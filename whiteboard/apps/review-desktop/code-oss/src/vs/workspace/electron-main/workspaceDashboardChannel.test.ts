/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { WebContents } from 'electron';
import { URI } from '../../base/common/uri.js';
import type { ICodeWindow } from '../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import type { WorkspaceTask } from './workspaceDatabase.js';
import { WorkspaceDashboardChannel, type TaskDeletionCoordinator } from './workspaceDashboardChannel.js';

function withChannel(run: (channel: WorkspaceDashboardChannel, projectId: string, bindingId: string, descriptorUri: string, codeWindow: ICodeWindow, sender: WebContents, otherSender: WebContents, forgedSender: WebContents, database: WorkspaceDatabase) => Promise<void>, coordinator?: TaskDeletionCoordinator): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-dashboard-channel-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	const descriptorUri = URI.file(join(directory, 'project.code-workspace')).toString();
	const workspace = database.createProjectWorkspace('Dashboard project', directory, descriptorUri);
	const codeWindow = {
		config: { reviewWindowLaunch: { kind: 'project', projectId: workspace.project.id } },
		openedWorkspace: { id: 'workspace-id', configPath: URI.parse(descriptorUri) },
	} as unknown as ICodeWindow;
	const otherWindow = { config: { reviewWindowLaunch: { kind: 'home' } } } as unknown as ICodeWindow;
	const sender = {} as WebContents;
	const otherSender = {} as WebContents;
	const forgedSender = {} as WebContents;
	const windows = {
		getWindowByWebContents: (candidate: WebContents) => candidate === sender ? codeWindow : candidate === otherSender ? otherWindow : undefined,
	} as IWindowsMainService;
	const helperPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.build/dev-fast/bound-checkout');
	const channel = new WorkspaceDashboardChannel(database, windows, coordinator, helperPath);
	return run(channel, workspace.project.id, workspace.binding.id, descriptorUri, codeWindow, sender, otherSender, forgedSender, database).finally(() => {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	});
}

test('dashboard reads and task creation are scoped to the live project window', async () => {
	await withChannel(async (channel, projectId, bindingId, descriptorUri, _codeWindow, sender) => {
		const dashboard = await channel.call<{ project: { id: string }; folder: { id: string }; tasks: unknown[]; view: { descriptorUri: string } }>(sender, 'getDashboard', projectId);
		assert.equal(dashboard.project.id, projectId);
		assert.equal(dashboard.folder.id, bindingId);
		assert.deepEqual(dashboard.tasks, []);
		assert.equal(dashboard.view.descriptorUri, descriptorUri);

		const created = await channel.call<{ project: { id: string }; folder: { id: string }; task: { bindingId: string; title: string; description: string | null }; view: { descriptorUri: string } }>(
			sender, 'createTask', { projectId, title: '  Inspect IPC  ', description: '  scoped creation  ', bindingId: 'renderer-controlled' },
		);
		assert.equal(created.project.id, projectId);
		assert.equal(created.folder.id, bindingId);
		assert.equal(created.task.title, 'Inspect IPC');
		assert.equal(created.task.description, 'scoped creation');
		assert.equal(created.view.descriptorUri, descriptorUri);
		assert.equal(created.task.bindingId, bindingId);
	});
});

