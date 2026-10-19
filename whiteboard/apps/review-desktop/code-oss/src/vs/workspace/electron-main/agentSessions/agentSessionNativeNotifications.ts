/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Notification } from 'electron';
import type { IStateService } from '../../../platform/state/node/state.js';
import type { ILogService } from '../../../platform/log/common/log.js';
import type { SessionNotificationDTO } from '../../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceAgentSessionNativeNotificationStatus } from '../../common/workspaceAgentCommunicationProtocol.js';

export interface AgentSessionNativeNotificationSource {
	onDidCommitNotification(listener: (notification: SessionNotificationDTO) => void, onError: (error: unknown) => void): { dispose(): void };
}

export interface AgentSessionNativeNotificationSink {
	isSupported(): boolean;
	create(options: { readonly title: string; readonly body: string }): AgentSessionNativeNotification;
}

export interface AgentSessionNativeNotification extends Pick<Notification, 'show' | 'close' | 'removeAllListeners'> {
	on(event: 'show' | 'click' | 'close', listener: () => void): this;
	on(event: 'failed', listener: (_event: Electron.Event, error: string) => void): this;
}

export type AgentSessionNotificationRoute = (projectId: string, notificationId: string) => Promise<void>;

const ENABLED_KEY = 'bugfixer.agentSessions.nativeNotifications.enabled';
const MAX_ACTIVE_NOTIFICATIONS = 32;
const TITLE = 'Whiteboard · AI 세션';

const BODIES: Readonly<Record<SessionNotificationDTO['kind'], string>> = Object.freeze({
	input: 'AI 세션에서 입력을 기다립니다.',
	approval: 'AI 세션에서 검토 승인을 기다립니다.',
	error: 'AI 세션에서 오류가 발생했습니다.',
	completion: 'AI 세션 작업이 완료되었습니다.',
	message: 'AI 세션에 새 메시지가 도착했습니다.',
	prReady: 'AI 세션에서 PR 검토 준비가 완료되었습니다.',
});

/** Owns optional OS delivery. The durable in-app notification remains authoritative. */
export class AgentSessionNativeNotifications {
	private readonly subscription: { dispose(): void };
	private readonly active = new Map<string, AgentSessionNativeNotification>();
	private readonly deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private attemptSequence = 0;
	private latestAttemptSequence = 0;
	private readonly attempts = new WeakMap<AgentSessionNativeNotification, { readonly sequence: number; settled: boolean }>();
	private availability: WorkspaceAgentSessionNativeNotificationStatus['availability'] = 'unknown';
	private lastDelivery: WorkspaceAgentSessionNativeNotificationStatus['lastDelivery'] = 'notAttempted';
	private disposed = false;

	constructor(
		private readonly source: AgentSessionNativeNotificationSource,
		private readonly stateService: Pick<IStateService, 'getItem' | 'setItem'>,
		private readonly sink: AgentSessionNativeNotificationSink,
		private readonly route: AgentSessionNotificationRoute,
		private readonly logService: Pick<ILogService, 'error'>,
		private readonly deliveryTimeoutMs = 10_000,
	) {
		this.subscription = source.onDidCommitNotification(
			notification => this.deliver(notification),
			() => {
				this.lastDelivery = 'failed';
				this.logGenericError('[Whiteboard] A committed AI session notification could not be delivered to the native alert service.');
			},
		);
	}

	getStatus(): WorkspaceAgentSessionNativeNotificationStatus {
		return Object.freeze({
			enabled: this.stateService.getItem<boolean>(ENABLED_KEY, false) === true,
			availability: this.availability,
			lastDelivery: this.lastDelivery,
		});
	}

	setEnabled(enabled: boolean): WorkspaceAgentSessionNativeNotificationStatus {
		if (this.disposed) { throw new Error('The native AI session notification service is shutting down.'); }
		if (typeof enabled !== 'boolean') { throw new TypeError('The native notification preference must be a boolean.'); }
		this.stateService.setItem(ENABLED_KEY, enabled);
		if (!enabled) { this.closeActiveNotifications(); }
		return this.getStatus();
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.subscription.dispose();
		this.closeActiveNotifications();
	}

