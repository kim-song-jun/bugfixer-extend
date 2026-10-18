/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionPermissionPolicy } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { ManagedWorktreeService } from './managedWorktrees.js';
import { AgentSessionWorkspaceResolver } from './agentSessionWorkspace.js';
import { TaskFolderWriterLock } from '../providerRuns/taskFolderWriterLock.js';

const READ_ONLY: AgentSessionPermissionPolicy = { mode: 'read-only', approval: 'never' };
const MUTATING: AgentSessionPermissionPolicy = { mode: 'mutating', approval: 'on-request' };

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), 'agent-session-workspace-'));
	const repository = join(root, 'repository');
	const ordinary = join(root, 'ordinary');
	const profile = join(root, 'profile');
	mkdirSync(repository);
	mkdirSync(ordinary);
	mkdirSync(profile);
	git(repository, 'init', '-q', '-b', 'user-work');
	git(repository, 'config', 'user.name', 'Workspace Fixture');
	git(repository, 'config', 'user.email', 'workspace-fixture@example.invalid');
	writeFileSync(join(repository, 'README.md'), 'base\n');
	git(repository, 'add', 'README.md');
	git(repository, 'commit', '-qm', 'base');
	const database = WorkspaceDatabase.open(join(root, 'workspace.db'));
	const project = database.createProject('Workspace fixture');
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
	return { root, repository: realpathSync(repository), ordinary: realpathSync(ordinary), database, project, gitBinding, sharedBinding, gitSession, sharedSession, worktrees, writerLock, resolver };
}

function dispose(fixture: ReturnType<typeof createFixture>): void {
	fixture.database.close();
	rmSync(fixture.root, { recursive: true, force: true });
}

test('workspace resolution derives the session-owned worktree from persisted project binding', async () => {
	const fixture = createFixture();
	try {
		const lease = await fixture.worktrees.create({ repositoryPath: fixture.repository, ownerId: fixture.gitSession.id, kind: 'session', baseRef: 'HEAD' });
		const acquired = await fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, permissionPolicy: READ_ONLY });
		try {
			assert.equal(acquired.snapshot.cwd, realpathSync(lease.worktreePath));
			assert.equal(acquired.snapshot.managedWorktreeOwnerId, fixture.gitSession.id);
			assert.equal(acquired.snapshot.folderIdentity.canonicalPath, acquired.snapshot.cwd);
			await fixture.resolver.revalidate(acquired);
			const otherProject = fixture.database.createProject('Wrong project');
			await assert.rejects(fixture.resolver.acquire({ projectId: otherProject.id, sessionId: fixture.gitSession.id, permissionPolicy: READ_ONLY }), /session|project/i);
		} finally {
			fixture.resolver.release(acquired);
		}
	} finally {
		dispose(fixture);
	}
});

test('same-repository sessions may launch concurrently in distinct owned worktrees', async () => {
	const fixture = createFixture();
	try {
		const firstWorktree = await fixture.worktrees.create({ repositoryPath: fixture.repository, ownerId: fixture.gitSession.id, kind: 'session', baseRef: 'HEAD' });
		const secondSession = fixture.database.agentSessions.createSession({
			projectId: fixture.project.id, bindingId: fixture.gitBinding.id, name: 'Second Git session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'gitWorktree',
		});
		const secondWorktree = await fixture.worktrees.create({ repositoryPath: fixture.repository, ownerId: secondSession.id, kind: 'session', baseRef: 'HEAD' });
		const first = await fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, permissionPolicy: READ_ONLY });
		try {
			assert.notEqual(first.snapshot.folderIdentity.canonicalPath, realpathSync(secondWorktree.worktreePath));
			const firstTurn = fixture.database.agentSessionTurns.createTurn({
				projectId: fixture.project.id, sessionId: fixture.gitSession.id, expectedSessionRevision: fixture.gitSession.revision, snapshot: first.snapshot,
			});
			assert.deepEqual(await fixture.resolver.revalidate(first, firstTurn.id), firstTurn.snapshot);
			const second = await fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: secondSession.id, permissionPolicy: READ_ONLY });
			try {
				assert.equal(second.snapshot.cwd, realpathSync(secondWorktree.worktreePath));
				assert.equal(second.snapshot.managedWorktreeOwnerId, secondSession.id);
			} finally {
				fixture.resolver.release(second);
			}
			assert.equal(realpathSync(firstWorktree.worktreePath), first.snapshot.cwd);
		} finally {
			fixture.resolver.release(first);
		}
	} finally {
		dispose(fixture);
	}
});

