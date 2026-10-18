/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { AgentSessionProvider, WorkspaceAgentSessionWorkspacePreparationDTO } from '../../common/workspaceAgentSessionProtocol.js';
import { AGENT_CLI_COMMAND_SPEC_VERSION, discoverAgentCliCapabilities, type AgentCliCapabilities } from './agentCliCapabilities.js';
import { AgentSessionCollaborationService } from './agentSessionCollaborationService.js';
import { createAgentSessionCommand } from './agentSessionCommands.js';
import { AgentSessionMcpBridge, AGENT_SESSION_MCP_GATEWAY_MODULE, AGENT_SESSION_MCP_TOKEN_ENV } from './agentSessionMcpBridge.js';
import { AgentSessionPtyRuntimeFactory } from './agentSessionPtyRuntime.js';
import { AgentSessionPreparationError } from './agentSessionPreparationError.js';
import { AgentSessionJournal } from './agentSessionJournal.js';
import { AgentCliProcessError } from './agentCliProcess.js';
import { AgentSessionService } from './agentSessionService.js';
import { AgentSessionWorkspaceResolver } from './agentSessionWorkspace.js';
import { ManagedWorktreeService } from './managedWorktrees.js';
import { OwnerOperationCoordinator } from './ownerOperationCoordinator.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';
import type { TaskFolderWriterLock } from '../providerRuns/taskFolderWriterLock.js';

const PROFILE_REFS = new Set(['local-primary', 'local-default-codex', 'local-default-claude']);
export interface AgentSessionRuntimePaths {
	readonly standaloneNode: string;
	readonly guardian: string;
	readonly cliProbeGuardian: string;
	readonly mcpGateway: string;
}

/** Owns the real app services behind the validated project-window session IPC. */
export class AgentSessionApplication {
	readonly collaboration: AgentSessionCollaborationService;
	readonly mcpBridge: AgentSessionMcpBridge;
	readonly workspaceResolver: AgentSessionWorkspaceResolver;
	readonly service: AgentSessionService;
	private recoveryReady = false;
	private readonly worktrees: ManagedWorktreeService;
	private readonly workspacePreparationLocks = new OwnerOperationCoordinator();

	constructor(
		private readonly database: WorkspaceDatabase,
		worktreeProfileDirectory: string,
		writerLock: TaskFolderWriterLock,
		private readonly resourcesPath: string,
	) {
		this.worktrees = new ManagedWorktreeService(worktreeProfileDirectory);
		this.collaboration = new AgentSessionCollaborationService(database);
		this.mcpBridge = new AgentSessionMcpBridge(this.collaboration);
		this.workspaceResolver = new AgentSessionWorkspaceResolver(database, this.worktrees, writerLock, () => this.recoveryReady);
		this.service = new AgentSessionService(database, this.workspaceResolver, new AgentSessionPtyRuntimeFactory({
			guardianNodeExecutable: this.runtimePaths().standaloneNode,
			guardianScriptPath: this.runtimePaths().guardian,
			prepareLaunch: (snapshot, turnId, signal) => this.prepareLaunch(snapshot, turnId, signal),
			createJournal: (snapshot, turnId, knownSecrets) => new AgentSessionJournal(database.agentSessionTranscripts, snapshot, turnId, knownSecrets),
		}));
		this.service.recoverStartup();
		this.recoveryReady = true;
	}

	normalizeProfileRef(provider: AgentSessionProvider, profileRef: string | undefined): string {
		const normalized = profileRef?.trim() || (provider === 'codex' ? 'local-default-codex' : 'local-default-claude');
		if (!PROFILE_REFS.has(normalized)) { throw new Error('Only the selected provider local profile is supported.'); }
		if (normalized === 'local-primary') { return provider === 'codex' ? 'local-default-codex' : 'local-default-claude'; }
		if (normalized !== `local-default-${provider}`) { throw new Error('The saved local profile does not match this provider.'); }
		return normalized;
	}

