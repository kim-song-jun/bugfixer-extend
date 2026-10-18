/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { AgentPtySnapshot, AgentPtyStopResult } from './agentPtyHost.js';
import type { AgentSessionPermissionPolicy } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { TaskFolderWriterLock } from '../providerRuns/taskFolderWriterLock.js';
import { ManagedWorktreeService } from './managedWorktrees.js';
import { AgentSessionService, type AgentSessionRuntimeFactory, type AgentSessionRuntimeHandle } from './agentSessionService.js';
import { AgentSessionWorkspaceResolver, type AcquireAgentSessionWorkspaceInput, type AcquiredAgentSessionWorkspace } from './agentSessionWorkspace.js';

const READ_ONLY: AgentSessionPermissionPolicy = { mode: 'read-only', approval: 'never' };
const WORKFLOW_READ_ONLY: AgentSessionPermissionPolicy = READ_ONLY;
const MUTATING: AgentSessionPermissionPolicy = { mode: 'mutating', approval: 'on-request' };

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), 'agent-session-service-'));
	const repository = join(root, 'repository');
	const ordinary = join(root, 'ordinary');
	const profile = join(root, 'profile');
	mkdirSync(repository);
	mkdirSync(ordinary);
	mkdirSync(profile);
	git(repository, 'init', '-q', '-b', 'user-work');
	git(repository, 'config', 'user.name', 'Session Service Fixture');
	git(repository, 'config', 'user.email', 'session-service-fixture@example.invalid');
	writeFileSync(join(repository, 'README.md'), 'fixture\n');
	git(repository, 'add', 'README.md');
	git(repository, 'commit', '-qm', 'fixture');
	const database = WorkspaceDatabase.open(join(root, 'workspace.db'));
	const project = database.createProject('Session service fixture');
	const gitBinding = database.createFolderBinding({ projectId: project.id, path: repository, vcsKind: 'git', vcsRoot: repository });
	const sharedBinding = database.createFolderBinding({ projectId: project.id, path: ordinary });
	const gitSession = database.agentSessions.createSession({
		projectId: project.id, bindingId: gitBinding.id, name: 'Git session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'gitWorktree',
	});
	const sharedSession = database.agentSessions.createSession({
		projectId: project.id, bindingId: sharedBinding.id, name: 'Shared session', provider: 'claude', model: 'sonnet', workspaceMode: 'sharedFolder',
	});
	const worktrees = new ManagedWorktreeService(profile);
	const writerLock = new TaskFolderWriterLock();
	const resolver = new AgentSessionWorkspaceResolver(database, worktrees, writerLock, () => true);
	const runtimeFactory = createNeverLaunchRuntimeFactory();
	const service = new AgentSessionService(database, resolver, runtimeFactory.factory);
	return {
		root,
		repository: realpathSync(repository),
		ordinary: realpathSync(ordinary),
		database,
		project,
		gitBinding,
		sharedBinding,
		gitSession,
		sharedSession,
		worktrees,
		writerLock,
		resolver,
		runtimeFactory,
		service,
	};
}

function createNeverLaunchRuntimeFactory(): { readonly factory: AgentSessionRuntimeFactory; readonly starts: () => number } {
	let startCount = 0;
	const unexpected = (): never => { throw new Error('A preflight rejection must not invoke the runtime factory.'); };
	const factory: AgentSessionRuntimeFactory = {
		start() { startCount++; return Promise.reject(new Error('Unexpected runtime start.')); },
		watchExit: unexpected,
		getSnapshot: unexpected,
		write: unexpected,
		resize: unexpected,
		attach: unexpected,
		stop: unexpected,
		release: unexpected,
	};
	return { factory, starts: () => startCount };
}

