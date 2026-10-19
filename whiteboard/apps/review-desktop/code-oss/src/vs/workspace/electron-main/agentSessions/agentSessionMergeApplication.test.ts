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
import { AgentSessionCommitApplication } from './agentSessionCommitApplication.js';
import { AgentSessionMergeApplication, type AgentSessionMergePrepareInput } from './agentSessionMergeApplication.js';
import { AgentSessionService, type AgentSessionRuntimeFactory } from './agentSessionService.js';
import { AgentSessionWorkspaceResolver } from './agentSessionWorkspace.js';
import { ManagedWorktreeService } from './managedWorktrees.js';
import { TaskFolderWriterLock } from '../providerRuns/taskFolderWriterLock.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

async function withGitDates<T>(authorDate: string, committerDate: string, action: () => Promise<T>): Promise<T> {
	const previousAuthorDate = process.env.GIT_AUTHOR_DATE;
	const previousCommitterDate = process.env.GIT_COMMITTER_DATE;
	process.env.GIT_AUTHOR_DATE = authorDate;
	process.env.GIT_COMMITTER_DATE = committerDate;
	try { return await action(); }
	finally {
		if (previousAuthorDate === undefined) { delete process.env.GIT_AUTHOR_DATE; } else { process.env.GIT_AUTHOR_DATE = previousAuthorDate; }
		if (previousCommitterDate === undefined) { delete process.env.GIT_COMMITTER_DATE; } else { process.env.GIT_COMMITTER_DATE = previousCommitterDate; }
	}
}

function noProviderRuntime(): AgentSessionRuntimeFactory {
	const unexpected = (): never => { throw new Error('This fixture never launches a provider.'); };
	return { start: unexpected, watchExit: unexpected, getSnapshot: unexpected, write: unexpected, resize: unexpected, attach: unexpected, stop: unexpected, release: async () => undefined };
}

