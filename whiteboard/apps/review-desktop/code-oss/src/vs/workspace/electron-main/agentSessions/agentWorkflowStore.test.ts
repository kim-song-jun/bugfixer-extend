/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import type { AgentWorkflowPlanInput } from '../../common/workspaceAgentWorkflowProtocol.js';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';

function withDatabase(run: (database: WorkspaceDatabase, fixtureRoot: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), 'agent-workflow-fixture-'));
	const fixtureRoot = join(directory, 'project');
	mkdirSync(fixtureRoot);
	const database = WorkspaceDatabase.open(':memory:');
	try { run(database, fixtureRoot); }
	finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
}

function projectFixture(database: WorkspaceDatabase, name = 'Workflow project', folderPath?: string) {
	const project = database.createProject(name);
	const binding = database.createFolderBinding({ projectId: project.id, path: folderPath ?? `/work/${name.toLowerCase().replaceAll(' ', '-')}` });
	const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Implement finite workflow' });
	return { project, binding, task };
}

function createSession(database: WorkspaceDatabase, projectId: string, bindingId: string, taskId: string | undefined, provider: 'codex' | 'claude' = 'codex', workspaceMode: 'gitWorktree' | 'sharedFolder' = 'gitWorktree') {
	return database.agentSessions.createSession({ projectId, bindingId, taskId, name: 'Workflow session', provider, model: provider === 'codex' ? 'gpt-5-codex' : 'sonnet', workspaceMode });
}

function createStartingSessionTurn(database: WorkspaceDatabase, projectId: string, bindingId: string, taskId: string, sessionId: string, folderPath: string, workflowLaunchAuthorization?: { readonly reservationId: string }) {
	const session = database.agentSessions.getSession(projectId, sessionId)!;
	const cwd = realpathSync(folderPath);
	const stats = statSync(cwd, { bigint: true });
	const snapshot: AgentSessionTurnSnapshot = {
		schemaVersion: 1, projectId, sessionId, sessionRevision: session.revision, bindingId, taskId,
		provider: session.provider, model: session.model, profileRef: session.profileRef, cwd,
		folderIdentity: { canonicalPath: cwd, dev: stats.dev.toString(), ino: stats.ino.toString() },
		managedWorktreeOwnerId: null, permissionPolicy: { mode: 'read-only', approval: 'on-request' }, convention: null, references: [],
	};
	const created = database.agentSessionTurns.createTurn({
		projectId, sessionId, expectedSessionRevision: session.revision, snapshot,
		...(workflowLaunchAuthorization ? { workflowLaunchAuthorization } : {}),
	});
	return { turn: created, session };
}

function createRunningSessionTurn(database: WorkspaceDatabase, projectId: string, bindingId: string, taskId: string, sessionId: string, folderPath: string, workflowLaunchAuthorization?: { readonly reservationId: string }) {
	const created = createStartingSessionTurn(database, projectId, bindingId, taskId, sessionId, folderPath, workflowLaunchAuthorization).turn;
	const identified = database.agentSessionTurns.recordProviderConversationId(projectId, sessionId, created.id, created.revision, randomUUID());
	const startingSession = database.agentSessions.getSession(projectId, sessionId)!;
	return database.agentSessionTurns.transitionTurn(projectId, sessionId, created.id, identified.revision, startingSession.revision, { state: 'running' });
}

function plan(projectId: string, sessionId: string, bindingId: string, taskId: string | null, overrides: Partial<AgentWorkflowPlanInput> = {}): AgentWorkflowPlanInput {
	return {
		projectId, bindingId, taskId, maxConcurrentNodes: 2, maxTotalTurns: 4, maxDurationMs: 60_000,
		nodes: [{ nodeId: 'implement', sessionId, role: 'implementer', provider: 'codex', model: 'gpt-5-codex', taskId, bindingId, referenceIds: [], permissionPolicy: { mode: 'read-only', approval: 'on-request' }, dependsOn: [] }],
		...overrides,
	};
}

function create(database: WorkspaceDatabase, projectId: string, input: AgentWorkflowPlanInput, key = 'create-1') {
	return database.agentWorkflows.createWorkflow(projectId, { ...input, idempotencyKey: key });
}