	async prepareCreatedSession(projectId: string, sessionId: string): Promise<WorkspaceAgentSessionWorkspacePreparationDTO> {
		return this.prepareWorkspace(projectId, sessionId);
	}

	async workspacePreparation(projectId: string, sessionId: string): Promise<WorkspaceAgentSessionWorkspacePreparationDTO> {
		const session = this.database.agentSessions.getSession(projectId, sessionId);
		if (!session) { throw new Error('The created session could not be reloaded for workspace preparation.'); }
		return this.workspacePreparationLocks.run(sessionId, () => this.inspectWorkspacePreparation(session));
	}

	async prepareWorkspace(projectId: string, sessionId: string): Promise<WorkspaceAgentSessionWorkspacePreparationDTO> {
		const session = this.database.agentSessions.getSession(projectId, sessionId);
		if (!session) { throw new Error('The session does not belong to this project.'); }
		return this.workspacePreparationLocks.run(sessionId, async () => {
			const current = await this.inspectWorkspacePreparation(session);
			if (current.state !== 'needsPreparation' || session.workspaceMode !== 'gitWorktree') { return current; }
			const binding = this.database.listFolderBindings(session.projectId).find(candidate => candidate.id === session.bindingId);
			if (!binding || binding.vcsKind !== 'git' || !binding.vcsRoot) {
				return { ...current, state: 'recoveryRequired', reason: 'The persisted Git repository binding is unavailable.' };
			}
			try {
				await this.worktrees.create({ repositoryPath: binding.vcsRoot, ownerId: session.id, kind: 'session', baseRef: 'HEAD' });
			} catch (error) {
				const afterFailure = await this.inspectWorkspacePreparation(session);
				if (afterFailure.state === 'ready') { return afterFailure; }
				if (afterFailure.state === 'needsPreparation') { return { ...afterFailure, reason: errorMessage(error) }; }
				return { ...afterFailure, reason: [afterFailure.reason, errorMessage(error)].filter(Boolean).join(' ') };
			}
			return this.inspectWorkspacePreparation(session);
		});
	}

	async shutdown(): Promise<void> {
		const receipts = await this.service.shutdown();
		const unverified = receipts.filter(receipt => !receipt.cleanupVerified);
		if (unverified.length) { throw new Error(`Session shutdown left ${unverified.length} owned turn cleanup(s) unverified.`); }
	}

	private runtimePaths(): AgentSessionRuntimePaths {
		const appRoot = join(this.resourcesPath, 'app');
		return {
			standaloneNode: join(appRoot, 'review-runtime', 'bin', 'node'),
			guardian: join(appRoot, 'out', 'vs', 'workspace', 'electron-main', 'agentSessions', 'pty', 'agentPtyGuardian.mjs'),
			cliProbeGuardian: join(appRoot, 'out', 'vs', 'workspace', 'electron-main', 'agentSessions', 'agentCliProbeGuardian.mjs'),
			mcpGateway: join(appRoot, 'out', 'vs', 'workspace', 'electron-main', 'agentSessions', AGENT_SESSION_MCP_GATEWAY_MODULE),
		};
	}

