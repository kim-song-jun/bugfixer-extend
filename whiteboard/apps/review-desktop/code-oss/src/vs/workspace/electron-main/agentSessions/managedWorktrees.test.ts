/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ManagedWorktreeService, type ManagedWorktreeLease } from './managedWorktrees.js';

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function gitExitCode(cwd: string, ...args: string[]): number | null {
	try { execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }); return 0; }
	catch (error) { return (error as NodeJS.ErrnoException & { status?: number }).status ?? null; }
}

async function fixture(run: (root: string, repository: string, service: ManagedWorktreeService) => Promise<void>, options: { globalIdentity?: boolean } = {}): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), 'bugfixer-managed-worktrees-'));
	const repository = join(root, 'repository');
	const profile = join(root, 'profile');
	mkdirSync(repository);
	mkdirSync(profile);
	const priorGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
	const identityEnvironment = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'];
	const priorIdentityEnvironment = new Map(identityEnvironment.map(key => [key, process.env[key]]));
	if (options.globalIdentity) { for (const key of identityEnvironment) { delete process.env[key]; } }
	const isolatedGlobalConfig = join(profile, 'gitconfig');
	try {
		git(repository, 'init', '-q', '-b', 'user-work');
		if (options.globalIdentity) {
			writeFileSync(isolatedGlobalConfig, '[user]\n\tname = Fixture Global\n\temail = global@example.invalid\n');
		} else {
			writeFileSync(isolatedGlobalConfig, '');
		}
		process.env.GIT_CONFIG_GLOBAL = isolatedGlobalConfig;
		if (!options.globalIdentity) {
			git(repository, 'config', 'user.name', 'Fixture User');
			git(repository, 'config', 'user.email', 'fixture@example.invalid');
		}
		writeFileSync(join(repository, 'README.md'), 'base\n');
		git(repository, 'add', 'README.md');
		git(repository, 'commit', '-qm', 'base');
		await run(root, repository, new ManagedWorktreeService(profile));
	}
	finally {
		if (priorGlobalConfig === undefined) { delete process.env.GIT_CONFIG_GLOBAL; } else { process.env.GIT_CONFIG_GLOBAL = priorGlobalConfig; }
		for (const [key, value] of priorIdentityEnvironment) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
		rmSync(root, { recursive: true, force: true });
	}
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
	const prior = new Map(Object.keys(values).map(key => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
	try { await run(); }
	finally { for (const [key, value] of prior) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } } }
}

type TestInternals = {
	writeLease(lease: ManagedWorktreeLease): ManagedWorktreeLease;
	sign(value: object): string;
	withIntegrationLock<T>(ownerId: string, operation: 'merge' | 'remove', run: () => T | Promise<T>): Promise<T>;
	runCommand(command: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: Buffer; stderr: Buffer }>;
};

function commit(worktree: string, path: string, contents: string, message: string): void {
	writeFileSync(join(worktree, path), contents);
	git(worktree, 'add', path);
	git(worktree, 'commit', '-qm', message);
}

test('session worktrees use separate owned branches and leave the user checkout untouched', async () => {
	await fixture(async (_root, repository, service) => {
		const originalHead = git(repository, 'rev-parse', 'HEAD');
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: 'HEAD' });
		assert.match(session.branch, /^bugfixer\/session\/[0-9a-f-]{36}$/);
		assert.match(integration.branch, /^bugfixer\/integration\/[0-9a-f-]{36}$/);
		assert.notEqual(session.worktreePath, integration.worktreePath);
		assert.equal(git(repository, 'branch', '--show-current'), 'user-work');
		assert.equal(git(repository, 'rev-parse', 'HEAD'), originalHead);
		assert.equal((await service.inspect(session.ownerId)).repositoryPath, repository);
	});
});

test('reviewed merge integrates the reviewed session commit in the integration worktree', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'feature.txt', 'feature\n', 'feature');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		const result = await service.mergeReviewed(preview.previewId);
		assert.equal(result.state, 'merged');
		assert.equal(readFileSync(join(integration.worktreePath, 'feature.txt'), 'utf8'), 'feature\n');
		assert.equal(git(repository, 'branch', '--show-current'), 'user-work');
	});
});

test('merge uses the repository user identity from global Git config', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'global-identity.txt', 'ok\n', 'global identity');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		assert.equal((await service.mergeReviewed(preview.previewId)).state, 'merged');
		assert.match(git(integration.worktreePath, 'show', '-s', '--format=%an <%ae>', 'HEAD'), /^Fixture Global <global@example\.invalid>$/);
	}, { globalIdentity: true });
});

