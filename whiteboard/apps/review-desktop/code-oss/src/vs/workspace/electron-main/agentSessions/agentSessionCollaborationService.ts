/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type { AgentSessionPermissionPolicy, AgentSessionTurnDTO, AgentSessionTranscriptPageOptions } from '../../common/workspaceAgentSessionProtocol.js';
import type { AgentSessionControlRequestDTO, AgentSessionControlWorkflowAuthority } from '../../common/workspaceAgentSessionControlProtocol.js';
import type { AgentWorkflowDTO, AgentWorkflowPlan } from '../../common/workspaceAgentWorkflowProtocol.js';
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

export interface AgentSessionWorkflowHost {
	cancel(projectId: string, workflowId: string, expectedRevision: number, idempotencyKey: string): AgentWorkflowDTO;
	getHostError(projectId: string, workflowId: string, runId?: string): string | null;
}

export interface AgentSessionControlHost {
	/** Queue only an already durable receipt; never await provider stop on the MCP socket. */
	queueStop(request: AgentSessionControlRequestDTO): void;
}

export interface AgentSessionWorkflowPublicStatus {
	readonly scope: { readonly bindingId: string; readonly taskId: string | null };
	readonly workflow: { readonly id: string; readonly state: string; readonly revision: number; readonly planVersion: number; readonly updatedAt: string };
	readonly limits: { readonly maxConcurrentNodes: number; readonly maxTotalTurns: number; readonly maxDurationMs: number };
	readonly nodes: readonly { readonly nodeId: string; readonly role: string; readonly provider: string; readonly model: string; readonly state: string; readonly dependsOn: readonly string[] }[];
	readonly run: null | { readonly id: string; readonly state: string; readonly revision: number; readonly deadlineAt: string; readonly nodes: readonly { readonly nodeId: string; readonly state: string }[] };
	readonly hostError: string | null;
}

export interface AgentSessionWorkflowCancelReceipt {
	readonly workflowId: string;
	readonly revision: number;
	readonly state: string;
	readonly cancellationRequested: true;
}

interface GrantRecord {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly permissionPolicy: AgentSessionPermissionPolicy;
	readonly knownSecrets: readonly string[];
	readonly workflowAuthority: AgentSessionControlWorkflowAuthority | undefined;
	active: boolean;
}

/** Shared trusted backend for launch-scoped MCP and future host IPC mailbox handlers. */
export class AgentSessionCollaborationService {
	private readonly grants = new WeakMap<AgentSessionCollaborationGrant, GrantRecord>();
	private readonly grantSet = new Set<AgentSessionCollaborationGrant>();
	private readonly changeListeners = new Set<() => void>();
	private activeWaiters = 0;

