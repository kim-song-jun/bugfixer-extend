/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type {
	AgentSessionMergeApprovalDTO, AgentSessionMergeApplyingBinding, AgentSessionMergeOutcomeDTO,
	AgentSessionMergeOutcomeState, AgentSessionMergePathDTO, AgentSessionMergeProposalDTO, AgentSessionMergeReceipt,
	AgentSessionMergeArtifactEvent, AgentSessionMergeArtifactRecord, AgentSessionMergeConflictArtifact,
	AgentSessionMergePriorGeneration, AgentSessionMergeResolutionDTO, WorkspaceAgentMergeProposalPageDTO,
} from '../../common/workspaceAgentMergeProtocol.js';
import { AGENT_SESSION_MERGE_PROPOSAL_PAGE_LIMIT } from '../../common/workspaceAgentMergeProtocol.js';
import type { AgentSessionIntegrationGitIdentity, AgentSessionIntegrationProposalDTO } from '../../common/workspaceAgentIntegrationProtocol.js';
import type { AgentSessionTurnDTO } from '../../common/workspaceAgentSessionProtocol.js';
import type { AgentSessionStore } from './agentSessionStore.js';

export type {
	AgentSessionMergeApprovalDTO, AgentSessionMergeApplyingBinding, AgentSessionMergeOutcomeDTO,
	AgentSessionMergeOutcomeState, AgentSessionMergePathDTO, AgentSessionMergeProposalDTO, AgentSessionMergeReceipt,
	AgentSessionMergeArtifactEvent, AgentSessionMergeArtifactRecord,
} from '../../common/workspaceAgentMergeProtocol.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_PROPOSAL_BYTES = 5 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_PATHS = 300;
const MAX_PROPOSAL_TTL_MS = 10 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_CONFLICTS = 300;

interface AgentSessionMergeStoreBinding {
	readonly id: string;
	readonly projectId: string;
	readonly vcsKind: 'git' | 'jj' | null;
	readonly vcsRoot: string | null;
}

interface MergeProposalPayload {
	readonly resolution?: AgentSessionMergeResolutionDTO;
	readonly diffText: string;
	readonly commitMessage: string;
	readonly author: AgentSessionIntegrationGitIdentity;
	readonly committer: AgentSessionIntegrationGitIdentity;
	readonly paths: readonly AgentSessionMergePathDTO[];
}

interface MergeProposalRow extends Readonly<Record<string, SQLOutputValue>> {
	readonly id: SQLOutputValue;
	readonly project_id: SQLOutputValue;
	readonly binding_id: SQLOutputValue;
	readonly session_id: SQLOutputValue;
	readonly turn_id: SQLOutputValue;
	readonly revision: SQLOutputValue;
	readonly commit_proposal_id: SQLOutputValue;
	readonly commit_proposal_revision: SQLOutputValue;
	readonly commit_proposal_fingerprint: SQLOutputValue;
	readonly integration_owner_id: SQLOutputValue;
	readonly source_head: SQLOutputValue;
	readonly target_head: SQLOutputValue;
	readonly merge_base: SQLOutputValue;
	readonly diff_fingerprint: SQLOutputValue;
	readonly proposal_fingerprint: SQLOutputValue;
	readonly payload_json: SQLOutputValue;
	readonly created_at: SQLOutputValue;
	readonly expires_at: SQLOutputValue;
}

interface MergeApprovalRow extends Readonly<Record<string, SQLOutputValue>> {
	readonly id: SQLOutputValue;
	readonly proposal_id: SQLOutputValue;
	readonly proposal_fingerprint: SQLOutputValue;
	readonly actor: SQLOutputValue;
	readonly approved_at: SQLOutputValue;
}

interface MergeOutcomeRow extends Readonly<Record<string, SQLOutputValue>> {
	readonly id: SQLOutputValue;
	readonly proposal_id: SQLOutputValue;
	readonly revision: SQLOutputValue;
	readonly state: SQLOutputValue;
	readonly receipt_json: SQLOutputValue;
	readonly retry_of_outcome_id: SQLOutputValue;
	readonly recorded_at: SQLOutputValue;
}

interface MergeArtifactRow extends Readonly<Record<string, SQLOutputValue>> {
	readonly operation_id: SQLOutputValue;
	readonly proposal_id: SQLOutputValue;
	readonly revision: SQLOutputValue;
	readonly phase: SQLOutputValue;
	readonly event_json: SQLOutputValue;
}

/** Immutable merge reviews and host-produced operation receipts; no Git command runs here. */
export class AgentSessionMergeStore {
	constructor(
		private readonly db: DatabaseSync,
		private readonly assertOpen: () => void,
		private readonly getBinding: (projectId: string, bindingId: string) => AgentSessionMergeStoreBinding | undefined,
		private readonly getTurn: (projectId: string, sessionId: string, turnId: string) => AgentSessionTurnDTO | undefined,
		private readonly getCommitProposal: (proposalId: string) => AgentSessionIntegrationProposalDTO | undefined,
		private readonly sessions: AgentSessionStore,
	) { }

	getOrCreateIntegrationOwner(projectId: string, bindingId: string): string {
		this.assertOpen();
		this.assertUuid(projectId, 'project ID'); this.assertUuid(bindingId, 'folder binding ID');
		const binding = this.requireGitBinding(projectId, bindingId);
		return this.transaction(() => {
			const existing = this.db.prepare(`SELECT integration_owner_id, repository_root FROM agent_session_merge_workspaces
				WHERE project_id = ? AND binding_id = ?`).get(projectId, bindingId) as { integration_owner_id: SQLOutputValue; repository_root: SQLOutputValue } | undefined;
			if (existing) {
				if (String(existing.repository_root) !== binding.vcsRoot) { throw new Error('The Git repository root changed for this integration binding; explicit recovery is required.'); }
				return String(existing.integration_owner_id);
			}
			const integrationOwnerId = randomUUID();
			this.db.prepare(`INSERT INTO agent_session_merge_workspaces (project_id, binding_id, integration_owner_id, repository_root, created_at)
				VALUES (?, ?, ?, ?, ?)`).run(projectId, bindingId, integrationOwnerId, binding.vcsRoot, new Date().toISOString());
			return integrationOwnerId;
		});
	}

