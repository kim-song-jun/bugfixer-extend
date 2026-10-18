/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from 'node:path';
import type { ProviderPermissionPolicy, ProviderId } from '../providerRuns/providerRunTypes.js';
import { AGENT_CLI_COMMAND_SPEC_VERSION, type AgentCliCapabilities } from './agentCliCapabilities.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CLI_VALUE = /^[\p{L}\p{N}._:/@+-]+$/u;
const MAX_PATH_LENGTH = 4096;

export interface AgentSessionMcpServer {
	/** App-generated stable name; caller-supplied MCP server names are not accepted at IPC boundaries. */
	readonly name: 'bugfixer-session';
	/** Trusted app-owned local bridge executable and arguments. */
	readonly command: string;
	readonly args: readonly string[];
	/** Allowlisted variable names forwarded to the app-owned bridge; values stay out of config and argv. */
	readonly envVariables: readonly string[];
}

export interface AgentSessionCommandInput {
	readonly provider: ProviderId;
	readonly commandSpecVersion: number;
	readonly capabilities: AgentCliCapabilities;
	readonly executable: string;
	readonly model: string;
	readonly profileRef: string;
	readonly profileDirectory: string;
	readonly cwd: string;
	readonly sessionId: string;
	readonly resumeProviderSessionId?: string;
	readonly permissionPolicy: ProviderPermissionPolicy;
	readonly mcpServer: AgentSessionMcpServer;
	readonly claudeMcpConfigPath?: string;
	/** Only the selected existing local profile's documented home/config selector is accepted. */
	readonly profileEnvironment: Readonly<Record<string, string>>;
}

export interface AgentSessionCommandSpec {
	readonly commandSpecVersion: typeof AGENT_CLI_COMMAND_SPEC_VERSION;
	readonly provider: ProviderId;
	readonly cliVersion: string;
	readonly model: string;
	readonly profileRef: string;
	readonly cwd: string;
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly forwardedMcpEnvironmentVariableNames: readonly string[];
}

/** Builds one immutable, interactive CLI launch. No shell text, prompt, or caller-defined extra args. */
export function createAgentSessionCommand(input: AgentSessionCommandInput): AgentSessionCommandSpec {
	validateInput(input);
	const env = Object.freeze({ ...input.profileEnvironment });
	const args = input.provider === 'codex' ? createCodexArgs(input) : createClaudeArgs(input);
	return Object.freeze({
		commandSpecVersion: AGENT_CLI_COMMAND_SPEC_VERSION,
		provider: input.provider,
		cliVersion: input.capabilities.version,
		model: input.model,
		profileRef: input.profileRef,
		cwd: input.cwd,
		executable: input.executable,
		args: Object.freeze(args),
		env,
		forwardedMcpEnvironmentVariableNames: Object.freeze([...input.mcpServer.envVariables]),
	});
}

