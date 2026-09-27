/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export const WORKSPACE_DASHBOARD_CHANNEL = 'vscode:workspaceDashboard';

export interface WorkspaceDashboardProjectDTO {
	readonly id: string;
	readonly name: string;
	readonly createdAt: string;
}

export interface WorkspaceDashboardFolderDTO {
	readonly id: string;
	readonly projectId: string;
	readonly path: string;
	readonly vcsKind: 'git' | 'jj' | null;
	readonly vcsRoot: string | null;
	readonly reviewRepositoryId: string | null;
	readonly createdAt: string;
}

export interface WorkspaceDashboardTaskItemDTO {
	readonly id: string;
	readonly projectId: string;
	readonly bindingId: string;
	readonly title: string;
	readonly description: string | null;
	readonly state: 'ready' | 'inProgress' | 'review' | 'done';
	readonly order: number;
	readonly revision: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly archivedAt: string | null;
	readonly trashedAt: string | null;
	readonly deletionPendingAt: string | null;
	readonly deletionError: string | null;
	readonly deletionRequestId: string | null;
}

export interface WorkspaceDashboardViewDTO {
	readonly projectId: string;
	readonly descriptorUri: string;
	readonly openAtQuit: boolean;
	readonly selectedTaskId: string | null;
	readonly dashboardPosition: string | null;
}

export interface WorkspaceDashboardDTO {
	readonly project: WorkspaceDashboardProjectDTO;
	readonly folder: WorkspaceDashboardFolderDTO;
	readonly tasks: readonly WorkspaceDashboardTaskItemDTO[];
	readonly nextAction: WorkspaceDashboardNextActionDTO | null;
	readonly view: WorkspaceDashboardViewDTO;
}

export interface WorkspaceDashboardNextActionDTO {
	readonly taskId: string;
	readonly kind: 'attention' | 'inspectChanges' | 'review' | 'running' | 'ready';
	readonly primaryReviewId: string | null;
	readonly hasPassedE2eEvidence: boolean;
}

export interface CreateWorkspaceDashboardTaskRequest {
	readonly projectId: string;
	readonly title: string;
	readonly description?: string;
}

export interface UpdateWorkspaceDashboardTaskRequest {
	readonly projectId: string;
	readonly taskId: string;
	readonly expectedRevision: number;
	readonly title?: string;
	readonly description?: string | null;
	readonly state?: 'ready' | 'inProgress' | 'review' | 'done';
}

export interface ReorderWorkspaceDashboardTasksRequest {
	readonly projectId: string;
	readonly state: 'ready' | 'inProgress' | 'review' | 'done';
	readonly orderedTaskRevisions: readonly { readonly taskId: string; readonly revision: number }[];
}

export interface WorkspaceDashboardTaskLifecycleRequest {
	readonly projectId: string;
	readonly taskId: string;
	readonly expectedRevision: number;
}

export interface TrashWorkspaceDashboardTaskRequest extends WorkspaceDashboardTaskLifecycleRequest {
	readonly requestId: string;
}

export interface UpdateWorkspaceDashboardStateRequest {
	readonly projectId: string;
	readonly selectedTaskId: string | null;
	/** Canonical nonnegative scroll offset in pixels, encoded as a decimal string. */
	readonly dashboardPosition: string | null;
}

export interface OpenObservedOrdinaryFolderChangeRequest {
	readonly projectId: string;
	readonly taskId: string;
	readonly attemptId: string;
	/** A relative path copied from that attempt's persisted observed report. */
	readonly relativePath: string;
}

export interface WorkspaceDashboardInspectFileDTO {
	readonly relativePath: string;
	readonly content: string;
}

export interface WorkspaceDashboardTaskDTO {
	readonly project: WorkspaceDashboardProjectDTO;
	readonly folder: WorkspaceDashboardFolderDTO;
	readonly task: WorkspaceDashboardTaskItemDTO;
	readonly view: WorkspaceDashboardViewDTO;
}

export interface IWorkspaceDashboardService {
	getDashboard(projectId: string): Promise<WorkspaceDashboardDTO>;
	createTask(request: CreateWorkspaceDashboardTaskRequest): Promise<WorkspaceDashboardTaskDTO>;
	updateTask(request: UpdateWorkspaceDashboardTaskRequest): Promise<WorkspaceDashboardTaskItemDTO>;
	reorderTasks(request: ReorderWorkspaceDashboardTasksRequest): Promise<readonly WorkspaceDashboardTaskItemDTO[]>;
	listArchivedTasks(projectId: string): Promise<readonly WorkspaceDashboardTaskItemDTO[]>;
	listTrashedTasks(projectId: string): Promise<readonly WorkspaceDashboardTaskItemDTO[]>;
	archiveTask(request: WorkspaceDashboardTaskLifecycleRequest): Promise<WorkspaceDashboardTaskItemDTO>;
	restoreArchivedTask(request: WorkspaceDashboardTaskLifecycleRequest): Promise<WorkspaceDashboardTaskItemDTO>;
	trashTask(request: TrashWorkspaceDashboardTaskRequest): Promise<WorkspaceDashboardTaskItemDTO>;
	restoreTrashedTask(request: WorkspaceDashboardTaskLifecycleRequest): Promise<WorkspaceDashboardTaskItemDTO>;
	updateDashboardState(request: UpdateWorkspaceDashboardStateRequest): Promise<WorkspaceDashboardViewDTO>;
	openObservedOrdinaryFolderChange(request: OpenObservedOrdinaryFolderChangeRequest): Promise<WorkspaceDashboardInspectFileDTO>;
}
