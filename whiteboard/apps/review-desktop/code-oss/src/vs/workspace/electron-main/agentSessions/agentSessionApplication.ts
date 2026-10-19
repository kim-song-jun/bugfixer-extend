/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { AgentSessionProvider, AgentSessionTurnDTO, WorkspaceAgentSessionWorkspacePreparationDTO } from '../../common/workspaceAgentSessionProtocol.js';
import { AGENT_CLI_COMMAND_SPEC_VERSION, discoverAgentCliCapabilities, type AgentCliCapabilities } from './agentCliCapabilities.js';
import { AgentSessionCollaborationService } from './agentSessionCollaborationService.js';
import { createAgentSessionCommand } from './agentSessionCommands.js';
import { AGENT_PROVIDER_IDENTITY_PORT_ENV, AGENT_PROVIDER_IDENTITY_NONCE_ENV, AgentProviderIdentityReceiver, type AgentProviderIdentityAccess } from './agentProviderIdentity.js';
import { AgentSessionMcpBridge, AGENT_SESSION_MCP_GATEWAY_MODULE, AGENT_SESSION_MCP_TOKEN_ENV } from './agentSessionMcpBridge.js';
import { AgentSessionPtyRuntimeFactory } from './agentSessionPtyRuntime.js';
import { AgentSessionPreparationError } from './agentSessionPreparationError.js';
import { AgentSessionJournal } from './agentSessionJournal.js';
import { AgentCliProcessError } from './agentCliProcess.js';
import { AgentSessionService } from './agentSessionService.js';
import { AgentSessionControlApplication } from './agentSessionControlApplication.js';
import { AgentSessionCommitApplication } from './agentSessionCommitApplication.js';
import { AgentSessionMergeApplication } from './agentSessionMergeApplication.js';
import { AgentSessionPublicationApplication } from './agentSessionPublicationApplication.js';
import { AgentSessionPrTextApplication } from './agentSessionPrTextApplication.js';
import { createAgentSessionPrTextResolver } from './agentSessionPrTextEnvironment.js';
import { inspectWorkspaceAgentSetup } from './agentSessionSetupInspection.js';
import type { WorkspaceAgentSetupInspectionDTO } from '../../common/workspaceAgentSetupProtocol.js';
import { AgentSessionContentCaptureCleanupError, captureAgentSessionContentSnapshot, type AgentSessionContentSnapshot } from './agentSessionContentCapture.js';
import { AgentWorkflowScheduler } from './agentWorkflowScheduler.js';
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
	readonly providerIdentityHook: string;
}

/** Owns the real app services behind the validated project-window session IPC. */
export class AgentSessionApplication {
	readonly collaboration: AgentSessionCollaborationService;
	readonly mcpBridge: AgentSessionMcpBridge;
	private readonly providerIdentityReceiver: AgentProviderIdentityReceiver;
	readonly workspaceResolver: AgentSessionWorkspaceResolver;
	readonly service: AgentSessionService;
	readonly controlApplication: AgentSessionControlApplication;
	readonly commitApplication: AgentSessionCommitApplication;
	readonly mergeApplication: AgentSessionMergeApplication;
	readonly publicationApplication: AgentSessionPublicationApplication;
	readonly prTextApplication: AgentSessionPrTextApplication;
	readonly prTextReady: Promise<void>;
	readonly workflowScheduler: AgentWorkflowScheduler;
	private recoveryReady = false;
	private setupClosing = false;
	private setupInspectionRequest: Promise<WorkspaceAgentSetupInspectionDTO> | undefined;
	private setupCleanupFailure: AgentCliProcessError | undefined;
	private readonly worktrees: ManagedWorktreeService;
	private readonly workspacePreparationLocks = new OwnerOperationCoordinator();
	/** Reserve at most eight capture slots; a failed DB write retains the exact captured bytes for retry. */
	private readonly pendingFinalContents = new Map<string, { captured?: { readonly snapshot: AgentSessionContentSnapshot; readonly revision: string | null; readonly expectedLatestVersion: number } }>();

