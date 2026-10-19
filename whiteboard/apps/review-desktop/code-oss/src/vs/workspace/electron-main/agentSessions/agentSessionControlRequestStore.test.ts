/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { AgentSessionPermissionPolicy } from '../../common/workspaceAgentSessionProtocol.js';
import { AgentSessionControlRequestStore, AGENT_SESSION_CONTROL_REQUESTS_MIGRATION_V34 } from './agentSessionControlRequestStore.js';

const READ_ONLY: AgentSessionPermissionPolicy = { mode: 'read-only', approval: 'on-request' };
const PROJECT = randomUUID();

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
	const store = new AgentSessionControlRequestStore(db, () => undefined);
	const base = { projectId: PROJECT, callerSessionId, callerTurnId, targetSessionId, idempotencyKey: 'request-1' };
	const startInput = { ...base, expectedSessionRevision: 4, permissionPolicy: READ_ONLY, reason: 'Investigate the failing run.' };
	return { db, store, callerSessionId, targetSessionId, callerTurnId, base, startInput };
}

function addApprovedWorkflow(f: ReturnType<typeof fixture>, targetTurnId: string) {
	const workflowId = randomUUID(); const runId = randomUUID(); const approvalId = randomUUID();
	const fingerprint = '1'.repeat(64);
	const nodes = [{ nodeId: 'caller', sessionId: f.callerSessionId }, { nodeId: 'target', sessionId: f.targetSessionId }];
	f.db.prepare('INSERT INTO agent_workflows(id, project_id, plan_version, state) VALUES (?, ?, ?, ?)').run(workflowId, PROJECT, 3, 'running');
	f.db.prepare('INSERT INTO agent_workflow_plans(workflow_id, project_id, version, plan_json, fingerprint) VALUES (?, ?, ?, ?, ?)').run(workflowId, PROJECT, 3, JSON.stringify({ nodes }), fingerprint);
	f.db.prepare('INSERT INTO agent_workflow_approvals(id, workflow_id, project_id, plan_version, fingerprint) VALUES (?, ?, ?, ?, ?)').run(approvalId, workflowId, PROJECT, 3, fingerprint);
	f.db.prepare('INSERT INTO agent_workflow_runs(id, workflow_id, project_id, plan_version, fingerprint, state) VALUES (?, ?, ?, ?, ?, ?)').run(runId, workflowId, PROJECT, 3, fingerprint, 'running');
	f.db.prepare('INSERT INTO agent_workflow_run_nodes(workflow_id, project_id, run_id, node_id, session_id, state, session_turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(workflowId, PROJECT, runId, 'caller', f.callerSessionId, 'running', f.callerTurnId);
	f.db.prepare('INSERT INTO agent_workflow_run_nodes(workflow_id, project_id, run_id, node_id, session_id, state, session_turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(workflowId, PROJECT, runId, 'target', f.targetSessionId, 'running', targetTurnId);
	return { workflowId, planVersion: 3, fingerprint, runId, approvalId, allowedSessionIds: [f.callerSessionId, f.targetSessionId] };
}

test('unknown permission fields cannot silently become an apparently reviewed policy', () => {
	const f = fixture();
	try {
		const policy = { ...READ_ONLY, skipHumanReview: true };
		assert.throws(() => f.store.createStartRequest({ ...f.startInput, permissionPolicy: policy }), /permission policy/i);
		assert.deepEqual(f.store.list(PROJECT), []);
	} finally { f.db.close(); }
});

test('start request is durable, idempotent, project scoped, and approval claims the exact revision once', () => {
	const f = fixture();
	try {
		const request = f.store.createStartRequest(f.startInput);
		assert.equal(request.state, 'pendingReview');
		assert.equal(f.store.createStartRequest(f.startInput).id, request.id);
		assert.throws(() => f.store.createStartRequest({ ...f.startInput, reason: 'Different request.' }), /different request content/);
		assert.throws(() => f.store.createStartRequest({ ...f.startInput, projectId: randomUUID() }), /caller must be the exact live turn|project/i);
		assert.throws(() => f.store.createStartRequest({ ...f.startInput, expectedSessionRevision: 3, idempotencyKey: 'stale-revision' }), /changed since/);
		const approval = f.store.beginStart(request.id, request.revision, 'b'.repeat(64), 'approval-1');
		assert.equal(approval.claimed, true);
		assert.equal(f.store.beginStart(request.id, request.revision, 'b'.repeat(64), 'approval-1').claimed, false);
		assert.throws(() => f.store.beginStart(request.id, request.revision + 1, 'b'.repeat(64), 'approval-1'), /different approval content/);
		assert.throws(() => f.store.beginStart(request.id, request.revision, 'c'.repeat(64), 'approval-2'), /different approval content/);
		const turnId = randomUUID();
		f.db.prepare('INSERT INTO agent_session_turns(id, project_id, session_id, state, snapshot_sha256) VALUES (?, ?, ?, ?, ?)').run(turnId, PROJECT, f.targetSessionId, 'running', 'b'.repeat(64));
		const started = f.store.markStarted(request.id, turnId);
		assert.equal(started.state, 'started');
		assert.equal(started.resultTurnId, turnId);
		assert.deepEqual(f.store.listEvents(PROJECT, request.id).map(event => event.type), ['startRequested', 'startApproved', 'started']);
	} finally { f.db.close(); }
});

test('start approval rejects an active target and pending decisions are revision guarded and idempotent', () => {
	const f = fixture();
	try {
		const request = f.store.createStartRequest(f.startInput);
		const targetTurnId = randomUUID();
		f.db.prepare('INSERT INTO agent_session_turns(id, project_id, session_id, state, snapshot_sha256) VALUES (?, ?, ?, ?, ?)').run(targetTurnId, PROJECT, f.targetSessionId, 'running', 'd'.repeat(64));
		assert.throws(() => f.store.beginStart(request.id, request.revision, 'b'.repeat(64), 'approval-1'), /changed or became active/);
		const rejected = f.store.rejectPending(request.id, request.revision, 'decision-1');
		assert.equal(rejected.state, 'rejected');
		assert.equal(f.store.rejectPending(request.id, request.revision, 'decision-1').id, rejected.id);
		assert.throws(() => f.store.cancelPending(request.id, request.revision, 'decision-1'), /pending start request/);
		f.db.prepare("UPDATE agent_session_turns SET state = 'exited' WHERE session_id = ? AND state = 'running'").run(f.targetSessionId);
		const cancellable = f.store.createStartRequest({ ...f.startInput, idempotencyKey: 'request-cancel' });
		assert.equal(f.store.cancelPending(cancellable.id, cancellable.revision, 'decision-cancel').state, 'cancelled');
	} finally { f.db.close(); }
});

test('stop receipt distinguishes acceptance from verified process cleanup and retains actual turn state', () => {
	const f = fixture();
	try {
		const targetTurnId = randomUUID();
		f.db.prepare('INSERT INTO agent_session_turns(id, project_id, session_id, state, snapshot_sha256) VALUES (?, ?, ?, ?, ?)').run(targetTurnId, PROJECT, f.targetSessionId, 'running', 'e'.repeat(64));
		const workflowAuthority = addApprovedWorkflow(f, targetTurnId);
		const requestInput = { ...f.base, targetTurnId, idempotencyKey: 'stop-1', workflowAuthority };
		assert.throws(() => f.store.createStopRequest({ ...requestInput, workflowAuthority: { ...workflowAuthority, allowedSessionIds: [f.targetSessionId] } }), /exactly match its approved plan/);
		f.db.prepare("UPDATE agent_workflow_run_nodes SET session_turn_id = ? WHERE run_id = ? AND session_id = ?").run(randomUUID(), workflowAuthority.runId, f.targetSessionId);
		assert.throws(() => f.store.createStopRequest({ ...requestInput, idempotencyKey: 'wrong-target' }), /exact source and target turns/);
		f.db.prepare("UPDATE agent_workflow_run_nodes SET session_turn_id = ? WHERE run_id = ? AND session_id = ?").run(targetTurnId, workflowAuthority.runId, f.targetSessionId);
		const request = f.store.createStopRequest(requestInput);
		assert.equal(request.state, 'stopAccepted');
		assert.equal(f.store.createStopRequest(requestInput).id, request.id);
		f.db.prepare("UPDATE agent_session_turns SET state = 'exited', cleanup_verified = 0 WHERE id = ?").run(targetTurnId);
		const unverified = f.store.markStopResult(request.id);
		assert.equal(unverified.state, 'stopUnverified');
		assert.equal(unverified.targetTurnState, 'exited');
		f.db.prepare('UPDATE agent_session_turns SET cleanup_verified = 1 WHERE id = ?').run(targetTurnId);
		const completed = f.store.markStopResult(request.id);
		assert.equal(completed.state, 'stopCompleted');
		assert.equal(completed.targetTurnState, 'exited');
	} finally { f.db.close(); }
});

test('cross-session stop rejects absent and stale workflow approval or mismatched caller turn', () => {
	const f = fixture();
	try {
		const targetTurnId = randomUUID();
		f.db.prepare('INSERT INTO agent_session_turns(id, project_id, session_id, state, snapshot_sha256) VALUES (?, ?, ?, ?, ?)').run(targetTurnId, PROJECT, f.targetSessionId, 'running', 'e'.repeat(64));
		assert.throws(() => f.store.createStopRequest({ ...f.base, targetTurnId, idempotencyKey: 'without-authority' }), /requires trusted workflow authority/);
		const authority = addApprovedWorkflow(f, targetTurnId);
		f.db.prepare('UPDATE agent_workflows SET plan_version = 4 WHERE id = ?').run(authority.workflowId);
		assert.throws(() => f.store.createStopRequest({ ...f.base, targetTurnId, idempotencyKey: 'stale-plan', workflowAuthority: authority }), /stale or is not the current approved active run/);
		f.db.prepare('UPDATE agent_workflows SET plan_version = 3 WHERE id = ?').run(authority.workflowId);
		assert.throws(() => f.store.createStopRequest({ ...f.base, callerTurnId: randomUUID(), targetTurnId, idempotencyKey: 'wrong-source', workflowAuthority: authority }), /caller must be the exact live turn/);
	} finally { f.db.close(); }
});

test('waiting UI session status still authorizes its exact running caller turn', () => {
	const f = fixture();
	try {
		f.db.prepare("UPDATE agent_sessions SET state = 'waitingForInput' WHERE id = ?").run(f.callerSessionId);
		const request = f.store.createStartRequest({ ...f.startInput, idempotencyKey: 'waiting-session-caller' });
		assert.equal(request.state, 'pendingReview');
	} finally { f.db.close(); }
});

test('start request accepts a same-project target in another task and binding without launching, and rejects a foreign-project target', () => {
	const f = fixture();
	try {
		const otherTaskSessionId = randomUUID();
		f.db.prepare('INSERT INTO agent_sessions(id, project_id, binding_id, task_id, state, revision) VALUES (?, ?, ?, ?, ?, ?)').run(otherTaskSessionId, PROJECT, 'binding-other', 'task-other', 'idle', 1);
		const request = f.store.createStartRequest({ ...f.startInput, targetSessionId: otherTaskSessionId, expectedSessionRevision: 1, idempotencyKey: 'other-task' });
		assert.equal(request.state, 'pendingReview');
		assert.equal(request.targetSessionId, otherTaskSessionId);
		assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM agent_session_turns WHERE session_id = ?').get(otherTaskSessionId)?.count, 0);
		const approval = f.store.beginStart(request.id, request.revision, '7'.repeat(64), 'approve-other-task');
		assert.equal(approval.request.state, 'starting');
		assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM agent_session_turns WHERE session_id = ?').get(otherTaskSessionId)?.count, 0);

		const foreignProjectId = randomUUID();
		const foreignSessionId = randomUUID();
		f.db.prepare('INSERT INTO projects(id) VALUES (?)').run(foreignProjectId);
		f.db.prepare('INSERT INTO agent_sessions(id, project_id, binding_id, task_id, state, revision) VALUES (?, ?, ?, ?, ?, ?)').run(foreignSessionId, foreignProjectId, 'binding-foreign', 'task-foreign', 'idle', 1);
		assert.throws(() => f.store.createStartRequest({ ...f.startInput, targetSessionId: foreignSessionId, expectedSessionRevision: 1, idempotencyKey: 'foreign-project' }), /caller project/);
	} finally { f.db.close(); }
});

test('stop request rejects a same-project target outside the caller task and binding', () => {
	const f = fixture();
	try {
		const foreignBindingSessionId = randomUUID();
		const foreignBindingTurnId = randomUUID();
		f.db.prepare('INSERT INTO agent_sessions(id, project_id, binding_id, task_id, state, revision) VALUES (?, ?, ?, ?, ?, ?)').run(foreignBindingSessionId, PROJECT, 'binding-other', 'task-other', 'running', 1);
		f.db.prepare('INSERT INTO agent_session_turns(id, project_id, session_id, state, snapshot_sha256) VALUES (?, ?, ?, ?, ?)').run(foreignBindingTurnId, PROJECT, foreignBindingSessionId, 'running', '8'.repeat(64));
		assert.throws(() => f.store.createStopRequest({
			...f.base, targetSessionId: foreignBindingSessionId, targetTurnId: foreignBindingTurnId, idempotencyKey: 'foreign-binding-stop',
		}), /project, task, and binding/);
	} finally { f.db.close(); }
});

test('stale starting requests are marked interrupted when the store is reconstructed', () => {
	const f = fixture();
	try {
		const request = f.store.createStartRequest(f.startInput);
		const claimed = f.store.beginStart(request.id, request.revision, 'f'.repeat(64), 'approval-crashed');
		assert.equal(claimed.request.state, 'starting');
		const recovered = new AgentSessionControlRequestStore(f.db, () => undefined);
		assert.equal(recovered.recoverInterruptedStarts(), 1);
		assert.equal(recovered.get(PROJECT, request.id)?.state, 'interrupted');
	} finally { f.db.close(); }
});
