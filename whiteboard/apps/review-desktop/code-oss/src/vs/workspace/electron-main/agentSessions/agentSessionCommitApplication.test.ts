/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import type { AgentSessionContentSnapshot } from './agentSessionContentCapture.js';
import type { ReviewedCommitApplyInput, ReviewedCommitApplyResult, ReviewedCommitIdentity, ReviewedCommitInput } from './managedWorktrees.js';
import { AgentSessionCommitApplication } from './agentSessionCommitApplication.js';
import { AgentSessionService, type AgentSessionRuntimeFactory } from './agentSessionService.js';
import { AgentSessionWorkspaceResolver } from './agentSessionWorkspace.js';
import { ManagedWorktreeService } from './managedWorktrees.js';
import { TaskFolderWriterLock } from '../providerRuns/taskFolderWriterLock.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function noProviderRuntime(): AgentSessionRuntimeFactory {
	const unexpected = (): never => { throw new Error('This fixture never launches a provider.'); };
	return { start: unexpected, watchExit: unexpected, getSnapshot: unexpected, write: unexpected, resize: unexpected, attach: unexpected, stop: unexpected, release: async () => undefined };
}

function snapshot(folderIdentity: AgentSessionTurnSnapshot['folderIdentity'], contents: string, capturedAt: string, schemaVersion: 1 | 2 = 2): AgentSessionContentSnapshot {
	const bytes = Buffer.from(contents, 'utf8');
	return {
		schemaVersion, folderIdentity, capturedAt, inventoryCoverage: 'complete', contentCoverage: 'complete',
		entryCount: 1, fileBytes: bytes.byteLength, retainedTextBytes: bytes.byteLength, contentReadCount: 1,
		entries: [{ path: 'src/change.ts', kind: 'file', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), content: contents, ...(schemaVersion === 2 ? { executable: false } : {}) }],
	};
}

