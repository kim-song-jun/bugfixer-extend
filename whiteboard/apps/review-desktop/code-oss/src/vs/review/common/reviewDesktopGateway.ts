/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewDesktopConnection } from "./reviewDesktopBootstrap.js";

export const REVIEW_DESKTOP_MAX_REQUEST_BYTES = 1_048_576;
export const REVIEW_DESKTOP_MAX_BUG_REPORT_BYTES = 6_291_456;
export const REVIEW_DESKTOP_MAX_RESPONSE_BYTES = 8_388_608;

export interface ReviewDesktopRequest {
	readonly path: string;
	readonly method?: "GET" | "POST" | "PUT" | "DELETE";
	readonly body?: unknown;
}

export type ReviewDesktopStreamEvent = { readonly value: unknown } | { readonly error: string };

export interface ReviewDesktopPublicStatus {
	readonly version: number;
	readonly instanceId: string;
	readonly appSessionId: string;
}

export function publicReviewDesktopStatus(connection: ReviewDesktopConnection): ReviewDesktopPublicStatus {
	return { version: connection.version, instanceId: connection.instanceId, appSessionId: connection.appSessionId };
}

export function validatedReviewDesktopOrigin(connection: Pick<ReviewDesktopConnection, "url">): string {
	let url: URL;
	try { url = new URL(connection.url); }
	catch { throw new Error("Invalid Review Desktop server origin."); }
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.origin !== connection.url) {
		throw new Error("Review Desktop server must use its validated loopback origin.");
	}
	return url.origin;
}

const ROUTES: readonly { readonly method: string; readonly pattern: RegExp }[] = [
	{ method: "GET", pattern: /^\/health$/ },
	{ method: "GET", pattern: /^\/reviews-api(?:\/[A-Za-z0-9_-]+)?$/ },
	{ method: "GET", pattern: /^\/reviews-api\/[A-Za-z0-9_-]+\/(?:versions|agent-traces)(?:\/[A-Za-z0-9_-]+)?$/ },
	{ method: "GET", pattern: /^\/reviews-api\/[A-Za-z0-9_-]+\/(?:history|stack|commits)$/ },
	{ method: "GET", pattern: /^\/reviews-api\/[A-Za-z0-9_-]+\/(?:progress|maps\/[A-Za-z0-9_-]+|resources\/[A-Za-z0-9_-]+)$/ },
	{ method: "GET", pattern: /^\/reviews-api\/(?:watch|[A-Za-z0-9_-]+\/watch)$/ },
	{ method: "POST", pattern: /^\/reviews-api(?:\/[A-Za-z0-9_-]+)?\/commands$/ },
	{ method: "POST", pattern: /^\/reviews-api\/[A-Za-z0-9_-]+\/navigator$/ },
	{ method: "POST", pattern: /^\/reviews-api\/[A-Za-z0-9_-]+\/(?:copy-context|telemetry\/(?:event|tab|bug-report))$/ },
	{ method: "GET", pattern: /^\/reviews-api\/[A-Za-z0-9_-]+\/tree$/ },
	{ method: "GET", pattern: /^\/reviews-api\/[^/]+\/(?:file|diff|navigator|structural-diff|language-context)$/ },
	{ method: "GET", pattern: /^\/(?:diffr-config|preferences\/scratchpad|tutorial\/status|install\/status)$/ },
	{ method: "PUT", pattern: /^\/(?:diffr-config|diffr-config\/summarizer|preferences\/scratchpad)$/ },
	{ method: "POST", pattern: /^\/(?:diffr-config\/summarizer\/test|tutorial\/prepare|tutorial\/open|install\/apply|install\/remove|install\/(?:finish-update|decline|skip|reset|legacy-skills\/remove))$/ },
	{ method: "POST", pattern: /^\/control\/result$/ },
	{ method: "POST", pattern: /^\/telemetry\/event$/ },
	{ method: "POST", pattern: /^\/reviews-api\/sharing\/import$/ },
	{ method: "GET", pattern: /^\/reviews-api\/sharing\/import\/[A-Za-z0-9_-]+$/ },
	{ method: "GET", pattern: /^\/reviews-api\/sharing\/account$/ },
	{ method: "DELETE", pattern: /^\/tutorial$/ },
];

