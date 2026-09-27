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
	const windows = {
		getWindowByWebContents: () => home,
		getWindows: () => [],
	} as unknown as IWindowsMainService;
	let selected = join(root, 'folder');
	const opened: string[] = [];
	const channel = new WorkspaceProjectHomeChannel(database, workspaces, windows, async () => selected, async id => { opened.push(id); database.markProjectOpened(id); });
	return { root, database, workspaces, channel, home, windows, opened, setSelected: (path: string) => { selected = path; } };
}

test('project home only authorizes a live home window', async () => {
	const state = setup();
	try {
		(state.windows as unknown as { getWindowByWebContents: () => unknown }).getWindowByWebContents = () => ({ config: { reviewWindowLaunch: { kind: 'project', projectId: 'x' } } });
		await assert.rejects(state.channel.call({} as WebContents, 'listProjects'), /project home window/);
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
