/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';

export interface NativeNotificationOpenCoordinatorOptions<TWindow extends object> {
	getNotification(projectId: string, notificationId: string): { readonly id: string; readonly projectId: string } | null;
	getProjectDescriptor(projectId: string): string | undefined;
	openProject(projectId: string): Promise<void>;
	findProjectWindow(projectId: string, descriptor: string): TWindow | undefined;
	focusWindow(window: TWindow): void;
	dispatchOpen(window: TWindow, notificationId: string, requestId: string): void;
	timeoutMs?: number;
}

interface PendingOpen<TWindow extends object> {
	readonly projectId: string;
	readonly notificationId: string;
	readonly descriptor: string;
	readonly window: TWindow;
	readonly resolve: (opened: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Coordinates one exact persisted notification route and its authenticated renderer acknowledgement. */
export class AgentSessionNativeNotificationOpenCoordinator<TWindow extends object> {
	private readonly pending = new Map<string, PendingOpen<TWindow>>();
	private generation = 0;
	private shuttingDown = false;

	constructor(private readonly options: NativeNotificationOpenCoordinatorOptions<TWindow>) { }

	async open(projectId: string, notificationId: string): Promise<void> {
		const generation = this.generation;
		this.assertActive(generation);
		const notification = this.options.getNotification(projectId, notificationId);
		const descriptor = this.options.getProjectDescriptor(projectId);
		if (!notification || notification.id !== notificationId || notification.projectId !== projectId || !descriptor) {
			throw new Error('The exact saved project notification is unavailable.');
		}

		await this.options.openProject(projectId);
		this.assertActive(generation);
		this.assertSameTarget(projectId, notificationId, descriptor);
		const window = this.options.findProjectWindow(projectId, descriptor);
		if (!window) { throw new Error('The exact saved project window did not open.'); }
		this.options.focusWindow(window);

		const requestId = randomUUID();
		const opened = await new Promise<boolean>(resolve => {
			const pending: PendingOpen<TWindow> = {
				projectId, notificationId, descriptor, window, resolve,
				timer: setTimeout(() => this.settle(requestId, false), this.options.timeoutMs ?? 20_000),
			};
			this.pending.set(requestId, pending);
			try { this.options.dispatchOpen(window, notificationId, requestId); }
			catch { this.settle(requestId, false); }
		});
		if (!opened) { throw new Error('The exact notification target did not acknowledge before its request expired or closed.'); }
	}

	acknowledge(senderWindow: TWindow, projectId: string, notificationId: string, requestId: string): boolean {
		const pending = this.pending.get(requestId);
		if (!pending || this.shuttingDown || pending.projectId !== projectId || pending.notificationId !== notificationId
			|| pending.window !== senderWindow || this.options.getProjectDescriptor(projectId) !== pending.descriptor) { return false; }
		const notification = this.options.getNotification(projectId, notificationId);
		if (!notification || notification.id !== pending.notificationId || notification.projectId !== pending.projectId) { return false; }
		return this.settle(requestId, true);
	}

	windowClosed(window: TWindow): void {
		for (const [requestId, pending] of this.pending) {
			if (pending.window === window) { this.settle(requestId, false); }
		}
	}

	shutdown(): void {
		if (this.shuttingDown) { return; }
		this.shuttingDown = true;
		this.generation++;
		for (const requestId of [...this.pending.keys()]) { this.settle(requestId, false); }
	}

	private assertActive(generation: number): void {
		if (this.shuttingDown || generation !== this.generation) { throw new Error('The native notification route is shutting down.'); }
	}

	private assertSameTarget(projectId: string, notificationId: string, descriptor: string): void {
		this.assertActive(this.generation);
		const currentDescriptor = this.options.getProjectDescriptor(projectId);
		const notification = this.options.getNotification(projectId, notificationId);
		if (currentDescriptor !== descriptor || !notification || notification.projectId !== projectId || notification.id !== notificationId) {
			throw new Error('The saved project or exact notification changed while opening.');
		}
	}

	private settle(requestId: string, opened: boolean): boolean {
		const pending = this.pending.get(requestId);
		if (!pending) { return false; }
		this.pending.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve(opened);
		return true;
	}
}
