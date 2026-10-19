/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { AgentSessionPermissionPolicy } from '../../common/workspaceAgentSessionProtocol.js';
import type { AgentPrTextRevisionDTO } from '../../common/workspaceAgentPrTextProtocol.js';
import type { AgentSessionExplanationCitation, AgentSessionReportedCheck, AgentSessionExplanationTarget } from './agentSessionReviewStore.js';
import { computeAgentSessionChangeHunks } from './agentSessionChangeHunks.js';
import { sanitizeCompleteAgentText } from './agentOutputRedactor.js';
import { readAgentSessionMcpLogs } from './agentSessionMcpLogs.js';
import { AgentSessionCollaborationService, type AgentSessionCollaborationGrant } from './agentSessionCollaborationService.js';
import { AgentSessionPreparationError, type AgentSessionPreparationRecovery } from './agentSessionPreparationError.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';

export const AGENT_SESSION_MCP_GATEWAY_MODULE = 'agentSessionMcpGateway.mjs';
export const AGENT_SESSION_MCP_TOKEN_ENV = 'BUGFIXER_SESSION_MCP_TOKEN';

export type AgentSessionReviewDatabase = Pick<WorkspaceDatabase, 'agentSessionTurns' | 'agentSessionChangeEvidence' | 'agentSessionContents' | 'agentSessionReviews' | 'agentSessionPrTexts'>;

const MAX_FRAME_BYTES = 65_536;
const MAX_CONNECTIONS = 8;
const MAX_IN_FLIGHT_PER_CONNECTION = 8;
const AUTH_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AgentSessionMcpAccessInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly permissionPolicy: AgentSessionPermissionPolicy;
	readonly knownSecrets?: readonly string[];
}

export interface AgentSessionMcpAccess {
	/** Ephemeral loopback port is a nonsecret gateway argument; only the capability is an environment value. */
	readonly port: number;
	/** The token is forwarded to the app-owned gateway through the launch's allowlisted environment only. */
	readonly gatewayEnvironment: Readonly<Record<string, string>>;
	readonly knownSecrets: readonly string[];
	/** Idempotent synchronous deny, socket destruction, and wait cancellation. */
	revokeAccess(): void;
	/** Awaits this grant's loopback listener and connections closing after revokeAccess. */
	releasePrivateConfig(): Promise<void>;
}

type AgentSessionMcpServerFactory = (listener: (socket: Socket) => void) => Server;

interface ActiveRequest {
	readonly controller: AbortController;
}

/** Main-process capability broker. It owns a scoped loopback listener and no provider process handles. */
export class AgentSessionMcpBridge {
	constructor(
		private readonly collaboration: AgentSessionCollaborationService,
		private readonly serverFactory: AgentSessionMcpServerFactory = listener => createServer(listener),
		private readonly reviewDatabase?: AgentSessionReviewDatabase,
	) { }

