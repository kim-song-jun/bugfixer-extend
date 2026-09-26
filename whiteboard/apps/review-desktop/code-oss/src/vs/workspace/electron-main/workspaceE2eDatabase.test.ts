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

test('frontend E2E evidence persists its pre-open snapshots and requires artifact hashes plus cleanup receipt', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-e2e-db-'));
	const path = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(path);
	try {
		const project = database.createProject('E2E');
		const binding = database.createFolderBinding({ projectId: project.id, path: '/checkout/project', vcsKind: 'git', vcsRoot: '/checkout' });
		const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Verify checkout' });
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'local-profile', folderIdentity: 'dev:ino', cwd: '/checkout/project', mode: 'mutating', prompt: 'run tests' });
		const evidence = database.createWorkspaceE2eEvidence({ projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'native-macos:dev', scenario: [{ type: 'assertText', selector: 'h1', value: 'Ready' }], taskSpaceId: 42 });
		assert.equal(JSON.parse(evidence.checkoutSnapshot).vcsRoot, '/checkout');
		assert.equal(JSON.parse(evidence.requesterSnapshot).attemptId, attempt.attemptId);
		assert.throws(() => database.finishWorkspaceE2eEvidence({ id: evidence.id, state: 'passed', screenshotSha256: null, screenshotPath: null, logSha256: null, logPath: null, failure: null, cleanupError: null }), /requires artifacts/);
		const captureFailure = database.createWorkspaceE2eEvidence({ projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'native-macos:dev', scenario: [{ type: 'assertText', selector: 'h1', value: 'Ready' }], taskSpaceId: 43 });
		const failed = database.finishWorkspaceE2eEvidence({ id: captureFailure.id, state: 'failed', screenshotSha256: null, screenshotPath: null, logSha256: null, logPath: null, failure: 'Ego closed, but the screenshot could not be saved.', cleanupError: null });
		assert.equal(failed.state, 'failed');
		assert.equal(failed.cleanupError, null);
		assert.equal(failed.screenshotPath, null);
		const complete = database.finishWorkspaceE2eEvidence({ id: evidence.id, state: 'passed', screenshotSha256: 'a'.repeat(64), screenshotPath: '/artifacts/shot.png', logSha256: 'b'.repeat(64), logPath: '/artifacts/log.json', failure: null, cleanupError: null });
		assert.equal(complete.state, 'passed');
		database.close();
		database = WorkspaceDatabase.open(path);
		assert.deepEqual(database.getWorkspaceE2eEvidence(evidence.id), complete);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
