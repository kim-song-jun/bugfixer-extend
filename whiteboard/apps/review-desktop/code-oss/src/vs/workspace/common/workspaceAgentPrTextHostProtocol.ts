/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	AgentPrTextRequestDTO, AgentPrTextRequestPageDTO, AgentPrTextRevisionDTO, AgentPrTextRevisionPageDTO, AgentPrTextScope,
} from './workspaceAgentPrTextProtocol.js';

export interface WorkspaceAgentPrTextDraftDTO {
	readonly head: AgentPrTextRevisionDTO | null;
	readonly revisions: AgentPrTextRevisionPageDTO;
	readonly requests: AgentPrTextRequestPageDTO;
}

export interface WorkspaceAgentPrTextPageInput {
	readonly scope: AgentPrTextScope;
	readonly after: number;
	readonly limit: number;
}

export interface WorkspaceAgentPrTextSaveInput {
	readonly scope: AgentPrTextScope;
	readonly expectedRevision: number;
	readonly idempotencyKey: string;
	readonly title: string;
	readonly body: string;
}

export interface WorkspaceAgentPrTextPreviewInput {
	readonly scope: AgentPrTextScope;
	readonly baseRevision: number;
	readonly idempotencyKey: string;
	readonly instruction: string;
}

export interface WorkspaceAgentPrTextPreviewDTO {
	readonly request: AgentPrTextRequestDTO;
	readonly digest: string;
	readonly sourceSummary: readonly string[];
}

export interface WorkspaceAgentPrTextRequestInput {
	readonly scope: AgentPrTextScope;
	readonly requestId: string;
}

export interface WorkspaceAgentPrTextStartInput extends WorkspaceAgentPrTextRequestInput {
	readonly expectedStateRevision: number;
	readonly expectedDigest: string;
}

export interface WorkspaceAgentPrTextCancelInput extends WorkspaceAgentPrTextRequestInput {
	readonly expectedStateRevision: number;
}

export interface WorkspaceAgentPrTextApplyInput extends WorkspaceAgentPrTextRequestInput {
	readonly expectedStateRevision: number;
	readonly expectedHeadRevision: number;
	readonly idempotencyKey: string;
}

/** Exact stored text selected by a person; this tuple conveys no publication approval. */
export interface WorkspaceAgentPrTextSelection {
	readonly scope: AgentPrTextScope;
	readonly revision: number;
	readonly contentHash: string;
}

export interface IWorkspaceAgentPrTextService {
	getPrTextDraft(scope: AgentPrTextScope): Promise<WorkspaceAgentPrTextDraftDTO>;
	listPrTextRevisions(input: WorkspaceAgentPrTextPageInput): Promise<AgentPrTextRevisionPageDTO>;
	listPrTextRequests(input: WorkspaceAgentPrTextPageInput): Promise<AgentPrTextRequestPageDTO>;
	savePrTextRevision(input: WorkspaceAgentPrTextSaveInput): Promise<AgentPrTextRevisionDTO>;
	previewPrTextRequest(input: WorkspaceAgentPrTextPreviewInput): Promise<WorkspaceAgentPrTextPreviewDTO>;
	startPrTextRequest(input: WorkspaceAgentPrTextStartInput): Promise<AgentPrTextRequestDTO>;
	getPrTextRequest(input: WorkspaceAgentPrTextRequestInput): Promise<AgentPrTextRequestDTO>;
	cancelPrTextRequest(input: WorkspaceAgentPrTextCancelInput): Promise<AgentPrTextRequestDTO>;
	applyPrTextCandidate(input: WorkspaceAgentPrTextApplyInput): Promise<AgentPrTextRevisionDTO>;
}
