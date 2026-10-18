/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type { AgentSessionPermissionPolicy, AgentSessionTurnDTO } from '../../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';
import { createAgentPtyOutputSanitizer, sanitizeCompleteAgentText } from './agentOutputRedactor.js';

const MAX_WAIT_MS = 30_000;
const MAX_WAITERS = 64;
const WAIT_POLL_MS = 200;
const MAX_MCP_FRAME_BYTES = 65_536;
const MCP_FRAME_RESERVE_BYTES = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AgentSessionCollaborationGrantInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly permissionPolicy: AgentSessionPermissionPolicy;
	readonly knownSecrets: readonly string[];
}

/** Opaque in-process authority minted only after the turn is checked against the durable launch snapshot. */
export interface AgentSessionCollaborationGrant {
	readonly id: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
}

export interface AgentSessionCollaborationMessage {
	readonly id: string;
	readonly senderSessionId: string;
	readonly recipientSessionId: string;
	readonly sequence: number;
	readonly body: string;
	readonly createdAt: string;
	readonly readAt: string | null;
	readonly redacted: boolean;
	readonly receiverAvailability: 'active' | 'offline';
}

export interface AgentSessionCollaborationPage {
	readonly messages: readonly AgentSessionCollaborationMessage[];
	readonly nextCursor: number;
	readonly timedOut?: boolean;
}

interface GrantRecord {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly permissionPolicy: AgentSessionPermissionPolicy;
	readonly knownSecrets: readonly string[];
	active: boolean;
}

/** Shared trusted backend for launch-scoped MCP and future host IPC mailbox handlers. */
export class AgentSessionCollaborationService {
	private readonly grants = new WeakMap<AgentSessionCollaborationGrant, GrantRecord>();
	private readonly grantSet = new Set<AgentSessionCollaborationGrant>();
	private readonly changeListeners = new Set<() => void>();
	private activeWaiters = 0;

	constructor(private readonly database: Pick<WorkspaceDatabase, 'agentSessions' | 'agentSessionTurns'>) { }

	/** The host calls this only for the turn whose trusted launch snapshot supplied this policy. */
	authorizeTurn(input: AgentSessionCollaborationGrantInput): AgentSessionCollaborationGrant {
		assertUuid(input.projectId, 'project ID');
		assertUuid(input.sessionId, 'session ID');
		assertUuid(input.turnId, 'turn ID');
		if (!Array.isArray(input.knownSecrets) || input.knownSecrets.some(secret => typeof secret !== 'string' || secret.length > 65_408)) {
			throw new Error('The trusted session secret set is invalid.');
		}
		createAgentPtyOutputSanitizer({ knownSecrets: input.knownSecrets });
		const session = this.database.agentSessions.getSession(input.projectId, input.sessionId);
		const turn = this.database.agentSessionTurns.getTurn(input.projectId, input.sessionId, input.turnId);
		if (!session || !turn || isTerminal(turn)) { throw new Error('The collaboration grant requires a live turn in the specified project and session.'); }
		if (turn.snapshot.permissionPolicy.mode !== input.permissionPolicy.mode || turn.snapshot.permissionPolicy.approval !== input.permissionPolicy.approval) {
			throw new Error('The collaboration grant permission policy does not match the durable turn snapshot.');
		}
		const grant = Object.freeze({ id: randomUUID(), projectId: input.projectId, sessionId: input.sessionId, turnId: input.turnId });
		this.grants.set(grant, {
			projectId: input.projectId,
			sessionId: input.sessionId,
			turnId: input.turnId,
			permissionPolicy: Object.freeze({ ...input.permissionPolicy }),
			knownSecrets: Object.freeze([...new Set(input.knownSecrets.filter(Boolean))]),
			active: true,
		});
		this.grantSet.add(grant);
		return grant;
	}

	/** Synchronous revocation makes every later dispatch fail, including registered waits. */
	revoke(grant: AgentSessionCollaborationGrant): void {
		const record = this.grants.get(grant);
		if (!record || !record.active) { return; }
		record.active = false;
		this.grantSet.delete(grant);
		for (const listener of this.changeListeners) { listener(); }
	}

