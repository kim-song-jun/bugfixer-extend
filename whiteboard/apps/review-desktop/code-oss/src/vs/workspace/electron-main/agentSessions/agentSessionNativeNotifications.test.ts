/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { AgentSessionNativeNotification, AgentSessionNativeNotificationSink } from './agentSessionNativeNotifications.js';
import { AgentSessionNativeNotifications } from './agentSessionNativeNotifications.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';

class NotificationFixture extends EventEmitter implements AgentSessionNativeNotification {
	closed = false;
	constructor(readonly options: { readonly title: string; readonly body: string }, private readonly failOnShow = false, private readonly noSettlement = false, private readonly failEvent = false) { super(); }
	show(): void {
		if (this.failOnShow) { throw new Error('private fixture failure detail'); }
		if (this.failEvent) { this.emit('failed', {}, 'private fixture failure detail'); return; }
		if (!this.noSettlement) { this.emit('show'); }
	}
	close(): void { this.closed = true; this.emit('close'); }
}

function fixture(options?: { readonly supported?: boolean; readonly failOnShow?: boolean; readonly noSettlement?: boolean; readonly failEvent?: boolean; readonly deliveryTimeoutMs?: number }) {
	const database = WorkspaceDatabase.open(':memory:');
	const project = database.createProject('Private project name');
	const binding = database.createFolderBinding({ projectId: project.id, path: '/work/private-project' });
	const sender = database.agentSessions.createSession({
		projectId: project.id, bindingId: binding.id, name: 'Secret sender name', provider: 'codex', model: 'private-model', workspaceMode: 'sharedFolder',
	});
	const recipient = database.agentSessions.createSession({
		projectId: project.id, bindingId: binding.id, name: 'Secret recipient name', provider: 'claude', model: 'private-model', workspaceMode: 'sharedFolder',
	});
	const state = new Map<string, unknown>();
	const stateService = {
		getItem<T>(key: string, defaultValue: T): T { return (state.has(key) ? state.get(key) : defaultValue) as T; },
		setItem(key: string, value: unknown): void { state.set(key, value); },
	};
	const created: NotificationFixture[] = [];
	const sink: AgentSessionNativeNotificationSink = {
		isSupported: () => options?.supported ?? true,
		create: value => {
			const notification = new NotificationFixture(value, options?.failOnShow, options?.noSettlement, options?.failEvent);
			created.push(notification);
			return notification;
		},
	};
	const errors: string[] = [];
	const logger = { error: (message?: unknown) => errors.push(String(message)) };
	const routes: Array<{ readonly projectId: string; readonly notificationId: string }> = [];
	const service = new AgentSessionNativeNotifications(
		database.agentSessions,
		stateService,
		sink,
		async (projectId, notificationId) => { routes.push({ projectId, notificationId }); },
		logger,
		options?.deliveryTimeoutMs,
	);
	return { database, project, sender, recipient, service, created, routes, errors, state };
}

function commitMessageNotification(value: ReturnType<typeof fixture>, body = 'private-token-123 and source text', idempotencyKey = 'native-alert-fixture') {
	const message = value.database.agentSessions.sendMessage(value.project.id, value.sender.id, {
		recipientSessionId: value.recipient.id,
		idempotencyKey,
		body,
	});
	const notification = value.database.agentSessions.getNotification(value.project.id, value.database.agentSessions.listNotifications(value.project.id, { limit: 1 })[0].id)!;
	assert.equal(notification.target.kind, 'message');
	assert.equal(notification.target.id, message.id);
	return notification;
}

test('native session notifications are off by default while SQLite retains the committed unread alert', () => {
	const value = fixture();
	try {
		const notification = commitMessageNotification(value);
		assert.equal(value.service.getStatus().enabled, false);
		assert.equal(value.created.length, 0);
		assert.deepEqual(value.database.agentSessions.getNotification(value.project.id, notification.id), notification);
		assert.equal(value.database.agentSessions.notificationStatus(value.project.id).unreadCount, 1);
	} finally {
		value.service.dispose();
		value.database.close();
	}
});

test('opted-in native alerts contain only generic kind text and route the exact committed project and notification ID', async () => {
	const value = fixture();
	try {
		value.service.setEnabled(true);
		const notification = commitMessageNotification(value, 'secret account, message, and token');
		assert.equal(value.created.length, 1);
		const native = value.created[0];
		assert.equal(native.options.title, 'Whiteboard · AI 세션');
		assert.equal(native.options.body, 'AI 세션에 새 메시지가 도착했습니다.');
		assert.doesNotMatch(JSON.stringify(native.options), /private project|secret sender|secret recipient|secret account|message, and token|token-123|private-model/iu);
		native.emit('click');
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(value.routes, [{ projectId: value.project.id, notificationId: notification.id }]);
		assert.equal(value.database.agentSessions.notificationStatus(value.project.id).unreadCount, 1);
	} finally {
		value.service.dispose();
		value.database.close();
	}
});