test('ordinary-folder Inspect opens only persisted observed files under the still-bound root identity', async () => {
	await withChannel(async (channel, projectId, bindingId, _descriptorUri, _codeWindow, sender, _otherSender, _forgedSender, database) => {
		const task = database.createTask({ projectId, bindingId, title: 'Inspect ordinary report' });
		database.updateTask(task.id, task.revision, { state: 'review' });
		const grant = database.enableOrdinaryFolderMutation(projectId, bindingId);
		const folderIdentity = `${bindingId}:${grant.canonicalPath}:${grant.dev}:${grant.ino}`;
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'claude', purpose: 'task', profileRef: 'local-default-claude', folderIdentity, cwd: grant.canonicalPath, mode: 'mutating', prompt: 'Edit.' });
		const rootFile = join(grant.canonicalPath, 'created.txt');
		writeFileSync(rootFile, 'observed');
		const fileHash = createHash('sha256').update('observed').digest('hex');
		const report = { status: 'observed', summary: '2 changed paths observed.', changes: [
			{ path: 'created.txt', change: 'created', after: fileHash }, { path: 'vanished.txt', change: 'deleted', before: fileHash },
		], truncated: false };
		database.appendProviderAttemptEvent(attempt.attemptId, { type: 'ordinaryFolderInventoryStarted' });
		database.appendProviderAttemptEvent(attempt.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: JSON.stringify(report) } });
		database.finishProviderAttempt(attempt.attemptId, 'succeeded', null, database.getTask(task.id)!.revision, null, true);
		database.revokeOrdinaryFolderMutation(projectId, bindingId);
		assert.equal((await channel.call<{ nextAction: { taskId: string; kind: string } | null }>(sender, 'getDashboard', projectId)).nextAction?.kind, 'inspectChanges');
		const request = (relativePath: string) => ({ projectId, taskId: task.id, attemptId: attempt.attemptId, relativePath });
		const snapshot = await channel.call<{ relativePath: string; content: string }>(sender, 'openObservedOrdinaryFolderChange', request('created.txt'));
		assert.deepEqual(snapshot, { relativePath: 'created.txt', content: 'observed' });
		const snapshotOutsidePath = join(tmpdir(), `ordinary-report-snapshot-outside-${Date.now()}.txt`);
		try {
			writeFileSync(snapshotOutsidePath, 'outside snapshot target');
			unlinkSync(rootFile);
			symlinkSync(snapshotOutsidePath, rootFile);
			assert.equal(snapshot.content, 'observed', 'the delivered content snapshot must remain unchanged after the path is retargeted');
			await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', request('created.txt')), /could not be read safely/u);
		} finally {
			rmSync(rootFile, { force: true });
			rmSync(snapshotOutsidePath, { force: true });
		}
		writeFileSync(rootFile, 'observed');
		writeFileSync(rootFile, 'modified after the report');
		assert.equal((await channel.call<{ nextAction: { kind: string } | null }>(sender, 'getDashboard', projectId)).nextAction?.kind, 'inspectChanges');
		await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', request('created.txt')), /changed after the observed report/u);
		writeFileSync(rootFile, 'observed');
		const cleanupUnverified = database.createProviderAttempt({ taskId: task.id, provider: 'claude', purpose: 'task', profileRef: 'local-default-claude', folderIdentity, cwd: grant.canonicalPath, mode: 'mutating', prompt: 'Edit.' });
		database.appendProviderAttemptEvent(cleanupUnverified.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: JSON.stringify(report) } });
		database.finishProviderAttempt(cleanupUnverified.attemptId, 'succeeded', null, database.getTask(task.id)!.revision, null, false);
		await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', { ...request('created.txt'), attemptId: cleanupUnverified.attemptId }), /cleanup has not been verified/u);
		const supersededReport = database.createProviderAttempt({ taskId: task.id, provider: 'claude', purpose: 'task', profileRef: 'local-default-claude', folderIdentity, cwd: grant.canonicalPath, mode: 'mutating', prompt: 'Edit.' });
		database.appendProviderAttemptEvent(supersededReport.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: JSON.stringify(report) } });
		database.appendProviderAttemptEvent(supersededReport.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: JSON.stringify({ status: 'unverified', summary: 'Final inventory failed.', changes: [], truncated: false }) } });
		database.finishProviderAttempt(supersededReport.attemptId, 'succeeded', null, database.getTask(task.id)!.revision, null, true);
		await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', { ...request('created.txt'), attemptId: supersededReport.attemptId }), /no verified ordinary-folder change report/u);
		await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', request('../outside.txt')), /not an openable path|escapes/u);
		await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', request('vanished.txt')), /not an openable path/u);
		await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', request('missing.txt')), /not an openable path/u);
		unlinkSync(rootFile);
		await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', request('created.txt')), /could not be read safely/u);
		writeFileSync(rootFile, 'observed again');

		const outsidePath = join(tmpdir(), `ordinary-report-outside-${Date.now()}.txt`);
		const outsideDirectory = mkdtempSync(join(tmpdir(), 'ordinary-report-outside-dir-'));
		try {
			writeFileSync(outsidePath, 'outside');
			writeFileSync(join(outsideDirectory, 'nested.txt'), 'outside nested target');
			symlinkSync(outsidePath, join(grant.canonicalPath, 'linked.txt'));
			const symlinkReport = { ...report, summary: '1 changed path observed.', changes: [{ path: 'linked.txt', change: 'created', after: fileHash }] };
			const symlinkAttempt = database.createProviderAttempt({ taskId: task.id, provider: 'claude', purpose: 'task', profileRef: 'local-default-claude', folderIdentity, cwd: grant.canonicalPath, mode: 'mutating', prompt: 'Edit.' });
			database.appendProviderAttemptEvent(symlinkAttempt.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: JSON.stringify(symlinkReport) } });
			database.finishProviderAttempt(symlinkAttempt.attemptId, 'succeeded', null, database.getTask(task.id)!.revision, null, true);
			await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', { ...request('linked.txt'), attemptId: symlinkAttempt.attemptId }), /could not be read safely/u);
			unlinkSync(join(grant.canonicalPath, 'linked.txt'));
			symlinkSync(outsideDirectory, join(grant.canonicalPath, 'linked-dir'), 'dir');
			const nestedReport = { ...report, summary: '1 changed path observed.', changes: [{ path: 'linked-dir/nested.txt', change: 'created', after: fileHash }] };
			const nestedSymlinkAttempt = database.createProviderAttempt({ taskId: task.id, provider: 'claude', purpose: 'task', profileRef: 'local-default-claude', folderIdentity, cwd: grant.canonicalPath, mode: 'mutating', prompt: 'Edit.' });
			database.appendProviderAttemptEvent(nestedSymlinkAttempt.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: JSON.stringify(nestedReport) } });
			database.finishProviderAttempt(nestedSymlinkAttempt.attemptId, 'succeeded', null, database.getTask(task.id)!.revision, null, true);
			await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', { ...request('linked-dir/nested.txt'), attemptId: nestedSymlinkAttempt.attemptId }), /could not be read safely/u);
			unlinkSync(join(grant.canonicalPath, 'linked-dir'));
			writeFileSync(join(grant.canonicalPath, 'linked.txt'), 'now a regular file');
			const linkReport = { ...report, summary: '1 changed path observed.', changes: [{ path: 'linked.txt', change: 'created', after: 'link:/outside' }] };
			const changedSinceReport = database.createProviderAttempt({ taskId: task.id, provider: 'claude', purpose: 'task', profileRef: 'local-default-claude', folderIdentity, cwd: grant.canonicalPath, mode: 'mutating', prompt: 'Edit.' });
			database.appendProviderAttemptEvent(changedSinceReport.attemptId, { type: 'ordinaryFolderChanges', metadata: { report: JSON.stringify(linkReport) } });
			database.finishProviderAttempt(changedSinceReport.attemptId, 'succeeded', null, database.getTask(task.id)!.revision, null, true);
			await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', { ...request('linked.txt'), attemptId: changedSinceReport.attemptId }), /not an openable path/u);
		} finally {
			rmSync(join(grant.canonicalPath, 'linked.txt'), { force: true });
			rmSync(join(grant.canonicalPath, 'linked-dir'), { force: true });
			rmSync(outsidePath, { force: true });
			rmSync(outsideDirectory, { recursive: true, force: true });
		}

		const replacement = mkdtempSync(join(tmpdir(), 'ordinary-report-retarget-'));
		try {
			writeFileSync(join(replacement, 'created.txt'), 'replacement');
			database.updateFolderBinding(bindingId, { path: replacement, expectedPath: grant.canonicalPath });
			await assert.rejects(channel.call(sender, 'openObservedOrdinaryFolderChange', request('created.txt')), /no longer authorized|identity changed/u);
		} finally { rmSync(replacement, { recursive: true, force: true }); }
	});
});

