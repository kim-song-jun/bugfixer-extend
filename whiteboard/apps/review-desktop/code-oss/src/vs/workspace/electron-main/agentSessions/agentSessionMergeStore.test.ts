/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import type { AgentSessionMergeProposalDTO } from '../../common/workspaceAgentMergeProtocol.js';
import type { AgentSessionContentSnapshot } from './agentSessionContentCapture.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';

test('durable merge proposal pins successful commit, full source delta, human approval and exact operation outcome across reopen', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-agent-session-merge-'));
	const folder = join(directory, 'repository'); mkdirSync(folder);
	const databasePath = join(directory, 'workspace.db'); let database = WorkspaceDatabase.open(databasePath);
	try {
		const project = database.createProject('Local merge review');
		const binding = database.createFolderBinding({ projectId: project.id, path: folder, vcsKind: 'git', vcsRoot: folder });
		const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Merge source', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'gitWorktree' });
		const canonicalFolder = realpathSync(folder); const identity = statSync(canonicalFolder, { bigint: true });
		const folderIdentity = { canonicalPath: canonicalFolder, dev: identity.dev.toString(), ino: identity.ino.toString() };
		const snapshot: AgentSessionTurnSnapshot = { schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision,
			bindingId: binding.id, taskId: null, provider: session.provider, model: session.model, profileRef: null, cwd: canonicalFolder, folderIdentity,
			managedWorktreeOwnerId: session.id, permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [] };
		let turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
		const scope = { projectId: project.id, sessionId: session.id, turnId: turn.id };
		const capture = (content: string, capturedAt: string): AgentSessionContentSnapshot => ({ schemaVersion: 1, folderIdentity, capturedAt, inventoryCoverage: 'complete', contentCoverage: 'complete', entryCount: 1,
			fileBytes: Buffer.byteLength(content), retainedTextBytes: Buffer.byteLength(content), contentReadCount: 1,
			entries: [{ path: 'src/selected.ts', kind: 'file', size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), content }] });
		database.agentSessionContents.recordBaseline({ scope, snapshot: capture('before\n', '2026-10-19T00:00:00.000Z'), revision: '1'.repeat(40) });
		const currentSession = database.agentSessions.getSession(project.id, session.id)!;
		const running = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, currentSession.revision, { state: 'running' });
		database.agentSessionContents.recordAfter({ scope, snapshot: capture('after\n', '2026-10-19T00:01:00.000Z'), expectedLatestVersion: 0, revision: '2'.repeat(40), cleanupVerified: true });
		const finalSession = database.agentSessions.getSession(project.id, session.id)!;
		turn = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, running.turn.revision, finalSession.revision, { state: 'exited', exitCode: 0, cleanupVerified: true }).turn;
		const evidence = database.agentSessionChangeEvidence.getLatest(project.id, session.id, turn.id)!;
		const explanation = database.agentSessionReviews.recordHumanExplanation({ target: { ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'src/selected.ts', hunkId: null },
			expectedLatestRevision: 0, what: 'Updated selected source.', why: 'The requested behavior needs this change.', citations: [], checkClaims: [], status: 'confirmed' });
		const sourceHead = 'd'.repeat(40); const commitProposalInput = { ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint,
			sourceHead: 'a'.repeat(40), proposedGitTreeHash: 'b'.repeat(40), diffFingerprint: 'c'.repeat(64), commitMessage: 'Commit selected source',
			author: { name: 'Author', email: 'author@example.test', date: '1792416000 +0900' }, committer: { name: 'Committer', email: 'committer@example.test', date: '1792416060 +0900' },
			paths: [{ path: 'src/selected.ts', explanationTargets: [{ path: 'src/selected.ts', hunkId: null, revision: explanation.revision }] }], expectedLatestRevision: 0 };
		const commitProposal = database.agentSessionIntegrations.createProposal(commitProposalInput);
		database.agentSessionIntegrations.recordTrustedHumanApproval(commitProposal.id, commitProposal.revision);
		const operationId = randomUUID(); const applyingReceipt = { operationId, sourceHead: commitProposal.sourceHead, proposedGitTreeHash: commitProposal.proposedGitTreeHash,
			diffFingerprint: commitProposal.diffFingerprint, candidateHead: sourceHead, resultingHead: null, changedPaths: [], failureCode: null };
		database.agentSessionIntegrations.recordOutcome({ proposalId: commitProposal.id, expectedOutcomeRevision: 0, state: 'applying', action: 'commit', receipt: applyingReceipt });
		database.agentSessionIntegrations.recordOutcome({ proposalId: commitProposal.id, expectedOutcomeRevision: 1, state: 'succeeded', action: 'commit', receipt: { ...applyingReceipt, resultingHead: sourceHead, changedPaths: ['src/selected.ts'] } });

		const integrationOwnerId = database.agentSessionMerges.getOrCreateIntegrationOwner(project.id, binding.id);
		assert.equal(database.agentSessionMerges.getOrCreateIntegrationOwner(project.id, binding.id), integrationOwnerId);
		const diffText = 'diff --git a/src/selected.ts b/src/selected.ts\n+after\n';
		const mergeInput = { ...scope, commitProposalId: commitProposal.id, commitProposalRevision: commitProposal.revision, commitProposalFingerprint: commitProposal.fingerprint,
			integrationOwnerId, sourceHead, targetHead: 'e'.repeat(40), mergeBase: '1'.repeat(40), diffFingerprint: createHash('sha256').update(diffText, 'utf8').digest('hex'),
			diffText, commitMessage: `Merge reviewed session ${scope.sessionId}`,
			author: { name: 'Merge Author', email: 'author@example.test', date: '1792416000 +0900' },
			committer: { name: 'Merge Committer', email: 'committer@example.test', date: '1792416060 +0900' },
			changedPaths: ['src/selected.ts', 'src/unselected-source-change.ts'], expectedLatestRevision: 0 };
		const proposal = database.agentSessionMerges.createProposal(mergeInput);
		assert.equal(proposal.state, 'pending'); assert.equal(proposal.diffText, diffText);
		assert.equal(database.agentSessionMerges.listProposals(project.id, session.id, turn.id).proposals.length, 1);
		assert.throws(() => database.agentSessionMerges.listProposals(project.id, session.id, turn.id, { limit: 6 }), /page bounds/);
		assert.equal(proposal.paths[0]?.explanationState, 'linked'); assert.equal(proposal.paths[0]?.explanations[0]?.id, explanation.id);
		assert.equal(proposal.paths[1]?.explanationState, 'unknown'); assert.deepEqual(proposal.paths[1]?.explanations, []);
		assert.throws(() => database.agentSessionMerges.createProposal({ ...mergeInput, integrationOwnerId: randomUUID() }), /does not match the persisted project Git binding/);
		assert.throws(() => database.agentSessionMerges.createProposal({ ...mergeInput, diffText: `${diffText}extra` }), /does not match its full SHA-256/);
		assert.throws(() => database.agentSessionMerges.createProposal({ ...mergeInput, commitMessage: 'renderer supplied message' }), /host-defined reviewed-session message/);
		assert.throws(() => database.agentSessionMerges.createProposal({ ...mergeInput, forgedHuman: true } as never), /unknown fields/);
		assert.throws(() => database.agentSessionMerges.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 0, state: 'applying', receipt: makeReceipt(proposal, randomUUID()) }), /trusted human approval/);
		const approval = database.agentSessionMerges.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint);
		assert.equal(approval.actor, 'human'); assert.equal(approval.proposalFingerprint, proposal.fingerprint);
		const receipt = makeReceipt(proposal, randomUUID());
		const applying = database.agentSessionMerges.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 0, state: 'applying', receipt });
		assert.deepEqual(database.agentSessionMerges.getApplyingBinding(proposal.id, receipt.operationId), applyingBinding(receipt));
		const intent = { phase: 'intent' as const, generationId: randomUUID(), generationPath: `integration/generations/${randomUUID()}`,
			registrationId: randomUUID(), priorGeneration: null };
		assert.throws(() => database.agentSessionMerges.recordArtifact(randomUUID(), 0, intent), /no durable applying receipt/);
		assert.throws(() => database.agentSessionMerges.recordArtifact(receipt.operationId, 0, { phase: 'candidatePrepared', candidateTreeOid: '1'.repeat(40), candidateCommitOid: '2'.repeat(40), outcome: 'clean', conflicts: [] }), /phase is out of order/);
		const intentRecord = database.agentSessionMerges.recordArtifact(receipt.operationId, 0, intent);
		assert.deepEqual(database.agentSessionMerges.recordArtifact(receipt.operationId, 0, intent), intentRecord);
		assert.throws(() => database.agentSessionMerges.recordArtifact(receipt.operationId, 0, { ...intent, generationId: randomUUID() }), /already recorded with different content/);
		assert.throws(() => database.agentSessionMerges.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 1, state: 'merged',
			receipt: { ...receipt, resultingHead: '9'.repeat(40), changedPaths: proposal.paths.map(path => path.path) }, retryOfOutcomeId: applying.id }), /complete exact published artifact chain/);
		assert.equal(database.agentSessionMerges.getProposal(proposal.id)?.state, 'applying');
		const candidate = { phase: 'candidatePrepared' as const, candidateTreeOid: '1'.repeat(40), candidateCommitOid: '2'.repeat(40), outcome: 'clean' as const, conflicts: [] };
		const registered = { phase: 'generationRegistered' as const, generationPath: intent.generationPath, registrationId: intent.registrationId };
		const materialized = { phase: 'generationMaterialized' as const, head: candidate.candidateCommitOid, indexDigest: '3'.repeat(64), treeDigest: '4'.repeat(64), conflictDigest: null };
		const published = { phase: 'published' as const, targetRef: `refs/heads/bugfixer/integration/${proposal.integrationOwnerId}`, resultingHead: candidate.candidateCommitOid,
			currentGenerationId: intent.generationId, priorGenerationId: null };
		const artifactRecords = [intentRecord,
			database.agentSessionMerges.recordArtifact(receipt.operationId, 1, candidate),
			database.agentSessionMerges.recordArtifact(receipt.operationId, 2, registered),
			database.agentSessionMerges.recordArtifact(receipt.operationId, 3, materialized),
			database.agentSessionMerges.recordArtifact(receipt.operationId, 4, published)];
		assert.deepEqual(database.agentSessionMerges.readArtifacts(receipt.operationId), artifactRecords);
		const merged = database.agentSessionMerges.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 1, state: 'merged', receipt: { ...receipt, resultingHead: candidate.candidateCommitOid, changedPaths: proposal.paths.map(path => path.path) }, retryOfOutcomeId: applying.id });
		assert.equal(merged.state, 'merged');
		assert.throws(() => database.agentSessionMerges.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 2, state: 'applying', receipt: { ...receipt, operationId: randomUUID() } }), /only exact journal reconciliation/);
		const raw = new DatabaseSync(databasePath);
		try {
			assert.throws(() => raw.prepare('UPDATE agent_session_merge_proposals SET payload_json = ? WHERE id = ?').run('{}', proposal.id), /immutable/);
			assert.throws(() => raw.prepare('UPDATE agent_session_merge_approvals SET actor = ? WHERE proposal_id = ?').run('renderer', proposal.id), /human|immutable/);
			assert.throws(() => raw.prepare('DELETE FROM agent_session_merge_outcomes WHERE proposal_id = ?').run(proposal.id), /immutable/);
			assert.throws(() => raw.prepare('UPDATE agent_session_merge_artifacts SET event_json = ? WHERE operation_id = ? AND revision = 1').run('{}', receipt.operationId), /immutable/);
			assert.throws(() => raw.prepare('DELETE FROM agent_session_merge_artifacts WHERE operation_id = ?').run(receipt.operationId), /immutable/);
		} finally { raw.close(); }
		database.close(); database = WorkspaceDatabase.open(databasePath);
		assert.deepEqual(database.agentSessionMerges.getProposal(proposal.id), { ...proposal, approval, state: 'merged', outcomes: [applying, merged], artifacts: artifactRecords });
		assert.deepEqual(database.agentSessionMerges.getApplyingBinding(proposal.id, receipt.operationId), applyingBinding(receipt));
		assert.deepEqual(database.agentSessionMerges.readArtifacts(receipt.operationId), artifactRecords);
	} finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('merge artifact journal preserves generated conflict paths and rejects unbound phase changes', () => {
	const fixture = createMergeFixture(); let database = fixture.database; const { proposal } = fixture;
	try {
		database.agentSessionMerges.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint);
		const receipt = makeReceipt(proposal, randomUUID());
		const applying = database.agentSessionMerges.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 0, state: 'applying', receipt });
		const intent = { phase: 'intent' as const, generationId: randomUUID(), generationPath: `integration/generations/${randomUUID()}`, registrationId: randomUUID(), priorGeneration: null };
		database.agentSessionMerges.recordArtifact(receipt.operationId, 0, intent);
		const candidate = { phase: 'candidatePrepared' as const, candidateTreeOid: 'a'.repeat(40), candidateCommitOid: null, outcome: 'conflict' as const,
			conflicts: [{ path: 'generated/renamed-conflict.txt', message: 'content conflict', stages: [{ stage: 1 as const, mode: '100644' as const, oid: 'b'.repeat(40) }, { stage: 2 as const, mode: '100644' as const, oid: 'c'.repeat(40) }] }] };
		database.agentSessionMerges.recordArtifact(receipt.operationId, 1, candidate);
		database.agentSessionMerges.recordArtifact(receipt.operationId, 2, { phase: 'generationRegistered', generationPath: intent.generationPath, registrationId: intent.registrationId });
		const conflictDigest = createHash('sha256').update(JSON.stringify(candidate.conflicts), 'utf8').digest('hex');
		database.agentSessionMerges.recordArtifact(receipt.operationId, 3, { phase: 'generationMaterialized', head: proposal.targetHead, indexDigest: 'd'.repeat(64), treeDigest: 'e'.repeat(64), conflictDigest });
		assert.deepEqual(database.agentSessionMerges.readArtifacts(receipt.operationId).map(record => record.event.phase), ['intent', 'candidatePrepared', 'generationRegistered', 'generationMaterialized']);
		const conflict = database.agentSessionMerges.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 1, state: 'conflict',
			receipt: { ...receipt, conflictedPaths: ['generated/renamed-conflict.txt'] }, retryOfOutcomeId: applying.id });
		assert.deepEqual(conflict.receipt.conflictedPaths, ['generated/renamed-conflict.txt']);
		assert.equal(database.agentSessionMerges.readArtifacts(receipt.operationId).length, 4);
		database = fixture.reopen();
		const reopened = database.agentSessionMerges.getProposal(proposal.id)!;
		assert.equal(reopened.state, 'conflict');
		assert.deepEqual(reopened.outcomes.at(-1)?.receipt.conflictedPaths, ['generated/renamed-conflict.txt']);
		assert.deepEqual(reopened.artifacts.map(record => record.event.phase), ['intent', 'candidatePrepared', 'generationRegistered', 'generationMaterialized']);
		assert.throws(() => database.agentSessionMerges.recordArtifact(receipt.operationId, 4, { phase: 'published', targetRef: `refs/heads/bugfixer/integration/${proposal.integrationOwnerId}`,
			resultingHead: 'a'.repeat(40), currentGenerationId: intent.generationId, priorGenerationId: null }), /only while the exact operation is applying/);
	} finally { fixture.dispose(); }
});

