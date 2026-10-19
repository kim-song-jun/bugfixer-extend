/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ManagedWorktreeService, type ManagedWorktreeLease, type ReviewedCommitApplyingRecord, type ReviewedCommitBinding, type ReviewedMergeApplyingRecord, type MergePreview } from './managedWorktrees.js';
import { OwnerOperationCoordinator } from './ownerOperationCoordinator.js';

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function gitExitCode(cwd: string, ...args: string[]): number | null {
	try { execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }); return 0; }
	catch (error) { return (error as NodeJS.ErrnoException & { status?: number }).status ?? null; }
}

async function fixture(run: (root: string, repository: string, service: ManagedWorktreeService) => Promise<void>, options: { globalIdentity?: boolean; objectFormat?: 'sha1' | 'sha256' } = {}): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), 'bugfixer-managed-worktrees-'));
	const repository = join(root, 'repository');
	const profile = join(root, 'profile');
	mkdirSync(repository);
	mkdirSync(profile);
	const priorGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
	const identityEnvironment = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE', 'EMAIL'];
	const priorIdentityEnvironment = new Map(identityEnvironment.map(key => [key, process.env[key]]));
	if (options.globalIdentity) { for (const key of identityEnvironment) { delete process.env[key]; } }
	const isolatedGlobalConfig = join(profile, 'gitconfig');
	try {
		git(repository, 'init', '-q', '-b', 'user-work', `--object-format=${options.objectFormat ?? 'sha1'}`);
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

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const prior = new Map(Object.keys(values).map(key => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
	try { return await run(); }
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

test('publication uses the signed integration lock and existing PID-reuse recovery protocol', async () => {
	await fixture(async (root, _repository, service) => {
		const ownerId = randomUUID();
		const path = realpathSync('/usr/bin/git');
		const executable = { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
		const lockPath = join(root, 'profile', 'managed-worktrees', `${ownerId}.operation-lock.json`);
		await assert.rejects(service.acquirePublicationLease(ownerId, { ...executable, sha256: '0'.repeat(64) }));
		assert.equal(existsSync(lockPath), false, 'Untrusted Git does not acquire a durable lock');
		const stale = { ownerId, operation: 'publication', operationId: randomUUID(), pid: process.pid, processStart: 'prior-PID-incarnation' };
		writeFileSync(lockPath, JSON.stringify({ ...stale, signature: (service as unknown as TestInternals).sign(stale) }), { mode: 0o600 });
		const lease = await service.acquirePublicationLease(ownerId, executable);
		try {
			const acquired = JSON.parse(readFileSync(lockPath, 'utf8')) as typeof stale;
			assert.equal(acquired.operation, 'publication'); assert.notEqual(acquired.operationId, stale.operationId);
			await assert.rejects(new ManagedWorktreeService(join(root, 'profile')).acquirePublicationLease(ownerId, executable), /live process/u);
			await assert.rejects((service as unknown as TestInternals).withIntegrationLock(ownerId, 'merge', async () => undefined), /live process/u);
			await assert.rejects((service as unknown as TestInternals).withIntegrationLock(ownerId, 'remove', async () => undefined), /live process/u);
		} finally { await lease.release(); }
		await lease.release(); assert.equal(existsSync(lockPath), false);
		const next = await service.acquirePublicationLease(ownerId, executable); await next.release();
		writeFileSync(lockPath, JSON.stringify({ ...stale, signature: '0'.repeat(64) }), { mode: 0o600 });
		await assert.rejects(service.acquirePublicationLease(ownerId, executable), /invalid or ambiguous/u);
		assert.equal(existsSync(lockPath), true, 'Unverifiable foreign lock is retained for explicit recovery');
	});
});

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

type TestMergeJournal = {
	readonly operationId: string;
	readonly readApplying: (operationId: string) => Promise<ReviewedMergeApplyingRecord | undefined>;
	readonly recordArtifact: (operationId: string, expectedRevision: number, event: import('../../common/workspaceAgentMergeProtocol.js').AgentSessionMergeArtifactEvent) => Promise<import('../../common/workspaceAgentMergeProtocol.js').AgentSessionMergeArtifactRecord>;
	readonly readArtifacts: (operationId: string) => Promise<readonly import('../../common/workspaceAgentMergeProtocol.js').AgentSessionMergeArtifactRecord[]>;
};

async function mergeReviewed(service: ManagedWorktreeService, preview: MergePreview, options: {
	beforeReadback?: () => Promise<void>;
	readback?: (record: ReviewedMergeApplyingRecord) => ReviewedMergeApplyingRecord | undefined;
	beforeArtifact?: (event: import('../../common/workspaceAgentMergeProtocol.js').AgentSessionMergeArtifactEvent) => Promise<void> | void;
	captureJournal?: (journal: TestMergeJournal) => void;
} = {}) {
	let durable: ReviewedMergeApplyingRecord | undefined;
	let artifacts: Array<{ readonly revision: number; readonly event: import('../../common/workspaceAgentMergeProtocol.js').AgentSessionMergeArtifactEvent }> = [];
	const operationId = randomUUID();
	const journal: TestMergeJournal = {
		operationId,
		readApplying: async requestedId => requestedId === operationId ? durable : undefined,
		recordArtifact: async (requestedId, expectedRevision, event) => {
			if (requestedId !== operationId || expectedRevision !== artifacts.length) { throw new Error('Test journal rejected an unexpected artifact revision.'); }
			await options.beforeArtifact?.(event);
			const record = { revision: expectedRevision + 1, event };
			artifacts.push(record);
			return record;
		},
		readArtifacts: async requestedId => requestedId === operationId ? artifacts : []
	};
	options.captureJournal?.(journal);
	return service.mergeReviewed({
		previewId: preview.previewId, operationId, proposalId: randomUUID(), proposalFingerprint: 'a'.repeat(64),
		commitMessage: preview.commitMessage, author: preview.author, committer: preview.committer,
		recordApplying: async record => { durable = record; await options.beforeReadback?.(); },
		readApplying: async requestedId => {
			if (!durable || durable.operationId !== requestedId) { return undefined; }
			return options.readback ? options.readback(durable) : durable;
		},
		recordArtifact: journal.recordArtifact,
		readArtifacts: journal.readArtifacts,
	});
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

test('integration target is stable, starts at the source base, and never claims an orphan branch', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'committed.txt', 'committed source\n', 'source commit');
		writeFileSync(join(session.worktreePath, 'unselected.txt'), 'leave dirty\n');
		const ownerId = randomUUID();
		const integration = await service.ensureIntegrationTarget({ ownerId, sessionOwnerId: session.ownerId });
		assert.equal(integration.ownerId, ownerId);
		assert.equal(integration.kind, 'integration');
		assert.equal(integration.baseCommit, session.baseCommit);
		assert.equal(integration.head, session.baseCommit);
		const reused = await service.ensureIntegrationTarget({ ownerId, sessionOwnerId: session.ownerId });
		assert.equal(reused.worktreePath, integration.worktreePath);
		assert.equal(reused.head, integration.head);
		assert.equal(readFileSync(join(session.worktreePath, 'unselected.txt'), 'utf8'), 'leave dirty\n');
		assert.equal(existsSync(join(integration.worktreePath, 'unselected.txt')), false);

		const orphanOwner = randomUUID();
		git(repository, 'branch', `bugfixer/integration/${orphanOwner}`, base);
		await assert.rejects(service.ensureIntegrationTarget({ ownerId: orphanOwner, sessionOwnerId: session.ownerId }), /unmanifested integration/u);
		assert.equal(git(repository, 'rev-parse', `refs/heads/bugfixer/integration/${orphanOwner}`), base);
		const preview = await service.previewMerge({ integrationOwnerId: ownerId, sessionOwnerId: session.ownerId });
		const merged = await mergeReviewed(service, preview);
		assert.equal(merged.state, 'merged');
		const updated = await service.inspect(ownerId);
		assert.ok(updated.generationId);
		assert.equal(updated.generations?.length, 2);
		assert.notEqual(updated.worktreePath, integration.worktreePath);
		assert.equal(git(integration.worktreePath, 'rev-parse', 'HEAD'), base);
		assert.equal(updated.head, git(repository, 'rev-parse', `refs/heads/${updated.branch}`));
	});
});

test('reviewed merge integrates the reviewed session commit in the integration worktree', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'feature.txt', 'feature\n', 'feature');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		const result = await mergeReviewed(service, preview);
		assert.equal(result.state, 'merged');
		const current = await service.inspect(integration.ownerId);
		assert.notEqual(current.worktreePath, integration.worktreePath);
		assert.equal(readFileSync(join(current.worktreePath, 'feature.txt'), 'utf8'), 'feature\n');
		assert.equal(git(integration.worktreePath, 'rev-parse', 'HEAD'), base);
		assert.equal(git(integration.worktreePath, 'branch', '--show-current'), '');
		assert.equal(git(repository, 'branch', '--show-current'), 'user-work');
	});
});

