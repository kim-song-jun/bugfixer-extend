/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
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
const READ_ONLY: AgentSessionPermissionPolicy = { mode: 'read-only', approval: 'never' };
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

function createTurn(fixture: ReturnType<typeof createFixture>, session: ReturnType<typeof createSession>, permissionPolicy = POLICY) {
	const stats = statSync(fixture.root, { bigint: true });
	const snapshot: AgentSessionTurnSnapshot = {
		schemaVersion: 1, projectId: fixture.project.id, sessionId: session.id, sessionRevision: session.revision,
		bindingId: fixture.binding.id, taskId: fixture.task.id, provider: session.provider, model: session.model, profileRef: session.profileRef,
		cwd: fixture.root, folderIdentity: { canonicalPath: fixture.root, dev: stats.dev.toString(), ino: stats.ino.toString() },
		managedWorktreeOwnerId: null, permissionPolicy, convention: null, references: [],
	};
	return fixture.database.agentSessionTurns.createTurn({ projectId: fixture.project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
}

function createWorkflow(fixture: ReturnType<typeof createFixture>, session: ReturnType<typeof createSession>, permissionPolicy = POLICY) {
	const workflow = fixture.database.agentWorkflows.createWorkflow(fixture.project.id, {
		projectId: fixture.project.id, bindingId: fixture.binding.id, taskId: fixture.task.id,
		maxConcurrentNodes: 1, maxTotalTurns: 1, maxDurationMs: 60_000,
		nodes: [{
			nodeId: 'implement', sessionId: session.id, role: 'implementer', provider: session.provider, model: session.model,
			taskId: fixture.task.id, bindingId: fixture.binding.id, referenceIds: [], permissionPolicy, dependsOn: [],
		}],
		idempotencyKey: randomUUID(),
	});
	return workflow;
}

async function openMcpClient(
	access: Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>>,
	token = access.gatewayEnvironment[AGENT_SESSION_MCP_TOKEN_ENV],
	connectionTimeoutMs = 60_000,
) {
	const env = {
		PATH: process.env.PATH ?? '',
		[AGENT_SESSION_MCP_TOKEN_ENV]: token,
	};
	const transport = new StdioClientTransport({ command: process.execPath, args: [GATEWAY_PATH, String(access.port)], env, stderr: 'pipe' });
	const client = new Client({ name: 'bugfixer-session-collaboration-test', version: '1.0.0' });
	let connectionTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			client.connect(transport),
			new Promise<never>((_, reject) => {
				connectionTimer = setTimeout(() => reject(new Error('Timed out connecting the MCP SDK to its gateway.')), connectionTimeoutMs);
			}),
		]);
	} catch (error) {
		try { await transport.close(); }
		catch (cleanupError) { throw new AggregateError([error, cleanupError], 'MCP client setup and transport cleanup failed.'); }
		throw error;
	} finally {
		if (connectionTimer) { clearTimeout(connectionTimer); }
	}
	return { client, close: () => client.close() };
}

async function closeOwnedMcpResources(
	clients: readonly Awaited<ReturnType<typeof openMcpClient>>[],
	accesses: readonly Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>>[],
): Promise<void> {
	for (const access of accesses) { access.revokeAccess(); }
	const clientsClosed = await Promise.allSettled(clients.map(client => client.close()));
	const configsReleased = await Promise.allSettled(accesses.map(access => access.releasePrivateConfig()));
	const failures = [...clientsClosed, ...configsReleased].filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason);
	if (failures.length) { throw new AggregateError(failures, 'Owned MCP fixture resources did not close cleanly.'); }
}