	listSessions(grant: AgentSessionCollaborationGrant, limit = 50): readonly Record<string, string | number | null>[] {
		const record = this.requireGrant(grant);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { throw new Error('The session page limit must be between 1 and 100.'); }
		return this.database.agentSessions.listSessions(record.projectId).slice(0, limit).map(session => ({
			id: session.id,
			name: this.sanitize(record, session.name).text,
			provider: session.provider,
			model: this.sanitize(record, session.model).text,
			state: session.state,
			updatedAt: session.updatedAt,
		}));
	}

	sendMessage(grant: AgentSessionCollaborationGrant, input: { readonly recipientSessionId: string; readonly idempotencyKey: string; readonly body: string }): AgentSessionCollaborationMessage {
		const record = this.requireGrant(grant);
		assertUuid(input.recipientSessionId, 'recipient session ID');
		const idempotency = this.sanitize(record, input.idempotencyKey);
		if (idempotency.redacted) { throw new Error('The idempotency key contains a trusted secret.'); }
		const body = this.sanitize(record, input.body);
		const candidate = {
			id: '00000000-0000-4000-8000-000000000000', senderSessionId: record.sessionId,
			recipientSessionId: input.recipientSessionId, sequence: Number.MAX_SAFE_INTEGER,
			body: body.text, createdAt: '9999-12-31T23:59:59.999Z', readAt: '9999-12-31T23:59:59.999Z',
			redacted: body.redacted, receiverAvailability: 'offline' as const,
		};
		if (!fitsMcpToolResult({ message: candidate }) || !fitsMcpToolResult({ messages: [candidate], nextCursor: Number.MAX_SAFE_INTEGER, timedOut: true })) {
			throw new Error('The message cannot be represented within the session MCP response limit.');
		}
		const message = this.database.agentSessions.sendMessage(record.projectId, record.sessionId, {
			recipientSessionId: input.recipientSessionId,
			idempotencyKey: input.idempotencyKey,
			body: body.text,
		}, { maxUnreadMessages: 100 });
		this.notifyChanged();
		return this.messageFromStore(record, message, body.redacted);
	}

	listMessages(grant: AgentSessionCollaborationGrant, options: { readonly afterSequence?: number; readonly limit?: number } = {}): AgentSessionCollaborationPage {
		const record = this.requireGrant(grant);
		const source = this.database.agentSessions.listInbox(record.projectId, record.sessionId, options);
		const messages: AgentSessionCollaborationMessage[] = [];
		let nextCursor = options.afterSequence ?? 0;
		for (const item of source) {
			const message = this.messageFromStore(record, item);
			const candidate = { messages: [...messages, message], nextCursor: message.sequence };
			if (!fitsMcpToolResult(candidate) || !fitsMcpToolResult({ ...candidate, timedOut: true })) {
				if (messages.length === 0) { throw new Error('A mailbox message cannot be represented within the session MCP response limit.'); }
				break;
			}
			messages.push(message);
			nextCursor = message.sequence;
		}
		return { messages, nextCursor };
	}

	acknowledgeMessage(grant: AgentSessionCollaborationGrant, messageId: string): void {
		const record = this.requireGrant(grant);
		assertUuid(messageId, 'message ID');
		this.database.agentSessions.acknowledgeMessage(record.projectId, record.sessionId, messageId);
	}