for (const objectFormat of ['sha1', 'sha256'] as const) {
	test(`isolated ${objectFormat} generation ignores ambient index/worktree/object redirection and publishes exact divergent heads`, async () => {
		await fixture(async (root, repository, service) => {
			const source = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
			const originalHead = git(repository, 'rev-parse', 'HEAD');
			const originalIndex = readFileSync(join(repository, '.git', 'index'));
			commit(source.worktreePath, 'source.txt', 'reviewed source\n', 'source');
			const decoy = join(root, 'decoy'); mkdirSync(decoy);
			const decoyIndex = join(decoy, 'index'); writeFileSync(decoyIndex, 'do not read or replace');
			await withEnv({ GIT_INDEX_FILE: decoyIndex, GIT_WORK_TREE: decoy, GIT_OBJECT_DIRECTORY: decoy }, async () => {
				const integration = await service.ensureIntegrationTarget({ ownerId: randomUUID(), sessionOwnerId: source.ownerId });
				const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: source.ownerId });
				assert.notEqual(preview.targetHead, preview.sourceHead);
				assert.equal(preview.targetHead.length, objectFormat === 'sha256' ? 64 : 40);
				const result = await mergeReviewed(service, preview);
				assert.equal(result.state, 'merged');
				if (result.state !== 'merged') { throw new Error('Expected isolated merge publication.'); }
				assert.equal(readFileSync(join(result.integration.worktreePath, 'source.txt'), 'utf8'), 'reviewed source\n');
			});
			assert.equal(readFileSync(decoyIndex, 'utf8'), 'do not read or replace');
			assert.equal(git(repository, 'rev-parse', 'HEAD'), originalHead);
			assert.deepEqual(readFileSync(join(repository, '.git', 'index')), originalIndex);
		}, { objectFormat });
	});
}

