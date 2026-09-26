/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WorkspaceDatabase, type WorkspaceProject, type WorkspaceTask } from './workspaceDatabase.js';

function withDatabase(run: (database: WorkspaceDatabase) => void): void {
	const database = WorkspaceDatabase.open(':memory:');
	try { run(database); }
	finally { database.close(); }
}

function createProjectAndTask(database: WorkspaceDatabase, name: string): { project: WorkspaceProject; task: WorkspaceTask } {
	const project = database.createProject(name);
	const binding = database.createFolderBinding({ projectId: project.id, path: `/work/${name.toLowerCase()}` });
	const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: `Task for ${name}` });
	return { project, task };
}

function createSuccessfulTaskAttempt(
	database: WorkspaceDatabase,
	task: WorkspaceTask,
	input: { provider: 'codex' | 'claude'; mode: string; conventionSnapshotId?: string | null; refSnapshotId?: string | null },
) {
	const ownedPgid = nextOwnedPgid++;
	const attempt = database.createProviderAttempt({
		taskId: task.id, provider: input.provider, purpose: 'task', profileRef: 'profile:local',
		folderIdentity: `/work/${task.projectId}`, cwd: `/work/${task.projectId}`, mode: input.mode,
		prompt: `Record ${input.mode} provenance.`, conventionSnapshotId: input.conventionSnapshotId, refSnapshotId: input.refSnapshotId,
	});
	database.setProviderAttemptRunning(attempt.attemptId, task.revision, ownedPgid);
	const runningTask = database.getTask(task.id)!;
	return database.finishProviderAttempt(attempt.attemptId, 'succeeded', `session-${attempt.attemptId}`, runningTask.revision, null, true);
}

let nextOwnedPgid = 81000;

test('reference re-collection creates immutable byte snapshots and keeps existing task links', () => {
	withDatabase(database => {
		const { project, task } = createProjectAndTask(database, 'Reference Project');
		const firstBytes = new Uint8Array([0, 255, 11, 128]);
		const first = database.knowledge.importReference({
			projectId: project.id, connectorId: 'local-files', connectorVersion: '1.0', externalId: 'document-7',
			sourceUri: 'file:///notes/brief.md', title: 'Brief v1', contentType: 'application/octet-stream', content: firstBytes,
			omissions: ['embedded image'],
		});
		database.knowledge.attachReferenceToTask(task.id, first.id);
		firstBytes.fill(0);
		first.content.fill(1);

		const secondBytes = new Uint8Array([9, 8, 7, 6]);
		const second = database.knowledge.importReference({
			projectId: project.id, connectorId: 'local-files', connectorVersion: '2.0', externalId: 'document-7',
			sourceUri: 'file:///notes/brief.md', title: 'Brief v2', contentType: 'application/octet-stream', content: secondBytes,
		});

		assert.equal(second.sourceId, first.sourceId);
		assert.equal(first.version, 1);
		assert.equal(second.version, 2);
		assert.equal(second.previousId, first.id);
		assert.deepEqual([...database.knowledge.readReference(first.id)!.content], [0, 255, 11, 128]);
		assert.deepEqual([...database.knowledge.readReference(second.id)!.content], [9, 8, 7, 6]);
		assert.notEqual(second.contentSha256, first.contentSha256);
		assert.deepEqual(database.knowledge.listTaskReferences(task.id).map(reference => reference.id), [first.id]);

		const sqlite = Reflect.get(database, 'db') as DatabaseSync;
		assert.throws(() => sqlite.prepare('UPDATE reference_snapshots SET title = ? WHERE id = ?').run('mutated', first.id), /immutable/);
		assert.equal(database.knowledge.readReference(first.id)?.title, 'Brief v1');
	});
});

test('reference snapshots hash and retain source artifact bytes separately from extracted text', () => {
	withDatabase(database => {
		const { project, task } = createProjectAndTask(database, 'Artifact Project');
		const artifact = Buffer.from('{ "ok": true, "message": "original" }', 'utf8');
		const snapshot = database.knowledge.importReference({
			projectId: project.id, connectorId: 'slack', connectorVersion: '1', externalId: 'C1234:170.1',
			accountRef: 'account_1', title: 'Thread', contentType: 'application/vnd.bugfixer.slack-source+json',
			content: artifact, derivedText: 'U1: readable message.',
		});
		const read = database.knowledge.readReference(snapshot.id)!;
		assert.deepEqual(Buffer.from(read.content), artifact);
		assert.equal(read.derivedText, 'U1: readable message.');
		assert.equal(read.contentSha256, createHash('sha256').update(artifact).digest('hex'));
		database.knowledge.attachReferenceToTask(task.id, snapshot.id);
		assert.equal('derivedText' in database.knowledge.listProjectReferences(project.id)[0], false);
		assert.equal('derivedText' in database.knowledge.listTaskReferences(task.id)[0], false);
	});
});

