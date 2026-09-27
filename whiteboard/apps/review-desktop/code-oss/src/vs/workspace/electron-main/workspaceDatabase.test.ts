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
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
	ReviewCommandConflictError,
	TaskCleanupNotVerifiedError,
	TaskRevisionConflictError,
	TaskSetRevisionConflictError,
	WorkspaceDatabase,
} from './workspaceDatabase.js';

function withDatabase(run: (path: string, database: WorkspaceDatabase) => void): void {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-workspace-db-'));
	const path = join(directory, 'workspace.db');
	const database = WorkspaceDatabase.open(path);
	try {
		run(path, database);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

function createProjectAndTask(database: WorkspaceDatabase, name = 'Project') {
	const project = database.createProject(name);
	const binding = database.createFolderBinding({ projectId: project.id, path: `/work/${name.toLowerCase()}` });
	const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Review durable storage' });
	return { project, binding, task };
}

test('projects, bindings, tasks, review links and project view persist across database reopen', () => {
	withDatabase((path, database) => {
		const { project, binding, task } = createProjectAndTask(database);
		const command = database.enqueueReviewRequest({ commandId: 'command-1', taskId: task.id, body: '{"operation":{"type":"create"}}' });
		assert.equal(command.status, 'pending');
		database.completeReviewRequest(command.commandId, 'review-1');
		database.setProjectView({ projectId: project.id, descriptorUri: 'file:///profile/projects/one.code-workspace', openAtQuit: true, selectedTaskId: task.id, dashboardPosition: '{"x":10,"y":20}' });
		database.close();

		const reopened = WorkspaceDatabase.open(path);
		try {
			assert.deepEqual(reopened.getProject(project.id), project);
			assert.deepEqual(reopened.listFolderBindings(project.id), [binding]);
			assert.deepEqual(reopened.getTask(task.id), task);
			assert.equal(reopened.getReviewCommand('command-1')?.reviewId, 'review-1');
			assert.equal(reopened.listTaskReviews(task.id)[0]?.isPrimary, true);
			assert.deepEqual(reopened.getProjectView(project.id), {
				projectId: project.id,
				descriptorUri: 'file:///profile/projects/one.code-workspace',
				openAtQuit: true,
				selectedTaskId: task.id,
				dashboardPosition: '{"x":10,"y":20}',
			});
		} finally {
			reopened.close();
		}
	});
});

test('v17 databases upgrade with project and task data intact and null recent-open time', () => {
	withDatabase((path, database) => {
		const { project, task } = createProjectAndTask(database, 'Upgrade');
		database.setProjectView({ projectId: project.id, descriptorUri: 'file:///profile/projects/upgrade.code-workspace', openAtQuit: true, selectedTaskId: task.id, dashboardPosition: null });
		database.close();

		const legacy = new DatabaseSync(path);
		try {
			legacy.exec('ALTER TABLE project_views DROP COLUMN last_opened_at; PRAGMA user_version = 17;');
		} finally { legacy.close(); }

		const upgraded = WorkspaceDatabase.open(path);
		try {
			assert.deepEqual(upgraded.getProject(project.id), project);
			assert.deepEqual(upgraded.getTask(task.id), task);
			assert.equal(upgraded.getProjectView(project.id)?.selectedTaskId, task.id);
			assert.equal(upgraded.getProjectLastOpenedAt(project.id), null);
		} finally { upgraded.close(); }
	});
});

test('open-at-quit project views are returned in stable project order and exclude closed projects', () => {
	withDatabase((_path, database) => {
		const second = database.createProject('Second');
		const first = database.createProject('First');
		database.setProjectView({ projectId: second.id, descriptorUri: 'file:///projects/second.code-workspace', openAtQuit: true, selectedTaskId: null, dashboardPosition: null });
		database.setProjectView({ projectId: first.id, descriptorUri: 'file:///projects/first.code-workspace', openAtQuit: true, selectedTaskId: null, dashboardPosition: null });
		const closed = database.createProject('Closed');
		database.setProjectView({ projectId: closed.id, descriptorUri: 'file:///projects/closed.code-workspace', openAtQuit: false, selectedTaskId: null, dashboardPosition: null });

		assert.deepEqual(database.listProjectViewsOpenAtQuit().map(view => view.projectId), [first.id, second.id].sort());
		database.setProjectOpenAtQuit(first.id, false);
		assert.deepEqual(database.listProjectViewsOpenAtQuit().map(view => view.projectId), [second.id]);
		assert.equal(database.getProjectView(first.id)?.descriptorUri, 'file:///projects/first.code-workspace');
	});
});

test('concurrent first opens serialize the initial schema migration', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-workspace-db-open-race-'));
	const path = join(directory, 'workspace.db');
	const moduleUrl = new URL('./workspaceDatabase.js', import.meta.url).href;
	const source = `import { WorkspaceDatabase } from ${JSON.stringify(moduleUrl)}; const database = WorkspaceDatabase.open(process.argv[1]); database.close();`;
	const children = [0, 1].map(() => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, path], { stdio: 'pipe' }));
	try {
		const results = await Promise.all(children.map(child => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
			let output = '';
			child.stdout.setEncoding('utf8').on('data', chunk => output += chunk);
			child.stderr.setEncoding('utf8').on('data', chunk => output += chunk);
			child.once('error', reject);
			child.once('close', code => resolve({ code, output }));
		})));
		assert.deepEqual(results.map(result => result.code), [0, 0], results.map(result => result.output).join('\n'));
		const database = WorkspaceDatabase.open(path);
		database.close();
	} finally {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); }
		}
		rmSync(directory, { recursive: true, force: true });
	}
});

test('folder bindings and selected task enforce same-project foreign keys', () => {
	withDatabase((_path, database) => {
		const first = createProjectAndTask(database, 'First');
		const second = database.createProject('Second');
		assert.throws(() => database.createTask({ projectId: second.id, bindingId: first.binding.id, title: 'Cross-project task' }));
		assert.throws(() => database.setProjectView({ projectId: second.id, descriptorUri: 'file:///second.code-workspace', openAtQuit: false, selectedTaskId: first.task.id, dashboardPosition: null }));
	});
});

