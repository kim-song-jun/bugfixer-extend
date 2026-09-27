/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WorkspaceReferenceDTO } from './workspaceKnowledgeProtocol.js';

export const WORKSPACE_PACKAGE_CONNECTOR_CHANNEL = 'vscode:workspacePackageConnectors';

export interface WorkspaceSignedPackageEnvelope {
	readonly manifestBytesBase64: string;
	readonly signatureBase64: string;
	readonly publicKeyBase64: string;
}

export interface WorkspacePackageSourceDTO {
	readonly sourceId: string;
	readonly label: string;
}

export interface WorkspacePackageSourceRuleDTO extends WorkspacePackageSourceDTO {
	readonly domain: string;
	readonly method: 'GET';
	readonly path: string;
	readonly fields: readonly string[];
	readonly paginated: boolean;
	readonly requiredScope?: string;
}

export interface WorkspacePackageReviewDTO {
	readonly packageId: string;
	readonly version: string;
	readonly name: string;
	readonly description: string;
	readonly fingerprint: string;
	readonly manifestDigest: string;
	readonly domains: readonly string[];
	readonly accountAccess: 'none' | 'bearer-token';
	readonly requestedScopes: readonly string[];
	readonly sources: readonly WorkspacePackageSourceDTO[];
	readonly sourceRules: readonly WorkspacePackageSourceRuleDTO[];
	readonly trustStatus: 'first-install' | 'installed' | 'same-key-update';
}

export interface WorkspaceInstalledPackageDTO extends WorkspacePackageReviewDTO {
	readonly installedAt: string;
	readonly updatedAt: string;
}

export interface WorkspacePackageConnectionDTO {
	readonly connectionId: string;
	readonly accountRef: string;
	readonly projectId: string;
	readonly packageId: string;
	readonly manifestDigest: string;
	readonly host: string;
	readonly grantedScopes: readonly string[];
	readonly label: string;
	readonly authKind: 'none' | 'bearer-token';
	readonly state: 'pending' | 'active' | 'disconnecting' | 'disconnected';
}

export type WorkspacePackageConnectionListRequest = WorkspacePackageRequest;

export interface WorkspacePackageConnectionRequest extends WorkspacePackageRequest {
	readonly host: string;
	readonly label: string;
	readonly credential: string;
	readonly grantedScopes: readonly string[];
}

export interface WorkspacePackageConnectionActionRequest extends WorkspacePackageRequest {
	readonly connectionId: string;
}

export interface WorkspacePackageApproval {
	readonly packageId: string;
	readonly version: string;
	readonly fingerprint: string;
	readonly manifestDigest: string;
}

export interface WorkspacePackageReviewRequest {
	readonly projectId: string;
	readonly envelope: WorkspaceSignedPackageEnvelope;
}

export interface WorkspacePackageInstallRequest extends WorkspacePackageReviewRequest {
	readonly approval: WorkspacePackageApproval;
}

export interface WorkspacePackageRequest {
	readonly projectId: string;
	readonly packageId: string;
}

export interface WorkspacePackageImportRequest extends WorkspacePackageRequest {
	readonly sourceId: string;
	readonly sourceKey: string;
	readonly connectionId: string;
}

export interface WorkspacePackagePreviewDTO {
	readonly previewId: string;
	readonly packageId: string;
	readonly accountRef: string;
	readonly sourceId: string;
	readonly sourceKey: string;
	readonly connectorVersion: string;
	readonly externalId: string;
	readonly sourceUri: string;
	readonly title: string;
	readonly contentSha256: string;
	readonly content: string;
	readonly omissions: readonly string[];
	readonly expiresAt: string;
}

export interface WorkspacePackagePreviewImportRequest extends WorkspacePackageRequest {
	readonly previewId: string;
	readonly connectionId: string;
	/** Attach the imported snapshot to this active task in the same database transaction. */
	readonly taskId?: string;
}

export interface WorkspacePackageRefreshRequest extends WorkspacePackageImportRequest {
	/** Latest immutable snapshot selected by the user for this remote source. */
	readonly previousReferenceId: string;
}

export interface WorkspacePackageConnectorOperations {
	readonly listPackages: { readonly request: string; readonly response: readonly WorkspaceInstalledPackageDTO[] };
	readonly listPackageConnections: { readonly request: WorkspacePackageConnectionListRequest; readonly response: readonly WorkspacePackageConnectionDTO[] };
	readonly connectPackageConnection: { readonly request: WorkspacePackageConnectionRequest; readonly response: WorkspacePackageConnectionDTO };
	readonly disconnectPackageConnection: { readonly request: WorkspacePackageConnectionActionRequest; readonly response: WorkspacePackageConnectionDTO };
	readonly retryPackageConnectionCleanup: { readonly request: WorkspacePackageConnectionActionRequest; readonly response: WorkspacePackageConnectionDTO };
	readonly reviewPackage: { readonly request: WorkspacePackageReviewRequest; readonly response: WorkspacePackageReviewDTO };
	readonly installPackage: { readonly request: WorkspacePackageInstallRequest; readonly response: WorkspaceInstalledPackageDTO };
	readonly uninstallPackage: { readonly request: WorkspacePackageRequest; readonly response: void };
	readonly previewPackageSource: { readonly request: WorkspacePackageImportRequest; readonly response: WorkspacePackagePreviewDTO };
	readonly importPackagePreview: { readonly request: WorkspacePackagePreviewImportRequest; readonly response: WorkspaceReferenceDTO };
	readonly refreshPackageSource: { readonly request: WorkspacePackageRefreshRequest; readonly response: WorkspaceReferenceDTO };
}
