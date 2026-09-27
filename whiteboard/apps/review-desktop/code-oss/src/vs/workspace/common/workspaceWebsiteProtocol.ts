/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WorkspaceReferenceDTO } from './workspaceKnowledgeProtocol.js';

export const WORKSPACE_WEBSITE_CHANNEL = 'vscode:workspaceWebsite';

export interface WorkspaceWebsitePreviewDTO {
	readonly previewId: string;
	/** Canonical URL the user submitted, before any redirects. */
	readonly requestedUri: string;
	/** Canonical final URL that supplied the reviewed page. */
	readonly sourceUri: string;
	readonly title: string;
	readonly contentType: string;
	readonly derivedText: string;
	readonly contentSha256: string;
	readonly omissions: readonly string[];
	readonly expiresAt: string;
}

export interface WorkspaceWebsitePreviewRequest {
	readonly projectId: string;
	readonly url: string;
}

export interface WorkspaceWebsiteImportRequest {
	readonly projectId: string;
	readonly previewId: string;
	readonly taskId?: string;
}

export interface WorkspaceWebsiteProjectRequest { readonly projectId: string; }

export interface WorkspaceWebsiteOperations {
	readonly previewPage: { readonly request: WorkspaceWebsitePreviewRequest; readonly response: WorkspaceWebsitePreviewDTO };
	readonly importPreview: { readonly request: WorkspaceWebsiteImportRequest; readonly response: WorkspaceReferenceDTO };
	readonly clearPreviews: { readonly request: WorkspaceWebsiteProjectRequest; readonly response: void };
}
