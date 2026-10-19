/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { AgentSessionDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const dom = new JSDOM('<html><body></body></html>');
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node'] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
const { renderSessionList } = await import('./sessionList.js');

function session(id: string, parentSessionId: string | null = null, overrides: Partial<AgentSessionDTO> = {}): AgentSessionDTO {
	return {
		id, projectId: 'project', bindingId: 'folder', taskId: 'task', parentSessionId,
		name: id, provider: 'codex', model: 'model-v1', profileRef: null, workspaceMode: 'gitWorktree',
		state: 'created', revision: 1, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
		...overrides,
	};
}

function actions(overrides: Partial<Parameters<typeof renderSessionList>[3]> = {}): Parameters<typeof renderSessionList>[3] {
	return {
		onSelect: () => undefined,
		onCreate: () => undefined,
		onOpen: () => undefined,
		onStop: () => undefined,
		onToggle: () => undefined,
		collapsedIds: new Set(),
		busy: false,
		...overrides,
	};
}

function mount(): HTMLElement {
	const parent = document.createElement('div');
	document.body.append(parent);
	return parent;
}

function node(parent: HTMLElement, sessionId: string): HTMLLIElement {
	const found = parent.querySelector<HTMLLIElement>(`li[data-session-id="${sessionId}"]`);
	assert.ok(found, `expected visible session node ${sessionId}`);
	return found;
}

test('renders a source-order child-first collection as a nested parent, child, and grandchild tree', () => {
	const parent = mount();
	try {
		const sessions = [
			session('grandchild', 'child'),
			session('child', 'parent'),
			session('peer'),
			session('parent'),
		];
		renderSessionList(parent, sessions, undefined, actions());

		const peer = parent.querySelector<HTMLLIElement>('.ai-session__session-list > li[data-session-id="peer"]');
		const root = parent.querySelector<HTMLLIElement>('.ai-session__session-list > li[data-session-id="parent"]');
		assert.ok(peer);
		assert.ok(root);
		const child = root.querySelector<HTMLLIElement>(':scope > ul.ai-session__branch > li[data-session-id="child"]');
		assert.ok(child);
		const grandchild = child.querySelector<HTMLLIElement>(':scope > ul.ai-session__branch > li[data-session-id="grandchild"]');
		assert.ok(grandchild);
		assert.equal(parent.querySelectorAll('li[data-session-id]').length, 4);
	} finally {
		parent.remove();
	}
});

test('collapsing a parent hides only its descendants and expansion restores the registered branch', () => {
	const parent = mount();
	const sessions = [session('grandchild', 'child'), session('peer'), session('child', 'parent'), session('parent')];
	try {
		renderSessionList(parent, sessions, undefined, actions({ collapsedIds: new Set(['parent']) }));
		assert.ok(parent.querySelector('.ai-session__session-list > li[data-session-id="parent"]'));
		assert.ok(parent.querySelector('.ai-session__session-list > li[data-session-id="peer"]'));
		assert.equal(parent.querySelector('li[data-session-id="child"]'), null);
		assert.equal(parent.querySelector('li[data-session-id="grandchild"]'), null);

		renderSessionList(parent, sessions, undefined, actions());
		assert.ok(node(parent, 'child'));
		assert.ok(node(parent, 'grandchild'));
	} finally {
		parent.remove();
	}
});

test('selection, logs, instructions, and stop actions route exact session IDs and disable stop for stopped sessions', () => {
	const parent = mount();
	const selected: string[] = [];
	const opened: Array<{ readonly sessionId: string; readonly view: 'terminal' | 'logs' }> = [];
	const stopped: string[] = [];
	try {
		const sessions = [
			session('parent', null, { state: 'running' }),
			session('child', 'parent', { state: 'stopped' }),
		];
		renderSessionList(parent, sessions, undefined, actions({
			onSelect: sessionId => selected.push(sessionId),
			onOpen: (sessionId, view) => opened.push({ sessionId, view }),
			onStop: sessionId => stopped.push(sessionId),
		}));

		node(parent, 'child').querySelector<HTMLButtonElement>('.ai-session__session-row')!.click();
		node(parent, 'parent').querySelector<HTMLButtonElement>('[aria-label="parent 로그"]')!.click();
		node(parent, 'child').querySelector<HTMLButtonElement>('[aria-label="child 지시"]')!.click();
		node(parent, 'parent').querySelector<HTMLButtonElement>('[aria-label="parent 중단"]')!.click();

		assert.deepEqual(selected, ['child']);
		assert.deepEqual(opened, [
			{ sessionId: 'parent', view: 'logs' },
			{ sessionId: 'child', view: 'terminal' },
		]);
		assert.deepEqual(stopped, ['parent']);
		assert.equal(node(parent, 'parent').querySelector<HTMLButtonElement>('[aria-label="parent 중단"]')?.disabled, false);
		assert.equal(node(parent, 'child').querySelector<HTMLButtonElement>('[aria-label="child 중단"]')?.disabled, true);
	} finally {
		parent.remove();
	}
});

test('rerender reflects the latest model and session state', () => {
	const parent = mount();
	try {
		renderSessionList(parent, [session('reload', null, { state: 'running' })], 'reload', actions());
		assert.match(node(parent, 'reload').textContent ?? '', /Codex · model-v1/u);
		assert.match(node(parent, 'reload').textContent ?? '', /실행 중/u);

		renderSessionList(parent, [session('reload', null, { provider: 'claude', model: 'model-v2', state: 'stopped' })], 'reload', actions());
		const row = node(parent, 'reload').querySelector<HTMLButtonElement>('.ai-session__session-row');
		assert.ok(row);
		assert.equal(row.getAttribute('aria-current'), 'true');
		assert.equal(node(parent, 'reload').querySelector('.ai-session__session-meta')?.textContent, 'Claude · model-v2');
		assert.equal(node(parent, 'reload').querySelector('.ai-session__session-state')?.textContent, '종료');
	} finally {
		parent.remove();
	}
});
