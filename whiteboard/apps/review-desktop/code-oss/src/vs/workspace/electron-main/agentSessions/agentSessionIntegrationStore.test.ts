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
import type { AgentSessionContentSnapshot } from './agentSessionContentCapture.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';

test('commit proposal binds exact turn evidence and explanation revisions; approval and outcomes are durable and guarded', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-agent-session-integration-'));
	const folder = join(directory, 'session-worktree');
	mkdirSync(folder);
	const databasePath = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(databasePath);
	try {
		const project = database.createProject('Commit review');
		const binding = database.createFolderBinding({ projectId: project.id, path: folder });
		const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Session worktree', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'gitWorktree' });
		const canonicalFolder = realpathSync(folder);
		const identity = statSync(canonicalFolder, { bigint: true });
		const folderIdentity = { canonicalPath: canonicalFolder, dev: identity.dev.toString(), ino: identity.ino.toString() };
		const snapshot: AgentSessionTurnSnapshot = {
			schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: null,
			provider: session.provider, model: session.model, profileRef: null, cwd: canonicalFolder, folderIdentity,
			managedWorktreeOwnerId: session.id, permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [],
		};
		let turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
		const scope = { projectId: project.id, sessionId: session.id, turnId: turn.id };
		const makeCapture = (content: string, capturedAt: string): AgentSessionContentSnapshot => ({
			schemaVersion: 1, folderIdentity, capturedAt, inventoryCoverage: 'complete', contentCoverage: 'complete', entryCount: 1,
			fileBytes: Buffer.byteLength(content, 'utf8'), retainedTextBytes: Buffer.byteLength(content, 'utf8'), contentReadCount: 1,
			entries: [{ path: 'src/change.ts', kind: 'file', size: Buffer.byteLength(content, 'utf8'), sha256: createHash('sha256').update(content, 'utf8').digest('hex'), content }],
		});
		database.agentSessionContents.recordBaseline({ scope, snapshot: makeCapture('before\n', '2026-10-19T00:00:00.000Z'), revision: '1'.repeat(40) });
		const currentSession = database.agentSessions.getSession(project.id, session.id)!;
		const running = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, currentSession.revision, { state: 'running' });
		database.agentSessionContents.recordAfter({ scope, snapshot: makeCapture('after\n', '2026-10-19T00:01:00.000Z'), expectedLatestVersion: 0, revision: '2'.repeat(40), cleanupVerified: true });
		turn = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, running.turn.revision, running.session.revision, { state: 'exited', exitCode: 0, cleanupVerified: true }).turn;
		const evidence = database.agentSessionChangeEvidence.getLatest(project.id, session.id, turn.id)!;
		const explanationTarget = { ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'src/change.ts', hunkId: null };
		const explanation = database.agentSessionReviews.recordHumanExplanation({ target: explanationTarget, expectedLatestRevision: 0, what: 'Changed the value.', why: 'The reviewed request requires this value.', citations: [], checkClaims: [], status: 'confirmed' });
		const proposalInput = {
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint,
			sourceHead: 'a'.repeat(40), proposedGitTreeHash: 'b'.repeat(40), diffFingerprint: 'c'.repeat(64), commitMessage: 'Implement the reviewed change',
			author: { name: 'Review Author', email: 'author@example.test', date: '1792416000 +0900' },
			committer: { name: 'Review Committer', email: 'committer@example.test', date: '1792416060 +0900' },
			paths: [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }], expectedLatestRevision: 0,
		};
		const proposal = database.agentSessionIntegrations.createProposal(proposalInput);
		assert.equal(proposal.kind, 'commit');
		assert.equal(proposal.sessionWorktreeOwnerId, session.id);
		assert.equal(proposal.paths[0]?.beforeMetadataSha256?.length, 64);
		assert.equal(proposal.paths[0]?.afterMetadataSha256?.length, 64);
		assert.equal(proposal.paths[0]?.explanations[0]?.id, explanation.id);
		assert.deepEqual(proposal.author, proposalInput.author);
		assert.deepEqual(proposal.committer, proposalInput.committer);
		assert.equal(proposal.state, 'pending');
		assert.equal(database.agentSessionIntegrations.createProposal(proposalInput).id, proposal.id);
		assert.throws(() => database.agentSessionIntegrations.createProposal({ ...proposalInput, paths: [{ path: 'outside.ts', explanationTargets: [{ path: 'outside.ts', hunkId: null, revision: 1 }] }] }), /not part of the exact change evidence/);
		assert.throws(() => database.agentSessionIntegrations.createProposal({ ...proposalInput, projectId: randomUUID() }), /durable turn/);
		assert.throws(() => database.agentSessionIntegrations.createProposal({ ...proposalInput, actor: 'human' } as never), /unknown fields/);
		assert.throws(() => database.agentSessionIntegrations.createProposal({ ...proposalInput, author: { ...proposalInput.author, date: '01792416000 +0900' } }), /raw Git date is invalid/);
		assert.throws(() => database.agentSessionIntegrations.createProposal({ ...proposalInput, committer: { ...proposalInput.committer, email: 'commit>ter@example.test' } }), /committer email is invalid/);
		assert.throws(() => database.agentSessionIntegrations.createProposal({ ...proposalInput, author: { ...proposalInput.author, actor: 'human' } } as never), /unknown fields/);
		assert.throws(() => database.agentSessionIntegrations.recordOutcome({
			proposalId: proposal.id, expectedOutcomeRevision: 0, state: 'applying', action: 'commit', receipt: makeReceipt(proposal),
		}), /requires a trusted human proposal approval/);
		const approval = database.agentSessionIntegrations.recordTrustedHumanApproval(proposal.id, proposal.revision);
		assert.equal(approval.actor, 'human');
		assert.equal(approval.proposalFingerprint, proposal.fingerprint);
		assert.equal(database.agentSessionIntegrations.recordTrustedHumanApproval(proposal.id, proposal.revision).id, approval.id);
		const applyingReceipt = makeReceipt(proposal, randomUUID(), 'd'.repeat(40));
		const applyingInput = { proposalId: proposal.id, expectedOutcomeRevision: 0, state: 'applying' as const, action: 'commit' as const, receipt: applyingReceipt };
		const applying = database.agentSessionIntegrations.recordOutcome(applyingInput);
		assert.equal(applying.revision, 1);
		assert.equal(database.agentSessionIntegrations.recordOutcome(applyingInput).id, applying.id);
		assert.throws(() => database.agentSessionIntegrations.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 1, state: 'applying', action: 'commit', receipt: makeReceipt(proposal) }), /requires one terminal/);
		assert.throws(() => database.agentSessionIntegrations.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 1, state: 'failed', action: 'commit', receipt: { ...applyingReceipt, operationId: randomUUID(), failureCode: 'commit.rejected' } }), /operation ID and candidate HEAD/);
		assert.throws(() => database.agentSessionIntegrations.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 1, state: 'failed', action: 'commit', receipt: { ...applyingReceipt, candidateHead: 'e'.repeat(40), failureCode: 'commit.rejected' } }), /operation ID and candidate HEAD/);
		const failedReceipt = { ...applyingReceipt, failureCode: 'commit.rejected' };
		const failed = database.agentSessionIntegrations.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 1, state: 'failed', action: 'commit', receipt: failedReceipt });
		assert.equal(failed.state, 'failed');
		assert.equal(failed.receipt.operationId, applying.receipt.operationId);
		assert.throws(() => database.agentSessionIntegrations.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 2, state: 'applying', action: 'commit', receipt: makeReceipt(proposal) }), /explicitly reference the exact/);
		const retryReceipt = makeReceipt(proposal, randomUUID(), applyingReceipt.candidateHead);
		const retry = database.agentSessionIntegrations.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 2, state: 'applying', action: 'commit', receipt: retryReceipt, retryOfOutcomeId: failed.id });
		assert.equal(retry.revision, 3);
		assert.throws(() => database.agentSessionIntegrations.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 3, state: 'succeeded', action: 'commit', receipt: { ...retryReceipt, resultingHead: 'e'.repeat(40), changedPaths: ['src/change.ts'] } }), /exact candidate HEAD/);
		const succeededReceipt = { ...retryReceipt, resultingHead: retryReceipt.candidateHead, changedPaths: ['src/change.ts'] };
		const succeeded = database.agentSessionIntegrations.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: 3, state: 'succeeded', action: 'commit', receipt: succeededReceipt });
		assert.equal(succeeded.state, 'succeeded');
		assert.equal(succeeded.receipt.operationId, retry.receipt.operationId);
		assert.equal(succeeded.receipt.candidateHead, retry.receipt.candidateHead);
		assert.equal(database.agentSessionIntegrations.getProposal(proposal.id)?.state, 'succeeded');
		assert.throws(() => database.agentSessionIntegrations.createProposal({ ...proposalInput, expectedLatestRevision: 0, diffFingerprint: 'e'.repeat(64) }), /stale/);
		const secondProposal = database.agentSessionIntegrations.createProposal({ ...proposalInput, expectedLatestRevision: 1, author: { ...proposalInput.author, name: 'Alternate Author' } });
		const thirdProposal = database.agentSessionIntegrations.createProposal({ ...proposalInput, expectedLatestRevision: 2 });
		assert.equal(secondProposal.revision, 2);
		assert.equal(thirdProposal.revision, 3);
		assert.notEqual(thirdProposal.id, proposal.id);
		assert.notEqual(secondProposal.fingerprint, proposal.fingerprint);
		assert.equal(thirdProposal.author.name, proposal.author.name);
		assert.notEqual(thirdProposal.id, secondProposal.id);
		const originalNow = Date.now;
		try {
			Date.now = () => Date.parse(proposal.expiresAt) + 1;
			assert.deepEqual(database.agentSessionIntegrations.recordTrustedHumanApproval(proposal.id, proposal.revision), approval);
		} finally { Date.now = originalNow; }
		assert.equal(database.agentSessions.getSession(project.id, session.id)?.state, 'idle');
		const raw = new DatabaseSync(databasePath);
		try {
			assert.throws(() => raw.prepare('UPDATE agent_session_integration_proposals SET payload_json = ? WHERE id = ?').run('{}', proposal.id), /immutable/);
			assert.throws(() => raw.prepare('DELETE FROM agent_session_integration_approvals WHERE proposal_id = ?').run(proposal.id), /immutable/);
			assert.throws(() => raw.prepare('UPDATE agent_session_integration_outcomes SET state = ? WHERE id = ?').run('failed', succeeded.id), /immutable/);
			assert.equal(raw.prepare('SELECT actor FROM agent_session_integration_approvals WHERE proposal_id = ?').get(proposal.id)?.actor, 'human');
		} finally { raw.close(); }
		database.close();
		database = WorkspaceDatabase.open(databasePath);
		const reopenedProposal = database.agentSessionIntegrations.getProposal(proposal.id)!;
		assert.deepEqual(reopenedProposal, { ...proposal, approval, state: 'succeeded', outcomes: [applying, failed, retry, succeeded] });
		assert.equal(reopenedProposal.outcomes[0]?.receipt.candidateHead, applyingReceipt.candidateHead);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

function makeReceipt(proposal: { readonly sourceHead: string; readonly proposedGitTreeHash: string; readonly diffFingerprint: string }, operationId = randomUUID(), candidateHead = 'd'.repeat(proposal.sourceHead.length)) {
	return { operationId, sourceHead: proposal.sourceHead, proposedGitTreeHash: proposal.proposedGitTreeHash, diffFingerprint: proposal.diffFingerprint, candidateHead, resultingHead: null, changedPaths: [], failureCode: null };
}
