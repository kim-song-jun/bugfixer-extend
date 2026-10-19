/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import type { AgentSessionPublicationHostCreateInput } from './agentSessionPublicationStore.js';
import type { AgentSessionContentSnapshot } from './agentSessionContentCapture.js';

export interface MergedPublicationFixtureOptions {
	readonly baseOid?: string;
	readonly resultOid?: string;
}

export interface MergedPublicationFixture {
	readonly sourcePath: string;
	readonly sourceMergeId: string;
	readonly input: AgentSessionPublicationHostCreateInput;
	dispose(): void;
}

/** Builds a genuine workspace DB with a successful MergeStore receipt and artifact chain. */
export function createMergedPublicationFixture(options: MergedPublicationFixtureOptions = {}): MergedPublicationFixture {
	const baseOid = options.baseOid ?? 'e'.repeat(40);
	const resultOid = options.resultOid ?? 'f'.repeat(40);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(baseOid) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(resultOid) || baseOid.length !== resultOid.length) {
		throw new TypeError('Publication fixture requires full Git OIDs using one object format.');
	}
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-publication-store-'));
	const repositoryPath = join(directory, 'repo'); mkdirSync(repositoryPath);
	const sourcePath = join(directory, 'source.db'); const source = WorkspaceDatabase.open(sourcePath);
	try {
		const project = source.createProject('Publication source');
		const binding = source.createFolderBinding({ projectId: project.id, path: repositoryPath, vcsKind: 'git', vcsRoot: repositoryPath });
		const session = source.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Source', provider: 'codex', model: 'fixture', workspaceMode: 'gitWorktree' });
		const canonical = realpathSync(repositoryPath); const identity = statSync(canonical, { bigint: true });
		const folderIdentity = { canonicalPath: canonical, dev: identity.dev.toString(), ino: identity.ino.toString() };
		const snapshot: AgentSessionTurnSnapshot = { schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: null,
			provider: session.provider, model: session.model, profileRef: null, cwd: canonical, folderIdentity, managedWorktreeOwnerId: session.id,
			permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [] };
		let turn = source.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
		const scope = { projectId: project.id, sessionId: session.id, turnId: turn.id };
		const capture = (content: string, capturedAt: string): AgentSessionContentSnapshot => ({ schemaVersion: 1, folderIdentity, capturedAt, inventoryCoverage: 'complete', contentCoverage: 'complete', entryCount: 1,
			fileBytes: Buffer.byteLength(content), retainedTextBytes: Buffer.byteLength(content), contentReadCount: 1,
			entries: [{ path: 'src/change.ts', kind: 'file', size: Buffer.byteLength(content), sha256: digest(content), content }] });
		source.agentSessionContents.recordBaseline({ scope, snapshot: capture('before\n', '2026-10-19T00:00:00.000Z'), revision: '1'.repeat(40) });
		let currentSession = source.agentSessions.getSession(project.id, session.id)!;
		const running = source.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, currentSession.revision, { state: 'running' });
		source.agentSessionContents.recordAfter({ scope, snapshot: capture('after\n', '2026-10-19T00:01:00.000Z'), expectedLatestVersion: 0, revision: '2'.repeat(40), cleanupVerified: true });
		currentSession = source.agentSessions.getSession(project.id, session.id)!;
		turn = source.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, running.turn.revision, currentSession.revision, { state: 'exited', exitCode: 0, cleanupVerified: true }).turn;
		const evidence = source.agentSessionChangeEvidence.getLatest(project.id, session.id, turn.id)!;
		const explanation = source.agentSessionReviews.recordHumanExplanation({ target: { ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'src/change.ts', hunkId: null },
			expectedLatestRevision: 0, what: 'Updated source.', why: 'Requested behavior.', citations: [], checkClaims: [], status: 'confirmed' });
		const commit = source.agentSessionIntegrations.createProposal({ ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, sourceHead: 'a'.repeat(baseOid.length),
			proposedGitTreeHash: 'b'.repeat(baseOid.length), diffFingerprint: 'c'.repeat(64), commitMessage: 'Commit reviewed source', author: { name: 'Author', email: 'author@example.test', date: '1792416000 +0900' },
			committer: { name: 'Committer', email: 'committer@example.test', date: '1792416060 +0900' }, paths: [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }], expectedLatestRevision: 0 });
		source.agentSessionIntegrations.recordTrustedHumanApproval(commit.id, commit.revision);
		const commitOperation = randomUUID(); const commitReceipt = { operationId: commitOperation, sourceHead: commit.sourceHead, proposedGitTreeHash: commit.proposedGitTreeHash,
			diffFingerprint: commit.diffFingerprint, candidateHead: 'd'.repeat(baseOid.length), resultingHead: null, changedPaths: [], failureCode: null };
		source.agentSessionIntegrations.recordOutcome({ proposalId: commit.id, expectedOutcomeRevision: 0, state: 'applying', action: 'commit', receipt: commitReceipt });
		source.agentSessionIntegrations.recordOutcome({ proposalId: commit.id, expectedOutcomeRevision: 1, state: 'succeeded', action: 'commit', receipt: { ...commitReceipt, resultingHead: 'd'.repeat(baseOid.length), changedPaths: ['src/change.ts'] } });
		const integrationOwnerId = source.agentSessionMerges.getOrCreateIntegrationOwner(project.id, binding.id);
		const mergeText = 'diff --git a/src/change.ts b/src/change.ts\n+after\n';
		const merge = source.agentSessionMerges.createProposal({ ...scope, commitProposalId: commit.id, commitProposalRevision: commit.revision, commitProposalFingerprint: commit.fingerprint,
			integrationOwnerId, sourceHead: 'd'.repeat(baseOid.length), targetHead: baseOid, mergeBase: '1'.repeat(baseOid.length), diffFingerprint: digest(mergeText), diffText: mergeText,
			commitMessage: `Merge reviewed session ${session.id}`, author: { name: 'Merge Author', email: 'author@example.test', date: '1792416000 +0900' },
			committer: { name: 'Merge Committer', email: 'committer@example.test', date: '1792416060 +0900' }, changedPaths: ['src/change.ts'], expectedLatestRevision: 0 });
		source.agentSessionMerges.recordTrustedHumanApproval(merge.id, merge.revision, merge.fingerprint);
		const mergeOperation = randomUUID(); const receipt = { operationId: mergeOperation, proposalId: merge.id, proposalFingerprint: merge.fingerprint, integrationOwnerId,
			sessionOwnerId: session.id, sourceHead: merge.sourceHead, targetHead: merge.targetHead, mergeBase: merge.mergeBase, diffFingerprint: merge.diffFingerprint, commitMessage: merge.commitMessage,
			author: merge.author, committer: merge.committer, resultingHead: null, changedPaths: [], conflictedPaths: [], failureCode: null };
		const applying = source.agentSessionMerges.recordOutcome({ proposalId: merge.id, expectedOutcomeRevision: 0, state: 'applying', receipt });
		const generationId = randomUUID(); const generationPath = `integration/generations/${generationId}`; const registrationId = randomUUID();
		const events = [
			{ phase: 'intent' as const, generationId, generationPath, registrationId, priorGeneration: null },
			{ phase: 'candidatePrepared' as const, candidateTreeOid: '2'.repeat(baseOid.length), candidateCommitOid: resultOid, outcome: 'clean' as const, conflicts: [] },
			{ phase: 'generationRegistered' as const, generationPath, registrationId },
			{ phase: 'generationMaterialized' as const, head: resultOid, indexDigest: '3'.repeat(64), treeDigest: '4'.repeat(64), conflictDigest: null },
			{ phase: 'published' as const, targetRef: `refs/heads/bugfixer/integration/${integrationOwnerId}`, resultingHead: resultOid, currentGenerationId: generationId, priorGenerationId: null },
		];
		events.forEach((event, revision) => source.agentSessionMerges.recordArtifact(mergeOperation, revision, event));
		source.agentSessionMerges.recordOutcome({ proposalId: merge.id, expectedOutcomeRevision: 1, state: 'merged', receipt: { ...receipt, resultingHead: resultOid, changedPaths: ['src/change.ts'] }, retryOfOutcomeId: applying.id });
		const result = source.agentSessionMerges.getProposal(merge.id)!;
		const publicationText = 'diff --git a/src/change.ts b/src/change.ts\n+after\n';
		const input: AgentSessionPublicationHostCreateInput = {
			projectId: project.id, sessionId: session.id, turnId: turn.id, sourceMergeId: merge.id, remoteName: 'origin', baseRef: 'refs/heads/main', accountRef: 'gh-account-primary',
			title: 'Review source update', body: 'This draft publishes the reviewed merge.', expectedRevision: 0,
			sourceMerge: { projectId: project.id, bindingId: binding.id, sessionId: session.id, turnId: turn.id, mergeProposalId: result.id, mergeRevision: result.revision,
				mergeFingerprint: result.fingerprint, mergeOperationId: mergeOperation, integrationOwnerId, resultCommit: resultOid },
			remote: { name: 'origin', canonicalUrl: 'https://github.com/acme/widget.git', host: 'github.com', repositoryId: 'R_kgDOExample', owner: 'acme', repository: 'widget', visibility: 'private', writable: true },
			account: { accountRef: 'gh-account-primary', stableId: '12345678', login: 'reviewer', host: 'github.com' },
			base: { ref: 'refs/heads/main', oid: baseOid },
			diff: { baseCommit: baseOid, headCommit: resultOid, text: publicationText, fingerprint: digest(publicationText), paths: [{ path: 'src/change.ts', status: 'modified', previousPath: null, explanationReferences: [], checkReferences: [], unknowns: ['CI status is not available in this fixture.'] }] },
		};
		source.close();
		return { sourcePath, sourceMergeId: merge.id, input, dispose: () => rmSync(directory, { recursive: true, force: true }) };
	} catch (error) { source.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
}

function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