	constructor(
		private readonly database: Pick<WorkspaceDatabase, 'agentSessions' | 'agentSessionTurns' | 'agentWorkflows' | 'agentSessionTranscripts' | 'agentSessionControlRequests'>,
		private readonly workflowHost?: AgentSessionWorkflowHost,
		private readonly controlHost?: AgentSessionControlHost,
	) { }

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
			workflowAuthority: this.database.agentWorkflows.getSessionControlAuthority(input.projectId, input.sessionId, input.turnId),
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
		return this.listSessionPage(grant, { limit }).sessions;
	}

	requestStart(grant: AgentSessionCollaborationGrant, input: {
		readonly targetSessionId: string; readonly expectedSessionRevision: number;
		readonly permissionPolicy: AgentSessionPermissionPolicy; readonly reason: string; readonly idempotencyKey: string;
	}): AgentSessionControlRequestDTO {
		const record = this.requireGrant(grant);
		if (!this.controlHost) { throw new Error('Human-reviewed session control is unavailable on this host.'); }
		this.assertControlKey(record, input.idempotencyKey);
		return this.database.agentSessionControlRequests.createStartRequest({
			projectId: record.projectId, callerSessionId: record.sessionId, callerTurnId: record.turnId,
			targetSessionId: input.targetSessionId, expectedSessionRevision: input.expectedSessionRevision,
			permissionPolicy: input.permissionPolicy, reason: this.sanitize(record, input.reason).text, idempotencyKey: input.idempotencyKey,
		});
	}

	requestStop(grant: AgentSessionCollaborationGrant, input: {
		readonly targetSessionId: string; readonly targetTurnId: string; readonly idempotencyKey: string;
	}): AgentSessionControlRequestDTO {
		const record = this.requireGrant(grant);
		if (!this.controlHost) { throw new Error('Session stop control is unavailable on this host.'); }
		this.assertControlKey(record, input.idempotencyKey);
		const ownTurn = input.targetSessionId === record.sessionId && input.targetTurnId === record.turnId;
		if (!ownTurn && !record.workflowAuthority) { throw new Error('The target is outside this turn and its captured approved workflow.'); }
		const request = this.database.agentSessionControlRequests.createStopRequest({
			projectId: record.projectId, callerSessionId: record.sessionId, callerTurnId: record.turnId,
			targetSessionId: input.targetSessionId, targetTurnId: input.targetTurnId, idempotencyKey: input.idempotencyKey,
			...(!ownTurn ? { workflowAuthority: record.workflowAuthority } : {}),
		});
		if (request.state === 'stopAccepted') {
			try { this.controlHost.queueStop(request); }
			catch (error) {
				this.database.agentSessionControlRequests.markStopResult(request.id, 'stopQueueUnavailable');
				throw error;
			}
		}
		return request;
	}

	getOwnControlRequest(grant: AgentSessionCollaborationGrant, requestId: string): AgentSessionControlRequestDTO {
		const record = this.requireGrant(grant);
		const request = this.database.agentSessionControlRequests.get(record.projectId, requestId);
		if (!request || request.callerSessionId !== record.sessionId || request.callerTurnId !== record.turnId) { throw new Error('The control request does not belong to this exact caller turn.'); }
		return request;
	}

	private assertControlKey(record: GrantRecord, key: string): void {
		if (typeof key !== 'string' || !key.trim() || key.length > 128 || this.sanitize(record, key).redacted) { throw new Error('The control idempotency key is invalid or contains a trusted secret.'); }
	}

	listSessionPage(grant: AgentSessionCollaborationGrant, options: { readonly afterSessionId?: string; readonly limit?: number } = {}): { readonly sessions: readonly Record<string, string | number | null>[]; readonly nextCursor: string | null } {
		const record = this.requireGrant(grant);
		const limit = options.limit ?? 50;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { throw new Error('The session page limit must be between 1 and 100.'); }
		const ordered = this.database.agentSessions.listSessions(record.projectId);
		const authority = record.workflowAuthority;
		const currentAuthority = authority ? this.database.agentWorkflows.getSessionControlAuthority(record.projectId, record.sessionId, record.turnId) : undefined;
		const currentRun = authority && JSON.stringify(authority) === JSON.stringify(currentAuthority)
			? this.database.agentWorkflows.getRun(record.projectId, authority.workflowId, authority.runId) : undefined;
		const workflowTurns = new Map(currentRun?.nodes.map(node => [node.sessionId, node.sessionTurnId]));
		let start = 0;
		if (options.afterSessionId !== undefined) {
			assertUuid(options.afterSessionId, 'session cursor');
			const cursorIndex = ordered.findIndex(session => session.id === options.afterSessionId);
			if (cursorIndex < 0) { throw new Error('The session cursor is unavailable in this project.'); }
			start = cursorIndex + 1;
		}
		const sessions: Record<string, string | number | null>[] = [];
		for (const session of ordered.slice(start, start + limit + 1)) {
			const item = {
				id: session.id,
				name: this.sanitize(record, session.name).text,
				provider: session.provider,
				model: this.sanitize(record, session.model).text,
				state: session.state,
				revision: session.revision,
				parentSessionId: session.parentSessionId,
				callerTurnId: session.id === record.sessionId ? record.turnId : null,
				workflowTurnId: authority?.allowedSessionIds.includes(session.id) ? workflowTurns.get(session.id) ?? null : null,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
			};
			if (sessions.length === limit) { break; }
			if (!fitsMcpToolResult({ sessions: [...sessions, item], nextCursor: item.id })) {
				if (!sessions.length) { throw new Error('A session cannot be represented within the session MCP response limit.'); }
				break;
			}
			sessions.push(item);
		}
		const hasMore = ordered.length > start + sessions.length;
		const nextCursor = hasMore && sessions.length ? String(sessions[sessions.length - 1].id) : null;
		const page = { sessions, nextCursor };
		if (!fitsMcpToolResult(page)) { throw new Error('The session page cannot be represented within the session MCP response limit.'); }
		return page;
	}

	readTranscriptPage(grant: AgentSessionCollaborationGrant, turnId: string, options: AgentSessionTranscriptPageOptions = {}) {
		const record = this.requireGrant(grant);
		assertUuid(turnId, 'turn ID');
		const targetTurn = this.database.agentSessionTurns.getTurn(record.projectId, record.sessionId, turnId);
		const liveTurn = this.database.agentSessionTurns.getTurn(record.projectId, record.sessionId, record.turnId);
		if (!targetTurn || targetTurn.projectId !== record.projectId || targetTurn.sessionId !== record.sessionId || !liveTurn) {
			throw new Error('The requested transcript is unavailable within this session capability.');
		}
		if (isTerminal(liveTurn)) { throw new Error('The session collaboration turn has ended.'); }
		if (targetTurn.ordinal > liveTurn.ordinal) { throw new Error('The requested transcript must be from this turn or earlier in the same session.'); }
		return this.database.agentSessionTranscripts.readPage(record.projectId, record.sessionId, turnId, options);
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

	getWorkflowStatus(grant: AgentSessionCollaborationGrant, workflowId: string): AgentSessionWorkflowPublicStatus {
		const { record, workflow, plan } = this.requireOwnedWorkflow(grant, workflowId);
		const run = this.database.agentWorkflows.getLatestRun(record.projectId, workflowId) ?? null;
		const result: AgentSessionWorkflowPublicStatus = {
			scope: { bindingId: this.sanitize(record, plan.bindingId).text, taskId: plan.taskId === null ? null : this.sanitize(record, plan.taskId).text },
			workflow: {
				id: this.sanitize(record, workflow.id).text, state: this.sanitize(record, workflow.state).text,
				revision: workflow.revision, planVersion: workflow.planVersion, updatedAt: this.sanitize(record, workflow.updatedAt).text,
			},
			limits: { maxConcurrentNodes: plan.maxConcurrentNodes, maxTotalTurns: plan.maxTotalTurns, maxDurationMs: plan.maxDurationMs },
			nodes: plan.nodes.map(node => ({
				nodeId: this.sanitize(record, node.nodeId).text, role: this.sanitize(record, node.role).text,
				provider: this.sanitize(record, node.provider).text, model: this.sanitize(record, node.model).text,
				state: this.sanitize(record, run?.nodes.find(item => item.nodeId === node.nodeId)?.state ?? 'notStarted').text,
				dependsOn: node.dependsOn.map(id => this.sanitize(record, id).text),
			})),
			run: run ? {
				id: this.sanitize(record, run.id).text, state: this.sanitize(record, run.state).text,
				revision: run.revision, deadlineAt: this.sanitize(record, run.deadlineAt).text,
				nodes: run.nodes.map(node => ({ nodeId: this.sanitize(record, node.nodeId).text, state: this.sanitize(record, node.state).text })),
			} : null,
			hostError: this.sanitize(record, this.workflowHost?.getHostError(record.projectId, workflowId, run?.id) ?? '').text || null,
		};
		if (!fitsMcpToolResult(result)) { throw new Error('The workflow status cannot be represented within the session MCP response limit.'); }
		return result;
	}

	cancelWorkflow(grant: AgentSessionCollaborationGrant, input: { readonly workflowId: string; readonly expectedRevision: number; readonly idempotencyKey: string }): AgentSessionWorkflowCancelReceipt {
		const { record } = this.requireOwnedWorkflow(grant, input.workflowId);
		if (!this.workflowHost) { throw new Error('Workflow cancellation is unavailable on this host.'); }
		if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) { throw new Error('The expected workflow revision is invalid.'); }
		if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128) { throw new Error('The workflow cancel idempotency key is invalid.'); }
		const key = this.sanitize(record, input.idempotencyKey);
		if (key.redacted) { throw new Error('The workflow cancel idempotency key contains a trusted secret.'); }
		const workflow = this.workflowHost.cancel(record.projectId, input.workflowId, input.expectedRevision, input.idempotencyKey);
		const receipt: AgentSessionWorkflowCancelReceipt = {
			workflowId: this.sanitize(record, workflow.id).text,
			revision: workflow.revision,
			state: this.sanitize(record, workflow.state).text,
			cancellationRequested: true,
		};
		if (!fitsMcpToolResult(receipt)) { throw new Error('The workflow cancellation receipt cannot be represented within the session MCP response limit.'); }
		return receipt;
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

	private requireOwnedWorkflow(grant: AgentSessionCollaborationGrant, workflowId: string): {
		readonly record: GrantRecord;
		readonly workflow: AgentWorkflowDTO;
		readonly plan: AgentWorkflowPlan;
	} {
		const record = this.requireGrant(grant);
		assertUuid(workflowId, 'workflow ID');
		const workflow = this.database.agentWorkflows.getWorkflow(record.projectId, workflowId);
		const plan = workflow ? this.database.agentWorkflows.getPlan(record.projectId, workflowId, workflow.planVersion) : undefined;
		if (!workflow || !plan || !plan.nodes.some(node => node.sessionId === record.sessionId)) {
			throw new Error('The workflow is unavailable to this session in the granted project.');
		}
		return { record, workflow, plan };
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