test('merge outcomes reconcile their immutable journal binding after proposal expiry', () => {
	const fixture = createMergeFixture(); const { database, proposal } = fixture;
	try {
		const approval = database.agentSessionMerges.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint);
		const applyingReceipt = makeReceipt(proposal, randomUUID());
		const applying = database.agentSessionMerges.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 0, state: 'applying', receipt: applyingReceipt });
		const originalNow = Date.now;
		try {
			Date.now = () => Date.parse(proposal.expiresAt) + 1;
			assert.deepEqual(database.agentSessionMerges.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint), approval);
			const reconciled = database.agentSessionMerges.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: applying.revision,
				state: 'notApplied', receipt: applyingReceipt, retryOfOutcomeId: applying.id });
			assert.equal(reconciled.receipt.operationId, applyingReceipt.operationId);
		} finally { Date.now = originalNow; }
	} finally { fixture.dispose(); }
});

test('merge proposal history pages five persisted records without duplicate or omitted cursors', () => {
	const fixture = createMergeFixture();
	const { database, proposal } = fixture;
	try {
		const ids = [proposal.id];
		for (let revision = 1; revision < 6; revision++) {
			const next = database.agentSessionMerges.createProposal({ projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId,
				commitProposalId: proposal.commitProposalId, commitProposalRevision: proposal.commitProposalRevision, commitProposalFingerprint: proposal.commitProposalFingerprint,
				integrationOwnerId: proposal.integrationOwnerId, sourceHead: proposal.sourceHead, targetHead: proposal.targetHead, mergeBase: proposal.mergeBase,
				diffFingerprint: proposal.diffFingerprint, diffText: proposal.diffText, commitMessage: proposal.commitMessage, author: proposal.author, committer: proposal.committer,
				changedPaths: proposal.paths.map(path => path.path), expectedLatestRevision: revision });
			ids.push(next.id);
		}
		const first = database.agentSessionMerges.listProposals(proposal.projectId, proposal.sessionId, proposal.turnId);
		assert.deepEqual(first.proposals.map(item => item.id), ids.slice(0, 5));
		assert.equal(first.hasMore, true); assert.equal(first.nextRevision, 5);
		const second = database.agentSessionMerges.listProposals(proposal.projectId, proposal.sessionId, proposal.turnId, { afterRevision: first.nextRevision });
		assert.deepEqual(second.proposals.map(item => item.id), ids.slice(5));
		assert.equal(second.hasMore, false); assert.equal(second.nextRevision, 6);
		const end = database.agentSessionMerges.listProposals(proposal.projectId, proposal.sessionId, proposal.turnId, { afterRevision: second.nextRevision });
		assert.deepEqual(end.proposals, []); assert.equal(end.hasMore, false); assert.equal(end.nextRevision, 6);
	} finally { fixture.dispose(); }
});