test('unsupported native delivery and failed show preserve unread in-app state and report permission as unknown', () => {
	const unsupported = fixture({ supported: false });
	try {
		unsupported.service.setEnabled(true);
		commitMessageNotification(unsupported);
		assert.equal(unsupported.service.getStatus().availability, 'unsupported');
		assert.equal(unsupported.service.getStatus().lastDelivery, 'notAttempted');
		assert.equal(unsupported.created.length, 0);
		assert.equal(unsupported.database.agentSessions.notificationStatus(unsupported.project.id).unreadCount, 1);
	} finally {
		unsupported.service.dispose();
		unsupported.database.close();
	}

	const failed = fixture({ failOnShow: true });
	try {
		failed.service.setEnabled(true);
		commitMessageNotification(failed);
		assert.equal(failed.service.getStatus().availability, 'supported');
		assert.equal(failed.service.getStatus().lastDelivery, 'failed');
		assert.equal(failed.database.agentSessions.notificationStatus(failed.project.id).unreadCount, 1);
		assert.equal(failed.errors.some(message => /permission state is unknown/iu.test(message)), true);
		assert.equal(failed.errors.some(message => /private fixture failure detail|token|source text/iu.test(message)), false);
	} finally {
		failed.service.dispose();
		failed.database.close();
	}

	const failedEvent = fixture({ failEvent: true });
	try {
		failedEvent.service.setEnabled(true);
		commitMessageNotification(failedEvent);
		assert.equal(failedEvent.service.getStatus().lastDelivery, 'failed');
		assert.equal(failedEvent.created[0].closed, true);
		assert.equal(failedEvent.created[0].listenerCount('click'), 0);
		assert.equal(failedEvent.database.agentSessions.notificationStatus(failedEvent.project.id).unreadCount, 1);
		assert.equal(failedEvent.errors.some(message => /private fixture failure detail|token|source text/iu.test(message)), false);
	} finally {
		failedEvent.service.dispose();
		failedEvent.database.close();
	}
});

test('native delivery without show or failed settlement times out, closes, and preserves the unread alert', async () => {
	const value = fixture({ noSettlement: true, deliveryTimeoutMs: 5 });
	try {
		value.service.setEnabled(true);
		commitMessageNotification(value);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(value.service.getStatus().lastDelivery, 'failed');
		assert.equal(value.created[0].closed, true);
		assert.equal(value.created[0].listenerCount('click'), 0);
		assert.equal(value.database.agentSessions.notificationStatus(value.project.id).unreadCount, 1);
		assert.equal(value.errors.some(message => /permission state is unknown/iu.test(message)), true);
	} finally {
		value.service.dispose();
		value.database.close();
	}
});

test('closing before show or failed settles the delivery as unconfirmed and preserves the durable unread alert', () => {
	const value = fixture({ noSettlement: true, deliveryTimeoutMs: 1000 });
	try {
		value.service.setEnabled(true);
		const notification = commitMessageNotification(value);
		value.created[0].close();
		assert.equal(value.service.getStatus().lastDelivery, 'failed');
		assert.equal(value.created[0].listenerCount('click'), 0);
		assert.equal(value.errors.some(message => /closed before delivery was confirmed/iu.test(message)), true);
		assert.equal(value.database.agentSessions.getNotification(value.project.id, notification.id)?.readAt, null);
	} finally {
		value.service.dispose();
		value.database.close();
	}
});

test('late close from an older native alert cannot overwrite the latest delivery status', () => {
	const value = fixture({ noSettlement: true, deliveryTimeoutMs: 1000 });
	try {
		value.service.setEnabled(true);
		commitMessageNotification(value, 'first', 'native-alert-older-attempt');
		commitMessageNotification(value, 'second', 'native-alert-latest-attempt');
		value.created[1].emit('show');
		assert.equal(value.service.getStatus().lastDelivery, 'shown');
		value.created[0].close();
		assert.equal(value.service.getStatus().lastDelivery, 'shown');
	} finally {
		value.service.dispose();
		value.database.close();
	}
});

test('disabling while an OS delivery is unconfirmed clears its deadline without changing unread state', async () => {
	const value = fixture({ noSettlement: true, deliveryTimeoutMs: 20 });
	try {
		value.service.setEnabled(true);
		commitMessageNotification(value);
		value.service.setEnabled(false);
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.equal(value.service.getStatus().lastDelivery, 'failed');
		assert.equal(value.created[0].closed, true);
		assert.equal(value.database.agentSessions.notificationStatus(value.project.id).unreadCount, 1);
	} finally {
		value.service.dispose();
		value.database.close();
	}
});

test('disabling or shutting down closes active OS notices and stops committed-event delivery', () => {
	const value = fixture();
	try {
		value.service.setEnabled(true);
		commitMessageNotification(value);
		const active = value.created[0];
		value.service.setEnabled(false);
		assert.equal(value.service.getStatus().enabled, false);
		assert.equal(active.listenerCount('click'), 0);
		assert.equal(active.closed, true);
		assert.equal(value.database.agentSessions.notificationStatus(value.project.id).unreadCount, 1);
		value.service.setEnabled(true);
		commitMessageNotification(value, 'shutdown notice', 'native-alert-fixture-shutdown');
		const shutdownActive = value.created[1];
		value.service.dispose();
		assert.equal(shutdownActive.listenerCount('click'), 0);
		assert.equal(shutdownActive.closed, true);
		commitMessageNotification(value, 'second committed body', 'native-alert-fixture-second');
		assert.equal(value.created.length, 2);
		assert.equal(value.database.agentSessions.notificationStatus(value.project.id).unreadCount, 3);
	} finally {
		value.service.dispose();
		value.database.close();
	}
});