test('schema v15 backfills legacy readable text and round-trips new raw artifacts', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-reference-v15-'));
	const path = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(path);
	const { project } = createProjectAndTask(database, 'Migration Project');
	const legacy = database.knowledge.importReference({
		projectId: project.id, connectorId: 'manual', connectorVersion: '1', externalId: 'old-source',
		title: 'Old text', contentType: 'text/plain; charset=utf-8', content: new TextEncoder().encode('Existing text remains readable.'),
	});
	database.close();
	const legacyDatabase = new DatabaseSync(path);
	try {
		// Recreate the v14 columns and triggers, then exercise every migration from v15 onward.
		legacyDatabase.exec(`
			DROP TRIGGER provider_attempt_parent_insert;
			DROP TRIGGER provider_attempt_parent_update;
			DROP INDEX provider_attempts_parent;
			ALTER TABLE provider_attempts DROP COLUMN running_task_revision;
			ALTER TABLE provider_attempts DROP COLUMN orchestration_phase;
			ALTER TABLE provider_attempts DROP COLUMN result_sha256;
			ALTER TABLE provider_attempts DROP COLUMN result_text;
			ALTER TABLE provider_attempts DROP COLUMN child_scope_json;
			ALTER TABLE provider_attempts DROP COLUMN parent_attempt_id;
			ALTER TABLE frontend_e2e_evidence DROP COLUMN checkout_revision_unavailable_reason;
			ALTER TABLE frontend_e2e_evidence DROP COLUMN checkout_revision;
			ALTER TABLE reference_snapshots DROP COLUMN derived_text;
			PRAGMA user_version = 14;
		`);
	} finally { legacyDatabase.close(); }
	database = WorkspaceDatabase.open(path);
	try {
		assert.equal(database.knowledge.readReference(legacy.id)?.derivedText, 'Existing text remains readable.');
		const artifact = Buffer.from('{"message":"new source bytes"}');
		const current = database.knowledge.importReference({
			projectId: project.id, connectorId: 'slack', connectorVersion: '1', externalId: 'channel:1.2',
			title: 'New source', contentType: 'application/vnd.bugfixer.slack-source+json', content: artifact,
			derivedText: 'Extracted message text.',
		});
		assert.deepEqual(Buffer.from(database.knowledge.readReference(current.id)!.content), artifact);
		assert.equal(database.knowledge.readReference(current.id)!.derivedText, 'Extracted message text.');
		assert.notEqual(current.contentSha256, legacy.contentSha256);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('reference attachments and convention sources cannot cross project boundaries', () => {
	withDatabase(database => {
		const first = createProjectAndTask(database, 'First');
		const second = createProjectAndTask(database, 'Second');
		const reference = database.knowledge.importReference({
			projectId: first.project.id, connectorId: 'test-source', connectorVersion: '1', externalId: 'shared-id',
			title: 'Private source', contentType: 'text/plain', content: new TextEncoder().encode('first project only'),
		});

		assert.throws(() => database.knowledge.attachReferenceToTask(second.task.id, reference.id), /same project/);
		assert.throws(() => database.knowledge.createConventionVersion({
			projectId: second.project.id, markdown: '# Other project', sourceSnapshotIds: [reference.id], authoredBy: 'person',
		}), /source is unavailable in this project/);
		assert.deepEqual(database.knowledge.listTaskReferences(second.task.id), []);
		assert.deepEqual(database.knowledge.listProjectReferences(second.project.id), []);
	});
});

test('convention drafts, apply history, and provider attempt snapshots are durable', () => {
	withDatabase(database => {
		const { project, task } = createProjectAndTask(database, 'Conventions');
		const reference = database.knowledge.importReference({
			projectId: project.id, connectorId: 'test-source', connectorVersion: '1', externalId: 'rules-source',
			title: 'Rules source', contentType: 'text/markdown', content: new TextEncoder().encode('Source text.'),
		});
		const first = database.knowledge.createConventionVersion({
			projectId: project.id, markdown: '# Draft one\n\nKeep changes small.', sourceSnapshotIds: [reference.id], authoredBy: 'person',
		});
		assert.equal(database.knowledge.activeConvention(project.id), undefined);
		assert.equal(database.knowledge.applyConventionVersion(project.id, first.id).active, true);

		const second = database.knowledge.createConventionVersion({
			projectId: project.id, markdown: '# Draft two\n\nKeep changes reviewable.', sourceSnapshotIds: [reference.id], authoredBy: 'person',
		});
		assert.equal(database.knowledge.activeConvention(project.id)?.id, first.id);
		assert.equal(database.knowledge.applyConventionVersion(project.id, second.id).active, true);
		const versions = database.knowledge.listConventions(project.id);
		assert.deepEqual(versions.map(version => [version.version, version.active]), [[2, true], [1, false]]);
		assert.ok(versions.find(version => version.id === first.id)?.lastAppliedAt);

		const attempt = database.createProviderAttempt({
			taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'profile:local',
			folderIdentity: '/work/conventions', cwd: '/work/conventions', mode: 'execute', prompt: 'Use the approved context.',
			conventionSnapshotId: second.id, refSnapshotId: reference.id,
		});
		const storedAttempt = database.getProviderAttempt(attempt.attemptId)!;
		assert.equal(storedAttempt.conventionSnapshotId, second.id);
		assert.equal(storedAttempt.refSnapshotId, reference.id);
	});
});

test('agent-authored drafts and checks require matching successful cleaned-up provenance', () => {
	withDatabase(database => {
		const project = database.createProject('Provenance');
		const makeTask = (title: string) => {
			const binding = database.createFolderBinding({ projectId: project.id, path: `/work/${title.toLowerCase().replaceAll(' ', '-')}` });
			return database.createTask({ projectId: project.id, bindingId: binding.id, title });
		};
		const reference = database.knowledge.importReference({
			projectId: project.id, connectorId: 'test-source', connectorVersion: '1', externalId: 'input',
			title: 'Input', contentType: 'text/plain', content: new TextEncoder().encode('Use this source.'),
		});
		const authorTask = makeTask('Author');
		const genericRun = createSuccessfulTaskAttempt(database, authorTask, { provider: 'codex', mode: 'execute', refSnapshotId: reference.id });
		assert.throws(() => database.knowledge.createConventionVersion({
			projectId: project.id, markdown: '# Unproven', sourceSnapshotIds: [reference.id], authoredBy: 'codex', authorAttemptId: genericRun.attemptId,
		}), /convention-draft agent run from this project is required/);

		const draftTask = makeTask('Draft provenance');
		const authorRun = createSuccessfulTaskAttempt(database, draftTask, { provider: 'claude', mode: 'convention-draft', refSnapshotId: reference.id });
		const draft = database.knowledge.createConventionVersion({
			projectId: project.id, markdown: '# Agent draft', sourceSnapshotIds: [reference.id], authoredBy: 'claude', authorAttemptId: authorRun.attemptId,
		});
		assert.equal(draft.authorAttemptId, authorRun.attemptId);
		assert.throws(() => database.knowledge.applyConventionVersion(project.id, draft.id), /requires a passing check/);
		assert.throws(() => database.knowledge.recordConventionCheck({
			versionId: draft.id, provider: 'claude', attemptId: authorRun.attemptId, verdict: 'pass', report: 'self review',
		}), /cannot check itself/);

		const wrongModeTask = makeTask('Wrong checker mode');
		const wrongModeRun = createSuccessfulTaskAttempt(database, wrongModeTask, { provider: 'codex', mode: 'execute', conventionSnapshotId: draft.id, refSnapshotId: reference.id });
		assert.throws(() => database.knowledge.recordConventionCheck({
			versionId: draft.id, provider: 'codex', attemptId: wrongModeRun.attemptId, verdict: 'pass', report: 'generic run is not a review',
		}), /convention-check agent run from this project is required/);

		const wrongSnapshotTask = makeTask('Wrong convention snapshot');
		const wrongSnapshotRun = createSuccessfulTaskAttempt(database, wrongSnapshotTask, { provider: 'codex', mode: 'convention-check', conventionSnapshotId: 'wrong-version-id', refSnapshotId: reference.id });
		assert.throws(() => database.knowledge.recordConventionCheck({
			versionId: draft.id, provider: 'codex', attemptId: wrongSnapshotRun.attemptId, verdict: 'concerns', report: 'reviewed different snapshot',
		}), /convention-check agent run from this project is required/);

		const checkTask = makeTask('Valid checker');
		const checkRun = createSuccessfulTaskAttempt(database, checkTask, { provider: 'codex', mode: 'convention-check', conventionSnapshotId: draft.id, refSnapshotId: reference.id });
		const check = database.knowledge.recordConventionCheck({
			versionId: draft.id, provider: 'codex', attemptId: checkRun.attemptId, verdict: 'concerns', report: 'One rule needs clarification.',
		});
		assert.equal(check.attemptId, checkRun.attemptId);
		assert.deepEqual(database.knowledge.listConventionChecks(draft.id), [check]);
		assert.throws(() => database.knowledge.applyConventionVersion(project.id, draft.id), /requires a passing check/);

		const passTask = makeTask('Passing checker');
		const passRun = createSuccessfulTaskAttempt(database, passTask, { provider: 'codex', mode: 'convention-check', conventionSnapshotId: draft.id, refSnapshotId: reference.id });
		const passed = database.knowledge.recordConventionCheck({
			versionId: draft.id, provider: 'codex', attemptId: passRun.attemptId, verdict: 'pass', report: 'All guidance is supported.',
		});
		assert.deepEqual(database.knowledge.listConventionChecks(draft.id), [check, passed]);
		assert.equal(database.knowledge.applyConventionVersion(project.id, draft.id).active, true);

		const failTask = makeTask('Failed recheck');
		const failRun = createSuccessfulTaskAttempt(database, failTask, { provider: 'codex', mode: 'convention-check', conventionSnapshotId: draft.id, refSnapshotId: reference.id });
		database.knowledge.recordConventionCheck({
			versionId: draft.id, provider: 'codex', attemptId: failRun.attemptId, verdict: 'fail', report: 'A later contradiction was found.',
		});
		assert.throws(() => database.knowledge.applyConventionVersion(project.id, draft.id), /requires a passing check/);
		assert.throws(() => database.knowledge.activeConvention(project.id), /no longer has a passing latest check/);
	});
});