test('a merge failure before Git mutation reconciles as not applied', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'identity-failure.txt', 'preserved\n', 'source commit');
		git(repository, 'config', '--unset', 'user.name');
		git(repository, 'config', '--unset', 'user.email');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		await assert.rejects(service.mergeReviewed(preview.previewId), /identity/i);
		const inspected = await service.inspect(integration.ownerId);
		assert.equal(inspected.state, 'active');
		assert.equal(inspected.pendingOperation, undefined);
		assert.ok(inspected.lastOperation);
		assert.match(inspected.lastOperation.id, /^[0-9a-f-]{36}$/i);
		assert.equal(inspected.lastOperation.kind, 'merge');
		assert.equal(inspected.lastOperation.outcome, 'notApplied');
		assert.equal(inspected.lastOperation.reconciled, true);
		assert.equal('version' in inspected, false);
		assert.equal('signature' in inspected, false);
		assert.equal(existsSync(join(integration.worktreePath, 'identity-failure.txt')), false);
		assert.equal(git(integration.worktreePath, 'status', '--porcelain'), '');
		const reopened = new ManagedWorktreeService(join(_root, 'profile'));
		assert.deepEqual((await reopened.inspect(integration.ownerId)).lastOperation, inspected.lastOperation);
	});
});

test('a non-conflict commit-signing failure after merge preparation remains pending for recovery', async () => {
	await fixture(async (root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'signing-failure.txt', 'preserved in prepared merge\n', 'source commit');
		const gpgMarker = join(root, 'gpg-called');
		const failingGpg = join(root, 'failing-gpg');
		writeFileSync(failingGpg, `#!/bin/sh\nprintf 'fixture signing failure\\n' >&2\nprintf called > '${gpgMarker}'\nexit 1\n`);
		chmodSync(failingGpg, 0o700);
		git(integration.worktreePath, 'config', 'commit.gpgsign', 'true');
		git(integration.worktreePath, 'config', 'gpg.program', failingGpg);
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		await assert.rejects(service.mergeReviewed(preview.previewId), /fixture signing failure/i);
		assert.equal(existsSync(gpgMarker), true);
		assert.equal(readFileSync(join(integration.worktreePath, 'signing-failure.txt'), 'utf8'), 'preserved in prepared merge\n');
		const mergeHeadValue = git(integration.worktreePath, 'rev-parse', '--git-path', 'MERGE_HEAD');
		const mergeHeadPath = mergeHeadValue.startsWith('/') ? mergeHeadValue : join(integration.worktreePath, mergeHeadValue);
		assert.equal(readFileSync(mergeHeadPath, 'utf8').trim(), preview.sourceHead);
		assert.equal(git(integration.worktreePath, 'ls-files', '--error-unmatch', 'signing-failure.txt'), 'signing-failure.txt');
		assert.equal(git(integration.worktreePath, 'ls-files', '--unmerged'), '');
		const inspected = await service.inspect(integration.ownerId);
		assert.equal(inspected.state, 'recoveryRequired');
		assert.equal(inspected.pendingOperation?.kind, 'merge');
		const reopened = new ManagedWorktreeService(join(root, 'profile'));
		assert.equal((await reopened.inspect(integration.ownerId)).pendingOperation?.id, inspected.pendingOperation?.id);
	});
});

test('ambient repository and config override variables cannot redirect managed Git commands', async () => {
	await fixture(async (root, repository, service) => {
		const decoy = join(root, 'decoy');
		mkdirSync(decoy);
		git(decoy, 'init', '-q');
		const serviceRoot = join(root, 'profile', 'managed-worktrees');
		await withEnv({
			GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy, GIT_COMMON_DIR: join(decoy, '.git'),
			GIT_INDEX_FILE: join(decoy, 'index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: decoy
		}, async () => {
			const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
			assert.equal((await service.inspect(session.ownerId)).repositoryPath, repository);
			assert.ok(existsSync(join(serviceRoot, 'session', session.ownerId)));
		});
	});
});

test('preview expires if either source or target HEAD advances', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'source.txt', 'one\n', 'source one');
		const sourcePreview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		commit(session.worktreePath, 'source.txt', 'two\n', 'source two');
		await assert.rejects(service.mergeReviewed(sourcePreview.previewId), /stale|changed/i);
		const targetPreview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		commit(integration.worktreePath, 'target.txt', 'advance\n', 'target advance');
		await assert.rejects(service.mergeReviewed(targetPreview.previewId), /stale|changed/i);
	});
});

