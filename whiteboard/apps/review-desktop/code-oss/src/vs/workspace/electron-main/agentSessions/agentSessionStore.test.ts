/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import type { AgentSessionState, CreateAgentSessionInput } from '../../common/workspaceAgentSessionProtocol.js';

function withDatabase(run: (database: WorkspaceDatabase) => void): void {
	const database = WorkspaceDatabase.open(':memory:');
	try { run(database); }
	finally { database.close(); }
}

function projectFixture(database: WorkspaceDatabase, name = 'Session project') {
	const project = database.createProject(name);
	const binding = database.createFolderBinding({ projectId: project.id, path: `/work/${name.toLowerCase().replaceAll(' ', '-')}` });
	const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Coordinate agent sessions' });
	return { project, binding, task };
}

function sessionInput(projectId: string, bindingId: string, overrides: Partial<CreateAgentSessionInput> = {}): CreateAgentSessionInput {
	return {
		projectId, bindingId, name: 'Implementation', provider: 'codex', model: 'gpt-5-codex',
		workspaceMode: 'gitWorktree', ...overrides,
	};
}

const SESSION_TRANSITIONS: Readonly<Record<AgentSessionState, readonly AgentSessionState[]>> = {
	created: ['starting', 'stopped', 'failed'],
	starting: ['running', 'waitingForInput', 'waitingForApproval', 'idle', 'stopping', 'stopped', 'interrupted', 'failed'],
	running: ['waitingForInput', 'waitingForApproval', 'idle', 'stopping', 'stopped', 'interrupted', 'failed'],
	waitingForInput: ['running', 'idle', 'stopping', 'stopped', 'interrupted', 'failed'],
	waitingForApproval: ['running', 'idle', 'stopping', 'stopped', 'interrupted', 'failed'],
	idle: ['starting', 'running', 'stopping', 'stopped', 'interrupted', 'failed'],
	stopping: ['stopped', 'interrupted', 'failed'],
	stopped: [],
	interrupted: ['starting', 'stopping', 'stopped', 'failed'],
	failed: ['starting', 'stopped'],
};

function transitionPath(target: AgentSessionState): AgentSessionState[] {
	const queue: Array<{ state: AgentSessionState; path: AgentSessionState[] }> = [{ state: 'created', path: [] }];
	const visited = new Set<AgentSessionState>(['created']);
	while (queue.length) {
		const current = queue.shift()!;
		if (current.state === target) { return current.path; }
		for (const next of SESSION_TRANSITIONS[current.state]) {
			if (!visited.has(next)) {
				visited.add(next);
				queue.push({ state: next, path: [...current.path, next] });
			}
		}
	}
	throw new Error(`No valid session transition path to ${target}.`);
}

