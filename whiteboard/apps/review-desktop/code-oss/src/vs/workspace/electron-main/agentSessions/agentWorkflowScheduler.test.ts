/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { AgentPtySnapshot } from './agentPtyHost.js';
import type { AgentSessionPermissionPolicy } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { TaskFolderWriterLock } from '../providerRuns/taskFolderWriterLock.js';
import { ManagedWorktreeService } from './managedWorktrees.js';
import { AgentSessionService, type AgentSessionRuntimeFactory, type AgentSessionRuntimeHandle } from './agentSessionService.js';
import { AgentSessionWorkspaceResolver } from './agentSessionWorkspace.js';
import { AgentWorkflowScheduler } from './agentWorkflowScheduler.js';

const POLICY: AgentSessionPermissionPolicy = { mode: 'read-only', approval: 'never' };

function fixture(nodeCount = 2, options: { independent?: boolean; delayedAcquire?: boolean; failedStop?: boolean; durationMs?: number } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'agent-workflow-scheduler-'));
	const folder = join(root, 'folder');
	mkdirSync(folder);
	const database = WorkspaceDatabase.open(join(root, 'workspace.db'));
	const project = database.createProject('Workflow scheduler test');
	const binding = database.createFolderBinding({ projectId: project.id, path: folder });
	const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Keep task open' });
	const sessions = Array.from({ length: nodeCount }, (_, index) => database.agentSessions.createSession({
		projectId: project.id, bindingId: binding.id, taskId: task.id, name: `Session ${index}`, provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder',
	}));
	const snapshots = new Map<string, AgentPtySnapshot>();
	const listeners = new Map<string, (snapshot: AgentPtySnapshot) => void>();
	const runtimeHandle = Object.freeze({}) as AgentSessionRuntimeHandle;
	const started: string[] = [];
	let stopCalls = 0;
	const runtimeFactory: AgentSessionRuntimeFactory = {
		async start(_snapshot, turnId) {
			started.push(turnId);
			const snapshot: AgentPtySnapshot = { state: 'running', latestSequence: 0, outputSanitizerFailed: false, failedOutputListeners: 0, failedExitListeners: 0, accessRevocationFailed: false };
			snapshots.set(turnId, snapshot);
			return runtimeHandle;
		},
		watchExit(_handle, listener) {
			const turnId = started.at(-1)!;
			listeners.set(turnId, listener);
			return { dispose() { listeners.delete(turnId); } };
		},
		getSnapshot(_handle) { return snapshots.get(started.at(-1)!)!; },
		async write() { }, async resize() { }, async attach() { throw new Error('Not used.'); },
		async stop() { stopCalls++; return options.failedStop ? { state: 'cleanupUnverified', cleanupVerified: false } : { state: 'stopped', cleanupVerified: true }; }, async release() { },
	};
	let releaseAcquire!: () => void;
	let markAcquireEntered!: () => void;
	const acquireEntered = new Promise<void>(resolve => { markAcquireEntered = resolve; });
	const acquireGate = new Promise<void>(resolve => { releaseAcquire = resolve; });
	class ControlledResolver extends AgentSessionWorkspaceResolver {
		override async acquire(input: Parameters<AgentSessionWorkspaceResolver['acquire']>[0]) {
			if (options.delayedAcquire) {
				markAcquireEntered();
				await new Promise<void>((resolve, reject) => {
					if (input.signal?.aborted) { reject(new Error('The workflow acquisition was cancelled.')); return; }
					const onAbort = () => reject(new Error('The workflow acquisition was cancelled.'));
					input.signal?.addEventListener('abort', onAbort, { once: true });
					acquireGate.then(resolve, reject);
				});
			}
			return super.acquire(input);
		}
	}
	const resolver = new ControlledResolver(database, new ManagedWorktreeService(join(root, 'worktrees')), new TaskFolderWriterLock(), () => true);
	const service = new AgentSessionService(database, resolver, runtimeFactory);
	const planNodes = sessions.map((session, index) => ({
		nodeId: `node-${index}`, sessionId: session.id, role: 'implementer' as const, provider: session.provider, model: session.model,
		taskId: task.id, bindingId: binding.id, referenceIds: [], permissionPolicy: POLICY, dependsOn: index === 0 || options.independent ? [] : [`node-${index - 1}`],
	}));
	const workflow = database.agentWorkflows.createWorkflow(project.id, {
		projectId: project.id, bindingId: binding.id, taskId: task.id, maxConcurrentNodes: 1, maxTotalTurns: nodeCount, maxDurationMs: options.durationMs ?? 60_000,
		nodes: planNodes, idempotencyKey: randomUUID(),
	});
	const plan = database.agentWorkflows.getPlan(project.id, workflow.id)!;
	database.agentWorkflows.recordTrustedUiApproval(project.id, workflow.id, plan.version, plan.fingerprint, randomUUID());
	const scheduler = new AgentWorkflowScheduler(database, service, Date.now, 10);
	return { root, database, project, task, workflow, plan, scheduler, service, started, snapshots, listeners, acquireEntered, releaseAcquire, get stopCalls() { return stopCalls; } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
	assert.equal(predicate(), true, 'the expected workflow transition did not occur');
}

