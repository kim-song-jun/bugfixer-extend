/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderId, ProviderAttemptDTO } from './workspaceProviderRunProtocol.js';

export const WORKSPACE_CONVENTION_AGENT_CHANNEL = 'vscode:workspaceConventionAgent';

export interface ConventionAgentScope {
	readonly projectId: string;
	readonly taskId: string;
	readonly providerId: ProviderId;
}

export interface ConventionDraftRequest extends ConventionAgentScope {
	readonly sourceSnapshotIds: readonly string[];
}

export interface ConventionDraftStartRequest extends ConventionDraftRequest {
	readonly digest: string;
}

export interface ConventionCheckRequest extends ConventionAgentScope {
	readonly versionId: string;
}

export interface ConventionCheckStartRequest extends ConventionCheckRequest {
	readonly digest: string;
}

export interface ConventionAgentReferenceDTO {
	readonly id: string;
	readonly version: number;
	readonly title: string;
	readonly contentType: string;
	readonly contentSha256: string;
	readonly content: string;
}

export interface ConventionAgentPreviewDTO {
	readonly operation: 'draft' | 'check';
	readonly providerId: ProviderId;
	readonly accountLabel: string;
	readonly task: { readonly id: string; readonly revision: number; readonly title: string };
	readonly references: readonly ConventionAgentReferenceDTO[];
	readonly convention: { readonly id: string; readonly version: number; readonly markdown: string; readonly contentSha256: string } | null;
	readonly prompt: string;
	readonly digest: string;
	readonly allowed: boolean;
	readonly blockedReason: string | null;
	readonly permissionSummary: string;
}

export interface ConventionAgentResultDTO {
	readonly attempt: ProviderAttemptDTO;
	readonly versionId?: string;
	readonly versionNumber?: number;
	readonly verdict?: 'pass' | 'concerns' | 'fail';
	readonly report?: string;
}

export interface ConventionAgentResultRequest {
	readonly projectId: string;
	readonly attemptId: string;
}

export interface WorkspaceConventionAgentOperations {
	readonly previewDraft: { readonly request: ConventionDraftRequest; readonly response: ConventionAgentPreviewDTO };
	readonly draft: { readonly request: ConventionDraftStartRequest; readonly response: ConventionAgentResultDTO };
	readonly previewCheck: { readonly request: ConventionCheckRequest; readonly response: ConventionAgentPreviewDTO };
	readonly check: { readonly request: ConventionCheckStartRequest; readonly response: ConventionAgentResultDTO };
	readonly getResult: { readonly request: ConventionAgentResultRequest; readonly response: ConventionAgentResultDTO };
	readonly cancel: { readonly request: { readonly projectId: string; readonly attemptId: string }; readonly response: void };
}
