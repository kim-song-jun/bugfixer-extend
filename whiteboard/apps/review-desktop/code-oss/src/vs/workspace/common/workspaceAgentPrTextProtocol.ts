/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const AGENT_PR_TEXT_MAX_TITLE_BYTES = 256;
export const AGENT_PR_TEXT_MAX_BODY_BYTES = 32_768;
export const AGENT_PR_TEXT_MAX_INSTRUCTION_BYTES = 8_192;

export type AgentPrTextProvider = 'codex' | 'claude';
export type AgentPrTextAuthor = 'liveAgentTurn' | 'providerAttempt' | 'human';
export type AgentPrTextRequestState = 'preview' | 'running' | 'succeeded' | 'conflicted' | 'failed' | 'cancelled' | 'interrupted';
export type AgentPrTextErrorCode = 'providerFailed' | 'runnerUnavailable' | 'invalidCandidate';

export interface AgentPrTextScope {
	readonly projectId: string;
	readonly sessionId: string;
	readonly targetTurnId: string;
}

export interface AgentPrTextContent {
	readonly title: string;
	readonly body: string;
	readonly contentHash: string;
}

export type AgentPrTextSource =
	| { readonly kind: 'liveAgentTurn'; readonly turnId: string }
	| {
		readonly kind: 'providerAttempt';
		readonly requestId: string;
		readonly attemptId: string;
		readonly provider: AgentPrTextProvider;
		readonly model: string;
		readonly profileRef: string | null;
		/** Host-runner hash binding request, attempt, output digest, and verified cleanup receipt. */
		readonly receiptHash: string;
		readonly cleanupVerified: true;
	};

export interface AgentPrTextRevisionDTO {
	readonly id: string;
	readonly scope: AgentPrTextScope;
	readonly revision: number;
	readonly author: AgentPrTextAuthor;
	readonly source: AgentPrTextSource | null;
	readonly content: AgentPrTextContent;
	readonly createdAt: string;
}

export interface AgentPrTextRevisionPageDTO {
	readonly revisions: readonly AgentPrTextRevisionDTO[];
	readonly nextRevision: number;
	readonly hasMore: boolean;
}

export interface AgentPrTextCandidateDTO {
	readonly source: AgentPrTextSource;
	readonly content: AgentPrTextContent;
	readonly receivedAt: string;
}

export interface AgentPrTextRequestDTO {
	readonly id: string;
	readonly scope: AgentPrTextScope;
	readonly baseRevision: number;
	readonly headRevision: number;
	readonly state: AgentPrTextRequestState;
	readonly stateRevision: number;
	readonly provider: AgentPrTextProvider;
	readonly model: string;
	readonly profileRef: string | null;
	readonly contextDigest: string;
	readonly instruction: string;
	readonly candidate?: AgentPrTextCandidateDTO;
	readonly errorCode?: AgentPrTextErrorCode;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface AgentPrTextRequestPageDTO {
	readonly requests: readonly AgentPrTextRequestDTO[];
	readonly nextSequence: number;
	readonly hasMore: boolean;
}

export interface CreateAgentPrTextRequestInput {
	readonly scope: AgentPrTextScope;
	readonly idempotencyKey: string;
	readonly baseRevision: number;
	readonly provider: AgentPrTextProvider;
	readonly model: string;
	readonly profileRef: string | null;
	readonly contextDigest: string;
	readonly contextJSON: string;
	readonly instruction: string;
}

export interface AgentPrTextDraftInput {
	readonly title: string;
	readonly body: string;
}