function content(folderIdentity: AgentSessionTurnSnapshot['folderIdentity'], text: string, capturedAt: string): AgentSessionContentSnapshot {
	const bytes = Buffer.from(text, 'utf8');
	return {
		schemaVersion: 2, folderIdentity, capturedAt, inventoryCoverage: 'complete', contentCoverage: 'complete',
		entryCount: 1, fileBytes: bytes.byteLength, retainedTextBytes: bytes.byteLength, retainedBinaryBytes: 0, contentReadCount: 1,
		entries: [{ path: 'src/change.txt', kind: 'file', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), content: text, executable: false }],
	};
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'agent-session-merge-application-'));
	const repository = join(root, 'repository');
	const profile = join(root, 'profile');
	mkdirSync(repository);
	mkdirSync(profile);
	git(repository, 'init', '-q', '-b', 'user-work');
	git(repository, 'config', 'user.name', 'Merge Application Fixture');
	git(repository, 'config', 'user.email', 'merge-application@example.invalid');
	mkdirSync(join(repository, 'src'));
	writeFileSync(join(repository, 'src/change.txt'), 'before\n');
	git(repository, 'add', 'src/change.txt');
	git(repository, 'commit', '-qm', 'source base');
	const originalHead = git(repository, 'rev-parse', 'HEAD');
	const originalIndex = readFileSync(join(repository, '.git', 'index'));
	const databasePath = join(root, 'workspace.db');
	let database = WorkspaceDatabase.open(databasePath);
	const project = database.createProject('Merge application fixture');
	const folder = database.createFolderBinding({ projectId: project.id, path: repository, vcsKind: 'git', vcsRoot: repository });
	const session = database.agentSessions.createSession({ projectId: project.id, bindingId: folder.id, name: 'Merge source session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'gitWorktree' });
	let worktrees = new ManagedWorktreeService(profile);
	const sessionLease = await worktrees.create({ repositoryPath: repository, ownerId: session.id, kind: 'session', baseRef: 'HEAD' });
	const worktreePath = sessionLease.worktreePath;
	const identity = statSync(realpathSync(worktreePath), { bigint: true });
	const folderIdentity = { canonicalPath: realpathSync(worktreePath), dev: identity.dev.toString(), ino: identity.ino.toString() };
	const turnSnapshot: AgentSessionTurnSnapshot = {
		schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: folder.id, taskId: null,
		provider: session.provider, model: session.model, profileRef: null, cwd: worktreePath, folderIdentity, managedWorktreeOwnerId: session.id,
		permissionPolicy: { mode: 'read-only', approval: 'never' }, convention: null, references: [],
	};
	const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot: turnSnapshot });
	const scope = { projectId: project.id, sessionId: session.id, turnId: turn.id };
	database.agentSessionContents.recordBaseline({ scope, snapshot: content(folderIdentity, 'before\n', '2026-10-19T00:00:00.000Z'), revision: originalHead });
	const running = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, session.revision, { state: 'running' });
	writeFileSync(join(worktreePath, 'src/change.txt'), 'after\n');
	database.agentSessionContents.recordAfter({ scope, snapshot: content(folderIdentity, 'after\n', '2026-10-19T00:01:00.000Z'), expectedLatestVersion: 0, revision: originalHead, cleanupVerified: true });
	database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, running.turn.revision, running.session.revision, { state: 'exited', exitCode: 0, cleanupVerified: true });
	const evidence = database.agentSessionChangeEvidence.getLatest(project.id, session.id, turn.id)!;
	const explanation = database.agentSessionReviews.recordHumanExplanation({
		target: { ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'src/change.txt', hunkId: null },
		expectedLatestRevision: 0, what: 'Changed the source text.', why: 'The reviewed update is needed.', citations: [], checkClaims: [], status: 'confirmed',
	});
	const writerLock = new TaskFolderWriterLock();
	let resolver = new AgentSessionWorkspaceResolver(database, worktrees, writerLock, () => true);
	let service = new AgentSessionService(database, resolver, noProviderRuntime());
	let commitApplication = new AgentSessionCommitApplication(database, worktrees, resolver, service);
	let mergeApplication = new AgentSessionMergeApplication(database, worktrees, database.agentSessionMerges, resolver, service);
	const commitProposal = await commitApplication.prepareProposal({
		...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint,
		paths: [{ path: 'src/change.txt', explanationTargets: [{ path: 'src/change.txt', hunkId: null, revision: explanation.revision }] }],
		commitMessage: 'Reviewed source update', expectedLatestRevision: 0,
	});
	commitApplication.approveProposal({ proposalId: commitProposal.id, expectedRevision: commitProposal.revision, expectedFingerprint: commitProposal.fingerprint });
	await commitApplication.applyApprovedProposal({ proposalId: commitProposal.id, expectedRevision: commitProposal.revision, expectedFingerprint: commitProposal.fingerprint });
	const mergeInput: AgentSessionMergePrepareInput = { ...scope, commitProposalId: commitProposal.id, expectedLatestRevision: 0 };
	const reopened = () => {
		database.close();
		database = WorkspaceDatabase.open(databasePath);
		worktrees = new ManagedWorktreeService(profile);
		resolver = new AgentSessionWorkspaceResolver(database, worktrees, new TaskFolderWriterLock(), () => true);
		service = new AgentSessionService(database, resolver, noProviderRuntime());
		commitApplication = new AgentSessionCommitApplication(database, worktrees, resolver, service);
		mergeApplication = new AgentSessionMergeApplication(database, worktrees, database.agentSessionMerges, resolver, service);
	};
	return {
		root, repository, profile, databasePath, project, session, get worktrees() { return worktrees; }, get database() { return database; }, get mergeApplication() { return mergeApplication; },
		originalHead, originalIndex, worktreePath, mergeInput,
		reopen: reopened,
		cleanup() { database.close(); rmSync(root, { recursive: true, force: true }); },
	};
}

