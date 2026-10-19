/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Browser-safe contract for human-reviewed integration proposals. Contains metadata only. */
export interface AgentSessionIntegrationPathInput {
	readonly path: string;
	readonly explanationTargets: readonly { readonly path: string; readonly hunkId: string | null; readonly revision: number }[];
}

export interface AgentSessionIntegrationPathDTO {
	readonly path: string;
	readonly previousPath: string | null;
	readonly beforeMetadataSha256: string | null;
	readonly afterMetadataSha256: string | null;
	readonly explanations: readonly {
		readonly id: string;
		readonly path: string;
		readonly hunkId: string | null;
		readonly revision: number;
		readonly actor: 'agent' | 'human';
		readonly status: 'draft' | 'confirmed';
	}[];
}

export interface AgentSessionIntegrationProposalDTO {
	readonly kind: 'commit';
	readonly id: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly revision: number;
	readonly evidenceVersion: number;
	readonly evidenceFingerprint: string;
	readonly turnSnapshotSha256: string;
	readonly sessionWorktreeOwnerId: string;
	readonly sourceHead: string;
	readonly proposedGitTreeHash: string;
	readonly diffFingerprint: string;
	readonly commitMessage: string;
	readonly author: AgentSessionIntegrationGitIdentity;
	readonly committer: AgentSessionIntegrationGitIdentity;
	readonly paths: readonly AgentSessionIntegrationPathDTO[];
	readonly fingerprint: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly approval: AgentSessionIntegrationApprovalDTO | null;
	readonly state: AgentSessionIntegrationState;
	readonly outcomes: readonly AgentSessionIntegrationOutcomeDTO[];
}

export interface AgentSessionIntegrationGitIdentity {
	readonly name: string;
	readonly email: string;
	readonly date: string;
}

export interface AgentSessionIntegrationApprovalDTO {
	readonly id: string;
	readonly proposalId: string;
	readonly proposalFingerprint: string;
	readonly actor: 'human';
	readonly approvedAt: string;
}

export type AgentSessionIntegrationState = 'pending' | 'applying' | 'succeeded' | 'failed' | 'recoveryRequired';
export type AgentSessionIntegrationAction = 'commit';
export type AgentSessionIntegrationOutcomeState = Exclude<AgentSessionIntegrationState, 'pending'>;

export interface AgentSessionIntegrationActionReceipt {
	readonly operationId: string;
	readonly sourceHead: string;
	readonly proposedGitTreeHash: string;
	readonly diffFingerprint: string;
	readonly candidateHead: string;
	readonly resultingHead: string | null;
	readonly changedPaths: readonly string[];
	readonly failureCode: string | null;
}

export interface AgentSessionIntegrationOutcomeDTO {
	readonly id: string;
	readonly proposalId: string;
	readonly revision: number;
	readonly state: AgentSessionIntegrationOutcomeState;
	readonly action: AgentSessionIntegrationAction;
	readonly receipt: AgentSessionIntegrationActionReceipt;
	readonly retryOfOutcomeId: string | null;
	readonly recordedAt: string;
}

export interface WorkspaceAgentCommitPrepareInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly evidenceVersion: number;
	readonly evidenceFingerprint: string;
	readonly paths: readonly AgentSessionIntegrationPathInput[];
	readonly commitMessage: string;
	readonly expectedLatestRevision: number;
}

export interface WorkspaceAgentCommitProposalInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly proposalId: string;
	readonly expectedRevision: number;
	readonly expectedFingerprint: string;
}

export interface WorkspaceAgentCommitRecoveryInput extends WorkspaceAgentCommitProposalInput {
	readonly operationId?: string;
}

export interface WorkspaceAgentCommitProposalPageInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly afterRevision?: number;
	readonly limit?: number;
}
