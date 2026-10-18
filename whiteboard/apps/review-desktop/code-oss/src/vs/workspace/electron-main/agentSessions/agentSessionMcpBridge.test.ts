/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import test from 'node:test';
import type { AgentSessionPermissionPolicy, AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { AgentSessionCollaborationService } from './agentSessionCollaborationService.js';
import {
	AGENT_SESSION_MCP_TOKEN_ENV,
	AgentSessionMcpBridge,
} from './agentSessionMcpBridge.js';

const POLICY: AgentSessionPermissionPolicy = { mode: 'mutating', approval: 'on-request' };
const GATEWAY_PATH = new URL('./agentSessionMcpGateway.mjs', import.meta.url).pathname;

function createFixture(directory: string) {
	const root = join(directory, 'workspace');
	mkdirSync(root, { recursive: true });
	const database = WorkspaceDatabase.open(':memory:');
	const project = database.createProject('MCP bridge test');
	const binding = database.createFolderBinding({ projectId: project.id, path: realpathSync(root) });
	const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Exercise scoped mailbox' });
	return { database, project, binding, task, root: realpathSync(root) };
}

function createSession(fixture: ReturnType<typeof createFixture>, provider: 'codex' | 'claude') {
	return fixture.database.agentSessions.createSession({
		projectId: fixture.project.id, bindingId: fixture.binding.id, taskId: fixture.task.id,
		name: `${provider} session`, provider, model: provider === 'codex' ? 'gpt-5-codex' : 'sonnet', workspaceMode: 'sharedFolder',
	});
}

function createTurn(fixture: ReturnType<typeof createFixture>, session: ReturnType<typeof createSession>) {
	const stats = statSync(fixture.root, { bigint: true });
	const snapshot: AgentSessionTurnSnapshot = {
		schemaVersion: 1, projectId: fixture.project.id, sessionId: session.id, sessionRevision: session.revision,
		bindingId: fixture.binding.id, taskId: fixture.task.id, provider: session.provider, model: session.model, profileRef: session.profileRef,
		cwd: fixture.root, folderIdentity: { canonicalPath: fixture.root, dev: stats.dev.toString(), ino: stats.ino.toString() },
		managedWorktreeOwnerId: null, permissionPolicy: POLICY, convention: null, references: [],
	};
	return fixture.database.agentSessionTurns.createTurn({ projectId: fixture.project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
}

async function openMcpClient(access: Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>>) {
	const env = {
		PATH: process.env.PATH ?? '',
		[AGENT_SESSION_MCP_TOKEN_ENV]: access.gatewayEnvironment[AGENT_SESSION_MCP_TOKEN_ENV],
	};
	const transport = new StdioClientTransport({ command: process.execPath, args: [GATEWAY_PATH, ...access.gatewayArguments], env, stderr: 'pipe' });
	const client = new Client({ name: 'bugfixer-session-collaboration-test', version: '1.0.0' });
	await client.connect(transport);
	return { client, close: async () => { try { await client.close(); } catch { /* The bridge revocation test intentionally closes the private socket first. */ } } };
}

function assertSocketDenied(socketPath: string, token: string): Promise<void> {
	const socket = connect(socketPath);
	return new Promise((resolve, reject) => {
		socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'auth', token })}\n`));
		socket.once('close', () => resolve());
		socket.once('error', reject);
	});
}

test('real MCP SDK client uses scoped sockets for all provider pairings and durable receipts', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-mcp-sdk-'));
	const fixture = createFixture(directory);
	const collaboration = new AgentSessionCollaborationService(fixture.database);
	const bridge = new AgentSessionMcpBridge(collaboration);
	try {
		for (const [senderProvider, receiverProvider] of [['codex', 'codex'], ['codex', 'claude'], ['claude', 'codex'], ['claude', 'claude']] as const) {
			const pairAccesses: Array<Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>>> = [];
			const pairClients: Array<Awaited<ReturnType<typeof openMcpClient>>> = [];
			try {
				const sender = createSession(fixture, senderProvider);
				const receiver = createSession(fixture, receiverProvider);
				const senderTurn = createTurn(fixture, sender);
				const receiverTurn = createTurn(fixture, receiver);
				const senderAccess = await bridge.issueAccess({ projectId: fixture.project.id, sessionId: sender.id, turnId: senderTurn.id, permissionPolicy: POLICY });
				pairAccesses.push(senderAccess);
				const receiverAccess = await bridge.issueAccess({ projectId: fixture.project.id, sessionId: receiver.id, turnId: receiverTurn.id, permissionPolicy: POLICY });
				pairAccesses.push(receiverAccess);
				const senderClient = await openMcpClient(senderAccess);
				pairClients.push(senderClient);
				const receiverClient = await openMcpClient(receiverAccess);
				pairClients.push(receiverClient);

				const toolList = await senderClient.client.listTools();
				assert.deepEqual(toolList.tools.map(tool => tool.name), ['sessions_list', 'messages_send', 'messages_list', 'messages_ack', 'messages_wait']);
				const request = {
					name: 'messages_send',
					arguments: { recipientSessionId: receiver.id, idempotencyKey: `stable-${senderProvider}-${receiverProvider}`, body: 'Inspect this collaboration request.' },
				};
				const first = await senderClient.client.callTool(request);
				const duplicate = await senderClient.client.callTool(request);
				const firstPayload = first.structuredContent as { message: { id: string; receiverAvailability: string } };
				const duplicatePayload = duplicate.structuredContent as { message: { id: string } };
				assert.equal(firstPayload.message.id, duplicatePayload.message.id);
				assert.equal(firstPayload.message.receiverAvailability, 'active');
				const page = await receiverClient.client.callTool({ name: 'messages_list', arguments: { afterSequence: 0, limit: 1 } });
				const pagePayload = page.structuredContent as { messages: Array<{ id: string; senderSessionId: string; body: string }>; nextCursor: number };
				assert.equal(pagePayload.messages.length, 1);
				assert.equal(pagePayload.messages[0].senderSessionId, sender.id);
				assert.equal(pagePayload.messages[0].body, 'Inspect this collaboration request.');
				assert.ok(pagePayload.nextCursor > 0);
				await receiverClient.client.callTool({ name: 'messages_ack', arguments: { messageId: pagePayload.messages[0].id } });
				const acknowledged = await receiverClient.client.callTool({ name: 'messages_list', arguments: { afterSequence: 0, limit: 1 } });
				assert.ok((acknowledged.structuredContent as { messages: Array<{ readAt: string | null }> }).messages[0].readAt);
				if (senderProvider === 'codex' && receiverProvider === 'codex') {
					const offline = createSession(fixture, 'claude');
					const queued = await senderClient.client.callTool({ name: 'messages_send', arguments: {
						recipientSessionId: offline.id, idempotencyKey: 'offline-recipient', body: 'This remains queued for an offline session.',
					} });
					assert.equal((queued.structuredContent as { message: { receiverAvailability: string } }).message.receiverAvailability, 'offline');
				}
			} finally {
				for (const access of pairAccesses) { access.revokeAccess(); }
				for (const client of pairClients) { await client.close(); }
				for (const access of pairAccesses) { await access.releasePrivateConfig(); }
			}
		}
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('large escaped mailbox messages are byte-paged with exact cursors and unrepresentable messages are rejected before persistence', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-mcp-large-pages-'));
	const fixture = createFixture(directory);
	const collaboration = new AgentSessionCollaborationService(fixture.database);
	const bridge = new AgentSessionMcpBridge(collaboration);
	const accesses: Array<Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>>> = [];
	const clients: Array<Awaited<ReturnType<typeof openMcpClient>>> = [];
	try {
		const sender = createSession(fixture, 'codex');
		const receiver = createSession(fixture, 'claude');
		const senderTurn = createTurn(fixture, sender);
		const receiverTurn = createTurn(fixture, receiver);
		const senderAccess = await bridge.issueAccess({ projectId: fixture.project.id, sessionId: sender.id, turnId: senderTurn.id, permissionPolicy: POLICY });
		const receiverAccess = await bridge.issueAccess({ projectId: fixture.project.id, sessionId: receiver.id, turnId: receiverTurn.id, permissionPolicy: POLICY });
		accesses.push(senderAccess, receiverAccess);
		const senderClient = await openMcpClient(senderAccess);
		const receiverClient = await openMcpClient(receiverAccess);
		clients.push(senderClient, receiverClient);
		const body = ('café\t"quoted"\\😀').repeat(350);
		const expectedBodies: string[] = [];
		for (let index = 0; index < 7; index++) {
			expectedBodies.push(`${index}:${body}`);
			const sent = await senderClient.client.callTool({ name: 'messages_send', arguments: {
				recipientSessionId: receiver.id, idempotencyKey: `large-page-${index}`, body: expectedBodies[index],
			} });
			assert.equal(sent.isError, undefined);
		}
		const oversized = await senderClient.client.callTool({ name: 'messages_send', arguments: {
			recipientSessionId: receiver.id, idempotencyKey: 'unrepresentable-surrogate-text', body: '\ud800'.repeat(10_000),
		} });
		assert.equal(oversized.isError, true);
		const sqlite = Reflect.get(fixture.database, 'db') as { prepare(sql: string): { all(...args: string[]): Array<Record<string, unknown>> } };
		assert.equal(sqlite.prepare('SELECT id FROM agent_session_messages WHERE idempotency_key = ?').all('unrepresentable-surrogate-text').length, 0);

		const received: Array<{ id: string; body: string; sequence: number }> = [];
		const waited = await receiverClient.client.callTool({ name: 'messages_wait', arguments: { afterSequence: 0, timeoutMs: 0, limit: 100 } });
		const waitPage = waited.structuredContent as { messages: Array<{ id: string; body: string; sequence: number }>; nextCursor: number };
		assert.ok(waitPage.messages.length > 0 && waitPage.messages.length < 7, 'wait results must be byte-paged within the response frame');
		assert.equal(waitPage.nextCursor, waitPage.messages.at(-1)!.sequence);
		received.push(...waitPage.messages);
		let cursor = waitPage.nextCursor;
		while (true) {
			const response = await receiverClient.client.callTool({ name: 'messages_list', arguments: { afterSequence: cursor, limit: 100 } });
			assert.equal(response.isError, undefined);
			const page = response.structuredContent as { messages: Array<{ id: string; body: string; sequence: number }>; nextCursor: number };
			if (!page.messages.length) { break; }
			assert.ok(page.messages.length < 7, 'large bodies must be byte-paged before reaching the frame limit');
			assert.equal(page.nextCursor, page.messages.at(-1)!.sequence);
			assert.ok(page.nextCursor > cursor);
			received.push(...page.messages);
			cursor = page.nextCursor;
		}
		assert.deepEqual(received.map(message => message.body), expectedBodies);
		assert.equal(new Set(received.map(message => message.id)).size, 7);
	} finally {
		for (const access of accesses) { access.revokeAccess(); }
		for (const client of clients) { await client.close(); }
		for (const access of accesses) { await access.releasePrivateConfig(); }
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('gateway rejects a duplicate in-flight JSON-RPC ID before dispatching its second operation', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-mcp-duplicate-id-'));
	const fixture = createFixture(directory);
	const collaboration = new AgentSessionCollaborationService(fixture.database);
	const bridge = new AgentSessionMcpBridge(collaboration);
	let access: Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>> | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	try {
		const sender = createSession(fixture, 'codex');
		const receiver = createSession(fixture, 'claude');
		const turn = createTurn(fixture, sender);
		access = await bridge.issueAccess({ projectId: fixture.project.id, sessionId: sender.id, turnId: turn.id, permissionPolicy: POLICY });
		child = spawn(process.execPath, [GATEWAY_PATH, ...access.gatewayArguments], {
			env: { PATH: process.env.PATH ?? '', [AGENT_SESSION_MCP_TOKEN_ENV]: access.gatewayEnvironment[AGENT_SESSION_MCP_TOKEN_ENV] },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let buffered = '';
		const lines: string[] = [];
		const readers: Array<(line: string) => void> = [];
		child.stdout.on('data', chunk => {
			buffered += chunk.toString('utf8');
			let newline: number;
			while ((newline = buffered.indexOf('\n')) >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				const reader = readers.shift();
				if (reader) { reader(line); } else { lines.push(line); }
			}
		});
		const readLine = () => {
			if (lines.length) { return Promise.resolve(lines.shift()!); }
			return new Promise<string>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('Timed out waiting for the gateway JSON-RPC response.')), 5_000);
				readers.push(line => { clearTimeout(timeout); resolve(line); });
			});
		};
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'same-id', method: 'tools/call', params: { name: 'messages_wait', arguments: { timeoutMs: 30_000 } } })}\n`);
		const deadline = Date.now() + 2_000;
		while (Reflect.get(collaboration, 'activeWaiters') !== 1 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); }
		assert.equal(Reflect.get(collaboration, 'activeWaiters'), 1, 'first request must be pending before duplicate arrives');
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'same-id', method: 'tools/call', params: { name: 'messages_send', arguments: {
			recipientSessionId: receiver.id, idempotencyKey: 'must-not-send', body: 'Duplicate request must have no side effect.',
		} } })}\n`);
		const duplicate = JSON.parse(await readLine()) as { id: string; error?: { code: number; message: string } };
		assert.equal(duplicate.id, 'same-id');
		assert.equal(duplicate.error?.code, -32600);
		assert.match(duplicate.error?.message ?? '', /already in flight/i);
		const escapedLongId = '\\'.repeat(130);
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: escapedLongId, method: 'tools/call', params: { name: 'messages_send', arguments: {
			recipientSessionId: receiver.id, idempotencyKey: 'escaped-id-must-not-send', body: 'Escaped ID rejected before dispatch.',
		} } })}\n`);
		const invalidId = JSON.parse(await readLine()) as { id: string | null; error?: { code: number; message: string } };
		assert.equal(invalidId.id, null);
		assert.equal(invalidId.error?.code, -32600);
		assert.match(invalidId.error?.message ?? '', /request ID/i);
		const sqlite = Reflect.get(fixture.database, 'db') as { prepare(sql: string): { all(...args: string[]): Array<Record<string, unknown>> } };
		assert.equal(sqlite.prepare('SELECT id FROM agent_session_messages WHERE idempotency_key = ?').all('must-not-send').length, 0);
		assert.equal(sqlite.prepare('SELECT id FROM agent_session_messages WHERE idempotency_key = ?').all('escaped-id-must-not-send').length, 0);
	} finally {
		access?.revokeAccess();
		if (child && child.exitCode === null) {
			child.kill('SIGTERM');
			await new Promise<void>(resolve => child!.once('exit', () => resolve()));
		}
		if (access) { await access.releasePrivateConfig(); }
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('MCP token is secret-redacted and revocation promptly cancels a waiting tool', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-mcp-revoke-'));
	const fixture = createFixture(directory);
	const collaboration = new AgentSessionCollaborationService(fixture.database);
	const bridge = new AgentSessionMcpBridge(collaboration);
	let access: Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>> | undefined;
	let mcp: Awaited<ReturnType<typeof openMcpClient>> | undefined;
	let receiverAccess: Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>> | undefined;
	let receiverClient: Awaited<ReturnType<typeof openMcpClient>> | undefined;
	try {
		const sender = createSession(fixture, 'codex');
		const receiver = createSession(fixture, 'claude');
		const senderTurn = createTurn(fixture, sender);
		createTurn(fixture, receiver);
		access = await bridge.issueAccess({ projectId: fixture.project.id, sessionId: sender.id, turnId: senderTurn.id, permissionPolicy: POLICY });
		const socketPath = access.gatewayArguments[0];
		const privateDirectory = socketPath.slice(0, socketPath.lastIndexOf('/'));
		assert.equal(statSync(privateDirectory).mode & 0o777, 0o700);
		assert.equal(statSync(socketPath).mode & 0o777, 0o600);
		assert.deepEqual(Object.keys(access.gatewayEnvironment), [AGENT_SESSION_MCP_TOKEN_ENV]);
		await assertSocketDenied(socketPath, 'wrong-capability');
		mcp = await openMcpClient(access);
		const token = access.gatewayEnvironment[AGENT_SESSION_MCP_TOKEN_ENV];
		assert.ok(access.knownSecrets.includes(token));
		const result = await mcp.client.callTool({
			name: 'messages_send',
			arguments: { recipientSessionId: receiver.id, idempotencyKey: 'redaction-check', body: `Do not persist ${token}` },
		});
		const payload = result.structuredContent as { message: { body: string; redacted: boolean } };
		assert.equal(payload.message.body, 'Do not persist ***');
		assert.equal(payload.message.redacted, true);
		const sqlite = Reflect.get(fixture.database, 'db') as { prepare(sql: string): { all(...args: string[]): Array<Record<string, unknown>> } };
		const rows = sqlite.prepare('SELECT body, idempotency_key FROM agent_session_messages').all();
		assert.equal(JSON.stringify(rows).includes(token), false);
		access.revokeAccess();
		await assertSocketDenied(socketPath, token);

		const receiverTurn = fixture.database.agentSessionTurns.listTurns(fixture.project.id, receiver.id)[0];
		receiverAccess = await bridge.issueAccess({ projectId: fixture.project.id, sessionId: receiver.id, turnId: receiverTurn.id, permissionPolicy: POLICY });
		receiverClient = await openMcpClient(receiverAccess);
		const waiting = receiverClient.client.callTool({ name: 'messages_wait', arguments: { afterSequence: 1, timeoutMs: 30_000 } });
		const waitDeadline = Date.now() + 2_000;
		while (Reflect.get(collaboration, 'activeWaiters') !== 1 && Date.now() < waitDeadline) { await new Promise(resolve => setTimeout(resolve, 10)); }
		assert.equal(Reflect.get(collaboration, 'activeWaiters'), 1, 'mailbox wait must be active before launch access is revoked');
		receiverAccess.revokeAccess();
		await assert.rejects(waiting, /cancelled|revoked|disconnected|closed|transport/i);
		assert.equal(Reflect.get(collaboration, 'activeWaiters'), 0, 'revocation must release the backend waiter');
		const receiverSocketPath = receiverAccess.gatewayArguments[0];
		const receiverDirectory = receiverSocketPath.slice(0, receiverSocketPath.lastIndexOf('/'));
		await receiverAccess.releasePrivateConfig();
		assert.equal(existsSync(receiverSocketPath), false);
		assert.equal(existsSync(receiverDirectory), false);
	} finally {
		if (receiverAccess) { receiverAccess.revokeAccess(); }
		await receiverClient?.close();
		if (receiverAccess) { await receiverAccess.releasePrivateConfig(); }
		if (access) {
			access.revokeAccess();
			await mcp?.close();
			await access.releasePrivateConfig();
		}
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
