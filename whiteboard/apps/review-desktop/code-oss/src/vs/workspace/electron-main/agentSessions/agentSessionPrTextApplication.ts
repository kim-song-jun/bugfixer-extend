/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import type {
	AgentPrTextRequestDTO, AgentPrTextScope,
} from '../../common/workspaceAgentPrTextProtocol.js';
import { AGENT_PR_TEXT_MAX_BODY_BYTES } from '../../common/workspaceAgentPrTextProtocol.js';
import type {
	IWorkspaceAgentPrTextService, WorkspaceAgentPrTextApplyInput, WorkspaceAgentPrTextCancelInput,
	WorkspaceAgentPrTextDraftDTO, WorkspaceAgentPrTextPageInput, WorkspaceAgentPrTextPreviewDTO,
	WorkspaceAgentPrTextPreviewInput, WorkspaceAgentPrTextRequestInput, WorkspaceAgentPrTextSaveInput,
	WorkspaceAgentPrTextSelection, WorkspaceAgentPrTextStartInput,
} from '../../common/workspaceAgentPrTextHostProtocol.js';
import type { AgentSessionDTO, AgentSessionTurnDTO } from '../../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';
import {
	queryProviderPrTextCapability, runProviderPrText,
	type ProviderPrTextCapabilityRequest, type ProviderPrTextRunRequest, type ProviderPrTextRunResult,
} from '../providerRuns/providerPrTextRun.js';
import type { ProviderId, ProviderRunRequest } from '../providerRuns/providerRunTypes.js';
import type { AgentPrTextRequestContext } from './agentSessionPrTextStore.js';
import type { AgentSessionPrTextOwnedProcessReceipt } from './agentSessionPrTextProcessStore.js';
import type { AgentSessionContentFileSideDTO } from './agentSessionContentStore.js';
import { cancelProviderProcessGroup } from '../providerRuns/providerGroupControlClient.js';
import type { ProviderRecoveryControl } from '../providerRuns/providerRunTypes.js';
import { isOwnedProcessGroupGone } from '../providerRuns/providerProcessSupervisor.js';
import { lstatSync } from 'node:fs';
import { removePrTextControlDirectoryIfPresent, removePrTextControlSocketIfPresent } from './agentSessionPrTextEnvironment.js';

const FIXED_UNAVAILABLE = '현재 선택된 제공자는 PR 문구 자동 작성을 지원하지 않습니다. 설정을 변경하지 않았으며 다른 제공자로 전환하지 않았습니다.';
const MAX_PAGE_SIZE = 20;
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_CONTEXT_FILES = 200;
const MAX_SUMMARY_PATHS = 12;
const MAX_SUMMARY_ITEMS = 20;
const MAX_SUMMARY_ITEM_BYTES = 499;
const MAX_TITLE_BYTES = 256;
const PROCESS_RECOVERY_UNAVAILABLE = 'An earlier PR text provider process has not been fully cleaned up. Generation is blocked until exact process and control-socket cleanup is verified.';

export interface AgentSessionPrTextEnvironment extends ProviderPrTextCapabilityRequest {
	readonly profileRef: string | null;
	readonly knownSecrets: readonly string[];
	readonly preflight: ProviderRunRequest['preflight'];
}

/** Resolves the host's actual configured provider account and executable for one stored session. */
export interface AgentSessionPrTextResolver {
	resolve(session: AgentSessionDTO, targetTurn: AgentSessionTurnDTO): Promise<AgentSessionPrTextEnvironment>;
}

export type AgentSessionPrTextRunner = (request: ProviderPrTextRunRequest) => Promise<ProviderPrTextRunResult>;

interface ActivePrTextRun {
	readonly scope: AgentPrTextScope;
	readonly requestId: string;
	readonly attemptId: string;
	readonly expectedRunningRevision: number;
	readonly controller: AbortController;
	promise: Promise<void>;
	settled: boolean;
	retainForShutdown?: boolean;
	spawnedProcess?: AgentSessionPrTextOwnedProcessReceipt;
	cleanupReceiptPersisted?: boolean;
}

interface ContextSnapshot {
	readonly contextJSON: string;
	readonly sourceSummary: readonly string[];
	readonly snapshotId: string;
	readonly sha256: string;
}

export class AgentSessionPrTextApplication implements IWorkspaceAgentPrTextService {
	private closing = false;
	private readonly activeRuns = new Map<string, ActivePrTextRun>();
	private readonly retainedFailures: Error[] = [];
	private readonly runner: AgentSessionPrTextRunner;
	private processRecovery: Promise<void> | undefined;

	constructor(private readonly database: WorkspaceDatabase, private readonly resolver: AgentSessionPrTextResolver, runner: AgentSessionPrTextRunner = runProviderPrText) {
		this.runner = runner;
	}

