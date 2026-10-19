/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Browser-safe publication review contracts. Authentication material is deliberately absent. */
export const AGENT_SESSION_PUBLICATION_HISTORY_LIMIT = 5;
export const AGENT_SESSION_PUBLICATION_OPERATION_EVENT_LIMIT = 32;
export const AGENT_SESSION_PUBLICATION_DIFF_MAX_BYTES = 4 * 1024 * 1024;

export interface AgentSessionPublicationPrepareInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly sourceMergeId: string;
	readonly remoteName: string;
	readonly baseRef: string;
	readonly accountRef: string;
	readonly title: string;
	readonly body: string;
	readonly expectedRevision: number;
}

export interface AgentSessionPublicationMergedSource {
	readonly projectId: string;
	readonly bindingId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly mergeProposalId: string;
	readonly mergeRevision: number;
	readonly mergeFingerprint: string;
	readonly mergeOperationId: string;
	readonly integrationOwnerId: string;
	readonly resultCommit: string;
}

/** Local immutable MergeStore receipt, not an externally hosted URL. */
export interface AgentSessionPublicationPublishedArtifactDTO {
	readonly mergeOperationId: string;
	readonly artifactRevision: number;
	readonly targetRef: string;
	readonly resultingHead: string;
	readonly currentGenerationId: string;
	readonly priorGenerationId: string | null;
}

export interface AgentSessionPublicationRemote {
	readonly name: string;
	readonly canonicalUrl: string;
	readonly host: string;
	readonly repositoryId: string;
	readonly owner: string;
	readonly repository: string;
	readonly visibility: 'public' | 'private' | 'internal';
	readonly writable: true;
}

export interface AgentSessionPublicationAccount {
	readonly accountRef: string;
	readonly stableId: string;
	readonly login: string;
	readonly host: string;
}

export interface AgentSessionPublicationBase {
	readonly ref: string;
	readonly oid: string;
}

export interface AgentSessionPublicationDiffPath {
	readonly path: string;
	readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unknown';
	readonly previousPath: string | null;
	readonly explanationReferences: readonly string[];
	readonly checkReferences: readonly string[];
	readonly unknowns: readonly string[];
}

export interface AgentSessionPublicationDiff {
	readonly baseCommit: string;
	readonly headCommit: string;
	readonly text: string;
	readonly fingerprint: string;
	readonly paths: readonly AgentSessionPublicationDiffPath[];
}

/** Full immutable proposal; its publication branch is allocated by the host. */
export interface AgentSessionPublicationProposalDTO {
	readonly id: string;
	readonly revision: number;
	readonly projectId: string;
	readonly bindingId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly sourceMergeId: string;
	readonly sourceMergeRevision: number;
	readonly sourceMergeFingerprint: string;
	readonly sourceMergeOperationId: string;
	readonly integrationOwnerId: string;
	readonly resultCommit: string;
	readonly publishedArtifact: AgentSessionPublicationPublishedArtifactDTO;
	readonly remote: AgentSessionPublicationRemote;
	readonly account: AgentSessionPublicationAccount;
	readonly baseRef: string;
	readonly baseOid: string;
	readonly publicationRef: string;
	readonly expectedOldRemoteOid: null;
	readonly diff: AgentSessionPublicationDiff;
	readonly title: string;
	readonly body: string;
	readonly draft: true;
	readonly fingerprint: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly approval: AgentSessionPublicationApprovalDTO | null;
}

export interface AgentSessionPublicationApprovalDTO {
	readonly actor: 'human';
	readonly approvedAt: string;
	readonly proposalFingerprint: string;
}

/** Strict append-only observation events; payloads can carry partial external write receipts. */
export type AgentSessionPublicationEvent =
	| { readonly type: 'branchWriteStarted'; readonly expectedOldRemoteOid: null }
	| { readonly type: 'branchObserved'; readonly oid: string | null; readonly outcome: 'created' | 'absent' | 'mismatch' | 'unknown'; readonly errorCode: AgentSessionPublicationProviderErrorCode }
	| { readonly type: 'branchReobserved'; readonly oid: string | null; readonly outcome: 'created' | 'absent' | 'mismatch' | 'unknown'; readonly errorCode: AgentSessionPublicationProviderErrorCode }
	| { readonly type: 'pullRequestWriteStarted'; readonly headOid: string }
	| { readonly type: 'pullRequestObserved'; readonly id: string | null; readonly url: string | null; readonly repositoryId: string; readonly headRef: string; readonly headOid: string; readonly baseRef: string; readonly baseOid: string; readonly title: string; readonly body: string; readonly draft: boolean; readonly outcome: 'created' | 'absent' | 'mismatch' | 'unknown'; readonly errorCode: AgentSessionPublicationProviderErrorCode }
	| { readonly type: 'pullRequestReobserved'; readonly id: string | null; readonly url: string | null; readonly repositoryId: string; readonly headRef: string; readonly headOid: string; readonly baseRef: string; readonly baseOid: string; readonly title: string; readonly body: string; readonly draft: boolean; readonly outcome: 'created' | 'absent' | 'mismatch' | 'unknown'; readonly errorCode: AgentSessionPublicationProviderErrorCode }
	| { readonly type: 'published'; readonly pullRequestId: string; readonly url: string; readonly branchOid: string; readonly headOid: string; readonly baseRef: string; readonly title: string; readonly body: string; readonly draft: true }
	| { readonly type: 'recoveryRequired'; readonly reason: 'branchMismatch' | 'prMismatch' | 'baseChanged' | 'uncertainWrite'; readonly pullRequestId: string | null; readonly branchOid: string | null }
	| { readonly type: 'notPublished'; readonly reason: 'branchAbsent' | 'prAbsent'; readonly pullRequestId: string | null; readonly branchOid: string | null }
	| { readonly type: 'failed'; readonly errorCode: AgentSessionPublicationProviderErrorCode; readonly pullRequestId: string | null; readonly branchOid: string | null };

export type AgentSessionPublicationProviderErrorCode = 'none' | 'accountChanged' | 'remoteChanged' | 'baseChanged' | 'permissionDenied' | 'networkUncertain' | 'providerFailed' | 'invalidObservation';

export interface AgentSessionPublicationEventRecord {
	readonly revision: number;
	readonly event: AgentSessionPublicationEvent;
	readonly recordedAt: string;
}

export interface AgentSessionPublicationOperationDTO {
	readonly id: string;
	readonly proposalId: string;
	readonly proposalFingerprint: string;
	readonly accountStableId: string;
	readonly repositoryId: string;
	readonly publicationRef: string;
	readonly expectedOldRemoteOid: null;
	readonly headOid: string;
	readonly state: 'started' | 'published' | 'recoveryRequired' | 'notPublished' | 'failed';
	readonly revision: number;
	readonly events: readonly AgentSessionPublicationEventRecord[];
	readonly startedAt: string;
}

export interface AgentSessionPublicationPageDTO {
	readonly proposals: readonly AgentSessionPublicationProposalDTO[];
	readonly nextRevision: number;
	readonly hasMore: boolean;
}

export type AgentSessionPublicationErrorCode =
	| 'invalidInput' | 'sourceMergeNotPublished' | 'authorityMismatch' | 'staleRevision' | 'expired'
	| 'notApproved' | 'operationExists' | 'invalidStep' | 'staleOperation' | 'invalidPersistedData';

export interface AgentSessionPublicationErrorReceipt {
	readonly code: AgentSessionPublicationErrorCode;
	readonly message: string;
}