test('auto-merging messages preserve clean stage zero entries beside a real conflict', async () => {
	await fixture(async (_root, repository, service) => {
		commit(repository, 'auto.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'base lines');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: 'HEAD' });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		commit(integration.worktreePath, 'auto.txt', 'TARGET\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'target clean part');
		commit(session.worktreePath, 'auto.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nSOURCE\n', 'source clean part');
		const cleanPreview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		const clean = await mergeReviewed(service, cleanPreview);
		assert.equal(clean.state, 'merged');
		if (clean.state !== 'merged') { throw new Error('Informational auto-merging output must remain clean.'); }
		assert.equal(readFileSync(join(clean.integration.worktreePath, 'auto.txt'), 'utf8'), 'TARGET\ntwo\nthree\nfour\nfive\nsix\nSOURCE\n');
		// A second pair retains a clean automerge and an unrelated staged conflict together.
		const secondTarget = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: 'HEAD' });
		const secondSource = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		commit(secondTarget.worktreePath, 'auto.txt', 'TARGET\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'target clean part');
		commit(secondSource.worktreePath, 'auto.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nSOURCE\n', 'source clean part');
		commit(secondTarget.worktreePath, 'README.md', 'target conflict\n', 'target conflict');
		commit(secondSource.worktreePath, 'README.md', 'source conflict\n', 'source conflict');
		const conflict = await mergeReviewed(service, await service.previewMerge({ integrationOwnerId: secondTarget.ownerId, sessionOwnerId: secondSource.ownerId }));
		assert.equal(conflict.state, 'conflict');
		if (conflict.state !== 'conflict') { throw new Error('Expected real conflict.'); }
		assert.deepEqual(conflict.conflictedPaths, ['README.md']);
		assert.match(git(conflict.integration.worktreePath, 'ls-files', '--stage', '--', 'auto.txt'), / 0\tauto\.txt$/u);
		assert.equal(git(conflict.integration.worktreePath, 'ls-files', '--unmerged', '--', 'auto.txt'), '');
	});
});

