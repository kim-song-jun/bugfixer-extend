/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSessionPermissionPolicy } from './workspaceAgentSessionProtocol.js';

export type AgentSessionControlRequestKind = 'start' | 'stop';
export type AgentSessionControlRequestState =
	| 'pendingReview' | 'starting' | 'started' | 'startFailed' | 'rejected' | 'cancelled' | 'interrupted'
	| 'stopAccepted' | 'stopCompleted' | 'stopUnverified' | 'stopFailed';

export interface AgentSessionControlWorkflowAuthority {
	readonly workflowId: string;
	readonly planVersion: number;
	readonly fingerprint: string;
	readonly runId: string;
	readonly approvalId: string;
	readonly allowedSessionIds: readonly string[];
}

export interface AgentSessionControlRequestDTO {
	readonly id: string;
	readonly projectId: string;
	readonly kind: AgentSessionControlRequestKind;
	readonly state: AgentSessionControlRequestState;
	readonly revision: number;
	readonly callerSessionId: string;
	readonly callerTurnId: string;
	readonly targetSessionId: string;
	readonly targetTurnId: string | null;
	readonly expectedSessionRevision: number | null;
	readonly permissionPolicy: AgentSessionPermissionPolicy | null;
	readonly reason: string | null;
	readonly workflowAuthority: AgentSessionControlWorkflowAuthority | null;
	readonly snapshotFingerprint: string | null;
	readonly approvedIdempotencyKey: string | null;
	readonly resultTurnId: string | null;
	readonly targetTurnState: 'starting' | 'running' | 'stopping' | 'exited' | 'interrupted' | 'failed' | null;
	readonly error: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface AgentSessionControlRequestPageOptions {
	readonly afterCreatedAt?: string;
	readonly afterId?: string;
	readonly limit?: number;
	readonly state?: AgentSessionControlRequestState;
}

export interface WorkspaceAgentSessionControlPageDTO {
	readonly requests: readonly AgentSessionControlRequestDTO[];
	readonly nextCursor: { readonly createdAt: string; readonly id: string } | null;
	readonly hasMore: boolean;
	readonly hostError: string | null;
}