test('changing a folder path clears its old checkout identity until a separate verification update', () => {
	withDatabase((_path, database) => {
		const project = database.createProject('Rebind');
		const binding = database.createFolderBinding({ projectId: project.id, path: '/work/old', vcsKind: 'git', vcsRoot: '/work/old', reviewRepositoryId: 'repo-old' });
		assert.throws(() => database.updateFolderBinding(binding.id, { path: '/work/new', vcsKind: 'git', vcsRoot: '/work/new', reviewRepositoryId: 'repo-new' }), /must be verified/);
		assert.deepEqual(database.updateFolderBinding(binding.id, { path: '/work/new' }), {
			...binding, path: '/work/new', vcsKind: null, vcsRoot: null, reviewRepositoryId: null,
		});
		assert.throws(() => database.updateFolderBinding(binding.id, { expectedPath: '/work/old', vcsKind: 'jj', vcsRoot: '/work/new', reviewRepositoryId: 'repo-new' }), /must match the current path/);
		assert.deepEqual(database.updateFolderBinding(binding.id, { expectedPath: '/work/new', vcsKind: 'jj', vcsRoot: '/work/new', reviewRepositoryId: 'repo-new' }), {
			...binding, path: '/work/new', vcsKind: 'jj', vcsRoot: '/work/new', reviewRepositoryId: 'repo-new',
		});
	});
});

test('failed review completion rolls back the outbox status and link together', () => {
	withDatabase((path, database) => {
		const { task } = createProjectAndTask(database);
		const command = database.enqueueReviewRequest({ commandId: 'rollback-command', taskId: task.id, body: '{"immutable":true}' });
		const sabotage = new DatabaseSync(path);
		try {
			sabotage.exec(`CREATE TRIGGER fail_review_link BEFORE INSERT ON task_review_links BEGIN SELECT RAISE(ABORT, 'injected constraint failure'); END;`);
			assert.throws(() => database.completeReviewRequest(command.commandId, 'review-rollback'), /injected constraint failure/);
			assert.equal(database.getReviewCommand(command.commandId)?.status, 'pending');
			assert.deepEqual(database.listTaskReviews(task.id), []);
		} finally {
			sabotage.close();
		}
	});
});

test('review outbox retries are idempotent and reject command ID reuse with a changed body', () => {
	withDatabase((_path, database) => {
		const { task } = createProjectAndTask(database);
		const input = { commandId: 'stable-command', taskId: task.id, body: '{"title":"Original"}' };
		const first = database.enqueueReviewRequest(input);
		assert.deepEqual(database.enqueueReviewRequest(input), first);
		assert.throws(() => database.enqueueReviewRequest({ ...input, body: '{"title":"Changed"}' }), ReviewCommandConflictError);
		assert.throws(() => database.enqueueReviewRequest({ ...input, taskId: 'different-task' }), ReviewCommandConflictError);
		const completed = database.completeReviewRequest(first.commandId, 'review-stable');
		assert.deepEqual(database.completeReviewRequest(first.commandId, 'review-stable'), completed);
		assert.throws(() => database.completeReviewRequest(first.commandId, 'review-other'), /different review ID/);
	});
});

test('one review ID can link to multiple tasks and each task can choose its own primary', () => {
	withDatabase((_path, database) => {
		const first = createProjectAndTask(database, 'First');
		const second = createProjectAndTask(database, 'Second');
		const firstCommand = database.enqueueReviewRequest({ commandId: 'first-review-command', taskId: first.task.id, body: '{"one":1}' });
		const secondCommand = database.enqueueReviewRequest({ commandId: 'second-review-command', taskId: second.task.id, body: '{"two":2}' });
		database.completeReviewRequest(firstCommand.commandId, 'shared-review');
		database.completeReviewRequest(secondCommand.commandId, 'shared-review');
		const additional = database.enqueueReviewRequest({ commandId: 'additional-review-command', taskId: first.task.id, body: '{"three":3}' });
		database.completeReviewRequest(additional.commandId, 'other-review');

		assert.equal(database.listTaskReviews(first.task.id).length, 2);
		assert.equal(database.listTaskReviews(second.task.id).length, 1);
		assert.equal(database.listTaskReviews(first.task.id).find(link => link.isPrimary)?.reviewId, 'shared-review');
		database.choosePrimaryReview(first.task.id, first.task.revision, 'other-review');
		assert.equal(database.listTaskReviews(first.task.id).filter(link => link.isPrimary).length, 1);
		assert.equal(database.listTaskReviews(first.task.id).find(link => link.isPrimary)?.reviewId, 'other-review');
		assert.equal(database.getTask(first.task.id)!.revision, first.task.revision + 1);
		assert.throws(() => database.choosePrimaryReview(first.task.id, first.task.revision, 'shared-review'), TaskRevisionConflictError);
		assert.equal(database.listTaskReviews(first.task.id).find(link => link.isPrimary)?.reviewId, 'other-review');
		assert.equal(database.listTaskReviews(second.task.id).find(link => link.isPrimary)?.reviewId, 'shared-review');
	});
});

test('failed requests cannot overwrite completed outbox commands and review availability is editable', () => {
	withDatabase((_path, database) => {
		const { task } = createProjectAndTask(database);
		const command = database.enqueueReviewRequest({ commandId: 'complete-before-failure', taskId: task.id, body: '{"request":true}' });
		database.completeReviewRequest(command.commandId, 'review-available');
		assert.deepEqual(database.markReviewRequestFailed(command.commandId, 'late network failure'), database.getReviewCommand(command.commandId));
		assert.equal(database.getReviewCommand(command.commandId)?.status, 'complete');
		assert.equal(database.getReviewCommand(command.commandId)?.lastError, null);
		assert.equal(database.setTaskReviewAvailability(task.id, 'review-available', 'unavailable')?.state, 'unavailable');
		assert.equal(database.setTaskReviewAvailability(task.id, 'review-available', 'available')?.state, 'available');
		assert.equal(database.setTaskReviewAvailability(task.id, 'missing-review', 'unavailable'), undefined);
	});
});

