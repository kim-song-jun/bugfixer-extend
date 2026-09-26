/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceDatabase } from './workspaceDatabase.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

test('frontend E2E evidence persists its pre-open snapshots and requires artifact hashes plus cleanup receipt', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-e2e-db-'));
	const path = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(path);
	try {
		const project = database.createProject('E2E');
		const binding = database.createFolderBinding({ projectId: project.id, path: '/checkout/project', vcsKind: 'git', vcsRoot: '/checkout' });
		const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Verify checkout' });
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'local-profile', folderIdentity: 'dev:ino', cwd: '/checkout/project', mode: 'mutating', prompt: 'run tests' });
		const evidence = database.createWorkspaceE2eEvidence({ projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'native-macos:dev', scenario: [{ type: 'assertText', selector: 'h1', value: 'Ready' }], taskSpaceId: 42, checkoutRevision: 'a'.repeat(40), checkoutRevisionUnavailableReason: null });
		assert.equal(JSON.parse(evidence.checkoutSnapshot).vcsRoot, '/checkout');
		assert.equal(evidence.checkoutRevision, 'a'.repeat(40));
		assert.equal(evidence.checkoutRevisionUnavailableReason, null);
		assert.equal(JSON.parse(evidence.requesterSnapshot).attemptId, attempt.attemptId);
		assert.throws(() => database.finishWorkspaceE2eEvidence({ id: evidence.id, state: 'passed', screenshotSha256: null, screenshotPath: null, logSha256: null, logPath: null, failure: null, cleanupError: null }), /requires artifacts/);
		const captureFailure = database.createWorkspaceE2eEvidence({ projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'native-macos:dev', scenario: [{ type: 'assertText', selector: 'h1', value: 'Ready' }], taskSpaceId: 43, checkoutRevision: 'a'.repeat(40), checkoutRevisionUnavailableReason: null });
		const failed = database.finishWorkspaceE2eEvidence({ id: captureFailure.id, state: 'failed', screenshotSha256: null, screenshotPath: null, logSha256: null, logPath: null, failure: 'Ego closed, but the screenshot could not be saved.', cleanupError: null });
		assert.equal(failed.state, 'failed');
		assert.equal(failed.cleanupError, null);
		assert.equal(failed.screenshotPath, null);
		const complete = database.finishWorkspaceE2eEvidence({ id: evidence.id, state: 'passed', screenshotSha256: 'a'.repeat(64), screenshotPath: '/artifacts/shot.png', logSha256: 'b'.repeat(64), logPath: '/artifacts/log.json', failure: null, cleanupError: null });
		assert.equal(complete.state, 'passed');
		database.close();
		database = WorkspaceDatabase.open(path);
		assert.deepEqual(database.getWorkspaceE2eEvidence(evidence.id), complete);
		const ordinaryBinding = database.createFolderBinding({ projectId: project.id, path: '/ordinary/project' });
		const ordinaryTask = database.createTask({ projectId: project.id, bindingId: ordinaryBinding.id, title: 'Check ordinary folder' });
		const ordinaryAttempt = database.createProviderAttempt({ taskId: ordinaryTask.id, provider: 'codex', purpose: 'task', profileRef: 'local-profile', folderIdentity: 'dev:ordinary', cwd: '/ordinary/project', mode: 'mutating', prompt: 'run tests' });
		const ordinaryEvidence = database.createWorkspaceE2eEvidence({ projectId: project.id, taskId: ordinaryTask.id, attemptId: ordinaryAttempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'native-macos:dev', scenario: [{ type: 'assertText', selector: 'h1', value: 'Ready' }], taskSpaceId: 44, checkoutRevision: null, checkoutRevisionUnavailableReason: 'This task uses an ordinary folder without Git or jj revision history.' });
		assert.equal(ordinaryEvidence.checkoutRevision, null);
		assert.match(ordinaryEvidence.checkoutRevisionUnavailableReason ?? '', /ordinary folder/);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('v16 E2E rows migrate with an explicit unavailable checkout-revision reason', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-e2e-db-migration-'));
	const path = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(path);
	try {
		const project = database.createProject('E2E migration');
		const binding = database.createFolderBinding({ projectId: project.id, path: '/checkout/project' });
		const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Legacy evidence' });
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: null, folderIdentity: 'dev:ino', cwd: '/checkout/project', mode: 'mutating', prompt: 'run check' });
		const evidence = database.createWorkspaceE2eEvidence({ projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'native-macos:dev', scenario: [{ type: 'assertText', selector: 'h1', value: 'Ready' }], taskSpaceId: 52, checkoutRevision: null, checkoutRevisionUnavailableReason: 'This task uses an ordinary folder without Git or jj revision history.' });
		database.close();

		const legacyDb = new DatabaseSync(path);
		try {
			legacyDb.exec('ALTER TABLE frontend_e2e_evidence DROP COLUMN checkout_revision; ALTER TABLE frontend_e2e_evidence DROP COLUMN checkout_revision_unavailable_reason; PRAGMA user_version = 16;');
		} finally { legacyDb.close(); }

		database = WorkspaceDatabase.open(path);
		const migrated = database.getWorkspaceE2eEvidence(evidence.id)!;
		assert.equal(migrated.checkoutRevision, null);
		assert.match(migrated.checkoutRevisionUnavailableReason ?? '', /not available when this evidence was recorded/i);
	} finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