export function validateReviewDesktopStreamPath(path: unknown): string {
	if (typeof path !== "string" || path.length > 4096 || !path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid Review Desktop stream path.");
	const url = new URL(path, "http://127.0.0.1");
	if (url.origin !== "http://127.0.0.1" || url.hash || !(url.pathname === "/control" || /^\/reviews-api\/(?:watch|[A-Za-z0-9_-]+\/(?:watch|structural-diff))$/.test(url.pathname)) || /%(?:2f|5c)/i.test(url.pathname)) {
		throw new Error("Review Desktop stream route is not allowed.");
	}
	return `${url.pathname}${url.search}`;
}

export function validateReviewDesktopRequest(request: ReviewDesktopRequest): { urlPath: string; method: string; body?: string } {
	if (!request || typeof request.path !== "string" || request.path.length > 4096 || !request.path.startsWith("/") || request.path.startsWith("//")) {
		throw new Error("Invalid Review Desktop request path.");
	}
	const url = new URL(request.path, "http://127.0.0.1");
	if (url.origin !== "http://127.0.0.1" || url.hash || /%(?:2f|5c)/i.test(url.pathname)) {
		throw new Error("Invalid Review Desktop request path.");
	}
	const method = request.method ?? "GET";
	if (!ROUTES.some(route => route.method === method && route.pattern.test(url.pathname))) {
		throw new Error(`Review Desktop route is not allowed: ${method} ${url.pathname}`);
	}
	let body: string | undefined;
	if (request.body !== undefined) {
		if ((method !== "POST" && method !== "PUT") || request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
			throw new Error("Review Desktop request body is invalid.");
		}
		body = JSON.stringify(request.body);
		const maximumBytes = url.pathname.endsWith("/telemetry/bug-report") ? REVIEW_DESKTOP_MAX_BUG_REPORT_BYTES : REVIEW_DESKTOP_MAX_REQUEST_BYTES;
		if (new TextEncoder().encode(body).byteLength > maximumBytes) {
			throw new Error("Review Desktop request body is too large.");
		}
	}
	return { urlPath: `${url.pathname}${url.search}`, method, ...(body === undefined ? {} : { body }) };
}

/** Main-process-only authenticated JSON transport. It never returns connection credentials. */
export async function requestReviewDesktopServer<T>(connection: ReviewDesktopConnection, request: ReviewDesktopRequest): Promise<T> {
	const validated = validateReviewDesktopRequest(request);
	const origin = validatedReviewDesktopOrigin(connection);
	const response = await fetch(new URL(validated.urlPath, origin), {
		method: validated.method,
		redirect: "error",
		headers: {
			"x-review-token": connection.token,
			...(/(?:^|\/)telemetry\/(?:event|tab)$/.test(new URL(validated.urlPath, origin).pathname) ? { "x-review-app-session-id": connection.appSessionId } : {}),
			...(validated.body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(validated.body === undefined ? {} : { body: validated.body }),
		signal: AbortSignal.timeout(120_000),
	});
	const contentType = response.headers.get("content-type") ?? "";
	const isJson = contentType.toLowerCase().includes("application/json");
	if (!isJson && response.ok) throw new Error("Review Desktop server returned a non-JSON response.");
	if (Number(response.headers.get("content-length")) > REVIEW_DESKTOP_MAX_RESPONSE_BYTES) {
		throw new Error("Review Desktop server response is too large.");
	}
	if (!response.body) throw new Error("Review Desktop server returned an empty response.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		size += chunk.value.byteLength;
		if (size > REVIEW_DESKTOP_MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error("Review Desktop server response is too large.");
		}
		chunks.push(chunk.value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	const text = new TextDecoder().decode(bytes);
	let payload: unknown;
	if (text) {
		try { payload = JSON.parse(text); }
		catch { if (response.ok) throw new Error("Review Desktop server returned invalid JSON."); }
	}
	if (!response.ok) {
		const detail = payload && typeof payload === "object" ? payload as { error?: unknown; output?: unknown } : undefined;
		const message = typeof detail?.output === "string" && detail.output ? detail.output : detail?.error;
		throw new Error(typeof message === "string" ? message : `Review Desktop request failed (${response.status}).`);
	}
	return payload as T;
}
