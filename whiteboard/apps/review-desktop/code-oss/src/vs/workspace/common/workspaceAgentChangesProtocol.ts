/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Browser-safe DTOs for retained per-turn change evidence and human-authored explanation records. */
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

export interface WorkspaceAgentChangeHunkRangeDTO {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

export interface WorkspaceAgentChangeHunkDTO {
	readonly id: string;
	readonly originalStartLineNumber: number;
	readonly originalEndLineNumberExclusive: number;
	readonly modifiedStartLineNumber: number;
	readonly modifiedEndLineNumberExclusive: number;
	readonly ranges: readonly { readonly original: WorkspaceAgentChangeHunkRangeDTO; readonly modified: WorkspaceAgentChangeHunkRangeDTO }[];
}

export type WorkspaceAgentChangeHunkFileStateDTO =
	| { readonly state: 'absent'; readonly sha256: null }
	| { readonly state: 'text'; readonly sha256: string }
	| { readonly state: 'unavailable'; readonly sha256: string | null; readonly reason: string };

export interface WorkspaceAgentChangeHunksDTO {
	readonly scope: { readonly projectId: string; readonly sessionId: string; readonly turnId: string };
	readonly evidenceVersion: number;
	readonly evidenceFingerprint: string;
	readonly path: string;
	readonly before: WorkspaceAgentChangeHunkFileStateDTO;
	readonly after: WorkspaceAgentChangeHunkFileStateDTO;
	readonly status: 'hunks' | 'noTextChange' | 'eolOnly' | 'presenceChanged' | 'unavailable' | 'partial';
	readonly hunks: readonly WorkspaceAgentChangeHunkDTO[];
	readonly truncated: boolean;
	readonly timedOut: boolean;
	readonly unavailableReason: string | null;
}

export interface WorkspaceAgentExplanationTargetDTO {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly evidenceVersion: number;
	readonly evidenceFingerprint: string;
	readonly path: string;
	readonly hunkId: string | null;
}

export interface WorkspaceAgentExplanationCitationDTO {
	readonly kind: 'reference' | 'convention';
	readonly id: string;
	readonly version: number;
	readonly sha256: string;
}

export interface WorkspaceAgentReportedCheckDTO {
	readonly label: string;
	readonly outcome: 'reportedPass' | 'reportedFail' | 'notRun';
	readonly detail?: string;
}

export interface WorkspaceAgentExplanationDTO {
	readonly id: string;
	readonly target: WorkspaceAgentExplanationTargetDTO;
	readonly revision: number;
	readonly turnSnapshotSha256: string;
	readonly actor: 'agent' | 'human';
	readonly authorTurnId: string | null;
	readonly status: 'draft' | 'confirmed';
	readonly what: string;
	readonly why: string;
	readonly citations: readonly WorkspaceAgentExplanationCitationDTO[];
	readonly grounding: 'linked' | 'unlinked';
	readonly checkClaims: readonly WorkspaceAgentReportedCheckDTO[];
	readonly verification: 'unverified';
	readonly createdAt: string;
}

export interface WorkspaceAgentExplanationPageDTO {
	readonly revisions: readonly WorkspaceAgentExplanationDTO[];
	readonly nextRevision: number;
	readonly hasMore: boolean;
}
