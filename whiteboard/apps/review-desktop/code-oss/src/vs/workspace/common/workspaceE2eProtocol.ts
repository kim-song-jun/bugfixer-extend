/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export const WORKSPACE_E2E_CHANNEL = 'vscode:workspaceE2e';

export type WorkspaceE2eStep =
	| { readonly type: 'click'; readonly selector: string }
	| { readonly type: 'fill'; readonly selector: string; readonly value: string }
	| { readonly type: 'assertText'; readonly selector: string; readonly value: string };

export interface StartWorkspaceE2eRequest {
	readonly projectId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly targetUrl: string;
	readonly environmentIdentity: string;
	readonly scenario: readonly WorkspaceE2eStep[];
}

export interface WorkspaceE2eRequest { readonly projectId: string; readonly taskId: string; readonly evidenceId: string; }

export interface WorkspaceE2eEvidenceDTO {
	readonly id: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly targetUrl: string;
	/** Full VCS commit ID at check start; this does not identify uncommitted working-tree content. */
	readonly checkoutRevision: string | null;
	readonly checkoutRevisionUnavailableReason: string | null;
	readonly environmentIdentity: string;
	readonly scenario: readonly WorkspaceE2eStep[];
	readonly state: 'running' | 'passed' | 'failed' | 'cancelled' | 'cleanupFailed';
	readonly taskSpaceId: number;
	readonly screenshotSha256: string | null;
	readonly screenshotPath: string | null;
	readonly logSha256: string | null;
	readonly logPath: string | null;
	readonly failure: string | null;
	readonly cleanupError: string | null;
	readonly createdAt: string;
	readonly completedAt: string | null;
}

export interface WorkspaceE2eOperations {
	readonly start: { readonly request: StartWorkspaceE2eRequest; readonly response: { readonly evidence: WorkspaceE2eEvidenceDTO } };
	readonly cancel: { readonly request: WorkspaceE2eRequest; readonly response: { readonly evidence: WorkspaceE2eEvidenceDTO } };
	readonly retryCleanup: { readonly request: WorkspaceE2eRequest; readonly response: { readonly evidence: WorkspaceE2eEvidenceDTO } };
	readonly list: { readonly request: Pick<WorkspaceE2eRequest, 'projectId' | 'taskId'>; readonly response: { readonly evidence: readonly WorkspaceE2eEvidenceDTO[] } };
}
