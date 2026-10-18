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
import test from 'node:test';
import type { AgentSessionPermissionPolicy } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { TaskFolderWriterLock } from '../providerRuns/taskFolderWriterLock.js';
import { ManagedWorktreeService } from './managedWorktrees.js';
import { AgentSessionService, type AgentSessionRuntimeFactory } from './agentSessionService.js';
import { AgentSessionWorkspaceResolver, type AcquireAgentSessionWorkspaceInput, type AcquiredAgentSessionWorkspace } from './agentSessionWorkspace.js';

const READ_ONLY: AgentSessionPermissionPolicy = { mode: 'read-only', approval: 'never' };
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

function createDelayedService(fixture: ReturnType<typeof createFixture>) {
	class DelayedResolver extends AgentSessionWorkspaceResolver {
		private nextHold?: { readonly entered: () => void; readonly gate: Promise<void> };

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
			return super.acquire(input);
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