	private async inspectWorkspacePreparation(session: { readonly projectId: string; readonly id: string; readonly bindingId: string; readonly workspaceMode: 'gitWorktree' | 'sharedFolder' }): Promise<WorkspaceAgentSessionWorkspacePreparationDTO> {
		if (session.workspaceMode === 'sharedFolder') {
			const binding = this.database.listFolderBindings(session.projectId).find(candidate => candidate.id === session.bindingId);
			return { projectId: session.projectId, sessionId: session.id, workspaceMode: session.workspaceMode, state: binding ? 'ready' : 'recoveryRequired', worktreePath: binding?.path ?? null, branch: null, reason: binding ? null : 'The persisted shared-folder binding is unavailable.' };
		}
		const binding = this.database.listFolderBindings(session.projectId).find(candidate => candidate.id === session.bindingId);
		const expected = this.worktrees.expectedLocation(session.id, 'session');
		if (!binding || binding.vcsKind !== 'git' || !binding.vcsRoot) {
			return { projectId: session.projectId, sessionId: session.id, workspaceMode: session.workspaceMode, state: 'recoveryRequired', ...expected, reason: 'The persisted Git repository binding is unavailable.' };
		}
		try {
			const lease = await this.worktrees.inspectOptional(session.id, binding.vcsRoot);
			if (!lease) {
				return { projectId: session.projectId, sessionId: session.id, workspaceMode: session.workspaceMode, state: 'needsPreparation', ...expected, reason: null };
			}
			if (lease.kind !== 'session' || lease.state !== 'active' || lease.repositoryPath !== realpathSync(binding.vcsRoot)
				|| lease.worktreePath !== expected.worktreePath || lease.branch !== expected.branch) {
				return { projectId: session.projectId, sessionId: session.id, workspaceMode: session.workspaceMode, state: 'recoveryRequired', worktreePath: lease.worktreePath, branch: lease.branch, reason: `The signed session worktree is ${lease.state} and requires explicit recovery.` };
			}
			return { projectId: session.projectId, sessionId: session.id, workspaceMode: session.workspaceMode, state: 'ready', worktreePath: lease.worktreePath, branch: lease.branch, reason: null };
		} catch (error) {
			return { projectId: session.projectId, sessionId: session.id, workspaceMode: session.workspaceMode, state: 'recoveryRequired', ...expected, reason: errorMessage(error) };
		}
	}