function approveAndStart(database: WorkspaceDatabase, projectId: string, workflowId: string) {
	const planRecord = database.agentWorkflows.getPlan(projectId, workflowId)!;
	database.agentWorkflows.recordTrustedUiApproval(projectId, workflowId, planRecord.version, planRecord.fingerprint, 'approval-1');
	const ready = database.agentWorkflows.getWorkflow(projectId, workflowId)!;
	return database.agentWorkflows.startWorkflow(projectId, workflowId, ready.revision, 'start-1');
}

test('finite workflow plan, approval receipt and ready run persist across SQLite reopen', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-workflow-reopen-'));
	const path = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(path);
	try {
		const { project, binding, task } = projectFixture(database);
		const session = createSession(database, project.id, binding.id, task.id);
		const workflow = create(database, project.id, plan(project.id, session.id, binding.id, task.id));
		const run = approveAndStart(database, project.id, workflow.id);
		assert.equal(run.state, 'ready');
		assert.equal(run.nodes[0].state, 'ready');
		database.close();
		database = WorkspaceDatabase.open(path);
		assert.equal(database.agentWorkflows.getWorkflow(project.id, workflow.id)?.state, 'ready');
		assert.deepEqual(database.agentWorkflows.getPlan(project.id, workflow.id)?.nodes[0].sessionId, session.id);
		assert.deepEqual(database.agentWorkflows.startWorkflow(project.id, workflow.id, 2, 'start-1'), run);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
test('frozen schema v24 migration retains project, task and session rows through schema v31', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-workflow-v24-'));
	const path = join(directory, 'workspace.db');
	const projectId = randomUUID();
	const bindingId = randomUUID();
	const taskId = randomUUID();
	const sessionId = randomUUID();
	const legacy = new DatabaseSync(path);
	try {
		legacy.exec(readFileSync(new URL('./fixtures/schema-v24.sql', import.meta.url), 'utf8'));
		const now = new Date().toISOString();
		legacy.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(projectId, 'Preserved v24', now);
		legacy.prepare('INSERT INTO folder_bindings (id, project_id, path, created_at) VALUES (?, ?, ?, ?)').run(bindingId, projectId, '/work/preserved-v24', now);
		legacy.prepare(`INSERT INTO tasks (id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at)
			VALUES (?, ?, ?, ?, NULL, 'ready', 0, 1, ?, ?)`).run(taskId, projectId, bindingId, 'Implement finite workflow', now, now);
		legacy.prepare(`INSERT INTO agent_sessions (id, project_id, binding_id, task_id, parent_session_id, name, provider, model, profile_ref,
			workspace_mode, state, revision, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, 'codex', 'gpt-5-codex', NULL, 'gitWorktree', 'created', 1, ?, ?)`)
			.run(sessionId, projectId, bindingId, taskId, 'Preserved session', now, now);
	} finally { legacy.close(); }
	const database = WorkspaceDatabase.open(path);
	try {
		assert.equal(database.getProject(projectId)?.name, 'Preserved v24');
		assert.equal(database.getTask(taskId)?.title, 'Implement finite workflow');
		assert.equal(database.agentSessions.getSession(projectId, sessionId)?.id, sessionId);
		assert.equal(Number((Reflect.get(database, 'db') as DatabaseSync).prepare('PRAGMA user_version').get()?.user_version), 31);
		assert.ok(database.agentWorkflows.getWorkflow(projectId, randomUUID()) === undefined);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('workflow creation rejects foreign task, knowledge, project and binding references, duplicate nodes and DAG cycles', () => {
	withDatabase(database => {
		const first = projectFixture(database, 'First workflow project');
		const second = projectFixture(database, 'Second workflow project');
		const session = createSession(database, first.project.id, first.binding.id, first.task.id);
		const foreignSnapshot = database.knowledge.importReference({ projectId: second.project.id, connectorId: 'fixture', connectorVersion: '1', externalId: 'foreign', title: 'Foreign source', contentType: 'text/plain; charset=utf-8', content: Buffer.from('private') });
		assert.throws(() => create(database, first.project.id, plan(first.project.id, session.id, first.binding.id, first.task.id, {
			nodes: [{ ...plan(first.project.id, session.id, first.binding.id, first.task.id).nodes[0], referenceIds: [{ kind: 'knowledgeSnapshot', id: foreignSnapshot.id }] }],
		}), 'foreign-ref'), /does not belong to the workflow project/i);
		assert.throws(() => create(database, first.project.id, plan(first.project.id, session.id, first.binding.id, second.task.id), 'foreign-task'), /active and belong/i);
		const secondSession = createSession(database, first.project.id, first.binding.id, first.task.id, 'claude');
		const firstNode = plan(first.project.id, session.id, first.binding.id, first.task.id).nodes[0];
		const secondNode = { ...firstNode, nodeId: 'review', sessionId: secondSession.id, provider: 'claude' as const, model: 'sonnet', dependsOn: ['implement'] };
		assert.throws(() => create(database, first.project.id, plan(first.project.id, session.id, first.binding.id, first.task.id, { nodes: [firstNode, { ...secondNode, nodeId: 'implement' }] }), 'duplicate-node'), /IDs must be unique/i);
		assert.throws(() => create(database, first.project.id, plan(first.project.id, session.id, first.binding.id, first.task.id, { nodes: [{ ...firstNode, dependsOn: ['review'] }, secondNode] }), 'cycle'), /contains a cycle/i);
		assert.throws(() => create(database, first.project.id, plan(first.project.id, session.id, first.binding.id, first.task.id, { nodes: [firstNode, { ...secondNode, sessionId: session.id, provider: 'codex', model: 'gpt-5-codex', dependsOn: [] }] }), 'duplicate-session'), /session can appear only once/i);
		assert.throws(() => create(database, second.project.id, plan(second.project.id, session.id, first.binding.id, first.task.id), 'foreign-session'), /project and binding/i);
		assert.throws(() => create(database, second.project.id, plan(first.project.id, session.id, first.binding.id, first.task.id), 'mismatched-plan-project'), /plan project ID/i);
	});
});

test('exact plan fingerprint approval, immutable revisions, stale CAS and bounded explicit limits', () => {
	withDatabase(database => {
		const { project, binding, task } = projectFixture(database);
		const session = createSession(database, project.id, binding.id, task.id);
		const input = plan(project.id, session.id, binding.id, task.id);
		const workflow = create(database, project.id, input);
		assert.equal(create(database, project.id, input).id, workflow.id);
		assert.throws(() => create(database, project.id, { ...input, maxDurationMs: 120_000 }), /different plan/i);
		const currentPlan = database.agentWorkflows.getPlan(project.id, workflow.id)!;
		assert.throws(() => database.agentWorkflows.recordTrustedUiApproval(project.id, workflow.id, currentPlan.version, '0'.repeat(64), 'approval-bad'), /changed after review/i);
		const receipt = database.agentWorkflows.recordTrustedUiApproval(project.id, workflow.id, currentPlan.version, currentPlan.fingerprint, 'approval-good');
		assert.equal(database.agentWorkflows.recordTrustedUiApproval(project.id, workflow.id, currentPlan.version, currentPlan.fingerprint, 'approval-good').id, receipt.id);
		assert.throws(() => database.agentWorkflows.recordTrustedUiApproval(project.id, workflow.id, currentPlan.version, '0'.repeat(64), 'approval-good'), /different plan fingerprint/i);
		assert.throws(() => database.agentWorkflows.reviseWorkflowPlan(project.id, workflow.id, workflow.revision, input), /stale/i);
		const approvedWorkflow = database.agentWorkflows.getWorkflow(project.id, workflow.id)!;
		const revised = database.agentWorkflows.reviseWorkflowPlan(project.id, workflow.id, approvedWorkflow.revision, { ...input, maxDurationMs: 120_000 });
		assert.equal(revised.planVersion, 2);
		assert.equal(revised.state, 'waiting');
		assert.equal(database.agentWorkflows.getPlan(project.id, workflow.id, 1)?.fingerprint, currentPlan.fingerprint);
		const sqlite = Reflect.get(database, 'db') as DatabaseSync;
		assert.throws(() => sqlite.prepare(`UPDATE agent_workflow_plans SET plan_json = '{}' WHERE workflow_id = ? AND version = 1`).run(workflow.id), /immutable/i);
		assert.throws(() => database.agentWorkflows.startWorkflow(project.id, workflow.id, revised.revision, 'start-revised'), /must be approved/i);
		assert.throws(() => create(database, project.id, plan(project.id, session.id, binding.id, task.id, { maxConcurrentNodes: 9 }), 'too-concurrent'), /between 1 and 8/i);
		assert.throws(() => create(database, project.id, plan(project.id, session.id, binding.id, task.id, { maxTotalTurns: 0 }), 'no-turn-limit'), /between 1 and 64/i);
		assert.throws(() => create(database, project.id, plan(project.id, session.id, binding.id, task.id, { maxDurationMs: 0 }), 'no-time-limit'), /between 1000 and/i);
	});
});

test('workflow cancellation waits for host cleanup and idempotent source events reject changed content', () => {
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow cancellation', fixtureRoot);
		const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const workflow = create(database, project.id, plan(project.id, session.id, binding.id, task.id));
		const run = approveAndStart(database, project.id, workflow.id);
		const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, session.revision);
		const runningTurn = createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId });
		const running = database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 3, 'running', runningTurn.turn.id);
		assert.equal(running.state, 'running');
		const cancelRequested = database.agentWorkflows.requestWorkflowCancellation(project.id, workflow.id, 3, 'cancel-1');
		assert.equal(cancelRequested.state, 'cancelRequested');
		assert.equal(database.agentWorkflows.getRun(project.id, workflow.id, run.id)?.nodes[0].state, 'cancelRequested');
		assert.throws(() => database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 5, 'cancelled'), /terminal and host cleanup is verified/i);
		const turnExit = database.agentSessionTurns.transitionTurn(project.id, session.id, runningTurn.turn.id, runningTurn.turn.revision, runningTurn.session.revision, { state: 'exited', exitCode: 0 });
		database.agentSessionTurns.confirmTurnCleanup(project.id, session.id, turnExit.turn.id, turnExit.turn.revision);
		const settled = database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 5, 'cancelled');
		assert.equal(settled.state, 'cancelled');
		assert.equal(database.agentWorkflows.requestWorkflowCancellation(project.id, workflow.id, 4, 'cancel-1').state, 'cancelled');
		const firstEvent = database.agentWorkflows.recordSourceEvent(project.id, workflow.id, 'source:event:1', { kind: 'message', sequence: 1 });
		assert.equal(firstEvent.duplicate, false);
		assert.equal(database.agentWorkflows.recordSourceEvent(project.id, workflow.id, 'source:event:1', { sequence: 1, kind: 'message' }).duplicate, true);
		assert.throws(() => database.agentWorkflows.recordSourceEvent(project.id, workflow.id, 'source:event:1', { kind: 'message', sequence: 2 }), /different event content/i);
	});
});