	/** Must be awaited by host startup before exposing PR text generation. */
	initialize(): Promise<void> { return this.ensureProcessRecovery(); }

	async getPrTextDraft(scope: AgentPrTextScope): Promise<WorkspaceAgentPrTextDraftDTO> {
		this.assertOpen(); this.requireScope(scope);
		const head = this.database.agentSessionPrTexts.getHead(scope) ?? null;
		const revisions = this.database.agentSessionPrTexts.listRevisions(scope, { afterRevision: 0, limit: 5, newestFirst: true });
		const requests = this.database.agentSessionPrTexts.listRequests(scope, { afterSequence: 0, limit: 5, newestFirst: true });
		return { head, revisions, requests };
	}

	async listPrTextRevisions(input: WorkspaceAgentPrTextPageInput) {
		this.assertOpen(); this.assertKeys(input, ['scope', 'after', 'limit'], 'PR text revision page'); this.requireScope(input.scope); this.validatePage(input);
		return this.database.agentSessionPrTexts.listRevisions(input.scope, { afterRevision: input.after, limit: input.limit, newestFirst: true });
	}

	async listPrTextRequests(input: WorkspaceAgentPrTextPageInput) {
		this.assertOpen(); this.assertKeys(input, ['scope', 'after', 'limit'], 'PR text request page'); this.requireScope(input.scope); this.validatePage(input);
		return this.database.agentSessionPrTexts.listRequests(input.scope, { afterSequence: input.after, limit: input.limit, newestFirst: true });
	}

	async savePrTextRevision(input: WorkspaceAgentPrTextSaveInput, assertCurrent: () => void = () => undefined): Promise<ReturnType<WorkspaceDatabase['agentSessionPrTexts']['appendHumanRevision']>> {
		this.assertOpen(); this.assertKeys(input, ['scope', 'expectedRevision', 'idempotencyKey', 'title', 'body'], 'PR text save'); this.requireScope(input.scope); assertCurrent();
		this.assertOpen(); assertCurrent();
		return this.database.agentSessionPrTexts.appendHumanRevision({ scope: input.scope, expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey, content: { title: input.title, body: input.body } });
	}

	async previewPrTextRequest(input: WorkspaceAgentPrTextPreviewInput, assertCurrent: () => void = () => undefined): Promise<WorkspaceAgentPrTextPreviewDTO> {
		this.assertOpen(); this.assertKeys(input, ['scope', 'baseRevision', 'idempotencyKey', 'instruction'], 'PR text preview'); this.requireScope(input.scope); assertCurrent();
		const session = this.requireSession(input.scope); const targetTurn = this.requireSelectedTurn(input.scope, session);
		const environment = await this.resolveEnvironment(session, targetTurn);
		this.assertOpen(); assertCurrent();
		const currentSession = this.requireSession(input.scope); const currentTurn = this.requireSelectedTurn(input.scope, currentSession); this.assertEnvironment(currentSession, currentTurn, environment);
		this.requireAvailable(environment);
		const currentHead = this.database.agentSessionPrTexts.getHead(input.scope) ?? null;
		if (input.baseRevision !== (currentHead?.revision ?? 0)) { throw new Error('최신 PR 문구가 바뀌었습니다. 현재 문구를 다시 불러와 주세요.'); }
		const snapshot = this.readSourceSnapshot(input.scope, currentSession, environment.knownSecrets);
		const permissionSummary = `실행: ${environment.providerId} / ${environment.model} · 현재 ${environment.profileRef} 프로필 · 실제 작업 폴더: 비공개 임시 폴더. 저장 근거 최대 ${MAX_CONTEXT_FILES}개 파일/${MAX_CONTEXT_BYTES}바이트가 주장의 기준이며, CLI는 ${environment.sourceCwd}도 기존 정책대로 읽을 수 있습니다. 읽기 전용 정책, 현재 계정과 제공자 과금이 적용됩니다.`;
		const sourceSummary = [permissionSummary, ...snapshot.sourceSummary];
		if (sourceSummary.length > MAX_SUMMARY_ITEMS || sourceSummary.some(item => Buffer.byteLength(item, 'utf8') > MAX_SUMMARY_ITEM_BYTES)) {
			throw new Error('PR 문구 실행 범위 요약이 표시 한도를 넘습니다. 경로 또는 근거를 줄인 뒤 다시 시도해 주세요.');
		}
		this.assertOpen(); assertCurrent();
		const request = this.database.agentSessionPrTexts.createRequest({
			scope: input.scope,
			idempotencyKey: input.idempotencyKey,
			baseRevision: input.baseRevision,
			provider: environment.providerId,
			model: environment.model,
			profileRef: environment.profileRef,
			contextDigest: snapshot.sha256,
			contextJSON: snapshot.contextJSON,
			instruction: input.instruction,
		}, environment.knownSecrets);
		const persisted = this.database.agentSessionPrTexts.getRequestContext(input.scope, request.id);
		if (!persisted || persisted.contextDigest !== request.contextDigest) { throw new Error('저장된 PR 문구 요청 문맥을 확인하지 못했습니다.'); }
		return { request, digest: request.contextDigest, sourceSummary };
	}

