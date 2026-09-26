/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readWorkspaceE2eCheckoutRevision } from './workspaceE2eCheckoutRevision.js';

test('E2E checkout snapshot reads the exact checked-out Git commit and identifies ordinary folders', async () => {
	const root = mkdtempSync(join(tmpdir(), 'workspace-e2e-checkout-revision-'));
	try {
		execFileSync('git', ['-C', root, 'init', '-q']);
		execFileSync('git', ['-C', root, 'config', 'user.name', 'E2E test']);
		execFileSync('git', ['-C', root, 'config', 'user.email', 'e2e@example.invalid']);
		writeFileSync(join(root, 'tracked.txt'), 'committed content\n');
		execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
		execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'initial snapshot']);
		const expectedRevision = execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' }).trim();
		assert.deepEqual(await readWorkspaceE2eCheckoutRevision({ vcsKind: 'git', vcsRoot: root }), { revision: expectedRevision, unavailableReason: null });
		assert.deepEqual(await readWorkspaceE2eCheckoutRevision({ vcsKind: null, vcsRoot: null }), { revision: null, unavailableReason: 'This task uses an ordinary folder without Git or jj revision history.' });
		await assert.rejects(readWorkspaceE2eCheckoutRevision({ vcsKind: 'svn', vcsRoot: root } as never), /unsupported version control kind/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
