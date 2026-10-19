/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const dom = new JSDOM('<html><body></body></html>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'navigator'] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
registerHooks({ load(url, context, next) {
	return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { createSessionLogs } = await import('./sessionLogs.js');

const context = { projectId: 'project-exact', sessionId: 'session-exact', turnId: 'turn-exact' } as const;
const emptyPage = { entries: [], nextSequence: 0, highestSequence: 0, firstRetainedSequence: null, gaps: [], hasMore: false } as const;

test('turn notification navigation confirms the exact transcript context after its page renders', async () => {
	const parent = document.createElement('div');
	document.body.append(parent);
	const controller = createSessionLogs(parent, context, { loadPage: async () => emptyPage });
	controller.setVisible(true);
	try {
		assert.equal(await controller.confirmContext(context), true);
		assert.match(parent.textContent ?? '', /저장된 기록 없음/u);
		assert.equal(await controller.confirmContext({ ...context, turnId: 'different-turn' }), false);
	} finally {
		controller.dispose();
		parent.remove();
	}
});

test('failed exact transcript reads do not confirm a turn notification as opened', async () => {
	const parent = document.createElement('div');
	document.body.append(parent);
	const controller = createSessionLogs(parent, context, { loadPage: async () => { throw new Error('fixture transcript unavailable'); } });
	controller.setVisible(true);
	try {
		assert.equal(await controller.confirmContext(context), false);
	} finally {
		controller.dispose();
		parent.remove();
	}
});
