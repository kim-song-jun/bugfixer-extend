/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { discoverAgentCliCapabilities } from '../agentCliCapabilities.js';
import { runBoundedAgentCliProcess } from '../agentCliProcess.js';

describe('pinned provider CLI help and version discovery', () => {
	it('Codex 0.163.0 reports the interactive flags required by the command builder', async () => {
		const capabilities = await discoverAgentCliCapabilities({
			provider: 'codex', executable: requiredExecutable('BUGFIXER_CODEX_CLI'),
		});
		assert.equal(capabilities.version, '0.163.0');
		assert.equal(capabilities.interactive, true);
		assert.equal(capabilities.model, true);
		assert.equal(capabilities.resumeById, true);
		assert.equal(capabilities.readOnlyPolicy, true);
		assert.equal(capabilities.mutatingPolicy, true);
		assert.equal(capabilities.invocationMcpConfig, true);
		assert.equal(capabilities.exclusiveMcpRoster, false);
	});

	it('Claude Code 2.1.302 reports the interactive flags required by the command builder', async () => {
		const capabilities = await discoverAgentCliCapabilities({
			provider: 'claude', executable: requiredExecutable('BUGFIXER_CLAUDE_CLI'),
		});
		assert.equal(capabilities.version, '2.1.302');
		assert.equal(capabilities.interactive, true);
		assert.equal(capabilities.model, true);
		assert.equal(capabilities.resumeById, true);
		assert.equal(capabilities.newSessionId, true);
		assert.equal(capabilities.readOnlyPolicy, true);
		assert.equal(capabilities.mutatingPolicy, true);
		assert.equal(capabilities.invocationMcpConfig, true);
		assert.equal(capabilities.exclusiveMcpRoster, true);
	});

	it('Codex invocation overrides add the app bridge without clearing an inherited MCP roster', async () => {
		const executable = requiredExecutable('BUGFIXER_CODEX_CLI');
		const profile = mkdtempSync(join(tmpdir(), 'agent-cli-mcp-roster-'));
		try {
			writeFileSync(join(profile, 'config.toml'), [
				'[features]',
				'plugins = false',
				'',
				'[mcp_servers.ci-sentinel]',
				'command = "/usr/bin/true"',
				'args = []',
			].join('\n'));
			const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: profile, CODEX_HOME: profile, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
			const cleared = await runBoundedAgentCliProcess(executable, ['mcp', 'list', '--json', '-c', 'mcp_servers={}'], { env, cwd: profile, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
			const inherited = parseMcpRoster(cleared.stdout);
			assert.deepEqual(inherited.map(server => server.name).sort(), ['ci-sentinel']);
			assert.equal(inherited[0].enabled, true);
			assert.equal(inherited[0].transport.type, 'stdio');
			assert.equal(inherited[0].transport.command, '/usr/bin/true');
			assert.deepEqual(inherited[0].transport.args, []);

			const withBridge = await runBoundedAgentCliProcess(executable, [
				'mcp', 'list', '--json',
				'-c', 'mcp_servers.bugfixer-session.command="/app/session-mcp"',
				'-c', 'mcp_servers.bugfixer-session.args=[]',
				'-c', 'mcp_servers.bugfixer-session.env_vars=["BUGFIXER_SESSION_TOKEN"]',
			], { env, cwd: profile, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
			const roster = parseMcpRoster(withBridge.stdout);
			assert.deepEqual(roster.map(server => server.name).sort(), ['bugfixer-session', 'ci-sentinel']);
			const bridge = roster.find(server => server.name === 'bugfixer-session');
			assert.ok(bridge);
			assert.equal(bridge.enabled, true);
			assert.equal(bridge.transport.type, 'stdio');
			assert.equal(bridge.transport.command, '/app/session-mcp');
			assert.deepEqual(bridge.transport.args, []);
			assert.deepEqual(bridge.transport.env_vars, ['BUGFIXER_SESSION_TOKEN']);
		} finally {
			rmSync(profile, { recursive: true, force: true });
		}
	});

	it('Codex mcp list accepts the invocation UserPromptSubmit command config (config-parser proof only)', async () => {
		const executable = requiredExecutable('BUGFIXER_CODEX_CLI');
		const profile = mkdtempSync(join(tmpdir(), 'agent-cli-prompt-hook-'));
		const configPath = join(profile, 'config.toml');
		const originalConfig = [
			'[features]',
			'plugins = false',
			'',
			'[mcp_servers.ci-sentinel]',
			'command = "/usr/bin/true"',
			'args = []',
		].join('\n');
		try {
			writeFileSync(configPath, originalConfig);
			const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: profile, CODEX_HOME: profile, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
			const command = '"/app/Node.js" "/app/helpers/capture identity.mjs"';
			const hookConfig = JSON.stringify([{ hooks: [{ type: 'command', command }] }]);
			const accepted = await runBoundedAgentCliProcess(executable, [
				'mcp', 'list', '--json',
				'-c', 'mcp_servers.bugfixer-session.command="/app/session-mcp"',
				'-c', 'mcp_servers.bugfixer-session.args=[]',
				'-c', 'mcp_servers.bugfixer-session.env_vars=["BUGFIXER_SESSION_TOKEN"]',
				'-c', `hooks.UserPromptSubmit=${hookConfig}`,
			], { env, cwd: profile, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
			const roster = parseMcpRoster(accepted.stdout);
			assert.deepEqual(roster.map(server => server.name).sort(), ['bugfixer-session', 'ci-sentinel']);
			assert.equal(readFileSync(configPath, 'utf8'), originalConfig, 'Invocation config parsing must not rewrite the profile config file');
		} finally {
			rmSync(profile, { recursive: true, force: true });
		}
	});
});

function requiredExecutable(key: string): string {
	const value = process.env[key];
	assert.ok(value && value.startsWith('/'), `${key} must point to the pinned public CLI installed by CI`);
	return value;
}

interface McpRosterEntry {
	readonly name: string;
	readonly enabled: boolean;
	readonly transport: {
		readonly type: string;
		readonly command?: string;
		readonly args?: readonly string[];
		readonly env_vars?: readonly string[];
	};
}

function parseMcpRoster(output: string): McpRosterEntry[] {
	const parsed: unknown = JSON.parse(output);
	assert.ok(Array.isArray(parsed), 'Codex MCP JSON output must be an array.');
	for (const entry of parsed) {
		assert.ok(entry && typeof entry === 'object' && typeof entry.name === 'string' && typeof entry.enabled === 'boolean');
		assert.ok(entry.transport && typeof entry.transport === 'object' && typeof entry.transport.type === 'string');
	}
	return parsed as McpRosterEntry[];
}