	createProposal(input: {
		readonly resolution?: AgentSessionMergeResolutionDTO;
		readonly projectId: string;
		readonly sessionId: string;
		readonly turnId: string;
		readonly commitProposalId: string;
		readonly commitProposalRevision: number;
		readonly commitProposalFingerprint: string;
		readonly integrationOwnerId: string;
		readonly sourceHead: string;
		readonly targetHead: string;
		readonly mergeBase: string;
		readonly diffFingerprint: string;
		readonly diffText: string;
		readonly commitMessage: string;
		readonly author: AgentSessionIntegrationGitIdentity;
		readonly committer: AgentSessionIntegrationGitIdentity;
		readonly changedPaths: readonly string[];
		readonly expectedLatestRevision: number;
	}): AgentSessionMergeProposalDTO {
		this.assertOpen();
		this.assertExactKeys(input, ['projectId', 'sessionId', 'turnId', 'commitProposalId', 'commitProposalRevision', 'commitProposalFingerprint', 'integrationOwnerId', 'sourceHead', 'targetHead', 'mergeBase', 'diffFingerprint', 'diffText', 'commitMessage', 'author', 'committer', 'changedPaths', 'expectedLatestRevision'], ['resolution'], 'merge proposal');
		const scope = this.normalizeScope(input.projectId, input.sessionId, input.turnId);
		this.assertUuid(input.commitProposalId, 'source commit proposal ID'); this.assertUuid(input.integrationOwnerId, 'integration worktree owner ID');
		if (!Number.isSafeInteger(input.commitProposalRevision) || input.commitProposalRevision < 1 || !SHA256_PATTERN.test(input.commitProposalFingerprint)) { throw new Error('Merge source commit proposal identity is invalid.'); }
		if (!Number.isSafeInteger(input.expectedLatestRevision) || input.expectedLatestRevision < 0) { throw new Error('Expected merge proposal revision is invalid.'); }
		const oids = [input.sourceHead, input.targetHead, input.mergeBase];
		if (oids.some(value => typeof value !== 'string' || !GIT_OBJECT_PATTERN.test(value) || value !== value.toLowerCase()) || new Set(oids.map(value => value.length)).size !== 1) { throw new Error('Merge source, target, and base must be lowercase full Git object IDs using one object format.'); }
		if (!SHA256_PATTERN.test(input.diffFingerprint)) { throw new Error('Merge diff SHA-256 is invalid.'); }
		if (typeof input.diffText !== 'string' || input.diffText.includes('\0')) { throw new Error('Merge diff must be complete NUL-free UTF-8 text.'); }
		const diffBytes = Buffer.from(input.diffText, 'utf8');
		if (diffBytes.byteLength > MAX_DIFF_BYTES || diffBytes.toString('utf8') !== input.diffText) { throw new Error('Merge diff exceeds four MiB or is not canonical UTF-8.'); }
		if (digestBytes(diffBytes) !== input.diffFingerprint) { throw new Error('Merge diff text does not match its full SHA-256 fingerprint.'); }
		const commitMessage = this.normalizeText(input.commitMessage, 1024, 'merge commit message');
		if (commitMessage !== `Merge reviewed session ${scope.sessionId}`) { throw new Error('Merge commit message must use the host-defined reviewed-session message.'); }
		const author = this.normalizeGitIdentity(input.author, 'author'); const committer = this.normalizeGitIdentity(input.committer, 'committer');
		const resolution = input.resolution === undefined ? undefined : this.normalizeResolution(input.resolution);
		const changedPaths = resolution && Array.isArray(input.changedPaths) && !input.changedPaths.length ? [] : this.normalizePaths(input.changedPaths);
		if (resolution) { this.assertResolutionOrigin(resolution, input); }
		const turn = this.requireTurn(scope.projectId, scope.sessionId, scope.turnId);
		const bindingId = turn.snapshot.bindingId;
		if (!bindingId || turn.snapshot.managedWorktreeOwnerId !== scope.sessionId) { throw new Error('Merge proposal requires the exact managed session worktree from the source turn.'); }
		const integrationOwnerId = this.getOrCreateIntegrationOwner(scope.projectId, bindingId);
		if (integrationOwnerId !== input.integrationOwnerId) { throw new Error('Renderer-supplied integration owner does not match the persisted project Git binding.'); }
		const commitProposal = this.requireSuccessfulCommitProposal({
			projectId: scope.projectId, sessionId: scope.sessionId, turnId: scope.turnId,
			proposalId: input.commitProposalId, revision: input.commitProposalRevision, fingerprint: input.commitProposalFingerprint, resultingHead: input.sourceHead,
		});
		const paths = resolution ? changedPaths.map(path => ({ path, explanationState: 'unknown' as const, explanations: [] })) : this.linkPaths(changedPaths, commitProposal);
		const payload: MergeProposalPayload = { diffText: input.diffText, commitMessage, author, committer, paths, ...(resolution ? { resolution } : {}) };
		const payloadJson = JSON.stringify(payload);
		if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PROPOSAL_BYTES) { throw new Error('Merge proposal payload exceeds five MiB.'); }
		const proposalFingerprint = digest(JSON.stringify({ projectId: scope.projectId, bindingId, sessionId: scope.sessionId, turnId: scope.turnId, commitProposalId: input.commitProposalId, commitProposalRevision: input.commitProposalRevision,
			commitProposalFingerprint: input.commitProposalFingerprint, integrationOwnerId, sourceHead: input.sourceHead, targetHead: input.targetHead,
			mergeBase: input.mergeBase, diffFingerprint: input.diffFingerprint, payload }));
		return this.transaction(() => {
			const latest = this.latestProposalRow(scope.projectId, scope.sessionId, scope.turnId);
			const latestRevision = latest ? Number(latest.revision) : 0;
			if (latestRevision === input.expectedLatestRevision + 1 && latest && String(latest.proposal_fingerprint) === proposalFingerprint) { return this.proposalFromRow(latest); }
			if (latestRevision !== input.expectedLatestRevision) { throw new Error('Merge proposal revision is stale.'); }
			const id = randomUUID(); const createdAt = new Date().toISOString();
			const expiresAt = new Date(Date.parse(createdAt) + MAX_PROPOSAL_TTL_MS).toISOString();
			this.db.prepare(`INSERT INTO agent_session_merge_proposals
				(id, project_id, binding_id, session_id, turn_id, revision, commit_proposal_id, commit_proposal_revision, commit_proposal_fingerprint,
				integration_owner_id, source_head, target_head, merge_base, diff_fingerprint, proposal_fingerprint, payload_json, created_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				id, scope.projectId, bindingId, scope.sessionId, scope.turnId, latestRevision + 1, input.commitProposalId, input.commitProposalRevision,
				input.commitProposalFingerprint, integrationOwnerId, input.sourceHead, input.targetHead, input.mergeBase,
				input.diffFingerprint, proposalFingerprint, payloadJson, createdAt, expiresAt,
			);
			this.sessions.recordNotificationWithinTransaction({
				eventId: `mergeProposal:${id}:review`, projectId: scope.projectId, sessionId: scope.sessionId,
				kind: 'approval', target: { kind: 'mergeProposal', id, turnId: scope.turnId }, createdAt,
			});
			return this.getProposal(id)!;
		});
	}

	getProposal(proposalId: string): AgentSessionMergeProposalDTO | undefined {
		this.assertOpen(); this.assertUuid(proposalId, 'merge proposal ID');
		const row = this.db.prepare(`SELECT id, project_id, binding_id, session_id, turn_id, revision, commit_proposal_id, commit_proposal_revision,
			commit_proposal_fingerprint, integration_owner_id, source_head, target_head, merge_base, diff_fingerprint, proposal_fingerprint,
			payload_json, created_at, expires_at FROM agent_session_merge_proposals WHERE id = ?`).get(proposalId) as MergeProposalRow | undefined;
		return row ? this.proposalFromRow(row) : undefined;
	}

	listProposals(projectId: string, sessionId: string, turnId: string, options: { readonly afterRevision?: number; readonly limit?: number } = {}): WorkspaceAgentMergeProposalPageDTO {
		this.assertOpen(); const scope = this.normalizeScope(projectId, sessionId, turnId); this.requireTurn(scope.projectId, scope.sessionId, scope.turnId);
		this.assertExactKeys(options, [], ['afterRevision', 'limit'], 'merge proposal page');
		const afterRevision = options.afterRevision ?? 0; const limit = options.limit ?? AGENT_SESSION_MERGE_PROPOSAL_PAGE_LIMIT;
		if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_SESSION_MERGE_PROPOSAL_PAGE_LIMIT) { throw new Error('Merge proposal page bounds are invalid.'); }
		const rows = this.db.prepare(`SELECT id, project_id, binding_id, session_id, turn_id, revision, commit_proposal_id, commit_proposal_revision,
			commit_proposal_fingerprint, integration_owner_id, source_head, target_head, merge_base, diff_fingerprint, proposal_fingerprint,
			payload_json, created_at, expires_at FROM agent_session_merge_proposals
			WHERE project_id = ? AND session_id = ? AND turn_id = ? AND revision > ? ORDER BY revision LIMIT ?`)
			.all(scope.projectId, scope.sessionId, scope.turnId, afterRevision, limit) as MergeProposalRow[];
		const proposals = rows.map(row => this.proposalFromRow(row)); const nextRevision = proposals.at(-1)?.revision ?? afterRevision;
		const hasMore = !!this.db.prepare(`SELECT 1 FROM agent_session_merge_proposals WHERE project_id = ? AND session_id = ? AND turn_id = ? AND revision > ? LIMIT 1`)
			.get(scope.projectId, scope.sessionId, scope.turnId, nextRevision);
		return { proposals, nextRevision, hasMore };
	}

	recordTrustedHumanApproval(proposalId: string, expectedRevision: number, expectedFingerprint: string): AgentSessionMergeApprovalDTO {
		this.assertOpen(); this.assertUuid(proposalId, 'merge proposal ID');
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !SHA256_PATTERN.test(expectedFingerprint)) { throw new Error('Merge proposal approval identity is invalid.'); }
		return this.transaction(() => {
			const proposal = this.requireProposalRow(proposalId); const dto = this.proposalFromRow(proposal);
			if (dto.revision !== expectedRevision || dto.fingerprint !== expectedFingerprint) { throw new Error('Merge approval proposal tuple is stale.'); }
			const existing = this.approvalRow(proposalId);
			if (existing) {
				if (String(existing.proposal_fingerprint) !== dto.fingerprint) { throw new Error('Merge approval fingerprint does not match its immutable proposal.'); }
				return this.approvalFromRow(existing);
			}
			if (this.latestProposalRow(dto.projectId, dto.sessionId, dto.turnId)?.id !== proposalId) { throw new Error('An older merge proposal cannot receive a new approval.'); }
			if (Date.parse(dto.expiresAt) <= Date.now()) { throw new Error('Merge proposal approval has expired.'); }
			const id = randomUUID(); const approvedAt = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_session_merge_approvals (id, proposal_id, proposal_fingerprint, actor, approved_at) VALUES (?, ?, ?, 'human', ?)`)
				.run(id, proposalId, dto.fingerprint, approvedAt);
			return this.approvalFromRow(this.approvalRow(proposalId)!);
		});
	}

	getApplyingBinding(proposalId: string, operationId: string): AgentSessionMergeApplyingBinding | undefined {
		this.assertOpen(); this.assertUuid(proposalId, 'merge proposal ID'); this.assertUuid(operationId, 'merge operation ID');
		const proposal = this.getProposal(proposalId);
		const outcome = proposal?.outcomes.find(item => item.receipt.operationId === operationId && item.state === 'applying');
		return outcome ? this.applyingBinding(outcome.receipt) : undefined;
	}

	/** Persist one strict, append-only phase against the exact durable applying receipt for this operation. */
	recordArtifact(operationId: string, expectedRevision: number, event: AgentSessionMergeArtifactEvent): AgentSessionMergeArtifactRecord {
		this.assertOpen(); this.assertUuid(operationId, 'merge operation ID');
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) { throw new Error('Merge artifact revision is invalid.'); }
		const normalized = this.normalizeArtifact(event); const eventJson = JSON.stringify(normalized);
		if (Buffer.byteLength(eventJson, 'utf8') > MAX_ARTIFACT_BYTES) { throw new Error('Merge artifact exceeds two MiB.'); }
		return this.transaction(() => {
			const binding = this.requireApplyingBindingForOperation(operationId);
			const latestOutcome = this.latestOutcomeRow(binding.proposalId);
			if (!latestOutcome || !['applying', 'recoveryRequired'].includes(String(latestOutcome.state))) { throw new Error('Merge artifacts may advance only while the exact operation is applying or explicitly recovering.'); }
			const records = this.readArtifactRows(operationId, binding);
			const latestRevision = records.at(-1)?.revision ?? 0;
			if (latestRevision === expectedRevision + 1) {
				const prior = records.at(-1)!;
				if (JSON.stringify(prior.event) === eventJson) { return prior; }
				throw new Error('Merge artifact revision was already recorded with different content.');
			}
			if (latestRevision !== expectedRevision) { throw new Error('Merge artifact revision is stale.'); }
			this.validateNextArtifact(binding, records.map(record => record.event), normalized);
			const revision = latestRevision + 1;
			this.db.prepare(`INSERT INTO agent_session_merge_artifacts (operation_id, proposal_id, revision, phase, event_json, recorded_at)
				VALUES (?, ?, ?, ?, ?, ?)`).run(operationId, binding.proposalId, revision, normalized.phase, eventJson, new Date().toISOString());
			return { revision, event: normalized };
		});
	}

	/** Readback validates the complete immutable event chain against its persisted applying receipt. */
	readArtifacts(operationId: string): readonly AgentSessionMergeArtifactRecord[] {
		this.assertOpen(); this.assertUuid(operationId, 'merge operation ID');
		const binding = this.requireApplyingBindingForOperation(operationId);
		return this.readArtifactRows(operationId, binding);
	}

	recordOutcome(input: {
		readonly proposalId: string;
		readonly expectedOutcomeRevision: number;
		readonly state: AgentSessionMergeOutcomeState;
		readonly receipt: AgentSessionMergeReceipt;
		readonly retryOfOutcomeId?: string | null;
	}): AgentSessionMergeOutcomeDTO {
		this.assertOpen();
		this.assertExactKeys(input, ['proposalId', 'expectedOutcomeRevision', 'state', 'receipt'], ['retryOfOutcomeId'], 'merge outcome');
		this.assertUuid(input.proposalId, 'merge proposal ID');
		if (!Number.isSafeInteger(input.expectedOutcomeRevision) || input.expectedOutcomeRevision < 0 || !['applying', 'merged', 'conflict', 'notApplied', 'recoveryRequired', 'failed'].includes(input.state)) { throw new Error('Merge outcome state or revision is invalid.'); }
		const retryOfOutcomeId = input.retryOfOutcomeId ?? null; if (retryOfOutcomeId !== null) { this.assertUuid(retryOfOutcomeId, 'retry outcome ID'); }
		const receipt = this.normalizeReceipt(input.receipt); const receiptJson = JSON.stringify(receipt);
		if (Buffer.byteLength(receiptJson, 'utf8') > MAX_RECEIPT_BYTES) { throw new Error('Merge outcome receipt exceeds 32 KiB.'); }
		const payloadFingerprint = digest(JSON.stringify({ state: input.state, receipt, retryOfOutcomeId }));
		return this.transaction(() => {
			const row = this.requireProposalRow(input.proposalId); const proposal = this.proposalFromRow(row);
			if (!proposal.approval || proposal.approval.proposalFingerprint !== proposal.fingerprint) { throw new Error('A trusted human approval for this exact merge proposal is required.'); }
			this.assertReceiptMatchesProposal(receipt, proposal);
			this.validateOutcomeReceipt(input.state, receipt, proposal);
			const latest = this.latestOutcomeRow(input.proposalId); const latestRevision = latest ? Number(latest.revision) : 0;
			if (latestRevision === input.expectedOutcomeRevision + 1 && latest && digest(JSON.stringify({ state: String(latest.state), receipt: JSON.parse(String(latest.receipt_json)), retryOfOutcomeId: latest.retry_of_outcome_id ?? null })) === payloadFingerprint) { return this.outcomeFromRow(latest); }
			if (latestRevision !== input.expectedOutcomeRevision) { throw new Error('Merge outcome revision is stale.'); }
			if (latestRevision >= 100) { throw new Error('Merge proposal outcome history reached its 100-receipt limit.'); }
			const previous = latest ? this.outcomeFromRow(latest) : undefined;
			if (!previous) {
				if (input.state !== 'applying' || retryOfOutcomeId !== null) { throw new Error('An approved merge must begin with a durable applying receipt.'); }
				if (Date.parse(proposal.expiresAt) <= Date.now() || this.latestProposalRow(proposal.projectId, proposal.sessionId, proposal.turnId)?.id !== proposal.id) { throw new Error('A new merge attempt requires the latest unexpired proposal and approval.'); }
			} else {
				if (!['applying', 'recoveryRequired'].includes(previous.state) || input.state === 'applying' || retryOfOutcomeId !== previous.id) { throw new Error('Only exact journal reconciliation may append after a merge applying or recovery-required receipt.'); }
				if (receipt.operationId !== previous.receipt.operationId) { throw new Error('Merge reconciliation must preserve the exact operation ID.'); }
			}
			const id = randomUUID(); const recordedAt = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_session_merge_outcomes (id, proposal_id, revision, state, receipt_json, retry_of_outcome_id, recorded_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.proposalId, latestRevision + 1, input.state, receiptJson, retryOfOutcomeId, recordedAt);
			return this.outcomeFromRow(this.latestOutcomeRow(input.proposalId)!);
		});
	}

	private proposalMetadataFromRow(row: MergeProposalRow): Omit<AgentSessionMergeProposalDTO, 'state' | 'outcomes' | 'artifacts'> {
		const projectId = String(row.project_id); const bindingId = String(row.binding_id); const sessionId = String(row.session_id); const turnId = String(row.turn_id);
		const turn = this.requireTurn(projectId, sessionId, turnId);
		if (turn.snapshot.bindingId !== bindingId || turn.snapshot.managedWorktreeOwnerId !== sessionId) { throw new Error('Merge proposal turn no longer matches its persisted Git binding.'); }
		const ownerId = this.requireMappedIntegrationOwner(projectId, bindingId, String(row.integration_owner_id));
		this.requireSuccessfulCommitProposal({ projectId, sessionId, turnId, proposalId: String(row.commit_proposal_id),
			revision: Number(row.commit_proposal_revision), fingerprint: String(row.commit_proposal_fingerprint), resultingHead: String(row.source_head) });
		const payloadJson = String(row.payload_json);
		if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PROPOSAL_BYTES) { throw new Error('Persisted merge proposal exceeds its payload limit.'); }
		const rawPayload: unknown = JSON.parse(payloadJson);
		this.assertExactKeys(rawPayload, ['diffText', 'commitMessage', 'author', 'committer', 'paths'], ['resolution'], 'persisted merge proposal payload');
		const raw = rawPayload as Record<string, unknown>;
		if (typeof raw.diffText !== 'string') { throw new Error('Persisted merge diff text is invalid.'); }
		const commitMessage = this.normalizeText(raw.commitMessage, 1024, 'persisted merge commit message');
		if (commitMessage !== `Merge reviewed session ${sessionId}`) { throw new Error('Persisted merge commit message is invalid.'); }
		const author = this.normalizeGitIdentity(raw.author, 'persisted author'); const committer = this.normalizeGitIdentity(raw.committer, 'persisted committer');
		const diffBytes = Buffer.from(raw.diffText, 'utf8');
		if (diffBytes.byteLength > MAX_DIFF_BYTES || diffBytes.toString('utf8') !== raw.diffText || raw.diffText.includes('\0') || digestBytes(diffBytes) !== String(row.diff_fingerprint)) { throw new Error('Persisted merge diff is incomplete or its fingerprint changed.'); }
		const resolution = raw.resolution === undefined ? undefined : this.normalizeResolution(raw.resolution);
		if (resolution) { this.assertResolutionOrigin(resolution, { projectId, sessionId, turnId, commitProposalId: String(row.commit_proposal_id), integrationOwnerId: ownerId, sourceHead: String(row.source_head), targetHead: String(row.target_head), mergeBase: String(row.merge_base) }); }
		const paths = resolution && Array.isArray(raw.paths) && !raw.paths.length ? [] : this.normalizePathDTOs(raw.paths);
		const payload: MergeProposalPayload = { diffText: raw.diffText, commitMessage, author, committer, paths, ...(resolution ? { resolution } : {}) };
		if (JSON.stringify(payload) !== payloadJson) { throw new Error('Persisted merge proposal payload is not canonical.'); }
		const scope = { projectId, bindingId, sessionId, turnId };
		const fingerprint = digest(JSON.stringify({ ...scope, commitProposalId: String(row.commit_proposal_id), commitProposalRevision: Number(row.commit_proposal_revision),
			commitProposalFingerprint: String(row.commit_proposal_fingerprint), integrationOwnerId: ownerId, sourceHead: String(row.source_head),
			targetHead: String(row.target_head), mergeBase: String(row.merge_base), diffFingerprint: String(row.diff_fingerprint), payload }));
		if (fingerprint !== String(row.proposal_fingerprint)) { throw new Error('Merge proposal fingerprint does not match its immutable payload.'); }
		const approvalRow = this.approvalRow(String(row.id)); const approval = approvalRow ? this.approvalFromRow(approvalRow) : null;
		if (approval && approval.proposalFingerprint !== fingerprint) { throw new Error('Merge approval is not bound to the exact proposal fingerprint.'); }
		return { kind: 'merge', id: String(row.id), ...scope, revision: Number(row.revision), commitProposalId: String(row.commit_proposal_id),
			commitProposalRevision: Number(row.commit_proposal_revision), commitProposalFingerprint: String(row.commit_proposal_fingerprint),
			sessionOwnerId: sessionId, integrationOwnerId: ownerId, sourceHead: String(row.source_head), targetHead: String(row.target_head),
			mergeBase: String(row.merge_base), diffFingerprint: String(row.diff_fingerprint), diffText: raw.diffText, commitMessage, author, committer, paths,
			fingerprint, createdAt: String(row.created_at), expiresAt: String(row.expires_at), approval, ...(resolution ? { resolution } : {}) };
	}

	private normalizeResolution(value: unknown): AgentSessionMergeResolutionDTO {
		this.assertExactKeys(value, ['proposalId', 'operationId', 'generationId', 'registrationId', 'treeOid', 'indexDigest', 'treeDigest', 'indexFileDigest'], [], 'conflict resolution');
		const raw = value as Record<string, unknown>;
		for (const key of ['proposalId', 'operationId', 'generationId', 'registrationId']) { this.assertUuid(raw[key], `resolution ${key}`); }
		if (typeof raw.treeOid !== 'string' || !GIT_OBJECT_PATTERN.test(raw.treeOid) || raw.treeOid !== raw.treeOid.toLowerCase()
			|| typeof raw.indexFileDigest !== 'string' || !SHA256_PATTERN.test(raw.indexFileDigest)
			|| typeof raw.indexDigest !== 'string' || !SHA256_PATTERN.test(raw.indexDigest) || typeof raw.treeDigest !== 'string' || !SHA256_PATTERN.test(raw.treeDigest)) { throw new Error('Conflict resolution tree or index fingerprint is invalid.'); }
		return { proposalId: String(raw.proposalId), operationId: String(raw.operationId), generationId: String(raw.generationId), registrationId: String(raw.registrationId), treeOid: raw.treeOid, indexDigest: raw.indexDigest, treeDigest: raw.treeDigest, indexFileDigest: raw.indexFileDigest };
	}

	private assertResolutionOrigin(resolution: AgentSessionMergeResolutionDTO, binding: { projectId: string; sessionId: string; turnId: string; commitProposalId: string; integrationOwnerId: string; sourceHead: string; targetHead: string; mergeBase: string }): void {
		const prior = this.requireProposalRow(resolution.proposalId);
		const outcome = this.latestOutcomeRow(resolution.proposalId);
		if (String(prior.project_id) !== binding.projectId || String(prior.session_id) !== binding.sessionId || String(prior.turn_id) !== binding.turnId
			|| String(prior.commit_proposal_id) !== binding.commitProposalId || String(prior.integration_owner_id) !== binding.integrationOwnerId
			|| String(prior.source_head) !== binding.sourceHead || String(prior.target_head) !== binding.targetHead || String(prior.merge_base) !== binding.mergeBase
			|| resolution.treeOid.length !== binding.targetHead.length || !outcome || outcome.state !== 'conflict') { throw new Error('Resolution must reference the exact durable conflict proposal and original source/target.'); }
		const receipt = this.outcomeFromRow(outcome).receipt;
		if (receipt.operationId !== resolution.operationId) { throw new Error('Resolution prior operation differs from the durable conflict.'); }
		const artifacts = this.readArtifactRows(resolution.operationId, this.applyingBinding(receipt));
		const intent = artifacts[0]?.event;
		if (artifacts.length !== 4 || intent?.phase !== 'intent' || intent.generationId !== resolution.generationId || intent.registrationId !== resolution.registrationId) { throw new Error('Resolution generation differs from the recorded conflict generation.'); }
	}

	private proposalFromRow(row: MergeProposalRow): AgentSessionMergeProposalDTO {
		const metadata = this.proposalMetadataFromRow(row);
		const outcomes: AgentSessionMergeOutcomeDTO[] = [];
		for (const [index, outcomeRow] of this.outcomeRows(String(row.id)).entries()) {
			const outcome = this.outcomeFromRow(outcomeRow);
			if (outcome.proposalId !== String(row.id) || outcome.revision !== index + 1) { throw new Error('Persisted merge outcome sequence is invalid.'); }
			this.assertReceiptMatchesProposal(outcome.receipt, metadata);
			this.validateOutcomeReceipt(outcome.state, outcome.receipt, metadata);
			const previous = outcomes.at(-1);
			if ((!previous && (outcome.state !== 'applying' || outcome.retryOfOutcomeId !== null))
				|| (previous && (!['applying', 'recoveryRequired'].includes(previous.state) || outcome.state === 'applying'
					|| outcome.retryOfOutcomeId !== previous.id || outcome.receipt.operationId !== previous.receipt.operationId))) {
				throw new Error('Persisted merge outcome chain is invalid.');
			}
			outcomes.push(outcome);
		}
		const latestOutcome = outcomes.at(-1);
		const artifacts = latestOutcome ? this.readArtifactRows(latestOutcome.receipt.operationId, this.applyingBinding(latestOutcome.receipt)) : [];
		return { ...metadata, state: outcomes.at(-1)?.state ?? 'pending', outcomes, artifacts };
	}

	private requireSuccessfulCommitProposal(input: { readonly projectId: string; readonly sessionId: string; readonly turnId: string; readonly proposalId: string; readonly revision: number; readonly fingerprint: string; readonly resultingHead: string }): AgentSessionIntegrationProposalDTO {
		const proposal = this.getCommitProposal(input.proposalId);
		if (!proposal || proposal.kind !== 'commit' || proposal.projectId !== input.projectId || proposal.sessionId !== input.sessionId || proposal.turnId !== input.turnId
			|| proposal.id !== input.proposalId || proposal.revision !== input.revision || proposal.fingerprint !== input.fingerprint || proposal.sessionWorktreeOwnerId !== input.sessionId
			|| !proposal.approval || proposal.approval.proposalFingerprint !== proposal.fingerprint) { throw new Error('Merge source must be the exact human-approved commit proposal for this project, session, and turn.'); }
		const last = proposal.outcomes.at(-1);
		if (proposal.state !== 'succeeded' || !last || last.state !== 'succeeded' || last.action !== 'commit' || last.receipt.resultingHead !== input.resultingHead
			|| last.receipt.candidateHead !== input.resultingHead || last.receipt.operationId.length === 0) { throw new Error('Merge source must match the exact successful durable commit result.'); }
		return proposal;
	}

	private linkPaths(paths: readonly string[], commitProposal: AgentSessionIntegrationProposalDTO): AgentSessionMergePathDTO[] {
		const selected = new Map(commitProposal.paths.map(path => [path.path, path]));
		return paths.map(path => {
			const source = selected.get(path);
			const explanations = source?.explanations.map(reference => ({ id: reference.id, path: reference.path, hunkId: reference.hunkId,
				revision: reference.revision, actor: reference.actor, status: reference.status })) ?? [];
			return { path, explanationState: explanations.length ? 'linked' : 'unknown', explanations };
		});
	}

	private normalizePathDTOs(value: unknown): AgentSessionMergePathDTO[] {
		if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PATHS) { throw new Error('Merge proposal path count is invalid.'); }
		const seen = new Set<string>();
		const paths = value.map((entry, index) => {
			this.assertExactKeys(entry, ['path', 'explanationState', 'explanations'], [], `merge path ${index + 1}`);
			const raw = entry as Record<string, unknown>; const path = this.normalizePath(raw.path);
			if (seen.has(path)) { throw new Error('Merge proposal paths must be unique.'); } seen.add(path);
			if (!['linked', 'unknown'].includes(String(raw.explanationState)) || !Array.isArray(raw.explanations) || raw.explanations.length > 600) { throw new Error('Merge path explanation linkage is invalid.'); }
			const explanations = raw.explanations.map((reference, refIndex) => {
				this.assertExactKeys(reference, ['id', 'path', 'hunkId', 'revision', 'actor', 'status'], [], `merge explanation ${index + 1}.${refIndex + 1}`);
				const item = reference as Record<string, unknown>; this.assertUuid(item.id, 'explanation ID'); this.normalizePath(item.path);
				if (item.hunkId !== null && (typeof item.hunkId !== 'string' || !SHA256_PATTERN.test(item.hunkId))) { throw new Error('Merge explanation hunk ID is invalid.'); }
				if (!Number.isSafeInteger(item.revision) || Number(item.revision) < 1 || !['agent', 'human'].includes(String(item.actor)) || !['draft', 'confirmed'].includes(String(item.status))) { throw new Error('Merge explanation reference is invalid.'); }
				return { id: String(item.id), path: String(item.path), hunkId: item.hunkId as string | null, revision: Number(item.revision), actor: item.actor as 'agent' | 'human', status: item.status as 'draft' | 'confirmed' };
			});
			if ((raw.explanationState === 'linked') !== (explanations.length > 0)) { throw new Error('Merge explanation state does not match its linked references.'); }
			return { path, explanationState: raw.explanationState as 'linked' | 'unknown', explanations };
		});
		if (paths.some((item, index) => index > 0 && item.path <= paths[index - 1].path)) { throw new Error('Merge proposal paths must be sorted canonically.'); }
		return paths;
	}

	private normalizePaths(input: readonly string[]): string[] {
		if (!Array.isArray(input) || input.length < 1 || input.length > MAX_PATHS) { throw new Error('Merge proposal must include between one and 300 changed paths.'); }
		const paths = input.map(path => this.normalizePath(path)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
		if (new Set(paths).size !== paths.length) { throw new Error('Merge proposal contains duplicate changed paths.'); }
		return paths;
	}

	private normalizePath(value: unknown): string {
		if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES || value.includes('\0') || value.startsWith('/') || value.includes('\\')) { throw new Error('Merge path must be a bounded root-relative POSIX path.'); }
		if (value.split('/').some(part => !part || part === '.' || part === '..')) { throw new Error('Merge path contains an invalid segment.'); }
		return value;
	}

	private normalizeReceipt(input: AgentSessionMergeReceipt): AgentSessionMergeReceipt {
		this.assertExactKeys(input, ['operationId', 'proposalId', 'proposalFingerprint', 'integrationOwnerId', 'sessionOwnerId', 'sourceHead', 'targetHead', 'mergeBase', 'diffFingerprint', 'commitMessage', 'author', 'committer', 'resultingHead', 'changedPaths', 'conflictedPaths', 'failureCode'], [], 'merge receipt');
		this.assertUuid(input.operationId, 'merge operation ID'); this.assertUuid(input.proposalId, 'merge proposal ID'); this.assertUuid(input.integrationOwnerId, 'integration worktree owner ID'); this.assertUuid(input.sessionOwnerId, 'session worktree owner ID');
		if (!SHA256_PATTERN.test(input.proposalFingerprint) || !SHA256_PATTERN.test(input.diffFingerprint)) { throw new Error('Merge receipt fingerprint is invalid.'); }
		const commitMessage = this.normalizeText(input.commitMessage, 1024, 'merge receipt commit message');
		if (commitMessage !== `Merge reviewed session ${input.sessionOwnerId}`) { throw new Error('Merge receipt commit message is invalid.'); }
		const author = this.normalizeGitIdentity(input.author, 'receipt author'); const committer = this.normalizeGitIdentity(input.committer, 'receipt committer');
		const oids = [input.sourceHead, input.targetHead, input.mergeBase, ...(input.resultingHead ? [input.resultingHead] : [])];
		if (oids.some(value => typeof value !== 'string' || !GIT_OBJECT_PATTERN.test(value)) || new Set(oids.map(value => value.length)).size !== 1) { throw new Error('Merge receipt Git object IDs are invalid or use different formats.'); }
		const changedPaths = this.normalizeReceiptPaths(input.changedPaths); const conflictedPaths = this.normalizeReceiptPaths(input.conflictedPaths);
		if (input.failureCode !== null && (typeof input.failureCode !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/u.test(input.failureCode))) { throw new Error('Merge failure code is invalid.'); }
		return { operationId: input.operationId, proposalId: input.proposalId, proposalFingerprint: input.proposalFingerprint, integrationOwnerId: input.integrationOwnerId, sessionOwnerId: input.sessionOwnerId,
			sourceHead: input.sourceHead.toLowerCase(), targetHead: input.targetHead.toLowerCase(), mergeBase: input.mergeBase.toLowerCase(), diffFingerprint: input.diffFingerprint.toLowerCase(),
			commitMessage, author, committer, resultingHead: input.resultingHead?.toLowerCase() ?? null, changedPaths, conflictedPaths, failureCode: input.failureCode };
	}

	private validateOutcomeReceipt(state: AgentSessionMergeOutcomeState, receipt: AgentSessionMergeReceipt, proposal: Pick<AgentSessionMergeProposalDTO, 'paths'>): void {
		if (state === 'applying' && (receipt.resultingHead !== null || receipt.changedPaths.length || receipt.conflictedPaths.length || receipt.failureCode !== null)) { throw new Error('Applying merge receipt cannot claim a completed result.'); }
		if (state === 'merged' && (!receipt.resultingHead || receipt.conflictedPaths.length || receipt.failureCode !== null)) { throw new Error('Merged outcome requires a result HEAD and no conflict or failure.'); }
		if (state === 'conflict' && (!receipt.conflictedPaths.length || receipt.resultingHead !== null || receipt.failureCode !== null)) { throw new Error('Conflict outcome must preserve conflict paths without claiming a merge commit.'); }
		if (state === 'notApplied' && (receipt.resultingHead !== null || receipt.changedPaths.length || receipt.conflictedPaths.length)) { throw new Error('Not-applied merge outcome cannot claim a resulting HEAD, changed paths, or conflict.'); }
		if (state === 'failed' && (receipt.resultingHead !== null || receipt.changedPaths.length || receipt.conflictedPaths.length)) { throw new Error('Failed merge outcome cannot claim published changes or conflict paths.'); }
		if ((state === 'failed' || state === 'recoveryRequired') && !receipt.failureCode) { throw new Error('Failed or recovery-required merge receipt needs a host failure code.'); }
		const expectedPaths = proposal.paths.map(path => path.path);
		if (state === 'merged' && JSON.stringify(receipt.changedPaths) !== JSON.stringify(expectedPaths)) { throw new Error('Merged receipt paths must equal the complete reviewed source delta.'); }
		if (receipt.changedPaths.some(path => !expectedPaths.includes(path))) { throw new Error('Merge receipt changed paths include a path outside the exact reviewed source delta.'); }
		if (state === 'merged') { this.requirePublishedArtifacts(receipt); }
		if (state === 'recoveryRequired') {
			const artifacts = this.readArtifactRows(receipt.operationId, this.applyingBinding(receipt));
			const published = artifacts.at(-1)?.event;
			if ((published?.phase === 'published' && published.resultingHead !== receipt.resultingHead)
				|| (published?.phase !== 'published' && (receipt.resultingHead !== null || receipt.changedPaths.length !== 0))
				|| (published?.phase === 'published' && JSON.stringify(receipt.changedPaths) !== JSON.stringify(expectedPaths))) {
				throw new Error('Recovery-required result HEAD must match its exact published artifact when publication occurred.');
			}
		}
		if (receipt.conflictedPaths.length || state === 'conflict') {
			const artifacts = this.readArtifactRows(receipt.operationId, this.applyingBinding(receipt));
			const candidate = artifacts.find(record => record.event.phase === 'candidatePrepared')?.event;
			const materialized = artifacts.some(record => record.event.phase === 'generationMaterialized');
			if (candidate?.phase !== 'candidatePrepared' || candidate.outcome !== 'conflict' || !materialized
				|| JSON.stringify(candidate.conflicts.map(conflict => conflict.path)) !== JSON.stringify(receipt.conflictedPaths)) {
				throw new Error('Merge conflict receipt paths must equal the exact recorded generated conflict paths.');
			}
		}
		if (state === 'notApplied' || state === 'failed') {
			const artifacts = this.readArtifactRows(receipt.operationId, this.applyingBinding(receipt));
			const candidate = artifacts.find(record => record.event.phase === 'candidatePrepared')?.event;
			if (artifacts.some(record => record.event.phase === 'published') || candidate?.phase === 'candidatePrepared' && candidate.outcome === 'conflict') {
				throw new Error('Not-applied or failed merge outcome conflicts with its durable candidate artifacts.');
			}
		}
	}

	private requirePublishedArtifacts(receipt: AgentSessionMergeReceipt): void {
		const durableBinding = this.requireApplyingBindingForOperation(receipt.operationId);
		if (JSON.stringify(durableBinding) !== JSON.stringify(this.applyingBinding(receipt))) { throw new Error('Merged outcome differs from its exact durable applying operation binding.'); }
		const artifacts = this.readArtifactRows(receipt.operationId, durableBinding);
		const published = artifacts.at(-1)?.event;
		if (artifacts.length !== 5 || published?.phase !== 'published' || published.resultingHead !== receipt.resultingHead) {
			throw new Error('Merged outcome requires the complete exact published artifact chain and matching result HEAD.');
		}
	}

	private assertReceiptMatchesProposal(receipt: AgentSessionMergeReceipt, proposal: Pick<AgentSessionMergeProposalDTO, 'id' | 'fingerprint' | 'integrationOwnerId' | 'sessionOwnerId' | 'sourceHead' | 'targetHead' | 'mergeBase' | 'diffFingerprint' | 'commitMessage' | 'author' | 'committer'>): void {
		if (receipt.proposalId !== proposal.id || receipt.proposalFingerprint !== proposal.fingerprint || receipt.integrationOwnerId !== proposal.integrationOwnerId
			|| receipt.sessionOwnerId !== proposal.sessionOwnerId || receipt.sourceHead !== proposal.sourceHead || receipt.targetHead !== proposal.targetHead
			|| receipt.mergeBase !== proposal.mergeBase || receipt.diffFingerprint !== proposal.diffFingerprint || receipt.commitMessage !== proposal.commitMessage
			|| JSON.stringify(receipt.author) !== JSON.stringify(proposal.author) || JSON.stringify(receipt.committer) !== JSON.stringify(proposal.committer)) { throw new Error('Merge operation receipt does not match its immutable proposal.'); }
	}

	private applyingBinding(receipt: AgentSessionMergeReceipt): AgentSessionMergeApplyingBinding {
		return { operationId: receipt.operationId, proposalId: receipt.proposalId, proposalFingerprint: receipt.proposalFingerprint,
			integrationOwnerId: receipt.integrationOwnerId, sessionOwnerId: receipt.sessionOwnerId, sourceHead: receipt.sourceHead,
			targetHead: receipt.targetHead, mergeBase: receipt.mergeBase, diffFingerprint: receipt.diffFingerprint,
			commitMessage: receipt.commitMessage, author: receipt.author, committer: receipt.committer };
	}

	private requireApplyingBindingForOperation(operationId: string): AgentSessionMergeApplyingBinding {
		const rows = this.db.prepare(`SELECT id, proposal_id, revision, state, receipt_json, retry_of_outcome_id, recorded_at
			FROM agent_session_merge_outcomes WHERE state = 'applying' ORDER BY proposal_id, revision`).all() as MergeOutcomeRow[];
		let result: AgentSessionMergeApplyingBinding | undefined;
		for (const row of rows) {
			const outcome = this.outcomeFromRow(row);
			if (outcome.receipt.operationId !== operationId) { continue; }
			if (result) { throw new Error('Merge operation ID is bound to more than one applying receipt.'); }
			const proposal = this.proposalMetadataFromRow(this.requireProposalRow(outcome.proposalId));
			if (outcome.state !== 'applying' || !proposal.approval || proposal.approval.proposalFingerprint !== proposal.fingerprint) { throw new Error('Merge artifact operation has no valid approved durable applying receipt.'); }
			this.assertReceiptMatchesProposal(outcome.receipt, proposal);
			result = this.applyingBinding(outcome.receipt);
		}
		if (!result) { throw new Error('Merge artifact operation has no durable applying receipt.'); }
		return result;
	}

	private readArtifactRows(operationId: string, binding: AgentSessionMergeApplyingBinding): AgentSessionMergeArtifactRecord[] {
		const rows = this.db.prepare(`SELECT operation_id, proposal_id, revision, phase, event_json FROM agent_session_merge_artifacts
			WHERE operation_id = ? ORDER BY revision`).all(operationId) as MergeArtifactRow[];
		const records: AgentSessionMergeArtifactRecord[] = [];
		for (const row of rows) {
			const revision = Number(row.revision);
			if (String(row.operation_id) !== operationId || String(row.proposal_id) !== binding.proposalId || !Number.isSafeInteger(revision) || revision !== records.length + 1) {
				throw new Error('Persisted merge artifact operation binding or revision sequence is invalid.');
			}
			const eventJson = String(row.event_json);
			if (Buffer.byteLength(eventJson, 'utf8') > MAX_ARTIFACT_BYTES) { throw new Error('Persisted merge artifact exceeds its size limit.'); }
			const event = this.normalizeArtifact(JSON.parse(eventJson));
			if (JSON.stringify(event) !== eventJson || String(row.phase) !== event.phase) { throw new Error('Persisted merge artifact is not canonical or its phase column differs.'); }
			this.validateNextArtifact(binding, records.map(record => record.event), event);
			records.push({ revision, event });
		}
		const latestOutcome = this.latestOutcomeRow(binding.proposalId);
		if (latestOutcome) {
			const outcome = this.outcomeFromRow(latestOutcome);
			if (outcome.receipt.operationId === operationId && outcome.state === 'merged') {
				const published = records.at(-1)?.event;
				if (published?.phase !== 'published' || published.resultingHead !== outcome.receipt.resultingHead) { throw new Error('Merged outcome does not match its durable published artifact.'); }
			}
			if (outcome.receipt.operationId === operationId && outcome.state === 'conflict') {
				const candidate = records.find(record => record.event.phase === 'candidatePrepared')?.event;
				if (candidate?.phase !== 'candidatePrepared' || candidate.outcome !== 'conflict' || records.some(record => record.event.phase === 'published')) { throw new Error('Conflict outcome does not match its retained conflict artifacts.'); }
			}
			if (outcome.receipt.operationId === operationId && ['notApplied', 'failed'].includes(outcome.state) && records.some(record => record.event.phase === 'published')) {
				throw new Error('Non-published merge outcome cannot have a published artifact.');
			}
		}
		return records;
	}

	private validateNextArtifact(binding: AgentSessionMergeApplyingBinding, prior: readonly AgentSessionMergeArtifactEvent[], event: AgentSessionMergeArtifactEvent): void {
		const phases = ['intent', 'candidatePrepared', 'generationRegistered', 'generationMaterialized', 'published'] as const;
		if (prior.length >= phases.length || phases[prior.length] !== event.phase) { throw new Error('Merge artifact phase is out of order or already terminal.'); }
		// Artifact validation must not call proposalFromRow (which reads artifacts).
		const rawResolution = (JSON.parse(String(this.requireProposalRow(binding.proposalId).payload_json)) as MergeProposalPayload).resolution;
		const resolution = rawResolution === undefined ? undefined : this.normalizeResolution(rawResolution);
		if (resolution && event.phase === 'intent') {
			const captured = event.priorGeneration;
			if (!captured || captured.generationId !== resolution.generationId || captured.registrationId !== resolution.registrationId
				|| captured.head !== binding.targetHead || captured.indexDigest !== resolution.indexDigest || captured.treeDigest !== resolution.treeDigest) { throw new Error('Resolution intent differs from the exact approved human generation snapshot.'); }
		}
		if (resolution && event.phase === 'candidatePrepared'
			&& (event.candidateTreeOid !== resolution.treeOid || event.outcome !== 'clean' || !event.candidateCommitOid || event.conflicts.length)) { throw new Error('Resolution candidate differs from the exact approved staged tree.'); }
		if (prior.length === 0) {
			if (event.phase !== 'intent') { throw new Error('Merge artifact history must begin with intent.'); }
			if (event.priorGeneration && (event.priorGeneration.head !== binding.targetHead || event.priorGeneration.generationId === event.generationId || event.priorGeneration.generationPath === event.generationPath)) {
				throw new Error('Merge intent prior generation does not match the pinned target or is reused as the new generation.');
			}
			return;
		}
		const objectLength = binding.sourceHead.length;
		const eventOids = this.collectArtifactOids(event);
		if (eventOids.some(oid => oid.length !== objectLength)) { throw new Error('Merge artifact object ID uses a different Git object format than its applying receipt.'); }
		const intent = prior[0];
		if (intent?.phase !== 'intent') { throw new Error('Merge artifact intent is missing.'); }
		if (event.phase === 'generationRegistered' && (event.generationPath !== intent.generationPath || event.registrationId !== intent.registrationId)) {
			throw new Error('Registered merge generation does not match its immutable intent.');
		}
		if (event.phase === 'generationMaterialized') {
			const candidate = prior[1];
			if (candidate?.phase !== 'candidatePrepared') { throw new Error('Merge candidate artifact is missing before materialization.'); }
			const expectedHead = candidate.outcome === 'clean' ? candidate.candidateCommitOid : binding.targetHead;
			const expectedConflictDigest = candidate.conflicts.length ? digest(JSON.stringify(candidate.conflicts)) : null;
			if (event.head !== expectedHead || event.conflictDigest !== expectedConflictDigest) {
				throw new Error('Materialized merge generation does not match its candidate or conflict outcome.');
			}
		}
		if (event.phase === 'published') {
			const candidate = prior[1];
			if (candidate?.phase !== 'candidatePrepared' || candidate.outcome !== 'clean' || !candidate.candidateCommitOid
				|| event.resultingHead !== candidate.candidateCommitOid || event.currentGenerationId !== intent.generationId
				|| event.priorGenerationId !== (intent.priorGeneration?.generationId ?? null)
				|| event.targetRef !== `refs/heads/bugfixer/integration/${binding.integrationOwnerId}`) {
				throw new Error('Published merge artifact does not match the exact clean candidate and integration owner.');
			}
		}
	}

	private normalizeArtifact(value: unknown): AgentSessionMergeArtifactEvent {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Merge artifact must be an object.'); }
		const raw = value as Record<string, unknown>;
		if (raw.phase === 'intent') {
			this.assertExactKeys(raw, ['phase', 'generationId', 'generationPath', 'registrationId', 'priorGeneration'], [], 'merge intent artifact');
			const generationId = this.artifactUuid(raw.generationId, 'generation ID'); const generationPath = this.artifactPath(raw.generationPath); const registrationId = this.artifactUuid(raw.registrationId, 'registration ID');
			const priorGeneration = raw.priorGeneration === null ? null : this.normalizePriorGeneration(raw.priorGeneration);
			return { phase: 'intent', generationId, generationPath, registrationId, priorGeneration };
		}
		if (raw.phase === 'candidatePrepared') {
			this.assertExactKeys(raw, ['phase', 'candidateTreeOid', 'candidateCommitOid', 'outcome', 'conflicts'], [], 'merge candidate artifact');
			const candidateTreeOid = this.artifactOid(raw.candidateTreeOid);
			const candidateCommitOid = raw.candidateCommitOid === null ? null : this.artifactOid(raw.candidateCommitOid);
			if (raw.outcome !== 'clean' && raw.outcome !== 'conflict') { throw new Error('Merge candidate outcome is invalid.'); }
			if (!Array.isArray(raw.conflicts) || raw.conflicts.length > MAX_CONFLICTS) { throw new Error('Merge conflict artifact count is invalid.'); }
			const conflicts = raw.conflicts.map((entry, index) => this.normalizeConflict(entry, index));
			if (conflicts.some((conflict, index) => index > 0 && conflict.path <= conflicts[index - 1].path)) { throw new Error('Merge conflicts must be sorted by unique path.'); }
			if ((raw.outcome === 'clean' && (!candidateCommitOid || conflicts.length)) || (raw.outcome === 'conflict' && (candidateCommitOid !== null || !conflicts.length))) { throw new Error('Merge candidate commit and conflict metadata disagree with its outcome.'); }
			return { phase: 'candidatePrepared', candidateTreeOid, candidateCommitOid, outcome: raw.outcome, conflicts };
		}
		if (raw.phase === 'generationRegistered') {
			this.assertExactKeys(raw, ['phase', 'generationPath', 'registrationId'], [], 'registered generation artifact');
			return { phase: 'generationRegistered', generationPath: this.artifactPath(raw.generationPath), registrationId: this.artifactUuid(raw.registrationId, 'registration ID') };
		}
		if (raw.phase === 'generationMaterialized') {
			this.assertExactKeys(raw, ['phase', 'head', 'indexDigest', 'treeDigest', 'conflictDigest'], [], 'materialized generation artifact');
			return { phase: 'generationMaterialized', head: this.artifactOid(raw.head), indexDigest: this.artifactSha(raw.indexDigest), treeDigest: this.artifactSha(raw.treeDigest), conflictDigest: raw.conflictDigest === null ? null : this.artifactSha(raw.conflictDigest) };
		}
		if (raw.phase === 'published') {
			this.assertExactKeys(raw, ['phase', 'targetRef', 'resultingHead', 'currentGenerationId', 'priorGenerationId'], [], 'published generation artifact');
			if (typeof raw.targetRef !== 'string' || raw.targetRef.length > 512 || !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(raw.targetRef) || raw.targetRef.includes('..') || raw.targetRef.includes('//')) { throw new Error('Merge target ref is invalid.'); }
			return { phase: 'published', targetRef: raw.targetRef, resultingHead: this.artifactOid(raw.resultingHead), currentGenerationId: this.artifactUuid(raw.currentGenerationId, 'current generation ID'), priorGenerationId: raw.priorGenerationId === null ? null : this.artifactUuid(raw.priorGenerationId, 'prior generation ID') };
		}
		throw new Error('Merge artifact phase is unknown.');
	}

	private normalizePriorGeneration(value: unknown): AgentSessionMergePriorGeneration {
		this.assertExactKeys(value, ['generationId', 'generationPath', 'registrationId', 'head', 'indexDigest', 'treeDigest'], [], 'prior generation artifact');
		const raw = value as Record<string, unknown>;
		return { generationId: this.artifactUuid(raw.generationId, 'prior generation ID'), generationPath: this.artifactPath(raw.generationPath),
			registrationId: this.artifactUuid(raw.registrationId, 'prior registration ID'), head: this.artifactOid(raw.head), indexDigest: this.artifactSha(raw.indexDigest), treeDigest: this.artifactSha(raw.treeDigest) };
	}

	private normalizeConflict(value: unknown, index: number): AgentSessionMergeConflictArtifact {
		this.assertExactKeys(value, ['path', 'message', 'stages'], [], `merge conflict ${index + 1}`);
		const raw = value as Record<string, unknown>; const path = this.normalizePath(raw.path);
		if (typeof raw.message !== 'string' || Buffer.byteLength(raw.message, 'utf8') > 16 * 1024 || raw.message.includes('\0')) { throw new Error('Merge conflict message is invalid or too large.'); }
		if (!Array.isArray(raw.stages) || raw.stages.length > 3) { throw new Error('Merge conflict stages are invalid.'); }
		const stages = raw.stages.map((entry, stageIndex): AgentSessionMergeConflictArtifact['stages'][number] => {
			this.assertExactKeys(entry, ['stage', 'mode', 'oid'], [], `merge conflict stage ${index + 1}.${stageIndex + 1}`);
			const stage = (entry as Record<string, unknown>).stage; const mode = (entry as Record<string, unknown>).mode;
			if (stage !== 1 && stage !== 2 && stage !== 3) { throw new Error('Merge conflict stage number is invalid.'); }
			if (mode !== '100644' && mode !== '100755' && mode !== '120000' && mode !== '160000') { throw new Error('Merge conflict file mode is invalid.'); }
			return { stage, mode, oid: this.artifactOid((entry as Record<string, unknown>).oid) };
		});
		if (stages.some((stage, stageIndex) => stageIndex > 0 && stage.stage <= stages[stageIndex - 1].stage)) { throw new Error('Merge conflict stages must be unique and sorted.'); }
		return { path, message: raw.message, stages };
	}

	private artifactUuid(value: unknown, label: string): string { this.assertUuid(value, label); return value; }
	private artifactOid(value: unknown): string { if (typeof value !== 'string' || !GIT_OBJECT_PATTERN.test(value) || value !== value.toLowerCase()) { throw new Error('Merge artifact Git object ID is invalid.'); } return value; }
	private artifactSha(value: unknown): string { if (typeof value !== 'string' || !SHA256_PATTERN.test(value) || value !== value.toLowerCase()) { throw new Error('Merge artifact SHA-256 is invalid.'); } return value; }
	private artifactPath(value: unknown): string {
		if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES || value.includes('\0') || value.startsWith('/') || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) {
			throw new Error('Merge generation path must be a bounded relative POSIX path.');
		}
		return value;
	}

	private normalizeText(value: unknown, maxBytes: number, label: string): string {
		if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0') || /[\r\n]/u.test(value)) {
			throw new Error(`Merge ${label} is invalid or too large.`);
		}
		return value;
	}

	private normalizeGitIdentity(value: unknown, label: string): AgentSessionIntegrationGitIdentity {
		this.assertExactKeys(value, ['name', 'email', 'date'], [], `merge ${label} Git identity`);
		const raw = value as Record<string, unknown>;
		const name = raw.name; const email = raw.email; const date = raw.date;
		const byteLength = (item: unknown): number => typeof item === 'string' ? Buffer.byteLength(item, 'utf8') : Number.MAX_SAFE_INTEGER;
		if (typeof name !== 'string' || !name.trim() || byteLength(name) > 512 || /[\r\n<>\0]/u.test(name)) { throw new Error(`Merge ${label} Git name is invalid.`); }
		if (typeof email !== 'string' || !email.trim() || byteLength(email) > 512 || /[\r\n<>\0]/u.test(email)) { throw new Error(`Merge ${label} Git email is invalid.`); }
		if (typeof date !== 'string' || byteLength(date) > 32 || !/^(?:0|[1-9][0-9]*) [+-](?:[01][0-9]|2[0-3])[0-5][0-9]$/u.test(date)) { throw new Error(`Merge ${label} Git date is invalid.`); }
		return { name, email, date };
	}

	private collectArtifactOids(event: AgentSessionMergeArtifactEvent): string[] {
		switch (event.phase) {
			case 'intent': return event.priorGeneration ? [event.priorGeneration.head] : [];
			case 'candidatePrepared': return [event.candidateTreeOid, ...(event.candidateCommitOid ? [event.candidateCommitOid] : []), ...event.conflicts.flatMap(conflict => conflict.stages.map(stage => stage.oid))];
			case 'generationRegistered': return [];
			case 'generationMaterialized': return [event.head];
			case 'published': return [event.resultingHead];
		}
	}

	private outcomeFromRow(row: MergeOutcomeRow): AgentSessionMergeOutcomeDTO {
		const receipt = this.normalizeReceipt(JSON.parse(String(row.receipt_json)) as AgentSessionMergeReceipt);
		const state = String(row.state) as AgentSessionMergeOutcomeState;
		if (!['applying', 'merged', 'conflict', 'notApplied', 'recoveryRequired', 'failed'].includes(state)) { throw new Error('Persisted merge outcome state is invalid.'); }
		const retryOfOutcomeId = row.retry_of_outcome_id === null ? null : String(row.retry_of_outcome_id); if (retryOfOutcomeId !== null) { this.assertUuid(retryOfOutcomeId, 'persisted merge retry outcome ID'); }
		return { id: String(row.id), proposalId: String(row.proposal_id), revision: Number(row.revision), state, receipt, retryOfOutcomeId, recordedAt: String(row.recorded_at) };
	}

	private approvalFromRow(row: MergeApprovalRow): AgentSessionMergeApprovalDTO {
		if (row.actor !== 'human') { throw new Error('Merge approval actor is invalid.'); }
		this.assertUuid(String(row.id), 'merge approval ID'); this.assertUuid(String(row.proposal_id), 'merge approval proposal ID');
		return { id: String(row.id), proposalId: String(row.proposal_id), proposalFingerprint: String(row.proposal_fingerprint), actor: 'human', approvedAt: String(row.approved_at) };
	}

	private requireGitBinding(projectId: string, bindingId: string): AgentSessionMergeStoreBinding & { readonly vcsRoot: string } {
		const binding = this.getBinding(projectId, bindingId);
		if (!binding || binding.projectId !== projectId || binding.id !== bindingId || binding.vcsKind !== 'git' || typeof binding.vcsRoot !== 'string' || !binding.vcsRoot.trim()) { throw new Error('Merge integration owner requires the exact persisted Git folder binding.'); }
		return binding as AgentSessionMergeStoreBinding & { readonly vcsRoot: string };
	}

	private requireMappedIntegrationOwner(projectId: string, bindingId: string, ownerId: string): string {
		const binding = this.requireGitBinding(projectId, bindingId);
		const row = this.db.prepare(`SELECT integration_owner_id, repository_root FROM agent_session_merge_workspaces WHERE project_id = ? AND binding_id = ?`).get(projectId, bindingId) as { integration_owner_id: SQLOutputValue; repository_root: SQLOutputValue } | undefined;
		if (!row || String(row.integration_owner_id) !== ownerId || String(row.repository_root) !== binding.vcsRoot) { throw new Error('Merge proposal integration owner does not match its durable Git binding.'); }
		return ownerId;
	}

	private requireTurn(projectId: string, sessionId: string, turnId: string): AgentSessionTurnDTO {
		const turn = this.getTurn(projectId, sessionId, turnId);
		if (!turn || turn.projectId !== projectId || turn.sessionId !== sessionId || turn.id !== turnId) { throw new Error('Merge proposal requires the exact durable project, session, and turn.'); }
		return turn;
	}

	private normalizeScope(projectId: string, sessionId: string, turnId: string): { readonly projectId: string; readonly sessionId: string; readonly turnId: string } {
		this.assertUuid(projectId, 'project ID'); this.assertUuid(sessionId, 'session ID'); this.assertUuid(turnId, 'turn ID'); return { projectId, sessionId, turnId };
	}

	private normalizeReceiptPaths(value: readonly string[]): string[] {
		if (!Array.isArray(value) || value.length > MAX_PATHS) { throw new Error('Merge receipt path count is invalid.'); }
		const paths = value.map(path => this.normalizePath(path));
		if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && path <= paths[index - 1])) { throw new Error('Merge receipt paths must be unique and sorted.'); }
		return paths;
	}

	private requireProposalRow(proposalId: string): MergeProposalRow {
		const row = this.db.prepare(`SELECT id, project_id, binding_id, session_id, turn_id, revision, commit_proposal_id, commit_proposal_revision,
			commit_proposal_fingerprint, integration_owner_id, source_head, target_head, merge_base, diff_fingerprint, proposal_fingerprint,
			payload_json, created_at, expires_at FROM agent_session_merge_proposals WHERE id = ?`).get(proposalId) as MergeProposalRow | undefined;
		if (!row) { throw new Error('Merge proposal does not exist.'); } return row;
	}

	private latestProposalRow(projectId: string, sessionId: string, turnId: string): MergeProposalRow | undefined {
		return this.db.prepare(`SELECT id, project_id, binding_id, session_id, turn_id, revision, commit_proposal_id, commit_proposal_revision,
			commit_proposal_fingerprint, integration_owner_id, source_head, target_head, merge_base, diff_fingerprint, proposal_fingerprint,
			payload_json, created_at, expires_at FROM agent_session_merge_proposals WHERE project_id = ? AND session_id = ? AND turn_id = ? ORDER BY revision DESC LIMIT 1`)
			.get(projectId, sessionId, turnId) as MergeProposalRow | undefined;
	}

	private approvalRow(proposalId: string): MergeApprovalRow | undefined {
		return this.db.prepare('SELECT id, proposal_id, proposal_fingerprint, actor, approved_at FROM agent_session_merge_approvals WHERE proposal_id = ?').get(proposalId) as MergeApprovalRow | undefined;
	}

	private latestOutcomeRow(proposalId: string): MergeOutcomeRow | undefined {
		return this.db.prepare(`SELECT id, proposal_id, revision, state, receipt_json, retry_of_outcome_id, recorded_at FROM agent_session_merge_outcomes WHERE proposal_id = ? ORDER BY revision DESC LIMIT 1`).get(proposalId) as MergeOutcomeRow | undefined;
	}

	private outcomeRows(proposalId: string): MergeOutcomeRow[] {
		return this.db.prepare(`SELECT id, proposal_id, revision, state, receipt_json, retry_of_outcome_id, recorded_at FROM agent_session_merge_outcomes WHERE proposal_id = ? ORDER BY revision LIMIT 100`).all(proposalId) as MergeOutcomeRow[];
	}

	private assertUuid(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !UUID_PATTERN.test(value)) { throw new Error(`Merge ${label} is invalid.`); } }
	private assertExactKeys(value: unknown, required: readonly string[], optional: readonly string[], label: string): void {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`Merge ${label} must be an object.`); }
		const object = value as Record<string, unknown>; const allowed = new Set([...required, ...optional]);
		for (const key of required) { if (!Object.hasOwn(object, key)) { throw new Error(`Merge ${label} is missing ${key}.`); } }
		for (const key of Object.keys(object)) { if (!allowed.has(key)) { throw new Error(`Merge ${label} contains unknown fields.`); } }
	}
	private transaction<T>(operation: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = operation(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function digestBytes(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
