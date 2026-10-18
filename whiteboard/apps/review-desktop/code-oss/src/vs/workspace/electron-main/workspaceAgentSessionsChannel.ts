/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { isUUID } from '../../base/common/uuid.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type {
	AgentSessionPermissionPolicy,
	AgentSessionProvider,
	AgentSessionTranscriptPageOptions,
	SessionMessageDTO,
	CreateAgentSessionInput,
	WorkspaceAgentSessionWorkspacePreparationDTO,
	WorkspaceAgentSessionOutputEvent,
} from '../common/workspaceAgentSessionProtocol.js';
import { WORKSPACE_AGENT_SESSIONS_OUTPUT_EVENT } from '../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceAgentSessionMailboxMessage, WorkspaceAgentSessionMailboxPage } from '../common/workspaceAgentCommunicationProtocol.js';
import type { AgentSessionAttachResult, AgentSessionService } from './agentSessions/agentSessionService.js';
import type { WorkspaceDatabase } from './workspaceDatabase.js';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_READ_CHUNKS = 500;
const MAX_MAILBOX_PAGE_BYTES = 512 * 1024;
const CATCH_UP_READ_PAGE_SIZE = 100;
const MAX_CATCH_UP_CHUNKS = 5_000;
const MAX_ATTACHMENTS_PER_WINDOW = 8;
const MAX_ATTACHMENTS_PER_TURN = 2;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MAX_DIMENSION = 1000;

interface ScopedAttachment {
	readonly attachmentId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly owner: WebContents;
	lastSentSequence: number;
}

interface AttachmentReservation {
	readonly owner: WebContents;
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
}

interface SenderScope {
	readonly sender: WebContents;
	generation: number;
	projectId?: string;
	descriptorUri?: string;
	pendingOperations: number;
	disposeListeners?: () => void;
}

interface ScopeToken {
	readonly scope: SenderScope;
	readonly generation: number;
	readonly projectId: string;
	readonly descriptorUri: string;
}