test('only a consumed trusted reservation links the exact approved turn; ordinary turns cannot attach retroactively', () => {
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow reservation', fixtureRoot);
		const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const workflow = create(database, project.id, plan(project.id, session.id, binding.id, task.id));
		const priorOrdinaryTurn = createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot);
		const exit = database.agentSessionTurns.transitionTurn(project.id, session.id, priorOrdinaryTurn.turn.id, priorOrdinaryTurn.turn.revision, priorOrdinaryTurn.session.revision, { state: 'exited', exitCode: 0 });
		database.agentSessionTurns.confirmTurnCleanup(project.id, session.id, exit.turn.id, exit.turn.revision);
		const run = approveAndStart(database, project.id, workflow.id);
		assert.throws(() => database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 1, 'running', priorOrdinaryTurn.turn.id), /state transition is invalid/i);
		const untouched = database.agentWorkflows.getRun(project.id, workflow.id, run.id)!;
		assert.equal(untouched.nodes[0].state, 'ready');
		assert.equal(untouched.nodes[0].revision, 1);
		assert.equal(untouched.nodes[0].sessionTurnId, null);
		const currentSession = database.agentSessions.getSession(project.id, session.id)!;
		const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, currentSession.revision);
		assert.notEqual(reservation.turnId, priorOrdinaryTurn.turn.id);
		const ordinaryAfterReservation = createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot);
		assert.notEqual(ordinaryAfterReservation.turn.id, reservation.turnId);
		assert.throws(() => database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 2, 'running', ordinaryAfterReservation.turn.id), /exact turn bound by its launch transaction/i);
		const stillReserved = database.agentWorkflows.getRun(project.id, workflow.id, run.id)!.nodes[0];
		assert.equal(stillReserved.state, 'launching');
		assert.equal(stillReserved.revision, 2);
		assert.equal(stillReserved.sessionTurnId, null);
		assert.throws(() => createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId }), /authorization|revision/i);
	});
});

