/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export type AgentSessionProvider = 'codex' | 'claude';
export type AgentSessionWorkspaceMode = 'gitWorktree' | 'sharedFolder';
export type AgentSessionState =
	| 'created'
	| 'starting'
	| 'running'
	| 'waitingForInput'
	| 'waitingForApproval'
	| 'idle'
	| 'stopping'
	| 'stopped'
	| 'interrupted'
	| 'failed';

export interface CreateAgentSessionInput {
	readonly projectId: string;
	readonly bindingId: string;
	readonly taskId?: string;
	readonly parentSessionId?: string;
	readonly name: string;
	readonly provider: AgentSessionProvider;
	readonly model: string;
	readonly profileRef?: string;
	readonly workspaceMode: AgentSessionWorkspaceMode;
}

export interface AgentSessionDTO {
	readonly id: string;
	readonly projectId: string;
	readonly bindingId: string;
	readonly taskId: string | null;
	readonly parentSessionId: string | null;
	readonly name: string;
	readonly provider: AgentSessionProvider;
	readonly model: string;
	readonly profileRef: string | null;
	readonly workspaceMode: AgentSessionWorkspaceMode;
	readonly state: AgentSessionState;
	readonly revision: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface SendSessionMessageInput {
	readonly recipientSessionId: string;
	readonly idempotencyKey: string;
	readonly body: string;
}

export interface SessionMessageDTO {
	readonly id: string;
	readonly projectId: string;
	readonly senderSessionId: string;
	readonly recipientSessionId: string;
	readonly sequence: number;
	readonly idempotencyKey: string;
	readonly body: string;
	readonly createdAt: string;
	readonly readAt: string | null;
}

export interface SessionNotificationDTO {
	readonly id: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly sequence: number;
	readonly kind: 'message';
	readonly messageId: string;
	readonly createdAt: string;
	readonly readAt: string | null;
}

export interface SessionPageOptions {
	readonly afterSequence?: number;
	readonly limit?: number;
}
