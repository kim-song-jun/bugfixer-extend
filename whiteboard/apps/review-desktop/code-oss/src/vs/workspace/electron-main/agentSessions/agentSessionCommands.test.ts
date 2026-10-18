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
});
