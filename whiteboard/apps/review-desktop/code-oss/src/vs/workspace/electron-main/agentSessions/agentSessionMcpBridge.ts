/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdtempSync } from 'node:fs';
import { rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import type { AgentSessionPermissionPolicy } from '../../common/workspaceAgentSessionProtocol.js';
import { AgentSessionCollaborationService, type AgentSessionCollaborationGrant } from './agentSessionCollaborationService.js';
import { AgentSessionPreparationError, type AgentSessionPreparationRecovery } from './agentSessionPreparationError.js';

export const AGENT_SESSION_MCP_GATEWAY_MODULE = 'agentSessionMcpGateway.mjs';
export const AGENT_SESSION_MCP_TOKEN_ENV = 'BUGFIXER_SESSION_MCP_TOKEN';

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
	/** The private Unix socket path is a nonsecret argument; only the capability value is an environment value. */
	readonly gatewayArguments: readonly string[];
	/** The token is forwarded to the app-owned gateway through the launch's allowlisted environment only. */
	readonly gatewayEnvironment: Readonly<Record<string, string>>;
	readonly knownSecrets: readonly string[];
	/** Idempotent synchronous deny, socket destruction, and wait cancellation. */
	revokeAccess(): void;
	/** Removes only this grant's private socket and temporary directory after revokeAccess. */
	releasePrivateConfig(): Promise<void>;
}

export interface AgentSessionMcpBridgeOptions {
	/** Trusted app temp root; injectable to isolate setup and cleanup in focused tests. */
	readonly temporaryDirectory?: string;
	readonly chmod?: typeof chmodSync;
	readonly unlink?: typeof unlink;
	readonly rmdir?: typeof rmdir;
}

interface ActiveRequest {
	readonly controller: AbortController;
}

/** Main-process capability broker. It owns a private Unix socket and no process handles. */
export class AgentSessionMcpBridge {
	constructor(private readonly collaboration: AgentSessionCollaborationService, private readonly options: AgentSessionMcpBridgeOptions = {}) { }

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
		let socketRemoved = false;
		let directoryRemoved = false;
		let closePromise: Promise<void> | undefined;
		const sockets = new Set<Socket>();
		let privateDirectory: string | undefined;
		let socketPath: string | undefined;
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
			if (socketPath && !socketRemoved) {
				try { await (this.options.unlink ?? unlink)(socketPath); socketRemoved = true; }
				catch (error) { if (isMissingFile(error)) { socketRemoved = true; } else { failures.push(error); } }
			}
			if (privateDirectory && !directoryRemoved) {
				try { await (this.options.rmdir ?? rmdir)(privateDirectory); directoryRemoved = true; }
				catch (error) { if (isMissingFile(error)) { directoryRemoved = true; } else { failures.push(error); } }
			}
			if (failures.length) { throw new AggregateError(failures, 'Session MCP private resources could not be released.'); }
		};
		const releasePrivateConfig = async () => {
			if (!grantRevoked) { throw new Error('Session MCP access must be revoked before private configuration is released.'); }
			await cleanupOwnedResources();
		};
		try {
			privateDirectory = mkdtempSync(join(this.options.temporaryDirectory ?? tmpdir(), 'bugfixer-session-mcp-'));
			socketPath = join(privateDirectory, 'bridge.sock');
			server = createServer(socket => acceptSocket(socket, grant, tokenDigest, this.collaboration, sockets, () => active));
			server.maxConnections = MAX_CONNECTIONS;
			server.on('error', error => {
				if (!active) { return; }
				try { revokeAccess(); } catch (revokeError) { asynchronousServerFailure = new AggregateError([error, revokeError], 'Session MCP server failed and access revocation needs retry.'); }
			});
			await listen(server, socketPath);
			(this.options.chmod ?? chmodSync)(privateDirectory, 0o700);
			(this.options.chmod ?? chmodSync)(socketPath, 0o600);
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
		const knownSecrets = Object.freeze([...new Set([...(input.knownSecrets ?? []), token].filter(Boolean))]);
		const ownedSocketPath = socketPath!;
		return Object.freeze({
			gatewayArguments: Object.freeze([ownedSocketPath]),
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
			void dispatch(collaboration, grant, parsed.method, parsed.params, controller.signal).then(
				result => {
					if (!isActive() || closed) { return; }
					requests.delete(parsed.id);
					writeFrame(socket, { type: 'response', id: parsed.id, result });
				},
				error => {
					if (!isActive() || closed) { return; }
					requests.delete(parsed.id);
					writeFrame(socket, { type: 'response', id: parsed.id, error: safeError(error) });
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
): Promise<unknown> {
	switch (method) {
		case 'sessions.list':
			assertAllowedKeys(params, ['limit']);
			return { sessions: collaboration.listSessions(grant, optionalInteger(params.limit, 50)) };
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
		default:
			throw new Error('The requested session collaboration tool is not supported.');
	}
}

function optionalInteger(value: unknown, fallback: number): number {
	if (value === undefined) { return fallback; }
	if (!Number.isSafeInteger(value)) { throw new Error('The numeric tool argument is invalid.'); }
	return value as number;
}

function requiredInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value)) { throw new Error(`The ${name} tool argument is invalid.`); }
	return value as number;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 65_000) { throw new Error(`The ${name} tool argument is invalid or too large.`); }
	return value;
}

function assertAllowedKeys(params: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(params).some(key => !allowed.includes(key))) { throw new Error('The session collaboration tool contains unsupported arguments.'); }
}

function safeError(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 500) : 'The collaboration request failed.';
}

function writeFrame(socket: Socket, value: unknown): void {
	const frame = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
	if (frame.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
	socket.write(frame);
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
		const onListening = () => { server.off('error', onError); resolve(); };
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(socketPath);
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

function isMissingFile(error: unknown): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