test('invalid UTF-8 repository paths are rejected before generation materialization', async () => {
	await fixture(async (root, repository, service) => {
		const invalidPath = Buffer.concat([Buffer.from(`${repository}/`), Buffer.from([0xff]), Buffer.from('.txt')]);
		writeFileSync(invalidPath, 'invalid byte path\n');
		git(repository, 'add', '--all'); git(repository, 'commit', '-qm', 'invalid byte path');
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const ownerId = randomUUID();
		await assert.rejects(service.ensureIntegrationTarget({ ownerId, sessionOwnerId: session.ownerId }), /invalid UTF-8/u);
		assert.equal(existsSync(join(root, 'profile', 'managed-worktrees', `${ownerId}.json`)), false);
		assert.equal(git(repository, 'branch', '--list', `bugfixer/integration/${ownerId}`), '');
	});
});

test('merge preview shows the complete committed source delta and preserves unrelated dirty source files', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'z-last.txt', 'committed source\n', 'source commit');
		writeFileSync(join(session.worktreePath, 'unselected.txt'), 'keep as dirty source state\n');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		assert.equal(preview.mergeBase, base);
		assert.deepEqual(preview.changedPaths, ['z-last.txt']);
		assert.match(preview.diffText, /committed source/u);
		assert.equal(createHash('sha256').update(preview.diffText, 'utf8').digest('hex'), preview.diffHash);
		assert.equal((await mergeReviewed(service, preview)).state, 'merged');
		const current = await service.inspect(integration.ownerId);
		assert.equal(readFileSync(join(current.worktreePath, 'z-last.txt'), 'utf8'), 'committed source\n');
		assert.equal(readFileSync(join(session.worktreePath, 'unselected.txt'), 'utf8'), 'keep as dirty source state\n');
		assert.match(git(session.worktreePath, 'status', '--porcelain'), /unselected\.txt/u);
	});
});

test('missing or mismatched durable merge readback prevents the Git merge', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'journal-required.txt', 'must not merge\n', 'source commit');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		const before = git(integration.worktreePath, 'rev-parse', 'HEAD');
		await assert.rejects(mergeReviewed(service, preview, { readback: () => undefined }), /did not read back/u);
		assert.equal(git(integration.worktreePath, 'rev-parse', 'HEAD'), before);
		assert.equal((await service.inspect(integration.ownerId)).pendingOperation, undefined);

		const second = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		await assert.rejects(mergeReviewed(service, second, { readback: record => ({ ...record, targetHead: '0'.repeat(40) }) }), /did not read back/u);
		assert.equal(git(integration.worktreePath, 'rev-parse', 'HEAD'), before);
	});
});

test('source or target changes while durable applying is recorded never execute the stale merge', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'reviewed.txt', 'reviewed source\n', 'source commit');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		const sourceHead = preview.sourceHead;
		await assert.rejects(mergeReviewed(service, preview, {
			beforeReadback: async () => { commit(session.worktreePath, 'later.txt', 'later source\n', 'later commit'); },
		}), /stale|changed/u);
		assert.equal(git(integration.worktreePath, 'rev-parse', 'HEAD'), preview.targetHead);
		assert.equal(git(session.worktreePath, 'rev-parse', 'HEAD') === sourceHead, false);
		assert.equal(existsSync(join(integration.worktreePath, 'reviewed.txt')), false);
		assert.equal((await service.inspect(integration.ownerId)).pendingOperation, undefined);
	});
});

