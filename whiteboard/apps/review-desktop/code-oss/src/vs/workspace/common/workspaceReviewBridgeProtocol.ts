/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export const WORKSPACE_REVIEW_BRIDGE_CHANNEL = 'vscode:workspaceReviewBridge';

export interface WorkspaceTaskReviewLink {
	readonly taskId: string;
	readonly reviewId: string;
	readonly state: 'available' | 'unavailable';
	readonly isPrimary: boolean;
	readonly createdAt: string;
}

export interface CreateTaskReviewRequest {
	readonly projectId: string;
	readonly taskId: string;
	/** Generated once by the caller and reused after transport failures. */
	readonly commandId: string;
}

export interface TaskReviewListRequest {
	readonly projectId: string;
	readonly taskId: string;
}

export interface ChoosePrimaryTaskReviewRequest extends TaskReviewListRequest {
	readonly reviewId: string;
	readonly expectedRevision: number;
}

export interface TaskReviewOpenResult {
	readonly reviewId: string;
	/** Immutable Review snapshot version verified against this task's current repository. */
	readonly version: number;
	readonly title: string;
}

export type WorkspaceReviewBridgeCommand = 'createTaskReview' | 'listTaskReviews' | 'choosePrimaryReview' | 'openTaskReview';

export interface TaskReviewAvailability {
	readonly state: 'available' | 'unavailable';
	/** Present when the host or a link check could not be completed. */
	readonly error?: string;
	readonly reviews: readonly WorkspaceTaskReviewLink[];
	/** Durable creates awaiting a verified Review receipt; retry with the same command ID. */
	readonly pendingCreates: readonly {
		readonly commandId: string;
		readonly status: 'pending' | 'failed';
		readonly lastError: string | null;
		readonly createdAt: string;
	}[];
}
