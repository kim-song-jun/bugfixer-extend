/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, timingSafeEqual } from 'node:crypto';
import net, { type Server, type Socket } from 'node:net';
import type { AgentSessionStore } from './agentSessionStore.js';
import type { AgentSessionTurnStore } from './agentSessionTurnStore.js';
import { AgentSessionPreparationError } from './agentSessionPreparationError.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FRAME_BYTES = 4096;
const MAX_PENDING_CONNECTIONS = 4;
const CONNECTION_TIMEOUT_MS = 3000;

export type AgentProviderIdentityDatabase = {
	readonly agentSessions: Pick<AgentSessionStore, 'getSession'>;
	readonly agentSessionTurns: Pick<AgentSessionTurnStore, 'getTurn' | 'recordProviderConversationId'>;
};

export interface AgentProviderIdentityAccess {
	readonly port: number;
	readonly nonce: string;
	revokeAccess(): void;
	close(): Promise<AgentProviderIdentityCleanupReceipt>;
	releasePrivateConfig(): Promise<void>;
}

export interface AgentProviderIdentityCleanupReceipt {
	readonly complete: boolean;
	readonly listenerClosed: boolean;
	readonly connectionsClosed: boolean;
	readonly error?: string;
}

interface IdentityReceiverInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly expectedConversationId: string | null;
	readonly onIdentityMismatch: () => void;
}

interface IdentityFrame {
	readonly nonce: string;
	readonly sessionId: string;
}

export class AgentProviderIdentitySetupError extends AgentSessionPreparationError {
	constructor(
		readonly cleanupReceipt: AgentProviderIdentityCleanupReceipt,
		recovery: { revokeAccess(): void; releasePrivateConfig(): Promise<void> },
		cause: unknown,
	) {
		super('Could not create the private provider identity receiver.', false, recovery);
		this.name = 'AgentProviderIdentitySetupError';
		Object.defineProperty(this, 'cause', { value: cause, configurable: true });
	}
}

/** Receives root Codex UserPromptSubmit identity metadata through a private, per-launch loopback port. */
export class AgentProviderIdentityReceiver {
	constructor(private readonly database: AgentProviderIdentityDatabase) { }

