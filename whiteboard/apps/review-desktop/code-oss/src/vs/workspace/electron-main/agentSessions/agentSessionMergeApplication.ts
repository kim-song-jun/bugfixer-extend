/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type {
	AgentSessionMergeApplyingBinding,
	AgentSessionMergeArtifactEvent,
	AgentSessionMergeArtifactRecord,
	AgentSessionMergeOutcomeDTO,
	AgentSessionMergeProposalDTO,
	AgentSessionMergeReceipt,
	WorkspaceAgentMergeProposalMutationInput,
	WorkspaceAgentMergeProposalPageDTO,
	WorkspaceAgentMergeProposalPageInput,
	WorkspaceAgentMergeProposalRecoveryInput,
} from '../../common/workspaceAgentMergeProtocol.js';
import type { AgentSessionIntegrationGitIdentity, AgentSessionIntegrationProposalDTO } from '../../common/workspaceAgentIntegrationProtocol.js';
import type { AgentSessionTurnDTO } from '../../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';
import type { AgentSessionService } from './agentSessionService.js';
import type { AgentSessionMergeStore } from './agentSessionMergeStore.js';
import type { AgentSessionWorkspaceResolver, AcquiredAgentSessionWorkspace } from './agentSessionWorkspace.js';
import type { ManagedWorktreeLease, ManagedWorktreeService, MergePreview, MergeResolutionSource, ReviewedMergeApplyingRecord, ReviewedMergeResult } from './managedWorktrees.js';

export interface AgentSessionMergePrepareInput {
	readonly resolutionOfProposalId?: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly commitProposalId: string;
	readonly expectedLatestRevision: number;
}