test('dashboard state IPC persists selected task and bounded scroll without replacing view identity', async () => {
	await withChannel(async (channel, projectId, _bindingId, descriptorUri, _codeWindow, sender, _otherSender, _forgedSender, database) => {
		const dashboard = await channel.call<{ tasks: Array<{ id: string }> }>(sender, 'getDashboard', projectId);
		const task = await channel.call<{ task: { id: string } }>(sender, 'createTask', { projectId, title: 'Selected task' });
		const before = database.getProjectView(projectId)!;
		database.setProjectView({ ...before, openAtQuit: true });
		const updated = await channel.call<{ selectedTaskId: string | null; dashboardPosition: string | null; descriptorUri: string; openAtQuit: boolean }>(
			sender, 'updateDashboardState', { projectId, selectedTaskId: task.task.id, dashboardPosition: '640' },
		);
		assert.equal(dashboard.tasks.length, 0);
		assert.equal(updated.selectedTaskId, task.task.id);
		assert.equal(updated.dashboardPosition, '640');
		assert.equal(updated.descriptorUri, descriptorUri);
		assert.equal(updated.openAtQuit, true);
		assert.deepEqual(database.getProjectView(projectId), updated);

		const otherWorkspace = database.createProjectWorkspace('Other project', '/work/other', 'file:///other.code-workspace');
		const otherTask = database.createTask({ projectId: otherWorkspace.project.id, bindingId: otherWorkspace.binding.id, title: 'Other task' });
		await assert.rejects(channel.call(sender, 'updateDashboardState', { projectId, selectedTaskId: otherTask.id, dashboardPosition: '700' }), /does not belong to this project/);
		for (const dashboardPosition of ['-1', '01', '1.5', '10000001']) {
			await assert.rejects(channel.call(sender, 'updateDashboardState', { projectId, selectedTaskId: task.task.id, dashboardPosition }), /integer pixel value/);
		}
		assert.deepEqual(database.getProjectView(projectId), updated);
	});
});

