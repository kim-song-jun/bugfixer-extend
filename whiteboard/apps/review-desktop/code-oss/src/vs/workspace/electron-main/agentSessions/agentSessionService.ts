/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type {
	AgentSessionDTO,
	AgentSessionPermissionPolicy,
	AgentSessionTurnDTO,
	AgentSessionTurnSnapshot,
} from '../../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';
import type {
	AgentPtyAttachment,
	AgentPtyOutputChunk,
	AgentPtyOutputPage,
	AgentPtySnapshot,
	AgentPtyStopResult,
} from './agentPtyHost.js';
import { AcquiredAgentSessionWorkspace, AgentSessionWorkspaceResolver } from './agentSessionWorkspace.js';

const LAUNCH_TICKET_TTL_MS = 30_000;
const MAX_LAUNCH_TICKETS = 128;
const MAX_PENDING_STARTS = 8;
const MAX_ATTACHMENTS_PER_TURN = 8;

declare const agentSessionRuntimeHandleBrand: unique symbol;

/** Factory-owned lifecycle capability. It is distinct from the host's actual PTY handle. */
export interface AgentSessionRuntimeHandle {
	readonly [agentSessionRuntimeHandleBrand]: true;
}

export interface AgentSessionLaunchPreview {
	readonly ticketId: string;
	readonly expiresAt: string;
	readonly snapshot: AgentSessionTurnSnapshot;
}

/** Trusted adapter around the PTY host and provider-specific command builder. */
export interface AgentSessionRuntimeFactory {
	/** Resolves only after the trusted PTY reports that the provider actually started. */
	start(snapshot: AgentSessionTurnSnapshot, turnId: string, signal: AbortSignal): Promise<AgentSessionRuntimeHandle>;
	watchExit(handle: AgentSessionRuntimeHandle, listener: (snapshot: AgentPtySnapshot) => void): IDisposable;
	getSnapshot(handle: AgentSessionRuntimeHandle): AgentPtySnapshot;
	write(handle: AgentSessionRuntimeHandle, text: string): Promise<void>;
	resize(handle: AgentSessionRuntimeHandle, cols: number, rows: number): Promise<void>;
	attach(handle: AgentSessionRuntimeHandle, listener: (chunk: AgentPtyOutputChunk) => void, afterSequence: number): Promise<AgentPtyAttachment>;
	stop(handle: AgentSessionRuntimeHandle): Promise<AgentPtyStopResult>;
	release(handle: AgentSessionRuntimeHandle): Promise<void>;
}

export interface AgentSessionAttachResult {
	readonly attachmentId: string;
	readonly snapshot: AgentPtySnapshot;
	readonly initialPage: AgentPtyOutputPage;
}

export interface AgentSessionShutdownReceipt {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly state: AgentSessionTurnDTO['state'];
	readonly cleanupVerified: boolean;
	readonly errorSummary?: string;
}

interface LaunchTicket {
	readonly id: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly sessionRevision: number;
	readonly snapshot: AgentSessionTurnSnapshot;
	readonly snapshotDigest: string;
	readonly expiresAt: number;
}

interface LiveTurn {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly workspace: AcquiredAgentSessionWorkspace;
	readonly abortController: AbortController;
	readonly attachments: Map<string, AgentPtyAttachment>;
	readonly pendingAttachments: Set<Promise<void>>;
	turn: AgentSessionTurnDTO;
	runtime?: AgentSessionRuntimeHandle;
	exitSubscription?: IDisposable;
	startPromise: Promise<void>;
	stopPromise?: Promise<AgentSessionTurnDTO>;
	stopRequested: boolean;
	running: boolean;
	launchPending: boolean;
	pendingExit?: AgentPtySnapshot;
	launchFailed: boolean;
	spawnAttempted: boolean;
	launchFailureCleanupVerified: boolean;
	launchFailureExitCode?: number | null;
	launchFailureExitSignal?: string | null;
	lifecycleFailure?: unknown;
}

interface ScopedAttachment {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly attachment: AgentPtyAttachment;
}

interface PendingWorkspaceOperation {
	readonly controller: AbortController;
	readonly settled: Promise<void>;
	complete(): void;
}

