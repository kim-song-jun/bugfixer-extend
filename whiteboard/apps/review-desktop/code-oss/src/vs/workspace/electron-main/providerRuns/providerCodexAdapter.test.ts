/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexCommandSpec, parseCodexJsonlEvent } from './providerCodexAdapter.js';
import type { ProviderRunRequest } from './providerRunTypes.js';

function request(mode: 'read-only' | 'mutating' = 'read-only', approval: 'never' | 'on-request' | 'always' = 'never'): ProviderRunRequest {
	return {
		providerId: 'codex',
		attemptId: 'attempt-1',
		cwd: '/workspace/repo',
		prompt: 'inspect the failing test',
		profileDirectory: '/profiles/codex',
		permissionPolicy: { mode, approval },
		preflight: async () => ({ allowed: true, cwdIdentity: 'folder-1', policyProof: 'policy-1' }),
	};
}

test('Codex command keeps prompt and paths as argv values and applies the requested safe policy', () => {
	const spec = createCodexCommandSpec({ ...request(), prompt: 'fix; do not run shell fragments' });
	assert.equal(spec.executable, 'codex');
	assert.deepEqual(spec.args, [
		'exec', '--json', '--sandbox', 'read-only',
		'--skip-git-repo-check', '--ephemeral', '-',
	]);
	assert.equal(spec.stdin, 'fix; do not run shell fragments');
	assert.deepEqual(spec.env, { CODEX_HOME: '/profiles/codex' });
	assert.equal(spec.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
});

test('Codex mutating mode uses the installed CLI workspace-write and automatic-review flags', () => {
	const spec = createCodexCommandSpec(request('mutating', 'on-request'));
	assert.deepEqual(spec.args, [
		'exec', '--json', '--approve-for-me',
		'--skip-git-repo-check', '--ephemeral', '-',
	]);
	assert.equal(spec.args.includes('--ask-for-approval'), false);
	assert.equal(spec.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
	assert.throws(() => createCodexCommandSpec(request('mutating', 'never')), /on-request/);
	assert.throws(() => createCodexCommandSpec(request('read-only', 'on-request')), /read-only sandbox/);
});

test('Codex events expose lifecycle metadata only and require a terminal turn event', () => {
	const started = parseCodexJsonlEvent(JSON.stringify({ type: 'thread.started', thread_id: 'a1b2c3d4-1234' }), 'stdout');
	assert.deepEqual(started, { event: { type: 'session.started', providerSessionId: 'a1b2c3d4-1234' } });
	const output = parseCodexJsonlEvent(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'private response' } }), 'stdout');
	assert.deepEqual(output, { event: { type: 'item.completed', metadata: { itemType: 'agent_message' } }, finalText: 'private response' });
	assert.deepEqual(parseCodexJsonlEvent('{"type":"turn.completed"}', 'stdout'), { event: { type: 'turn.completed' }, terminalState: 'succeeded' });
	assert.deepEqual(parseCodexJsonlEvent('{"type":"turn.failed","error":{"message":"secret"}}', 'stdout'), { event: { type: 'turn.failed' }, terminalState: 'failed' });
	assert.deepEqual(parseCodexJsonlEvent('{"type":"turn.completed"}', 'stderr'), {});
	const verboseLine = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(128 * 1024) } });
	assert.ok(Buffer.byteLength(verboseLine, 'utf8') > 64 * 1024);
	assert.deepEqual(parseCodexJsonlEvent(verboseLine, 'stdout'), { event: { type: 'item.completed', metadata: { itemType: 'agent_message' } }, finalText: 'x'.repeat(128 * 1024) });
	assert.deepEqual(parseCodexJsonlEvent('x'.repeat(1024 * 1024 + 1), 'stdout'), {});
});

test('Codex failed validation clears on an identical successful retry', () => {
	const parser = createCodexCommandSpec(request()).parseEvent;
	const red = parser(JSON.stringify({ type: 'item.completed', item: {
		type: 'command_execution', command: 'npm test', exit_code: 1, status: 'failed',
	} }), 'stdout');
	assert.equal(red.event?.metadata?.itemOutcome, 'failed');
	assert.equal(red.terminalState, undefined);
	const green = parser(JSON.stringify({ type: 'item.completed', item: {
		type: 'command_execution', command: 'npm test', exit_code: 0, status: 'completed',
	} }), 'stdout');
	assert.equal(green.event?.metadata?.itemOutcome, undefined);
	assert.equal(parser('{"type":"turn.completed"}', 'stdout').terminalState, 'succeeded');
});