test('next action uses the latest run failure, then review and ready tasks in that order', async () => {
	await withChannel(async (channel, projectId, bindingId, _descriptorUri, _codeWindow, sender, _otherSender, _forgedSender, database) => {
		const ready = database.createTask({ projectId, bindingId, title: 'Ready task' });
		const running = database.createTask({ projectId, bindingId, title: 'Running task' });
		const review = database.createTask({ projectId, bindingId, title: 'Review task' });
		database.updateTask(running.id, running.revision, { state: 'inProgress' });
		database.updateTask(review.id, review.revision, { state: 'review' });
		const request = database.enqueueReviewRequest({ taskId: review.id, body: 'Review this task' });
		database.completeReviewRequest(request.commandId, 'primary-review');

		const getNextAction = async () => (await channel.call<{ nextAction: { taskId: string; kind: string; primaryReviewId: string | null } | null }>(sender, 'getDashboard', projectId)).nextAction;
		assert.deepEqual(await getNextAction(), { taskId: review.id, kind: 'review', primaryReviewId: 'primary-review', hasPassedE2eEvidence: false });
		const first = database.createProviderAttempt({ taskId: running.id, provider: 'codex', purpose: 'task', profileRef: 'profile:local', folderIdentity: '/work/project', cwd: '/work/project', mode: 'mutating', prompt: 'Run' });
		database.finishProviderAttempt(first.attemptId, 'failed', null, undefined, 'Provider failed', false);
		assert.deepEqual(await getNextAction(), { taskId: running.id, kind: 'attention', primaryReviewId: null, hasPassedE2eEvidence: false });

		const retry = database.createProviderAttempt({ taskId: running.id, provider: 'claude', purpose: 'task', profileRef: 'profile:local', folderIdentity: '/work/project', cwd: '/work/project', mode: 'mutating', prompt: 'Retry' });
		assert.equal((await getNextAction())?.taskId, review.id, 'an old failure must not outrank an active retry');
		database.finishProviderAttempt(retry.attemptId, 'cancelled', null, undefined, 'Cancelled', true);
		assert.equal((await getNextAction())?.kind, 'attention');
		database.updateTask(running.id, database.getTask(running.id)!.revision, { state: 'done' });
		assert.equal((await getNextAction())?.taskId, review.id);
		database.updateTask(review.id, database.getTask(review.id)!.revision, { state: 'done' });
		assert.deepEqual(await getNextAction(), { taskId: ready.id, kind: 'ready', primaryReviewId: null, hasPassedE2eEvidence: false });
	});
});