	constructor(
		private readonly database: WorkspaceDatabase,
		worktreeProfileDirectory: string,
		writerLock: TaskFolderWriterLock,
		private readonly resourcesPath: string,
	) {
		this.worktrees = new ManagedWorktreeService(worktreeProfileDirectory);
		let workflowScheduler: AgentWorkflowScheduler | undefined;
		this.collaboration = new AgentSessionCollaborationService(database, {
			cancel: (projectId, workflowId, expectedRevision, idempotencyKey) => {
				if (!workflowScheduler) { throw new Error('Workflow cancellation is unavailable while the host is initializing.'); }
				return workflowScheduler.cancel(projectId, workflowId, expectedRevision, idempotencyKey);
			},
			getHostError: (projectId, workflowId, runId) => workflowScheduler?.getHostError(projectId, workflowId, runId) ?? null,
		}, {
			queueStop: request => {
				if (!this.recoveryReady) { throw new Error('Session control is unavailable while the host is initializing.'); }
				this.controlApplication.queueStop(request);
			},
		});
		this.mcpBridge = new AgentSessionMcpBridge(this.collaboration, undefined, database);
		this.providerIdentityReceiver = new AgentProviderIdentityReceiver(database);
		this.workspaceResolver = new AgentSessionWorkspaceResolver(database, this.worktrees, writerLock, () => this.recoveryReady, turn => this.service.ownsRunningReadOnlyTurn(turn));
		this.service = new AgentSessionService(database, this.workspaceResolver, new AgentSessionPtyRuntimeFactory({
			guardianNodeExecutable: this.runtimePaths().standaloneNode,
			guardianScriptPath: this.runtimePaths().guardian,
			prepareLaunch: (snapshot, turnId, signal) => this.prepareLaunch(snapshot, turnId, signal),
			createJournal: (snapshot, turnId, knownSecrets) => new AgentSessionJournal(database.agentSessionTranscripts, snapshot, turnId, knownSecrets),
		}), {
			beforeStart: async (turn, signal) => {
				if (this.pendingFinalContents.size >= 8) { throw new Error('8개 세션의 실행·변경 기록을 처리 중입니다. 종료 또는 저장 재시도 후 다시 시작해 주세요.'); }
				this.pendingFinalContents.set(turn.id, {});
				const captured = await this.captureTurnContent(turn, signal);
				database.agentSessionContents.recordBaseline({ scope: this.contentScope(turn), ...captured });
			},
			afterCleanup: (turn, context) => this.recordFinalContent(turn, context.cleanupVerified),
		});
		this.service.recoverStartup();
		this.controlApplication = new AgentSessionControlApplication(database, this.service);
		this.controlApplication.recoverStartup();
		database.agentSessionContents.reconcileInterruptedCaptures();
		this.commitApplication = new AgentSessionCommitApplication(database, this.worktrees, this.workspaceResolver, this.service);
		this.mergeApplication = new AgentSessionMergeApplication(database, this.worktrees, database.agentSessionMerges, this.workspaceResolver, this.service);
		this.publicationApplication = new AgentSessionPublicationApplication(database, this.worktrees, worktreeProfileDirectory, this.resourcesPath);
		this.prTextApplication = new AgentSessionPrTextApplication(database, createAgentSessionPrTextResolver({
			database, resourcesPath: this.resourcesPath,
			homeDirectory: () => userInfo().homedir || homedir(),
			runtimePaths: () => this.runtimePaths(),
			normalizeProfileRef: (provider, profileRef) => this.normalizeProfileRef(provider, profileRef),
			resolveExecutable: (provider, home) => resolveProviderCli(provider, home),
			buildLaunchEnvironment,
			verifyWorkspace: async (session, turn) => {
				const binding = database.listFolderBindings(session.projectId).find(candidate => candidate.id === session.bindingId);
				if (!binding) { throw new Error('The persisted session folder binding is unavailable.'); }
				if (session.workspaceMode === 'sharedFolder') {
					if (turn.snapshot.managedWorktreeOwnerId !== null || realpathSync(binding.path) !== turn.snapshot.folderIdentity.canonicalPath) {
						throw new Error('The completed turn no longer matches its bound shared folder.');
					}
					return;
				}
				if (turn.snapshot.managedWorktreeOwnerId !== session.id || !binding.vcsRoot) { throw new Error('The completed turn has no session-owned worktree binding.'); }
				const preparation = await this.inspectWorkspacePreparation(session);
				if (preparation.state !== 'ready' || preparation.worktreePath !== turn.snapshot.folderIdentity.canonicalPath) {
					throw new Error('The session-owned worktree is not the selected completed turn folder.');
				}
			},
		}));
		this.prTextReady = this.prTextApplication.initialize();
		workflowScheduler = this.workflowScheduler = new AgentWorkflowScheduler(database, this.service);
		this.recoveryReady = true;
	}