test('merge uses the repository user identity from global Git config', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'global-identity.txt', 'ok\n', 'global identity');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		assert.equal((await mergeReviewed(service, preview)).state, 'merged');
		const current = await service.inspect(integration.ownerId);
		assert.match(git(current.worktreePath, 'show', '-s', '--format=%an <%ae>', 'HEAD'), /^Fixture Global <global@example\.invalid>$/);
	}, { globalIdentity: true });
});

test('missing effective Git identity blocks merge review without changing the integration lease', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'identity-failure.txt', 'preserved\n', 'source commit');
		git(repository, 'config', '--unset', 'user.name');
		git(repository, 'config', '--unset', 'user.email');
		await assert.rejects(service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId }), /identity/i);
		const inspected = await service.inspect(integration.ownerId);
		assert.equal(inspected.worktreePath, integration.worktreePath);
		assert.equal(inspected.state, 'active');
		assert.equal(inspected.pendingOperation, undefined);
		assert.equal(inspected.lastOperation, undefined);
		assert.equal(existsSync(join(integration.worktreePath, 'identity-failure.txt')), false);
		assert.equal(git(integration.worktreePath, 'status', '--porcelain'), '');
		const reopened = new ManagedWorktreeService(join(_root, 'profile'));
		assert.equal((await reopened.inspect(integration.ownerId)).lastOperation, undefined);
	});
});

test('reviewed commit captures effective identity environment and keeps candidate headers frozen', async () => {
	await fixture(async (_root, repository, service) => {
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: 'HEAD' });
		const sourceHead = git(session.worktreePath, 'rev-parse', 'HEAD');
		const bytes = Buffer.from('identity-bound content\n');
		const author = { name: 'Captured Author', email: 'captured-author@example.invalid', date: '946684800 +0000' };
		const committer = { name: 'Captured Committer', email: 'captured-committer@example.invalid', date: '978307200 -0700' };
		const preview = await withEnv({
			GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date,
			GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: committer.date
		}, () => service.prepareReviewedCommit({
			ownerId: session.ownerId, sourceHead, commitMessage: 'Identity environment review',
			files: [{ path: 'identity.txt', before: { absent: true }, after: { mode: '100644', sha256: createHash('sha256').update(bytes).digest('hex'), bytes } }]
		}));
		assert.deepEqual(preview.author, author);
		assert.deepEqual(preview.committer, committer);

		const candidate = await withEnv({
			GIT_AUTHOR_NAME: 'Changed Author', GIT_AUTHOR_EMAIL: 'changed-author@example.invalid', GIT_AUTHOR_DATE: '1000000000 +0000',
			GIT_COMMITTER_NAME: 'Changed Committer', GIT_COMMITTER_EMAIL: 'changed-committer@example.invalid', GIT_COMMITTER_DATE: '1000000060 +0000'
		}, () => service.createReviewedCommitCandidate(preview.previewId));
		const commitObject = execFileSync('git', ['-C', repository, 'cat-file', 'commit', candidate.candidateCommitOid]);
		const headerSeparator = commitObject.indexOf(Buffer.from('\n\n'));
		assert.ok(headerSeparator >= 0);
		assert.deepEqual(commitObject.subarray(0, headerSeparator).toString('utf8').split('\n'), [
			`tree ${preview.proposedTreeOid}`,
			`parent ${preview.sourceHead}`,
			`author ${author.name} <${author.email}> ${author.date}`,
			`committer ${committer.name} <${committer.email}> ${committer.date}`
		]);
	});
});

test('configured signing helpers are rejected without execution or mutation', async () => {
	await fixture(async (root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'signing-failure.txt', 'preserved in prepared merge\n', 'source commit');
		const gpgMarker = join(root, 'gpg-called');
		const failingGpg = join(root, 'failing-gpg');
		writeFileSync(failingGpg, `#!/bin/sh\nprintf 'fixture signing failure\\n' >&2\nprintf called > '${gpgMarker}'\nexit 1\n`);
		chmodSync(failingGpg, 0o700);
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		git(repository, 'config', 'commit.gpgsign', 'true');
		git(repository, 'config', 'gpg.program', failingGpg);
		await assert.rejects(mergeReviewed(service, preview), /unsupported|signing|configuration/i);
		assert.equal(existsSync(gpgMarker), false);
		assert.equal(existsSync(join(integration.worktreePath, 'signing-failure.txt')), false);
		const inspected = await service.inspect(integration.ownerId);
		assert.equal(inspected.state, 'active');
		assert.equal(inspected.pendingOperation, undefined);
		const reopened = new ManagedWorktreeService(join(root, 'profile'));
		assert.equal((await reopened.inspect(integration.ownerId)).pendingOperation, undefined);
	});
});

