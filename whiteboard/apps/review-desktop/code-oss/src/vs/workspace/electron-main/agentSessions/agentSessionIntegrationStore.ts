/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { AgentSessionTurnDTO } from '../../common/workspaceAgentSessionProtocol.js';
import type {
	AgentSessionIntegrationAction, AgentSessionIntegrationActionReceipt, AgentSessionIntegrationApprovalDTO,
	AgentSessionIntegrationGitIdentity, AgentSessionIntegrationOutcomeDTO, AgentSessionIntegrationOutcomeState,
	AgentSessionIntegrationPathDTO, AgentSessionIntegrationPathInput, AgentSessionIntegrationProposalDTO,
} from '../../common/workspaceAgentIntegrationProtocol.js';
import type { AgentSessionChangeEvidenceDTO } from './agentSessionChangeEvidenceStore.js';
import type { AgentSessionExplanationDTO, AgentSessionExplanationTarget } from './agentSessionReviewStore.js';

export type {
	AgentSessionIntegrationAction, AgentSessionIntegrationActionReceipt, AgentSessionIntegrationApprovalDTO,
	AgentSessionIntegrationGitIdentity, AgentSessionIntegrationOutcomeDTO, AgentSessionIntegrationOutcomeState,
	AgentSessionIntegrationPathDTO, AgentSessionIntegrationPathInput, AgentSessionIntegrationProposalDTO,
	AgentSessionIntegrationState,
} from '../../common/workspaceAgentIntegrationProtocol.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;
const MAX_PATH_BYTES = 4096;
const MAX_PATHS = 300;
const MAX_EXPLANATIONS = 600;
const MAX_PROPOSAL_BYTES = 256 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024;
const PROPOSAL_TTL_MS = 10 * 60 * 1000;

interface ProposalPayload {
	readonly sessionWorktreeOwnerId: string;
	readonly sourceHead: string;
	readonly proposedGitTreeHash: string;
	readonly diffFingerprint: string;
	readonly commitMessage: string;
	readonly author: AgentSessionIntegrationGitIdentity;
	readonly committer: AgentSessionIntegrationGitIdentity;
	readonly paths: readonly AgentSessionIntegrationPathDTO[];
}

interface ProposalRow extends Readonly<Record<string, SQLOutputValue>> {
	readonly id: SQLOutputValue;
	readonly project_id: SQLOutputValue;
	readonly session_id: SQLOutputValue;
	readonly turn_id: SQLOutputValue;
	readonly revision: SQLOutputValue;
	readonly evidence_version: SQLOutputValue;
	readonly evidence_fingerprint: SQLOutputValue;
	readonly turn_snapshot_sha256: SQLOutputValue;
	readonly proposal_fingerprint: SQLOutputValue;
	readonly payload_json: SQLOutputValue;
	readonly created_at: SQLOutputValue;
	readonly expires_at: SQLOutputValue;
}

interface ApprovalRow extends Readonly<Record<string, SQLOutputValue>> {
	readonly id: SQLOutputValue;
	readonly proposal_id: SQLOutputValue;
	readonly proposal_fingerprint: SQLOutputValue;
	readonly actor: SQLOutputValue;
	readonly approved_at: SQLOutputValue;
}

interface OutcomeRow extends Readonly<Record<string, SQLOutputValue>> {
	readonly id: SQLOutputValue;
	readonly proposal_id: SQLOutputValue;
	readonly revision: SQLOutputValue;
	readonly state: SQLOutputValue;
	readonly action: SQLOutputValue;
	readonly receipt_json: SQLOutputValue;
	readonly retry_of_outcome_id: SQLOutputValue;
	readonly recorded_at: SQLOutputValue;
}

/** Main-process-only immutable proposals, trusted human approvals and host action receipts. */
export class AgentSessionIntegrationStore {
	constructor(
		private readonly db: DatabaseSync,
		private readonly assertOpen: () => void,
		private readonly getTurn: (projectId: string, sessionId: string, turnId: string) => AgentSessionTurnDTO | undefined,
		private readonly getLatestEvidence: (projectId: string, sessionId: string, turnId: string) => AgentSessionChangeEvidenceDTO | undefined,
		private readonly getEvidence: (projectId: string, sessionId: string, turnId: string, evidenceVersion: number) => AgentSessionChangeEvidenceDTO | undefined,
		private readonly getExplanation: (target: AgentSessionExplanationTarget, revision: number) => AgentSessionExplanationDTO | undefined,
	) { }

