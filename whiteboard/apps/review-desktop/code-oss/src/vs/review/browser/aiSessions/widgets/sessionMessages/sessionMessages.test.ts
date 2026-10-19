/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';

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