test('a target commit inserted between snapshot validation and merge is never recorded as reviewed success', async () => {
	await fixture(async (root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'reviewed-source.txt', 'reviewed change\n', 'reviewed source');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
		const shimDirectory = join(root, 'git-shim');
		mkdirSync(shimDirectory);
		const marker = join(root, 'target-advanced');
		const targetFile = join(integration.worktreePath, 'external-target.txt');
		const wrapper = join(shimDirectory, 'git');
		writeFileSync(wrapper, `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = merge ] && [ ! -f '${marker}' ]; then\n    printf 'external target advance\\n' > '${targetFile}'\n    '${realGit}' -C '${integration.worktreePath}' add external-target.txt\n    '${realGit}' -C '${integration.worktreePath}' commit -qm 'external target advance'\n    touch '${marker}'\n    break\n  fi\ndone\nexec '${realGit}' "$@"\n`);
		chmodSync(wrapper, 0o700);
		await withEnv({ PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? ''}` }, async () => {
			await assert.rejects(service.mergeReviewed(preview.previewId), /reviewed target and source|durable recovery|merge commit/i);
			const inspected = await service.inspect(integration.ownerId);
			assert.equal(inspected.state, 'recoveryRequired');
			assert.equal(inspected.pendingOperation?.targetHead, preview.targetHead);
			assert.match(git(integration.worktreePath, 'log', '-1', '--format=%s'), /Merge|merge/i);
			assert.equal(readFileSync(targetFile, 'utf8'), 'external target advance\n');
			assert.equal(readFileSync(join(integration.worktreePath, 'reviewed-source.txt'), 'utf8'), 'reviewed change\n');
		});
	});
});

test('merge conflict is reported and retained for explicit recovery', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'README.md', 'session\n', 'session edit');
		commit(integration.worktreePath, 'README.md', 'integration\n', 'integration edit');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		const result = await service.mergeReviewed(preview.previewId);
		assert.equal(result.state, 'conflict');
		assert.ok(git(integration.worktreePath, 'status', '--porcelain').length > 0);
		await assert.rejects(service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId }), /conflict|recovery/i);
	});
});

test('a crash after Git merge but before receipt is reconciled from exact merge parents', async () => {
	await fixture(async (root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'crash-window.txt', 'merged\n', 'source commit');
		const sourceHead = git(session.worktreePath, 'rev-parse', 'HEAD');
		const targetHead = git(integration.worktreePath, 'rev-parse', 'HEAD');
		const pending = { id: randomUUID(), kind: 'merge' as const, startedAt: Date.now(), sourceOwnerId: session.ownerId, sourceHead, targetHead };
		(service as unknown as TestInternals).writeLease({ ...integration, state: 'recoveryRequired', pendingOperation: pending });
		git(integration.worktreePath, 'merge', '--no-ff', '--no-edit', sourceHead);
		const internals = service as unknown as TestInternals;
		const operationLock = join(root, 'profile', 'managed-worktrees', `${integration.ownerId}.operation-lock.json`);
		const lockUnsigned = { ownerId: integration.ownerId, operation: 'merge' as const, operationId: randomUUID(), pid: process.pid, processStart: execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 16 * 1024 }).trim() };
		writeFileSync(operationLock, JSON.stringify({ ...lockUnsigned, signature: internals.sign(lockUnsigned) }));
		assert.equal((await service.inspect(integration.ownerId)).pendingOperation?.id, pending.id);
		rmSync(operationLock);
		const reopened = new ManagedWorktreeService(join(root, 'profile'));
		const recovered = await reopened.inspect(integration.ownerId);
		assert.equal(recovered.state, 'active');
		assert.deepEqual(recovered.lastOperation, { id: pending.id, kind: 'merge', outcome: 'merged', commit: recovered.head, reconciled: true });
		assert.equal(git(integration.worktreePath, 'show', 'HEAD:crash-window.txt'), 'merged');
	});
});

test('pending merge with an unexpected HEAD remains blocked and is never assumed successful', async () => {
	await fixture(async (_root, repository, service) => {
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: 'HEAD' });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const pending = { id: randomUUID(), kind: 'merge' as const, startedAt: Date.now(), sourceOwnerId: session.ownerId, sourceHead: session.head, targetHead: integration.head };
		(service as unknown as TestInternals).writeLease({ ...integration, state: 'recoveryRequired', pendingOperation: pending });
		commit(integration.worktreePath, 'unexpected.txt', 'keep\n', 'unexpected target advance');
		const inspected = await service.inspect(integration.ownerId);
		assert.equal(inspected.state, 'recoveryRequired');
		assert.deepEqual(inspected.pendingOperation, pending);
		assert.equal(readFileSync(join(integration.worktreePath, 'unexpected.txt'), 'utf8'), 'keep\n');
	});
});

test('unmerged paths with MERGE_HEAD are not reconciled if target HEAD moved', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'README.md', 'session side\n', 'session conflict');
		commit(integration.worktreePath, 'README.md', 'integration side\n', 'integration conflict');
		const pending = {
			id: randomUUID(), kind: 'merge' as const, startedAt: Date.now(), sourceOwnerId: session.ownerId,
			sourceHead: git(session.worktreePath, 'rev-parse', 'HEAD'), targetHead: git(integration.worktreePath, 'rev-parse', 'HEAD')
		};
		(service as unknown as TestInternals).writeLease({ ...integration, state: 'recoveryRequired', pendingOperation: pending });
		assert.equal(gitExitCode(integration.worktreePath, 'merge', '--no-ff', '--no-edit', pending.sourceHead!), 1);
		assert.ok(git(integration.worktreePath, 'ls-files', '--unmerged'));
		git(integration.worktreePath, 'update-ref', `refs/heads/${integration.branch}`, base);
		const inspected = await service.inspect(integration.ownerId);
		assert.equal(inspected.state, 'recoveryRequired');
		assert.deepEqual(inspected.pendingOperation, pending);
		assert.ok(git(integration.worktreePath, 'ls-files', '--unmerged'));
	});
});

test('a crash after worktree removal is reconciled without discarding the retained session ref', async () => {
	await fixture(async (root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'retained.txt', 'ref retained\n', 'retained session');
		const sourceHead = git(session.worktreePath, 'rev-parse', 'HEAD');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		assert.equal((await service.mergeReviewed(preview.previewId)).state, 'merged');
		const pending = { id: randomUUID(), kind: 'remove' as const, startedAt: Date.now(), expectedHead: sourceHead, retainedIntegrationOwnerId: integration.ownerId };
		(service as unknown as TestInternals).writeLease({ ...session, state: 'recoveryRequired', pendingOperation: pending });
		git(repository, 'worktree', 'remove', session.worktreePath);
		const reopened = new ManagedWorktreeService(join(root, 'profile'));
		const recovered = await reopened.inspect(session.ownerId);
		assert.equal(recovered.state, 'removed');
		assert.equal(git(repository, 'rev-parse', `refs/heads/${session.branch}`), sourceHead);
		assert.equal(recovered.lastOperation?.reconciled, true);
	});
});

test('merge hooks stay disabled and operation locks reject concurrent owners then clear after failure', async () => {
	await fixture(async (root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'hook.txt', 'merged\n', 'hook fixture');
		const hookPath = git(integration.worktreePath, 'rev-parse', '--git-path', 'hooks/pre-merge-commit');
		const hook = hookPath.startsWith('/') ? hookPath : join(integration.worktreePath, hookPath);
		const marker = join(root, 'hook-ran');
		writeFileSync(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`);
		chmodSync(hook, 0o700);
		const internals = service as unknown as TestInternals;
		const secondInstance = new ManagedWorktreeService(join(root, 'profile')) as unknown as TestInternals;
		await assert.rejects(internals.withIntegrationLock(integration.ownerId, 'merge', () => secondInstance.withIntegrationLock(integration.ownerId, 'merge', () => undefined)), /live process|lock/i);
		assert.equal(existsSync(join(root, 'profile', 'managed-worktrees', `${integration.ownerId}.operation-lock.json`)), false);
		await assert.rejects(internals.withIntegrationLock(integration.ownerId, 'remove', async () => { throw new Error('operation fixture failure'); }), /operation fixture failure/);
		assert.equal(existsSync(join(root, 'profile', 'managed-worktrees', `${integration.ownerId}.operation-lock.json`)), false);
		const lockPath = join(root, 'profile', 'managed-worktrees', `${integration.ownerId}.operation-lock.json`);
		const staleUnsigned = { ownerId: integration.ownerId, operation: 'merge' as const, operationId: randomUUID(), pid: process.pid, processStart: 'old-process-start-token' };
		writeFileSync(lockPath, JSON.stringify({ ...staleUnsigned, signature: internals.sign(staleUnsigned) }));
		assert.equal(await internals.withIntegrationLock(integration.ownerId, 'merge', () => 'recovered stale lock'), 'recovered stale lock');
		assert.equal(existsSync(lockPath), false);
		writeFileSync(lockPath, '{ forged lock');
		await assert.rejects(internals.withIntegrationLock(integration.ownerId, 'merge', () => undefined), /invalid|ambiguous|recovery/i);
		rmSync(lockPath);
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		assert.equal((await service.mergeReviewed(preview.previewId)).state, 'merged');
		assert.equal(existsSync(marker), false);
	});
});

