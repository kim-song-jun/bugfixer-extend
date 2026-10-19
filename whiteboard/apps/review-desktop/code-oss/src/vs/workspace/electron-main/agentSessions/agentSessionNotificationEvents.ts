/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync } from 'node:sqlite';
import type { SessionNotificationDTO } from '../../common/workspaceAgentSessionProtocol.js';

interface TransactionFrame {
	readonly savepoint: string | undefined;
	readonly notifications: SessionNotificationDTO[];
}

interface NotificationEventState {
	readonly frames: TransactionFrame[];
	readonly listeners: Set<NotificationObserver>;
	sequence: number;
}

type NotificationListener = (notification: SessionNotificationDTO) => void;
type ObserverErrorHandler = (error: unknown) => void;
interface NotificationObserver {
	readonly listener: NotificationListener;
	readonly onError: ObserverErrorHandler;
}

const states = new WeakMap<DatabaseSync, NotificationEventState>();

function stateFor(db: DatabaseSync): NotificationEventState {
	let state = states.get(db);
	if (!state) {
		state = { frames: [], listeners: new Set(), sequence: 0 };
		states.set(db, state);
	}
	return state;
}

/** Runs synchronous work in a SQLite transaction and publishes queued alerts only after the outer commit. */
export function runAgentSessionTransaction<T>(db: DatabaseSync, operation: () => T): T {
	const state = stateFor(db);
	if (db.isTransaction && state.frames.length === 0) {
		throw new Error('Agent session transactions must own the outer SQLite transaction.');
	}
	const parent = state.frames.at(-1);
	const savepoint = parent ? `agent_session_event_${++state.sequence}` : undefined;
	const frame: TransactionFrame = { savepoint, notifications: [] };
	db.exec(savepoint ? `SAVEPOINT ${savepoint};` : 'BEGIN IMMEDIATE;');
	state.frames.push(frame);

	let value: T;
	try {
		value = operation();
		db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint};` : 'COMMIT;');
	} catch (error) {
		state.frames.pop();
		try {
			db.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint};` : 'ROLLBACK;');
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], 'The agent session transaction failed and could not be rolled back cleanly.');
		}
		throw error;
	}

	state.frames.pop();
	if (parent) {
		parent.notifications.push(...frame.notifications);
	} else {
		for (const notification of frame.notifications) {
			for (const observer of [...state.listeners]) {
				try {
					observer.listener(notification);
				} catch (error) {
					try {
						observer.onError(error);
					} catch {
						if (!reportObserverError()) {
							state.listeners.delete(observer);
						}
					}
				}
			}
		}
	}
	return value;
}

/** Queues a newly inserted durable notification for publication at the outermost successful commit. */
export function publishAgentSessionNotificationAfterCommit(db: DatabaseSync, notification: SessionNotificationDTO): void {
	const frame = stateFor(db).frames.at(-1);
	if (!frame) {
		throw new Error('A session notification can only be published from its source transaction.');
	}
	frame.notifications.push(Object.freeze({ ...notification, target: Object.freeze({ ...notification.target }) }));
}

/** Rejects unmanaged transactions before a source writer can change durable state. */
export function assertAgentSessionTransactionManaged(db: DatabaseSync): void {
	if (!db.isTransaction || stateFor(db).frames.length === 0) {
		throw new Error('A durable session notification requires an agent session transaction.');
	}
}

/** Subscribes to newly committed notifications. The returned function releases the listener. */
export function subscribeToCommittedAgentSessionNotifications(
	db: DatabaseSync,
	listener: NotificationListener,
	onObserverError: ObserverErrorHandler,
): { dispose(): void } {
	if (typeof onObserverError !== 'function') {
		throw new TypeError('A notification observer error handler is required.');
	}
	const listeners = stateFor(db).listeners;
	const observer = { listener, onError: onObserverError };
	listeners.add(observer);
	return { dispose: () => listeners.delete(observer) };
}

function reportObserverError(): boolean {
	// Do not retain exception payloads or let unavailable logging escape an already committed operation.
	try {
		console.error('Committed session notification observer error handler failed.');
		return true;
	} catch {
		return false;
	}
}