test('project workspace descriptor URIs are unique across project views', () => {
	withDatabase((_path, database) => {
		const first = database.createProject('First view');
		const second = database.createProject('Second view');
		database.setProjectView({ projectId: first.id, descriptorUri: 'file:///profile/workspaces/shared.code-workspace', openAtQuit: true, selectedTaskId: null, dashboardPosition: null });
		assert.throws(() => database.setProjectView({ projectId: second.id, descriptorUri: 'file:///profile/workspaces/shared.code-workspace', openAtQuit: false, selectedTaskId: null, dashboardPosition: null }));
	});
});

test('dashboard state updates atomically preserve view identity and reject cross-project tasks or invalid positions', () => {
	withDatabase((_path, database) => {
		const first = createProjectAndTask(database, 'Dashboard one');
		const second = createProjectAndTask(database, 'Dashboard two');
		const descriptorUri = 'file:///profile/workspaces/dashboard-one.code-workspace';
		const initialView = database.setProjectView({
			projectId: first.project.id, descriptorUri, openAtQuit: true,
			selectedTaskId: null, dashboardPosition: null,
		});
		const updated = database.updateProjectDashboardState({
			projectId: first.project.id, expectedDescriptorUri: descriptorUri,
			selectedTaskId: first.task.id, dashboardPosition: '1200',
		});
		assert.deepEqual(updated, { ...initialView, selectedTaskId: first.task.id, dashboardPosition: '1200' });
		assert.throws(() => database.updateProjectDashboardState({
			projectId: first.project.id, expectedDescriptorUri: descriptorUri,
			selectedTaskId: second.task.id, dashboardPosition: '1400',
		}), /does not belong to this project/);
		for (const dashboardPosition of ['-1', '01', '1.5', '10000001']) {
			assert.throws(() => database.updateProjectDashboardState({
				projectId: first.project.id, expectedDescriptorUri: descriptorUri,
				selectedTaskId: first.task.id, dashboardPosition,
			}), /integer pixel value/);
		}
		assert.throws(() => database.updateProjectDashboardState({
			projectId: first.project.id, expectedDescriptorUri: 'file:///other.code-workspace',
			selectedTaskId: first.task.id, dashboardPosition: '1400',
		}), /workspace changed/);
		assert.deepEqual(database.getProjectView(first.project.id), updated);
		assert.equal(database.getProjectView(first.project.id)?.openAtQuit, true);
		assert.equal(database.getProjectView(first.project.id)?.descriptorUri, descriptorUri);
	});
});

test('provider attempts persist exact preflight snapshot and interrupt live attempts after restart', () => {
	withDatabase((path, database) => {
		const { task } = createProjectAndTask(database);
		const input = {
			attemptId: 'attempt-durable', taskId: task.id, provider: 'codex' as const, purpose: 'task' as const, profileRef: 'profile:work',
			folderIdentity: 'file:///work/project', cwd: '/work/project', mode: 'plan', prompt: 'Fix the failing parser.',
			conventionSnapshotId: null, refSnapshotId: 'refs:42',
		};
		const queued = database.createProviderAttempt(input);
		assert.equal(queued.state, 'queued');
		assert.equal(queued.promptHash, 'b822678baaaaf8607bbc5b2d609b87f5c9c6f120e69649cdf06d7da844f3a1a5');
		database.setProviderAttemptRunning(queued.attemptId, task.revision, 73001);
		database.appendProviderAttemptEvent(queued.attemptId, { type: 'session.started' });
		database.appendProviderAttemptEvent(queued.attemptId, { type: 'item.started', metadata: { itemType: 'command_execution' } });
		database.appendProviderAttemptEvent(queued.attemptId, { type: 'item.updated', metadata: { itemType: 'command_execution' } });
		database.appendProviderAttemptEvent(queued.attemptId, { type: 'item.completed', metadata: { itemType: 'command_execution' } });
		database.appendProviderAttemptEvent(queued.attemptId, { type: 'turn.completed', metadata: { subtype: 'success', numTurns: 2, durationMs: 900 } });
		database.appendProviderAttemptEvent(queued.attemptId, { type: 'turn.failed', metadata: { subtype: 'provider_error', durationMs: 86_400_000 } });
		database.appendProviderAttemptEvent(queued.attemptId, { type: 'error' });
		database.close();

		const reopened = WorkspaceDatabase.open(path);
		try {
			const interrupted = reopened.getProviderAttempt(queued.attemptId)!;
			assert.equal(interrupted.state, 'interrupted');
			assert.equal(interrupted.cwd, input.cwd);
			assert.ok(interrupted.startedAt);
			assert.ok(interrupted.finishedAt);
			assert.equal(interrupted.prompt, input.prompt);
			assert.equal(interrupted.promptHash, queued.promptHash);
			assert.deepEqual(reopened.listProviderAttemptEvents(queued.attemptId).map(event => [event.type, event.metadata]), [
				['session.started', {}], ['item.started', { itemType: 'command_execution' }],
				['item.updated', { itemType: 'command_execution' }],
				['item.completed', { itemType: 'command_execution' }],
				['turn.completed', { subtype: 'success', numTurns: 2, durationMs: 900 }],
				['turn.failed', { subtype: 'provider_error', durationMs: 86_400_000 }],
				['error', {}],
			]);
		} finally {
			reopened.close();
		}
	});
});

