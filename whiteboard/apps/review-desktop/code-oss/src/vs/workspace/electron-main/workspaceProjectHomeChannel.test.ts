/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebContents } from 'electron';
import { URI } from '../../base/common/uri.js';
import { WorkspaceProjectHomeChannel } from './workspaceProjectHomeChannel.js';
import { ProjectWorkspaceService } from './projectWorkspaceService.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';

function setup() {
	const root = mkdtempSync(join(tmpdir(), 'workspace-project-home-'));
	mkdirSync(join(root, 'profile'));
	mkdirSync(join(root, 'folder'));
	const database = WorkspaceDatabase.open(join(root, 'workspace.db'));
	const workspaces = new ProjectWorkspaceService(database, join(root, 'profile'));
	const home = { config: { reviewWindowLaunch: { kind: 'home' } }, focus() {} };
	let activeWindow: unknown = home;
	const windows = {
		getWindowByWebContents: () => activeWindow,
		getWindows: () => [],
	} as unknown as IWindowsMainService;
	let selected = join(root, 'folder');
	const opened: string[] = [];
	const channel = new WorkspaceProjectHomeChannel(database, workspaces, windows, async () => selected, async id => { opened.push(id); database.markProjectOpened(id); });
	return { root, database, workspaces, channel, home, windows, opened, setSelected: (path: string) => { selected = path; }, setWindow: (window: unknown) => { activeWindow = window; } };
}

test('rejects unowned callers and project windows with invalid launch IDs', async () => {
	const state = setup();
	try {
		state.setWindow(undefined);
		await assert.rejects(state.channel.call({} as WebContents, 'listProjects'), /requires the native project home or an open project window/);
		state.setWindow({ config: { reviewWindowLaunch: { kind: 'sourceNavigator' } } });
		await assert.rejects(state.channel.call({} as WebContents, 'listProjects'), /requires the native project home or an open project window/);
		state.setWindow({ config: { reviewWindowLaunch: { kind: 'project', projectId: 'x' } } });
		await assert.rejects(state.channel.call({} as WebContents, 'listProjects'), /invalid project ID/);
	} finally { state.database.close(); rmSync(state.root, { recursive: true, force: true }); }
});

test('native project window can list and open projects only while its descriptor matches its launch project', async () => {
	const state = setup();
	try {
		const current = state.workspaces.createProject('current', join(state.root, 'folder'));
		mkdirSync(join(state.root, 'other-folder'));
		const other = state.workspaces.createProject('other', join(state.root, 'other-folder'));
		const projectWindow = (projectId: string, descriptorUri: string) => ({
			config: { reviewWindowLaunch: { kind: 'project', projectId } },
			openedWorkspace: { configPath: URI.parse(descriptorUri) },
		});
		state.setWindow(projectWindow(current.project.id, current.view.descriptorUri));
		const listed = await state.channel.call<readonly { id: string }[]>({} as WebContents, 'listProjects');
		assert.deepEqual(listed.map(project => project.id).sort(), [current.project.id, other.project.id].sort());
		await state.channel.call({} as WebContents, 'openProject', other.project.id);
		assert.deepEqual(state.opened, [other.project.id]);

		state.setWindow(projectWindow(current.project.id, other.view.descriptorUri));
		await assert.rejects(state.channel.call({} as WebContents, 'listProjects'), /does not match this project/);
		await assert.rejects(state.channel.call({} as WebContents, 'openProject', other.project.id), /does not match this project/);

		state.setWindow(projectWindow('00000000-0000-4000-8000-000000000001', current.view.descriptorUri));
		await assert.rejects(state.channel.call({} as WebContents, 'listProjects'), /unavailable/);
		state.setWindow(projectWindow(current.project.id, current.view.descriptorUri));
		await assert.rejects(state.channel.call({} as WebContents, 'chooseFolder'), /requires the native project home window/);
		assert.deepEqual(state.opened, [other.project.id]);
	} finally { state.database.close(); rmSync(state.root, { recursive: true, force: true }); }
});

test('chooseFolder reuses canonical folder and openProject orders by actual opens', async () => {
	const state = setup();
	try {
		const project = state.workspaces.createProject('folder', join(state.root, 'folder'));
		mkdirSync(join(state.root, 'second-folder'));
		const second = state.workspaces.createProject('second-folder', join(state.root, 'second-folder'));
		const alias = join(state.root, 'alias');
		symlinkSync(join(state.root, 'folder'), alias);
		state.setSelected(alias);
		const reused = await state.channel.call<{ id: string }>({} as WebContents, 'chooseFolder');
		assert.equal(reused.id, project.project.id);
		assert.equal(state.database.listProjects().length, 2);
		await state.channel.call({} as WebContents, 'openProject', project.project.id);
		await new Promise(resolve => setTimeout(resolve, 2));
		await state.channel.call({} as WebContents, 'openProject', second.project.id);
		const listed = await state.channel.call<readonly { id: string; lastOpenedAt: string | null }[]>({} as WebContents, 'listProjects');
		assert.equal(listed[0].id, second.project.id);
		assert.ok(listed[0].lastOpenedAt);
		assert.ok(listed[1].lastOpenedAt);
		assert.deepEqual(state.opened, [project.project.id, second.project.id]);
		state.database.close();
		const reopened = WorkspaceDatabase.open(join(state.root, 'workspace.db'));
		try {
			const persisted = reopened.listProjects().map(item => ({ id: item.id, lastOpenedAt: reopened.getProjectLastOpenedAt(item.id) })).sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''));
			assert.equal(persisted[0].id, second.project.id);
		} finally { reopened.close(); }
	} finally { state.database.close(); rmSync(state.root, { recursive: true, force: true }); }
});


test('openProject rejects unknown IDs before asking main to open a window', async () => {
	const state = setup();
	try {
		await assert.rejects(state.channel.call({} as WebContents, 'openProject', '00000000-0000-4000-8000-000000000001'), /does not exist/);
		assert.deepEqual(state.opened, []);
	} finally { state.database.close(); rmSync(state.root, { recursive: true, force: true }); }
});