	async issueAccess(input: AgentSessionMcpAccessInput): Promise<AgentSessionMcpAccess> {
		assertUuid(input.projectId, 'project ID');
		assertUuid(input.sessionId, 'session ID');
		assertUuid(input.turnId, 'turn ID');
		if (input.knownSecrets !== undefined && (!Array.isArray(input.knownSecrets) || input.knownSecrets.some(secret => typeof secret !== 'string'))) {
			throw new Error('Trusted launch secrets must be strings.');
		}
		const token = randomBytes(32).toString('base64url');
		const grant = this.collaboration.authorizeTurn({
			projectId: input.projectId,
			sessionId: input.sessionId,
			turnId: input.turnId,
			permissionPolicy: input.permissionPolicy,
			knownSecrets: [...(input.knownSecrets ?? []), token],
		});
		const tokenDigest = createHash('sha256').update(token, 'utf8').digest();
		let active = true;
		let grantRevoked = false;
		let serverClosed = false;
		let closePromise: Promise<void> | undefined;
		const sockets = new Set<Socket>();
		const knownSecrets = Object.freeze([...new Set([...(input.knownSecrets ?? []), token].filter(Boolean))]);
		let port: number | undefined;
		let server: Server | undefined;
		let asynchronousServerFailure: unknown;
		const revokeAccess = () => {
			active = false;
			const failures: unknown[] = [];
			if (!grantRevoked) {
				try { this.collaboration.revoke(grant); grantRevoked = true; } catch (error) { failures.push(error); }
			}
			for (const socket of sockets) {
				try { socket.destroy(); } catch (error) { failures.push(error); }
			}
			sockets.clear();
			if (asynchronousServerFailure !== undefined) {
				failures.push(asynchronousServerFailure);
				asynchronousServerFailure = undefined;
			}
			if (failures.length) { throw new AggregateError(failures, 'Session MCP access revocation could not be verified.'); }
		};
		const cleanupOwnedResources = async () => {
			const failures: unknown[] = [];
			if (server && !serverClosed) {
				closePromise ??= closeServer(server);
				try { await closePromise; serverClosed = true; }
				catch (error) { closePromise = undefined; failures.push(error); }
			}
			if (failures.length) { throw new AggregateError(failures, 'Session MCP listener resources could not be released.'); }
		};
		const releasePrivateConfig = async () => {
			if (!grantRevoked) { throw new Error('Session MCP access must be revoked before private configuration is released.'); }
			await cleanupOwnedResources();
		};
		try {
			server = this.serverFactory(socket => acceptSocket(socket, grant, tokenDigest, this.collaboration, this.reviewDatabase, knownSecrets, sockets, () => active));
			server.maxConnections = MAX_CONNECTIONS;
			server.on('error', error => {
				if (!active) { return; }
				try { revokeAccess(); } catch (revokeError) { asynchronousServerFailure = new AggregateError([error, revokeError], 'Session MCP server failed and access revocation needs retry.'); }
			});
			await listen(server);
			const address = server.address();
			if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port < 1 || address.port > 65_535) {
				throw new Error('Session MCP bridge did not bind an ephemeral loopback port.');
			}
			port = address.port;
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			try { revokeAccess(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
			try { await cleanupOwnedResources(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
			if (cleanupErrors.length) {
				const recovery: AgentSessionPreparationRecovery = { revokeAccess, releasePrivateConfig };
				throw new AgentSessionPreparationError(
					new AggregateError([error, ...cleanupErrors], 'Session MCP launch setup failed and its private resources could not be fully released.').message,
					false,
					recovery,
				);
			}
			throw new AgentSessionPreparationError(error instanceof Error ? error.message : String(error), true);
		}
		return Object.freeze({
			port: port!,
			gatewayEnvironment: Object.freeze({ [AGENT_SESSION_MCP_TOKEN_ENV]: token }),
			knownSecrets,
			revokeAccess,
			releasePrivateConfig,
		});
	}
}

function acceptSocket(
	socket: Socket,
	grant: AgentSessionCollaborationGrant,
	expectedDigest: Buffer,
	collaboration: AgentSessionCollaborationService,
	reviewDatabase: AgentSessionReviewDatabase | undefined,
	knownSecrets: readonly string[],
	sockets: Set<Socket>,
	isActive: () => boolean,
): void {
	if (!isActive() || sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
	sockets.add(socket);
	socket.setNoDelay(true);
	let buffer = Buffer.alloc(0);
	let authenticated = false;
	let closed = false;
	const requests = new Map<string, ActiveRequest>();
	const authTimer = setTimeout(() => { if (!authenticated) { socket.destroy(); } }, AUTH_TIMEOUT_MS);
	socket.on('close', () => {
		closed = true;
		clearTimeout(authTimer);
		sockets.delete(socket);
		for (const request of requests.values()) { request.controller.abort(); }
		requests.clear();
	});
	socket.on('error', () => { /* The close event owns request cancellation and cleanup. */ });
	socket.on('data', chunk => {
		if (closed || !isActive()) { socket.destroy(); return; }
		buffer = Buffer.concat([buffer, chunk]);
		if (buffer.length > MAX_FRAME_BYTES && buffer.indexOf(0x0a) < 0) { socket.destroy(); return; }
		let newline: number;
		while ((newline = buffer.indexOf(0x0a)) >= 0) {
			const frame = buffer.subarray(0, newline);
			buffer = buffer.subarray(newline + 1);
			if (frame.length === 0 || frame.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
			let parsed: unknown;
			try { parsed = JSON.parse(frame.toString('utf8')); } catch { socket.destroy(); return; }
			if (!authenticated) {
				if (!isAuthFrame(parsed, expectedDigest)) { socket.destroy(); return; }
				authenticated = true;
				clearTimeout(authTimer);
				writeFrame(socket, { type: 'auth', ok: true });
				continue;
			}
			if (isCancelFrame(parsed)) {
				requests.get(parsed.id)?.controller.abort();
				requests.delete(parsed.id);
				continue;
			}
			if (!isRequestFrame(parsed) || requests.size >= MAX_IN_FLIGHT_PER_CONNECTION || requests.has(parsed.id)) { socket.destroy(); return; }
			const controller = new AbortController();
			requests.set(parsed.id, { controller });
			void dispatch(collaboration, grant, parsed.method, parsed.params, controller.signal, reviewDatabase, knownSecrets, isActive).then(
				result => {
					if (!isActive() || closed) { return; }
					requests.delete(parsed.id);
					writeFrame(socket, { type: 'response', id: parsed.id, result });
				},
				error => {
					if (!isActive() || closed) { return; }
					requests.delete(parsed.id);
					writeFrame(socket, { type: 'response', id: parsed.id, error: safeError(error, knownSecrets) });
				},
			);
		}
		if (buffer.length > MAX_FRAME_BYTES) { socket.destroy(); }
	});
}

function isAuthFrame(value: unknown, expectedDigest: Buffer): boolean {
	if (!value || typeof value !== 'object') { return false; }
	const frame = value as { type?: unknown; token?: unknown };
	if (frame.type !== 'auth' || typeof frame.token !== 'string' || frame.token.length > 256) { return false; }
	const actualDigest = createHash('sha256').update(frame.token, 'utf8').digest();
	return timingSafeEqual(actualDigest, expectedDigest);
}

function isRequestFrame(value: unknown): value is { type: 'request'; id: string; method: string; params: Record<string, unknown> } {
	if (!value || typeof value !== 'object') { return false; }
	const frame = value as Record<string, unknown>;
	return frame.type === 'request' && typeof frame.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(frame.id)
		&& typeof frame.method === 'string' && frame.method.length <= 64
		&& !!frame.params && typeof frame.params === 'object' && !Array.isArray(frame.params);
}

function isCancelFrame(value: unknown): value is { type: 'cancel'; id: string } {
	if (!value || typeof value !== 'object') { return false; }
	const frame = value as Record<string, unknown>;
	return frame.type === 'cancel' && typeof frame.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(frame.id);
}

async function dispatch(
	collaboration: AgentSessionCollaborationService,
	grant: AgentSessionCollaborationGrant,
	method: string,
	params: Record<string, unknown>,
	signal: AbortSignal,
	reviewDatabase: AgentSessionReviewDatabase | undefined,
	knownSecrets: readonly string[],
	isActive: () => boolean,
): Promise<unknown> {
	switch (method) {
		case 'sessions.requestStart': {
			assertAllowedKeys(params, ['targetSessionId', 'expectedSessionRevision', 'permissionMode', 'approval', 'reason', 'idempotencyKey']);
			if (params.permissionMode !== 'read-only' && params.permissionMode !== 'mutating') { throw new Error('The requested permission mode is invalid.'); }
			if (params.approval !== 'never' && params.approval !== 'on-request' && params.approval !== 'always') { throw new Error('The requested approval policy is invalid.'); }
			return collaboration.requestStart(grant, {
				targetSessionId: requiredUuid(params.targetSessionId, 'targetSessionId'), expectedSessionRevision: requiredInteger(params.expectedSessionRevision, 'expectedSessionRevision'),
				permissionPolicy: { mode: params.permissionMode, approval: params.approval },
				reason: requiredString(params.reason, 'reason'), idempotencyKey: requiredString(params.idempotencyKey, 'idempotencyKey'),
			});
		}
		case 'sessions.stop':
			assertAllowedKeys(params, ['targetSessionId', 'targetTurnId', 'idempotencyKey']);
			return collaboration.requestStop(grant, {
				targetSessionId: requiredUuid(params.targetSessionId, 'targetSessionId'), targetTurnId: requiredUuid(params.targetTurnId, 'targetTurnId'),
				idempotencyKey: requiredString(params.idempotencyKey, 'idempotencyKey'),
			});
		case 'sessionRequests.get':
			assertAllowedKeys(params, ['requestId']);
			return collaboration.getOwnControlRequest(grant, requiredUuid(params.requestId, 'requestId'));
		case 'sessions.list':
			assertAllowedKeys(params, ['afterSessionId', 'limit']);
			return collaboration.listSessionPage(grant, { afterSessionId: params.afterSessionId === undefined ? undefined : requiredUuid(params.afterSessionId, 'afterSessionId'), limit: optionalInteger(params.limit, 50) });
		case 'logs.read': {
			assertAllowedKeys(params, ['targetTurnId', 'afterSequence', 'limit', 'maxCharacters', 'kind', 'severity', 'source', 'cursor']);
			const targetTurnId = requiredUuid(params.targetTurnId, 'targetTurnId');
			if (params.kind !== undefined && (typeof params.kind !== 'string' || !['terminal', 'log'].includes(params.kind))) { throw new Error('Transcript kind filter is invalid.'); }
			if (params.severity !== undefined && (typeof params.severity !== 'string' || !['debug', 'info', 'warning', 'error'].includes(params.severity))) { throw new Error('Transcript severity filter is invalid.'); }
			if (params.source !== undefined && (typeof params.source !== 'string' || !['pty', 'provider', 'host', 'workspace'].includes(params.source))) { throw new Error('Transcript source filter is invalid.'); }
			const authorizeRead = () => {
				if (!isActive() || signal.aborted) { throw new Error('The session collaboration capability is revoked, invalid, or cancelled.'); }
				collaboration.listSessions(grant, 1);
			};
			return readAgentSessionMcpLogs((_afterSequence, options) => {
				authorizeRead();
				return collaboration.readTranscriptPage(grant, targetTurnId, options);
			}, {
				projectId: grant.projectId, sessionId: grant.sessionId, turnId: targetTurnId,
				afterSequence: params.afterSequence === undefined ? undefined : requiredInteger(params.afterSequence, 'afterSequence'),
				limit: optionalInteger(params.limit, 20), maxCharacters: optionalInteger(params.maxCharacters, 1_000),
				kind: params.kind as 'terminal' | 'log' | undefined, severity: params.severity as 'debug' | 'info' | 'warning' | 'error' | undefined,
				source: params.source as 'pty' | 'provider' | 'host' | 'workspace' | undefined,
				cursor: params.cursor === undefined ? undefined : requiredString(params.cursor, 'cursor'),
			}, knownSecrets, authorizeRead);
		}
		case 'messages.send':
			assertAllowedKeys(params, ['recipientSessionId', 'idempotencyKey', 'body']);
			return { message: collaboration.sendMessage(grant, {
				recipientSessionId: requiredString(params.recipientSessionId, 'recipientSessionId'),
				idempotencyKey: requiredString(params.idempotencyKey, 'idempotencyKey'),
				body: requiredString(params.body, 'body'),
			}) };
		case 'messages.list':
			assertAllowedKeys(params, ['afterSequence', 'limit']);
			return collaboration.listMessages(grant, { afterSequence: optionalInteger(params.afterSequence, 0), limit: optionalInteger(params.limit, 50) });
		case 'messages.ack':
			assertAllowedKeys(params, ['messageId']);
			collaboration.acknowledgeMessage(grant, requiredString(params.messageId, 'messageId'));
			return { acknowledged: true };
		case 'messages.wait':
			assertAllowedKeys(params, ['afterSequence', 'limit', 'timeoutMs']);
			return collaboration.waitForMessages(grant, {
				afterSequence: optionalInteger(params.afterSequence, 0),
				limit: optionalInteger(params.limit, 50),
				timeoutMs: optionalInteger(params.timeoutMs, 20_000),
			}, signal);
		case 'workflows.status':
			assertAllowedKeys(params, ['workflowId']);
			return collaboration.getWorkflowStatus(grant, requiredString(params.workflowId, 'workflowId'));
		case 'workflows.cancel':
			assertAllowedKeys(params, ['workflowId', 'expectedRevision', 'idempotencyKey']);
			return collaboration.cancelWorkflow(grant, {
				workflowId: requiredString(params.workflowId, 'workflowId'),
				expectedRevision: requiredInteger(params.expectedRevision, 'expectedRevision'),
				idempotencyKey: requiredString(params.idempotencyKey, 'idempotencyKey'),
			});
		case 'pr.get': {
			assertAllowedKeys(params, ['targetTurnId', 'revision', 'afterCharacter', 'maxCharacters']);
			const database = requireReviewDatabase(reviewDatabase);
			const targetTurnId = requiredUuid(params.targetTurnId, 'targetTurnId');
			requireScopedTargetTurn(collaboration, grant, database, targetTurnId, isActive, signal);
			const scope = { projectId: grant.projectId, sessionId: grant.sessionId, targetTurnId };
			const revision = params.revision === undefined ? database.agentSessionPrTexts.getHead(scope)
				: database.agentSessionPrTexts.getRevision(scope, requiredInteger(params.revision, 'revision'));
			if (!revision) { return { revision: null }; }
			const after = optionalInteger(params.afterCharacter, 0);
			const limit = optionalInteger(params.maxCharacters, 1000);
			const safeBody = sanitizeCompleteAgentText(revision.content.body, { knownSecrets });
			const characters = [...safeBody];
			if (after < 0 || after > characters.length || limit < 1 || limit > 1000) { throw new Error('PR text body read bounds are invalid.'); }
			const nextCharacter = Math.min(after + limit, characters.length);
			return boundedReviewResult({ revision: prTextMetadata(revision), bodyFragment: characters.slice(after, nextCharacter).join(''),
				...(safeBody === revision.content.body ? {} : { redactionApplied: true }),
				afterCharacter: after, nextCharacter, totalCharacters: characters.length, hasMore: nextCharacter < characters.length }, knownSecrets);
		}
		case 'pr.list': {
			assertAllowedKeys(params, ['targetTurnId', 'afterRevision', 'limit']);
			const database = requireReviewDatabase(reviewDatabase);
			const targetTurnId = requiredUuid(params.targetTurnId, 'targetTurnId');
			requireScopedTargetTurn(collaboration, grant, database, targetTurnId, isActive, signal);
			const scope = { projectId: grant.projectId, sessionId: grant.sessionId, targetTurnId };
			const limit = optionalInteger(params.limit, 1);
			if (limit < 1 || limit > 5) { throw new Error('PR text history page limit is invalid.'); }
			const page = database.agentSessionPrTexts.listRevisions(scope, {
				afterRevision: optionalInteger(params.afterRevision, 0), limit: optionalInteger(params.limit, 1),
			});
			return boundedReviewResult({ ...page, revisions: page.revisions.map(prTextMetadata) }, knownSecrets);
		}
		case 'pr.prepare': {
			assertAllowedKeys(params, ['targetTurnId', 'expectedRevision', 'idempotencyKey', 'title', 'body']);
			const database = requireReviewDatabase(reviewDatabase);
			const targetTurnId = requiredUuid(params.targetTurnId, 'targetTurnId');
			const expectedRevision = requiredInteger(params.expectedRevision, 'expectedRevision');
			const idempotencyKey = requiredString(params.idempotencyKey, 'idempotencyKey');
			const title = requiredString(params.title, 'title');
			const body = requiredString(params.body, 'body');
			// No await may separate the live-grant check from the synchronous text-only CAS.
			requireScopedTargetTurn(collaboration, grant, database, targetTurnId, isActive, signal);
			const revision = database.agentSessionPrTexts.appendGeneratedRevision({
				scope: { projectId: grant.projectId, sessionId: grant.sessionId, targetTurnId },
				expectedRevision, idempotencyKey, source: { kind: 'liveAgentTurn', turnId: grant.turnId },
				sanitizedCompleteAgentText: { title, body }, knownSecrets,
			});
			return boundedReviewResult({ revision: prTextMetadata(revision) }, knownSecrets);
		}
		case 'changes.get': {
			assertAllowedKeys(params, ['turnId', 'evidenceVersion', 'path']);
			const database = requireReviewDatabase(reviewDatabase);
			const turnId = requiredUuid(params.turnId, 'turnId');
			const evidenceVersion = requiredInteger(params.evidenceVersion, 'evidenceVersion');
			const path = requiredString(params.path, 'path');
			requireScopedTargetTurn(collaboration, grant, database, turnId, isActive, signal);
			const evidence = database.agentSessionChangeEvidence.listVersions(grant.projectId, grant.sessionId, turnId, { afterVersion: evidenceVersion - 1, limit: 1 }).snapshots.find(item => item.version === evidenceVersion);
			if (!evidence) { throw new Error('The requested change evidence version is unavailable in this session.'); }
			if (!evidence.files.some(file => file.path === path)) { throw new Error('The requested file is not part of this change evidence version.'); }
			const file = database.agentSessionContents.getFile({ scope: { projectId: grant.projectId, sessionId: grant.sessionId, turnId }, evidenceVersion, path });
			if (!file || file.evidenceFingerprint !== evidence.fingerprint) { throw new Error('The requested retained file is unavailable for this evidence version.'); }
			const hunks = computeAgentSessionChangeHunks(file);
			if (hunks.timedOut) { throw new Error('Retained change hunk calculation timed out; retry the read.'); }
			return boundedReviewResult({ evidence, file, hunks }, knownSecrets);
		}
		case 'change_explanations.latest': {
			assertAllowedKeys(params, ['turnId', 'evidenceVersion', 'evidenceFingerprint', 'path', 'hunkId']);
			const database = requireReviewDatabase(reviewDatabase);
			const target = reviewTarget(grant, params);
			requireScopedTargetTurn(collaboration, grant, database, target.turnId, isActive, signal);
			return boundedReviewResult(database.agentSessionReviews.getLatest(target), knownSecrets);
		}
		case 'change_explanations.list': {
			assertAllowedKeys(params, ['turnId', 'evidenceVersion', 'evidenceFingerprint', 'path', 'hunkId', 'afterRevision', 'limit']);
			const database = requireReviewDatabase(reviewDatabase);
			const target = reviewTarget(grant, params);
			requireScopedTargetTurn(collaboration, grant, database, target.turnId, isActive, signal);
			const afterRevision = params.afterRevision === undefined ? 0 : requiredInteger(params.afterRevision, 'afterRevision');
			const limit = params.limit === undefined ? 20 : requiredInteger(params.limit, 'limit');
			if (limit < 1 || limit > 30) { throw new Error('Review history page size must be from 1 to 30.'); }
			return boundedReviewResult(database.agentSessionReviews.listRevisions({ target, afterRevision, limit }), knownSecrets);
		}
		case 'change_explanations.draft': {
			assertAllowedKeys(params, ['turnId', 'evidenceVersion', 'evidenceFingerprint', 'path', 'hunkId', 'expectedLatestRevision', 'what', 'why', 'citations', 'checkClaims']);
			const database = requireReviewDatabase(reviewDatabase);
			const target = reviewTarget(grant, params);
			requireScopedTargetTurn(collaboration, grant, database, grant.turnId, isActive, signal);
			requireScopedTargetTurn(collaboration, grant, database, target.turnId, isActive, signal);
			const expectedLatestRevision = requiredInteger(params.expectedLatestRevision, 'expectedLatestRevision');
			const what = requiredString(params.what, 'what');
			const why = requiredString(params.why, 'why');
			const citations = reviewCitations(params.citations);
			const checkClaims = reviewCheckClaims(params.checkClaims);
			const redactedInput = sanitizeExplanation(what, why, checkClaims, knownSecrets);
			const dto = database.agentSessionReviews.recordAgentExplanation({
				target, authorTurnId: grant.turnId, expectedLatestRevision,
				what: redactedInput.what, why: redactedInput.why, citations, checkClaims: redactedInput.checkClaims,
			});
			return boundedReviewResult(dto, knownSecrets);
		}
		default:
			throw new Error('The requested session collaboration tool is not supported.');
	}
}

function optionalInteger(value: unknown, fallback: number): number {
	if (value === undefined) { return fallback; }
	if (!Number.isSafeInteger(value)) { throw new Error('The numeric tool argument is invalid.'); }
	return value as number;
}

function prTextMetadata(revision: AgentPrTextRevisionDTO) {
	return { id: revision.id, scope: revision.scope, revision: revision.revision, author: revision.author,
		source: revision.source, title: revision.content.title, contentHash: revision.content.contentHash, createdAt: revision.createdAt };
}

function requiredInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value)) { throw new Error(`The ${name} tool argument is invalid.`); }
	return value as number;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 65_000) { throw new Error(`The ${name} tool argument is invalid or too large.`); }
	return value;
}

function requiredUuid(value: unknown, name: string): string {
	const result = requiredString(value, name);
	assertUuid(result, name);
	return result;
}

function assertAllowedKeys(params: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(params).some(key => !allowed.includes(key))) { throw new Error('The session collaboration tool contains unsupported arguments.'); }
}

