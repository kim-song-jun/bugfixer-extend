/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ReviewVerbResponseSchema, type ReviewVerbRequest, type ReviewVerbResponse } from './reviewProtocol.js';

export const REVIEW_CONTROL_DISPATCH_CHANNEL = 'vscode:reviewControlDispatch';
export const REVIEW_CONTROL_ACK_CHANNEL = 'vscode:reviewControlAck';
export const REVIEW_CONTROL_CONNECTION_CHANNEL = 'vscode:reviewControlConnection';
export const REVIEW_CONTROL_DEADLINE_MS = 20_000;

export function reviewControlDestination(owners: readonly string[]): { readonly kind: 'project'; readonly projectId: string } | { readonly kind: 'choose'; readonly projectIds: readonly string[] } {
	return owners.length === 1 ? { kind: 'project', projectId: owners[0] } : { kind: 'choose', projectIds: owners };
}

/**
 * Wait for the editor operation to settle before acknowledging or removing a timed-out tab.
 * IEditorService.openEditor has no cancellation signal. The caller must prove that a tab
 * was opened only by this request before cleanup. An adopted tab remains open.
 */
export async function runReviewControlOpen(
	requestId: string,
	key: string,
	latest: Map<string, string>,
	isCancelled: () => boolean,
	open: () => Promise<unknown>,
	cleanup: () => Promise<unknown>,
	canCleanup: () => boolean,
): Promise<boolean> {
	latest.set(key, requestId);
	try {
		await open();
		if (!isCancelled()) return true;
		if (latest.get(key) === requestId && canCleanup()) await cleanup();
		return false;
	} finally {
		if (latest.get(key) === requestId) latest.delete(key);
	}
}

export type ReviewControlDispatch = {
	readonly kind: 'dispatch';
	readonly id: string;
	readonly generation: number;
	readonly request: ReviewVerbRequest;
};

export type ReviewControlCancel = {
	readonly kind: 'cancel';
	readonly id: string;
	readonly generation: number;
};

export type ReviewControlAck = {
	readonly id: string;
	readonly generation: number;
	readonly response: ReviewVerbResponse;
};

/** A receipt belongs to one request generation and one concrete WebContents. */
export class ReviewControlReceipt<T extends object> {
	private readonly pending = new Map<string, {
		readonly target: T;
		readonly generation: number;
		readonly resolve: (response: ReviewVerbResponse) => void;
		readonly reject: (error: Error) => void;
		readonly timer: ReturnType<typeof setTimeout>;
	}>();

	wait(id: string, target: T, generation: number, deadlineMs = REVIEW_CONTROL_DEADLINE_MS): Promise<ReviewVerbResponse> {
		if (this.pending.has(id)) throw new Error('Duplicate Review control request.');
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.cancel(id, 'Review window did not acknowledge the request.'), deadlineMs);
			this.pending.set(id, { target, generation, resolve, reject, timer });
		});
	}

	ack(sender: T, value: unknown): boolean {
		if (!value || typeof value !== 'object') return false;
		const ack = value as Partial<ReviewControlAck>;
		if (typeof ack.id !== 'string' || !Number.isSafeInteger(ack.generation)) return false;
		const response = ReviewVerbResponseSchema.safeParse(ack.response);
		if (!response.success) return false;
		const entry = this.pending.get(ack.id);
		if (!entry || entry.target !== sender || entry.generation !== ack.generation) return false;
		this.pending.delete(ack.id);
		clearTimeout(entry.timer);
		entry.resolve(response.data);
		return true;
	}

	cancel(id: string, reason: string): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		clearTimeout(entry.timer);
		entry.reject(new Error(reason));
		return true;
	}

	cancelTarget(target: T, reason: string): void {
		for (const [id, entry] of this.pending) if (entry.target === target) this.cancel(id, reason);
	}

	dispose(): void {
		for (const id of this.pending.keys()) this.cancel(id, 'Review control dispatcher closed.');
	}
}
