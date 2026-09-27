import * as assert from 'assert';
import { test } from 'node:test';
import { reviewWindowLaunchForWorkspace } from './reviewWindowLaunchPolicy.js';

const project = { projectId: 'project-1', projectName: 'Project One' };

test('known app-owned workspace descriptors launch as projects during running-app launches', () => {
	assert.deepStrictEqual(reviewWindowLaunchForWorkspace(undefined, true, false, project), { kind: 'project', ...project });
});

test('explicit source navigator launch is preserved for a known project descriptor', () => {
	assert.deepStrictEqual(reviewWindowLaunchForWorkspace({ kind: 'sourceNavigator' }, true, false, project), { kind: 'sourceNavigator' });
});

test('unknown workspaces remain source navigator launches', () => {
	assert.deepStrictEqual(reviewWindowLaunchForWorkspace(undefined, true, false, undefined), { kind: 'sourceNavigator' });
	assert.deepStrictEqual(reviewWindowLaunchForWorkspace(undefined, false, false, project), { kind: 'sourceNavigator' });
});

test('an explicit project launch cannot acquire another descriptor project identity', () => {
	const requestedProject = { kind: 'project' as const, projectId: 'requested-project', projectName: 'Requested' };
	assert.throws(() => reviewWindowLaunchForWorkspace(requestedProject, true, false, project), /must match their workspace descriptor/);
	assert.throws(() => reviewWindowLaunchForWorkspace(requestedProject, false, false, project), /must match their workspace descriptor/);
	assert.deepStrictEqual(reviewWindowLaunchForWorkspace(requestedProject, true, true, project), requestedProject);
});

test('invalid resolved project identities remain source navigator launches', () => {
	assert.deepStrictEqual(reviewWindowLaunchForWorkspace(undefined, true, false, { projectId: ' ', projectName: 'Project' }), { kind: 'sourceNavigator' });
});