	async issue(input: IdentityReceiverInput): Promise<AgentProviderIdentityAccess> {
		assertUuid(input.projectId, 'project ID');
		assertUuid(input.sessionId, 'session ID');
		assertUuid(input.turnId, 'turn ID');
		if (input.expectedConversationId !== null) { assertUuid(input.expectedConversationId, 'expected provider conversation ID'); }
		if (typeof input.onIdentityMismatch !== 'function') { throw new Error('The identity mismatch handler is invalid.'); }
		const session = this.database.agentSessions.getSession(input.projectId, input.sessionId);
		if (!session || session.provider !== 'codex') { throw new Error('The provider identity receiver requires an owned Codex session.'); }
		const turn = this.database.agentSessionTurns.getTurn(input.projectId, input.sessionId, input.turnId);
		if (!turn || (turn.state !== 'starting' && turn.state !== 'running')) { throw new Error('The provider identity receiver requires an active owned turn.'); }
		if (turn.providerConversationId !== null && input.expectedConversationId !== null && input.expectedConversationId !== turn.providerConversationId) {
			throw new Error('The expected provider conversation ID does not match the active turn.');
		}

		let nonce = '';
		let nonceBytes = Buffer.alloc(0);
		let port: number | undefined;
		let server: Server | undefined;
		const sockets = new Set<Socket>();
		let pendingConnections = 0;
		let revoked = false;
		let closePromise: Promise<AgentProviderIdentityCleanupReceipt> | undefined;
		let mismatchReported = false;

		const onMismatch = (): void => {
			if (mismatchReported) { return; }
			mismatchReported = true;
			try { input.onIdentityMismatch(); }
			catch { console.error('Provider identity mismatch callback failed.'); }
		};

		const onConnection = (socket: Socket): void => {
			if (revoked || pendingConnections >= MAX_PENDING_CONNECTIONS) { socket.destroy(); return; }
			pendingConnections++;
			sockets.add(socket);
			socket.setTimeout(CONNECTION_TIMEOUT_MS);
			let buffer = Buffer.alloc(0);
			let settled = false;
			let frameReceived = false;
			const finish = (): void => {
				if (settled) { return; }
				settled = true;
				pendingConnections--;
				sockets.delete(socket);
			};
			socket.once('timeout', () => socket.destroy(new Error('Identity request timed out.')));
			socket.once('error', () => { socket.destroy(); });
			socket.once('close', finish);
			socket.on('data', chunk => {
				if (settled || revoked || frameReceived) { socket.destroy(); return; }
				buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
				if (buffer.byteLength > MAX_FRAME_BYTES) { socket.destroy(new Error('Identity frame exceeds its size limit.')); return; }
				const newline = buffer.indexOf(0x0a);
				if (newline < 0) { return; }
				if (newline !== buffer.byteLength - 1) { socket.destroy(new Error('Identity frame contains trailing data.')); return; }
				frameReceived = true;
				const frame = parseFrame(buffer.subarray(0, newline), nonceBytes);
				if (!frame) { socket.end('{"ok":false}\n'); return; }
				void persistIdentity(input, frame.sessionId, this.database, onMismatch)
					.then(result => {
						if (revoked || socket.destroyed) { return; }
						socket.end(result.accepted ? '{"ok":true}\n' : '{"ok":false}\n');
					})
					.catch(() => {
						console.error('Provider identity persistence failed.');
						if (!revoked && !socket.destroyed) { socket.end('{"ok":false}\n'); }
					});
			});
		};

		try {
			nonce = randomBytes(32).toString('base64url');
			nonceBytes = Buffer.from(nonce, 'utf8');
			server = net.createServer({ allowHalfOpen: false });
			server.on('connection', onConnection);
			server.on('error', () => { console.error('Provider identity listener failed.'); });
			await new Promise<void>((resolve, reject) => {
				server!.once('error', reject);
				server!.listen({ host: '127.0.0.1', port: 0 }, () => {
					server!.removeListener('error', reject);
					const address = server!.address();
					if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port < 1 || address.port > 65535) {
						reject(new Error('The provider identity listener did not bind to the expected loopback address.'));
						return;
					}
					port = address.port;
					resolve();
				});
			});
		} catch (error) {
			revoked = true;
			const cleanup = (): Promise<AgentProviderIdentityCleanupReceipt> => cleanupServer(server, sockets);
			const receipt = await cleanup();
			if (!receipt.complete) {
				throw new AgentProviderIdentitySetupError(receipt, {
					revokeAccess: () => { revoked = true; for (const socket of sockets) { socket.destroy(); } },
					releasePrivateConfig: async () => {
						const retry = await cleanup();
						if (!retry.complete) { throw new Error('Provider identity receiver cleanup remains incomplete.'); }
					},
				}, error);
			}
			throw new Error('Could not create the private provider identity receiver.', { cause: error });
		}

		const close = (): Promise<AgentProviderIdentityCleanupReceipt> => {
			if (!closePromise) {
				revoked = true;
				for (const socket of sockets) { socket.destroy(); }
				closePromise = cleanupServer(server, sockets).then(receipt => {
					if (!receipt.complete) { closePromise = undefined; }
					return receipt;
				}, error => {
					closePromise = undefined;
					console.error('Provider identity receiver cleanup failed.');
					return { complete: false, listenerClosed: false, connectionsClosed: false, error: errorMessage(error) };
				});
			}
			return closePromise!;
		};
		return Object.freeze({
			port: port!,
			nonce,
			revokeAccess: (): void => { revoked = true; for (const socket of sockets) { socket.destroy(); } },
			close,
			releasePrivateConfig: async (): Promise<void> => {
				const receipt = await close();
				if (!receipt.complete) { throw new Error('Provider identity receiver cleanup remains incomplete.'); }
			},
		});
	}
}

