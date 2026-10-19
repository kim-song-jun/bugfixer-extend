/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type { AgentSessionIntegrationActionReceipt, AgentSessionIntegrationOutcomeDTO, AgentSessionIntegrationProposalDTO, AgentSessionIntegrationPathInput } from './agentSessionIntegrationStore.js';
import type { AgentSessionRawContentFileDTO, AgentSessionRawContentFileSide } from './agentSessionContentStore.js';
import type { AgentSessionTurnDTO } from '../../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';
import type { AcquiredAgentSessionWorkspace, AgentSessionWorkspaceResolver } from './agentSessionWorkspace.js';
import type { ManagedWorktreeService, ReviewedCommitApplyResult, ReviewedCommitApplyingRecord, ReviewedCommitBinding, ReviewedCommitFileInput, ReviewedCommitPreview } from './managedWorktrees.js';
import type { AgentSessionService } from './agentSessionService.js';

export interface AgentSessionCommitPrepareInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly evidenceVersion: number;
	readonly evidenceFingerprint: string;
	readonly paths: readonly AgentSessionIntegrationPathInput[];
	readonly commitMessage: string;
	readonly expectedLatestRevision: number;
}

export interface AgentSessionCommitApprovalInput {
	readonly proposalId: string;
	readonly expectedRevision: number;
	readonly expectedFingerprint: string;
}

export interface AgentSessionCommitApplyInput extends AgentSessionCommitApprovalInput { }

export interface AgentSessionCommitRecoveryInput extends AgentSessionCommitApprovalInput {
	readonly operationId?: string;
}