/** Project-scoped IPC for durable sessions and host-owned PTY capabilities. */
export class WorkspaceAgentSessionsChannel {
	private readonly attachments = new Map<string, ScopedAttachment>();
	private readonly attachmentReservations = new Map<string, AttachmentReservation>();
	private readonly senderScopes = new Map<number, SenderScope>();

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly windowsMainService: IWindowsMainService,
		private readonly service?: AgentSessionService,
		private readonly prepareCreatedSession?: (projectId: string, sessionId: string) => Promise<WorkspaceAgentSessionWorkspacePreparationDTO>,
		private readonly normalizeProfileRef?: (provider: AgentSessionProvider, profileRef: string | undefined) => string,
		private readonly workspacePreparation?: (projectId: string, sessionId: string) => Promise<WorkspaceAgentSessionWorkspacePreparationDTO>,
		private readonly prepareWorkspace?: (projectId: string, sessionId: string) => Promise<WorkspaceAgentSessionWorkspacePreparationDTO>,
	) { }

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		const projectId = this.authorize(sender);
		switch (command) {
			case 'listSessions': {
				this.assertProjectRequest(arg, projectId);
				return this.database.agentSessions.listSessions(projectId) as T;
			}
			case 'createSession': {
				const parsed = this.parseCreate(arg, projectId);
				const request = this.normalizeProfileRef ? { ...parsed, profileRef: this.normalizeProfileRef(parsed.provider, parsed.profileRef) } : parsed;
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const session = this.database.agentSessions.createSession(request);
					if (this.prepareCreatedSession) { await this.prepareCreatedSession(projectId, session.id); }
					this.assertScopeCurrent(scope);
					return session as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'workspacePreparation': {
				const request = this.parseSessionRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const status = await this.requireWorkspacePreparationHook(this.workspacePreparation)(projectId, request.sessionId);
					this.assertScopeCurrent(scope);
					return status as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'prepareWorkspace': {
				const request = this.parseSessionRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const status = await this.requireWorkspacePreparationHook(this.prepareWorkspace)(projectId, request.sessionId);
					this.assertScopeCurrent(scope);
					return status as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'listTurns': {
				const request = this.parseSessionRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				return this.database.agentSessionTurns.listTurns(projectId, request.sessionId) as T;
			}
			case 'readTranscript': {
				const request = this.parseTurnRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const options = this.parseTranscriptOptions(this.record(arg).options);
				return this.database.agentSessionTranscripts.readPage(projectId, request.sessionId, request.turnId, options) as T;
			}
			case 'listNotifications': {
				const request = this.record(arg);
				this.assertProjectId(request.projectId, projectId);
				return this.database.agentSessions.listNotifications(projectId, {
					afterSequence: request.afterSequence === undefined ? 0 : this.sequence(request.afterSequence, 'notification cursor'),
					limit: request.limit === undefined ? 50 : this.integer(request.limit, 1, 100, 'notification page limit'),
				}) as T;
			}
			case 'notificationStatus': {
				const request = this.record(arg);
				this.assertProjectId(request.projectId, projectId);
				return this.database.agentSessions.notificationStatus(projectId) as T;
			}
			case 'listMessages': {
				const request = this.parseSessionRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const raw = this.record(arg);
				const afterSequence = raw.afterSequence === undefined ? 0 : this.sequence(raw.afterSequence, 'mailbox cursor');
				const limit = raw.limit === undefined ? 50 : this.integer(raw.limit, 1, 100, 'mailbox page limit');
				const source = this.database.agentSessions.listInbox(projectId, request.sessionId, { afterSequence, limit });
				const messages: WorkspaceAgentSessionMailboxPage['messages'][number][] = [];
				const envelopeBytes = Buffer.byteLength(JSON.stringify({ messages: [], nextCursor: Number.MAX_SAFE_INTEGER, hasMore: false }), 'utf8');
				let outputBytes = envelopeBytes;
				for (const message of source) {
					const item = projectMailboxMessage(message);
					const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
					if (envelopeBytes + bytes > MAX_MAILBOX_PAGE_BYTES) { throw new Error('A stored message exceeds the mailbox response byte limit.'); }
					const separatorBytes = messages.length > 0 ? 1 : 0;
					if (outputBytes + separatorBytes + bytes > MAX_MAILBOX_PAGE_BYTES) { break; }
					messages.push(item);
					outputBytes += separatorBytes + bytes;
				}
				const page: WorkspaceAgentSessionMailboxPage = {
					messages,
					nextCursor: messages.at(-1)?.sequence ?? afterSequence,
					hasMore: messages.length < source.length || source.length === limit,
				};
				return page as T;
			}
			case 'getMessage': {
				const request = this.parseSessionRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const messageId = this.uuid(this.record(arg).messageId, 'message ID');
				const message = this.database.agentSessions.getInboxMessage(projectId, request.sessionId, messageId);
				return (message ? projectMailboxMessage(message) : null) as T;
			}
			case 'markNotificationRead': {
				const request = this.record(arg);
				this.assertProjectId(request.projectId, projectId);
				this.database.agentSessions.markNotificationRead(projectId, this.uuid(request.notificationId, 'notification ID'));
				return undefined as T;
			}
			case 'preview': {
				const request = this.parsePreview(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const preview = await this.requireService().preview(request);
					this.assertScopeCurrent(scope);
					return preview as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'start': {
				const request = this.parseStart(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const turn = await this.requireService().start(request);
					if (!this.isScopeCurrent(scope)) {
						let stopped: Awaited<ReturnType<AgentSessionService['stop']>>;
						try { stopped = await this.requireService().stop(projectId, request.sessionId, turn.id); }
						catch (error) {
							throw new Error(`The project window changed after turn ${turn.id} started; exact-turn cleanup failed: ${this.errorMessage(error)}`);
						}
						throw new Error(`The project window changed after turn ${turn.id} started; the exact turn was stopped (cleanup verified: ${stopped.cleanupVerified}).`);
					}
					return turn as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'stop': {
				const request = this.parseTurnRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const turn = await this.requireService().stop(projectId, request.sessionId, request.turnId);
					this.assertScopeCurrent(scope);
					return turn as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'attach': {
				const request = this.parseAttach(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				let reservationId: string | undefined;
				let latestObservedSequence = request.afterSequence ?? 0;
				let result: AgentSessionAttachResult | undefined;
				try {
					const reservedId = this.reserveAttachment(sender, projectId, request.sessionId, request.turnId);
					reservationId = reservedId;
					result = await this.requireService().attach(projectId, request.sessionId, request.turnId, chunk => {
						latestObservedSequence = Math.max(latestObservedSequence, chunk.sequence);
						const active = result && this.attachments.get(result.attachmentId);
						if (active && this.isScopeCurrent(scope)) { this.sendAttachmentChunk(active, chunk); }
					}, request.afterSequence);
					if (!this.isScopeCurrent(scope)) {
						this.requireService().detach(projectId, request.sessionId, request.turnId, result.attachmentId);
						throw new Error('The project window changed while the output attachment was being created.');
					}
					this.trackAttachment(sender, projectId, request.sessionId, request.turnId, reservedId, result);
					reservationId = undefined;
					this.catchUpAttachment(result, latestObservedSequence);
					return result as T;
				} catch (error) {
					if (result && this.attachments.has(result.attachmentId)) { this.disconnectAttachment(sender, result.attachmentId); }
					throw error;
				} finally {
					if (reservationId) { this.releaseAttachmentReservation(reservationId); }
					this.finishScopedOperation(scope);
				}
			}
			case 'read': {
				const request = this.parseRead(arg, projectId);
				this.requireAttachment(sender, request);
				return this.requireService().read(projectId, request.sessionId, request.turnId, request.attachmentId, request.afterSequence, request.limit) as T;
			}
			case 'write': {
				const request = this.parseWrite(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					this.assertScopeCurrent(scope);
					if (request.text.length === 0) { return undefined as T; }
					await this.requireService().write(projectId, request.sessionId, request.turnId, request.text);
					this.assertScopeCurrent(scope);
					return undefined as T;
				}
				finally { this.finishScopedOperation(scope); }
			}
			case 'resize': {
				const request = this.parseResize(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try { this.assertScopeCurrent(scope); await this.requireService().resize(projectId, request.sessionId, request.turnId, request.cols, request.rows); this.assertScopeCurrent(scope); return undefined as T; }
				finally { this.finishScopedOperation(scope); }
			}
			case 'disconnect': {
				const request = this.parseDisconnect(arg, projectId);
				this.requireAttachment(sender, request);
				this.disconnectAttachment(sender, request.attachmentId);
				return undefined as T;
			}
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	private authorize(sender: WebContents): string { return this.authorizeScope(sender).projectId; }

	private authorizeScope(sender: WebContents): { readonly projectId: string; readonly descriptorUri: string } {
		if (!sender || typeof sender !== 'object' || sender.isDestroyed()) { throw new Error('A live IPC sender is required.'); }
		const window = this.windowsMainService.getWindowByWebContents(sender);
		if (!window?.config || window.config.reviewWindowLaunch.kind !== 'project') { throw new Error('This operation requires an open project window.'); }
		const projectId = window.config.reviewWindowLaunch.projectId;
		if (!isUUID(projectId) || !this.database.getProject(projectId)) { throw new Error('The project window has an invalid or unavailable project ID.'); }
		const view = this.database.getProjectView(projectId);
		const openedWorkspace = window.openedWorkspace;
		const descriptorUri = openedWorkspace && 'configPath' in openedWorkspace ? openedWorkspace.configPath.toString() : undefined;
		if (!view || !descriptorUri || descriptorUri !== view.descriptorUri) { throw new Error('The open workspace does not match this project.'); }
		return { projectId, descriptorUri };
	}

	private beginScopedOperation(sender: WebContents, expectedProjectId: string): ScopeToken {
		const authorized = this.authorizeScope(sender);
		if (authorized.projectId !== expectedProjectId) { throw new Error('The requested project does not match this window.'); }
		let scope = this.senderScopes.get(sender.id);
		if (!scope) {
			scope = { sender, generation: 0, pendingOperations: 0 };
			this.senderScopes.set(sender.id, scope);
		}
		if ((scope.projectId && scope.projectId !== authorized.projectId) || (scope.descriptorUri && scope.descriptorUri !== authorized.descriptorUri)) {
			this.invalidateSender(scope);
		}
		scope.projectId = authorized.projectId;
		scope.descriptorUri = authorized.descriptorUri;
		this.ensureSenderListeners(scope);
		scope.pendingOperations++;
		return { scope, generation: scope.generation, projectId: authorized.projectId, descriptorUri: authorized.descriptorUri };
	}

	private ensureSenderListeners(scope: SenderScope): void {
		if (scope.disposeListeners) { return; }
		const invalidate = () => this.invalidateSender(scope);
		scope.sender.once('destroyed', invalidate);
		scope.sender.on('did-start-loading', invalidate);
		scope.sender.on('render-process-gone', invalidate);
		scope.disposeListeners = () => {
			scope.sender.removeListener('destroyed', invalidate);
			scope.sender.removeListener('did-start-loading', invalidate);
			scope.sender.removeListener('render-process-gone', invalidate);
			scope.disposeListeners = undefined;
		};
	}

	private invalidateSender(scope: SenderScope): void {
		scope.generation++;
		scope.projectId = undefined;
		scope.descriptorUri = undefined;
		for (const [id, attachment] of this.attachments) {
			if (attachment.owner === scope.sender) { this.disconnectAttachment(scope.sender, id); }
		}
		for (const [id, reservation] of this.attachmentReservations) {
			if (reservation.owner === scope.sender) { this.releaseAttachmentReservation(id); }
		}
		this.cleanupSenderScope(scope);
	}

	private finishScopedOperation(token: ScopeToken): void {
		token.scope.pendingOperations = Math.max(0, token.scope.pendingOperations - 1);
		this.cleanupSenderScope(token.scope);
	}

	private cleanupSenderScope(scope: SenderScope): void {
		if (scope.pendingOperations !== 0 || [...this.attachments.values()].some(attachment => attachment.owner === scope.sender)) { return; }
		scope.disposeListeners?.();
		this.senderScopes.delete(scope.sender.id);
	}

	private isScopeCurrent(token: ScopeToken): boolean {
		if (token.scope.generation !== token.generation || token.scope.projectId !== token.projectId
			|| token.scope.descriptorUri !== token.descriptorUri || token.scope.sender.isDestroyed()) { return false; }
		try {
			const current = this.authorizeScope(token.scope.sender);
			return current.projectId === token.projectId && current.descriptorUri === token.descriptorUri;
		} catch { return false; }
	}

	private assertScopeCurrent(token: ScopeToken): void {
		if (!this.isScopeCurrent(token)) { throw new Error('The project window changed while the session operation was pending.'); }
	}

	private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

	private requireService(): AgentSessionService {
		if (!this.service) { throw new Error('Interactive AI sessions are unavailable because no trusted PTY backend is registered.'); }
		return this.service;
	}

	private requireWorkspacePreparationHook(hook: ((projectId: string, sessionId: string) => Promise<WorkspaceAgentSessionWorkspacePreparationDTO>) | undefined): (projectId: string, sessionId: string) => Promise<WorkspaceAgentSessionWorkspacePreparationDTO> {
		if (!hook) { throw new Error('Session workspace preparation is unavailable because no trusted worktree service is registered.'); }
		return hook;
	}

	private requireSession(projectId: string, sessionId: string): void {
		if (!this.database.agentSessions.getSession(projectId, sessionId)) { throw new Error('The session does not belong to this project.'); }
	}

	private reserveAttachment(sender: WebContents, projectId: string, sessionId: string, turnId: string): string {
		const owned = (item: { owner: WebContents }) => item.owner === sender;
		const sameTurn = (item: { owner: WebContents; projectId: string; sessionId: string; turnId: string }) =>
			item.owner === sender && item.projectId === projectId && item.sessionId === sessionId && item.turnId === turnId;
		const windowCount = [...this.attachments.values()].filter(owned).length + [...this.attachmentReservations.values()].filter(owned).length;
		const turnCount = [...this.attachments.values()].filter(sameTurn).length + [...this.attachmentReservations.values()].filter(sameTurn).length;
		if (windowCount >= MAX_ATTACHMENTS_PER_WINDOW) { throw new Error('The project window already has the maximum number of live output attachments.'); }
		if (turnCount >= MAX_ATTACHMENTS_PER_TURN) { throw new Error('The turn already has the maximum number of live output attachments.'); }
		const reservationId = randomUUID();
		this.attachmentReservations.set(reservationId, { owner: sender, projectId, sessionId, turnId });
		return reservationId;
	}

	private releaseAttachmentReservation(reservationId: string): void { this.attachmentReservations.delete(reservationId); }

	private trackAttachment(sender: WebContents, projectId: string, sessionId: string, turnId: string, reservationId: string, result: AgentSessionAttachResult): void {
		const attachmentId = result.attachmentId;
		this.attachments.set(attachmentId, { attachmentId, projectId, sessionId, turnId, owner: sender, lastSentSequence: result.initialPage.cursor });
		this.releaseAttachmentReservation(reservationId);
	}

	private sendAttachmentChunk(attachment: ScopedAttachment, chunk: WorkspaceAgentSessionOutputEvent['chunk']): void {
		if (chunk.sequence <= attachment.lastSentSequence) { return; }
		const event: WorkspaceAgentSessionOutputEvent = {
			attachmentId: attachment.attachmentId,
			projectId: attachment.projectId, sessionId: attachment.sessionId, turnId: attachment.turnId, chunk,
		};
		try {
			if (!attachment.owner.isDestroyed()) { attachment.owner.send(WORKSPACE_AGENT_SESSIONS_OUTPUT_EVENT, event); }
			attachment.lastSentSequence = chunk.sequence;
		} catch { this.disconnectAttachment(attachment.owner, event.attachmentId); }
	}

	private catchUpAttachment(result: AgentSessionAttachResult, latestObservedSequence: number): void {
		const attachment = this.attachments.get(result.attachmentId);
		if (!attachment || latestObservedSequence <= attachment.lastSentSequence) { return; }
		let sent = 0;
		while (attachment.lastSentSequence < latestObservedSequence && sent < MAX_CATCH_UP_CHUNKS) {
			const cursorBeforeRead = attachment.lastSentSequence;
			const page = this.requireService().read(attachment.projectId, attachment.sessionId, attachment.turnId, result.attachmentId, cursorBeforeRead, CATCH_UP_READ_PAGE_SIZE);
			if (page.retentionGap) {
				const nextSequence = page.chunks[0]?.sequence;
				const gapSequence = nextSequence ? nextSequence - 1 : Math.max(attachment.lastSentSequence + 1, Math.min(latestObservedSequence, page.latestSequence));
				this.sendAttachmentChunk(attachment, { sequence: gapSequence, text: '', gap: true });
			}
			if (page.chunks.length === 0) { break; }
			for (const chunk of page.chunks) {
				if (chunk.sequence > latestObservedSequence || sent >= MAX_CATCH_UP_CHUNKS) { break; }
				this.sendAttachmentChunk(attachment, chunk);
				sent++;
			}
			if (attachment.lastSentSequence <= cursorBeforeRead) { break; }
		}
		if (attachment.lastSentSequence < latestObservedSequence) {
			this.sendAttachmentChunk(attachment, { sequence: latestObservedSequence, text: '', gap: true });
		}
	}

	private disconnectAttachment(sender: WebContents, attachmentId: string): void {
		const attachment = this.attachments.get(attachmentId);
		if (!attachment || attachment.owner !== sender) { return; }
		this.attachments.delete(attachmentId);
		try { this.service?.detach(attachment.projectId, attachment.sessionId, attachment.turnId, attachmentId); }
		catch (error) { console.error('Failed to revoke a project session attachment.', error); }
		const scope = this.senderScopes.get(sender.id);
		if (scope) { this.cleanupSenderScope(scope); }
	}

	private requireAttachment(sender: WebContents, request: { projectId: string; sessionId: string; turnId: string; attachmentId: string }): void {
		const attachment = this.attachments.get(request.attachmentId);
		if (!attachment || attachment.owner !== sender || attachment.projectId !== request.projectId
			|| attachment.sessionId !== request.sessionId || attachment.turnId !== request.turnId) {
			throw new Error('The output attachment is not owned by this project window and turn.');
		}
	}

	private assertProjectRequest(value: unknown, projectId: string): void {
		const request = this.record(value);
		this.assertProjectId(request.projectId, projectId);
	}

	private parseCreate(value: unknown, projectId: string): CreateAgentSessionInput {
		const request = this.record(value);
		this.assertProjectId(request.projectId, projectId);
		this.uuid(request.bindingId, 'binding ID');
		if (request.taskId !== undefined) { this.uuid(request.taskId, 'task ID'); }
		if (request.parentSessionId !== undefined) { this.uuid(request.parentSessionId, 'parent session ID'); }
		this.string(request.name, 'session name', 200);
		if (request.provider !== 'codex' && request.provider !== 'claude') { throw new Error('The provider is invalid.'); }
		this.string(request.model, 'model', 200);
		if (request.profileRef !== undefined) { this.string(request.profileRef, 'profile reference', 512); }
		if (request.workspaceMode !== 'gitWorktree' && request.workspaceMode !== 'sharedFolder') { throw new Error('The workspace mode is invalid.'); }
		return request as unknown as CreateAgentSessionInput;
	}

	private parsePreview(value: unknown, projectId: string) {
		const request = this.parseSessionRequest(value, projectId);
		const raw = this.record(value);
		const policy = this.parsePolicy(raw.permissionPolicy);
		return { ...request, permissionPolicy: policy };
	}

	private parseTranscriptOptions(value: unknown): AgentSessionTranscriptPageOptions {
		const raw = value === undefined ? {} : this.record(value);
		if (raw.kind !== undefined && raw.kind !== 'terminal' && raw.kind !== 'log') { throw new Error('The transcript kind is invalid.'); }
		if (raw.severity !== undefined && (typeof raw.severity !== 'string' || !['debug', 'info', 'warning', 'error'].includes(raw.severity))) { throw new Error('The transcript severity is invalid.'); }
		if (raw.source !== undefined && (typeof raw.source !== 'string' || !['pty', 'provider', 'host', 'workspace'].includes(raw.source))) { throw new Error('The transcript source is invalid.'); }
		return {
			afterSequence: raw.afterSequence === undefined ? 0 : this.sequence(raw.afterSequence, 'transcript cursor'),
			limit: raw.limit === undefined ? 50 : this.integer(raw.limit, 1, 100, 'transcript page limit'),
			maxOutputBytes: raw.maxOutputBytes === undefined ? 512 * 1024 : this.integer(raw.maxOutputBytes, 256 * 1024, 2 * 1024 * 1024, 'transcript byte budget'),
			...(raw.kind !== undefined ? { kind: raw.kind as AgentSessionTranscriptPageOptions['kind'] } : {}),
			...(raw.severity !== undefined ? { severity: raw.severity as AgentSessionTranscriptPageOptions['severity'] } : {}),
			...(raw.source !== undefined ? { source: raw.source as AgentSessionTranscriptPageOptions['source'] } : {}),
		};
	}

	private parsePolicy(value: unknown): AgentSessionPermissionPolicy {
		const policy = this.record(value);
		if (!['read-only', 'mutating'].includes(String(policy.mode)) || !['never', 'on-request', 'always'].includes(String(policy.approval))) {
			throw new Error('The session permission policy is invalid.');
		}
		return { mode: policy.mode as AgentSessionPermissionPolicy['mode'], approval: policy.approval as AgentSessionPermissionPolicy['approval'] };
	}

	private parseStart(value: unknown, projectId: string) {
		const request = this.parseSessionRequest(value, projectId);
		const raw = this.record(value);
		return { ...request, ticketId: this.string(raw.ticketId, 'launch ticket', 64) };
	}

	private parseSessionRequest(value: unknown, projectId: string) {
		const request = this.record(value);
		this.assertProjectId(request.projectId, projectId);
		return { projectId, sessionId: this.uuid(request.sessionId, 'session ID') };
	}

	private parseTurnRequest(value: unknown, projectId: string) {
		const request = this.parseSessionRequest(value, projectId);
		const raw = this.record(value);
		return { ...request, turnId: this.uuid(raw.turnId, 'turn ID') };
	}

	private parseAttach(value: unknown, projectId: string) {
		const request = this.parseTurnRequest(value, projectId);
		const raw = this.record(value);
		return { ...request, afterSequence: raw.afterSequence === undefined ? 0 : this.sequence(raw.afterSequence, 'output cursor') };
	}

	private parseRead(value: unknown, projectId: string) {
		const request = this.parseTurnRequest(value, projectId);
		const raw = this.record(value);
		const limit = raw.limit === undefined ? undefined : this.integer(raw.limit, 1, MAX_READ_CHUNKS, 'read limit');
		return { ...request, attachmentId: this.string(raw.attachmentId, 'attachment ID', 64), afterSequence: this.sequence(raw.afterSequence, 'output cursor'), ...(limit === undefined ? {} : { limit }) };
	}

	private parseWrite(value: unknown, projectId: string) {
		const request = this.parseTurnRequest(value, projectId);
		const text = this.record(value).text;
		if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
			throw new Error('Terminal input must be text within the 64 KiB limit.');
		}
		return { ...request, text };
	}

	private parseResize(value: unknown, projectId: string) {
		const request = this.parseTurnRequest(value, projectId);
		const raw = this.record(value);
		return { ...request, cols: this.integer(raw.cols, 1, MAX_DIMENSION, 'terminal columns'), rows: this.integer(raw.rows, 1, MAX_DIMENSION, 'terminal rows') };
	}

	private parseDisconnect(value: unknown, projectId: string) {
		const request = this.parseTurnRequest(value, projectId);
		return { ...request, attachmentId: this.string(this.record(value).attachmentId, 'attachment ID', 64) };
	}

	private assertProjectId(value: unknown, authorizedProjectId: string): void {
		if (this.uuid(value, 'project ID') !== authorizedProjectId) { throw new Error('The requested project does not match this window.'); }
	}

	private record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('A structured session request is required.'); }
		return value as Record<string, unknown>;
	}

	private uuid(value: unknown, label: string): string {
		if (typeof value !== 'string' || !isUUID(value)) { throw new Error(`A valid ${label} is required.`); }
		return value;
	}

	private string(value: unknown, label: string, maxBytes: number): string {
		if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes) { throw new Error(`The ${label} is invalid or exceeds its size limit.`); }
		return value;
	}

	private integer(value: unknown, minimum: number, maximum: number, label: string): number {
		if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) { throw new Error(`The ${label} is outside its allowed range.`); }
		return value as number;
	}

	private sequence(value: unknown, label: string): number { return this.integer(value, 0, MAX_SEQUENCE, label); }
}

function projectMailboxMessage(message: SessionMessageDTO): WorkspaceAgentSessionMailboxMessage {
	return {
		id: message.id, senderSessionId: message.senderSessionId, recipientSessionId: message.recipientSessionId,
		sequence: message.sequence, body: message.body, createdAt: message.createdAt, readAt: message.readAt,
	};
}
