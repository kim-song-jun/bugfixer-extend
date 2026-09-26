/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export const WORKSPACE_KNOWLEDGE_CHANNEL = 'vscode:workspaceKnowledge';

export interface WorkspaceKnowledgeProjectRequest {
	readonly projectId: string;
}

export interface WorkspaceReferenceDTO {
	readonly id: string;
	readonly sourceId: string;
	readonly projectId: string;
	readonly connectorId: string;
	readonly connectorVersion: string;
	readonly externalId: string;
	readonly sourceUri: string | null;
	readonly accountRef: string | null;
	readonly version: number;
	readonly previousId: string | null;
	readonly title: string;
	readonly retrievedAt: string;
	readonly contentType: string;
	readonly contentSha256: string;
	readonly omissions: readonly string[];
}

export interface WorkspaceReferenceContentDTO extends WorkspaceReferenceDTO {
	/** Readable reference text retained for existing UI consumers. */
	readonly content: string;
}

export interface ImportWorkspaceTextReferenceRequest extends WorkspaceKnowledgeProjectRequest {
	readonly title: string;
	readonly content: string;
	readonly sourceUri?: string | null;
	/** When set, create a new immutable version of this project's manual source. */
	readonly sourceId?: string;
}

export interface WorkspaceKnowledgeReferenceRequest extends WorkspaceKnowledgeProjectRequest {
	readonly snapshotId: string;
}

export interface WorkspaceKnowledgeTaskRequest extends WorkspaceKnowledgeProjectRequest {
	readonly taskId: string;
}

export interface AttachWorkspaceTaskReferenceRequest extends WorkspaceKnowledgeTaskRequest {
	readonly snapshotId: string;
}

export interface WorkspaceConventionDTO {
	readonly id: string;
	readonly projectId: string;
	readonly version: number;
	readonly markdown: string;
	readonly sourceSnapshotIds: readonly string[];
	readonly authoredBy: 'person' | 'codex' | 'claude';
	readonly authorAttemptId: string | null;
	readonly createdAt: string;
	readonly active: boolean;
	readonly lastAppliedAt: string | null;
	/** The most recently recorded agent check for this exact immutable version. */
	readonly latestCheckVerdict: 'pass' | 'concerns' | 'fail' | null;
}

export interface CreateWorkspaceConventionDraftRequest extends WorkspaceKnowledgeProjectRequest {
	readonly markdown: string;
	readonly sourceSnapshotIds: readonly string[];
}

export interface WorkspaceKnowledgeConventionRequest extends WorkspaceKnowledgeProjectRequest {
	readonly versionId: string;
}

export interface WorkspaceConventionCheckDTO {
	readonly id: string;
	readonly versionId: string;
	readonly provider: 'codex' | 'claude';
	readonly attemptId: string;
	readonly verdict: 'pass' | 'concerns' | 'fail';
	readonly report: string;
	readonly checkedAt: string;
}

export interface WorkspaceKnowledgeDTO {
	readonly references: readonly WorkspaceReferenceDTO[];
	readonly taskReferences: Readonly<Record<string, readonly WorkspaceReferenceDTO[]>>;
	readonly conventions: readonly WorkspaceConventionDTO[];
	readonly activeConventionId: string | null;
}

export interface WorkspaceKnowledgeOperations {
	readonly getProjectKnowledge: { readonly request: string; readonly response: WorkspaceKnowledgeDTO };
	readonly listProjectReferences: { readonly request: WorkspaceKnowledgeProjectRequest; readonly response: readonly WorkspaceReferenceDTO[] };
	readonly importTextReference: { readonly request: ImportWorkspaceTextReferenceRequest; readonly response: WorkspaceReferenceDTO };
	readonly getReference: { readonly request: WorkspaceKnowledgeReferenceRequest; readonly response: WorkspaceReferenceContentDTO };
	readonly attachTaskReference: { readonly request: AttachWorkspaceTaskReferenceRequest; readonly response: void };
	readonly listTaskReferences: { readonly request: WorkspaceKnowledgeTaskRequest; readonly response: readonly WorkspaceReferenceDTO[] };
	readonly listConventions: { readonly request: WorkspaceKnowledgeProjectRequest; readonly response: readonly WorkspaceConventionDTO[] };
	readonly createConventionDraft: { readonly request: CreateWorkspaceConventionDraftRequest; readonly response: WorkspaceConventionDTO };
	readonly applyConvention: { readonly request: WorkspaceKnowledgeConventionRequest; readonly response: WorkspaceConventionDTO };
	readonly listConventionChecks: { readonly request: WorkspaceKnowledgeConventionRequest; readonly response: readonly WorkspaceConventionCheckDTO[] };
}