async function createFixture(options: { readonly interruptAfterApply?: boolean; readonly legacyBefore?: boolean; readonly frozenIdentity?: { readonly author: ReviewedCommitIdentity; readonly committer: ReviewedCommitIdentity } } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'agent-session-commit-application-'));
	const repository = join(root, 'repository');
	const profile = join(root, 'profile');
	mkdirSync(repository);
	mkdirSync(profile);
	git(repository, 'init', '-q', '-b', 'user-work');
	git(repository, 'config', 'user.name', 'Commit Application Fixture');
	git(repository, 'config', 'user.email', 'commit-application@example.invalid');
	mkdirSync(join(repository, 'src'));
	writeFileSync(join(repository, 'src/change.ts'), 'before\n');
	git(repository, 'add', 'src/change.ts');
	git(repository, 'commit', '-qm', 'source');
	const originalHead = git(repository, 'rev-parse', 'HEAD');
	const originalIndex = readFileSync(join(repository, '.git', 'index'));
	const databasePath = join(root, 'workspace.db');
	let database = WorkspaceDatabase.open(databasePath);
	const project = database.createProject('Commit application fixture');
	const binding = database.createFolderBinding({ projectId: project.id, path: repository, vcsKind: 'git', vcsRoot: repository });
	const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Session worktree', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'gitWorktree' });
	const rawWorktrees = new ManagedWorktreeService(profile);
	const managedLease = await rawWorktrees.create({ repositoryPath: repository, ownerId: session.id, kind: 'session', baseRef: 'HEAD' });
	const worktreePath = managedLease.worktreePath;
	const managedIndexPath = git(worktreePath, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
	const managedIndexBeforeApply = readFileSync(managedIndexPath);
	const identity = statSync(realpathSync(worktreePath), { bigint: true });
	const folderIdentity = { canonicalPath: realpathSync(worktreePath), dev: identity.dev.toString(), ino: identity.ino.toString() };
	const turnSnapshot: AgentSessionTurnSnapshot = {
		schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: null,
		provider: session.provider, model: session.model, profileRef: null, cwd: worktreePath, folderIdentity,
		managedWorktreeOwnerId: session.id, permissionPolicy: { mode: 'read-only', approval: 'never' }, convention: null, references: [],
	};
	const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot: turnSnapshot });
	const scope = { projectId: project.id, sessionId: session.id, turnId: turn.id };
	database.agentSessionContents.recordBaseline({ scope, snapshot: snapshot(folderIdentity, 'before\n', '2026-10-19T00:00:00.000Z', options.legacyBefore ? 1 : 2), revision: originalHead });
	const currentSession = database.agentSessions.getSession(project.id, session.id)!;
	const running = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, currentSession.revision, { state: 'running' });
	writeFileSync(join(worktreePath, 'src/change.ts'), 'after\n');
	database.agentSessionContents.recordAfter({ scope, snapshot: snapshot(folderIdentity, 'after\n', '2026-10-19T00:01:00.000Z'), expectedLatestVersion: 0, revision: originalHead, cleanupVerified: true });
	database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, running.turn.revision, running.session.revision, { state: 'exited', exitCode: 0, cleanupVerified: true });
	const evidence = database.agentSessionChangeEvidence.getLatest(project.id, session.id, turn.id)!;
	const reviewTarget = { ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'src/change.ts', hunkId: null };
	const explanation = database.agentSessionReviews.recordHumanExplanation({ target: reviewTarget, expectedLatestRevision: 0, what: 'Updated the retained source.', why: 'The reviewed change requires this source content.', citations: [], checkClaims: [], status: 'confirmed' });
	let interruptAfterApply = options.interruptAfterApply ?? false;
	const worktrees = new class extends ManagedWorktreeService {
		override async prepareReviewedCommit(input: ReviewedCommitInput) {
			return super.prepareReviewedCommit(input.frozenIdentity || !options.frozenIdentity ? input : { ...input, frozenIdentity: options.frozenIdentity });
		}
		override async applyReviewedCommit(input: ReviewedCommitApplyInput): Promise<ReviewedCommitApplyResult> {
			const result = await super.applyReviewedCommit(input);
			if (interruptAfterApply) { interruptAfterApply = false; throw new Error('Fixture interruption after the durable Git apply.'); }
			return result;
		}
	}(profile);
	const writerLock = new TaskFolderWriterLock();
	const resolver = new AgentSessionWorkspaceResolver(database, worktrees, writerLock, () => true);
	const service = new AgentSessionService(database, resolver, noProviderRuntime());
	const application = new AgentSessionCommitApplication(database, worktrees, resolver, service);
	return {
		root, repository, profile, databasePath, database, project, session, worktrees, writerLock, resolver, service, application,
		originalHead, originalIndex, worktreePath, managedIndexPath, managedIndexBeforeApply, folderIdentity, scope, evidence, explanation,
		reopen() {
			database.close();
			database = WorkspaceDatabase.open(databasePath);
			const reopenedWorktrees = new ManagedWorktreeService(profile);
			const reopenedResolver = new AgentSessionWorkspaceResolver(database, reopenedWorktrees, new TaskFolderWriterLock(), () => true);
			const reopenedService = new AgentSessionService(database, reopenedResolver, noProviderRuntime());
			return { database, worktrees: reopenedWorktrees, resolver: reopenedResolver, service: reopenedService, application: new AgentSessionCommitApplication(database, reopenedWorktrees, reopenedResolver, reopenedService) };
		},
		cleanup() { database.close(); rmSync(root, { recursive: true, force: true }); },
	};
}