function createRunningRuntimeFactory(stopResult: AgentPtyStopResult = { state: 'stopped', cleanupVerified: true }): { readonly factory: AgentSessionRuntimeFactory; readonly starts: () => readonly string[]; readonly releases: () => number } {
	const startedTurns: string[] = [];
	let releaseCount = 0;
	const handle = Object.freeze({}) as AgentSessionRuntimeHandle;
	const snapshot = { state: 'running' as const, latestSequence: 0, outputSanitizerFailed: false, failedOutputListeners: 0, failedExitListeners: 0, accessRevocationFailed: false };
	const factory: AgentSessionRuntimeFactory = {
		async start(_turnSnapshot, turnId) { startedTurns.push(turnId); return handle; },
		watchExit() { return { dispose() { } }; },
		getSnapshot() { return snapshot; },
		async write() { },
		async resize() { },
		async attach() { throw new Error('Attachment is not used by this launch contract.'); },
		async stop() { return stopResult; },
		async release() { releaseCount++; },
	};
	return { factory, starts: () => startedTurns, releases: () => releaseCount };
}

function createExitRaceRuntimeFactory() {
	const handle = Object.freeze({}) as AgentSessionRuntimeHandle;
	const runningSnapshot: AgentPtySnapshot = { state: 'running', latestSequence: 0, outputSanitizerFailed: false, failedOutputListeners: 0, failedExitListeners: 0, accessRevocationFailed: false };
	let currentSnapshot = runningSnapshot;
	let exitListener: ((snapshot: AgentPtySnapshot) => void) | undefined;
	let stopCount = 0;
	let enteredStop!: () => void;
	const stopEntered = new Promise<void>(resolve => { enteredStop = resolve; });
	let finishStop!: () => void;
	const stopGate = new Promise<void>(resolve => { finishStop = resolve; });
	const factory: AgentSessionRuntimeFactory = {
		async start() { return handle; },
		watchExit(_handle, listener) { exitListener = listener; return { dispose() { } }; },
		getSnapshot() { return currentSnapshot; },
		async write() { },
		async resize() { },
		async attach() { throw new Error('Attachment is not used by this lifecycle contract.'); },
		async stop() { stopCount++; enteredStop(); await stopGate; return { state: 'stopped', cleanupVerified: true }; },
		async release() { },
	};
	return {
		factory,
		stopEntered,
		finishStop,
		stopCount: () => stopCount,
		exitSuccessfully() {
			currentSnapshot = { ...runningSnapshot, state: 'exited', providerExitCode: 0, transcriptPersistenceFailed: true };
			exitListener?.(currentSnapshot);
		},
	};
}

function approveWorkflowLaunch(
	fixture: ReturnType<typeof createFixture>,
	permissionPolicy = WORKFLOW_READ_ONLY,
	projectId = fixture.project.id,
	sessionId = fixture.sharedSession.id,
	bindingId = fixture.sharedBinding.id,
) {
	const session = fixture.database.agentSessions.getSession(projectId, sessionId)!;
	const workflow = fixture.database.agentWorkflows.createWorkflow(projectId, {
		projectId,
		bindingId,
		taskId: null,
		maxConcurrentNodes: 1,
		maxTotalTurns: 1,
		maxDurationMs: 60_000,
		nodes: [{
			nodeId: 'implement', sessionId: session.id, role: 'implementer', provider: session.provider, model: session.model,
			taskId: null, bindingId, referenceIds: [], permissionPolicy, dependsOn: [],
		}],
		idempotencyKey: randomUUID(),
	});
	const plan = fixture.database.agentWorkflows.getPlan(projectId, workflow.id)!;
	fixture.database.agentWorkflows.recordTrustedUiApproval(projectId, workflow.id, plan.version, plan.fingerprint, randomUUID());
	const approved = fixture.database.agentWorkflows.getWorkflow(projectId, workflow.id)!;
	const run = fixture.database.agentWorkflows.startWorkflow(projectId, workflow.id, approved.revision, randomUUID());
	const reservation = fixture.database.agentWorkflows.reserveNodeTurnLaunch(projectId, workflow.id, run.id, 'implement', run.nodes[0].revision, session.revision);
	return { session, reservation, workflowId: workflow.id, runId: run.id };
}