export class AgentSessionMergeApplication {
	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly worktrees: ManagedWorktreeService,
		private readonly mergeStore: AgentSessionMergeStore,
		private readonly workspaceResolver: AgentSessionWorkspaceResolver,
		private readonly service: AgentSessionService,
	) { }

	async prepareProposal(input: AgentSessionMergePrepareInput): Promise<AgentSessionMergeProposalDTO> {
		this.assertExactKeys(input, ['projectId', 'sessionId', 'turnId', 'commitProposalId', 'expectedLatestRevision'], ['resolutionOfProposalId'], 'merge preparation');
		const turn = this.requireReviewableTurn(input.projectId, input.sessionId, input.turnId);
		const commit = this.requireSuccessfulCommit(turn, input.commitProposalId);
		const sourceHead = this.commitResultingHead(commit);
		const lease = await this.acquireTerminalWorkspace(turn);
		let previewId: string | undefined;
		try {
			const session = this.database.agentSessions.getSession(turn.projectId, turn.sessionId)!;
			const integrationOwnerId = this.mergeStore.getOrCreateIntegrationOwner(session.projectId, session.bindingId);
			const resolutionOf = input.resolutionOfProposalId === undefined ? undefined : this.resolutionSource(input.resolutionOfProposalId, input, integrationOwnerId);
			const integration = await this.worktrees.ensureIntegrationTarget({ ownerId: integrationOwnerId, sessionOwnerId: session.id });
			if (integration.state !== (resolutionOf ? 'conflict' : 'active') || integration.kind !== 'integration') { throw new Error('The owned integration target requires recovery before a merge proposal can be prepared.'); }
			const preview = await this.worktrees.previewMerge({ integrationOwnerId, sessionOwnerId: session.id, ...(resolutionOf ? { resolutionOf } : {}) });
			previewId = preview.previewId;
			this.assertPreparedPreview(preview, integrationOwnerId, session.id, sourceHead);
			return this.mergeStore.createProposal({
				projectId: turn.projectId, sessionId: turn.sessionId, turnId: turn.id,
				commitProposalId: commit.id, commitProposalRevision: commit.revision, commitProposalFingerprint: commit.fingerprint,
				integrationOwnerId, sourceHead: preview.sourceHead, targetHead: preview.targetHead, mergeBase: preview.mergeBase,
				diffFingerprint: preview.diffHash, diffText: preview.diffText, commitMessage: preview.commitMessage,
				author: preview.author, committer: preview.committer, changedPaths: preview.changedPaths,
				...(preview.resolution ? { resolution: preview.resolution } : {}),
				expectedLatestRevision: input.expectedLatestRevision,
			});
		} finally {
			try { if (previewId) { this.worktrees.discardMergePreview(previewId); } }
			finally { lease.release(); }
		}
	}

	async listProposals(input: WorkspaceAgentMergeProposalPageInput): Promise<WorkspaceAgentMergeProposalPageDTO> {
		this.assertExactKeys(input, ['projectId', 'sessionId', 'turnId'], ['afterRevision', 'limit'], 'merge proposal listing');
		const page = this.mergeStore.listProposals(input.projectId, input.sessionId, input.turnId, {
			...(input.afterRevision !== undefined ? { afterRevision: input.afterRevision } : {}),
			...(input.limit !== undefined ? { limit: input.limit } : {}),
		});
		const proposals: AgentSessionMergeProposalDTO[] = [];
		for (const proposal of page.proposals) { proposals.push(await this.withGenerationDirectory(proposal)); }
		return { ...page, proposals };
	}

	private async withGenerationDirectory(proposal: AgentSessionMergeProposalDTO): Promise<AgentSessionMergeProposalDTO> {
		const intent = proposal.artifacts[0]?.event;
		if (intent?.phase !== 'intent' || !proposal.artifacts.some(value => value.event.phase === 'generationRegistered')) { return proposal; }
		try {
			const generationDirectory = await this.worktrees.getMergeGenerationDirectory(proposal.integrationOwnerId, intent.generationId, intent.registrationId);
			return { ...proposal, generationDirectory };
		} catch (error) {
			return { ...proposal, generationDirectoryError: `Generation directory verification failed: ${error instanceof Error ? error.message.slice(0, 1024) : String(error).slice(0, 1024)}` };
		}
	}

	private resolutionSource(proposalId: string, scope: { projectId: string; sessionId: string; turnId: string; commitProposalId: string }, integrationOwnerId: string): MergeResolutionSource {
		const prior = this.mergeStore.getProposal(proposalId);
		const outcome = prior?.outcomes.at(-1);
		const intent = prior?.artifacts[0]?.event;
		if (!prior || prior.projectId !== scope.projectId || prior.sessionId !== scope.sessionId || prior.turnId !== scope.turnId
			|| prior.commitProposalId !== scope.commitProposalId || prior.integrationOwnerId !== integrationOwnerId || prior.state !== 'conflict'
			|| !outcome || outcome.state !== 'conflict' || intent?.phase !== 'intent' || prior.artifacts.length !== 4) { throw new Error('Resolution review requires the exact prior durable conflict in this project, session and turn.'); }
		return { proposalId: prior.id, operationId: outcome.receipt.operationId, sourceHead: prior.sourceHead, targetHead: prior.targetHead, mergeBase: prior.mergeBase,
			generationId: intent.generationId, registrationId: intent.registrationId };
	}

	approveProposal(input: WorkspaceAgentMergeProposalMutationInput) {
		this.assertExactKeys(input, ['projectId', 'sessionId', 'turnId', 'proposalId', 'expectedRevision', 'expectedFingerprint'], [], 'merge approval');
		const proposal = this.requireExactProposal(input);
		return this.mergeStore.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint);
	}

	async applyApprovedProposal(input: WorkspaceAgentMergeProposalMutationInput): Promise<AgentSessionMergeProposalDTO> {
		this.assertExactKeys(input, ['projectId', 'sessionId', 'turnId', 'proposalId', 'expectedRevision', 'expectedFingerprint'], [], 'merge apply');
		const proposal = this.requireExactProposal(input);
		this.requireHumanApproval(proposal);
		const latestOutcome = proposal.outcomes.at(-1);
		if (latestOutcome?.state === 'merged') { return this.withGenerationDirectory(proposal); }
		if (latestOutcome?.state === 'applying' || latestOutcome?.state === 'recoveryRequired') {
			return this.reconcileApplying({ ...input, operationId: latestOutcome.receipt.operationId });
		}
		if (latestOutcome) { throw new Error('This merge attempt is terminal; prepare and approve a fresh proposal to retry.'); }
		this.assertProposalCanStart(proposal);
		const turn = this.requireReviewableTurn(proposal.projectId, proposal.sessionId, proposal.turnId);
		this.requireSuccessfulCommit(turn, proposal.commitProposalId, proposal.commitProposalRevision, proposal.commitProposalFingerprint, proposal.sourceHead);
		const lease = await this.acquireTerminalWorkspace(turn);
		let previewId: string | undefined;
		let applying: AgentSessionMergeOutcomeDTO | undefined;
		let readApplying: (() => AgentSessionMergeOutcomeDTO | undefined) | undefined;
		try {
			const integrationOwnerId = this.requireIntegrationOwner(proposal);
			const integration = await this.worktrees.ensureIntegrationTarget({ ownerId: integrationOwnerId, sessionOwnerId: proposal.sessionOwnerId });
			if (integration.state !== (proposal.resolution ? 'conflict' : 'active') || integration.kind !== 'integration') { throw new Error('The approved integration target requires recovery before apply.'); }
			const resolutionOf = proposal.resolution ? this.resolutionSource(proposal.resolution.proposalId, proposal, integrationOwnerId) : undefined;
			const preview = await this.worktrees.previewMerge({ integrationOwnerId, sessionOwnerId: proposal.sessionOwnerId, ...(resolutionOf ? { resolutionOf } : {}) });
			previewId = preview.previewId;
			this.assertPreviewMatchesProposal(preview, proposal);
			const operationId = randomUUID();
			const binding = this.applyingBinding(proposal, operationId);
			const journal = this.journalFor(proposal, binding, operationId);
			readApplying = journal.getApplying;
			const result = await this.worktrees.mergeReviewed({
				previewId: preview.previewId, operationId, proposalId: proposal.id, proposalFingerprint: proposal.fingerprint,
				commitMessage: proposal.commitMessage, author: proposal.author, committer: proposal.committer,
				recordApplying: journal.recordApplying, readApplying: journal.readApplying,
				recordArtifact: journal.recordArtifact, readArtifacts: journal.readArtifacts,
			});
			applying = journal.getApplying();
			if (!applying) { throw new Error('Managed Git merge returned without its durable applying receipt.'); }
			this.recordMergeResult(proposal, applying, result);
			return this.withGenerationDirectory(this.mergeStore.getProposal(proposal.id)!);
		} catch (error) {
			applying ??= readApplying?.();
			if (!applying) { throw error; }
			return this.reconcileWithManager(proposal, applying);
		} finally {
			try { if (previewId) { this.worktrees.discardMergePreview(previewId); } }
			finally { lease.release(); }
		}
	}

	async reconcileApplying(input: WorkspaceAgentMergeProposalRecoveryInput): Promise<AgentSessionMergeProposalDTO> {
		this.assertExactKeys(input, ['projectId', 'sessionId', 'turnId', 'proposalId', 'expectedRevision', 'expectedFingerprint'], ['operationId'], 'merge recovery');
		const proposal = this.requireExactProposal(input);
		this.requireHumanApproval(proposal);
		const applying = proposal.outcomes.at(-1);
		if (!applying || !['applying', 'recoveryRequired'].includes(applying.state)) { throw new Error('Only an exact applying or recovery-required merge can be reconciled.'); }
		if (input.operationId && input.operationId !== applying.receipt.operationId) { throw new Error('Merge recovery operation ID does not match its exact durable receipt.'); }
		const turn = this.requireReviewableTurn(proposal.projectId, proposal.sessionId, proposal.turnId);
		this.requireSuccessfulCommit(turn, proposal.commitProposalId, proposal.commitProposalRevision, proposal.commitProposalFingerprint, proposal.sourceHead);
		this.requireIntegrationOwner(proposal);
		const lease = await this.acquireTerminalWorkspace(turn);
		try {
			return await this.reconcileWithManager(proposal, applying);
		} catch (error) {
			return this.withGenerationDirectory(this.persistRecoveryRequired(proposal, applying, this.failureCode(error), error));
		} finally { lease.release(); }
	}

	private async reconcileWithManager(proposal: AgentSessionMergeProposalDTO, applying: AgentSessionMergeOutcomeDTO): Promise<AgentSessionMergeProposalDTO> {
		const expectedBinding = this.applyingBinding(proposal, applying.receipt.operationId);
		const journal = this.journalFor(proposal, expectedBinding, applying.receipt.operationId, applying);
		let result: ReviewedMergeResult;
		try {
			result = await this.worktrees.reconcileReviewedMerge({
				integrationOwnerId: proposal.integrationOwnerId, operationId: applying.receipt.operationId,
				readApplying: journal.readApplying, readArtifacts: journal.readArtifacts, recordArtifact: journal.recordArtifact,
			});
		} catch (error) {
			return this.withGenerationDirectory(this.persistRecoveryRequired(proposal, applying, this.failureCode(error), error));
		}
		this.recordMergeResult(proposal, applying, result);
		return this.withGenerationDirectory(this.mergeStore.getProposal(proposal.id)!);
	}

	private recordMergeResult(proposal: AgentSessionMergeProposalDTO, applying: AgentSessionMergeOutcomeDTO, result: ReviewedMergeResult): void {
		if (result.state === 'merged') {
			const operation = result.integration.lastOperation;
			if (!operation || !this.lastOperationMatches(operation, proposal, applying.receipt.operationId)
				|| operation.outcome !== 'merged' || operation.commit !== result.commit || result.commit !== result.integration.head) {
				throw new Error('Managed Git merge result differs from its exact signed integration manifest receipt.');
			}
			this.persistTerminal(proposal, applying, 'merged', this.receipt(proposal, applying.receipt.operationId, result.commit, this.proposalPaths(proposal), [], null));
			return;
		}
		if (result.state === 'conflict') {
			const operation = result.integration.lastOperation;
			if (!operation || !this.lastOperationMatches(operation, proposal, applying.receipt.operationId)
				|| operation.outcome !== 'conflict' || JSON.stringify(operation.conflictedPaths ?? []) !== JSON.stringify(result.conflictedPaths)) {
				throw new Error('Managed Git conflict result differs from its exact signed integration manifest receipt.');
			}
			this.persistTerminal(proposal, applying, 'conflict', this.receipt(proposal, applying.receipt.operationId, null, [], [...result.conflictedPaths], null));
			return;
		}
		if (result.state === 'notApplied') {
			if (result.operationId !== applying.receipt.operationId || result.integration.head !== proposal.targetHead) { throw new Error('Managed Git nonpublication result differs from its exact pinned operation.'); }
			this.persistTerminal(proposal, applying, 'notApplied', this.receipt(proposal, applying.receipt.operationId, null, [], [], 'merge-not-applied'));
			return;
		}
		if (result.operationId !== applying.receipt.operationId) { throw new Error('Managed Git recovery result differs from its exact durable operation.'); }
		this.persistRecoveryRequired(proposal, applying, 'merge-recovery-required', new Error(result.reason));
	}

	private persistTerminal(proposal: AgentSessionMergeProposalDTO, applying: AgentSessionMergeOutcomeDTO, state: 'merged' | 'conflict' | 'notApplied', receipt: AgentSessionMergeReceipt): AgentSessionMergeProposalDTO {
		this.mergeStore.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: applying.revision, state, receipt, retryOfOutcomeId: applying.id });
		return this.mergeStore.getProposal(proposal.id)!;
	}

	private persistRecoveryRequired(proposal: AgentSessionMergeProposalDTO, applying: AgentSessionMergeOutcomeDTO, failureCode: string, cause?: unknown): AgentSessionMergeProposalDTO {
		let receipt: AgentSessionMergeReceipt;
		try {
			const expectedBinding = this.applyingBinding(proposal, applying.receipt.operationId);
			const durableBinding = this.mergeStore.getApplyingBinding(proposal.id, applying.receipt.operationId);
			if (!durableBinding || !this.sameBinding(durableBinding, expectedBinding)) { throw new Error('Merge recovery artifacts do not belong to the exact approved operation.'); }
			const artifacts = this.mergeStore.readArtifacts(applying.receipt.operationId);
			const published = artifacts.at(-1)?.event;
			receipt = published?.phase === 'published'
				? this.receipt(proposal, applying.receipt.operationId, published.resultingHead, this.proposalPaths(proposal), [], failureCode)
				: this.receipt(proposal, applying.receipt.operationId, null, [], [], failureCode);
		} catch (artifactError) {
			throw cause ?? artifactError;
		}
		if (applying.state === 'recoveryRequired' && JSON.stringify(applying.receipt) === JSON.stringify(receipt)) { return this.mergeStore.getProposal(proposal.id)!; }
		this.mergeStore.recordOutcome({
			proposalId: proposal.id, expectedOutcomeRevision: applying.revision, state: 'recoveryRequired',
			receipt, retryOfOutcomeId: applying.id,
		});
		return this.mergeStore.getProposal(proposal.id)!;
	}

	private journalFor(proposal: AgentSessionMergeProposalDTO, binding: ReviewedMergeApplyingRecord, operationId: string, existingApplying?: AgentSessionMergeOutcomeDTO) {
		let applying: AgentSessionMergeOutcomeDTO | undefined = existingApplying;
		return {
			recordApplying: async (record: ReviewedMergeApplyingRecord) => {
				if (!this.sameBinding(record, binding)) { throw new Error('Managed Git merge requested a journal entry outside the exact approved proposal.'); }
				applying = this.mergeStore.recordOutcome({
					proposalId: proposal.id, expectedOutcomeRevision: 0, state: 'applying',
					receipt: this.receipt(proposal, operationId, null, [], [], null),
				});
			},
			readApplying: async (requestedOperationId: string) => {
				if (requestedOperationId !== operationId) { return undefined; }
				const durable = this.mergeStore.getApplyingBinding(proposal.id, operationId);
				return durable && this.sameBinding(durable, binding) ? binding : undefined;
			},
			recordArtifact: async (requestedOperationId: string, expectedRevision: number, event: AgentSessionMergeArtifactEvent): Promise<AgentSessionMergeArtifactRecord> => {
				const durable = this.mergeStore.getApplyingBinding(proposal.id, operationId);
				if (requestedOperationId !== operationId || !durable || !this.sameBinding(durable, binding)) { throw new Error('Merge artifact write is outside its exact durable operation.'); }
				return this.mergeStore.recordArtifact(operationId, expectedRevision, event);
			},
			readArtifacts: async (requestedOperationId: string): Promise<readonly AgentSessionMergeArtifactRecord[]> => {
				const durable = this.mergeStore.getApplyingBinding(proposal.id, operationId);
				if (requestedOperationId !== operationId || !durable || !this.sameBinding(durable, binding)) { throw new Error('Merge artifact read is outside its exact durable operation.'); }
				return this.mergeStore.readArtifacts(operationId);
			},
			getApplying: () => applying,
		};
	}

	private requireReviewableTurn(projectId: string, sessionId: string, turnId: string): AgentSessionTurnDTO {
		const turn = this.database.agentSessionTurns.getTurn(projectId, sessionId, turnId);
		const session = this.database.agentSessions.getSession(projectId, sessionId);
		if (!turn || !session || turn.snapshot.projectId !== projectId || turn.snapshot.sessionId !== sessionId) { throw new Error('Merge operation requires the exact project, session, and turn.'); }
		if (session.workspaceMode !== 'gitWorktree' || ['starting', 'running', 'waitingForInput', 'waitingForApproval', 'stopping'].includes(session.state)
			|| turn.snapshot.managedWorktreeOwnerId !== sessionId || !['exited', 'failed', 'interrupted'].includes(turn.state) || turn.cleanupVerified !== true) {
			throw new Error('Merge operation requires a terminal cleaned turn in its idle app-managed Git worktree session.');
		}
		if (this.database.agentSessionTurns.listTurns(projectId, sessionId).some(candidate => ['starting', 'running', 'stopping'].includes(candidate.state) || candidate.cleanupVerified !== true)) {
			throw new Error('Another session turn has unresolved provider or cleanup state.');
		}
		return turn;
	}

	private requireSuccessfulCommit(turn: AgentSessionTurnDTO, proposalId: string, revision?: number, fingerprint?: string, sourceHead?: string): AgentSessionIntegrationProposalDTO {
		const proposal = this.database.agentSessionIntegrations.getProposal(proposalId);
		const outcome = proposal?.outcomes.at(-1);
		if (!proposal || proposal.projectId !== turn.projectId || proposal.sessionId !== turn.sessionId || proposal.turnId !== turn.id
			|| (revision !== undefined && proposal.revision !== revision) || (fingerprint !== undefined && proposal.fingerprint !== fingerprint)
			|| !proposal.approval || proposal.approval.proposalFingerprint !== proposal.fingerprint || outcome?.state !== 'succeeded'
			|| !outcome.receipt.resultingHead || (sourceHead !== undefined && outcome.receipt.resultingHead !== sourceHead)
			|| proposal.sessionWorktreeOwnerId !== turn.snapshot.managedWorktreeOwnerId) {
			throw new Error('Merge requires the exact trusted, successful reviewed commit proposal and its resulting session HEAD.');
		}
		return proposal;
	}

	private commitResultingHead(proposal: AgentSessionIntegrationProposalDTO): string {
		const resultingHead = proposal.outcomes.at(-1)?.receipt.resultingHead;
		if (!resultingHead) { throw new Error('The successful commit proposal has no resulting session HEAD.'); }
		return resultingHead;
	}

	private async acquireTerminalWorkspace(turn: AgentSessionTurnDTO): Promise<{ readonly workspace: AcquiredAgentSessionWorkspace; release(): void }> {
		const mutation = this.service.acquireIdleMutationLease({ projectId: turn.projectId, sessionId: turn.sessionId });
		let workspace: AcquiredAgentSessionWorkspace | undefined;
		try {
			workspace = await this.workspaceResolver.acquire({ projectId: turn.projectId, sessionId: turn.sessionId, permissionPolicy: turn.snapshot.permissionPolicy });
			await this.workspaceResolver.revalidate(workspace);
			const acquired = workspace.snapshot.folderIdentity;
			const expected = turn.snapshot.folderIdentity;
			if (acquired.canonicalPath !== expected.canonicalPath || acquired.dev !== expected.dev || acquired.ino !== expected.ino) { throw new Error('Merge operation workspace identity differs from the exact turn snapshot.'); }
			let released = false;
			return { workspace, release: () => {
				if (released) { return; }
				released = true;
				try { this.workspaceResolver.release(workspace!); }
				finally { mutation.release(); }
			} };
		} catch (error) {
			try { if (workspace) { this.workspaceResolver.release(workspace); } }
			finally { mutation.release(); }
			throw error;
		}
	}

	private requireExactProposal(input: WorkspaceAgentMergeProposalMutationInput): AgentSessionMergeProposalDTO {
		if (typeof input.proposalId !== 'string' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
			|| typeof input.expectedFingerprint !== 'string' || !/^[0-9a-f]{64}$/iu.test(input.expectedFingerprint)) { throw new Error('Merge proposal identity or fingerprint is invalid.'); }
		const proposal = this.mergeStore.getProposal(input.proposalId);
		if (!proposal || proposal.projectId !== input.projectId || proposal.sessionId !== input.sessionId || proposal.turnId !== input.turnId
			|| proposal.revision !== input.expectedRevision || proposal.fingerprint !== input.expectedFingerprint) { throw new Error('Merge proposal changed; review the latest exact proposal.'); }
		return proposal;
	}

	private requireHumanApproval(proposal: AgentSessionMergeProposalDTO): void {
		if (!proposal.approval || proposal.approval.proposalFingerprint !== proposal.fingerprint || proposal.approval.actor !== 'human') { throw new Error('A trusted human approval for this exact merge proposal is required.'); }
	}

	private assertProposalCanStart(proposal: AgentSessionMergeProposalDTO): void {
		if (Date.parse(proposal.expiresAt) <= Date.now()) { throw new Error('Merge proposal expired; prepare and approve a fresh exact proposal.'); }
		if (this.mergeStore.listProposals(proposal.projectId, proposal.sessionId, proposal.turnId, { afterRevision: proposal.revision, limit: 1 }).proposals.length) { throw new Error('Only the latest merge proposal can be applied.'); }
	}

	private requireIntegrationOwner(proposal: AgentSessionMergeProposalDTO): string {
		const session = this.database.agentSessions.getSession(proposal.projectId, proposal.sessionId);
		if (!session || session.bindingId !== proposal.bindingId || this.mergeStore.getOrCreateIntegrationOwner(proposal.projectId, session.bindingId) !== proposal.integrationOwnerId) {
			throw new Error('The merge proposal integration owner no longer matches its persisted project Git binding.');
		}
		return proposal.integrationOwnerId;
	}

	private assertPreparedPreview(preview: MergePreview, integrationOwnerId: string, sessionOwnerId: string, sourceHead: string): void {
		if (preview.integrationOwnerId !== integrationOwnerId || preview.sessionOwnerId !== sessionOwnerId || preview.sourceHead !== sourceHead
			|| (!preview.resolution && (!preview.diffText || !preview.changedPaths.length))) { throw new Error('Fresh merge preview does not match the exact successful commit and managed worktrees.'); }
	}

	private assertPreviewMatchesProposal(preview: MergePreview, proposal: AgentSessionMergeProposalDTO): void {
		if (preview.integrationOwnerId !== proposal.integrationOwnerId || preview.sessionOwnerId !== proposal.sessionOwnerId
			|| preview.sourceHead !== proposal.sourceHead || preview.targetHead !== proposal.targetHead || preview.mergeBase !== proposal.mergeBase
			|| preview.diffHash !== proposal.diffFingerprint || preview.diffText !== proposal.diffText
			|| preview.commitMessage !== proposal.commitMessage
			|| JSON.stringify(preview.resolution) !== JSON.stringify(proposal.resolution)
			|| JSON.stringify(preview.changedPaths) !== JSON.stringify(proposal.paths.map(path => path.path))) {
			throw new Error('Fresh merge preview no longer matches the approved source, target, base, diff, and paths.');
		}
	}

	private applyingBinding(proposal: AgentSessionMergeProposalDTO, operationId: string): ReviewedMergeApplyingRecord {
		return {
			operationId, proposalId: proposal.id, proposalFingerprint: proposal.fingerprint, integrationOwnerId: proposal.integrationOwnerId,
			sessionOwnerId: proposal.sessionOwnerId, sourceHead: proposal.sourceHead, targetHead: proposal.targetHead,
			mergeBase: proposal.mergeBase, diffFingerprint: proposal.diffFingerprint, commitMessage: proposal.commitMessage,
			author: proposal.author, committer: proposal.committer,
		};
	}

	private sameBinding(left: AgentSessionMergeApplyingBinding | ReviewedMergeApplyingRecord, right: AgentSessionMergeApplyingBinding | ReviewedMergeApplyingRecord): boolean {
		return left.operationId === right.operationId && left.proposalId === right.proposalId && left.proposalFingerprint === right.proposalFingerprint
			&& left.integrationOwnerId === right.integrationOwnerId && left.sessionOwnerId === right.sessionOwnerId
			&& left.sourceHead === right.sourceHead && left.targetHead === right.targetHead
			&& left.mergeBase === right.mergeBase && left.diffFingerprint === right.diffFingerprint
			&& left.commitMessage === right.commitMessage && this.sameGitIdentity(left.author, right.author)
			&& this.sameGitIdentity(left.committer, right.committer);
	}

	private sameGitIdentity(left: AgentSessionIntegrationGitIdentity, right: AgentSessionIntegrationGitIdentity): boolean {
		return left.name === right.name && left.email === right.email && left.date === right.date;
	}

	private lastOperationMatches(operation: NonNullable<ManagedWorktreeLease['lastOperation']>, proposal: AgentSessionMergeProposalDTO, operationId: string): boolean {
		return operation.kind === 'merge' && operation.id === operationId && operation.proposalId === proposal.id
			&& operation.proposalFingerprint === proposal.fingerprint && operation.sourceOwnerId === proposal.sessionOwnerId
			&& operation.sourceHead === proposal.sourceHead && operation.targetHead === proposal.targetHead
			&& operation.mergeBase === proposal.mergeBase && operation.diffFingerprint === proposal.diffFingerprint;
	}

	private receipt(proposal: AgentSessionMergeProposalDTO, operationId: string, resultingHead: string | null, changedPaths: readonly string[], conflictedPaths: readonly string[], failureCode: string | null): AgentSessionMergeReceipt {
		return {
			operationId, proposalId: proposal.id, proposalFingerprint: proposal.fingerprint, integrationOwnerId: proposal.integrationOwnerId,
			sessionOwnerId: proposal.sessionOwnerId, sourceHead: proposal.sourceHead, targetHead: proposal.targetHead, mergeBase: proposal.mergeBase,
			diffFingerprint: proposal.diffFingerprint, commitMessage: proposal.commitMessage, author: proposal.author, committer: proposal.committer,
			resultingHead, changedPaths: [...changedPaths], conflictedPaths: [...conflictedPaths], failureCode,
		};
	}

	private proposalPaths(proposal: AgentSessionMergeProposalDTO): string[] { return proposal.paths.map(path => path.path); }
	private failureCode(_error: unknown): string { return 'merge-host-operation-failed'; }

	private assertExactKeys(value: unknown, required: readonly string[], optional: readonly string[], label: string): void {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`${label} must be an object.`); }
		const object = value as Record<string, unknown>;
		const allowed = new Set([...required, ...optional]);
		if (required.some(key => !Object.hasOwn(object, key)) || Object.keys(object).some(key => !allowed.has(key))) { throw new Error(`${label} contains missing or unknown fields.`); }
	}
}
