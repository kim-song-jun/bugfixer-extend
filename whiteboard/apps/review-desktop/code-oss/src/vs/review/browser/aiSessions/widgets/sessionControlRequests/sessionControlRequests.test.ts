import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { AgentSessionControlRequestDTO } from '../../../../../workspace/common/workspaceAgentSessionControlProtocol.js';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const dom = new JSDOM('<html><body></body></html>');
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
const { renderSessionControlRequests } = await import('./sessionControlRequests.js');

function request(state: AgentSessionControlRequestDTO['state'] = 'pendingReview'): AgentSessionControlRequestDTO {
	return {
		id: 'request', projectId: 'project', kind: state.startsWith('stop') ? 'stop' : 'start', state, revision: 1,
		callerSessionId: 'caller', callerTurnId: 'caller-turn', targetSessionId: 'target', targetTurnId: null,
		expectedSessionRevision: 1, permissionPolicy: { mode: 'read-only', approval: 'on-request' }, reason: 'Inspect the retained reference.',
		workflowAuthority: null, snapshotFingerprint: null, approvedIdempotencyKey: null, resultTurnId: null,
		targetTurnState: null, error: null, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
	};
}

test('pending requests expose exact preview/reject actions with no renderer launch action', () => {
	const parent = document.createElement('section');
	const previews: string[] = []; const rejections: string[] = [];
	const saved = request();
	renderSessionControlRequests(parent, { page: { requests: [saved], hasMore: false, nextCursor: null, hostError: null }, loading: false, error: undefined, history: false, sessions: [], busy: false }, {
		onPreview: item => previews.push(item.id), onReject: item => rejections.push(item.id), onFilter() { }, onFirst() { }, onNext() { }, onClose() { },
	});
	parent.querySelector<HTMLButtonElement>('[data-control-action="request:preview"]')!.click();
	parent.querySelector<HTMLButtonElement>('[data-control-action="request:reject"]')!.click();
	assert.deepEqual(previews, ['request']); assert.deepEqual(rejections, ['request']);
	assert.match(parent.textContent ?? '', /macOS 확인 창에서 승인해야 실행/u);
	assert.equal([...parent.querySelectorAll('button')].some(button => button.textContent === '실행'), false);
});

test('accepted stop is visibly unverified and completion never acquires start approval controls', () => {
	const parent = document.createElement('section');
	const actions = { onPreview() { assert.fail('A stop receipt cannot authorize a start.'); }, onReject() { }, onFilter() { }, onFirst() { }, onNext() { }, onClose() { } };
	for (const state of ['stopAccepted', 'stopCompleted'] as const) {
		renderSessionControlRequests(parent, { page: { requests: [request(state)], hasMore: false, nextCursor: null, hostError: null }, loading: false, error: undefined, history: true, sessions: [], busy: false }, actions);
		const row = parent.querySelector('.ai-session-control__row')!;
		assert.match(row.textContent ?? '', state === 'stopAccepted' ? /중단 접수 · 정리 미확인/u : /중단 정리 확인/u);
		assert.equal(row.querySelector('button'), null);
		assert.equal(parent.querySelectorAll('.ai-session-control__row').length, 1, 'Rerender must replace stale request rows.');
	}
});

test('busy requests cannot dispatch duplicate previews or page changes', () => {
	const parent = document.createElement('section');
	let dispatched = 0;
	const invoke = () => { dispatched++; };
	renderSessionControlRequests(parent, { page: { requests: [request()], hasMore: true, nextCursor: { createdAt: '2026-10-20T00:00:00Z', id: 'request' }, hostError: null }, loading: false, error: undefined, history: false, sessions: [], busy: true }, {
		onPreview: invoke, onReject: invoke, onFilter: invoke, onFirst: invoke, onNext: invoke, onClose() { },
	});
	for (const button of parent.querySelectorAll<HTMLButtonElement>('button:not([data-control-action="요청 닫기"])')) { button.click(); }
	assert.equal(dispatched, 0);
	assert.match(parent.querySelector('[role="status"]')?.textContent ?? '', /요청을 처리 중/u);
});