function finishTurn(f: ReturnType<typeof fixture>, turnId: string, exitCode: number): void {
	const snapshot: AgentPtySnapshot = { ...f.snapshots.get(turnId)!, state: 'exited', providerExitCode: exitCode };
	f.snapshots.set(turnId, snapshot);
	f.listeners.get(turnId)?.(snapshot);
}

function cleanup(f: ReturnType<typeof fixture>): void {
	f.scheduler.stopScheduling();
	f.database.close();
	rmSync(f.root, { recursive: true, force: true });
}

function sqlCount(f: ReturnType<typeof fixture>, statement: string, ...parameters: string[]): number {
	const db = (f.database as unknown as { readonly db: DatabaseSync }).db;
	return Number((db.prepare(statement).get(...parameters) as { readonly count: number }).count);
}

test('approved DAG starts dependencies in order and successful execution leaves its board task open', async () => {
	const f = fixture();
	try {
		const run = f.scheduler.start(f.project.id, f.workflow.id, f.database.agentWorkflows.getWorkflow(f.project.id, f.workflow.id)!.revision, randomUUID());
		await waitFor(() => f.started.length === 1);
		assert.equal(f.database.agentWorkflows.getRun(f.project.id, f.workflow.id, run.id)!.nodes[1].state, 'waiting');
		finishTurn(f, f.started[0], 0);
		await waitFor(() => f.started.length === 2);
		finishTurn(f, f.started[1], 0);
		await waitFor(() => f.database.agentWorkflows.getRun(f.project.id, f.workflow.id, run.id)!.state === 'succeeded');
		assert.equal(f.database.getTask(f.task.id)!.state, 'ready');
	} finally { cleanup(f); }
});

