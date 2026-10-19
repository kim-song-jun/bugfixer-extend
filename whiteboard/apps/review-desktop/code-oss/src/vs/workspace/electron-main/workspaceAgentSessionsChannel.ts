/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { WebContents } from 'electron';
import { isUUID } from '../../base/common/uuid.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type {
	AgentSessionPermissionPolicy,
	AgentSessionProvider,
	AgentSessionTranscriptPageOptions,
	SessionMessageDTO,
	CreateAgentSessionInput,
	WorkspaceAgentSessionWorkspacePreparationDTO,
	WorkspaceAgentSessionOutputEvent,
} from '../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceAgentChangeFileDTO, WorkspaceAgentExplanationCitationDTO, WorkspaceAgentReportedCheckDTO } from '../common/workspaceAgentChangesProtocol.js';
import { WORKSPACE_AGENT_SESSIONS_OUTPUT_EVENT } from '../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceAgentSessionMailboxMessage, WorkspaceAgentSessionMailboxPage } from '../common/workspaceAgentCommunicationProtocol.js';
import type {
	AgentWorkflowDTO, AgentWorkflowNodePlan, AgentWorkflowPlan, AgentWorkflowPlanInput, AgentWorkflowRunDTO, AgentWorkflowStatusDTO,
} from '../common/workspaceAgentWorkflowProtocol.js';
import type {
	AgentSessionIntegrationProposalDTO, WorkspaceAgentCommitPrepareInput, WorkspaceAgentCommitProposalInput,
	WorkspaceAgentCommitProposalPageInput, WorkspaceAgentCommitRecoveryInput,
} from '../common/workspaceAgentIntegrationProtocol.js';
import type {
	AgentSessionMergeProposalDTO, WorkspaceAgentMergePrepareInput, WorkspaceAgentMergeProposalMutationInput,
	WorkspaceAgentMergeProposalPageInput, WorkspaceAgentMergeProposalPageDTO, WorkspaceAgentMergeProposalRecoveryInput,
} from '../common/workspaceAgentMergeProtocol.js';
import { AGENT_SESSION_MERGE_PROPOSAL_PAGE_LIMIT } from '../common/workspaceAgentMergeProtocol.js';
import {
	AGENT_SESSION_PUBLICATION_HISTORY_LIMIT,
	type AgentSessionPublicationPrepareInput,
	type AgentSessionPublicationPageDTO,
	type AgentSessionPublicationOperationDTO,
	type AgentSessionPublicationProposalDTO,
	type WorkspaceAgentPublicationExecutionDTO,
	type WorkspaceAgentPublicationAccountsDTO,
	type WorkspaceAgentPublicationMutationInput,
	type WorkspaceAgentPublicationPageInput,
	type WorkspaceAgentPublicationRecoveryInput,
	type WorkspaceAgentPublicationScope,
} from '../common/workspaceAgentPublicationProtocol.js';
import type { AgentSessionAttachResult, AgentSessionService } from './agentSessions/agentSessionService.js';
import { computeAgentSessionChangeHunks } from './agentSessions/agentSessionChangeHunks.js';
import type { AgentSessionExplanationTarget } from './agentSessions/agentSessionReviewStore.js';
import type { WorkspaceDatabase } from './workspaceDatabase.js';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_READ_CHUNKS = 500;
const MAX_MAILBOX_PAGE_BYTES = 512 * 1024;
const CATCH_UP_READ_PAGE_SIZE = 100;
const MAX_CATCH_UP_CHUNKS = 5_000;
const MAX_ATTACHMENTS_PER_WINDOW = 8;
const MAX_ATTACHMENTS_PER_TURN = 2;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MAX_DIMENSION = 1000;

interface ScopedAttachment {
	readonly attachmentId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly owner: WebContents;
	lastSentSequence: number;
}

interface AttachmentReservation {
	readonly owner: WebContents;
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
}

interface SenderScope {
	readonly sender: WebContents;
	generation: number;
	projectId?: string;
	descriptorUri?: string;
	pendingOperations: number;
	disposeListeners?: () => void;
}

interface ScopeToken {
	readonly scope: SenderScope;
	readonly generation: number;
	readonly projectId: string;
	readonly descriptorUri: string;
}

/** Approval always uses a main-process native dialog; IPC cannot supply an approval receipt. */
export interface WorkspaceAgentWorkflowHost {
	start(projectId: string, workflowId: string, expectedRevision: number, idempotencyKey: string): AgentWorkflowRunDTO | Promise<AgentWorkflowRunDTO>;
	cancel(projectId: string, workflowId: string, expectedRevision: number, idempotencyKey: string): AgentWorkflowDTO | Promise<AgentWorkflowDTO>;
	getHostError(projectId: string, workflowId: string, runId?: string): string | null;
	confirmPlan(sender: WebContents, plan: AgentWorkflowPlan): Promise<boolean>;
}

/** Host-only commit proposal operations. Human confirmation remains a native dialog capability. */
export interface WorkspaceAgentCommitHost {
	prepare(input: WorkspaceAgentCommitPrepareInput): Promise<AgentSessionIntegrationProposalDTO>;
	approve(input: WorkspaceAgentCommitProposalInput): AgentSessionIntegrationProposalDTO['approval'];
	apply(input: WorkspaceAgentCommitProposalInput): Promise<AgentSessionIntegrationProposalDTO>;
	recover(input: WorkspaceAgentCommitRecoveryInput): Promise<AgentSessionIntegrationProposalDTO>;
	confirmProposal(sender: WebContents, proposal: AgentSessionIntegrationProposalDTO): Promise<boolean>;
}

/** Host-only merge proposal operations. Human confirmation remains a native dialog capability. */
export interface WorkspaceAgentMergeHost {
	prepare(input: WorkspaceAgentMergePrepareInput): Promise<AgentSessionMergeProposalDTO>;
	list(input: WorkspaceAgentMergeProposalPageInput): WorkspaceAgentMergeProposalPageDTO | Promise<WorkspaceAgentMergeProposalPageDTO>;
	approve(input: WorkspaceAgentMergeProposalMutationInput): AgentSessionMergeProposalDTO['approval'];
	apply(input: WorkspaceAgentMergeProposalMutationInput): Promise<AgentSessionMergeProposalDTO>;
	reconcile(input: WorkspaceAgentMergeProposalRecoveryInput): Promise<AgentSessionMergeProposalDTO>;
	confirmProposal(sender: WebContents, proposal: AgentSessionMergeProposalDTO): Promise<boolean>;
}

/** Publication provider access is main-process only; renderer input can never grant approval. */
export interface WorkspaceAgentPublicationHost {
	listAccounts(scope: WorkspaceAgentPublicationScope, assertCurrent: () => void): Promise<WorkspaceAgentPublicationAccountsDTO>;
	list(input: WorkspaceAgentPublicationPageInput): AgentSessionPublicationPageDTO | Promise<AgentSessionPublicationPageDTO>;
	prepare(input: AgentSessionPublicationPrepareInput, assertCurrent: () => void): Promise<AgentSessionPublicationProposalDTO>;
	approve(input: WorkspaceAgentPublicationMutationInput): AgentSessionPublicationProposalDTO;
	publish(input: WorkspaceAgentPublicationMutationInput, assertCurrent: () => void): Promise<WorkspaceAgentPublicationExecutionDTO>;
	continue(input: WorkspaceAgentPublicationRecoveryInput, assertCurrent: () => void): Promise<WorkspaceAgentPublicationExecutionDTO>;
	reconcile(input: WorkspaceAgentPublicationRecoveryInput, assertCurrent: () => void): Promise<WorkspaceAgentPublicationExecutionDTO>;
	readOperation(input: WorkspaceAgentPublicationMutationInput): AgentSessionPublicationOperationDTO | null;
	confirmProposal(sender: WebContents, proposal: AgentSessionPublicationProposalDTO): Promise<boolean>;
}

