/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { AgentSessionDTO, AgentSessionPermissionPolicy, AgentSessionTurnDTO, AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { AgentSessionControlApplication, AgentSessionControlApplicationError } from './agentSessionControlApplication.js';
import { AgentSessionControlRequestStore, AGENT_SESSION_CONTROL_REQUESTS_MIGRATION_V34 } from './agentSessionControlRequestStore.js';
import type { AgentSessionLaunchPreview } from './agentSessionService.js';

const PROJECT = randomUUID();
const POLICY: AgentSessionPermissionPolicy = { mode: 'read-only', approval: 'never' };

function fixture() {
	const db = new DatabaseSync(':memory:');
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL) STRICT;
		CREATE TABLE agent_sessions (
			id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), binding_id TEXT NOT NULL, task_id TEXT,
			state TEXT NOT NULL, revision INTEGER NOT NULL, UNIQUE(id, project_id)
		) STRICT;
		CREATE TABLE agent_session_turns (
			id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL,
			snapshot_sha256 TEXT NOT NULL, cleanup_verified INTEGER NOT NULL DEFAULT 0, error_summary TEXT,
			UNIQUE(id, project_id, session_id), FOREIGN KEY(session_id, project_id) REFERENCES agent_sessions(id, project_id)
		) STRICT;
		CREATE UNIQUE INDEX agent_session_turns_one_live ON agent_session_turns(session_id) WHERE state IN ('starting', 'running', 'stopping');
		CREATE TABLE agent_workflows (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, plan_version INTEGER NOT NULL, state TEXT NOT NULL) STRICT;
		CREATE TABLE agent_workflow_plans (workflow_id TEXT NOT NULL, project_id TEXT NOT NULL, version INTEGER NOT NULL, plan_json TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(workflow_id, version)) STRICT;
		CREATE TABLE agent_workflow_approvals (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, project_id TEXT NOT NULL, plan_version INTEGER NOT NULL, fingerprint TEXT NOT NULL) STRICT;
		CREATE TABLE agent_workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, project_id TEXT NOT NULL, plan_version INTEGER NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL) STRICT;
		CREATE TABLE agent_workflow_run_nodes (workflow_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, node_id TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL, session_turn_id TEXT) STRICT;
	`);
	db.exec(AGENT_SESSION_CONTROL_REQUESTS_MIGRATION_V34);
	db.prepare('INSERT INTO projects(id) VALUES (?)').run(PROJECT);
	const callerSessionId = randomUUID();
	const targetSessionId = randomUUID();
	const callerTurnId = randomUUID();
	db.prepare('INSERT INTO agent_sessions(id, project_id, binding_id, task_id, state, revision) VALUES (?, ?, ?, ?, ?, ?)').run(callerSessionId, PROJECT, 'binding-a', 'task-a', 'running', 2);
	db.prepare('INSERT INTO agent_sessions(id, project_id, binding_id, task_id, state, revision) VALUES (?, ?, ?, ?, ?, ?)').run(targetSessionId, PROJECT, 'binding-a', 'task-a', 'idle', 4);
	db.prepare('INSERT INTO agent_session_turns(id, project_id, session_id, state, snapshot_sha256) VALUES (?, ?, ?, ?, ?)').run(callerTurnId, PROJECT, callerSessionId, 'running', 'a'.repeat(64));
	const ledger = new AgentSessionControlRequestStore(db, () => undefined);
	const turns = new Map<string, AgentSessionTurnDTO>();
	const sessions = new Map<string, AgentSessionDTO>([
		[callerSessionId, makeSession(callerSessionId, 2)], [targetSessionId, makeSession(targetSessionId, 4)],
	]);
	const database = {
		agentSessionControlRequests: ledger,
		agentSessions: { getSession: (projectId: string, sessionId: string) => projectId === PROJECT ? sessions.get(sessionId) : undefined },
		agentSessionTurns: {
			getTurn: (projectId: string, sessionId: string, turnId: string) => {
				const turn = turns.get(turnId);
				return turn?.projectId === projectId && turn.sessionId === sessionId ? turn : undefined;
			},
			listTurns: (projectId: string, sessionId: string) => [...turns.values()].filter(turn => turn.projectId === projectId && turn.sessionId === sessionId),
		},
	};
	const startRequest = ledger.createStartRequest({
		projectId: PROJECT, callerSessionId, callerTurnId, targetSessionId, idempotencyKey: 'request-start',
		expectedSessionRevision: 4, permissionPolicy: POLICY, reason: 'Review this session first.',
	});
	return { db, ledger, database, sessions, turns, callerSessionId, targetSessionId, callerTurnId, startRequest };
}

function makeSession(id: string, revision: number): AgentSessionDTO {
	return {
		id, projectId: PROJECT, bindingId: 'binding-a', taskId: 'task-a', parentSessionId: null, name: 'Session',
		provider: 'claude', model: 'model', profileRef: null, workspaceMode: 'sharedFolder', state: 'idle', revision,
		createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
	};
}

function makeSnapshot(sessionId: string, revision: number): AgentSessionTurnSnapshot {
	return {
		schemaVersion: 1, projectId: PROJECT, sessionId, sessionRevision: revision, bindingId: 'binding-a', taskId: 'task-a',
		provider: 'claude', model: 'model', profileRef: null, cwd: '/workspace',
		folderIdentity: { canonicalPath: '/workspace', dev: '1', ino: '2' }, managedWorktreeOwnerId: null,
		permissionPolicy: POLICY, convention: null, references: [],
	};
}

function makeTurn(snapshot: AgentSessionTurnSnapshot): AgentSessionTurnDTO {
	const now = new Date().toISOString();
	return {
		id: randomUUID(), projectId: PROJECT, sessionId: snapshot.sessionId, ordinal: 1, state: 'running', revision: 1,
		snapshot, snapshotSha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), providerConversationId: null,
		exitCode: null, exitSignal: null, errorSummary: null, cleanupVerified: false, createdAt: now, updatedAt: now, startedAt: now, finishedAt: null,
	};
}

function serviceFor(f: ReturnType<typeof fixture>, options: {
	onStop?: (projectId: string, sessionId: string, turnId: string) => void;
	failStartAfterPersist?: boolean;
} = {}) {
	let previews = 0;
	let starts = 0;
	const service = {
		preview: async ({ projectId, sessionId, permissionPolicy }: { projectId: string; sessionId: string; permissionPolicy: AgentSessionPermissionPolicy }): Promise<AgentSessionLaunchPreview> => {
			previews++;
			const snapshot = { ...makeSnapshot(sessionId, 4), projectId, permissionPolicy };
			return { ticketId: `ticket-${previews}`, expiresAt: new Date(Date.now() + 30_000).toISOString(), snapshot };
		},
		start: async ({ projectId, sessionId }: { projectId: string; sessionId: string }): Promise<AgentSessionTurnDTO> => {
			starts++;
			const snapshot = makeSnapshot(sessionId, 4);
			const turn = makeTurn(snapshot);
			f.db.prepare('INSERT INTO agent_session_turns(id, project_id, session_id, state, snapshot_sha256) VALUES (?, ?, ?, ?, ?)').run(turn.id, projectId, sessionId, 'running', turn.snapshotSha256);
			f.turns.set(turn.id, turn);
			if (options.failStartAfterPersist) { throw new Error('Simulated failure after durable turn creation.'); }
			return turn;
		},
		stop: async (projectId: string, sessionId: string, turnId: string): Promise<AgentSessionTurnDTO> => {
			options.onStop?.(projectId, sessionId, turnId);
			f.db.prepare("UPDATE agent_session_turns SET state = 'exited', cleanup_verified = 1 WHERE id = ? AND project_id = ? AND session_id = ?").run(turnId, projectId, sessionId);
			const current = f.turns.get(turnId);
			if (current) { f.turns.set(turnId, { ...current, state: 'exited', cleanupVerified: true }); }
			return current ? f.turns.get(turnId)! : makeTurn(makeSnapshot(sessionId, 4));
		},
	};
	return { service, get starts() { return starts; } };
}

test('durable start request does not launch; fresh private preview authorizes exactly one launch', async () => {
	const f = fixture();
	try {
		const runtime = serviceFor(f);
		const app = new AgentSessionControlApplication(f.database, runtime.service);
		assert.equal(f.startRequest.state, 'pendingReview');
		assert.equal(runtime.starts, 0);
		const { preview } = await app.previewStart(PROJECT, f.startRequest.id);
		const review = app.readStartReview(PROJECT, f.startRequest.id, f.startRequest.revision, preview.ticketId);
		assert.equal(review.preview, preview);
		assert.equal(app.isControlPreview(preview.ticketId), true);
		const started = await app.startReviewed(PROJECT, f.startRequest.id, f.startRequest.revision, preview.ticketId, 'human-approval-1');
		assert.equal(started.state, 'started');
		assert.equal(f.ledger.get(PROJECT, f.startRequest.id)?.resultTurnId, started.resultTurnId);
		assert.equal(runtime.starts, 1);
		f.sessions.set(f.targetSessionId, makeSession(f.targetSessionId, 5));
		const replay = await app.startReviewed(PROJECT, f.startRequest.id, f.startRequest.revision, preview.ticketId, 'human-approval-1');
		assert.equal(replay.state, 'started');
		assert.equal(runtime.starts, 1);
		await app.shutdown();
	} finally { f.db.close(); }
});

test('a rejected start with a newly persisted exact turn records failure only after verified cleanup', async () => {
	const f = fixture();
	try {
		let stoppedTurnId: string | undefined;
		const runtime = serviceFor(f, { failStartAfterPersist: true, onStop: (_projectId, _sessionId, turnId) => { stoppedTurnId = turnId; } });
		const app = new AgentSessionControlApplication(f.database, runtime.service);
		const { preview } = await app.previewStart(PROJECT, f.startRequest.id);
		await assert.rejects(app.startReviewed(PROJECT, f.startRequest.id, f.startRequest.revision, preview.ticketId, 'approval-after-persist-failure'), AgentSessionControlApplicationError);
		assert.equal(f.ledger.get(PROJECT, f.startRequest.id)?.state, 'startFailed');
		assert.ok(stoppedTurnId);
		assert.equal(f.turns.get(stoppedTurnId)?.cleanupVerified, true);
		assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM agent_session_turns WHERE session_id = ? AND state IN ('starting', 'running', 'stopping')").get(f.targetSessionId)?.count, 0);
		assert.equal(app.getHostError(), null);
		await app.shutdown();
	} finally { f.db.close(); }
});

test('a failed durable start receipt stops only its exact new turn and verifies cleanup before recording failure', async () => {
	const f = fixture();
	try {
		let stoppedTurnId: string | undefined;
		const runtime = serviceFor(f, { onStop: (_projectId, _sessionId, turnId) => { stoppedTurnId = turnId; } });
		const app = new AgentSessionControlApplication(f.database, runtime.service);
		const { preview } = await app.previewStart(PROJECT, f.startRequest.id);
		f.db.exec(`CREATE TRIGGER fail_started_receipt BEFORE UPDATE ON agent_session_control_requests
			WHEN OLD.id = '${f.startRequest.id}' AND NEW.state = 'started'
			BEGIN SELECT RAISE(ABORT, 'injected durable receipt failure'); END;`);
		await assert.rejects(app.startReviewed(PROJECT, f.startRequest.id, f.startRequest.revision, preview.ticketId, 'approval-receipt-failure'), AgentSessionControlApplicationError);
		const row = f.ledger.get(PROJECT, f.startRequest.id);
		assert.equal(row?.state, 'startFailed');
		assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM agent_session_turns WHERE session_id = ? AND state IN ('starting', 'running', 'stopping')").get(f.targetSessionId)?.count, 0);
		assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM agent_session_turns WHERE session_id = ? AND cleanup_verified = 1').get(f.targetSessionId)?.count, 1);
		assert.equal(stoppedTurnId, f.db.prepare('SELECT id FROM agent_session_turns WHERE session_id = ?').get(f.targetSessionId)?.id);
		await app.shutdown();
	} finally { f.db.close(); }
});

test('start approval rejects forged or reused tickets and a target revision changed after preview', async () => {
	const f = fixture();
	try {
		const runtime = serviceFor(f);
		const app = new AgentSessionControlApplication(f.database, runtime.service);
		await assert.rejects(app.startReviewed(PROJECT, f.startRequest.id, f.startRequest.revision, 'forged-ticket', 'approve-1'), AgentSessionControlApplicationError);
		const { preview } = await app.previewStart(PROJECT, f.startRequest.id);
		f.sessions.set(f.targetSessionId, makeSession(f.targetSessionId, 5));
		await assert.rejects(app.startReviewed(PROJECT, f.startRequest.id, f.startRequest.revision, preview.ticketId, 'approve-1'), AgentSessionControlApplicationError);
		assert.equal(runtime.starts, 0);
		f.sessions.set(f.targetSessionId, makeSession(f.targetSessionId, 4));
		const { preview: fresh } = await app.previewStart(PROJECT, f.startRequest.id);
		const result = await app.startReviewed(PROJECT, f.startRequest.id, f.startRequest.revision, fresh.ticketId, 'approve-2');
		assert.equal(result.state, 'started');
		await assert.rejects(app.startReviewed(PROJECT, f.startRequest.id, f.startRequest.revision, fresh.ticketId, 'different-approval'), AgentSessionControlApplicationError);
		assert.equal(runtime.starts, 1);
		await app.shutdown();
	} finally { f.db.close(); }
});

test('stop returns persisted receipt before runtime work and records actual cleanup only after deferred stop', async () => {
	const f = fixture();
	try {
		const turnId = f.callerTurnId;
		const stop = f.ledger.createStopRequest({
			projectId: PROJECT, callerSessionId: f.callerSessionId, callerTurnId: turnId, targetSessionId: f.callerSessionId,
			targetTurnId: turnId, idempotencyKey: 'stop-own-turn',
		});
		let didStop = false;
		const runtime = serviceFor(f, { onStop: () => { didStop = true; } });
		const app = new AgentSessionControlApplication(f.database, runtime.service);
		const receipt = app.queueStop(stop);
		assert.equal(receipt.status, 'queued');
		assert.equal(receipt.request.state, 'stopAccepted');
		assert.equal(didStop, false);
		assert.equal(f.ledger.get(PROJECT, stop.id)?.state, 'stopAccepted');
		await app.waitForIdle();
		assert.equal(didStop, true);
		assert.equal(f.ledger.get(PROJECT, stop.id)?.state, 'stopCompleted');
		assert.equal(f.db.prepare('SELECT cleanup_verified FROM agent_session_turns WHERE id = ?').get(turnId)?.cleanup_verified, 1);
		await app.shutdown();
	} finally { f.db.close(); }
});

test('a failed stop-result transaction is retained and surfaced after its queued job settles', async () => {
	const f = fixture();
	try {
		const turnId = f.callerTurnId;
		const request = f.ledger.createStopRequest({
			projectId: PROJECT, callerSessionId: f.callerSessionId, callerTurnId: turnId, targetSessionId: f.callerSessionId,
			targetTurnId: turnId, idempotencyKey: 'stop-ledger-failure',
		});
		f.db.exec(`CREATE TRIGGER fail_stop_receipt BEFORE UPDATE ON agent_session_control_requests
			WHEN OLD.id = '${request.id}' AND NEW.state LIKE 'stop%'
			BEGIN SELECT RAISE(ABORT, 'injected stop receipt failure'); END;`);
		const app = new AgentSessionControlApplication(f.database, serviceFor(f).service);
		const receipt = app.queueStop(request);
		assert.equal(receipt.request.state, 'stopAccepted');
		await assert.rejects(app.waitForIdle(), AgentSessionControlApplicationError);
		assert.match(app.getHostError() ?? '', /session control operation could not be fully verified/i);
		assert.equal(f.ledger.get(PROJECT, request.id)?.state, 'stopAccepted');
		assert.throws(() => app.queueStop(request), AgentSessionControlApplicationError);
		await assert.rejects(app.shutdown(), AgentSessionControlApplicationError);
	} finally { f.db.close(); }
});
