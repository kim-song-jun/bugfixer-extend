import type { WebContents } from 'electron';
import { isUUID } from '../../base/common/uuid.js';
import type { AgentSessionControlRequestDTO, AgentSessionControlRequestState } from '../common/workspaceAgentSessionControlProtocol.js';
import type { AgentSessionTurnDTO } from '../common/workspaceAgentSessionProtocol.js';
import type { AgentSessionControlApplication } from './agentSessions/agentSessionControlApplication.js';
import type { AgentSessionLaunchPreview } from './agentSessions/agentSessionService.js';
import type { WorkspaceDatabase } from './workspaceDatabase.js';

export interface WorkspaceAgentControlHost {
	readonly application: AgentSessionControlApplication;
	confirmStart(sender: WebContents, request: AgentSessionControlRequestDTO, preview: AgentSessionLaunchPreview): Promise<boolean>;
	stopStartedTurn(projectId: string, sessionId: string, turnId: string): Promise<AgentSessionTurnDTO>;
}

export const WORKSPACE_AGENT_CONTROL_COMMANDS: ReadonlySet<string> = new Set([
	'listControlRequests', 'getControlRequest', 'previewControlStart', 'startControlRequest', 'rejectControlRequest', 'cancelControlRequest',
]);

/** Only an authenticated project window can reach this dispatcher; MCP has no approval endpoint. */
export async function dispatchWorkspaceAgentControlRequest(
	host: WorkspaceAgentControlHost, database: WorkspaceDatabase, sender: WebContents, command: string,
	arg: unknown, projectId: string, assertCurrent: () => void,
): Promise<unknown> {
	assertCurrent();
	const input = record(arg);
	if (input.projectId !== projectId) { throw new Error('The control request belongs to another project window.'); }
	if (command === 'listControlRequests') {
		exact(input, ['projectId', 'afterCreatedAt', 'afterId', 'limit', 'state']);
		const states: readonly string[] = ['pendingReview', 'starting', 'started', 'startFailed', 'rejected', 'cancelled', 'interrupted', 'stopAccepted', 'stopCompleted', 'stopUnverified', 'stopFailed'];
		if (input.state !== undefined && (typeof input.state !== 'string' || !states.includes(input.state))) { throw new Error('The request state filter is invalid.'); }
		const limit = input.limit === undefined ? 20 : integer(input.limit, 1, 50);
		const rows = database.agentSessionControlRequests.list(projectId, {
			afterCreatedAt: input.afterCreatedAt === undefined ? undefined : text(input.afterCreatedAt, 40),
			afterId: input.afterId === undefined ? undefined : uuid(input.afterId),
			limit: limit + 1, state: input.state as AgentSessionControlRequestState | undefined,
		});
		const requests = rows.slice(0, limit);
		const last = requests.at(-1);
		return { requests, hasMore: rows.length > limit, nextCursor: last ? { createdAt: last.createdAt, id: last.id } : null, hostError: host.application.getHostError() };
	}
	const requestId = uuid(input.requestId);
	const request = database.agentSessionControlRequests.get(projectId, requestId);
	if (!request) { throw new Error('The control request does not belong to this project.'); }
	switch (command) {
		case 'getControlRequest':
			exact(input, ['projectId', 'requestId']);
			return request;
		case 'previewControlStart': {
			exact(input, ['projectId', 'requestId']);
			const preview = await host.application.previewStart(projectId, requestId);
			assertCurrent();
			return preview;
		}
		case 'startControlRequest': {
			exact(input, ['projectId', 'requestId', 'expectedRevision', 'ticketId', 'idempotencyKey']);
			const revision = integer(input.expectedRevision, 1);
			const ticketId = uuid(input.ticketId);
			const key = text(input.idempotencyKey, 128);
			const review = host.application.readStartReview(projectId, requestId, revision, ticketId);
			if (!await host.confirmStart(sender, review.request, review.preview)) { assertCurrent(); return request; }
			assertCurrent();
			const result = await host.application.startReviewed(projectId, requestId, revision, ticketId, key);
			try { assertCurrent(); }
			catch (scopeError) {
				if (result.resultTurnId) {
					const stopped = await host.stopStartedTurn(projectId, result.targetSessionId, result.resultTurnId);
					if (stopped.id !== result.resultTurnId || stopped.projectId !== projectId || stopped.sessionId !== result.targetSessionId || !stopped.cleanupVerified) {
						throw new Error('The project window changed after approval and exact-turn cleanup could not be verified.');
					}
				}
				throw scopeError;
			}
			return result;
		}
		case 'rejectControlRequest':
		case 'cancelControlRequest': {
			exact(input, ['projectId', 'requestId', 'expectedRevision', 'idempotencyKey']);
			const revision = integer(input.expectedRevision, 1);
			const key = text(input.idempotencyKey, 128);
			assertCurrent();
			return command === 'rejectControlRequest'
				? database.agentSessionControlRequests.rejectPending(requestId, revision, key)
				: database.agentSessionControlRequests.cancelPending(requestId, revision, key);
		}
		default: throw new Error('Unknown session control request command.');
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > 16_384) { throw new Error('The control request payload is invalid or too large.'); }
	return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).some(key => !keys.includes(key))) { throw new Error('Unexpected session control request field.'); }
}
function uuid(value: unknown): string {
	if (typeof value !== 'string' || !isUUID(value)) { throw new Error('A control request identifier is invalid.'); }
	return value;
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) { throw new Error('The control request revision or limit is invalid.'); }
	return value;
}
function text(value: unknown, maximumBytes: number): string {
	if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximumBytes || /[\u0000-\u001f\u007f]/u.test(value)) { throw new Error('The control request text is invalid.'); }
	return value;
}
