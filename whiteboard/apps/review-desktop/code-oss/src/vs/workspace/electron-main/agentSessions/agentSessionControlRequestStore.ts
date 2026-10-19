/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { AgentSessionPermissionPolicy } from '../../common/workspaceAgentSessionProtocol.js';
import type {
	AgentSessionControlRequestDTO, AgentSessionControlRequestKind, AgentSessionControlRequestPageOptions,
	AgentSessionControlRequestState, AgentSessionControlWorkflowAuthority,
} from '../../common/workspaceAgentSessionControlProtocol.js';

export const AGENT_SESSION_CONTROL_REQUESTS_MIGRATION_V34 = `
CREATE TABLE agent_session_control_requests (
	id TEXT PRIMARY KEY NOT NULL,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	kind TEXT NOT NULL CHECK (kind IN ('start', 'stop')),
	state TEXT NOT NULL CHECK (state IN ('pendingReview', 'starting', 'started', 'startFailed', 'rejected', 'cancelled', 'interrupted', 'stopAccepted', 'stopCompleted', 'stopUnverified', 'stopFailed')),
	revision INTEGER NOT NULL CHECK (revision > 0),
	caller_session_id TEXT NOT NULL,
	caller_turn_id TEXT NOT NULL,
	target_session_id TEXT NOT NULL,
	target_turn_id TEXT,
	expected_session_revision INTEGER,
	permission_policy_json TEXT CHECK (permission_policy_json IS NULL OR json_valid(permission_policy_json)),
	reason TEXT CHECK (reason IS NULL OR length(reason) <= 8192),
	workflow_authority_json TEXT CHECK (workflow_authority_json IS NULL OR json_valid(workflow_authority_json)),
	request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
	idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
	decision_key TEXT CHECK (decision_key IS NULL OR length(decision_key) BETWEEN 1 AND 128),
	decision_fingerprint TEXT CHECK (decision_fingerprint IS NULL OR (length(decision_fingerprint) = 64 AND decision_fingerprint NOT GLOB '*[^0-9a-f]*')),
	snapshot_fingerprint TEXT CHECK (snapshot_fingerprint IS NULL OR (length(snapshot_fingerprint) = 64 AND snapshot_fingerprint NOT GLOB '*[^0-9a-f]*')),
	approval_fingerprint TEXT CHECK (approval_fingerprint IS NULL OR (length(approval_fingerprint) = 64 AND approval_fingerprint NOT GLOB '*[^0-9a-f]*')),
	approved_idempotency_key TEXT CHECK (approved_idempotency_key IS NULL OR length(approved_idempotency_key) BETWEEN 1 AND 128),
	result_turn_id TEXT,
	target_turn_state TEXT CHECK (target_turn_state IS NULL OR target_turn_state IN ('starting', 'running', 'stopping', 'exited', 'interrupted', 'failed')),
	error TEXT CHECK (error IS NULL OR length(error) <= 2000),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (id, project_id),
	UNIQUE (project_id, caller_session_id, caller_turn_id, kind, idempotency_key),
	FOREIGN KEY (caller_session_id, project_id) REFERENCES agent_sessions(id, project_id) ON DELETE RESTRICT,
	FOREIGN KEY (target_session_id, project_id) REFERENCES agent_sessions(id, project_id) ON DELETE RESTRICT,
	FOREIGN KEY (caller_turn_id, project_id, caller_session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT,
	FOREIGN KEY (target_turn_id, project_id, target_session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT,
	FOREIGN KEY (result_turn_id, project_id, target_session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT,
	CHECK ((kind = 'start' AND target_turn_id IS NULL AND expected_session_revision IS NOT NULL AND expected_session_revision > 0 AND permission_policy_json IS NOT NULL AND reason IS NOT NULL AND workflow_authority_json IS NULL)
		OR (kind = 'stop' AND target_turn_id IS NOT NULL AND expected_session_revision IS NULL AND permission_policy_json IS NULL AND reason IS NULL)),
	CHECK ((state IN ('starting', 'started', 'startFailed') AND snapshot_fingerprint IS NOT NULL AND approval_fingerprint IS NOT NULL AND approved_idempotency_key IS NOT NULL)
		OR (state NOT IN ('starting', 'started', 'startFailed') AND (snapshot_fingerprint IS NULL OR state = 'interrupted'))),
	CHECK ((decision_key IS NULL AND decision_fingerprint IS NULL) OR (decision_key IS NOT NULL AND decision_fingerprint IS NOT NULL)),
	CHECK ((kind = 'stop' AND state IN ('stopAccepted', 'stopCompleted', 'stopUnverified', 'stopFailed'))
		OR (kind = 'start' AND state IN ('pendingReview', 'starting', 'started', 'startFailed', 'rejected', 'cancelled', 'interrupted')))
) STRICT;
CREATE TABLE agent_session_control_request_events (
	id TEXT PRIMARY KEY NOT NULL,
	project_id TEXT NOT NULL,
	request_id TEXT NOT NULL,
	sequence INTEGER NOT NULL CHECK (sequence > 0),
	event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
	payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 8192),
	created_at TEXT NOT NULL,
	UNIQUE (request_id, sequence),
	FOREIGN KEY (request_id, project_id) REFERENCES agent_session_control_requests(id, project_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_control_request_events_page ON agent_session_control_request_events(project_id, request_id, sequence);
CREATE TRIGGER agent_session_control_request_event_immutable_update BEFORE UPDATE ON agent_session_control_request_events
BEGIN SELECT RAISE(ABORT, 'agent session control request events are immutable'); END;
CREATE TRIGGER agent_session_control_request_event_immutable_delete BEFORE DELETE ON agent_session_control_request_events
BEGIN SELECT RAISE(ABORT, 'agent session control request events are immutable'); END;
CREATE INDEX agent_session_control_requests_project_page ON agent_session_control_requests(project_id, created_at, id);
CREATE INDEX agent_session_control_requests_target ON agent_session_control_requests(project_id, target_session_id, target_turn_id, created_at, id);
CREATE TRIGGER agent_session_control_request_payload_immutable BEFORE UPDATE OF
	id, project_id, kind, caller_session_id, caller_turn_id, target_session_id, target_turn_id,
	expected_session_revision, permission_policy_json, reason, workflow_authority_json,
	request_fingerprint, idempotency_key, created_at ON agent_session_control_requests
BEGIN SELECT RAISE(ABORT, 'agent session control request payload is immutable'); END;
CREATE TRIGGER agent_session_control_request_no_delete BEFORE DELETE ON agent_session_control_requests
BEGIN SELECT RAISE(ABORT, 'agent session control requests are immutable'); END;
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const LIVE_TURN_STATES = new Set(['starting', 'running', 'stopping']);
const TERMINAL_TURN_STATES = new Set(['exited', 'failed', 'interrupted']);
const MAX_PAGE_SIZE = 100;
const MAX_ERROR_LENGTH = 2000;

interface RequestRow extends Readonly<Record<string, SQLOutputValue>> {
	id: SQLOutputValue; project_id: SQLOutputValue; kind: SQLOutputValue; state: SQLOutputValue; revision: SQLOutputValue;
	caller_session_id: SQLOutputValue; caller_turn_id: SQLOutputValue; target_session_id: SQLOutputValue; target_turn_id: SQLOutputValue;
	expected_session_revision: SQLOutputValue; permission_policy_json: SQLOutputValue; reason: SQLOutputValue;
	workflow_authority_json: SQLOutputValue; request_fingerprint: SQLOutputValue; idempotency_key: SQLOutputValue;
	decision_key: SQLOutputValue; decision_fingerprint: SQLOutputValue; snapshot_fingerprint: SQLOutputValue;
	approval_fingerprint: SQLOutputValue; approved_idempotency_key: SQLOutputValue;
	result_turn_id: SQLOutputValue; target_turn_state: SQLOutputValue; error: SQLOutputValue; created_at: SQLOutputValue; updated_at: SQLOutputValue;
}

interface RequestInputBase {
	readonly projectId: string;
	readonly callerSessionId: string;
	readonly callerTurnId: string;
	readonly targetSessionId: string;
	readonly idempotencyKey: string;
}

/** Durable request ledger only. It does not create launch capabilities or execute session lifecycle operations. */
export class AgentSessionControlRequestStore {
	constructor(private readonly db: DatabaseSync, private readonly assertOpen: () => void) { }

	recoverInterruptedStarts(): number {
		this.assertOpen();
		return this.transaction(() => {
			const rows = this.db.prepare(`SELECT * FROM agent_session_control_requests WHERE kind = 'start' AND state = 'starting'`).all() as RequestRow[];
			for (const row of rows) { this.updateState(row, 'interrupted', { error: 'The host restarted while this approved start was in progress.' }, 'startInterrupted'); }
			return rows.length;
		});
	}

	createStartRequest(input: RequestInputBase & {
		readonly expectedSessionRevision: number;
		readonly permissionPolicy: AgentSessionPermissionPolicy;
		readonly reason: string;
	}): AgentSessionControlRequestDTO {
		this.assertOpen();
		this.assertExactKeys(input, ['projectId', 'callerSessionId', 'callerTurnId', 'targetSessionId', 'idempotencyKey', 'expectedSessionRevision', 'permissionPolicy', 'reason'], [], 'start request');
		const base = this.normalizeBase(input);
		if (!Number.isSafeInteger(input.expectedSessionRevision) || input.expectedSessionRevision < 1) { throw new Error('The expected target session revision is invalid.'); }
		const policy = this.normalizePolicy(input.permissionPolicy);
		if (typeof input.reason !== 'string' || input.reason.length > 8192 || Buffer.byteLength(input.reason, 'utf8') > 8192) { throw new Error('The start request reason exceeds 8192 bytes.'); }
		const reason = input.reason.trim();
		const body = { ...base, expectedSessionRevision: input.expectedSessionRevision, permissionPolicy: policy, reason };
		return this.transaction(() => {
			const duplicate = this.findIdempotent(base, 'start');
			if (duplicate) { this.assertSameFingerprint(duplicate, body); return this.fromRow(duplicate); }
			this.assertLiveCaller(base);
			const target = this.requireProjectTarget(base.projectId, base.targetSessionId);
			if (target.revision !== input.expectedSessionRevision) { throw new Error('The target session changed since the start request was prepared.'); }
			if (this.hasLiveTurn(base.projectId, base.targetSessionId)) { throw new Error('The target session already has an active turn.'); }
			return this.insertRequest(base, 'start', body, {
				state: 'pendingReview', targetTurnId: null, expectedSessionRevision: input.expectedSessionRevision,
				permissionPolicy: policy, reason, workflowAuthority: null,
			});
		});
	}

	createStopRequest(input: RequestInputBase & {
		readonly targetTurnId: string;
		readonly workflowAuthority?: AgentSessionControlWorkflowAuthority;
	}): AgentSessionControlRequestDTO {
		this.assertOpen();
		this.assertExactKeys(input, ['projectId', 'callerSessionId', 'callerTurnId', 'targetSessionId', 'targetTurnId', 'idempotencyKey'], ['workflowAuthority'], 'stop request');
		const base = this.normalizeBase(input);
		const targetTurnId = this.normalizeUuid(input.targetTurnId, 'target turn ID');
		const authority = input.workflowAuthority === undefined ? null : this.normalizeAuthority(input.workflowAuthority);
		if (authority && !authority.allowedSessionIds.includes(base.targetSessionId)) { throw new Error('The workflow authority does not include the target session.'); }
		const body = { ...base, targetTurnId, workflowAuthority: authority };
		return this.transaction(() => {
			const duplicate = this.findIdempotent(base, 'stop');
			if (duplicate) { this.assertSameFingerprint(duplicate, body); return this.fromRow(duplicate); }
			this.assertLiveCaller(base);
			this.requireCompatibleTarget(base);
			const targetTurn = this.db.prepare(`SELECT state FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ?`).get(targetTurnId, base.projectId, base.targetSessionId);
			if (!targetTurn || !LIVE_TURN_STATES.has(String(targetTurn.state))) { throw new Error('The exact target turn is not active in this project and session.'); }
			const ownExactTurn = base.callerSessionId === base.targetSessionId && base.callerTurnId === targetTurnId;
			if (authority) { this.assertWorkflowAuthority(base, targetTurnId, authority); }
			else if (!ownExactTurn) { throw new Error('Stopping another session requires trusted workflow authority.'); }
			return this.insertRequest(base, 'stop', body, {
				state: 'stopAccepted', targetTurnId, expectedSessionRevision: null, permissionPolicy: null, reason: null, workflowAuthority: authority,
			});
		});
	}

	/** Claims a pending human-approved start exactly once; a same-key/same-snapshot retry is a read-only replay. */
	beginStart(requestId: string, expectedRequestRevision: number, snapshotFingerprint: string, idempotencyKey: string): { readonly request: AgentSessionControlRequestDTO; readonly claimed: boolean } {
		this.assertOpen();
		this.validateUuid(requestId, 'request ID');
		this.validateRevision(expectedRequestRevision);
		if (!SHA256.test(snapshotFingerprint)) { throw new Error('The launch snapshot fingerprint is invalid.'); }
		const key = this.normalizeKey(idempotencyKey);
		return this.transaction(() => {
			const row = this.requireRequestById(requestId);
			if (row.kind !== 'start') { throw new Error('Only a start request can be approved for launch.'); }
			const approvalFingerprint = this.fingerprint({ requestId, expectedRequestRevision, snapshotFingerprint, idempotencyKey: key });
			if (row.state === 'starting' || row.state === 'started' || row.state === 'startFailed') {
				if (row.approved_idempotency_key === key && row.approval_fingerprint === approvalFingerprint) { return { request: this.fromRow(row), claimed: false }; }
				throw new Error('The start request was already claimed with different approval content.');
			}
			if (row.state !== 'pendingReview' || Number(row.revision) !== expectedRequestRevision) { throw new Error('The start request is no longer pending at the expected revision.'); }
			const base = this.rowScope(row);
			this.requireProjectTarget(base.projectId, base.targetSessionId);
			if (this.requireSessionRevision(base.projectId, base.targetSessionId) !== Number(row.expected_session_revision) || this.hasLiveTurn(base.projectId, base.targetSessionId)) {
				throw new Error('The target session changed or became active before approval.');
			}
			const now = this.now();
			const updated = this.db.prepare(`UPDATE agent_session_control_requests SET state = 'starting', revision = revision + 1, snapshot_fingerprint = ?, approval_fingerprint = ?, approved_idempotency_key = ?, updated_at = ? WHERE id = ? AND state = 'pendingReview' AND revision = ?`).run(snapshotFingerprint, approvalFingerprint, key, now, requestId, expectedRequestRevision);
			if (Number(updated.changes) !== 1) { throw new Error('The start request changed before it could be claimed.'); }
			const claimed = this.requireRequestById(requestId);
			this.recordEvent(claimed, 'startApproved', { snapshotFingerprint, idempotencyKey: key });
			return { request: this.fromRow(claimed), claimed: true };
		});
	}

	markStarted(requestId: string, turnId: string): AgentSessionControlRequestDTO {
		this.assertOpen(); this.validateUuid(requestId, 'request ID'); this.validateUuid(turnId, 'turn ID');
		return this.transaction(() => {
			const row = this.requireRequestById(requestId);
			if (row.state === 'started' && row.result_turn_id === turnId) { return this.fromRow(row); }
			if (row.kind !== 'start' || row.state !== 'starting') { throw new Error('The start request is not currently being launched.'); }
			const turn = this.db.prepare(`SELECT snapshot_sha256 FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ?`).get(turnId, row.project_id, row.target_session_id);
			if (!turn || turn.snapshot_sha256 !== row.snapshot_fingerprint) { throw new Error('The created turn does not match the approved launch snapshot.'); }
			return this.updateState(row, 'started', { resultTurnId: turnId, error: null });
		});
	}

	markStartFailed(requestId: string, error: string): AgentSessionControlRequestDTO {
		this.assertOpen(); this.validateUuid(requestId, 'request ID');
		return this.transaction(() => {
			const row = this.requireRequestById(requestId);
			if (row.state === 'startFailed') { return this.fromRow(row); }
			if (row.kind !== 'start' || row.state !== 'starting') { throw new Error('The start request is not currently being launched.'); }
			return this.updateState(row, 'startFailed', { error: this.normalizeError(error) });
		});
	}

	rejectPending(requestId: string, expectedRequestRevision: number, idempotencyKey: string): AgentSessionControlRequestDTO {
		return this.finishPending(requestId, expectedRequestRevision, idempotencyKey, 'rejected');
	}

	cancelPending(requestId: string, expectedRequestRevision: number, idempotencyKey: string): AgentSessionControlRequestDTO {
		return this.finishPending(requestId, expectedRequestRevision, idempotencyKey, 'cancelled');
	}

	markStopResult(requestId: string, error?: string): AgentSessionControlRequestDTO {
		this.assertOpen(); this.validateUuid(requestId, 'request ID');
		return this.transaction(() => {
			const row = this.requireRequestById(requestId);
			if (row.kind !== 'stop') { throw new Error('Only a stop request has a stop result.'); }
			if (['stopCompleted', 'stopFailed'].includes(String(row.state))) { return this.fromRow(row); }
			if (row.state !== 'stopAccepted' && row.state !== 'stopUnverified') { throw new Error('The stop request was not accepted.'); }
			const turn = this.db.prepare(`SELECT state, cleanup_verified, error_summary FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ?`).get(row.target_turn_id, row.project_id, row.target_session_id);
			if (!turn) { return this.updateState(row, 'stopFailed', { error: this.normalizeError(error ?? 'The exact target turn no longer exists.') }); }
			const turnState = String(turn.state);
			if (TERMINAL_TURN_STATES.has(turnState) && Number(turn.cleanup_verified) === 1) {
				return this.updateState(row, 'stopCompleted', { targetTurnState: turnState, error: null });
			}
			if (TERMINAL_TURN_STATES.has(turnState)) {
				return this.updateState(row, 'stopUnverified', { targetTurnState: turnState, error: this.normalizeError(error ?? (turn.error_summary == null ? 'Turn ended without verified process cleanup.' : String(turn.error_summary))) });
			}
			return this.updateState(row, 'stopUnverified', { targetTurnState: turnState, error: this.normalizeError(error ?? `Target turn remains ${turnState}; cleanup is not complete.`) });
		});
	}

	/** Revalidates a persisted stop receipt immediately before the host invokes the exact stop operation. */
	validateAcceptedStop(projectId: string, requestId: string): AgentSessionControlRequestDTO {
		this.assertOpen(); this.validateUuid(projectId, 'project ID'); this.validateUuid(requestId, 'request ID');
		return this.transaction(() => {
			const row = this.db.prepare('SELECT * FROM agent_session_control_requests WHERE project_id = ? AND id = ?').get(projectId, requestId) as RequestRow | undefined;
			if (!row || row.kind !== 'stop' || row.state !== 'stopAccepted') { throw new Error('The accepted stop request does not exist in this project.'); }
			const scope = this.rowScope(row);
			this.assertLiveCaller(scope);
			this.requireCompatibleTarget(scope);
			const targetTurn = this.db.prepare(`SELECT state FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ?`).get(row.target_turn_id, projectId, row.target_session_id);
			if (!targetTurn || !LIVE_TURN_STATES.has(String(targetTurn.state))) { throw new Error('The exact target turn is no longer active.'); }
			if (row.workflow_authority_json !== null) {
				const authority = this.normalizeAuthority(JSON.parse(String(row.workflow_authority_json)) as AgentSessionControlWorkflowAuthority);
				this.assertWorkflowAuthority(scope, String(row.target_turn_id), authority);
			} else if (scope.callerSessionId !== scope.targetSessionId || scope.callerTurnId !== String(row.target_turn_id)) {
				throw new Error('The stop request no longer has exact caller-turn authority.');
			}
			return this.fromRow(row);
		});
	}

	get(projectId: string, requestId: string): AgentSessionControlRequestDTO | undefined {
		this.assertOpen(); this.validateUuid(projectId, 'project ID'); this.validateUuid(requestId, 'request ID');
		const row = this.db.prepare('SELECT * FROM agent_session_control_requests WHERE project_id = ? AND id = ?').get(projectId, requestId) as RequestRow | undefined;
		return row ? this.fromRow(row) : undefined;
	}

	list(projectId: string, options: AgentSessionControlRequestPageOptions = {}): readonly AgentSessionControlRequestDTO[] {
		this.assertOpen(); this.validateUuid(projectId, 'project ID');
		this.assertExactKeys(options, [], ['afterCreatedAt', 'afterId', 'limit', 'state'], 'control request page');
		const limit = options.limit ?? 50;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) { throw new Error(`The request page limit must be between 1 and ${MAX_PAGE_SIZE}.`); }
		if (options.state !== undefined && !['pendingReview', 'starting', 'started', 'startFailed', 'rejected', 'cancelled', 'interrupted', 'stopAccepted', 'stopCompleted', 'stopUnverified', 'stopFailed'].includes(options.state)) { throw new Error('The control request state filter is invalid.'); }
		if ((options.afterCreatedAt === undefined) !== (options.afterId === undefined)) { throw new Error('Both request page cursor fields are required together.'); }
		if (options.afterId !== undefined) { this.validateUuid(options.afterId, 'cursor request ID'); }
		const stateClause = options.state === undefined ? '' : ' AND state = ?';
		const cursor = options.afterCreatedAt === undefined ? '' : ' AND (created_at, id) > (?, ?)';
		const cursorParams: string[] = [];
		if (options.afterCreatedAt !== undefined && options.afterId !== undefined) { cursorParams.push(options.afterCreatedAt, options.afterId); }
		const params = [projectId, ...(options.state === undefined ? [] : [options.state]), ...cursorParams, limit];
		const rows = this.db.prepare(`SELECT * FROM agent_session_control_requests WHERE project_id = ?${stateClause}${cursor} ORDER BY created_at, id LIMIT ?`).all(...params);
		return rows.map(row => this.fromRow(row as RequestRow));
	}

	listEvents(projectId: string, requestId: string, afterSequence = 0, limit = 100): readonly { readonly id: string; readonly sequence: number; readonly type: string; readonly payload: unknown; readonly createdAt: string }[] {
		this.assertOpen(); this.validateUuid(projectId, 'project ID'); this.validateUuid(requestId, 'request ID');
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) { throw new Error('The control request event page is invalid.'); }
		if (!this.db.prepare('SELECT 1 FROM agent_session_control_requests WHERE project_id = ? AND id = ?').get(projectId, requestId)) { return []; }
		return this.db.prepare('SELECT id, sequence, event_type, payload_json, created_at FROM agent_session_control_request_events WHERE project_id = ? AND request_id = ? AND sequence > ? ORDER BY sequence LIMIT ?').all(projectId, requestId, afterSequence, limit).map(row => ({
			id: String(row.id), sequence: Number(row.sequence), type: String(row.event_type), payload: JSON.parse(String(row.payload_json)), createdAt: String(row.created_at),
		}));
	}

	private finishPending(requestId: string, expectedRevision: number, idempotencyKey: string, state: 'rejected' | 'cancelled'): AgentSessionControlRequestDTO {
		this.assertOpen(); this.validateUuid(requestId, 'request ID'); this.validateRevision(expectedRevision);
		const key = this.normalizeKey(idempotencyKey);
		return this.transaction(() => {
			const row = this.requireRequestById(requestId);
			const fingerprint = this.fingerprint({ requestId, state, expectedRevision });
			if (row.state === state && row.decision_key === key) {
				if (row.decision_fingerprint !== fingerprint) { throw new Error('The decision idempotency key was reused with different content.'); }
				return this.fromRow(row);
			}
			if (row.kind !== 'start' || row.state !== 'pendingReview' || Number(row.revision) !== expectedRevision) { throw new Error('Only a pending start request at the expected revision can be rejected or cancelled.'); }
			this.db.prepare(`UPDATE agent_session_control_requests SET state = ?, revision = revision + 1, decision_key = ?, decision_fingerprint = ?, updated_at = ? WHERE id = ? AND revision = ? AND state = 'pendingReview'`).run(state, key, fingerprint, this.now(), requestId, expectedRevision);
			const updated = this.requireRequestById(requestId);
			this.recordEvent(updated, state, { idempotencyKey: key });
			return this.fromRow(updated);
		});
	}

	private assertLiveCaller(input: RequestInputBase): void {
		const row = this.db.prepare(`SELECT turn.state FROM agent_session_turns turn
			JOIN agent_sessions session ON session.id = turn.session_id AND session.project_id = turn.project_id
			WHERE turn.id = ? AND turn.project_id = ? AND turn.session_id = ?`).get(input.callerTurnId, input.projectId, input.callerSessionId);
		if (!row || row.state !== 'running') { throw new Error('The caller must be the exact live turn in the same project.'); }
	}

	private requireCompatibleTarget(input: RequestInputBase): { readonly revision: number } {
		const row = this.db.prepare(`SELECT target.revision FROM agent_sessions caller JOIN agent_sessions target
			ON target.project_id = caller.project_id AND target.binding_id = caller.binding_id AND target.task_id IS caller.task_id
			WHERE caller.project_id = ? AND caller.id = ? AND target.id = ?`).get(input.projectId, input.callerSessionId, input.targetSessionId);
		if (!row) { throw new Error('The target session must belong to the caller project, task, and binding.'); }
		return { revision: Number(row.revision) };
	}

	private requireProjectTarget(projectId: string, sessionId: string): { readonly revision: number } {
		const row = this.db.prepare('SELECT revision FROM agent_sessions WHERE project_id = ? AND id = ?').get(projectId, sessionId);
		if (!row) { throw new Error('The target session must belong to the caller project.'); }
		return { revision: Number(row.revision) };
	}

	private requireSessionRevision(projectId: string, sessionId: string): number {
		const row = this.db.prepare('SELECT revision FROM agent_sessions WHERE project_id = ? AND id = ?').get(projectId, sessionId);
		if (!row) { throw new Error('The target session does not belong to this project.'); }
		return Number(row.revision);
	}

	private hasLiveTurn(projectId: string, sessionId: string): boolean {
		return this.db.prepare(`SELECT 1 FROM agent_session_turns WHERE project_id = ? AND session_id = ? AND state IN ('starting', 'running', 'stopping') LIMIT 1`).get(projectId, sessionId) !== undefined;
	}

	private insertRequest(base: RequestInputBase, kind: AgentSessionControlRequestKind, body: unknown, fields: {
		readonly state: AgentSessionControlRequestState; readonly targetTurnId: string | null; readonly expectedSessionRevision: number | null;
		readonly permissionPolicy: AgentSessionPermissionPolicy | null; readonly reason: string | null; readonly workflowAuthority: AgentSessionControlWorkflowAuthority | null;
	}): AgentSessionControlRequestDTO {
		const now = this.now();
		this.db.prepare(`INSERT INTO agent_session_control_requests (
			id, project_id, kind, state, revision, caller_session_id, caller_turn_id, target_session_id, target_turn_id,
			expected_session_revision, permission_policy_json, reason, workflow_authority_json, request_fingerprint, idempotency_key, created_at, updated_at
		) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			randomUUID(), base.projectId, kind, fields.state, base.callerSessionId, base.callerTurnId, base.targetSessionId,
			fields.targetTurnId, fields.expectedSessionRevision, fields.permissionPolicy === null ? null : JSON.stringify(fields.permissionPolicy),
			fields.reason, fields.workflowAuthority === null ? null : JSON.stringify(fields.workflowAuthority), this.fingerprint(body), base.idempotencyKey, now, now,
		);
		const row = this.db.prepare(`SELECT * FROM agent_session_control_requests WHERE project_id = ? AND caller_session_id = ? AND caller_turn_id = ? AND kind = ? AND idempotency_key = ?`).get(base.projectId, base.callerSessionId, base.callerTurnId, kind, base.idempotencyKey) as RequestRow | undefined;
		if (!row) { throw new Error('The durable control request could not be read after insertion.'); }
		this.recordEvent(row, kind === 'start' ? 'startRequested' : 'stopAccepted', { requestFingerprint: row.request_fingerprint });
		return this.fromRow(row);
	}

	private findIdempotent(base: RequestInputBase, kind: AgentSessionControlRequestKind): RequestRow | undefined {
		return this.db.prepare('SELECT * FROM agent_session_control_requests WHERE project_id = ? AND caller_session_id = ? AND caller_turn_id = ? AND kind = ? AND idempotency_key = ?').get(base.projectId, base.callerSessionId, base.callerTurnId, kind, base.idempotencyKey) as RequestRow | undefined;
	}

	private assertSameFingerprint(row: RequestRow, body: unknown): void {
		if (row.request_fingerprint !== this.fingerprint(body)) { throw new Error('The idempotency key was already used for different request content.'); }
	}

	private updateState(row: RequestRow, state: AgentSessionControlRequestState, fields: { readonly resultTurnId?: string; readonly targetTurnState?: string; readonly error: string | null }, eventType: string = state): AgentSessionControlRequestDTO {
		this.db.prepare(`UPDATE agent_session_control_requests SET state = ?, revision = revision + 1, result_turn_id = COALESCE(?, result_turn_id), target_turn_state = ?, error = ?, updated_at = ? WHERE id = ? AND revision = ?`).run(
			state, fields.resultTurnId ?? null, fields.targetTurnState ?? null, fields.error, this.now(), row.id, row.revision,
		);
		const updated = this.requireRequestById(String(row.id));
		this.recordEvent(updated, eventType, { state, targetTurnState: fields.targetTurnState ?? null, error: fields.error });
		return this.fromRow(updated);
	}

	private recordEvent(row: RequestRow, type: string, payload: unknown): void {
		this.db.prepare('INSERT INTO agent_session_control_request_events(id, project_id, request_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
			randomUUID(), row.project_id, row.id, row.revision, type, JSON.stringify(payload), this.now(),
		);
	}

	private requireRequestById(requestId: string): RequestRow {
		const row = this.db.prepare('SELECT * FROM agent_session_control_requests WHERE id = ?').get(requestId) as RequestRow | undefined;
		if (!row) { throw new Error('The control request does not exist.'); }
		return row;
	}

	private rowScope(row: RequestRow): RequestInputBase {
		return { projectId: String(row.project_id), callerSessionId: String(row.caller_session_id), callerTurnId: String(row.caller_turn_id), targetSessionId: String(row.target_session_id), idempotencyKey: String(row.idempotency_key) };
	}

	private fromRow(row: RequestRow): AgentSessionControlRequestDTO {
		return {
			id: String(row.id), projectId: String(row.project_id), kind: String(row.kind) as AgentSessionControlRequestKind,
			state: String(row.state) as AgentSessionControlRequestState, revision: Number(row.revision),
			callerSessionId: String(row.caller_session_id), callerTurnId: String(row.caller_turn_id), targetSessionId: String(row.target_session_id),
			targetTurnId: row.target_turn_id == null ? null : String(row.target_turn_id),
			expectedSessionRevision: row.expected_session_revision == null ? null : Number(row.expected_session_revision),
			permissionPolicy: row.permission_policy_json == null ? null : JSON.parse(String(row.permission_policy_json)) as AgentSessionPermissionPolicy,
			reason: row.reason == null ? null : String(row.reason),
			workflowAuthority: row.workflow_authority_json == null ? null : JSON.parse(String(row.workflow_authority_json)) as AgentSessionControlWorkflowAuthority,
			snapshotFingerprint: row.snapshot_fingerprint == null ? null : String(row.snapshot_fingerprint),
			approvedIdempotencyKey: row.approved_idempotency_key == null ? null : String(row.approved_idempotency_key),
			resultTurnId: row.result_turn_id == null ? null : String(row.result_turn_id),
			targetTurnState: row.target_turn_state == null ? null : String(row.target_turn_state) as AgentSessionControlRequestDTO['targetTurnState'],
			error: row.error == null ? null : String(row.error), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
		};
	}

	private normalizeBase(input: RequestInputBase): RequestInputBase {
		return {
			projectId: this.normalizeUuid(input.projectId, 'project ID'), callerSessionId: this.normalizeUuid(input.callerSessionId, 'caller session ID'),
			callerTurnId: this.normalizeUuid(input.callerTurnId, 'caller turn ID'), targetSessionId: this.normalizeUuid(input.targetSessionId, 'target session ID'),
			idempotencyKey: this.normalizeKey(input.idempotencyKey),
		};
	}

	private normalizePolicy(value: AgentSessionPermissionPolicy): AgentSessionPermissionPolicy {
		this.assertExactKeys(value, ['mode', 'approval'], [], 'permission policy');
		if (!value || !(value.mode === 'read-only' && value.approval === 'never')
			&& !(value.mode === 'mutating' && value.approval === 'on-request')) {
			throw new Error('The start request permission policy is invalid.');
		}
		return { mode: value.mode, approval: value.approval };
	}

	private normalizeAuthority(value: AgentSessionControlWorkflowAuthority): AgentSessionControlWorkflowAuthority {
		this.assertExactKeys(value, ['workflowId', 'planVersion', 'fingerprint', 'runId', 'approvalId', 'allowedSessionIds'], [], 'workflow authority');
		const workflowId = this.normalizeUuid(value.workflowId, 'workflow ID');
		const runId = this.normalizeUuid(value.runId, 'workflow run ID');
		const approvalId = this.normalizeUuid(value.approvalId, 'workflow approval ID');
		if (!Number.isSafeInteger(value.planVersion) || value.planVersion < 1 || !SHA256.test(value.fingerprint)) { throw new Error('The workflow authority plan binding is invalid.'); }
		if (!Array.isArray(value.allowedSessionIds) || value.allowedSessionIds.length < 1 || value.allowedSessionIds.length > 100) { throw new Error('The workflow authority session scope is invalid.'); }
		const allowedSessionIds = [...new Set(value.allowedSessionIds.map(id => this.normalizeUuid(id, 'workflow session ID')))];
		if (allowedSessionIds.length !== value.allowedSessionIds.length) { throw new Error('The workflow authority session scope contains duplicates.'); }
		return { workflowId, planVersion: value.planVersion, fingerprint: value.fingerprint, runId, approvalId, allowedSessionIds };
	}

	private assertWorkflowAuthority(input: RequestInputBase, targetTurnId: string, authority: AgentSessionControlWorkflowAuthority): void {
		const current = this.db.prepare(`SELECT workflow.plan_version, workflow.state AS workflow_state,
			plan.plan_json, plan.fingerprint, approval.id AS approval_id, run.state AS run_state,
			run.plan_version AS run_plan_version, run.fingerprint AS run_fingerprint
			FROM agent_workflows workflow
			JOIN agent_workflow_plans plan ON plan.workflow_id = workflow.id AND plan.project_id = workflow.project_id AND plan.version = workflow.plan_version
			JOIN agent_workflow_approvals approval ON approval.workflow_id = workflow.id AND approval.project_id = workflow.project_id
				AND approval.plan_version = plan.version AND approval.fingerprint = plan.fingerprint
			JOIN agent_workflow_runs run ON run.workflow_id = workflow.id AND run.project_id = workflow.project_id
				AND run.plan_version = plan.version AND run.fingerprint = plan.fingerprint
			WHERE workflow.id = ? AND workflow.project_id = ? AND workflow.plan_version = ?
			AND plan.fingerprint = ? AND approval.id = ? AND run.id = ?
			AND workflow.state IN ('ready', 'running', 'cancelRequested') AND run.state IN ('ready', 'running', 'cancelRequested')`).get(
			authority.workflowId, input.projectId, authority.planVersion, authority.fingerprint, authority.approvalId, authority.runId,
		);
		if (!current || current.run_plan_version !== authority.planVersion || current.run_fingerprint !== authority.fingerprint) {
			throw new Error('The workflow stop authority is stale or is not the current approved active run.');
		}
		let plan: unknown;
		try { plan = JSON.parse(String(current.plan_json)); } catch (error) { throw new Error('The approved workflow plan is invalid JSON.', { cause: error }); }
		if (!plan || typeof plan !== 'object' || !Array.isArray((plan as { nodes?: unknown }).nodes)) { throw new Error('The approved workflow plan has no valid node list.'); }
		const planNodes = (plan as { nodes: unknown[] }).nodes;
		const planSessionIds = planNodes.map(node => {
			if (!node || typeof node !== 'object' || typeof (node as { sessionId?: unknown }).sessionId !== 'string') { throw new Error('The approved workflow plan contains an invalid node.'); }
			return this.normalizeUuid((node as { sessionId: string }).sessionId, 'approved workflow session ID');
		}).sort();
		const allowedSessionIds = [...authority.allowedSessionIds].sort();
		if (new Set(planSessionIds).size !== planSessionIds.length || planSessionIds.length !== allowedSessionIds.length || planSessionIds.some((id, index) => id !== allowedSessionIds[index])) {
			throw new Error('The workflow stop authority session set does not exactly match its approved plan.');
		}
		const sourceNode = this.db.prepare(`SELECT 1 FROM agent_workflow_run_nodes WHERE workflow_id = ? AND project_id = ? AND run_id = ?
			AND session_id = ? AND session_turn_id = ? AND state IN ('launching', 'running', 'cancelRequested')`).get(
			authority.workflowId, input.projectId, authority.runId, input.callerSessionId, input.callerTurnId,
		);
		const targetNode = this.db.prepare(`SELECT 1 FROM agent_workflow_run_nodes WHERE workflow_id = ? AND project_id = ? AND run_id = ?
			AND session_id = ? AND session_turn_id = ? AND state IN ('launching', 'running', 'cancelRequested')`).get(
			authority.workflowId, input.projectId, authority.runId, input.targetSessionId, targetTurnId,
		);
		if (!sourceNode || !targetNode) { throw new Error('The workflow authority does not bind both exact source and target turns in the active run.'); }
	}

	private normalizeKey(value: string): string {
		if (typeof value !== 'string' || !value.trim() || value.trim().length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) { throw new Error('The idempotency key is invalid.'); }
		return value.trim();
	}

	private normalizeError(value: string): string {
		if (typeof value !== 'string') { throw new Error('The control request error is invalid.'); }
		return value.slice(0, MAX_ERROR_LENGTH);
	}

	private normalizeUuid(value: string, label: string): string {
		if (typeof value !== 'string' || !UUID.test(value)) { throw new Error(`The ${label} is invalid.`); }
		return value.toLowerCase();
	}

	private validateUuid(value: string, label: string): void { this.normalizeUuid(value, label); }
	private validateRevision(value: number): void { if (!Number.isSafeInteger(value) || value < 1) { throw new Error('The expected request revision is invalid.'); } }
	private now(): string { return new Date().toISOString(); }
	private fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
	private assertExactKeys(value: object, required: readonly string[], optional: readonly string[], label: string): void {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`The ${label} input is invalid.`); }
		const keys = Object.keys(value);
		if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) { throw new Error(`The ${label} contains missing or unknown fields.`); }
	}
	private transaction<T>(callback: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try { const result = callback(); this.db.exec('COMMIT'); return result; }
		catch (error) { try { this.db.exec('ROLLBACK'); } catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Control request transaction and rollback both failed.'); } throw error; }
	}
}
