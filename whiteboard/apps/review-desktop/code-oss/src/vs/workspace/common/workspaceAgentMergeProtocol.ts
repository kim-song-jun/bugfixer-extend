/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSessionIntegrationGitIdentity } from './workspaceAgentIntegrationProtocol.js';

/** Bounded database window used by the review UI for immutable merge proposal history. */
export const AGENT_SESSION_MERGE_PROPOSAL_PAGE_LIMIT = 5;

/** Browser-safe DTOs for a separately reviewed local merge into an app-owned integration branch. */
export interface AgentSessionMergeExplanationReferenceDTO {
	readonly id: string;
	readonly path: string;
	readonly hunkId: string | null;
	readonly revision: number;
	readonly actor: 'agent' | 'human';
	readonly status: 'draft' | 'confirmed';
}

export interface AgentSessionMergePathDTO {
	readonly path: string;
	readonly explanationState: 'linked' | 'unknown';
	readonly explanations: readonly AgentSessionMergeExplanationReferenceDTO[];
}

/** Host-captured staged resolution of one exact retained conflict generation. */
export interface AgentSessionMergeResolutionDTO {
	readonly proposalId: string;
	readonly operationId: string;
	readonly generationId: string;
	readonly registrationId: string;
	readonly treeOid: string;
	readonly indexDigest: string;
	readonly indexFileDigest: string;
	readonly treeDigest: string;
}

export interface AgentSessionMergeProposalDTO {
	readonly resolution?: AgentSessionMergeResolutionDTO;
	/** Host-verified registered generation directory; never accepted as request authority. */
	readonly generationDirectory?: string;
	readonly generationDirectoryError?: string;
	readonly kind: 'merge';
	readonly id: string;
	readonly projectId: string;
	readonly bindingId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly revision: number;
	readonly commitProposalId: string;
	readonly commitProposalRevision: number;
	readonly commitProposalFingerprint: string;
	readonly sessionOwnerId: string;
	readonly integrationOwnerId: string;
	readonly sourceHead: string;
	readonly targetHead: string;
	readonly mergeBase: string;
	readonly diffFingerprint: string;
	readonly diffText: string;
	readonly commitMessage: string;
	readonly author: AgentSessionIntegrationGitIdentity;
	readonly committer: AgentSessionIntegrationGitIdentity;
	readonly paths: readonly AgentSessionMergePathDTO[];
	readonly fingerprint: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly approval: AgentSessionMergeApprovalDTO | null;
	readonly state: AgentSessionMergeState;
	readonly outcomes: readonly AgentSessionMergeOutcomeDTO[];
	readonly artifacts: readonly AgentSessionMergeArtifactRecord[];
}

export interface AgentSessionMergeApprovalDTO {
	readonly id: string;
	readonly proposalId: string;
	readonly proposalFingerprint: string;
	readonly actor: 'human';
	readonly approvedAt: string;
}

export type AgentSessionMergeState = 'pending' | 'applying' | 'merged' | 'conflict' | 'notApplied' | 'recoveryRequired' | 'failed';
export type AgentSessionMergeOutcomeState = Exclude<AgentSessionMergeState, 'pending'>;

/** Exact durable identity passed to ManagedWorktreeService before it mutates Git. */
export interface AgentSessionMergeApplyingBinding {
	readonly operationId: string;
	readonly proposalId: string;
	readonly proposalFingerprint: string;
	readonly integrationOwnerId: string;
	readonly sessionOwnerId: string;
	readonly sourceHead: string;
	readonly targetHead: string;
	readonly mergeBase: string;
	readonly diffFingerprint: string;
	readonly commitMessage: string;
	readonly author: AgentSessionIntegrationGitIdentity;
	readonly committer: AgentSessionIntegrationGitIdentity;
}

export interface AgentSessionMergePriorGeneration {
	readonly generationId: string;
	readonly generationPath: string;
	readonly registrationId: string;
	readonly head: string;
	readonly indexDigest: string;
	readonly treeDigest: string;
}

export interface AgentSessionMergeConflictStage {
	readonly stage: 1 | 2 | 3;
	readonly mode: '100644' | '100755' | '120000' | '160000';
	readonly oid: string;
}

export interface AgentSessionMergeConflictArtifact {
	readonly path: string;
	readonly message: string;
	readonly stages: readonly AgentSessionMergeConflictStage[];
}

/** Append-only, host-produced merge artifacts. No file contents or private index bytes are exposed. */
export type AgentSessionMergeArtifactEvent =
	| { readonly phase: 'intent'; readonly generationId: string; readonly generationPath: string; readonly registrationId: string; readonly priorGeneration: AgentSessionMergePriorGeneration | null }
	| { readonly phase: 'candidatePrepared'; readonly candidateTreeOid: string; readonly candidateCommitOid: string | null; readonly outcome: 'clean' | 'conflict'; readonly conflicts: readonly AgentSessionMergeConflictArtifact[] }
	| { readonly phase: 'generationRegistered'; readonly generationPath: string; readonly registrationId: string }
	| { readonly phase: 'generationMaterialized'; readonly head: string; readonly indexDigest: string; readonly treeDigest: string; readonly conflictDigest: string | null }
	| { readonly phase: 'published'; readonly targetRef: string; readonly resultingHead: string; readonly currentGenerationId: string; readonly priorGenerationId: string | null };

export interface AgentSessionMergeArtifactRecord {
	readonly revision: number;
	readonly event: AgentSessionMergeArtifactEvent;
}

export interface AgentSessionMergeReceipt extends AgentSessionMergeApplyingBinding {
	readonly resultingHead: string | null;
	readonly changedPaths: readonly string[];
	readonly conflictedPaths: readonly string[];
	readonly failureCode: string | null;
}

export interface AgentSessionMergeOutcomeDTO {
	readonly id: string;
	readonly proposalId: string;
	readonly revision: number;
	readonly state: AgentSessionMergeOutcomeState;
	readonly receipt: AgentSessionMergeReceipt;
	readonly retryOfOutcomeId: string | null;
	readonly recordedAt: string;
}

export interface WorkspaceAgentMergeProposalMutationInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly proposalId: string;
	readonly expectedRevision: number;
	readonly expectedFingerprint: string;
}

export interface WorkspaceAgentMergeProposalRecoveryInput extends WorkspaceAgentMergeProposalMutationInput {
	readonly operationId?: string;
}

export interface WorkspaceAgentMergeProposalPageInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly afterRevision?: number;
	readonly limit?: number;
}

export interface WorkspaceAgentMergeProposalPageDTO {
	readonly proposals: readonly AgentSessionMergeProposalDTO[];
	readonly nextRevision: number;
	readonly hasMore: boolean;
}

/** Project-window request to prepare a merge proposal from one exact successful commit proposal. */
export interface WorkspaceAgentMergePrepareInput {
	readonly resolutionOfProposalId?: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly commitProposalId: string;
	readonly expectedLatestRevision: number;
}
