/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProviderRunRequest } from './providerRunTypes.js';
import { createClaudeProviderCommand, parseClaudeProviderEvent } from './providerClaudeAdapter.js';

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
	return {
		providerId: 'claude',
		attemptId: 'attempt-claude-test',
		cwd: '/workspace/project',
		prompt: 'review this change; do not edit files',
		profileDirectory: '/profile/claude',
		permissionPolicy: { mode: 'read-only', approval: 'never' },
		preflight: async () => ({ allowed: true, cwdIdentity: 'directory-proof', policyProof: 'read-only-proof' }),
		...overrides,
	};
}

test('builds a shell-free Claude command with isolated profile and enforced plan permissions', () => {
	const command = createClaudeProviderCommand(request(), '/opt/claude');
	assert.equal(command.executable, '/opt/claude');
	assert.deepEqual(command.args, [
		'--print', '--input-format', 'stream-json',
		'--output-format', 'stream-json', '--verbose', '--restricted',
		'--permission-mode', 'plan', '--permission-prompts', 'none',
	]);
	assert.equal(command.stdin, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'review this change; do not edit files' }] } }) + '\n');
	assert.deepEqual(command.env, { CLAUDE_CONFIG_DIR: '/profile/claude' });
});

test('Claude default profile uses the CLI default while custom profiles remain isolated', () => {
	const defaultCommand = createClaudeProviderCommand(request({ profileDirectory: join(userInfo().homedir, '.claude') }));
	assert.equal(defaultCommand.env, undefined);

	const customCommand = createClaudeProviderCommand(request({ profileDirectory: '/profile/claude-custom' }));
	assert.deepEqual(customCommand.env, { CLAUDE_CONFIG_DIR: '/profile/claude-custom' });
});

test('Claude default profile remains native when HOME differs from the account home', () => {
	const priorHome = process.env.HOME;
	try {
		process.env.HOME = '/tmp/claude-home-override';
		const command = createClaudeProviderCommand(request({ profileDirectory: join(userInfo().homedir, '.claude') }));
		assert.equal(command.env, undefined);
	} finally {
		if (priorHome === undefined) delete process.env.HOME;
		else process.env.HOME = priorHome;
	}
});

test('Claude task mode accepts project edits while denying tools that need a prompt broker', () => {
	const command = createClaudeProviderCommand(request({
		permissionPolicy: { mode: 'mutating', approval: 'on-request' },
	}));
	assert.deepEqual(command.args, [
		'--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--restricted',
		'--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
	]);
	assert.equal(command.args.includes('bypassPermissions'), false);
	assert.throws(() => createClaudeProviderCommand(request({ permissionPolicy: { mode: 'mutating', approval: 'never' } })), /on-request/);
	assert.throws(() => createClaudeProviderCommand(request({
		permissionPolicy: { mode: 'read-only', approval: 'on-request' },
	})), /read-only runs require no approval/);
});

test('convention agent mode disables all Claude tools so it can use only supplied snapshots', () => {
	const command = createClaudeProviderCommand(request({ captureFinalText: true }));
	assert.ok(command.args.includes('--tools'));
	assert.equal(command.args[command.args.indexOf('--tools') + 1], '');
	assert.equal(command.args.includes('bypassPermissions'), false);
});

test('Claude task runs retain restricted file tools while capturing the final result', () => {
	const command = createClaudeProviderCommand(request({
		captureFinalText: true,
		permissionPolicy: { mode: 'mutating', approval: 'on-request' },
	}));
	assert.equal(command.args.includes('--tools'), false);
	assert.ok(command.args.includes('--restricted'));
	assert.ok(command.args.includes('--permission-mode'));
	assert.equal(command.args[command.args.indexOf('--permission-mode') + 1], 'acceptEdits');
	assert.equal(command.args[command.args.indexOf('--permission-prompts') + 1], 'none');
	assert.deepEqual(command.env, { CLAUDE_CONFIG_DIR: '/profile/claude' });
	assert.equal(parseClaudeProviderEvent(JSON.stringify({
		type: 'result', subtype: 'success', is_error: false, result: 'task result',
	}), 'stdout').finalText, 'task result');
});

