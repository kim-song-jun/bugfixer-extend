/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import type { AgentSessionTranscriptPageDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';

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

function transcriptEntry(sequence: number, text: string, entryContext: { readonly projectId: string; readonly sessionId: string; readonly turnId: string } = context) {
	return {
		...entryContext,
		sequence,
		kind: 'log' as const,
		text,
		byteLength: new TextEncoder().encode(text).byteLength,
		retained: true,
		severity: 'info' as const,
		source: 'workspace' as const,
		references: [],
		createdAt: '2026-10-20T00:00:00.000Z',
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) { throw new Error('Timed out waiting for session log state'); }
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

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

test('retained text search advances through empty scanned pages and stops at the exact matching turn entry', async () => {
	const parent = document.createElement('div');
	document.body.append(parent);
	const requests: Array<{ readonly query?: string; readonly afterSequence?: number; readonly kind?: string; readonly severity?: string; readonly source?: string }> = [];
	const controller = createSessionLogs(parent, context, {
		loadPage: async options => {
			requests.push(options);
			if (!options.query) { return emptyPage; }
			if (options.query === 'needle' && options.afterSequence === 0) {
				return { entries: [], nextSequence: 100, highestSequence: 220, firstRetainedSequence: 1, gaps: [], hasMore: true };
			}
			if (options.query === 'needle' && options.afterSequence === 100) {
				return { entries: [transcriptEntry(220, 'retained needle')], nextSequence: 220, highestSequence: 220, firstRetainedSequence: 1, gaps: [], hasMore: false };
			}
			if (options.query === 'missing' && options.afterSequence === 0) {
				return { entries: [], nextSequence: 100, highestSequence: 220, firstRetainedSequence: 1, gaps: [], hasMore: true };
			}
			return { entries: [], nextSequence: 220, highestSequence: 220, firstRetainedSequence: 1, gaps: [], hasMore: false };
		},
	});
	controller.setVisible(true);
	try {
		await waitFor(() => parent.querySelector('.ai-session-logs__status')?.textContent?.includes('저장된 기록 없음') === true);
		const [kind, severity, source] = [...parent.querySelectorAll<HTMLSelectElement>('.ai-session-logs__filter select')];
		kind.value = 'log';
		kind.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		severity.value = 'info';
		severity.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		source.value = 'workspace';
		source.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		const search = parent.querySelector<HTMLInputElement>('input[type="search"]')!;
		search.value = 'needle';
		search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		await waitFor(() => parent.querySelector('.ai-session-logs__entry-text')?.textContent === 'retained needle');
		const needleRequests = requests.filter(request => request.query === 'needle');
		assert.deepEqual(needleRequests.map(request => request.afterSequence), [0, 100]);
		assert.ok(needleRequests.every(request => request.kind === 'log' && request.severity === 'info' && request.source === 'workspace'));
		assert.equal(parent.querySelectorAll('.ai-session-logs__entry').length, 1);
		assert.match(parent.querySelector('.ai-session-logs__status')?.textContent ?? '', /보존된 기록을 검색합니다/u);

		search.value = 'missing';
		search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		await waitFor(() => requests.some(request => request.query === 'missing' && request.afterSequence === 100));
		await waitFor(() => parent.querySelector('.ai-session-logs__entry') === null
			&& [...parent.querySelectorAll('button')].find(button => button.textContent === '다음 기록 불러오기')?.disabled === true);
		assert.deepEqual(requests.filter(request => request.query === 'missing').map(request => request.afterSequence), [0, 100]);
		assert.equal(parent.querySelectorAll('.ai-session-logs__entry').length, 0);
		assert.equal((parent.querySelector('.ai-session-logs__status')?.textContent ?? '').includes('다음 기록 불러오기로 계속 찾을 수 있습니다.'), false);
	} finally {
		controller.dispose();
		parent.remove();
	}
});

test('a late retained-search page cannot cross the selected turn generation', async () => {
	const parent = document.createElement('div');
	document.body.append(parent);
	const oldQueryRequests: string[] = [];
	let resolveOldPage!: (page: AgentSessionTranscriptPageDTO) => void;
	const controller = createSessionLogs(parent, context, {
		loadPage: async options => {
			if (!options.query) { return emptyPage; }
			oldQueryRequests.push(options.query);
			return new Promise<AgentSessionTranscriptPageDTO>(resolve => { resolveOldPage = resolve; });
		},
	});
	controller.setVisible(true);
	try {
		const search = parent.querySelector<HTMLInputElement>('input[type="search"]')!;
		search.value = 'old-turn-match';
		search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		await waitFor(() => oldQueryRequests.includes('old-turn-match'));

		const nextContext = { ...context, turnId: 'turn-next' };
		controller.setContext(nextContext, async () => ({
			entries: [transcriptEntry(1, 'new turn old-turn-match', nextContext)],
			nextSequence: 1,
			highestSequence: 1,
			firstRetainedSequence: 1,
			gaps: [],
			hasMore: false,
		}));
		await waitFor(() => parent.querySelector('.ai-session-logs__entry-text')?.textContent === 'new turn old-turn-match');
		resolveOldPage({
			entries: [transcriptEntry(99, 'old turn stale result')],
			nextSequence: 99,
			highestSequence: 99,
			firstRetainedSequence: 1,
			gaps: [],
			hasMore: false,
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepEqual([...parent.querySelectorAll('.ai-session-logs__entry-text')].map(node => node.textContent), ['new turn old-turn-match']);
	} finally {
		controller.dispose();
		parent.remove();
	}
});

test('a whitespace query is literal and live polling resumes from the exhausted retained cursor', async () => {
	const parent = document.createElement('div');
	document.body.append(parent);
	const requests: Array<{ readonly query?: string; readonly afterSequence?: number }> = [];
	const controller = createSessionLogs(parent, context, {
		pollIntervalMs: 1000,
		loadPage: async options => {
			requests.push(options);
			if (options.query === undefined) { return emptyPage; }
			if (options.query === '  ' && options.afterSequence === 0) {
				return { entries: [], nextSequence: 5, highestSequence: 5, firstRetainedSequence: 1, gaps: [], hasMore: false };
			}
			if (options.query === '  ' && options.afterSequence === 5) {
				return {
					entries: [transcriptEntry(6, 'live  retained match')],
					nextSequence: 6,
					highestSequence: 6,
					firstRetainedSequence: 1,
					gaps: [],
					hasMore: false,
				};
			}
			return emptyPage;
		},
	});
	controller.setVisible(true);
	try {
		const search = parent.querySelector<HTMLInputElement>('input[type="search"]')!;
		search.value = '  ';
		search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		await waitFor(() => requests.some(request => request.query === '  ' && request.afterSequence === 0));
		await waitFor(() => parent.querySelector('.ai-session-logs__status')?.textContent?.includes('조건에 맞는 보존 기록이 없습니다.') === true);
		await waitFor(() => parent.querySelector('.ai-session-logs__entry-text')?.textContent === 'live  retained match', 4000);
		assert.ok(requests.some(request => request.query === '  ' && request.afterSequence === 5), 'Live polling must keep the literal query and continue from the exhausted cursor');
	} finally {
		controller.dispose();
		parent.remove();
	}
});