	async startPrTextRequest(input: WorkspaceAgentPrTextStartInput, assertCurrent: () => void = () => undefined): Promise<AgentPrTextRequestDTO> {
		this.assertOpen(); this.assertKeys(input, ['scope', 'requestId', 'expectedStateRevision', 'expectedDigest'], 'PR text start'); this.requireScope(input.scope); assertCurrent();
		const current = this.requireRequest(input.scope, input.requestId);
		if (current.state === 'running') {
			const active = this.activeRuns.get(current.id);
			if (active && current.stateRevision === input.expectedStateRevision + 1 && current.contextDigest === input.expectedDigest) { return current; }
			throw new Error('이미 실행 중이거나 복구가 필요한 AI 작성 요청입니다.');
		}
		if (current.state !== 'preview' || current.stateRevision !== input.expectedStateRevision || current.contextDigest !== input.expectedDigest) { throw new Error('PR 문구 미리보기가 바뀌었습니다. 다시 준비해 주세요.'); }
		if ([...this.activeRuns.values()].some(active => !active.settled)) { throw new Error(PROCESS_RECOVERY_UNAVAILABLE); }
		await this.ensureProcessRecovery();
		this.assertOpen(); assertCurrent();
		const session = this.requireSession(input.scope); const targetTurn = this.requireSelectedTurn(input.scope, session);
		const environment = await this.resolveEnvironment(session, targetTurn);
		this.assertOpen(); assertCurrent();
		const currentSession = this.requireSession(input.scope); const currentTurn = this.requireSelectedTurn(input.scope, currentSession); this.assertEnvironment(currentSession, currentTurn, environment); this.requireAvailable(environment);
		const storedContext = this.database.agentSessionPrTexts.getRequestContext(input.scope, current.id);
		if (!storedContext || !this.sameResolvedSettings(storedContext, environment)) { throw new Error('선택한 제공자 설정이 미리보기와 달라졌습니다. 새 미리보기를 준비해 주세요.'); }
		const snapshot = this.readSourceSnapshot(input.scope, currentSession, environment.knownSecrets);
		const sanitized = this.database.agentSessionPrTexts.sanitizeContextJSON(snapshot.contextJSON, environment.knownSecrets);
		if (sanitized.contextDigest !== storedContext.contextDigest || snapshot.sha256 !== sanitized.contextDigest) { throw new Error('작업 문맥 또는 PR head가 미리보기 뒤 바뀌었습니다. 새 미리보기를 준비해 주세요.'); }
		if (storedContext.contextDigest !== input.expectedDigest) { throw new Error('PR 문구 미리보기 지문이 일치하지 않습니다.'); }
		const attemptId = randomUUID();
		this.assertOpen(); assertCurrent();
		const running = this.database.agentSessionPrTexts.startRequest({ requestId: current.id, expectedStateRevision: current.stateRevision, attemptId });
		const active: ActivePrTextRun = { scope: input.scope, requestId: current.id, attemptId, expectedRunningRevision: running.stateRevision, controller: new AbortController(), promise: Promise.resolve(), settled: false };
		this.activeRuns.set(current.id, active);
		active.promise = this.executeRun(active, storedContext, environment);
		return running;
	}

	async getPrTextRequest(input: WorkspaceAgentPrTextRequestInput): Promise<AgentPrTextRequestDTO> {
		this.assertOpen(); this.assertKeys(input, ['scope', 'requestId'], 'PR text request read'); this.requireScope(input.scope);
		return this.requireRequest(input.scope, input.requestId);
	}

	async cancelPrTextRequest(input: WorkspaceAgentPrTextCancelInput): Promise<AgentPrTextRequestDTO> {
		this.assertOpen(); this.assertKeys(input, ['scope', 'requestId', 'expectedStateRevision'], 'PR text cancel'); this.requireScope(input.scope);
		const current = this.requireRequest(input.scope, input.requestId);
		const cancelled = this.database.agentSessionPrTexts.cancelRequest({ requestId: current.id, expectedStateRevision: input.expectedStateRevision });
		this.activeRuns.get(current.id)?.controller.abort();
		return cancelled;
	}