test('a failed owned subagent makes its in-progress task the next action', async () => {
	await withChannel(async (channel, projectId, bindingId, _descriptorUri, _codeWindow, sender, _otherSender, _forgedSender, database) => {
		const review = database.createTask({ projectId, bindingId, title: 'Review later' });
		database.updateTask(review.id, review.revision, { state: 'review' });
		const task = database.createTask({ projectId, bindingId, title: 'Delegated task' });
		const root = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Coordinate.' });
		const running = database.setProviderAttemptRunning(root.attemptId, task.revision, 74009);
		const child = database.createProviderAttempt({ taskId: task.id, parentAttemptId: root.attemptId, childScope: '{"scope":"Check parser"}', provider: 'claude', purpose: 'task', profileRef: null, folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Check parser.' });
		database.finishProviderAttempt(child.attemptId, 'failed', null, undefined, 'Parser check failed', true);
		const dashboard = await channel.call<{ nextAction: { taskId: string; kind: string } | null }>(sender, 'getDashboard', projectId);
		assert.equal(dashboard.nextAction?.taskId, task.id);
		assert.equal(dashboard.nextAction?.kind, 'attention');
		assert.equal(database.getTask(task.id)?.revision, running.runningTaskRevision);
	});
});

test('task edits, manual Done, and reorder IPC use authorized project and revision snapshots', async () => {
	await withChannel(async (channel, projectId, _bindingId, _descriptorUri, _codeWindow, sender, _otherSender, _forgedSender, database) => {
		const one = await channel.call<{ task: { id: string; revision: number } }>(sender, 'createTask', { projectId, title: 'First' });
		const two = await channel.call<{ task: { id: string; revision: number } }>(sender, 'createTask', { projectId, title: 'Second' });
		const edited = await channel.call<{ title: string; description: string | null; revision: number }>(sender, 'updateTask', {
			projectId, taskId: one.task.id, expectedRevision: one.task.revision, title: 'Renamed', description: 'Task details',
		});
		assert.equal(edited.title, 'Renamed');
		assert.equal(edited.description, 'Task details');
		const done = await channel.call<{ state: string; revision: number }>(sender, 'updateTask', {
			projectId, taskId: one.task.id, expectedRevision: edited.revision, state: 'done',
		});
		assert.equal(done.state, 'done');
		const reordered = await channel.call<Array<{ id: string; order: number }>>(sender, 'reorderTasks', {
			projectId, state: 'ready', orderedTaskRevisions: [{ taskId: two.task.id, revision: two.task.revision }],
		});
		assert.deepEqual(reordered.map(task => [task.id, task.order]), [[two.task.id, 0]]);
		const other = database.createProjectWorkspace('Other', '/work/other', 'file:///other.code-workspace');
		await assert.rejects(channel.call(sender, 'updateTask', { projectId: other.project.id, taskId: one.task.id, expectedRevision: done.revision, state: 'ready' }), /does not match this window/);
		await assert.rejects(channel.call(sender, 'updateTask', { projectId, taskId: one.task.id, expectedRevision: edited.revision, state: 'ready' }), /changed since revision/);
		await assert.rejects(channel.call(sender, 'updateTask', { projectId, taskId: one.task.id, expectedRevision: done.revision }), /At least one task field/);
		await assert.rejects(channel.call(sender, 'updateTask', { projectId, taskId: one.task.id, expectedRevision: done.revision, state: {} }), /valid task state/);
	});
});

test('archive and inactive Trash IPC require the owning project and return tasks to saved state', async () => {
	await withChannel(async (channel, projectId, _bindingId, _descriptorUri, _codeWindow, sender, _otherSender, _forgedSender, database) => {
		const created = await channel.call<{ task: { id: string; revision: number } }>(sender, 'createTask', { projectId, title: 'Lifecycle' });
		const archived = await channel.call<{ archivedAt: string | null; revision: number }>(sender, 'archiveTask', { projectId, taskId: created.task.id, expectedRevision: created.task.revision });
		assert.ok(archived.archivedAt);
		assert.equal((await channel.call<Array<{ id: string }>>(sender, 'listArchivedTasks', projectId))[0].id, created.task.id);
		const unarchived = await channel.call<{ archivedAt: string | null; revision: number }>(sender, 'restoreArchivedTask', { projectId, taskId: created.task.id, expectedRevision: archived.revision });
		assert.equal(unarchived.archivedAt, null);
		const moved = database.updateTask(created.task.id, unarchived.revision, { state: 'review' });
		const requestId = '86f6bd6d-2b2c-44c9-9d0c-6458fd90da55';
		const trashed = await channel.call<{ trashedAt: string | null; revision: number }>(sender, 'trashTask', { projectId, taskId: created.task.id, expectedRevision: moved.revision, requestId });
		assert.ok(trashed.trashedAt);
		const restored = await channel.call<{ state: string; trashedAt: string | null; revision: number }>(sender, 'restoreTrashedTask', { projectId, taskId: created.task.id, expectedRevision: trashed.revision });
		assert.equal(restored.state, 'review');
		assert.equal(restored.trashedAt, null);
		const other = database.createProjectWorkspace('Other', '/work/other', 'file:///other.code-workspace');
		await assert.rejects(channel.call(sender, 'archiveTask', { projectId: other.project.id, taskId: created.task.id, expectedRevision: restored.revision }), /does not match this window/);
	});
});

test('archive and Trash IPC refuse active attempts and explain missing cleanup orchestration', async () => {
	await withChannel(async (channel, projectId, _bindingId, _descriptorUri, _codeWindow, sender, _otherSender, _forgedSender, database) => {
		const created = await channel.call<{ task: { id: string; revision: number } }>(sender, 'createTask', { projectId, title: 'Running' });
		database.createProviderAttempt({ taskId: created.task.id, provider: 'claude', purpose: 'task', profileRef: 'profile:local', folderIdentity: '/work/project', cwd: '/work/project', mode: 'execute', prompt: 'Run' });
		await assert.rejects(channel.call(sender, 'archiveTask', { projectId, taskId: created.task.id, expectedRevision: created.task.revision }), /cannot be archived while it has queued or running attempts/);
		await assert.rejects(channel.call(sender, 'trashTask', { projectId, taskId: created.task.id, expectedRevision: created.task.revision, requestId: '86f6bd6d-2b2c-44c9-9d0c-6458fd90da55' }), /main-process coordinator to cancel owned attempts/);
	});
});

test('Trash delegates to the main-process coordinator only after live project authorization', async () => {
	let calls = 0;
	let reconcileCalls = 0;
	let observed: readonly [string, string, number, string] | undefined;
	let coordinatedTask: WorkspaceTask | undefined;
	const coordinator: TaskDeletionCoordinator = {
		reconcileTaskCleanup: async () => { reconcileCalls++; },
		deleteTask: async (projectId, taskId, expectedRevision, requestId) => {
			calls++;
			observed = [projectId, taskId, expectedRevision, requestId];
			if (!coordinatedTask) { throw new Error('Test coordinator was called before its task was prepared.'); }
			return coordinatedTask;
		},
	};
	await withChannel(async (channel, projectId, _bindingId, _descriptorUri, _codeWindow, sender, _otherSender, _forgedSender, database) => {
		const task = database.createTask({ projectId, bindingId: database.listFolderBindings(projectId)[0].id, title: 'Coordinated delete' });
		coordinatedTask = task;
		const requestId = '86f6bd6d-2b2c-44c9-9d0c-6458fd90da55';
		await channel.call(sender, 'trashTask', { projectId, taskId: task.id, expectedRevision: task.revision, requestId });
		assert.equal(calls, 1);
		assert.deepEqual(observed, [projectId, task.id, task.revision, requestId]);
		await channel.call(sender, 'archiveTask', { projectId, taskId: task.id, expectedRevision: task.revision });
		assert.equal(reconcileCalls, 1);
		const other = database.createProjectWorkspace('Other', '/work/other', 'file:///other.code-workspace');
		await assert.rejects(channel.call(sender, 'trashTask', { projectId: other.project.id, taskId: task.id, expectedRevision: task.revision, requestId }), /does not match this window/);
		await assert.rejects(channel.call(sender, 'archiveTask', { projectId: other.project.id, taskId: task.id, expectedRevision: task.revision }), /does not match this window/);
		assert.equal(calls, 1);
		assert.equal(reconcileCalls, 1);
		await assert.rejects(channel.call(sender, 'beginTaskDeletion', { projectId, taskId: task.id, expectedRevision: task.revision, requestId }), /Call not found/);
	}, coordinator);
});

test('dashboard rejects forged or unrelated senders, mismatched workspaces, and malformed requests', async () => {
	await withChannel(async (channel, projectId, _bindingId, descriptorUri, codeWindow, sender, otherSender, forgedSender) => {
		await assert.rejects(channel.call(forgedSender, 'getDashboard', projectId), /open project window/);
		await assert.rejects(channel.call(otherSender, 'getDashboard', projectId), /open project window/);
		await assert.rejects(channel.call(null as unknown as WebContents, 'getDashboard', projectId), /valid IPC sender/);
		Object.defineProperty(codeWindow, 'openedWorkspace', { value: { id: 'wrong-workspace', configPath: URI.file('/other/project.code-workspace') }, configurable: true });
		await assert.rejects(channel.call(sender, 'getDashboard', projectId), /open workspace does not match/);
		await assert.rejects(channel.call(sender, 'updateDashboardState', { projectId, selectedTaskId: null, dashboardPosition: '0' }), /open workspace does not match/);
		Object.defineProperty(codeWindow, 'openedWorkspace', { value: { id: 'workspace-id', configPath: URI.parse(descriptorUri) }, configurable: true });
		await assert.rejects(channel.call(sender, 'createTask', { projectId: 'bad', title: 'Task' }), /valid project ID/);
		await assert.rejects(channel.call(sender, 'createTask', { projectId, title: '  ' }), /task title/);
		await assert.rejects(channel.call(sender, 'updateDashboardState', { projectId, selectedTaskId: 'bad', dashboardPosition: '0' }), /selected task ID/);
		await assert.rejects(channel.call(sender, 'getDashboard', '00000000-0000-0000-0000-000000000001'), /does not match this window/);
	});
});
