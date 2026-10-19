/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import test from 'node:test';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { AGENT_PROVIDER_IDENTITY_PORT_ENV, AGENT_PROVIDER_IDENTITY_NONCE_ENV, AgentProviderIdentityReceiver, providerIdentityEnvironmentNames } from './agentProviderIdentity.js';

const helperPath = fileURLToPath(new URL('./agentProviderIdentityHook.mjs', import.meta.url));

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'agent-provider-identity-'));
	const root = join(directory, 'project');
	mkdirSync(root);
	const database = WorkspaceDatabase.open(':memory:');
	const project = database.createProject('Provider identity project');
	const binding = database.createFolderBinding({ projectId: project.id, path: root });
	const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Bind provider identity' });
	const session = database.agentSessions.createSession({
		projectId: project.id, bindingId: binding.id, taskId: task.id, name: 'Codex turn', provider: 'codex',
		model: 'gpt-5-codex', profileRef: 'local-codex-default', workspaceMode: 'sharedFolder',
	});
	const cwd = realpathSync(root);
	const stats = statSync(cwd, { bigint: true });
	const snapshot: AgentSessionTurnSnapshot = {
		schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision,
		bindingId: binding.id, taskId: task.id, provider: 'codex', model: session.model, profileRef: session.profileRef,
		cwd, folderIdentity: { canonicalPath: cwd, dev: stats.dev.toString(), ino: stats.ino.toString() },
		managedWorktreeOwnerId: null, permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [],
	};
	const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
	const receiver = new AgentProviderIdentityReceiver(database);
	return { directory, database, project, session, turn, receiver };
}

function runHook(port: number, nonce: string, input: unknown): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [helperPath], {
			env: { ...process.env, [AGENT_PROVIDER_IDENTITY_PORT_ENV]: String(port), [AGENT_PROVIDER_IDENTITY_NONCE_ENV]: nonce },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
		child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
		child.once('error', reject);
		child.once('close', code => resolve({ code, stdout, stderr }));
		child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
	});
}

function hookInput(sessionId: string, extra: Record<string, unknown> = {}) {
	return {
		session_id: sessionId, turn_id: randomUUID(), transcript_path: null, cwd: '/workspace',
		hook_event_name: 'UserPromptSubmit', model: 'gpt-5-codex', permission_mode: 'default', prompt: 'PRIVATE PROMPT', ...extra,
	};
}

function sendFrame(port: number, frame: unknown): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: '127.0.0.1', port });
		let response = '';
		socket.setTimeout(5000, () => socket.destroy(new Error('test socket timeout')));
		socket.once('connect', () => socket.end(`${JSON.stringify(frame)}\n`));
		socket.setEncoding('utf8').on('data', chunk => { response += chunk; });
		socket.once('error', reject);
		socket.once('close', () => resolve(response.trim()));
	});
}

function closeFixture(value: ReturnType<typeof fixture>): void {
	value.database.close();
	rmSync(value.directory, { recursive: true, force: true });
}

test('only a complete Codex receiver environment with its registered secret is allowed into a PTY', async () => {
	const value = fixture();
	let access: Awaited<ReturnType<typeof value.receiver.issue>> | undefined;
	try {
		access = await value.receiver.issue({ projectId: value.project.id, sessionId: value.session.id, turnId: value.turn.id, expectedConversationId: null, onIdentityMismatch: () => assert.fail('No identity event is sent by this test') });
		const nonce = access.nonce;
		const environment = { [AGENT_PROVIDER_IDENTITY_PORT_ENV]: String(access.port), [AGENT_PROVIDER_IDENTITY_NONCE_ENV]: nonce };
		assert.deepEqual(providerIdentityEnvironmentNames('codex', environment, [nonce], []), Object.keys(environment));
		assert.deepEqual(providerIdentityEnvironmentNames('codex', {}, [], []), []);
		assert.deepEqual(providerIdentityEnvironmentNames('claude', {}, [], []), []);
		assert.throws(() => providerIdentityEnvironmentNames('claude', environment, [nonce], []), /provider identity environment/);
		assert.throws(() => providerIdentityEnvironmentNames('codex', environment, [], []), /provider identity environment/);
		for (const name of [AGENT_PROVIDER_IDENTITY_PORT_ENV, AGENT_PROVIDER_IDENTITY_NONCE_ENV]) {
			assert.throws(() => providerIdentityEnvironmentNames('codex', environment, [nonce], [name]), /provider identity environment/);
			assert.throws(() => providerIdentityEnvironmentNames('codex', {}, [], [name]), /provider identity environment/);
		}
		for (const invalid of [
			{ [AGENT_PROVIDER_IDENTITY_PORT_ENV]: String(access.port) }, { [AGENT_PROVIDER_IDENTITY_NONCE_ENV]: nonce },
			{ [AGENT_PROVIDER_IDENTITY_PORT_ENV]: undefined, [AGENT_PROVIDER_IDENTITY_NONCE_ENV]: undefined },
			...['0', '65536', '043210', '+43210', '43210\n'].map(port => ({ ...environment, [AGENT_PROVIDER_IDENTITY_PORT_ENV]: port })),
			{ ...environment, [AGENT_PROVIDER_IDENTITY_NONCE_ENV]: 'invalid' },
		]) {
			assert.throws(() => providerIdentityEnvironmentNames('codex', invalid, [nonce], []), /provider identity environment/);
		}
	} finally {
		if (access) { assert.equal((await access.close()).complete, true); }
		closeFixture(value);
	}
});