	normalizeProfileRef(provider: AgentSessionProvider, profileRef: string | undefined): string {
		const normalized = profileRef?.trim() || (provider === 'codex' ? 'local-default-codex' : 'local-default-claude');
		if (!PROFILE_REFS.has(normalized)) { throw new Error('Only the selected provider local profile is supported.'); }
		if (normalized === 'local-primary') { return provider === 'codex' ? 'local-default-codex' : 'local-default-claude'; }
		if (normalized !== `local-default-${provider}`) { throw new Error('The saved local profile does not match this provider.'); }
		return normalized;
	}

	async inspectSetup(projectId: string, provider: AgentSessionProvider, assertCurrent: () => void): Promise<WorkspaceAgentSetupInspectionDTO> {
		assertCurrent();
		if (!this.database.getProject(projectId)) { throw new Error('Setup inspection project is unavailable.'); }
		if (this.setupClosing) { throw new Error('The setup inspection host is closing.'); }
		if (this.setupCleanupFailure) { throw this.setupCleanupFailure; }
		if (this.setupInspectionRequest) { throw new Error('A provider setup inspection is already running.'); }
		const paths = this.runtimePaths();
		assertExecutable(paths.standaloneNode, 'The packaged standalone Node runtime');
		assertReadable(paths.cliProbeGuardian, 'The packaged CLI probe guardian');
		const home = userInfo().homedir || homedir();
		const executable = findProviderCli(provider, home);
		const profileDirectory = join(home, provider === 'codex' ? '.codex' : '.claude');
		const request = inspectWorkspaceAgentSetup({ projectId, provider, executable, profileDirectory,
			environment: buildLaunchEnvironment(provider, profileDirectory, dirname(paths.standaloneNode), executable ? dirname(executable) : dirname(paths.standaloneNode)),
			guardianNodeExecutable: paths.standaloneNode, guardianScriptPath: paths.cliProbeGuardian });
		this.setupInspectionRequest = request;
		try {
			const result = await request;
			assertCurrent();
			if (this.setupClosing) { throw new Error('The setup inspection host is closing.'); }
			return result;
		} catch (error) {
			if (error instanceof AgentCliProcessError && !error.cleanupVerified) { this.setupCleanupFailure = error; }
			throw error;
		} finally { if (this.setupInspectionRequest === request) { this.setupInspectionRequest = undefined; } }
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
		this.setupClosing = true;
		const setupDrain = this.setupInspectionRequest ? Promise.allSettled([this.setupInspectionRequest]) : undefined;
		const failures: unknown[] = [];
		const independentDrains = await Promise.allSettled([
			Promise.resolve().then(() => this.publicationApplication.shutdown()),
			Promise.resolve().then(() => this.prTextApplication.shutdown()),
			Promise.resolve().then(() => this.controlApplication.shutdown()),
		]);
		for (const result of independentDrains) { if (result.status === 'rejected') { failures.push(result.reason); } }
		try { this.workflowScheduler.stopScheduling(); } catch (error) { failures.push(error); }
		try { this.workflowScheduler.requestShutdownCancellation(); } catch (error) { failures.push(error); }
		try {
			const receipts = await this.service.shutdown();
			const unverified = receipts.filter(receipt => !receipt.cleanupVerified);
			if (unverified.length) { failures.push(new Error(`Session shutdown left ${unverified.length} owned turn cleanup(s) unverified.`)); }
		} catch (error) { failures.push(error); }
		try { this.workflowScheduler.reconcileAfterShutdown(); } catch (error) { failures.push(error); }
		try { await setupDrain; } catch (error) { failures.push(error); }
		if (this.setupCleanupFailure) { failures.push(this.setupCleanupFailure); }
		if (failures.length) { throw new AggregateError(failures, 'Agent session shutdown did not verify cleanup.'); }
	}

