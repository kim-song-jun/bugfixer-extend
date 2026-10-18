/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentCliCapabilities } from './agentCliCapabilities.js';
import { createAgentSessionCommand, type AgentSessionCommandInput } from './agentSessionCommands.js';

const appSessionId = '550e8400-e29b-41d4-a716-446655440000';
const conversationId = '123e4567-e89b-42d3-a456-426614174000';
const capabilities: AgentCliCapabilities = {
	provider: 'codex', commandSpecVersion: 1, version: '0.163.0', interactive: true, model: true,
	resumeById: true, newSessionId: true, workingDirectory: true, readOnlyPolicy: true, mutatingPolicy: true,
	invocationMcpConfig: true, exclusiveMcpRoster: false, profileSelector: 'CODEX_HOME', requiredPermissionModes: ['--no-daemon'],
};

function input(overrides: Partial<AgentSessionCommandInput> = {}): AgentSessionCommandInput {
	return {
		provider: 'codex', commandSpecVersion: 1, capabilities, executable: '/opt/codex', model: 'gpt-6.1-sol',
		profileRef: 'local-primary', profileDirectory: '/private/profile', cwd: '/work/repo', sessionId: appSessionId,
		permissionPolicy: { mode: 'mutating', approval: 'on-request' },
		mcpServer: { name: 'bugfixer-session', command: '/app/session-mcp', args: [], envVariables: ['BUGFIXER_SESSION_TOKEN'] },
		profileEnvironment: { CODEX_HOME: '/private/profile' }, ...overrides,
	};
}

