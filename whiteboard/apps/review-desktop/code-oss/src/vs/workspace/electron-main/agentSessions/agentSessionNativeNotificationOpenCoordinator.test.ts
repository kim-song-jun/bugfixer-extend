/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSessionNativeNotificationOpenCoordinator } from './agentSessionNativeNotificationOpenCoordinator.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';

function fixture(openProject: () => Promise<void> = async () => undefined) {
	const database = WorkspaceDatabase.open(':memory:');
	const project = database.createProject('Private project');
	const binding = database.createFolderBinding({ projectId: project.id, path: '/work/private-project' });
	const sender = database.agentSessions.createSession({
		projectId: project.id, bindingId: binding.id, name: 'Private sender', provider: 'codex', model: 'private', workspaceMode: 'sharedFolder',
	});
	const recipient = database.agentSessions.createSession({
		projectId: project.id, bindingId: binding.id, name: 'Private recipient', provider: 'claude', model: 'private', workspaceMode: 'sharedFolder',
	});
	database.agentSessions.sendMessage(project.id, sender.id, { recipientSessionId: recipient.id, idempotencyKey: 'native-open-test', body: 'private message' });
	const notification = database.agentSessions.listNotifications(project.id, { limit: 1 })[0];
	let descriptor = 'descriptor-original';
	const window = {};
	let dispatched: { notificationId: string; requestId: string } | undefined;
	const coordinator = new AgentSessionNativeNotificationOpenCoordinator({
		getNotification: (projectId, notificationId) => database.agentSessions.getNotification(projectId, notificationId),
		getProjectDescriptor: () => descriptor,
		openProject,
		findProjectWindow: () => window,
		focusWindow: () => undefined,
		dispatchOpen: (_window, notificationId, requestId) => { dispatched = { notificationId, requestId }; },
		timeoutMs: 1000,
	});
	return { database, project, notification, window, coordinator, get descriptor() { return descriptor; }, set descriptor(value: string) { descriptor = value; }, get dispatched() { return dispatched; } };
}

test('shutdown during project opening rejects before creating a pending renderer route', async () => {
	let releaseOpenProject!: () => void;
	const openProject = new Promise<void>(resolve => { releaseOpenProject = resolve; });
	const value = fixture(() => openProject);
	try {
		const route = value.coordinator.open(value.project.id, value.notification.id);
		value.coordinator.shutdown();
		releaseOpenProject();
		await assert.rejects(route, /shutting down/iu);
		assert.equal(value.dispatched, undefined);
		assert.equal(value.coordinator.acknowledge(value.window, value.project.id, value.notification.id, '00000000-0000-4000-8000-000000000001'), false);
		assert.equal(value.database.agentSessions.getNotification(value.project.id, value.notification.id)?.readAt, null);
	} finally {
		value.coordinator.shutdown();
		value.database.close();
	}
});

test('descriptor changes and late acknowledgements cannot complete the exact pending route', async () => {
	const value = fixture();
	try {
		const route = value.coordinator.open(value.project.id, value.notification.id);
		await new Promise<void>(resolve => setImmediate(resolve));
		const dispatched = value.dispatched;
		assert.ok(dispatched);
		value.descriptor = 'descriptor-replaced';
		assert.equal(value.coordinator.acknowledge(value.window, value.project.id, value.notification.id, dispatched.requestId), false);
		value.coordinator.shutdown();
		await assert.rejects(route, /acknowledge/iu);
		assert.equal(value.coordinator.acknowledge(value.window, value.project.id, value.notification.id, dispatched.requestId), false);
		assert.equal(value.database.agentSessions.getNotification(value.project.id, value.notification.id)?.readAt, null);
	} finally {
		value.coordinator.shutdown();
		value.database.close();
	}
});