	private runtimePaths(): AgentSessionRuntimePaths {
		const appRoot = join(this.resourcesPath, 'app');
		return {
			standaloneNode: join(appRoot, 'review-runtime', 'bin', 'node'),
			guardian: join(appRoot, 'out', 'vs', 'workspace', 'electron-main', 'agentSessions', 'pty', 'agentPtyGuardian.mjs'),
			cliProbeGuardian: join(appRoot, 'out', 'vs', 'workspace', 'electron-main', 'agentSessions', 'agentCliProbeGuardian.mjs'),
			mcpGateway: join(appRoot, 'out', 'vs', 'workspace', 'electron-main', 'agentSessions', AGENT_SESSION_MCP_GATEWAY_MODULE),
			providerIdentityHook: join(appRoot, 'out', 'vs', 'workspace', 'electron-main', 'agentSessions', 'agentProviderIdentityHook.mjs'),
		};
	}

	private contentScope(turn: AgentSessionTurnDTO) {
		return { projectId: turn.projectId, sessionId: turn.sessionId, turnId: turn.id };
	}

	private async captureTurnContent(turn: AgentSessionTurnDTO, signal: AbortSignal): Promise<{ readonly snapshot: AgentSessionContentSnapshot; readonly revision: string | null }> {
		const revision = await this.contentRevision(turn);
		if (signal.aborted) { throw new Error('파일 내용 수집이 취소됐습니다.'); }
		const helper = join(this.resourcesPath, 'app', 'review-runtime', 'bin', 'bound-checkout');
		assertExecutable(helper, 'The packaged bound-checkout helper');
		const snapshot = await captureAgentSessionContentSnapshot(helper, turn.snapshot.folderIdentity, { signal, timeoutMs: 30_000 });
		if (signal.aborted) { throw new Error('파일 내용 수집이 취소됐습니다.'); }
		if (await this.contentRevision(turn) !== revision) { throw new Error('파일 내용을 수집하는 동안 Git 기준 커밋이 바뀌었습니다.'); }
		return { snapshot, revision };
	}

	private async contentRevision(turn: AgentSessionTurnDTO): Promise<string | null> {
		const ownerId = turn.snapshot.managedWorktreeOwnerId;
		if (ownerId === null) { return null; }
		const binding = this.database.listFolderBindings(turn.projectId).find(candidate => candidate.id === turn.snapshot.bindingId);
		if (!binding?.vcsRoot) { throw new Error('세션 작업 복사본의 저장소 연결을 확인할 수 없습니다.'); }
		const lease = await this.worktrees.inspectOptional(ownerId, binding.vcsRoot);
		if (!lease || lease.kind !== 'session' || lease.state !== 'active' || lease.pendingOperation
			|| lease.worktreePath !== turn.snapshot.folderIdentity.canonicalPath) {
			throw new Error('세션 작업 복사본의 소유권과 Git 기준 커밋을 확인할 수 없습니다.');
		}
		return lease.head;
	}

