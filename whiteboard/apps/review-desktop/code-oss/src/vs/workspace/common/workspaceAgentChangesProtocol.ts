/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Browser-safe, read-only views of retained per-turn file change evidence. */
export type WorkspaceAgentChangeKind = 'created' | 'modified' | 'deleted' | 'renamed' | 'typeChanged' | 'symlinkChanged';

export interface WorkspaceAgentChangeFileObservation {
	readonly path: string;
	readonly change: WorkspaceAgentChangeKind;
	readonly previousPath?: string;
	readonly before: { readonly kind: 'file' | 'directory' | 'symlink' | 'special'; readonly size?: number; readonly sha256?: string; readonly targetSha256?: string } | null;
	readonly after: { readonly kind: 'file' | 'directory' | 'symlink' | 'special'; readonly size?: number; readonly sha256?: string; readonly targetSha256?: string } | null;
}

export interface WorkspaceAgentChangeEvidenceDTO {
	readonly id: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly version: number;
	readonly fingerprint: string;
	readonly turnSnapshotSha256: string;
	readonly source: 'ordinaryFolder' | 'managedWorktree';
	readonly folderIdentity: { readonly canonicalPath: string; readonly dev: string; readonly ino: string };
	readonly managedWorktreeOwnerId: string | null;
	readonly capturedAt: string;
	readonly beforeRevision: string | null;
	readonly afterRevision: string | null;
	readonly status: 'observed' | 'unverified';
	readonly coverage: 'complete' | 'partial';
	readonly noChangesConfirmed: boolean;
	readonly missingReason: string | null;
	readonly attribution: 'unknown' | 'mixed';
	readonly attributionNote: string | null;
	readonly files: readonly WorkspaceAgentChangeFileObservation[];
	readonly createdAt: string;
}

export interface WorkspaceAgentChangeEvidencePageDTO {
	readonly snapshots: readonly WorkspaceAgentChangeEvidenceDTO[];
	readonly nextVersion: number;
	readonly hasMore: boolean;
}

export interface WorkspaceAgentChangeFileDTO {
	readonly scope: { readonly projectId: string; readonly sessionId: string; readonly turnId: string };
	readonly evidenceVersion: number;
	readonly path: string;
	readonly evidenceFingerprint: string;
	readonly before: WorkspaceAgentChangeFileSideDTO;
	readonly after: WorkspaceAgentChangeFileSideDTO;
}

export type WorkspaceAgentChangeFileSideDTO =
	| { readonly state: 'absent' }
	| { readonly state: 'text'; readonly file: WorkspaceAgentChangeTextFileDTO }
	| { readonly state: 'unavailable'; readonly file?: WorkspaceAgentChangeFileMetadataDTO; readonly reason: string };

export interface WorkspaceAgentChangeFileMetadataDTO {
	readonly path: string;
	readonly kind: 'file' | 'directory' | 'symlink' | 'special';
	readonly size: number;
	readonly sha256: string;
	readonly contentUnavailableReason?: 'fileTooLarge' | 'contentFileLimit' | 'retainedTextLimit' | 'binary' | 'invalidUtf8';
}

export interface WorkspaceAgentChangeTextFileDTO extends WorkspaceAgentChangeFileMetadataDTO {
	readonly content: string;
}
