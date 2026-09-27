/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from "crypto";
import type { WebContents } from "electron";
import { Event } from "../../base/common/event.js";
import { IServerChannel } from "../../base/parts/ipc/common/ipc.js";
import { publicReviewDesktopStatus, requestReviewDesktopServer, validateReviewDesktopStreamPath, validatedReviewDesktopOrigin, type ReviewDesktopRequest, type ReviewDesktopStreamEvent } from "../common/reviewDesktopGateway.js";
import { parseJsonText } from "../common/reviewProtocol.js";
import type { ReviewDesktopHost } from "./reviewDesktopHost.js";

export { REVIEW_DESKTOP_CHANNEL } from "../common/reviewDesktopBootstrap.js";

const MAX_QUEUED_STREAM_EVENTS = 32;
const STREAM_POLL_WAIT_MS = 25_000;

interface StreamHandle {
	readonly controller: AbortController;
	readonly queue: ReviewStreamQueue;
}

/** Main-process-owned Review transport. Only validated requests and bounded stream frames cross IPC. */
export class ReviewDesktopChannel implements IServerChannel<WebContents> {
	private readonly streams = new WeakMap<WebContents, Map<string, StreamHandle>>();
	private readonly senderCleanupRegistered = new WeakSet<WebContents>();

	constructor(
		private readonly host: ReviewDesktopHost,
		private readonly isTrustedSender: (sender: WebContents) => boolean,
	) {}

	listen<T>(): import("../../base/common/event.js").Event<T> {
		return Event.None as import("../../base/common/event.js").Event<T>;
	}

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		if (!this.isTrustedSender(sender)) throw new Error("Untrusted sender for Review Desktop IPC.");
		if (command === "getStatus") {
			return publicReviewDesktopStatus(await this.host.whenConnected()) as T;
		}
		if (command === "request") {
			if (!isReviewDesktopRequest(arg)) throw new Error("Invalid Review Desktop request.");
			if (new URL(arg.path, 'http://127.0.0.1').pathname === '/control/result') throw new Error('Review control results are main-process-only.');
			return requestReviewDesktopServer(await this.host.whenConnected(), arg) as Promise<T>;
		}
		if (command === "streamStart") {
			if (!isStreamRequest(arg)) throw new Error("Invalid Review Desktop stream request.");
			return this.startStream(sender, arg.path) as T;
		}
		if (command === "streamNext") {
			if (!isStreamId(arg)) throw new Error("Invalid Review Desktop stream id.");
			return await (this.streams.get(sender)?.get(arg.id)?.queue.next() ?? Promise.resolve({ done: true })) as T;
		}
		if (command === "streamCancel") {
			if (!isStreamId(arg)) throw new Error("Invalid Review Desktop stream id.");
			this.cancelStream(sender, arg.id);
			return undefined as T;
		}
		if (command === "stageRustAnalyzer") {
			this.host.stageRustAnalyzer();
			return undefined as T;
		}
		throw new Error(`Unknown Review Desktop channel call: ${command}`);
	}

	private startStream(sender: WebContents, path: string): { id: string } {
		validateReviewDesktopStreamPath(path);
		let streams = this.streams.get(sender);
		if (!streams) this.streams.set(sender, (streams = new Map()));
		if (streams.size >= 8) throw new Error("Too many Review Desktop streams are active.");
		const id = randomUUID();
		const controller = new AbortController();
		const queue = new ReviewStreamQueue();
		streams.set(id, { controller, queue });
		if (!this.senderCleanupRegistered.has(sender)) {
			this.senderCleanupRegistered.add(sender);
			sender.once("destroyed", () => this.cancelAllStreams(sender));
		}
		void this.pumpStream(path, controller.signal, value => { if (!queue.push(value)) controller.abort(); }).then(
			() => queue.close(),
			error => { if (!controller.signal.aborted) queue.close({ error: error instanceof Error ? error.message : String(error) }); else queue.close(); },
		);
		return { id };
	}

	private cancelStream(sender: WebContents, id: string): void {
		const streams = this.streams.get(sender);
		const stream = streams?.get(id);
		if (!stream) return;
		streams!.delete(id);
		stream.controller.abort();
		stream.queue.close();
		if (streams!.size === 0) this.streams.delete(sender);
	}

	private cancelAllStreams(sender: WebContents): void {
		const streams = this.streams.get(sender);
		if (!streams) return;
		for (const [id] of streams) this.cancelStream(sender, id);
	}

	private async pumpStream(path: string, signal: AbortSignal, emit: (value: ReviewDesktopStreamEvent) => void): Promise<void> {
		const urlPath = validateReviewDesktopStreamPath(path);
		const connection = await this.host.whenConnected();
		const response = await fetch(new URL(urlPath, validatedReviewDesktopOrigin(connection)), {
			headers: { "x-review-token": connection.token, accept: "application/x-ndjson" },
			signal,
			redirect: "error",
		});
		if (!response.ok || !response.body) throw new Error(`Review Desktop stream failed (${response.status}).`);
		if (!response.headers.get("content-type")?.toLowerCase().includes("application/x-ndjson")) throw new Error("Review watch stream returned an invalid content type.");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		try {
			while (!signal.aborted) {
				const { value, done } = await reader.read();
				pending += decoder.decode(value, { stream: !done });
				if (new TextEncoder().encode(pending).byteLength > 1_048_576) throw new Error("Review stream event exceeded 1 MiB.");
				let newline: number;
				while ((newline = pending.indexOf("\n")) !== -1) {
					const line = pending.slice(0, newline).trim();
					pending = pending.slice(newline + 1);
					if (line) emit({ value: parseJsonText(line) });
				}
				if (done) break;
			}
		} finally {
			await reader.cancel();
		}
		if (pending.trim()) emit({ value: parseJsonText(pending.trim()) });
	}
}

class ReviewStreamQueue {
	private readonly values: ReviewDesktopStreamEvent[] = [];
	private waiter: ((value: ReviewDesktopStreamEvent | { readonly pending: true } | { readonly done: true }) => void) | undefined;
	private ended = false;

	push(value: ReviewDesktopStreamEvent): boolean {
		if (this.ended) return false;
		if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(value); return true; }
		if (this.values.length >= MAX_QUEUED_STREAM_EVENTS) { this.close({ error: "Review stream fell behind the renderer." }); return false; }
		this.values.push(value);
		return true;
	}

	close(error?: { readonly error: string }): void {
		if (this.ended) return;
		this.ended = true;
		if (error) this.values.push(error);
		if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(this.values.shift() ?? { done: true }); }
	}

	next(): Promise<ReviewDesktopStreamEvent | { readonly pending: true } | { readonly done: true }> {
		const value = this.values.shift();
		if (value) return Promise.resolve(value);
		if (this.ended) return Promise.resolve({ done: true });
		return new Promise(resolve => {
			const timer = setTimeout(() => { this.waiter = undefined; resolve({ pending: true }); }, STREAM_POLL_WAIT_MS);
			this.waiter = value => { clearTimeout(timer); resolve(value); };
		});
	}
}

function isReviewDesktopRequest(value: unknown): value is ReviewDesktopRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const request = value as Record<string, unknown>;
	return typeof request.path === "string" &&
		(request.method === undefined || request.method === "GET" || request.method === "POST" || request.method === "PUT" || request.method === "DELETE");
}

function isStreamRequest(value: unknown): value is { path: string } {
	return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).path === "string";
}

function isStreamId(value: unknown): value is { id: string } {
	return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).id === "string";
}