test('Codex failed validation and hard item failures block turn completion', () => {
	const unresolvedParser = createCodexCommandSpec(request()).parseEvent;
	const red = unresolvedParser(JSON.stringify({ type: 'item.completed', item: {
		type: 'command_execution', command: 'npm test', exit_code: 1, status: 'failed',
	} }), 'stdout');
	assert.equal(red.event?.metadata?.itemOutcome, 'failed');
	assert.equal(unresolvedParser('{"type":"turn.completed"}', 'stdout').event?.metadata?.itemOutcome, 'failed');
	assert.equal(unresolvedParser('{"type":"turn.completed"}', 'stdout').terminalState, 'failed');

	for (const item of [
		{ type: 'file_change', changes: [], status: 'failed' },
		{ type: 'command_execution', exit_code: 1, status: 'failed' },
		{ type: 'command_execution', command: 'npm test', status: 'failed' },
		{ type: 'command_execution', command: 'npm test', exit_code: '1', status: 'failed' },
		{ type: 'command_execution', command: 'npm test', exit_code: 1.5, status: 'failed' },
		{ type: 'command_execution', command: 'npm test', status: 'denied' },
	]) {
		const parser = createCodexCommandSpec(request()).parseEvent;
		const failedItem = parser(JSON.stringify({ type: 'item.completed', item }), 'stdout');
		assert.equal(failedItem.event?.metadata?.itemOutcome, item.status === 'denied' ? 'denied' : 'failed');
		assert.equal(failedItem.terminalState, 'failed');
		assert.equal(parser('{"type":"turn.completed"}', 'stdout').terminalState, 'failed');
	}
	const denied = parseCodexJsonlEvent(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', status: 'denied' } }), 'stdout');
	assert.equal(denied.event?.metadata?.itemOutcome, 'denied');
	assert.equal(denied.terminalState, 'failed');
});

test('Codex allows a failed exploratory probe in a non-git folder when the edit and turn complete', () => {
	const parser = createCodexCommandSpec(request('mutating', 'on-request')).parseEvent;
	const probe = parser(JSON.stringify({ type: 'item.completed', item: {
		type: 'command_execution', command: 'git status --short', exit_code: 128, status: 'failed',
	} }), 'stdout');
	assert.equal(probe.event?.metadata?.itemOutcome, 'unresolved');
	assert.equal(probe.terminalState, undefined);
	const edit = parser(JSON.stringify({ type: 'item.completed', item: {
		type: 'file_change', status: 'completed',
	} }), 'stdout');
	assert.equal(edit.terminalState, undefined);
	assert.deepEqual(parser('{"type":"turn.completed"}', 'stdout'), {
		event: { type: 'turn.completed' }, terminalState: 'succeeded',
	});
});

test('Codex failed validation remains a run failure unless the same check succeeds', () => {
	const parser = createCodexCommandSpec(request()).parseEvent;
	const failedCheck = parser(JSON.stringify({ type: 'item.completed', item: {
		type: 'command_execution', command: 'pnpm run lint', exit_code: 1, status: 'failed',
	} }), 'stdout');
	assert.equal(failedCheck.event?.metadata?.itemOutcome, 'failed');
	assert.equal(parser('{"type":"turn.completed"}', 'stdout').terminalState, 'failed');
});

test('Codex adapter rejects unsupported approval policy and another provider', () => {
	assert.throws(() => createCodexCommandSpec(request('read-only', 'always')), /does not support/);
	assert.throws(() => createCodexCommandSpec({ ...request(), providerId: 'claude' }), /another provider/);
});

test('Codex adapter rejects an empty or relative profile directory', () => {
	assert.throws(() => createCodexCommandSpec({ ...request(), profileDirectory: '' }), /absolute profile directory/);
	assert.throws(() => createCodexCommandSpec({ ...request(), profileDirectory: 'relative/profile' }), /absolute profile directory/);
});