	async waitForMessages(
		grant: AgentSessionCollaborationGrant,
		options: { readonly afterSequence?: number; readonly limit?: number; readonly timeoutMs?: number },
		signal?: AbortSignal,
	): Promise<AgentSessionCollaborationPage> {
		const record = this.requireGrant(grant);
		const timeoutMs = options.timeoutMs ?? 20_000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) { throw new Error('The mailbox wait must be between 0 and 30000 ms.'); }
		if (this.activeWaiters >= MAX_WAITERS) { throw new Error('Too many mailbox waits are active.'); }
		this.activeWaiters++;
		try {
			const immediate = this.listMessages(grant, options);
			if (immediate.messages.length || timeoutMs === 0) { return immediate; }
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				this.throwIfAborted(record, signal);
				await this.waitForChange(Math.min(WAIT_POLL_MS, deadline - Date.now()), record, signal);
				this.throwIfAborted(record, signal);
				const page = this.listMessages(grant, options);
				if (page.messages.length) { return page; }
			}
			this.requireGrant(grant);
			return { ...this.listMessages(grant, options), timedOut: true };
		} finally { this.activeWaiters--; }
	}

	private messageFromStore(record: GrantRecord, message: { id: string; senderSessionId: string; recipientSessionId: string; sequence: number; body: string; createdAt: string; readAt: string | null }, bodyWasRedacted = false): AgentSessionCollaborationMessage {
		const sanitized = this.sanitize(record, message.body);
		return {
			id: message.id,
			senderSessionId: message.senderSessionId,
			recipientSessionId: message.recipientSessionId,
			sequence: message.sequence,
			body: sanitized.text,
			createdAt: message.createdAt,
			readAt: message.readAt,
			redacted: bodyWasRedacted || sanitized.redacted,
			receiverAvailability: this.receiverIsActive(record.projectId, message.recipientSessionId) ? 'active' : 'offline',
		};
	}

	private receiverIsActive(projectId: string, sessionId: string): boolean {
		return this.database.agentSessionTurns.listTurns(projectId, sessionId).some(turn => turn.state === 'starting' || turn.state === 'running' || turn.state === 'stopping');
	}

	private sanitize(record: GrantRecord, value: string): { text: string; redacted: boolean } {
		if (typeof value !== 'string') { throw new Error('Mailbox text must be a string.'); }
		const text = sanitizeCompleteAgentText(value, { knownSecrets: record.knownSecrets });
		return { text, redacted: text !== value };
	}

	private requireGrant(grant: AgentSessionCollaborationGrant): GrantRecord {
		const record = this.grants.get(grant);
		if (!record || !record.active || !this.grantSet.has(grant)) { throw new Error('The session collaboration capability is revoked or invalid.'); }
		// Recheck the durable turn on every operation so a terminal turn cannot retain mailbox access.
		const current = this.database.agentSessionTurns.getTurn(record.projectId, record.sessionId, record.turnId);
		if (!current || isTerminal(current)) {
			record.active = false;
			this.grantSet.delete(grant);
			for (const listener of this.changeListeners) { listener(); }
			throw new Error('The session collaboration turn has ended.');
		}
		return record;
	}

	private throwIfAborted(record: GrantRecord, signal?: AbortSignal): void {
		if (!record.active || signal?.aborted) { throw new Error('The mailbox wait was cancelled because access was revoked.'); }
	}

	private waitForChange(ms: number, record: GrantRecord, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				this.changeListeners.delete(onChange);
				signal?.removeEventListener('abort', onAbort);
				if (error) { reject(error); } else { resolve(); }
			};
			const onChange = () => { if (!record.active || signal?.aborted) { finish(new Error('The mailbox wait was cancelled because access was revoked.')); } else { finish(); } };
			const onAbort = () => finish(new Error('The mailbox wait was cancelled because access was revoked.'));
			const timer = setTimeout(() => finish(), ms);
			this.changeListeners.add(onChange);
			signal?.addEventListener('abort', onAbort, { once: true });
			if (!record.active || signal?.aborted) { onAbort(); }
		});
	}

	private notifyChanged(): void { for (const listener of this.changeListeners) { listener(); } }
}

function assertUuid(value: string, label: string): void {
	if (typeof value !== 'string' || !UUID.test(value)) { throw new Error(`The ${label} must be a UUID.`); }
}

function fitsMcpToolResult(result: unknown): boolean {
	const contentText = JSON.stringify(result);
	const toolResult = { content: [{ type: 'text', text: contentText }], structuredContent: result };
	const bridgeFrame = `${JSON.stringify({ type: 'response', id: 'x'.repeat(32), result })}\n`;
	const mcpFrame = `${JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(32), result: toolResult })}\n`;
	return Buffer.byteLength(bridgeFrame, 'utf8') <= MAX_MCP_FRAME_BYTES - MCP_FRAME_RESERVE_BYTES
		&& Buffer.byteLength(mcpFrame, 'utf8') <= MAX_MCP_FRAME_BYTES - MCP_FRAME_RESERVE_BYTES;
}

function isTerminal(turn: AgentSessionTurnDTO): boolean {
	return turn.state === 'exited' || turn.state === 'interrupted' || turn.state === 'failed';
}