function safeError(error: unknown, knownSecrets: readonly string[]): string {
	const message = error instanceof Error ? error.message : 'The collaboration request failed.';
	return sanitizeCompleteAgentText(message, { knownSecrets }).slice(0, 500);
}

function requireReviewDatabase(database: AgentSessionReviewDatabase | undefined): AgentSessionReviewDatabase {
	if (!database) { throw new Error('Retained change review tools are unavailable on this host.'); }
	return database;
}

function requireScopedTargetTurn(
	collaboration: AgentSessionCollaborationService,
	grant: AgentSessionCollaborationGrant,
	database: AgentSessionReviewDatabase,
	turnId: string,
	isActive: () => boolean,
	signal: AbortSignal,
) {
	if (!isActive() || signal.aborted) { throw new Error('The session collaboration capability is revoked, invalid, or cancelled.'); }
	collaboration.listSessions(grant, 1);
	const turn = database.agentSessionTurns.getTurn(grant.projectId, grant.sessionId, turnId);
	if (!turn || turn.projectId !== grant.projectId || turn.sessionId !== grant.sessionId) {
		throw new Error('The requested turn is unavailable within this session capability.');
	}
	const liveTurn = database.agentSessionTurns.getTurn(grant.projectId, grant.sessionId, grant.turnId);
	if (!liveTurn || liveTurn.state === 'exited' || liveTurn.state === 'failed' || liveTurn.state === 'interrupted') {
		throw new Error('The session collaboration turn has ended.');
	}
	if (turn.ordinal > liveTurn.ordinal) { throw new Error('The requested evidence target must be from this turn or earlier in the same session.'); }
	return turn;
}

