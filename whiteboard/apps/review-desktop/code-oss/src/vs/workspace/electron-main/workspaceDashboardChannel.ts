/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isUUID } from '../../base/common/uuid.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import { WorkspaceDatabase, type ProviderAttempt, type WorkspaceFolderBinding, type WorkspaceTask } from './workspaceDatabase.js';
import type { CreateWorkspaceDashboardTaskRequest, OpenObservedOrdinaryFolderChangeRequest, ReorderWorkspaceDashboardTasksRequest, TrashWorkspaceDashboardTaskRequest, UpdateWorkspaceDashboardStateRequest, UpdateWorkspaceDashboardTaskRequest, WorkspaceDashboardDTO, WorkspaceDashboardInspectFileDTO, WorkspaceDashboardNextActionDTO, WorkspaceDashboardTaskDTO, WorkspaceDashboardTaskLifecycleRequest, WorkspaceDashboardViewDTO } from '../common/workspaceDashboardProtocol.js';
import { parseOrdinaryFolderChangeReport } from './providerRuns/ordinaryFolderInventory.js';

const maximumDashboardPositionPixels = 10_000_000;
const maximumInspectFileBytes = 1024 * 1024;

export interface TaskDeletionCoordinator {
	deleteTask(projectId: string, taskId: string, expectedRevision: number, requestId: string): Promise<WorkspaceTask>;
	reconcileTaskCleanup(taskId: string): Promise<void>;
}