	private deliver(notification: SessionNotificationDTO): void {
		if (this.disposed || !this.getStatus().enabled) { return; }
		const attemptSequence = ++this.attemptSequence;
		this.latestAttemptSequence = attemptSequence;
		let supported: boolean;
		try {
			supported = this.sink.isSupported();
		} catch {
			this.availability = 'unknown';
			this.setDeliveryStatus(attemptSequence, 'failed');
			this.logGenericError('[Whiteboard] Native AI session notification support could not be checked.');
			return;
		}
		this.availability = supported ? 'supported' : 'unsupported';
		if (!supported) {
			this.lastDelivery = 'notAttempted';
			return;
		}

		let nativeNotification: AgentSessionNativeNotification;
		try {
			nativeNotification = this.sink.create({ title: TITLE, body: BODIES[notification.kind] });
		} catch {
			this.setDeliveryStatus(attemptSequence, 'failed');
			this.logGenericError('[Whiteboard] A native AI session notification could not be created.');
			return;
		}

		const attempt = { sequence: attemptSequence, settled: false };
		this.attempts.set(nativeNotification, attempt);
		this.track(notification.id, nativeNotification);
		try {
			nativeNotification.on('show', () => {
				if (attempt.settled) { return; }
				attempt.settled = true;
				this.clearDeliveryTimer(notification.id);
				this.setDeliveryStatus(attempt.sequence, 'shown');
			});
			nativeNotification.on('click', () => { void this.openNotification(notification); });
			nativeNotification.on('failed', () => {
				if (attempt.settled) { return; }
				attempt.settled = true;
				this.clearDeliveryTimer(notification.id);
				this.setDeliveryStatus(attempt.sequence, 'failed');
				this.release(notification.id, nativeNotification);
				this.closeNativeNotification(nativeNotification);
				this.logGenericError('[Whiteboard] The operating system did not confirm delivery of an AI session notification. Its notification permission state is unknown.');
			});
			nativeNotification.on('close', () => {
				if (!attempt.settled) {
					attempt.settled = true;
					this.setDeliveryStatus(attempt.sequence, 'failed');
					this.logGenericError('[Whiteboard] Native AI session notification closed before delivery was confirmed. Its notification permission state is unknown.');
				}
				this.clearDeliveryTimer(notification.id);
				this.release(notification.id, nativeNotification);
			});
			this.deliveryTimers.set(notification.id, setTimeout(() => {
				this.deliveryTimers.delete(notification.id);
				if (this.active.get(notification.id) !== nativeNotification) { return; }
				if (attempt.settled) { return; }
				attempt.settled = true;
				this.setDeliveryStatus(attempt.sequence, 'failed');
				this.release(notification.id, nativeNotification);
				this.closeNativeNotification(nativeNotification);
				this.logGenericError('[Whiteboard] Native AI session notification delivery was not confirmed before timeout. Its notification permission state is unknown.');
			}, this.deliveryTimeoutMs));
			nativeNotification.show();
		} catch {
			this.clearDeliveryTimer(notification.id);
			attempt.settled = true;
			this.setDeliveryStatus(attempt.sequence, 'failed');
			this.release(notification.id, nativeNotification);
			this.closeNativeNotification(nativeNotification);
			this.logGenericError('[Whiteboard] A native AI session notification could not be shown. Its notification permission state is unknown.');
		}
	}

	private setDeliveryStatus(sequence: number, status: WorkspaceAgentSessionNativeNotificationStatus['lastDelivery']): void {
		if (sequence === this.latestAttemptSequence) { this.lastDelivery = status; }
	}

	private track(id: string, notification: AgentSessionNativeNotification): void {
		this.clearDeliveryTimer(id);
		const previous = this.active.get(id);
		if (previous) {
			this.markUnconfirmed(previous, '[Whiteboard] A replaced native AI session notification closed before delivery was confirmed. Its notification permission state is unknown.');
			this.active.delete(id);
			previous.removeAllListeners();
			this.closeNativeNotification(previous);
		}
		this.active.set(id, notification);
		while (this.active.size > MAX_ACTIVE_NOTIFICATIONS) {
			const oldest = this.active.entries().next().value as [string, AgentSessionNativeNotification] | undefined;
			if (!oldest) { break; }
			this.markUnconfirmed(oldest[1], '[Whiteboard] A native AI session notification closed before delivery was confirmed. Its notification permission state is unknown.');
			this.release(oldest[0], oldest[1]);
			this.closeNativeNotification(oldest[1]);
		}
	}

	private async openNotification(notification: SessionNotificationDTO): Promise<void> {
		try {
			await this.route(notification.projectId, notification.id);
		} catch {
			this.logGenericError('[Whiteboard] A native AI session notification could not open its saved project and exact alert. The in-app alert remains unread.');
		}
	}

	private release(id: string, notification: AgentSessionNativeNotification): void {
		if (this.active.get(id) !== notification) { return; }
		this.clearDeliveryTimer(id);
		this.active.delete(id);
		notification.removeAllListeners();
	}

	private closeActiveNotifications(): void {
		const active = [...this.active.entries()];
		this.active.clear();
		for (const [id, notification] of active) {
			this.clearDeliveryTimer(id);
			this.markUnconfirmed(notification, '[Whiteboard] A pending native AI session notification was closed before delivery was confirmed. Its notification permission state is unknown.');
			notification.removeAllListeners();
			this.closeNativeNotification(notification);
		}
	}

	private clearDeliveryTimer(id: string): void {
		const timer = this.deliveryTimers.get(id);
		if (timer) { clearTimeout(timer); this.deliveryTimers.delete(id); }
	}

	private markUnconfirmed(notification: AgentSessionNativeNotification, message: string): void {
		const attempt = this.attempts.get(notification);
		if (!attempt || attempt.settled) { return; }
		attempt.settled = true;
		this.setDeliveryStatus(attempt.sequence, 'failed');
		this.logGenericError(message);
	}

	private closeNativeNotification(notification: AgentSessionNativeNotification, attemptSequence?: number): void {
		try {
			notification.close();
		} catch {
			const sequence = attemptSequence ?? this.attempts.get(notification)?.sequence;
			if (sequence !== undefined) { this.setDeliveryStatus(sequence, 'failed'); }
			this.logGenericError('[Whiteboard] A pending native AI session notification could not be closed.');
		}
	}

	private logGenericError(message: string): void {
		try {
			this.logService.error(message);
		} catch {
			// Callers persist delivery failure before logging; the observer must never throw after the store has committed.
		}
	}
}

export const AGENT_SESSION_NATIVE_NOTIFICATION_PREFERENCE_KEY = ENABLED_KEY;