function reviewTarget(grant: AgentSessionCollaborationGrant, params: Record<string, unknown>): AgentSessionExplanationTarget {
	const hunkId = params.hunkId;
	if (hunkId !== null && (typeof hunkId !== 'string' || !/^[0-9a-f]{64}$/iu.test(hunkId))) { throw new Error('hunkId must be null or a SHA-256 digest.'); }
	const evidenceFingerprint = requiredString(params.evidenceFingerprint, 'evidenceFingerprint');
	if (!/^[0-9a-f]{64}$/iu.test(evidenceFingerprint)) { throw new Error('evidenceFingerprint must be a SHA-256 digest.'); }
	const evidenceVersion = requiredInteger(params.evidenceVersion, 'evidenceVersion');
	if (evidenceVersion < 1) { throw new Error('evidenceVersion must be a positive integer.'); }
	return {
		projectId: grant.projectId,
		sessionId: grant.sessionId,
		turnId: requiredUuid(params.turnId, 'turnId'),
		evidenceVersion,
		evidenceFingerprint,
		path: requiredString(params.path, 'path'),
		hunkId,
	};
}

function reviewCitations(value: unknown): readonly AgentSessionExplanationCitation[] {
	if (!Array.isArray(value) || value.length > 20) { throw new Error('citations must contain at most 20 exact selected references or conventions.'); }
	return value.map(candidate => {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { throw new Error('Each citation must be an object.'); }
		const citation = candidate as Record<string, unknown>;
		assertAllowedKeys(citation, ['kind', 'id', 'version', 'sha256']);
		if (citation.kind !== 'reference' && citation.kind !== 'convention') { throw new Error('Citation kind is invalid.'); }
		const id = requiredUuid(citation.id, 'citation id');
		const version = requiredInteger(citation.version, 'citation version');
		const sha256 = requiredString(citation.sha256, 'citation sha256');
		if (version < 1 || !/^[0-9a-f]{64}$/iu.test(sha256)) { throw new Error('Citation must identify a positive exact version and SHA-256 digest.'); }
		return { kind: citation.kind, id, version, sha256 };
	});
}

