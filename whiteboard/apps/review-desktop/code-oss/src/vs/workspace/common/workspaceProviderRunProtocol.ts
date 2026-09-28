/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WorkspaceTaskInstructionPromotionDTO } from './workspaceKnowledgeProtocol.js';

export const WORKSPACE_PROVIDER_RUNS_CHANNEL = 'vscode:workspaceProviderRuns';

export type ProviderId = 'codex' | 'claude';
export type ProviderAttemptState = 'queued' | 'preflight' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface ProviderRunScope {
	readonly projectId: string;
	readonly taskId: string;
	readonly providerId: ProviderId;
}

export interface ProviderRunPreviewRequest extends ProviderRunScope { }

export interface ProviderRunPreviewDTO {
	readonly prompt: string;
	readonly mode: 'mutating';
	readonly accountLabel: string;
	readonly cwd: string;
	readonly digest: string;
	readonly task: { readonly id: string; readonly revision: number; readonly title: string; readonly description: string | null };
	readonly conventionSnapshot: { readonly id: string; readonly version: number; readonly markdown: string; readonly contentSha256: string } | null;
	readonly references: readonly { readonly id: string; readonly version: number; readonly title: string; readonly contentType: string; readonly contentSha256: string; readonly content: string }[];
	readonly approvedInstructions: readonly WorkspaceTaskInstructionPromotionDTO[];
	readonly permission: {
		readonly providerId: ProviderId;
		readonly summary: string;
		readonly ordinaryFolderGrantRequired: boolean;
		readonly ordinaryFolderGrantEnabled: boolean;
		readonly allowed: boolean;
		readonly blockedReason: string | null;
	};
}

export interface OrdinaryFolderMutationRequest {
	readonly projectId: string;
	readonly bindingId: string;
}

export interface OrdinaryFolderMutationGrantDTO {
	readonly projectId: string;
	readonly bindingId: string;
	readonly canonicalPath: string;
	readonly dev: string;
	readonly ino: string;
	readonly grantedAt: string;
}

export interface StartProviderRunRequest extends ProviderRunScope {
	readonly digest: string;
}

export interface SubagentPreviewRequest extends ProviderRunScope {
	readonly parentAttemptId: string;
	readonly scope: string;
}

export interface StartSubagentRequest extends SubagentPreviewRequest {
	readonly digest: string;
}

export interface SubagentAttemptsRequest {
	readonly projectId: string;
	readonly taskId: string;
	readonly parentAttemptId: string;
}

export interface ProviderAttemptsRequest {
	readonly projectId: string;
	readonly taskId: string;
}

export interface CancelProviderRunRequest {
	readonly projectId: string;
	readonly attemptId: string;
}

export interface ProviderAttemptDTO {
	readonly id: string;
	readonly projectId: string;
	readonly taskId: string;
	readonly providerId: ProviderId;
	readonly purpose: 'connectionTest' | 'task';
	readonly state: ProviderAttemptState;
	readonly mode: 'read-only' | 'mutating';
	readonly accountLabel: string;
	readonly cwd: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
	readonly sessionId: string | null;
	readonly errorSummary: string | null;
	readonly cleanupVerified: boolean;
	readonly ordinaryFolderChanges?: OrdinaryFolderChangeReportDTO | null;
	readonly parentAttemptId?: string | null;
	readonly childScope?: string | null;
	readonly resultText?: string | null;
	readonly resultSha256?: string | null;
	readonly orchestrationPhase?: 'preflight' | 'waiting' | null;
	readonly approvedInstructions: readonly WorkspaceTaskInstructionPromotionDTO[];
}

export interface ProviderAttemptEventDTO {
	readonly eventId: number;
	readonly type: string;
	readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
	readonly createdAt: string;
}

export interface OrdinaryFolderChangeReportDTO {
	readonly status: 'observed' | 'unverified';
	readonly summary: string;
	readonly changes: readonly { readonly path: string; readonly change: 'created' | 'modified' | 'deleted' | 'symlink changed' | 'type changed'; readonly before?: string; readonly after?: string }[];
	readonly truncated: boolean;
}

export interface WorkspaceProviderRunOperations {
	readonly preview: { readonly request: ProviderRunPreviewRequest; readonly response: ProviderRunPreviewDTO };
	readonly start: { readonly request: StartProviderRunRequest; readonly response: { readonly attempt: ProviderAttemptDTO } };
	readonly enableFolderMutation: { readonly request: OrdinaryFolderMutationRequest; readonly response: OrdinaryFolderMutationGrantDTO };
	readonly revokeFolderMutation: { readonly request: OrdinaryFolderMutationRequest; readonly response: void };
	readonly list: { readonly request: ProviderAttemptsRequest; readonly response: { readonly attempts: readonly ProviderAttemptDTO[] } };
	readonly cancel: { readonly request: CancelProviderRunRequest; readonly response: void };
	readonly previewSubagent: { readonly request: SubagentPreviewRequest; readonly response: ProviderRunPreviewDTO };
	readonly startSubagent: { readonly request: StartSubagentRequest; readonly response: { readonly attempt: ProviderAttemptDTO } };
	readonly listSubagents: { readonly request: SubagentAttemptsRequest; readonly response: { readonly attempts: readonly ProviderAttemptDTO[]; readonly events: Readonly<Record<string, readonly ProviderAttemptEventDTO[]>> } };
}