test('session identities and mailbox persist across database reopen', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-reopen-'));
	const path = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(path);
	const { project, binding } = projectFixture(database);
	const sender = database.agentSessions.createSession(sessionInput(project.id, binding.id));
	const receiver = database.agentSessions.createSession(sessionInput(project.id, binding.id, { provider: 'claude', model: 'sonnet' }));
	const message = database.agentSessions.sendMessage(project.id, sender.id, {
		recipientSessionId: receiver.id, idempotencyKey: 'request-1', body: 'Review the database migration.',
	});
	const notification = database.agentSessions.listNotifications(project.id, { limit: 10 })[0];
	assert.deepEqual(notification.target, { kind: 'message', id: message.id });
	assert.equal(notification.eventId, `message:${message.id}`);
	database.close();
	try {
		database = WorkspaceDatabase.open(path);
		assert.deepEqual(database.agentSessions.getSession(project.id, sender.id), sender);
		assert.deepEqual(database.agentSessions.listInbox(project.id, receiver.id, { limit: 10 }), [message]);
		assert.deepEqual(database.agentSessions.listNotifications(project.id, { limit: 10 }), [notification]);
		database.agentSessions.markNotificationRead(project.id, notification.id);
		database.close();
		database = WorkspaceDatabase.open(path);
		assert.ok(database.agentSessions.listNotifications(project.id, { limit: 10 })[0].readAt);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('schema v21 migrates in place and preserves existing project tasks', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-v21-'));
	const path = join(directory, 'workspace.db');
	const legacy = new DatabaseSync(path);
	try {
		legacy.exec(readFileSync(new URL('./fixtures/workspace-v21.sql', import.meta.url), 'utf8'));
		assert.equal(Number(legacy.prepare('PRAGMA user_version').get()?.user_version), 21);
	} finally { legacy.close(); }
	const database = WorkspaceDatabase.open(path);
	try {
		assert.equal(database.getProject('00000000-0000-4000-8000-000000000021')?.name, 'Frozen v21 project');
		const preservedTask = database.getTask('00000000-0000-4000-8000-000000000023');
		assert.deepEqual({
			id: preservedTask?.id,
			projectId: preservedTask?.projectId,
			bindingId: preservedTask?.bindingId,
			title: preservedTask?.title,
			revision: preservedTask?.revision,
		}, {
			id: '00000000-0000-4000-8000-000000000023',
			projectId: '00000000-0000-4000-8000-000000000021',
			bindingId: '00000000-0000-4000-8000-000000000022',
			title: 'Preserved v21 task',
			revision: 4,
		});
		assert.deepEqual(database.agentSessions.listSessions('00000000-0000-4000-8000-000000000021'), []);
		assert.equal(Number((Reflect.get(database, 'db') as DatabaseSync).prepare('PRAGMA user_version').get()?.user_version), 33);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('frozen schema v22 migrates through v32 and preserves existing project and task data', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-v22-'));
	const path = join(directory, 'workspace.db');
	const legacy = new DatabaseSync(path);
	try {
		legacy.exec(readFileSync(new URL('./fixtures/workspace-v22.sql', import.meta.url), 'utf8'));
		assert.equal(Number(legacy.prepare('PRAGMA user_version').get()?.user_version), 22);
	} finally { legacy.close(); }
	const database = WorkspaceDatabase.open(path);
	try {
		assert.equal(database.getProject('00000000-0000-4000-8000-000000000021')?.name, 'Frozen v21 project');
		assert.equal(database.getTask('00000000-0000-4000-8000-000000000023')?.title, 'Preserved v21 task');
		assert.deepEqual(database.agentSessions.listSessions('00000000-0000-4000-8000-000000000021'), []);
		assert.equal(Number((Reflect.get(database, 'db') as DatabaseSync).prepare('PRAGMA user_version').get()?.user_version), 33);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('all Codex and Claude session pairings exchange and acknowledge messages', () => {
	withDatabase(database => {
		for (const [senderProvider, recipientProvider] of [
			['codex', 'codex'], ['codex', 'claude'], ['claude', 'claude'],
		] as const) {
			const { project, binding } = projectFixture(database, `${senderProvider}-${recipientProvider}`);
			const sender = database.agentSessions.createSession(sessionInput(project.id, binding.id, { provider: senderProvider }));
			const recipient = database.agentSessions.createSession(sessionInput(project.id, binding.id, { provider: recipientProvider }));
			const message = database.agentSessions.sendMessage(project.id, sender.id, {
				recipientSessionId: recipient.id, idempotencyKey: randomUUID(), body: 'Pairing works.',
			});
			assert.equal(database.agentSessions.listInbox(project.id, recipient.id, { limit: 10 })[0].id, message.id);
			database.agentSessions.acknowledgeMessage(project.id, recipient.id, message.id);
			assert.ok(database.agentSessions.listInbox(project.id, recipient.id, { limit: 10 })[0].readAt);
		}
	});
});

test('durable message notifications retain the legacy message reference restriction while allowing read acknowledgements', () => {
	withDatabase(database => {
		const { project, binding } = projectFixture(database);
		const sender = database.agentSessions.createSession(sessionInput(project.id, binding.id));
		const recipient = database.agentSessions.createSession(sessionInput(project.id, binding.id, { provider: 'claude', model: 'sonnet' }));
		const message = database.agentSessions.sendMessage(project.id, sender.id, { recipientSessionId: recipient.id, idempotencyKey: 'reference-guard', body: 'Keep my durable reference.' });
		const notification = database.agentSessions.listNotifications(project.id, { limit: 10 })[0];
		const db = Reflect.get(database, 'db') as DatabaseSync;
		assert.throws(() => db.prepare('DELETE FROM agent_session_messages WHERE id = ?').run(message.id), /referenced by a durable session notification/u);
		assert.throws(() => db.prepare('UPDATE agent_session_messages SET id = ? WHERE id = ?').run(randomUUID(), message.id), /identity or recipient is still referenced by a durable session notification/u);
		assert.throws(() => db.prepare('UPDATE agent_session_messages SET recipient_session_id = ? WHERE id = ?').run(sender.id, message.id), /identity or recipient is still referenced by a durable session notification/u);
		const otherProject = database.createProject('Other notification scope');
		assert.throws(() => db.prepare('UPDATE agent_session_messages SET project_id = ? WHERE id = ?').run(otherProject.id, message.id), /identity or recipient is still referenced by a durable session notification/u);
		database.agentSessions.acknowledgeMessage(project.id, recipient.id, message.id);
		assert.ok(database.agentSessions.getInboxMessage(project.id, recipient.id, message.id)?.readAt);
		database.agentSessions.markNotificationRead(project.id, notification.id);
		assert.ok(database.agentSessions.listNotifications(project.id, { limit: 10 })[0].readAt);
		const unreferencedMessageId = randomUUID();
		db.prepare(`INSERT INTO agent_session_messages
			(id, project_id, sender_session_id, recipient_session_id, sequence, idempotency_key, body, created_at, read_at)
			VALUES (?, ?, ?, ?, 2, ?, ?, ?, NULL)`).run(unreferencedMessageId, project.id, sender.id, recipient.id, 'unreferenced-message', 'No notification references this message.', new Date().toISOString());
		assert.equal(Number(db.prepare('UPDATE agent_session_messages SET recipient_session_id = ? WHERE id = ?').run(sender.id, unreferencedMessageId).changes), 1,
			'An unrelated message without a notification reference keeps the legacy update behavior.');
		assert.equal(Number(db.prepare('DELETE FROM agent_session_messages WHERE id = ?').run(unreferencedMessageId).changes), 1,
			'An unrelated message without a notification reference keeps the legacy delete behavior.');
	});
});

test('same idempotency key and same body returns one message and one notification; changed request rejects', () => {
	withDatabase(database => {
		const { project, binding } = projectFixture(database);
		const sender = database.agentSessions.createSession(sessionInput(project.id, binding.id));
		const recipient = database.agentSessions.createSession(sessionInput(project.id, binding.id, { provider: 'claude', model: 'sonnet' }));
		const request = { recipientSessionId: recipient.id, idempotencyKey: 'stable-key', body: 'Same bytes.' };
		const first = database.agentSessions.sendMessage(project.id, sender.id, request);
		assert.deepEqual(database.agentSessions.sendMessage(project.id, sender.id, request), first);
		assert.throws(() => database.agentSessions.sendMessage(project.id, sender.id, { ...request, body: 'Changed bytes.' }), /idempotency/i);
		assert.throws(() => database.agentSessions.sendMessage(project.id, sender.id, { ...request, recipientSessionId: sender.id }), /idempotency/i);
		assert.equal(database.agentSessions.listInbox(project.id, recipient.id, { limit: 10 }).length, 1);
		assert.equal(database.agentSessions.listNotifications(project.id, { limit: 10 }).length, 1);
	});
});

test('waiting session states create durable typed alerts from state transitions', () => {
	withDatabase(database => {
		const { project, binding } = projectFixture(database);
		let session = database.agentSessions.createSession(sessionInput(project.id, binding.id));
		session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'starting');
		session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'waitingForInput');
		session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'running');
		session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'waitingForApproval');
		const alerts = database.agentSessions.listNotifications(project.id, { limit: 10 });
		assert.deepEqual(alerts.map(item => item.kind), ['input', 'approval']);
		assert.deepEqual(alerts.map(item => item.target), [{ kind: 'session', id: session.id }, { kind: 'session', id: session.id }]);
	});
});

test('notification retries preserve generated timestamps but reject changed explicit timestamps', () => {
	withDatabase(database => {
		const { project, binding } = projectFixture(database);
		const session = database.agentSessions.createSession(sessionInput(project.id, binding.id));
		const event = { eventId: `session:${session.id}:manual-time`, projectId: project.id, sessionId: session.id, kind: 'input' as const,
			target: { kind: 'session' as const, id: session.id } };
		const db = Reflect.get(database, 'db') as DatabaseSync;
		db.exec('BEGIN IMMEDIATE;');
		const recorded = database.agentSessions.recordNotificationWithinTransaction({ ...event, createdAt: '2026-10-19T00:00:00.000Z' });
		db.exec('COMMIT;');
		db.exec('BEGIN IMMEDIATE;');
		assert.deepEqual(database.agentSessions.recordNotificationWithinTransaction(event), recorded, 'An omitted timestamp retry is idempotent and keeps the generated record timestamp.');
		assert.throws(() => database.agentSessions.recordNotificationWithinTransaction({ ...event, createdAt: '2026-10-19T00:00:01.000Z' }), /different event content/i);
		db.exec('COMMIT;');
	});
});

test('a notification identity conflict rolls back the source session transition', () => {
	withDatabase(database => {
		const { project, binding } = projectFixture(database);
		let session = database.agentSessions.createSession(sessionInput(project.id, binding.id));
		session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'starting');
		const eventId = `session:${session.id}:revision:${session.revision + 1}:state:waitingForInput`;
		const db = Reflect.get(database, 'db') as DatabaseSync;
		db.exec('BEGIN IMMEDIATE;');
		database.agentSessions.recordNotificationWithinTransaction({ eventId, projectId: project.id, sessionId: session.id, kind: 'error', target: { kind: 'session', id: session.id } });
		db.exec('COMMIT;');
		assert.throws(() => database.agentSessions.transitionSession(project.id, session.id, session.revision, 'waitingForInput'), /different event content/i);
		assert.equal(database.agentSessions.getSession(project.id, session.id)?.state, 'starting');
		assert.equal(database.agentSessions.listNotifications(project.id, { limit: 10 }).length, 1);
	});
});

test('optional unread queue limit is atomic, preserves retries at capacity, and frees space on acknowledgement', () => {
	withDatabase(database => {
		const { project, binding } = projectFixture(database);
		const sender = database.agentSessions.createSession(sessionInput(project.id, binding.id));
		const recipient = database.agentSessions.createSession(sessionInput(project.id, binding.id, { provider: 'claude', model: 'sonnet' }));
		const policy = { maxUnreadMessages: 100 };
		let lastMessage: ReturnType<typeof database.agentSessions.sendMessage> | undefined;
		for (let index = 0; index < 100; index++) {
			lastMessage = database.agentSessions.sendMessage(project.id, sender.id, {
				recipientSessionId: recipient.id, idempotencyKey: `queue-${index}`, body: `Unread ${index}`,
			}, policy);
		}
		const retry = database.agentSessions.sendMessage(project.id, sender.id, {
			recipientSessionId: recipient.id, idempotencyKey: 'queue-99', body: 'Unread 99',
		}, policy);
		assert.equal(retry.id, lastMessage?.id);
		assert.throws(() => database.agentSessions.sendMessage(project.id, sender.id, {
			recipientSessionId: recipient.id, idempotencyKey: 'queue-overflow', body: 'Unread overflow',
		}, policy), /unread queue is full/i);
		database.agentSessions.acknowledgeMessage(project.id, recipient.id, retry.id);
		const next = database.agentSessions.sendMessage(project.id, sender.id, {
			recipientSessionId: recipient.id, idempotencyKey: 'queue-after-ack', body: 'Capacity freed',
		}, policy);
		const databaseHandle = Reflect.get(database, 'db') as { prepare(sql: string): { get(...args: string[]): { unread: number } } };
		assert.equal(Number(databaseHandle.prepare(`SELECT COUNT(*) AS unread FROM agent_session_messages
			WHERE project_id = ? AND recipient_session_id = ? AND read_at IS NULL`).get(project.id, recipient.id).unread), 100);
		assert.equal(database.agentSessions.listInbox(project.id, recipient.id, { afterSequence: 100, limit: 1 })[0].id, next.id);
		assert.throws(() => database.agentSessions.sendMessage(project.id, sender.id, {
			recipientSessionId: recipient.id, idempotencyKey: 'invalid-cap', body: 'No',
		}, { maxUnreadMessages: 1000.5 }), /integer between 1 and 1000/i);
	});
});

test('message and notification reads and acknowledgements enforce project and recipient ownership', () => {
	withDatabase(database => {
		const first = projectFixture(database, 'First project');
		const other = projectFixture(database, 'Other project');
		const sender = database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id));
		const recipient = database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id, { provider: 'claude', model: 'sonnet' }));
		const sameProjectIntruder = database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id));
		const foreign = database.agentSessions.createSession(sessionInput(other.project.id, other.binding.id));
		const message = database.agentSessions.sendMessage(first.project.id, sender.id, {
			recipientSessionId: recipient.id, idempotencyKey: 'private', body: 'Private message.',
		});
		assert.equal(database.agentSessions.getSession(other.project.id, sender.id), undefined);
		assert.deepEqual(database.agentSessions.listInbox(first.project.id, sameProjectIntruder.id, { limit: 10 }), []);
		assert.throws(() => database.agentSessions.acknowledgeMessage(first.project.id, sameProjectIntruder.id, message.id), /recipient/i);
		assert.deepEqual(database.agentSessions.listInbox(other.project.id, foreign.id, { limit: 10 }), []);
		assert.throws(() => database.agentSessions.acknowledgeMessage(other.project.id, foreign.id, message.id), /recipient|project/i);
		assert.equal(database.agentSessions.listInbox(first.project.id, recipient.id, { limit: 10 })[0].readAt, null);
	});
});