function createDelayedService(fixture: ReturnType<typeof createFixture>) {
	class DelayedResolver extends AgentSessionWorkspaceResolver {
		private nextHold?: { readonly entered: () => void; readonly gate: Promise<void> };
		readonly acquiredWorkspaces: AcquiredAgentSessionWorkspace[] = [];

		holdNextAcquire(): { readonly entered: Promise<void>; release(): void } {
			let notifyEntered!: () => void;
			let releaseGate!: () => void;
			const entered = new Promise<void>(resolve => { notifyEntered = resolve; });
			const gate = new Promise<void>(resolve => { releaseGate = resolve; });
			this.nextHold = { entered: notifyEntered, gate };
			return { entered, release: releaseGate };
		}

		override async acquire(input: AcquireAgentSessionWorkspaceInput): Promise<AcquiredAgentSessionWorkspace> {
			const hold = this.nextHold;
			if (hold) {
				this.nextHold = undefined;
				hold.entered();
				await hold.gate;
			}
			const workspace = await super.acquire(input);
			this.acquiredWorkspaces.push(workspace);
			return workspace;
		}
	}
	const resolver = new DelayedResolver(fixture.database, fixture.worktrees, fixture.writerLock, () => true);
	const service = new AgentSessionService(fixture.database, resolver, fixture.runtimeFactory.factory);
	return { service, resolver };
}

function dispose(fixture: ReturnType<typeof createFixture>): void {
	fixture.database.close();
	rmSync(fixture.root, { recursive: true, force: true });
}

test('launch tickets are opaque, single-use, and scoped to their persisted project/session', async () => {
	const fixture = createFixture();
	try {
		await fixture.worktrees.create({ repositoryPath: fixture.repository, ownerId: fixture.gitSession.id, kind: 'session', baseRef: 'HEAD' });
		const preview = await fixture.service.preview({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, permissionPolicy: READ_ONLY });
		const otherProject = fixture.database.createProject('Other project');
		await assert.rejects(
			fixture.service.start({ projectId: otherProject.id, sessionId: fixture.gitSession.id, ticketId: preview.ticketId }),
			/project or session/i,
		);
		await assert.rejects(
			fixture.service.start({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, ticketId: randomUUID() }),
			/ticket/i,
		);
		await assert.rejects(
			fixture.service.attach(otherProject.id, fixture.gitSession.id, 'forged-turn', () => undefined),
			/project and session/i,
		);
		await assert.rejects(
			fixture.service.attach(fixture.project.id, fixture.gitSession.id, randomUUID(), () => undefined),
			/active in this project and session/i,
		);
		await assert.rejects(
			fixture.service.start({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, ticketId: preview.ticketId }),
			/ticket/i,
		);
		assert.equal(fixture.runtimeFactory.starts(), 0);
		assert.deepEqual(fixture.database.agentSessionTurns.listTurns(fixture.project.id, fixture.gitSession.id), []);
	} finally {
		dispose(fixture);
	}
});