	createProposal(input: {
		readonly projectId: string;
		readonly sessionId: string;
		readonly turnId: string;
		readonly evidenceVersion: number;
		readonly evidenceFingerprint: string;
		readonly sourceHead: string;
		readonly proposedGitTreeHash: string;
		readonly diffFingerprint: string;
		readonly commitMessage: string;
		readonly author: AgentSessionIntegrationGitIdentity;
		readonly committer: AgentSessionIntegrationGitIdentity;
		readonly paths: readonly AgentSessionIntegrationPathInput[];
		readonly expectedLatestRevision: number;
	}): AgentSessionIntegrationProposalDTO {
		this.assertOpen();
		this.assertExactKeys(input, ['projectId', 'sessionId', 'turnId', 'evidenceVersion', 'evidenceFingerprint', 'sourceHead', 'proposedGitTreeHash', 'diffFingerprint', 'commitMessage', 'author', 'committer', 'paths', 'expectedLatestRevision'], [], 'commit proposal');
		const scope = this.normalizeScope(input.projectId, input.sessionId, input.turnId);
		if (!Number.isSafeInteger(input.evidenceVersion) || input.evidenceVersion < 1 || !SHA256_PATTERN.test(input.evidenceFingerprint)) { throw new Error('Integration evidence binding is invalid.'); }
		for (const [label, value] of [['source HEAD', input.sourceHead], ['proposed Git tree hash', input.proposedGitTreeHash]] as const) {
			if (typeof value !== 'string' || !GIT_OBJECT_PATTERN.test(value)) { throw new Error(`Commit proposal ${label} is invalid.`); }
		}
		if (input.sourceHead.length !== input.proposedGitTreeHash.length) { throw new Error('Commit proposal Git object IDs use different object formats.'); }
		if (!SHA256_PATTERN.test(input.diffFingerprint)) { throw new Error('Commit proposal diff fingerprint is invalid.'); }
		const commitMessage = this.normalizeText(input.commitMessage, 1024, 'Commit message');
		const author = this.normalizeGitIdentity(input.author, 'author');
		const committer = this.normalizeGitIdentity(input.committer, 'committer');
		if (!Number.isSafeInteger(input.expectedLatestRevision) || input.expectedLatestRevision < 0) { throw new Error('Expected integration proposal revision is invalid.'); }
		const turn = this.requireTurn(scope.projectId, scope.sessionId, scope.turnId);
		const sessionWorktreeOwnerId = turn.snapshot.managedWorktreeOwnerId;
		if (!sessionWorktreeOwnerId || sessionWorktreeOwnerId !== scope.sessionId) { throw new Error('A commit proposal requires the exact app-managed session worktree captured by the turn.'); }
		if (!['exited', 'failed', 'interrupted'].includes(turn.state) || turn.cleanupVerified !== true) { throw new Error('A commit proposal requires a terminal turn with verified cleanup.'); }
		const evidence = this.getEvidence(scope.projectId, scope.sessionId, scope.turnId, input.evidenceVersion);
		const latestEvidence = this.getLatestEvidence(scope.projectId, scope.sessionId, scope.turnId);
		if (!evidence || !latestEvidence || evidence.fingerprint !== input.evidenceFingerprint || latestEvidence.version !== evidence.version || latestEvidence.fingerprint !== evidence.fingerprint) {
			throw new Error('Integration proposal evidence must match the latest durable turn observation.');
		}
		if (evidence.status !== 'observed' || evidence.coverage !== 'complete') { throw new Error('A commit proposal requires complete observed change evidence.'); }
		const paths = this.resolvePaths(input.paths, evidence, scope);
		const payload: ProposalPayload = {
			sessionWorktreeOwnerId,
			sourceHead: input.sourceHead.toLowerCase(), proposedGitTreeHash: input.proposedGitTreeHash.toLowerCase(), diffFingerprint: input.diffFingerprint.toLowerCase(),
			commitMessage, paths,
			author, committer,
		};
		const payloadJson = JSON.stringify(payload);
		if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PROPOSAL_BYTES) { throw new Error('Integration proposal exceeds 256 KiB.'); }
		const proposalFingerprint = digest(JSON.stringify({ ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, turnSnapshotSha256: turn.snapshotSha256, ...payload }));
		return this.transaction(() => {
			const latest = this.latestProposalRow(scope.projectId, scope.sessionId, scope.turnId);
			const latestRevision = latest ? Number(latest.revision) : 0;
			if (latestRevision === input.expectedLatestRevision + 1 && latest && String(latest.proposal_fingerprint) === proposalFingerprint) {
				return this.proposalFromRow(latest);
			}
			if (latestRevision !== input.expectedLatestRevision) { throw new Error('Integration proposal revision is stale.'); }
			const id = randomUUID();
			const createdAt = new Date().toISOString();
			const expiresAt = new Date(Date.parse(createdAt) + PROPOSAL_TTL_MS).toISOString();
			this.db.prepare(`INSERT INTO agent_session_integration_proposals
				(id, project_id, session_id, turn_id, revision, evidence_version, evidence_fingerprint, turn_snapshot_sha256, proposal_fingerprint, payload_json, created_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				id, scope.projectId, scope.sessionId, scope.turnId, latestRevision + 1, evidence.version, evidence.fingerprint,
				turn.snapshotSha256, proposalFingerprint, payloadJson, createdAt, expiresAt,
			);
			return this.getProposal(id)!;
		});
	}

	getProposal(proposalId: string): AgentSessionIntegrationProposalDTO | undefined {
		this.assertOpen();
		this.assertUuid(proposalId, 'integration proposal ID');
		const row = this.db.prepare(`SELECT id, project_id, session_id, turn_id, revision, evidence_version, evidence_fingerprint, turn_snapshot_sha256, proposal_fingerprint, payload_json, created_at, expires_at
			FROM agent_session_integration_proposals WHERE id = ?`).get(proposalId) as ProposalRow | undefined;
		return row ? this.proposalFromRow(row) : undefined;
	}

	listProposals(projectId: string, sessionId: string, turnId: string, options: { readonly afterRevision?: number; readonly limit?: number } = {}): { readonly proposals: readonly AgentSessionIntegrationProposalDTO[]; readonly nextRevision: number; readonly hasMore: boolean } {
		this.assertOpen();
		const scope = this.normalizeScope(projectId, sessionId, turnId);
		this.requireTurn(scope.projectId, scope.sessionId, scope.turnId);
		this.assertExactKeys(options, [], ['afterRevision', 'limit'], 'integration proposal page');
		const afterRevision = options.afterRevision ?? 0;
		const limit = options.limit ?? 50;
		if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) { throw new Error('Integration proposal page bounds are invalid.'); }
		const rows = this.db.prepare(`SELECT id, project_id, session_id, turn_id, revision, evidence_version, evidence_fingerprint, turn_snapshot_sha256, proposal_fingerprint, payload_json, created_at, expires_at
			FROM agent_session_integration_proposals WHERE project_id = ? AND session_id = ? AND turn_id = ? AND revision > ? ORDER BY revision LIMIT ?`)
			.all(scope.projectId, scope.sessionId, scope.turnId, afterRevision, limit + 1) as ProposalRow[];
		const hasMore = rows.length > limit;
		const proposals = rows.slice(0, limit).map(row => this.proposalFromRow(row));
		return { proposals, nextRevision: proposals.at(-1)?.revision ?? afterRevision, hasMore };
	}

	/** Trusted UI host entry point. Caller identity and approval time are assigned here, never accepted as input. */
	recordTrustedHumanApproval(proposalId: string, expectedRevision: number): AgentSessionIntegrationApprovalDTO {
		this.assertOpen();
		this.assertUuid(proposalId, 'integration proposal ID');
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) { throw new Error('Integration proposal revision is invalid.'); }
		return this.transaction(() => {
			const proposal = this.requireProposalRow(proposalId);
			if (Number(proposal.revision) !== expectedRevision) { throw new Error('Commit approval proposal revision is stale.'); }
			const proposalDto = this.proposalFromRow(proposal);
			const existing = this.approvalRow(proposalId);
			if (existing) {
				if (String(existing.proposal_fingerprint) !== proposalDto.fingerprint) { throw new Error('Commit approval fingerprint does not match its proposal.'); }
				return this.approvalFromRow(existing);
			}
			if (this.latestProposalRow(proposalDto.projectId, proposalDto.sessionId, proposalDto.turnId)?.id !== proposalId) { throw new Error('An older commit proposal cannot be approved.'); }
			if (Date.parse(proposalDto.expiresAt) <= Date.now()) { throw new Error('Commit proposal approval has expired.'); }
			this.assertCurrentProposalEvidence(proposalDto);
			const approvalId = randomUUID();
			const approvedAt = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_session_integration_approvals (id, proposal_id, proposal_fingerprint, actor, approved_at)
				VALUES (?, ?, ?, 'human', ?)`).run(approvalId, proposalId, proposalDto.fingerprint, approvedAt);
			return this.approvalFromRow(this.approvalRow(proposalId)!);
		});
	}

	/** Records a host-produced action receipt. This store does not execute or independently verify Git operations. */
	recordOutcome(input: {
		readonly proposalId: string;
		readonly expectedOutcomeRevision: number;
		readonly state: AgentSessionIntegrationOutcomeState;
		readonly action: AgentSessionIntegrationAction;
		readonly receipt: AgentSessionIntegrationActionReceipt;
		readonly retryOfOutcomeId?: string | null;
	}): AgentSessionIntegrationOutcomeDTO {
		this.assertOpen();
		this.assertExactKeys(input, ['proposalId', 'expectedOutcomeRevision', 'state', 'action', 'receipt'], ['retryOfOutcomeId'], 'integration outcome');
		this.assertUuid(input.proposalId, 'integration proposal ID');
		if (!Number.isSafeInteger(input.expectedOutcomeRevision) || input.expectedOutcomeRevision < 0) { throw new Error('Expected integration outcome revision is invalid.'); }
		if (!['applying', 'succeeded', 'failed', 'recoveryRequired'].includes(input.state)) { throw new Error('Commit outcome state is invalid.'); }
		if (input.action !== 'commit') { throw new Error('Commit proposal action is invalid.'); }
		const retryOfOutcomeId = input.retryOfOutcomeId ?? null;
		if (retryOfOutcomeId !== null) { this.assertUuid(retryOfOutcomeId, 'retry outcome ID'); }
		const receipt = this.normalizeReceipt(input.receipt);
		const receiptJson = JSON.stringify(receipt);
		if (Buffer.byteLength(receiptJson, 'utf8') > MAX_RECEIPT_BYTES) { throw new Error('Integration action receipt exceeds 32 KiB.'); }
		const payloadFingerprint = digest(JSON.stringify({ state: input.state, action: input.action, receipt, retryOfOutcomeId }));
		return this.transaction(() => {
			const proposal = this.requireProposalRow(input.proposalId);
			const proposalDto = this.proposalFromRow(proposal);
			if (!proposalDto.approval) { throw new Error('A commit action requires a trusted human proposal approval.'); }
			if (receipt.sourceHead !== proposalDto.sourceHead || receipt.proposedGitTreeHash !== proposalDto.proposedGitTreeHash || receipt.diffFingerprint !== proposalDto.diffFingerprint) {
				throw new Error('Commit action receipt does not match the approved proposal snapshot.');
			}
			const selectedPaths = new Set(proposalDto.paths.flatMap(path => path.previousPath ? [path.path, path.previousPath] : [path.path]));
			if (receipt.changedPaths.some(path => !selectedPaths.has(path))) { throw new Error('Commit receipt contains a path outside the approved proposal.'); }
			if (input.state === 'applying' && (receipt.resultingHead !== null || receipt.failureCode !== null || receipt.changedPaths.length > 0)) {
				throw new Error('Applying receipt cannot claim completed commit changes.');
			}
			if (input.state === 'succeeded' && (receipt.resultingHead === null || receipt.resultingHead !== receipt.candidateHead || receipt.failureCode !== null)) { throw new Error('Successful commit receipt requires the exact candidate HEAD and no failure code.'); }
			if ((input.state === 'failed' || input.state === 'recoveryRequired') && receipt.failureCode === null) { throw new Error('Failed or recovery-required commit receipt needs a failure code.'); }
			const latest = this.latestOutcomeRow(input.proposalId);
			const latestRevision = latest ? Number(latest.revision) : 0;
			if (latestRevision === input.expectedOutcomeRevision + 1 && latest && digest(JSON.stringify({ state: latest.state, action: latest.action, receipt: JSON.parse(String(latest.receipt_json)), retryOfOutcomeId: latest.retry_of_outcome_id ?? null })) === payloadFingerprint) {
				return this.outcomeFromRow(latest);
			}
			if (latestRevision !== input.expectedOutcomeRevision) { throw new Error('Integration outcome revision is stale.'); }
			const previous = latest ? this.outcomeFromRow(latest) : undefined;
			if (latestRevision >= 100) { throw new Error('Commit proposal outcome history reached its 100-receipt limit.'); }
			if (!previous) {
				if (input.state !== 'applying' || retryOfOutcomeId !== null) { throw new Error('An approved commit must begin with an applying receipt.'); }
				this.assertProposalCanStart(proposalDto);
			} else if (previous.state === 'applying') {
				if (!['succeeded', 'failed', 'recoveryRequired'].includes(input.state) || retryOfOutcomeId !== null) { throw new Error('An applying commit requires one terminal action outcome.'); }
				if (receipt.operationId !== previous.receipt.operationId || receipt.candidateHead !== previous.receipt.candidateHead) { throw new Error('Terminal commit receipt must preserve the applying operation ID and candidate HEAD.'); }
			} else if (previous.state === 'failed' || previous.state === 'recoveryRequired') {
				if (input.state !== 'applying' || retryOfOutcomeId !== previous.id) { throw new Error('Commit retry must explicitly reference the exact failed or recovery-required receipt.'); }
				if (receipt.candidateHead !== previous.receipt.candidateHead) { throw new Error('Commit retry must preserve the exact candidate HEAD.'); }
				if (previous.state === 'failed') { this.assertProposalCanStart(proposalDto); }
			} else {
				throw new Error('A completed commit requires a new proposal.');
			}
			const id = randomUUID();
			const recordedAt = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_session_integration_outcomes
				(id, proposal_id, revision, state, action, receipt_json, retry_of_outcome_id, recorded_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
				id, input.proposalId, latestRevision + 1, input.state, input.action, receiptJson, retryOfOutcomeId, recordedAt,
			);
			return this.outcomeFromRow(this.latestOutcomeRow(input.proposalId)!);
		});
	}

	private resolvePaths(input: readonly AgentSessionIntegrationPathInput[], evidence: AgentSessionChangeEvidenceDTO, scope: { readonly projectId: string; readonly sessionId: string; readonly turnId: string }): readonly AgentSessionIntegrationPathDTO[] {
		if (!Array.isArray(input) || input.length < 1 || input.length > MAX_PATHS) { throw new Error('Commit proposal must select between 1 and 300 changed paths.'); }
		const requestedExplanationCount = input.reduce((total, entry) => total + (Array.isArray(entry?.explanationTargets) ? entry.explanationTargets.length : 0), 0);
		if (requestedExplanationCount > MAX_EXPLANATIONS) { throw new Error('Commit proposal selects too many explanation revisions.'); }
		const observations = new Map(evidence.files.map(file => [file.path, file]));
		const seenPaths = new Set<string>();
		let explanationCount = 0;
		const paths = input.map((entry, index) => {
			this.assertExactKeys(entry, ['path', 'explanationTargets'], [], `selected path ${index + 1}`);
			const path = this.normalizePath(entry.path);
			if (seenPaths.has(path)) { throw new Error('Integration proposal paths must be unique.'); }
			seenPaths.add(path);
			const observation = observations.get(path);
			if (!observation) { throw new Error(`Selected path is not part of the exact change evidence: ${path}`); }
			if (!Array.isArray(entry.explanationTargets) || entry.explanationTargets.length < 1) { throw new Error(`Selected path requires at least one exact explanation revision: ${path}`); }
			const seenTargets = new Set<string>();
			const explanationTargets: AgentSessionIntegrationPathInput['explanationTargets'] = entry.explanationTargets;
			const explanations = explanationTargets.map((target: AgentSessionIntegrationPathInput['explanationTargets'][number], targetIndex: number) => {
				this.assertExactKeys(target, ['path', 'hunkId', 'revision'], [], `explanation target ${targetIndex + 1}`);
				if (target.path !== path || (target.hunkId !== null && !SHA256_PATTERN.test(target.hunkId))) { throw new Error('Selected explanation target must match its exact changed path and hunk ID.'); }
				if (!Number.isSafeInteger(target.revision) || target.revision < 1) { throw new Error('Selected explanation revision is invalid.'); }
				const targetKey = target.hunkId ?? '';
				if (seenTargets.has(targetKey)) { throw new Error('Selected explanation targets must be unique per path and hunk.'); }
				seenTargets.add(targetKey);
				const explanationTarget: AgentSessionExplanationTarget = {
					...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path, hunkId: target.hunkId,
				};
				const explanation = this.getExplanation(explanationTarget, target.revision);
				if (!explanation || explanation.revision !== target.revision || explanation.target.path !== path || explanation.target.hunkId !== target.hunkId
					|| explanation.target.evidenceFingerprint !== evidence.fingerprint) {
					throw new Error('Selected explanation revision does not belong to the exact turn evidence and path.');
				}
				explanationCount++;
				return { id: explanation.id, path, hunkId: target.hunkId, revision: explanation.revision, actor: explanation.actor, status: explanation.status };
			});
			return { path, previousPath: observation.previousPath ?? null, beforeMetadataSha256: observation.before ? digest(JSON.stringify(observation.before)) : null,
				afterMetadataSha256: observation.after ? digest(JSON.stringify(observation.after)) : null, explanations };
		});
		if (explanationCount > MAX_EXPLANATIONS) { throw new Error('Commit proposal selects too many explanation revisions.'); }
		return paths.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	}

	private normalizeReceipt(input: AgentSessionIntegrationActionReceipt): AgentSessionIntegrationActionReceipt {
		this.assertExactKeys(input, ['operationId', 'sourceHead', 'proposedGitTreeHash', 'diffFingerprint', 'candidateHead', 'resultingHead', 'changedPaths', 'failureCode'], [], 'commit action receipt');
		this.assertUuid(input.operationId, 'integration operation ID');
		if (!GIT_OBJECT_PATTERN.test(input.sourceHead) || !GIT_OBJECT_PATTERN.test(input.proposedGitTreeHash) || !GIT_OBJECT_PATTERN.test(input.candidateHead)
			|| input.proposedGitTreeHash.length !== input.sourceHead.length || input.candidateHead.length !== input.sourceHead.length || !SHA256_PATTERN.test(input.diffFingerprint)) {
			throw new Error('Commit action receipt fingerprints or Git object format are invalid.');
		}
		if (input.resultingHead !== null && (!GIT_OBJECT_PATTERN.test(input.resultingHead) || input.resultingHead.length !== input.sourceHead.length)) { throw new Error('Commit result HEAD does not match the source Git object format.'); }
		if (!Array.isArray(input.changedPaths) || input.changedPaths.length > MAX_PATHS) { throw new Error('Commit receipt path bounds are invalid.'); }
		const changedPaths = input.changedPaths.map(path => this.normalizePath(path));
		if (new Set(changedPaths).size !== changedPaths.length) { throw new Error('Commit receipt paths must be unique.'); }
		if (input.failureCode !== null && (typeof input.failureCode !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/u.test(input.failureCode))) { throw new Error('Commit failure code is invalid.'); }
		return { operationId: input.operationId, sourceHead: input.sourceHead.toLowerCase(), proposedGitTreeHash: input.proposedGitTreeHash.toLowerCase(), diffFingerprint: input.diffFingerprint.toLowerCase(),
			candidateHead: input.candidateHead.toLowerCase(), resultingHead: input.resultingHead?.toLowerCase() ?? null, changedPaths, failureCode: input.failureCode };
	}

	private proposalFromRow(row: ProposalRow): AgentSessionIntegrationProposalDTO {
		const projectId = String(row.project_id);
		const sessionId = String(row.session_id);
		const turnId = String(row.turn_id);
		const turn = this.requireTurn(projectId, sessionId, turnId);
		if (turn.snapshotSha256 !== String(row.turn_snapshot_sha256)) { throw new Error('Integration proposal turn snapshot digest changed.'); }
		const evidence = this.getEvidence(projectId, sessionId, turnId, Number(row.evidence_version));
		if (!evidence || evidence.fingerprint !== String(row.evidence_fingerprint)) { throw new Error('Integration proposal evidence binding is missing or corrupt.'); }
		const payloadJson = String(row.payload_json);
		const payload = JSON.parse(payloadJson) as ProposalPayload;
		this.assertExactKeys(payload, ['sessionWorktreeOwnerId', 'sourceHead', 'proposedGitTreeHash', 'diffFingerprint', 'commitMessage', 'author', 'committer', 'paths'], [], 'persisted commit proposal');
		const author = this.normalizeGitIdentity(payload.author, 'persisted author');
		const committer = this.normalizeGitIdentity(payload.committer, 'persisted committer');
		if (JSON.stringify(author) !== JSON.stringify(payload.author) || JSON.stringify(committer) !== JSON.stringify(payload.committer)) { throw new Error('Persisted commit proposal Git identity is not canonical.'); }
		if (payload.sessionWorktreeOwnerId !== turn.snapshot.managedWorktreeOwnerId || payload.sessionWorktreeOwnerId !== sessionId) { throw new Error('Commit proposal session worktree owner does not match its durable turn.'); }
		const validatedPaths = this.resolvePaths(payload.paths.map(path => ({
			path: path.path,
			explanationTargets: path.explanations.map(explanation => ({ path: explanation.path, hunkId: explanation.hunkId, revision: explanation.revision })),
		})), evidence, { projectId, sessionId, turnId });
		if (JSON.stringify(validatedPaths) !== JSON.stringify(payload.paths)) { throw new Error('Commit proposal paths or explanations no longer match their immutable evidence.'); }
		const proposalFingerprint = digest(JSON.stringify({ projectId, sessionId, turnId, evidenceVersion: Number(row.evidence_version), evidenceFingerprint: String(row.evidence_fingerprint), turnSnapshotSha256: turn.snapshotSha256, ...payload }));
		if (proposalFingerprint !== String(row.proposal_fingerprint)) { throw new Error('Integration proposal fingerprint does not match its immutable payload.'); }
		const proposalId = String(row.id);
		const approvalRow = this.approvalRow(proposalId);
		const approval = approvalRow ? this.approvalFromRow(approvalRow) : null;
		if (approval && approval.proposalFingerprint !== proposalFingerprint) { throw new Error('Integration approval is not bound to this proposal fingerprint.'); }
		const outcomes = this.outcomeRows(proposalId).map(outcome => this.outcomeFromRow(outcome));
		return {
			kind: 'commit', id: proposalId, projectId, sessionId, turnId, revision: Number(row.revision), evidenceVersion: Number(row.evidence_version),
			evidenceFingerprint: String(row.evidence_fingerprint), turnSnapshotSha256: turn.snapshotSha256,
			...payload, fingerprint: proposalFingerprint, createdAt: String(row.created_at), expiresAt: String(row.expires_at),
			approval, state: outcomes.at(-1)?.state ?? 'pending', outcomes,
		};
	}

	private outcomeFromRow(row: OutcomeRow): AgentSessionIntegrationOutcomeDTO {
		const receipt = this.normalizeReceipt(JSON.parse(String(row.receipt_json)) as AgentSessionIntegrationActionReceipt);
		const state = String(row.state) as AgentSessionIntegrationOutcomeState;
		if (!['applying', 'succeeded', 'failed', 'recoveryRequired'].includes(state) || row.action !== 'commit') { throw new Error('Persisted commit outcome state or action is invalid.'); }
		const retryOfOutcomeId = row.retry_of_outcome_id === null ? null : String(row.retry_of_outcome_id);
		if (retryOfOutcomeId !== null) { this.assertUuid(retryOfOutcomeId, 'persisted retry outcome ID'); }
		return { id: String(row.id), proposalId: String(row.proposal_id), revision: Number(row.revision), state,
			action: 'commit', receipt, retryOfOutcomeId, recordedAt: String(row.recorded_at) };
	}

	private approvalFromRow(row: ApprovalRow): AgentSessionIntegrationApprovalDTO {
		if (row.actor !== 'human') { throw new Error('Integration approval actor is invalid.'); }
		return { id: String(row.id), proposalId: String(row.proposal_id), proposalFingerprint: String(row.proposal_fingerprint), actor: 'human', approvedAt: String(row.approved_at) };
	}

	private assertCurrentProposalEvidence(proposal: AgentSessionIntegrationProposalDTO): void {
		const latest = this.getLatestEvidence(proposal.projectId, proposal.sessionId, proposal.turnId);
		if (!latest || latest.version !== proposal.evidenceVersion || latest.fingerprint !== proposal.evidenceFingerprint) { throw new Error('Integration proposal evidence changed; prepare and review a fresh proposal.'); }
	}

	private assertProposalCanStart(proposal: AgentSessionIntegrationProposalDTO): void {
		if (Date.parse(proposal.expiresAt) <= Date.now()) { throw new Error('Commit proposal action has expired; prepare and approve a fresh proposal.'); }
		this.assertCurrentProposalEvidence(proposal);
		if (this.latestProposalRow(proposal.projectId, proposal.sessionId, proposal.turnId)?.id !== proposal.id) { throw new Error('An older commit proposal cannot be applied.'); }
	}

	private requireTurn(projectId: string, sessionId: string, turnId: string): AgentSessionTurnDTO {
		const turn = this.getTurn(projectId, sessionId, turnId);
		if (!turn) { throw new Error('Integration proposal requires an exact durable turn in the project and session.'); }
		return turn;
	}

	private requireProposalRow(proposalId: string): ProposalRow {
		const row = this.db.prepare(`SELECT id, project_id, session_id, turn_id, revision, evidence_version, evidence_fingerprint, turn_snapshot_sha256, proposal_fingerprint, payload_json, created_at, expires_at
			FROM agent_session_integration_proposals WHERE id = ?`).get(proposalId) as ProposalRow | undefined;
		if (!row) { throw new Error('Integration proposal does not exist.'); }
		return row;
	}

	private latestProposalRow(projectId: string, sessionId: string, turnId: string): ProposalRow | undefined {
		return this.db.prepare(`SELECT id, project_id, session_id, turn_id, revision, evidence_version, evidence_fingerprint, turn_snapshot_sha256, proposal_fingerprint, payload_json, created_at, expires_at
			FROM agent_session_integration_proposals WHERE project_id = ? AND session_id = ? AND turn_id = ? ORDER BY revision DESC LIMIT 1`)
			.get(projectId, sessionId, turnId) as ProposalRow | undefined;
	}

	private approvalRow(proposalId: string): ApprovalRow | undefined {
		return this.db.prepare('SELECT id, proposal_id, proposal_fingerprint, actor, approved_at FROM agent_session_integration_approvals WHERE proposal_id = ?').get(proposalId) as ApprovalRow | undefined;
	}

	private latestOutcomeRow(proposalId: string): OutcomeRow | undefined {
		return this.db.prepare(`SELECT id, proposal_id, revision, state, action, receipt_json, retry_of_outcome_id, recorded_at FROM agent_session_integration_outcomes
			WHERE proposal_id = ? ORDER BY revision DESC LIMIT 1`).get(proposalId) as OutcomeRow | undefined;
	}

	private outcomeRows(proposalId: string): OutcomeRow[] {
		return this.db.prepare(`SELECT id, proposal_id, revision, state, action, receipt_json, retry_of_outcome_id, recorded_at FROM agent_session_integration_outcomes
			WHERE proposal_id = ? ORDER BY revision LIMIT 100`).all(proposalId) as OutcomeRow[];
	}

	private normalizeScope(projectId: string, sessionId: string, turnId: string): { readonly projectId: string; readonly sessionId: string; readonly turnId: string } {
		this.assertUuid(projectId, 'project ID'); this.assertUuid(sessionId, 'session ID'); this.assertUuid(turnId, 'turn ID');
		return { projectId, sessionId, turnId };
	}

	private normalizePath(input: string): string {
		if (typeof input !== 'string' || !input || Buffer.byteLength(input, 'utf8') > MAX_PATH_BYTES || input.includes('\0') || isAbsolute(input) || input.includes('\\')) { throw new Error('Integration path must be a bounded root-relative POSIX path.'); }
		const parts = input.split('/');
		if (parts.some(part => !part || part === '.' || part === '..')) { throw new Error('Integration path contains an invalid segment.'); }
		return input;
	}

	private normalizeText(input: string, maxBytes: number, label: string): string {
		if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input, 'utf8') > maxBytes || input.includes('\0')) { throw new Error(`${label} must be non-empty and within its size limit.`); }
		return input;
	}

	private normalizeGitIdentity(input: AgentSessionIntegrationGitIdentity, label: string): AgentSessionIntegrationGitIdentity {
		this.assertExactKeys(input, ['name', 'email', 'date'], [], `${label} Git identity`);
		const byteLength = (value: unknown): number => typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : Number.MAX_SAFE_INTEGER;
		if (typeof input.name !== 'string' || !input.name.trim() || byteLength(input.name) > 512 || /[\r\n<>\0]/u.test(input.name)) { throw new Error(`Commit ${label} name is invalid.`); }
		if (typeof input.email !== 'string' || !input.email.trim() || byteLength(input.email) > 512 || /[\r\n<>\0]/u.test(input.email)) { throw new Error(`Commit ${label} email is invalid.`); }
		if (typeof input.date !== 'string' || byteLength(input.date) > 32 || !/^(?:0|[1-9][0-9]*) [+-](?:[01][0-9]|2[0-3])[0-5][0-9]$/u.test(input.date)) { throw new Error(`Commit ${label} raw Git date is invalid.`); }
		return { name: input.name, email: input.email, date: input.date };
	}

	private assertUuid(value: string, label: string): void { if (typeof value !== 'string' || !UUID_PATTERN.test(value)) { throw new Error(`Integration ${label} is invalid.`); } }

	private assertExactKeys(value: unknown, required: readonly string[], optional: readonly string[], label: string): void {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`Integration ${label} must be an object.`); }
		const object = value as Record<string, unknown>;
		const allowed = new Set([...required, ...optional]);
		for (const key of required) { if (!Object.hasOwn(object, key)) { throw new Error(`Integration ${label} is missing ${key}.`); } }
		for (const key of Object.keys(object)) { if (!allowed.has(key)) { throw new Error(`Integration ${label} contains unknown fields.`); } }
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try { const result = operation(); this.db.exec('COMMIT'); return result; }
		catch (error) { this.db.exec('ROLLBACK'); throw error; }
	}
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
