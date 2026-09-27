/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { Event } from "../../base/common/event.js";
import { ReviewCanvasEditorInput } from "../browser/parts/canvas/reviewCanvasEditorInput.js";
import { ReviewCanvasEditorTabsService } from "./reviewCanvasEditorTabsService.js";

async function closeWelcome(updateNeeded: boolean): Promise<number> {
	let finished = 0;
	const instantiation = {
		createInstance(_ctor: unknown, target: never) {
			return new ReviewCanvasEditorInput(target, {} as never);
		},
	};
	const editors = { onDidCloseEditor: Event.None, async openEditor() {} };
	const groups = { groups: [], mainPart: { activeGroup: undefined } };
	const connection = {
		async getCliInstallStatus() {
			return { updateNeeded };
		},
		async finishCliInstallUpdate() {
			finished += 1;
		},
	};
	const tabs = new ReviewCanvasEditorTabsService(
		instantiation as never,
		editors as never,
		groups as never,
		connection as never,
		{} as never,
		{ warn() {} } as never,
	);
	try {
		const welcome = await tabs.openWelcome(true);
		welcome.dispose();
		await new Promise((resolve) => setImmediate(resolve));
		return finished;
	} finally {
		tabs.dispose();
	}
}

test("closing Welcome finishes the CLI install update only when one is pending", async () => {
	assert.equal(await closeWelcome(true), 1);
	assert.equal(await closeWelcome(false), 0);
});

test("opening API source resolves its navigator workspace through the main-process request bridge", async () => {
	const requests: unknown[] = [];
	let opened: unknown;
	const tabs = new ReviewCanvasEditorTabsService(
		{ createInstance() { throw new Error("not used"); } } as never,
		{ onDidCloseEditor: Event.None } as never,
		{} as never,
		{ async request(request: unknown) { requests.push(request); return { workspacePath: "/repo", filePath: "/repo/src/a.ts" }; } } as never,
		{ async openWindow(input: unknown) { opened = input; } } as never,
		{ warn() {} } as never,
	);
	try {
		await tabs.openApiSource({ reviewId: "review-1", kind: "current" }, "Review");
		assert.deepEqual(requests, [{
			path: "/reviews-api/review-1/navigator",
			method: "POST",
		}]);
		assert.equal((opened as Array<{ workspaceUri: { fsPath: string }; label: string }>)[0].workspaceUri.fsPath, "/repo");
		assert.equal((opened as Array<{ workspaceUri: unknown; label: string }>)[0].label, "Review");
	} finally {
		tabs.dispose();
	}
});

test("task reviews use a distinct immutable tab identity from live reviews", async () => {
	const inputs: ReviewCanvasEditorInput[] = [];
	const opened: ReviewCanvasEditorInput[] = [];
	const tabs = new ReviewCanvasEditorTabsService(
		{ createInstance(_ctor: unknown, target: ConstructorParameters<typeof ReviewCanvasEditorInput>[0]) {
			const input = new ReviewCanvasEditorInput(target, {} as never);
			inputs.push(input);
			return input;
		} } as never,
		{ onDidCloseEditor: Event.None, async openEditor(input: ReviewCanvasEditorInput) { opened.push(input); } } as never,
		{ groups: [], mainPart: { activeGroup: undefined } } as never,
		{} as never,
		{} as never,
		{ warn() {} } as never,
	);
	try {
		const live = tabs.inputFor({ kind: "api", reviewId: "review-1", title: "Live" });
		const pinned = await tabs.openTaskApiReview("task-1", "review-1", 7, "Task snapshot");
		assert.notEqual(pinned, live);
		assert.equal(pinned, tabs.inputFor({ kind: "api-task-review", taskId: "task-1", reviewId: "review-1", version: 7, title: "Task snapshot" }));
		assert.notEqual(pinned, tabs.inputFor({ kind: "api-task-review", taskId: "task-1", reviewId: "review-1", version: 8, title: "Task snapshot" }));
		assert.equal(pinned.target.kind, "api-task-review");
		assert.deepEqual(opened, [pinned]);
		await assert.rejects(tabs.openTaskApiReview("task-1", "review-1", -1, "Invalid"), /valid immutable version/);
	} finally {
		tabs.dispose();
		inputs.forEach((input) => input.dispose());
	}
});
