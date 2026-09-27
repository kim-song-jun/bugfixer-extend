/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { URI } from '../../base/common/uri.js';
import { hasProjectWindow, ProjectWindowOpenCoordinator, restoreProjectWindows, type ProjectWindowIdentity } from './projectWindowRestore.js';

test('concurrent project opens share one window creation and allow retry after failure', async () => {
	const coordinator = new ProjectWindowOpenCoordinator<string>();
	let resolveWindow!: (value: string) => void;
	const windowReady = new Promise<string>(resolve => { resolveWindow = resolve; });
	let starts = 0;
	const first = coordinator.open('project-one', async () => { starts++; return windowReady; });
	const second = coordinator.open('project-one', async () => { starts++; return 'duplicate'; });
	await Promise.resolve();
	assert.equal(starts, 1);
	resolveWindow('one window');
	assert.deepEqual(await Promise.all([first, second]), ['one window', 'one window']);
	assert.equal(coordinator.get('project-one'), undefined);

	await assert.rejects(coordinator.open('project-two', async () => { throw new Error('folder missing'); }), /folder missing/);
	assert.equal(coordinator.get('project-two'), undefined);
	assert.equal(await coordinator.open('project-two', async () => 'reopened'), 'reopened');
});

test('startup restoration skips already open and duplicate projects, continues after a surfaced failure', async () => {
	const opened: string[] = [];
	const failures: Array<{ projectId: string; error: unknown }> = [];
	await restoreProjectWindows(
		['already-open', 'first', 'broken', 'first', 'last'],
		['already-open'],
		async projectId => {
			opened.push(projectId);
			if (projectId === 'broken') { throw new Error('folder unavailable'); }
		},
		(projectId, error) => failures.push({ projectId, error }),
	);
	assert.deepEqual(opened, ['first', 'broken', 'last']);
	assert.equal(failures.length, 1);
	assert.equal(failures[0].projectId, 'broken');
	assert.match(String(failures[0].error), /folder unavailable/);
});

test('closing one window preserves open-at-quit while another window still owns the same project', () => {
	const projectId = 'project-one';
	const descriptorUri = URI.file('/profile/projects/project-one.code-workspace').toString();
	const sameProjectWindow: ProjectWindowIdentity = {
		config: { reviewWindowLaunch: { kind: 'project', projectId, projectName: 'Project One' } },
	};
	const descriptorOpenedWindow: ProjectWindowIdentity = {
		openedWorkspace: { id: 'workspace-one', configPath: URI.parse(descriptorUri) },
	};
	const otherProjectWindow: ProjectWindowIdentity = {
		config: { reviewWindowLaunch: { kind: 'project', projectId: 'project-two', projectName: 'Project Two' } },
	};

	assert.equal(hasProjectWindow(projectId, descriptorUri, [sameProjectWindow]), true);
	assert.equal(hasProjectWindow(projectId, descriptorUri, [descriptorOpenedWindow]), true);
	assert.equal(hasProjectWindow(projectId, descriptorUri, [otherProjectWindow]), false);
});
