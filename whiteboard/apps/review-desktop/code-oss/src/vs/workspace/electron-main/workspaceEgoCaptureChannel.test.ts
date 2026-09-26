/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import type { WebContents } from 'electron';
import { URI } from '../../base/common/uri.js';
import type { ICodeWindow } from '../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type { StartWorkspaceEgoCaptureRequest, WorkspaceEgoCaptureRecoveryStatus, WorkspaceEgoCaptureRequest, WorkspaceEgoCaptureStatus, WorkspaceEgoSelectedText } from '../common/workspaceBrowserCaptureProtocol.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import { WorkspaceEgoCaptureChannel } from './workspaceEgoCaptureChannel.js';
import { EgoBrowserCaptureError, EgoBrowserCliRuntime, resolveEgoBrowserExecutable, type EgoCaptureRuntime } from './browserCapture/egoCaptureRuntime.js';

test('Ego CLI resolver requires an executable absolute path', () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-ego-cli-path-'));
	try {
		const executable = join(directory, 'ego-browser');
		writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
		chmodSync(executable, 0o700);
		const resolved = resolveEgoBrowserExecutable(executable);
		assert.ok(resolved);
		assert.equal(isAbsolute(resolved), true);
		assert.equal(resolveEgoBrowserExecutable('ego-browser'), undefined);
		const nonExecutable = join(directory, 'not-executable');
		writeFileSync(nonExecutable, '');
		assert.equal(resolveEgoBrowserExecutable(nonExecutable), undefined);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Ego startup failure does not finish a TaskSpace the startup script already closed', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-ego-cli-closed-start-'));
	try {
		const executable = join(directory, 'ego-browser');
		const finishCallsPath = join(directory, 'finish-calls');
		writeFileSync(finishCallsPath, '');
		writeFileSync(executable, `#!/bin/sh
case "$3" in
	*"taskSpace("*)
		printf '%s\\n' '__REVIEW_DESKTOP_EGO__{"event":"space-created","spaceId":41}'
		printf '%s\\n' '__REVIEW_DESKTOP_EGO__{"event":"result","result":{"ok":false,"spaceId":41,"closed":true,"stage":"navigation"}}'
		;;
	*)
		printf x >> '${finishCallsPath}'
		printf '%s\\n' '__REVIEW_DESKTOP_EGO__{"event":"result","result":{"ok":true}}'
		;;
esac
`, { mode: 0o700 });
		chmodSync(executable, 0o700);
		const runtime = new EgoBrowserCliRuntime(executable);
		await assert.rejects(runtime.start('https://example.com'), /could not start a capture page/);
		assert.equal(existsSync(finishCallsPath) && readFileSync(finishCallsPath, 'utf8'), '');
		await runtime.shutdown();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Ego startup preserves a TaskSpace when the startup script could not confirm cleanup', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-ego-cli-uncertain-start-'));
	try {
		const executable = join(directory, 'ego-browser');
		const finishCallsPath = join(directory, 'finish-calls');
		writeFileSync(finishCallsPath, '');
		writeFileSync(executable, `#!/bin/sh
case "$3" in
	*"taskSpace("*)
		printf '%s\\n' '__REVIEW_DESKTOP_EGO__{"event":"space-created","spaceId":42}'
		printf '%s\\n' '__REVIEW_DESKTOP_EGO__{"event":"result","result":{"ok":false,"spaceId":42,"closed":false,"stage":"navigation"}}'
		;;
	*)
		printf x >> '${finishCallsPath}'
		printf '%s\\n' '__REVIEW_DESKTOP_EGO__{"event":"result","result":{"ok":true}}'
		;;
esac
`, { mode: 0o700 });
		chmodSync(executable, 0o700);
		const runtime = new EgoBrowserCliRuntime(executable);
		await assert.rejects(runtime.start('https://example.com'), (error: unknown) => {
			assert.ok(error instanceof EgoBrowserCaptureError);
			assert.equal(error.createdSpaceId, 42);
			assert.equal(error.cleanupPending, true);
			assert.equal(error.diagnostic, 'navigation');
			return true;
		});
		assert.equal(readFileSync(finishCallsPath, 'utf8'), '');
		await runtime.shutdown();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Ego capture hands off one URL, then imports only the confirmed active-page selection', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-ego-capture-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const descriptor = URI.file(join(directory, 'project.code-workspace')).toString();
		const project = database.createProjectWorkspace('Project', directory, descriptor);
		const task = database.createTask({ projectId: project.project.id, bindingId: project.binding.id, title: 'Review source' });
		const window = {
			config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } },
			openedWorkspace: { configPath: URI.parse(descriptor) },
		} as unknown as ICodeWindow;
		const sender = new EventEmitter() as WebContents;
		const otherSender = {} as WebContents;
		const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender ? window : undefined } as IWindowsMainService;
		const startedUrls: string[] = [];
		let selection: WorkspaceEgoSelectedText = { text: 'The exact selected paragraph.', url: 'https://example.com/article#part', title: 'Source article' };
		const runtime: EgoCaptureRuntime = {
			start: async url => { startedUrls.push(url); return 7; },
			captureSelection: async spaceId => { assert.equal(spaceId, 7); return selection; },
			cancel: async () => undefined,
		};
		const channel = new WorkspaceEgoCaptureChannel(database, new WorkspaceDashboardChannel(database, windows), runtime);
		const request: StartWorkspaceEgoCaptureRequest = { projectId: project.project.id, taskId: task.id, url: 'https://example.com/start?ref=desk' };
		const handoff = await channel.call<WorkspaceEgoCaptureStatus>(sender, 'startCapture', request);
		assert.equal(handoff.state, 'handoff');
		assert.deepEqual(startedUrls, ['https://example.com/start?ref=desk']);
		if (handoff.state !== 'handoff') { return; }
		const captureRequest: WorkspaceEgoCaptureRequest = { projectId: project.project.id, taskId: task.id, captureId: handoff.captureId };
		await assert.rejects(channel.call(otherSender, 'captureSelection', captureRequest), /unavailable in this window/);
		await assert.rejects(channel.call(sender, 'captureSelection', { ...captureRequest, projectId: randomUUID() }), /does not match this project and task/);
		const captured = await channel.call<WorkspaceEgoCaptureStatus>(sender, 'captureSelection', captureRequest);
		assert.equal(captured.state, 'captured');
		if (captured.state !== 'captured') { return; }
		const snapshot = database.knowledge.readReference(captured.reference.id)!;
		assert.equal(snapshot.title, 'Source article');
		assert.equal(snapshot.sourceUri, 'https://example.com/article#part');
		assert.equal(new TextDecoder().decode(snapshot.content), 'The exact selected paragraph.');
		assert.deepEqual(database.knowledge.listTaskReferences(task.id).map(reference => reference.id), [snapshot.id]);
		await assert.rejects(channel.call(sender, 'captureSelection', captureRequest), /unavailable in this window/);

		selection = { text: 'ignored', url: 'file:///etc/passwd', title: 'Unsafe' };
		const unsafe = await channel.call<WorkspaceEgoCaptureStatus>(sender, 'startCapture', { ...request, url: 'https://example.com' });
		assert.equal(unsafe.state, 'handoff');
		if (unsafe.state !== 'handoff') { return; }
		const unsafeResult = await channel.call<WorkspaceEgoCaptureStatus>(sender, 'captureSelection', { ...captureRequest, captureId: unsafe.captureId });
		assert.equal(unsafeResult.state, 'failed');
		assert.equal(database.knowledge.listProjectReferences(project.project.id).length, 1);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Ego capture cancellation closes the same TaskSpace and rejects project spoofing', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-ego-capture-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const descriptor = URI.file(join(directory, 'project.code-workspace')).toString();
		const project = database.createProjectWorkspace('Project', directory, descriptor);
		const task = database.createTask({ projectId: project.project.id, bindingId: project.binding.id, title: 'Review source' });
		const window = { config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } }, openedWorkspace: { configPath: URI.parse(descriptor) } } as unknown as ICodeWindow;
		const sender = new EventEmitter() as WebContents;
		const windows = { getWindowByWebContents: () => window } as unknown as IWindowsMainService;
		const cancelledSpaces: number[] = [];
		let resolveDestroyedCleanup: (() => void) | undefined;
		const destroyedCleanup = new Promise<void>(resolve => { resolveDestroyedCleanup = resolve; });
		const runtime: EgoCaptureRuntime = {
			start: async () => 13,
			captureSelection: async () => ({ text: 'unused', url: 'https://example.com', title: 'Example' }),
			cancel: async spaceId => { cancelledSpaces.push(spaceId); if (cancelledSpaces.length === 2) resolveDestroyedCleanup?.(); },
		};
		const channel = new WorkspaceEgoCaptureChannel(database, new WorkspaceDashboardChannel(database, windows), runtime);
		const started = await channel.call<WorkspaceEgoCaptureStatus>(sender, 'startCapture', { projectId: project.project.id, taskId: task.id, url: 'https://example.com' });
		assert.equal(started.state, 'handoff');
		if (started.state !== 'handoff') { return; }
		const result = await channel.call<WorkspaceEgoCaptureStatus>(sender, 'cancelCapture', { projectId: project.project.id, taskId: task.id, captureId: started.captureId });
		assert.equal(result.state, 'cancelled');
		assert.deepEqual(cancelledSpaces, [13]);
		assert.deepEqual(database.knowledge.listProjectReferences(project.project.id), []);
		const windowClosing = await channel.call<WorkspaceEgoCaptureStatus>(sender, 'startCapture', { projectId: project.project.id, taskId: task.id, url: 'https://example.com' });
		assert.equal(windowClosing.state, 'handoff');
		if (windowClosing.state !== 'handoff') { return; }
		await assert.rejects(channel.call(sender, 'startCapture', { projectId: randomUUID(), taskId: task.id, url: 'https://example.com' }), /does not match this window/);
		sender.emit('destroyed');
		await destroyedCleanup;
		await channel.closeSessionsForSender(sender);
		assert.deepEqual(cancelledSpaces, [13, 13]);
		await assert.rejects(channel.call(sender, 'captureSelection', { projectId: project.project.id, taskId: task.id, captureId: windowClosing.captureId }), /unavailable in this window/);
		assert.equal((await channel.call<WorkspaceEgoCaptureStatus>(sender, 'startCapture', { projectId: project.project.id, taskId: task.id, url: 'https://example.com' })).state, 'failed');
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Ego capture recovery reattaches the sender-owned TaskSpace and duplicate starts cannot orphan it', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-ego-capture-recovery-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const descriptor = URI.file(join(directory, 'project.code-workspace')).toString();
		const project = database.createProjectWorkspace('Project', directory, descriptor);
		const task = database.createTask({ projectId: project.project.id, bindingId: project.binding.id, title: 'Review source' });
		const otherTask = database.createTask({ projectId: project.project.id, bindingId: project.binding.id, title: 'Review another source' });
		const window = { config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } }, openedWorkspace: { configPath: URI.parse(descriptor) } } as unknown as ICodeWindow;
		const sender = new EventEmitter() as WebContents;
		const windows = { getWindowByWebContents: () => window } as unknown as IWindowsMainService;
		let starts = 0;
		let cancellations = 0;
		let notifyCancelStarted: (() => void) | undefined;
		const cancelStarted = new Promise<void>(resolve => { notifyCancelStarted = resolve; });
		let finishFirstCancel: (() => void) | undefined;
		const firstCancelGate = new Promise<void>(resolve => { finishFirstCancel = resolve; });
		const runtime: EgoCaptureRuntime = {
			start: async () => { starts++; return 23; },
			captureSelection: async () => ({ text: 'unused', url: 'https://example.com', title: 'Example' }),
			cancel: async () => { cancellations++; if (cancellations === 1) { notifyCancelStarted?.(); await firstCancelGate; throw new Error('temporary close failure'); } },
		};
		const channel = new WorkspaceEgoCaptureChannel(database, new WorkspaceDashboardChannel(database, windows), runtime);
		const request: StartWorkspaceEgoCaptureRequest = { projectId: project.project.id, taskId: task.id, url: 'https://example.com' };
		const [started, duplicate] = await Promise.all([
			channel.call<WorkspaceEgoCaptureStatus>(sender, 'startCapture', request),
			channel.call<WorkspaceEgoCaptureStatus>(sender, 'startCapture', request),
		]);
		assert.equal(started.state, 'handoff');
		if (started.state !== 'handoff') { return; }
		assert.deepEqual(duplicate, started);
		assert.equal(starts, 1);
		await assert.rejects(channel.call(sender, 'startCapture', { ...request, taskId: otherTask.id }), /already active for this window/);
		const recovered = await channel.call<WorkspaceEgoCaptureRecoveryStatus>(sender, 'getActiveCapture', { projectId: project.project.id });
		assert.deepEqual(recovered, { state: 'handoff', captureId: started.captureId, taskId: task.id, cleanupPending: false });
		const closing = channel.call<WorkspaceEgoCaptureStatus>(sender, 'cancelCapture', { projectId: project.project.id, taskId: task.id, captureId: started.captureId });
		await cancelStarted;
		await assert.rejects(channel.call(sender, 'startCapture', request), /already being completed/);
		finishFirstCancel?.();
		const failedClose = await closing;
		assert.equal(failedClose.state, 'failed');
		assert.deepEqual(await channel.call(sender, 'getActiveCapture', { projectId: project.project.id }), recovered);
		const closed = await channel.call<WorkspaceEgoCaptureStatus>(sender, 'cancelCapture', { projectId: project.project.id, taskId: task.id, captureId: started.captureId });
		assert.equal(closed.state, 'cancelled');
		assert.deepEqual(await channel.call(sender, 'getActiveCapture', { projectId: project.project.id }), { state: 'none' });
		assert.equal(cancellations, 2);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('failed cleanup after a destroyed sender preserves the TaskSpace for a shutdown retry', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-ego-capture-close-retry-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const descriptor = URI.file(join(directory, 'project.code-workspace')).toString();
		const project = database.createProjectWorkspace('Project', directory, descriptor);
		const task = database.createTask({ projectId: project.project.id, bindingId: project.binding.id, title: 'Review source' });
		const window = { config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } }, openedWorkspace: { configPath: URI.parse(descriptor) } } as unknown as ICodeWindow;
		const sender = new EventEmitter() as WebContents;
		const windows = { getWindowByWebContents: () => window } as unknown as IWindowsMainService;
		const cancelledSpaces: number[] = [];
		let notifyStarted: (() => void) | undefined;
		const startInvoked = new Promise<void>(resolve => { notifyStarted = resolve; });
		const runtime: EgoCaptureRuntime = {
			start: async () => { notifyStarted?.(); return 29; },
			captureSelection: async () => ({ text: 'unused', url: 'https://example.com', title: 'Example' }),
			cancel: async spaceId => { cancelledSpaces.push(spaceId); if (cancelledSpaces.length === 1) { throw new Error('temporary close failure'); } },
		};
		const channel = new WorkspaceEgoCaptureChannel(database, new WorkspaceDashboardChannel(database, windows), runtime);
		const starting = channel.call<WorkspaceEgoCaptureStatus>(sender, 'startCapture', { projectId: project.project.id, taskId: task.id, url: 'https://example.com' });
		await startInvoked;
		sender.emit('destroyed');
		const result = await starting;
		assert.equal(result.state, 'failed');
		assert.deepEqual(cancelledSpaces, [29]);
		await channel.closeSessionsForSender(sender);
		assert.deepEqual(cancelledSpaces, [29, 29]);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('startup cleanup failure preserves its created TaskSpace for an explicit retry', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-ego-capture-start-retry-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const descriptor = URI.file(join(directory, 'project.code-workspace')).toString();
		const project = database.createProjectWorkspace('Project', directory, descriptor);
		const task = database.createTask({ projectId: project.project.id, bindingId: project.binding.id, title: 'Review source' });
		const window = { config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } }, openedWorkspace: { configPath: URI.parse(descriptor) } } as unknown as ICodeWindow;
		const sender = new EventEmitter() as WebContents;
		const windows = { getWindowByWebContents: () => window } as unknown as IWindowsMainService;
		const cancelledSpaces: number[] = [];
		let starts = 0;
		const runtime: EgoCaptureRuntime = {
			start: async () => { starts++; throw new EgoBrowserCaptureError('Ego Browser could not start or close the capture session.', undefined, 31, true); },
			captureSelection: async () => ({ text: 'unused', url: 'https://example.com', title: 'Example' }),
			cancel: async spaceId => { cancelledSpaces.push(spaceId); },
		};
		const channel = new WorkspaceEgoCaptureChannel(database, new WorkspaceDashboardChannel(database, windows), runtime);
		const request: StartWorkspaceEgoCaptureRequest = { projectId: project.project.id, taskId: task.id, url: 'https://example.com' };
		const failedStart = await channel.call<WorkspaceEgoCaptureStatus>(sender, 'startCapture', request);
		assert.equal(failedStart.state, 'failed');
		assert.equal(starts, 1);
		const recovered = await channel.call<WorkspaceEgoCaptureRecoveryStatus>(sender, 'getActiveCapture', { projectId: project.project.id });
		assert.equal(recovered.state, 'handoff');
		if (recovered.state !== 'handoff') { return; }
		assert.equal(recovered.cleanupPending, true);
		await assert.rejects(channel.call(sender, 'captureSelection', { projectId: project.project.id, taskId: task.id, captureId: recovered.captureId }), /cleanup is pending/);
		const retry = await channel.call<WorkspaceEgoCaptureStatus>(sender, 'cancelCapture', { projectId: project.project.id, taskId: task.id, captureId: recovered.captureId });
		assert.equal(retry.state, 'cancelled');
		assert.deepEqual(cancelledSpaces, [31]);
		assert.deepEqual(await channel.call(sender, 'getActiveCapture', { projectId: project.project.id }), { state: 'none' });
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Ego TaskSpace created during handoff is closed if its project window is destroyed', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-ego-capture-race-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const descriptor = URI.file(join(directory, 'project.code-workspace')).toString();
		const project = database.createProjectWorkspace('Project', directory, descriptor);
		const task = database.createTask({ projectId: project.project.id, bindingId: project.binding.id, title: 'Review source' });
		const window = { config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } }, openedWorkspace: { configPath: URI.parse(descriptor) } } as unknown as ICodeWindow;
		const sender = new EventEmitter() as WebContents;
		const windows = { getWindowByWebContents: () => window } as unknown as IWindowsMainService;
		let resolveStart: ((spaceId: number) => void) | undefined;
		const started = new Promise<number>(resolve => { resolveStart = resolve; });
		let notifyStartInvoked: (() => void) | undefined;
		const startInvoked = new Promise<void>(resolve => { notifyStartInvoked = resolve; });
		const cancelledSpaces: number[] = [];
		const runtime: EgoCaptureRuntime = {
			start: async () => { notifyStartInvoked?.(); return await started; },
			captureSelection: async () => ({ text: 'unused', url: 'https://example.com', title: 'Example' }),
			cancel: async spaceId => { cancelledSpaces.push(spaceId); },
		};
		const channel = new WorkspaceEgoCaptureChannel(database, new WorkspaceDashboardChannel(database, windows), runtime);
		const starting = channel.call<WorkspaceEgoCaptureStatus>(sender, 'startCapture', { projectId: project.project.id, taskId: task.id, url: 'https://example.com' });
		await startInvoked;
		sender.emit('destroyed');
		resolveStart?.(19);
		const result = await starting;
		assert.equal(result.state, 'failed');
		assert.deepEqual(cancelledSpaces, [19]);
		assert.deepEqual(database.knowledge.listProjectReferences(project.project.id), []);
		await channel.closeSessionsForSender(sender);
		assert.deepEqual(cancelledSpaces, [19]);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
