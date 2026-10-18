/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type {
	AgentSessionDTO,
	AgentSessionKnowledgeRef,
	AgentSessionState,
	AgentSessionTurnDTO,
	AgentSessionTurnLifecycleResult,
	AgentSessionTurnSnapshot,
	AgentSessionTurnState,
	AgentSessionTurnUpdate,
	CreateAgentSessionTurnInput,
} from '../../common/workspaceAgentSessionProtocol.js';
import { canTransitionAgentSessionState } from './agentSessionTransitions.js';
import { AgentSessionStore } from './agentSessionStore.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REFERENCE_COUNT = 100;
const MAX_ERROR_SUMMARY_LENGTH = 2000;

interface WorkflowLaunchValidation {
	readonly reservationId: string;
	readonly runId: string;
	readonly nodeId: string;
	readonly turnId: string;
	readonly nodeRevision: number;
	readonly maxConcurrentNodes: number;
}

const TURN_TRANSITIONS: Readonly<Record<AgentSessionTurnState, ReadonlySet<AgentSessionTurnState>>> = {
	starting: new Set(['running', 'stopping', 'interrupted', 'failed']),
	running: new Set(['stopping', 'exited', 'interrupted', 'failed']),
	stopping: new Set(['exited', 'interrupted', 'failed']),
	exited: new Set(),
	interrupted: new Set(),
	failed: new Set(),
};

const SESSION_STATE_FOR_TURN: Readonly<Record<AgentSessionTurnState, AgentSessionState>> = {
	starting: 'starting', running: 'running', stopping: 'stopping',
	exited: 'idle', interrupted: 'interrupted', failed: 'failed',
};

/** Durable launch snapshots and lifecycle records. Only the main-process PTY host should call lifecycle methods. */
export class AgentSessionTurnStore {
	constructor(private readonly db: DatabaseSync, private readonly assertOpen: () => void, private readonly sessions: AgentSessionStore) { }

