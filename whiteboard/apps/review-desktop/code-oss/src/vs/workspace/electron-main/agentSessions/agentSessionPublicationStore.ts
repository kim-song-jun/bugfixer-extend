/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { AgentSessionMergeProposalDTO } from '../../common/workspaceAgentMergeProtocol.js';
import type { AgentSessionStore } from './agentSessionStore.js';
import { runAgentSessionTransaction } from './agentSessionNotificationEvents.js';
import {
	AGENT_SESSION_PUBLICATION_DIFF_MAX_BYTES,
	AGENT_SESSION_PUBLICATION_HISTORY_LIMIT,
	AGENT_SESSION_PUBLICATION_OPERATION_EVENT_LIMIT,
	type AgentSessionPublicationAccount,
	type AgentSessionPublicationApprovalDTO,
	type AgentSessionPublicationDiff,
	type AgentSessionPublicationEvent,
	type AgentSessionPublicationOperationDTO,
	type AgentSessionPublicationPageDTO,
	type AgentSessionPublicationProposalDTO,
	type AgentSessionPublicationPublishedArtifactDTO,
	type AgentSessionPublicationPrepareInput,
	type AgentSessionPublicationBase,
	type AgentSessionPublicationMergedSource,
	type AgentSessionPublicationRemote,
} from '../../common/workspaceAgentPublicationProtocol.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PROPOSAL_BYTES = 5 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_TTL_MS = 10 * 60 * 1000;
const MAX_TITLE_BYTES = 512;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_PATHS = 300;

/** Electron-main-only material. Never pass this shape through renderer or MCP IPC. */
export interface AgentSessionPublicationHostCreateInput extends AgentSessionPublicationPrepareInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly sourceMerge: AgentSessionPublicationMergedSource;
	readonly remote: AgentSessionPublicationRemote;
	readonly account: AgentSessionPublicationAccount;
	readonly base: AgentSessionPublicationBase;
	readonly diff: AgentSessionPublicationDiff;
}

interface ProposalRow extends Readonly<Record<string, SQLOutputValue>> {
	id: SQLOutputValue; project_id: SQLOutputValue; session_id: SQLOutputValue; turn_id: SQLOutputValue;
	source_merge_id: SQLOutputValue; revision: SQLOutputValue; semantic_fingerprint: SQLOutputValue;
	proposal_fingerprint: SQLOutputValue; payload_json: SQLOutputValue; created_at: SQLOutputValue; expires_at: SQLOutputValue;
}

interface OperationRow extends Readonly<Record<string, SQLOutputValue>> {
	id: SQLOutputValue; proposal_id: SQLOutputValue; proposal_fingerprint: SQLOutputValue;
	account_stable_id: SQLOutputValue; repository_id: SQLOutputValue; publication_ref: SQLOutputValue;
	expected_old_remote_oid: SQLOutputValue; head_oid: SQLOutputValue; state: SQLOutputValue;
	revision: SQLOutputValue; started_at: SQLOutputValue;
}

interface EventRow extends Readonly<Record<string, SQLOutputValue>> {
	revision: SQLOutputValue; event_type: SQLOutputValue; event_json: SQLOutputValue; recorded_at: SQLOutputValue;
}

interface StoredProposalPayload extends Omit<AgentSessionPublicationProposalDTO, 'approval'> { }

/** Synchronous durable journal. It performs no filesystem, Git, HTTP, CLI, or credential work. */
export class AgentSessionPublicationStore {
	constructor(
		private readonly db: DatabaseSync,
		private readonly getMergeProposal: (proposalId: string) => AgentSessionMergeProposalDTO | undefined,
		private readonly sessions: AgentSessionStore,
	) { }

	createProposal(input: AgentSessionPublicationHostCreateInput): AgentSessionPublicationProposalDTO {
		this.assertExactKeys(input, ['projectId', 'sessionId', 'turnId', 'sourceMergeId', 'remoteName', 'baseRef', 'accountRef', 'title', 'body', 'expectedRevision', 'sourceMerge', 'remote', 'account', 'base', 'diff'], ['textRevision']);
		this.assertScope(input.projectId, input.sessionId, input.turnId); this.assertUuid(input.sourceMergeId, 'source merge ID');
		if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) { throw this.error('invalidInput', 'Expected publication revision is invalid.'); }
		const publishedArtifact = this.requireSuccessfulMerge(input);
		const sourceMerge = input.sourceMerge;
		const remote = this.normalizeRemote(input.remote, input.remoteName);
		const account = this.normalizeAccount(input.account, input.accountRef, remote.host);
		const baseRef = this.normalizeRef(input.baseRef, 'base ref');
		this.assertExactKeys(input.base, ['ref', 'oid']);
		const baseOid = this.normalizeOid(input.base.oid, 'base commit');
		if (input.base.ref !== baseRef) { throw this.error('authorityMismatch', 'Resolved base ref does not match the requested ref.'); }
		const diff = this.normalizeDiff(input.diff, baseOid, sourceMerge.resultCommit);
		const title = this.normalizeText(input.title, MAX_TITLE_BYTES, 'title', false);
		const body = this.normalizeText(input.body, MAX_BODY_BYTES, 'body', true);
		const textRevision = input.textRevision === undefined ? undefined : this.normalizeTextSelection(input.textRevision, input, title, body);
		const semantic = { projectId: input.projectId, sessionId: input.sessionId, turnId: input.turnId, sourceMergeId: input.sourceMergeId,
			sourceMergeRevision: sourceMerge.mergeRevision, sourceMergeFingerprint: sourceMerge.mergeFingerprint, sourceMergeOperationId: sourceMerge.mergeOperationId,
			integrationOwnerId: sourceMerge.integrationOwnerId, resultCommit: sourceMerge.resultCommit, publishedArtifact,
			remote, account, baseRef, baseOid, diff, title, body, draft: true as const, ...(textRevision ? { textRevision } : {}) };
		const semanticFingerprint = digest(JSON.stringify(semantic));
		return this.transaction(() => {
			const latest = this.latestProposal(input.projectId, input.sessionId, input.turnId);
			const latestRevision = latest ? Number(latest.revision) : 0;
			if (latestRevision === input.expectedRevision + 1 && latest && String(latest.semantic_fingerprint) === semanticFingerprint) {
				return this.proposalFromRow(latest);
			}
			if (latestRevision !== input.expectedRevision) { throw this.error('staleRevision', 'Publication proposal revision is stale.'); }
			this.pruneUnstartedHistory(input.projectId, input.sessionId, input.turnId);
			const retained = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM agent_session_publication_proposals WHERE project_id = ? AND session_id = ? AND turn_id = ?`)
				.get(input.projectId, input.sessionId, input.turnId) as { count: SQLOutputValue }).count);
			if (retained >= AGENT_SESSION_PUBLICATION_HISTORY_LIMIT) { throw this.error('invalidInput', 'Publication history is full because all retained rows are approved or have durable operations.'); }
			const createdAt = new Date().toISOString();
			const expiresAt = new Date(Date.now() + MAX_TTL_MS).toISOString();
			const id = randomUUID();
			const publicationRef = `refs/heads/bugfixer/pr/${id}`;
			const payload: StoredProposalPayload = {
				id, revision: latestRevision + 1, projectId: input.projectId, bindingId: sourceMerge.bindingId,
				sessionId: input.sessionId, turnId: input.turnId, sourceMergeId: input.sourceMergeId,
				sourceMergeRevision: sourceMerge.mergeRevision, sourceMergeFingerprint: sourceMerge.mergeFingerprint,
				sourceMergeOperationId: sourceMerge.mergeOperationId, integrationOwnerId: sourceMerge.integrationOwnerId,
				resultCommit: sourceMerge.resultCommit, publishedArtifact,
				remote, account, baseRef, baseOid, publicationRef, expectedOldRemoteOid: null, diff, title, body, draft: true,
				fingerprint: '', createdAt, expiresAt, ...(textRevision ? { textRevision } : {}),
			};
			const fingerprint = digest(JSON.stringify(payload));
			const immutablePayload = { ...payload, fingerprint };
			const payloadJson = JSON.stringify(immutablePayload);
			if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PROPOSAL_BYTES) { throw this.error('invalidInput', 'Publication proposal exceeds five MiB.'); }
			this.db.prepare(`INSERT INTO agent_session_publication_proposals
				(id, project_id, session_id, turn_id, source_merge_id, revision, semantic_fingerprint, proposal_fingerprint, payload_json, created_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(id, input.projectId, input.sessionId, input.turnId, input.sourceMergeId, latestRevision + 1, semanticFingerprint, fingerprint, payloadJson, createdAt, expiresAt);
			this.sessions.recordNotificationWithinTransaction({
				eventId: `publicationProposal:${id}:review`, projectId: input.projectId, sessionId: input.sessionId,
				kind: 'prReady', target: { kind: 'publicationProposal', id, turnId: input.turnId }, createdAt,
			});
			return this.proposalFromRow(this.requireProposalRow(id));
		});
	}