test('approved commit recovers its exact durable candidate after newer evidence without touching the user checkout', async () => {
	const fixture = await createFixture({ interruptAfterApply: true });
	try {
		const { database, application, evidence, scope, explanation } = fixture;
		const proposal = await application.prepareProposal({
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint,
			paths: [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }],
			commitMessage: '  Commit reviewed source update  ', expectedLatestRevision: 0,
		});
		assert.equal(proposal.commitMessage, '  Commit reviewed source update  ');
		assert.equal(proposal.sourceHead, fixture.originalHead);
		assert.equal(proposal.sessionWorktreeOwnerId, fixture.session.id);
		assert.equal(proposal.author.name, 'Commit Application Fixture');
		assert.equal(proposal.paths[0]?.path, 'src/change.ts');
		await assert.rejects(application.applyApprovedProposal({ proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint }), /trusted human approval/u);
		assert.equal(git(fixture.repository, 'rev-parse', 'HEAD'), fixture.originalHead);
		const approval = application.approveProposal({ proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint });
		assert.equal(approval.proposalFingerprint, proposal.fingerprint);
		writeFileSync(join(fixture.worktreePath, 'src/change.ts'), 'later filesystem edit\n');
		await assert.rejects(application.applyApprovedProposal({ proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint }), /Fixture interruption/u);
		const applying = database.agentSessionIntegrations.getProposal(proposal.id)!.outcomes.at(-1)!;
		assert.equal(applying.state, 'applying');
		assert.equal(git(fixture.worktreePath, 'rev-parse', `refs/heads/bugfixer/session/${fixture.session.id}`), applying.receipt.candidateHead);
		assert.equal(git(fixture.repository, 'rev-parse', 'HEAD'), fixture.originalHead);
		assert.deepEqual(readFileSync(join(fixture.repository, '.git', 'index')), fixture.originalIndex);
		assert.equal(readFileSync(join(fixture.worktreePath, 'src/change.ts'), 'utf8'), 'later filesystem edit\n');
		writeFileSync(fixture.managedIndexPath, fixture.managedIndexBeforeApply);
		const indexLockPath = `${fixture.managedIndexPath}.lock`;
		writeFileSync(indexLockPath, 'fixture-owned recovery blocker');
		const blockedRecovery = await application.recoverApplying({ proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint, operationId: applying.receipt.operationId });
		assert.equal(blockedRecovery.state, 'recoveryRequired');
		assert.equal(git(fixture.worktreePath, 'show', ':src/change.ts'), 'before');
		assert.equal(git(fixture.worktreePath, 'rev-parse', `refs/heads/bugfixer/session/${fixture.session.id}`), applying.receipt.candidateHead);
		rmSync(indexLockPath);
		const recoveryRequired = blockedRecovery.outcomes.at(-1)!;
		const newerProposal = database.agentSessionIntegrations.createProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			evidenceVersion: proposal.evidenceVersion, evidenceFingerprint: proposal.evidenceFingerprint,
			sourceHead: proposal.sourceHead, proposedGitTreeHash: proposal.proposedGitTreeHash, diffFingerprint: proposal.diffFingerprint,
			commitMessage: 'A newer unapproved proposal', author: proposal.author, committer: proposal.committer,
			paths: [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }],
			expectedLatestRevision: proposal.revision,
		});
		assert.equal(newerProposal.revision, proposal.revision + 1);
		writeFileSync(join(fixture.worktreePath, 'src/change.ts'), 'newer unreviewed observation\n');
		database.agentSessionContents.recordAfter({
			scope, snapshot: snapshot(fixture.folderIdentity, 'newer unreviewed observation\n', '2026-10-19T00:02:00.000Z'),
			expectedLatestVersion: evidence.version, revision: fixture.originalHead, cleanupVerified: true,
		});

		const reopened = fixture.reopen();
		const recovered = await reopened.application.recoverApplying({ proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint, operationId: recoveryRequired.receipt.operationId });
		assert.equal(recovered.state, 'succeeded');
		assert.equal(recovered.outcomes.at(-1)?.state, 'succeeded');
		assert.equal(git(fixture.worktreePath, 'rev-parse', `refs/heads/bugfixer/session/${fixture.session.id}`), recoveryRequired.receipt.candidateHead);
		assert.equal(git(fixture.worktreePath, 'show', `${recoveryRequired.receipt.candidateHead}:src/change.ts`), 'after');
		assert.equal(git(fixture.worktreePath, 'show', ':src/change.ts'), 'after');
		assert.equal(readFileSync(join(fixture.worktreePath, 'src/change.ts'), 'utf8'), 'newer unreviewed observation\n');
		assert.equal(git(fixture.repository, 'rev-parse', 'HEAD'), fixture.originalHead);
		assert.deepEqual(readFileSync(join(fixture.repository, '.git', 'index')), fixture.originalIndex);
		await assert.rejects(reopened.application.recoverApplying({ proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint }), /applying or recovery-required/u);
	} finally {
		fixture.cleanup();
	}
});

