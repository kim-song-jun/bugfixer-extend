/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ManagedWorktreeService, type ManagedWorktreeLease, type ReviewedCommitApplyingRecord, type ReviewedCommitBinding } from './managedWorktrees.js';
import { OwnerOperationCoordinator } from './ownerOperationCoordinator.js';

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

async function reviewedBinding(service: ManagedWorktreeService, ownerId: string, path: string, contents: string) {
	const sourceHead = git((await service.inspect(ownerId)).worktreePath, 'rev-parse', 'HEAD');
	const bytes = Buffer.from(contents);
	const commitMessage = `review ${path}`;
	const preview = await service.prepareReviewedCommit({
		ownerId, sourceHead, commitMessage,
		files: [{ path, before: { absent: true }, after: { mode: '100644', sha256: createHash('sha256').update(bytes).digest('hex'), bytes } }]
	});
	const candidate = await service.createReviewedCommitCandidate(preview.previewId);
	return {
		...candidate, ownerId, commitMessage, author: preview.author, committer: preview.committer,
		files: preview.files
	};
}

function applyingJournal(): {
	readonly recordApplying: (record: ReviewedCommitApplyingRecord) => Promise<void>;
	readonly readApplying: (operationId: string) => Promise<ReviewedCommitApplyingRecord | undefined>;
	readonly get: () => ReviewedCommitApplyingRecord | undefined;
} {
	let record: ReviewedCommitApplyingRecord | undefined;
	return {
		recordApplying: async value => { record = value; },
		readApplying: async operationId => record?.operationId === operationId ? record : undefined,
		get: () => record
	};
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

test('concurrent preparation for one session owner creates one signed worktree lease', async () => {
	await fixture(async (_root, repository, service) => {
		const ownerId = randomUUID();
		const coordinator = new OwnerOperationCoordinator();
		const prepare = () => coordinator.run(ownerId, async () => {
			const existing = await service.inspectOptional(ownerId, repository);
			if (!existing) { await service.create({ repositoryPath: repository, ownerId, kind: 'session', baseRef: 'HEAD' }); }
			return service.inspect(ownerId);
		});
		const [first, second] = await Promise.all([prepare(), prepare()]);
		assert.equal(first.state, 'active');
		assert.equal(second.state, 'active');
		assert.equal(first.worktreePath, second.worktreePath);
		assert.equal(first.branch, second.branch);
		assert.equal(git(repository, 'worktree', 'list', '--porcelain').split(`worktree ${first.worktreePath}`).length - 1, 1);
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

test('an unprepared session owner can retry after a precreation Git failure using the same ID', async () => {
	await fixture(async (_root, repository, service) => {
		const ownerId = randomUUID();
		await assert.rejects(service.create({ repositoryPath: repository, ownerId, kind: 'session', baseRef: 'missing-session-base' }));
		assert.equal(await service.inspectOptional(ownerId, repository), undefined);
		const recovered = await service.create({ repositoryPath: repository, ownerId, kind: 'session', baseRef: 'HEAD' });
		assert.equal(recovered.ownerId, ownerId);
		assert.equal((await service.inspectOptional(ownerId, repository))?.state, 'active');
	});
});

test('optional inspection fails closed for invalid manifests and unmanifested worktree artifacts', async () => {
	await fixture(async (root, repository, service) => {
		const invalidManifestOwner = randomUUID();
		const invalidManifestPath = join(root, 'profile', 'managed-worktrees', `${invalidManifestOwner}.json`);
		writeFileSync(invalidManifestPath, JSON.stringify({ version: 1, ownerId: invalidManifestOwner }));
		await assert.rejects(service.inspectOptional(invalidManifestOwner, repository), /manifest|invalid|malformed|signature/i);

		const partialOwner = randomUUID();
		const partialPath = join(root, 'profile', 'managed-worktrees', 'session', partialOwner);
		mkdirSync(partialPath, { recursive: true });
		await assert.rejects(service.inspectOptional(partialOwner, repository), /unmanifested|recovery/i);
		assert.equal(existsSync(partialPath), true);

		const branchOwner = randomUUID();
		git(repository, 'branch', `bugfixer/session/${branchOwner}`);
		await assert.rejects(service.inspectOptional(branchOwner, repository), /branch .*without its signed worktree manifest/i);
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

test('reviewed commit candidate uses retained bytes and leaves checkout, branch, and real index untouched', async () => {
	await fixture(async (root, repository, service) => {
		writeFileSync(join(repository, 'obsolete.txt'), 'remove me\n');
		git(repository, 'add', 'obsolete.txt');
		git(repository, 'commit', '-qm', 'add deletion fixture');
		writeFileSync(join(repository, '.gitattributes'), '*.txt filter=fixture\n');
		git(repository, 'add', '.gitattributes');
		git(repository, 'commit', '-qm', 'add filter attribute');
		const filterMarker = join(root, 'filter-ran');
		const filterCommand = join(root, 'clean-filter');
		writeFileSync(filterCommand, `#!/bin/sh\nprintf ran > '${filterMarker}'\ncat\n`);
		chmodSync(filterCommand, 0o700);
		git(repository, 'config', 'filter.fixture.clean', filterCommand);
		const hookMarker = join(root, 'hook-ran');
		const hookPath = git(repository, 'rev-parse', '--git-path', 'hooks/pre-commit');
		const hook = hookPath.startsWith('/') ? hookPath : join(repository, hookPath);
		writeFileSync(hook, `#!/bin/sh\nprintf ran > '${hookMarker}'\n`);
		chmodSync(hook, 0o700);

		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const sourceHead = git(session.worktreePath, 'rev-parse', 'HEAD');
		const mainBranch = git(repository, 'branch', '--show-current');
		const mainHead = git(repository, 'rev-parse', 'HEAD');
		const refsBefore = git(repository, 'show-ref', '--heads');
		writeFileSync(join(repository, 'local.bin'), 'user-staged\n');
		git(repository, 'add', 'local.bin');
		const indexPathValue = git(repository, 'rev-parse', '--git-path', 'index');
		const realIndexPath = indexPathValue.startsWith('/') ? indexPathValue : join(repository, indexPathValue);
		const realIndex = readFileSync(realIndexPath);
		const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
		const retainedReadme = Buffer.from('retained content, independent of the worktree\n');
		const createdWithNewline = Buffer.from('created from retained bytes\n');
		const optionNamedFile = Buffer.from('literal option-like path\n');
		const symlinkTarget = Buffer.from('target.txt');
		const executable = Buffer.from('#!/bin/sh\nexit 0\n');
		const preview = await service.prepareReviewedCommit({
			ownerId: session.ownerId, sourceHead, commitMessage: 'Reviewed retained files\nwith a second paragraph',
			files: [
				{ path: 'README.md', before: { mode: '100644', sha256: sha(Buffer.from('base\n')) }, after: { mode: '100644', sha256: sha(retainedReadme), bytes: retainedReadme } },
				{ path: 'obsolete.txt', before: { mode: '100644', sha256: sha(Buffer.from('remove me\n')) }, after: { absent: true } },
				{ path: 'created\nliteral.txt', before: { absent: true }, after: { mode: '100644', sha256: sha(createdWithNewline), bytes: createdWithNewline } },
				{ path: '-literal.txt', before: { absent: true }, after: { mode: '100644', sha256: sha(optionNamedFile), bytes: optionNamedFile } },
				{ path: 'link', before: { absent: true }, after: { mode: '120000', sha256: sha(symlinkTarget), bytes: symlinkTarget } },
				{ path: 'bin/tool', before: { absent: true }, after: { mode: '100755', sha256: sha(executable), bytes: executable } }
			]
		});
		assert.equal(preview.sourceHead, sourceHead);
		assert.equal(preview.files.length, 6);
		assert.equal(Object.isFrozen(preview), true);
		assert.equal(Object.isFrozen(preview.files[0].after), true);
		assert.equal(Object.isFrozen(preview.author), true);
		writeFileSync(join(session.worktreePath, 'README.md'), 'later mutable worktree content\n');
		writeFileSync(join(session.worktreePath, 'unselected-later.txt'), 'not part of the explicit selection\n');

		const candidate = await service.createReviewedCommitCandidate(preview.previewId);
		assert.equal(candidate.state, 'candidate');
		assert.equal(git(repository, 'show', `${candidate.candidateCommitOid}:README.md`), 'retained content, independent of the worktree');
		assert.equal(execFileSync('git', ['-C', repository, 'show', `${candidate.candidateCommitOid}:created\nliteral.txt`], { encoding: 'utf8' }), 'created from retained bytes\n');
		assert.equal(git(repository, 'show', `${candidate.candidateCommitOid}:-literal.txt`), 'literal option-like path');
		assert.equal(execFileSync('git', ['-C', repository, 'show', `${candidate.candidateCommitOid}:link`], { encoding: 'utf8' }), 'target.txt');
		assert.equal(gitExitCode(repository, 'cat-file', '-e', `${candidate.candidateCommitOid}:obsolete.txt`), 128);
		assert.equal(gitExitCode(repository, 'cat-file', '-e', `${candidate.candidateCommitOid}:unselected-later.txt`), 128);
		assert.match(git(repository, 'ls-tree', candidate.candidateCommitOid, '--', 'bin/tool'), /^100755 blob /);
		const commitObject = execFileSync('git', ['-C', repository, 'cat-file', 'commit', candidate.candidateCommitOid]);
		const headerSeparator = commitObject.indexOf(Buffer.from('\n\n'));
		assert.ok(headerSeparator >= 0);
		const commitHeaders = commitObject.subarray(0, headerSeparator).toString('utf8').split('\n');
		assert.deepEqual(commitHeaders, [
			`tree ${preview.proposedTreeOid}`,
			`parent ${preview.sourceHead}`,
			`author ${preview.author.name} <${preview.author.email}> ${preview.author.date}`,
			`committer ${preview.committer.name} <${preview.committer.email}> ${preview.committer.date}`,
		]);
		assert.deepEqual(commitObject.subarray(headerSeparator + 2), Buffer.from(`${preview.commitMessage}\n`, 'utf8'));
		assert.equal(existsSync(filterMarker), false, 'hash-object must not run clean filters');
		assert.equal(existsSync(hookMarker), false, 'candidate creation must not run commit hooks');
		assert.equal(readFileSync(join(session.worktreePath, 'README.md'), 'utf8'), 'later mutable worktree content\n');
		assert.equal(readFileSync(join(session.worktreePath, 'unselected-later.txt'), 'utf8'), 'not part of the explicit selection\n');
		assert.equal(git(session.worktreePath, 'rev-parse', 'HEAD'), sourceHead);
		assert.equal(git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`), sourceHead);
		assert.equal(git(repository, 'branch', '--show-current'), mainBranch);
		assert.equal(git(repository, 'rev-parse', 'HEAD'), mainHead);
		assert.equal(git(repository, 'show-ref', '--heads'), refsBefore);
		assert.deepEqual(readFileSync(realIndexPath), realIndex);
		assert.equal(readFileSync(join(repository, 'local.bin'), 'utf8'), 'user-staged\n');
		assert.deepEqual(candidate.selectedPaths, ['README.md', 'obsolete.txt', 'created\nliteral.txt', '-literal.txt', 'link', 'bin/tool']);
	});
});

test('reviewed commit preparation rejects stale source and malformed retained file claims', async () => {
	await fixture(async (_root, repository, service) => {
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: 'HEAD' });
		const sourceHead = git(session.worktreePath, 'rev-parse', 'HEAD');
		const bytes = Buffer.from('reviewed\n');
		const input = {
			ownerId: session.ownerId, sourceHead, commitMessage: 'reviewed',
			files: [{ path: 'new.txt', before: { absent: true as const }, after: { mode: '100644' as const, sha256: createHash('sha256').update(bytes).digest('hex'), bytes } }]
		};
		const author = { name: 'Frozen Author', email: 'author@example.invalid', date: '946684800 +0000' };
		const committer = { name: 'Frozen Committer', email: 'committer@example.invalid', date: '978307200 -0700' };
		await assert.rejects(service.prepareReviewedCommit({ ...input, frozenIdentity: { author } as unknown as { author: typeof author; committer: typeof committer } }), /exactly one author and committer/i);
		await assert.rejects(service.prepareReviewedCommit({ ...input, frozenIdentity: { author, committer: { ...committer, date: undefined } } as unknown as { author: typeof author; committer: typeof committer } }), /malformed or incomplete/i);
		await assert.rejects(service.prepareReviewedCommit({ ...input, ownerId: integration.ownerId }), /active managed session lease/i);
		await assert.rejects(service.prepareReviewedCommit({ ...input, files: [{ ...input.files[0], after: { ...input.files[0].after, sha256: '0'.repeat(64) } }] }), /SHA-256/i);
		await assert.rejects(service.prepareReviewedCommit({ ...input, files: [{ ...input.files[0], path: '../escape.txt' }] }), /path/i);
		const oversized = Buffer.alloc(1024 * 1024 + 1, 1);
		await assert.rejects(service.prepareReviewedCommit({ ...input, files: [{ ...input.files[0], after: { ...input.files[0].after, sha256: createHash('sha256').update(oversized).digest('hex'), bytes: oversized } }] }), /one MiB/i);
		const preview = await service.prepareReviewedCommit(input);
		commit(session.worktreePath, 'advance.txt', 'new source commit\n', 'advance source');
		await assert.rejects(service.createReviewedCommitCandidate(preview.previewId), /active managed session lease|HEAD changed|source/i);
	});
});

test('approved reviewed candidate advances only its session ref and reconciles selected index entries', async () => {
	await fixture(async (_root, repository, service) => {
		const originalHead = git(repository, 'rev-parse', 'HEAD');
		const userIndexBefore = readFileSync(join(repository, '.git', 'index'));
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		writeFileSync(join(session.worktreePath, 'unrelated-staged.txt'), 'preserve this staged entry\n');
		git(session.worktreePath, 'add', 'unrelated-staged.txt');
		const binding = await reviewedBinding(service, session.ownerId, 'reviewed.txt', 'approved\n');
		writeFileSync(join(session.worktreePath, 'reviewed.txt'), 'approved\n');
		const journal = applyingJournal();
		const operationId = randomUUID();
		const result = await service.applyReviewedCommit({ operationId, binding, ...journal });
		assert.equal(result.state, 'applied');
		assert.equal(git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`), binding.candidateCommitOid);
		assert.equal(git(session.worktreePath, 'rev-parse', 'HEAD'), binding.candidateCommitOid);
		assert.match(git(session.worktreePath, 'ls-files', '--stage', '--', 'reviewed.txt'), /^100644 [0-9a-f]+ 0\treviewed\.txt$/);
		assert.match(git(session.worktreePath, 'ls-files', '--stage', '--', 'unrelated-staged.txt'), /^100644 [0-9a-f]+ 0\tunrelated-staged\.txt$/);
		assert.equal(git(session.worktreePath, 'status', '--porcelain=v1'), 'A  unrelated-staged.txt');
		assert.equal(git(repository, 'branch', '--show-current'), 'user-work');
		assert.equal(git(repository, 'rev-parse', 'HEAD'), originalHead);
		assert.deepEqual(readFileSync(join(repository, '.git', 'index')), userIndexBefore);
		assert.equal(journal.get()?.operationId, operationId);
		assert.equal((await service.inspect(session.ownerId)).head, binding.candidateCommitOid);
	});
});

test('the owned real index lock prevents an ordinary Git stage during the journal callback', async () => {
	await fixture(async (_root, repository, service) => {
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const binding = await reviewedBinding(service, session.ownerId, 'reviewed.txt', 'approved\n');
		writeFileSync(join(session.worktreePath, 'reviewed.txt'), 'approved\n');
		let applying: ReviewedCommitApplyingRecord | undefined;
		const operationId = randomUUID();
		const result = await service.applyReviewedCommit({
			operationId, binding,
			recordApplying: async record => {
				applying = record;
				assert.throws(() => git(session.worktreePath, 'add', 'reviewed.txt'), /index\.lock|Unable to create|File exists/i);
			},
			readApplying: async id => applying?.operationId === id ? applying : undefined
		});
		assert.equal(result.state, 'applied');
		assert.equal(git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`), binding.candidateCommitOid);
	});
});

test('direct real-index mutation during journaling is detected before the session ref CAS', async () => {
	await fixture(async (_root, repository, service) => {
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const binding = await reviewedBinding(service, session.ownerId, 'reviewed.txt', 'approved\n');
		const indexPath = resolve(session.worktreePath, git(session.worktreePath, 'rev-parse', '--git-path', 'index'));
		const indexBefore = readFileSync(indexPath);
		const operationId = randomUUID();
		let applying: ReviewedCommitApplyingRecord | undefined;
		const result = await service.applyReviewedCommit({
			operationId, binding,
			recordApplying: async record => {
				applying = record;
				writeFileSync(indexPath, Buffer.concat([indexBefore, Buffer.from('fixture external mutation')]));
			},
			readApplying: async id => applying?.operationId === id ? applying : undefined
		});
		assert.equal(result.state, 'recoveryRequired');
		assert.equal(result.currentRef, binding.sourceHead);
		assert.equal(git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`), binding.sourceHead);
		assert.notDeepEqual(readFileSync(indexPath), indexBefore);
		writeFileSync(indexPath, indexBefore);
	});
});

test('selected staged content blocks apply before journaling while unrelated index entries remain untouched', async () => {
	await fixture(async (_root, repository, service) => {
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const binding = await reviewedBinding(service, session.ownerId, 'reviewed.txt', 'approved\n');
		writeFileSync(join(session.worktreePath, 'reviewed.txt'), 'a different staged version\n');
		git(session.worktreePath, 'add', 'reviewed.txt');
		const refBefore = git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`);
		const indexBefore = readFileSync(resolve(session.worktreePath, git(session.worktreePath, 'rev-parse', '--git-path', 'index')));
		const journal = applyingJournal();
		await assert.rejects(service.applyReviewedCommit({ operationId: randomUUID(), binding, ...journal }), /unique staged version/i);
		assert.equal(git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`), refBefore);
		assert.deepEqual(readFileSync(resolve(session.worktreePath, git(session.worktreePath, 'rev-parse', '--git-path', 'index'))), indexBefore);
		assert.equal(journal.get(), undefined);
	});
});

test('journal write failure leaves the session ref and real index unchanged', async () => {
	await fixture(async (_root, repository, service) => {
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const binding = await reviewedBinding(service, session.ownerId, 'reviewed.txt', 'approved\n');
		const refBefore = git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`);
		const indexPath = resolve(session.worktreePath, git(session.worktreePath, 'rev-parse', '--git-path', 'index'));
		const indexBefore = readFileSync(indexPath);
		await assert.rejects(service.applyReviewedCommit({
			operationId: randomUUID(), binding, recordApplying: async () => { throw new Error('database unavailable'); },
			readApplying: async () => undefined
		}), /database unavailable/i);
		assert.equal(git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`), refBefore);
		assert.deepEqual(readFileSync(indexPath), indexBefore);
	});
});

test('a stale session ref is rejected before a new applying receipt is written', async () => {
	await fixture(async (_root, repository, service) => {
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const binding = await reviewedBinding(service, session.ownerId, 'reviewed.txt', 'approved\n');
		commit(session.worktreePath, 'external.txt', 'advance\n', 'advance session branch');
		const currentRef = git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`);
		const journal = applyingJournal();
		await assert.rejects(service.applyReviewedCommit({ operationId: randomUUID(), binding, ...journal }), /source ref changed|active managed session lease/i);
		assert.equal(git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`), currentRef);
		assert.equal(journal.get(), undefined);
	});
});

test('recovery with an exact durable journal repairs candidate index after an interrupted ref apply', async () => {
	await fixture(async (root, repository, service) => {
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const binding = await reviewedBinding(service, session.ownerId, 'reviewed.txt', 'approved\n');
		const journal = applyingJournal();
		const operationId = randomUUID();
		const internals = service as unknown as {
			assertIndexMatchesReviewedCommit(lease: ManagedWorktreeLease, proposal: ReviewedCommitBinding, expectedBytes: Buffer): Promise<void>;
		};
		const originalCheck = internals.assertIndexMatchesReviewedCommit.bind(service);
		let injectFailure = true;
		internals.assertIndexMatchesReviewedCommit = async (lease, proposal, expectedBytes) => {
			if (injectFailure) { injectFailure = false; throw new Error('fixture post-rename index verification failure'); }
			return originalCheck(lease, proposal, expectedBytes);
		};
		const result = await service.applyReviewedCommit({ operationId, binding, ...journal });
		assert.equal(result.state, 'recoveryRequired');
		assert.equal(git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`), binding.candidateCommitOid);
		assert.match(git(session.worktreePath, 'ls-files', '--stage', '--', 'reviewed.txt'), /^100644 [0-9a-f]+ 0\treviewed\.txt$/);
		const reopened = new ManagedWorktreeService(join(root, 'profile'));
		const recovered = await reopened.reconcileReviewedCommit({ operationId, binding, readApplying: journal.readApplying });
		assert.equal(recovered.state, 'alreadyApplied');
		assert.match(git(session.worktreePath, 'ls-files', '--stage', '--', 'reviewed.txt'), /^100644 [0-9a-f]+ 0\treviewed\.txt$/);
		assert.equal((await reopened.inspect(session.ownerId)).head, binding.candidateCommitOid);
	});
});

test('recovery refuses to move a session ref still at source or at another commit', async () => {
	await fixture(async (_root, repository, service) => {
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const binding = await reviewedBinding(service, session.ownerId, 'reviewed.txt', 'approved\n');
		const journal = applyingJournal();
		const operationId = randomUUID();
		const record = { operationId, binding };
		await journal.recordApplying(record);
		const atSource = await service.reconcileReviewedCommit({ operationId, binding, readApplying: journal.readApplying });
		assert.equal(atSource.state, 'recoveryRequired');
		assert.equal(atSource.currentRef, binding.sourceHead);
		assert.equal(git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`), binding.sourceHead);
		commit(session.worktreePath, 'external.txt', 'external\n', 'external advance');
		const other = git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`);
		const atOther = await service.reconcileReviewedCommit({ operationId, binding, readApplying: journal.readApplying });
		assert.equal(atOther.state, 'recoveryRequired');
		assert.equal(atOther.currentRef, other);
		assert.equal(git(session.worktreePath, 'rev-parse', `refs/heads/${session.branch}`), other);
	});
});