	async applyPrTextCandidate(input: WorkspaceAgentPrTextApplyInput, assertCurrent: () => void = () => undefined): Promise<ReturnType<WorkspaceDatabase['agentSessionPrTexts']['applyCandidate']>> {
		this.assertOpen(); this.assertKeys(input, ['scope', 'requestId', 'expectedStateRevision', 'expectedHeadRevision', 'idempotencyKey'], 'PR text candidate apply'); this.requireScope(input.scope); assertCurrent();
		const request = this.requireRequest(input.scope, input.requestId);
		this.assertOpen(); assertCurrent();
		return this.database.agentSessionPrTexts.applyCandidate({ requestId: request.id, expectedStateRevision: input.expectedStateRevision, expectedHeadRevision: input.expectedHeadRevision, idempotencyKey: input.idempotencyKey });
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		if (this.processRecovery) {
			try { await this.processRecovery; }
			catch (error) { this.retainFailure('PR text startup process recovery did not finish cleanly.', error); }
		}
		for (const active of this.activeRuns.values()) {
			const request = this.database.agentSessionPrTexts.getRequest(active.scope, active.requestId);
			if (request?.state === 'running') {
				try { this.database.agentSessionPrTexts.cancelRequest({ requestId: request.id, expectedStateRevision: request.stateRevision }); }
				catch (error) { this.retainFailure(`Could not persist PR text shutdown cancellation for ${request.id}.`, error); }
			}
			active.controller.abort();
		}
		await Promise.all([...this.activeRuns.values()].map(active => active.promise));
		if (this.retainedFailures.length) { throw new AggregateError(this.retainedFailures, 'PR text runner shutdown did not verify cleanup.'); }
	}