test('subprocess timeout terminates the owned POSIX process group', async () => {
	await fixture(async (root, _repository, service) => {
		const pidPath = join(root, 'sleeping-child.pid');
		const script = join(root, 'sleeping-git-fixture');
		writeFileSync(script, `#!/bin/sh\nprintf '%s' "$$" > '${pidPath}'\ntrap '' TERM\nwhile :; do sleep 1; done\n`);
		chmodSync(script, 0o700);
		const internals = service as unknown as TestInternals;
		await assert.rejects(internals.runCommand(script, [], 500), /timeout.*process group was terminated/i);
		const pid = Number(readFileSync(pidPath, 'utf8'));
		assert.ok(Number.isSafeInteger(pid) && pid > 0);
		let alive = true;
		try { process.kill(pid, 0); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ESRCH') { alive = false; }
			else { throw error; }
		}
		assert.equal(alive, false);
	});
});

test('timeout rejection waits for SIGKILL cleanup of descendants that close pipes and ignore TERM', async () => {
	if (process.platform === 'win32') { return; }
	await fixture(async (root, _repository, service) => {
		const pidPath = join(root, 'detached-descendant.pid');
		const script = join(root, 'spawn-descendant-fixture');
		writeFileSync(script, `#!/bin/sh\nsh -c 'trap "" TERM; printf "%s" "$$" > "${pidPath}"; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &\nexec >/dev/null 2>&1\nwait\n`);
		chmodSync(script, 0o700);
		const internals = service as unknown as TestInternals;
		const startedAt = Date.now();
		await assert.rejects(internals.runCommand(script, [], 500), /timeout.*process group was terminated/i);
		assert.ok(Date.now() - startedAt >= 1_300, 'timeout should settle only after the owned process group cleanup deadline');
		const pid = Number(readFileSync(pidPath, 'utf8'));
		assert.ok(Number.isSafeInteger(pid) && pid > 0);
		let processState = '';
		try { processState = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim(); }
		catch (error) { assert.equal((error as NodeJS.ErrnoException & { status?: number }).status, 1); }
		assert.ok(!processState || processState.startsWith('Z'), `descendant must be gone or reaped after operation rejection, got ${processState}`);
	});
});

