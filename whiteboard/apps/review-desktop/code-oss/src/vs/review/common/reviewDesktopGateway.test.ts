/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_DESKTOP_MAX_REQUEST_BYTES, publicReviewDesktopStatus, requestReviewDesktopServer, validateReviewDesktopRequest, validateReviewDesktopStreamPath } from "./reviewDesktopGateway.js";

test("Review Desktop gateway permits only bounded first-party API routes", () => {
	assert.deepEqual(validateReviewDesktopRequest({ path: "/reviews-api?mode=structural" }), {
		urlPath: "/reviews-api?mode=structural", method: "GET",
	});
	assert.deepEqual(validateReviewDesktopRequest({ path: "/reviews-api/abc/file?side=head", method: "GET" }), {
		urlPath: "/reviews-api/abc/file?side=head", method: "GET",
	});
	assert.equal(validateReviewDesktopRequest({ path: "/reviews-api/abc/history" }).urlPath, "/reviews-api/abc/history");
	assert.equal(validateReviewDesktopRequest({ path: "/reviews-api/abc/tree?side=head&path=src" }).urlPath, "/reviews-api/abc/tree?side=head&path=src");
	assert.equal(validateReviewDesktopRequest({ path: "/reviews-api/abc/stack?version=2" }).urlPath, "/reviews-api/abc/stack?version=2");
	assert.equal(validateReviewDesktopRequest({ path: "/reviews-api/abc/commits?version=2" }).urlPath, "/reviews-api/abc/commits?version=2");
	assert.equal(validateReviewDesktopRequest({ path: "/reviews-api/abc/progress?version=2&mode=structural&wait=false" }).urlPath, "/reviews-api/abc/progress?version=2&mode=structural&wait=false");
	assert.equal(validateReviewDesktopRequest({ path: "/reviews-api/sharing/account" }).urlPath, "/reviews-api/sharing/account");
	assert.equal(validateReviewDesktopRequest({ path: "/reviews-api/abc/resources/asset_1" }).urlPath, "/reviews-api/abc/resources/asset_1");
	assert.equal(validateReviewDesktopRequest({ path: "/reviews-api/abc/maps/map_1?version=2" }).urlPath, "/reviews-api/abc/maps/map_1?version=2");
	assert.throws(() => validateReviewDesktopRequest({ path: "https://evil.example/reviews-api" }), /path/);
	assert.throws(() => validateReviewDesktopRequest({ path: "//evil.example/reviews-api" }), /path/);
	assert.throws(() => validateReviewDesktopRequest({ path: "/control?token=stolen" }), /not allowed/);
	assert.throws(() => validateReviewDesktopRequest({ path: "/reviews-api/abc/file", method: "POST" }), /not allowed/);
	assert.throws(() => validateReviewDesktopRequest({ path: "/reviews-api/abc/tree", method: "POST" }), /not allowed/);
	assert.throws(() => validateReviewDesktopRequest({ path: "/reviews-api/abc/arbitrary" }), /not allowed/);
	assert.throws(() => validateReviewDesktopRequest({ path: "/reviews-api/abc/progress", method: "POST" }), /not allowed/);
	assert.throws(() => validateReviewDesktopRequest({ path: "/reviews-api/sharing/account", method: "POST" }), /not allowed/);
	assert.throws(() => validateReviewDesktopRequest({ path: "/reviews-api/abc/resources/asset_1/delete" }), /not allowed/);
	assert.throws(() => validateReviewDesktopRequest({ path: "/reviews-api/abc/maps/map_1/delete" }), /not allowed/);
	assert.throws(() => validateReviewDesktopRequest({ path: "/tutorial", method: "DELETE", body: { invalid: true } }), /body is invalid/);
	assert.throws(() => validateReviewDesktopRequest({ path: "/reviews-api/commands", method: "POST", body: { data: "x".repeat(REVIEW_DESKTOP_MAX_REQUEST_BYTES) } }), /too large/);
	assert.equal(validateReviewDesktopStreamPath("/reviews-api/watch?subscriptions=%5B%5D"), "/reviews-api/watch?subscriptions=%5B%5D");
	assert.throws(() => validateReviewDesktopStreamPath("https://evil.example/control"), /path/);
});

test("authenticated Review requests stay on loopback and never follow redirects", async (t) => {
	t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		assert.equal(new URL(String(input)).origin, "http://127.0.0.1:5000");
		assert.equal(init?.redirect, "error");
		assert.equal(new Headers(init?.headers).get("x-review-token"), "secret");
		return Response.json({ ok: true });
	});
	const result = await requestReviewDesktopServer<{ ok: boolean }>({
		version: 3,
		url: "http://127.0.0.1:5000",
		token: "secret",
		instanceId: "instance",
		appSessionId: "session",
	}, { path: "/health" });
	assert.deepEqual(result, { ok: true });
	await assert.rejects(requestReviewDesktopServer({
		version: 3,
		url: "http://127.0.0.1:5000",
		token: "secret",
		instanceId: "instance",
		appSessionId: "session",
	}, { path: "https://evil.example/health" }), /path/);
});

test("renderer status contains no server URL or token", () => {
	const status = publicReviewDesktopStatus({
		version: 3,
		url: "http://127.0.0.1:5000",
		token: "secret",
		instanceId: "instance",
		appSessionId: "session",
	});
	assert.deepEqual(status, { version: 3, instanceId: "instance", appSessionId: "session" });
	assert.equal("token" in status, false);
	assert.equal("url" in status, false);
});