	private async executeRun(active: ActivePrTextRun, context: AgentPrTextRequestContext, environment: AgentSessionPrTextEnvironment): Promise<void> {
		const snapshot = { snapshotId: active.requestId, sourceText: context.contextJSON, sha256: context.contextDigest };
		const runRequest: ProviderPrTextRunRequest = {
			providerId: environment.providerId, model: environment.model,
			sourceCwd: environment.sourceCwd, profileDirectory: environment.profileDirectory, executable: environment.executable, processControl: environment.processControl,
			requestId: active.requestId, attemptId: active.attemptId, snapshot, task: context.instruction,
			signal: active.controller.signal, preflight: environment.preflight,
			onOwnedProcessSpawned: async (pgid, controlNonce, recoveryControl) => {
				const receipt = this.ownedProcessReceipt(active, environment, pgid, controlNonce, recoveryControl);
				const persisted = this.database.agentSessionPrTextProcesses.recordOwnedProcess(receipt);
				const readback = this.database.agentSessionPrTextProcesses.getOwnedProcess(active.requestId, active.attemptId);
				if (!readback || !sameProcessReceipt(persisted, readback)) { throw new Error('The durable PR text process receipt failed readback verification.'); }
				active.spawnedProcess = readback;
			},
			onCleanupVerified: async receipt => {
				const owned = active.spawnedProcess;
				if (!owned || receipt.requestId !== active.requestId || receipt.attemptId !== active.attemptId
					|| receipt.pgid !== owned.pgid || receipt.controlNonce !== owned.nonce || receipt.recoveryControl.nonce !== owned.nonce
					|| receipt.recoveryControl.socketPath !== owned.socketPath || receipt.recoveryControl.nodeExecutable !== owned.nodeExecutable
					|| receipt.recoveryControl.helperScript !== owned.helperScript) {
					throw new Error('The runner cleanup receipt does not match the durable PR text process owner.');
				}
				removePrTextControlSocketIfPresent(owned.socketPath);
				try { lstatSync(owned.socketPath); throw new Error('The verified provider recovery socket still exists.'); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
				const persisted = this.database.agentSessionPrTextProcesses.markCleanupVerified({ requestId: active.requestId, attemptId: active.attemptId,
					pgid: owned.pgid, nonce: owned.nonce });
				const readback = this.database.agentSessionPrTextProcesses.getCleanupReceipt(active.requestId, active.attemptId);
				if (!readback || persisted.pgid !== readback.pgid || persisted.nonce !== readback.nonce || readback.pgid !== owned.pgid || readback.nonce !== owned.nonce) {
					throw new Error('The durable PR text cleanup receipt failed readback verification.');
				}
				active.cleanupReceiptPersisted = true;
			},
		};
		let result: ProviderPrTextRunResult;
		try { result = await this.runner(runRequest); }
		catch (error) {
			this.tryInterruptRequest(active, `Could not persist interrupted PR text request ${active.requestId}.`);
			active.retainForShutdown = true;
			const ownedGroup = active.spawnedProcess ? ` (owned process group ${active.spawnedProcess.pgid})` : '';
			this.retainFailure(`PR text runner rejected without a cleanup receipt for request ${active.requestId}${ownedGroup}.`, error);
			active.settled = true;
			return;
		}
		try {
			if (!result || result.cleanupVerified !== true) {
				const reason = typeof result?.reason === 'string' && result.reason.trim() ? result.reason.slice(0, 1024) : 'Owned provider process cleanup was not verified.';
				if (active.spawnedProcess && active.cleanupReceiptPersisted) {
					try {
						removePrTextControlDirectoryIfPresent(active.spawnedProcess.socketPath);
						this.interruptRequest(active);
						return;
					} catch (error) {
						this.retainFailure(`Could not remove verified private PR text control directory for ${active.requestId}.`, error);
					}
				}
				this.tryInterruptRequest(active, `Could not persist interrupted PR text request ${active.requestId}.`);
				active.retainForShutdown = true;
				this.retainedFailures.push(new Error(`PR text request ${active.requestId}: ${reason}`));
				return;
			}
			if (active.spawnedProcess && !active.cleanupReceiptPersisted) {
				throw new Error('The PR text runner returned without persisting its required durable cleanup receipt.');
			}
			if (result.state === 'succeeded') {
				const source = this.sourceFromReceipt(result, active, environment, snapshot);
				if (!source || !result.content || !this.validContent(result.content, environment.knownSecrets)) {
					this.failRequest(active, 'invalidCandidate');
					return;
				}
				this.database.agentSessionPrTexts.completeRequest({ requestId: active.requestId, expectedRunningRevision: active.expectedRunningRevision, source,
					sanitizedCompleteAgentText: result.content, knownSecrets: environment.knownSecrets });
				return;
			}
			if (result.state === 'cancelled') { this.cancelIfRunning(active); return; }
			if (result.state === 'interrupted') { this.interruptRequest(active); return; }
			this.failRequest(active, 'providerFailed');
		} catch (error) {
			this.tryInterruptRequest(active, `Could not persist interrupted PR text request ${active.requestId}.`);
			this.retainFailure(`Could not persist PR text request result for ${active.requestId}.`, error);
		} finally {
			active.settled = true;
			if (!active.retainForShutdown) { this.activeRuns.delete(active.requestId); }
		}
	}

	private ensureProcessRecovery(): Promise<void> {
		if (this.processRecovery) { return this.processRecovery; }
		const recovery = this.recoverUnverifiedProcesses();
		const tracked = recovery.finally(() => { if (this.processRecovery === tracked) { this.processRecovery = undefined; } });
		this.processRecovery = tracked;
		return tracked;
	}

	private async recoverUnverifiedProcesses(): Promise<void> {
		for (const receipt of this.database.agentSessionPrTextProcesses.listUnverified()) {
			if (!isOwnedProcessGroupGone(receipt.pgid)) {
				let socketWarning: string | undefined;
				try { socketWarning = await cancelProviderProcessGroup({ socketPath: receipt.socketPath, nonce: receipt.nonce }, receipt.attemptId, receipt.pgid); }
				catch { throw new Error(PROCESS_RECOVERY_UNAVAILABLE); }
				if (socketWarning !== undefined) { throw new Error(PROCESS_RECOVERY_UNAVAILABLE); }
			}
			try { removePrTextControlDirectoryIfPresent(receipt.socketPath); }
			catch { throw new Error(PROCESS_RECOVERY_UNAVAILABLE); }
			this.database.agentSessionPrTextProcesses.markCleanupVerified({ requestId: receipt.requestId, attemptId: receipt.attemptId, pgid: receipt.pgid, nonce: receipt.nonce });
			const active = this.activeRuns.get(receipt.requestId);
			if (active?.attemptId === receipt.attemptId && active.settled) { this.activeRuns.delete(receipt.requestId); }
		}
		let after: { requestId: string; attemptId: string } | undefined;
		for (;;) {
			const page = this.database.agentSessionPrTextProcesses.listCleanupVerified(after, 100);
			if (page.length === 0) { break; }
			for (const receipt of page) {
				try { removePrTextControlDirectoryIfPresent(receipt.socketPath); }
				catch { throw new Error(PROCESS_RECOVERY_UNAVAILABLE); }
			}
			const last = page.at(-1)!;
			after = { requestId: last.requestId, attemptId: last.attemptId };
			if (page.length < 100) { break; }
		}
	}

	private ownedProcessReceipt(active: ActivePrTextRun, environment: AgentSessionPrTextEnvironment, pgid: number, controlNonce?: string, recoveryControl?: ProviderRecoveryControl): AgentSessionPrTextOwnedProcessReceipt {
		if (!Number.isSafeInteger(pgid) || pgid < 1 || !recoveryControl || controlNonce !== recoveryControl.nonce
			|| recoveryControl.nodeExecutable !== environment.processControl.nodeExecutable
			|| recoveryControl.helperScript !== environment.processControl.helperScript) {
			throw new Error('The owned PR text process did not provide its authenticated recovery identity.');
		}
		return { requestId: active.requestId, attemptId: active.attemptId, pgid, nodeExecutable: recoveryControl.nodeExecutable,
			helperScript: recoveryControl.helperScript, socketPath: recoveryControl.socketPath, nonce: recoveryControl.nonce, recordedAt: new Date().toISOString() };
	}

	private sourceFromReceipt(result: ProviderPrTextRunResult, active: ActivePrTextRun, environment: AgentSessionPrTextEnvironment,
	snapshot: { readonly snapshotId: string; readonly sourceText: string; readonly sha256: string }): { readonly kind: 'providerAttempt'; readonly requestId: string; readonly attemptId: string; readonly provider: ProviderId; readonly model: string; readonly profileRef: string | null; readonly receiptHash: string; readonly cleanupVerified: true } | undefined {
		const receipt = result.receipt;
		if (!receipt || receipt.requestId !== active.requestId || receipt.attemptId !== active.attemptId || receipt.providerId !== environment.providerId
			|| receipt.model !== environment.model || receipt.snapshotId !== snapshot.snapshotId || receipt.snapshotSha256 !== snapshot.sha256
			|| !/^[0-9a-f]{64}$/u.test(receipt.contentSha256) || !result.content || receipt.contentSha256 !== digest(JSON.stringify(result.content))) { return undefined; }
		const receiptHash = digest(JSON.stringify(receipt));
		return { kind: 'providerAttempt', requestId: active.requestId, attemptId: active.attemptId, provider: environment.providerId, model: environment.model,
			profileRef: environment.profileRef, receiptHash, cleanupVerified: true };
	}

	private cancelIfRunning(active: ActivePrTextRun): void {
		const request = this.database.agentSessionPrTexts.getRequest(active.scope, active.requestId);
		if (request?.state === 'running') { this.database.agentSessionPrTexts.cancelRequest({ requestId: request.id, expectedStateRevision: request.stateRevision }); }
	}

	private interruptRequest(active: ActivePrTextRun): void {
		const request = this.database.agentSessionPrTexts.getRequest(active.scope, active.requestId);
		if (request?.state === 'running') { this.database.agentSessionPrTexts.interruptRequest({ requestId: request.id, expectedStateRevision: request.stateRevision }); }
	}

	private tryInterruptRequest(active: ActivePrTextRun, message: string): void {
		try { this.interruptRequest(active); }
		catch (error) { active.retainForShutdown = true; this.retainFailure(message, error); }
	}

	private failRequest(active: ActivePrTextRun, errorCode: 'providerFailed' | 'invalidCandidate'): void {
		const request = this.database.agentSessionPrTexts.getRequest(active.scope, active.requestId);
		if (request?.state === 'running') { this.database.agentSessionPrTexts.failRequest({ requestId: request.id, expectedStateRevision: request.stateRevision, errorCode }); }
	}

	private readSourceSnapshot(scope: AgentPrTextScope, session: AgentSessionDTO, knownSecrets: readonly string[]): ContextSnapshot {
		const turn = this.requireSelectedTurn(scope, session);
		const evidence = this.database.agentSessionChangeEvidence.getLatest(scope.projectId, scope.sessionId, scope.targetTurnId);
		if (!evidence || evidence.projectId !== scope.projectId || evidence.sessionId !== scope.sessionId || evidence.turnId !== scope.targetTurnId || evidence.turnSnapshotSha256 !== turn.snapshotSha256) {
			throw new Error('선택한 실행의 보관된 변경 근거를 확인할 수 없습니다.');
		}
		if (evidence.files.length > MAX_CONTEXT_FILES) { throw new Error(`보관된 변경 파일이 ${MAX_CONTEXT_FILES}개 제한을 넘습니다. 입력을 줄인 뒤 다시 시도해 주세요.`); }
		const files = [...evidence.files].sort((left, right) => left.path.localeCompare(right.path)).map(observation => {
			const retained = this.database.agentSessionContents.getFile({ scope: { projectId: scope.projectId, sessionId: scope.sessionId, turnId: scope.targetTurnId }, evidenceVersion: evidence.version, path: observation.path });
			if (!retained || retained.evidenceFingerprint !== evidence.fingerprint) { throw new Error(`보관된 변경 파일 ${observation.path}을 확인할 수 없습니다.`); }
			const reason = this.database.agentSessionReviews.getLatest({ projectId: scope.projectId, sessionId: scope.sessionId, turnId: scope.targetTurnId,
				evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: observation.path, hunkId: null });
			return {
				path: observation.path, previousPath: observation.previousPath ?? null, change: observation.change,
				before: this.retainedSide(retained.before), after: this.retainedSide(retained.after),
				reason: reason?.actor === 'human' && reason.status === 'confirmed' ? { what: reason.what, why: reason.why } : null,
			};
		});
		const task = session.taskId ? this.database.getTask(session.taskId) : undefined;
		if (session.taskId && (!task || task.projectId !== scope.projectId)) { throw new Error('선택한 세션의 작업 설명을 확인할 수 없습니다.'); }
		const head = this.database.agentSessionPrTexts.getHead(scope) ?? null;
		const context = {
			schemaVersion: 1,
			scope,
			task: task ? { id: task.id, revision: task.revision, title: task.title, description: task.description } : null,
			turn: { id: turn.id, ordinal: turn.ordinal, state: turn.state, provider: turn.snapshot.provider, model: turn.snapshot.model, snapshotSha256: turn.snapshotSha256 },
			evidence: { id: evidence.id, version: evidence.version, fingerprint: evidence.fingerprint, status: evidence.status, coverage: evidence.coverage,
				noChangesConfirmed: evidence.noChangesConfirmed, missingReason: evidence.missingReason, attribution: evidence.attribution, attributionNote: evidence.attributionNote, files },
			currentPrHead: head ? { revision: head.revision, title: head.content.title, body: head.content.body, contentHash: head.content.contentHash } : null,
		};
		const rawJSON = JSON.stringify(context);
		if (Buffer.byteLength(rawJSON, 'utf8') > MAX_CONTEXT_BYTES) { throw new Error(`선택한 변경 근거가 ${MAX_CONTEXT_BYTES}바이트 한도를 넘습니다. 내용을 줄인 뒤 다시 시도해 주세요.`); }
		const sanitized = this.database.agentSessionPrTexts.sanitizeContextJSON(rawJSON, knownSecrets);
		if (Buffer.byteLength(sanitized.contextJSON, 'utf8') > MAX_CONTEXT_BYTES) { throw new Error(`비밀 정보 제거 후에도 변경 근거가 ${MAX_CONTEXT_BYTES}바이트 한도를 넘습니다.`); }
		const reasonCount = files.filter(file => file.reason !== null).length;
		const listedPaths = files.slice(0, MAX_SUMMARY_PATHS).map(file => file.path);
		const pathRemainder = files.length - listedPaths.length;
		const pathSummary = files.length ? `보관된 파일 ${files.length}개: ${listedPaths.join(', ')}${pathRemainder ? ` 외 ${pathRemainder}개` : ''}` : '보관된 변경 파일 없음';
		const sourceSummary = [
			`선택한 실행 #${turn.ordinal} · ${turn.state} · 저장된 실행 지문 ${turn.snapshotSha256}`,
			`변경 근거 v${evidence.version} · ${evidence.status} · ${evidence.coverage} · ${pathSummary}`,
			`사람 작성 이유 ${reasonCount}개 · 현재 PR head ${head ? `v${head.revision}` : '없음'}`,
		];
		if (sourceSummary.length > MAX_SUMMARY_ITEMS || sourceSummary.some(item => Buffer.byteLength(item, 'utf8') > MAX_SUMMARY_ITEM_BYTES)) {
			throw new Error('선택한 변경 근거의 실행 범위 요약이 표시 한도를 넘습니다. 경로 또는 근거를 줄인 뒤 다시 시도해 주세요.');
		}
		return { contextJSON: sanitized.contextJSON, sourceSummary, snapshotId: `pr-text:${scope.projectId}:${scope.sessionId}:${scope.targetTurnId}:${evidence.version}:${head?.revision ?? 0}`, sha256: sanitized.contextDigest };
	}

	private retainedSide(side: AgentSessionContentFileSideDTO): unknown {
		if (side.state === 'absent') { return { state: 'absent' }; }
		if (side.state === 'unavailable') { return { state: 'unavailable', reason: side.reason, ...(side.file ? { size: side.file.size, sha256: side.file.sha256, kind: side.file.kind } : {}) }; }
		return { state: 'text', content: side.file.content ?? null, size: side.file.size, sha256: side.file.sha256, kind: side.file.kind };
	}

	private async resolveEnvironment(session: AgentSessionDTO, targetTurn: AgentSessionTurnDTO): Promise<AgentSessionPrTextEnvironment> {
		try { return await this.resolver.resolve(session, targetTurn); }
		catch { throw new Error(FIXED_UNAVAILABLE); }
	}

	private assertEnvironment(session: AgentSessionDTO, turn: AgentSessionTurnDTO, environment: AgentSessionPrTextEnvironment): void {
		if (environment.providerId !== session.provider || environment.model !== session.model || environment.profileRef !== session.profileRef
			|| environment.sourceCwd !== turn.snapshot.cwd || session.taskId !== turn.snapshot.taskId || session.bindingId !== turn.snapshot.bindingId) {
			throw new Error('세션 또는 선택한 실행의 제공자 설정과 작업 폴더가 다릅니다.');
		}
		if (!Array.isArray(environment.knownSecrets) || environment.knownSecrets.some(secret => typeof secret !== 'string' || !secret.length || Buffer.byteLength(secret, 'utf8') > 8192)) { throw new Error(FIXED_UNAVAILABLE); }
	}

	private requireAvailable(environment: AgentSessionPrTextEnvironment): void {
		if (!queryProviderPrTextCapability(environment).available) { throw new Error(FIXED_UNAVAILABLE); }
	}

	private sameResolvedSettings(context: AgentPrTextRequestContext, environment: AgentSessionPrTextEnvironment): boolean {
		return context.provider === environment.providerId && context.model === environment.model && context.profileRef === environment.profileRef;
	}

	private validContent(content: { readonly title: string; readonly body: string }, knownSecrets: readonly string[]): boolean {
		return typeof content.title === 'string' && content.title.trim() === content.title && content.title.length > 0 && Buffer.byteLength(content.title, 'utf8') <= MAX_TITLE_BYTES
			&& !/[\r\n\u0000-\u001f\u007f]/u.test(content.title) && typeof content.body === 'string' && !content.body.includes('\0') && Buffer.byteLength(content.body, 'utf8') <= AGENT_PR_TEXT_MAX_BODY_BYTES
			&& !knownSecrets.some(secret => content.title.includes(secret) || content.body.includes(secret));
	}

	private requireSelectedTurn(scope: AgentPrTextScope, session: AgentSessionDTO) {
		const turn = this.database.agentSessionTurns.getTurn(scope.projectId, scope.sessionId, scope.targetTurnId);
		if (!turn || turn.projectId !== scope.projectId || turn.sessionId !== scope.sessionId || turn.id !== scope.targetTurnId
			|| turn.snapshot.projectId !== scope.projectId || turn.snapshot.sessionId !== session.id || turn.state !== 'exited' || turn.cleanupVerified !== true) {
			throw new Error('정리까지 완료한 세션 실행을 선택해 주세요.');
		}
		return turn;
	}

	private requireSession(scope: AgentPrTextScope): AgentSessionDTO {
		const session = this.database.agentSessions.getSession(scope.projectId, scope.sessionId);
		if (!session || session.projectId !== scope.projectId || session.id !== scope.sessionId) { throw new Error('PR 문구 세션을 찾을 수 없습니다.'); }
		return session;
	}

	private requireScope(scope: AgentPrTextScope): void {
		this.requireSession(scope);
		if (!this.database.agentSessionTurns.getTurn(scope.projectId, scope.sessionId, scope.targetTurnId)) { throw new Error('PR 문구 실행 범위가 일치하지 않습니다.'); }
	}
	private requireRequest(scope: AgentPrTextScope, requestId: string): AgentPrTextRequestDTO {
		const request = this.database.agentSessionPrTexts.getRequest(scope, requestId);
		if (!request || !sameScope(request.scope, scope)) { throw new Error('PR 문구 요청을 찾을 수 없습니다.'); }
		return request;
	}

	private validatePage(input: WorkspaceAgentPrTextPageInput): void {
		if (!Number.isSafeInteger(input.after) || input.after < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE) { throw new Error(`PR 문구 기록 페이지는 ${MAX_PAGE_SIZE}개 이하로 요청해야 합니다.`); }
	}
	private assertOpen(): void { if (this.closing) { throw new Error('PR 문구 호스트가 종료 중입니다.'); } }
	private assertKeys(value: object, expected: readonly string[], label: string): void {
		const keys = Object.keys(value).sort(); const allowed = [...expected].sort();
		if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) { throw new Error(`${label} 입력에 예상하지 않은 필드가 있습니다.`); }
	}
	private retainFailure(message: string, cause: unknown): void { this.retainedFailures.push(new Error(message, { cause })); }
}

function sameScope(left: AgentPrTextScope, right: AgentPrTextScope): boolean {
	return left.projectId === right.projectId && left.sessionId === right.sessionId && left.targetTurnId === right.targetTurnId;
}
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function sameProcessReceipt(left: AgentSessionPrTextOwnedProcessReceipt, right: AgentSessionPrTextOwnedProcessReceipt): boolean {
	return left.requestId === right.requestId && left.attemptId === right.attemptId && left.pgid === right.pgid
		&& left.nodeExecutable === right.nodeExecutable && left.helperScript === right.helperScript
		&& left.socketPath === right.socketPath && left.nonce === right.nonce;
}
