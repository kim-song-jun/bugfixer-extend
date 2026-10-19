/* CI-only: actual Git, signed manager generations, and central SQLite. No provider/account proof. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { AgentSessionMergeApplyingBinding, AgentSessionMergeProposalDTO } from '../../common/workspaceAgentMergeProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { AgentSessionPublicationAuthority } from './agentSessionPublicationAuthority.js';
import { createMergedPublicationFixture } from './agentSessionPublicationFixture.testHelpers.js';
import { ManagedWorktreeService } from './managedWorktrees.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('publication authority exports actual signed merge closure, holds cross-process lease, rejects changed authority', async () => {
	// The existing helper supplies real session/evidence tables. The source under
	// test below is a subsequent real Git merge, journaled by the actual manager.
	const seed = createMergedPublicationFixture();
	const database = WorkspaceDatabase.open(seed.sourcePath);
	const root = realpathSync(dirname(seed.sourcePath));
	const repository = database.listFolderBindings(seed.input.projectId)[0].vcsRoot!;
	const profile = join(root, 'profile'); mkdirSync(profile, { mode: 0o700 });
	const gitPath = realpathSync('/usr/bin/git');
	const executable = { path: gitPath, sha256: digest(readFileSync(gitPath)) };
	const globalConfig = join(root, 'empty-global'); writeFileSync(globalConfig, '');
	const originalEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
	process.env.GIT_CONFIG_GLOBAL = globalConfig; process.env.GIT_CONFIG_NOSYSTEM = '1';
	const environment = { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
	const gitBytes = (cwd: string, args: readonly string[], input?: Buffer) => execFileSync(gitPath, ['-C', cwd, ...args], { env: environment, input, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
	const git = (cwd: string, ...args: string[]) => gitBytes(cwd, args).toString('utf8').trim();
	let active: { release(): Promise<void> } | undefined;
	try {
		git(repository, 'init', '-q', '-b', 'main'); git(repository, 'config', 'user.name', 'CI'); git(repository, 'config', 'user.email', 'ci@example.invalid');
		mkdirSync(join(repository, 'src')); writeFileSync(join(repository, 'src/change.ts'), 'before\n');
		git(repository, 'add', 'src/change.ts'); git(repository, 'commit', '-qm', 'base');
		git(repository, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git');
		const base = git(repository, 'rev-parse', 'HEAD');
		const worktrees = new ManagedWorktreeService(profile);
		const session = await worktrees.create({ repositoryPath: repository, ownerId: seed.input.sessionId, kind: 'session', baseRef: 'HEAD' });
		writeFileSync(join(session.worktreePath, 'src/change.ts'), 'after\n');
		git(session.worktreePath, 'add', 'src/change.ts'); git(session.worktreePath, 'commit', '-qm', 'reviewed source');
		const sourceHead = git(session.worktreePath, 'rev-parse', 'HEAD');
		const oldMerge = database.agentSessionMerges.getProposal(seed.sourceMergeId)!;
		const oldCommit = database.agentSessionIntegrations.getProposal(oldMerge.commitProposalId)!;
		const scope = { projectId: oldMerge.projectId, sessionId: oldMerge.sessionId, turnId: oldMerge.turnId };
		const commit = database.agentSessionIntegrations.createProposal({ ...scope, evidenceVersion: oldCommit.evidenceVersion, evidenceFingerprint: oldCommit.evidenceFingerprint,
			sourceHead: base, proposedGitTreeHash: git(session.worktreePath, 'rev-parse', 'HEAD^{tree}'), diffFingerprint: digest(gitBytes(session.worktreePath, ['diff', '--binary', base, sourceHead])),
			commitMessage: 'reviewed source', author: oldCommit.author, committer: oldCommit.committer,
			paths: oldCommit.paths.map(path => ({ path: path.path, explanationTargets: path.explanations.map(item => ({ path: item.path, hunkId: item.hunkId, revision: item.revision })) })), expectedLatestRevision: oldCommit.revision });
		database.agentSessionIntegrations.recordTrustedHumanApproval(commit.id, commit.revision);
		const commitReceipt = { operationId: randomUUID(), sourceHead: base, proposedGitTreeHash: commit.proposedGitTreeHash, diffFingerprint: commit.diffFingerprint,
			candidateHead: sourceHead, resultingHead: null, changedPaths: [], failureCode: null };
		database.agentSessionIntegrations.recordOutcome({ proposalId: commit.id, expectedOutcomeRevision: 0, state: 'applying', action: 'commit', receipt: commitReceipt });
		database.agentSessionIntegrations.recordOutcome({ proposalId: commit.id, expectedOutcomeRevision: 1, state: 'succeeded', action: 'commit', receipt: { ...commitReceipt, resultingHead: sourceHead, changedPaths: ['src/change.ts'] } });
		await worktrees.ensureIntegrationTarget({ ownerId: oldMerge.integrationOwnerId, sessionOwnerId: session.ownerId });
		const preview = await worktrees.previewMerge({ integrationOwnerId: oldMerge.integrationOwnerId, sessionOwnerId: session.ownerId });
		const proposal = database.agentSessionMerges.createProposal({ ...scope, commitProposalId: commit.id, commitProposalRevision: commit.revision, commitProposalFingerprint: commit.fingerprint,
			integrationOwnerId: preview.integrationOwnerId, sourceHead: preview.sourceHead, targetHead: preview.targetHead, mergeBase: preview.mergeBase,
			diffFingerprint: preview.diffHash, diffText: preview.diffText, commitMessage: preview.commitMessage, author: preview.author, committer: preview.committer,
			changedPaths: preview.changedPaths, expectedLatestRevision: oldMerge.revision });
		database.agentSessionMerges.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint);
		const operationId = randomUUID();
		const merged = await worktrees.mergeReviewed({ previewId: preview.previewId, operationId, proposalId: proposal.id, proposalFingerprint: proposal.fingerprint,
			commitMessage: proposal.commitMessage, author: proposal.author, committer: proposal.committer,
			recordApplying: async record => { database.agentSessionMerges.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 0, state: 'applying', receipt: { ...record, resultingHead: null, changedPaths: [], conflictedPaths: [], failureCode: null } }); },
			readApplying: async id => {
				const receipt = database.agentSessionMerges.getProposal(proposal.id)!.outcomes.at(-1)!.receipt;
				if (receipt.operationId !== id) { return undefined; }
				return applyingBinding(receipt);
			},
			recordArtifact: async (id, revision, event) => database.agentSessionMerges.recordArtifact(id, revision, event),
			readArtifacts: async id => { assert.equal(id, operationId); return database.agentSessionMerges.getProposal(proposal.id)!.artifacts; },
		});
		assert.equal(merged.state, 'merged'); if (merged.state !== 'merged') { throw new Error('Fixture merge did not finish.'); }
		const applying = database.agentSessionMerges.getProposal(proposal.id)!.outcomes.at(-1)!;
		database.agentSessionMerges.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: applying.revision, state: 'merged', retryOfOutcomeId: applying.id,
			receipt: { ...applying.receipt, resultingHead: merged.commit, changedPaths: preview.changedPaths } });
		const sourceMerge = database.agentSessionMerges.getProposal(proposal.id)!;
		const lockPath = join(profile, 'managed-worktrees', `${proposal.integrationOwnerId}.operation-lock.json`);
		let windowCurrent = true;
		let changeWindowDuringAccount = false;
		const authority = new AgentSessionPublicationAuthority(database, worktrees, { git: executable,
			assertScopeCurrent: actual => { assert.ok(windowCurrent, 'Native window changed'); assert.equal(actual.projectId, scope.projectId); assert.equal(actual.sessionId, scope.sessionId); assert.equal(actual.turnId, scope.turnId); },
			resolveSelectedAccount: async accountRef => { await Promise.resolve(); if (changeWindowDuringAccount) { windowCurrent = false; } return { accountRef, login: 'reviewer', configDirectory: root }; },
		});
		// Deliberately dirty original checkout: publication must preserve it byte-for-byte.
		writeFileSync(join(repository, 'src/change.ts'), 'user staged\n'); git(repository, 'add', 'src/change.ts');
		writeFileSync(join(repository, 'src/change.ts'), 'user unstaged\n'); writeFileSync(join(repository, 'untracked.txt'), 'keep\n');
		const trap = join(root, 'unexpected-helper-execution');
		const fsmonitor = join(root, 'untrusted-fsmonitor');
		writeFileSync(fsmonitor, `#!/bin/sh\nprintf unexpected > '${trap}'\nexit 1\n`, { mode: 0o700 });
		git(repository, 'config', 'core.fsmonitor', fsmonitor);
		git(repository, 'config', 'credential.helper', `!${fsmonitor}`);
		const before = snapshot(repository, git);
		const exported = await authority.exportSource(proposal.id, 'origin');
		assert.equal(exported.source.resultCommit, merged.commit); assert.equal(exported.remote.canonicalUrl, 'https://github.com/acme/widget.git');
		assert.equal(existsSync(lockPath), false, 'Preparation released its short signed lease');
		const imported = join(root, 'imported.git'); mkdirSync(imported); git(imported, 'init', '--bare', '-q');
		gitBytes(imported, ['index-pack', '--stdin'], exported.pack); exported.pack.fill(0);
		assert.equal(git(imported, 'rev-list', '--objects', merged.commit), git(repository, 'rev-list', '--objects', merged.commit), 'Export includes the complete pinned closure');
		const diffText = gitBytes(repository, ['diff', '--binary', '--full-index', base, merged.commit]).toString('utf8');
		const publication = database.agentSessionPublications.createProposal({ ...seed.input, sourceMergeId: proposal.id, sourceMerge: exported.source,
			base: { ref: 'refs/heads/main', oid: base }, diff: { ...seed.input.diff, baseCommit: base, headCommit: merged.commit, text: diffText, fingerprint: digest(diffText) } });
		database.agentSessionPublications.recordTrustedHumanApproval(publication.id, publication.revision, publication.fingerprint);
		active = await authority.acquireOperation(publication.id);
		await authority.assertCurrentApproval(publication);
		const exportedWhileHeld = await authority.exportSource(proposal.id, 'origin'); exportedWhileHeld.pack.fill(0);
		assert.equal(existsSync(lockPath), true, 'Export reuses the already-held owner lease');
		const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
import { ManagedWorktreeService } from ${JSON.stringify(new URL('./managedWorktrees.js', import.meta.url).href)};
const [profile, owner, path, sha256] = process.argv.slice(1);
try { const lease = await new ManagedWorktreeService(profile).acquirePublicationLease(owner, {path, sha256}); await lease.release(); process.exitCode = 2; }
catch (error) { if (!String(error).includes('live process')) throw error; process.stdout.write('blocked'); }
`, profile, proposal.integrationOwnerId, executable.path, executable.sha256], { env: { ...environment, TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH }, timeout: 10_000, maxBuffer: 1024 * 1024 });
		assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr.toString()); assert.equal(child.stdout.toString(), 'blocked');
		await active.release(); active = undefined;
		assert.deepEqual(snapshot(repository, git), before, 'Source refs, index, files, and HEAD remain unchanged');
		assert.equal(existsSync(trap), false, 'Repository fsmonitor and credential helper programs never ran');

		// Reject supported-looking remotes that actually escape the reviewed destination.
		for (const url of ['https://reviewer:secret@github.com/acme/widget.git', 'https://github.com.evil.test/acme/widget.git', 'ext::anything', 'ssh://git@github.com:22/acme/widget.git']) {
			git(repository, 'config', 'remote.origin.url', url);
			await assert.rejects(authority.exportSource(proposal.id, 'origin'), /remote is unsupported/u);
			assert.equal(existsSync(lockPath), false, 'Failed prepare released its exact lock');
		}
		git(repository, 'config', 'remote.origin.url', 'https://github.com/acme/widget.git');
		git(repository, 'config', '--add', 'remote.origin.pushurl', 'https://github.com/acme/other.git');
		await assert.rejects(authority.exportSource(proposal.id, 'origin'), /one exact canonical/u);
		git(repository, 'config', '--unset-all', 'remote.origin.pushurl');
		git(repository, 'config', 'url.https://evil.test/.insteadOf', 'https://github.com/');
		await assert.rejects(authority.exportSource(proposal.id, 'origin'), /rewritten/u);
		git(repository, 'config', '--remove-section', 'url.https://evil.test/');
		git(repository, 'config', 'remote.origin.url', 'ssh://git@github.com/acme/widget.git');
		const ssh = await authority.exportSource(proposal.id, 'origin'); ssh.pack.fill(0); assert.equal(ssh.remote.canonicalUrl, exported.remote.canonicalUrl);
		const lease = await worktrees.acquirePublicationLease(proposal.integrationOwnerId, executable);
		try {
			const forged: AgentSessionMergeProposalDTO = { ...sourceMerge, artifacts: sourceMerge.artifacts.map(record => record.event.phase === 'generationRegistered' ? { ...record, event: { ...record.event, registrationId: randomUUID() } } : record) };
			await assert.rejects(lease.assertPinned({ repositoryPath: repository, remoteName: 'origin', merge: forged }), /signed generation/u);
		} finally { await lease.release(); }
		changeWindowDuringAccount = true;
		await assert.rejects(authority.resolveSelectedAccount(seed.input.accountRef), /Native window changed/u);
		windowCurrent = true; changeWindowDuringAccount = false;
		const newer = database.agentSessionPublications.createProposal({ ...seed.input, sourceMergeId: proposal.id, sourceMerge: exported.source, title: 'New review', expectedRevision: publication.revision,
			base: { ref: 'refs/heads/main', oid: base }, diff: { ...seed.input.diff, baseCommit: base, headCommit: merged.commit, text: diffText, fingerprint: digest(diffText) } });
		assert.ok(newer.revision > publication.revision);
		await assert.rejects(authority.assertCurrentApproval(publication), /latest/u);
		// Changed logical ref invalidates every new source export. Historical recovery
		// can still hold the old proposal's owner lock without approval or ref mutation.
		git(repository, 'update-ref', `refs/heads/bugfixer/integration/${proposal.integrationOwnerId}`, base, merged.commit);
		await assert.rejects(authority.exportSource(proposal.id, 'origin'), /branch ref|logical branch/u);
		active = await authority.acquireOperation(publication.id);
		assert.equal(git(repository, 'rev-parse', `refs/heads/bugfixer/integration/${proposal.integrationOwnerId}`), base);
		await active.release(); active = undefined;
		assert.equal(existsSync(lockPath), false);
		assert.deepEqual(readdirSync(join(profile, 'managed-worktrees')).filter(name => name.startsWith('.publication-read-') || name.startsWith('.merge-context-')), []);
	} finally {
		try { await active?.release(); }
		finally {
			try { database.close(); }
			finally {
				try { seed.dispose(); }
				finally {
					if (originalEnv.global === undefined) { delete process.env.GIT_CONFIG_GLOBAL; } else { process.env.GIT_CONFIG_GLOBAL = originalEnv.global; }
					if (originalEnv.system === undefined) { delete process.env.GIT_CONFIG_NOSYSTEM; } else { process.env.GIT_CONFIG_NOSYSTEM = originalEnv.system; }
				}
			}
		}
	}
});

function applyingBinding(receipt: AgentSessionMergeApplyingBinding): AgentSessionMergeApplyingBinding {
	return { operationId: receipt.operationId, proposalId: receipt.proposalId, proposalFingerprint: receipt.proposalFingerprint, integrationOwnerId: receipt.integrationOwnerId,
		sessionOwnerId: receipt.sessionOwnerId, sourceHead: receipt.sourceHead, targetHead: receipt.targetHead, mergeBase: receipt.mergeBase, diffFingerprint: receipt.diffFingerprint,
		commitMessage: receipt.commitMessage, author: receipt.author, committer: receipt.committer };
}

function snapshot(repository: string, git: (cwd: string, ...args: string[]) => string) {
	return { refs: git(repository, 'show-ref'), head: readFileSync(join(repository, '.git/HEAD')), index: readFileSync(join(repository, '.git/index')),
		config: readFileSync(join(repository, '.git/config')), tracked: readFileSync(join(repository, 'src/change.ts')), untracked: readFileSync(join(repository, 'untracked.txt')) };
}
