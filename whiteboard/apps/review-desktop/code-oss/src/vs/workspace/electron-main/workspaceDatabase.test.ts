/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
	ReviewCommandConflictError,
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

test('concurrent first opens serialize the initial schema migration', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-workspace-db-open-race-'));
	const path = join(directory, 'workspace.db');
	const moduleUrl = new URL('./workspaceDatabase.ts', import.meta.url).href;
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
		database.choosePrimaryReview(first.task.id, 'other-review');
		assert.equal(database.listTaskReviews(first.task.id).filter(link => link.isPrimary).length, 1);
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
