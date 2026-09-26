/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceDatabase } from './workspaceDatabase.js';

test('ordinary-folder mutation grant pins the real folder and is revoked on rebind', () => {
	const directory = mkdtempSync(join(tmpdir(), 'folder-mutation-grant-'));
	const first = join(directory, 'first');
	const second = join(directory, 'second');
	const alias = join(directory, 'project');
	mkdirSync(first);
	mkdirSync(second);
	symlinkSync(first, alias);
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const { project, binding } = database.createProjectWorkspace('Ordinary', alias, 'file:///ordinary.code-workspace');
		assert.equal(database.getOrdinaryFolderMutationGrant(project.id, binding.id), undefined);
		const grant = database.enableOrdinaryFolderMutation(project.id, binding.id);
		const stats = statSync(realpathSync(alias), { bigint: true });
		assert.equal(grant.canonicalPath, realpathSync(first));
		assert.equal(database.isOrdinaryFolderMutationEnabled(project.id, binding.id, realpathSync(first), stats.dev.toString(), stats.ino.toString()), true);
		assert.equal(database.hasCurrentOrdinaryFolderMutationGrant(project.id, binding.id), true);
		rmSync(alias);
		symlinkSync(second, alias);
		const retargeted = statSync(realpathSync(alias), { bigint: true });
		assert.equal(database.isOrdinaryFolderMutationEnabled(project.id, binding.id, realpathSync(second), retargeted.dev.toString(), retargeted.ino.toString()), false);
		assert.equal(database.hasCurrentOrdinaryFolderMutationGrant(project.id, binding.id), false);
		database.rebindProjectFolder(project.id, second, alias);
		assert.equal(database.getOrdinaryFolderMutationGrant(project.id, binding.id), undefined);
		const rebound = database.enableOrdinaryFolderMutation(project.id, binding.id);
		assert.equal(rebound.canonicalPath, realpathSync(second));
		database.revokeOrdinaryFolderMutation(project.id, binding.id);
		assert.equal(database.getOrdinaryFolderMutationGrant(project.id, binding.id), undefined);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