	private async prepareLaunch(snapshot: Parameters<AgentSessionPtyRuntimeFactory['start']>[0], turnId: string, signal: AbortSignal) {
		const trusted = (() => {
			try {
				if (signal.aborted) { throw new Error('The session launch was cancelled before preparation.'); }
				const paths = this.runtimePaths();
				assertExecutable(paths.standaloneNode, 'The packaged standalone Node runtime');
				assertReadable(paths.guardian, 'The packaged PTY guardian');
				assertReadable(paths.cliProbeGuardian, 'The packaged CLI probe guardian');
				assertReadable(paths.mcpGateway, 'The packaged session MCP gateway');
				const profileRef = this.normalizeProfileRef(snapshot.provider, snapshot.profileRef ?? undefined);
				if (profileRef !== snapshot.profileRef) { throw new Error('The saved session profile reference is not normalized for its provider.'); }
				const profileDirectory = join(userInfo().homedir || homedir(), snapshot.provider === 'codex' ? '.codex' : '.claude');
				assertDirectory(profileDirectory, 'The selected local provider profile');
				const executable = resolveProviderCli(snapshot.provider, userInfo().homedir || homedir());
				const runtimeEnv = buildLaunchEnvironment(snapshot.provider, profileDirectory, dirname(paths.standaloneNode), dirname(executable));
				return { paths, profileRef, profileDirectory, executable, runtimeEnv };
			} catch (error) { throw new AgentSessionPreparationError(errorMessage(error), true); }
		})();
		let capabilities: AgentCliCapabilities;
		try {
			capabilities = await discoverAgentCliCapabilities({
				provider: snapshot.provider, executable: trusted.executable, env: trusted.runtimeEnv,
				guardianNodeExecutable: trusted.paths.standaloneNode, guardianScriptPath: trusted.paths.cliProbeGuardian,
			});
		} catch (error) {
			if (error instanceof AgentCliProcessError && error.cleanupVerified) { throw new AgentSessionPreparationError(error.message, true); }
			throw error;
		}
		const { paths, profileRef, profileDirectory, executable, runtimeEnv } = trusted;
		if (signal.aborted) { throw new AgentSessionPreparationError('The session launch was cancelled while checking the selected CLI.', true); }
		let access: Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>> | undefined;
		let privateDirectory: string | undefined;
		let configPath: string | undefined;
		let accessRevoked = false;
		let bridgeConfigReleased = false;
		let configFileRemoved = false;
		let privateDirectoryRemoved = false;
		const revokeAccess = () => {
			if (!access || accessRevoked) { return; }
			access.revokeAccess();
			accessRevoked = true;
		};
		const releasePrivateConfig = async () => {
			const failures: unknown[] = [];
			if (configPath && !configFileRemoved) {
				try { await import('node:fs/promises').then(fs => fs.unlink(configPath!)); configFileRemoved = true; }
				catch (error) { if (hasErrorCode(error, 'ENOENT')) { configFileRemoved = true; } else { failures.push(error); } }
			}
			if (privateDirectory && !privateDirectoryRemoved) {
				try { await import('node:fs/promises').then(fs => fs.rmdir(privateDirectory!)); privateDirectoryRemoved = true; }
				catch (error) { if (hasErrorCode(error, 'ENOENT')) { privateDirectoryRemoved = true; } else { failures.push(error); } }
			}
			if (access && !bridgeConfigReleased) {
				try { await access.releasePrivateConfig(); bridgeConfigReleased = true; } catch (error) { failures.push(error); }
			}
			if (failures.length) { throw new AggregateError(failures, 'Private session launch resources could not be released.'); }
		};
		try {
			access = await this.mcpBridge.issueAccess({
				projectId: snapshot.projectId, sessionId: snapshot.sessionId, turnId,
				permissionPolicy: snapshot.permissionPolicy,
			});
			if (signal.aborted) { throw new Error('The session launch was cancelled while creating its MCP capability.'); }
			const gateway = { name: 'bugfixer-session' as const, command: paths.standaloneNode, args: [paths.mcpGateway, ...access.gatewayArguments], envVariables: [AGENT_SESSION_MCP_TOKEN_ENV] };
			if (snapshot.provider === 'claude') {
				privateDirectory = mkdtempSync(join(tmpdir(), 'bugfixer-session-config-'));
				configPath = join(privateDirectory, `claude-${turnId}.json`);
				writeFileSync(configPath, JSON.stringify({ mcpServers: { 'bugfixer-session': {
					command: paths.standaloneNode,
					args: [paths.mcpGateway, ...access.gatewayArguments],
					env: { [AGENT_SESSION_MCP_TOKEN_ENV]: '$' + `{${AGENT_SESSION_MCP_TOKEN_ENV}}` },
				} } }), { mode: 0o600, flag: 'wx' });
			}
			const command = createAgentSessionCommand({
				provider: snapshot.provider, commandSpecVersion: AGENT_CLI_COMMAND_SPEC_VERSION, capabilities,
				executable, model: snapshot.model, profileRef, profileDirectory, cwd: snapshot.cwd, sessionId: snapshot.sessionId,
				permissionPolicy: snapshot.permissionPolicy, mcpServer: gateway,
				...(configPath ? { claudeMcpConfigPath: configPath } : {}),
				profileEnvironment: { [snapshot.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: profileDirectory },
			});
			if (signal.aborted) { throw new Error('The session launch was cancelled before PTY creation.'); }
			const launchEnv: Record<string, string> = { ...command.env, ...runtimeEnv, ...access.gatewayEnvironment };
			return {
				command, permissionPolicy: snapshot.permissionPolicy, profileDirectory,
				launch: { executable: command.executable, args: command.args, cwd: command.cwd, env: launchEnv, cols: 100, rows: 30 },
				knownSecrets: access.knownSecrets,
				revokeAccess,
				releasePrivateConfig,
			};
		} catch (error) {
			const preparationFailure = error instanceof AgentSessionPreparationError ? error : undefined;
			const revokeAllAccess = () => {
				revokeAccess();
				preparationFailure?.recovery?.revokeAccess();
			};
			const releaseAllPrivateConfig = async () => {
				await releasePrivateConfig();
				await preparationFailure?.recovery?.releasePrivateConfig();
			};
			const failures: unknown[] = [];
			try { revokeAllAccess(); } catch (cleanupError) { failures.push(cleanupError); }
			if (!access || accessRevoked) { try { await releaseAllPrivateConfig(); } catch (cleanupError) { failures.push(cleanupError); } }
			if (failures.length) {
				throw new AgentSessionPreparationError(
					new AggregateError([error, ...failures], 'Session launch preparation failed and its private resources could not be fully released.').message,
					false,
					{ revokeAccess: revokeAllAccess, releasePrivateConfig: releaseAllPrivateConfig },
				);
			}
			throw new AgentSessionPreparationError(errorMessage(error), true);
		}
	}
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function resolveProviderCli(provider: AgentSessionProvider, home: string): string {
	const name = provider === 'codex' ? 'codex' : 'claude';
	const candidates = [
		join(home, '.local', 'bin', name), join(home, '.npm-global', 'bin', name),
		join(home, '.volta', 'bin', name), join(home, '.bun', 'bin', name), join(home, '.yarn', 'bin', name),
		'/opt/homebrew/bin/' + name, '/usr/local/bin/' + name,
	];
	const nvmVersions = join(home, '.nvm', 'versions', 'node');
	if (existsSync(nvmVersions)) {
		for (const version of readdirSync(nvmVersions).sort().reverse()) { candidates.push(join(nvmVersions, version, 'bin', name)); }
	}
	for (const candidate of candidates) {
		if (!existsSync(candidate)) { continue; }
		const canonical = realpathSync(candidate);
		accessSync(canonical, constants.X_OK);
		const firstLine = readFileSync(canonical).subarray(0, 256).toString('utf8').split(/\r?\n/, 1)[0];
		if (firstLine.startsWith('#!') && !/^#!\s*\/usr\/bin\/env\s+node(?:\s|$)/.test(firstLine) && !/^#!\s*\/[^\s]*node(?:\s|$)/.test(firstLine)) {
			throw new Error(`The installed ${provider} CLI uses an unsupported script launcher.`);
		}
		return canonical;
	}
	throw new Error(`An executable ${provider} CLI was not found in the supported local macOS locations.`);
}

function buildLaunchEnvironment(provider: AgentSessionProvider, profileDirectory: string, nodeDirectory: string, cliDirectory: string): Record<string, string> {
	const home = userInfo().homedir || homedir();
	const env: Record<string, string> = {
		PATH: [nodeDirectory, cliDirectory, '/usr/bin', '/bin'].join(delimiter),
		HOME: home,
		TMPDIR: realpathSync(tmpdir()),
		LANG: process.env.LANG || 'C.UTF-8',
		LC_ALL: process.env.LC_ALL || 'C.UTF-8',
		USER: userInfo().username,
		LOGNAME: userInfo().username,
		[snapshotProfileKey(provider)]: profileDirectory,
	};
	for (const key of Object.keys(env)) {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof env[key] !== 'string' || /[\u0000\r\n]/.test(env[key])) { throw new Error('The trusted provider launch environment is invalid.'); }
	}
	return env;
}

function snapshotProfileKey(provider: AgentSessionProvider): string { return provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'; }

function assertExecutable(path: string, name: string): void {
	try { accessSync(path, constants.X_OK); if (realpathSync(path) !== path) { throw new Error(); } }
	catch { throw new Error(`${name} is unavailable at its required packaged path.`); }
}

function assertReadable(path: string, name: string): void {
	try { accessSync(path, constants.R_OK); if (realpathSync(path) !== path) { throw new Error(); } }
	catch { throw new Error(`${name} is unavailable at its required packaged path.`); }
}

function assertDirectory(path: string, name: string): void {
	try { if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) { throw new Error(); } }
	catch { throw new Error(`${name} is unavailable or is not a canonical directory.`); }
}