function validateInput(input: AgentSessionCommandInput): void {
	if (input.commandSpecVersion !== AGENT_CLI_COMMAND_SPEC_VERSION || input.capabilities.commandSpecVersion !== AGENT_CLI_COMMAND_SPEC_VERSION) {
		throw new Error('The CLI command specification version is unsupported.');
	}
	if (input.capabilities.provider !== input.provider || !input.capabilities.interactive || !input.capabilities.model || !input.capabilities.resumeById || !input.capabilities.newSessionId
		|| !input.capabilities.workingDirectory || !input.capabilities.scopedMcpConfig
		|| (input.permissionPolicy.mode === 'read-only' && !input.capabilities.readOnlyPolicy)
		|| (input.permissionPolicy.mode === 'mutating' && !input.capabilities.mutatingPolicy)) {
		throw new Error('The selected CLI does not prove all required interactive session capabilities.');
	}
	for (const [name, value] of [['executable', input.executable], ['model', input.model], ['profileRef', input.profileRef]] as const) {
		if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) { throw new Error(`The ${name} is invalid.`); }
	}
	if (!SAFE_CLI_VALUE.test(input.model)) { throw new Error('The selected model identifier contains unsupported characters.'); }
	assertAbsolutePath(input.cwd, 'working directory');
	assertAbsolutePath(input.profileDirectory, 'profile directory');
	if (!UUID.test(input.sessionId)) { throw new Error('The app session ID must be a UUID.'); }
	if (input.resumeProviderSessionId !== undefined && !UUID.test(input.resumeProviderSessionId)) { throw new Error('The provider conversation ID must be a UUID.'); }
	if (input.permissionPolicy.mode === 'read-only' && input.permissionPolicy.approval !== 'never') { throw new Error('Read-only sessions require the never approval policy.'); }
	if (input.permissionPolicy.mode === 'mutating' && input.permissionPolicy.approval !== 'on-request') { throw new Error('Mutating sessions require the on-request approval policy.'); }
	if (input.permissionPolicy.mode !== 'read-only' && input.permissionPolicy.mode !== 'mutating') { throw new Error('The requested permission mode is unsupported.'); }
	if (input.mcpServer.name !== 'bugfixer-session' || !isAbsolute(input.mcpServer.command) || input.mcpServer.command.length > MAX_PATH_LENGTH
		|| /[\u0000-\u001f\u007f]/.test(input.mcpServer.command) || input.mcpServer.args.length > 4
		|| input.mcpServer.args.some(arg => !isAbsolute(arg) || arg.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(arg))) {
		throw new Error('The app-owned session MCP bridge specification is invalid.');
	}
	if (input.mcpServer.envVariables.length > 8 || new Set(input.mcpServer.envVariables).size !== input.mcpServer.envVariables.length
		|| input.mcpServer.envVariables.some(name => !/^[A-Z][A-Z0-9_]{0,63}$/.test(name))) {
		throw new Error('Session MCP environment must contain only allowlisted variable names.');
	}
	const expectedProfileKey = input.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
	if (input.capabilities.profileSelector !== expectedProfileKey || Object.keys(input.profileEnvironment).length !== 1 || typeof input.profileEnvironment[expectedProfileKey] !== 'string'
		|| input.profileEnvironment[expectedProfileKey] !== input.profileDirectory) {
		throw new Error('The launch environment must select exactly the requested local provider profile.');
	}
	if (input.provider === 'claude') { assertAbsolutePath(input.claudeMcpConfigPath ?? '', 'Claude MCP config'); }
}

function createCodexArgs(input: AgentSessionCommandInput): string[] {
	const args = input.resumeProviderSessionId ? ['resume', input.resumeProviderSessionId] : [];
	args.push('--no-daemon', '--model', input.model, '--cd', input.cwd);
	if (input.permissionPolicy.mode === 'mutating') {
		args.push('--approve-for-me');
	} else {
		args.push('--sandbox', 'read-only', '--ask-for-approval', 'never');
	}
	for (const [key, value] of Object.entries(codexMcpOverrides(input.mcpServer))) { args.push('-c', `${key}=${serializeTomlValue(value)}`); }
	return args;
}

function codexMcpOverrides(server: AgentSessionMcpServer): Record<string, string | readonly string[]> {
	const prefix = `mcp_servers.${server.name}`;
	return {
		[`${prefix}.command`]: server.command,
		[`${prefix}.args`]: server.args,
		[`${prefix}.env_vars`]: server.envVariables,
	};
}

function createClaudeArgs(input: AgentSessionCommandInput): string[] {
	const args = ['--model', input.model, '--mcp-config', input.claudeMcpConfigPath!, '--strict-mcp-config'];
	if (input.resumeProviderSessionId) { args.push('--resume', input.resumeProviderSessionId); }
	else { args.push('--session-id', input.sessionId); }
	if (input.permissionPolicy.mode === 'mutating') {
		args.push('--permission-mode', 'acceptEdits');
	} else {
		args.push('--restricted', '--tools', 'Read,Glob,Grep', '--permission-mode', 'plan');
	}
	return args;
}

function serializeTomlValue(value: string | readonly string[]): string {
	return typeof value === 'string' ? JSON.stringify(value) : `[${value.map(item => JSON.stringify(item)).join(', ')}]`;
}

function assertAbsolutePath(value: string, name: string): void {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH || !isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new Error(`The ${name} must be a bounded absolute path without control characters.`);
	}
}
