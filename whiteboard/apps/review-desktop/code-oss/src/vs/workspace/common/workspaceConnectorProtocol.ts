/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WorkspaceReferenceDTO } from './workspaceKnowledgeProtocol.js';

export const WORKSPACE_CONNECTOR_CHANNEL = 'vscode:workspaceConnectors';

export type WorkspaceConnectorId = 'slack' | 'notion';

export interface WorkspaceConnectorAccountDTO {
	readonly id: string;
	readonly projectId: string;
	readonly provider: WorkspaceConnectorId;
	readonly label: string;
	readonly remoteIdentity: string;
	readonly state: 'pending' | 'active' | 'disconnecting';
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface ConnectWorkspaceConnectorRequest {
	readonly projectId: string;
	readonly provider: WorkspaceConnectorId;
	readonly token: string;
	/** Required for Notion so multiple personal tokens for the same identity remain distinguishable. */
	readonly accountLabel?: string;
}

export interface WorkspaceConnectorAccountRequest {
	readonly projectId: string;
	readonly accountId: string;
}

export interface PreviewSlackConversationRequest extends WorkspaceConnectorAccountRequest {
	readonly channelId: string;
	readonly title?: string;
	/** When present, previews this message and its complete bounded reply thread. */
	readonly messageTs?: string;
}

export interface PreviewNotionPageRequest extends WorkspaceConnectorAccountRequest {
	readonly pageId: string;
}

/** Content safe to render for review; raw source bytes and credentials stay in electron-main. */
export interface WorkspaceConnectorPreviewDTO {
	readonly previewId: string;
	readonly connectorId: WorkspaceConnectorId;
	readonly externalId: string;
	readonly sourceUri: string;
	readonly title: string;
	readonly contentSha256: string;
	readonly derivedText: string;
	readonly omissions: readonly string[];
	readonly expiresAt: string;
}

export interface ImportConnectorPreviewRequest extends WorkspaceConnectorAccountRequest {
	readonly previewId: string;
	readonly taskId?: string;
}

export interface WorkspaceConnectorOperations {
	readonly listAccounts: { readonly request: string; readonly response: readonly WorkspaceConnectorAccountDTO[] };
	readonly connectAccount: { readonly request: ConnectWorkspaceConnectorRequest; readonly response: WorkspaceConnectorAccountDTO };
	readonly disconnectAccount: { readonly request: WorkspaceConnectorAccountRequest; readonly response: void };
	readonly retryAccountCleanup: { readonly request: WorkspaceConnectorAccountRequest; readonly response: void };
	readonly clearPreviews: { readonly request: { readonly projectId: string }; readonly response: void };
	readonly previewSlackConversation: { readonly request: PreviewSlackConversationRequest; readonly response: WorkspaceConnectorPreviewDTO };
	readonly previewNotionPage: { readonly request: PreviewNotionPageRequest; readonly response: WorkspaceConnectorPreviewDTO };
	readonly importPreview: { readonly request: ImportConnectorPreviewRequest; readonly response: WorkspaceReferenceDTO };
}