/** Project-scoped IPC for durable sessions and host-owned PTY capabilities. */
export class WorkspaceAgentSessionsChannel {
	private readonly attachments = new Map<string, ScopedAttachment>();
	private readonly attachmentReservations = new Map<string, AttachmentReservation>();
	private readonly senderScopes = new Map<number, SenderScope>();

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly windowsMainService: IWindowsMainService,
		private readonly service?: AgentSessionService,
		private readonly prepareCreatedSession?: (projectId: string, sessionId: string) => Promise<WorkspaceAgentSessionWorkspacePreparationDTO>,
		private readonly normalizeProfileRef?: (provider: AgentSessionProvider, profileRef: string | undefined) => string,
		private readonly workspacePreparation?: (projectId: string, sessionId: string) => Promise<WorkspaceAgentSessionWorkspacePreparationDTO>,
		private readonly prepareWorkspace?: (projectId: string, sessionId: string) => Promise<WorkspaceAgentSessionWorkspacePreparationDTO>,
		private readonly workflowHost?: WorkspaceAgentWorkflowHost,
		private readonly commitHost?: WorkspaceAgentCommitHost,
		private readonly mergeHost?: WorkspaceAgentMergeHost,
		private readonly publicationHost?: WorkspaceAgentPublicationHost,
	) { }

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		const projectId = this.authorize(sender);
		switch (command) {
			case 'listSessions': {
				this.assertProjectRequest(arg, projectId);
				return this.database.agentSessions.listSessions(projectId) as T;
			}
			case 'listWorkflows': {
				const request = this.record(arg);
				this.assertProjectId(request.projectId, projectId);
				return this.database.agentWorkflows.listWorkflows(projectId, {
					...(request.afterId !== undefined ? { afterId: this.uuid(request.afterId, 'workflow cursor') } : {}),
					limit: request.limit === undefined ? 50 : this.integer(request.limit, 1, 100, 'workflow page limit'),
				}) as T;
			}
			case 'getWorkflow': {
				const request = this.parseWorkflowRequest(arg, projectId);
				return this.workflowStatus(projectId, request.workflowId) as T;
			}
			case 'createWorkflow': {
				const request = this.record(arg);
				const plan = this.parseWorkflowPlan(request, projectId);
				const workflow = this.database.agentWorkflows.createWorkflow(projectId, { ...plan, idempotencyKey: this.string(request.idempotencyKey, 'workflow retry key', 128) });
				return this.workflowStatus(projectId, workflow.id) as T;
			}
			case 'reviseWorkflow': {
				const request = this.parseWorkflowMutation(arg, projectId);
				const plan = this.parseWorkflowPlan(this.record(arg).plan, projectId);
				this.database.agentWorkflows.reviseWorkflowPlan(projectId, request.workflowId, request.expectedRevision, plan);
				return this.workflowStatus(projectId, request.workflowId) as T;
			}
			case 'approveWorkflow': {
				const request = this.parseWorkflowMutation(arg, projectId);
				const raw = this.record(arg);
				const planVersion = this.integer(raw.planVersion, 1, Number.MAX_SAFE_INTEGER, 'workflow plan version');
				const fingerprint = this.string(raw.fingerprint, 'workflow plan fingerprint', 64);
				const key = this.string(raw.idempotencyKey, 'workflow approval retry key', 128);
				const before = this.workflowStatus(projectId, request.workflowId);
				if (before.workflow.revision !== request.expectedRevision || before.plan.version !== planVersion || before.plan.fingerprint !== fingerprint) { throw new Error('The workflow plan changed; review its current version before approval.'); }
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const approved = await this.requireWorkflowHost().confirmPlan(sender, before.plan);
					this.assertScopeCurrent(scope);
					const current = this.workflowStatus(projectId, request.workflowId);
					if (current.workflow.revision !== request.expectedRevision || current.plan.version !== planVersion || current.plan.fingerprint !== fingerprint) { throw new Error('The workflow plan changed while its approval dialog was open.'); }
					if (approved) { this.database.agentWorkflows.recordTrustedUiApproval(projectId, request.workflowId, planVersion, fingerprint, key); }
					return { approved, status: this.workflowStatus(projectId, request.workflowId) } as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'startWorkflow': {
				const request = this.parseWorkflowMutation(arg, projectId);
				const key = this.string(this.record(arg).idempotencyKey, 'workflow start retry key', 128);
				const host = this.requireWorkflowHost();
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const startedRun = await host.start(projectId, request.workflowId, request.expectedRevision, key);
					try { this.assertScopeCurrent(scope); }
					catch (scopeError) {
						const current = this.workflowStatus(projectId, request.workflowId);
						if (current.run?.id === startedRun.id && current.run.planVersion === startedRun.planVersion && current.run.fingerprint === startedRun.fingerprint) {
							await host.cancel(projectId, request.workflowId, current.workflow.revision, randomUUID());
						}
						throw scopeError;
					}
					return this.workflowStatus(projectId, request.workflowId) as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'cancelWorkflow': {
				const request = this.parseWorkflowMutation(arg, projectId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					await this.requireWorkflowHost().cancel(projectId, request.workflowId, request.expectedRevision, this.string(this.record(arg).idempotencyKey, 'workflow cancellation retry key', 128));
					this.assertScopeCurrent(scope);
					return this.workflowStatus(projectId, request.workflowId) as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'createSession': {
				const parsed = this.parseCreate(arg, projectId);
				const request = this.normalizeProfileRef ? { ...parsed, profileRef: this.normalizeProfileRef(parsed.provider, parsed.profileRef) } : parsed;
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const session = this.database.agentSessions.createSession(request);
					if (this.prepareCreatedSession) { await this.prepareCreatedSession(projectId, session.id); }
					this.assertScopeCurrent(scope);
					return session as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'workspacePreparation': {
				const request = this.parseSessionRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const status = await this.requireWorkspacePreparationHook(this.workspacePreparation)(projectId, request.sessionId);
					this.assertScopeCurrent(scope);
					return status as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'prepareWorkspace': {
				const request = this.parseSessionRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const status = await this.requireWorkspacePreparationHook(this.prepareWorkspace)(projectId, request.sessionId);
					this.assertScopeCurrent(scope);
					return status as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'listTurns': {
				const request = this.parseSessionRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				return this.database.agentSessionTurns.listTurns(projectId, request.sessionId) as T;
			}
			case 'readTranscript': {
				const request = this.parseTurnRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const options = this.parseTranscriptOptions(this.record(arg).options);
				return this.database.agentSessionTranscripts.readPage(projectId, request.sessionId, request.turnId, options) as T;
			}
			case 'getLatestChangeEvidence': {
				const request = this.parseChangeScope(arg, projectId, ['projectId', 'sessionId', 'turnId']);
				this.requireSession(projectId, request.sessionId);
				const result = this.database.agentSessionChangeEvidence.getLatest(projectId, request.sessionId, request.turnId) ?? null;
				if (result && (result.projectId !== projectId || result.sessionId !== request.sessionId || result.turnId !== request.turnId)) { throw new Error('Change evidence response scope does not match the request.'); }
				return result as T;
			}
			case 'listChangeEvidence': {
				const request = this.parseChangeScope(arg, projectId, ['projectId', 'sessionId', 'turnId', 'afterVersion', 'beforeVersion', 'limit']);
				this.requireSession(projectId, request.sessionId);
				const raw = this.record(arg);
				if (raw.afterVersion !== undefined && raw.beforeVersion !== undefined) { throw new Error('Change evidence paging accepts either beforeVersion or afterVersion, not both.'); }
				const page = this.database.agentSessionChangeEvidence.listVersions(projectId, request.sessionId, request.turnId, {
					...(raw.beforeVersion !== undefined ? { beforeVersion: this.integer(raw.beforeVersion, 1, MAX_SEQUENCE, 'change evidence cursor') }
						: { afterVersion: raw.afterVersion === undefined ? 0 : this.integer(raw.afterVersion, 0, MAX_SEQUENCE, 'change evidence cursor') }),
					limit: raw.limit === undefined ? 50 : this.integer(raw.limit, 1, 100, 'change evidence page limit'),
				});
				if (page.snapshots.some(item => item.projectId !== projectId || item.sessionId !== request.sessionId || item.turnId !== request.turnId)) { throw new Error('Change evidence page contains an out-of-scope snapshot.'); }
				return page as T;
			}
			case 'getChangeFile': {
				const request = this.parseChangeScope(arg, projectId, ['projectId', 'sessionId', 'turnId', 'evidenceVersion', 'fingerprint', 'path']);
				this.requireSession(projectId, request.sessionId);
				const raw = this.record(arg);
				const evidenceVersion = this.integer(raw.evidenceVersion, 1, MAX_SEQUENCE, 'change evidence version');
				const fingerprint = this.string(raw.fingerprint, 'change evidence fingerprint', 64);
				if (!/^[0-9a-f]{64}$/i.test(fingerprint)) { throw new Error('A valid change evidence fingerprint is required.'); }
				const path = this.safeChangePath(raw.path);
				const page = this.database.agentSessionChangeEvidence.listVersions(projectId, request.sessionId, request.turnId, { afterVersion: evidenceVersion - 1, limit: 1 });
				const selected = page.snapshots[0];
				if (!selected || selected.version !== evidenceVersion || selected.fingerprint !== fingerprint) { throw new Error('The selected change evidence version is unavailable or has changed.'); }
				if (!selected.files.some(file => file.path === path || file.previousPath === path)) { throw new Error('The requested path is not part of the selected change evidence.'); }
				const scope = { projectId, sessionId: request.sessionId, turnId: request.turnId };
				const result = this.database.agentSessionContents.getFile({ scope, evidenceVersion, path });
				if (!result) { return null as T; }
				if (result.scope.projectId !== projectId || result.scope.sessionId !== request.sessionId || result.scope.turnId !== request.turnId
					|| result.evidenceVersion !== evidenceVersion || result.path !== path || result.evidenceFingerprint !== fingerprint) {
					throw new Error('Retained file content does not match the selected change evidence.');
				}
				return result as WorkspaceAgentChangeFileDTO as T;
			}
			case 'getChangeHunks': {
				const request = this.parseChangeScope(arg, projectId, ['projectId', 'sessionId', 'turnId', 'evidenceVersion', 'fingerprint', 'path']);
				this.requireSession(projectId, request.sessionId);
				const raw = this.record(arg);
				const evidenceVersion = this.integer(raw.evidenceVersion, 1, MAX_SEQUENCE, 'change evidence version');
				const fingerprint = this.changeFingerprint(raw.fingerprint);
				const path = this.safeChangePath(raw.path);
				const file = this.getExactChangeFile(projectId, request.sessionId, request.turnId, evidenceVersion, fingerprint, path);
				return (file ? computeAgentSessionChangeHunks(file) : null) as T;
			}
			case 'getLatestChangeExplanation': {
				const target = this.parseExplanationTarget(arg, projectId);
				this.requireSession(projectId, target.sessionId);
				return (this.database.agentSessionReviews.getLatest(target) ?? null) as T;
			}
			case 'listChangeExplanationRevisions': {
				const raw = this.record(arg);
				const target = this.parseExplanationTarget(arg, projectId, ['afterRevision', 'limit'], ['afterRevision', 'limit']);
				this.requireSession(projectId, target.sessionId);
				const page = this.database.agentSessionReviews.listRevisions({ target, ...(raw.afterRevision === undefined ? {} : { afterRevision: this.integer(raw.afterRevision, 0, MAX_SEQUENCE, 'explanation revision cursor') }), ...(raw.limit === undefined ? {} : { limit: this.integer(raw.limit, 1, 100, 'explanation revision page limit') }) });
				if (page.revisions.some(item => !sameExplanationTarget(item.target, target))) { throw new Error('Explanation revision page contains an out-of-scope target.'); }
				return page as T;
			}
			case 'recordHumanChangeExplanation': {
				const raw = this.record(arg);
				const target = this.parseExplanationTarget(arg, projectId, ['expectedLatestRevision', 'what', 'why', 'citations', 'checkClaims', 'status']);
				this.requireSession(projectId, target.sessionId);
				if (target.hunkId !== null) { this.requireExactExplanationHunk(target); }
				const result = this.database.agentSessionReviews.recordHumanExplanation({
					target, expectedLatestRevision: this.integer(raw.expectedLatestRevision, 0, MAX_SEQUENCE, 'expected explanation revision'),
					what: raw.what as string, why: raw.why as string, citations: raw.citations as readonly WorkspaceAgentExplanationCitationDTO[],
					checkClaims: raw.checkClaims as readonly WorkspaceAgentReportedCheckDTO[], status: raw.status as 'draft' | 'confirmed',
				});
				if (!sameExplanationTarget(result.target, target) || result.actor !== 'human' || result.authorTurnId !== null || result.verification !== 'unverified') { throw new Error('Human explanation response contains invalid authority or scope.'); }
				return result as T;
			}
			case 'listCommitProposals': {
				const request = this.parseCommitProposalPage(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const page = this.database.agentSessionIntegrations.listProposals(projectId, request.sessionId, request.turnId, {
					...(request.afterRevision !== undefined ? { afterRevision: request.afterRevision } : {}),
					...(request.limit !== undefined ? { limit: request.limit } : {}),
				});
				if (page.proposals.some(proposal => !this.sameCommitScope(proposal, request))) { throw new Error('Commit proposal page contains an out-of-scope proposal.'); }
				return page as T;
			}
			case 'prepareCommitProposal': {
				const request = this.parseCommitPrepare(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const proposal = await this.requireCommitHost().prepare(request);
					this.assertScopeCurrent(scope);
					if (!this.sameCommitScope(proposal, request) || proposal.evidenceVersion !== request.evidenceVersion || proposal.evidenceFingerprint !== request.evidenceFingerprint) { throw new Error('Prepared commit proposal does not match its requested evidence scope.'); }
					return proposal as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'approveCommitProposal': {
				const request = this.parseCommitProposalMutation(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const before = this.requireCommitProposal(request);
				this.assertCommitProposalCurrent(before);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const approved = await this.requireCommitHost().confirmProposal(sender, before);
					this.assertScopeCurrent(scope);
					const current = this.requireCommitProposal(request);
					if (current.revision !== request.expectedRevision || current.fingerprint !== request.expectedFingerprint || current.id !== before.id) { throw new Error('The commit proposal changed while its approval dialog was open.'); }
					this.assertCommitProposalCurrent(current);
					if (approved) { this.requireCommitHost().approve(this.commitProposalInput(request)); }
					return { approved, proposal: this.requireCommitProposal(request) } as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'applyCommitProposal': {
				const request = this.parseCommitProposalMutation(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				this.requireCommitProposal(request);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const proposal = await this.requireCommitHost().apply(this.commitProposalInput(request));
					this.assertScopeCurrent(scope);
					if (!this.sameCommitScope(proposal, request)) { throw new Error('Commit result scope does not match the approved proposal.'); }
					return proposal as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'recoverCommitProposal': {
				const request = this.parseCommitRecovery(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				this.requireCommitProposal(request);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const proposal = await this.requireCommitHost().recover(request);
					this.assertScopeCurrent(scope);
					if (!this.sameCommitScope(proposal, request)) { throw new Error('Commit recovery scope does not match the approved proposal.'); }
					return proposal as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'listMergeProposals': {
				const request = this.parseMergeProposalPage(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const page = await this.requireMergeHost().list(request);
					this.assertScopeCurrent(scope);
					if (page.proposals.some(proposal => !this.sameMergeScope(proposal, request))) { throw new Error('Merge proposal page contains an out-of-scope proposal.'); }
					return page as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'prepareMergeProposal': {
				const request = this.parseMergePrepare(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const proposal = await this.requireMergeHost().prepare(request);
					this.assertScopeCurrent(scope);
					if (!this.sameMergeScope(proposal, request) || proposal.commitProposalId !== request.commitProposalId) { throw new Error('Prepared merge proposal does not match its requested scope and source commit.'); }
					return proposal as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'approveMergeProposal': {
				const request = this.parseMergeProposalMutation(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const before = this.requireMergeProposal(request);
				if (before.approval?.proposalFingerprint === before.fingerprint) { return { approved: true, proposal: before } as T; }
				this.assertMergeProposalCurrent(before);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const approved = await this.requireMergeHost().confirmProposal(sender, before);
					this.assertScopeCurrent(scope);
					const current = this.requireMergeProposal(request);
					if (current.id !== before.id || current.revision !== before.revision || current.fingerprint !== before.fingerprint) { throw new Error('The merge proposal changed while its approval dialog was open.'); }
					this.assertMergeProposalCurrent(current);
					if (approved) { this.requireMergeHost().approve(this.mergeProposalInput(request)); }
					return { approved, proposal: this.requireMergeProposal(request) } as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'applyMergeProposal': {
				const request = this.parseMergeProposalMutation(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				this.requireMergeProposal(request);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const proposal = await this.requireMergeHost().apply(this.mergeProposalInput(request));
					this.assertScopeCurrent(scope);
					if (!this.sameMergeScope(proposal, request) || proposal.id !== request.proposalId || proposal.revision !== request.expectedRevision || proposal.fingerprint !== request.expectedFingerprint) { throw new Error('Merge result does not match the exact approved proposal.'); }
					return proposal as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'reconcileMergeProposal': {
				const request = this.parseMergeRecovery(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				this.requireMergeProposal(request);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const proposal = await this.requireMergeHost().reconcile(request);
					this.assertScopeCurrent(scope);
					if (!this.sameMergeScope(proposal, request) || proposal.id !== request.proposalId || proposal.revision !== request.expectedRevision || proposal.fingerprint !== request.expectedFingerprint) { throw new Error('Merge recovery result does not match the exact approved proposal.'); }
					return proposal as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'listPublicationAccounts': {
				const request = this.parsePublicationScope(arg, projectId);
				this.requirePublicationScope(request);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const accounts = await this.requirePublicationHost().listAccounts(request, () => this.assertScopeCurrent(scope));
					this.assertScopeCurrent(scope);
					return this.validatePublicationAccounts(accounts) as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'listPublicationProposals': {
				const request = this.parsePublicationPage(arg, projectId);
				this.requirePublicationScope(request);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const page = await this.requirePublicationHost().list(request);
					this.assertScopeCurrent(scope);
					const authoritative = this.database.agentSessionPublications.listProposals(request.projectId, request.sessionId, request.turnId, {
						...(request.afterRevision === undefined ? {} : { afterRevision: request.afterRevision }),
						...(request.limit === undefined ? {} : { limit: request.limit }),
					});
					if (!isDeepStrictEqual(page, authoritative)) { throw new Error('Publication proposal page does not match authoritative persisted records.'); }
					return authoritative as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'preparePublicationProposal': {
				const request = this.parsePublicationPrepare(arg, projectId);
				this.requirePublicationScope(request);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const proposal = await this.requirePublicationHost().prepare(request, () => this.assertScopeCurrent(scope));
					this.assertScopeCurrent(scope);
					return this.assertPublicationProposalResponse(proposal, { ...request, expectedRevision: request.expectedRevision + 1 }, { sourceMergeId: request.sourceMergeId }) as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'approvePublicationProposal': {
				const request = this.parsePublicationMutation(arg, projectId);
				this.requirePublicationScope(request);
				const before = this.requirePublicationProposal(request);
				if (before.approval?.proposalFingerprint === before.fingerprint) {
					return { approved: true, proposal: before } as T;
				}
				this.assertPublicationProposalCurrent(before);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const confirmed = await this.requirePublicationHost().confirmProposal(sender, before);
					this.assertScopeCurrent(scope);
					const current = this.requirePublicationProposal(request);
					if (current.id !== before.id || current.revision !== before.revision || current.fingerprint !== before.fingerprint) {
						throw new Error('The publication proposal changed while its approval dialog was open.');
					}
					this.assertPublicationProposalCurrent(current);
					if (!confirmed) { return { approved: false, proposal: current } as T; }
					const returned = this.requirePublicationHost().approve(this.publicationMutationInput(request));
					this.assertScopeCurrent(scope);
					const approved = this.requirePublicationProposal(request);
					if (approved.approval?.actor !== 'human' || approved.approval.proposalFingerprint !== approved.fingerprint) {
						throw new Error('Publication approval did not persist trusted human authority for the exact proposal.');
					}
					this.assertPublicationProposalResponse(returned, request);
					return { approved: true, proposal: approved } as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'publishApprovedProposal': {
				const request = this.parsePublicationMutation(arg, projectId);
				this.requirePublicationScope(request);
				const before = this.requirePublicationProposal(request);
				this.assertPublicationProposalCurrent(before);
				if (before.approval?.proposalFingerprint !== before.fingerprint) { throw new Error('A trusted human approval for this exact publication proposal is required.'); }
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const result = await this.requirePublicationHost().publish(this.publicationMutationInput(request), () => this.assertScopeCurrent(scope));
					this.assertScopeCurrent(scope);
					return this.assertPublicationExecutionResponse(result, request) as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'getPublicationOperation': {
				const request = this.parsePublicationMutation(arg, projectId);
				this.requirePublicationScope(request);
				this.requirePublicationProposal(request);
				const operation = this.requirePublicationHost().readOperation(request);
				if (operation === null) { return null as T; }
				const proposal = this.requirePublicationProposal(request);
				const authoritative = this.database.agentSessionPublications.readOperation(operation.id);
				if (!isDeepStrictEqual(operation, authoritative) || operation.proposalId !== proposal.id || operation.proposalFingerprint !== proposal.fingerprint) {
					throw new Error('Publication operation does not match authoritative persisted data for this exact proposal.');
				}
				return operation as T;
			}
			case 'continuePublicationOperation':
			case 'reconcilePublicationOperation': {
				const request = this.parsePublicationRecovery(arg, projectId);
				this.requirePublicationScope(request);
				this.requirePublicationProposal(request);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const host = this.requirePublicationHost();
					const result = command === 'continuePublicationOperation'
						? await host.continue(request, () => this.assertScopeCurrent(scope))
						: await host.reconcile(request, () => this.assertScopeCurrent(scope));
					this.assertScopeCurrent(scope);
					return this.assertPublicationExecutionResponse(result, request) as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'listNotifications': {
				const request = this.record(arg);
				this.assertProjectId(request.projectId, projectId);
				return this.database.agentSessions.listNotifications(projectId, {
					afterSequence: request.afterSequence === undefined ? 0 : this.sequence(request.afterSequence, 'notification cursor'),
					limit: request.limit === undefined ? 50 : this.integer(request.limit, 1, 100, 'notification page limit'),
				}) as T;
			}
			case 'notificationStatus': {
				const request = this.record(arg);
				this.assertProjectId(request.projectId, projectId);
				return this.database.agentSessions.notificationStatus(projectId) as T;
			}
			case 'listMessages': {
				const request = this.parseSessionRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const raw = this.record(arg);
				const afterSequence = raw.afterSequence === undefined ? 0 : this.sequence(raw.afterSequence, 'mailbox cursor');
				const limit = raw.limit === undefined ? 50 : this.integer(raw.limit, 1, 100, 'mailbox page limit');
				const source = this.database.agentSessions.listInbox(projectId, request.sessionId, { afterSequence, limit });
				const messages: WorkspaceAgentSessionMailboxPage['messages'][number][] = [];
				const envelopeBytes = Buffer.byteLength(JSON.stringify({ messages: [], nextCursor: Number.MAX_SAFE_INTEGER, hasMore: false }), 'utf8');
				let outputBytes = envelopeBytes;
				for (const message of source) {
					const item = projectMailboxMessage(message);
					const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
					if (envelopeBytes + bytes > MAX_MAILBOX_PAGE_BYTES) { throw new Error('A stored message exceeds the mailbox response byte limit.'); }
					const separatorBytes = messages.length > 0 ? 1 : 0;
					if (outputBytes + separatorBytes + bytes > MAX_MAILBOX_PAGE_BYTES) { break; }
					messages.push(item);
					outputBytes += separatorBytes + bytes;
				}
				const page: WorkspaceAgentSessionMailboxPage = {
					messages,
					nextCursor: messages.at(-1)?.sequence ?? afterSequence,
					hasMore: messages.length < source.length || source.length === limit,
				};
				return page as T;
			}
			case 'getMessage': {
				const request = this.parseSessionRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const messageId = this.uuid(this.record(arg).messageId, 'message ID');
				const message = this.database.agentSessions.getInboxMessage(projectId, request.sessionId, messageId);
				return (message ? projectMailboxMessage(message) : null) as T;
			}
			case 'markNotificationRead': {
				const request = this.record(arg);
				this.assertProjectId(request.projectId, projectId);
				this.database.agentSessions.markNotificationRead(projectId, this.uuid(request.notificationId, 'notification ID'));
				return undefined as T;
			}
			case 'preview': {
				const request = this.parsePreview(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const preview = await this.requireService().preview(request);
					this.assertScopeCurrent(scope);
					return preview as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'start': {
				const request = this.parseStart(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const turn = await this.requireService().start(request);
					if (!this.isScopeCurrent(scope)) {
						let stopped: Awaited<ReturnType<AgentSessionService['stop']>>;
						try { stopped = await this.requireService().stop(projectId, request.sessionId, turn.id); }
						catch (error) {
							throw new Error(`The project window changed after turn ${turn.id} started; exact-turn cleanup failed: ${this.errorMessage(error)}`);
						}
						throw new Error(`The project window changed after turn ${turn.id} started; the exact turn was stopped (cleanup verified: ${stopped.cleanupVerified}).`);
					}
					return turn as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'stop': {
				const request = this.parseTurnRequest(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					const turn = await this.requireService().stop(projectId, request.sessionId, request.turnId);
					this.assertScopeCurrent(scope);
					return turn as T;
				} finally { this.finishScopedOperation(scope); }
			}
			case 'attach': {
				const request = this.parseAttach(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				let reservationId: string | undefined;
				let latestObservedSequence = request.afterSequence ?? 0;
				let result: AgentSessionAttachResult | undefined;
				try {
					const reservedId = this.reserveAttachment(sender, projectId, request.sessionId, request.turnId);
					reservationId = reservedId;
					result = await this.requireService().attach(projectId, request.sessionId, request.turnId, chunk => {
						latestObservedSequence = Math.max(latestObservedSequence, chunk.sequence);
						const active = result && this.attachments.get(result.attachmentId);
						if (active && this.isScopeCurrent(scope)) { this.sendAttachmentChunk(active, chunk); }
					}, request.afterSequence);
					if (!this.isScopeCurrent(scope)) {
						this.requireService().detach(projectId, request.sessionId, request.turnId, result.attachmentId);
						throw new Error('The project window changed while the output attachment was being created.');
					}
					this.trackAttachment(sender, projectId, request.sessionId, request.turnId, reservedId, result);
					reservationId = undefined;
					this.catchUpAttachment(result, latestObservedSequence);
					return result as T;
				} catch (error) {
					if (result && this.attachments.has(result.attachmentId)) { this.disconnectAttachment(sender, result.attachmentId); }
					throw error;
				} finally {
					if (reservationId) { this.releaseAttachmentReservation(reservationId); }
					this.finishScopedOperation(scope);
				}
			}
			case 'read': {
				const request = this.parseRead(arg, projectId);
				this.requireAttachment(sender, request);
				return this.requireService().read(projectId, request.sessionId, request.turnId, request.attachmentId, request.afterSequence, request.limit) as T;
			}
			case 'write': {
				const request = this.parseWrite(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try {
					this.assertScopeCurrent(scope);
					if (request.text.length === 0) { return undefined as T; }
					await this.requireService().write(projectId, request.sessionId, request.turnId, request.text);
					this.assertScopeCurrent(scope);
					return undefined as T;
				}
				finally { this.finishScopedOperation(scope); }
			}
			case 'resize': {
				const request = this.parseResize(arg, projectId);
				this.requireSession(projectId, request.sessionId);
				const scope = this.beginScopedOperation(sender, projectId);
				try { this.assertScopeCurrent(scope); await this.requireService().resize(projectId, request.sessionId, request.turnId, request.cols, request.rows); this.assertScopeCurrent(scope); return undefined as T; }
				finally { this.finishScopedOperation(scope); }
			}
			case 'disconnect': {
				const request = this.parseDisconnect(arg, projectId);
				this.requireAttachment(sender, request);
				this.disconnectAttachment(sender, request.attachmentId);
				return undefined as T;
			}
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	private authorize(sender: WebContents): string { return this.authorizeScope(sender).projectId; }

	private authorizeScope(sender: WebContents): { readonly projectId: string; readonly descriptorUri: string } {
		if (!sender || typeof sender !== 'object' || sender.isDestroyed()) { throw new Error('A live IPC sender is required.'); }
		const window = this.windowsMainService.getWindowByWebContents(sender);
		if (!window?.config || window.config.reviewWindowLaunch.kind !== 'project') { throw new Error('This operation requires an open project window.'); }
		const projectId = window.config.reviewWindowLaunch.projectId;
		if (!isUUID(projectId) || !this.database.getProject(projectId)) { throw new Error('The project window has an invalid or unavailable project ID.'); }
		const view = this.database.getProjectView(projectId);
		const openedWorkspace = window.openedWorkspace;
		const descriptorUri = openedWorkspace && 'configPath' in openedWorkspace ? openedWorkspace.configPath.toString() : undefined;
		if (!view || !descriptorUri || descriptorUri !== view.descriptorUri) { throw new Error('The open workspace does not match this project.'); }
		return { projectId, descriptorUri };
	}

	private beginScopedOperation(sender: WebContents, expectedProjectId: string): ScopeToken {
		const authorized = this.authorizeScope(sender);
		if (authorized.projectId !== expectedProjectId) { throw new Error('The requested project does not match this window.'); }
		let scope = this.senderScopes.get(sender.id);
		if (!scope) {
			scope = { sender, generation: 0, pendingOperations: 0 };
			this.senderScopes.set(sender.id, scope);
		}
		if ((scope.projectId && scope.projectId !== authorized.projectId) || (scope.descriptorUri && scope.descriptorUri !== authorized.descriptorUri)) {
			this.invalidateSender(scope);
		}
		scope.projectId = authorized.projectId;
		scope.descriptorUri = authorized.descriptorUri;
		this.ensureSenderListeners(scope);
		scope.pendingOperations++;
		return { scope, generation: scope.generation, projectId: authorized.projectId, descriptorUri: authorized.descriptorUri };
	}

	private ensureSenderListeners(scope: SenderScope): void {
		if (scope.disposeListeners) { return; }
		const invalidate = () => this.invalidateSender(scope);
		scope.sender.once('destroyed', invalidate);
		scope.sender.on('did-start-loading', invalidate);
		scope.sender.on('render-process-gone', invalidate);
		scope.disposeListeners = () => {
			scope.sender.removeListener('destroyed', invalidate);
			scope.sender.removeListener('did-start-loading', invalidate);
			scope.sender.removeListener('render-process-gone', invalidate);
			scope.disposeListeners = undefined;
		};
	}

	private invalidateSender(scope: SenderScope): void {
		scope.generation++;
		scope.projectId = undefined;
		scope.descriptorUri = undefined;
		for (const [id, attachment] of this.attachments) {
			if (attachment.owner === scope.sender) { this.disconnectAttachment(scope.sender, id); }
		}
		for (const [id, reservation] of this.attachmentReservations) {
			if (reservation.owner === scope.sender) { this.releaseAttachmentReservation(id); }
		}
		this.cleanupSenderScope(scope);
	}

	private finishScopedOperation(token: ScopeToken): void {
		token.scope.pendingOperations = Math.max(0, token.scope.pendingOperations - 1);
		this.cleanupSenderScope(token.scope);
	}

	private cleanupSenderScope(scope: SenderScope): void {
		if (scope.pendingOperations !== 0 || [...this.attachments.values()].some(attachment => attachment.owner === scope.sender)) { return; }
		scope.disposeListeners?.();
		this.senderScopes.delete(scope.sender.id);
	}

	private isScopeCurrent(token: ScopeToken): boolean {
		if (token.scope.generation !== token.generation || token.scope.projectId !== token.projectId
			|| token.scope.descriptorUri !== token.descriptorUri || token.scope.sender.isDestroyed()) { return false; }
		try {
			const current = this.authorizeScope(token.scope.sender);
			return current.projectId === token.projectId && current.descriptorUri === token.descriptorUri;
		} catch { return false; }
	}

	private assertScopeCurrent(token: ScopeToken): void {
		if (!this.isScopeCurrent(token)) { throw new Error('The project window changed while the session operation was pending.'); }
	}

	private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

	private requireService(): AgentSessionService {
		if (!this.service) { throw new Error('Interactive AI sessions are unavailable because no trusted PTY backend is registered.'); }
		return this.service;
	}

	private requireWorkspacePreparationHook(hook: ((projectId: string, sessionId: string) => Promise<WorkspaceAgentSessionWorkspacePreparationDTO>) | undefined): (projectId: string, sessionId: string) => Promise<WorkspaceAgentSessionWorkspacePreparationDTO> {
		if (!hook) { throw new Error('Session workspace preparation is unavailable because no trusted worktree service is registered.'); }
		return hook;
	}

	private requireSession(projectId: string, sessionId: string): void {
		if (!this.database.agentSessions.getSession(projectId, sessionId)) { throw new Error('The session does not belong to this project.'); }
	}

	private reserveAttachment(sender: WebContents, projectId: string, sessionId: string, turnId: string): string {
		const owned = (item: { owner: WebContents }) => item.owner === sender;
		const sameTurn = (item: { owner: WebContents; projectId: string; sessionId: string; turnId: string }) =>
			item.owner === sender && item.projectId === projectId && item.sessionId === sessionId && item.turnId === turnId;
		const windowCount = [...this.attachments.values()].filter(owned).length + [...this.attachmentReservations.values()].filter(owned).length;
		const turnCount = [...this.attachments.values()].filter(sameTurn).length + [...this.attachmentReservations.values()].filter(sameTurn).length;
		if (windowCount >= MAX_ATTACHMENTS_PER_WINDOW) { throw new Error('The project window already has the maximum number of live output attachments.'); }
		if (turnCount >= MAX_ATTACHMENTS_PER_TURN) { throw new Error('The turn already has the maximum number of live output attachments.'); }
		const reservationId = randomUUID();
		this.attachmentReservations.set(reservationId, { owner: sender, projectId, sessionId, turnId });
		return reservationId;
	}

	private releaseAttachmentReservation(reservationId: string): void { this.attachmentReservations.delete(reservationId); }

	private trackAttachment(sender: WebContents, projectId: string, sessionId: string, turnId: string, reservationId: string, result: AgentSessionAttachResult): void {
		const attachmentId = result.attachmentId;
		this.attachments.set(attachmentId, { attachmentId, projectId, sessionId, turnId, owner: sender, lastSentSequence: result.initialPage.cursor });
		this.releaseAttachmentReservation(reservationId);
	}

	private sendAttachmentChunk(attachment: ScopedAttachment, chunk: WorkspaceAgentSessionOutputEvent['chunk']): void {
		if (chunk.sequence <= attachment.lastSentSequence) { return; }
		const event: WorkspaceAgentSessionOutputEvent = {
			attachmentId: attachment.attachmentId,
			projectId: attachment.projectId, sessionId: attachment.sessionId, turnId: attachment.turnId, chunk,
		};
		try {
			if (!attachment.owner.isDestroyed()) { attachment.owner.send(WORKSPACE_AGENT_SESSIONS_OUTPUT_EVENT, event); }
			attachment.lastSentSequence = chunk.sequence;
		} catch { this.disconnectAttachment(attachment.owner, event.attachmentId); }
	}

	private catchUpAttachment(result: AgentSessionAttachResult, latestObservedSequence: number): void {
		const attachment = this.attachments.get(result.attachmentId);
		if (!attachment || latestObservedSequence <= attachment.lastSentSequence) { return; }
		let sent = 0;
		while (attachment.lastSentSequence < latestObservedSequence && sent < MAX_CATCH_UP_CHUNKS) {
			const cursorBeforeRead = attachment.lastSentSequence;
			const page = this.requireService().read(attachment.projectId, attachment.sessionId, attachment.turnId, result.attachmentId, cursorBeforeRead, CATCH_UP_READ_PAGE_SIZE);
			if (page.retentionGap) {
				const nextSequence = page.chunks[0]?.sequence;
				const gapSequence = nextSequence ? nextSequence - 1 : Math.max(attachment.lastSentSequence + 1, Math.min(latestObservedSequence, page.latestSequence));
				this.sendAttachmentChunk(attachment, { sequence: gapSequence, text: '', gap: true });
			}
			if (page.chunks.length === 0) { break; }
			for (const chunk of page.chunks) {
				if (chunk.sequence > latestObservedSequence || sent >= MAX_CATCH_UP_CHUNKS) { break; }
				this.sendAttachmentChunk(attachment, chunk);
				sent++;
			}
			if (attachment.lastSentSequence <= cursorBeforeRead) { break; }
		}
		if (attachment.lastSentSequence < latestObservedSequence) {
			this.sendAttachmentChunk(attachment, { sequence: latestObservedSequence, text: '', gap: true });
		}
	}

	private disconnectAttachment(sender: WebContents, attachmentId: string): void {
		const attachment = this.attachments.get(attachmentId);
		if (!attachment || attachment.owner !== sender) { return; }
		this.attachments.delete(attachmentId);
		try { this.service?.detach(attachment.projectId, attachment.sessionId, attachment.turnId, attachmentId); }
		catch (error) { console.error('Failed to revoke a project session attachment.', error); }
		const scope = this.senderScopes.get(sender.id);
		if (scope) { this.cleanupSenderScope(scope); }
	}

	private requireAttachment(sender: WebContents, request: { projectId: string; sessionId: string; turnId: string; attachmentId: string }): void {
		const attachment = this.attachments.get(request.attachmentId);
		if (!attachment || attachment.owner !== sender || attachment.projectId !== request.projectId
			|| attachment.sessionId !== request.sessionId || attachment.turnId !== request.turnId) {
			throw new Error('The output attachment is not owned by this project window and turn.');
		}
	}

	private assertProjectRequest(value: unknown, projectId: string): void {
		const request = this.record(value);
		this.assertProjectId(request.projectId, projectId);
	}

	private parseCreate(value: unknown, projectId: string): CreateAgentSessionInput {
		const request = this.record(value);
		this.assertProjectId(request.projectId, projectId);
		this.uuid(request.bindingId, 'binding ID');
		if (request.taskId !== undefined) { this.uuid(request.taskId, 'task ID'); }
		if (request.parentSessionId !== undefined) { this.uuid(request.parentSessionId, 'parent session ID'); }
		this.string(request.name, 'session name', 200);
		if (request.provider !== 'codex' && request.provider !== 'claude') { throw new Error('The provider is invalid.'); }
		this.string(request.model, 'model', 200);
		if (request.profileRef !== undefined) { this.string(request.profileRef, 'profile reference', 512); }
		if (request.workspaceMode !== 'gitWorktree' && request.workspaceMode !== 'sharedFolder') { throw new Error('The workspace mode is invalid.'); }
		return request as unknown as CreateAgentSessionInput;
	}

	private parsePreview(value: unknown, projectId: string) {
		const request = this.parseSessionRequest(value, projectId);
		const raw = this.record(value);
		const policy = this.parsePolicy(raw.permissionPolicy);
		return { ...request, permissionPolicy: policy };
	}

	private parseTranscriptOptions(value: unknown): AgentSessionTranscriptPageOptions {
		const raw = value === undefined ? {} : this.record(value);
		if (raw.kind !== undefined && raw.kind !== 'terminal' && raw.kind !== 'log') { throw new Error('The transcript kind is invalid.'); }
		if (raw.severity !== undefined && (typeof raw.severity !== 'string' || !['debug', 'info', 'warning', 'error'].includes(raw.severity))) { throw new Error('The transcript severity is invalid.'); }
		if (raw.source !== undefined && (typeof raw.source !== 'string' || !['pty', 'provider', 'host', 'workspace'].includes(raw.source))) { throw new Error('The transcript source is invalid.'); }
		return {
			afterSequence: raw.afterSequence === undefined ? 0 : this.sequence(raw.afterSequence, 'transcript cursor'),
			limit: raw.limit === undefined ? 50 : this.integer(raw.limit, 1, 100, 'transcript page limit'),
			maxOutputBytes: raw.maxOutputBytes === undefined ? 512 * 1024 : this.integer(raw.maxOutputBytes, 256 * 1024, 2 * 1024 * 1024, 'transcript byte budget'),
			...(raw.kind !== undefined ? { kind: raw.kind as AgentSessionTranscriptPageOptions['kind'] } : {}),
			...(raw.severity !== undefined ? { severity: raw.severity as AgentSessionTranscriptPageOptions['severity'] } : {}),
			...(raw.source !== undefined ? { source: raw.source as AgentSessionTranscriptPageOptions['source'] } : {}),
		};
	}

	private workflowStatus(projectId: string, workflowId: string): AgentWorkflowStatusDTO {
		const workflow = this.database.agentWorkflows.getWorkflow(projectId, workflowId);
		const plan = this.database.agentWorkflows.getPlan(projectId, workflowId);
		if (!workflow || !plan) { throw new Error('The workflow does not belong to this project.'); }
		const run = this.database.agentWorkflows.getLatestRun(projectId, workflowId) ?? null;
		return { workflow, plan, run, hostError: this.workflowHost?.getHostError(projectId, workflowId, run?.id) ?? null };
	}

	private requireCommitProposal(request: WorkspaceAgentCommitProposalInput): AgentSessionIntegrationProposalDTO {
		const proposal = this.database.agentSessionIntegrations.getProposal(request.proposalId);
		if (!proposal || !this.sameCommitScope(proposal, request) || proposal.revision !== request.expectedRevision || proposal.fingerprint !== request.expectedFingerprint) {
			throw new Error('Commit proposal is unavailable or changed; review its latest exact revision.');
		}
		return proposal;
	}

	private assertCommitProposalCurrent(proposal: AgentSessionIntegrationProposalDTO): void {
		if (Date.parse(proposal.expiresAt) <= Date.now()) { throw new Error('Commit proposal approval has expired. Prepare and review a fresh proposal.'); }
		const latestEvidence = this.database.agentSessionChangeEvidence.getLatest(proposal.projectId, proposal.sessionId, proposal.turnId);
		if (!latestEvidence || latestEvidence.version !== proposal.evidenceVersion || latestEvidence.fingerprint !== proposal.evidenceFingerprint) { throw new Error('Commit proposal evidence changed; review its current version.'); }
		const newer = this.database.agentSessionIntegrations.listProposals(proposal.projectId, proposal.sessionId, proposal.turnId, { afterRevision: proposal.revision, limit: 1 });
		if (newer.proposals.length) { throw new Error('A newer commit proposal exists; review that exact revision instead.'); }
	}

	private sameCommitScope(proposal: Pick<AgentSessionIntegrationProposalDTO, 'projectId' | 'sessionId' | 'turnId'>, request: Pick<WorkspaceAgentCommitProposalInput, 'projectId' | 'sessionId' | 'turnId'>): boolean {
		return proposal.projectId === request.projectId && proposal.sessionId === request.sessionId && proposal.turnId === request.turnId;
	}

	private commitProposalInput(request: WorkspaceAgentCommitProposalInput): WorkspaceAgentCommitProposalInput {
		return { projectId: request.projectId, sessionId: request.sessionId, turnId: request.turnId, proposalId: request.proposalId, expectedRevision: request.expectedRevision, expectedFingerprint: request.expectedFingerprint };
	}

	private requireCommitHost(): WorkspaceAgentCommitHost {
		if (!this.commitHost) { throw new Error('Reviewed commit operations are unavailable because no trusted host is registered.'); }
		return this.commitHost;
	}

	private requireMergeHost(): WorkspaceAgentMergeHost {
		if (!this.mergeHost) { throw new Error('Reviewed merge operations are unavailable because no trusted host is registered.'); }
		return this.mergeHost;
	}

	private requireMergeProposal(request: WorkspaceAgentMergeProposalMutationInput): AgentSessionMergeProposalDTO {
		const proposal = this.database.agentSessionMerges.getProposal(request.proposalId);
		if (!proposal || !this.sameMergeScope(proposal, request) || proposal.revision !== request.expectedRevision || proposal.fingerprint !== request.expectedFingerprint) {
			throw new Error('Merge proposal is unavailable or changed; review its latest exact revision.');
		}
		return proposal;
	}

	private assertMergeProposalCurrent(proposal: AgentSessionMergeProposalDTO): void {
		if (Date.parse(proposal.expiresAt) <= Date.now()) { throw new Error('Merge proposal approval has expired. Prepare and review a fresh proposal.'); }
		const newer = this.database.agentSessionMerges.listProposals(proposal.projectId, proposal.sessionId, proposal.turnId, { afterRevision: proposal.revision, limit: 1 });
		if (newer.proposals.length) { throw new Error('A newer merge proposal exists; review that exact revision instead.'); }
	}

	private sameMergeScope(proposal: Pick<AgentSessionMergeProposalDTO, 'projectId' | 'sessionId' | 'turnId'>, request: Pick<WorkspaceAgentMergeProposalPageInput, 'projectId' | 'sessionId' | 'turnId'>): boolean {
		return proposal.projectId === request.projectId && proposal.sessionId === request.sessionId && proposal.turnId === request.turnId;
	}

	private mergeProposalInput(request: WorkspaceAgentMergeProposalMutationInput): WorkspaceAgentMergeProposalMutationInput {
		return { projectId: request.projectId, sessionId: request.sessionId, turnId: request.turnId, proposalId: request.proposalId, expectedRevision: request.expectedRevision, expectedFingerprint: request.expectedFingerprint };
	}

	private requirePublicationHost(): WorkspaceAgentPublicationHost {
		if (!this.publicationHost) { throw new Error('The publication host is unavailable.'); }
		return this.publicationHost;
	}

	private requirePublicationScope(request: WorkspaceAgentPublicationScope): void {
		this.requireSession(request.projectId, request.sessionId);
		if (!this.database.agentSessionTurns.getTurn(request.projectId, request.sessionId, request.turnId)) { throw new Error('The turn does not belong to this project session.'); }
	}

	private requirePublicationProposal(request: WorkspaceAgentPublicationMutationInput): AgentSessionPublicationProposalDTO {
		const proposal = this.database.agentSessionPublications.getProposal(request.proposalId);
		if (!proposal || !this.samePublicationScope(proposal, request) || proposal.revision !== request.expectedRevision || proposal.fingerprint !== request.expectedFingerprint) {
			throw new Error('Publication proposal is unavailable or changed; review its latest exact revision.');
		}
		return proposal;
	}

	private assertPublicationProposalCurrent(proposal: AgentSessionPublicationProposalDTO): void {
		if (Date.parse(proposal.expiresAt) <= Date.now()) { throw new Error('Publication proposal approval has expired. Prepare and review a fresh proposal.'); }
		const newer = this.database.agentSessionPublications.listProposals(proposal.projectId, proposal.sessionId, proposal.turnId, { afterRevision: proposal.revision, limit: 1 });
		if (newer.proposals.length) { throw new Error('A newer publication proposal exists; review that exact revision instead.'); }
	}

	private samePublicationScope(proposal: Pick<AgentSessionPublicationProposalDTO, 'projectId' | 'sessionId' | 'turnId'>, request: WorkspaceAgentPublicationScope): boolean {
		return proposal.projectId === request.projectId && proposal.sessionId === request.sessionId && proposal.turnId === request.turnId;
	}

	private publicationMutationInput(request: WorkspaceAgentPublicationMutationInput): WorkspaceAgentPublicationMutationInput {
		return { projectId: request.projectId, sessionId: request.sessionId, turnId: request.turnId, proposalId: request.proposalId,
			expectedRevision: request.expectedRevision, expectedFingerprint: request.expectedFingerprint };
	}

	private assertPublicationProposalResponse(
		value: AgentSessionPublicationProposalDTO,
		request: WorkspaceAgentPublicationScope & { readonly proposalId?: string; readonly expectedRevision?: number; readonly expectedFingerprint?: string },
		expected: { readonly sourceMergeId?: string } = {},
	): AgentSessionPublicationProposalDTO {
		if (!value || typeof value !== 'object' || Array.isArray(value) || !isUUID(value.id)
			|| !this.samePublicationScope(value, request)
			|| (request.proposalId !== undefined && value.id !== request.proposalId)
			|| (request.expectedRevision !== undefined && value.revision !== request.expectedRevision)
			|| (request.expectedFingerprint !== undefined && value.fingerprint !== request.expectedFingerprint)
			|| (expected.sourceMergeId !== undefined && value.sourceMergeId !== expected.sourceMergeId)) {
			throw new Error('Publication host returned a proposal outside the exact requested scope and revision.');
		}
		const authoritative = this.database.agentSessionPublications.getProposal(value.id);
		if (!authoritative || !isDeepStrictEqual(value, authoritative)) { throw new Error('Publication host returned data that does not match the authoritative persisted proposal.'); }
		return authoritative;
	}

	private assertPublicationExecutionResponse(value: WorkspaceAgentPublicationExecutionDTO, request: WorkspaceAgentPublicationMutationInput): WorkspaceAgentPublicationExecutionDTO {
		if (!value || typeof value !== 'object' || Array.isArray(value) || !value.operation || typeof value.operation !== 'object' || Array.isArray(value.operation)
			|| !isUUID(value.operation.id) || value.operation.proposalId !== request.proposalId || value.operation.proposalFingerprint !== request.expectedFingerprint) {
			throw new Error('Publication host returned an operation outside the exact requested proposal.');
		}
		const proposal = this.assertPublicationProposalResponse(value.proposal, request);
		const operation = this.database.agentSessionPublications.readOperation(value.operation.id);
		if (operation.proposalId !== proposal.id || operation.proposalFingerprint !== proposal.fingerprint || !isDeepStrictEqual(value.operation, operation)) {
			throw new Error('Publication host returned an operation that does not match the authoritative persisted event chain.');
		}
		return { proposal, operation };
	}

	private validatePublicationAccounts(value: WorkspaceAgentPublicationAccountsDTO): WorkspaceAgentPublicationAccountsDTO {
		this.assertExactKeys(value, ['available', 'accounts', 'reason'], [], 'publication accounts response');
		if (typeof value.available !== 'boolean' || !Array.isArray(value.accounts) || value.accounts.length > 100
			|| (value.reason !== null && (typeof value.reason !== 'string'
				|| !/^GitHub 연결을 확인하지 못했습니다\. Git과 gh 로그인 상태를 확인해 주세요\. \((?:accountChanged|remoteChanged|baseChanged|permissionDenied|networkUncertain|providerFailed|invalidObservation|unavailable)\)$/u.test(value.reason)))) {
			throw new Error('Publication account response contains invalid metadata.');
		}
		const seen = new Set<string>();
		const accounts = value.accounts.map((account, index) => {
			this.assertExactKeys(account, ['accountRef', 'host', 'login', 'active', 'state'], [], `publication account ${index + 1}`);
			const accountRef = this.string(account.accountRef, 'publication account reference', 256);
			const login = this.string(account.login, 'publication account login', 256);
			if (!/^[A-Za-z0-9-]{1,39}$/u.test(login) || seen.has(accountRef) || account.host !== 'github.com' || typeof account.active !== 'boolean'
				|| !['success', 'timeout', 'error'].includes(String(account.state))) {
				throw new Error('Publication account response contains invalid or repeated account metadata.');
			}
			seen.add(accountRef);
			return { accountRef, host: 'github.com' as const, login, active: account.active, state: account.state as 'success' | 'timeout' | 'error' };
		});
		if ((value.available && value.reason !== null) || (!value.available && (value.reason === null || accounts.length !== 0))) {
			throw new Error('Publication account availability does not match its returned metadata.');
		}
		return { available: value.available, accounts, reason: value.reason };
	}

	private parsePublicationScope(value: unknown, authorizedProjectId: string): WorkspaceAgentPublicationScope {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId'], [], 'publication scope');
		return { projectId: this.assertProjectAndReturn(raw.projectId, authorizedProjectId), sessionId: this.uuid(raw.sessionId, 'publication session ID'), turnId: this.uuid(raw.turnId, 'publication turn ID') };
	}

	private parsePublicationPage(value: unknown, authorizedProjectId: string): WorkspaceAgentPublicationPageInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId'], ['afterRevision', 'limit'], 'publication proposal page');
		return { ...this.parsePublicationScope({ projectId: raw.projectId, sessionId: raw.sessionId, turnId: raw.turnId }, authorizedProjectId),
			...(raw.afterRevision === undefined ? {} : { afterRevision: this.integer(raw.afterRevision, 0, MAX_SEQUENCE, 'publication proposal cursor') }),
			...(raw.limit === undefined ? {} : { limit: this.integer(raw.limit, 1, AGENT_SESSION_PUBLICATION_HISTORY_LIMIT, 'publication proposal page limit') }) };
	}

	private parsePublicationPrepare(value: unknown, authorizedProjectId: string): AgentSessionPublicationPrepareInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId', 'sourceMergeId', 'remoteName', 'baseRef', 'accountRef', 'title', 'body', 'expectedRevision'], [], 'publication preparation');
		if (typeof raw.body !== 'string' || Buffer.byteLength(raw.body, 'utf8') > 64 * 1024) { throw new Error('The publication body is invalid or exceeds its size limit.'); }
		return { ...this.parsePublicationScope({ projectId: raw.projectId, sessionId: raw.sessionId, turnId: raw.turnId }, authorizedProjectId),
			sourceMergeId: this.uuid(raw.sourceMergeId, 'source merge proposal ID'), remoteName: this.string(raw.remoteName, 'publication remote name', 128),
			baseRef: this.string(raw.baseRef, 'publication base ref', 1024), accountRef: this.string(raw.accountRef, 'publication account reference', 256),
			title: this.string(raw.title, 'publication title', 256), body: raw.body,
			expectedRevision: this.integer(raw.expectedRevision, 0, MAX_SEQUENCE, 'publication proposal revision') };
	}

	private parsePublicationMutation(value: unknown, authorizedProjectId: string): WorkspaceAgentPublicationMutationInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId', 'proposalId', 'expectedRevision', 'expectedFingerprint'], [], 'publication proposal mutation');
		return { ...this.parsePublicationScope({ projectId: raw.projectId, sessionId: raw.sessionId, turnId: raw.turnId }, authorizedProjectId),
			proposalId: this.uuid(raw.proposalId, 'publication proposal ID'), expectedRevision: this.integer(raw.expectedRevision, 1, MAX_SEQUENCE, 'publication proposal revision'),
			expectedFingerprint: this.changeFingerprint(raw.expectedFingerprint) };
	}

	private parsePublicationRecovery(value: unknown, authorizedProjectId: string): WorkspaceAgentPublicationRecoveryInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId', 'proposalId', 'expectedRevision', 'expectedFingerprint', 'operationId'], [], 'publication operation recovery');
		return { ...this.parsePublicationMutation({ projectId: raw.projectId, sessionId: raw.sessionId, turnId: raw.turnId,
			proposalId: raw.proposalId, expectedRevision: raw.expectedRevision, expectedFingerprint: raw.expectedFingerprint }, authorizedProjectId),
			operationId: this.uuid(raw.operationId, 'publication operation ID') };
	}

	private parseMergeProposalPage(value: unknown, authorizedProjectId: string): WorkspaceAgentMergeProposalPageInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId'], ['afterRevision', 'limit'], 'merge proposal page');
		this.assertProjectId(raw.projectId, authorizedProjectId);
		return {
			projectId: authorizedProjectId, sessionId: this.uuid(raw.sessionId, 'merge session ID'), turnId: this.uuid(raw.turnId, 'merge turn ID'),
			...(raw.afterRevision === undefined ? {} : { afterRevision: this.integer(raw.afterRevision, 0, MAX_SEQUENCE, 'merge proposal cursor') }),
			...(raw.limit === undefined ? {} : { limit: this.integer(raw.limit, 1, AGENT_SESSION_MERGE_PROPOSAL_PAGE_LIMIT, 'merge proposal page limit') }),
		};
	}

	private parseMergePrepare(value: unknown, authorizedProjectId: string): WorkspaceAgentMergePrepareInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId', 'commitProposalId', 'expectedLatestRevision'], ['resolutionOfProposalId'], 'merge preparation');
		return {
			projectId: this.assertProjectAndReturn(raw.projectId, authorizedProjectId),
			sessionId: this.uuid(raw.sessionId, 'merge session ID'), turnId: this.uuid(raw.turnId, 'merge turn ID'),
			commitProposalId: this.uuid(raw.commitProposalId, 'source commit proposal ID'),
			expectedLatestRevision: this.integer(raw.expectedLatestRevision, 0, MAX_SEQUENCE, 'merge proposal revision'),
			...(raw.resolutionOfProposalId === undefined ? {} : { resolutionOfProposalId: this.uuid(raw.resolutionOfProposalId, 'resolution proposal ID') }),
		};
	}

	private parseMergeProposalMutation(value: unknown, authorizedProjectId: string): WorkspaceAgentMergeProposalMutationInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId', 'proposalId', 'expectedRevision', 'expectedFingerprint'], [], 'merge proposal mutation');
		return {
			projectId: this.assertProjectAndReturn(raw.projectId, authorizedProjectId), sessionId: this.uuid(raw.sessionId, 'merge session ID'), turnId: this.uuid(raw.turnId, 'merge turn ID'),
			proposalId: this.uuid(raw.proposalId, 'merge proposal ID'), expectedRevision: this.integer(raw.expectedRevision, 1, MAX_SEQUENCE, 'merge proposal revision'),
			expectedFingerprint: this.changeFingerprint(raw.expectedFingerprint),
		};
	}

	private parseMergeRecovery(value: unknown, authorizedProjectId: string): WorkspaceAgentMergeProposalRecoveryInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId', 'proposalId', 'expectedRevision', 'expectedFingerprint'], ['operationId'], 'merge recovery');
		return {
			...this.parseMergeProposalMutation({
				projectId: raw.projectId, sessionId: raw.sessionId, turnId: raw.turnId, proposalId: raw.proposalId,
				expectedRevision: raw.expectedRevision, expectedFingerprint: raw.expectedFingerprint,
			}, authorizedProjectId),
			...(raw.operationId === undefined ? {} : { operationId: this.uuid(raw.operationId, 'merge operation ID') }),
		};
	}

	private parseCommitProposalPage(value: unknown, authorizedProjectId: string): WorkspaceAgentCommitProposalPageInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId'], ['afterRevision', 'limit'], 'commit proposal page');
		this.assertProjectId(raw.projectId, authorizedProjectId);
		return {
			projectId: authorizedProjectId,
			sessionId: this.uuid(raw.sessionId, 'commit session ID'),
			turnId: this.uuid(raw.turnId, 'commit turn ID'),
			...(raw.afterRevision === undefined ? {} : { afterRevision: this.integer(raw.afterRevision, 0, MAX_SEQUENCE, 'commit proposal cursor') }),
			...(raw.limit === undefined ? {} : { limit: this.integer(raw.limit, 1, 100, 'commit proposal page limit') }),
		};
	}

	private parseCommitPrepare(value: unknown, authorizedProjectId: string): WorkspaceAgentCommitPrepareInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId', 'evidenceVersion', 'evidenceFingerprint', 'paths', 'commitMessage', 'expectedLatestRevision'], [], 'commit preparation');
		this.assertProjectId(raw.projectId, authorizedProjectId);
		if (!Array.isArray(raw.paths) || raw.paths.length < 1 || raw.paths.length > 300) { throw new Error('A commit proposal needs 1 to 300 selected evidence paths.'); }
		let targetCount = 0;
		const paths = raw.paths.map((value, pathIndex) => {
			const path = this.record(value);
			this.assertExactKeys(path, ['path', 'explanationTargets'], [], `commit path ${pathIndex + 1}`);
			const pathValue = this.safeChangePath(path.path);
			if (!Array.isArray(path.explanationTargets) || path.explanationTargets.length < 1) { throw new Error('Every selected commit path needs an explanation revision.'); }
			targetCount += path.explanationTargets.length;
			if (targetCount > 600) { throw new Error('A commit proposal selects too many explanation revisions.'); }
			return {
				path: pathValue,
				explanationTargets: path.explanationTargets.map((value, targetIndex) => {
					const target = this.record(value);
					this.assertExactKeys(target, ['path', 'hunkId', 'revision'], [], `commit explanation target ${targetIndex + 1}`);
					const targetPath = this.safeChangePath(target.path);
					if (targetPath !== pathValue || (target.hunkId !== null && (typeof target.hunkId !== 'string' || !/^[0-9a-f]{64}$/iu.test(target.hunkId)))) { throw new Error('Commit explanation target must match its selected path and valid hunk.'); }
					return { path: targetPath, hunkId: target.hunkId as string | null, revision: this.integer(target.revision, 1, MAX_SEQUENCE, 'explanation revision') };
				}),
			};
		});
		const evidenceFingerprint = this.string(raw.evidenceFingerprint, 'change evidence fingerprint', 64);
		if (!/^[0-9a-f]{64}$/iu.test(evidenceFingerprint)) { throw new Error('A valid change evidence fingerprint is required.'); }
		return {
			projectId: authorizedProjectId, sessionId: this.uuid(raw.sessionId, 'commit session ID'), turnId: this.uuid(raw.turnId, 'commit turn ID'),
			evidenceVersion: this.integer(raw.evidenceVersion, 1, MAX_SEQUENCE, 'change evidence version'), evidenceFingerprint,
			paths, commitMessage: this.string(raw.commitMessage, 'commit message', 1024),
			expectedLatestRevision: this.integer(raw.expectedLatestRevision, 0, MAX_SEQUENCE, 'commit proposal revision'),
		};
	}

	private parseCommitProposalMutation(value: unknown, authorizedProjectId: string): WorkspaceAgentCommitProposalInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId', 'proposalId', 'expectedRevision', 'expectedFingerprint'], [], 'commit proposal mutation');
		return {
			projectId: this.assertProjectAndReturn(raw.projectId, authorizedProjectId),
			sessionId: this.uuid(raw.sessionId, 'commit session ID'), turnId: this.uuid(raw.turnId, 'commit turn ID'),
			proposalId: this.uuid(raw.proposalId, 'commit proposal ID'),
			expectedRevision: this.integer(raw.expectedRevision, 1, MAX_SEQUENCE, 'commit proposal revision'),
			expectedFingerprint: this.changeFingerprint(raw.expectedFingerprint),
		};
	}

	private parseCommitRecovery(value: unknown, authorizedProjectId: string): WorkspaceAgentCommitRecoveryInput {
		const raw = this.record(value);
		this.assertExactKeys(raw, ['projectId', 'sessionId', 'turnId', 'proposalId', 'expectedRevision', 'expectedFingerprint'], ['operationId'], 'commit recovery');
		return {
			...this.parseCommitProposalMutation({
				projectId: raw.projectId, sessionId: raw.sessionId, turnId: raw.turnId, proposalId: raw.proposalId,
				expectedRevision: raw.expectedRevision, expectedFingerprint: raw.expectedFingerprint,
			}, authorizedProjectId),
			...(raw.operationId === undefined ? {} : { operationId: this.uuid(raw.operationId, 'commit operation ID') }),
		};
	}

	private requireWorkflowHost(): WorkspaceAgentWorkflowHost {
		if (!this.workflowHost) { throw new Error('The workflow execution host is unavailable.'); }
		return this.workflowHost;
	}

	private parseWorkflowRequest(value: unknown, projectId: string) {
		const request = this.record(value);
		this.assertProjectId(request.projectId, projectId);
		return { projectId, workflowId: this.uuid(request.workflowId, 'workflow ID') };
	}

	private parseWorkflowMutation(value: unknown, projectId: string) {
		const request = this.parseWorkflowRequest(value, projectId);
		return { ...request, expectedRevision: this.integer(this.record(value).expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'workflow revision') };
	}

	private parseWorkflowPlan(value: unknown, projectId: string): AgentWorkflowPlanInput {
		const plan = this.record(value);
		this.assertProjectId(plan.projectId, projectId);
		if (!Array.isArray(plan.nodes) || plan.nodes.length < 1 || plan.nodes.length > 64) { throw new Error('A workflow needs 1 to 64 nodes.'); }
		const bindingId = this.uuid(plan.bindingId, 'workflow folder binding');
		const taskId = plan.taskId === null ? null : this.uuid(plan.taskId, 'workflow task');
		return {
			projectId, bindingId, taskId,
			maxConcurrentNodes: this.integer(plan.maxConcurrentNodes, 1, 8, 'workflow concurrency'),
			maxTotalTurns: this.integer(plan.maxTotalTurns, 1, 64, 'workflow turn limit'),
			maxDurationMs: this.integer(plan.maxDurationMs, 1000, 7_200_000, 'workflow duration'),
			nodes: plan.nodes.map((value): AgentWorkflowNodePlan => {
				const node = this.record(value);
				if (!Array.isArray(node.dependsOn) || node.dependsOn.length > 64 || !Array.isArray(node.referenceIds) || node.referenceIds.length > 64) { throw new Error('Workflow dependencies and references must be bounded lists.'); }
				if (node.provider !== 'codex' && node.provider !== 'claude') { throw new Error('The workflow provider is invalid.'); }
				const role = node.role;
				if (role !== 'coordinator' && role !== 'implementer' && role !== 'reviewer' && role !== 'researcher' && role !== 'tester') { throw new Error('The workflow role is invalid.'); }
				const permissionPolicy = this.parsePolicy(node.permissionPolicy);
				if (!((permissionPolicy.mode === 'read-only' && permissionPolicy.approval === 'never') || (permissionPolicy.mode === 'mutating' && permissionPolicy.approval === 'on-request'))) { throw new Error('The workflow launch policy must be read-only/never or mutating/on-request.'); }
				return {
					nodeId: this.string(node.nodeId, 'workflow node ID', 80), sessionId: this.uuid(node.sessionId, 'workflow session ID'),
					role, provider: node.provider,
					model: this.string(node.model, 'workflow model', 800),
					bindingId: this.uuid(node.bindingId, 'node folder binding'), taskId: node.taskId === null ? null : this.uuid(node.taskId, 'node task'),
					permissionPolicy,
					dependsOn: node.dependsOn.map(id => this.string(id, 'dependency ID', 80)),
					referenceIds: node.referenceIds.map(value => {
						const reference = this.record(value);
						if (reference.kind !== 'knowledgeSnapshot' && reference.kind !== 'conventionVersion') { throw new Error('The workflow reference kind is invalid.'); }
						return { kind: reference.kind, id: this.uuid(reference.id, 'workflow reference ID') };
					}),
				};
			}),
		};
	}

	private parsePolicy(value: unknown): AgentSessionPermissionPolicy {
		const policy = this.record(value);
		if (!['read-only', 'mutating'].includes(String(policy.mode)) || !['never', 'on-request', 'always'].includes(String(policy.approval))) {
			throw new Error('The session permission policy is invalid.');
		}
		return { mode: policy.mode as AgentSessionPermissionPolicy['mode'], approval: policy.approval as AgentSessionPermissionPolicy['approval'] };
	}

	private parseStart(value: unknown, projectId: string) {
		const request = this.parseSessionRequest(value, projectId);
		const raw = this.record(value);
		return { ...request, ticketId: this.string(raw.ticketId, 'launch ticket', 64) };
	}

	private parseSessionRequest(value: unknown, projectId: string) {
		const request = this.record(value);
		this.assertProjectId(request.projectId, projectId);
		return { projectId, sessionId: this.uuid(request.sessionId, 'session ID') };
	}

	private parseTurnRequest(value: unknown, projectId: string) {
		const request = this.parseSessionRequest(value, projectId);
		const raw = this.record(value);
		return { ...request, turnId: this.uuid(raw.turnId, 'turn ID') };
	}

	private parseChangeScope(value: unknown, projectId: string, allowedKeys: readonly string[]) {
		const raw = this.record(value);
		if (Object.keys(raw).some(key => !allowedKeys.includes(key)) || !['projectId', 'sessionId', 'turnId'].every(key => Object.hasOwn(raw, key))) {
			throw new Error('Change evidence requests must contain only their documented scope and paging fields.');
		}
		this.assertProjectId(raw.projectId, projectId);
		const sessionId = this.uuid(raw.sessionId, 'session ID');
		const turnId = this.uuid(raw.turnId, 'turn ID');
		if (!this.database.agentSessionTurns.getTurn(projectId, sessionId, turnId)) { throw new Error('The turn does not belong to this project session.'); }
		return { sessionId, turnId };
	}

	private parseExplanationTarget(value: unknown, projectId: string, extraKeys: readonly string[] = [], optionalKeys: readonly string[] = []): AgentSessionExplanationTarget {
		const allowedKeys = ['projectId', 'sessionId', 'turnId', 'evidenceVersion', 'evidenceFingerprint', 'path', 'hunkId', ...extraKeys];
		const request = this.parseChangeScope(value, projectId, allowedKeys);
		const raw = this.record(value);
		const requiredKeys = allowedKeys.filter(key => !optionalKeys.includes(key));
		if (requiredKeys.some(key => !Object.hasOwn(raw, key)) || Object.keys(raw).some(key => !allowedKeys.includes(key))) { throw new Error('Explanation requests must contain exactly their documented target and fields.'); }
		const evidenceFingerprint = this.changeFingerprint(raw.evidenceFingerprint);
		const hunkId = raw.hunkId;
		if (hunkId !== null && (typeof hunkId !== 'string' || !/^[0-9a-f]{64}$/u.test(hunkId))) { throw new Error('Explanation hunk ID must be null or a SHA-256 digest.'); }
		return {
			projectId, sessionId: request.sessionId, turnId: request.turnId,
			evidenceVersion: this.integer(raw.evidenceVersion, 1, MAX_SEQUENCE, 'change evidence version'),
			evidenceFingerprint, path: this.safeChangePath(raw.path), hunkId: hunkId as string | null,
		};
	}

	private changeFingerprint(value: unknown): string {
		const fingerprint = this.string(value, 'change evidence fingerprint', 64);
		if (!/^[0-9a-f]{64}$/u.test(fingerprint)) { throw new Error('A valid change evidence fingerprint is required.'); }
		return fingerprint;
	}

	private getExactChangeFile(projectId: string, sessionId: string, turnId: string, evidenceVersion: number, fingerprint: string, path: string) {
		const page = this.database.agentSessionChangeEvidence.listVersions(projectId, sessionId, turnId, { afterVersion: evidenceVersion - 1, limit: 1 });
		const selected = page.snapshots[0];
		if (!selected || selected.version !== evidenceVersion || selected.fingerprint !== fingerprint) { throw new Error('The selected change evidence version is unavailable or has changed.'); }
		if (!selected.files.some(file => file.path === path)) { throw new Error('The requested path is not part of the selected change evidence.'); }
		const scope = { projectId, sessionId, turnId };
		const result = this.database.agentSessionContents.getFile({ scope, evidenceVersion, path });
		if (!result) { return undefined; }
		if (result.scope.projectId !== projectId || result.scope.sessionId !== sessionId || result.scope.turnId !== turnId
			|| result.evidenceVersion !== evidenceVersion || result.path !== path || result.evidenceFingerprint !== fingerprint) {
			throw new Error('Retained file content does not match the selected change evidence.');
		}
		return result;
	}

	private requireExactExplanationHunk(target: AgentSessionExplanationTarget): void {
		if (target.hunkId === null) { return; }
		const file = this.getExactChangeFile(target.projectId, target.sessionId, target.turnId, target.evidenceVersion, target.evidenceFingerprint, target.path);
		if (!file || !computeAgentSessionChangeHunks(file).hunks.some(hunk => hunk.id === target.hunkId)) { throw new Error('The selected hunk is not present in the exact retained file content.'); }
	}

	private safeChangePath(value: unknown): string {
		const path = this.string(value, 'change file path', 4096);
		if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
			throw new Error('The change file path must be a safe root-relative path.');
		}
		return path;
	}

	private parseAttach(value: unknown, projectId: string) {
		const request = this.parseTurnRequest(value, projectId);
		const raw = this.record(value);
		return { ...request, afterSequence: raw.afterSequence === undefined ? 0 : this.sequence(raw.afterSequence, 'output cursor') };
	}

	private parseRead(value: unknown, projectId: string) {
		const request = this.parseTurnRequest(value, projectId);
		const raw = this.record(value);
		const limit = raw.limit === undefined ? undefined : this.integer(raw.limit, 1, MAX_READ_CHUNKS, 'read limit');
		return { ...request, attachmentId: this.string(raw.attachmentId, 'attachment ID', 64), afterSequence: this.sequence(raw.afterSequence, 'output cursor'), ...(limit === undefined ? {} : { limit }) };
	}

	private parseWrite(value: unknown, projectId: string) {
		const request = this.parseTurnRequest(value, projectId);
		const text = this.record(value).text;
		if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
			throw new Error('Terminal input must be text within the 64 KiB limit.');
		}
		return { ...request, text };
	}

	private parseResize(value: unknown, projectId: string) {
		const request = this.parseTurnRequest(value, projectId);
		const raw = this.record(value);
		return { ...request, cols: this.integer(raw.cols, 1, MAX_DIMENSION, 'terminal columns'), rows: this.integer(raw.rows, 1, MAX_DIMENSION, 'terminal rows') };
	}

	private parseDisconnect(value: unknown, projectId: string) {
		const request = this.parseTurnRequest(value, projectId);
		return { ...request, attachmentId: this.string(this.record(value).attachmentId, 'attachment ID', 64) };
	}

	private assertProjectId(value: unknown, authorizedProjectId: string): void {
		if (this.uuid(value, 'project ID') !== authorizedProjectId) { throw new Error('The requested project does not match this window.'); }
	}

	private assertProjectAndReturn(value: unknown, authorizedProjectId: string): string {
		this.assertProjectId(value, authorizedProjectId);
		return authorizedProjectId;
	}

	private record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('A structured session request is required.'); }
		return value as Record<string, unknown>;
	}

	private assertExactKeys(value: unknown, required: readonly string[], optional: readonly string[], label: string): void {
		const object = this.record(value);
		const allowed = new Set([...required, ...optional]);
		if (required.some(key => !Object.hasOwn(object, key)) || Object.keys(object).some(key => !allowed.has(key))) { throw new Error(`The ${label} request contains missing or unknown fields.`); }
	}

	private uuid(value: unknown, label: string): string {
		if (typeof value !== 'string' || !isUUID(value)) { throw new Error(`A valid ${label} is required.`); }
		return value;
	}

	private string(value: unknown, label: string, maxBytes: number): string {
		if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes) { throw new Error(`The ${label} is invalid or exceeds its size limit.`); }
		return value;
	}

	private integer(value: unknown, minimum: number, maximum: number, label: string): number {
		if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) { throw new Error(`The ${label} is outside its allowed range.`); }
		return value as number;
	}

	private sequence(value: unknown, label: string): number { return this.integer(value, 0, MAX_SEQUENCE, label); }
}

function projectMailboxMessage(message: SessionMessageDTO): WorkspaceAgentSessionMailboxMessage {
	return {
		id: message.id, senderSessionId: message.senderSessionId, recipientSessionId: message.recipientSessionId,
		sequence: message.sequence, body: message.body, createdAt: message.createdAt, readAt: message.readAt,
	};
}

function sameExplanationTarget(left: AgentSessionExplanationTarget, right: AgentSessionExplanationTarget): boolean {
	return left.projectId === right.projectId && left.sessionId === right.sessionId && left.turnId === right.turnId
		&& left.evidenceVersion === right.evidenceVersion && left.evidenceFingerprint === right.evidenceFingerprint
		&& left.path === right.path && left.hunkId === right.hunkId;
}