test('a linked launching node cannot hide a starting or running turn as ready or blocked', () => {
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow linked-turn visibility', fixtureRoot);
		for (const turnState of ['starting', 'running'] as const) {
			const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
			const workflow = create(database, project.id, plan(project.id, session.id, binding.id, task.id), `linked-${turnState}`);
			const run = approveAndStart(database, project.id, workflow.id);
			const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, session.revision);
			const turn = turnState === 'starting'
				? createStartingSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId })
				: createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId });

			for (const nextState of ['ready', 'blocked'] as const) {
				assert.throws(
					() => database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 3, nextState),
					/linked or consumed turn/i,
				);
			}
			const sqlite = Reflect.get(database, 'db') as DatabaseSync;
			const persisted = sqlite.prepare('SELECT state, revision, session_turn_id FROM agent_workflow_run_nodes WHERE run_id = ? AND node_id = ?').get(run.id, 'implement') as { state: string; revision: number; session_turn_id: string };
			assert.equal(persisted.state, 'launching');
			assert.equal(persisted.revision, 3);
			assert.equal(persisted.session_turn_id, turn.turn.id);
		}
	});
});

test('a successful turn may finish while its workflow node is still launching', () => {
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow fast turn completion', fixtureRoot);
		const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const workflow = create(database, project.id, plan(project.id, session.id, binding.id, task.id));
		const run = approveAndStart(database, project.id, workflow.id);
		const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, session.revision);
		const turn = createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId });
		const exited = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.turn.id, turn.turn.revision, turn.session.revision, {
			state: 'exited', exitCode: 0, cleanupVerified: true,
		});

		const completed = database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 3, 'succeeded');
		assert.equal(completed.state, 'succeeded');
		assert.equal(completed.nodes[0].state, 'succeeded');
		assert.equal(completed.nodes[0].sessionTurnId, exited.turn.id);
	});
});

