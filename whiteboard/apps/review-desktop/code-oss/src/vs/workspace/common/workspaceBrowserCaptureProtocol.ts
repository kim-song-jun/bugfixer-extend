/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WorkspaceReferenceDTO } from './workspaceKnowledgeProtocol.js';

export const WORKSPACE_EGO_CAPTURE_CHANNEL = 'vscode:workspaceEgoCapture';

export interface StartWorkspaceEgoCaptureRequest {
	readonly projectId: string;
	readonly taskId: string;
	readonly url: string;
}


export interface WorkspaceEgoCaptureRequest {
	readonly projectId: string;
	readonly taskId: string;
	readonly captureId: string;
}

export interface WorkspaceEgoCaptureRecoveryRequest {
	readonly projectId: string;
}

export type WorkspaceEgoCaptureRecoveryStatus =
	| { readonly state: 'none' }
	| { readonly state: 'handoff'; readonly captureId: string; readonly taskId: string; readonly cleanupPending: boolean };

export type WorkspaceEgoCaptureStatus =
	| { readonly state: 'handoff'; readonly captureId: string }
	| { readonly state: 'captured'; readonly captureId: string; readonly reference: WorkspaceReferenceDTO }
	| { readonly state: 'cancelled'; readonly captureId: string }
	| { readonly state: 'failed'; readonly captureId: string; readonly message: string };

export interface WorkspaceEgoSelectedText {
	/** Exact text the user selected and explicitly confirmed in Ego. */
	readonly text: string;
	readonly url: string;
	readonly title: string;
}

export interface WorkspaceEgoCaptureOperations {
	readonly startCapture: { readonly request: StartWorkspaceEgoCaptureRequest; readonly response: WorkspaceEgoCaptureStatus };
	readonly getActiveCapture: { readonly request: WorkspaceEgoCaptureRecoveryRequest; readonly response: WorkspaceEgoCaptureRecoveryStatus };
	readonly captureSelection: { readonly request: WorkspaceEgoCaptureRequest; readonly response: WorkspaceEgoCaptureStatus };
	readonly cancelCapture: { readonly request: WorkspaceEgoCaptureRequest; readonly response: WorkspaceEgoCaptureStatus };
}
