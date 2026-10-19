/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentPrTextScope } from '../common/workspaceAgentPrTextProtocol.js';
import type {
	IWorkspaceAgentPrTextService, WorkspaceAgentPrTextPreviewDTO, WorkspaceAgentPrTextPreviewInput, WorkspaceAgentPrTextStartInput,
	WorkspaceAgentPrTextSaveInput, WorkspaceAgentPrTextApplyInput,
} from '../common/workspaceAgentPrTextHostProtocol.js';
import { AGENT_PR_TEXT_MAX_BODY_BYTES, type AgentPrTextRequestDTO, type AgentPrTextRevisionDTO } from '../common/workspaceAgentPrTextProtocol.js';
import type { WorkspaceDatabase } from './workspaceDatabase.js';

type MaybeAsyncService = {
	[K in keyof IWorkspaceAgentPrTextService]: (...args: Parameters<IWorkspaceAgentPrTextService[K]>) => ReturnType<IWorkspaceAgentPrTextService[K]> | Awaited<ReturnType<IWorkspaceAgentPrTextService[K]>>;
};

export type WorkspaceAgentPrTextHost = Omit<MaybeAsyncService, 'previewPrTextRequest' | 'startPrTextRequest' | 'savePrTextRevision' | 'applyPrTextCandidate'> & {
	previewPrTextRequest(input: WorkspaceAgentPrTextPreviewInput, assertCurrent?: () => void): Promise<WorkspaceAgentPrTextPreviewDTO>;
	startPrTextRequest(input: WorkspaceAgentPrTextStartInput, assertCurrent?: () => void): Promise<AgentPrTextRequestDTO>;
	savePrTextRevision(input: WorkspaceAgentPrTextSaveInput, assertCurrent?: () => void): Promise<AgentPrTextRevisionDTO>;
	applyPrTextCandidate(input: WorkspaceAgentPrTextApplyInput, assertCurrent?: () => void): Promise<AgentPrTextRevisionDTO>;
};

export const WORKSPACE_AGENT_PR_TEXT_COMMANDS: ReadonlySet<string> = new Set([
	'getPrTextDraft', 'listPrTextRevisions', 'listPrTextRequests', 'savePrTextRevision',
	'previewPrTextRequest', 'startPrTextRequest', 'getPrTextRequest', 'cancelPrTextRequest',
	'applyPrTextCandidate',
]);

/** Strict native request parsing. An author, model, account or provider receipt is never accepted here. */
export async function dispatchWorkspaceAgentPrTextRequest(
	host: WorkspaceAgentPrTextHost, database: WorkspaceDatabase, command: string, arg: unknown,
	projectId: string, assertCurrent: () => void,
): Promise<unknown> {
	assertCurrent();
	const value = record(arg);
	const scope = parseScope(command === 'getPrTextDraft' ? value : value.scope, projectId, database);
	let result: unknown;
	switch (command) {
		case 'getPrTextDraft':
			result = await host.getPrTextDraft(scope);
			break;
		case 'listPrTextRevisions':
		case 'listPrTextRequests': {
			exact(value, ['scope', 'after', 'limit']);
			const input = { scope, after: integer(value.after, 0), limit: integer(value.limit, 1, 20) };
			result = command === 'listPrTextRevisions' ? await host.listPrTextRevisions(input) : await host.listPrTextRequests(input);
			break;
		}
		case 'savePrTextRevision':
			exact(value, ['scope', 'expectedRevision', 'idempotencyKey', 'title', 'body']);
			result = await host.savePrTextRevision({ scope, expectedRevision: integer(value.expectedRevision, 1),
				idempotencyKey: text(value.idempotencyKey, 128, false), title: text(value.title, 256, false), body: text(value.body, AGENT_PR_TEXT_MAX_BODY_BYTES) }, assertCurrent);
			break;
		case 'previewPrTextRequest':
			exact(value, ['scope', 'baseRevision', 'idempotencyKey', 'instruction']);
			result = await host.previewPrTextRequest({ scope, baseRevision: integer(value.baseRevision, 0),
				idempotencyKey: text(value.idempotencyKey, 128, false), instruction: text(value.instruction, 8192, false) }, assertCurrent);
			break;
		case 'startPrTextRequest':
			exact(value, ['scope', 'requestId', 'expectedStateRevision', 'expectedDigest']);
			result = await host.startPrTextRequest({ scope, requestId: uuid(value.requestId), expectedStateRevision: integer(value.expectedStateRevision, 0),
				expectedDigest: sha256(value.expectedDigest) }, assertCurrent);
			break;
		case 'getPrTextRequest':
			exact(value, ['scope', 'requestId']);
			result = await host.getPrTextRequest({ scope, requestId: uuid(value.requestId) });
			break;
		case 'cancelPrTextRequest':
			exact(value, ['scope', 'requestId', 'expectedStateRevision']);
			result = await host.cancelPrTextRequest({ scope, requestId: uuid(value.requestId), expectedStateRevision: integer(value.expectedStateRevision, 0) });
			break;
		case 'applyPrTextCandidate':
			exact(value, ['scope', 'requestId', 'expectedStateRevision', 'expectedHeadRevision', 'idempotencyKey']);
			result = await host.applyPrTextCandidate({ scope, requestId: uuid(value.requestId), expectedStateRevision: integer(value.expectedStateRevision, 0),
				expectedHeadRevision: integer(value.expectedHeadRevision, 0), idempotencyKey: text(value.idempotencyKey, 128, false) }, assertCurrent);
			break;
		default: throw new Error('Unsupported PR text command.');
	}
	assertCurrent();
	return result;
}

function parseScope(input: unknown, projectId: string, database: WorkspaceDatabase): AgentPrTextScope {
	const value = record(input); exact(value, ['projectId', 'sessionId', 'targetTurnId']);
	const scope = { projectId: uuid(value.projectId), sessionId: uuid(value.sessionId), targetTurnId: uuid(value.targetTurnId) };
	if (scope.projectId !== projectId || !database.agentSessionTurns.getTurn(scope.projectId, scope.sessionId, scope.targetTurnId)) {
		throw new Error('PR text scope is unavailable in this project window.');
	}
	return scope;
}

function record(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) { throw new Error('PR text request must be an object.'); }
	return input as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
	if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) { throw new Error('PR text request contains missing or unknown fields.'); }
}

function integer(input: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(input) || (input as number) < minimum || (input as number) > maximum) { throw new Error('PR text request has an invalid integer.'); }
	return input as number;
}

function text(input: unknown, maximum: number, empty = true): string {
	if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > maximum || input.includes('\0') || (!empty && !input.trim())) { throw new Error('PR text request has invalid or oversized text.'); }
	return input;
}

function uuid(input: unknown): string {
	if (typeof input !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input)) { throw new Error('PR text request has an invalid ID.'); }
	return input;
}

function sha256(input: unknown): string {
	if (typeof input !== 'string' || !/^[0-9a-f]{64}$/u.test(input)) { throw new Error('PR text request has an invalid digest.'); }
	return input;
}
