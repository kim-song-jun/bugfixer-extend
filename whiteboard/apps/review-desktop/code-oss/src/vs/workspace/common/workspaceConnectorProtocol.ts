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
}

export interface WorkspaceConnectorAccountRequest {
	readonly projectId: string;
	readonly accountId: string;
}

export interface ImportSlackConversationRequest extends WorkspaceConnectorAccountRequest {
	readonly channelId: string;
	readonly title?: string;
	/** When present, imports this message and its complete bounded reply thread. */
	readonly messageTs?: string;
}

export interface ImportNotionPageRequest extends WorkspaceConnectorAccountRequest {
	readonly pageId: string;
}

export interface WorkspaceConnectorOperations {
	readonly listAccounts: { readonly request: string; readonly response: readonly WorkspaceConnectorAccountDTO[] };
	readonly connectAccount: { readonly request: ConnectWorkspaceConnectorRequest; readonly response: WorkspaceConnectorAccountDTO };
	readonly disconnectAccount: { readonly request: WorkspaceConnectorAccountRequest; readonly response: void };
	readonly retryAccountCleanup: { readonly request: WorkspaceConnectorAccountRequest; readonly response: void };
	readonly importSlackConversation: { readonly request: ImportSlackConversationRequest; readonly response: WorkspaceReferenceDTO };
	readonly importNotionPage: { readonly request: ImportNotionPageRequest; readonly response: WorkspaceReferenceDTO };
}
