/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionPermissionPolicy, AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { AgentSessionCollaborationService } from './agentSessionCollaborationService.js';

const POLICY: AgentSessionPermissionPolicy = { mode: 'mutating', approval: 'on-request' };
const READ_ONLY: AgentSessionPermissionPolicy = { mode: 'read-only', approval: 'never' };

function createFixture(directory: string, databasePath = ':memory:') {
	const root = join(directory, 'workspace');
	mkdirSync(root, { recursive: true });
	const database = WorkspaceDatabase.open(databasePath);
	const project = database.createProject('Collaboration test');
	const binding = database.createFolderBinding({ projectId: project.id, path: realpathSync(root) });
	const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Coordinate sessions' });
	return { database, project, binding, task, root: realpathSync(root) };
}

function createSession(fixture: ReturnType<typeof createFixture>, provider: 'codex' | 'claude') {
	return fixture.database.agentSessions.createSession({
		projectId: fixture.project.id,
		bindingId: fixture.binding.id,
		taskId: fixture.task.id,
		name: `${provider} session`, provider, model: provider === 'codex' ? 'gpt-5-codex' : 'sonnet', workspaceMode: 'sharedFolder',
	});
}

function createTurn(fixture: ReturnType<typeof createFixture>, session: ReturnType<typeof createSession>, permissionPolicy = POLICY) {
	const stats = statSync(fixture.root, { bigint: true });
	const snapshot: AgentSessionTurnSnapshot = {
		schemaVersion: 1,
		projectId: fixture.project.id,
		sessionId: session.id,
		sessionRevision: session.revision,
		bindingId: fixture.binding.id,
		taskId: fixture.task.id,
		provider: session.provider,
		model: session.model,
		profileRef: session.profileRef,
		cwd: fixture.root,
		folderIdentity: { canonicalPath: fixture.root, dev: stats.dev.toString(), ino: stats.ino.toString() },
		managedWorktreeOwnerId: null,
		permissionPolicy,
		convention: null,
		references: [],
	};
	return fixture.database.agentSessionTurns.createTurn({ projectId: fixture.project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
}

function authorize(collaboration: AgentSessionCollaborationService, fixture: ReturnType<typeof createFixture>, session: ReturnType<typeof createSession>, turn: ReturnType<typeof createTurn>, knownSecrets: readonly string[] = [], permissionPolicy = POLICY) {
	return collaboration.authorizeTurn({
		projectId: fixture.project.id, sessionId: session.id, turnId: turn.id, permissionPolicy, knownSecrets,
	});
}

test('shared collaboration service derives identities, redacts before persistence, and serves all provider pairings', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-collaboration-'));
	const fixture = createFixture(directory);
	try {
		const collaboration = new AgentSessionCollaborationService(fixture.database);
		for (const [senderProvider, receiverProvider] of [['codex', 'codex'], ['codex', 'claude'], ['claude', 'codex'], ['claude', 'claude']] as const) {
			const sender = createSession(fixture, senderProvider);
			const receiver = createSession(fixture, receiverProvider);
			const senderTurn = createTurn(fixture, sender);
			const receiverTurn = createTurn(fixture, receiver);
			const secret = `launch-secret-${senderProvider}-${receiverProvider}`;
			const senderGrant = collaboration.authorizeTurn({ projectId: fixture.project.id, sessionId: sender.id, turnId: senderTurn.id, permissionPolicy: POLICY, knownSecrets: [secret] });
			const receiverGrant = collaboration.authorizeTurn({ projectId: fixture.project.id, sessionId: receiver.id, turnId: receiverTurn.id, permissionPolicy: POLICY, knownSecrets: [secret] });
			const sessions = collaboration.listSessions(senderGrant);
			assert.ok(sessions.some(item => item.id === receiver.id));
			const input = { recipientSessionId: receiver.id, idempotencyKey: `request-${senderProvider}-${receiverProvider}`, body: `please inspect ${secret}` };
			const message = collaboration.sendMessage(senderGrant, input);
			assert.equal(message.body, 'please inspect ***');
			assert.equal(message.redacted, true);
			assert.equal(message.receiverAvailability, 'active');
			assert.deepEqual(collaboration.sendMessage(senderGrant, input), message);
			const page = collaboration.listMessages(receiverGrant, { afterSequence: 0, limit: 1 });
			assert.equal(page.messages.length, 1);
			assert.equal(page.messages[0].senderSessionId, sender.id);
			assert.equal(page.messages[0].body, 'please inspect ***');
			assert.equal(page.nextCursor, message.sequence);
			collaboration.acknowledgeMessage(receiverGrant, message.id);
			assert.ok(collaboration.listMessages(receiverGrant).messages[0].readAt);
			collaboration.revoke(senderGrant);
			assert.throws(() => collaboration.listSessions(senderGrant), /revoked|invalid/i);
			collaboration.revoke(receiverGrant);
		}
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('revocation cancels a durable mailbox wait and a terminal turn cannot retain access', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-collaboration-wait-'));
	const fixture = createFixture(directory);
	try {
		const collaboration = new AgentSessionCollaborationService(fixture.database);
		const session = createSession(fixture, 'codex');
		const turn = createTurn(fixture, session);
		const grant = authorize(collaboration, fixture, session, turn);
		const waiting = collaboration.waitForMessages(grant, { afterSequence: 0, timeoutMs: 30_000 });
		assert.equal((Reflect.get(collaboration, 'changeListeners') as Set<() => void>).size, 1, 'wait must be registered before revocation');
		collaboration.revoke(grant);
		await assert.rejects(waiting, /cancelled because access was revoked/i);
		assert.throws(() => collaboration.listMessages(grant), /revoked|invalid/i);

		const currentSession = fixture.database.agentSessions.getSession(fixture.project.id, session.id)!;
		const firstRunning = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, session.id, turn.id, turn.revision, currentSession.revision, { state: 'running' });
		const firstEnded = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, session.id, turn.id, firstRunning.turn.revision, firstRunning.session.revision, { state: 'exited', exitCode: 0, cleanupVerified: true });
		const idleSession = fixture.database.agentSessions.getSession(fixture.project.id, session.id)!;
		const nextTurn = createTurn(fixture, idleSession);
		const nextGrant = authorize(collaboration, fixture, idleSession, nextTurn);
		const running = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, session.id, nextTurn.id, nextTurn.revision, firstEnded.session.revision + 1, { state: 'running' });
		fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, session.id, running.turn.id, running.turn.revision, running.session.revision, { state: 'exited', exitCode: 0, cleanupVerified: true });
		assert.throws(() => collaboration.listSessions(nextGrant), /ended|revoked|invalid/i);
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('complete mailbox records preserve a harmless secret prefix while masking and rejecting full secrets', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-complete-record-'));
	const fixture = createFixture(directory);
	try {
		const sender = createSession(fixture, 'codex');
		const receiver = createSession(fixture, 'claude');
		const turn = createTurn(fixture, sender);
		const collaboration = new AgentSessionCollaborationService(fixture.database);
		const secret = '6scoped-bridge-fixture';
		const grant = authorize(collaboration, fixture, sender, turn, [secret]);
		const input = { recipientSessionId: receiver.id, idempotencyKey: 'large-page-6', body: 'ordinary text ending 6' };
		const sent = collaboration.sendMessage(grant, input);
		assert.equal(sent.body, input.body);
		assert.equal(collaboration.sendMessage(grant, input).id, sent.id);
		const masked = collaboration.sendMessage(grant, { recipientSessionId: receiver.id, idempotencyKey: 'full-secret-body', body: secret });
		assert.equal(masked.body, '***');
		assert.throws(() => collaboration.sendMessage(grant, { recipientSessionId: receiver.id, idempotencyKey: secret, body: 'must not persist' }), /key contains a trusted secret/i);
		assert.deepEqual(fixture.database.agentSessions.listInbox(fixture.project.id, receiver.id, { limit: 10 }).map(message => message.body), [input.body, '***']);
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('mailbox survives database restart while launch capabilities remain process-local', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-collaboration-reopen-'));
	const databasePath = join(directory, 'workspace.db');
	let fixture = createFixture(directory, databasePath);
	try {
		const sender = createSession(fixture, 'codex');
		const receiver = createSession(fixture, 'claude');
		const senderTurn = createTurn(fixture, sender);
		createTurn(fixture, receiver);
		const token = 'opaque-memory-only-capability';
		const collaboration = new AgentSessionCollaborationService(fixture.database);
		const grant = collaboration.authorizeTurn({ projectId: fixture.project.id, sessionId: sender.id, turnId: senderTurn.id, permissionPolicy: POLICY, knownSecrets: [token] });
		const sent = collaboration.sendMessage(grant, { recipientSessionId: receiver.id, idempotencyKey: 'restart-key', body: 'persist this mailbox item' });
		collaboration.revoke(grant);
		const sqlite = Reflect.get(fixture.database, 'db') as { prepare(sql: string): { all(): Array<Record<string, unknown>> } };
		const persistedRows = sqlite.prepare('SELECT body, idempotency_key FROM agent_session_messages').all();
		assert.deepEqual(persistedRows.map(row => ({ body: row.body, idempotency_key: row.idempotency_key })), [{ body: 'persist this mailbox item', idempotency_key: 'restart-key' }]);
		fixture.database.close();
		fixture = { ...fixture, database: WorkspaceDatabase.open(databasePath) };
		assert.equal(fixture.database.agentSessions.listInbox(fixture.project.id, receiver.id, { limit: 10 })[0].id, sent.id);
		assert.equal(fixture.database.agentSessions.listInbox(fixture.project.id, receiver.id, { limit: 10 })[0].body, sent.body);
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('workflow status is database-backed without a host and cancellation is explicitly unavailable', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-workflow-status-'));
	const fixture = createFixture(directory);
	try {
		const session = createSession(fixture, 'codex');
		const workflow = fixture.database.agentWorkflows.createWorkflow(fixture.project.id, {
			projectId: fixture.project.id, bindingId: fixture.binding.id, taskId: fixture.task.id,
			maxConcurrentNodes: 1, maxTotalTurns: 1, maxDurationMs: 60_000,
			nodes: [{ nodeId: 'implement', sessionId: session.id, role: 'implementer', provider: session.provider, model: session.model, taskId: fixture.task.id, bindingId: fixture.binding.id, referenceIds: [], permissionPolicy: READ_ONLY, dependsOn: [] }],
			idempotencyKey: 'workflow-status-create',
		});
		const turn = createTurn(fixture, session, READ_ONLY);
		const collaboration = new AgentSessionCollaborationService(fixture.database);
		const grant = authorize(collaboration, fixture, session, turn, [], READ_ONLY);
		const status = collaboration.getWorkflowStatus(grant, workflow.id);
		assert.equal(status.workflow.id, workflow.id);
		assert.equal(status.workflow.state, 'waiting');
		assert.equal(status.nodes[0].state, 'notStarted');
		assert.equal(status.hostError, null);
		assert.throws(() => collaboration.cancelWorkflow(grant, { workflowId: workflow.id, expectedRevision: workflow.revision, idempotencyKey: 'workflow-status-cancel' }), /unavailable/i);
		collaboration.revoke(grant);
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('workflow cancellation returns its durable receipt if the host synchronously revokes the caller grant', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-workflow-cancel-revoke-'));
	const fixture = createFixture(directory);
	try {
		const session = createSession(fixture, 'codex');
		const workflow = fixture.database.agentWorkflows.createWorkflow(fixture.project.id, {
			projectId: fixture.project.id, bindingId: fixture.binding.id, taskId: fixture.task.id,
			maxConcurrentNodes: 1, maxTotalTurns: 1, maxDurationMs: 60_000,
			nodes: [{ nodeId: 'implement', sessionId: session.id, role: 'implementer', provider: session.provider, model: session.model, taskId: fixture.task.id, bindingId: fixture.binding.id, referenceIds: [], permissionPolicy: READ_ONLY, dependsOn: [] }],
			idempotencyKey: 'workflow-revoke-create',
		});
		const turn = createTurn(fixture, session, READ_ONLY);
		let grant: ReturnType<typeof authorize> | undefined;
		let collaboration!: AgentSessionCollaborationService;
		collaboration = new AgentSessionCollaborationService(fixture.database, {
			cancel: (projectId, workflowId, revision, key) => {
				const canceled = fixture.database.agentWorkflows.requestWorkflowCancellation(projectId, workflowId, revision, key);
				if (grant) { collaboration.revoke(grant); }
				return canceled;
			},
			getHostError: () => null,
		});
		grant = authorize(collaboration, fixture, session, turn, [], READ_ONLY);
		const receipt = collaboration.cancelWorkflow(grant, { workflowId: workflow.id, expectedRevision: workflow.revision, idempotencyKey: 'workflow-revoke-cancel' });
		assert.deepEqual(receipt, { workflowId: workflow.id, revision: workflow.revision + 1, state: 'cancelled', cancellationRequested: true });
		assert.throws(() => collaboration.getWorkflowStatus(grant!, workflow.id), /revoked|invalid/i);
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
