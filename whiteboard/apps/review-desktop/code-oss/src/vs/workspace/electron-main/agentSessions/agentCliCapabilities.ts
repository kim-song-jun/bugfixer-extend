/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderId } from '../providerRuns/providerRunTypes.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoundedAgentCliProcess } from './agentCliProcess.js';
import { AgentSessionPreparationError } from './agentSessionPreparationError.js';

export const AGENT_CLI_COMMAND_SPEC_VERSION = 1 as const;
export const AGENT_CLI_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;

export interface AgentCliCapabilities {
	readonly provider: ProviderId;
	readonly commandSpecVersion: typeof AGENT_CLI_COMMAND_SPEC_VERSION;
	readonly version: string;
	readonly interactive: boolean;
	readonly model: boolean;
	readonly resumeById: boolean;
	readonly newSessionId: boolean;
	readonly workingDirectory: boolean;
	readonly readOnlyPolicy: boolean;
	readonly mutatingPolicy: boolean;
	/** The CLI accepts an invocation-only MCP config/override flag; this does not imply an exclusive server roster. */
	readonly invocationMcpConfig: boolean;
	/** The CLI can restrict MCP servers to the invocation config. Codex has no equivalent; Claude managed policy may reject strict config. */
	readonly exclusiveMcpRoster: boolean;
	/** Current profile selector env key. This is configuration metadata, not proof of account isolation. */
	readonly profileSelector: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR';
	readonly requiredPermissionModes: readonly string[];
}

export interface AgentCliProbeOptions {
	readonly provider: ProviderId;
	readonly executable: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
	/** Trusted standalone Node runtime required when discovery runs inside Electron. */
	readonly guardianNodeExecutable?: string;
	/** Packaged guardian script path required when discovery runs inside Electron. */
	readonly guardianScriptPath?: string;
}

/**
 * Reads only --version and --help from the selected CLI. It never starts a session, loads global
 * environment variables, or returns raw help/error output that might contain local credentials.
 */
export async function discoverAgentCliCapabilities(options: AgentCliProbeOptions): Promise<AgentCliCapabilities> {
	if (!options.executable.trim() || /[\u0000-\u001f\u007f]/.test(options.executable)) {
		throw new Error('The selected CLI executable path is invalid.');
	}
	const probeHome = mkdtempSync(join(tmpdir(), 'agent-cli-capabilities-'));
	let allProbesCompleted = false;
	try {
		const env = minimalProbeEnvironment(options.env ?? process.env, options.provider, probeHome);
		const timeoutMs = options.timeoutMs ?? AGENT_CLI_PROBE_TIMEOUT_MS;
		const versionOutput = await probe(options.executable, ['--version'], env, timeoutMs, options.guardianNodeExecutable, options.guardianScriptPath);
		const helpOutput = await probe(options.executable, ['--help'], env, timeoutMs, options.guardianNodeExecutable, options.guardianScriptPath);
		const resumeHelpOutput = options.provider === 'codex' ? await probe(options.executable, ['resume', '--help'], env, timeoutMs, options.guardianNodeExecutable, options.guardianScriptPath) : { stdout: '', stderr: '' };
		allProbesCompleted = true;
		const version = extractVersion(options.provider, `${versionOutput.stdout}\n${versionOutput.stderr}`);
		const help = `${helpOutput.stdout}\n${helpOutput.stderr}\n${resumeHelpOutput.stdout}\n${resumeHelpOutput.stderr}`;
		const has = (flag: string) => new RegExp(`(?:^|\\s)${escapeRegExp(flag)}(?:[\\s,=]|$)`, 'm').test(help);
		const common = {
			provider: options.provider,
			commandSpecVersion: AGENT_CLI_COMMAND_SPEC_VERSION,
			version,
			interactive: options.provider === 'codex' ? has('--no-daemon') : has('--resume'),
			model: has('--model') || has('-m'),
			resumeById: options.provider === 'codex' ? help.includes('SESSION_ID') || help.includes('resume <') : has('--resume'),
			newSessionId: options.provider === 'codex' || has('--session-id'),
			workingDirectory: options.provider === 'codex' ? has('--cd') || has('-C') : true,
			readOnlyPolicy: options.provider === 'codex' ? has('--sandbox') && has('--ask-for-approval') : has('--restricted') && has('--tools') && has('--permission-mode'),
			mutatingPolicy: options.provider === 'codex' ? has('--approve-for-me') : has('--permission-mode'),
			invocationMcpConfig: options.provider === 'codex' ? has('-c') || has('--config') : has('--mcp-config') && has('--strict-mcp-config'),
			exclusiveMcpRoster: options.provider === 'claude' && has('--mcp-config') && has('--strict-mcp-config'),
			profileSelector: options.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR',
			requiredPermissionModes: options.provider === 'codex' ? ['--approve-for-me', '--sandbox read-only'] : ['--restricted --tools Read,Glob,Grep', '--permission-mode acceptEdits'],
		} satisfies Omit<AgentCliCapabilities, 'version'> & { version: string };
		return Object.freeze({ ...common, version });
	} catch (error) {
		if (allProbesCompleted || (error instanceof Error && error.name === 'AgentCliProcessError' && 'cleanupVerified' in error && error.cleanupVerified === true)) {
			throw new AgentSessionPreparationError(error instanceof Error ? error.message : String(error), true);
		}
		throw error;
	} finally {
		rmSync(probeHome, { recursive: true, force: true });
	}
}

function minimalProbeEnvironment(source: NodeJS.ProcessEnv, provider: ProviderId, isolatedProfileDirectory: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { PATH: source.PATH ?? '', LANG: source.LANG ?? 'C.UTF-8', LC_ALL: source.LC_ALL ?? 'C.UTF-8' };
	for (const key of ['TMPDIR', 'TEMP', 'SystemRoot']) {
		if (source[key] !== undefined) { env[key] = source[key]; }
	}
	if (provider === 'codex') { env.CODEX_HOME = isolatedProfileDirectory; }
	if (provider === 'claude') { env.CLAUDE_CONFIG_DIR = isolatedProfileDirectory; }
	return env;
}

function probe(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number, guardianNodeExecutable?: string, guardianScriptPath?: string): Promise<{ stdout: string; stderr: string }> {
	return runBoundedAgentCliProcess(executable, args, { env, timeoutMs, maxOutputBytes: MAX_PROBE_OUTPUT_BYTES, guardianNodeExecutable, guardianScriptPath });
}

function extractVersion(_provider: ProviderId, output: string): string {
	const match = /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/.exec(output);
	if (!match) { throw new Error('The selected CLI did not report a recognizable version.'); }
	return match[1];
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