test('merge remains separate from commit approval and survives exact SQLite and manager reopen', async () => {
	const state = await fixture();
	try {
		writeFileSync(join(state.worktreePath, 'unselected-dirty.txt'), 'keep on the source worktree\n');
		const proposal = await withGitDates('2001-02-03T04:05:06+00:00', '2003-04-05T06:07:08+00:00', () => state.mergeApplication.prepareProposal(state.mergeInput));
		const target = await state.worktrees.ensureIntegrationTarget({ ownerId: proposal.integrationOwnerId, sessionOwnerId: proposal.sessionOwnerId });
		const targetHead = git(target.worktreePath, 'rev-parse', 'HEAD');		assert.equal(targetHead, proposal.targetHead);
		await assert.rejects(state.mergeApplication.applyApprovedProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		}), /trusted human approval/u);
		assert.equal(git(target.worktreePath, 'rev-parse', 'HEAD'), targetHead);
		assert.equal(state.database.agentSessionMerges.getProposal(proposal.id)?.approval, null);

		state.mergeApplication.approveProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		});
		state.reopen();
		const applied = await withGitDates('2024-01-02T03:04:05+00:00', '2025-06-07T08:09:10+00:00', () => state.mergeApplication.applyApprovedProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		}));
		assert.equal(applied.outcomes.at(-1)?.state, 'merged');
		const applyingBinding = state.database.agentSessionMerges.getApplyingBinding(proposal.id, applied.outcomes.at(-1)!.receipt.operationId);
		assert.equal(applyingBinding?.proposalFingerprint, proposal.fingerprint);
		assert.equal(applyingBinding?.integrationOwnerId, proposal.integrationOwnerId);
		assert.equal(applyingBinding?.commitMessage, proposal.commitMessage);
		assert.deepEqual(applyingBinding?.author, proposal.author);
		assert.deepEqual(applyingBinding?.committer, proposal.committer);
		assert.equal(applied.outcomes.at(-1)?.receipt.sourceHead, proposal.sourceHead);
		assert.equal(applied.outcomes.at(-1)?.receipt.targetHead, proposal.targetHead);
		assert.deepEqual(applied.artifacts.map(record => record.event.phase), ['intent', 'candidatePrepared', 'generationRegistered', 'generationMaterialized', 'published']);
		const headers = git(state.repository, 'cat-file', '-p', applied.outcomes.at(-1)!.receipt.resultingHead!).split('\n\n')[0];
		assert.ok(headers.includes(`author ${proposal.author.name} <${proposal.author.email}> ${proposal.author.date}`));
		assert.ok(headers.includes(`committer ${proposal.committer.name} <${proposal.committer.email}> ${proposal.committer.date}`));
		assert.equal(git(state.repository, 'show', '-s', '--format=%s', applied.outcomes.at(-1)!.receipt.resultingHead!), proposal.commitMessage);
		assert.equal(git(state.repository, 'rev-parse', 'HEAD'), state.originalHead);
		assert.deepEqual(readFileSync(join(state.repository, '.git', 'index')), state.originalIndex);
		assert.equal(readFileSync(join(state.worktreePath, 'unselected-dirty.txt'), 'utf8'), 'keep on the source worktree\n');
		const mergedTarget = await state.worktrees.inspect(proposal.integrationOwnerId);
		assert.equal(mergedTarget.head, applied.outcomes.at(-1)?.receipt.resultingHead);
		assert.equal(git(mergedTarget.worktreePath, 'show', 'HEAD:src/change.txt'), 'after');
	} finally { state.cleanup(); }
});