test('worktree resolution rejects unowned, integration, repository-mismatched, and replaced leases', async () => {
	const fixture = createFixture();
	try {
		await fixture.worktrees.create({ repositoryPath: fixture.repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		await assert.rejects(fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, permissionPolicy: READ_ONLY }), /lease|owner|worktree/i);
		await fixture.worktrees.create({ repositoryPath: fixture.repository, ownerId: fixture.gitSession.id, kind: 'integration', baseRef: 'HEAD' });
		await assert.rejects(fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, permissionPolicy: READ_ONLY }), /session|kind/i);

		const otherRepository = join(fixture.root, 'other-repository');
		mkdirSync(otherRepository);
		git(otherRepository, 'init', '-q', '-b', 'other');
		git(otherRepository, 'config', 'user.name', 'Workspace Fixture');
		git(otherRepository, 'config', 'user.email', 'workspace-fixture@example.invalid');
		writeFileSync(join(otherRepository, 'README.md'), 'other\n');
		git(otherRepository, 'add', 'README.md');
		git(otherRepository, 'commit', '-qm', 'other');
		const anotherProfile = join(fixture.root, 'other-profile');
		mkdirSync(anotherProfile);
		const otherWorktrees = new ManagedWorktreeService(anotherProfile);
		await otherWorktrees.create({ repositoryPath: otherRepository, ownerId: fixture.gitSession.id, kind: 'session', baseRef: 'HEAD' });
		const wrongRepositoryResolver = new AgentSessionWorkspaceResolver(fixture.database, otherWorktrees, fixture.writerLock, () => true);
		await assert.rejects(wrongRepositoryResolver.acquire({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, permissionPolicy: READ_ONLY }), /repository|binding/i);

		const forgedProfile = join(fixture.root, 'forged-profile');
		mkdirSync(forgedProfile);
		const forgedWorktrees = new ManagedWorktreeService(forgedProfile);
		await forgedWorktrees.create({ repositoryPath: fixture.repository, ownerId: fixture.gitSession.id, kind: 'session', baseRef: 'HEAD' });
		const manifestPath = join(forgedProfile, 'managed-worktrees', `${fixture.gitSession.id}.json`);
		const forgedManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { repositoryPath: string };
		forgedManifest.repositoryPath = otherRepository;
		writeFileSync(manifestPath, JSON.stringify(forgedManifest));
		const forgedResolver = new AgentSessionWorkspaceResolver(fixture.database, forgedWorktrees, fixture.writerLock, () => true);
		await assert.rejects(forgedResolver.acquire({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, permissionPolicy: READ_ONLY }), /signature|manifest|identity/i);

		const validProfile = join(fixture.root, 'valid-profile');
		mkdirSync(validProfile);
		const validWorktrees = new ManagedWorktreeService(validProfile);
		const validLease = await validWorktrees.create({ repositoryPath: fixture.repository, ownerId: fixture.gitSession.id, kind: 'session', baseRef: 'HEAD' });
		const movedPath = `${validLease.worktreePath}-moved`;
		const fs = await import('node:fs/promises');
		await fs.rename(validLease.worktreePath, movedPath);
		const replacedResolver = new AgentSessionWorkspaceResolver(fixture.database, validWorktrees, fixture.writerLock, () => true);
		await assert.rejects(replacedResolver.acquire({ projectId: fixture.project.id, sessionId: fixture.gitSession.id, permissionPolicy: READ_ONLY }), /worktree|identity|path|missing/i);
	} finally {
		dispose(fixture);
	}
});

test('shared-folder identity and mutation grant are revalidated before a turn can use the lease', async () => {
	const fixture = createFixture();
	try {
		const readonly = await fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY });
		assert.equal(readonly.snapshot.cwd, fixture.ordinary);
		assert.equal(readonly.snapshot.managedWorktreeOwnerId, null);
		fixture.resolver.release(readonly);

		await assert.rejects(fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: MUTATING }), /grant|permission/i);
		const identityLease = await fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY });
		const moved = join(fixture.root, 'ordinary-old');
		const fs = await import('node:fs/promises');
		await fs.rename(fixture.ordinary, moved);
		mkdirSync(fixture.ordinary);
		await assert.rejects(fixture.resolver.revalidate(identityLease), /identity|binding|folder/i);
		fixture.resolver.release(identityLease);
	} finally {
		dispose(fixture);
	}
});

