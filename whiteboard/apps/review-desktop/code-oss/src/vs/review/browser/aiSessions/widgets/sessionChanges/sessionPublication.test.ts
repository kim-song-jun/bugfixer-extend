/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import type { AgentSessionMergeProposalDTO } from '../../../../../workspace/common/workspaceAgentMergeProtocol.js';
import type { WorkspaceAgentPublicationScope } from '../../../../../workspace/common/workspaceAgentPublicationProtocol.js';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const dom = new JSDOM('<html><body></body></html>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'navigator'] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
registerHooks({ load(url, context, next) {
	return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { createSessionPublication } = await import('./sessionPublication.js');

test('publication requests strip structural context extras from proposal and account scopes', async () => {
	const parent = document.createElement('div');
	document.body.append(parent);
	const proposalRequests: unknown[] = [];
	const accountRequests: unknown[] = [];
	const baseScope: WorkspaceAgentPublicationScope = { projectId: 'project-exact', sessionId: 'session-exact', turnId: 'turn-exact' };
	const extendedContext = { ...baseScope, knowledgeReferences: [{ kind: 'reference', id: 'private-context' }], evidenceVersion: 3 };
	const source: AgentSessionMergeProposalDTO = {
		kind: 'merge', id: 'merge-exact', projectId: baseScope.projectId, bindingId: 'binding-exact', sessionId: baseScope.sessionId, turnId: baseScope.turnId,
		revision: 1, commitProposalId: 'commit-exact', commitProposalRevision: 1, commitProposalFingerprint: 'commit-fingerprint-exact',
		sessionOwnerId: 'session-owner-exact', integrationOwnerId: 'integration-owner-exact', sourceHead: 'a'.repeat(40), targetHead: 'b'.repeat(40), mergeBase: 'c'.repeat(40),
		diffFingerprint: 'diff-fingerprint-exact', diffText: '', commitMessage: 'Reviewed merge',
		author: { name: 'Author', email: 'author@example.test', date: '1792416000 +0900' },
		committer: { name: 'Committer', email: 'committer@example.test', date: '1792416060 +0900' }, paths: [], fingerprint: 'fingerprint-exact',
		createdAt: '2026-10-20T00:00:00.000Z', expiresAt: '2026-10-20T01:00:00.000Z', approval: null, state: 'merged',
		outcomes: [{ id: 'outcome-exact', proposalId: 'merge-exact', revision: 1, state: 'merged', retryOfOutcomeId: null, recordedAt: '2026-10-20T00:01:00.000Z', receipt: {
			operationId: 'operation-exact', proposalId: 'merge-exact', proposalFingerprint: 'fingerprint-exact', integrationOwnerId: 'integration-owner-exact', sessionOwnerId: 'session-owner-exact',
			sourceHead: 'a'.repeat(40), targetHead: 'b'.repeat(40), mergeBase: 'c'.repeat(40), diffFingerprint: 'diff-fingerprint-exact', commitMessage: 'Reviewed merge',
			author: { name: 'Author', email: 'author@example.test', date: '1792416000 +0900' }, committer: { name: 'Committer', email: 'committer@example.test', date: '1792416060 +0900' },
			resultingHead: 'd'.repeat(40), changedPaths: [], conflictedPaths: [], failureCode: null,
		} }], artifacts: [],
	};
	const publication = createSessionPublication();
	publication.render(parent, extendedContext, {
		listPublicationAccounts: async scope => {
			accountRequests.push(scope);
			return { available: false, accounts: [], reason: 'unavailable' };
		},
		listPublicationProposals: async input => {
			proposalRequests.push(input);
			return { proposals: [], nextRevision: 0, hasMore: false };
		},
		preparePublicationProposal: async () => { throw new Error('not expected'); },
		approvePublicationProposal: async () => { throw new Error('not expected'); },
		publishApprovedProposal: async () => { throw new Error('not expected'); },
		continuePublicationOperation: async () => { throw new Error('not expected'); },
		reconcilePublicationOperation: async () => { throw new Error('not expected'); },
		getPublicationOperation: async () => null,
	}, source, () => true, undefined, () => {}, () => {});
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		parent.querySelector<HTMLButtonElement>('[data-focus-key="publication-discover-account"]')?.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepEqual(proposalRequests, [{ ...baseScope, afterRevision: 0, limit: 5 }]);
		assert.deepEqual(accountRequests, [baseScope]);
	} finally {
		publication.dispose();
		parent.remove();
	}
});
