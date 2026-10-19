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
import { AgentSessionContentCaptureCleanupError } from './agentSessionContentCapture.js';

const LAUNCH_TICKET_TTL_MS = 30_000;
const MAX_LAUNCH_TICKETS = 128;
const MAX_PENDING_STARTS = 8;
const MAX_ATTACHMENTS_PER_TURN = 8;
const PROVIDER_IDENTITY_MISMATCH_ERROR = '프로바이더 대화 식별자가 현재 세션과 일치하지 않습니다.';
const PROVIDER_IDENTITY_AND_TRANSCRIPT_ERROR = '프로바이더 대화 식별자가 현재 세션과 일치하지 않으며 실행 기록을 저장하지 못했습니다.';
const CHANGE_EVIDENCE_ERROR = '실행 전후 파일 변경 증거를 저장하지 못했습니다.';

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

/** Host-only lifecycle port for durable, exact-turn workspace change observations. */
export interface AgentSessionChangeObserver {
	/** Must finish persisting the before observation before the PTY runtime may start. */
	beforeStart(turn: AgentSessionTurnDTO, signal: AbortSignal): Promise<void>;
	/** Called after runtime cleanup was attempted and before the acquired workspace is released. */
	afterCleanup(turn: AgentSessionTurnDTO, context: { readonly cleanupVerified: boolean; readonly spawnAttempted: boolean }): Promise<void>;
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
	transcriptPersistenceFailed: boolean;
	providerIdentityMismatch: boolean;
	changeEvidenceFailure: boolean;
	beforeEvidenceFailure: boolean;
	changeEvidenceFinalized: boolean;
	captureCleanupRecovery?: AgentSessionContentCaptureCleanupError['recovery'];
	ptyCleanupVerified: boolean;
	workspaceReleased: boolean;
	lifecycleFailure?: unknown;
}

interface ScopedAttachment {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly attachment: AgentPtyAttachment;
}

interface PendingWorkspaceOperation {
	readonly projectId: string;
	readonly sessionId: string;
	readonly controller: AbortController;
	readonly settled: Promise<void>;
	complete(): void;
}

interface IdleMutationLeaseRecord {
	readonly token: symbol;
	readonly settled: Promise<void>;
	complete(): void;
}

