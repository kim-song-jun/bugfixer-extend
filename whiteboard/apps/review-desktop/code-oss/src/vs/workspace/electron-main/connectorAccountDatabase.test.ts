/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceDatabase } from './workspaceDatabase.js';

test('connector account activation and interrupted disconnect survive database reopen', () => {
	const directory = mkdtempSync(join(tmpdir(), 'connector-account-db-'));
	const path = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(path);
	try {
		const project = database.createProjectWorkspace('Sources', directory, 'file:///sources.code-workspace').project;
		const account = database.createPendingConnectorAccount({
			projectId: project.id, provider: 'notion', label: 'Team notes', remoteIdentity: 'notion-user-id',
		});
		assert.equal(database.listConnectorAccounts(project.id).length, 0);
		assert.equal(database.listConnectorAccountsNeedingVaultRecovery()[0].id, account.id);
		assert.equal(database.activateConnectorAccount(account.id).state, 'active');
		assert.equal(database.listConnectorAccounts(project.id)[0].id, account.id);
		assert.equal(database.beginConnectorDisconnect(account.id).state, 'disconnecting');
		database.close();
		database = WorkspaceDatabase.open(path);
		assert.equal(database.listConnectorAccountsNeedingVaultRecovery()[0].id, account.id);
		assert.equal(database.completeConnectorDisconnect(account.id).state, 'disconnected');
		assert.equal(database.listConnectorAccounts(project.id).length, 0);
		assert.equal(database.listConnectorAccountsNeedingVaultRecovery().length, 0);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
