import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPinnedSessionStopResponse, requestPinnedSessionStop } from './sessionStop.js';

test('a new run appearing during a delayed refresh cannot inherit the previous stop click', async () => {
	let finish!: (turn: { id: string; projectId: string; sessionId: string; state: 'running' }) => void;
	const refreshed = new Promise<{ id: string; projectId: string; sessionId: string; state: 'running' }>(resolve => { finish = resolve; });
	const stopped: string[] = [];
	const result = requestPinnedSessionStop({ projectId: 'project', sessionId: 'session', turnId: 'run-A' }, {
		refresh: () => refreshed, isCurrent: () => true, stop: async turnId => { stopped.push(turnId); return true; },
	});
	assert.deepEqual(stopped, []);
	finish({ id: 'run-B', projectId: 'project', sessionId: 'session', state: 'running' });
	assert.equal(await result, 'reviewRequired');
	assert.deepEqual(stopped, []);
});

test('only the exact reviewed running turn in the same project and session can be stopped', async () => {
	const stopped: string[] = [];
	for (const current of [
		{ id: 'run-A', projectId: 'other-project', sessionId: 'session', state: 'running' as const },
		{ id: 'run-A', projectId: 'project', sessionId: 'other-session', state: 'running' as const },
		{ id: 'run-A', projectId: 'project', sessionId: 'session', state: 'exited' as const },
		{ id: 'run-A', projectId: 'project', sessionId: 'session', state: 'running' as const },
	]) {
		await requestPinnedSessionStop({ projectId: 'project', sessionId: 'session', turnId: 'run-A' }, {
			refresh: async () => current, isCurrent: () => true, stop: async turnId => { stopped.push(turnId); return true; },
		});
	}
	assert.deepEqual(stopped, ['run-A']);
});

test('unknown click targets and changed selection require review without stopping the refreshed run', async () => {
	const stopped: string[] = [];
	for (const [turnId, isCurrent] of [[undefined, true], ['run-A', false]] as const) {
		await requestPinnedSessionStop({ projectId: 'project', sessionId: 'session', turnId }, {
			refresh: async () => ({ id: 'run-A', projectId: 'project', sessionId: 'session', state: 'running' }),
			isCurrent: () => isCurrent, stop: async id => { stopped.push(id); return true; },
		});
	}
	assert.deepEqual(stopped, []);
});

test('a stop operation refused after refresh is never reported as an accepted request', async () => {
	let operation = false;
	const sent: string[] = [];
	const result = await requestPinnedSessionStop({ projectId: 'project', sessionId: 'session', turnId: 'run-A' }, {
		refresh: async () => { operation = true; return { id: 'run-A', projectId: 'project', sessionId: 'session', state: 'running' }; },
		isCurrent: () => true,
		stop: async id => { if (operation) { return false; } sent.push(id); return true; },
	});
	assert.equal(result, 'notRequested');
	assert.deepEqual(sent, []);
});

test('a sent request with a foreign response is an explicit verification error, not a refusal before send', async () => {
	const target = { projectId: 'project', sessionId: 'session', turnId: 'run-A' };
	const sent: string[] = [];
	await assert.rejects(requestPinnedSessionStop(target, {
		refresh: async () => ({ id: 'run-A', projectId: 'project', sessionId: 'session', state: 'running' }),
		isCurrent: () => true,
		stop: async id => {
			sent.push(id);
			assertPinnedSessionStopResponse(target, { id: 'run-B', projectId: 'project', sessionId: 'session', state: 'exited' });
			return true;
		},
	}), /응답이 요청한 프로젝트·세션·실행과 일치하지 않습니다/u);
	assert.deepEqual(sent, ['run-A']);
});