test('mismatched repositories and forged or retargeted manifests cannot authorize operations', async () => {
	await fixture(async (root, repository, service) => {
		const other = join(root, 'other');
		mkdirSync(other);
		git(other, 'init', '-q');
		git(other, 'config', 'user.name', 'Fixture User');
		git(other, 'config', 'user.email', 'fixture@example.invalid');
		writeFileSync(join(other, 'README.md'), 'other\n');
		git(other, 'add', 'README.md');
		git(other, 'commit', '-qm', 'other');
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const integration = await service.create({ repositoryPath: other, ownerId: randomUUID(), kind: 'integration', baseRef: 'HEAD' });
		await assert.rejects(service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId }), /same repository|repository/i);
		const manifestPath = join(root, 'profile', 'managed-worktrees', `${session.ownerId}.json`);
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
		manifest.worktreePath = other;
		writeFileSync(manifestPath, JSON.stringify(manifest));
		await assert.rejects(service.inspect(session.ownerId), /manifest|identity|signature|owned/i);
	});
});

test('dirty and untracked worktrees are preserved when cleanup is rejected', async () => {
	await fixture(async (_root, repository, service) => {
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		writeFileSync(join(session.worktreePath, 'README.md'), 'modified\n');
		await assert.rejects(service.remove(session.ownerId), /dirty|untracked|clean/i);
		assert.equal(readFileSync(join(session.worktreePath, 'README.md'), 'utf8'), 'modified\n');
		writeFileSync(join(session.worktreePath, 'untracked.txt'), 'keep me\n');
		await assert.rejects(service.remove(session.ownerId), /dirty|untracked|clean/i);
		assert.equal(readFileSync(join(session.worktreePath, 'untracked.txt'), 'utf8'), 'keep me\n');
	});
});

test('clean merged session cleanup preserves the commit in its integration branch', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'merged.txt', 'retained\n', 'unique session change');
		const sessionHead = git(session.worktreePath, 'rev-parse', 'HEAD');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		const merged = await service.mergeReviewed(preview.previewId);
		assert.equal(merged.state, 'merged');
		await service.remove(session.ownerId, { retainedIntegrationOwnerId: integration.ownerId });
		assert.equal(git(integration.worktreePath, 'merge-base', '--is-ancestor', sessionHead, 'HEAD'), '');
		assert.equal(git(integration.worktreePath, 'show', 'HEAD:merged.txt'), 'retained');
	});
});