export class AgentSessionCommitApplication {
	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly worktrees: ManagedWorktreeService,
		private readonly workspaceResolver: AgentSessionWorkspaceResolver,
		private readonly service: AgentSessionService,
	) { }

	async prepareProposal(input: AgentSessionCommitPrepareInput): Promise<AgentSessionIntegrationProposalDTO> {
		this.assertExactKeys(input, ['projectId', 'sessionId', 'turnId', 'evidenceVersion', 'evidenceFingerprint', 'paths', 'commitMessage', 'expectedLatestRevision'], [], 'commit preparation');
		const turn = this.requireReviewableTurn(input.projectId, input.sessionId, input.turnId);
		const evidence = this.requireEvidence(input.projectId, input.sessionId, input.turnId, input.evidenceVersion, input.evidenceFingerprint);
		const lease = await this.acquireTerminalWorkspace(turn);
		let previewId: string | undefined;
		try {
			const files = this.reviewedFiles(input.paths, evidence.files, input.projectId, input.sessionId, input.turnId, input.evidenceVersion, input.evidenceFingerprint);
			const sourceHead = evidence.afterRevision;
			if (!sourceHead) { throw new Error('Complete commit evidence has no exact post-turn Git source revision.'); }
			const preview = await this.worktrees.prepareReviewedCommit({ ownerId: turn.sessionId, sourceHead, commitMessage: input.commitMessage, files });
			previewId = preview.previewId;
			this.assertPreviewMatches(preview, turn, sourceHead, input.commitMessage, files);
			return this.database.agentSessionIntegrations.createProposal({
				projectId: turn.projectId, sessionId: turn.sessionId, turnId: turn.id,
				evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint,
				sourceHead: preview.sourceHead, proposedGitTreeHash: preview.proposedTreeOid, diffFingerprint: preview.rawDiffFingerprint,
				commitMessage: preview.commitMessage, author: preview.author, committer: preview.committer,
				paths: input.paths, expectedLatestRevision: input.expectedLatestRevision,
			});
		} finally {
			try {
				if (previewId) { this.worktrees.discardReviewedCommitPreview(previewId); }
			} finally { lease.release(); }
		}
	}

	approveProposal(input: AgentSessionCommitApprovalInput) {
		this.assertExactKeys(input, ['proposalId', 'expectedRevision', 'expectedFingerprint'], [], 'commit approval');
		const proposal = this.requireExactProposal(input);
		return this.database.agentSessionIntegrations.recordTrustedHumanApproval(proposal.id, proposal.revision);
	}

	async applyApprovedProposal(input: AgentSessionCommitApplyInput): Promise<AgentSessionIntegrationProposalDTO> {
		this.assertExactKeys(input, ['proposalId', 'expectedRevision', 'expectedFingerprint'], [], 'commit apply');
		const proposal = this.requireExactProposal(input);
		if (!proposal.approval || proposal.approval.proposalFingerprint !== proposal.fingerprint) { throw new Error('A trusted human approval for this exact commit proposal is required.'); }
		const latest = proposal.outcomes.at(-1);
		if (latest?.state === 'succeeded') { return proposal; }
		if (latest?.state === 'applying') { return this.recoverApplying({ ...input, operationId: latest.receipt.operationId }); }
		if (latest?.state === 'recoveryRequired') { return this.recoverApplying(input); }
		if (latest?.state === 'failed') { throw new Error('The previous commit attempt failed; prepare and approve a fresh proposal before retrying.'); }
		this.assertProposalCanStart(proposal);
		const turn = this.requireReviewableTurn(proposal.projectId, proposal.sessionId, proposal.turnId);
		const evidence = this.requireEvidence(proposal.projectId, proposal.sessionId, proposal.turnId, proposal.evidenceVersion, proposal.evidenceFingerprint);
		const lease = await this.acquireTerminalWorkspace(turn);
		let previewId: string | undefined;
		try {
			const files = this.reviewedFiles(this.pathInputs(proposal), evidence.files, proposal.projectId, proposal.sessionId, proposal.turnId, proposal.evidenceVersion, proposal.evidenceFingerprint);
			if (evidence.afterRevision !== proposal.sourceHead) { throw new Error('Approved proposal source revision no longer matches its retained evidence.'); }
			const preview = await this.worktrees.prepareReviewedCommit({
				ownerId: proposal.sessionWorktreeOwnerId, sourceHead: proposal.sourceHead, commitMessage: proposal.commitMessage, files,
				frozenIdentity: { author: proposal.author, committer: proposal.committer },
			});
			previewId = preview.previewId;
			this.assertPreviewMatchesProposal(preview, proposal, files);
			const candidate = await this.worktrees.createReviewedCommitCandidate(preview.previewId);
			if (candidate.sourceHead !== proposal.sourceHead || candidate.proposedTreeOid !== proposal.proposedGitTreeHash
				|| candidate.rawDiffFingerprint !== proposal.diffFingerprint || !this.samePaths(candidate.selectedPaths, this.bindingPaths(files))) {
				throw new Error('The created commit candidate does not match the approved proposal.');
			}
			const binding: ReviewedCommitBinding = {
				...candidate, ownerId: proposal.sessionWorktreeOwnerId, candidateCommitOid: candidate.candidateCommitOid,
				commitMessage: proposal.commitMessage, author: proposal.author, committer: proposal.committer,
				files: files.map(file => ({ path: file.path, before: this.metadata(file.before), after: this.metadata(file.after) })),
			};
			const operationId = randomUUID();
			const journal = this.journalFor(proposal, binding, operationId, proposal.outcomes.at(-1));
			const result = await this.worktrees.applyReviewedCommit({ operationId, binding, recordApplying: journal.recordApplying, readApplying: journal.readApplying });
			const applying = journal.getApplying();
			if (!applying) { throw new Error('Managed Git apply returned without its durable applying receipt.'); }
			this.recordApplyResult(proposal, binding, applying, result);
			return this.database.agentSessionIntegrations.getProposal(proposal.id)!;
		} finally {
			try {
				if (previewId) { this.worktrees.discardReviewedCommitPreview(previewId); }
			} finally { lease.release(); }
		}
	}

	async recoverApplying(input: AgentSessionCommitRecoveryInput): Promise<AgentSessionIntegrationProposalDTO> {
		this.assertExactKeys(input, ['proposalId', 'expectedRevision', 'expectedFingerprint'], ['operationId'], 'commit recovery');
		const proposal = this.requireExactProposal(input);
		if (!proposal.approval || proposal.approval.proposalFingerprint !== proposal.fingerprint) { throw new Error('A trusted human approval for this exact commit proposal is required.'); }
		let latest = proposal.outcomes.at(-1);
		if (!latest || !['applying', 'recoveryRequired'].includes(latest.state)) { throw new Error('Only an exact applying or recovery-required commit can be reconciled.'); }
		if (input.operationId && input.operationId !== latest.receipt.operationId) { throw new Error('Commit recovery operation ID does not match the durable receipt.'); }
		const turn = this.requireReviewableTurn(proposal.projectId, proposal.sessionId, proposal.turnId);
		const evidence = this.requireHistoricalEvidence(proposal.projectId, proposal.sessionId, proposal.turnId, proposal.evidenceVersion, proposal.evidenceFingerprint);
		const lease = await this.acquireTerminalWorkspace(turn);
		try {
			const files = this.reviewedFiles(this.pathInputs(proposal), evidence.files, proposal.projectId, proposal.sessionId, proposal.turnId, proposal.evidenceVersion, proposal.evidenceFingerprint);
			if (evidence.afterRevision !== proposal.sourceHead) { throw new Error('Recovery evidence source revision does not match the durable proposal.'); }
			const candidateHead = latest.receipt.candidateHead;
			const binding = this.recoveredBinding(proposal, files, candidateHead);
			let applying = latest;
			if (latest.state === 'recoveryRequired') {
				const operationId = randomUUID();
				const receipt = this.receipt(proposal, operationId, candidateHead, null, [], null);
				applying = this.database.agentSessionIntegrations.recordOutcome({
					proposalId: proposal.id, expectedOutcomeRevision: latest.revision, state: 'applying', action: 'commit', receipt, retryOfOutcomeId: latest.id,
				});
			}
			const journal = this.journalFor(proposal, binding, applying.receipt.operationId, applying);
			const result = await this.worktrees.reconcileReviewedCommit({ operationId: applying.receipt.operationId, binding, readApplying: journal.readApplying });
			this.recordApplyResult(proposal, binding, applying, result);
			return this.database.agentSessionIntegrations.getProposal(proposal.id)!;
		} finally {
			lease.release();
		}
	}

	private requireExactProposal(input: AgentSessionCommitApprovalInput): AgentSessionIntegrationProposalDTO {
		if (typeof input.proposalId !== 'string' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !/^[0-9a-f]{64}$/iu.test(input.expectedFingerprint)) {
			throw new Error('Commit proposal identity or fingerprint is invalid.');
		}
		const proposal = this.database.agentSessionIntegrations.getProposal(input.proposalId);
		if (!proposal || proposal.revision !== input.expectedRevision || proposal.fingerprint !== input.expectedFingerprint) { throw new Error('Commit proposal changed; review the latest exact proposal.'); }
		return proposal;
	}

	private requireReviewableTurn(projectId: string, sessionId: string, turnId: string): AgentSessionTurnDTO {
		const turn = this.database.agentSessionTurns.getTurn(projectId, sessionId, turnId);
		const session = this.database.agentSessions.getSession(projectId, sessionId);
		if (!turn || !session || turn.snapshot.projectId !== projectId || turn.snapshot.sessionId !== sessionId) { throw new Error('Commit operation requires the exact project, session, and turn.'); }
		if (session.workspaceMode !== 'gitWorktree' || ['starting', 'running', 'waitingForInput', 'waitingForApproval', 'stopping'].includes(session.state) || turn.snapshot.managedWorktreeOwnerId !== sessionId
			|| !['exited', 'failed', 'interrupted'].includes(turn.state) || turn.cleanupVerified !== true) {
			throw new Error('Commit operation requires a terminal cleaned turn in its idle app-managed Git worktree session.');
		}
		if (this.database.agentSessionTurns.listTurns(projectId, sessionId).some(candidate => candidate.state === 'starting' || candidate.state === 'running' || candidate.state === 'stopping' || candidate.cleanupVerified !== true)) {
			throw new Error('Another session turn has unresolved provider or cleanup state.');
		}
		return turn;
	}

	private requireEvidence(projectId: string, sessionId: string, turnId: string, version: number, fingerprint: string) {
		const latest = this.database.agentSessionChangeEvidence.getLatest(projectId, sessionId, turnId);
		if (!latest || latest.version !== version || latest.fingerprint !== fingerprint || latest.status !== 'observed' || latest.coverage !== 'complete') {
			throw new Error('Commit operation requires the latest complete observed content evidence.');
		}
		return latest;
	}

	private requireHistoricalEvidence(projectId: string, sessionId: string, turnId: string, version: number, fingerprint: string) {
		const evidence = this.database.agentSessionChangeEvidence.listVersions(projectId, sessionId, turnId, { afterVersion: version - 1, limit: 1 }).snapshots.find(snapshot => snapshot.version === version);
		if (!evidence || evidence.fingerprint !== fingerprint || evidence.status !== 'observed' || evidence.coverage !== 'complete') {
			throw new Error('Commit recovery requires the exact complete evidence bound to its durable applying receipt.');
		}
		return evidence;
	}

	private async acquireTerminalWorkspace(turn: AgentSessionTurnDTO): Promise<{ readonly workspace: AcquiredAgentSessionWorkspace; release(): void }> {
		const mutation = this.service.acquireIdleMutationLease({ projectId: turn.projectId, sessionId: turn.sessionId });
		let workspace: AcquiredAgentSessionWorkspace | undefined;
		try {
			workspace = await this.workspaceResolver.acquire({
				projectId: turn.projectId, sessionId: turn.sessionId, permissionPolicy: turn.snapshot.permissionPolicy,
			});
			await this.workspaceResolver.revalidate(workspace);
			if (workspace.snapshot.folderIdentity.canonicalPath !== turn.snapshot.folderIdentity.canonicalPath
				|| workspace.snapshot.folderIdentity.dev !== turn.snapshot.folderIdentity.dev || workspace.snapshot.folderIdentity.ino !== turn.snapshot.folderIdentity.ino) {
				throw new Error('Commit operation workspace identity differs from the exact turn snapshot.');
			}
			let released = false;
			return { workspace, release: () => {
				if (released) { return; }
				released = true;
				try {
					this.workspaceResolver.release(workspace!);
				} finally {
					mutation.release();
				}
			} };
		} catch (error) {
			let releaseError: unknown;
			try {
				if (workspace) { this.workspaceResolver.release(workspace); }
			} catch (error) {
				releaseError = error;
			}
			mutation.release();
			if (releaseError !== undefined) { throw new AggregateError([error, releaseError], 'Workspace acquisition and cleanup both failed.'); }
			throw error;
		}
	}

	private reviewedFiles(selected: readonly AgentSessionIntegrationPathInput[], evidenceFiles: readonly { readonly path: string; readonly previousPath?: string | null }[], projectId: string, sessionId: string, turnId: string, evidenceVersion: number, evidenceFingerprint: string): ReviewedCommitFileInput[] {
		if (!Array.isArray(selected) || selected.length < 1 || selected.length > 300) { throw new Error('Select between 1 and 300 evidence-backed paths for a commit proposal.'); }
		const files: ReviewedCommitFileInput[] = [];
		const addedPaths = new Set<string>();
		const add = (path: string, before: AgentSessionRawContentFileSide, after: AgentSessionRawContentFileSide) => {
			if (addedPaths.has(path)) { throw new Error('Selected commit paths resolve to a duplicate retained file.'); }
			addedPaths.add(path);
			files.push({ path, before: this.gitBefore(before), after: this.gitAfter(after) });
		};
		for (const selection of selected) {
			const observation = evidenceFiles.find(file => file.path === selection.path);
			if (!observation) { throw new Error('Selected commit path is not in the exact evidence version.'); }
			const current = this.rawEntry({ projectId, sessionId, turnId, evidenceVersion, evidenceFingerprint, path: selection.path });
			if (observation.previousPath && observation.previousPath !== selection.path) {
				const previous = this.rawEntry({ projectId, sessionId, turnId, evidenceVersion, evidenceFingerprint, path: observation.previousPath });
				if (previous.after.state !== 'absent' || current.before.state !== 'absent') { throw new Error('Rename evidence does not have exact retained before and after sides.'); }
				add(observation.previousPath, previous.before, { state: 'absent' });
				add(selection.path, { state: 'absent' }, current.after);
			} else {
				add(selection.path, current.before, current.after);
			}
		}
		return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	}

	private rawEntry(input: { readonly projectId: string; readonly sessionId: string; readonly turnId: string; readonly evidenceVersion: number; readonly evidenceFingerprint: string; readonly path: string }): AgentSessionRawContentFileDTO {
		const entry = this.database.agentSessionContents.getRawEntry({ scope: { projectId: input.projectId, sessionId: input.sessionId, turnId: input.turnId }, evidenceVersion: input.evidenceVersion, path: input.path, evidenceFingerprint: input.evidenceFingerprint });
		if (!entry) { throw new Error('Selected commit path has no immutable retained content entry.'); }
		return entry;
	}

	private gitBefore(side: AgentSessionRawContentFileSide): ReviewedCommitFileInput['before'] {
		if (side.state === 'absent') { return { absent: true }; }
		if (side.state !== 'retained') { throw new Error('Commit requires retained before bytes for each selected file.'); }
		return { mode: side.mode, sha256: side.sha256 };
	}

	private gitAfter(side: AgentSessionRawContentFileSide): ReviewedCommitFileInput['after'] {
		if (side.state === 'absent') { return { absent: true }; }
		if (side.state !== 'retained') { throw new Error('Commit requires retained after bytes for each selected file.'); }
		return { mode: side.mode, sha256: side.sha256, bytes: Buffer.from(side.bytes) };
	}

	private assertPreviewMatches(preview: ReviewedCommitPreview, turn: AgentSessionTurnDTO, sourceHead: string, commitMessage: string, files: readonly ReviewedCommitFileInput[]): void {
		if (preview.ownerId !== turn.sessionId || preview.sourceHead !== sourceHead || preview.commitMessage !== commitMessage || !this.samePaths(preview.files.map(file => file.path), this.bindingPaths(files))) {
			throw new Error('Managed Git preview does not match the exact turn and selected retained files.');
		}
	}

	private assertPreviewMatchesProposal(preview: ReviewedCommitPreview, proposal: AgentSessionIntegrationProposalDTO, files: readonly ReviewedCommitFileInput[]): void {
		if (preview.ownerId !== proposal.sessionWorktreeOwnerId || preview.sourceHead !== proposal.sourceHead || preview.proposedTreeOid !== proposal.proposedGitTreeHash
			|| preview.rawDiffFingerprint !== proposal.diffFingerprint || preview.commitMessage !== proposal.commitMessage
			|| JSON.stringify(preview.author) !== JSON.stringify(proposal.author) || JSON.stringify(preview.committer) !== JSON.stringify(proposal.committer)
			|| !this.samePaths(preview.files.map(file => file.path), this.bindingPaths(files))) {
			throw new Error('Fresh managed Git preview no longer matches the approved proposal identity.');
		}
	}

	private pathInputs(proposal: AgentSessionIntegrationProposalDTO): AgentSessionIntegrationPathInput[] {
		return proposal.paths.map(path => ({ path: path.path, explanationTargets: path.explanations.map(explanation => ({ path: explanation.path, hunkId: explanation.hunkId, revision: explanation.revision })) }));
	}

	private bindingPaths(files: readonly ReviewedCommitFileInput[]): string[] { return files.map(file => file.path).sort(); }
	private samePaths(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((path, index) => path === right[index]); }

	private metadata(side: ReviewedCommitFileInput['before'] | ReviewedCommitFileInput['after']) {
		return 'absent' in side ? { absent: true as const } : { mode: side.mode, sha256: side.sha256 };
	}

	private recoveredBinding(proposal: AgentSessionIntegrationProposalDTO, files: readonly ReviewedCommitFileInput[], candidateCommitOid: string): ReviewedCommitBinding {
		return {
			state: 'candidate', candidateCommitOid, sourceHead: proposal.sourceHead, proposedTreeOid: proposal.proposedGitTreeHash,
			rawDiffFingerprint: proposal.diffFingerprint, selectedPaths: this.bindingPaths(files), ownerId: proposal.sessionWorktreeOwnerId,
			commitMessage: proposal.commitMessage, author: proposal.author, committer: proposal.committer,
			files: files.map(file => ({ path: file.path, before: this.metadata(file.before), after: this.metadata(file.after) })),
		};
	}

	private sameBinding(left: ReviewedCommitBinding, right: ReviewedCommitBinding): boolean {
		const normalize = (binding: ReviewedCommitBinding): ReviewedCommitBinding => ({
			state: binding.state,
			ownerId: binding.ownerId,
			candidateCommitOid: binding.candidateCommitOid,
			sourceHead: binding.sourceHead,
			proposedTreeOid: binding.proposedTreeOid,
			rawDiffFingerprint: binding.rawDiffFingerprint,
			selectedPaths: [...binding.selectedPaths],
			commitMessage: binding.commitMessage,
			author: { name: binding.author.name, email: binding.author.email, date: binding.author.date },
			committer: { name: binding.committer.name, email: binding.committer.email, date: binding.committer.date },
			files: binding.files.map(file => ({
				path: file.path,
				before: this.metadata(file.before),
				after: this.metadata(file.after),
			})),
		});
		return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
	}

	private journalFor(proposal: AgentSessionIntegrationProposalDTO, binding: ReviewedCommitBinding, operationId: string, prior?: AgentSessionIntegrationOutcomeDTO) {
		let applying: AgentSessionIntegrationOutcomeDTO | undefined = prior?.state === 'applying' ? prior : undefined;
		return {
			recordApplying: async (record: ReviewedCommitApplyingRecord) => {
				if (record.operationId !== operationId || !this.sameBinding(record.binding, binding)) {
					throw new Error('Managed Git apply requested a journal entry outside the exact approved candidate.');
				}
				const receipt = this.receipt(proposal, operationId, binding.candidateCommitOid, null, [], null);
				applying = this.database.agentSessionIntegrations.recordOutcome({
					proposalId: proposal.id, expectedOutcomeRevision: prior?.revision ?? 0, state: 'applying', action: 'commit', receipt,
					...(prior ? { retryOfOutcomeId: prior.id } : {}),
				});
			},
			readApplying: async (operationId: string) => {
				const current = this.database.agentSessionIntegrations.getProposal(proposal.id);
				const record = current?.outcomes.find(outcome => outcome.state === 'applying' && outcome.receipt.operationId === operationId);
				if (!record || record.receipt.candidateHead !== binding.candidateCommitOid || record.receipt.sourceHead !== binding.sourceHead
					|| record.receipt.proposedGitTreeHash !== binding.proposedTreeOid || record.receipt.diffFingerprint !== binding.rawDiffFingerprint) { return undefined; }
				return { operationId, binding };
			},
			getApplying: () => applying,
		};
	}

	private recordApplyResult(proposal: AgentSessionIntegrationProposalDTO, binding: ReviewedCommitBinding, applying: AgentSessionIntegrationOutcomeDTO, result: ReviewedCommitApplyResult): void {
		const succeeded = result.state === 'applied' || result.state === 'alreadyApplied';
		const receipt = this.receipt(proposal, applying.receipt.operationId, binding.candidateCommitOid,
			succeeded ? result.currentRef : null, succeeded ? binding.selectedPaths : [], succeeded ? null : 'commit.recovery-required');
		this.database.agentSessionIntegrations.recordOutcome({ proposalId: proposal.id, expectedOutcomeRevision: applying.revision,
			state: succeeded ? 'succeeded' : 'recoveryRequired', action: 'commit', receipt });
	}

	private receipt(proposal: AgentSessionIntegrationProposalDTO, operationId: string, candidateHead: string, resultingHead: string | null, changedPaths: readonly string[], failureCode: string | null): AgentSessionIntegrationActionReceipt {
		return { operationId, sourceHead: proposal.sourceHead, proposedGitTreeHash: proposal.proposedGitTreeHash,
			diffFingerprint: proposal.diffFingerprint, candidateHead, resultingHead, changedPaths: [...changedPaths], failureCode };
	}

	private assertProposalCanStart(proposal: AgentSessionIntegrationProposalDTO): void {
		if (Date.parse(proposal.expiresAt) <= Date.now()) { throw new Error('Commit proposal expired; prepare and approve a fresh exact proposal.'); }
		if (this.database.agentSessionIntegrations.listProposals(proposal.projectId, proposal.sessionId, proposal.turnId, { afterRevision: proposal.revision, limit: 1 }).proposals.length) {
			throw new Error('Only the latest commit proposal can be applied.');
		}
	}

	private assertExactKeys(value: unknown, required: readonly string[], optional: readonly string[], label: string): void {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`${label} must be an object.`); }
		const object = value as Record<string, unknown>;
		const allowed = new Set([...required, ...optional]);
		if (required.some(key => !Object.hasOwn(object, key)) || Object.keys(object).some(key => !allowed.has(key))) { throw new Error(`${label} contains missing or unknown fields.`); }
	}
}