function assertBridgeDenied(port: number, token: string): Promise<void> {
	const socket = connect({ host: '127.0.0.1', port });
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) { return; }
			settled = true;
			socket.destroy();
			if (error) { reject(error); } else { resolve(); }
		};
		socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'auth', token })}\n`, error => {
			if (error) {
				if ((error as NodeJS.ErrnoException).code === 'EPIPE') { finish(); }
				else { finish(error); }
			}
		}));
		socket.once('close', () => finish());
		socket.once('error', error => {
			if (['EPIPE', 'ECONNREFUSED', 'ECONNRESET'].includes((error as NodeJS.ErrnoException).code ?? '')) { finish(); }
			else { finish(error); }
		});
	});
}

function assertUnauthenticatedConnectionTimesOut(port: number): Promise<void> {
	const socket = connect({ host: '127.0.0.1', port });
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error('The MCP bridge did not close an unauthenticated connection within its bounded auth timeout.'));
		}, 8_000);
		socket.once('connect', () => undefined);
		socket.once('close', () => { clearTimeout(timeout); resolve(); });
		socket.once('error', error => {
			clearTimeout(timeout);
			if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') { resolve(); }
			else { reject(error); }
		});
	});
}

function assertBridgeUnavailable(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port });
		socket.once('connect', () => { socket.destroy(); reject(new Error('The released MCP bridge port accepted a connection.')); });
		socket.once('error', error => {
			if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') { resolve(); }
			else { reject(error); }
		});
	});
}

async function assertRejectsWithin(promise: Promise<unknown>, timeoutMs: number, message: string): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			assert.rejects(promise),
			new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs); }),
		]);
	} finally {
		if (timeout) { clearTimeout(timeout); }
	}
}

function readSuccessfulToolPayload(result: unknown, operation: string): Record<string, unknown> {
	const envelope = result as { isError?: boolean; structuredContent?: unknown; content?: unknown };
	assert.notEqual(envelope.isError, true, `${operation} returned an MCP tool error: ${JSON.stringify(envelope)}`);
	assert.ok(Array.isArray(envelope.content), `${operation} returned no MCP content blocks: ${JSON.stringify(envelope)}`);
	const textBlock = (envelope.content as Array<{ type?: unknown; text?: unknown }>).find(block => block.type === 'text' && typeof block.text === 'string');
	assert.ok(textBlock, `${operation} returned no text content block: ${JSON.stringify(envelope)}`);
	let textPayload: unknown;
	try { textPayload = JSON.parse(textBlock.text as string) as unknown; }
	catch (error) { assert.fail(`${operation} returned invalid JSON text content: ${String(error)}; payload=${String(textBlock.text)}`); }
	let payload = envelope.structuredContent;
	if (payload === undefined) { payload = textPayload; }
	else { assert.deepEqual(payload, textPayload, `${operation} structuredContent differs from its text payload`); }
	assert.ok(payload !== null && typeof payload === 'object' && !Array.isArray(payload), `${operation} returned an unexpected tool payload: ${JSON.stringify(payload)}`);
	return payload as Record<string, unknown>;
}

test('real MCP SDK client uses scoped loopback ports for all provider pairings and durable receipts', async () => {
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
				assert.deepEqual(toolList.tools.map(tool => tool.name), ['sessions_list', 'messages_send', 'messages_list', 'messages_ack', 'messages_wait', 'workflows_status', 'workflows_cancel']);
				const request = {
					name: 'messages_send',
					arguments: { recipientSessionId: receiver.id, idempotencyKey: `stable-${senderProvider}-${receiverProvider}`, body: 'Inspect this collaboration request.' },
				};
				const first = await senderClient.client.callTool(request);
				const duplicate = await senderClient.client.callTool(request);
				const firstPayload = readSuccessfulToolPayload(first, 'messages_send') as unknown as { message: { id: string; receiverAvailability: string } };
				const duplicatePayload = readSuccessfulToolPayload(duplicate, 'idempotent messages_send') as unknown as { message: { id: string } };
				assert.ok(firstPayload.message && typeof firstPayload.message.id === 'string', `messages_send returned an unexpected payload: ${JSON.stringify(firstPayload)}`);
				assert.equal(firstPayload.message.id, duplicatePayload.message.id);
				assert.equal(firstPayload.message.receiverAvailability, 'active');
				const page = await receiverClient.client.callTool({ name: 'messages_list', arguments: { afterSequence: 0, limit: 1 } });
				const pagePayload = readSuccessfulToolPayload(page, 'messages_list') as unknown as { messages: Array<{ id: string; senderSessionId: string; body: string }>; nextCursor: number };
				assert.equal(pagePayload.messages.length, 1);
				assert.equal(pagePayload.messages[0].senderSessionId, sender.id);
				assert.equal(pagePayload.messages[0].body, 'Inspect this collaboration request.');
				assert.ok(pagePayload.nextCursor > 0);
				await receiverClient.client.callTool({ name: 'messages_ack', arguments: { messageId: pagePayload.messages[0].id } });
				const acknowledged = await receiverClient.client.callTool({ name: 'messages_list', arguments: { afterSequence: 0, limit: 1 } });
				assert.ok((readSuccessfulToolPayload(acknowledged, 'acknowledged messages_list') as unknown as { messages: Array<{ readAt: string | null }> }).messages[0].readAt);
				if (senderProvider === 'codex' && receiverProvider === 'codex') {
					const offline = createSession(fixture, 'claude');
					const queued = await senderClient.client.callTool({ name: 'messages_send', arguments: {
						recipientSessionId: offline.id, idempotencyKey: 'offline-recipient', body: 'This remains queued for an offline session.',
					} });
					assert.equal((readSuccessfulToolPayload(queued, 'offline messages_send') as unknown as { message: { receiverAvailability: string } }).message.receiverAvailability, 'offline');
				}
			} finally {
				await closeOwnedMcpResources(pairClients, pairAccesses);
			}
		}
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('real MCP SDK exposes only scoped workflow status and cancel for its own session membership', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-mcp-workflow-tools-'));
	const fixture = createFixture(directory);
	const sender = fixture.database.agentSessions.createSession({
		projectId: fixture.project.id, bindingId: fixture.binding.id, taskId: fixture.task.id,
		name: 'Status owner', provider: 'codex', model: 'model-private-token', workspaceMode: 'sharedFolder',
	});
	const unrelated = createSession(fixture, 'claude');
	const ownWorkflow = createWorkflow(fixture, sender, READ_ONLY);
	const unrelatedWorkflow = createWorkflow(fixture, unrelated, READ_ONLY);
	const senderTurn = createTurn(fixture, sender, READ_ONLY);
	const foreignProject = fixture.database.createProject('Foreign MCP workflow');
	const foreignBinding = fixture.database.createFolderBinding({ projectId: foreignProject.id, path: fixture.root });
	const foreignTask = fixture.database.createTask({ projectId: foreignProject.id, bindingId: foreignBinding.id, title: 'Foreign task' });
	const foreignSession = fixture.database.agentSessions.createSession({
		projectId: foreignProject.id, bindingId: foreignBinding.id, taskId: foreignTask.id,
		name: 'Foreign session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder',
	});
	const foreignWorkflow = fixture.database.agentWorkflows.createWorkflow(foreignProject.id, {
		projectId: foreignProject.id, bindingId: foreignBinding.id, taskId: foreignTask.id,
		maxConcurrentNodes: 1, maxTotalTurns: 1, maxDurationMs: 60_000,
		nodes: [{ nodeId: 'foreign', sessionId: foreignSession.id, role: 'implementer', provider: 'codex', model: 'gpt-5-codex', taskId: foreignTask.id, bindingId: foreignBinding.id, referenceIds: [], permissionPolicy: READ_ONLY, dependsOn: [] }],
		idempotencyKey: randomUUID(),
	});
	const collaboration = new AgentSessionCollaborationService(fixture.database, {
		cancel: (projectId, workflowId, revision, key) => fixture.database.agentWorkflows.requestWorkflowCancellation(projectId, workflowId, revision, key),
		getHostError: () => 'launchFailed',
	});
	const bridge = new AgentSessionMcpBridge(collaboration);
	let access: Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>> | undefined;
	let client: Awaited<ReturnType<typeof openMcpClient>> | undefined;
	try {
		access = await bridge.issueAccess({ projectId: fixture.project.id, sessionId: sender.id, turnId: senderTurn.id, permissionPolicy: READ_ONLY, knownSecrets: ['model-private-token'] });
		await assertRejectsWithin(
			openMcpClient(access, 'invalid-test-capability', 1_500),
			2_000,
			'The real MCP SDK must observe gateway authentication failure within two seconds.',
		);
		client = await openMcpClient(access);
		const listed = await client.client.listTools();
		assert.deepEqual(listed.tools.map(tool => tool.name), ['sessions_list', 'messages_send', 'messages_list', 'messages_ack', 'messages_wait', 'workflows_status', 'workflows_cancel']);
		const statusResult = await client.client.callTool({ name: 'workflows_status', arguments: { workflowId: ownWorkflow.id } });
		const status = readSuccessfulToolPayload(statusResult, 'own workflows_status') as unknown as {
			workflow: { id: string; state: string };
			nodes: Array<{ role: string; provider: string; model: string }>;
			hostError: string | null;
		};
		assert.equal(status.workflow.id, ownWorkflow.id);
		assert.equal(status.workflow.state, 'waiting');
		assert.deepEqual(status.nodes.map(node => ({ role: node.role, provider: node.provider, model: node.model })), [{ role: 'implementer', provider: 'codex', model: '***' }]);
		assert.equal(status.hostError, 'launchFailed');
		assert.equal('fingerprint' in status.workflow, false);
		for (const workflowId of [unrelatedWorkflow.id, foreignWorkflow.id]) {
			const rejected = await client.client.callTool({ name: 'workflows_status', arguments: { workflowId } });
			assert.equal((rejected as { isError?: boolean }).isError, true);
		}
		const initialRevision = ownWorkflow.revision;
		const cancelRequest = { name: 'workflows_cancel', arguments: { workflowId: ownWorkflow.id, expectedRevision: initialRevision, idempotencyKey: 'own-cancel-1' } };
		const canceled = readSuccessfulToolPayload(await client.client.callTool(cancelRequest), 'workflows_cancel');
		assert.deepEqual(canceled, { workflowId: ownWorkflow.id, revision: initialRevision + 1, state: 'cancelled', cancellationRequested: true });
		assert.deepEqual(readSuccessfulToolPayload(await client.client.callTool(cancelRequest), 'idempotent workflows_cancel'), canceled);
		const changedKey = await client.client.callTool({ name: 'workflows_cancel', arguments: { workflowId: ownWorkflow.id, expectedRevision: initialRevision, idempotencyKey: 'own-cancel-2' } });
		assert.equal((changedKey as { isError?: boolean }).isError, true);
		access.revokeAccess();
		await assertRejectsWithin(
			client.client.callTool({ name: 'workflows_status', arguments: { workflowId: ownWorkflow.id } }),
			2_000,
			'An MCP tool call submitted after grant revocation must fail within two seconds.',
		);
	} finally {
		await closeOwnedMcpResources(client ? [client] : [], access ? [access] : []);
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('near-limit SQLite workflow returns a bounded durable cancellation receipt when full MCP status exceeds the frame', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-mcp-large-workflow-'));
	const fixture = createFixture(directory);
	const model = 'm';
	const sessions = Array.from({ length: 64 }, (_, index) => fixture.database.agentSessions.createSession({
		projectId: fixture.project.id, bindingId: fixture.binding.id, taskId: fixture.task.id,
		name: `Workflow node ${index.toString().padStart(2, '0')}`, provider: 'codex', model, workspaceMode: 'sharedFolder',
	}));
	const nodeIds = sessions.map((_, index) => `node-${index.toString().padStart(2, '0')}-${'x'.repeat(8)}`);
	const workflow = fixture.database.agentWorkflows.createWorkflow(fixture.project.id, {
		projectId: fixture.project.id, bindingId: fixture.binding.id, taskId: fixture.task.id,
		maxConcurrentNodes: 8, maxTotalTurns: 64, maxDurationMs: 60_000,
		nodes: sessions.map((session, index) => ({
			nodeId: nodeIds[index], sessionId: session.id, role: 'implementer', provider: 'codex', model,
			taskId: fixture.task.id, bindingId: fixture.binding.id, referenceIds: [], permissionPolicy: READ_ONLY,
			dependsOn: nodeIds.slice(0, index),
		})),
		idempotencyKey: randomUUID(),
	});
	const savedPlan = fixture.database.agentWorkflows.getPlan(fixture.project.id, workflow.id)!;
	const savedPlanBytes = Buffer.byteLength(JSON.stringify(savedPlan), 'utf8');
	assert.ok(savedPlanBytes > 50_000 && savedPlanBytes <= 65_536, 'the actual persisted plan must be near the store limit without exceeding it');
	const turn = createTurn(fixture, sessions[0], READ_ONLY);
	const collaboration = new AgentSessionCollaborationService(fixture.database, {
		cancel: (projectId, workflowId, revision, key) => fixture.database.agentWorkflows.requestWorkflowCancellation(projectId, workflowId, revision, key),
		getHostError: () => null,
	});
	const bridge = new AgentSessionMcpBridge(collaboration);
	let access: Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>> | undefined;
	let client: Awaited<ReturnType<typeof openMcpClient>> | undefined;
	try {
		access = await bridge.issueAccess({ projectId: fixture.project.id, sessionId: sessions[0].id, turnId: turn.id, permissionPolicy: READ_ONLY });
		client = await openMcpClient(access);
		const oversizedStatus = await client.client.callTool({ name: 'workflows_status', arguments: { workflowId: workflow.id } });
		assert.equal((oversizedStatus as { isError?: boolean }).isError, true);
		const canceled = readSuccessfulToolPayload(await client.client.callTool({
			name: 'workflows_cancel', arguments: { workflowId: workflow.id, expectedRevision: workflow.revision, idempotencyKey: 'large-plan-cancel' },
		}), 'large-plan workflows_cancel');
		assert.deepEqual(canceled, { workflowId: workflow.id, revision: workflow.revision + 1, state: 'cancelled', cancellationRequested: true });
		assert.equal(fixture.database.agentWorkflows.getWorkflow(fixture.project.id, workflow.id)?.state, 'cancelled');
	} finally {
		await closeOwnedMcpResources(client ? [client] : [], access ? [access] : []);
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
			const sentPayload = readSuccessfulToolPayload(sent, `messages_send large-page-${index}`);
			assert.equal((sentPayload.message as { body: string }).body, expectedBodies[index]);
		}
		const oversized = await senderClient.client.callTool({ name: 'messages_send', arguments: {
			recipientSessionId: receiver.id, idempotencyKey: 'unrepresentable-surrogate-text', body: '\ud800'.repeat(10_000),
		} });
		assert.equal(oversized.isError, true);
		assert.match(JSON.stringify(oversized.content), /cannot be represented/i);
		const sqlite = Reflect.get(fixture.database, 'db') as { prepare(sql: string): { all(...args: string[]): Array<Record<string, unknown>> } };
		assert.equal(sqlite.prepare('SELECT id FROM agent_session_messages WHERE idempotency_key = ?').all('unrepresentable-surrogate-text').length, 0);

		const received: Array<{ id: string; body: string; sequence: number }> = [];
		const waited = await receiverClient.client.callTool({ name: 'messages_wait', arguments: { afterSequence: 0, timeoutMs: 0, limit: 100 } });
		const waitPage = readSuccessfulToolPayload(waited, 'messages_wait') as unknown as { messages: Array<{ id: string; body: string; sequence: number }>; nextCursor: number };
		assert.ok(waitPage.messages.length > 0 && waitPage.messages.length < 7, 'wait results must be byte-paged within the response frame');
		assert.equal(waitPage.nextCursor, waitPage.messages.at(-1)!.sequence);
		received.push(...waitPage.messages);
		let cursor = waitPage.nextCursor;
		while (true) {
			const response = await receiverClient.client.callTool({ name: 'messages_list', arguments: { afterSequence: cursor, limit: 100 } });
			const page = readSuccessfulToolPayload(response, 'messages_list pagination') as unknown as { messages: Array<{ id: string; body: string; sequence: number }>; nextCursor: number };
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
		try { await closeOwnedMcpResources(clients, accesses); }
		finally {
			fixture.database.close();
			rmSync(directory, { recursive: true, force: true });
		}
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
		child = spawn(process.execPath, [GATEWAY_PATH, String(access.port)], {
			env: { PATH: process.env.PATH ?? '', [AGENT_SESSION_MCP_TOKEN_ENV]: access.gatewayEnvironment[AGENT_SESSION_MCP_TOKEN_ENV] },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const input = child.stdin;
		const output = child.stdout;
		assert.ok(input && output, 'Gateway fixture requires piped stdin and stdout.');
		let buffered = '';
		const lines: string[] = [];
		const readers: Array<(line: string) => void> = [];
		output.on('data', chunk => {
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
		input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'same-id', method: 'tools/call', params: { name: 'messages_wait', arguments: { timeoutMs: 30_000 } } })}\n`);
		const deadline = Date.now() + 2_000;
		while (Reflect.get(collaboration, 'activeWaiters') !== 1 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); }
		assert.equal(Reflect.get(collaboration, 'activeWaiters'), 1, 'first request must be pending before duplicate arrives');
		input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'same-id', method: 'tools/call', params: { name: 'messages_send', arguments: {
			recipientSessionId: receiver.id, idempotencyKey: 'must-not-send', body: 'Duplicate request must have no side effect.',
		} } })}\n`);
		const duplicate = JSON.parse(await readLine()) as { id: string; error?: { code: number; message: string } };
		assert.equal(duplicate.id, 'same-id');
		assert.equal(duplicate.error?.code, -32600);
		assert.match(duplicate.error?.message ?? '', /already in flight/i);
		const escapedLongId = '\\'.repeat(130);
		input.write(`${JSON.stringify({ jsonrpc: '2.0', id: escapedLongId, method: 'tools/call', params: { name: 'messages_send', arguments: {
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
		if (child && child.exitCode === null && child.signalCode === null) {
			const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
			child.kill('SIGTERM');
			const killTimer = setTimeout(() => { if (child!.exitCode === null && child!.signalCode === null) { child!.kill('SIGKILL'); } }, 1_000);
			try { await exited; }
			finally { clearTimeout(killTimer); }
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
		assert.ok(Number.isSafeInteger(access.port) && access.port >= 1 && access.port <= 65_535);
		assert.deepEqual(Object.keys(access.gatewayEnvironment), [AGENT_SESSION_MCP_TOKEN_ENV]);
		await assertBridgeDenied(access.port, 'wrong-capability');
		await assertUnauthenticatedConnectionTimesOut(access.port);
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
		await assertBridgeDenied(access.port, token);

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
		const receiverPort = receiverAccess.port;
		await receiverAccess.releasePrivateConfig();
		await assertBridgeUnavailable(receiverPort);
	} finally {
		try {
			await closeOwnedMcpResources([receiverClient, mcp].filter(client => client !== undefined), [receiverAccess, access].filter(item => item !== undefined));
		} finally {
			fixture.database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}
});