	private async recordFinalContent(turn: AgentSessionTurnDTO, cleanupVerified: boolean): Promise<void> {
		const scope = this.contentScope(turn);
		const expectedLatestVersion = this.database.agentSessionChangeEvidence.getLatest(turn.projectId, turn.sessionId, turn.id)?.version ?? 0;
		const recordUnavailable = (reason: string) => this.database.agentSessionContents.recordUnavailable({
			scope, expectedLatestVersion, capturedAt: new Date().toISOString(), reason,
		});
		if (!cleanupVerified) {
			recordUnavailable('실행 프로세스 정리가 확인되지 않아 종료 후 파일 내용을 확정하지 않았습니다.');
			return;
		}
		if (!this.database.agentSessionContents.getBaseline(scope)) {
			recordUnavailable('실행 전 파일 내용이 저장되지 않아 변경 전후를 비교할 수 없습니다.');
			this.pendingFinalContents.delete(turn.id);
			return;
		}
		const pending = this.pendingFinalContents.get(turn.id);
		if (!pending) {
			recordUnavailable('종료 시점의 파일 내용을 보유하고 있지 않습니다. 현재 파일을 이전 실행의 결과로 대체하지 않았습니다.');
			return;
		}
		let captured = pending.captured;
		if (!captured) {
			try { captured = { ...await this.captureTurnContent(turn, new AbortController().signal), expectedLatestVersion }; }
			catch (error) {
				// A capture failure is durable missing evidence; current files are never substituted for old bytes.
				if (error instanceof AgentSessionContentCaptureCleanupError) { throw error; }
				recordUnavailable('실행 종료 후 파일 내용을 안전하게 수집하지 못했습니다. 이 기록으로 변경 내용을 확정할 수 없습니다.');
				this.pendingFinalContents.delete(turn.id);
				return;
			}
			pending.captured = captured;
		}
		this.database.agentSessionContents.recordAfter({ scope, ...captured, cleanupVerified: true });
		this.pendingFinalContents.delete(turn.id);
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
				if (snapshot.provider === 'codex') { assertReadable(paths.providerIdentityHook, 'The packaged Codex provider identity hook'); }
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
		let identityAccess: AgentProviderIdentityAccess | undefined;
		let privateDirectory: string | undefined;
		let configPath: string | undefined;
		let accessRevoked = false;
		let bridgeConfigReleased = false;
		let configFileRemoved = false;
		let privateDirectoryRemoved = false;
		const revokeAccess = () => {
			const failures: unknown[] = [];
			if (access && !accessRevoked) {
				try { access.revokeAccess(); accessRevoked = true; } catch (error) { failures.push(error); }
			}
			if (identityAccess) {
				try { identityAccess.revokeAccess(); } catch (error) { failures.push(error); }
			}
			if (failures.length) { throw new AggregateError(failures, 'Session launch access revocation could not be verified.'); }
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
			if (identityAccess) {
				try { await identityAccess.releasePrivateConfig(); } catch (error) { failures.push(error); }
			}
			if (failures.length) { throw new AggregateError(failures, 'Private session launch resources could not be released.'); }
		};
		try {
			access = await this.mcpBridge.issueAccess({
				projectId: snapshot.projectId, sessionId: snapshot.sessionId, turnId,
				permissionPolicy: snapshot.permissionPolicy,
			});
			if (signal.aborted) { throw new Error('The session launch was cancelled while creating its MCP capability.'); }
			const gateway = { name: 'bugfixer-session' as const, command: paths.standaloneNode, args: [paths.mcpGateway, String(access.port)], envVariables: [AGENT_SESSION_MCP_TOKEN_ENV] };
			const previousTurn = this.database.agentSessionTurns.getPreviousTurn(snapshot.projectId, snapshot.sessionId, turnId);
			let resumeProviderSessionId: string | undefined;
			if (snapshot.provider === 'codex' && previousTurn) {
				if (!previousTurn.providerConversationId) {
					throw new Error('이전 Codex 실행에서 대화 식별 정보를 받지 못해 이어서 실행할 수 없습니다. 새 세션에서 다시 시작해 주세요.');
				}
				resumeProviderSessionId = previousTurn.providerConversationId;
			} else if (snapshot.provider === 'claude' && previousTurn) {
				if (previousTurn.providerConversationId && previousTurn.providerConversationId !== snapshot.sessionId) {
					throw new Error('이전 Claude 실행의 식별 정보가 현재 세션과 일치하지 않아 이어서 실행할 수 없습니다.');
				}
				resumeProviderSessionId = snapshot.sessionId;
			}
			if (snapshot.provider === 'codex') {
				identityAccess = await this.providerIdentityReceiver.issue({
					projectId: snapshot.projectId,
					sessionId: snapshot.sessionId,
					turnId,
					expectedConversationId: previousTurn?.providerConversationId ?? null,
					onIdentityMismatch: () => {
						void this.service.rejectProviderConversation(snapshot.projectId, snapshot.sessionId, turnId)
							.catch(() => console.error('Codex provider identity mismatch could not stop its session.'));
					},
				});
			}
			if (snapshot.provider === 'claude') {
				privateDirectory = mkdtempSync(join(tmpdir(), 'bugfixer-session-config-'));
				configPath = join(privateDirectory, `claude-${turnId}.json`);
				writeFileSync(configPath, JSON.stringify({ mcpServers: { 'bugfixer-session': {
					command: paths.standaloneNode,
					args: [paths.mcpGateway, String(access.port)],
					env: { [AGENT_SESSION_MCP_TOKEN_ENV]: '$' + `{${AGENT_SESSION_MCP_TOKEN_ENV}}` },
				} } }), { mode: 0o600, flag: 'wx' });
			}
			const command = createAgentSessionCommand({
				provider: snapshot.provider, commandSpecVersion: AGENT_CLI_COMMAND_SPEC_VERSION, capabilities,
				executable, model: snapshot.model, profileRef, profileDirectory, cwd: snapshot.cwd, sessionId: snapshot.sessionId,
				resumeProviderSessionId,
				...(identityAccess ? { identityHookCommand: `${shellQuote(paths.standaloneNode)} ${shellQuote(paths.providerIdentityHook)}` } : {}),
				permissionPolicy: snapshot.permissionPolicy, mcpServer: gateway,
				...(configPath ? { claudeMcpConfigPath: configPath } : {}),
				profileEnvironment: { [snapshot.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: profileDirectory },
			});
			if (signal.aborted) { throw new Error('The session launch was cancelled before PTY creation.'); }
			const launchEnv: Record<string, string> = {
				...command.env, ...runtimeEnv, ...access.gatewayEnvironment,
				...(identityAccess ? {
					[AGENT_PROVIDER_IDENTITY_PORT_ENV]: String(identityAccess.port),
					[AGENT_PROVIDER_IDENTITY_NONCE_ENV]: identityAccess.nonce,
				} : {}),
			};
			return {
				command, permissionPolicy: snapshot.permissionPolicy, profileDirectory,
				launch: { executable: command.executable, args: command.args, cwd: command.cwd, env: launchEnv, cols: 100, rows: 30 },
				knownSecrets: [...access.knownSecrets, ...(identityAccess ? [identityAccess.nonce] : [])],
				revokeAccess,
				releasePrivateConfig,
			};
		} catch (error) {
			const preparationFailure = error instanceof AgentSessionPreparationError ? error : undefined;
			const revokeAllAccess = () => {
				const failures: unknown[] = [];
				try { revokeAccess(); } catch (cleanupError) { failures.push(cleanupError); }
				try { preparationFailure?.recovery?.revokeAccess(); } catch (cleanupError) { failures.push(cleanupError); }
				if (failures.length) { throw new AggregateError(failures, 'Session launch access revocation could not be verified.'); }
			};
			const releaseAllPrivateConfig = async () => {
				const failures: unknown[] = [];
				try { await releasePrivateConfig(); } catch (cleanupError) { failures.push(cleanupError); }
				try { await preparationFailure?.recovery?.releasePrivateConfig(); } catch (cleanupError) { failures.push(cleanupError); }
				if (failures.length) { throw new AggregateError(failures, 'Session launch resources could not be released.'); }
			};
			const failures: unknown[] = [];
			try { revokeAllAccess(); } catch (cleanupError) { failures.push(cleanupError); }
			try { await releaseAllPrivateConfig(); } catch (cleanupError) { failures.push(cleanupError); }
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

function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\"'\"'")}'`; }

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function resolveProviderCli(provider: AgentSessionProvider, home: string): string {
	const executable = findProviderCli(provider, home);
	if (!executable) { throw new Error(`An executable ${provider} CLI was not found in the supported local macOS locations.`); }
	return executable;
}

function findProviderCli(provider: AgentSessionProvider, home: string): string | undefined {
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
	return undefined;
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