test('configured merge drivers are rejected before an actual content conflict can invoke them', async () => {
	await fixture(async (root, repository, service) => {
		writeFileSync(join(repository, '.gitattributes'), 'README.md merge=fixture\n');
		git(repository, 'add', '.gitattributes');
		git(repository, 'commit', '-qm', 'pin merge driver attribute');
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(integration.worktreePath, 'README.md', 'target side\n', 'target conflict');
		commit(session.worktreePath, 'README.md', 'source side\n', 'source conflict');
		const marker = join(root, 'merge-driver-ran');
		const driver = join(root, 'merge-driver');
		writeFileSync(driver, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`);
		chmodSync(driver, 0o700);
		git(repository, 'config', 'merge.fixture.driver', driver);
		await assert.rejects(service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId }), /unsupported/u);
		assert.equal(existsSync(marker), false);
		assert.equal(readFileSync(join(integration.worktreePath, 'README.md'), 'utf8'), 'target side\n');
		assert.equal(readFileSync(join(session.worktreePath, 'README.md'), 'utf8'), 'source side\n');
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
		await assert.rejects(mergeReviewed(service, sourcePreview), /stale|changed/i);
		const targetPreview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		commit(integration.worktreePath, 'target.txt', 'advance\n', 'target advance');
		await assert.rejects(mergeReviewed(service, targetPreview), /stale|changed/i);
	});
});

test('an integration ref race at conditional publication remains journaled without a retry', async () => {
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
		const wrapper = join(shimDirectory, 'git');
		writeFileSync(wrapper, `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = update-ref ] && [ ! -f '${marker}' ]; then\n    '${realGit}' -C '${repository}' update-ref 'refs/heads/${integration.branch}' '${preview.sourceHead}'\n    touch '${marker}'\n    break\n  fi\ndone\nexec '${realGit}' "$@"\n`);
		chmodSync(wrapper, 0o700);
		await withEnv({ PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? ''}` }, async () => {
			const result = await mergeReviewed(service, preview);
			assert.equal(result.state, 'recoveryRequired');
			const inspected = await service.inspect(integration.ownerId);
			assert.equal(inspected.state, 'recoveryRequired');
			assert.equal(inspected.pendingOperation?.kind, 'merge');
			assert.equal(git(repository, 'rev-parse', `refs/heads/${integration.branch}`), preview.sourceHead);
			assert.equal(existsSync(marker), true);
			assert.equal(git(repository, 'branch', '--show-current'), 'user-work');
		});
	});
});