test('per-recipient message sequences and bounded cursor pages preserve order', () => {
	withDatabase(database => {
		const { project, binding } = projectFixture(database);
		const sender = database.agentSessions.createSession(sessionInput(project.id, binding.id));
		const recipient = database.agentSessions.createSession(sessionInput(project.id, binding.id, { provider: 'claude', model: 'sonnet' }));
		for (let index = 0; index < 4; index++) {
			database.agentSessions.sendMessage(project.id, sender.id, {
				recipientSessionId: recipient.id, idempotencyKey: `page-${index}`, body: `Message ${index}`,
			});
		}
		const firstPage = database.agentSessions.listInbox(project.id, recipient.id, { limit: 2 });
		const secondPage = database.agentSessions.listInbox(project.id, recipient.id, { afterSequence: firstPage[1].sequence, limit: 2 });
		assert.deepEqual([...firstPage, ...secondPage].map(message => message.sequence), [1, 2, 3, 4]);
		assert.throws(() => database.agentSessions.listInbox(project.id, recipient.id, { limit: 101 }), /limit/i);
		assert.throws(() => database.agentSessions.listInbox(project.id, recipient.id, { afterSequence: -1, limit: 2 }), /sequence|cursor/i);
		assert.throws(() => database.agentSessions.sendMessage(project.id, sender.id, {
			recipientSessionId: recipient.id, idempotencyKey: 'oversized', body: 'x'.repeat(16_385),
		}), /size/i);
	});
});