test('root UserPromptSubmit persists only the UUID; child events are ignored and duplicate identity is idempotent', async () => {
	const value = fixture();
	let mismatches = 0;
	let access: Awaited<ReturnType<typeof value.receiver.issue>> | undefined;
	try {
		access = await value.receiver.issue({
			projectId: value.project.id, sessionId: value.session.id, turnId: value.turn.id,
			expectedConversationId: null, onIdentityMismatch: () => { mismatches++; },
		});
		const child = await runHook(access.port, access.nonce, hookInput(randomUUID(), { agent_id: randomUUID(), agent_type: 'worker', prompt: 'DO NOT STORE child prompt' }));
		assert.equal(child.code, 0);
		assert.equal(value.database.agentSessionTurns.getTurn(value.project.id, value.session.id, value.turn.id)?.providerConversationId, null);

		const conversationId = randomUUID();
		const rootInput = hookInput(conversationId, { agent_type: null, prompt: 'DO NOT STORE root prompt', transcript_path: '/private/transcript.jsonl', unknown_provider_metadata: 'PRIVATE UNKNOWN METADATA' });
		const first = await runHook(access.port, access.nonce, rootInput);
		assert.equal(first.code, 0);
		assert.equal(first.stdout, '');
		const saved = value.database.agentSessionTurns.getTurn(value.project.id, value.session.id, value.turn.id);
		assert.equal(saved?.providerConversationId, conversationId);
		assert.equal(JSON.stringify(saved).includes('DO NOT STORE'), false);
		assert.equal(JSON.stringify(saved).includes('transcript.jsonl'), false);
		assert.equal(JSON.stringify(saved).includes('PRIVATE UNKNOWN METADATA'), false);
		assert.equal((await runHook(access.port, access.nonce, rootInput)).code, 0);
		assert.equal(value.database.agentSessionTurns.getTurn(value.project.id, value.session.id, value.turn.id)?.revision, saved?.revision);
		assert.equal(mismatches, 0);
	} finally {
		if (access) { assert.equal((await access.close()).complete, true); }
		closeFixture(value);
	}
});

test('known resumed identity mismatch is rejected and reported without rebinding or stopping the turn', async () => {
	const value = fixture();
	const expected = randomUUID();
	const known = value.database.agentSessionTurns.recordProviderConversationId(value.project.id, value.session.id, value.turn.id, value.turn.revision, expected);
	let mismatches = 0;
	let access: Awaited<ReturnType<typeof value.receiver.issue>> | undefined;
	try {
		access = await value.receiver.issue({
			projectId: value.project.id, sessionId: value.session.id, turnId: value.turn.id,
			expectedConversationId: expected, onIdentityMismatch: () => { mismatches++; },
		});
		const input = hookInput(randomUUID(), { prompt: 'PRIVATE MISMATCH PROMPT' });
		const result = await runHook(access.port, access.nonce, input);
		assert.equal(result.code, 2);
		assert.equal(mismatches, 1);
		const after = value.database.agentSessionTurns.getTurn(value.project.id, value.session.id, value.turn.id);
		assert.equal(after?.providerConversationId, expected);
		assert.equal(after?.revision, known.revision);
		assert.equal(after?.state, 'starting');
		assert.equal(JSON.stringify(after).includes('PRIVATE MISMATCH'), false);
	} finally {
		if (access) { assert.equal((await access.close()).complete, true); }
		closeFixture(value);
	}
});