test('subagent children persist bounded scope and result and reconcile Review only after every cleanup is verified', () => {
	withDatabase((_path, database) => {
		const { task } = createProjectAndTask(database);
		const root = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Coordinate the task.' });
		database.setSubagentPhase(root.attemptId, 'preflight');
		const runningRoot = database.setProviderAttemptRunning(root.attemptId, task.revision, 74001);
		const runningTaskRevision = runningRoot.runningTaskRevision!;
		assert.equal(database.getTask(task.id)?.state, 'inProgress');
		const child = database.createProviderAttempt({ taskId: task.id, parentAttemptId: root.attemptId, childScope: JSON.stringify({ files: ['src/parser.ts'] }), provider: 'claude', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Inspect the parser.' });
		assert.equal(child.parentAttemptId, root.attemptId);
		assert.throws(() => database.createProviderAttempt({ taskId: task.id, parentAttemptId: child.attemptId, provider: 'codex', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Nested child.' }), /root attempt/);
		database.setProviderAttemptRunning(child.attemptId, runningTaskRevision, 74002);
		const savedResult = database.persistProviderAttemptResult(child.attemptId, 'Parser review complete.');
		assert.match(savedResult.resultSha256 ?? '', /^[a-f0-9]{64}$/u);
		assert.equal(savedResult.resultText, 'Parser review complete.');
		assert.equal(database.persistProviderAttemptResult(child.attemptId, 'Parser review complete.').resultSha256, savedResult.resultSha256);
		assert.throws(() => database.persistProviderAttemptResult(child.attemptId, 'A different result.'), /cannot be changed/);
		database.finishProviderAttempt(root.attemptId, 'succeeded', null, runningTaskRevision, null, true);
		assert.equal(database.getTask(task.id)?.state, 'inProgress');
		assert.equal(database.getProviderAttempt(root.attemptId)?.orchestrationPhase, 'waiting');
		database.finishProviderAttempt(child.attemptId, 'succeeded', null, runningTaskRevision, null, true);
		assert.throws(() => database.persistProviderAttemptResult(child.attemptId, 'Changed after completion.'), /cannot be changed/);
		assert.equal(database.getTask(task.id)?.state, 'review');
		assert.equal(database.getProviderAttempt(root.attemptId)?.orchestrationPhase, null);
		assert.deepEqual(database.listSubagentAttempts(root.attemptId).map(item => item.attemptId), [child.attemptId]);
	});
});

test('subagent completion records a stale Review suggestion after a person changes task state', () => {
	withDatabase((_path, database) => {
		const { task } = createProjectAndTask(database);
		const root = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Coordinate the task.' });
		const runningRoot = database.setProviderAttemptRunning(root.attemptId, task.revision, 74003);
		const expectedRevision = runningRoot.runningTaskRevision!;
		const child = database.createProviderAttempt({ taskId: task.id, parentAttemptId: root.attemptId, childScope: '{"files":[]}', provider: 'claude', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Inspect.' });
		database.setProviderAttemptRunning(child.attemptId, expectedRevision, 74004);
		database.finishProviderAttempt(root.attemptId, 'succeeded', null, expectedRevision, null, true);
		database.updateTask(task.id, expectedRevision, { title: 'Edited while agents ran' });
		database.finishProviderAttempt(child.attemptId, 'succeeded', null, expectedRevision, null, true);
		assert.equal(database.getTask(task.id)?.state, 'inProgress');
		const audit = new DatabaseSync(_path);
		try {
			const suggestion = audit.prepare('SELECT suggested_state, reason FROM provider_attempt_task_suggestions WHERE attempt_id = ?').get(root.attemptId);
			assert.deepEqual([suggestion?.suggested_state, suggestion?.reason], ['review', 'stale_task_state']);
		} finally { audit.close(); }
	});
});

test('a successful root attempt waits for cleanup proof before moving its task to Review', () => {
	withDatabase((_path, database) => {
		const { task } = createProjectAndTask(database);
		const root = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Finish.' });
		const running = database.setProviderAttemptRunning(root.attemptId, task.revision, 74005);
		database.finishProviderAttempt(root.attemptId, 'succeeded', null, running.runningTaskRevision!, null, false);
		assert.equal(database.getTask(task.id)?.state, 'inProgress');
		assert.equal(database.getProviderAttempt(root.attemptId)?.orchestrationPhase, 'waiting');
		database.confirmProviderAttemptCleanup(root.attemptId);
		assert.equal(database.getTask(task.id)?.state, 'review');
	});
});

test('a repeated successful finish reconciles cleanup and a queued child can launch after its root finishes', () => {
	withDatabase((_path, database) => {
		const { task } = createProjectAndTask(database);
		const root = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Coordinate.' });
		const running = database.setProviderAttemptRunning(root.attemptId, task.revision, 74006);
		const child = database.createProviderAttempt({ taskId: task.id, parentAttemptId: root.attemptId, childScope: '{"files":[]}', provider: 'claude', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Inspect.' });
		database.finishProviderAttempt(root.attemptId, 'succeeded', null, running.runningTaskRevision!, null, false);
		assert.throws(() => database.setProviderAttemptRunning(child.attemptId, running.runningTaskRevision!, 74007), /parent is no longer active/);
		database.finishProviderAttempt(root.attemptId, 'succeeded', null, running.runningTaskRevision!, null, true);
		assert.equal(database.getTask(task.id)?.state, 'inProgress');
		assert.equal(database.getProviderAttempt(root.attemptId)?.cleanupVerified, true);
		database.setProviderAttemptRunning(child.attemptId, running.runningTaskRevision!, 74007);
		database.finishProviderAttempt(child.attemptId, 'succeeded', null, running.runningTaskRevision!, null, true);
		assert.equal(database.getTask(task.id)?.state, 'review');
	});
});

test('repeated successful finish reconciles a root with no child after cleanup', () => {
	withDatabase((_path, database) => {
		const { task } = createProjectAndTask(database);
		const root = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Finish.' });
		const running = database.setProviderAttemptRunning(root.attemptId, task.revision, 74008);
		database.finishProviderAttempt(root.attemptId, 'succeeded', null, running.runningTaskRevision!, null, false);
		database.finishProviderAttempt(root.attemptId, 'succeeded', null, running.runningTaskRevision!, null, true);
		assert.equal(database.getTask(task.id)?.state, 'review');
		assert.equal(database.getProviderAttempt(root.attemptId)?.orchestrationPhase, null);
	});
});

test('a queued attempt with the persisted launch gate is safely recovered as never launched', () => {
	withDatabase((path, database) => {
		const { task } = createProjectAndTask(database);
		const queued = database.createProviderAttempt({
			taskId: task.id, provider: 'codex', purpose: 'connectionTest', profileRef: 'profile:local',
			folderIdentity: '/work/project', cwd: '/work/project', mode: 'connectionTest', prompt: 'Verify',
		});
		assert.equal(queued.launchGateVersion, 1);
		assert.throws(
			() => database.setProviderAttemptRunning(queued.attemptId, task.revision),
			/process group must be persisted/,
		);
		database.close();

		const reopened = WorkspaceDatabase.open(path);
		try {
			const recovered = reopened.getProviderAttempt(queued.attemptId)!;
			assert.equal(recovered.state, 'interrupted');
			assert.equal(recovered.startedAt, null);
			assert.equal(recovered.ownedPgid, null);
			assert.equal(recovered.cleanupVerified, true);
			assert.match(recovered.errorSummary ?? '', /launch gate closed/);
		} finally {
			reopened.close();
		}
	});
});

test('version 5 databases migrate gate-less attempts without claiming cleanup proof', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-workspace-db-v5-'));
	const path = join(directory, 'workspace.db');
	const legacy = new DatabaseSync(path);
	const migrations = WorkspaceDatabase as unknown as {
		migrateV1(database: DatabaseSync): void;
		migrateV2(database: DatabaseSync): void;
		migrateV3(database: DatabaseSync): void;
		migrateV4(database: DatabaseSync): void;
		migrateV5(database: DatabaseSync): void;
	};
	const oldAttemptId = 'legacy-gate-less-attempt';
	try {
		legacy.exec('PRAGMA foreign_keys = ON; BEGIN EXCLUSIVE;');
		migrations.migrateV1(legacy);
		migrations.migrateV2(legacy);
		migrations.migrateV3(legacy);
		migrations.migrateV4(legacy);
		migrations.migrateV5(legacy);
		const now = new Date().toISOString();
		legacy.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('legacy-project', 'Legacy', now);
		legacy.prepare('INSERT INTO folder_bindings (id, project_id, path, vcs_kind, vcs_root, review_repository_id, created_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?)')
			.run('legacy-binding', 'legacy-project', '/work/project', now);
		legacy.prepare(`INSERT INTO tasks (id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at)
			VALUES (?, ?, ?, ?, NULL, 'ready', 0, 1, ?, ?)`)
			.run('legacy-task', 'legacy-project', 'legacy-binding', 'Legacy task', now, now);
		const prompt = 'Verify';
		legacy.prepare(`INSERT INTO provider_attempts
			(attempt_id, task_id, provider, purpose, profile_ref, folder_identity, cwd, mode, prompt, prompt_hash, convention_snapshot_id, ref_snapshot_id,
			state, created_at, updated_at, cleanup_verified, cleanup_verified_at, owned_pgid)
			VALUES (?, ?, 'claude', 'connectionTest', 'profile:local', '/work/project', '/work/project', 'connectionTest', ?, ?, NULL, NULL,
			'queued', ?, ?, 0, NULL, NULL)`)
			.run(oldAttemptId, 'legacy-task', prompt, createHash('sha256').update(prompt, 'utf8').digest('hex'), now, now);
		legacy.exec('COMMIT;');
	} finally {
		legacy.close();
	}
	const database = WorkspaceDatabase.open(path);
	try {
		const migrated = database.getProviderAttempt(oldAttemptId)!;
		assert.equal(migrated.launchGateVersion, null);
		assert.equal(migrated.state, 'interrupted');
		assert.equal(migrated.cleanupVerified, false);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('provider attempt transitions are audited, task moves are conditional, and event content is rejected', () => {
	withDatabase((path, database) => {
		const { task } = createProjectAndTask(database);
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'claude', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Run requested work.' });
		assert.equal(attempt.purpose, 'task');
		const running = database.setProviderAttemptRunning(attempt.attemptId, task.revision, 73002);
		assert.equal(running.state, 'running');
		assert.equal(database.getTask(task.id)?.state, 'inProgress');
		const inProgress = database.getTask(task.id)!;
		const finished = database.finishProviderAttempt(attempt.attemptId, 'succeeded', 'session-7', inProgress.revision, null, true);
		assert.equal(finished.state, 'succeeded');
		assert.equal(finished.providerSessionId, 'session-7');
		assert.ok(finished.startedAt);
		assert.ok(finished.finishedAt);
		assert.equal(database.getTask(task.id)?.state, 'review');
		assert.throws(() => database.finishProviderAttempt(attempt.attemptId, 'failed'), /already terminal/);
		assert.throws(() => database.appendProviderAttemptEvent(attempt.attemptId, { type: 'turn.completed', metadata: { text: 'sensitive content' } }), /not allowed/);
		assert.throws(() => database.appendProviderAttemptEvent(attempt.attemptId, { type: 'item.started', metadata: { itemType: 'raw secret content' } }), /not allowed/);
		assert.throws(() => database.appendProviderAttemptEvent(attempt.attemptId, { type: 'assistant.message' }), /Unsupported provider event type/);
		assert.deepEqual(database.listProviderAttemptEvents(attempt.attemptId), []);
		const audit = new DatabaseSync(path);
		try {
			assert.equal(Number(audit.prepare('SELECT COUNT(*) AS count FROM provider_attempt_state_audit WHERE attempt_id = ?').get(attempt.attemptId)?.count), 3);
			assert.deepEqual(audit.prepare('SELECT from_state, to_state FROM provider_attempt_task_state_audit WHERE attempt_id = ? ORDER BY audit_id').all(attempt.attemptId).map(row => [row.from_state, row.to_state]), [['ready', 'inProgress'], ['inProgress', 'review']]);
			assert.equal(Number(audit.prepare('SELECT COUNT(*) AS count FROM provider_attempt_task_suggestions').get()?.count), 0);
		} finally {
			audit.close();
		}
	});
});

test('provider item outcomes persist across a red-to-green command sequence without command content', () => {
	withDatabase((path, database) => {
		const { task } = createProjectAndTask(database);
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Run requested work.' });
		const rawCommand = 'git push origin reviewed-change';
		const commandHash = createHash('sha256').update(rawCommand, 'utf8').digest('hex');
		assert.doesNotThrow(() => database.appendProviderAttemptEvent(attempt.attemptId, {
			type: 'item.completed', metadata: { itemType: 'command_execution', itemOutcome: 'unresolved' },
		}));
		assert.throws(() => database.appendProviderAttemptEvent(attempt.attemptId, {
			type: 'item.completed', metadata: { itemType: 'command_execution', itemOutcome: 'resolved' },
		}), /not allowed/);
		assert.doesNotThrow(() => database.appendProviderAttemptEvent(attempt.attemptId, {
			type: 'item.completed', metadata: { itemType: 'command_execution' },
		}));

		const events = database.listProviderAttemptEvents(attempt.attemptId);
		assert.deepEqual(events.map(event => event.metadata), [
			{ itemType: 'command_execution', itemOutcome: 'unresolved' },
			{ itemType: 'command_execution' },
		]);
		const audit = new DatabaseSync(path);
		try {
			const serialized = audit.prepare('SELECT metadata_json FROM provider_attempt_events WHERE attempt_id = ? ORDER BY event_id').all(attempt.attemptId).map(row => String(row.metadata_json)).join('\n');
			assert.equal(serialized.includes(rawCommand), false);
			assert.equal(serialized.includes(commandHash), false);
		} finally {
			audit.close();
		}
	});
});

test('stale successful attempt records a review suggestion without changing the task', () => {
	withDatabase((path, database) => {
		const { task } = createProjectAndTask(database);
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'profile:default', folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Finish this task.' });
		database.setProviderAttemptRunning(attempt.attemptId, task.revision, 73003);
		const inProgress = database.getTask(task.id)!;
		database.updateTask(task.id, inProgress.revision, { title: 'Edited elsewhere' });
		database.finishProviderAttempt(attempt.attemptId, 'succeeded', 'session-8', inProgress.revision, null, true);
		assert.equal(database.getTask(task.id)?.state, 'inProgress');
		const audit = new DatabaseSync(path);
		try {
			const suggestion = audit.prepare('SELECT suggested_state, reason FROM provider_attempt_task_suggestions WHERE attempt_id = ?').get(attempt.attemptId);
			assert.equal(suggestion?.suggested_state, 'review');
			assert.equal(suggestion?.reason, 'stale_task_state');
		} finally {
			audit.close();
		}
	});
});

test('connection test attempts never move task workflow state on start or any terminal result', () => {
	withDatabase((path, database) => {
		const { task } = createProjectAndTask(database);
		const baseline = database.getTask(task.id)!;
		const makeAttempt = (attemptId: string) => database.createProviderAttempt({
			attemptId, taskId: task.id, provider: 'codex', purpose: 'connectionTest', profileRef: 'profile:default',
			folderIdentity: '/work/project', cwd: '/work/project', mode: 'connectionTest', prompt: 'Verify provider connection.',
		});

		const success = makeAttempt('connection-success');
		assert.equal(success.purpose, 'connectionTest');
		assert.equal(database.setProviderAttemptRunning(success.attemptId, baseline.revision, 73004).state, 'running');
		assert.equal(database.finishProviderAttempt(success.attemptId, 'succeeded').state, 'succeeded');
		assert.deepEqual(database.getTask(task.id), baseline);

		const failure = makeAttempt('connection-failure');
		database.setProviderAttemptRunning(failure.attemptId, baseline.revision, 73005);
		database.finishProviderAttempt(failure.attemptId, 'failed', null, undefined, 'connection_test_failed');
		assert.deepEqual(database.getTask(task.id), baseline);

		const cancelled = makeAttempt('connection-cancelled');
		database.setProviderAttemptRunning(cancelled.attemptId, baseline.revision, 73006);
		database.finishProviderAttempt(cancelled.attemptId, 'cancelled');
		assert.deepEqual(database.getTask(task.id), baseline);

		const audit = new DatabaseSync(path);
		try {
			assert.equal(Number(audit.prepare('SELECT COUNT(*) AS count FROM provider_attempt_task_state_audit').get()?.count), 0);
			assert.equal(Number(audit.prepare('SELECT COUNT(*) AS count FROM provider_attempt_task_suggestions').get()?.count), 0);
		} finally {
			audit.close();
		}
	});
});

test('provider attempts retain owned process group and require explicit terminal cleanup proof', () => {
	withDatabase((path, database) => {
		const { task } = createProjectAndTask(database);
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'profile:local', folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Run' });
		const running = database.setProviderAttemptRunning(attempt.attemptId, task.revision, 73124);
		assert.equal(running.ownedPgid, 73124);
		assert.equal(running.cleanupVerified, false);
		const finished = database.finishProviderAttempt(attempt.attemptId, 'failed', null, undefined, 'provider failed', true);
		assert.equal(finished.cleanupVerified, true);
		database.close();
		const reopened = WorkspaceDatabase.open(path);
		try {
			assert.equal(reopened.getProviderAttempt(attempt.attemptId)?.ownedPgid, 73124);
			assert.equal(reopened.getProviderAttempt(attempt.attemptId)?.cleanupVerified, true);
			const unverified = reopened.createProviderAttempt({ taskId: attempt.taskId, provider: 'claude', purpose: 'connectionTest', profileRef: 'profile:local', folderIdentity: '/work/project', cwd: '/work/project', mode: 'connectionTest', prompt: 'Verify' });
			reopened.setProviderAttemptRunning(unverified.attemptId, reopened.getTask(task.id)!.revision, 73125);
			reopened.finishProviderAttempt(unverified.attemptId, 'cancelled');
			assert.equal(reopened.getProviderAttempt(unverified.attemptId)?.cleanupVerified, false);
			reopened.confirmProviderAttemptCleanup(unverified.attemptId);
			assert.equal(reopened.getProviderAttempt(unverified.attemptId)?.cleanupVerified, true);
		} finally {
			reopened.close();
		}
	});
});

test('task creation and state moves append; reorder validates the complete state snapshot', () => {
	withDatabase((_path, database) => {
		const { project, binding, task: first } = createProjectAndTask(database);
		const second = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Second' });
		assert.deepEqual(database.listTasks(project.id, 'ready').map(task => task.order), [0, 1]);
		const destinationFirst = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Destination first', state: 'inProgress' });
		const destinationSecond = database.updateTask(second.id, second.revision, { state: 'inProgress' });
		assert.equal(destinationSecond.order, destinationFirst.order + 1);
		assert.equal(destinationSecond.revision, second.revision + 1);
		const moveBack = database.updateTask(second.id, destinationSecond.revision, { state: 'ready' });
		assert.equal(moveBack.order, first.order + 1);
		assert.throws(() => database.updateTask(second.id, second.revision, { state: 'done' }), TaskRevisionConflictError);

		const readyTasks = database.listTasks(project.id, 'ready');
		const revisionSnapshot = readyTasks.map(task => ({ taskId: task.id, revision: task.revision }));
		const reordered = database.reorderTasks(project.id, 'ready', [...revisionSnapshot].reverse());
		assert.deepEqual(reordered.map(task => task.id), [...revisionSnapshot].reverse().map(item => item.taskId));
		assert.deepEqual(reordered.map(task => task.order), [0, 1]);
		assert.ok(reordered.every(task => task.revision === revisionSnapshot.find(item => item.taskId === task.id)!.revision + 1));
		assert.throws(() => database.reorderTasks(project.id, 'ready', revisionSnapshot), TaskSetRevisionConflictError);
		assert.throws(() => database.reorderTasks(project.id, 'ready', revisionSnapshot.slice(0, 1)), TaskSetRevisionConflictError);
	});
});

test('manual task state moves, including Done, persist revisioned audit receipts', () => {
	withDatabase((path, database) => {
		const { task } = createProjectAndTask(database);
		const edited = database.updateTask(task.id, task.revision, { title: 'Edited title', description: 'Details' });
		assert.equal(edited.revision, task.revision + 1);
		const inProgress = database.updateTask(task.id, edited.revision, { state: 'inProgress' });
		const done = database.updateTask(task.id, inProgress.revision, { state: 'done' });
		assert.equal(done.state, 'done');
		assert.equal(done.revision, inProgress.revision + 1);
		assert.throws(() => database.updateTask(task.id, inProgress.revision, { state: 'ready' }), TaskRevisionConflictError);
		const audit = new DatabaseSync(path);
		try {
			assert.deepEqual(audit.prepare('SELECT from_state, to_state, from_revision, to_revision FROM task_state_audit ORDER BY audit_id').all().map(row => [row.from_state, row.to_state, Number(row.from_revision), Number(row.to_revision)]), [
				['ready', 'inProgress', edited.revision, inProgress.revision], ['inProgress', 'done', inProgress.revision, done.revision],
			]);
		} finally {
			audit.close();
		}
	});
});

test('archive and inactive Trash preserve links, restore board state, revisions, and audit receipts', () => {
	withDatabase((path, database) => {
		const { project, task } = createProjectAndTask(database);
		database.setProjectView({ projectId: project.id, descriptorUri: 'file:///project.code-workspace', openAtQuit: true, selectedTaskId: task.id, dashboardPosition: null });
		const review = database.enqueueReviewRequest({ taskId: task.id, body: '{"operation":{"type":"create"}}' });
		database.completeReviewRequest(review.commandId, 'shared-review');
		const archived = database.archiveTask(task.id, task.revision);
		assert.ok(archived.archivedAt);
		assert.equal(database.getProjectView(project.id)?.selectedTaskId, null);
		assert.equal(database.listTasks(project.id).length, 0);
		assert.deepEqual(database.listArchivedTasks(project.id).map(item => item.id), [task.id]);
		database.close();

		const reopened = WorkspaceDatabase.open(path);
		try {
			const restored = reopened.restoreArchivedTask(task.id, archived.revision);
			assert.equal(restored.archivedAt, null);
			assert.equal(reopened.getProjectView(project.id)?.selectedTaskId, null);
			const moved = reopened.updateTask(task.id, restored.revision, { state: 'review' });
			const attempt = reopened.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'profile:local', folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Run' });
			const pending = reopened.beginTaskDeletion(task.id, moved.revision, 'trash-request-one');
			assert.equal(pending.request.status, 'pending');
			assert.equal(pending.task.deletionRequestId, 'trash-request-one');
			assert.equal(pending.task.state, 'review');
			assert.deepEqual(reopened.listPendingTaskDeletions(project.id).map(item => item.requestId), ['trash-request-one']);
			const retried = reopened.beginTaskDeletion(task.id, moved.revision, 'trash-request-one');
			assert.equal(retried.request.requestId, pending.request.requestId);
			assert.equal(retried.task.revision, pending.task.revision);
			assert.equal(reopened.listTasks(project.id).length, 1);
			assert.throws(() => reopened.createProviderAttempt({ taskId: task.id, provider: 'claude', purpose: 'task', profileRef: 'profile:local', folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Race' }), /deletion pending/);
			assert.throws(() => reopened.setProviderAttemptRunning(attempt.attemptId, moved.revision, 73007), /deletion-pending/);
			const cleanupPending = reopened.finalizeTaskDeletion(task.id, 'trash-request-one', true);
			assert.match(cleanupPending.deletionError ?? '', /still active/);
			reopened.finishProviderAttempt(attempt.attemptId, 'cancelled', null, undefined, null, true);
			const trashed = reopened.finalizeTaskDeletion(task.id, 'trash-request-one', true);
			assert.ok(trashed.trashedAt);
			assert.deepEqual(reopened.listTaskReviews(task.id).map(link => [link.reviewId, link.isPrimary]), [['shared-review', true]]);
			assert.deepEqual(reopened.listTrashedTasks(project.id).map(item => item.id), [task.id]);
			assert.equal(reopened.getTaskDeletionRequest('trash-request-one')?.status, 'complete');
			const trashRestored = reopened.restoreTrashedTask(task.id, trashed.revision);
			assert.equal(trashRestored.state, 'review');
			assert.equal(trashRestored.trashedAt, null);
			assert.equal(trashRestored.deletionRequestId, null);
			const audit = new DatabaseSync(path);
			try {
				assert.deepEqual(audit.prepare('SELECT action, from_revision, to_revision FROM task_lifecycle_audit ORDER BY audit_id').all().map(row => [row.action, Number(row.from_revision), Number(row.to_revision)]), [
					['archived', task.revision, archived.revision], ['restored', archived.revision, restored.revision],
					['trashed', cleanupPending.revision, trashed.revision], ['trashRestored', trashed.revision, trashRestored.revision],
				]);
				assert.equal(Number(audit.prepare('SELECT COUNT(*) AS count FROM task_trash_requests WHERE request_id = ?').get('trash-request-one')?.count), 1);
				assert.deepEqual(audit.prepare('SELECT action FROM task_delete_audit WHERE request_id = ? ORDER BY audit_id').all('trash-request-one').map(row => row.action), ['pending', 'cleanupFailed', 'trashed']);
			} finally {
				audit.close();
			}
		} finally {
			reopened.close();
		}
	});
});

test('pending deletion request and visible task marker survive restart for coordinator recovery', () => {
	withDatabase((path, database) => {
		const { project, task } = createProjectAndTask(database);
		const pending = database.beginTaskDeletion(task.id, task.revision, 'trash-request-restart');
		database.close();
		const reopened = WorkspaceDatabase.open(path);
		try {
			const saved = reopened.getTask(task.id)!;
			assert.equal(saved.deletionRequestId, 'trash-request-restart');
			assert.ok(saved.deletionPendingAt);
			assert.equal(reopened.listTasks(project.id)[0].id, task.id);
			assert.deepEqual(reopened.listPendingTaskDeletions(project.id).map(item => item.requestId), ['trash-request-restart']);
			const retried = reopened.beginTaskDeletion(task.id, task.revision, 'trash-request-restart');
			assert.equal(retried.request.status, 'pending');
			assert.equal(retried.task.revision, pending.task.revision);
			const trashed = reopened.finalizeTaskDeletion(task.id, 'trash-request-restart', true);
			assert.ok(trashed.trashedAt);
		} finally {
			reopened.close();
		}
	});
});

test('terminal attempts without verified cleanup remain visible and block archive or Trash finalization', () => {
	withDatabase((_path, database) => {
		const { task } = createProjectAndTask(database);
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'claude', purpose: 'connectionTest', profileRef: 'profile:local', folderIdentity: '/work/project', cwd: '/work/project', mode: 'connectionTest', prompt: 'Verify' });
		database.setProviderAttemptRunning(attempt.attemptId, task.revision, 73201);
		database.finishProviderAttempt(attempt.attemptId, 'interrupted', null, undefined, 'Owned process group remains active.');
		const current = database.getTask(task.id)!;
		assert.throws(() => database.archiveTask(task.id, current.revision), TaskCleanupNotVerifiedError);
		const pending = database.beginTaskDeletion(task.id, current.revision, 'trash-request-cleanup');
		const blocked = database.finalizeTaskDeletion(task.id, 'trash-request-cleanup', true);
		assert.ok(blocked.deletionPendingAt);
		assert.match(blocked.deletionError ?? '', /Cleanup is not verified/);
		assert.equal(database.getTaskDeletionRequest('trash-request-cleanup')?.status, 'pending');
		database.confirmProviderAttemptCleanup(attempt.attemptId);
		const trashed = database.finalizeTaskDeletion(task.id, 'trash-request-cleanup', true);
		assert.ok(trashed.trashedAt);
		assert.equal(database.getTaskDeletionRequest('trash-request-cleanup')?.status, 'complete');
		assert.ok(pending.task.deletionRequestId);
	});
});

test('ordinary-folder change reports use a bounded durable event and gate successful task completion', () => {
	withDatabase((path, database) => {
		const { task } = createProjectAndTask(database);
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'claude', purpose: 'task', profileRef: 'local-default-claude', folderIdentity: 'ordinary', cwd: '/work/project', mode: 'mutating', prompt: 'Run' });
		const running = database.setProviderAttemptRunning(attempt.attemptId, task.revision, 73202);
		assert.throws(() => database.finishProviderAttempt(attempt.attemptId, 'succeeded', null, running ? database.getTask(task.id)!.revision : undefined, null, true), /durable change report/u);
		assert.throws(() => database.appendProviderAttemptEvent(attempt.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: '{bad json}' } }), /valid JSON/u);
		assert.throws(() => database.appendProviderAttemptEvent(attempt.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: JSON.stringify({ status: 'observed', summary: 'invalid', changes: [{ path: '../escape', change: 'created' }], truncated: false }) } }), /schema validation|state does not match/u);
		assert.throws(() => database.appendProviderAttemptEvent(attempt.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: ' '.repeat(64 * 1024 + 1) } }), /bounded JSON/u);
		assert.throws(() => database.appendProviderAttemptEvent(attempt.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: JSON.stringify({ status: 'unverified', summary: 'unsafe state', changes: [{ path: 'x', change: 'created' }], truncated: false }) } }), /state does not match/u);
		database.appendProviderAttemptEvent(attempt.attemptId, { type: 'ordinaryFolderInventoryStarted' });
		const report = { status: 'observed', summary: '1 changed path observed.', changes: [{ path: 'created.txt', change: 'created' }], truncated: false };
		database.appendProviderAttemptEvent(attempt.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: JSON.stringify(report) } });
		const finished = database.finishProviderAttempt(attempt.attemptId, 'succeeded', null, database.getTask(task.id)!.revision, null, true);
		assert.equal(finished.state, 'succeeded');
		database.close();
		const reopened = WorkspaceDatabase.open(path);
		try {
			const saved = reopened.listProviderAttemptEvents(attempt.attemptId).find(event => event.type === 'ordinaryFolderChanges');
			assert.deepEqual(JSON.parse(String(saved?.metadata.report)), report);
			assert.equal(reopened.getTask(task.id)?.state, 'review');
		} finally { reopened.close(); }
	});
});
