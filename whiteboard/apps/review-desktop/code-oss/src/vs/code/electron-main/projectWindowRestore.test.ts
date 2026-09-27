/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { URI } from '../../base/common/uri.js';
import { hasProjectWindow, ProjectWindowOpenCoordinator, releaseRecordedProjectWindow, restoreProjectWindows, type ProjectWindowIdentity } from './projectWindowRestore.js';

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

test('only a window launched for the project satisfies project reuse and open-at-quit ownership', () => {
	const projectId = 'project-one';
	const descriptorUri = URI.file('/profile/projects/project-one.code-workspace').toString();
	const sameProjectWindow: ProjectWindowIdentity = {
		config: { reviewWindowLaunch: { kind: 'project', projectId, projectName: 'Project One' } },
		openedWorkspace: { id: 'workspace-one', configPath: URI.parse(descriptorUri) },
	};
	const switchedWorkspace: ProjectWindowIdentity = {
		config: sameProjectWindow.config,
		openedWorkspace: { id: 'workspace-two', configPath: URI.file('/profile/projects/other.code-workspace') },
	};
	const projectWindowBeforeLoad: ProjectWindowIdentity = { config: sameProjectWindow.config };
	const descriptorOpenedWindow = {
		config: {},
		openedWorkspace: { id: 'workspace-one', configPath: URI.parse(descriptorUri) },
	};
	const sourceNavigatorWindow = {
		config: { reviewWindowLaunch: { kind: 'sourceNavigator' as const } },
		openedWorkspace: { id: 'workspace-one', configPath: URI.parse(descriptorUri) },
	};
	const otherProjectWindow: ProjectWindowIdentity = {
		config: { reviewWindowLaunch: { kind: 'project', projectId: 'project-two', projectName: 'Project Two' } },
		openedWorkspace: sameProjectWindow.openedWorkspace,
	};

	assert.equal(hasProjectWindow(projectId, descriptorUri, [sameProjectWindow]), true);
	assert.equal(hasProjectWindow(projectId, descriptorUri, [switchedWorkspace]), false);
	assert.equal(hasProjectWindow(projectId, descriptorUri, [projectWindowBeforeLoad]), false);
	assert.equal(hasProjectWindow(projectId, descriptorUri, [descriptorOpenedWindow]), false);
	assert.equal(hasProjectWindow(projectId, descriptorUri, [sourceNavigatorWindow]), false);
	assert.equal(hasProjectWindow(projectId, descriptorUri, [otherProjectWindow]), false);
	assert.equal(hasProjectWindow(projectId, descriptorUri, [switchedWorkspace, sameProjectWindow]), true);
});

test('a switched window retains ownership until its open-at-quit clear succeeds', () => {
	const recorded = new Set([7]);
	let attempts = 0;
	const clear = (): void => {
		attempts++;
		if (attempts === 1) { throw new Error('workspace database busy'); }
	};
	assert.throws(() => releaseRecordedProjectWindow(recorded, 7, false, clear), /database busy/);
	assert.equal(recorded.has(7), true);
	releaseRecordedProjectWindow(recorded, 7, false, clear);
	assert.equal(recorded.has(7), false);
	assert.equal(attempts, 2);
	recorded.add(8);
	releaseRecordedProjectWindow(recorded, 8, true, clear);
	assert.equal(recorded.has(8), false);
	assert.equal(attempts, 2);
});