/** Main-process owner for launch tickets, turn lifecycle and factory-owned runtime handles. */
export class AgentSessionService {
	private readonly tickets = new Map<string, LaunchTicket>();
	private readonly turns = new Map<string, LiveTurn>();
	private readonly attachments = new Map<string, ScopedAttachment>();
	private readonly pendingWorkspaceOperations = new Set<PendingWorkspaceOperation>();
	private shuttingDown = false;
	private pendingPreviewReservations = 0;
	private pendingStartReservations = 0;

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly workspaceResolver: AgentSessionWorkspaceResolver,
		private readonly runtimeFactory: AgentSessionRuntimeFactory,
	) { }

	async preview(input: { readonly projectId: string; readonly sessionId: string; readonly permissionPolicy: AgentSessionPermissionPolicy }): Promise<AgentSessionLaunchPreview> {
		this.assertAcceptingLaunches();
		this.expireTickets();
		if (this.tickets.size + this.pendingPreviewReservations >= MAX_LAUNCH_TICKETS) { throw new Error('Too many unconsumed session launch previews are active.'); }
		this.pendingPreviewReservations++;
		const pending = this.beginWorkspaceOperation();
		let workspace: AcquiredAgentSessionWorkspace | undefined;
		try {
			workspace = await this.workspaceResolver.acquire({ ...input, signal: pending.controller.signal });
			this.assertAcceptingLaunches();
			const snapshot = workspace.snapshot;
			const id = randomUUID();
			const expiresAt = Date.now() + LAUNCH_TICKET_TTL_MS;
			this.tickets.set(id, {
				id, projectId: input.projectId, sessionId: input.sessionId, sessionRevision: snapshot.sessionRevision,
				snapshot, snapshotDigest: digestSnapshot(snapshot), expiresAt,
			});
			return Object.freeze({ ticketId: id, expiresAt: new Date(expiresAt).toISOString(), snapshot });
		} finally {
			this.pendingPreviewReservations--;
			try {
				if (workspace) { this.workspaceResolver.release(workspace); }
			} finally {
				this.finishWorkspaceOperation(pending);
			}
		}
	}

	async start(input: { readonly projectId: string; readonly sessionId: string; readonly ticketId: string }): Promise<AgentSessionTurnDTO> {
		this.assertAcceptingLaunches();
		const ticket = this.tickets.get(input.ticketId);
		if (!ticket) { throw new Error('The session launch ticket is unknown, expired, or already consumed.'); }
		this.tickets.delete(input.ticketId);
		if (ticket.projectId !== input.projectId || ticket.sessionId !== input.sessionId) {
			throw new Error('The session launch ticket belongs to another project or session.');
		}
		if (ticket.expiresAt <= Date.now()) { throw new Error('The session launch ticket expired.'); }
		if ([...this.turns.values()].filter(turn => turn.launchPending).length + this.pendingStartReservations >= MAX_PENDING_STARTS) {
			throw new Error('Too many session launches are pending.');
		}
		this.pendingStartReservations++;
		const pending = this.beginWorkspaceOperation();
		let workspace: AcquiredAgentSessionWorkspace | undefined;
		let turn: AgentSessionTurnDTO | undefined;
		let live: LiveTurn | undefined;
		try {
			workspace = await this.workspaceResolver.acquire({
				projectId: ticket.projectId,
				sessionId: ticket.sessionId,
				permissionPolicy: ticket.snapshot.permissionPolicy,
				signal: pending.controller.signal,
			});
			this.assertAcceptingLaunches();
			const snapshot = workspace.snapshot;
			if (snapshot.sessionRevision !== ticket.sessionRevision || digestSnapshot(snapshot) !== ticket.snapshotDigest) {
				throw new Error('The session workspace changed after its launch preview; create a new preview.');
			}
			this.assertAcceptingLaunches();
			turn = this.database.agentSessionTurns.createTurn({
				projectId: input.projectId,
				sessionId: input.sessionId,
				expectedSessionRevision: snapshot.sessionRevision,
				snapshot,
			});
			live = {
				projectId: input.projectId,
				sessionId: input.sessionId,
				turnId: turn.id,
				workspace,
				abortController: new AbortController(),
				attachments: new Map(),
				pendingAttachments: new Set(),
				turn,
				startPromise: Promise.resolve(),
				stopRequested: false,
				running: false,
				launchPending: true,
				launchFailed: false,
				spawnAttempted: false,
				launchFailureCleanupVerified: true,
			};
			this.turns.set(turn.id, live);
			this.pendingStartReservations--;
			live.workspace.onLost(() => {
				live!.abortController.abort();
				void this.stop(input.projectId, input.sessionId, turn!.id).catch(error => {
					live!.lifecycleFailure = error;
					live!.launchFailed = true;
					live!.launchFailureCleanupVerified = false;
				});
			});
			live.startPromise = this.launch(live);
		} catch (error) {
			if (!turn && workspace) { this.workspaceResolver.release(workspace); }
			throw error;
		} finally {
			if (turn === undefined) { this.pendingStartReservations--; }
			this.finishWorkspaceOperation(pending);
		}

		await live!.startPromise;
		if (live!.stopRequested) {
			if (live!.stopPromise) { return live!.stopPromise; }
			return this.requireTurn(live!).turn;
		}
		if (live!.launchFailed) {
			await this.finishFailedLaunch(live!);
			throw new Error('The session provider failed to start; inspect the durable turn for cleanup status.');
		}
		if (live!.pendingExit) {
			live!.stopPromise ??= this.trackStopOperation(live!, this.finishNaturalExit(live!, live!.pendingExit));
			return live!.stopPromise;
		}
		return this.requireTurn(live!).turn;
	}

	async stop(projectId: string, sessionId: string, turnId: string): Promise<AgentSessionTurnDTO> {
		const live = this.turns.get(turnId);
		if (!live || live.projectId !== projectId || live.sessionId !== sessionId) {
			throw new Error('The PTY turn is not owned by this project and session in this host process.');
		}
		if (live.stopPromise) { return live.stopPromise; }
		live.stopRequested = true;
		live.abortController.abort();
		const operation = this.trackStopOperation(live, this.stopOwnedTurn(live));
		try {
			const turn = await operation;
			live.lifecycleFailure = undefined;
			return turn;
		} catch (error) {
			throw error;
		}
	}

	async attach(
		projectId: string,
		sessionId: string,
		turnId: string,
		listener: (chunk: AgentPtyOutputChunk) => void,
		afterSequence = 0,
	): Promise<AgentSessionAttachResult> {
		const live = this.requireRunningTurn(projectId, sessionId, turnId);
		if (typeof listener !== 'function') { throw new Error('A trusted session output listener is required.'); }
		if (live.attachments.size + live.pendingAttachments.size >= MAX_ATTACHMENTS_PER_TURN) {
			throw new Error('The session turn output attachment limit was reached.');
		}
		let resolvePending!: () => void;
		const pending = new Promise<void>(resolve => { resolvePending = resolve; });
		live.pendingAttachments.add(pending);
		let attachment: AgentPtyAttachment | undefined;
		let registered = false;
		try {
			attachment = await this.runtimeFactory.attach(live.runtime!, listener, afterSequence);
			if (!live.running || live.stopRequested || !live.runtime) {
				throw new Error('The PTY turn stopped while the output attachment was being created.');
			}
			const attachmentId = randomUUID();
			live.attachments.set(attachmentId, attachment);
			this.attachments.set(attachmentId, { projectId, sessionId, turnId, attachment });
			registered = true;
			return Object.freeze({ attachmentId, snapshot: attachment.snapshot, initialPage: attachment.initialPage });
		} finally {
			if (attachment && !registered) { attachment.dispose(); }
			live.pendingAttachments.delete(pending);
			resolvePending();
		}
	}

	/** Reads are available only through a live attachment; durable turn transcript storage is pending separately. */
	read(projectId: string, sessionId: string, turnId: string, attachmentId: string, afterSequence: number, limit?: number): AgentPtyOutputPage {
		const attachment = this.requireAttachment(projectId, sessionId, turnId, attachmentId);
		return attachment.read(afterSequence, limit);
	}

	detach(projectId: string, sessionId: string, turnId: string, attachmentId: string): void {
		const attachment = this.requireAttachment(projectId, sessionId, turnId, attachmentId);
		attachment.dispose();
		this.attachments.delete(attachmentId);
		this.turns.get(turnId)?.attachments.delete(attachmentId);
	}

	async write(projectId: string, sessionId: string, turnId: string, text: string): Promise<void> {
		const live = this.requireRunningTurn(projectId, sessionId, turnId);
		await this.runtimeFactory.write(live.runtime!, text);
	}

	async resize(projectId: string, sessionId: string, turnId: string, cols: number, rows: number): Promise<void> {
		const live = this.requireRunningTurn(projectId, sessionId, turnId);
		await this.runtimeFactory.resize(live.runtime!, cols, rows);
	}

	/** Mark legacy live turns interrupted without claiming that their old process resources were cleaned up. */
	recoverStartup(): number {
		if (this.turns.size !== 0) { throw new Error('Startup recovery must run before this service owns any live turns.'); }
		return this.database.agentSessionTurns.interruptUnverifiedLiveTurnsOnStartup();
	}

	async shutdown(): Promise<readonly AgentSessionShutdownReceipt[]> {
		this.shuttingDown = true;
		this.tickets.clear();
		const pendingOperations = [...this.pendingWorkspaceOperations];
		for (const pending of pendingOperations) { pending.controller.abort(); }
		await Promise.all(pendingOperations.map(pending => pending.settled));
		const receipts: AgentSessionShutdownReceipt[] = [];
		await Promise.all([...this.turns.values()].map(async live => {
			let turn = live.turn;
			try {
				turn = await this.stop(live.projectId, live.sessionId, live.turnId);
				if (!turn.cleanupVerified && live.runtime) { turn = await this.stop(live.projectId, live.sessionId, live.turnId); }
			}
			catch (error) {
				live.lifecycleFailure = error;
				turn = this.database.agentSessionTurns.getTurn(live.projectId, live.sessionId, live.turnId) ?? live.turn;
			}
			receipts.push({
				projectId: live.projectId, sessionId: live.sessionId, turnId: live.turnId, state: turn.state,
				cleanupVerified: turn.cleanupVerified,
				...(live.lifecycleFailure !== undefined ? { errorSummary: 'Session shutdown could not verify lifecycle cleanup.' } : {}),
			});
		}));
		return receipts;
	}

	private async launch(live: LiveTurn): Promise<void> {
		try {
			await this.workspaceResolver.revalidate(live.workspace, live.turn.id);
			if (live.abortController.signal.aborted || this.shuttingDown) { return; }
			live.spawnAttempted = true;
			live.runtime = await this.runtimeFactory.start(live.turn.snapshot, live.turn.id, live.abortController.signal);
			live.exitSubscription = this.runtimeFactory.watchExit(live.runtime, snapshot => {
				if (snapshot.state !== 'exited' && snapshot.state !== 'stopped' && snapshot.state !== 'cleanupUnverified') { return; }
				live.pendingExit = snapshot;
				if (live.running && !live.stopRequested) { live.stopPromise ??= this.trackStopOperation(live, this.finishNaturalExit(live, snapshot)); }
			});
			if (live.abortController.signal.aborted || live.stopRequested) { return; }
			const result = this.transition(live, { state: 'running' });
			live.turn = result.turn;
			live.running = true;
			const currentSnapshot = this.runtimeFactory.getSnapshot(live.runtime);
			if (currentSnapshot.state === 'exited' || currentSnapshot.state === 'stopped' || currentSnapshot.state === 'cleanupUnverified') {
				live.pendingExit = currentSnapshot;
				live.stopPromise ??= this.trackStopOperation(live, this.finishNaturalExit(live, currentSnapshot));
			}
		} catch (error) {
			live.launchFailed = true;
			if (error instanceof AgentSessionRuntimeStartError && error.recoveryHandle) { live.runtime = error.recoveryHandle; }
			live.launchFailureCleanupVerified = !live.spawnAttempted
				|| (!live.runtime && error instanceof AgentSessionRuntimeStartError && error.cleanupVerified);
			if (error instanceof AgentSessionRuntimeStartError) {
				live.launchFailureExitCode = error.exitCode;
				live.launchFailureExitSignal = error.exitSignal;
			}
		} finally {
			live.launchPending = false;
		}
	}

	private async finishFailedLaunch(live: LiveTurn): Promise<void> {
		if (live.stopRequested) { return; }
		let cleanupVerified = live.launchFailureCleanupVerified;
		if (live.runtime) { cleanupVerified = await this.stopAndReleaseRuntime(live); }
		const turn = this.requireTurn(live).turn;
		if (!isTerminal(turn.state)) {
			live.turn = this.transition(live, {
				state: 'failed',
				exitCode: live.launchFailureExitCode,
				exitSignal: live.launchFailureExitSignal,
				errorSummary: 'The provider could not be started by the trusted session runtime.',
				cleanupVerified,
			}).turn;
		}
		if (cleanupVerified) { this.releaseWorkspace(live); }
	}

	private async finishNaturalExit(live: LiveTurn, snapshot: AgentPtySnapshot): Promise<AgentSessionTurnDTO> {
		if (live.stopRequested || isTerminal(this.requireTurn(live).turn.state)) { return this.requireTurn(live).turn; }
		live.stopRequested = true;
		const cleanupVerified = await this.stopAndReleaseRuntime(live);
		const current = this.requireTurn(live).turn;
		if (!isTerminal(current.state)) {
			live.turn = this.transition(live, cleanupVerified ? {
				state: 'exited', exitCode: snapshot.providerExitCode ?? null, exitSignal: snapshot.providerExitSignal ?? null, cleanupVerified: true,
			} : {
				state: 'failed', exitCode: snapshot.providerExitCode ?? null, exitSignal: snapshot.providerExitSignal ?? null,
				errorSummary: 'Provider exit was observed, but owned PTY cleanup could not be verified.', cleanupVerified: false,
			}).turn;
		}
		if (cleanupVerified) { this.releaseWorkspace(live); }
		return live.turn;
	}

	private async stopOwnedTurn(live: LiveTurn): Promise<AgentSessionTurnDTO> {
		let current = this.requireTurn(live).turn;
		if (!isTerminal(current.state) && current.state !== 'stopping') {
			live.turn = this.transition(live, { state: 'stopping' }).turn;
		}
		await live.startPromise;
		current = this.requireTurn(live).turn;
		if (isTerminal(current.state)) {
			if (!current.cleanupVerified && live.runtime && await this.stopAndReleaseRuntime(live)) {
				live.turn = this.database.agentSessionTurns.confirmTurnCleanup(live.projectId, live.sessionId, live.turnId, current.revision);
				this.releaseWorkspace(live);
			}
			return live.turn;
		}
		let cleanupVerified = true;
		if (live.runtime) { cleanupVerified = await this.stopAndReleaseRuntime(live); }
		else if (live.launchFailed) { cleanupVerified = live.launchFailureCleanupVerified; }
		if (cleanupVerified) {
			live.turn = this.transition(live, { state: 'exited', cleanupVerified: true }).turn;
			this.releaseWorkspace(live);
		} else {
			live.turn = this.transition(live, {
				state: 'failed', errorSummary: 'Session launch or stop could not verify cleanup of owned resources.', cleanupVerified: false,
			}).turn;
		}
		return live.turn;
	}

	private async stopAndReleaseRuntime(live: LiveTurn): Promise<boolean> {
		if (!live.runtime) { return true; }
		let stopResult: AgentPtyStopResult;
		try { stopResult = await this.runtimeFactory.stop(live.runtime); }
		catch (error) { live.lifecycleFailure = error; return false; }
		if (!stopResult.cleanupVerified) { return false; }
		// Runtime stop flushes its final output before active attachments are disposed.
		await Promise.all([...live.pendingAttachments]);
		for (const [id, attachment] of live.attachments) {
			attachment.dispose();
			this.attachments.delete(id);
		}
		live.attachments.clear();
		try {
			live.exitSubscription?.dispose();
			live.exitSubscription = undefined;
			await this.runtimeFactory.release(live.runtime);
			live.runtime = undefined;
			return true;
		} catch (error) { live.lifecycleFailure = error; return false; }
	}

	private transition(live: LiveTurn, update: Parameters<WorkspaceDatabase['agentSessionTurns']['transitionTurn']>[5]): ReturnType<WorkspaceDatabase['agentSessionTurns']['transitionTurn']> {
		const currentTurn = this.database.agentSessionTurns.getTurn(live.projectId, live.sessionId, live.turnId);
		const currentSession = this.database.agentSessions.getSession(live.projectId, live.sessionId);
		if (!currentTurn || !currentSession) { throw new Error('The durable session turn no longer belongs to its project and session.'); }
		return this.database.agentSessionTurns.transitionTurn(
			live.projectId, live.sessionId, live.turnId, currentTurn.revision, currentSession.revision, update,
		);
	}

	private requireTurn(live: LiveTurn): { readonly turn: AgentSessionTurnDTO; readonly session: AgentSessionDTO } {
		const turn = this.database.agentSessionTurns.getTurn(live.projectId, live.sessionId, live.turnId);
		const session = this.database.agentSessions.getSession(live.projectId, live.sessionId);
		if (!turn || !session) { throw new Error('The durable session turn no longer belongs to its project and session.'); }
		return { turn, session };
	}

	private requireRunningTurn(projectId: string, sessionId: string, turnId: string): LiveTurn {
		const live = this.turns.get(turnId);
		if (!live || live.projectId !== projectId || live.sessionId !== sessionId || !live.running || live.stopRequested || !live.runtime) {
			throw new Error('The PTY turn is not active in this project and session.');
		}
		return live;
	}

	private requireAttachment(projectId: string, sessionId: string, turnId: string, attachmentId: string): AgentPtyAttachment {
		const scoped = this.attachments.get(attachmentId);
		if (!scoped || scoped.projectId !== projectId || scoped.sessionId !== sessionId || scoped.turnId !== turnId) {
			throw new Error('The PTY attachment is not owned by this project, session, and turn.');
		}
		return scoped.attachment;
	}

	private releaseWorkspace(live: LiveTurn): void {
		live.exitSubscription?.dispose();
		live.exitSubscription = undefined;
		this.workspaceResolver.release(live.workspace);
	}

	private trackStopOperation(live: LiveTurn, operation: Promise<AgentSessionTurnDTO>): Promise<AgentSessionTurnDTO> {
		let tracked!: Promise<AgentSessionTurnDTO>;
		tracked = operation.then(turn => {
			if (live.stopPromise === tracked && isTerminal(turn.state) && !turn.cleanupVerified) { live.stopPromise = undefined; }
			return turn;
		}, error => {
			if (live.stopPromise === tracked) { live.stopPromise = undefined; }
			live.lifecycleFailure = error;
			throw error;
		});
		live.stopPromise = tracked;
		return tracked;
	}

	private beginWorkspaceOperation(): PendingWorkspaceOperation {
		let complete!: () => void;
		const pending: PendingWorkspaceOperation = {
			controller: new AbortController(),
			settled: new Promise<void>(resolve => { complete = resolve; }),
			complete: () => complete(),
		};
		this.pendingWorkspaceOperations.add(pending);
		return pending;
	}

	private finishWorkspaceOperation(pending: PendingWorkspaceOperation): void {
		this.pendingWorkspaceOperations.delete(pending);
		pending.complete();
	}

	private assertAcceptingLaunches(): void {
		if (this.shuttingDown) { throw new Error('The session host is shutting down.'); }
	}

	private expireTickets(): void {
		const now = Date.now();
		for (const [id, ticket] of this.tickets) {
			if (ticket.expiresAt <= now) { this.tickets.delete(id); }
		}
	}
}

export class AgentSessionRuntimeStartError extends Error {
	constructor(
		message: string,
		readonly cleanupVerified: boolean,
		readonly exitCode?: number | null,
		readonly exitSignal?: string | null,
		readonly recoveryHandle?: AgentSessionRuntimeHandle,
	) {
		super(message);
		this.name = 'AgentSessionRuntimeStartError';
		if (cleanupVerified && recoveryHandle) { throw new Error('Verified runtime cleanup cannot retain a recovery handle.'); }
		if (!cleanupVerified && !recoveryHandle) { throw new Error('Unverified runtime cleanup requires its exact factory-owned recovery handle.'); }
	}
}

function digestSnapshot(snapshot: AgentSessionTurnSnapshot): string {
	return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function isTerminal(state: AgentSessionTurnDTO['state']): boolean {
	return state === 'exited' || state === 'interrupted' || state === 'failed';
}