test('host launch permissions accept only read-only/never and mutating/on-request', async () => {
	const fixture = createFixture();
	try {
		for (const permissionPolicy of [
			{ mode: 'read-only', approval: 'on-request' },
			{ mode: 'read-only', approval: 'always' },
			{ mode: 'mutating', approval: 'never' },
			{ mode: 'mutating', approval: 'always' },
		] as const) {
			await assert.rejects(
				fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy }),
				/permission policy/i,
			);
		}
	} finally {
		dispose(fixture);
	}
});

test('mutating shared-folder leases recheck the ordinary-folder grant before and after acquisition', {
	skip: process.platform !== 'darwin' && 'TaskFolderWriterLock uses macOS lockf for mutating shared-folder leases.',
}, async () => {
	const fixture = createFixture();
	try {
		fixture.database.enableOrdinaryFolderMutation(fixture.project.id, fixture.sharedBinding.id);
		const mutating = await fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: MUTATING });
		fixture.database.revokeOrdinaryFolderMutation(fixture.project.id, fixture.sharedBinding.id);
		await assert.rejects(fixture.resolver.revalidate(mutating), /grant|permission/i);
		fixture.resolver.release(mutating);
	} finally {
		dispose(fixture);
	}
});


test('shared-folder writers serialize with provider runs and recheck revoked grants after waiting', {
	skip: process.platform !== 'darwin' && 'TaskFolderWriterLock uses macOS lockf for shared-folder writer serialization.',
}, async () => {
	const fixture = createFixture();
	try {
		fixture.database.enableOrdinaryFolderMutation(fixture.project.id, fixture.sharedBinding.id);
		const providerLease = await fixture.writerLock.acquire(fixture.ordinary);
		let acquired = false;
		const waiting = fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: MUTATING }).then(lease => {
			acquired = true;
			return lease;
		});
		await new Promise(resolve => setTimeout(resolve, 75));
		assert.equal(acquired, false, 'the session must wait behind the provider run holding the shared writer lock');
		fixture.database.revokeOrdinaryFolderMutation(fixture.project.id, fixture.sharedBinding.id);
		providerLease.release();
		await assert.rejects(waiting, /grant|permission/i);

		fixture.database.enableOrdinaryFolderMutation(fixture.project.id, fixture.sharedBinding.id);
		const existingProviderLease = await fixture.writerLock.acquire(fixture.ordinary);
		const waitingAgain = fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: MUTATING });
		await new Promise(resolve => setTimeout(resolve, 75));
		const oldFolder = join(fixture.root, 'ordinary-before-replacement');
		const fs = await import('node:fs/promises');
		await fs.rename(fixture.ordinary, oldFolder);
		mkdirSync(fixture.ordinary);
		fixture.database.enableOrdinaryFolderMutation(fixture.project.id, fixture.sharedBinding.id);
		existingProviderLease.release();
		await assert.rejects(waitingAgain, /identity|workspace|folder/i);
	} finally {
		dispose(fixture);
	}
});