test('signed target conflict is retained and reported with its exact path', async () => {
	const state = await fixture();
	try {
		const integrationOwnerId = state.database.agentSessionMerges.getOrCreateIntegrationOwner(state.project.id, state.session.bindingId);
		const target = await state.worktrees.create({ repositoryPath: state.repository, ownerId: integrationOwnerId, kind: 'integration', baseRef: state.originalHead });
		writeFileSync(join(target.worktreePath, 'src/change.txt'), 'target edit\n');
		git(target.worktreePath, 'add', 'src/change.txt');
		git(target.worktreePath, 'commit', '-qm', 'independent target edit');
		const oldIndex = readFileSync(git(target.worktreePath, 'rev-parse', '--git-path', 'index'));
		const proposal = await state.mergeApplication.prepareProposal(state.mergeInput);
		state.mergeApplication.approveProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		});
		const result = await state.mergeApplication.applyApprovedProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		});
		assert.equal(result.outcomes.at(-1)?.state, 'conflict');
		assert.deepEqual(result.outcomes.at(-1)?.receipt.conflictedPaths, ['src/change.txt']);
		const conflict = await state.worktrees.inspect(integrationOwnerId);
		assert.equal(conflict.state, 'conflict');
		assert.notEqual(conflict.worktreePath, target.worktreePath);
		assert.equal(result.generationDirectory, conflict.worktreePath);
		assert.equal(readFileSync(join(conflict.worktreePath, 'src/change.txt'), 'utf8').includes('<<<<<<<'), true);
		assert.equal(readFileSync(join(target.worktreePath, 'src/change.txt'), 'utf8'), 'target edit\n');
		assert.deepEqual(readFileSync(git(target.worktreePath, 'rev-parse', '--git-path', 'index')), oldIndex);
		assert.equal(git(state.repository, 'rev-parse', 'HEAD'), state.originalHead);
	} finally { state.cleanup(); }
});