test('reservation is single-use, exact-turn-bound, and revoked on cancellation or deadline expiry', () => {
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow reserved launch', fixtureRoot);
		const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const workflow = create(database, project.id, plan(project.id, session.id, binding.id, task.id));
		const run = approveAndStart(database, project.id, workflow.id);
		const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, session.revision);
		const turn = createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId });
		assert.equal(turn.turn.id, reservation.turnId);
		assert.throws(() => database.agentSessionTurns.createTurn({
			projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision,
			snapshot: turn.turn.snapshot, workflowLaunchAuthorization: { reservationId: reservation.reservationId },
		}), /authorization/i);
		const linked = database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 3, 'running', turn.turn.id);
		assert.equal(linked.nodes[0].sessionTurnId, reservation.turnId);
	});
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow cancelled reservation', fixtureRoot);
		const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const basePlan = plan(project.id, session.id, binding.id, task.id, { maxConcurrentNodes: 1, maxTotalTurns: 2 });
		const waitingSession = createSession(database, project.id, binding.id, task.id, 'claude', 'sharedFolder');
		const waitingNode = { ...basePlan.nodes[0], nodeId: 'review', sessionId: waitingSession.id, role: 'reviewer' as const, provider: 'claude' as const, model: 'sonnet' };
		const workflow = create(database, project.id, { ...basePlan, nodes: [basePlan.nodes[0], waitingNode] });
		const run = approveAndStart(database, project.id, workflow.id);
		const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, session.revision);
		assert.throws(() => database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'review', 1, waitingSession.revision), /maximum concurrency/i);
		const turn = createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId });
		const cancelRequested = database.agentWorkflows.requestWorkflowCancellation(project.id, workflow.id, 3, 'cancel-reserved');
		const cancelledRun = database.agentWorkflows.getRun(project.id, workflow.id, run.id)!;
		assert.equal(cancelRequested.state, 'cancelRequested');
		assert.equal(cancelledRun.state, 'cancelRequested');
		assert.equal(cancelledRun.nodes[0].state, 'cancelRequested');
		assert.equal(cancelledRun.nodes[0].sessionTurnId, turn.turn.id);
		assert.equal(database.agentSessionTurns.getTurn(project.id, session.id, turn.turn.id)?.cleanupVerified, false);
		const sqlite = Reflect.get(database, 'db') as DatabaseSync;
		const occupiedSlots = Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM agent_workflow_run_nodes
			WHERE run_id = ? AND state IN ('running', 'cancelRequested')`).get(run.id)?.count);
		assert.equal(occupiedSlots, 1, 'A linked turn awaiting verified host cleanup must keep its concurrency slot.');
		assert.throws(() => database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', cancelledRun.nodes[0].revision, 'cancelled'), /host cleanup is verified/i);
		const stopped = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.turn.id, turn.turn.revision, turn.session.revision, {
			state: 'exited', exitCode: 0, cleanupVerified: true,
		});
		const settled = database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', cancelledRun.nodes[0].revision, 'cancelled');
		assert.equal(settled.state, 'cancelled');
		assert.equal(settled.nodes[0].sessionTurnId, stopped.turn.id);
		assert.throws(() => createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId }), /authorization/i);
	});
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow unconsumed reservation cancellation', fixtureRoot);
		const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const workflow = create(database, project.id, plan(project.id, session.id, binding.id, task.id));
		const run = approveAndStart(database, project.id, workflow.id);
		const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, session.revision);
		const cancelled = database.agentWorkflows.requestWorkflowCancellation(project.id, workflow.id, 3, 'cancel-unconsumed-reservation');
		assert.equal(cancelled.state, 'cancelled');
		assert.equal(database.agentWorkflows.getRun(project.id, workflow.id, run.id)?.nodes[0].state, 'cancelled');
		assert.throws(() => createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId }), /authorization/i);
	});
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow expired reservation', fixtureRoot);
		const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const shortPlan = plan(project.id, session.id, binding.id, task.id, { maxDurationMs: 1_000 });
		const workflow = create(database, project.id, shortPlan);
		const run = approveAndStart(database, project.id, workflow.id);
		const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, session.revision);
		assert.equal(database.agentWorkflows.expireOverdueRuns(new Date(Date.parse(run.deadlineAt) + 1).toISOString()), 1);
		assert.throws(() => createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId }), /authorization/i);
		assert.equal(database.agentWorkflows.getWorkflow(project.id, workflow.id)?.state, 'blocked');
	});
});

test('a launching reservation occupies the single concurrency slot before any turn can be created', () => {
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow concurrency', fixtureRoot);
		const firstSession = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const secondSession = createSession(database, project.id, binding.id, task.id, 'claude', 'sharedFolder');
		const base = plan(project.id, firstSession.id, binding.id, task.id);
		const secondNode = { ...base.nodes[0], nodeId: 'review', sessionId: secondSession.id, role: 'reviewer' as const, provider: 'claude' as const, model: 'sonnet' };
		const workflow = create(database, project.id, { ...base, maxConcurrentNodes: 1, maxTotalTurns: 2, nodes: [base.nodes[0], secondNode] });
		const run = approveAndStart(database, project.id, workflow.id);
		const firstReservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, firstSession.revision);
		assert.throws(() => database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'review', 1, secondSession.revision), /maximum concurrency/i);
		const sqlite = Reflect.get(database, 'db') as DatabaseSync;
		assert.equal(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_workflow_turn_reservations WHERE run_id = ?').get(run.id)?.count), 1);
		assert.equal(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_turns').get()?.count), 0);
		database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 2, 'ready');
		const secondReservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'review', 1, secondSession.revision);
		assert.notEqual(secondReservation.reservationId, firstReservation.reservationId, 'Resetting an unlaunched node must immediately release its reserved slot.');
		assert.throws(() => createStartingSessionTurn(database, project.id, binding.id, task.id, firstSession.id, fixtureRoot, { reservationId: firstReservation.reservationId }), /authorization|revoked|launching/i);
		assert.equal(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_turns').get()?.count), 0);
	});
});

test('reservation TTL does not invalidate an atomically created turn before its workflow deadline', () => {
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow reservation TTL', fixtureRoot);
		const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const workflow = create(database, project.id, plan(project.id, session.id, binding.id, task.id, { maxDurationMs: 120_000 }));
		const run = approveAndStart(database, project.id, workflow.id);
		const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, session.revision);
		const turn = createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId });
		const afterReservationExpiry = Date.parse(reservation.expiresAt) + 1;
		assert.ok(afterReservationExpiry < Date.parse(run.deadlineAt));
		const originalDateNow = Date.now;
		try {
			Date.now = () => afterReservationExpiry;
			const linked = database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 3, 'running', turn.turn.id);
			assert.equal(linked.nodes[0].state, 'running');
		} finally {
			Date.now = originalDateNow;
		}
	});
});

test('an expired unused reservation releases its launch slot without releasing a created turn', () => {
	withDatabase(database => {
		const { project, binding, task } = projectFixture(database, 'Workflow expired capacity');
		const firstSession = createSession(database, project.id, binding.id, task.id);
		const secondSession = createSession(database, project.id, binding.id, task.id, 'claude');
		const base = plan(project.id, firstSession.id, binding.id, task.id, { maxConcurrentNodes: 1, maxTotalTurns: 2, maxDurationMs: 120_000 });
		const secondNode = { ...base.nodes[0], nodeId: 'review', sessionId: secondSession.id, role: 'reviewer' as const, provider: 'claude' as const, model: 'sonnet' };
		const workflow = create(database, project.id, { ...base, nodes: [base.nodes[0], secondNode] });
		const run = approveAndStart(database, project.id, workflow.id);
		const expired = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, firstSession.revision);
		assert.equal(database.agentWorkflows.expireExpiredLaunchReservations(new Date(Date.parse(expired.expiresAt) + 1).toISOString()), 1);
		const replacement = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'review', 1, secondSession.revision);
		assert.ok(replacement.reservationId);
		const sqlite = Reflect.get(database, 'db') as DatabaseSync;
		assert.equal(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_workflow_turn_reservations WHERE run_id = ? AND revoked_at IS NULL AND consumed_at IS NULL').get(run.id)?.count), 1);
		assert.equal(Number(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_turns').get()?.count), 0);
	});
});

test('cancellation after revising a completed workflow targets the current plan, not its old run', () => {
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow revised cancellation', fixtureRoot);
		const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const originalPlan = plan(project.id, session.id, binding.id, task.id);
		const workflow = create(database, project.id, originalPlan);
		const run = approveAndStart(database, project.id, workflow.id);
		const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, session.revision);
		const turn = createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, fixtureRoot, { reservationId: reservation.reservationId });
		database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 3, 'running', turn.turn.id);
		const ended = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.turn.id, turn.turn.revision, turn.session.revision, { state: 'exited', exitCode: 0 });
		database.agentSessionTurns.confirmTurnCleanup(project.id, session.id, ended.turn.id, ended.turn.revision);
		const completed = database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 4, 'succeeded');
		assert.equal(completed.state, 'succeeded');
		const current = database.agentWorkflows.getWorkflow(project.id, workflow.id)!;
		const revised = database.agentWorkflows.reviseWorkflowPlan(project.id, workflow.id, current.revision, { ...originalPlan, maxDurationMs: 120_000 });
		assert.equal(revised.state, 'waiting');
		assert.equal(revised.planVersion, 2);
		const cancelled = database.agentWorkflows.requestWorkflowCancellation(project.id, workflow.id, revised.revision, 'cancel-current-plan');
		assert.equal(cancelled.state, 'cancelled');
		assert.equal(database.agentWorkflows.getRun(project.id, workflow.id, run.id)?.state, 'succeeded');
	});
});

test('a failed node requests cancellation of every active sibling without claiming cleanup', () => {
	withDatabase((database, fixtureRoot) => {
		const { project, binding, task } = projectFixture(database, 'Workflow failure cascade', fixtureRoot);
		const implementSession = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const reviewSession = createSession(database, project.id, binding.id, task.id, 'claude', 'sharedFolder');
		const base = plan(project.id, implementSession.id, binding.id, task.id);
		const reviewNode = { ...base.nodes[0], nodeId: 'review', sessionId: reviewSession.id, role: 'reviewer' as const, provider: 'claude' as const, model: 'sonnet' };
		const workflow = create(database, project.id, { ...base, maxConcurrentNodes: 2, maxTotalTurns: 2, nodes: [base.nodes[0], reviewNode] });
		const run = approveAndStart(database, project.id, workflow.id);
		const implementReservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, implementSession.revision);
		const reviewReservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'review', 1, reviewSession.revision);
		const implementTurn = createRunningSessionTurn(database, project.id, binding.id, task.id, implementSession.id, fixtureRoot, { reservationId: implementReservation.reservationId });
		const reviewTurn = createRunningSessionTurn(database, project.id, binding.id, task.id, reviewSession.id, fixtureRoot, { reservationId: reviewReservation.reservationId });
		database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 3, 'running', implementTurn.turn.id);
		database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'review', 3, 'running', reviewTurn.turn.id);
		const failedTurn = database.agentSessionTurns.transitionTurn(project.id, implementSession.id, implementTurn.turn.id, implementTurn.turn.revision, implementTurn.session.revision, { state: 'failed', errorSummary: 'Implementation failed.', cleanupVerified: true });
		const failedRun = database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 4, 'failed');
		assert.equal(failedRun.nodes.find(node => node.nodeId === 'implement')?.state, 'failed');
		assert.equal(failedRun.nodes.find(node => node.nodeId === 'review')?.state, 'cancelRequested');
		assert.equal(failedRun.state, 'cancelRequested');
		assert.equal(failedRun.nodes.find(node => node.nodeId === 'review')?.sessionTurnId, reviewTurn.turn.id);
		assert.equal(database.agentSessionTurns.getTurn(project.id, implementSession.id, failedTurn.turn.id)?.cleanupVerified, true);
		assert.equal(database.agentSessionTurns.getTurn(project.id, reviewSession.id, reviewTurn.turn.id)?.cleanupVerified, false);
	});
});

test('restart after atomic turn creation retains the exact linked turn and requires recovery', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-workflow-launch-recovery-'));
	const path = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(path);
	try {
		const folderPath = join(directory, 'project-folder');
		mkdirSync(folderPath);
		const { project, binding, task } = projectFixture(database, 'Workflow launch recovery', folderPath);
		const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const workflow = create(database, project.id, plan(project.id, session.id, binding.id, task.id));
		const run = approveAndStart(database, project.id, workflow.id);
		const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, session.revision);
		const startingTurn = createStartingSessionTurn(database, project.id, binding.id, task.id, session.id, folderPath, { reservationId: reservation.reservationId });
		database.close();
		database = WorkspaceDatabase.open(path);
		const recovered = database.agentWorkflows.getRun(project.id, workflow.id, run.id)!;
		assert.equal(recovered.state, 'recoveryRequired');
		assert.equal(recovered.nodes[0].state, 'recoveryRequired');
		assert.equal(recovered.nodes[0].sessionTurnId, startingTurn.turn.id);
		assert.equal(database.agentSessionTurns.getTurn(project.id, session.id, startingTurn.turn.id)?.cleanupVerified, false);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('process restart marks unverifiable active workflows recoveryRequired without implying cleanup', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-workflow-recovery-'));
	const path = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(path);
	try {
		const { project, binding, task } = projectFixture(database, 'Workflow recovery', join(directory, 'project-folder'));
		const folderPath = join(directory, 'project-folder');
		mkdirSync(folderPath);
		const session = createSession(database, project.id, binding.id, task.id, 'codex', 'sharedFolder');
		const workflow = create(database, project.id, plan(project.id, session.id, binding.id, task.id));
		const run = approveAndStart(database, project.id, workflow.id);
		const reservation = database.agentWorkflows.reserveNodeTurnLaunch(project.id, workflow.id, run.id, 'implement', 1, session.revision);
		const runningTurn = createRunningSessionTurn(database, project.id, binding.id, task.id, session.id, folderPath, { reservationId: reservation.reservationId });
		database.agentWorkflows.transitionNode(project.id, workflow.id, run.id, 'implement', 3, 'running', runningTurn.turn.id);
		database.close();
		database = WorkspaceDatabase.open(path);
		assert.equal(database.agentWorkflows.getWorkflow(project.id, workflow.id)?.state, 'recoveryRequired');
		const recovered = database.agentWorkflows.getRun(project.id, workflow.id, run.id)!;
		assert.equal(recovered.state, 'recoveryRequired');
		assert.equal(recovered.nodes[0].state, 'recoveryRequired');
		assert.equal(recovered.nodes[0].sessionTurnId, runningTurn.turn.id);
		assert.equal(recovered.nodes[0].cancelRequestedAt, null);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