function reviewCheckClaims(value: unknown): readonly AgentSessionReportedCheck[] {
	if (!Array.isArray(value) || value.length > 10) { throw new Error('checkClaims must contain at most 10 reported checks.'); }
	return value.map(candidate => {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { throw new Error('Each reported check must be an object.'); }
		const check = candidate as Record<string, unknown>;
		assertAllowedKeys(check, ['label', 'outcome', 'detail']);
		if (typeof check.label !== 'string' || !['reportedPass', 'reportedFail', 'notRun'].includes(String(check.outcome))) { throw new Error('Reported check fields are invalid.'); }
		if (check.detail !== undefined && typeof check.detail !== 'string') { throw new Error('Reported check detail must be text.'); }
		return { label: check.label, outcome: check.outcome as AgentSessionReportedCheck['outcome'], ...(typeof check.detail === 'string' ? { detail: check.detail } : {}) };
	});
}

function sanitizeExplanation(what: string, why: string, checks: readonly AgentSessionReportedCheck[], knownSecrets: readonly string[]) {
	const sanitize = (text: string) => sanitizeCompleteAgentText(text, { knownSecrets });
	return {
		what: sanitize(what), why: sanitize(why),
		checkClaims: checks.map(check => ({ ...check, label: sanitize(check.label), ...(check.detail === undefined ? {} : { detail: sanitize(check.detail) }) })),
	};
}

