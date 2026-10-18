/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSessionPermissionPolicy, AgentSessionProvider } from './workspaceAgentSessionProtocol.js';

/** Roles are app-owned labels. Provider-native helper processes are never represented as workflow sessions. */
export type AgentWorkflowRole = 'coordinator' | 'implementer' | 'reviewer' | 'researcher' | 'tester';
export type AgentWorkflowReference =
	| { readonly kind: 'knowledgeSnapshot'; readonly id: string }
	| { readonly kind: 'conventionVersion'; readonly id: string };

export interface AgentWorkflowNodePlan {
	/** Stable, plan-local identity; distinct from the persisted app session ID. */
	readonly nodeId: string;
	readonly sessionId: string;
	readonly role: AgentWorkflowRole;
	readonly provider: AgentSessionProvider;
	readonly model: string;
	readonly taskId: string | null;
	readonly bindingId: string;
	readonly referenceIds: readonly AgentWorkflowReference[];
	readonly permissionPolicy: AgentSessionPermissionPolicy;
	readonly dependsOn: readonly string[];
}

export interface AgentWorkflowPlanInput {
	readonly projectId: string;
	readonly bindingId: string;
	readonly taskId: string | null;
	readonly maxConcurrentNodes: number;
	readonly maxTotalTurns: number;
	readonly maxDurationMs: number;
	readonly nodes: readonly AgentWorkflowNodePlan[];
}

export interface AgentWorkflowPlan extends AgentWorkflowPlanInput {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly version: number;
	readonly fingerprint: string;
	readonly createdAt: string;
}

export type AgentWorkflowState =
	| 'waiting' | 'ready' | 'running' | 'cancelRequested' | 'succeeded' | 'failed'
	| 'cancelled' | 'blocked' | 'interrupted' | 'recoveryRequired';
export type AgentWorkflowNodeState = Exclude<AgentWorkflowState, 'waiting'> | 'waiting' | 'launching';

export interface AgentWorkflowDTO {
	readonly id: string;
	readonly projectId: string;
	readonly bindingId: string;
	readonly taskId: string | null;
	readonly revision: number;
	readonly state: AgentWorkflowState;
	readonly planVersion: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface AgentWorkflowApprovalReceipt {
	readonly id: string;
	readonly projectId: string;
	readonly workflowId: string;
	readonly planVersion: number;
	readonly fingerprint: string;
	readonly idempotencyKey: string;
	readonly approvedAt: string;
}

export interface AgentWorkflowNodeExecutionDTO {
	readonly workflowId: string;
	readonly runId: string;
	readonly nodeId: string;
	readonly sessionId: string;
	readonly sessionTurnId: string | null;
	readonly state: AgentWorkflowNodeState;
	readonly revision: number;
	readonly cancelRequestedAt: string | null;
	readonly updatedAt: string;
}

export interface AgentWorkflowRunDTO {
	readonly id: string;
	readonly projectId: string;
	readonly workflowId: string;
	readonly planVersion: number;
	readonly fingerprint: string;
	readonly idempotencyKey: string;
	readonly revision: number;
	readonly state: AgentWorkflowState;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly deadlineAt: string;
	readonly nodes: readonly AgentWorkflowNodeExecutionDTO[];
}

export interface CreateAgentWorkflowInput extends AgentWorkflowPlanInput {
	/** Host-generated retry key. A retry with changed content is rejected. */
	readonly idempotencyKey: string;
}