/** Main-process owner for launch tickets, turn lifecycle and factory-owned runtime handles. */
export class AgentSessionService {
	private readonly tickets = new Map<string, LaunchTicket>();
	private readonly turns = new Map<string, LiveTurn>();
	private readonly attachments = new Map<string, ScopedAttachment>();
	private readonly pendingWorkspaceOperations = new Set<PendingWorkspaceOperation>();
	private readonly pendingStartsBySession = new Map<string, symbol>();
	private readonly idleMutationLeases = new Map<string, IdleMutationLeaseRecord>();
	private shuttingDown = false;
	private pendingPreviewReservations = 0;
	private pendingStartReservations = 0;

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly workspaceResolver: AgentSessionWorkspaceResolver,
		private readonly runtimeFactory: AgentSessionRuntimeFactory,
		private readonly changeObserver?: AgentSessionChangeObserver,
	) { }

	/** Synchronously reserves this session while trusted host code prepares a Git mutation. */
	acquireIdleMutationLease(input: { readonly projectId: string; readonly sessionId: string }): { release(): void } {
		this.assertAcceptingLaunches();
		if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'projectId,sessionId') {
			throw new Error('The mutation lease requires exact project and session scope.');
		}
		const key = sessionKey(input.projectId, input.sessionId);
		const session = this.database.agentSessions.getSession(input.projectId, input.sessionId);
		if (!session) { throw new Error('The mutation lease session does not belong to this project.'); }
		if (['starting', 'running', 'waitingForInput', 'waitingForApproval', 'stopping'].includes(session.state)) {
			throw new Error('A session mutation lease requires an idle session.');
		}
		if (this.idleMutationLeases.has(key)) { throw new Error('A trusted mutation already holds this session lease.'); }
		if (this.pendingStartsBySession.has(key)) { throw new Error('A provider start is pending for this session.'); }
		if ([...this.pendingWorkspaceOperations].some(operation => operation.projectId === input.projectId && operation.sessionId === input.sessionId)) {
			throw new Error('A workspace operation is pending for this session.');
		}
		for (const turn of this.database.agentSessionTurns.listTurns(input.projectId, input.sessionId)) {
			if (!isTerminal(turn.state) || !turn.cleanupVerified) { throw new Error('An active turn or unverified cleanup prevents this session mutation.'); }
		}
		for (const live of this.turns.values()) {
			if (live.projectId === input.projectId && live.sessionId === input.sessionId
				&& (live.launchPending || !isTerminal(live.turn.state) || !live.turn.cleanupVerified || !live.workspaceReleased || !live.changeEvidenceFinalized)) {
				throw new Error('A live or unreleased turn prevents this session mutation.');
			}
		}
		const token = Symbol('agent-session-idle-mutation-lease');
		let complete!: () => void;
		const record: IdleMutationLeaseRecord = { token, settled: new Promise<void>(resolve => { complete = resolve; }), complete: () => complete() };
		this.idleMutationLeases.set(key, record);
		let released = false;
		return Object.freeze({
			release: () => {
				if (released) { return; }
				released = true;
				if (this.idleMutationLeases.get(key)?.token === token) {
					this.idleMutationLeases.delete(key);
					record.complete();
				}
			},
		});
	}

	/** Trusted workspace check: a durable running row alone never establishes live PTY ownership. */
	ownsRunningReadOnlyTurn(turn: AgentSessionTurnDTO): boolean {
		const live = this.turns.get(turn.id);
		return !!live && !this.shuttingDown && live.running && !live.launchPending && !live.stopRequested && !live.launchFailed
			&& !live.transcriptPersistenceFailed && !live.providerIdentityMismatch && !live.changeEvidenceFailure && !live.workspaceReleased
			&& live.projectId === turn.projectId && live.sessionId === turn.sessionId && turn.state === 'running' && live.turn.state === 'running'
			&& turn.snapshot.permissionPolicy.mode === 'read-only' && live.turn.snapshot.permissionPolicy.mode === 'read-only'
			&& JSON.stringify(turn.snapshot) === JSON.stringify(live.turn.snapshot)
			&& live.runtime !== undefined && this.runtimeFactory.getSnapshot(live.runtime).state === 'running';
	}

	async preview(input: { readonly projectId: string; readonly sessionId: string; readonly permissionPolicy: AgentSessionPermissionPolicy }): Promise<AgentSessionLaunchPreview> {
		this.assertAcceptingLaunches();
		this.assertNoIdleMutationLease(input.projectId, input.sessionId);
		this.expireTickets();
		if (this.tickets.size + this.pendingPreviewReservations >= MAX_LAUNCH_TICKETS) { throw new Error('Too many unconsumed session launch previews are active.'); }
		this.pendingPreviewReservations++;
		const pending = this.beginWorkspaceOperation(input);
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
		return this.startWithWorkspace(input, ticket.snapshot.permissionPolicy, snapshot => {
			if (snapshot.sessionRevision !== ticket.sessionRevision || digestSnapshot(snapshot) !== ticket.snapshotDigest) {
				throw new Error('The session workspace changed after its launch preview; create a new preview.');
			}
			return this.database.agentSessionTurns.createTurn({
				projectId: input.projectId,
				sessionId: input.sessionId,
				expectedSessionRevision: snapshot.sessionRevision,
				snapshot,
			});
		});
	}

	/** Trusted-main entry point. Reservation IDs must never be exposed through renderer IPC or MCP. */
	async startWorkflowNode(input: {
		readonly projectId: string;
		readonly sessionId: string;
		readonly permissionPolicy: AgentSessionPermissionPolicy;
		readonly reservationId: string;
		readonly signal?: AbortSignal;
	}): Promise<AgentSessionTurnDTO> {
		this.assertAcceptingLaunches();
		if (!input.reservationId) { throw new Error('A workflow launch reservation is required.'); }
		if ([...this.turns.values()].filter(turn => turn.launchPending).length + this.pendingStartReservations >= MAX_PENDING_STARTS) {
			throw new Error('Too many session launches are pending.');
		}
		return this.startWithWorkspace(input, input.permissionPolicy, snapshot => this.database.agentSessionTurns.createTurn({
			projectId: input.projectId,
			sessionId: input.sessionId,
			expectedSessionRevision: snapshot.sessionRevision,
			snapshot,
			workflowLaunchAuthorization: { reservationId: input.reservationId },
		}), input.signal);
	}

	private async startWithWorkspace(
		input: { readonly projectId: string; readonly sessionId: string },
		permissionPolicy: AgentSessionPermissionPolicy,
		createTurn: (snapshot: AgentSessionTurnSnapshot) => AgentSessionTurnDTO,
		signal?: AbortSignal,
	): Promise<AgentSessionTurnDTO> {
		const sessionKeyValue = sessionKey(input.projectId, input.sessionId);
		this.assertNoIdleMutationLease(input.projectId, input.sessionId);
		if (this.pendingStartsBySession.has(sessionKeyValue)) { throw new Error('A provider start is already pending for this session.'); }
		const startToken = Symbol('agent-session-start-reservation');
		this.pendingStartsBySession.set(sessionKeyValue, startToken);
		this.pendingStartReservations++;
		const pending = this.beginWorkspaceOperation(input);
		const abortPending = () => pending.controller.abort();
		if (signal?.aborted) { abortPending(); }
		else { signal?.addEventListener('abort', abortPending, { once: true }); }
		let workspace: AcquiredAgentSessionWorkspace | undefined;
		let turn: AgentSessionTurnDTO | undefined;
		let live: LiveTurn | undefined;
		try {
			workspace = await this.workspaceResolver.acquire({
				projectId: input.projectId,
				sessionId: input.sessionId,
				permissionPolicy,
				signal: pending.controller.signal,
				launch: true,
			});
			this.assertAcceptingLaunches();
			if (pending.controller.signal.aborted) { throw new Error('The session launch was cancelled before a turn was created.'); }
			const snapshot = workspace.snapshot;
			turn = createTurn(snapshot);
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
				transcriptPersistenceFailed: false,
				providerIdentityMismatch: false,
				changeEvidenceFailure: false,
				beforeEvidenceFailure: false,
				changeEvidenceFinalized: false,
				ptyCleanupVerified: true,
				workspaceReleased: false,
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
			signal?.removeEventListener('abort', abortPending);
			if (turn === undefined) { this.pendingStartReservations--; }
			if (this.pendingStartsBySession.get(sessionKeyValue) === startToken) { this.pendingStartsBySession.delete(sessionKeyValue); }
			this.finishWorkspaceOperation(pending);
		}

		try {
			await live!.startPromise;
			if (live!.stopRequested) {
				if (live!.stopPromise) { return await live!.stopPromise; }
				return this.requireTurn(live!).turn;
			}
			if (live!.launchFailed) {
				await this.finishFailedLaunch(live!);
				throw new Error('The session provider failed to start; inspect the durable turn for cleanup status.');
			}
			if (live!.pendingExit) {
				live!.stopPromise ??= this.trackStopOperation(live!, this.finishNaturalExit(live!, live!.pendingExit));
				return await live!.stopPromise;
			}
			return this.requireTurn(live!).turn;
		} finally {
			this.workspaceResolver.finishLaunch(live!.workspace);
		}
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
			if (live.changeEvidenceFailure) { live.lifecycleFailure ??= new Error(CHANGE_EVIDENCE_ERROR); }
			else { live.lifecycleFailure = undefined; }
			return turn;
		} catch (error) {
			throw error;
		}
	}

	/** Trusted provider adapter callback. A mismatch fails only the exact turn owned by this host. */
	async rejectProviderConversation(projectId: string, sessionId: string, turnId: string): Promise<AgentSessionTurnDTO> {
		const live = this.turns.get(turnId);
		if (!live || live.projectId !== projectId || live.sessionId !== sessionId) {
			throw new Error('The provider conversation mismatch does not belong to this project, session, and turn.');
		}
		live.providerIdentityMismatch = true;
		return this.stop(projectId, sessionId, turnId);
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
		await Promise.all([...this.idleMutationLeases.values()].map(lease => lease.settled));
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
			if (this.changeObserver) {
				try {
					await this.changeObserver.beforeStart(live.turn, live.abortController.signal);
				} catch (error) {
					if (error instanceof AgentSessionContentCaptureCleanupError) {
						live.changeEvidenceFailure = true;
						live.beforeEvidenceFailure = true;
						live.captureCleanupRecovery = error.recovery;
						live.lifecycleFailure = error.stopReason;
					} else if (live.abortController.signal.aborted) { return; }
					else {
						live.changeEvidenceFailure = true;
						live.beforeEvidenceFailure = true;
						live.lifecycleFailure = error;
					}
					throw error;
				}
				if (live.abortController.signal.aborted || live.stopRequested || this.shuttingDown) { return; }
			}
			live.ptyCleanupVerified = false;
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
			live.ptyCleanupVerified = live.launchFailureCleanupVerified;
			if (error instanceof AgentSessionRuntimeStartError) {
				live.launchFailureExitCode = error.exitCode;
				live.launchFailureExitSignal = error.exitSignal;
				live.transcriptPersistenceFailed ||= error.transcriptPersistenceFailed;
			}
		} finally {
			live.launchPending = false;
		}
	}

	private async finishFailedLaunch(live: LiveTurn): Promise<void> {
		if (live.stopRequested) { return; }
		let ptyCleanupVerified = live.launchFailureCleanupVerified;
		if (live.runtime) { ptyCleanupVerified = await this.stopAndReleaseRuntime(live); }
		let evidenceRecorded = false;
		if (!live.captureCleanupRecovery) {
			evidenceRecorded = await this.observeAfterCleanup(live, ptyCleanupVerified);
		}
		const cleanupVerified = ptyCleanupVerified && !live.captureCleanupRecovery;
		const turn = this.requireTurn(live).turn;
		if (!isTerminal(turn.state)) {
			live.turn = this.transition(live, {
				state: 'failed',
				exitCode: live.launchFailureExitCode,
				exitSignal: live.launchFailureExitSignal,
				errorSummary: this.launchFailureSummary(live),
				cleanupVerified,
			}).turn;
		}
		if (cleanupVerified) { this.releaseWorkspace(live); }
		if (!evidenceRecorded && cleanupVerified) { live.lifecycleFailure ??= new Error(CHANGE_EVIDENCE_ERROR); }
	}

	private async finishNaturalExit(live: LiveTurn, snapshot: AgentPtySnapshot): Promise<AgentSessionTurnDTO> {
		if (live.stopRequested || isTerminal(this.requireTurn(live).turn.state)) { return this.requireTurn(live).turn; }
		live.stopRequested = true;
		const ptyCleanupVerified = await this.stopAndReleaseRuntime(live);
		live.transcriptPersistenceFailed ||= snapshot.transcriptPersistenceFailed === true;
		let evidenceRecorded = false;
		if (!live.captureCleanupRecovery) {
			evidenceRecorded = await this.observeAfterCleanup(live, ptyCleanupVerified);
		}
		const cleanupVerified = ptyCleanupVerified && !live.captureCleanupRecovery;
		const current = this.requireTurn(live).turn;
		if (!isTerminal(current.state)) {
			live.turn = this.transition(live, !cleanupVerified ? {
				state: 'failed', exitCode: snapshot.providerExitCode ?? null, exitSignal: snapshot.providerExitSignal ?? null,
				errorSummary: this.cleanupFailureSummary(live, ptyCleanupVerified ? 'Provider exit was observed, but owned file-capture helper cleanup could not be verified.' : 'Provider exit was observed, but owned PTY cleanup could not be verified.'), cleanupVerified: false,
			} : live.providerIdentityMismatch ? {
				state: 'failed', exitCode: snapshot.providerExitCode ?? null, exitSignal: snapshot.providerExitSignal ?? null,
				errorSummary: this.combinedFailureSummary(live, this.providerIdentityMismatchSummary(live)), cleanupVerified,
			} : cleanupVerified && !live.transcriptPersistenceFailed && evidenceRecorded ? {
				state: 'exited', exitCode: snapshot.providerExitCode ?? null, exitSignal: snapshot.providerExitSignal ?? null, cleanupVerified: true,
			} : {
				state: 'failed', exitCode: snapshot.providerExitCode ?? null, exitSignal: snapshot.providerExitSignal ?? null,
				errorSummary: this.terminalEvidenceSummary(live), cleanupVerified: true,
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
			if (!current.cleanupVerified && live.runtime) { await this.stopAndReleaseRuntime(live); }
			if (live.captureCleanupRecovery) { await this.retryCaptureCleanup(live); }
			let evidenceRecorded = false;
			if (!live.captureCleanupRecovery) {
				evidenceRecorded = await this.observeAfterCleanup(live, live.ptyCleanupVerified);
			}
			const cleanupVerified = live.ptyCleanupVerified && !live.captureCleanupRecovery;
			if (!current.cleanupVerified && cleanupVerified) {
				live.turn = this.database.agentSessionTurns.confirmTurnCleanup(live.projectId, live.sessionId, live.turnId, current.revision);
			}
			if (cleanupVerified) { this.releaseWorkspace(live); }
			if (!evidenceRecorded && !live.captureCleanupRecovery) { live.lifecycleFailure ??= new Error(CHANGE_EVIDENCE_ERROR); }
			return live.turn;
		}
		let ptyCleanupVerified = live.ptyCleanupVerified;
		if (live.runtime) { ptyCleanupVerified = await this.stopAndReleaseRuntime(live); }
		else if (live.launchFailed) { ptyCleanupVerified = live.launchFailureCleanupVerified; }
		if (live.captureCleanupRecovery) { await this.retryCaptureCleanup(live); }
		let evidenceRecorded = false;
		if (!live.captureCleanupRecovery) {
			evidenceRecorded = await this.observeAfterCleanup(live, ptyCleanupVerified);
		}
		const cleanupVerified = ptyCleanupVerified && !live.captureCleanupRecovery;
		if (cleanupVerified) {
			live.turn = this.transition(live, live.providerIdentityMismatch || live.transcriptPersistenceFailed || live.changeEvidenceFailure || !evidenceRecorded ? {
				state: 'failed', errorSummary: this.terminalEvidenceSummary(live), cleanupVerified: true,
			} : { state: 'exited', cleanupVerified: true }).turn;
			this.releaseWorkspace(live);
		} else {
			live.turn = this.transition(live, {
				state: 'failed', errorSummary: this.cleanupFailureSummary(live, 'Session launch or stop could not verify cleanup of owned resources.'), cleanupVerified: false,
			}).turn;
		}
		return live.turn;
	}

	private async observeAfterCleanup(live: LiveTurn, cleanupVerified: boolean): Promise<boolean> {
		if (!this.changeObserver) { live.changeEvidenceFinalized = true; return !live.changeEvidenceFailure; }
		if (cleanupVerified && live.changeEvidenceFinalized) { return !live.changeEvidenceFailure; }
		try {
			const turn = this.requireTurn(live).turn;
			await this.changeObserver.afterCleanup(turn, { cleanupVerified, spawnAttempted: live.spawnAttempted });
			live.changeEvidenceFailure = live.beforeEvidenceFailure;
			if (cleanupVerified) { live.changeEvidenceFinalized = true; }
			return true;
		} catch (error) {
			live.changeEvidenceFailure = true;
			if (error instanceof AgentSessionContentCaptureCleanupError) {
				live.captureCleanupRecovery = error.recovery;
				live.lifecycleFailure = error.stopReason;
			} else { live.lifecycleFailure = error; }
			return false;
		}
	}

	private async retryCaptureCleanup(live: LiveTurn): Promise<boolean> {
		const recovery = live.captureCleanupRecovery;
		if (!recovery) { return true; }
		try {
			if (!await recovery.retryCleanup()) { return false; }
			live.captureCleanupRecovery = undefined;
			return true;
		} catch (error) {
			live.lifecycleFailure = error;
			return false;
		}
	}

	private launchFailureSummary(live: LiveTurn): string {
		const summaries = [
			live.providerIdentityMismatch ? this.providerIdentityMismatchSummary(live) : undefined,
			live.transcriptPersistenceFailed ? 'The durable session transcript could not be written; terminal output was withheld.' : undefined,
			live.changeEvidenceFailure ? CHANGE_EVIDENCE_ERROR : undefined,
			!live.providerIdentityMismatch && !live.transcriptPersistenceFailed && !live.changeEvidenceFailure ? 'The provider could not be started by the trusted session runtime.' : undefined,
		].filter((value): value is string => value !== undefined);
		return summaries.join(' ');
	}

	private terminalEvidenceSummary(live: LiveTurn): string {
		const summaries = [
			live.providerIdentityMismatch ? this.providerIdentityMismatchSummary(live) : undefined,
			live.transcriptPersistenceFailed ? 'The durable session transcript could not be written; terminal output was withheld.' : undefined,
			live.changeEvidenceFailure ? CHANGE_EVIDENCE_ERROR : undefined,
		].filter((value): value is string => value !== undefined);
		return summaries.join(' ');
	}

	private combinedFailureSummary(live: LiveTurn, primary: string): string {
		return live.changeEvidenceFailure ? `${primary} ${CHANGE_EVIDENCE_ERROR}` : primary;
	}

	private cleanupFailureSummary(live: LiveTurn, primary: string): string {
		return [
			primary,
			live.providerIdentityMismatch ? this.providerIdentityMismatchSummary(live) : undefined,
			live.transcriptPersistenceFailed ? 'The durable session transcript could not be written; terminal output was withheld.' : undefined,
			live.changeEvidenceFailure ? CHANGE_EVIDENCE_ERROR : undefined,
		].filter((value): value is string => value !== undefined).join(' ');
	}

	private providerIdentityMismatchSummary(live: LiveTurn): string {
		return live.transcriptPersistenceFailed ? PROVIDER_IDENTITY_AND_TRANSCRIPT_ERROR : PROVIDER_IDENTITY_MISMATCH_ERROR;
	}

	private async stopAndReleaseRuntime(live: LiveTurn): Promise<boolean> {
		if (!live.runtime) { return live.ptyCleanupVerified; }
		let stopResult: AgentPtyStopResult;
		try { stopResult = await this.runtimeFactory.stop(live.runtime); }
		catch (error) { live.lifecycleFailure = error; live.ptyCleanupVerified = false; return false; }
		if (!stopResult.cleanupVerified) { live.ptyCleanupVerified = false; return false; }
		live.transcriptPersistenceFailed ||= this.runtimeFactory.getSnapshot(live.runtime).transcriptPersistenceFailed === true;
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
			live.ptyCleanupVerified = true;
			return true;
		} catch (error) { live.lifecycleFailure = error; live.ptyCleanupVerified = false; return false; }
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
		if (live.workspaceReleased) { return; }
		live.workspaceReleased = true;
		live.exitSubscription?.dispose();
		live.exitSubscription = undefined;
		this.workspaceResolver.release(live.workspace);
	}

	private trackStopOperation(live: LiveTurn, operation: Promise<AgentSessionTurnDTO>): Promise<AgentSessionTurnDTO> {
		let tracked!: Promise<AgentSessionTurnDTO>;
		tracked = operation.then(turn => {
			if (live.stopPromise === tracked && isTerminal(turn.state) && (!turn.cleanupVerified || !live.changeEvidenceFinalized)) { live.stopPromise = undefined; }
			return turn;
		}, error => {
			if (live.stopPromise === tracked) { live.stopPromise = undefined; }
			live.lifecycleFailure = error;
			throw error;
		});
		live.stopPromise = tracked;
		return tracked;
	}

	private beginWorkspaceOperation(scope: { readonly projectId: string; readonly sessionId: string }): PendingWorkspaceOperation {
		let complete!: () => void;
		const pending: PendingWorkspaceOperation = {
			projectId: scope.projectId,
			sessionId: scope.sessionId,
			controller: new AbortController(),
			settled: new Promise<void>(resolve => { complete = resolve; }),
			complete: () => complete(),
		};
		this.pendingWorkspaceOperations.add(pending);
		return pending;
	}

	private assertNoIdleMutationLease(projectId: string, sessionId: string): void {
		if (this.idleMutationLeases.has(sessionKey(projectId, sessionId))) { throw new Error('A trusted mutation currently holds this session lease.'); }
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
		readonly transcriptPersistenceFailed = false,
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

function sessionKey(projectId: string, sessionId: string): string { return `${projectId}:${sessionId}`; }

function isTerminal(state: AgentSessionTurnDTO['state']): boolean {
	return state === 'exited' || state === 'interrupted' || state === 'failed';
}