test('emits only bounded lifecycle metadata and derives success from the terminal result', () => {
	assert.deepEqual(parseClaudeProviderEvent(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session_123' }), 'stdout'), {
		event: { type: 'session.started', providerSessionId: 'session_123' },
	});
	assert.deepEqual(parseClaudeProviderEvent(JSON.stringify({
		type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 42, result: 'private answer',
	}), 'stdout'), {
		event: { type: 'turn.completed', metadata: { subtype: 'success', numTurns: 2, durationMs: 42 } },
		terminalState: 'succeeded',
		finalText: 'private answer',
	});
	assert.equal(parseClaudeProviderEvent(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'secret' }), 'stdout').terminalState, 'failed');
	assert.deepEqual(parseClaudeProviderEvent(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'bad/session' }), 'stdout'), {
		event: { type: 'session.started' },
	});
	assert.deepEqual(parseClaudeProviderEvent(JSON.stringify({ type: 'result', subtype: 'success', result: 'ignored' }), 'stderr'), {});
	assert.deepEqual(parseClaudeProviderEvent('x'.repeat(1024 * 1024 + 1), 'stdout'), {});
	assert.deepEqual(parseClaudeProviderEvent('not json', 'stdout'), {});
});

test('rejects invalid profile paths and omits unknown result subtype metadata', () => {
	assert.throws(() => createClaudeProviderCommand(request({ profileDirectory: '' })), /absolute profile directory/);
	assert.throws(() => createClaudeProviderCommand(request({ profileDirectory: 'relative/profile' })), /absolute profile directory/);
	assert.deepEqual(parseClaudeProviderEvent(JSON.stringify({ type: 'result', subtype: 'credential_dump', is_error: true }), 'stdout'), {
		event: { type: 'turn.completed', metadata: {} },
		terminalState: 'failed',
	});
});

test('tracks Claude permission denial through the observed tool event sequence without retaining details', () => {
	const command = createClaudeProviderCommand(request());
	assert.deepEqual(command.parseEvent(JSON.stringify({
		type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SecretTool', input: { token: 'private' } }] },
	}), 'stdout'), {});
	const denied = command.parseEvent(JSON.stringify({
		type: 'system', subtype: 'permission_denied', tool_name: 'SecretTool', message: 'private denial reason',
	}), 'stdout');
	assert.deepEqual(denied, { event: { type: 'permission.denied' } });
	assert.equal(JSON.stringify(denied).includes('SecretTool'), false);
	assert.equal(JSON.stringify(denied).includes('private denial reason'), false);
	assert.deepEqual(command.parseEvent(JSON.stringify({ type: 'user', tool_result: { is_error: true, content: 'private tool output' } }), 'stdout'), {});
	const result = command.parseEvent(JSON.stringify({
		type: 'result', subtype: 'success', is_error: false, result: 'must not escape',
		permission_denials: [{ tool_name: 'SecretTool', reason: 'private denial reason' }],
	}), 'stdout');
	assert.deepEqual(result, { event: { type: 'turn.completed', metadata: { itemOutcome: 'denied', subtype: 'success' } }, terminalState: 'failed' });
	assert.equal(JSON.stringify(result).includes('private'), false);
	assert.equal(result.finalText, undefined);
});

test('fails a result containing structured permission denials in the stateless parser', () => {
	assert.deepEqual(parseClaudeProviderEvent(JSON.stringify({
		type: 'result', subtype: 'success', is_error: false, result: 'private answer',
		permission_denials: [{ tool_name: 'SecretTool' }],
	}), 'stdout'), {
		event: { type: 'turn.completed', metadata: { itemOutcome: 'denied', subtype: 'success' } },
		terminalState: 'failed',
	});
});

test('does not make recoverable tool errors sticky and preserves a clean success', () => {
	const command = createClaudeProviderCommand(request());
	assert.deepEqual(command.parseEvent(JSON.stringify({
		type: 'user', tool_result: { is_error: true, content: 'tool failed but may recover' },
	}), 'stdout'), {});
	assert.deepEqual(command.parseEvent(JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'recovered' }] }), 'stdout'), {});
	assert.deepEqual(command.parseEvent(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'clean answer' }), 'stdout'), {
		event: { type: 'turn.completed', metadata: { subtype: 'success' } },
		terminalState: 'succeeded',
		finalText: 'clean answer',
	});
});
