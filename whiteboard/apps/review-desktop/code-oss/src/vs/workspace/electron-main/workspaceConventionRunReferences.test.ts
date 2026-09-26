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

test('convention agent attempts may cite project snapshots without altering task links; task runs still require links', () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-convention-attempt-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const one = database.createProjectWorkspace('One', directory, 'file:///one.code-workspace');
		const two = database.createProjectWorkspace('Two', directory, 'file:///two.code-workspace');
		const task = database.createTask({ projectId: one.project.id, bindingId: one.binding.id, title: 'Organize the project' });
		const source = database.knowledge.importReference({
			projectId: one.project.id, connectorId: 'manual-text', connectorVersion: '1', externalId: 'one',
			title: 'Team rules', contentType: 'text/plain; charset=utf-8', content: Buffer.from('Use clear names.'),
		});
		const other = database.knowledge.importReference({
			projectId: two.project.id, connectorId: 'manual-text', connectorVersion: '1', externalId: 'two',
			title: 'Other rules', contentType: 'text/plain; charset=utf-8', content: Buffer.from('Other project.'),
		});
		const base = {
			taskId: task.id, provider: 'codex' as const, profileRef: 'local-default-codex', folderIdentity: 'test',
			cwd: directory, prompt: 'Summarize the project conventions.',
		};
		const attempt = database.createProviderAttempt({ ...base, purpose: 'connectionTest', mode: 'convention-draft', refSnapshotIds: [source.id] });
		assert.deepEqual(attempt.refSnapshotIds, [source.id]);
		assert.deepEqual(database.knowledge.listTaskReferences(task.id), []);
		assert.throws(() => database.createProviderAttempt({ ...base, purpose: 'connectionTest', mode: 'convention-check', refSnapshotIds: [other.id] }), /belong to its project/);
		assert.throws(() => database.createProviderAttempt({ ...base, purpose: 'task', mode: 'mutating', refSnapshotIds: [source.id] }), /linked to its task/);
		assert.throws(() => database.finishConventionDraftAttempt({
			attemptId: attempt.attemptId, providerSessionId: null, projectId: one.project.id,
			provider: 'codex', markdown: '# Project rules\n\nUse clear names.', sourceSnapshotIds: [other.id],
		}), /unavailable in this project/);
		assert.equal(database.getProviderAttempt(attempt.attemptId)?.state, 'queued', 'failed artifact insert must roll back success');
		assert.deepEqual(database.knowledge.listConventions(one.project.id), []);
		const draft = database.finishConventionDraftAttempt({
			attemptId: attempt.attemptId, providerSessionId: null, projectId: one.project.id,
			provider: 'codex', markdown: '# Project rules\n\nUse clear names.', sourceSnapshotIds: [source.id],
		});
		assert.equal(draft.attempt.state, 'succeeded');
		assert.equal(database.knowledge.readConvention(draft.version.id)?.authorAttemptId, attempt.attemptId);
		const check = database.createProviderAttempt({ ...base, purpose: 'connectionTest', mode: 'convention-check', conventionSnapshotId: draft.version.id, refSnapshotIds: [source.id] });
		assert.throws(() => database.finishConventionCheckAttempt({
			attemptId: check.attemptId, providerSessionId: null, provider: 'codex',
			versionId: other.id, verdict: 'pass', report: 'Checked.',
		}), /Convention version is unavailable/);
		assert.equal(database.getProviderAttempt(check.attemptId)?.state, 'queued');
		const checked = database.finishConventionCheckAttempt({
			attemptId: check.attemptId, providerSessionId: null, provider: 'codex',
			versionId: draft.version.id, verdict: 'pass', report: 'Checked.',
		});
		assert.equal(checked.attempt.state, 'succeeded');
		assert.equal(database.knowledge.listConventionChecks(draft.version.id)[0]?.attemptId, check.attemptId);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
