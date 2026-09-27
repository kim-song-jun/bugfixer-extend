/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkspaceReferenceDTO } from '../../../workspace/common/workspaceKnowledgeProtocol.js';
import { getPackageRefreshCandidates } from './packageRefreshCandidates.js';

const packageId = 'acme-issues';
const sources = [{ sourceId: 'issue-list', label: '이슈 목록' }];

function reference(options: {
	id: string;
	sourceId: string;
	accountRef: string | null;
	externalId: string;
	version: number;
	retrievedAt: string;
}): WorkspaceReferenceDTO {
	return {
		...options,
		projectId: 'project-1',
		connectorId: `local:${packageId}`,
		connectorVersion: '1.0.0',
		sourceUri: 'https://api.example.test/issues',
		previousId: null,
		title: 'Issue list',
		contentType: 'text/plain; charset=utf-8',
		contentSha256: 'a'.repeat(64),
		omissions: [],
	};
}

test('package refresh candidates parse the account-scoped external ID and never cross accounts', () => {
	const references = [
		reference({ id: 'a-v1', sourceId: 'source-a', accountRef: 'account-a', externalId: `${packageId}:account-a:issue-list:team:open`, version: 1, retrievedAt: '2026-01-01T00:00:00.000Z' }),
		reference({ id: 'a-v2', sourceId: 'source-a', accountRef: 'account-a', externalId: `${packageId}:account-a:issue-list:team:open`, version: 2, retrievedAt: '2026-01-02T00:00:00.000Z' }),
		reference({ id: 'b-v9', sourceId: 'source-b', accountRef: 'account-b', externalId: `${packageId}:account-b:issue-list:private:closed`, version: 9, retrievedAt: '2026-01-09T00:00:00.000Z' }),
		// Legacy three-part identifiers must not be attributed to the selected account.
		reference({ id: 'legacy', sourceId: 'source-legacy', accountRef: null, externalId: `${packageId}:issue-list:legacy-key`, version: 20, retrievedAt: '2026-01-20T00:00:00.000Z' }),
	];

	const accountA = getPackageRefreshCandidates(references, packageId, sources, 'account-a');
	assert.equal(accountA.length, 1);
	assert.equal(accountA[0].reference.id, 'a-v2');
	assert.equal(accountA[0].sourceKey, 'team:open');

	const accountB = getPackageRefreshCandidates(references, packageId, sources, 'account-b');
	assert.equal(accountB.length, 1);
	assert.equal(accountB[0].reference.id, 'b-v9');
	assert.equal(accountB[0].sourceKey, 'private:closed');
});