	getProposal(proposalId: string): AgentSessionPublicationProposalDTO | undefined {
		this.assertUuid(proposalId, 'publication proposal ID');
		const row = this.db.prepare('SELECT * FROM agent_session_publication_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
		return row ? this.proposalFromRow(row) : undefined;
	}

	listProposals(projectId: string, sessionId: string, turnId: string, options: { readonly afterRevision?: number; readonly limit?: number } = {}): AgentSessionPublicationPageDTO {
		this.assertScope(projectId, sessionId, turnId);
		this.assertExactKeys(options, [], ['afterRevision', 'limit']);
		const afterRevision = options.afterRevision ?? 0; const limit = options.limit ?? AGENT_SESSION_PUBLICATION_HISTORY_LIMIT;
		if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_SESSION_PUBLICATION_HISTORY_LIMIT) { throw this.error('invalidInput', 'Publication page bounds are invalid.'); }
		const rows = this.db.prepare(`SELECT id, revision FROM agent_session_publication_proposals WHERE project_id = ? AND session_id = ? AND turn_id = ? AND revision > ? ORDER BY revision LIMIT ?`)
			.all(projectId, sessionId, turnId, afterRevision, limit + 1) as Array<{ id: SQLOutputValue; revision: SQLOutputValue }>;
		const hasMore = rows.length > limit; const proposals = rows.slice(0, limit).map(row => this.requireProposal(String(row.id)));
		return { proposals, nextRevision: proposals.at(-1)?.revision ?? afterRevision, hasMore };
	}

