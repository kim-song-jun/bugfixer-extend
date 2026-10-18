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

export interface WorkspaceAgentSessionWorkspacePreparationDTO {
	readonly projectId: string;
	readonly sessionId: string;
	readonly workspaceMode: AgentSessionWorkspaceMode;
	readonly state: 'ready' | 'needsPreparation' | 'recoveryRequired';
	readonly worktreePath: string | null;
	readonly branch: string | null;
	readonly reason: string | null;
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

export interface AgentSessionPermissionPolicy {
	readonly mode: 'read-only' | 'mutating';
	readonly approval: 'never' | 'on-request' | 'always';
}

export interface AgentSessionFolderIdentity {
	readonly canonicalPath: string;
	readonly dev: string;
	readonly ino: string;
}

export interface AgentSessionKnowledgeRef {
	readonly id: string;
	readonly version: number;
	readonly sha256: string;
}

/** Explicit launch-time allowlist. Secrets, argv, environment and provider account data do not belong here. */
export interface AgentSessionTurnSnapshot {
	readonly schemaVersion: 1;
	readonly projectId: string;
	readonly sessionId: string;
	readonly sessionRevision: number;
	readonly bindingId: string;
	readonly taskId: string | null;
	readonly provider: AgentSessionProvider;
	readonly model: string;
	readonly profileRef: string | null;
	readonly cwd: string;
	readonly folderIdentity: AgentSessionFolderIdentity;
	readonly managedWorktreeOwnerId: string | null;
	readonly permissionPolicy: AgentSessionPermissionPolicy;
	readonly convention: AgentSessionKnowledgeRef | null;
	readonly references: readonly AgentSessionKnowledgeRef[];
}

export type AgentSessionTurnState = 'starting' | 'running' | 'stopping' | 'exited' | 'interrupted' | 'failed';

export interface CreateAgentSessionTurnInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly expectedSessionRevision: number;
	readonly snapshot: AgentSessionTurnSnapshot;
}

export interface AgentSessionTurnDTO {
	readonly id: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly ordinal: number;
	readonly state: AgentSessionTurnState;
	readonly revision: number;
	readonly snapshot: AgentSessionTurnSnapshot;
	readonly snapshotSha256: string;
	readonly providerConversationId: string | null;
	readonly exitCode: number | null;
	readonly exitSignal: string | null;
	readonly errorSummary: string | null;
	readonly cleanupVerified: boolean;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
}

export interface AgentSessionTurnUpdate {
	readonly state: AgentSessionTurnState;
	readonly exitCode?: number | null;
	readonly exitSignal?: string | null;
	readonly errorSummary?: string | null;
	readonly cleanupVerified?: boolean;
}

export interface AgentSessionTurnLifecycleResult {
	readonly turn: AgentSessionTurnDTO;
	readonly session: AgentSessionDTO;
}

export type AgentSessionTranscriptSeverity = 'debug' | 'info' | 'warning' | 'error';
export type AgentSessionTranscriptSource = 'pty' | 'provider' | 'host' | 'workspace';
export type AgentSessionTranscriptReferenceKind = 'task' | 'turn' | 'knowledge' | 'diff';
export interface AgentSessionTranscriptReference {
	readonly kind: AgentSessionTranscriptReferenceKind;
	readonly id: string;
}
/** Text for terminal chunks must already be emitted by the stream's trusted full-output sanitizer. */
export interface AppendAgentSessionTranscriptChunkInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly sequence: number;
	readonly sanitizedTextFromTrustedPtyHost: string;
}
/** Structured event text is sanitized in full by the store using the host's trusted secret set. */
export interface AppendAgentSessionTranscriptLogInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly sequence: number;
	readonly text: string;
	readonly severity: AgentSessionTranscriptSeverity;
	readonly source: AgentSessionTranscriptSource;
	readonly references?: readonly AgentSessionTranscriptReference[];
	readonly trustedKnownSecrets?: readonly string[];
}
export interface AgentSessionTranscriptEntryDTO {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly sequence: number;
	readonly kind: 'terminal' | 'log';
	readonly text: string;
	readonly byteLength: number;
	readonly retained: boolean;
	readonly severity: AgentSessionTranscriptSeverity | null;
	readonly source: AgentSessionTranscriptSource | null;
	readonly references: readonly AgentSessionTranscriptReference[];
	readonly createdAt: string;
}
export interface AgentSessionTranscriptPageOptions {
	readonly afterSequence?: number;
	readonly limit?: number;
	readonly maxOutputBytes?: number;
	readonly kind?: 'terminal' | 'log';
	readonly severity?: AgentSessionTranscriptSeverity;
	readonly source?: AgentSessionTranscriptSource;
}
export interface AgentSessionTranscriptPageDTO {
	readonly entries: readonly AgentSessionTranscriptEntryDTO[];
	readonly nextSequence: number;
	readonly highestSequence: number;
	readonly firstRetainedSequence: number | null;
	readonly gaps: readonly { readonly afterSequence: number; readonly throughSequence: number }[];
	readonly hasMore: boolean;
}

