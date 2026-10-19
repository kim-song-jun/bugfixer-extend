/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import type { AgentSessionControlRequestDTO } from '../../common/workspaceAgentSessionControlProtocol.js';
import type { AgentSessionDTO, AgentSessionPermissionPolicy, AgentSessionTurnDTO, AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';
import type { AgentSessionLaunchPreview, AgentSessionService } from './agentSessionService.js';
import type { AgentSessionControlRequestStore } from './agentSessionControlRequestStore.js';

const MAX_PREVIEWS = 128;
const MAX_STOP_JOBS = 32;
const MAX_UNRESOLVED_STARTS = 16;
const START_FAILED = 'The approved AI session could not be started.';
const STOP_FAILED = 'The approved AI session could not be stopped or verified.';

type RequestLedger = Pick<AgentSessionControlRequestStore,
	'get' | 'beginStart' | 'markStarted' | 'markStartFailed' | 'validateAcceptedStop' | 'markStopResult' | 'recoverInterruptedStarts'>;
type SessionLookup = Pick<WorkspaceDatabase['agentSessions'], 'getSession'>;
type TurnLookup = Pick<WorkspaceDatabase['agentSessionTurns'], 'getTurn' | 'listTurns'>;
export interface AgentSessionControlApplicationDatabase {
	readonly agentSessions: SessionLookup;
	readonly agentSessionTurns: TurnLookup;
	readonly agentSessionControlRequests: RequestLedger;
}
type PreviewService = Pick<AgentSessionService, 'preview' | 'start' | 'stop'>;

interface PreviewBinding {
	readonly ticketId: string;
	readonly projectId: string;
	readonly requestId: string;
	readonly requestRevision: number;
	readonly targetSessionId: string;
	readonly targetSessionRevision: number;
	readonly permissionPolicy: AgentSessionPermissionPolicy;
	readonly fingerprint: string;
	readonly expiresAt: number;
	readonly preview: AgentSessionLaunchPreview;
}

const HOST_OPERATION_ERROR = 'A session control operation could not be fully verified. Review the session status before retrying.';

export type AgentSessionControlApplicationErrorCode = 'INVALID_REQUEST' | 'PREVIEW_STALE' | 'PREVIEW_INVALID' | 'APPROVAL_INVALID' | 'START_FAILED' | 'HOST_FAILURE' | 'STOP_QUEUE_FULL' | 'SHUTTING_DOWN';

export class AgentSessionControlApplicationError extends Error {
	constructor(readonly code: AgentSessionControlApplicationErrorCode, message: string) {
		super(message);
		this.name = 'AgentSessionControlApplicationError';
	}
}

/** Coordinates durable human decisions with the trusted session runtime. */
export class AgentSessionControlApplication {
	private readonly ledger: RequestLedger;
	private readonly sessions: SessionLookup;
	private readonly turns: TurnLookup;
	private readonly previews = new Map<string, PreviewBinding>();
	private readonly stopJobs = new Map<string, Promise<AgentSessionControlRequestDTO>>();
	private readonly startJobs = new Set<Promise<void>>();
	private readonly unresolvedStartTurns = new Map<string, { readonly projectId: string; readonly sessionId: string; readonly turnId: string; readonly fingerprint: string }>();
	private readonly stopJobFailures = new Map<string, AgentSessionControlApplicationError>();
	private hostError: string | null = null;
	private accepting = true;
	private recoveryComplete = false;

	constructor(database: AgentSessionControlApplicationDatabase, private readonly service: PreviewService) {
		this.ledger = database.agentSessionControlRequests;
		this.sessions = database.agentSessions;
		this.turns = database.agentSessionTurns;
	}

	async previewStart(projectId: string, requestId: string): Promise<{ readonly request: AgentSessionControlRequestDTO; readonly preview: AgentSessionLaunchPreview }> {
		this.assertAccepting();
		const request = this.requirePendingStart(projectId, requestId);
		const session = this.sessions.getSession(projectId, request.targetSessionId);
		if (!session || session.revision !== request.expectedSessionRevision) {
			throw new AgentSessionControlApplicationError('PREVIEW_STALE', 'The target session changed before preview.');
		}
		const preview = await this.service.preview({ projectId, sessionId: request.targetSessionId, permissionPolicy: request.permissionPolicy! });
		this.assertAccepting();
		const current = this.requirePendingStart(projectId, requestId);
		const currentSession = this.sessions.getSession(projectId, current.targetSessionId);
		if (current.revision !== request.revision || current.targetSessionId !== request.targetSessionId
			|| current.expectedSessionRevision !== request.expectedSessionRevision
			|| JSON.stringify(current.permissionPolicy) !== JSON.stringify(request.permissionPolicy)
			|| !currentSession || currentSession.revision !== request.expectedSessionRevision) {
			throw new AgentSessionControlApplicationError('PREVIEW_STALE', 'The request or target session changed while preview was being prepared.');
		}
		if (preview.snapshot.projectId !== projectId || preview.snapshot.sessionId !== request.targetSessionId
			|| preview.snapshot.sessionRevision !== request.expectedSessionRevision
			|| JSON.stringify(preview.snapshot.permissionPolicy) !== JSON.stringify(request.permissionPolicy)
			|| !Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now()) {
			throw new AgentSessionControlApplicationError('PREVIEW_INVALID', 'The runtime preview does not match the approved request.');
		}
		const fingerprint = fingerprintSnapshot(preview.snapshot);
		this.prunePreviews();
		if (this.previews.size >= MAX_PREVIEWS) {
			throw new AgentSessionControlApplicationError('PREVIEW_INVALID', 'Too many launch previews are currently active.');
		}
		const binding = Object.freeze({
			ticketId: preview.ticketId, projectId, requestId, requestRevision: request.revision,
			targetSessionId: request.targetSessionId, targetSessionRevision: request.expectedSessionRevision!,
			permissionPolicy: request.permissionPolicy!, fingerprint, expiresAt: Date.parse(preview.expiresAt), preview,
		});
		this.previews.set(preview.ticketId, binding);
		return Object.freeze({ request, preview });
	}

	readStartReview(projectId: string, requestId: string, expectedRequestRevision: number, ticketId: string): { readonly request: AgentSessionControlRequestDTO; readonly preview: AgentSessionLaunchPreview } {
		this.assertAccepting();
		const binding = this.requirePreviewBinding(projectId, requestId, ticketId);
		const request = this.requirePendingStart(projectId, requestId);
		const session = this.sessions.getSession(projectId, request.targetSessionId);
		if (request.revision !== expectedRequestRevision || request.revision !== binding.requestRevision
			|| !session || session.revision !== binding.targetSessionRevision || request.expectedSessionRevision !== binding.targetSessionRevision) {
			throw new AgentSessionControlApplicationError('APPROVAL_INVALID', 'The launch preview no longer matches the pending start review.');
		}
		return Object.freeze({ request, preview: binding.preview });
	}

	isControlPreview(ticketId: string): boolean {
		this.prunePreviews();
		return this.previews.has(ticketId);
	}

	getHostError(): string | null {
		return this.hostError;
	}

	async startReviewed(projectId: string, requestId: string, expectedRequestRevision: number, ticketId: string, idempotencyKey: string): Promise<AgentSessionControlRequestDTO> {
		this.assertAccepting();
		if (this.unresolvedStartTurns.size >= MAX_UNRESOLVED_STARTS) {
			throw new AgentSessionControlApplicationError('HOST_FAILURE', HOST_OPERATION_ERROR);
		}
		this.prunePreviews();
		const binding = this.previews.get(ticketId);
		const request = this.ledger.get(projectId, requestId);
		if (!binding || binding.projectId !== projectId || binding.requestId !== requestId || !request || request.kind !== 'start'
			|| request.targetSessionId !== binding.targetSessionId || request.expectedSessionRevision !== binding.targetSessionRevision
			|| JSON.stringify(request.permissionPolicy) !== JSON.stringify(binding.permissionPolicy)
			|| !((request.state === 'pendingReview' && request.revision === expectedRequestRevision && expectedRequestRevision === binding.requestRevision)
				|| (['starting', 'started', 'startFailed'].includes(request.state) && request.approvedIdempotencyKey === idempotencyKey && request.snapshotFingerprint === binding.fingerprint))) {
			throw new AgentSessionControlApplicationError('APPROVAL_INVALID', 'The preview is missing, expired, or does not match this approval.');
		}
		if (binding.expiresAt <= Date.now()) {
			this.previews.delete(ticketId);
			throw new AgentSessionControlApplicationError('APPROVAL_INVALID', 'The launch preview expired.');
		}
		const replay = ['starting', 'started', 'startFailed'].includes(request.state)
			&& request.approvedIdempotencyKey === idempotencyKey && request.snapshotFingerprint === binding.fingerprint;
		if (!replay) {
			const session = this.sessions.getSession(projectId, binding.targetSessionId);
			if (!session || session.revision !== binding.targetSessionRevision) {
				throw new AgentSessionControlApplicationError('APPROVAL_INVALID', 'The target session changed after preview.');
			}
		}
		const claim = this.ledger.beginStart(requestId, expectedRequestRevision, binding.fingerprint, idempotencyKey);
		if (!claim.claimed) { return claim.request; }
		return this.trackStart(this.runApprovedStart(projectId, requestId, binding, ticketId));
	}

	/** Persists acceptance synchronously and stops only after the host yields back to its event loop. */
	queueStop(request: AgentSessionControlRequestDTO): { readonly status: 'queued' | 'alreadyQueued'; readonly request: AgentSessionControlRequestDTO } {
		this.assertAccepting();
		if (!request || request.kind !== 'stop' || request.state !== 'stopAccepted' || !request.targetTurnId) {
			throw new AgentSessionControlApplicationError('INVALID_REQUEST', 'Only a persisted accepted stop request can be queued.');
		}
		const persisted = this.ledger.get(request.projectId, request.id);
		if (!persisted || persisted.kind !== 'stop' || persisted.state !== 'stopAccepted'
			|| persisted.targetSessionId !== request.targetSessionId || persisted.targetTurnId !== request.targetTurnId) {
			throw new AgentSessionControlApplicationError('INVALID_REQUEST', 'The stop receipt is no longer current.');
		}
		const existing = this.stopJobs.get(request.id);
		if (existing) { return { status: 'alreadyQueued', request: persisted }; }
		if (this.stopJobFailures.has(request.id)) { throw new AgentSessionControlApplicationError('HOST_FAILURE', HOST_OPERATION_ERROR); }
		if (this.stopJobs.size >= MAX_STOP_JOBS) {
			throw new AgentSessionControlApplicationError('STOP_QUEUE_FULL', 'The host stop queue is full; the durable request remains accepted.');
		}
		let resolveJob!: (value: AgentSessionControlRequestDTO) => void;
		const job = new Promise<AgentSessionControlRequestDTO>(resolve => { resolveJob = resolve; });
		this.stopJobs.set(request.id, job);
		setImmediate(() => {
			void this.runStop(request.projectId, request.id, request.targetSessionId, request.targetTurnId!).then(resolveJob, () => {
				this.hostError = HOST_OPERATION_ERROR;
				this.stopJobFailures.set(request.id, new AgentSessionControlApplicationError('HOST_FAILURE', HOST_OPERATION_ERROR));
				if (this.stopJobFailures.size > MAX_STOP_JOBS) { this.stopJobFailures.delete(this.stopJobFailures.keys().next().value!); }
				resolveJob(persisted);
			});
		});
		return { status: 'queued', request: persisted };
	}

	recoverStartup(): number {
		this.assertAccepting();
		if (this.recoveryComplete) { return 0; }
		const recovered = this.ledger.recoverInterruptedStarts();
		this.recoveryComplete = true;
		return recovered;
	}

	async waitForIdle(): Promise<void> {
		while (this.stopJobs.size > 0 || this.startJobs.size > 0) {
			await Promise.all([...this.stopJobs.values(), ...this.startJobs]);
		}
		if (this.stopJobFailures.size > 0 || this.unresolvedStartTurns.size > 0 || this.hostError !== null) {
			throw new AgentSessionControlApplicationError('HOST_FAILURE', HOST_OPERATION_ERROR);
		}
	}

	async shutdown(): Promise<void> {
		this.accepting = false;
		this.previews.clear();
		let idleFailure: unknown;
		try { await this.waitForIdle(); } catch (error) { idleFailure = error; }
		await this.cleanupUnresolvedStarts();
		if (this.unresolvedStartTurns.size > 0 || idleFailure || this.hostError !== null) { throw new AgentSessionControlApplicationError('HOST_FAILURE', HOST_OPERATION_ERROR); }
	}

	private async runApprovedStart(projectId: string, requestId: string, binding: PreviewBinding, ticketId: string): Promise<AgentSessionControlRequestDTO> {
		const priorTurnIds = new Set(this.turns.listTurns(projectId, binding.targetSessionId).map(turn => turn.id));
		let returnedTurn: AgentSessionTurnDTO | undefined;
		try {
			returnedTurn = await this.service.start({ projectId, sessionId: binding.targetSessionId, ticketId });
			if (returnedTurn.projectId !== projectId || returnedTurn.sessionId !== binding.targetSessionId || returnedTurn.snapshotSha256 !== binding.fingerprint) {
				throw new AgentSessionControlApplicationError('START_FAILED', START_FAILED);
			}
			try {
				return this.ledger.markStarted(requestId, returnedTurn.id);
			} catch {
				const cleaned = await this.stopAndVerifyOwnedStart(projectId, binding.targetSessionId, returnedTurn.id, binding.fingerprint, priorTurnIds);
				if (cleaned) { this.recordStartFailure(requestId, 'The approved start was stopped because its durable result could not be recorded.'); }
				else { this.retainUnresolvedStart(projectId, binding.targetSessionId, returnedTurn.id, binding.fingerprint); }
				throw new AgentSessionControlApplicationError('START_FAILED', cleaned ? START_FAILED : HOST_OPERATION_ERROR);
			}
		} catch (error) {
			if (returnedTurn && returnedTurn.projectId === projectId && returnedTurn.sessionId === binding.targetSessionId && returnedTurn.snapshotSha256 === binding.fingerprint) { throw error; }
			const candidates = this.turns.listTurns(projectId, binding.targetSessionId).filter(turn => !priorTurnIds.has(turn.id) && turn.snapshotSha256 === binding.fingerprint);
			let safelyStopped = !returnedTurn;
			for (const turn of candidates) {
				const cleaned = await this.stopAndVerifyOwnedStart(projectId, binding.targetSessionId, turn.id, binding.fingerprint, priorTurnIds);
				safelyStopped = safelyStopped && cleaned;
				if (!cleaned) { this.retainUnresolvedStart(projectId, binding.targetSessionId, turn.id, binding.fingerprint); }
			}
			if (safelyStopped) { this.recordStartFailure(requestId, START_FAILED); }
			else { this.hostError = HOST_OPERATION_ERROR; }
			throw new AgentSessionControlApplicationError('START_FAILED', safelyStopped ? START_FAILED : HOST_OPERATION_ERROR);
		}
	}

	private recordStartFailure(requestId: string, error: string): void {
		try { this.ledger.markStartFailed(requestId, error); } catch {
			this.hostError = HOST_OPERATION_ERROR;
		}
	}

	private async stopAndVerifyOwnedStart(projectId: string, sessionId: string, turnId: string, fingerprint: string, priorTurnIds: ReadonlySet<string>): Promise<boolean> {
		if (priorTurnIds.has(turnId)) { return false; }
		let before: AgentSessionTurnDTO | undefined;
		try { before = this.turns.getTurn(projectId, sessionId, turnId); } catch {
			this.hostError = HOST_OPERATION_ERROR;
			return false;
		}
		if (!before || before.snapshotSha256 !== fingerprint || before.projectId !== projectId || before.sessionId !== sessionId) { return false; }
		if (['exited', 'failed', 'interrupted'].includes(before.state) && before.cleanupVerified) { return true; }
		try { await this.service.stop(projectId, sessionId, turnId); } catch {
			let afterFailure: AgentSessionTurnDTO | undefined;
			try { afterFailure = this.turns.getTurn(projectId, sessionId, turnId); } catch {
				this.hostError = HOST_OPERATION_ERROR;
				return false;
			}
			if (isVerifiedCleanup(afterFailure, projectId, sessionId, turnId, fingerprint)) { return true; }
			this.hostError = HOST_OPERATION_ERROR;
			return false;
		}
		let after: AgentSessionTurnDTO | undefined;
		try { after = this.turns.getTurn(projectId, sessionId, turnId); } catch {
			this.hostError = HOST_OPERATION_ERROR;
			return false;
		}
		const verified = isVerifiedCleanup(after, projectId, sessionId, turnId, fingerprint);
		if (!verified) { this.hostError = HOST_OPERATION_ERROR; }
		return verified;
	}

	private retainUnresolvedStart(projectId: string, sessionId: string, turnId: string, fingerprint: string): void {
		this.unresolvedStartTurns.set(turnId, { projectId, sessionId, turnId, fingerprint });
		this.hostError = HOST_OPERATION_ERROR;
	}

	private async cleanupUnresolvedStarts(): Promise<void> {
		for (const record of this.unresolvedStartTurns.values()) {
			if (await this.stopAndVerifyOwnedStart(record.projectId, record.sessionId, record.turnId, record.fingerprint, new Set())) {
				this.unresolvedStartTurns.delete(record.turnId);
			}
		}
	}

	private trackStart<T>(operation: Promise<T>): Promise<T> {
		const tracked = operation.then(() => undefined, error => {
			if (!(error instanceof AgentSessionControlApplicationError && error.code === 'START_FAILED') && this.hostError === null) {
				this.hostError = HOST_OPERATION_ERROR;
			}
		});
		this.startJobs.add(tracked);
		void tracked.then(() => this.startJobs.delete(tracked));
		return operation;
	}

	private requirePreviewBinding(projectId: string, requestId: string, ticketId: string): PreviewBinding {
		this.prunePreviews();
		const binding = this.previews.get(ticketId);
		if (!binding || binding.projectId !== projectId || binding.requestId !== requestId || binding.expiresAt <= Date.now()) {
			throw new AgentSessionControlApplicationError('APPROVAL_INVALID', 'The launch preview is missing or expired.');
		}
		return binding;
	}

	private async runStop(projectId: string, requestId: string, targetSessionId: string, targetTurnId: string): Promise<AgentSessionControlRequestDTO> {
		let error: string | undefined;
		try {
			const authorized = this.ledger.validateAcceptedStop(projectId, requestId);
			if (authorized.projectId !== projectId || authorized.targetSessionId !== targetSessionId || authorized.targetTurnId !== targetTurnId) {
				throw new Error('The accepted stop scope changed.');
			}
			await this.service.stop(projectId, targetSessionId, targetTurnId);
		} catch {
			error = STOP_FAILED;
		}
		try {
			return this.ledger.markStopResult(requestId, error);
		} finally {
			this.stopJobs.delete(requestId);
		}
	}

	private requirePendingStart(projectId: string, requestId: string): AgentSessionControlRequestDTO {
		const request = this.ledger.get(projectId, requestId);
		if (!request || request.projectId !== projectId || request.kind !== 'start' || request.state !== 'pendingReview'
			|| request.expectedSessionRevision === null || request.permissionPolicy === null) {
			throw new AgentSessionControlApplicationError('INVALID_REQUEST', 'The project-scoped start request is not pending review.');
		}
		return request;
	}

	private prunePreviews(): void {
		const now = Date.now();
		for (const [id, binding] of this.previews) { if (binding.expiresAt <= now) { this.previews.delete(id); } }
	}

	private assertAccepting(): void {
		if (!this.accepting) { throw new AgentSessionControlApplicationError('SHUTTING_DOWN', 'The session control host is shutting down.'); }
	}
}

function fingerprintSnapshot(snapshot: AgentSessionTurnSnapshot): string {
	return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function isVerifiedCleanup(turn: AgentSessionTurnDTO | undefined, projectId: string, sessionId: string, turnId: string, fingerprint: string): boolean {
	return !!turn && turn.id === turnId && turn.projectId === projectId && turn.sessionId === sessionId
		&& turn.snapshotSha256 === fingerprint && ['exited', 'failed', 'interrupted'].includes(turn.state) && turn.cleanupVerified;
}
