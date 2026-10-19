/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SessionNotificationDTO } from '../../common/workspaceAgentSessionProtocol.js';
import {
	publishAgentSessionNotificationAfterCommit,
	runAgentSessionTransaction,
	subscribeToCommittedAgentSessionNotifications,
} from './agentSessionNotificationEvents.js';

const notification: SessionNotificationDTO = Object.freeze({
	id: 'notification-1', eventId: 'source-event-1', projectId: 'project-1', sessionId: 'session-1', sequence: 1,
	kind: 'completion', target: Object.freeze({ kind: 'session', id: 'session-1' }), createdAt: '2026-10-20T00:00:00.000Z', readAt: null,
});

function createDatabase(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec('CREATE TABLE source_events (id TEXT PRIMARY KEY); CREATE TABLE notifications (id TEXT PRIMARY KEY);');
	return db;
}

test('publishes nested committed notification events only after the outer SQLite commit', () => {
	const db = createDatabase();
	const delivered: string[] = [];
	const dispose = subscribeToCommittedAgentSessionNotifications(db, event => delivered.push(event.id), error => { throw error; });
	try {
		runAgentSessionTransaction(db, () => {
			db.prepare('INSERT INTO source_events VALUES (?)').run('outer');
			runAgentSessionTransaction(db, () => {
				db.prepare('INSERT INTO notifications VALUES (?)').run(notification.id);
				publishAgentSessionNotificationAfterCommit(db, notification);
			});
			assert.deepEqual(delivered, [], 'A savepoint release is not an outer commit.');
		});
		assert.deepEqual(delivered, [notification.id]);
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM source_events').get()?.count), 1);
	} finally {
		dispose.dispose();
		db.close();
	}
});

test('discards notifications from nested rollback and publishes surviving outer events', () => {
	const db = createDatabase();
	const delivered: string[] = [];
	const dispose = subscribeToCommittedAgentSessionNotifications(db, event => delivered.push(event.id), error => { throw error; });
	try {
		runAgentSessionTransaction(db, () => {
			db.prepare('INSERT INTO source_events VALUES (?)').run('outer');
			try {
				runAgentSessionTransaction(db, () => {
					db.prepare('INSERT INTO notifications VALUES (?)').run('rolled-back');
					publishAgentSessionNotificationAfterCommit(db, { ...notification, id: 'rolled-back' });
					throw new Error('rollback nested work');
				});
			} catch (error) {
				assert.match(String(error), /rollback nested work/);
			}
			db.prepare('INSERT INTO notifications VALUES (?)').run(notification.id);
			publishAgentSessionNotificationAfterCommit(db, notification);
		});
		assert.deepEqual(delivered, [notification.id]);
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM notifications').get()?.count), 1);
	} finally {
		dispose.dispose();
		db.close();
	}
});

test('outer rollback leaves source and notification rows absent and emits nothing', () => {
	const db = createDatabase();
	const delivered: string[] = [];
	const dispose = subscribeToCommittedAgentSessionNotifications(db, event => delivered.push(event.id), error => { throw error; });
	try {
		assert.throws(() => runAgentSessionTransaction(db, () => {
			db.prepare('INSERT INTO source_events VALUES (?)').run('source');
			db.prepare('INSERT INTO notifications VALUES (?)').run(notification.id);
			publishAgentSessionNotificationAfterCommit(db, notification);
			throw new Error('rollback source transaction');
		}), /rollback source transaction/);
		assert.deepEqual(delivered, []);
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM source_events').get()?.count), 0);
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM notifications').get()?.count), 0);
	} finally {
		dispose.dispose();
		db.close();
	}
});

test('a failed SQLite COMMIT rolls back source and notification rows without emission', () => {
	const db = createDatabase();
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec(`CREATE TABLE deferred_parent (id TEXT PRIMARY KEY);
		CREATE TABLE deferred_child (parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED);`);
	const delivered: string[] = [];
	const dispose = subscribeToCommittedAgentSessionNotifications(db, event => delivered.push(event.id), error => { throw error; });
	try {
		assert.throws(() => runAgentSessionTransaction(db, () => {
			db.prepare('INSERT INTO source_events VALUES (?)').run('source');
			db.prepare('INSERT INTO notifications VALUES (?)').run(notification.id);
			publishAgentSessionNotificationAfterCommit(db, notification);
			db.prepare('INSERT INTO deferred_child VALUES (?)').run('missing-parent');
		}), /FOREIGN KEY constraint failed/i);
		assert.deepEqual(delivered, []);
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM source_events').get()?.count), 0);
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM notifications').get()?.count), 0);
	} finally {
		dispose.dispose();
		db.close();
	}
});

test('observer failures are reported without changing committed source or notification rows', () => {
	const db = createDatabase();
	const reported: unknown[] = [];
	const dispose = subscribeToCommittedAgentSessionNotifications(db, () => { throw new Error('observer failure'); }, error => reported.push(error));
	try {
		assert.doesNotThrow(() => runAgentSessionTransaction(db, () => {
			db.prepare('INSERT INTO source_events VALUES (?)').run('source');
			db.prepare('INSERT INTO notifications VALUES (?)').run(notification.id);
			publishAgentSessionNotificationAfterCommit(db, notification);
		}));
		assert.equal(reported.length, 1);
		assert.match(String(reported[0]), /observer failure/);
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM source_events').get()?.count), 1);
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM notifications').get()?.count), 1);
	} finally {
		dispose.dispose();
		db.close();
	}
});

test('a throwing listener and error handler do not block later observers or escape commit', () => {
	const db = createDatabase();
	const delivered: string[] = [];
	let failingObserverCalls = 0;
	const originalConsoleError = console.error;
	console.error = () => { throw new Error('diagnostic sink failure'); };
	const first = subscribeToCommittedAgentSessionNotifications(db, () => { failingObserverCalls++; throw new Error('observer exception payload'); }, () => { throw new Error('reporter exception payload'); });
	const second = subscribeToCommittedAgentSessionNotifications(db, event => delivered.push(event.id), error => { throw error; });
	try {
		assert.doesNotThrow(() => runAgentSessionTransaction(db, () => {
			db.prepare('INSERT INTO source_events VALUES (?)').run('source');
			db.prepare('INSERT INTO notifications VALUES (?)').run(notification.id);
			publishAgentSessionNotificationAfterCommit(db, notification);
		}));
		assert.deepEqual(delivered, [notification.id]);
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM source_events').get()?.count), 1);
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM notifications').get()?.count), 1);
		assert.doesNotThrow(() => runAgentSessionTransaction(db, () => {
			db.prepare('INSERT INTO source_events VALUES (?)').run('source-2');
			db.prepare('INSERT INTO notifications VALUES (?)').run('notification-2');
			publishAgentSessionNotificationAfterCommit(db, { ...notification, id: 'notification-2', eventId: 'source-event-2', sequence: 2 });
		}));
		assert.deepEqual(delivered, [notification.id, 'notification-2']);
		assert.equal(failingObserverCalls, 1, 'An observer whose error reporter and diagnostic sink both failed is removed.');
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM source_events').get()?.count), 2);
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM notifications').get()?.count), 2);
	} finally {
		first.dispose();
		second.dispose();
		console.error = originalConsoleError;
		db.close();
	}
});