/** Project-window IPC contract. Runtime authority is always derived from the sender's live window. */
export type WorkspaceAgentSessionsCommand =
	| 'listSessions' | 'createSession' | 'workspacePreparation' | 'prepareWorkspace' | 'listTurns' | 'preview' | 'start' | 'stop'
	| 'attach' | 'read' | 'write' | 'resize' | 'disconnect' | 'readTranscript' | 'listNotifications' | 'markNotificationRead';

export interface WorkspaceAgentSessionProjectRequest { readonly projectId: string; }
export type WorkspaceAgentSessionCreateRequest = CreateAgentSessionInput;
export interface WorkspaceAgentSessionItemRequest extends WorkspaceAgentSessionProjectRequest { readonly sessionId: string; }
export interface WorkspaceAgentSessionPreviewRequest extends WorkspaceAgentSessionItemRequest { readonly permissionPolicy: AgentSessionPermissionPolicy; }
export interface WorkspaceAgentSessionStartRequest extends WorkspaceAgentSessionItemRequest { readonly ticketId: string; }
export interface WorkspaceAgentSessionTurnRequest extends WorkspaceAgentSessionItemRequest { readonly turnId: string; }
export interface WorkspaceAgentSessionTranscriptRequest extends WorkspaceAgentSessionTurnRequest { readonly options?: AgentSessionTranscriptPageOptions; }
export interface WorkspaceAgentSessionNotificationsRequest extends WorkspaceAgentSessionProjectRequest { readonly afterSequence?: number; readonly limit?: number; }
export interface WorkspaceAgentSessionNotificationReadRequest extends WorkspaceAgentSessionProjectRequest { readonly notificationId: string; }
export interface WorkspaceAgentSessionAttachRequest extends WorkspaceAgentSessionTurnRequest { readonly afterSequence?: number; }
export interface WorkspaceAgentSessionReadRequest extends WorkspaceAgentSessionTurnRequest {
	readonly attachmentId: string;
	readonly afterSequence: number;
	readonly limit?: number;
}
export interface WorkspaceAgentSessionWriteRequest extends WorkspaceAgentSessionTurnRequest { readonly text: string; }
export interface WorkspaceAgentSessionResizeRequest extends WorkspaceAgentSessionTurnRequest { readonly cols: number; readonly rows: number; }
export interface WorkspaceAgentSessionDisconnectRequest extends WorkspaceAgentSessionTurnRequest { readonly attachmentId: string; }

export interface WorkspaceAgentSessionOutputEvent {
	readonly attachmentId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly chunk: { readonly sequence: number; readonly text: string; readonly gap: boolean };
}

export const WORKSPACE_AGENT_SESSIONS_CHANNEL = 'workspaceAgentSessions';
export const WORKSPACE_AGENT_SESSIONS_OUTPUT_EVENT = 'workspaceAgentSessions/output';
