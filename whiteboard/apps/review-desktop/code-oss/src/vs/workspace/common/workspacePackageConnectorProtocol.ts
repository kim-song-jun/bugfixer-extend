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
}

export interface WorkspacePackageReviewDTO {
	readonly packageId: string;
	readonly version: string;
	readonly name: string;
	readonly description: string;
	readonly fingerprint: string;
	readonly manifestDigest: string;
	readonly domains: readonly string[];
	readonly accountAccess: 'none';
	readonly sources: readonly WorkspacePackageSourceDTO[];
	readonly sourceRules: readonly WorkspacePackageSourceRuleDTO[];
	readonly trustStatus: 'first-install' | 'installed' | 'same-key-update';
}

export interface WorkspaceInstalledPackageDTO extends WorkspacePackageReviewDTO {
	readonly installedAt: string;
	readonly updatedAt: string;
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
}

export interface WorkspacePackagePreviewDTO {
	readonly previewId: string;
	readonly packageId: string;
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
	/** Attach the imported snapshot to this active task in the same database transaction. */
	readonly taskId?: string;
}

export interface WorkspacePackageRefreshRequest extends WorkspacePackageImportRequest {
	/** Latest immutable snapshot selected by the user for this remote source. */
	readonly previousReferenceId: string;
}

export interface WorkspacePackageConnectorOperations {
	readonly listPackages: { readonly request: string; readonly response: readonly WorkspaceInstalledPackageDTO[] };
	readonly reviewPackage: { readonly request: WorkspacePackageReviewRequest; readonly response: WorkspacePackageReviewDTO };
	readonly installPackage: { readonly request: WorkspacePackageInstallRequest; readonly response: WorkspaceInstalledPackageDTO };
	readonly uninstallPackage: { readonly request: WorkspacePackageRequest; readonly response: void };
	readonly previewPackageSource: { readonly request: WorkspacePackageImportRequest; readonly response: WorkspacePackagePreviewDTO };
	readonly importPackagePreview: { readonly request: WorkspacePackagePreviewImportRequest; readonly response: WorkspaceReferenceDTO };
	readonly refreshPackageSource: { readonly request: WorkspacePackageRefreshRequest; readonly response: WorkspaceReferenceDTO };
}