	recordTrustedHumanApproval(proposalId: string, expectedRevision: number, expectedFingerprint: string): AgentSessionPublicationApprovalDTO {
		this.assertUuid(proposalId, 'publication proposal ID');
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !SHA256_PATTERN.test(expectedFingerprint)) { throw this.error('invalidInput', 'Publication approval identity is invalid.'); }
		return this.transaction(() => {
			const row = this.requireProposalRow(proposalId); const proposal = this.proposalFromRow(row);
			if (proposal.revision !== expectedRevision || proposal.fingerprint !== expectedFingerprint) { throw this.error('staleRevision', 'Publication approval tuple is stale.'); }
			const existing = this.approvalRow(proposalId);
			if (existing) {
				if (String(existing.proposal_fingerprint) !== proposal.fingerprint) { throw this.error('invalidPersistedData', 'Stored publication approval does not match its immutable proposal.'); }
				return this.approvalFromRow(existing, proposal.fingerprint);
			}
			if (this.latestProposal(proposal.projectId, proposal.sessionId, proposal.turnId)?.id !== proposalId) { throw this.error('staleRevision', 'An older publication proposal cannot be approved.'); }
			if (Date.parse(proposal.expiresAt) <= Date.now()) { throw this.error('expired', 'Publication proposal approval has expired.'); }
			const approvedAt = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_session_publication_approvals (proposal_id, proposal_fingerprint, actor, approved_at) VALUES (?, ?, 'human', ?)`)
				.run(proposalId, proposal.fingerprint, approvedAt);
			return this.approvalFromRow(this.approvalRow(proposalId)!, proposal.fingerprint);
		});
	}

	startOperation(proposalId: string, expectedFingerprint: string): AgentSessionPublicationOperationDTO {
		this.assertUuid(proposalId, 'publication proposal ID');
		if (!SHA256_PATTERN.test(expectedFingerprint)) { throw this.error('invalidInput', 'Publication fingerprint is invalid.'); }
		return this.transaction(() => {
			const proposal = this.requireProposal(proposalId);
			if (proposal.fingerprint !== expectedFingerprint) { throw this.error('staleRevision', 'Publication operation fingerprint is stale.'); }
			const existing = this.operationRow(proposalId);
			if (existing) { return this.operationFromRow(existing); }
			const approval = this.approvalRow(proposalId);
			if (!approval || String(approval.proposal_fingerprint) !== proposal.fingerprint) { throw this.error('notApproved', 'A trusted human approval for this exact publication proposal is required.'); }
			if (Date.parse(proposal.expiresAt) <= Date.now() || this.latestProposal(proposal.projectId, proposal.sessionId, proposal.turnId)?.id !== proposalId) { throw this.error('expired', 'A new publication operation requires the latest unexpired proposal.'); }
			const publishedArtifact = this.verifySuccessfulMerge({ projectId: proposal.projectId, bindingId: proposal.bindingId, sessionId: proposal.sessionId, turnId: proposal.turnId,
				mergeProposalId: proposal.sourceMergeId, mergeRevision: proposal.sourceMergeRevision, mergeFingerprint: proposal.sourceMergeFingerprint,
				mergeOperationId: proposal.sourceMergeOperationId, integrationOwnerId: proposal.integrationOwnerId, resultCommit: proposal.resultCommit,
			});
			if (JSON.stringify(publishedArtifact) !== JSON.stringify(proposal.publishedArtifact)) { throw this.error('authorityMismatch', 'The exact local published merge artifact changed after proposal preparation.'); }
			const id = randomUUID();
			this.db.prepare(`INSERT INTO agent_session_publication_operations (id, proposal_id, proposal_fingerprint, account_stable_id, repository_id, publication_ref, expected_old_remote_oid, head_oid, state, revision, started_at)
				VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'started', 0, ?)`)
				.run(id, proposalId, proposal.fingerprint, proposal.account.stableId, proposal.remote.repositoryId, proposal.publicationRef, proposal.resultCommit, new Date().toISOString());
			return this.operationFromRow(this.operationRow(proposalId)!);
		});
	}

	appendEvent(operationId: string, expectedRevision: number, event: AgentSessionPublicationEvent): AgentSessionPublicationOperationDTO {
		this.assertUuid(operationId, 'publication operation ID');
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) { throw this.error('invalidInput', 'Publication event revision is invalid.'); }
		const normalized = this.normalizeEvent(event); const eventJson = JSON.stringify(normalized);
		if (Buffer.byteLength(eventJson, 'utf8') > MAX_RECEIPT_BYTES) { throw this.error('invalidInput', 'Publication event exceeds 32 KiB.'); }
		return this.transaction(() => {
			const operationRow = this.requireOperationRow(operationId); const operation = this.operationFromRow(operationRow);
			const proposal = this.requireProposal(operation.proposalId); const events = operation.events;
			const currentRevision = operation.revision;
			if (currentRevision === expectedRevision + 1) {
				const previous = events.at(-1)!;
				if (JSON.stringify(previous.event) === eventJson) { return operation; }
				throw this.error('staleOperation', 'Publication event revision was already recorded with different content.');
			}
			if (currentRevision !== expectedRevision) { throw this.error('staleOperation', 'Publication operation revision is stale.'); }
			this.validateNextEvent(proposal, events.map(row => row.event), normalized);
			const nextRevision = currentRevision + 1; const recordedAt = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_session_publication_events (operation_id, revision, event_type, event_json, recorded_at) VALUES (?, ?, ?, ?, ?)`)
				.run(operationId, nextRevision, normalized.type, eventJson, recordedAt);
			const state = normalized.type === 'recoveryRequired' ? 'recoveryRequired'
				: normalized.type === 'published' || normalized.type === 'notPublished' || normalized.type === 'failed' ? normalized.type : operation.state;
			if (nextRevision > AGENT_SESSION_PUBLICATION_OPERATION_EVENT_LIMIT) { throw this.error('invalidStep', 'Publication operation observation limit was reached.'); }
			this.db.prepare(`UPDATE agent_session_publication_operations SET state = ?, revision = ? WHERE id = ?`)
				.run(state, nextRevision, operationId);
			return this.operationFromRow(this.requireOperationRow(operationId));
		});
	}

	readOperation(operationId: string): AgentSessionPublicationOperationDTO {
		this.assertUuid(operationId, 'publication operation ID');
		return this.operationFromRow(this.requireOperationRow(operationId));
	}

	getOperationForProposal(proposalId: string): AgentSessionPublicationOperationDTO | undefined {
		this.assertUuid(proposalId, 'publication proposal ID');
		const proposal = this.getProposal(proposalId);
		if (!proposal) { return undefined; }
		const row = this.operationRow(proposalId);
		if (!row) { return undefined; }
		const operation = this.operationFromRow(row);
		if (operation.proposalId !== proposal.id || operation.proposalFingerprint !== proposal.fingerprint) {
			throw this.error('invalidPersistedData', 'Persisted publication operation does not match its exact proposal.');
		}
		return operation;
	}

	private validateNextEvent(proposal: AgentSessionPublicationProposalDTO, prior: readonly AgentSessionPublicationEvent[], next: AgentSessionPublicationEvent): void {
		const last = prior.at(-1)?.type;
		const isRecovery = prior.some(event => event.type === 'recoveryRequired');
		const branchObservation = [...prior].reverse().find((event): event is Extract<AgentSessionPublicationEvent, { type: 'branchObserved' | 'branchReobserved' }> => event.type === 'branchObserved' || event.type === 'branchReobserved');
		const prObservation = [...prior].reverse().find((event): event is Extract<AgentSessionPublicationEvent, { type: 'pullRequestObserved' | 'pullRequestReobserved' }> => event.type === 'pullRequestObserved' || event.type === 'pullRequestReobserved');
		const lastRecoveryIndex = prior.map(event => event.type).lastIndexOf('recoveryRequired');
		if (['published', 'notPublished', 'failed'].includes(last ?? '')) { throw this.error('invalidStep', 'Publication operation is already terminal.'); }
		if (isRecovery && !['branchReobserved', 'pullRequestReobserved', 'recoveryRequired', 'published', 'notPublished', 'failed'].includes(next.type)) {
			throw this.error('invalidStep', 'Recovery permits read-only reobservations and an outcome only; external write intents cannot be retried.');
		}
		if (next.type === 'branchReobserved') {
			if (!isRecovery || !branchObservation || (next.oid !== null && !OID_PATTERN.test(next.oid))) { throw this.error('invalidStep', 'Branch reobservation requires a durable recovery journal and valid remote observation.'); }
			return;
		}
		if (next.type === 'pullRequestReobserved') {
			const knownPullRequestId = prior.find((event): event is Extract<AgentSessionPublicationEvent, { type: 'pullRequestObserved' | 'pullRequestReobserved' }> =>
				(event.type === 'pullRequestObserved' || event.type === 'pullRequestReobserved') && event.id !== null)?.id;
			if (!isRecovery || !prObservation || !this.validPullRequestObservation(proposal, next)
				|| (knownPullRequestId !== undefined && next.id !== knownPullRequestId)) { throw this.error('invalidStep', 'Pull request reobservation requires durable recovery and the same or newly discovered canonical pull request.'); }
			return;
		}
		if (next.type === 'branchWriteStarted') {
			if (prior.length !== 0 || next.expectedOldRemoteOid !== null) { throw this.error('invalidStep', 'The first publication step must be an absent-ref branch write intent.'); }
			return;
		}
		if (next.type === 'branchObserved') {
			if (last !== 'branchWriteStarted' || (next.oid !== null && !OID_PATTERN.test(next.oid))) { throw this.error('invalidStep', 'Branch observation is out of sequence or invalid.'); }
			return;
		}
		if (next.type === 'pullRequestWriteStarted') {
			const branch = prior.at(-1);
			if (last !== 'branchObserved' || branch?.type !== 'branchObserved' || branch.outcome !== 'created' || branch.oid !== proposal.resultCommit || next.headOid !== proposal.resultCommit) { throw this.error('invalidStep', 'Pull request creation requires the exact observed proposal branch and head.'); }
			return;
		}
		if (next.type === 'pullRequestObserved') {
			if (last !== 'pullRequestWriteStarted' || !this.validPullRequestObservation(proposal, next)) { throw this.error('invalidStep', 'Pull request observation is out of sequence or invalid.'); }
			return;
		}
		if (next.type === 'published') {
			if (!prObservation || !branchObservation || (isRecovery && (prior.findIndex((event, index) => index > lastRecoveryIndex && event.type === 'branchReobserved') < 0 || prior.findIndex((event, index) => index > lastRecoveryIndex && event.type === 'pullRequestReobserved') < 0))) { throw this.error('invalidStep', 'A published receipt requires fresh exact branch and pull request observations after recovery.'); }
			const observedPr = prObservation;
			if (branchObservation.outcome !== 'created' || branchObservation.oid !== proposal.resultCommit || observedPr.outcome !== 'created' || !observedPr.id || !observedPr.url || next.pullRequestId !== observedPr.id || next.url !== observedPr.url
				|| observedPr.repositoryId !== proposal.remote.repositoryId || observedPr.headRef !== proposal.publicationRef || observedPr.headOid !== proposal.resultCommit
				|| observedPr.baseRef !== proposal.baseRef || observedPr.baseOid !== proposal.baseOid || observedPr.title !== proposal.title || observedPr.body !== proposal.body || observedPr.draft !== true
				|| next.branchOid !== proposal.resultCommit || next.headOid !== proposal.resultCommit || next.baseRef !== proposal.baseRef || next.title !== proposal.title || next.body !== proposal.body || next.draft !== true) {
				throw this.error('invalidStep', 'Published receipt does not match the exact observed repository, branch, base, title, body, and draft state.');
			}
			return;
		}
		if (next.type === 'recoveryRequired') {
			if (!['branchObserved', 'branchReobserved', 'pullRequestObserved', 'pullRequestReobserved'].includes(last ?? '')) { throw this.error('invalidStep', 'Recovery requires a durable observation of the external write state.'); }
			if (next.pullRequestId !== (prObservation?.id ?? null) || next.branchOid !== (branchObservation?.oid ?? null)) { throw this.error('invalidStep', 'Recovery receipt must preserve every observed pull request ID and branch head.'); }
			const reasonMatches = next.reason === 'branchMismatch' ? branchObservation?.outcome === 'mismatch'
				: next.reason === 'prMismatch' ? prObservation?.outcome === 'mismatch'
					: next.reason === 'baseChanged' ? !!prObservation && prObservation.baseOid !== proposal.baseOid
						: branchObservation?.outcome === 'unknown' || prObservation?.outcome === 'unknown'
							|| branchObservation?.errorCode === 'networkUncertain' || prObservation?.errorCode === 'networkUncertain'
							|| (branchObservation?.outcome === 'absent' && prObservation?.id !== null && prObservation?.id !== undefined)
							|| (prObservation?.outcome === 'absent' && branchObservation?.outcome === 'created' && branchObservation.oid === proposal.resultCommit);
			if (!reasonMatches) { throw this.error('invalidStep', 'Recovery reason does not match the persisted remote observation.'); }
			return;
		}
		if (next.type === 'notPublished' || next.type === 'failed') {
			if (!['branchObserved', 'branchReobserved', 'pullRequestObserved', 'pullRequestReobserved'].includes(last ?? '')) { throw this.error('invalidStep', 'Terminal result requires a durable observation after the external write intent.'); }
			if (next.pullRequestId !== (prObservation?.id ?? null) || next.branchOid !== (branchObservation?.oid ?? null)) { throw this.error('invalidStep', 'Terminal receipt must preserve every observed pull request ID and branch head.'); }
			if (next.type === 'notPublished') {
				const hadPullRequestWrite = prior.some(event => event.type === 'pullRequestWriteStarted');
				const knownPullRequestId = prior.some(event => (event.type === 'pullRequestObserved' || event.type === 'pullRequestReobserved') && event.id !== null);
				const freshAfterRecovery = isRecovery && (prior.findIndex((event, index) => index > lastRecoveryIndex && event.type === 'branchReobserved') >= 0
					&& prior.findIndex((event, index) => index > lastRecoveryIndex && event.type === 'pullRequestReobserved') >= 0);
				const bothObjectsAbsent = branchObservation?.outcome === 'absent' && branchObservation.oid === null
					&& (!hadPullRequestWrite || (prObservation?.outcome === 'absent' && freshAfterRecovery));
				const reasonMatches = !knownPullRequestId && bothObjectsAbsent && (next.reason === 'branchAbsent' || next.reason === 'prAbsent');
				if (!reasonMatches) { throw this.error('invalidStep', 'Not-published reason does not match the persisted remote observation.'); }
			} else if (next.errorCode === 'none') { throw this.error('invalidStep', 'Failure receipt requires a bounded provider error code.'); }
			return;
		}
		throw this.error('invalidStep', 'Publication event type is invalid.');
	}

	private requireSuccessfulMerge(input: AgentSessionPublicationHostCreateInput): AgentSessionPublicationPublishedArtifactDTO {
		this.assertExactKeys(input.sourceMerge, ['projectId', 'bindingId', 'sessionId', 'turnId', 'mergeProposalId', 'mergeRevision', 'mergeFingerprint', 'mergeOperationId', 'integrationOwnerId', 'resultCommit']);
		if (input.sourceMerge.projectId !== input.projectId || input.sourceMerge.sessionId !== input.sessionId || input.sourceMerge.turnId !== input.turnId) { throw this.error('authorityMismatch', 'Source merge scope does not match the publication request.'); }
		return this.verifySuccessfulMerge(input.sourceMerge);
	}

	private validPullRequestObservation(proposal: AgentSessionPublicationProposalDTO, observation: Extract<AgentSessionPublicationEvent, { type: 'pullRequestObserved' | 'pullRequestReobserved' }>): boolean {
		if ((observation.id !== null && !/^[0-9]{1,20}$/u.test(observation.id))
			|| (observation.repositoryId !== proposal.remote.repositoryId && !['mismatch', 'unknown'].includes(observation.outcome))) { return false; }
		if (observation.id === null) { return observation.url === null; }
		if (!observation.url) { return false; }
		try {
			const url = new URL(observation.url);
			return url.protocol === 'https:' && url.hostname === proposal.remote.host && url.port === '' && !url.username && !url.password && !url.search && !url.hash
				&& url.pathname === `/${proposal.remote.owner}/${proposal.remote.repository}/pull/${observation.id}`;
		} catch { return false; }
	}

	private verifySuccessfulMerge(source: AgentSessionPublicationMergedSource): AgentSessionPublicationPublishedArtifactDTO {
		const merge = this.getMergeProposal(source.mergeProposalId);
		if (!merge || merge.kind !== 'merge' || merge.projectId !== source.projectId || merge.bindingId !== source.bindingId || merge.sessionId !== source.sessionId || merge.turnId !== source.turnId
			|| merge.id !== source.mergeProposalId || merge.revision !== source.mergeRevision || merge.fingerprint !== source.mergeFingerprint || merge.integrationOwnerId !== source.integrationOwnerId) {
			throw this.error('authorityMismatch', 'Source merge proposal does not match the actual persisted merge store.');
		}
		const merged = merge.outcomes.at(-1);
		if (merge.state !== 'merged' || !merged || merged.state !== 'merged' || merged.receipt.operationId !== source.mergeOperationId
			|| !merged.receipt.resultingHead || merged.receipt.resultingHead !== source.resultCommit || merged.receipt.proposalFingerprint !== merge.fingerprint) {
			throw this.error('sourceMergeNotPublished', 'Publication requires the exact successful merge receipt and published merge artifact.');
		}
		const artifact = merge.artifacts.find(record => record.event.phase === 'published' && record.event.resultingHead === source.resultCommit && record.event.currentGenerationId);
		if (!artifact || artifact.event.phase !== 'published' || artifact.event.targetRef !== `refs/heads/bugfixer/integration/${source.integrationOwnerId}`) {
			throw this.error('sourceMergeNotPublished', 'Publication requires the exact successful merge receipt and published merge artifact.');
		}
		return { mergeOperationId: source.mergeOperationId, artifactRevision: artifact.revision, targetRef: artifact.event.targetRef,
			resultingHead: artifact.event.resultingHead, currentGenerationId: artifact.event.currentGenerationId, priorGenerationId: artifact.event.priorGenerationId };
	}

	private normalizeRemote(remote: AgentSessionPublicationRemote, requestedName: string): AgentSessionPublicationRemote {
		this.assertExactKeys(remote, ['name', 'canonicalUrl', 'host', 'repositoryId', 'owner', 'repository', 'visibility', 'writable']);
		if (remote.name !== requestedName || !/^[A-Za-z0-9._-]{1,64}$/u.test(remote.name) || remote.writable !== true || !['public', 'private', 'internal'].includes(remote.visibility)
			|| !remote.repositoryId.trim() || remote.repositoryId.length > 256 || !remote.owner || !remote.repository) { throw this.error('authorityMismatch', 'Resolved GitHub repository identity is invalid.'); }
		let url: URL;
		try { url = new URL(remote.canonicalUrl); } catch { throw this.error('authorityMismatch', 'Canonical GitHub remote URL is invalid.'); }
		const path = url.pathname.replace(/\.git$/u, '').split('/').filter(Boolean);
		if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.hostname.toLowerCase() !== remote.host.toLowerCase()
			|| path.length !== 2 || path[0] !== remote.owner || path[1] !== remote.repository || !/^[A-Za-z0-9.-]+$/u.test(remote.host)) {
			throw this.error('authorityMismatch', 'Canonical GitHub remote URL does not match host, owner, and repository.');
		}
		return { ...remote, host: remote.host.toLowerCase(), canonicalUrl: `https://${remote.host.toLowerCase()}/${remote.owner}/${remote.repository}.git` };
	}

	private normalizeAccount(account: AgentSessionPublicationAccount, accountRef: string, remoteHost: string): AgentSessionPublicationAccount {
		this.assertExactKeys(account, ['accountRef', 'stableId', 'login', 'host']);
		if (account.accountRef !== accountRef || !account.stableId.trim() || account.stableId.length > 256 || !/^[A-Za-z0-9-]{1,39}$/u.test(account.login)
			|| account.host.toLowerCase() !== remoteHost.toLowerCase()) { throw this.error('authorityMismatch', 'Resolved GitHub account identity is invalid.'); }
		return { ...account, host: account.host.toLowerCase() };
	}

	private normalizeDiff(diff: AgentSessionPublicationDiff, baseOid: string, headOid: string): AgentSessionPublicationDiff {
		this.assertExactKeys(diff, ['baseCommit', 'headCommit', 'text', 'fingerprint', 'paths']);
		if (this.normalizeOid(diff.baseCommit, 'diff base commit') !== baseOid || this.normalizeOid(diff.headCommit, 'diff result commit') !== headOid
			|| !Array.isArray(diff.paths) || diff.paths.length > MAX_PATHS || !SHA256_PATTERN.test(diff.fingerprint)) { throw this.error('authorityMismatch', 'Publication diff identity is invalid.'); }
		if (baseOid.length !== headOid.length) { throw this.error('authorityMismatch', 'Publication base and result use different Git object formats.'); }
		if (typeof diff.text !== 'string' || diff.text.includes('\0')) { throw this.error('invalidInput', 'Publication diff must be complete NUL-free UTF-8 text.'); }
		const bytes = Buffer.from(diff.text, 'utf8');
		if (bytes.byteLength > AGENT_SESSION_PUBLICATION_DIFF_MAX_BYTES || bytes.toString('utf8') !== diff.text || digest(bytes) !== diff.fingerprint) { throw this.error('invalidInput', 'Publication diff is truncated, non-canonical, too large, or has the wrong fingerprint.'); }
		const seenPaths = new Set<string>();
		const paths = diff.paths.map(path => {
			this.assertExactKeys(path, ['path', 'status', 'previousPath', 'explanationReferences', 'checkReferences', 'unknowns']);
			const normalizedPath = this.normalizeText(path.path, 4096, 'path', false);
			if (seenPaths.has(normalizedPath)) { throw this.error('invalidInput', 'Publication diff contains a duplicate path.'); }
			seenPaths.add(normalizedPath);
			if (normalizedPath.startsWith('/') || normalizedPath.split('/').includes('..') || !['added', 'modified', 'deleted', 'renamed', 'copied', 'unknown'].includes(path.status)
				|| (path.previousPath !== null && (path.previousPath.startsWith('/') || path.previousPath.split('/').includes('..')))
				|| ![path.explanationReferences, path.checkReferences, path.unknowns].every(values => Array.isArray(values) && values.length <= 100 && values.every(value => typeof value === 'string' && value.length <= 4096))) {
				throw this.error('invalidInput', 'Publication diff path metadata is invalid.');
			}
			return { ...path, path: normalizedPath };
		});
		return { baseCommit: baseOid, headCommit: headOid, text: diff.text, fingerprint: diff.fingerprint, paths };
	}

	private normalizeEvent(event: AgentSessionPublicationEvent): AgentSessionPublicationEvent {
		if (!event || typeof event !== 'object' || !('type' in event)) { throw this.error('invalidInput', 'Publication event is invalid.'); }
		const keys: Record<AgentSessionPublicationEvent['type'], readonly string[]> = {
			branchWriteStarted: ['type', 'expectedOldRemoteOid'], branchObserved: ['type', 'oid', 'outcome', 'errorCode'], branchReobserved: ['type', 'oid', 'outcome', 'errorCode'],
			pullRequestWriteStarted: ['type', 'headOid'], pullRequestObserved: ['type', 'id', 'url', 'repositoryId', 'headRef', 'headOid', 'baseRef', 'baseOid', 'title', 'body', 'draft', 'outcome', 'errorCode'],
			pullRequestReobserved: ['type', 'id', 'url', 'repositoryId', 'headRef', 'headOid', 'baseRef', 'baseOid', 'title', 'body', 'draft', 'outcome', 'errorCode'],
			published: ['type', 'pullRequestId', 'url', 'branchOid', 'headOid', 'baseRef', 'title', 'body', 'draft'],
			recoveryRequired: ['type', 'reason', 'pullRequestId', 'branchOid'], notPublished: ['type', 'reason', 'pullRequestId', 'branchOid'], failed: ['type', 'errorCode', 'pullRequestId', 'branchOid'],
		};
		if (!(event.type in keys)) { throw this.error('invalidInput', 'Publication event type is invalid.'); }
		this.assertExactKeys(event, keys[event.type]);
		const errors = ['none', 'accountChanged', 'remoteChanged', 'baseChanged', 'permissionDenied', 'networkUncertain', 'providerFailed', 'invalidObservation'];
		const validNullableOid = (oid: string | null): boolean => oid === null || (typeof oid === 'string' && OID_PATTERN.test(oid) && oid === oid.toLowerCase());
		if (event.type === 'branchWriteStarted' && event.expectedOldRemoteOid !== null) { throw this.error('invalidInput', 'Publication branch write intent must expect remote absence.'); }
		if ((event.type === 'branchObserved' || event.type === 'branchReobserved') && (!['created', 'absent', 'mismatch', 'unknown'].includes(event.outcome) || !errors.includes(event.errorCode) || !validNullableOid(event.oid))) { throw this.error('invalidInput', 'Publication branch observation is invalid.'); }
		if (event.type === 'pullRequestWriteStarted' && (!OID_PATTERN.test(event.headOid) || event.headOid !== event.headOid.toLowerCase())) { throw this.error('invalidInput', 'Publication pull request write head is invalid.'); }
		if ((event.type === 'pullRequestObserved' || event.type === 'pullRequestReobserved') && (!['created', 'absent', 'mismatch', 'unknown'].includes(event.outcome) || !errors.includes(event.errorCode)
			|| (event.id !== null && !/^[0-9]{1,20}$/u.test(event.id)) || (event.url !== null && !this.isHttpsUrl(event.url))
			|| ![event.repositoryId, event.headRef, event.baseRef, event.title, event.body].every(value => typeof value === 'string' && value.length <= 32768)
			|| !OID_PATTERN.test(event.headOid) || !OID_PATTERN.test(event.baseOid) || typeof event.draft !== 'boolean')) { throw this.error('invalidInput', 'Publication pull request observation is invalid.'); }
		if (event.type === 'published' && ((event.pullRequestId !== null && !/^[0-9]{1,20}$/u.test(event.pullRequestId)) || !this.isHttpsUrl(event.url)
			|| !OID_PATTERN.test(event.branchOid) || !OID_PATTERN.test(event.headOid) || !this.normalizeRef(event.baseRef, 'published base ref')
			|| typeof event.title !== 'string' || typeof event.body !== 'string' || event.draft !== true)) { throw this.error('invalidInput', 'Publication terminal receipt is invalid.'); }
		if (event.type === 'recoveryRequired' && (!['branchMismatch', 'prMismatch', 'baseChanged', 'uncertainWrite'].includes(event.reason)
			|| (event.pullRequestId !== null && !/^[0-9]{1,20}$/u.test(event.pullRequestId)) || !validNullableOid(event.branchOid))) { throw this.error('invalidInput', 'Publication recovery receipt is invalid.'); }
		if (event.type === 'notPublished' && (!['branchAbsent', 'prAbsent'].includes(event.reason)
			|| (event.pullRequestId !== null && !/^[0-9]{1,20}$/u.test(event.pullRequestId)) || !validNullableOid(event.branchOid))) { throw this.error('invalidInput', 'Publication not-published receipt is invalid.'); }
		if (event.type === 'failed' && (!errors.includes(event.errorCode) || (event.pullRequestId !== null && !/^[0-9]{1,20}$/u.test(event.pullRequestId)) || !validNullableOid(event.branchOid))) { throw this.error('invalidInput', 'Publication failure receipt is invalid.'); }
		return JSON.parse(JSON.stringify(event)) as AgentSessionPublicationEvent;
	}

	private proposalFromRow(row: ProposalRow): AgentSessionPublicationProposalDTO {
		const payloadJson = String(row.payload_json);
		if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PROPOSAL_BYTES) { throw this.error('invalidPersistedData', 'Persisted publication proposal exceeds its payload limit.'); }
		let payload: StoredProposalPayload;
		try { payload = JSON.parse(payloadJson) as StoredProposalPayload; } catch { throw this.error('invalidPersistedData', 'Persisted publication proposal JSON is invalid.'); }
		this.assertExactKeys(payload, ['id', 'revision', 'projectId', 'bindingId', 'sessionId', 'turnId', 'sourceMergeId', 'sourceMergeRevision', 'sourceMergeFingerprint', 'sourceMergeOperationId', 'integrationOwnerId', 'resultCommit', 'publishedArtifact', 'remote', 'account', 'baseRef', 'baseOid', 'publicationRef', 'expectedOldRemoteOid', 'diff', 'title', 'body', 'draft', 'fingerprint', 'createdAt', 'expiresAt'], ['textRevision']);
		const unsigned = { ...payload, fingerprint: '' };
		if (payload.id !== String(row.id) || payload.projectId !== String(row.project_id) || payload.sessionId !== String(row.session_id) || payload.turnId !== String(row.turn_id)
			|| payload.sourceMergeId !== String(row.source_merge_id) || payload.revision !== Number(row.revision) || payload.fingerprint !== String(row.proposal_fingerprint)
			|| payload.createdAt !== String(row.created_at) || payload.expiresAt !== String(row.expires_at) || digest(JSON.stringify(unsigned)) !== payload.fingerprint) {
			throw this.error('invalidPersistedData', 'Persisted publication proposal fingerprint or identity is invalid.');
		}
		try {
			this.assertScope(payload.projectId, payload.bindingId, payload.sessionId, payload.turnId);
			if (payload.textRevision !== undefined) { this.normalizeTextSelection(payload.textRevision, payload, payload.title, payload.body); }
			this.assertUuid(payload.sourceMergeId, 'source merge ID'); this.assertUuid(payload.sourceMergeOperationId, 'source merge operation ID'); this.assertUuid(payload.integrationOwnerId, 'integration owner ID');
			if (!Number.isSafeInteger(payload.sourceMergeRevision) || payload.sourceMergeRevision < 1 || !SHA256_PATTERN.test(payload.sourceMergeFingerprint)
				|| payload.publicationRef !== `refs/heads/bugfixer/pr/${payload.id}` || payload.expectedOldRemoteOid !== null || payload.draft !== true) { throw this.error('invalidPersistedData', 'Persisted publication proposal authority is invalid.'); }
			this.assertExactKeys(payload.publishedArtifact, ['mergeOperationId', 'artifactRevision', 'targetRef', 'resultingHead', 'currentGenerationId', 'priorGenerationId']);
			this.assertUuid(payload.publishedArtifact.mergeOperationId, 'published artifact operation ID');
			this.assertUuid(payload.publishedArtifact.currentGenerationId, 'published artifact generation ID');
			if (payload.publishedArtifact.mergeOperationId !== payload.sourceMergeOperationId || payload.publishedArtifact.artifactRevision < 1
				|| payload.publishedArtifact.targetRef !== `refs/heads/bugfixer/integration/${payload.integrationOwnerId}`
				|| payload.publishedArtifact.resultingHead !== payload.resultCommit
				|| (payload.publishedArtifact.priorGenerationId !== null && !UUID_PATTERN.test(payload.publishedArtifact.priorGenerationId))) { throw this.error('invalidPersistedData', 'Persisted local published artifact identity is invalid.'); }
			this.normalizeOid(payload.resultCommit, 'persisted result commit'); this.normalizeOid(payload.baseOid, 'persisted base commit');
			this.normalizeRef(payload.baseRef, 'persisted base ref');
			if (JSON.stringify(this.normalizeRemote(payload.remote, payload.remote.name)) !== JSON.stringify(payload.remote)
				|| JSON.stringify(this.normalizeAccount(payload.account, payload.account.accountRef, payload.remote.host)) !== JSON.stringify(payload.account)
				|| JSON.stringify(this.normalizeDiff(payload.diff, payload.baseOid, payload.resultCommit)) !== JSON.stringify(payload.diff)
				|| this.normalizeText(payload.title, MAX_TITLE_BYTES, 'title', false) !== payload.title
				|| this.normalizeText(payload.body, MAX_BODY_BYTES, 'body', true) !== payload.body) { throw this.error('invalidPersistedData', 'Persisted publication proposal content is not canonical.'); }
		} catch { throw this.error('invalidPersistedData', 'Persisted publication proposal authority or content is invalid.'); }
		const approval = this.approvalRow(String(row.id));
		return { ...payload, approval: approval ? this.approvalFromRow(approval, payload.fingerprint) : null };
	}

	private approvalFromRow(row: Readonly<Record<string, SQLOutputValue>>, expectedFingerprint: string): AgentSessionPublicationApprovalDTO {
		if (String(row.actor) !== 'human' || String(row.proposal_fingerprint) !== expectedFingerprint) { throw this.error('invalidPersistedData', 'Persisted publication approval does not match its immutable proposal.'); }
		return { actor: 'human', proposalFingerprint: String(row.proposal_fingerprint), approvedAt: String(row.approved_at) };
	}

	private operationFromRow(row: OperationRow): AgentSessionPublicationOperationDTO {
		const proposal = this.requireProposal(String(row.proposal_id));
		const approval = this.approvalRow(proposal.id);
		if (!approval) { throw this.error('invalidPersistedData', 'Persisted publication operation has no trusted human approval.'); }
		this.approvalFromRow(approval, proposal.fingerprint);
		if (String(row.proposal_fingerprint) !== proposal.fingerprint || String(row.account_stable_id) !== proposal.account.stableId || String(row.repository_id) !== proposal.remote.repositoryId
			|| String(row.publication_ref) !== proposal.publicationRef || row.expected_old_remote_oid !== null || String(row.head_oid) !== proposal.resultCommit) {
			throw this.error('invalidPersistedData', 'Persisted publication operation authority does not match its immutable proposal.');
		}
		const eventRows = this.db.prepare('SELECT revision, event_type, event_json, recorded_at FROM agent_session_publication_events WHERE operation_id = ? ORDER BY revision')
			.all(String(row.id)) as EventRow[];
		const events = eventRows.map((event, index) => {
			if (Number(event.revision) !== index + 1 || Buffer.byteLength(String(event.event_json), 'utf8') > MAX_RECEIPT_BYTES) { throw this.error('invalidPersistedData', 'Persisted publication event sequence is invalid.'); }
			const decoded = JSON.parse(String(event.event_json)) as AgentSessionPublicationEvent;
			const normalized = this.normalizeEvent(decoded);
			if (normalized.type !== String(event.event_type)) { throw this.error('invalidPersistedData', 'Persisted publication event type does not match its payload.'); }
			return { revision: index + 1, event: normalized, recordedAt: String(event.recorded_at) };
		});
		if (events.length !== Number(row.revision)) { throw this.error('invalidPersistedData', 'Publication operation revision does not match its event chain.'); }
		let state: AgentSessionPublicationOperationDTO['state'] = 'started';
		for (let index = 0; index < events.length; index++) {
			const event = events[index].event;
			this.validateNextEvent(proposal, events.slice(0, index).map(item => item.event), event);
			if (event.type === 'recoveryRequired') { state = 'recoveryRequired'; }
			else if (event.type === 'published' || event.type === 'notPublished' || event.type === 'failed') { state = event.type; }
		}
		if (String(row.state) !== state) { throw this.error('invalidPersistedData', 'Persisted publication state does not match its validated event chain.'); }
		return {
			id: String(row.id), proposalId: proposal.id, proposalFingerprint: proposal.fingerprint, accountStableId: proposal.account.stableId,
			repositoryId: proposal.remote.repositoryId, publicationRef: proposal.publicationRef, expectedOldRemoteOid: null, headOid: proposal.resultCommit,
			state, revision: Number(row.revision), events, startedAt: String(row.started_at),
		};
	}

	private requireProposal(proposalId: string): AgentSessionPublicationProposalDTO {
		const proposal = this.getProposal(proposalId);
		if (!proposal) { throw this.error('invalidInput', 'Publication proposal was not found.'); }
		return proposal;
	}

	private requireProposalRow(proposalId: string): ProposalRow {
		const row = this.db.prepare('SELECT * FROM agent_session_publication_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
		if (!row) { throw this.error('invalidInput', 'Publication proposal was not found.'); }
		return row;
	}

	private latestProposal(projectId: string, sessionId: string, turnId: string): ProposalRow | undefined {
		return this.db.prepare('SELECT * FROM agent_session_publication_proposals WHERE project_id = ? AND session_id = ? AND turn_id = ? ORDER BY revision DESC LIMIT 1')
			.get(projectId, sessionId, turnId) as ProposalRow | undefined;
	}

	private approvalRow(proposalId: string): Readonly<Record<string, SQLOutputValue>> | undefined {
		return this.db.prepare('SELECT proposal_fingerprint, actor, approved_at FROM agent_session_publication_approvals WHERE proposal_id = ?').get(proposalId) as Readonly<Record<string, SQLOutputValue>> | undefined;
	}

	private operationRow(proposalId: string): OperationRow | undefined {
		return this.db.prepare('SELECT * FROM agent_session_publication_operations WHERE proposal_id = ?').get(proposalId) as OperationRow | undefined;
	}

	private requireOperationRow(operationId: string): OperationRow {
		const row = this.db.prepare('SELECT * FROM agent_session_publication_operations WHERE id = ?').get(operationId) as OperationRow | undefined;
		if (!row) { throw this.error('invalidInput', 'Publication operation was not found.'); }
		return row;
	}

	private pruneUnstartedHistory(projectId: string, sessionId: string, turnId: string): void {
		const rows = this.db.prepare('SELECT id FROM agent_session_publication_proposals WHERE project_id = ? AND session_id = ? AND turn_id = ? ORDER BY revision DESC')
			.all(projectId, sessionId, turnId) as Array<{ id: SQLOutputValue }>;
		for (const row of rows.slice(AGENT_SESSION_PUBLICATION_HISTORY_LIMIT - 1)) {
			this.db.prepare(`DELETE FROM agent_session_publication_proposals WHERE id = ? AND NOT EXISTS (SELECT 1 FROM agent_session_publication_approvals WHERE proposal_id = ?)
				AND NOT EXISTS (SELECT 1 FROM agent_session_publication_operations WHERE proposal_id = ?)`)
				.run(row.id, row.id, row.id);
		}
	}

	private normalizeRef(value: string, label: string): string {
		if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('refs/heads/') || value.endsWith('/') || value.endsWith('.') || value.includes('..')
			|| value.includes('//') || value.includes('@{') || value.includes('\\') || /[\x00-\x20\x7f ~^:?*\[\]]/u.test(value)
			|| value.slice('refs/heads/'.length).split('/').some(component => component.startsWith('.') || component.toLowerCase().endsWith('.lock'))) {
			throw this.error('invalidInput', `${label} is invalid.`);
		}
		return value;
	}

	private normalizeOid(value: string, label: string): string {
		if (typeof value !== 'string' || !OID_PATTERN.test(value) || value !== value.toLowerCase()) { throw this.error('invalidInput', `${label} must be a lowercase full Git object ID.`); }
		return value;
	}

	private normalizeText(value: string, maximumBytes: number, label: string, allowEmpty: boolean): string {
		if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximumBytes || Buffer.from(value, 'utf8').toString('utf8') !== value) {
			throw this.error('invalidInput', `Publication ${label} is invalid or exceeds its byte limit.`);
		}
		return value.replace(/\r\n?/gu, '\n');
	}

	private isHttpsUrl(value: string): boolean {
		try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
	}

	private assertScope(...values: string[]): void {
		for (const value of values) { this.assertUuid(value, 'publication scope ID'); }
	}

	private assertUuid(value: string, label: string): void {
		if (typeof value !== 'string' || !UUID_PATTERN.test(value)) { throw this.error('invalidInput', `${label} is invalid.`); }
	}

	private normalizeTextSelection(value: NonNullable<AgentSessionPublicationPrepareInput['textRevision']>, scope: { readonly projectId: string; readonly sessionId: string; readonly turnId: string }, title: string, body: string) {
		this.assertExactKeys(value, ['scope', 'revision', 'contentHash']);
		this.assertExactKeys(value.scope, ['projectId', 'sessionId', 'targetTurnId']);
		if (value.scope.projectId !== scope.projectId || value.scope.sessionId !== scope.sessionId || value.scope.targetTurnId !== scope.turnId
			|| !Number.isSafeInteger(value.revision) || value.revision < 1 || value.contentHash !== digest(JSON.stringify([title, body]))) {
			throw this.error('authorityMismatch', 'The exact PR text revision does not match its frozen title and body.');
		}
		return { scope: { projectId: scope.projectId, sessionId: scope.sessionId, targetTurnId: scope.turnId }, revision: value.revision, contentHash: value.contentHash };
	}

	private assertExactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw this.error('invalidInput', 'Publication input object is invalid.'); }
		const keys = Object.keys(value);
		if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) { throw this.error('invalidInput', 'Publication input contains missing or unexpected fields.'); }
	}

	private error(code: string, message: string): Error & { readonly code: string } {
		const error = new Error(message) as Error & { code: string };
		error.name = 'AgentSessionPublicationError'; error.code = code;
		return error;
	}

	private transaction<T>(callback: () => T): T {
		return runAgentSessionTransaction(this.db, callback);
	}
}

function digest(input: string | Uint8Array): string {
	return createHash('sha256').update(input).digest('hex');
}