function parseFrame(bytes: Buffer, expectedNonce: Buffer): IdentityFrame | undefined {
	try {
		const value: unknown = JSON.parse(bytes.toString('utf8'));
		if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.nonce !== 'string' || typeof value.sessionId !== 'string') { return undefined; }
		if (Buffer.byteLength(value.nonce, 'utf8') !== expectedNonce.byteLength) { return undefined; }
		const providedNonce = Buffer.from(value.nonce, 'utf8');
		if (!timingSafeEqual(providedNonce, expectedNonce) || !UUID_PATTERN.test(value.sessionId)) { return undefined; }
		return { nonce: value.nonce, sessionId: value.sessionId };
	} catch { return undefined; }
}

async function persistIdentity(
	input: IdentityReceiverInput,
	conversationId: string,
	database: AgentProviderIdentityDatabase,
	onMismatch: () => void,
): Promise<{ readonly accepted: boolean; readonly conversationId: string | null }> {
	const session = database.agentSessions.getSession(input.projectId, input.sessionId);
	if (!session || session.provider !== 'codex') { return { accepted: false, conversationId: null }; }
	const turn = database.agentSessionTurns.getTurn(input.projectId, input.sessionId, input.turnId);
	if (!turn || (turn.state !== 'starting' && turn.state !== 'running')) { return { accepted: false, conversationId: turn?.providerConversationId ?? null }; }
	if (input.expectedConversationId !== null && input.expectedConversationId !== conversationId) {
		onMismatch();
		return { accepted: false, conversationId: null };
	}
	if (turn.providerConversationId !== null) {
		if (turn.providerConversationId !== conversationId) { onMismatch(); return { accepted: false, conversationId: turn.providerConversationId }; }
		return { accepted: true, conversationId: turn.providerConversationId };
	}
	try {
		const recorded = database.agentSessionTurns.recordProviderConversationId(input.projectId, input.sessionId, input.turnId, turn.revision, conversationId);
		const latest = database.agentSessionTurns.getTurn(input.projectId, input.sessionId, input.turnId);
		return { accepted: recorded.providerConversationId === conversationId && (latest?.state === 'starting' || latest?.state === 'running'), conversationId: recorded.providerConversationId };
	} catch (error) {
		const latest = database.agentSessionTurns.getTurn(input.projectId, input.sessionId, input.turnId);
		if (latest?.providerConversationId !== null && latest?.providerConversationId !== undefined && latest.providerConversationId !== conversationId) {
			onMismatch();
			return { accepted: false, conversationId: latest.providerConversationId };
		}
		throw error;
	}
}

async function cleanupServer(server: Server | undefined, sockets: ReadonlySet<Socket>): Promise<AgentProviderIdentityCleanupReceipt> {
	const connections = [...sockets];
	const connectionsClosed = Promise.all(connections.map(waitForSocketClose)).then(() => true);
	for (const socket of connections) { socket.destroy(); }
	let listenerClosed = !server?.listening;
	if (server?.listening) {
		listenerClosed = await new Promise(resolve => {
			try { server.close(error => resolve(!error)); }
			catch { resolve(false); }
		});
	}
	const closed = await connectionsClosed;
	const connectionsClosedVerified = closed && sockets.size === 0;
	const complete = listenerClosed && connectionsClosedVerified;
	return {
		complete,
		listenerClosed,
		connectionsClosed: connectionsClosedVerified,
		...(!complete ? { error: [!listenerClosed && 'listener-close-failed', !connectionsClosedVerified && 'connections-still-open'].filter(Boolean).join(',') } : {}),
	};
}

function waitForSocketClose(socket: Socket): Promise<void> {
	if (socket.closed) { return Promise.resolve(); }
	return new Promise(resolve => socket.once('close', () => resolve()));
}

function assertUuid(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) { throw new Error(`The ${label} is invalid.`); }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'cleanup-failed'; }