test('commit proposal rejects stale identity and unavailable legacy file mode instead of guessing', async () => {
	const fixture = await createFixture({ legacyBefore: true });
	try {
		const { application, evidence, scope, explanation } = fixture;
		await assert.rejects(application.prepareProposal({
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: '0'.repeat(64),
			paths: [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }],
			commitMessage: 'Do not guess file mode', expectedLatestRevision: 0,
		}), /latest complete observed/u);
		await assert.rejects(application.prepareProposal({
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint,
			paths: [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }],
			commitMessage: 'Do not guess file mode', expectedLatestRevision: 0,
		}), /retained before bytes/u);
		assert.equal(git(fixture.repository, 'rev-parse', 'HEAD'), fixture.originalHead);
	} finally {
		fixture.cleanup();
	}
});

test('approved identity dates survive SQLite and Git service reopen and are written to the candidate headers', async () => {
	const frozenIdentity = {
		author: { name: 'Approved Author', email: 'author@example.invalid', date: '946684800 +0000' },
		committer: { name: 'Approved Committer', email: 'committer@example.invalid', date: '978307200 -0700' },
	};
	const fixture = await createFixture({ frozenIdentity });
	try {
		const { application, evidence, scope, explanation } = fixture;
		const proposal = await application.prepareProposal({
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint,
			paths: [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }],
			commitMessage: 'Preserve approved identity dates', expectedLatestRevision: 0,
		});
		assert.deepEqual(proposal.author, frozenIdentity.author);
		assert.deepEqual(proposal.committer, frozenIdentity.committer);
		fixture.database.agentSessionIntegrations.recordTrustedHumanApproval(proposal.id, proposal.revision);

		const reopened = fixture.reopen();
		const recoveredProposal = reopened.database.agentSessionIntegrations.getProposal(proposal.id)!;
		const applied = await reopened.application.applyApprovedProposal({
			proposalId: recoveredProposal.id, expectedRevision: recoveredProposal.revision, expectedFingerprint: recoveredProposal.fingerprint,
		});
		assert.equal(applied.outcomes.at(-1)?.state, 'succeeded');
		const candidateHead = applied.outcomes.at(-1)!.receipt.candidateHead;
		const headers = git(fixture.worktreePath, 'cat-file', 'commit', candidateHead).split('\n\n', 1)[0].split('\n');
		assert.ok(headers.includes(`author ${frozenIdentity.author.name} <${frozenIdentity.author.email}> ${frozenIdentity.author.date}`));
		assert.ok(headers.includes(`committer ${frozenIdentity.committer.name} <${frozenIdentity.committer.email}> ${frozenIdentity.committer.date}`));
	} finally {
		fixture.cleanup();
	}
});

test('proposal preparation releases previews after persistence and after persistence failure', async () => {
	const fixture = await createFixture();
	try {
		const { application, evidence, scope, explanation } = fixture;
		const paths = [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }];
		const first = await application.prepareProposal({
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, paths,
			commitMessage: 'Proposal 1', expectedLatestRevision: 0,
		});
		await assert.rejects(application.prepareProposal({
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, paths,
			commitMessage: 'Rejected proposal', expectedLatestRevision: first.revision + 1,
		}));
		let expectedLatestRevision = first.revision;
		for (let index = 2; index <= 6; index++) {
			const proposal = await application.prepareProposal({
				...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, paths,
				commitMessage: `Proposal ${index}`, expectedLatestRevision,
			});
			expectedLatestRevision = proposal.revision;
		}
	} finally {
		fixture.cleanup();
	}
});

test('workspace release failure still releases the session mutation lease', async () => {
	const fixture = await createFixture();
	try {
		const { application, evidence, scope, explanation, resolver, service } = fixture;
		const originalRelease = resolver.release.bind(resolver);
		resolver.release = workspace => {
			originalRelease(workspace);
			throw new Error('Fixture workspace release failure.');
		};
		await assert.rejects(application.prepareProposal({
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint,
			paths: [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }],
			commitMessage: 'Lease release regression', expectedLatestRevision: 0,
		}), /Fixture workspace release failure/u);
		const mutationLease = service.acquireIdleMutationLease({ projectId: scope.projectId, sessionId: scope.sessionId });
		mutationLease.release();
	} finally {
		fixture.cleanup();
	}
});
