/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { isUUID } from '../../base/common/uuid.js';
import type { WorkspaceDashboardDTO } from '../common/workspaceDashboardProtocol.js';
import type { AttachWorkspaceTaskReferenceRequest, CreateWorkspaceConventionDraftRequest, ImportWorkspaceTextReferenceRequest, WorkspaceConventionDTO, WorkspaceKnowledgeDTO, WorkspaceKnowledgeReferenceRequest, WorkspaceKnowledgeTaskRequest, WorkspaceKnowledgeConventionRequest, WorkspaceReferenceContentDTO } from '../common/workspaceKnowledgeProtocol.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase, type ConventionVersion } from './workspaceDatabase.js';

const maximumManualReferenceBytes = 1024 * 1024;

/** Renderer access to app-owned references and conventions, scoped to its live project window. */
export class WorkspaceKnowledgeChannel {
	constructor(private readonly database: WorkspaceDatabase, private readonly dashboardChannel: WorkspaceDashboardChannel) { }

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		const projectId = this.projectId(command, arg);
		const dashboard = await this.dashboardChannel.call<WorkspaceDashboardDTO>(sender, 'getDashboard', projectId);
		switch (command) {
			case 'getProjectKnowledge': {
				const taskReferences: Record<string, ReturnType<typeof this.database.knowledge.listTaskReferences>> = {};
				for (const task of dashboard.tasks) { taskReferences[task.id] = this.database.knowledge.listTaskReferences(task.id); }
			const conventions = this.database.knowledge.listConventions(projectId).map(version => this.conventionDTO(version));
				return {
					references: this.database.knowledge.listProjectReferences(projectId),
					taskReferences,
					conventions,
					activeConventionId: conventions.find(version => version.active)?.id ?? null,
				} satisfies WorkspaceKnowledgeDTO as T;
			}
			case 'listProjectReferences':
				return this.database.knowledge.listProjectReferences(projectId) as T;
			case 'importTextReference':
				return this.importTextReference(projectId, arg as ImportWorkspaceTextReferenceRequest) as T;
			case 'getReference': {
				const { snapshotId } = this.referenceRequest(arg);
				const snapshot = this.database.knowledge.readReference(snapshotId);
				if (!snapshot || snapshot.projectId !== projectId) { throw new Error('Reference is unavailable in this project.'); }
				const { content: _artifact, derivedText, ...metadata } = snapshot;
				return { ...metadata, content: derivedText } satisfies WorkspaceReferenceContentDTO as T;
			}
			case 'attachTaskReference': {
				const { taskId, snapshotId } = this.attachRequest(arg);
				this.requireTask(dashboard, taskId);
				this.database.knowledge.attachReferenceToTask(taskId, snapshotId);
				return undefined as T;
			}
			case 'listTaskReferences': {
				const { taskId } = this.taskRequest(arg);
				this.requireTask(dashboard, taskId);
				return this.database.knowledge.listTaskReferences(taskId) as T;
			}
			case 'listConventions':
				return this.database.knowledge.listConventions(projectId).map(version => this.conventionDTO(version)) as T;
			case 'createConventionDraft': {
				const request = this.conventionDraftRequest(arg);
				const version = this.database.knowledge.createConventionVersion({
					projectId, markdown: request.markdown, sourceSnapshotIds: request.sourceSnapshotIds, authoredBy: 'person',
				});
				return this.conventionDTO(version) as T;
			}
			case 'applyConvention': {
				const { versionId } = this.conventionRequest(arg);
				return this.conventionDTO(this.database.knowledge.applyConventionVersion(projectId, versionId)) as T;
			}
			case 'listConventionChecks': {
				const { versionId } = this.conventionRequest(arg);
				const version = this.database.knowledge.readConvention(versionId);
				if (!version || version.projectId !== projectId) { throw new Error('Convention version is unavailable in this project.'); }
				return this.database.knowledge.listConventionChecks(versionId) as T;
			}
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	private conventionDTO(version: ConventionVersion): WorkspaceConventionDTO {
		return { ...version, latestCheckVerdict: this.database.knowledge.latestConventionCheckVerdict(version.id) };
	}

	private importTextReference(projectId: string, request: ImportWorkspaceTextReferenceRequest) {
		if (typeof request.title !== 'string' || !request.title.trim() || request.title.length > 500) { throw new Error('A reference title of at most 500 characters is required.'); }
		if (typeof request.content !== 'string' || !request.content.trim() || Buffer.byteLength(request.content, 'utf8') > maximumManualReferenceBytes) {
			throw new Error('Reference text must contain 1 byte to 1 MiB of UTF-8 content.');
		}
		let sourceUri: string | null = null;
		if (request.sourceUri !== undefined && request.sourceUri !== null && request.sourceUri !== '') {
			if (typeof request.sourceUri !== 'string' || request.sourceUri.length > 4096) { throw new Error('Source URL is too long.'); }
			let url: URL;
			try { url = new URL(request.sourceUri); }
			catch { throw new Error('Source URL must be a valid HTTP or HTTPS URL.'); }
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { throw new Error('Source URL must use HTTP or HTTPS without embedded credentials.'); }
			sourceUri = url.toString();
		}
		let externalId: string = randomUUID();
		if (request.sourceId !== undefined) {
			if (typeof request.sourceId !== 'string' || !isUUID(request.sourceId)) { throw new Error('A valid source ID is required.'); }
			const prior = this.database.knowledge.listProjectReferences(projectId).find(snapshot => snapshot.sourceId === request.sourceId);
			if (!prior || prior.connectorId !== 'manual-text') { throw new Error('Manual source is unavailable in this project.'); }
			externalId = prior.externalId;
			sourceUri ??= prior.sourceUri;
		}
		const { content: _content, derivedText: _derivedText, ...metadata } = this.database.knowledge.importReference({
			projectId, connectorId: 'manual-text', connectorVersion: '1', externalId,
			sourceUri, title: request.title, contentType: 'text/plain; charset=utf-8',
			content: Buffer.from(request.content, 'utf8'),
		});
		return metadata;
	}

	private projectId(command: string, value: unknown): string {
		const projectId = command === 'getProjectKnowledge' && typeof value === 'string'
			? value : this.record(value).projectId;
		if (typeof projectId !== 'string' || !isUUID(projectId)) { throw new Error('A valid project ID is required.'); }
		return projectId;
	}

	private referenceRequest(value: unknown): WorkspaceKnowledgeReferenceRequest {
		const record = this.record(value);
		if (typeof record.snapshotId !== 'string' || !isUUID(record.snapshotId)) { throw new Error('A valid reference snapshot ID is required.'); }
		return record as unknown as WorkspaceKnowledgeReferenceRequest;
	}

	private taskRequest(value: unknown): WorkspaceKnowledgeTaskRequest {
		const record = this.record(value);
		if (typeof record.taskId !== 'string' || !isUUID(record.taskId)) { throw new Error('A valid task ID is required.'); }
		return record as unknown as WorkspaceKnowledgeTaskRequest;
	}

	private attachRequest(value: unknown): AttachWorkspaceTaskReferenceRequest {
		const request = this.taskRequest(value);
		if (typeof (value as Record<string, unknown>).snapshotId !== 'string' || !isUUID((value as Record<string, unknown>).snapshotId as string)) {
			throw new Error('A valid reference snapshot ID is required.');
		}
		return request as AttachWorkspaceTaskReferenceRequest;
	}

	private conventionDraftRequest(value: unknown): CreateWorkspaceConventionDraftRequest {
		const record = this.record(value);
		if (typeof record.markdown !== 'string' || !record.markdown.trim()) { throw new Error('A convention document is required.'); }
		if (!Array.isArray(record.sourceSnapshotIds) || record.sourceSnapshotIds.some(id => typeof id !== 'string' || !isUUID(id))) {
			throw new Error('Reference snapshot IDs are required.');
		}
		return record as unknown as CreateWorkspaceConventionDraftRequest;
	}

	private conventionRequest(value: unknown): WorkspaceKnowledgeConventionRequest {
		const record = this.record(value);
		if (typeof record.versionId !== 'string' || !isUUID(record.versionId)) { throw new Error('A valid convention version ID is required.'); }
		return record as unknown as WorkspaceKnowledgeConventionRequest;
	}

	private requireTask(dashboard: WorkspaceDashboardDTO, taskId: string): void {
		if (!dashboard.tasks.some(task => task.id === taskId)) { throw new Error('The task does not belong to this project.'); }
	}

	private record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('A knowledge request is required.'); }
		return value as Record<string, unknown>;
	}
}