describe('interactive agent CLI command builders', () => {
	it('builds interactive Codex argv with no daemon, explicit model, cwd, approval mode, and an invocation bridge override', () => {
		const spec = createAgentSessionCommand(input());
		assert.deepEqual(spec.args.slice(0, 6), ['--no-daemon', '--model', 'gpt-6.1-sol', '--cd', '/work/repo', '--approve-for-me']);
		assert.equal(spec.args.includes('--last'), false);
		assert.equal(spec.args.includes('exec'), false);
		assert.equal(spec.args.includes('--json'), false);
		assert.equal(spec.args.join(' ').includes('secret-token-value'), false);
		assert.deepEqual(spec.forwardedMcpEnvironmentVariableNames, ['BUGFIXER_SESSION_TOKEN']);
		assert.equal(spec.env.CODEX_HOME, '/private/profile');
		assert.equal(spec.cwd, '/work/repo');
	});

	it('resumes only the selected provider conversation UUID', () => {
		const spec = createAgentSessionCommand(input({ resumeProviderSessionId: conversationId }));
		assert.deepEqual(spec.args.slice(0, 4), ['resume', conversationId, '--no-daemon', '--model']);
	});

	it('serializes Codex MCP args and env_vars as TOML arrays with Unicode and quoted paths intact', () => {
		const spec = createAgentSessionCommand(input({ mcpServer: {
			name: 'bugfixer-session', command: '/app/도구 "bridge"', args: ['/app/scripts/작업 "one".mjs'],
			envVariables: ['BUGFIXER_SESSION_TOKEN', 'BUGFIXER_TRACE_ID'],
		} }));
		const overrides = new Map<string, unknown>();
		for (let index = 0; index < spec.args.length; index++) {
			if (spec.args[index] !== '-c') { continue; }
			const assignment = spec.args[index + 1];
			assert.ok(assignment);
			const separator = assignment.indexOf('=');
			const key = assignment.slice(0, separator);
			const value = assignment.slice(separator + 1);
			overrides.set(key, JSON.parse(value));
			index++;
		}
		assert.equal(overrides.get('mcp_servers.bugfixer-session.command'), '/app/도구 "bridge"');
		assert.deepEqual(overrides.get('mcp_servers.bugfixer-session.args'), ['/app/scripts/작업 "one".mjs']);
		assert.deepEqual(overrides.get('mcp_servers.bugfixer-session.env_vars'), ['BUGFIXER_SESSION_TOKEN', 'BUGFIXER_TRACE_ID']);
	});

	it('adds one static invocation-scoped UserPromptSubmit command hook without changing MCP, model, permissions, or resume behavior', () => {
		const command = '"/app/Node.js" "/app/helpers/capture identity.mjs"';
		const fresh = createAgentSessionCommand(input({ identityHookCommand: command }));
		const resumed = createAgentSessionCommand(input({ identityHookCommand: command, resumeProviderSessionId: conversationId }));
		const readOnly = createAgentSessionCommand(input({ identityHookCommand: command, permissionPolicy: { mode: 'read-only', approval: 'never' } }));
		const configValue = (args: readonly string[], key: string): string => {
			const index = args.findIndex((argument, position) => argument === '-c' && args[position + 1]?.startsWith(`${key}=`));
			assert.notEqual(index, -1, `Expected one invocation config override for ${key}`);
			const assignment = args[index + 1];
			assert.ok(assignment);
			return assignment.slice(key.length + 1);
		};
		const hook = JSON.parse(configValue(fresh.args, 'hooks.UserPromptSubmit'));
		assert.deepEqual(hook, [{ hooks: [{ type: 'command', command }] }]);
		assert.deepEqual(JSON.parse(configValue(resumed.args, 'hooks.UserPromptSubmit')), hook, 'The same static command must be used for resumed turns');
		assert.equal(resumed.args.includes(conversationId), true);
		assert.deepEqual(JSON.parse(configValue(readOnly.args, 'hooks.UserPromptSubmit')), hook);
		assert.equal(fresh.args.includes('--no-daemon'), true);
		assert.equal(fresh.args[fresh.args.indexOf('--model') + 1], 'gpt-6.1-sol');
		assert.equal(fresh.args[fresh.args.indexOf('--cd') + 1], '/work/repo');
		assert.equal(fresh.args.includes('--approve-for-me'), true);
		assert.deepEqual(readOnly.args.slice(0, 9), ['--no-daemon', '--model', 'gpt-6.1-sol', '--cd', '/work/repo', '--sandbox', 'read-only', '--ask-for-approval', 'never']);
		assert.equal(fresh.args.some(argument => argument.includes('dangerously-bypass') || argument.includes('skip-git-repo-check')), false);
		assert.equal(fresh.args.includes(conversationId), false);
		assert.deepEqual(fresh.forwardedMcpEnvironmentVariableNames, ['BUGFIXER_SESSION_TOKEN']);
		assert.equal(fresh.env.CODEX_HOME, '/private/profile');
		const configKeys: string[] = [];
		for (let index = 0; index < fresh.args.length; index++) {
			if (fresh.args[index] !== '-c') { continue; }
			const assignment = fresh.args[index + 1];
			assert.ok(assignment);
			const separator = assignment.indexOf('=');
			assert.ok(separator > 0);
			configKeys.push(assignment.slice(0, separator));
		}
		assert.deepEqual(configKeys, ['mcp_servers.bugfixer-session.command', 'mcp_servers.bugfixer-session.args', 'mcp_servers.bugfixer-session.env_vars', 'hooks.UserPromptSubmit']);
	});

	it('builds interactive Claude with a strict app MCP config and read-only built-in tool allowlist', () => {
		const spec = createAgentSessionCommand(input({
			provider: 'claude',
			capabilities: { ...capabilities, provider: 'claude', exclusiveMcpRoster: true, profileSelector: 'CLAUDE_CONFIG_DIR' },
			profileEnvironment: { CLAUDE_CONFIG_DIR: '/private/profile' },
			claudeMcpConfigPath: '/private/session-mcp.json',
			permissionPolicy: { mode: 'read-only', approval: 'never' },
		}));
		assert.deepEqual(spec.args, ['--model', 'gpt-6.1-sol', '--mcp-config', '/private/session-mcp.json', '--strict-mcp-config', '--session-id', appSessionId,
			'--restricted', '--tools', 'Read,Glob,Grep', '--permission-mode', 'plan']);
		assert.equal(spec.args.includes('--print'), false);
		assert.equal(spec.args.includes('--permission-prompts'), false);
	});

	it('requires invocation MCP configuration support without claiming Codex roster exclusivity', () => {
		assert.throws(() => createAgentSessionCommand(input({ capabilities: { ...capabilities, invocationMcpConfig: false } })), /does not prove/);
	});

	it('rejects unsupported policies, capability gaps, bad IDs, injected control characters, and profile mismatch', () => {
		assert.throws(() => createAgentSessionCommand(input({ permissionPolicy: { mode: 'read-only', approval: 'on-request' } })), /never approval/);
		assert.throws(() => createAgentSessionCommand(input({ permissionPolicy: { mode: 'mutating', approval: 'always' } })), /on-request/);
		assert.throws(() => createAgentSessionCommand(input({ capabilities: { ...capabilities, interactive: false } })), /does not prove/);
		assert.throws(() => createAgentSessionCommand(input({ resumeProviderSessionId: '--last' })), /UUID/);
		assert.throws(() => createAgentSessionCommand(input({ model: 'model\n--dangerously-bypass' })), /model/);
		assert.throws(() => createAgentSessionCommand(input({ cwd: '/work/repo\u0000--flag' })), /absolute path/);
		assert.throws(() => createAgentSessionCommand(input({ profileEnvironment: { CODEX_HOME: '/another/profile' } })), /requested local provider profile/);
	});

	it('rejects unknown version and caller supplied MCP environment values', () => {
		assert.throws(() => createAgentSessionCommand(input({ commandSpecVersion: 2 })), /version is unsupported/);
		assert.throws(() => createAgentSessionCommand(input({ mcpServer: { ...input().mcpServer, envVariables: ['Bearer-secret-value'] } })), /variable names/);
	});

	it('rejects invalid Codex identity hook commands and hooks for unsupported providers', () => {
		assert.throws(() => createAgentSessionCommand(input({ identityHookCommand: '' })), /identity hook command/);
		assert.throws(() => createAgentSessionCommand(input({ identityHookCommand: ' \t ' })), /identity hook command/);
		assert.throws(() => createAgentSessionCommand(input({ identityHookCommand: '/app/hook\u0000unsafe' })), /identity hook command/);
		assert.throws(() => createAgentSessionCommand(input({ identityHookCommand: '/app/hook\runsafe' })), /identity hook command/);
		assert.throws(() => createAgentSessionCommand(input({ identityHookCommand: '/app/hook\nunsafe' })), /identity hook command/);
		assert.throws(() => createAgentSessionCommand(input({ identityHookCommand: '/app/'.padEnd(4097, 'x') })), /identity hook command/);
		assert.throws(() => createAgentSessionCommand(input({ identityHookCommand: 42 as unknown as string })), /identity hook command/);
		assert.throws(() => createAgentSessionCommand(input({
			provider: 'claude',
			capabilities: { ...capabilities, provider: 'claude', exclusiveMcpRoster: true, profileSelector: 'CLAUDE_CONFIG_DIR' },
			profileEnvironment: { CLAUDE_CONFIG_DIR: '/private/profile' },
			claudeMcpConfigPath: '/private/session-mcp.json',
			identityHookCommand: '/app/hook',
		})), /only by the Codex/);
	});
});