test('session creation validates UUIDs, project binding, task, parent, and field limits', () => {
	withDatabase(database => {
		const first = projectFixture(database, 'Owner project');
		const other = projectFixture(database, 'Foreign project');
		const parent = database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id));
		assert.throws(() => database.agentSessions.createSession(sessionInput(first.project.id, other.binding.id)), /binding|project/i);
		assert.throws(() => database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id, { taskId: other.task.id })), /task|project/i);
		assert.throws(() => database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id, { parentSessionId: randomUUID() })), /parent|session/i);
		assert.throws(() => database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id, { parentSessionId: parent.id, taskId: other.task.id })), /parent|task/i);
		assert.throws(() => database.agentSessions.createSession(sessionInput('not-a-uuid', first.binding.id)), /UUID/i);
		assert.throws(() => database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id, { name: ' ' })), /name/i);
		assert.throws(() => database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id, { name: 'n'.repeat(201) })), /name/i);
		assert.throws(() => database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id, { model: 'm'.repeat(201) })), /model/i);
		assert.throws(() => database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id, { profileRef: 'p'.repeat(513) })), /profile reference/i);
		assert.throws(() => database.agentSessions.createSession(sessionInput(first.project.id, first.binding.id, { provider: 'other' as never })), /provider/i);
	});
});

