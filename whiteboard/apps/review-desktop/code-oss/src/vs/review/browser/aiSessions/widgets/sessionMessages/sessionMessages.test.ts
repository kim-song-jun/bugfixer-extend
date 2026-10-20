/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import type { WorkspaceAgentSessionMailboxPage } from '../../../../../workspace/common/workspaceAgentCommunicationProtocol.js';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const dom = new JSDOM('<html><body></body></html>', { pretendToBeVisual: true });
const css = dom.window.CSS ?? {};
css.escape ??= (value: string) => value.replace(/[^a-zA-Z0-9_-]/gu, '\\$&');
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'navigator'] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.defineProperty(globalThis, 'CSS', { configurable: true, value: css });
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() { } });
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
registerHooks({ load(url, context, next) {
	return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { createSessionMessages } = await import('./sessionMessages.js');

const message = {
	id: 'message-exact', senderSessionId: 'sender', recipientSessionId: 'recipient', sequence: 1,
	body: 'saved message', createdAt: '2026-10-20T00:00:00.000Z', readAt: null,
};

test('message notification navigation resolves only after the exact loaded message receives focus', async () => {
	const parent = document.createElement('div');
	document.body.append(parent);
	const controller = createSessionMessages(parent, 'project', 'recipient', {
		loadPage: async () => ({ messages: [message], nextCursor: 1, hasMore: false }),
		loadMessage: async id => id === message.id ? message : null,
		sessions: [],
	});
	controller.setVisible(true);
	try {
		assert.equal(await controller.revealMessage(message.id), true);
		assert.equal((document.activeElement as HTMLElement).dataset.messageId, message.id);
	} finally {
		controller.dispose();
		parent.remove();
	}
});

test('missing exact mailbox targets fail navigation and can never acknowledge as opened', async () => {
	const parent = document.createElement('div');
	document.body.append(parent);
	const controller = createSessionMessages(parent, 'project', 'recipient', {
		loadPage: async () => ({ messages: [], nextCursor: 0, hasMore: false }),
		loadMessage: async () => null,
		sessions: [],
	});
	controller.setVisible(true);
	try {
		assert.equal(await controller.revealMessage('missing-exact-message'), false);
	} finally {
		controller.dispose();
		parent.remove();
	}
});

test('mailbox polling keeps the focused first-page action focused while refreshing messages', async () => {
	const parent = document.createElement('div');
	document.body.append(parent);
	let pageLoads = 0;
	let finishRefresh!: (page: WorkspaceAgentSessionMailboxPage) => void;
	const refreshPage = new Promise<WorkspaceAgentSessionMailboxPage>(resolve => { finishRefresh = resolve; });
	const controller = createSessionMessages(parent, 'project', 'recipient', {
		loadPage: async () => {
			pageLoads++;
			return pageLoads === 1
				? { messages: [message], nextCursor: 1, hasMore: true }
				: refreshPage;
		},
		loadMessage: async () => null,
		sessions: [],
	});
	controller.setVisible(true);
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		const [firstPage, nextPage] = parent.querySelectorAll<HTMLButtonElement>('.ai-session-messages__toolbar button');
		assert.ok(firstPage);
		assert.ok(nextPage);
		firstPage.focus();
		controller.refresh();
		assert.equal(pageLoads, 2, 'the explicit refresh must start one request after the initial mailbox load');
		assert.equal(firstPage.disabled, false, 'the focused first-page action must remain natively focusable during refresh');
		assert.equal(firstPage.getAttribute('aria-disabled'), 'true', 'the first-page action must announce that activation is temporarily unavailable');
		assert.equal(nextPage.disabled, false, 'a page action that remains available after refresh must remain natively focusable');
		assert.equal(nextPage.getAttribute('aria-disabled'), 'true', 'the next-page action must announce the in-flight request');
		assert.equal(parent.getAttribute('aria-busy'), 'true', 'the mailbox must expose its busy state');
		assert.equal(document.activeElement, firstPage, 'starting a background refresh must not disable and blur the focused history action');
		firstPage.click();
		nextPage.click();
		assert.equal(pageLoads, 2, 'activating either paging action during refresh must not start a duplicate request');
		assert.equal(parent.querySelectorAll('.ai-session-messages__message').length, 1, 'paging input during refresh must not clear the loaded mailbox window');
		finishRefresh({ messages: [message], nextCursor: 1, hasMore: true });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(parent.getAttribute('aria-busy'), 'false', 'the mailbox must clear busy state when refresh completes');
		assert.equal(firstPage.getAttribute('aria-disabled'), 'false');
		assert.equal(nextPage.getAttribute('aria-disabled'), 'false');
		assert.equal(document.activeElement, firstPage, 'completing a background refresh must preserve focus on the history action');
	} finally {
		controller.dispose();
		parent.remove();
	}
});