/** Main-process IPC boundary for project dashboards. All authority comes from the live window. */
export class WorkspaceDashboardChannel {
	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly windowsMainService: IWindowsMainService,
		private readonly taskDeletionCoordinator?: TaskDeletionCoordinator,
		private readonly boundCheckoutHelper?: string,
	) { }

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		const window = this.requireAuthorizedWindow(sender);

		switch (command) {
			case 'openObservedOrdinaryFolderChange': {
				const request = this.parseOpenOrdinaryChangeRequest(arg);
				this.requireProjectWindow(window, request.projectId);
				return await this.openObservedOrdinaryFolderChange(request) as T;
			}
			case 'getDashboard': {
				if (typeof arg !== 'string' || !isUUID(arg)) { throw new Error('A valid project ID is required.'); }
				if (window.config?.reviewWindowLaunch.kind !== 'project' || window.config.reviewWindowLaunch.projectId !== arg) {
					throw new Error('The requested project does not match this window.');
				}
				return this.getDashboard(arg) as Promise<T>;
			}
			case 'createTask': {
				const request = this.parseCreateTaskRequest(arg);
				if (window.config?.reviewWindowLaunch.kind !== 'project' || window.config.reviewWindowLaunch.projectId !== request.projectId) {
					throw new Error('The requested project does not match this window.');
				}
				return this.createTask(request) as Promise<T>;
			}
			case 'updateTask': {
				const request = this.parseUpdateTaskRequest(arg);
				if (window.config?.reviewWindowLaunch.kind !== 'project' || window.config.reviewWindowLaunch.projectId !== request.projectId) {
					throw new Error('The requested project does not match this window.');
				}
				const task = this.database.getTask(request.taskId);
				if (!task || task.projectId !== request.projectId) { throw new Error('The task does not belong to this project.'); }
				return this.database.updateTask(request.taskId, request.expectedRevision, request) as T;
			}
			case 'reorderTasks': {
				const request = this.parseReorderTasksRequest(arg);
				if (window.config?.reviewWindowLaunch.kind !== 'project' || window.config.reviewWindowLaunch.projectId !== request.projectId) {
					throw new Error('The requested project does not match this window.');
				}
				return this.database.reorderTasks(request.projectId, request.state, request.orderedTaskRevisions) as T;
			}
			case 'listArchivedTasks':
			case 'listTrashedTasks': {
				if (typeof arg !== 'string' || !isUUID(arg)) { throw new Error('A valid project ID is required.'); }
				this.requireProjectWindow(window, arg);
				return (command === 'listArchivedTasks' ? this.database.listArchivedTasks(arg) : this.database.listTrashedTasks(arg)) as T;
			}
			case 'archiveTask':
			case 'restoreArchivedTask':
			case 'restoreTrashedTask': {
				const request = this.parseTaskLifecycleRequest(arg);
				this.requireProjectWindow(window, request.projectId);
				this.requireTaskInProject(request.taskId, request.projectId);
				if (command === 'archiveTask') {
					if (this.taskDeletionCoordinator) { await this.taskDeletionCoordinator.reconcileTaskCleanup(request.taskId); }
					return this.database.archiveTask(request.taskId, request.expectedRevision) as T;
				}
				return (command === 'restoreArchivedTask'
					? this.database.restoreArchivedTask(request.taskId, request.expectedRevision)
					: this.database.restoreTrashedTask(request.taskId, request.expectedRevision)) as T;
			}
			case 'trashTask': {
				const request = this.parseTrashTaskRequest(arg);
				this.requireProjectWindow(window, request.projectId);
				this.requireTaskInProject(request.taskId, request.projectId);
				if (this.taskDeletionCoordinator) {
					return await this.taskDeletionCoordinator.deleteTask(request.projectId, request.taskId, request.expectedRevision, request.requestId) as T;
				}
				if (this.database.hasAttemptsRequiringCleanup(request.taskId)) {
					throw new Error('Trash requires a main-process coordinator to cancel owned attempts and verify cleanup.');
				}
				return this.database.trashTask(request.taskId, request.expectedRevision, request.requestId) as T;
			}
			case 'updateDashboardState': {
				const request = this.parseUpdateDashboardStateRequest(arg);
				if (window.config?.reviewWindowLaunch.kind !== 'project' || window.config.reviewWindowLaunch.projectId !== request.projectId) {
					throw new Error('The requested project does not match this window.');
				}
				const openedWorkspace = window.openedWorkspace;
				const descriptorUri = openedWorkspace && 'configPath' in openedWorkspace ? openedWorkspace.configPath.toString() : undefined;
				if (!descriptorUri) { throw new Error('The open workspace does not match this project.'); }
				return this.updateDashboardState(request, descriptorUri) as Promise<T>;
			}
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	private async openObservedOrdinaryFolderChange(request: OpenObservedOrdinaryFolderChangeRequest): Promise<WorkspaceDashboardInspectFileDTO> {
		const task = this.requireTaskInProject(request.taskId, request.projectId);
		if (task.state !== 'review') { throw new Error('Changed files are available only while this task is in Review.'); }
		const binding = this.database.listFolderBindings(request.projectId).find(candidate => candidate.id === task.bindingId);
		if (!binding || binding.vcsKind !== null) { throw new Error('This task is not bound to an ordinary folder.'); }
		const attempt = this.database.getProviderAttempt(request.attemptId);
		if (!attempt || attempt.taskId !== task.id || attempt.parentAttemptId !== null || attempt.purpose !== 'task' || attempt.state !== 'succeeded') {
			throw new Error('A successful task run is required to inspect changed files.');
		}
		const changeEvent = this.database.listProviderAttemptEvents(attempt.attemptId).reverse().find(event => event.type === 'ordinaryFolderChanges');
		const report = changeEvent && typeof changeEvent.metadata.report === 'string' ? parseOrdinaryFolderChangeReport(changeEvent.metadata.report) : undefined;
		if (!report || report.status !== 'observed') { throw new Error('This run has no verified ordinary-folder change report.'); }
		if (!attempt.cleanupVerified) { throw new Error('Run cleanup has not been verified; changed files are not available yet.'); }
		const changed = report.changes.find(change => change.path === request.relativePath && /^[a-f0-9]{64}$/u.test(change.after ?? ''));
		if (!changed) { throw new Error('The requested file is not an openable path in this run\'s persisted report.'); }

		const { rootPath, dev, ino } = this.resolveOrdinaryReportRoot(binding, attempt);
		const content = await this.readOrdinaryReportFile(rootPath, dev, ino, request.relativePath, changed.after!);
		return { relativePath: request.relativePath, content };
	}

	private resolveOrdinaryReportRoot(binding: WorkspaceFolderBinding, attempt: ProviderAttempt): { rootPath: string; dev: string; ino: string } {
		let rootPath: string;
		try {
			const rootEntry = lstatSync(binding.path);
			if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) { throw new Error('The bound folder is not a regular directory.'); }
			rootPath = realpathSync(binding.path);
			const rootStats = statSync(rootPath, { bigint: true });
			const dev = rootStats.dev.toString();
			const ino = rootStats.ino.toString();
			const currentIdentity = `${binding.id}:${rootPath}:${dev}:${ino}`;
			if (attempt.cwd !== rootPath || attempt.folderIdentity !== currentIdentity) {
				throw new Error('The bound folder identity changed after the report was recorded.');
			}
			return { rootPath, dev, ino };
		} catch (error) {
			throw new Error(`The bound folder is unavailable or changed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async readOrdinaryReportFile(rootPath: string, dev: string, ino: string, relativePath: string, expectedHash: string): Promise<string> {
		if (!this.isSafeReportRelativePath(relativePath)) {
			throw new Error('A safe relative report path is required.');
		}
		const helper = this.boundCheckoutHelper ?? this.boundHelperExecutable();
		if (!helper) { throw new Error('The native bound-checkout helper is unavailable; Inspect is disabled.'); }
		const bytes = await new Promise<Buffer>((resolve, reject) => {
			execFile(helper, ['--root', rootPath, '--dev', dev, '--ino', ino, 'read', relativePath], {
				encoding: 'buffer', maxBuffer: maximumInspectFileBytes + 1, timeout: 10_000,
			}, (error, stdout) => {
				if (error) { reject(error); }
				else { resolve(stdout); }
			});
		}).catch((error: unknown) => {
			const code = error instanceof Error && 'code' in error ? error.code : undefined;
			if (code === 'ENOBUFS' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
				throw new Error('The reported file exceeds the 1 MiB Inspect limit.');
			}
			if (code === 'ETIMEDOUT') { throw new Error('Reading the reported file timed out.'); }
			throw new Error(`The reported file could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
		});
		if (bytes.byteLength > maximumInspectFileBytes) { throw new Error('The reported file exceeds the 1 MiB Inspect limit.'); }
		if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
			throw new Error('The reported file changed after the observed report was recorded.');
		}
		try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
		catch (error) {
			if (error instanceof TypeError) { throw new Error('The reported file is not valid UTF-8 text.'); }
			throw error;
		}
	}

	private isSafeReportRelativePath(relativePath: string): boolean {
		if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\') || Buffer.byteLength(relativePath, 'utf8') > 4096) { return false; }
		return relativePath.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
	}

	private boundHelperExecutable(): string | undefined {
		const resourcesPath = process.resourcesPath;
		const candidate = process.env['VSCODE_DEV']
			? process.env['DEV_FAST_REVIEW_BOUND_CHECKOUT_HELPER']
			: resourcesPath ? join(resourcesPath, 'app', 'review-runtime', 'bin', 'bound-checkout') : undefined;
		if (!candidate) { return undefined; }
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch { return undefined; }
	}

	private requireAuthorizedWindow(sender: WebContents) {
		if (!sender || typeof sender !== 'object') { throw new Error('A valid IPC sender is required.'); }
		const window = this.windowsMainService.getWindowByWebContents(sender);
		if (!window || !window.config || window.config.reviewWindowLaunch.kind !== 'project') {
			throw new Error('This operation requires an open project window.');
		}
		const projectId = window.config.reviewWindowLaunch.projectId;
		if (!isUUID(projectId)) { throw new Error('The project window has an invalid project ID.'); }
		const project = this.database.getProject(projectId);
		const view = this.database.getProjectView(projectId);
		if (!project || !view) { throw new Error(`Project ${projectId} is unavailable.`); }
		const openedWorkspace = window.openedWorkspace;
		const openedDescriptorUri = openedWorkspace && 'configPath' in openedWorkspace ? openedWorkspace.configPath.toString() : undefined;
		if (!openedDescriptorUri || openedDescriptorUri !== view.descriptorUri) {
			throw new Error('The open workspace does not match this project.');
		}
		return window;
	}

	private async getDashboard(projectId: string): Promise<WorkspaceDashboardDTO> {
		const project = this.database.getProject(projectId);
		const folder = this.database.listFolderBindings(projectId)[0];
		const view = this.database.getProjectView(projectId);
		if (!project || !folder || !view) { throw new Error(`Project ${projectId} is unavailable.`); }
		const tasks = this.database.listTasks(projectId);
		return { project, folder, tasks, nextAction: this.getNextAction(tasks), view };
	}

	private getNextAction(tasks: readonly WorkspaceTask[]): WorkspaceDashboardNextActionDTO | null {
		const oldestFirst = [...tasks].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
		const inProgress = oldestFirst.filter(task => task.state === 'inProgress');
		const needsAttention = inProgress.find(task => {
			const attempts = this.database.listProviderAttempts(task.id);
			const latestRoot = [...attempts].reverse().find(attempt => attempt.parentAttemptId === null && attempt.purpose === 'task');
			if (!latestRoot) { return false; }
			const failed = (state: string) => state === 'failed' || state === 'cancelled' || state === 'interrupted';
			return failed(latestRoot.state) || (latestRoot.state === 'succeeded' && !latestRoot.cleanupVerified)
				|| attempts.some(attempt => attempt.parentAttemptId === latestRoot.attemptId &&
					(failed(attempt.state) || (attempt.state === 'succeeded' && !attempt.cleanupVerified)));
		});
		if (needsAttention) { return { taskId: needsAttention.id, kind: 'attention', primaryReviewId: null, hasPassedE2eEvidence: false }; }
		const review = oldestFirst.find(task => task.state === 'review');
		if (review) {
			const binding = this.database.listFolderBindings(review.projectId).find(candidate => candidate.id === review.bindingId);
			const inspectAttempt = binding?.vcsKind === null ? [...this.database.listProviderAttempts(review.id)].reverse().find(attempt => {
				if (attempt.parentAttemptId !== null || attempt.purpose !== 'task' || attempt.state !== 'succeeded' || !attempt.cleanupVerified) { return false; }
				const event = this.database.listProviderAttemptEvents(attempt.attemptId).reverse().find(candidate => candidate.type === 'ordinaryFolderChanges');
				const report = event && typeof event.metadata.report === 'string' ? parseOrdinaryFolderChangeReport(event.metadata.report) : undefined;
				if (report?.status !== 'observed') { return false; }
				try { this.resolveOrdinaryReportRoot(binding, attempt); }
				catch (error) {
					if (error instanceof Error) { return false; }
					throw error;
				}
				return report.changes.some(change => {
					if (change.change === 'deleted' || change.change === 'symlink changed' || !/^[a-f0-9]{64}$/u.test(change.after ?? '')) { return false; }
					return this.isSafeReportRelativePath(change.path);
				});
			}) : undefined;
			const primaryReviewId = this.database.listTaskReviews(review.id).find(link => link.isPrimary && link.state === 'available')?.reviewId ?? null;
			const hasPassedE2eEvidence = this.database.listWorkspaceE2eEvidence(review.id).some(evidence => evidence.state === 'passed');
			return { taskId: review.id, kind: inspectAttempt ? 'inspectChanges' : 'review', primaryReviewId, hasPassedE2eEvidence };
		}
		const running = inProgress[0];
		if (running) { return { taskId: running.id, kind: 'running', primaryReviewId: null, hasPassedE2eEvidence: false }; }
		const ready = oldestFirst.find(task => task.state === 'ready');
		return ready ? { taskId: ready.id, kind: 'ready', primaryReviewId: null, hasPassedE2eEvidence: false } : null;
	}

	private async createTask(request: CreateWorkspaceDashboardTaskRequest): Promise<WorkspaceDashboardTaskDTO> {
		const project = this.database.getProject(request.projectId);
		const folder = this.database.listFolderBindings(request.projectId)[0];
		const view = this.database.getProjectView(request.projectId);
		if (!project || !folder || !view) { throw new Error(`Project ${request.projectId} is unavailable.`); }
		const task = this.database.createTask({
			projectId: project.id,
			bindingId: folder.id,
			title: request.title.trim(),
			description: request.description?.trim() || null,
		});
		return { project, folder, task, view };
	}

	private parseUpdateTaskRequest(value: unknown): UpdateWorkspaceDashboardTaskRequest {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('A task update request is required.'); }
		const request = value as Record<string, unknown>;
		if (typeof request.projectId !== 'string' || !isUUID(request.projectId)) { throw new Error('A valid project ID is required.'); }
		if (typeof request.taskId !== 'string' || !isUUID(request.taskId)) { throw new Error('A valid task ID is required.'); }
		if (!Number.isSafeInteger(request.expectedRevision) || Number(request.expectedRevision) < 1) { throw new Error('A valid task revision is required.'); }
		if (request.title !== undefined && (typeof request.title !== 'string' || !request.title.trim() || request.title.length > 500)) { throw new Error('A task title is required and must be at most 500 characters.'); }
		if (request.description !== undefined && request.description !== null && (typeof request.description !== 'string' || request.description.length > 10000)) { throw new Error('Task description must be at most 10000 characters.'); }
		if (request.state !== undefined && (typeof request.state !== 'string' || !['ready', 'inProgress', 'review', 'done'].includes(request.state))) { throw new Error('A valid task state is required.'); }
		if (request.title === undefined && request.description === undefined && request.state === undefined) { throw new Error('At least one task field must change.'); }
		return { projectId: request.projectId, taskId: request.taskId, expectedRevision: Number(request.expectedRevision), title: request.title as string | undefined, description: request.description as string | null | undefined, state: request.state as UpdateWorkspaceDashboardTaskRequest['state'] };
	}

	private parseReorderTasksRequest(value: unknown): ReorderWorkspaceDashboardTasksRequest {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('A reorder request is required.'); }
		const request = value as Record<string, unknown>;
		if (typeof request.projectId !== 'string' || !isUUID(request.projectId)) { throw new Error('A valid project ID is required.'); }
		if (typeof request.state !== 'string' || !['ready', 'inProgress', 'review', 'done'].includes(request.state)) { throw new Error('A valid task state is required.'); }
		if (!Array.isArray(request.orderedTaskRevisions) || request.orderedTaskRevisions.some(item => typeof item !== 'object' || item === null || Array.isArray(item) || typeof (item as Record<string, unknown>).taskId !== 'string' || !isUUID((item as Record<string, unknown>).taskId as string) || !Number.isSafeInteger((item as Record<string, unknown>).revision) || Number((item as Record<string, unknown>).revision) < 1)) { throw new Error('A complete task revision list is required.'); }
		return { projectId: request.projectId, state: request.state as ReorderWorkspaceDashboardTasksRequest['state'], orderedTaskRevisions: request.orderedTaskRevisions as ReorderWorkspaceDashboardTasksRequest['orderedTaskRevisions'] };
	}

	private parseTaskLifecycleRequest(value: unknown): WorkspaceDashboardTaskLifecycleRequest {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('A task lifecycle request is required.'); }
		const request = value as Record<string, unknown>;
		if (typeof request.projectId !== 'string' || !isUUID(request.projectId)) { throw new Error('A valid project ID is required.'); }
		if (typeof request.taskId !== 'string' || !isUUID(request.taskId)) { throw new Error('A valid task ID is required.'); }
		if (!Number.isSafeInteger(request.expectedRevision) || Number(request.expectedRevision) < 1) { throw new Error('A valid task revision is required.'); }
		return { projectId: request.projectId, taskId: request.taskId, expectedRevision: Number(request.expectedRevision) };
	}

	private parseTrashTaskRequest(value: unknown): TrashWorkspaceDashboardTaskRequest {
		const request = this.parseTaskLifecycleRequest(value);
		const requestId = (value as Record<string, unknown>).requestId;
		if (typeof requestId !== 'string' || !isUUID(requestId)) { throw new Error('A valid stable Trash request ID is required.'); }
		return { ...request, requestId };
	}

	private requireProjectWindow(window: ReturnType<WorkspaceDashboardChannel['requireAuthorizedWindow']>, projectId: string): void {
		if (window.config?.reviewWindowLaunch.kind !== 'project' || window.config.reviewWindowLaunch.projectId !== projectId) { throw new Error('The requested project does not match this window.'); }
	}

	private requireTaskInProject(taskId: string, projectId: string): WorkspaceTask {
		const task = this.database.getTask(taskId);
		if (!task || task.projectId !== projectId) { throw new Error('The task does not belong to this project.'); }
		return task;
	}

	private parseOpenOrdinaryChangeRequest(value: unknown): OpenObservedOrdinaryFolderChangeRequest {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('An ordinary-folder change request is required.'); }
		const request = value as Record<string, unknown>;
		for (const field of ['projectId', 'taskId', 'attemptId'] as const) {
			if (typeof request[field] !== 'string' || !isUUID(request[field] as string)) { throw new Error(`A valid ${field} is required.`); }
		}
		if (typeof request.relativePath !== 'string' || request.relativePath.length > 4096) { throw new Error('A valid report-relative path is required.'); }
		return { projectId: request.projectId as string, taskId: request.taskId as string, attemptId: request.attemptId as string, relativePath: request.relativePath };
	}

	private async updateDashboardState(request: UpdateWorkspaceDashboardStateRequest, descriptorUri: string): Promise<WorkspaceDashboardViewDTO> {
		return this.database.updateProjectDashboardState({ ...request, expectedDescriptorUri: descriptorUri });
	}

	private parseCreateTaskRequest(value: unknown): CreateWorkspaceDashboardTaskRequest {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('A task request is required.'); }
		const request = value as Record<string, unknown>;
		if (typeof request.projectId !== 'string' || !isUUID(request.projectId)) { throw new Error('A valid project ID is required.'); }
		if (typeof request.title !== 'string' || !request.title.trim()) { throw new Error('A task title is required.'); }
		if (request.description !== undefined && typeof request.description !== 'string') { throw new Error('Task description must be text.'); }
		if (request.title.length > 500 || (typeof request.description === 'string' && request.description.length > 10000)) {
			throw new Error('The task request is too long.');
		}
		return {
			projectId: request.projectId,
			title: request.title,
			description: request.description as string | undefined,
		};
	}

	private parseUpdateDashboardStateRequest(value: unknown): UpdateWorkspaceDashboardStateRequest {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('A dashboard state request is required.'); }
		const request = value as Record<string, unknown>;
		if (typeof request.projectId !== 'string' || !isUUID(request.projectId)) { throw new Error('A valid project ID is required.'); }
		if (request.selectedTaskId !== null && (typeof request.selectedTaskId !== 'string' || !isUUID(request.selectedTaskId))) {
			throw new Error('A valid selected task ID or null is required.');
		}
		const position = request.dashboardPosition;
		if (position !== null && (typeof position !== 'string' || !/^(0|[1-9][0-9]*)$/.test(position) || Number(position) > maximumDashboardPositionPixels)) {
			throw new Error('Dashboard position must be an integer pixel value from 0 to 10000000, encoded as text.');
		}
		return { projectId: request.projectId, selectedTaskId: request.selectedTaskId, dashboardPosition: position };
	}
}