test('an approved workflow reservation launches its exact reserved durable turn through the runtime factory', async () => {
	const fixture = createFixture();
	const runtime = createRunningRuntimeFactory();
	const service = new AgentSessionService(fixture.database, fixture.resolver, runtime.factory);
	try {
		const { session, reservation, workflowId, runId } = approveWorkflowLaunch(fixture);
		const turn = await service.startWorkflowNode({ projectId: fixture.project.id, sessionId: session.id, permissionPolicy: WORKFLOW_READ_ONLY, reservationId: reservation.reservationId });
		assert.equal(turn.id, reservation.turnId);
		assert.equal(turn.state, 'running');
		assert.deepEqual(runtime.starts(), [reservation.turnId]);
		assert.deepEqual(fixture.database.agentSessionTurns.listTurns(fixture.project.id, session.id).map(value => value.id), [reservation.turnId]);
		const stoppedWorkflowTurn = await service.stop(fixture.project.id, session.id, turn.id);
		assert.equal(stoppedWorkflowTurn.state, 'exited');
		assert.equal(stoppedWorkflowTurn.cleanupVerified, true);
		assert.equal(stoppedWorkflowTurn.exitCode, null, 'An explicit stop does not claim successful provider execution.');
		assert.equal(fixture.database.agentSessions.getSession(fixture.project.id, session.id)?.state, 'stopped');
		assert.equal(fixture.database.agentSessionTurns.getTurn(fixture.project.id, session.id, turn.id)?.state, stoppedWorkflowTurn.state);
		assert.throws(() => approveWorkflowLaunch(fixture, WORKFLOW_READ_ONLY, fixture.project.id, session.id, fixture.sharedBinding.id), /created or idle/i);
		const priorWorkflowRunBeforeResume = fixture.database.agentWorkflows.getRun(fixture.project.id, workflowId, runId)!;
		const priorWorkflowNodeBeforeResume = priorWorkflowRunBeforeResume.nodes[0];
		const workflowManualPreview = await service.preview({ projectId: fixture.project.id, sessionId: session.id, permissionPolicy: READ_ONLY });
		const resumedWorkflowSessionTurn = await service.start({ projectId: fixture.project.id, sessionId: session.id, ticketId: workflowManualPreview.ticketId });
		assert.equal(resumedWorkflowSessionTurn.ordinal, 2);
		assert.notEqual(resumedWorkflowSessionTurn.id, reservation.turnId);
		const priorWorkflowRun = fixture.database.agentWorkflows.getRun(fixture.project.id, workflowId, runId)!;
		assert.equal(priorWorkflowRun.revision, priorWorkflowRunBeforeResume.revision);
		assert.equal(priorWorkflowRun.nodes[0].revision, priorWorkflowNodeBeforeResume.revision);
		assert.equal(priorWorkflowRun.nodes[0].sessionTurnId, reservation.turnId);
		assert.notEqual(priorWorkflowRun.nodes[0].sessionTurnId, resumedWorkflowSessionTurn.id,
			'Manual resume must not bind its new turn to the prior workflow node.');
		assert.deepEqual(runtime.starts(), [reservation.turnId, resumedWorkflowSessionTurn.id]);
		assert.equal((await service.stop(fixture.project.id, session.id, resumedWorkflowSessionTurn.id)).cleanupVerified, true,
			'Verify cleanup before another session reuses the same shared folder.');
		const manualSession = fixture.database.agentSessions.createSession({
			projectId: fixture.project.id, bindingId: fixture.sharedBinding.id, name: 'Manual ticket session',
			provider: 'claude', model: 'sonnet', workspaceMode: 'sharedFolder',
		});
		const preview = await service.preview({ projectId: fixture.project.id, sessionId: manualSession.id, permissionPolicy: READ_ONLY });
		const manualTurn = await service.start({ projectId: fixture.project.id, sessionId: manualSession.id, ticketId: preview.ticketId });
		assert.notEqual(manualTurn.id, reservation.turnId);
		assert.deepEqual(runtime.starts(), [reservation.turnId, resumedWorkflowSessionTurn.id, manualTurn.id]);
		const stoppedManualTurn = await service.stop(fixture.project.id, manualSession.id, manualTurn.id);
		assert.equal(stoppedManualTurn.cleanupVerified, true);
		const resumePreview = await service.preview({ projectId: fixture.project.id, sessionId: manualSession.id, permissionPolicy: READ_ONLY });
		const resumedManualTurn = await service.start({ projectId: fixture.project.id, sessionId: manualSession.id, ticketId: resumePreview.ticketId });
		assert.equal(resumedManualTurn.ordinal, 2);
		assert.equal(fixture.database.agentSessionTurns.getPreviousTurn(fixture.project.id, manualSession.id, resumedManualTurn.id)?.id, stoppedManualTurn.id);
		assert.deepEqual(runtime.starts(), [reservation.turnId, resumedWorkflowSessionTurn.id, manualTurn.id, resumedManualTurn.id]);
		assert.equal((await service.stop(fixture.project.id, manualSession.id, resumedManualTurn.id)).cleanupVerified, true);
	} finally {
		dispose(fixture);
	}
});