function createMergeFixture(): { readonly database: WorkspaceDatabase; readonly proposal: AgentSessionMergeProposalDTO; reopen(): WorkspaceDatabase; dispose(): void } {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-agent-session-merge-cas-')); const folder = join(directory, 'repository'); mkdirSync(folder);
	const databasePath = join(directory, 'workspace.db'); let database = WorkspaceDatabase.open(databasePath);
	try {
		const project = database.createProject('Merge CAS'); const binding = database.createFolderBinding({ projectId: project.id, path: folder, vcsKind: 'git', vcsRoot: folder });
		const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Source', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'gitWorktree' });
		const realFolder = realpathSync(folder); const identity = statSync(realFolder, { bigint: true }); const folderIdentity = { canonicalPath: realFolder, dev: identity.dev.toString(), ino: identity.ino.toString() };
		const snapshot: AgentSessionTurnSnapshot = { schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: null,
			provider: session.provider, model: session.model, profileRef: null, cwd: realFolder, folderIdentity, managedWorktreeOwnerId: session.id,
			permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [] };
		let turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot }); const scope = { projectId: project.id, sessionId: session.id, turnId: turn.id };
		const makeCapture = (content: string, time: string): AgentSessionContentSnapshot => ({ schemaVersion: 1, folderIdentity, capturedAt: time, inventoryCoverage: 'complete', contentCoverage: 'complete', entryCount: 1,
			fileBytes: Buffer.byteLength(content), retainedTextBytes: Buffer.byteLength(content), contentReadCount: 1,
			entries: [{ path: 'file.txt', kind: 'file', size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), content }] });
		database.agentSessionContents.recordBaseline({ scope, snapshot: makeCapture('before', '2026-10-19T00:00:00.000Z'), revision: '1'.repeat(40) });
		const current = database.agentSessions.getSession(project.id, session.id)!; const running = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, current.revision, { state: 'running' });
		database.agentSessionContents.recordAfter({ scope, snapshot: makeCapture('after', '2026-10-19T00:01:00.000Z'), expectedLatestVersion: 0, revision: '2'.repeat(40), cleanupVerified: true });
		const finalSession = database.agentSessions.getSession(project.id, session.id)!;
		turn = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, running.turn.revision, finalSession.revision, { state: 'exited', exitCode: 0, cleanupVerified: true }).turn;
		const evidence = database.agentSessionChangeEvidence.getLatest(project.id, session.id, turn.id)!;
		const explanation = database.agentSessionReviews.recordHumanExplanation({ target: { ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'file.txt', hunkId: null }, expectedLatestRevision: 0, what: 'Changed it.', why: 'Requested.', citations: [], checkClaims: [], status: 'confirmed' });
		const commitProposal = database.agentSessionIntegrations.createProposal({ ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint,
			sourceHead: 'a'.repeat(40), proposedGitTreeHash: 'b'.repeat(40), diffFingerprint: 'c'.repeat(64), commitMessage: 'Commit source',
			author: { name: 'Author', email: 'a@example.test', date: '1792416000 +0900' }, committer: { name: 'Committer', email: 'c@example.test', date: '1792416060 +0900' },
			paths: [{ path: 'file.txt', explanationTargets: [{ path: 'file.txt', hunkId: null, revision: explanation.revision }] }], expectedLatestRevision: 0 });
		database.agentSessionIntegrations.recordTrustedHumanApproval(commitProposal.id, commitProposal.revision);
		const commitOperationId = randomUUID(); const commitReceipt = { operationId: commitOperationId, sourceHead: commitProposal.sourceHead, proposedGitTreeHash: commitProposal.proposedGitTreeHash,
			diffFingerprint: commitProposal.diffFingerprint, candidateHead: 'd'.repeat(40), resultingHead: null, changedPaths: [], failureCode: null };
		database.agentSessionIntegrations.recordOutcome({ proposalId: commitProposal.id, expectedOutcomeRevision: 0, state: 'applying', action: 'commit', receipt: commitReceipt });
		database.agentSessionIntegrations.recordOutcome({ proposalId: commitProposal.id, expectedOutcomeRevision: 1, state: 'succeeded', action: 'commit', receipt: { ...commitReceipt, resultingHead: 'd'.repeat(40), changedPaths: ['file.txt'] } });
		const integrationOwnerId = database.agentSessionMerges.getOrCreateIntegrationOwner(project.id, binding.id); const diffText = 'diff --git a/file.txt b/file.txt\n';
		const proposal = database.agentSessionMerges.createProposal({ ...scope, commitProposalId: commitProposal.id, commitProposalRevision: commitProposal.revision, commitProposalFingerprint: commitProposal.fingerprint,
			integrationOwnerId, sourceHead: 'd'.repeat(40), targetHead: 'e'.repeat(40), mergeBase: '1'.repeat(40), diffFingerprint: createHash('sha256').update(diffText).digest('hex'),
			diffText, commitMessage: `Merge reviewed session ${scope.sessionId}`,
			author: { name: 'Merge Author', email: 'author@example.test', date: '1792416000 +0900' },
			committer: { name: 'Merge Committer', email: 'committer@example.test', date: '1792416060 +0900' },
			changedPaths: ['file.txt'], expectedLatestRevision: 0 });
		return { database, proposal, reopen: () => { database.close(); database = WorkspaceDatabase.open(databasePath); return database; }, dispose: () => { database.close(); rmSync(directory, { recursive: true, force: true }); } };
	} catch (error) { database.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
}

function makeReceipt(proposal: AgentSessionMergeProposalDTO, operationId: string) {
	return { operationId, proposalId: proposal.id, proposalFingerprint: proposal.fingerprint, integrationOwnerId: proposal.integrationOwnerId, sessionOwnerId: proposal.sessionOwnerId,
		sourceHead: proposal.sourceHead, targetHead: proposal.targetHead, mergeBase: proposal.mergeBase, diffFingerprint: proposal.diffFingerprint,
		commitMessage: proposal.commitMessage, author: proposal.author, committer: proposal.committer,
		resultingHead: null, changedPaths: [], conflictedPaths: [], failureCode: null };
}
function applyingBinding(receipt: ReturnType<typeof makeReceipt>) { const { operationId, proposalId, proposalFingerprint, integrationOwnerId, sessionOwnerId, sourceHead, targetHead, mergeBase, diffFingerprint, commitMessage, author, committer } = receipt; return { operationId, proposalId, proposalFingerprint, integrationOwnerId, sessionOwnerId, sourceHead, targetHead, mergeBase, diffFingerprint, commitMessage, author, committer }; }