	/**
	 * Persists an allowlisted snapshot supplied by the trusted host. It records lease-owner identity but does not
	 * prove worktree path provenance; AgentSessionService must call ManagedWorktreeService.inspect and require
	 * a verified session-owned lease before invoking this method or starting a PTY.
	 */
	createTurn(input: CreateAgentSessionTurnInput): AgentSessionTurnDTO {
		this.assertOpen();
		this.validateUuid(input.projectId, 'project ID');
		this.validateUuid(input.sessionId, 'session ID');
		if (!Number.isSafeInteger(input.expectedSessionRevision) || input.expectedSessionRevision < 1) { throw new Error('The expected session revision is invalid.'); }
		const initialSession = this.sessions.getSession(input.projectId, input.sessionId);
		if (!initialSession) { throw new Error('The session does not belong to this project.'); }
		const inputSnapshot = input.snapshot;
		if (!inputSnapshot || inputSnapshot.projectId !== input.projectId || inputSnapshot.sessionId !== input.sessionId
			|| inputSnapshot.sessionRevision !== input.expectedSessionRevision || inputSnapshot.bindingId !== initialSession.bindingId
			|| inputSnapshot.taskId !== initialSession.taskId || inputSnapshot.provider !== initialSession.provider
			|| inputSnapshot.model !== initialSession.model || inputSnapshot.profileRef !== initialSession.profileRef) {
			throw new Error('The launch snapshot provider, model, profile, and ownership must match the persisted session.');
		}
		const snapshot = this.validateSnapshot(input.snapshot);
		if (snapshot.projectId !== input.projectId || snapshot.sessionId !== input.sessionId || snapshot.sessionRevision !== input.expectedSessionRevision) {
			throw new Error('The turn snapshot must match its project, session, and expected session revision.');
		}
		const snapshotJson = JSON.stringify(snapshot);
		if (Buffer.byteLength(snapshotJson, 'utf8') > 65_536) { throw new Error('The launch snapshot exceeds 64 KiB.'); }
		const snapshotSha256 = digest(snapshotJson);
		if (input.workflowLaunchAuthorization !== undefined) {
			this.assertExactKeys(input.workflowLaunchAuthorization, ['reservationId'], 'workflow launch authorization');
		}
		const now = new Date().toISOString();
		return this.transaction(() => {
			const workflowLaunch = input.workflowLaunchAuthorization
				? this.validateWorkflowLaunchAuthorization(input.workflowLaunchAuthorization.reservationId, input.projectId, input.sessionId, input.expectedSessionRevision, snapshot)
				: undefined;
			const id = workflowLaunch?.turnId ?? randomUUID();
			const session = this.sessions.getSession(input.projectId, input.sessionId);
			if (!session) { throw new Error('The session does not belong to this project.'); }
			if (session.revision !== input.expectedSessionRevision) { throw new Error('The session revision is stale.'); }
			if (session.provider !== snapshot.provider || session.model !== snapshot.model || session.profileRef !== snapshot.profileRef
				|| session.bindingId !== snapshot.bindingId || session.taskId !== snapshot.taskId) {
				throw new Error('The launch snapshot provider, model, profile, and ownership must match the persisted session.');
			}
			if (session.state === 'stopped' && workflowLaunch) { throw new Error('A stopped session cannot be restarted by a workflow launch reservation.'); }
			const stoppedManualResume = session.state === 'stopped' && workflowLaunch === undefined;
			const binding = this.db.prepare('SELECT path FROM folder_bindings WHERE id = ? AND project_id = ?').get(session.bindingId, input.projectId) as { path: string } | undefined;
			if (!binding) { throw new Error('The launch binding does not belong to the session project.'); }
			if (session.workspaceMode === 'sharedFolder') {
				if (snapshot.managedWorktreeOwnerId !== null || realpathSync(binding.path) !== snapshot.folderIdentity.canonicalPath) {
					throw new Error('A shared-folder launch must use its bound canonical folder and no managed worktree lease.');
				}
			} else if (snapshot.managedWorktreeOwnerId !== session.id) {
				throw new Error('A Git worktree launch must carry the session-owned worktree lease identity.');
			}
			this.assertKnowledgeReferences(session, snapshot);
			if (!stoppedManualResume && !['created', 'idle', 'interrupted', 'failed'].includes(session.state)) { throw new Error('The session is not ready to start a new turn.'); }
			const ordinal = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal FROM agent_session_turns WHERE project_id = ? AND session_id = ?')
				.get(input.projectId, input.sessionId)?.next_ordinal ?? 1);
			this.db.prepare(`INSERT INTO agent_session_turns (
				id, project_id, session_id, ordinal, state, revision, provider, model, profile_ref,
				snapshot_json, snapshot_sha256, provider_conversation_id, exit_code, exit_signal, error_summary,
				cleanup_verified, created_at, updated_at, started_at, finished_at
			) VALUES (?, ?, ?, ?, 'starting', 1, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?, NULL, NULL)`).run(
				id, input.projectId, input.sessionId, ordinal, session.provider, session.model, session.profileRef,
				snapshotJson, snapshotSha256, now, now,
			);
			if (workflowLaunch) { this.consumeWorkflowLaunchAuthorization(workflowLaunch, now); }
			if (stoppedManualResume) {
				this.sessions.resumeStoppedSessionForTurnWithinTransaction(input.projectId, input.sessionId, input.expectedSessionRevision, id);
			} else {
				this.sessions.transitionSessionWithinTransaction(input.projectId, input.sessionId, input.expectedSessionRevision, 'starting');
			}
			return this.readTurnInternal(input.projectId, input.sessionId, id)!;
		});
	}

	getTurn(projectId: string, sessionId: string, turnId: string): AgentSessionTurnDTO | undefined {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(sessionId, 'session ID');
		this.validateUuid(turnId, 'turn ID');
		return this.readTurnInternal(projectId, sessionId, turnId);
	}

	/** Records cleanup proof from the trusted host without changing the terminal outcome or session state. */
	confirmTurnCleanup(projectId: string, sessionId: string, turnId: string, expectedTurnRevision: number): AgentSessionTurnDTO {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(sessionId, 'session ID');
		this.validateUuid(turnId, 'turn ID');
		if (!Number.isSafeInteger(expectedTurnRevision) || expectedTurnRevision < 1) { throw new Error('The expected turn revision is invalid.'); }
		return this.transaction(() => {
			const turn = this.readTurnInternal(projectId, sessionId, turnId);
			if (!turn) { throw new Error('The turn does not belong to this project and session.'); }
			if (turn.revision !== expectedTurnRevision) { throw new Error('The turn revision is stale.'); }
			if (!this.isTerminal(turn.state)) { throw new Error('Cleanup proof may only be recorded for a terminal turn.'); }
			if (turn.cleanupVerified) { return turn; }
			const now = new Date().toISOString();
			const changed = this.db.prepare(`UPDATE agent_session_turns SET cleanup_verified = 1, revision = revision + 1, updated_at = ?
				WHERE id = ? AND project_id = ? AND session_id = ? AND revision = ? AND state IN ('exited', 'interrupted', 'failed') AND cleanup_verified = 0`)
				.run(now, turnId, projectId, sessionId, expectedTurnRevision);
			if (Number(changed.changes) !== 1) { throw new Error('The turn revision is stale or the turn is not terminal.'); }
			return this.readTurnInternal(projectId, sessionId, turnId)!;
		});
	}

	listTurns(projectId: string, sessionId: string): AgentSessionTurnDTO[] {
		this.assertOpen();
		this.assertOwnedSession(projectId, sessionId);
		return this.db.prepare(`SELECT id FROM agent_session_turns WHERE project_id = ? AND session_id = ? ORDER BY ordinal`)
			.all(projectId, sessionId).map(row => this.readTurnInternal(projectId, sessionId, String(row.id))!);
	}

	getPreviousTurn(projectId: string, sessionId: string, turnId: string): AgentSessionTurnDTO | undefined {
		this.assertOpen();
		this.assertOwnedSession(projectId, sessionId);
		this.validateUuid(turnId, 'turn ID');
		const current = this.readTurnInternal(projectId, sessionId, turnId);
		if (!current) { throw new Error('The turn does not belong to this project and session.'); }
		const previous = this.db.prepare(`SELECT id FROM agent_session_turns
			WHERE project_id = ? AND session_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT 1`)
			.get(projectId, sessionId, current.ordinal) as Record<string, SQLOutputValue> | undefined;
		return previous ? this.readTurnInternal(projectId, sessionId, String(previous.id)) : undefined;
	}

	transitionTurn(
		projectId: string,
		sessionId: string,
		turnId: string,
		expectedTurnRevision: number,
		expectedSessionRevision: number,
		update: AgentSessionTurnUpdate,
	): AgentSessionTurnLifecycleResult {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(sessionId, 'session ID');
		this.validateUuid(turnId, 'turn ID');
		if (!Number.isSafeInteger(expectedTurnRevision) || expectedTurnRevision < 1 || !Number.isSafeInteger(expectedSessionRevision) || expectedSessionRevision < 1) {
			throw new Error('The expected turn and session revisions are invalid.');
		}
		this.validateTurnUpdate(update);
		return this.transaction(() => {
			const turn = this.readTurnInternal(projectId, sessionId, turnId);
			const session = this.sessions.getSession(projectId, sessionId);
			if (!turn || !session) { throw new Error('The turn does not belong to this project and session.'); }
			if (turn.revision !== expectedTurnRevision) { throw new Error('The turn revision is stale.'); }
			if (session.revision !== expectedSessionRevision) { throw new Error('The session revision is stale.'); }
			if (!TURN_TRANSITIONS[turn.state].has(update.state)) { throw new Error('The turn lifecycle transition is invalid.'); }
			const nextSessionState = update.state === 'exited' && session.state === 'stopping' ? 'stopped' : SESSION_STATE_FOR_TURN[update.state];
			if (session.state !== nextSessionState && !canTransitionAgentSessionState(session.state, nextSessionState)) { throw new Error('The session lifecycle transition is invalid for this turn update.'); }
			const terminal = this.isTerminal(update.state);
			const now = new Date().toISOString();
			const exitCode = update.exitCode ?? null;
			const exitSignal = update.exitSignal ?? null;
			const errorSummary = update.errorSummary ?? null;
			const cleanupVerified = update.cleanupVerified ?? false;
			if (!terminal && (exitCode !== null || exitSignal !== null || errorSummary !== null || cleanupVerified)) {
				throw new Error('Exit results and cleanup verification may only be recorded on a terminal turn state.');
			}
			const changed = this.db.prepare(`UPDATE agent_session_turns SET state = ?, revision = revision + 1,
				exit_code = ?, exit_signal = ?, error_summary = ?, cleanup_verified = ?, updated_at = ?, finished_at = ?,
				started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END
				WHERE id = ? AND project_id = ? AND session_id = ? AND revision = ?`)
				.run(update.state, exitCode, exitSignal, errorSummary, cleanupVerified ? 1 : 0, now, terminal ? now : null, update.state, now,
					turnId, projectId, sessionId, expectedTurnRevision);
			if (Number(changed.changes) !== 1) { throw new Error('The turn revision is stale.'); }
			const nextSession = session.state === nextSessionState
				? session
				: this.sessions.transitionSessionWithinTransaction(projectId, sessionId, expectedSessionRevision, nextSessionState);
			return { turn: this.readTurnInternal(projectId, sessionId, turnId)!, session: nextSession };
		});
	}

	/** The provider conversation ID is accepted only from an explicit provider adapter event, never parsed from terminal output. */
	recordProviderConversationId(projectId: string, sessionId: string, turnId: string, expectedTurnRevision: number, conversationId: string): AgentSessionTurnDTO {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(sessionId, 'session ID');
		this.validateUuid(turnId, 'turn ID');
		if (!Number.isSafeInteger(expectedTurnRevision) || expectedTurnRevision < 1) { throw new Error('The expected turn revision is invalid.'); }
		this.validateUuid(conversationId, 'provider conversation ID');
		return this.transaction(() => {
			const turn = this.readTurnInternal(projectId, sessionId, turnId);
			if (!turn) { throw new Error('The turn does not belong to this project and session.'); }
			if (turn.revision !== expectedTurnRevision) { throw new Error('The turn revision is stale.'); }
			if (turn.providerConversationId !== null) {
				if (turn.providerConversationId !== conversationId) { throw new Error('The provider conversation ID is immutable once recorded.'); }
				return turn;
			}
			if (this.isTerminal(turn.state)) { throw new Error('A provider conversation ID cannot be added after the turn ends.'); }
			const now = new Date().toISOString();
			const changed = this.db.prepare(`UPDATE agent_session_turns SET provider_conversation_id = ?, revision = revision + 1, updated_at = ?
				WHERE id = ? AND project_id = ? AND session_id = ? AND revision = ? AND provider_conversation_id IS NULL`)
				.run(conversationId, now, turnId, projectId, sessionId, expectedTurnRevision);
			if (Number(changed.changes) !== 1) { throw new Error('The turn revision is stale.'); }
			return this.readTurnInternal(projectId, sessionId, turnId)!;
		});
	}

	/** Called by the trusted host on startup when prior PTY ownership cannot be re-proved. It never signals stored PIDs. */
	interruptUnverifiedLiveTurnsOnStartup(): number {
		this.assertOpen();
		return this.transaction(() => {
			const live = this.db.prepare(`SELECT id, project_id, session_id, state, revision FROM agent_session_turns
				WHERE state IN ('starting', 'running', 'stopping') ORDER BY created_at, id`).all();
			let interrupted = 0;
			for (const row of live) {
				const projectId = String(row.project_id);
				const sessionId = String(row.session_id);
				const turnId = String(row.id);
				const turnRevision = Number(row.revision);
				const turn = this.readTurnInternal(projectId, sessionId, turnId);
				const session = this.sessions.getSession(projectId, sessionId);
				if (!turn || !session || turn.revision !== turnRevision) { throw new Error('A live turn changed while startup recovery was running.'); }
				if (session.state !== 'interrupted' && !canTransitionAgentSessionState(session.state, 'interrupted')) { throw new Error('The live turn session cannot be marked interrupted safely.'); }
				const now = new Date().toISOString();
				const changed = this.db.prepare(`UPDATE agent_session_turns SET state = 'interrupted', revision = revision + 1,
					error_summary = ?, cleanup_verified = 0, updated_at = ?, finished_at = ?
					WHERE id = ? AND project_id = ? AND session_id = ? AND revision = ? AND state IN ('starting', 'running', 'stopping')`)
					.run('The app restarted and could not re-prove ownership of the prior PTY; cleanup is unverified.', now, now, turnId, projectId, sessionId, turnRevision);
				if (Number(changed.changes) !== 1) { throw new Error('A live turn changed while startup recovery was running.'); }
				if (session.state !== 'interrupted') { this.sessions.transitionSessionWithinTransaction(projectId, sessionId, session.revision, 'interrupted'); }
				interrupted++;
			}
			return interrupted;
		});
	}

	private validateWorkflowLaunchAuthorization(reservationId: string, projectId: string, sessionId: string, sessionRevision: number, snapshot: AgentSessionTurnSnapshot): WorkflowLaunchValidation {
		this.validateUuid(reservationId, 'workflow launch reservation ID');
		const reservation = this.db.prepare(`SELECT reservation.reserved_turn_id, reservation.project_id, reservation.workflow_id, reservation.run_id,
			reservation.node_id, reservation.approval_fingerprint AS reservation_fingerprint, reservation.session_id, reservation.session_revision,
			reservation.expires_at, reservation.consumed_at, reservation.revoked_at, run.state AS run_state, run.deadline_at,
			run.plan_version, run.fingerprint, workflow.state AS workflow_state, workflow.plan_version AS workflow_plan_version,
			approval.fingerprint AS approval_fingerprint, plan.fingerprint AS plan_fingerprint, plan.plan_json,
			node.state AS node_state, node.revision AS node_revision, node.session_turn_id, node.session_id AS node_session_id
			FROM agent_workflow_turn_reservations reservation
			JOIN agent_workflow_runs run ON run.id = reservation.run_id AND run.workflow_id = reservation.workflow_id AND run.project_id = reservation.project_id
			JOIN agent_workflows workflow ON workflow.id = reservation.workflow_id AND workflow.project_id = reservation.project_id
			JOIN agent_workflow_approvals approval ON approval.workflow_id = run.workflow_id AND approval.project_id = run.project_id
				AND approval.plan_version = run.plan_version AND approval.fingerprint = run.fingerprint
			JOIN agent_workflow_plans plan ON plan.workflow_id = run.workflow_id AND plan.project_id = run.project_id AND plan.version = run.plan_version
			JOIN agent_workflow_run_nodes node ON node.run_id = run.id AND node.workflow_id = run.workflow_id AND node.node_id = reservation.node_id
			WHERE reservation.id = ?`).get(reservationId) as Record<string, unknown> | undefined;
		if (!reservation || String(reservation.project_id) !== projectId || String(reservation.session_id) !== sessionId
			|| String(reservation.node_session_id) !== sessionId || Number(reservation.session_revision) !== sessionRevision
			|| String(reservation.reservation_fingerprint) !== String(reservation.fingerprint)
			|| String(reservation.approval_fingerprint) !== String(reservation.fingerprint) || String(reservation.plan_fingerprint) !== String(reservation.fingerprint)
			|| Number(reservation.workflow_plan_version) !== Number(reservation.plan_version)
			|| reservation.consumed_at !== null || reservation.revoked_at !== null
			|| Date.parse(String(reservation.expires_at)) <= Date.now() || Date.parse(String(reservation.deadline_at)) <= Date.now()
			|| !['running'].includes(String(reservation.run_state)) || !['running'].includes(String(reservation.workflow_state))
			|| reservation.node_state !== 'launching' || reservation.session_turn_id !== null) {
			throw new Error('The workflow launch authorization is missing, stale, expired, cancelled, or already consumed.');
		}
		const plan = JSON.parse(String(reservation.plan_json)) as { maxConcurrentNodes: number; nodes?: Array<{ nodeId: string; sessionId: string; bindingId: string; taskId: string | null; provider: string; model: string; permissionPolicy: AgentSessionTurnSnapshot['permissionPolicy']; referenceIds: Array<{ kind: string; id: string }> }> };
		if (!Number.isSafeInteger(plan.maxConcurrentNodes) || this.countWorkflowCapacitySlots(String(reservation.run_id), new Date().toISOString()) > plan.maxConcurrentNodes) {
			throw new Error('The workflow maximum concurrency reservation is invalid.');
		}
		const node = plan.nodes?.find(candidate => candidate.nodeId === String(reservation.node_id));
		if (!node || node.sessionId !== sessionId || node.bindingId !== snapshot.bindingId || node.taskId !== snapshot.taskId
			|| node.provider !== snapshot.provider || node.model !== snapshot.model
			|| node.permissionPolicy.mode !== snapshot.permissionPolicy.mode || node.permissionPolicy.approval !== snapshot.permissionPolicy.approval) {
			throw new Error('The workflow turn snapshot does not match its approved reservation.');
		}
		const expectedReferences = node.referenceIds.filter(reference => reference.kind === 'knowledgeSnapshot').map(reference => reference.id).sort();
		const actualReferences = snapshot.references.map(reference => reference.id).sort();
		const expectedConvention = node.referenceIds.find(reference => reference.kind === 'conventionVersion')?.id ?? null;
		if (JSON.stringify(expectedReferences) !== JSON.stringify(actualReferences) || (snapshot.convention?.id ?? null) !== expectedConvention) {
			throw new Error('The workflow turn knowledge snapshot does not match its approved reservation.');
		}
		return {
			reservationId, runId: String(reservation.run_id), nodeId: String(reservation.node_id),
			turnId: String(reservation.reserved_turn_id), nodeRevision: Number(reservation.node_revision),
			maxConcurrentNodes: plan.maxConcurrentNodes,
		};
	}

	private consumeWorkflowLaunchAuthorization(launch: WorkflowLaunchValidation, now: string): void {
		const consumed = this.db.prepare(`UPDATE agent_workflow_turn_reservations SET consumed_at = ?, consumed_turn_id = reserved_turn_id
			WHERE id = ? AND reserved_turn_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).run(now, launch.reservationId, launch.turnId, now);
		if (Number(consumed.changes) !== 1) { throw new Error('The workflow launch authorization was consumed concurrently, cancelled, or expired.'); }
		const linked = this.db.prepare(`UPDATE agent_workflow_run_nodes SET session_turn_id = ?, revision = revision + 1, updated_at = ?
			WHERE run_id = ? AND node_id = ? AND revision = ? AND state = 'launching' AND session_turn_id IS NULL`)
			.run(launch.turnId, now, launch.runId, launch.nodeId, launch.nodeRevision);
		if (Number(linked.changes) !== 1) { throw new Error('The workflow node launch reservation changed before the turn was created.'); }
	}

	private countWorkflowCapacitySlots(runId: string, now: string): number {
		return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM agent_workflow_run_nodes node WHERE node.run_id = ? AND (
			node.state IN ('running', 'cancelRequested') OR (
				node.state IN ('launching', 'interrupted', 'recoveryRequired') AND node.session_turn_id IS NOT NULL AND EXISTS (
					SELECT 1 FROM agent_session_turns turn WHERE turn.id = node.session_turn_id AND turn.cleanup_verified = 0
				)
			) OR EXISTS (
				SELECT 1 FROM agent_workflow_turn_reservations reservation WHERE reservation.run_id = node.run_id
				AND reservation.node_id = node.node_id AND reservation.consumed_at IS NULL AND reservation.revoked_at IS NULL
				AND reservation.expires_at > ?
			)
		)`).get(runId, now)?.count ?? 0);
	}

	private validateSnapshot(input: AgentSessionTurnSnapshot): AgentSessionTurnSnapshot {
		this.assertExactKeys(input, ['schemaVersion', 'projectId', 'sessionId', 'sessionRevision', 'bindingId', 'taskId', 'provider', 'model', 'profileRef', 'cwd', 'folderIdentity', 'managedWorktreeOwnerId', 'permissionPolicy', 'convention', 'references'], 'launch snapshot');
		if (input.schemaVersion !== 1) { throw new Error('The launch snapshot schema version is unsupported.'); }
		this.validateUuid(input.projectId, 'snapshot project ID');
		this.validateUuid(input.sessionId, 'snapshot session ID');
		this.validateUuid(input.bindingId, 'snapshot binding ID');
		if (input.taskId !== null) { this.validateUuid(input.taskId, 'snapshot task ID'); }
		if (!Number.isSafeInteger(input.sessionRevision) || input.sessionRevision < 1) { throw new Error('The snapshot session revision is invalid.'); }
		if (input.provider !== 'codex' && input.provider !== 'claude') { throw new Error('The snapshot provider is invalid.'); }
		if (typeof input.model !== 'string' || !input.model.trim() || input.model.trim().length > 200) { throw new Error('The snapshot model must contain 1 to 200 characters.'); }
		if (input.profileRef !== null && (typeof input.profileRef !== 'string' || input.profileRef.trim().length > 512)) { throw new Error('The snapshot profile reference exceeds 512 characters.'); }
		if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || realpathSync(input.cwd) !== input.cwd) { throw new Error('The launch cwd must be a canonical absolute directory path.'); }
		this.assertExactKeys(input.folderIdentity, ['canonicalPath', 'dev', 'ino'], 'folder identity');
		if (typeof input.folderIdentity.canonicalPath !== 'string' || !isAbsolute(input.folderIdentity.canonicalPath)
			|| realpathSync(input.folderIdentity.canonicalPath) !== input.folderIdentity.canonicalPath
			|| !/^\d+$/.test(input.folderIdentity.dev) || !/^\d+$/.test(input.folderIdentity.ino)) {
			throw new Error('The folder identity must contain a canonical path and numeric device/inode identity.');
		}
		const folderStats = statSync(input.folderIdentity.canonicalPath, { bigint: true });
		if (!folderStats.isDirectory() || folderStats.dev.toString() !== input.folderIdentity.dev || folderStats.ino.toString() !== input.folderIdentity.ino) {
			throw new Error('The folder identity changed before the launch snapshot was persisted.');
		}
		if (realpathSync(input.cwd) !== input.cwd || !statSync(input.cwd).isDirectory()) { throw new Error('The launch cwd is not an existing canonical directory.'); }
		if (input.managedWorktreeOwnerId !== null) { this.validateUuid(input.managedWorktreeOwnerId, 'managed worktree owner ID'); }
		if (input.managedWorktreeOwnerId !== null && input.managedWorktreeOwnerId !== input.sessionId) {
			throw new Error('A session worktree lease must be owned by the session being launched.');
		}
		if (input.managedWorktreeOwnerId === null) {
			const cwdRelativeToFolder = relative(input.folderIdentity.canonicalPath, input.cwd);
			if (cwdRelativeToFolder === '..' || cwdRelativeToFolder.startsWith(`..${sep}`) || isAbsolute(cwdRelativeToFolder)) {
				throw new Error('The shared-folder cwd must remain inside its canonical folder identity.');
			}
		} else if (input.cwd !== input.folderIdentity.canonicalPath) {
			throw new Error('A managed worktree turn must identify its worktree root as both cwd and folder identity.');
		}
		this.assertExactKeys(input.permissionPolicy, ['mode', 'approval'], 'permission policy');
		if (!['read-only', 'mutating'].includes(input.permissionPolicy.mode) || !['never', 'on-request', 'always'].includes(input.permissionPolicy.approval)) {
			throw new Error('The permission policy is invalid.');
		}
		const convention = input.convention === null ? null : this.validateKnowledgeRef(input.convention, 'convention');
		if (!Array.isArray(input.references) || input.references.length > MAX_REFERENCE_COUNT) { throw new Error('The launch snapshot may contain at most 100 reference snapshots.'); }
		const references = input.references.map((reference, index) => this.validateKnowledgeRef(reference, `reference ${index + 1}`));
		if (new Set(references.map(reference => reference.id)).size !== references.length) { throw new Error('Reference snapshot IDs must be unique in a turn.'); }
		return {
			schemaVersion: 1, projectId: input.projectId, sessionId: input.sessionId, sessionRevision: input.sessionRevision,
			bindingId: input.bindingId, taskId: input.taskId, provider: input.provider, model: input.model.trim(),
			profileRef: input.profileRef?.trim() || null, cwd: input.cwd,
			folderIdentity: { canonicalPath: input.folderIdentity.canonicalPath, dev: input.folderIdentity.dev, ino: input.folderIdentity.ino },
			managedWorktreeOwnerId: input.managedWorktreeOwnerId,
			permissionPolicy: { mode: input.permissionPolicy.mode, approval: input.permissionPolicy.approval },
			convention, references,
		};
	}

	private validateKnowledgeRef(input: AgentSessionKnowledgeRef, label: string): AgentSessionKnowledgeRef {
		this.assertExactKeys(input, ['id', 'version', 'sha256'], label);
		this.validateUuid(input.id, `${label} ID`);
		if (!Number.isSafeInteger(input.version) || input.version < 1 || typeof input.sha256 !== 'string' || !SHA256_PATTERN.test(input.sha256)) {
			throw new Error(`The ${label} version or content hash is invalid.`);
		}
		return { id: input.id, version: input.version, sha256: input.sha256 };
	}

	private assertExactKeys(value: object, keys: readonly string[], label: string): void {
		if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
			throw new Error(`The ${label} contains unsupported or missing fields.`);
		}
	}

	private validateTurnUpdate(update: AgentSessionTurnUpdate): void {
		if (!Object.hasOwn(TURN_TRANSITIONS, update.state)) { throw new Error('The requested turn state is invalid.'); }
		const allowed = new Set(['state', 'exitCode', 'exitSignal', 'errorSummary', 'cleanupVerified']);
		if (Object.keys(update).some(key => !allowed.has(key))) { throw new Error('The turn update contains unsupported fields.'); }
		if (update.exitCode !== undefined && update.exitCode !== null && (!Number.isSafeInteger(update.exitCode) || update.exitCode < -2_147_483_648 || update.exitCode > 2_147_483_647)) {
			throw new Error('The turn exit code is invalid.');
		}
		if (update.exitSignal !== undefined && update.exitSignal !== null && (typeof update.exitSignal !== 'string' || !update.exitSignal.trim() || update.exitSignal.length > 64)) {
			throw new Error('The turn exit signal must contain 1 to 64 characters.');
		}
		if (update.errorSummary !== undefined && update.errorSummary !== null && (typeof update.errorSummary !== 'string' || update.errorSummary.length > MAX_ERROR_SUMMARY_LENGTH)) {
			throw new Error('The turn error summary exceeds 2000 characters.');
		}
		if (update.cleanupVerified !== undefined && typeof update.cleanupVerified !== 'boolean') { throw new Error('Cleanup verification must be explicit.'); }
	}

	private assertKnowledgeReferences(session: AgentSessionDTO, snapshot: AgentSessionTurnSnapshot): void {
		if (snapshot.convention) {
			const row = this.db.prepare('SELECT project_id, version, markdown FROM convention_versions WHERE id = ?').get(snapshot.convention.id) as { project_id: string; version: number; markdown: string } | undefined;
			if (!row || String(row.project_id) !== session.projectId || Number(row.version) !== snapshot.convention.version || digest(row.markdown) !== snapshot.convention.sha256) {
				throw new Error('The convention reference must match an immutable version and content hash from this project.');
			}
		}
		for (const reference of snapshot.references) {
			const row = this.db.prepare(`SELECT source.project_id, snapshot.version, snapshot.content_sha256
				FROM reference_snapshots snapshot JOIN reference_sources source ON source.id = snapshot.source_id
				WHERE snapshot.id = ?`).get(reference.id) as { project_id: string; version: number; content_sha256: string } | undefined;
			if (!row || String(row.project_id) !== session.projectId || Number(row.version) !== reference.version || String(row.content_sha256) !== reference.sha256) {
				throw new Error('Every reference must match an immutable version and content hash from this project.');
			}
			if (session.taskId && !this.db.prepare('SELECT 1 FROM task_reference_links WHERE task_id = ? AND snapshot_id = ?').get(session.taskId, reference.id)) {
				throw new Error('A task session may only snapshot references attached to its task.');
			}
		}
	}

	private validateUuid(value: string, label: string): void {
		if (typeof value !== 'string' || !UUID_PATTERN.test(value)) { throw new Error(`The ${label} must be a UUID.`); }
	}

	private assertOwnedSession(projectId: string, sessionId: string): void {
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(sessionId, 'session ID');
		if (!this.sessions.getSession(projectId, sessionId)) { throw new Error('The session does not belong to this project.'); }
	}

	private readTurnInternal(projectId: string, sessionId: string, turnId: string): AgentSessionTurnDTO | undefined {
		const row = this.db.prepare(`SELECT id, project_id, session_id, ordinal, state, revision, snapshot_json, snapshot_sha256,
			provider_conversation_id, exit_code, exit_signal, error_summary, cleanup_verified, created_at, updated_at, started_at, finished_at
			FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ?`).get(turnId, projectId, sessionId) as Record<string, SQLOutputValue> | undefined;
		if (!row) { return undefined; }
		const snapshotJson = String(row.snapshot_json);
		const snapshotSha256 = String(row.snapshot_sha256);
		if (digest(snapshotJson) !== snapshotSha256) { throw new Error('The persisted launch snapshot digest does not match its content.'); }
		let snapshot: AgentSessionTurnSnapshot;
		try { snapshot = JSON.parse(snapshotJson) as AgentSessionTurnSnapshot; }
		catch { throw new Error('The persisted launch snapshot is invalid JSON.'); }
		return {
			id: String(row.id), projectId: String(row.project_id), sessionId: String(row.session_id), ordinal: Number(row.ordinal),
			state: row.state as AgentSessionTurnState, revision: Number(row.revision), snapshot, snapshotSha256,
			providerConversationId: row.provider_conversation_id === null ? null : String(row.provider_conversation_id),
			exitCode: row.exit_code === null ? null : Number(row.exit_code), exitSignal: row.exit_signal === null ? null : String(row.exit_signal),
			errorSummary: row.error_summary === null ? null : String(row.error_summary), cleanupVerified: Number(row.cleanup_verified) === 1,
			createdAt: String(row.created_at), updatedAt: String(row.updated_at), startedAt: row.started_at === null ? null : String(row.started_at),
			finishedAt: row.finished_at === null ? null : String(row.finished_at),
		};
	}

	private isTerminal(state: AgentSessionTurnState): boolean {
		return state === 'exited' || state === 'interrupted' || state === 'failed';
	}

	private transaction<T>(run: () => T): T {
		this.db.exec('BEGIN IMMEDIATE;');
		try {
			const value = run();
			this.db.exec('COMMIT;');
			return value;
		} catch (error) {
			this.db.exec('ROLLBACK;');
			throw error;
		}
	}
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}