test('session transition matrix accepts permitted edges and rejects every other edge without mutation', () => {
	withDatabase(database => {
		const { project, binding } = projectFixture(database);
		for (const source of Object.keys(SESSION_TRANSITIONS) as AgentSessionState[]) {
			for (const target of Object.keys(SESSION_TRANSITIONS) as AgentSessionState[]) {
				let session = database.agentSessions.createSession(sessionInput(project.id, binding.id));
				for (const nextState of transitionPath(source)) {
					session = database.agentSessions.transitionSession(project.id, session.id, session.revision, nextState);
				}
				const before = session;
				if (SESSION_TRANSITIONS[source].includes(target)) {
					const after = database.agentSessions.transitionSession(project.id, session.id, before.revision, target);
					assert.equal(after.state, target);
					assert.equal(after.revision, before.revision + 1);
				} else {
					assert.throws(() => database.agentSessions.transitionSession(project.id, session.id, before.revision, target), /transition/i, `${source} -> ${target}`);
					assert.deepEqual(database.agentSessions.getSession(project.id, session.id), before, `${source} -> ${target} must not mutate`);
				}
			}
		}
		const invalidTarget = database.agentSessions.createSession(sessionInput(project.id, binding.id));
		assert.throws(() => database.agentSessions.transitionSession(project.id, invalidTarget.id, invalidTarget.revision, 'done' as never), /state|transition/i);
		assert.deepEqual(database.agentSessions.getSession(project.id, invalidTarget.id), invalidTarget);
	});
});