test('unverified stop cleanup retains its runtime and blocks another launch preview', async () => {
	const fixture = createFixture();
	const runtime = createRunningRuntimeFactory({ state: 'cleanupUnverified', cleanupVerified: false, error: 'injected cleanup uncertainty' });
	const service = new AgentSessionService(fixture.database, fixture.resolver, runtime.factory);
	try {
		const preview = await service.preview({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY });
		const turn = await service.start({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, ticketId: preview.ticketId });
		const stopped = await service.stop(fixture.project.id, fixture.sharedSession.id, turn.id);
		assert.equal(stopped.state, 'failed');
		assert.equal(stopped.cleanupVerified, false);
		assert.equal(runtime.releases(), 0, 'uncertain PTY ownership must remain retained by the service');
		await assert.rejects(service.preview({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY }), /unresolved host-owned process cleanup/i);
		assert.deepEqual(runtime.starts(), [turn.id]);
	} finally {
		await service.shutdown();
		dispose(fixture);
	}
});

test('rejectProviderConversation fails and cleans only the exact owned turn while preserving its provider conversation ID', async () => {
	const fixture = createFixture();
	const runtime = createRunningRuntimeFactory();
	const service = new AgentSessionService(fixture.database, fixture.resolver, runtime.factory);
	try {
		const preview = await service.preview({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY });
		const started = await service.start({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, ticketId: preview.ticketId });
		const withConversation = fixture.database.agentSessionTurns.recordProviderConversationId(
			fixture.project.id, fixture.sharedSession.id, started.id, started.revision, randomUUID(),
		);
		await assert.rejects(service.rejectProviderConversation(randomUUID(), fixture.sharedSession.id, started.id), /does not belong/i);
		await assert.rejects(service.rejectProviderConversation(fixture.project.id, fixture.gitSession.id, started.id), /does not belong/i);
		assert.deepEqual(runtime.starts(), [started.id]);

		const rejected = await service.rejectProviderConversation(fixture.project.id, fixture.sharedSession.id, started.id);
		assert.equal(rejected.state, 'failed');
		assert.equal(rejected.cleanupVerified, true);
		assert.equal(rejected.providerConversationId, withConversation.providerConversationId);
		assert.equal(rejected.errorSummary, '프로바이더 대화 식별자가 현재 세션과 일치하지 않습니다.');
		assert.equal(fixture.database.agentSessions.getSession(fixture.project.id, fixture.sharedSession.id)?.state, 'failed');
		assert.deepEqual(await service.rejectProviderConversation(fixture.project.id, fixture.sharedSession.id, started.id), rejected);
		assert.deepEqual(runtime.starts(), [started.id]);
	} finally {
		dispose(fixture);
	}
});

test('provider identity rejection wins a natural exit-zero race and retains transcript failure cause', async () => {
	const fixture = createFixture();
	const runtime = createExitRaceRuntimeFactory();
	const service = new AgentSessionService(fixture.database, fixture.resolver, runtime.factory);
	try {
		const preview = await service.preview({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY });
		const started = await service.start({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, ticketId: preview.ticketId });
		const withConversation = fixture.database.agentSessionTurns.recordProviderConversationId(
			fixture.project.id, fixture.sharedSession.id, started.id, started.revision, randomUUID(),
		);
		runtime.exitSuccessfully();
		await runtime.stopEntered;
		const rejection = service.rejectProviderConversation(fixture.project.id, fixture.sharedSession.id, started.id);
		runtime.finishStop();
		const failed = await rejection;
		assert.equal(failed.state, 'failed');
		assert.equal(failed.exitCode, 0);
		assert.equal(failed.cleanupVerified, true);
		assert.equal(failed.providerConversationId, withConversation.providerConversationId);
		assert.equal(failed.errorSummary, '프로바이더 대화 식별자가 현재 세션과 일치하지 않으며 실행 기록을 저장하지 못했습니다.');
		assert.equal(runtime.stopCount(), 1);
		assert.equal(fixture.database.agentSessions.getSession(fixture.project.id, fixture.sharedSession.id)?.state, 'failed');
	} finally {
		dispose(fixture);
	}
});

