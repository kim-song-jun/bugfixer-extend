/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type {
	AgentSessionDTO,
	AgentSessionProvider,
	AgentSessionState,
	AgentSessionWorkspaceMode,
	CreateAgentSessionInput,
	SendSessionMessageInput,
	SessionMessageDTO,
	SessionNotificationDTO,
	SessionPageOptions,
} from '../../common/workspaceAgentSessionProtocol.js';
import { canTransitionAgentSessionState, isAgentSessionState } from './agentSessionTransitions.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_MESSAGE_CODE_UNITS = 16_384;
const MAX_MESSAGE_BYTES = 65_536;
const MAX_NAME_LENGTH = 200;
const MAX_MODEL_LENGTH = 200;
const MAX_PROFILE_REF_LENGTH = 512;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export class AgentSessionStore {
	constructor(private readonly db: DatabaseSync, private readonly assertOpen: () => void) { }

	createSession(input: CreateAgentSessionInput): AgentSessionDTO {
		this.assertOpen();
		this.validateSessionInput(input);
		const id = randomUUID();
		const now = new Date().toISOString();
		return this.transaction(() => {
			const project = this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(input.projectId);
			if (!project) { throw new Error('The session project does not exist.'); }
			const binding = this.db.prepare('SELECT 1 FROM folder_bindings WHERE id = ? AND project_id = ?').get(input.bindingId, input.projectId);
			if (!binding) { throw new Error('The session binding must belong to its project.'); }
			if (input.taskId) {
				const task = this.db.prepare('SELECT binding_id FROM tasks WHERE id = ? AND project_id = ?').get(input.taskId, input.projectId);
				if (!task || String(task.binding_id) !== input.bindingId) { throw new Error('The session task must belong to its project and binding.'); }
			}
			if (input.parentSessionId) {
				const parent = this.db.prepare('SELECT project_id, binding_id, task_id FROM agent_sessions WHERE id = ?').get(input.parentSessionId);
				if (!parent || String(parent.project_id) !== input.projectId || String(parent.binding_id) !== input.bindingId || (parent.task_id === null ? null : String(parent.task_id)) !== (input.taskId ?? null)) {
					throw new Error('The parent session must match the child project, binding, and task ownership.');
				}
			}
			this.db.prepare(`INSERT INTO agent_sessions (
				id, project_id, binding_id, task_id, parent_session_id, name, provider, model, profile_ref,
				workspace_mode, state, revision, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', 1, ?, ?)`).run(
				id, input.projectId, input.bindingId, input.taskId ?? null, input.parentSessionId ?? null,
				input.name.trim(), input.provider, input.model.trim(), input.profileRef?.trim() || null,
				input.workspaceMode, now, now,
			);
			return this.getSessionInternal(input.projectId, id)!;
		});
	}

	getSession(projectId: string, sessionId: string): AgentSessionDTO | undefined {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(sessionId, 'session ID');
		return this.getSessionInternal(projectId, sessionId);
	}

	listSessions(projectId: string): AgentSessionDTO[] {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		return this.db.prepare(`SELECT id, project_id, binding_id, task_id, parent_session_id, name, provider, model, profile_ref,
			workspace_mode, state, revision, created_at, updated_at
			FROM agent_sessions WHERE project_id = ? ORDER BY created_at, id`).all(projectId).map(row => this.sessionFromRow(row));
	}

	transitionSession(projectId: string, sessionId: string, expectedRevision: number, nextState: AgentSessionState): AgentSessionDTO {
		this.assertOpen();
		return this.transaction(() => {
			this.assertNoLiveTurnOwnsLifecycle(sessionId);
			return this.transitionSessionWithinTransaction(projectId, sessionId, expectedRevision, nextState);
		});
	}

	/** Atomically applies the session transition policy for the turn store while it owns this same SQLite transaction. */
	transitionSessionWithinTransaction(projectId: string, sessionId: string, expectedRevision: number, nextState: AgentSessionState): AgentSessionDTO {
		this.assertOpen();
		if (!this.db.isTransaction) { throw new Error('A turn-owned session transition requires an active SQLite transaction.'); }
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(sessionId, 'session ID');
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) { throw new Error('The expected session revision is invalid.'); }
		if (!isAgentSessionState(nextState)) { throw new Error('The requested session state is invalid.'); }
		const current = this.getSessionInternal(projectId, sessionId);
		if (!current) { throw new Error('The session does not belong to this project.'); }
		if (current.revision !== expectedRevision) { throw new Error('The session revision is stale.'); }
		if (!canTransitionAgentSessionState(current.state, nextState)) { throw new Error('The session state transition is invalid.'); }
		const now = new Date().toISOString();
		const result = this.db.prepare(`UPDATE agent_sessions SET state = ?, revision = revision + 1, updated_at = ?
			WHERE id = ? AND project_id = ? AND revision = ?`).run(nextState, now, sessionId, projectId, expectedRevision);
		if (Number(result.changes) !== 1) { throw new Error('The session revision is stale.'); }
		return this.getSessionInternal(projectId, sessionId)!;
	}

	/** Resumes a stopped session only for its exact newly-created manual turn after verified prior-turn cleanup. */
	resumeStoppedSessionForTurnWithinTransaction(projectId: string, sessionId: string, expectedRevision: number, turnId: string): AgentSessionDTO {
		this.assertOpen();
		if (!this.db.isTransaction) { throw new Error('A stopped-session resume requires an active SQLite transaction.'); }
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(sessionId, 'session ID');
		this.validateUuid(turnId, 'turn ID');
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) { throw new Error('The expected session revision is invalid.'); }
		const session = this.getSessionInternal(projectId, sessionId);
		if (!session || session.state !== 'stopped') { throw new Error('Only a stopped session can use this turn-owned resume transition.'); }
		if (session.revision !== expectedRevision) { throw new Error('The session revision is stale.'); }
		const nextTurn = this.db.prepare(`SELECT ordinal, state FROM agent_session_turns
			WHERE id = ? AND project_id = ? AND session_id = ?`).get(turnId, projectId, sessionId) as Record<string, SQLOutputValue> | undefined;
		if (!nextTurn || nextTurn.state !== 'starting') { throw new Error('The stopped-session resume requires its exact scoped starting turn.'); }
		const latestTurn = this.db.prepare(`SELECT id FROM agent_session_turns
			WHERE project_id = ? AND session_id = ? ORDER BY ordinal DESC LIMIT 1`).get(projectId, sessionId);
		if (!latestTurn || String(latestTurn.id) !== turnId) { throw new Error('Only the latest turn may resume a stopped session.'); }
		const ordinal = Number(nextTurn.ordinal);
		const previousTurn = ordinal > 1 ? this.db.prepare(`SELECT id, ordinal, state, cleanup_verified FROM agent_session_turns
			WHERE project_id = ? AND session_id = ? AND ordinal = ?`).get(projectId, sessionId, ordinal - 1) as Record<string, SQLOutputValue> | undefined : undefined;
		if (!previousTurn || Number(previousTurn.ordinal) !== ordinal - 1
			|| !['exited', 'failed', 'interrupted'].includes(String(previousTurn.state)) || Number(previousTurn.cleanup_verified) !== 1) {
			throw new Error('A stopped session requires a terminal, cleanup-verified previous turn before manual resume.');
		}
		if (this.db.prepare(`SELECT 1 FROM agent_workflow_run_nodes
			WHERE project_id = ? AND session_id = ? AND session_turn_id = ? LIMIT 1`).get(projectId, sessionId, turnId)) {
			throw new Error('A workflow-linked turn cannot use the manual stopped-session resume transition.');
		}
		const now = new Date().toISOString();
		const changed = this.db.prepare(`UPDATE agent_sessions SET state = 'starting', revision = revision + 1, updated_at = ?
			WHERE id = ? AND project_id = ? AND revision = ? AND state = 'stopped'
			AND EXISTS (SELECT 1 FROM agent_session_turns next WHERE next.id = ? AND next.project_id = ? AND next.session_id = ? AND next.state = 'starting')
			AND NOT EXISTS (SELECT 1 FROM agent_workflow_run_nodes node WHERE node.project_id = ? AND node.session_id = ? AND node.session_turn_id = ?)`)
			.run(now, sessionId, projectId, expectedRevision, turnId, projectId, sessionId, projectId, sessionId, turnId);
		if (Number(changed.changes) !== 1) { throw new Error('The stopped-session turn resume is stale or no longer eligible.'); }
		return this.getSessionInternal(projectId, sessionId)!;
	}

	private assertNoLiveTurnOwnsLifecycle(sessionId: string): void {
		if (this.db.prepare(`SELECT 1 FROM agent_session_turns WHERE session_id = ? AND state IN ('starting', 'running', 'stopping') LIMIT 1`).get(sessionId)) {
			throw new Error('A live session turn owns lifecycle updates; transition the turn instead.');
		}
	}

	/** Persists mailbox text. Future UI and MCP exposure must pass through the content redaction boundary. */
	sendMessage(projectId: string, senderSessionId: string, input: SendSessionMessageInput, policy?: { readonly maxUnreadMessages: number }): SessionMessageDTO {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(senderSessionId, 'sender session ID');
		this.validateUuid(input.recipientSessionId, 'recipient session ID');
		if (policy !== undefined && (!Number.isFinite(policy.maxUnreadMessages) || !Number.isSafeInteger(policy.maxUnreadMessages) || policy.maxUnreadMessages < 1 || policy.maxUnreadMessages > 1000)) {
			throw new Error('The trusted unread message limit must be an integer between 1 and 1000.');
		}
		if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
			throw new Error('The idempotency key must contain 1 to 128 characters.');
		}
		if (typeof input.body !== 'string' || input.body.length > MAX_MESSAGE_CODE_UNITS || Buffer.byteLength(input.body, 'utf8') > MAX_MESSAGE_BYTES) {
			throw new Error('The message body exceeds the allowed size.');
		}
		return this.transaction(() => {
			const sender = this.db.prepare('SELECT 1 FROM agent_sessions WHERE id = ? AND project_id = ?').get(senderSessionId, projectId);
			const recipient = this.db.prepare('SELECT 1 FROM agent_sessions WHERE id = ? AND project_id = ?').get(input.recipientSessionId, projectId);
			if (!sender || !recipient) { throw new Error('Both message sessions must belong to the specified project.'); }
			const prior = this.db.prepare(`SELECT id, project_id, sender_session_id, recipient_session_id, sequence, idempotency_key, body, created_at, read_at
				FROM agent_session_messages WHERE project_id = ? AND sender_session_id = ? AND idempotency_key = ?`).get(projectId, senderSessionId, input.idempotencyKey);
			if (prior) {
				if (String(prior.recipient_session_id) !== input.recipientSessionId || String(prior.body) !== input.body) {
					throw new Error('The idempotency key was already used for a different message request.');
				}
				return this.messageFromRow(prior);
			}
			if (policy) {
				const unread = Number(this.db.prepare(`SELECT COUNT(*) AS unread FROM agent_session_messages
					WHERE project_id = ? AND recipient_session_id = ? AND read_at IS NULL`).get(projectId, input.recipientSessionId)?.unread ?? 0);
				if (unread >= policy.maxUnreadMessages) { throw new Error('The recipient mailbox unread queue is full.'); }
			}
			const sequence = Number(this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM agent_session_messages WHERE project_id = ? AND recipient_session_id = ?').get(projectId, input.recipientSessionId)?.next_sequence ?? 1);
			const messageId = randomUUID();
			const notificationId = randomUUID();
			const now = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_session_messages (
				id, project_id, sender_session_id, recipient_session_id, sequence, idempotency_key, body, created_at, read_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
				messageId, projectId, senderSessionId, input.recipientSessionId, sequence, input.idempotencyKey, input.body, now,
			);
			const notificationSequence = Number(this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM agent_session_notifications WHERE project_id = ?').get(projectId)?.next_sequence ?? 1);
			this.db.prepare(`INSERT INTO agent_session_notifications (
				id, project_id, session_id, sequence, kind, message_id, created_at, read_at
			) VALUES (?, ?, ?, ?, 'message', ?, ?, NULL)`).run(notificationId, projectId, input.recipientSessionId, notificationSequence, messageId, now);
			return this.getMessageInternal(projectId, messageId)!;
		});
	}

	/** Trusted host callers must bind recipientSessionId to the authenticated session principal. */
	listInbox(projectId: string, recipientSessionId: string, options: SessionPageOptions): SessionMessageDTO[] {
		this.assertOpen();
		this.assertOwnedSession(projectId, recipientSessionId, 'recipient');
		const { afterSequence, limit } = this.pageValues(options);
		return this.db.prepare(`SELECT id, project_id, sender_session_id, recipient_session_id, sequence, idempotency_key, body, created_at, read_at
			FROM agent_session_messages WHERE project_id = ? AND recipient_session_id = ? AND sequence > ?
			ORDER BY sequence LIMIT ?`).all(projectId, recipientSessionId, afterSequence, limit).map(row => this.messageFromRow(row));
	}

	/** Trusted host callers must bind recipientSessionId to the authenticated session principal. */
	getInboxMessage(projectId: string, recipientSessionId: string, messageId: string): SessionMessageDTO | undefined {
		this.assertOpen();
		this.assertOwnedSession(projectId, recipientSessionId, 'recipient');
		this.validateUuid(messageId, 'message ID');
		const row = this.db.prepare(`SELECT id, project_id, sender_session_id, recipient_session_id, sequence, idempotency_key, body, created_at, read_at
			FROM agent_session_messages WHERE id = ? AND project_id = ? AND recipient_session_id = ?`).get(messageId, projectId, recipientSessionId);
		return row ? this.messageFromRow(row) : undefined;
	}

	/** Trusted host callers must bind recipientSessionId to the authenticated session principal. */
	acknowledgeMessage(projectId: string, recipientSessionId: string, messageId: string): void {
		this.assertOpen();
		this.assertOwnedSession(projectId, recipientSessionId, 'recipient');
		this.validateUuid(messageId, 'message ID');
		const now = new Date().toISOString();
		const result = this.db.prepare(`UPDATE agent_session_messages SET read_at = COALESCE(read_at, ?)
			WHERE id = ? AND project_id = ? AND recipient_session_id = ?`).run(now, messageId, projectId, recipientSessionId);
		if (Number(result.changes) !== 1) { throw new Error('The message does not belong to this recipient and project.'); }
	}

	listNotifications(projectId: string, options: SessionPageOptions): SessionNotificationDTO[] {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		const { afterSequence, limit } = this.pageValues(options);
		return this.db.prepare(`SELECT id, project_id, session_id, sequence, kind, message_id, created_at, read_at
			FROM agent_session_notifications WHERE project_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(projectId, afterSequence, limit).map(row => this.notificationFromRow(row));
	}

	notificationStatus(projectId: string): { readonly unreadCount: number; readonly latestSequence: number } {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		const row = this.db.prepare(`SELECT
			(SELECT COUNT(*) FROM agent_session_notifications WHERE project_id = ? AND read_at IS NULL) AS unread_count,
			(SELECT COALESCE(MAX(sequence), 0) FROM agent_session_notifications WHERE project_id = ?) AS latest_sequence`).get(projectId, projectId)!;
		const unreadCount = Number(row.unread_count);
		const latestSequence = Number(row.latest_sequence);
		if (!Number.isSafeInteger(unreadCount) || unreadCount < 0 || !Number.isSafeInteger(latestSequence) || latestSequence < 0) { throw new Error('Notification counters exceed the supported range.'); }
		return { unreadCount, latestSequence };
	}

	markNotificationRead(projectId: string, notificationId: string): void {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(notificationId, 'notification ID');
		const now = new Date().toISOString();
		const result = this.db.prepare(`UPDATE agent_session_notifications SET read_at = COALESCE(read_at, ?)
			WHERE id = ? AND project_id = ?`).run(now, notificationId, projectId);
		if (Number(result.changes) !== 1) { throw new Error('The notification does not belong to this project.'); }
	}

	private validateSessionInput(input: CreateAgentSessionInput): void {
		this.validateUuid(input.projectId, 'project ID');
		this.validateUuid(input.bindingId, 'binding ID');
		if (input.taskId !== undefined) { this.validateUuid(input.taskId, 'task ID'); }
		if (input.parentSessionId !== undefined) { this.validateUuid(input.parentSessionId, 'parent session ID'); }
		if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.trim().length > MAX_NAME_LENGTH) { throw new Error('The session name must contain 1 to 200 characters.'); }
		if (input.provider !== 'codex' && input.provider !== 'claude') { throw new Error('The session provider is invalid.'); }
		if (typeof input.model !== 'string' || input.model.trim().length === 0 || input.model.trim().length > MAX_MODEL_LENGTH) { throw new Error('The session model must contain 1 to 200 characters.'); }
		if (input.profileRef !== undefined && (typeof input.profileRef !== 'string' || input.profileRef.trim().length > MAX_PROFILE_REF_LENGTH)) { throw new Error('The profile reference exceeds 512 characters.'); }
		if (input.workspaceMode !== 'gitWorktree' && input.workspaceMode !== 'sharedFolder') { throw new Error('The session workspace mode is invalid.'); }
	}

	private validateUuid(value: string, label: string): void {
		if (typeof value !== 'string' || !UUID_PATTERN.test(value)) { throw new Error(`The ${label} must be a UUID.`); }
	}

	private assertOwnedSession(projectId: string, sessionId: string, label: string): void {
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(sessionId, `${label} session ID`);
		if (!this.db.prepare('SELECT 1 FROM agent_sessions WHERE id = ? AND project_id = ?').get(sessionId, projectId)) {
			throw new Error(`The ${label} session does not belong to this project.`);
		}
	}

	private pageValues(options: SessionPageOptions): { afterSequence: number; limit: number } {
		const afterSequence = options.afterSequence ?? 0;
		const limit = options.limit ?? DEFAULT_PAGE_SIZE;
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) { throw new Error('The sequence cursor must be a non-negative safe integer.'); }
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) { throw new Error('The page limit must be between 1 and 100.'); }
		return { afterSequence, limit };
	}

	private getSessionInternal(projectId: string, sessionId: string): AgentSessionDTO | undefined {
		const row = this.db.prepare(`SELECT id, project_id, binding_id, task_id, parent_session_id, name, provider, model, profile_ref,
			workspace_mode, state, revision, created_at, updated_at FROM agent_sessions WHERE id = ? AND project_id = ?`).get(sessionId, projectId);
		return row ? this.sessionFromRow(row) : undefined;
	}

	private getMessageInternal(projectId: string, messageId: string): SessionMessageDTO | undefined {
		const row = this.db.prepare(`SELECT id, project_id, sender_session_id, recipient_session_id, sequence, idempotency_key, body, created_at, read_at
			FROM agent_session_messages WHERE id = ? AND project_id = ?`).get(messageId, projectId);
		return row ? this.messageFromRow(row) : undefined;
	}

	private sessionFromRow(row: Record<string, SQLOutputValue>): AgentSessionDTO {
		return {
			id: String(row.id), projectId: String(row.project_id), bindingId: String(row.binding_id),
			taskId: row.task_id === null ? null : String(row.task_id), parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
			name: String(row.name), provider: row.provider as AgentSessionProvider, model: String(row.model),
			profileRef: row.profile_ref === null ? null : String(row.profile_ref), workspaceMode: row.workspace_mode as AgentSessionWorkspaceMode,
			state: row.state as AgentSessionState, revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
		};
	}

	private messageFromRow(row: Record<string, SQLOutputValue>): SessionMessageDTO {
		return {
			id: String(row.id), projectId: String(row.project_id), senderSessionId: String(row.sender_session_id), recipientSessionId: String(row.recipient_session_id),
			sequence: Number(row.sequence), idempotencyKey: String(row.idempotency_key), body: String(row.body), createdAt: String(row.created_at),
			readAt: row.read_at === null ? null : String(row.read_at),
		};
	}

	private notificationFromRow(row: Record<string, SQLOutputValue>): SessionNotificationDTO {
		return {
			id: String(row.id), projectId: String(row.project_id), sessionId: String(row.session_id), sequence: Number(row.sequence),
			kind: 'message', messageId: String(row.message_id), createdAt: String(row.created_at), readAt: row.read_at === null ? null : String(row.read_at),
		};
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