test('human conflict resolution needs a new exact approval, rejects staged or file edits and preserves generations across reopen', async () => {
	const state = await fixture();
	try {
		const ownerId = state.database.agentSessionMerges.getOrCreateIntegrationOwner(state.project.id, state.session.bindingId);
		const old = await state.worktrees.create({ repositoryPath: state.repository, ownerId, kind: 'integration', baseRef: state.originalHead });
		writeFileSync(join(old.worktreePath, 'src/change.txt'), 'target edit\n');
		git(old.worktreePath, 'add', 'src/change.txt'); git(old.worktreePath, 'commit', '-qm', 'target conflict');
		const oldIndex = readFileSync(git(old.worktreePath, 'rev-parse', '--git-path', 'index'));
		const first = await state.mergeApplication.prepareProposal(state.mergeInput);
		const mutation = (proposal: typeof first) => ({ projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId, proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint });
		state.mergeApplication.approveProposal(mutation(first));
		const conflict = await state.mergeApplication.applyApprovedProposal(mutation(first));
		assert.equal(conflict.state, 'conflict');
		const retained = await state.worktrees.inspect(ownerId);
		const resolutionInput = { ...state.mergeInput, resolutionOfProposalId: first.id, expectedLatestRevision: first.revision };
		await assert.rejects(state.mergeApplication.prepareProposal(resolutionInput), /Stage every resolved conflict/u);
		writeFileSync(join(retained.worktreePath, 'src/change.txt'), 'human resolved\n');
		git(retained.worktreePath, 'add', 'src/change.txt');
		const resolution = await state.mergeApplication.prepareProposal(resolutionInput);
		assert.equal(resolution.approval, null);
		assert.notEqual(resolution.id, first.id);
		assert.notEqual(resolution.fingerprint, first.fingerprint);
		assert.equal(resolution.resolution?.proposalId, first.id);
		assert.equal(resolution.resolution?.operationId, conflict.outcomes.at(-1)?.receipt.operationId);
		assert.equal(resolution.sourceHead, first.sourceHead); assert.equal(resolution.targetHead, first.targetHead);
		assert.match(resolution.diffText, /-target edit/u); assert.match(resolution.diffText, /\+human resolved/u);
		assert.equal(resolution.paths[0].explanationState, 'unknown');
		await assert.rejects(state.mergeApplication.applyApprovedProposal(mutation(resolution)), /trusted human approval/u);
		state.mergeApplication.approveProposal(mutation(resolution));
		// Index-only flags are part of the pinned byte snapshot, not just staged object IDs.
		git(retained.worktreePath, 'update-index', '--assume-unchanged', 'src/change.txt');
		await assert.rejects(state.mergeApplication.applyApprovedProposal(mutation(resolution)), /no longer matches/u);
		assert.equal(state.database.agentSessionMerges.getProposal(resolution.id)?.outcomes.length, 0);
		git(retained.worktreePath, 'update-index', '--no-assume-unchanged', 'src/change.txt');
		writeFileSync(join(retained.worktreePath, 'src/change.txt'), 'unstaged later human edit\n');
		await assert.rejects(state.mergeApplication.prepareProposal({ ...resolutionInput, expectedLatestRevision: resolution.revision }), /files differ/u);
		git(retained.worktreePath, 'add', 'src/change.txt');
		const fresh = await state.mergeApplication.prepareProposal({ ...resolutionInput, expectedLatestRevision: resolution.revision });
		assert.notEqual(fresh.fingerprint, resolution.fingerprint);
		const retainedIndex = readFileSync(git(retained.worktreePath, 'rev-parse', '--git-path', 'index'));
		state.reopen();
		assert.deepEqual(state.database.agentSessionMerges.getProposal(fresh.id)?.resolution, fresh.resolution);
		await assert.rejects(state.mergeApplication.applyApprovedProposal(mutation(fresh)), /trusted human approval/u);
		state.mergeApplication.approveProposal(mutation(fresh));
		const apply = state.worktrees.mergeReviewed.bind(state.worktrees);
		state.worktrees.mergeReviewed = input => apply({ ...input, recordArtifact: async (operationId, revision, event) => {
			const recorded = await input.recordArtifact(operationId, revision, event);
			if (event.phase === 'published') { throw new Error('simulated interruption after resolution publication'); }
			return recorded;
		} });
		const interrupted = await state.mergeApplication.applyApprovedProposal(mutation(fresh));
		assert.equal(interrupted.state, 'recoveryRequired');
		assert.ok(interrupted.generationDirectory);
		const publishedHead = git(state.repository, 'rev-parse', `refs/heads/bugfixer/integration/${ownerId}`);
		state.reopen();
		const merged = await state.mergeApplication.reconcileApplying({ ...mutation(fresh), operationId: interrupted.outcomes.at(-1)!.receipt.operationId });
		assert.equal(merged.state, 'merged');
		assert.equal(merged.outcomes.at(-1)?.receipt.resultingHead, publishedHead);
		const current = await state.worktrees.inspect(ownerId);
		assert.notEqual(current.worktreePath, retained.worktreePath);
		assert.equal(merged.generationDirectory, current.worktreePath);
		assert.equal(git(current.worktreePath, 'show', '-s', '--format=%P', 'HEAD'), `${first.targetHead} ${first.sourceHead}`);
		assert.equal(git(current.worktreePath, 'rev-parse', 'HEAD^{tree}'), fresh.resolution?.treeOid);
		assert.equal(readFileSync(join(current.worktreePath, 'src/change.txt'), 'utf8'), 'unstaged later human edit\n');
		assert.equal(readFileSync(join(retained.worktreePath, 'src/change.txt'), 'utf8'), 'unstaged later human edit\n');
		assert.deepEqual(readFileSync(git(retained.worktreePath, 'rev-parse', '--git-path', 'index')), retainedIndex);
		assert.deepEqual(readFileSync(git(old.worktreePath, 'rev-parse', '--git-path', 'index')), oldIndex);
		assert.equal(readFileSync(join(old.worktreePath, 'src/change.txt'), 'utf8'), 'target edit\n');
		state.reopen();
		const page = await state.mergeApplication.listProposals({ projectId: first.projectId, sessionId: first.sessionId, turnId: first.turnId });
		assert.equal(page.proposals.find(value => value.id === first.id)?.generationDirectory, retained.worktreePath);
		assert.equal(page.proposals.find(value => value.id === fresh.id)?.state, 'merged');
		assert.equal(git(state.repository, 'rev-parse', 'HEAD'), state.originalHead);
		assert.deepEqual(readFileSync(join(state.repository, '.git', 'index')), state.originalIndex);
	} finally { state.cleanup(); }
});