test('stale concurrent revision rejects without changing the winning state', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-stale-writer-'));
	const path = join(directory, 'workspace.db');
	const firstWriter = WorkspaceDatabase.open(path);
	let secondWriter: WorkspaceDatabase | undefined;
	try {
		const { project, binding } = projectFixture(firstWriter);
		const original = firstWriter.agentSessions.createSession(sessionInput(project.id, binding.id));
		secondWriter = WorkspaceDatabase.open(path);
		assert.deepEqual(secondWriter.agentSessions.getSession(project.id, original.id), original);
		const winningRevision = firstWriter.agentSessions.transitionSession(project.id, original.id, original.revision, 'starting');
		assert.throws(() => secondWriter!.agentSessions.transitionSession(project.id, original.id, original.revision, 'running'), /revision|stale/i);
		assert.deepEqual(secondWriter.agentSessions.getSession(project.id, original.id), winningRevision);
	} finally {
		secondWriter?.close();
		firstWriter.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('interrupted sessions recover, failed sessions restart, and stopped sessions remain terminal after reopen', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-recovery-'));
	const path = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(path);
	const { project, binding } = projectFixture(database);
	let session = database.agentSessions.createSession(sessionInput(project.id, binding.id));
	session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'starting');
	session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'interrupted');
	database.close();
	try {
		database = WorkspaceDatabase.open(path);
		session = database.agentSessions.getSession(project.id, session.id)!;
		assert.equal(session.state, 'interrupted');
		session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'starting');
		session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'failed');
		session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'starting');
		session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'stopping');
		session = database.agentSessions.transitionSession(project.id, session.id, session.revision, 'stopped');
		assert.throws(() => database.agentSessions.transitionSession(project.id, session.id, session.revision, 'starting'), /transition/i);
		assert.throws(() => database.agentSessions.resumeStoppedSessionForTurnWithinTransaction(project.id, session.id, session.revision, randomUUID()), /active SQLite transaction/i);
		assert.deepEqual(database.agentSessions.getSession(project.id, session.id), session);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('notification cursors, per-project sequences, idempotent read, and session close checks', () => {
	withDatabase(database => {
		const { project, binding } = projectFixture(database);
		const sender = database.agentSessions.createSession(sessionInput(project.id, binding.id));
		const recipient = database.agentSessions.createSession(sessionInput(project.id, binding.id, { provider: 'claude', model: 'sonnet' }));
		const first = database.agentSessions.sendMessage(project.id, sender.id, { recipientSessionId: recipient.id, idempotencyKey: 'n1', body: 'One.' });
		const second = database.agentSessions.sendMessage(project.id, sender.id, { recipientSessionId: recipient.id, idempotencyKey: 'n2', body: 'Two.' });
		const notifications = database.agentSessions.listNotifications(project.id, { limit: 10 });
		assert.deepEqual(notifications.map(notification => notification.sequence), [1, 2]);
		assert.deepEqual(database.agentSessions.listNotifications(project.id, { afterSequence: 1, limit: 10 }).map(notification => notification.target), [{ kind: 'message', id: second.id }]);
		database.agentSessions.markNotificationRead(project.id, notifications[0].id);
		const readAt = database.agentSessions.listNotifications(project.id, { limit: 10 })[0].readAt;
		database.agentSessions.markNotificationRead(project.id, notifications[0].id);
		assert.equal(database.agentSessions.listNotifications(project.id, { limit: 10 })[0].readAt, readAt);
		assert.equal(database.agentSessions.listInbox(project.id, recipient.id, { limit: 10 }).length, 2);
		database.close();
		assert.throws(() => database.agentSessions.getSession(project.id, sender.id), /closed/i);
		assert.throws(() => database.agentSessions.listInbox(project.id, recipient.id, { limit: 10 }), /closed/i);
		assert.ok(first.sequence < second.sequence);
	});
});
