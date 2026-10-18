/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';

function hash(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function createFixture(directory: string) {
	const root = join(directory, 'project');
	mkdirSync(root);
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	const project = database.createProject('Turn project');
	const binding = database.createFolderBinding({ projectId: project.id, path: root });
	const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Persist launch evidence' });
	const session = database.agentSessions.createSession({
		projectId: project.id, bindingId: binding.id, taskId: task.id, name: 'Implementation',
		provider: 'codex', model: 'gpt-5-codex', profileRef: 'local-codex-default', workspaceMode: 'sharedFolder',
	});
	return { database, project, binding, task, session, root: realpathSync(root) };
}

function snapshotFor(fixture: ReturnType<typeof createFixture>, overrides: Partial<AgentSessionTurnSnapshot> = {}): AgentSessionTurnSnapshot {
	const stats = statSync(fixture.root, { bigint: true });
	return {
		schemaVersion: 1, projectId: fixture.project.id, sessionId: fixture.session.id,
		sessionRevision: fixture.session.revision, bindingId: fixture.binding.id, taskId: fixture.task.id,
		provider: fixture.session.provider, model: fixture.session.model, profileRef: fixture.session.profileRef,
		cwd: fixture.root, folderIdentity: { canonicalPath: fixture.root, dev: stats.dev.toString(), ino: stats.ino.toString() },
		managedWorktreeOwnerId: null, permissionPolicy: { mode: 'mutating', approval: 'on-request' },
		convention: null, references: [], ...overrides,
	};
}

test('launch snapshots and turn ordinals survive reopen; exit does not complete the task', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-turn-reopen-'));
	let fixture = createFixture(directory);
	try {
		const turn = fixture.database.agentSessionTurns.createTurn({
			projectId: fixture.project.id, sessionId: fixture.session.id, expectedSessionRevision: fixture.session.revision,
			snapshot: snapshotFor(fixture),
		});
		assert.equal(turn.ordinal, 1);
		assert.equal(turn.state, 'starting');
		assert.equal(turn.snapshotSha256, hash(JSON.stringify(turn.snapshot)));
		assert.equal(fixture.database.agentSessions.getSession(fixture.project.id, fixture.session.id)?.state, 'starting');
		assert.throws(() => fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, fixture.session.id, turn.id, turn.revision, 2, {
			state: 'exited', exitCode: 0, cleanupVerified: true,
		}), /turn lifecycle transition/i);
		const sqlite = Reflect.get(fixture.database, 'db') as DatabaseSync;
		assert.throws(() => sqlite.prepare('UPDATE agent_session_turns SET snapshot_json = ? WHERE id = ?').run('{}', turn.id), /immutable/i);

		const identified = fixture.database.agentSessionTurns.recordProviderConversationId(fixture.project.id, fixture.session.id, turn.id, turn.revision, '00000000-0000-4000-8000-000000000042');
		const running = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, fixture.session.id, turn.id, identified.revision, 2, { state: 'running' });
		const exited = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, fixture.session.id, turn.id, running.turn.revision, running.session.revision, {
			state: 'exited', exitCode: 0, cleanupVerified: true,
		});
		assert.equal(exited.session.state, 'idle');
		assert.equal(exited.turn.providerConversationId, '00000000-0000-4000-8000-000000000042');
		assert.equal(exited.turn.exitCode, 0);
		assert.equal(exited.turn.cleanupVerified, true);
		assert.equal(fixture.database.getTask(fixture.task.id)?.state, 'ready');

		fixture.database.close();
		fixture = { ...fixture, database: WorkspaceDatabase.open(join(directory, 'workspace.db')) };
		assert.deepEqual(fixture.database.agentSessionTurns.getTurn(fixture.project.id, fixture.session.id, turn.id), exited.turn);
		const nextSnapshot = { ...snapshotFor(fixture), sessionRevision: exited.session.revision };
		const next = fixture.database.agentSessionTurns.createTurn({
			projectId: fixture.project.id, sessionId: fixture.session.id, expectedSessionRevision: exited.session.revision, snapshot: nextSnapshot,
		});
		assert.equal(next.ordinal, 2);
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('running evidence, immediate exit, and stop/exit races follow the session transition contract', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-turn-stop-race-'));
	const fixture = createFixture(directory);
	let secondDatabase: WorkspaceDatabase | undefined;
	try {
		const firstTurn = fixture.database.agentSessionTurns.createTurn({
			projectId: fixture.project.id, sessionId: fixture.session.id, expectedSessionRevision: fixture.session.revision, snapshot: snapshotFor(fixture),
		});
		// The host writes running only after PTY creation resolves; this SQLite contract then records an immediate exit.
		const running = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, fixture.session.id, firstTurn.id, firstTurn.revision, 2, { state: 'running' });
		secondDatabase = WorkspaceDatabase.open(join(directory, 'workspace.db'));
		const exited = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, fixture.session.id, firstTurn.id, running.turn.revision, running.session.revision, {
			state: 'exited', exitCode: 0, cleanupVerified: true,
		});
		assert.equal(exited.session.state, 'idle');
		assert.throws(() => secondDatabase!.agentSessionTurns.transitionTurn(fixture.project.id, fixture.session.id, firstTurn.id,
			running.turn.revision, running.session.revision, { state: 'stopping' }), /turn revision is stale/i);

		const stoppingSession = fixture.database.agentSessions.createSession({
			projectId: fixture.project.id, bindingId: fixture.binding.id, taskId: fixture.task.id, name: 'Stop race',
			provider: 'claude', model: 'sonnet', workspaceMode: 'sharedFolder',
		});
		const stoppingFixture = { ...fixture, session: stoppingSession };
		const stoppingTurn = fixture.database.agentSessionTurns.createTurn({
			projectId: fixture.project.id, sessionId: stoppingSession.id, expectedSessionRevision: stoppingSession.revision, snapshot: snapshotFor(stoppingFixture),
		});
		const started = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, stoppingSession.id, stoppingTurn.id, stoppingTurn.revision, 2, { state: 'running' });
		const stopping = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, stoppingSession.id, stoppingTurn.id, started.turn.revision, started.session.revision, { state: 'stopping' });
		const stopExited = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, stoppingSession.id, stoppingTurn.id, stopping.turn.revision, stopping.session.revision, {
			state: 'exited', exitSignal: 'SIGTERM', cleanupVerified: true,
		});
		assert.equal(stopExited.session.state, 'stopped');
		assert.equal(stopExited.turn.state, 'exited');
	} finally {
		secondDatabase?.close();
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a provider launch failure moves a starting turn and session to failed without implying task completion', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-turn-start-failure-'));
	const fixture = createFixture(directory);
	try {
		const turn = fixture.database.agentSessionTurns.createTurn({
			projectId: fixture.project.id, sessionId: fixture.session.id, expectedSessionRevision: fixture.session.revision, snapshot: snapshotFor(fixture),
		});
		const failed = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, fixture.session.id, turn.id, turn.revision, 2, {
			state: 'failed', errorSummary: 'PTY creation failed.', cleanupVerified: true,
		});
		assert.equal(failed.turn.state, 'failed');
		assert.equal(failed.session.state, 'failed');
		assert.equal(fixture.database.getTask(fixture.task.id)?.state, 'ready');
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
test('turn creation enforces session and project ownership, snapshot allowlist, and canonical folder identity', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-turn-owner-'));
	const fixture = createFixture(directory);
	try {
		const snapshot = snapshotFor(fixture);
		assert.throws(() => fixture.database.agentSessionTurns.createTurn({
			projectId: fixture.project.id, sessionId: fixture.session.id, expectedSessionRevision: fixture.session.revision,
			snapshot: { ...snapshot, model: 'different-model' },
		}), /match the persisted session/i);
		assert.throws(() => fixture.database.agentSessionTurns.createTurn({
			projectId: fixture.project.id, sessionId: fixture.session.id, expectedSessionRevision: fixture.session.revision,
			snapshot: { ...snapshot, environment: { SECRET: 'never persist' } } as AgentSessionTurnSnapshot,
		}), /unsupported or missing fields/i);
		assert.throws(() => fixture.database.agentSessionTurns.createTurn({
			projectId: fixture.project.id, sessionId: fixture.session.id, expectedSessionRevision: fixture.session.revision,
			snapshot: { ...snapshot, folderIdentity: { ...snapshot.folderIdentity, ino: '1' } },
		}), /identity changed/i);
		const foreignProject = fixture.database.createProject('Foreign project');
		assert.equal(fixture.database.agentSessionTurns.getTurn(foreignProject.id, fixture.session.id, '00000000-0000-4000-8000-000000000001'), undefined);
		assert.throws(() => fixture.database.agentSessionTurns.createTurn({
			projectId: foreignProject.id, sessionId: fixture.session.id, expectedSessionRevision: fixture.session.revision,
			snapshot: { ...snapshot, projectId: foreignProject.id },
		}), /does not belong/i);
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
test('turn snapshots bind immutable convention and reference versions by ID and digest', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-turn-knowledge-'));
	const fixture = createFixture(directory);
	try {
		const reference = fixture.database.knowledge.importReference({
			projectId: fixture.project.id, connectorId: 'local-file', connectorVersion: '1', externalId: 'guide',
			title: 'Project guide', contentType: 'text/plain; charset=utf-8', content: Buffer.from('Guide content.'),
		});
		fixture.database.knowledge.attachReferenceToTask(fixture.task.id, reference.id);
		const convention = fixture.database.knowledge.createConventionVersion({
			projectId: fixture.project.id, markdown: '# Conventions\nUse focused changes.', sourceSnapshotIds: [reference.id], authoredBy: 'person',
		});
		const session = fixture.session;
		const current = fixture.database.agentSessions.getSession(fixture.project.id, session.id)!;
		const snap = snapshotFor({ ...fixture, session: current }, {
			convention: { id: convention.id, version: convention.version, sha256: hash(convention.markdown) },
			references: [{ id: reference.id, version: reference.version, sha256: reference.contentSha256 }],
		});
		const turn = fixture.database.agentSessionTurns.createTurn({ projectId: fixture.project.id, sessionId: session.id, expectedSessionRevision: current.revision, snapshot: snap });
		assert.equal(turn.snapshot.convention?.sha256, hash(convention.markdown));
		assert.equal(turn.snapshot.references[0].sha256, reference.contentSha256);
		fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, session.id, turn.id, turn.revision, current.revision + 1, { state: 'interrupted' });
		const nextSession = fixture.database.agentSessions.getSession(fixture.project.id, session.id)!;
		assert.throws(() => fixture.database.agentSessionTurns.createTurn({
			projectId: fixture.project.id, sessionId: session.id, expectedSessionRevision: nextSession.revision,
			snapshot: { ...snap, sessionRevision: nextSession.revision, references: [{ ...snap.references[0], sha256: '0'.repeat(64) }] },
		}), /immutable version and content hash/i);
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('turn and session revisions serialize concurrent starts and reject stale lifecycle writes', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-turn-revision-'));
	const first = createFixture(directory);
	let secondDatabase: WorkspaceDatabase | undefined;
	try {
		secondDatabase = WorkspaceDatabase.open(join(directory, 'workspace.db'));
		const turn = first.database.agentSessionTurns.createTurn({
			projectId: first.project.id, sessionId: first.session.id, expectedSessionRevision: first.session.revision, snapshot: snapshotFor(first),
		});
		const staleSnapshot = { ...snapshotFor(first), sessionRevision: first.session.revision };
		assert.throws(() => secondDatabase!.agentSessionTurns.createTurn({
			projectId: first.project.id, sessionId: first.session.id, expectedSessionRevision: first.session.revision, snapshot: staleSnapshot,
		}), /revision is stale/i);
		const session = first.database.agentSessions.getSession(first.project.id, first.session.id)!;
		const winner = first.database.agentSessionTurns.transitionTurn(first.project.id, first.session.id, turn.id, turn.revision, session.revision, { state: 'running' });
		assert.throws(() => secondDatabase!.agentSessionTurns.transitionTurn(first.project.id, first.session.id, turn.id, turn.revision, winner.session.revision, { state: 'running' }), /turn revision is stale/i);
		assert.equal(secondDatabase.agentSessionTurns.listTurns(first.project.id, first.session.id).length, 1);
	} finally {
		secondDatabase?.close();
		first.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('startup recovery interrupts unverifiable live turns without claiming cleanup', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-turn-recovery-'));
	let fixture = createFixture(directory);
	try {
		const turn = fixture.database.agentSessionTurns.createTurn({
			projectId: fixture.project.id, sessionId: fixture.session.id, expectedSessionRevision: fixture.session.revision, snapshot: snapshotFor(fixture),
		});
		fixture.database.close();
		fixture = { ...fixture, database: WorkspaceDatabase.open(join(directory, 'workspace.db')) };
		assert.equal(fixture.database.agentSessionTurns.getTurn(fixture.project.id, fixture.session.id, turn.id)?.state, 'starting');
		assert.equal(fixture.database.agentSessionTurns.interruptUnverifiedLiveTurnsOnStartup(), 1);
		const recovered = fixture.database.agentSessionTurns.getTurn(fixture.project.id, fixture.session.id, turn.id)!;
		assert.equal(recovered.state, 'interrupted');
		assert.equal(recovered.cleanupVerified, false);
		assert.match(recovered.errorSummary ?? '', /could not re-prove ownership/i);
		assert.equal(fixture.database.agentSessionTurns.interruptUnverifiedLiveTurnsOnStartup(), 0);
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('standalone session transitions cannot steal live-turn lifecycle; recovery still handles multiple sessions', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-turn-session-guard-'));
	const fixture = createFixture(directory);
	try {
		const secondSession = fixture.database.agentSessions.createSession({
			projectId: fixture.project.id, bindingId: fixture.binding.id, taskId: fixture.task.id, name: 'Second live turn',
			provider: 'claude', model: 'sonnet', workspaceMode: 'sharedFolder',
		});
		const sessions = [fixture.session, secondSession];
		for (const session of sessions) {
			const current = fixture.database.agentSessions.getSession(fixture.project.id, session.id)!;
			const turn = fixture.database.agentSessionTurns.createTurn({
				projectId: fixture.project.id, sessionId: session.id, expectedSessionRevision: current.revision,
				snapshot: snapshotFor({ ...fixture, session: current }),
			});
			const starting = fixture.database.agentSessions.getSession(fixture.project.id, session.id)!;
			assert.equal(turn.state, 'starting');
			assert.throws(() => fixture.database.agentSessions.transitionSession(fixture.project.id, session.id, starting.revision, 'stopped'), /live session turn owns lifecycle/i);
			assert.deepEqual(fixture.database.agentSessions.getSession(fixture.project.id, session.id), starting);
		}
		assert.equal(fixture.database.agentSessionTurns.interruptUnverifiedLiveTurnsOnStartup(), 2);
		for (const session of sessions) {
			assert.equal(fixture.database.agentSessionTurns.listTurns(fixture.project.id, session.id)[0].state, 'interrupted');
			assert.equal(fixture.database.agentSessions.getSession(fixture.project.id, session.id)?.state, 'interrupted');
		}
	} finally {
		fixture.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