test('receiver rejects invalid nonce and oversized frames, times out incomplete connections, and closes its listener', async () => {
	const value = fixture();
	const access = await value.receiver.issue({
		projectId: value.project.id, sessionId: value.session.id, turnId: value.turn.id,
		expectedConversationId: null, onIdentityMismatch: () => { throw new Error('unexpected mismatch'); },
	});
	try {
		const wrongNonce = `${access.nonce.slice(0, -1)}${access.nonce.endsWith('A') ? 'B' : 'A'}`;
		assert.equal(await sendFrame(access.port, { nonce: wrongNonce, sessionId: randomUUID() }), '{"ok":false}');
		await new Promise<void>((resolve, reject) => {
			const socket = net.createConnection({ host: '127.0.0.1', port: access.port });
			socket.once('error', error => {
				if (error.message.includes('ECONNRESET')) { resolve(); }
				else { reject(error); }
			});
			socket.once('connect', () => socket.write(`${'x'.repeat(4097)}\n`));
			socket.once('close', () => resolve());
		});
		await new Promise<void>((resolve, reject) => {
			const socket = net.createConnection({ host: '127.0.0.1', port: access.port });
			socket.once('error', error => {
				if (error.message.includes('ECONNRESET')) { resolve(); }
				else { reject(error); }
			});
			socket.once('connect', () => socket.once('close', () => resolve()));
		});
		access.revokeAccess();
		const revokedResponse = await sendFrame(access.port, { nonce: access.nonce, sessionId: randomUUID() }).catch((error: NodeJS.ErrnoException) => {
			assert.equal(error.code, 'ECONNRESET');
			return '';
		});
		assert.equal(revokedResponse, '');
		assert.equal(value.database.agentSessionTurns.getTurn(value.project.id, value.session.id, value.turn.id)?.providerConversationId, null);
		const receipt = await access.close();
		assert.deepEqual(receipt, { complete: true, listenerClosed: true, connectionsClosed: true });
		await assert.rejects(sendFrame(access.port, { nonce: access.nonce, sessionId: randomUUID() }), { code: 'ECONNREFUSED' });
		assert.deepEqual(await access.close(), receipt);
	} finally {
		await access.close();
		closeFixture(value);
	}
});

test('receiver accepts more than 256 serial active receipts and rejects a duplicate after its turn ends', async () => {
	const value = fixture();
	const access = await value.receiver.issue({
		projectId: value.project.id, sessionId: value.session.id, turnId: value.turn.id,
		expectedConversationId: null, onIdentityMismatch: () => { throw new Error('unexpected mismatch'); },
	});
	try {
		const conversationId = randomUUID();
		const frame = { nonce: access.nonce, sessionId: conversationId };
		for (let index = 0; index < 260; index++) {
			assert.equal(await sendFrame(access.port, frame), '{"ok":true}', `receipt ${index + 1} should be accepted`);
		}
		const current = value.database.agentSessionTurns.getTurn(value.project.id, value.session.id, value.turn.id)!;
		const session = value.database.agentSessions.getSession(value.project.id, value.session.id)!;
		const running = value.database.agentSessionTurns.transitionTurn(value.project.id, value.session.id, value.turn.id,
			current.revision, session.revision, { state: 'running' });
		value.database.agentSessionTurns.transitionTurn(value.project.id, value.session.id, value.turn.id,
			running.turn.revision, running.session.revision, { state: 'exited', exitCode: 0, cleanupVerified: true });
		assert.equal(await sendFrame(access.port, frame), '{"ok":false}');
	} finally {
		assert.equal((await access.close()).complete, true);
		closeFixture(value);
	}
});

test('hook rejects oversized stdin with its generic failure code and emits no stdout metadata', async () => {
	const oversized = `${' '.repeat(1024 * 1024 + 1)}`;
	const value = await runHook(12345, 'A'.repeat(43), oversized);
	assert.equal(value.code, 2);
	assert.equal(value.stdout, '');
	assert.match(value.stderr, /input-too-large/);
});