test('an invalid workflow reservation releases the acquired writer lease without spawning a provider', { skip: process.platform !== 'darwin' && 'TaskFolderWriterLock uses macOS lockf for mutating shared-folder launches.' }, async () => {
	const fixture = createFixture();
	try {
		fixture.database.enableOrdinaryFolderMutation(fixture.project.id, fixture.sharedBinding.id);
		const { session, reservation } = approveWorkflowLaunch(fixture, MUTATING);
		const foreignProject = fixture.database.createProject('Foreign workflow project');
		const foreignBinding = fixture.database.createFolderBinding({ projectId: foreignProject.id, path: fixture.ordinary });
		const foreignSession = fixture.database.agentSessions.createSession({ projectId: foreignProject.id, bindingId: foreignBinding.id, name: 'Foreign workflow session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder' });
		const foreign = approveWorkflowLaunch(fixture, WORKFLOW_READ_ONLY, foreignProject.id, foreignSession.id, foreignBinding.id);
		await assert.rejects(fixture.service.startWorkflowNode({
			projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: WORKFLOW_READ_ONLY, reservationId: foreign.reservation.reservationId,
		}), /reservation|authorization|project/i);
		await assert.rejects(fixture.service.startWorkflowNode({
			projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: MUTATING, reservationId: randomUUID(),
		}), /reservation|authorization/i);
		const sqlite = Reflect.get(fixture.database, 'db') as DatabaseSync;
		sqlite.prepare('UPDATE agent_workflow_turn_reservations SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), reservation.reservationId);
		await assert.rejects(fixture.service.startWorkflowNode({
			projectId: fixture.project.id, sessionId: session.id, permissionPolicy: MUTATING, reservationId: reservation.reservationId,
		}), /expired|reservation|authorization/i);
		assert.equal(fixture.runtimeFactory.starts(), 0);
		assert.deepEqual(fixture.database.agentSessionTurns.listTurns(fixture.project.id, session.id), []);
		const lease = await fixture.writerLock.acquire(fixture.ordinary);
		lease.release();
	} finally {
		dispose(fixture);
	}
});

test('shutdown cancellation during workflow workspace acquisition cannot create a turn or spawn a provider', async () => {
	const fixture = createFixture();
	try {
		const { session, reservation } = approveWorkflowLaunch(fixture);
		const { service, resolver } = createDelayedService(fixture);
		const hold = resolver.holdNextAcquire();
		const start = service.startWorkflowNode({ projectId: fixture.project.id, sessionId: session.id, permissionPolicy: WORKFLOW_READ_ONLY, reservationId: reservation.reservationId });
		await hold.entered;
		const shutdown = service.shutdown();
		hold.release();
		await assert.rejects(start, /shutting down/i);
		assert.deepEqual(await shutdown, []);
		assert.equal(fixture.runtimeFactory.starts(), 0);
		assert.deepEqual(fixture.database.agentSessionTurns.listTurns(fixture.project.id, session.id), []);
	} finally {
		dispose(fixture);
	}
});

test('caller abort during workflow workspace acquisition releases the workspace before creating a turn', async () => {
	const fixture = createFixture();
	try {
		const { session, reservation } = approveWorkflowLaunch(fixture);
		const { service, resolver } = createDelayedService(fixture);
		const hold = resolver.holdNextAcquire();
		const controller = new AbortController();
		const start = service.startWorkflowNode({
			projectId: fixture.project.id, sessionId: session.id, permissionPolicy: WORKFLOW_READ_ONLY,
			reservationId: reservation.reservationId, signal: controller.signal,
		});
		await hold.entered;
		controller.abort();
		hold.release();
		await assert.rejects(start, /cancelled/i);
		assert.equal(fixture.runtimeFactory.starts(), 0);
		assert.deepEqual(fixture.database.agentSessionTurns.listTurns(fixture.project.id, session.id), []);
		assert.equal(resolver.acquiredWorkspaces.length, 1);
		assert.throws(() => resolver.acquiredWorkspaces[0].snapshot, /lease is unavailable/i);
	} finally {
		dispose(fixture);
	}
});

test('a changed persisted Git binding invalidates the preview before any runtime start', async () => {
	const fixture = createFixture();
	try {
		await fixture.worktrees.create({ repositoryPath: fixture.repository, ownerId: fixture.gitSession.id, kind: 'session', baseRef: 'HEAD' });
		const preview = await fixture.service.preview({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, permissionPolicy: READ_ONLY });
		const replacement = join(fixture.root, 'replacement');
		mkdirSync(replacement);
		fixture.database.updateFolderBinding(fixture.gitBinding.id, { path: replacement, expectedPath: fixture.repository });
		await assert.rejects(
			fixture.service.start({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, ticketId: preview.ticketId }),
			/Git session worktree requires|workspace changed/i,
		);
		assert.equal(fixture.runtimeFactory.starts(), 0);
		assert.deepEqual(fixture.database.agentSessionTurns.listTurns(fixture.project.id, fixture.gitSession.id), []);
	} finally {
		dispose(fixture);
	}
});

test('revoking the ordinary-folder mutation grant after preview blocks start before PTY creation', {
	skip: process.platform !== 'darwin' && 'TaskFolderWriterLock uses macOS lockf for mutating shared-folder launches.',
}, async () => {
	const fixture = createFixture();
	try {
		fixture.database.enableOrdinaryFolderMutation(fixture.project.id, fixture.sharedBinding.id);
		const preview = await fixture.service.preview({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: MUTATING });
		fixture.database.revokeOrdinaryFolderMutation(fixture.project.id, fixture.sharedBinding.id);
		await assert.rejects(
			fixture.service.start({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, ticketId: preview.ticketId }),
			/grant|permission/i,
		);
		assert.equal(fixture.runtimeFactory.starts(), 0);
		assert.deepEqual(fixture.database.agentSessionTurns.listTurns(fixture.project.id, fixture.sharedSession.id), []);
	} finally {
		dispose(fixture);
	}
});

test('shutdown aborts and drains a delayed preview before any launch ticket can be issued', async () => {
	const fixture = createFixture();
	try {
		const { service, resolver } = createDelayedService(fixture);
		const hold = resolver.holdNextAcquire();
		const preview = service.preview({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY });
		await hold.entered;
		let shutdownSettled = false;
		const shutdown = service.shutdown().then(receipts => { shutdownSettled = true; return receipts; });
		assert.equal(shutdownSettled, false);
		hold.release();
		await assert.rejects(preview, /shutting down/i);
		assert.deepEqual(await shutdown, []);
		assert.equal(fixture.runtimeFactory.starts(), 0);
		assert.deepEqual(fixture.database.agentSessionTurns.listTurns(fixture.project.id, fixture.sharedSession.id), []);
	} finally {
		dispose(fixture);
	}
});

test('shutdown drains a delayed start preflight before creating a durable turn or runtime', async () => {
	const fixture = createFixture();
	try {
		const { service, resolver } = createDelayedService(fixture);
		const preview = await service.preview({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY });
		const hold = resolver.holdNextAcquire();
		const start = service.start({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, ticketId: preview.ticketId });
		await hold.entered;
		let shutdownSettled = false;
		const shutdown = service.shutdown().then(receipts => { shutdownSettled = true; return receipts; });
		assert.equal(shutdownSettled, false);
		hold.release();
		await assert.rejects(start, /shutting down/i);
		assert.deepEqual(await shutdown, []);
		assert.equal(fixture.runtimeFactory.starts(), 0);
		assert.deepEqual(fixture.database.agentSessionTurns.listTurns(fixture.project.id, fixture.sharedSession.id), []);
	} finally {
		dispose(fixture);
	}
});

test('concurrent preview requests reserve the bounded ticket capacity before workspace acquisition', async () => {
	const fixture = createFixture();
	try {
		const results = await Promise.allSettled(Array.from({ length: 129 }, () => fixture.service.preview({
			projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY,
		})));
		assert.equal(results.filter(result => result.status === 'fulfilled').length, 128);
		assert.equal(results.filter(result => result.status === 'rejected').length, 1);
		assert.equal(fixture.runtimeFactory.starts(), 0);
		assert.deepEqual(fixture.database.agentSessionTurns.listTurns(fixture.project.id, fixture.sharedSession.id), []);
	} finally {
		dispose(fixture);
	}
});