test('unresolved host cleanup blocks another session turn; renderer-supplied cleanup is not accepted', async () => {
	const fixture = createFixture();
	try {
		fixture.database.enableOrdinaryFolderMutation(fixture.project.id, fixture.sharedBinding.id);
		const initial = await fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY });
		const turn = fixture.database.agentSessionTurns.createTurn({
			projectId: fixture.project.id, sessionId: fixture.sharedSession.id, expectedSessionRevision: fixture.sharedSession.revision, snapshot: initial.snapshot,
		});
		assert.deepEqual(await fixture.resolver.revalidate(initial, turn.id), turn.snapshot);
		fixture.resolver.release(initial);
		await assert.rejects(fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY }), /cleanup|recovery|turn/i);
		assert.equal(fixture.database.agentSessionTurns.getTurn(fixture.project.id, fixture.sharedSession.id, turn.id)?.cleanupVerified, false);

		const alias = join(fixture.root, 'ordinary-alias');
		symlinkSync(fixture.ordinary, alias, 'dir');
		const secondProject = fixture.database.createProject('Shared workspace project');
		const secondBinding = fixture.database.createFolderBinding({ projectId: secondProject.id, path: alias });
		const secondSession = fixture.database.agentSessions.createSession({
			projectId: secondProject.id, bindingId: secondBinding.id, name: 'Second project session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder',
		});
		await assert.rejects(fixture.resolver.acquire({ projectId: secondProject.id, sessionId: secondSession.id, permissionPolicy: READ_ONLY }), /launch folder|cleanup|recovery/i);

		const historicalFolder = join(fixture.root, 'historical-ordinary');
		const moved = join(fixture.root, 'ordinary-rebound');
		mkdirSync(historicalFolder);
		mkdirSync(moved);
		const historicalProject = fixture.database.createProject('Historical launch project');
		const historicalBinding = fixture.database.createFolderBinding({ projectId: historicalProject.id, path: historicalFolder });
		const historicalSession = fixture.database.agentSessions.createSession({
			projectId: historicalProject.id, bindingId: historicalBinding.id, name: 'Historical session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder',
		});
		const historicalLease = await fixture.resolver.acquire({ projectId: historicalProject.id, sessionId: historicalSession.id, permissionPolicy: READ_ONLY });
		const historicalTurn = fixture.database.agentSessionTurns.createTurn({
			projectId: historicalProject.id, sessionId: historicalSession.id, expectedSessionRevision: historicalSession.revision, snapshot: historicalLease.snapshot,
		});
		fixture.resolver.release(historicalLease);
		fixture.database.updateFolderBinding(historicalBinding.id, { path: moved, expectedPath: historicalFolder });
		const targetProject = fixture.database.createProject('Rebound target project');
		const targetBinding = fixture.database.createFolderBinding({ projectId: targetProject.id, path: historicalFolder });
		const targetSession = fixture.database.agentSessions.createSession({
			projectId: targetProject.id, bindingId: targetBinding.id, name: 'Target session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder',
		});
		assert.equal(historicalTurn.snapshot.folderIdentity.canonicalPath, historicalFolder);
		await assert.rejects(fixture.resolver.acquire({ projectId: targetProject.id, sessionId: targetSession.id, permissionPolicy: READ_ONLY }), /launch folder|cleanup|recovery/i);
	} finally {
		dispose(fixture);
	}
});

test('trashed and deletion-pending task sessions cannot acquire a workspace', async () => {
	const fixture = createFixture();
	try {
		const trashedTask = fixture.database.createTask({ projectId: fixture.project.id, bindingId: fixture.sharedBinding.id, title: 'Trashed task' });
		const trashedSession = fixture.database.agentSessions.createSession({
			projectId: fixture.project.id, bindingId: fixture.sharedBinding.id, taskId: trashedTask.id, name: 'Trashed task session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder',
		});
		fixture.database.trashTask(trashedTask.id, trashedTask.revision, randomUUID());
		await assert.rejects(fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: trashedSession.id, permissionPolicy: READ_ONLY }), /trashed|deletion-pending|archived/i);

		const pendingTask = fixture.database.createTask({ projectId: fixture.project.id, bindingId: fixture.sharedBinding.id, title: 'Pending task' });
		const pendingSession = fixture.database.agentSessions.createSession({
			projectId: fixture.project.id, bindingId: fixture.sharedBinding.id, taskId: pendingTask.id, name: 'Pending task session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder',
		});
		fixture.database.beginTaskDeletion(pendingTask.id, pendingTask.revision, randomUUID());
		await assert.rejects(fixture.resolver.acquire({ projectId: fixture.project.id, sessionId: pendingSession.id, permissionPolicy: READ_ONLY }), /trashed|deletion-pending|archived/i);
	} finally {
		dispose(fixture);
	}
});

test('acquisition fails closed until trusted startup recovery has completed', async () => {
	const fixture = createFixture();
	try {
		const resolver = new AgentSessionWorkspaceResolver(fixture.database, fixture.worktrees, fixture.writerLock, () => false);
		await assert.rejects(resolver.acquire({ projectId: fixture.project.id, sessionId: fixture.sharedSession.id, permissionPolicy: READ_ONLY }), /startup recovery/i);
	} finally {
		dispose(fixture);
	}
});