function boundedReviewResult(value: unknown, knownSecrets: readonly string[]): unknown {
	if (value === undefined) { return null; }
	let redactionApplied = false;
	const sanitizeValue = (candidate: unknown): unknown => {
		if (typeof candidate === 'string') {
			const sanitized = sanitizeCompleteAgentText(candidate, { knownSecrets });
			redactionApplied ||= sanitized !== candidate;
			return sanitized;
		}
		if (Array.isArray(candidate)) { return candidate.map(sanitizeValue); }
		if (candidate && typeof candidate === 'object') {
			return Object.fromEntries(Object.entries(candidate).map(([key, item]) => [key, sanitizeValue(item)]));
		}
		return candidate;
	};
	const sanitized = sanitizeValue(value);
	const safeValue = redactionApplied && sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
		? { ...sanitized, redactionApplied: true }
		: sanitized;
	const safeJson = JSON.stringify(safeValue);
	const toolResult = { content: [{ type: 'text', text: safeJson }], structuredContent: safeValue };
	const bridgeFrame = `${JSON.stringify({ type: 'response', id: 'x'.repeat(32), result: safeValue })}\n`;
	const mcpFrame = `${JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(32), result: toolResult })}\n`;
	if (Buffer.byteLength(bridgeFrame, 'utf8') > MAX_FRAME_BYTES - 512 || Buffer.byteLength(mcpFrame, 'utf8') > MAX_FRAME_BYTES - 512) {
		throw new Error('The retained change review result exceeds the bounded MCP response size.');
	}
	return safeValue;
}

function writeFrame(socket: Socket, value: unknown): void {
	const frame = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
	if (frame.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
	socket.write(frame);
}

function listen(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
		const onListening = () => { server.off('error', onError); resolve(); };
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!server.listening) { resolve(); return; }
		server.close(error => error ? reject(error) : resolve());
	});
}

function assertUuid(value: string, label: string): void {
	if (typeof value !== 'string' || !UUID.test(value)) { throw new Error(`The ${label} must be a UUID.`); }
}