test('a separately approved resolution may keep exactly the target tree with an empty complete diff', async () => {
	const state = await fixture();
	try {
		const ownerId = state.database.agentSessionMerges.getOrCreateIntegrationOwner(state.project.id, state.session.bindingId);
		const old = await state.worktrees.create({ repositoryPath: state.repository, ownerId, kind: 'integration', baseRef: state.originalHead });
		writeFileSync(join(old.worktreePath, 'src/change.txt'), 'target edit\n');
		git(old.worktreePath, 'add', 'src/change.txt'); git(old.worktreePath, 'commit', '-qm', 'target conflict');
		const original = await state.mergeApplication.prepareProposal(state.mergeInput);
		const mutation = (proposal: typeof original) => ({ projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId, proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint });
		state.mergeApplication.approveProposal(mutation(original));
		await state.mergeApplication.applyApprovedProposal(mutation(original));
		const conflict = await state.worktrees.inspect(ownerId);
		writeFileSync(join(conflict.worktreePath, 'src/change.txt'), 'target edit\n'); git(conflict.worktreePath, 'add', 'src/change.txt');
		const resolution = await state.mergeApplication.prepareProposal({ ...state.mergeInput, resolutionOfProposalId: original.id, expectedLatestRevision: original.revision });
		assert.equal(resolution.diffText, ''); assert.deepEqual(resolution.paths, []);
		state.mergeApplication.approveProposal(mutation(resolution));
		const merged = await state.mergeApplication.applyApprovedProposal(mutation(resolution));
		assert.equal(merged.state, 'merged'); assert.deepEqual(merged.outcomes.at(-1)?.receipt.changedPaths, []);
		assert.equal(git(state.repository, 'rev-parse', `${merged.outcomes.at(-1)!.receipt.resultingHead}^{tree}`), git(state.repository, 'rev-parse', `${original.targetHead}^{tree}`));
	} finally { state.cleanup(); }
});

test('missing durable merge journal readback cannot advance the integration ref', async () => {
	const state = await fixture();
	try {
		const proposal = await state.mergeApplication.prepareProposal(state.mergeInput);
		state.mergeApplication.approveProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		});
		const target = await state.worktrees.ensureIntegrationTarget({ ownerId: proposal.integrationOwnerId, sessionOwnerId: proposal.sessionOwnerId });
		const targetHead = git(target.worktreePath, 'rev-parse', 'HEAD');
		const mergeReviewed = state.worktrees.mergeReviewed.bind(state.worktrees);
		state.worktrees.mergeReviewed = input => mergeReviewed({ ...input, readApplying: async () => undefined });
		const result = await state.mergeApplication.applyApprovedProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		});
		assert.equal(result.outcomes.at(-1)?.state, 'notApplied');
		assert.equal(git(target.worktreePath, 'rev-parse', 'HEAD'), targetHead);
		assert.equal((await state.worktrees.inspect(proposal.integrationOwnerId)).lastOperation, undefined);
		assert.equal(result.outcomes.at(-1)?.receipt.failureCode, 'merge-not-applied');
		await assert.rejects(state.mergeApplication.applyApprovedProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		}), /terminal/u);
		assert.equal(git(target.worktreePath, 'rev-parse', 'HEAD'), targetHead);
	} finally { state.cleanup(); }
});

test('a crash after durable intent keeps its exact artifact history across reopen and never retries publication', async () => {
	const state = await fixture();
	try {
		const proposal = await state.mergeApplication.prepareProposal(state.mergeInput);
		state.mergeApplication.approveProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		});
		const target = await state.worktrees.ensureIntegrationTarget({ ownerId: proposal.integrationOwnerId, sessionOwnerId: proposal.sessionOwnerId });
		const targetHead = git(target.worktreePath, 'rev-parse', 'HEAD');
		const mergeReviewed = state.worktrees.mergeReviewed.bind(state.worktrees);
		state.worktrees.mergeReviewed = input => mergeReviewed({
			...input,
			recordArtifact: async (operationId, expectedRevision, event) => {
				const recorded = await input.recordArtifact(operationId, expectedRevision, event);
				if (event.phase === 'intent') { throw new Error('simulated host crash after intent readback'); }
				return recorded;
			},
		});
		const applying = await state.mergeApplication.applyApprovedProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		});
		assert.equal(applying.outcomes.at(-1)?.state, 'recoveryRequired');
		assert.deepEqual(applying.artifacts.map(record => record.event.phase), ['intent']);
		assert.equal(git(target.worktreePath, 'rev-parse', 'HEAD'), targetHead);

		state.reopen();
		const reconciled = await state.mergeApplication.reconcileApplying({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
			operationId: applying.outcomes.at(-1)!.receipt.operationId,
		});
		assert.equal(reconciled.outcomes.at(-1)?.state, 'recoveryRequired');
		assert.deepEqual(reconciled.artifacts.map(record => record.event.phase), ['intent']);
		assert.equal(git(target.worktreePath, 'rev-parse', 'HEAD'), targetHead);
	} finally { state.cleanup(); }
});