test('explicit recovery finishes a verified candidate published before its final artifact', async () => {
	await fixture(async (_root, repository, service) => {
		const base = git(repository, 'rev-parse', 'HEAD');
		const integration = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'integration', baseRef: base });
		const session = await service.create({ repositoryPath: repository, ownerId: randomUUID(), kind: 'session', baseRef: base });
		commit(session.worktreePath, 'recovery-candidate.txt', 'retained candidate\n', 'recovery candidate');
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		let journal: TestMergeJournal | undefined;
		let artifactStoreAvailable = false;
		const result = await mergeReviewed(service, preview, {
			captureJournal: value => { journal = value; },
			beforeArtifact: event => { if (event.phase === 'published' && !artifactStoreAvailable) { throw new Error('simulated durable artifact outage'); } }
		});
		assert.equal(result.state, 'recoveryRequired');
		assert.ok(journal);
		assert.notEqual(git(repository, 'rev-parse', `refs/heads/${integration.branch}`), preview.targetHead);
		artifactStoreAvailable = true;
		const recovered = await service.reconcileReviewedMerge({
			integrationOwnerId: integration.ownerId, operationId: journal.operationId,
			readApplying: journal.readApplying, recordArtifact: journal.recordArtifact, readArtifacts: journal.readArtifacts
		});
		assert.equal(recovered.state, 'merged');
		if (recovered.state !== 'merged') { throw new Error('Expected exact journal recovery to finalize the verified merge.'); }
		assert.equal(git(repository, 'rev-parse', `refs/heads/${integration.branch}`), recovered.commit);
		assert.equal(readFileSync(join(recovered.integration.worktreePath, 'recovery-candidate.txt'), 'utf8'), 'retained candidate\n');
		assert.equal(git(repository, 'branch', '--show-current'), 'user-work');
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
		const result = await mergeReviewed(service, preview);
		assert.equal(result.state, 'conflict');
		assert.deepEqual(result.conflictedPaths, ['README.md']);
		const conflicted = await service.inspect(integration.ownerId);
		assert.notEqual(conflicted.worktreePath, integration.worktreePath);
		assert.match(git(conflicted.worktreePath, 'status', '--porcelain'), /README\.md/u);
		assert.equal(git(repository, 'rev-parse', `refs/heads/${integration.branch}`), preview.targetHead);
		assert.equal(git(integration.worktreePath, 'rev-parse', 'HEAD'), preview.targetHead);
		assert.equal(conflicted.lastOperation?.sourceOwnerId, session.ownerId);
		assert.equal(conflicted.lastOperation?.sourceHead, preview.sourceHead);
		assert.equal(conflicted.lastOperation?.targetHead, preview.targetHead);
		assert.equal(conflicted.lastOperation?.mergeBase, preview.mergeBase);
		assert.equal(conflicted.lastOperation?.diffFingerprint, preview.diffHash);
		assert.deepEqual(conflicted.lastOperation?.conflictedPaths, ['README.md']);
		await assert.rejects(service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId }), /conflict|recovery/i);
	});
});

test('inspection never reconciles a pending merge without its exact approval journal', async () => {
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
		const first = await service.inspect(integration.ownerId);
		assert.equal(first.state, 'recoveryRequired');
		assert.deepEqual(first.pendingOperation, pending);
		assert.equal(first.lastOperation, undefined);
		assert.equal(git(integration.worktreePath, 'rev-parse', 'HEAD'), git(integration.worktreePath, 'rev-parse', `refs/heads/${integration.branch}`));
		const reopened = new ManagedWorktreeService(join(root, 'profile'));
		const second = await reopened.inspect(integration.ownerId);
		assert.equal(second.state, 'recoveryRequired');
		assert.deepEqual(second.pendingOperation, pending);
		assert.equal(second.lastOperation, undefined);
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
		assert.equal((await mergeReviewed(service, preview)).state, 'merged');
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
		writeFileSync(lockPath, JSON.stringify({ ...staleUnsigned, signature: internals.sign(staleUnsigned) }), { mode: 0o600 });
		assert.equal(await internals.withIntegrationLock(integration.ownerId, 'merge', () => 'recovered stale lock'), 'recovered stale lock');
		assert.equal(existsSync(lockPath), false);
		writeFileSync(lockPath, '{ forged lock', { mode: 0o600 });
		await assert.rejects(internals.withIntegrationLock(integration.ownerId, 'merge', () => undefined), /invalid|ambiguous|recovery/i);
		rmSync(lockPath);
		const preview = await service.previewMerge({ integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId });
		assert.equal((await mergeReviewed(service, preview)).state, 'merged');
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
		const merged = await mergeReviewed(service, preview);
		assert.equal(merged.state, 'merged');
		await service.remove(session.ownerId, { retainedIntegrationOwnerId: integration.ownerId });
		const current = await service.inspect(integration.ownerId);
		assert.equal(git(current.worktreePath, 'merge-base', '--is-ancestor', sessionHead, 'HEAD'), '');
		assert.equal(git(current.worktreePath, 'show', 'HEAD:merged.txt'), 'retained');
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
		assert.equal(existsSync(filterMarker), false, 'Fixture setup must not invoke the candidate clean filter');
		git(repository, 'config', 'filter.fixture.clean', filterCommand);
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