test('a persisted run recovered after restart is never relaunched by a fresh scheduler', async () => {
	const f = fixture(1);
	let databaseClosed = false;
	try {
		const started = f.scheduler.start(f.project.id, f.workflow.id, f.database.agentWorkflows.getWorkflow(f.project.id, f.workflow.id)!.revision, randomUUID());
		await waitFor(() => f.started.length === 1);
		const path = join(f.root, 'workspace.db');
		f.scheduler.stopScheduling();
		await f.service.shutdown();
		f.database.close();
		databaseClosed = true;
		const reopened = WorkspaceDatabase.open(path);
		const project = reopened.getProject(f.project.id)!;
		const session = reopened.agentSessions.getSession(project.id, f.plan.nodes[0].sessionId)!;
		const resolver = new AgentSessionWorkspaceResolver(reopened, new ManagedWorktreeService(join(f.root, 'worktrees')), new TaskFolderWriterLock(), () => true);
		const freshService = new AgentSessionService(reopened, resolver, {
			async start() { throw new Error('A recovered workflow must not relaunch.'); }, watchExit() { return { dispose() { } }; }, getSnapshot() { throw new Error('No runtime.'); },
			async write() { }, async resize() { }, async attach() { throw new Error('No runtime.'); }, async stop() { return { state: 'stopped', cleanupVerified: true }; }, async release() { },
		});
		freshService.recoverStartup();
		const freshScheduler = new AgentWorkflowScheduler(reopened, freshService, Date.now, 10);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(reopened.agentWorkflows.getRun(project.id, f.workflow.id, started.id)!.state, 'recoveryRequired');
		assert.equal(session.id, f.plan.nodes[0].sessionId);
		freshScheduler.stopScheduling();
		await freshService.shutdown();
		reopened.close();
	} finally {
		if (!databaseClosed) { f.database.close(); }
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('cancellation aborts an unresolved workspace acquisition and settles its reserved node', async () => {
	const f = fixture(1, { delayedAcquire: true });
	try {
		const run = f.scheduler.start(f.project.id, f.workflow.id, f.database.agentWorkflows.getWorkflow(f.project.id, f.workflow.id)!.revision, randomUUID());
		await f.acquireEntered;
		const workflow = f.database.agentWorkflows.getWorkflow(f.project.id, f.workflow.id)!;
		f.scheduler.cancel(f.project.id, f.workflow.id, workflow.revision, randomUUID());
		await waitFor(() => f.database.agentWorkflows.getRun(f.project.id, f.workflow.id, run.id)!.state === 'cancelled');
		assert.equal(f.started.length, 0);
	} finally { cleanup(f); }
});

test('deadline aborts an unresolved acquisition without starting a provider turn', async () => {
	const f = fixture(1, { delayedAcquire: true, durationMs: 1_000 });
	try {
		const run = f.scheduler.start(f.project.id, f.workflow.id, f.database.agentWorkflows.getWorkflow(f.project.id, f.workflow.id)!.revision, randomUUID());
		await f.acquireEntered;
		await waitFor(() => f.database.agentWorkflows.getRun(f.project.id, f.workflow.id, run.id)!.state === 'blocked');
		assert.equal(f.started.length, 0);
		assert.equal(f.scheduler.getHostError(f.project.id, f.workflow.id, run.id), 'deadlineReached');
	} finally { cleanup(f); }
});

test('independent ready nodes obey one reserved concurrency slot', async () => {
	const f = fixture(2, { independent: true });
	try {
		f.scheduler.start(f.project.id, f.workflow.id, f.database.agentWorkflows.getWorkflow(f.project.id, f.workflow.id)!.revision, randomUUID());
		await waitFor(() => f.started.length === 1);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(f.started.length, 1);
		const run = f.database.agentWorkflows.getLatestRun(f.project.id, f.workflow.id)!;
		assert.deepEqual(run.nodes.map(node => node.state).sort(), ['ready', 'running']);
	} finally { cleanup(f); }
});

test('an unverified stop becomes durable recovery without retrying or releasing its slot', async () => {
	const f = fixture(2, { independent: true, failedStop: true });
	try {
		const started = f.scheduler.start(f.project.id, f.workflow.id, f.database.agentWorkflows.getWorkflow(f.project.id, f.workflow.id)!.revision, randomUUID());
		await waitFor(() => f.started.length === 1);
		const workflow = f.database.agentWorkflows.getWorkflow(f.project.id, f.workflow.id)!;
		f.scheduler.cancel(f.project.id, f.workflow.id, workflow.revision, randomUUID());
		await waitFor(() => f.database.agentWorkflows.getRun(f.project.id, f.workflow.id, started.id)!.state === 'recoveryRequired');
		const sourceCount = sqlCount(f, 'SELECT COUNT(*) AS count FROM agent_workflow_source_events WHERE workflow_id = ?', f.workflow.id);
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(f.stopCalls, 1);
		assert.equal(f.started.length, 1);
		assert.equal(sqlCount(f, 'SELECT COUNT(*) AS count FROM agent_workflow_source_events WHERE workflow_id = ?', f.workflow.id), sourceCount);
		const run = f.database.agentWorkflows.getRun(f.project.id, f.workflow.id, started.id)!;
		const recoveryNode = run.nodes.find(node => node.state === 'recoveryRequired')!;
		assert.ok(recoveryNode.sessionTurnId);
		assert.equal(sqlCount(f, "SELECT COUNT(*) AS count FROM agent_workflow_turn_reservations WHERE run_id = ? AND node_id = ? AND consumed_at IS NOT NULL", started.id, recoveryNode.nodeId), 1);
		assert.equal(sqlCount(f, "SELECT COUNT(*) AS count FROM agent_workflow_run_nodes node JOIN agent_session_turns turn ON turn.id = node.session_turn_id WHERE node.run_id = ? AND node.state = 'recoveryRequired' AND turn.cleanup_verified = 0", started.id), 1);
	} finally { cleanup(f); }
});

test('a wall-clock deadline with an unverified stop retains recovery and does not repeat writes', async () => {
	const f = fixture(1, { failedStop: true, durationMs: 1_000 });
	try {
		const run = f.scheduler.start(f.project.id, f.workflow.id, f.database.agentWorkflows.getWorkflow(f.project.id, f.workflow.id)!.revision, randomUUID());
		await waitFor(() => f.started.length === 1);
		await waitFor(() => f.database.agentWorkflows.getRun(f.project.id, f.workflow.id, run.id)!.state === 'recoveryRequired');
		assert.equal(f.scheduler.getHostError(f.project.id, f.workflow.id, run.id), 'stopUnverified');
		const persistedEventCount = sqlCount(f, 'SELECT COUNT(*) AS count FROM agent_workflow_source_events WHERE workflow_id = ?', f.workflow.id);
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(f.stopCalls, 1);
		assert.equal(f.started.length, 1);
		assert.equal(sqlCount(f, 'SELECT COUNT(*) AS count FROM agent_workflow_source_events WHERE workflow_id = ?', f.workflow.id), persistedEventCount);
		const recovered = f.database.agentWorkflows.getRun(f.project.id, f.workflow.id, run.id)!;
		const node = recovered.nodes.find(candidate => candidate.state === 'recoveryRequired')!;
		assert.ok(node.sessionTurnId);
		assert.equal(sqlCount(f, "SELECT COUNT(*) AS count FROM agent_workflow_run_nodes node JOIN agent_session_turns turn ON turn.id = node.session_turn_id WHERE node.run_id = ? AND node.state = 'recoveryRequired' AND turn.cleanup_verified = 0", run.id), 1);
	} finally { cleanup(f); }
});
