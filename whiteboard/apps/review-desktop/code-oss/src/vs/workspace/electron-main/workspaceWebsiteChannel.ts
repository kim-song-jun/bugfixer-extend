/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { isUUID } from '../../base/common/uuid.js';
import type { WorkspaceDashboardDTO } from '../common/workspaceDashboardProtocol.js';
import type { WorkspaceReferenceDTO } from '../common/workspaceKnowledgeProtocol.js';
import type { WorkspaceWebsiteImportRequest, WorkspaceWebsitePreviewDTO, WorkspaceWebsitePreviewRequest } from '../common/workspaceWebsiteProtocol.js';
import { PublicWebsiteImportTransport, type PublicWebsiteImportResult } from './connectors/publicWebsiteImport.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';

const previewLifetimeMs = 5 * 60_000;
interface PendingPreview {
	readonly sender: WebContents;
	readonly projectId: string;
	readonly result: PublicWebsiteImportResult;
	readonly expiresAt: number;
}

/** Imports credential-free public web pages after the project window reviews the extracted text. */
export class WorkspaceWebsiteChannel {
	private readonly previews = new Map<string, PendingPreview>();
	private readonly trackedSenders = new WeakSet<WebContents>();

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly dashboardChannel: WorkspaceDashboardChannel,
		private readonly transportFactory: () => PublicWebsiteImportTransport = () => new PublicWebsiteImportTransport(),
		private readonly now: () => number = Date.now,
	) { }

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		const projectId = this.projectId(arg);
		const dashboard = await this.dashboardChannel.call<WorkspaceDashboardDTO>(sender, 'getDashboard', projectId);
		switch (command) {
			case 'previewPage': {
				const request = this.previewRequest(arg);
				const result = await this.transportFactory().fetch(request.url);
				await this.dashboardChannel.call<WorkspaceDashboardDTO>(sender, 'getDashboard', projectId);
				const previewId = randomUUID();
				const expiresAt = this.now() + previewLifetimeMs;
				this.pruneExpired();
				// A sender has one project-window authority and only needs its latest reviewed page.
				for (const [id, previous] of this.previews) { if (previous.sender === sender) { this.previews.delete(id); } }
				this.trackSender(sender);
				this.previews.set(previewId, { sender, projectId, result, expiresAt });
				return {
					previewId, requestedUri: result.requestedUrl, sourceUri: result.canonicalUrl,
					title: result.title, contentType: result.contentType, derivedText: result.derivedText,
					contentSha256: result.contentSha256, omissions: result.omissions, expiresAt: new Date(expiresAt).toISOString(),
				} satisfies WorkspaceWebsitePreviewDTO as T;
			}
			case 'importPreview': {
				const request = this.importRequest(arg);
				if (request.taskId && !dashboard.tasks.some(task => task.id === request.taskId)) { throw new Error('The task does not belong to this project.'); }
				const preview = this.previews.get(request.previewId);
				if (!preview || preview.sender !== sender || preview.projectId !== projectId) { throw new Error('The website preview is unavailable in this project window.'); }
				if (preview.expiresAt <= this.now()) { this.previews.delete(request.previewId); throw new Error('The website preview expired. Review the page again.'); }
				const exactHash = createHash('sha256').update(preview.result.content).digest('hex');
				if (exactHash !== preview.result.contentSha256) { this.previews.delete(request.previewId); throw new Error('The reviewed website content changed. Review the page again.'); }
				const imported = this.database.knowledge.importReferenceWithTask({
					projectId, connectorId: 'public-website', connectorVersion: '1', externalId: preview.result.canonicalUrl,
					sourceUri: preview.result.requestedUrl, title: preview.result.title, contentType: preview.result.contentType,
					content: preview.result.content, derivedText: preview.result.derivedText, omissions: preview.result.omissions,
				}, request.taskId);
				this.previews.delete(request.previewId);
				const { content: _content, derivedText: _derivedText, ...dto } = imported;
				return dto satisfies WorkspaceReferenceDTO as T;
			}
			case 'clearPreviews':
				for (const [id, preview] of this.previews) { if (preview.sender === sender && preview.projectId === projectId) { this.previews.delete(id); } }
				return undefined as T;
			default: throw new Error(`Call not found: ${command}`);
		}
	}

	private pruneExpired(): void { for (const [id, preview] of this.previews) { if (preview.expiresAt <= this.now()) { this.previews.delete(id); } } }
	private trackSender(sender: WebContents): void {
		if (this.trackedSenders.has(sender) || typeof sender.once !== 'function') { return; }
		this.trackedSenders.add(sender);
		sender.once('destroyed', () => {
			for (const [id, preview] of this.previews) { if (preview.sender === sender) { this.previews.delete(id); } }
		});
	}
	private projectId(value: unknown): string {
		const projectId = this.record(value).projectId;
		if (typeof projectId !== 'string' || !isUUID(projectId)) { throw new Error('A valid project ID is required.'); }
		return projectId;
	}
	private previewRequest(value: unknown): WorkspaceWebsitePreviewRequest {
		const record = this.record(value);
		if (typeof record.url !== 'string') { throw new Error('A website URL is required.'); }
		return record as unknown as WorkspaceWebsitePreviewRequest;
	}
	private importRequest(value: unknown): WorkspaceWebsiteImportRequest {
		const record = this.record(value);
		if (typeof record.previewId !== 'string' || !isUUID(record.previewId)) { throw new Error('A valid website preview ID is required.'); }
		if (record.taskId !== undefined && (typeof record.taskId !== 'string' || !isUUID(record.taskId))) { throw new Error('A valid task ID is required.'); }
		return record as unknown as WorkspaceWebsiteImportRequest;
	}
	private record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('A website import request is required.'); }
		return value as Record<string, unknown>;
	}
}