test('published Git result is copied from its durable artifact into recovery receipt and reconciled after reopen', async () => {
	const state = await fixture();
	try {
		const proposal = await state.mergeApplication.prepareProposal(state.mergeInput);
		state.mergeApplication.approveProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		});
		const mergeReviewed = state.worktrees.mergeReviewed.bind(state.worktrees);
		let interruptedAfterPublication = false;
		state.worktrees.mergeReviewed = input => mergeReviewed({
			...input,
			recordArtifact: async (operationId, expectedRevision, event) => {
				const recorded = await input.recordArtifact(operationId, expectedRevision, event);
				if (event.phase === 'published' && !interruptedAfterPublication) {
					interruptedAfterPublication = true;
					throw new Error('simulated crash after durable publication artifact');
				}
				return recorded;
			},
		});
		const interrupted = await state.mergeApplication.applyApprovedProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		});
		assert.equal(interruptedAfterPublication, true);
		assert.equal(interrupted.outcomes.at(-1)?.state, 'recoveryRequired');
		const published = interrupted.artifacts.at(-1)?.event;
		assert.equal(published?.phase, 'published');
		if (published?.phase !== 'published') { throw new Error('Published artifact was not retained after interruption.'); }
		assert.equal(interrupted.outcomes.at(-1)?.receipt.resultingHead, published.resultingHead);
		assert.deepEqual(interrupted.outcomes.at(-1)?.receipt.changedPaths, proposal.paths.map(path => path.path));
		assert.equal(git(state.repository, 'cat-file', '-e', published.resultingHead), '');

		state.reopen();
		const reconciled = await state.mergeApplication.reconcileApplying({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
			operationId: interrupted.outcomes.at(-1)!.receipt.operationId,
		});
		assert.equal(reconciled.outcomes.at(-1)?.state, 'merged');
		assert.equal(reconciled.outcomes.at(-1)?.receipt.resultingHead, published.resultingHead);
		assert.deepEqual(reconciled.outcomes.at(-1)?.receipt.changedPaths, proposal.paths.map(path => path.path));
		assert.deepEqual(reconciled.artifacts.map(record => record.event.phase), ['intent', 'candidatePrepared', 'generationRegistered', 'generationMaterialized', 'published']);
	} finally { state.cleanup(); }
});

test('fresh merge proposal rejects a changed target before durable apply or Git mutation', async () => {
	const state = await fixture();
	try {
		const proposal = await state.mergeApplication.prepareProposal(state.mergeInput);
		const target = await state.worktrees.ensureIntegrationTarget({ ownerId: proposal.integrationOwnerId, sessionOwnerId: proposal.sessionOwnerId });
		writeFileSync(join(target.worktreePath, 'target-only.txt'), 'target advanced after review\n');
		git(target.worktreePath, 'add', 'target-only.txt');
		git(target.worktreePath, 'commit', '-qm', 'advance target after review');
		const advancedHead = git(target.worktreePath, 'rev-parse', 'HEAD');
		state.mergeApplication.approveProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		});
		await assert.rejects(state.mergeApplication.applyApprovedProposal({
			projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
		}), /no longer matches|branch ref|HEAD/u);
		assert.equal(state.database.agentSessionMerges.getProposal(proposal.id)?.outcomes.length, 0);
		assert.equal(git(target.worktreePath, 'rev-parse', 'HEAD'), advancedHead);
		assert.equal(git(state.repository, 'rev-parse', 'HEAD'), state.originalHead);
		assert.deepEqual(readFileSync(join(state.repository, '.git', 'index')), state.originalIndex);
	} finally { state.cleanup(); }
});
