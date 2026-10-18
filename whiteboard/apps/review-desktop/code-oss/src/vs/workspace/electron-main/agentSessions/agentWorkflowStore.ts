/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import type {
	AgentWorkflowApprovalReceipt, AgentWorkflowDTO, AgentWorkflowNodeExecutionDTO, AgentWorkflowNodePlan,
	AgentWorkflowNodeState, AgentWorkflowPlan, AgentWorkflowPlanInput, AgentWorkflowReference, AgentWorkflowRole,
	AgentWorkflowRunDTO, AgentWorkflowState, CreateAgentWorkflowInput,
} from '../../common/workspaceAgentWorkflowProtocol.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const NODE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const ROLES = new Set<AgentWorkflowRole>(['coordinator', 'implementer', 'reviewer', 'researcher', 'tester']);
const MAX_CONCURRENCY = 8;
const MAX_TOTAL_TURNS = 64;
const MAX_DURATION_MS = 7_200_000;
const MAX_NODES = 64;
const MAX_PLAN_BYTES = 65_536;
const MAX_SOURCE_EVENT_BYTES = 4096;

type WorkflowRow = Record<string, SQLOutputValue>;
type WorkflowCore = Omit<AgentWorkflowPlanInput, 'nodes'> & { readonly nodes: readonly AgentWorkflowNodePlan[] };

/** Durable finite-plan records only. This store does not launch providers or own their processes. */
export class AgentWorkflowStore {
	constructor(private readonly db: DatabaseSync, private readonly assertOpen: () => void) {
		this.recoverUnverifiableRunsAfterRestart();
	}

	createWorkflow(projectId: string, input: CreateAgentWorkflowInput): AgentWorkflowDTO {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateIdempotencyKey(input.idempotencyKey);
		if (input.projectId !== projectId) { throw new Error('The plan project ID must match the owning project.'); }
		const now = new Date().toISOString();
		return this.transaction(() => {
			const retryCore = this.validatePlanCore(projectId, input, true);
			const fingerprint = this.fingerprint(retryCore);
			const prior = this.db.prepare(`SELECT id, project_id, binding_id, task_id, plan_version, revision, state, created_at, updated_at
				FROM agent_workflows WHERE project_id = ? AND create_idempotency_key = ?`).get(projectId, input.idempotencyKey);
			if (prior) {
				const workflow = this.workflowFromRow(prior);
				const plan = this.getPlanInternal(projectId, workflow.id, workflow.planVersion);
				if (plan?.fingerprint !== fingerprint) { throw new Error('The workflow creation idempotency key was already used for a different plan.'); }
				return workflow;
			}
			const core = this.validatePlanCore(projectId, input);
			const id = randomUUID();
			const plan = this.planWithMetadata(id, 1, core, fingerprint, now);
			this.db.prepare(`INSERT INTO agent_workflows
				(id, project_id, binding_id, task_id, create_idempotency_key, plan_version, revision, state, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, 1, 1, 'waiting', ?, ?)`).run(id, projectId, core.bindingId, core.taskId, input.idempotencyKey, now, now);
			this.insertPlan(plan);
			return this.getWorkflowInternal(projectId, id)!;
		});
	}

	getWorkflow(projectId: string, workflowId: string): AgentWorkflowDTO | undefined {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(workflowId, 'workflow ID');
		return this.getWorkflowInternal(projectId, workflowId);
	}

	getPlan(projectId: string, workflowId: string, version?: number): AgentWorkflowPlan | undefined {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(workflowId, 'workflow ID');
		const workflow = this.getWorkflowInternal(projectId, workflowId);
		if (!workflow) { return undefined; }
		const selectedVersion = version ?? workflow.planVersion;
		if (!Number.isSafeInteger(selectedVersion) || selectedVersion < 1) { throw new Error('The workflow plan version is invalid.'); }
		return this.getPlanInternal(projectId, workflowId, selectedVersion);
	}

	getRun(projectId: string, workflowId: string, runId: string): AgentWorkflowRunDTO | undefined {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(workflowId, 'workflow ID');
		this.validateUuid(runId, 'workflow run ID');
		return this.getRunInternal(projectId, workflowId, runId);
	}

	reviseWorkflowPlan(projectId: string, workflowId: string, expectedRevision: number, input: AgentWorkflowPlanInput): AgentWorkflowDTO {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(workflowId, 'workflow ID');
		this.validateExpectedRevision(expectedRevision);
		if (input.projectId !== projectId) { throw new Error('The plan project ID must match the owning project.'); }
		const core = this.validatePlanCore(projectId, input);
		const fingerprint = this.fingerprint(core);
		const now = new Date().toISOString();
		return this.transaction(() => {
			const current = this.getWorkflowInternal(projectId, workflowId);
			if (!current) { throw new Error('The workflow does not belong to this project.'); }
			if (current.revision !== expectedRevision) { throw new Error('The workflow revision is stale.'); }
			if (core.bindingId !== current.bindingId || core.taskId !== current.taskId) { throw new Error('A workflow plan revision cannot expand its project, binding, or task scope.'); }
			if (this.hasUnfinishedRun(workflowId)) { throw new Error('A workflow plan cannot change while a run needs execution or recovery.'); }
			const version = current.planVersion + 1;
			const plan = this.planWithMetadata(workflowId, version, core, fingerprint, now);
			this.insertPlan(plan);
			const result = this.db.prepare(`UPDATE agent_workflows SET plan_version = ?, state = 'waiting', revision = revision + 1, updated_at = ?
				WHERE id = ? AND project_id = ? AND revision = ?`).run(version, now, workflowId, projectId, expectedRevision);
			if (Number(result.changes) !== 1) { throw new Error('The workflow revision is stale.'); }
			return this.getWorkflowInternal(projectId, workflowId)!;
		});
	}

	/** Must be invoked only by the trusted UI approval path; no MCP or provider-facing API should call it. */
	recordTrustedUiApproval(projectId: string, workflowId: string, planVersion: number, fingerprint: string, idempotencyKey: string): AgentWorkflowApprovalReceipt {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(workflowId, 'workflow ID');
		this.validateIdempotencyKey(idempotencyKey);
		if (!Number.isSafeInteger(planVersion) || planVersion < 1 || typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) { throw new Error('The approval must identify one exact workflow plan version and fingerprint.'); }
		return this.transaction(() => {
			const previous = this.db.prepare(`SELECT id, project_id, workflow_id, plan_version, fingerprint, idempotency_key, approved_at
				FROM agent_workflow_approvals WHERE workflow_id = ? AND idempotency_key = ?`).get(workflowId, idempotencyKey);
			if (previous) {
				if (String(previous.project_id) !== projectId || Number(previous.plan_version) !== planVersion || String(previous.fingerprint) !== fingerprint) {
					throw new Error('The approval idempotency key was already used for a different plan fingerprint.');
				}
				return this.approvalFromRow(previous);
			}
			const workflow = this.getWorkflowInternal(projectId, workflowId);
			if (!workflow || workflow.planVersion !== planVersion) { throw new Error('Approval is only valid for the current workflow plan version.'); }
			if (workflow.state !== 'waiting' && workflow.state !== 'ready') { throw new Error('Workflow approval is available only before the workflow run begins.'); }
			const plan = this.getPlanInternal(projectId, workflowId, planVersion);
			if (!plan || plan.fingerprint !== fingerprint) { throw new Error('The workflow plan changed after review; review the current fingerprint before approval.'); }
			const sameApproval = this.db.prepare(`SELECT id, project_id, workflow_id, plan_version, fingerprint, idempotency_key, approved_at
				FROM agent_workflow_approvals WHERE workflow_id = ? AND project_id = ? AND plan_version = ? AND fingerprint = ?`).get(workflowId, projectId, planVersion, fingerprint);
			if (sameApproval) { return this.approvalFromRow(sameApproval); }
			const id = randomUUID();
			const approvedAt = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_workflow_approvals
				(id, workflow_id, project_id, plan_version, fingerprint, idempotency_key, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
				.run(id, workflowId, projectId, planVersion, fingerprint, idempotencyKey, approvedAt);
			if (workflow.state === 'waiting') {
				const result = this.db.prepare(`UPDATE agent_workflows SET state = 'ready', revision = revision + 1, updated_at = ?
					WHERE id = ? AND project_id = ? AND revision = ?`).run(approvedAt, workflowId, projectId, workflow.revision);
				if (Number(result.changes) !== 1) { throw new Error('The workflow revision is stale.'); }
			}
			return this.getApprovalInternal(workflowId, id)!;
		});
	}

	/** Records an accepted start request as ready work. Provider turns remain unstarted until a host runtime does so. */
	startWorkflow(projectId: string, workflowId: string, expectedRevision: number, idempotencyKey: string): AgentWorkflowRunDTO {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(workflowId, 'workflow ID');
		this.validateExpectedRevision(expectedRevision);
		this.validateIdempotencyKey(idempotencyKey);
		return this.transaction(() => {
			const workflow = this.getWorkflowInternal(projectId, workflowId);
			if (!workflow) { throw new Error('The workflow does not belong to this project.'); }
			const plan = this.getPlanInternal(projectId, workflowId, workflow.planVersion);
			if (!plan) { throw new Error('The current workflow plan is unavailable.'); }
			const requestFingerprint = this.fingerprint({ planVersion: plan.version, fingerprint: plan.fingerprint });
			const receipt = this.getOperationReceipt(workflowId, 'start', idempotencyKey);
			if (receipt) {
				if (String(receipt.request_fingerprint) !== requestFingerprint) { throw new Error('The start idempotency key was already used for a different plan.'); }
				return this.getRunInternal(projectId, workflowId, String(JSON.parse(String(receipt.result_json)).runId))!;
			}
			if (workflow.revision !== expectedRevision) { throw new Error('The workflow revision is stale.'); }
			if (workflow.state !== 'ready' || !this.hasApproval(workflowId, projectId, plan.version, plan.fingerprint)) { throw new Error('The exact current workflow plan must be approved before start.'); }
			if (this.hasUnfinishedRun(workflowId)) { throw new Error('The workflow already has a run requiring execution or recovery.'); }
			const runId = randomUUID();
			const now = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_workflow_runs
				(id, workflow_id, project_id, plan_version, fingerprint, idempotency_key, revision, state, deadline_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, 1, 'ready', ?, ?, ?)`)
				.run(runId, workflowId, projectId, plan.version, plan.fingerprint, idempotencyKey, new Date(Date.parse(now) + plan.maxDurationMs).toISOString(), now, now);
			for (const node of plan.nodes) {
				const state = node.dependsOn.length === 0 ? 'ready' : 'waiting';
				this.db.prepare(`INSERT INTO agent_workflow_run_nodes
					(workflow_id, project_id, run_id, node_id, session_id, state, revision, cancel_requested_at, session_turn_id, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?)`).run(workflowId, projectId, runId, node.nodeId, node.sessionId, state, now);
			}
			this.insertOperationReceipt(workflowId, projectId, 'start', idempotencyKey, requestFingerprint, { runId, planVersion: plan.version, fingerprint: plan.fingerprint }, now);
			return this.getRunInternal(projectId, workflowId, runId)!;
		});
	}

	requestWorkflowCancellation(projectId: string, workflowId: string, expectedRevision: number, idempotencyKey: string): AgentWorkflowDTO {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(workflowId, 'workflow ID');
		this.validateExpectedRevision(expectedRevision);
		this.validateIdempotencyKey(idempotencyKey);
		return this.transaction(() => {
			const workflow = this.getWorkflowInternal(projectId, workflowId);
			if (!workflow) { throw new Error('The workflow does not belong to this project.'); }
			const priorReceipt = this.getOperationReceipt(workflowId, 'cancel', idempotencyKey);
			if (priorReceipt) {
				if (String(priorReceipt.request_fingerprint) !== this.fingerprint({ operation: 'cancel', workflowId })) { throw new Error('The cancel idempotency key was used for another workflow operation.'); }
				return this.getWorkflowInternal(projectId, workflowId)!;
			}
			if (workflow.revision !== expectedRevision) { throw new Error('The workflow revision is stale.'); }
			const requestFingerprint = this.fingerprint({ operation: 'cancel', workflowId });
			if (['succeeded', 'failed', 'cancelled', 'blocked'].includes(workflow.state)) {
				this.insertOperationReceipt(workflowId, projectId, 'cancel', idempotencyKey, requestFingerprint, { state: workflow.state, runId: null }, new Date().toISOString());
				return workflow;
			}
			const run = this.db.prepare(`SELECT run.id FROM agent_workflow_runs run JOIN agent_workflows workflow
				ON workflow.id = run.workflow_id AND workflow.project_id = run.project_id AND workflow.plan_version = run.plan_version
				WHERE run.workflow_id = ? AND run.project_id = ? ORDER BY run.created_at DESC, run.id DESC LIMIT 1`).get(workflowId, projectId);
			const runId = run ? String(run.id) : null;
			const now = new Date().toISOString();
			let nextState: AgentWorkflowState = 'cancelled';
			if (runId) {
				this.db.prepare(`UPDATE agent_workflow_turn_reservations SET revoked_at = ? WHERE run_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`).run(now, runId);
				const nodes = this.db.prepare(`SELECT node_id, state, revision FROM agent_workflow_run_nodes WHERE run_id = ?`).all(runId) as WorkflowRow[];
				for (const node of nodes) {
					const state = String(node.state) as AgentWorkflowNodeState;
					if (state === 'waiting' || state === 'ready' || state === 'launching') {
						const consumedTurn = this.getConsumedReservationTurn(runId, String(node.node_id));
						this.updateNodeState(runId, String(node.node_id), Number(node.revision), consumedTurn ? 'cancelRequested' : 'cancelled', now, consumedTurn ? now : null, consumedTurn?.turnId ?? null);
					} else if (state === 'running') {
						this.updateNodeState(runId, String(node.node_id), Number(node.revision), 'cancelRequested', now, now);
						nextState = 'cancelRequested';
					}
				}
				const finalStates = this.db.prepare('SELECT state FROM agent_workflow_run_nodes WHERE run_id = ?').all(runId).map(row => String(row.state) as AgentWorkflowNodeState);
				nextState = deriveRunState(finalStates);
				const runRow = this.db.prepare('SELECT revision FROM agent_workflow_runs WHERE id = ?').get(runId)!;
				this.updateRunState(runId, Number(runRow.revision), nextState, now);
			}
			this.updateWorkflowState(workflowId, projectId, workflow.revision, nextState, now);
			this.insertOperationReceipt(workflowId, projectId, 'cancel', idempotencyKey, requestFingerprint, { state: nextState, runId }, now);
			return this.getWorkflowInternal(projectId, workflowId)!;
		});
	}

	/** Host-only prelaunch capability. The returned reservation ID must never be accepted from IPC or MCP callers. */
	reserveNodeTurnLaunch(projectId: string, workflowId: string, runId: string, nodeId: string, expectedNodeRevision: number, expectedSessionRevision: number): { readonly reservationId: string; readonly turnId: string; readonly expiresAt: string } {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(workflowId, 'workflow ID');
		this.validateUuid(runId, 'workflow run ID');
		this.validateNodeId(nodeId);
		this.validateExpectedRevision(expectedNodeRevision);
		if (!Number.isSafeInteger(expectedSessionRevision) || expectedSessionRevision < 1) { throw new Error('The expected session revision is invalid.'); }
		return this.transaction(() => {
			const now = new Date().toISOString();
			this.expireExpiredLaunchReservationsInternal(now);
			const row = this.db.prepare(`SELECT node.state AS node_state, node.revision AS node_revision, node.session_id, run.state AS run_state,
				run.plan_version, run.fingerprint, run.deadline_at, workflow.state AS workflow_state
				FROM agent_workflow_runs run JOIN agent_workflows workflow ON workflow.id = run.workflow_id AND workflow.project_id = run.project_id
				JOIN agent_workflow_run_nodes node ON node.run_id = run.id AND node.workflow_id = run.workflow_id
				WHERE run.id = ? AND run.workflow_id = ? AND run.project_id = ? AND node.node_id = ?`).get(runId, workflowId, projectId, nodeId) as WorkflowRow | undefined;
			if (!row || Number(row.node_revision) !== expectedNodeRevision) { throw new Error('The workflow node is missing or its revision is stale.'); }
			if (!['ready', 'launching'].includes(String(row.node_state)) || !['ready', 'running'].includes(String(row.run_state)) || !['ready', 'running'].includes(String(row.workflow_state))) { throw new Error('Only an approved, ready node in an active run can reserve a session turn.'); }
			if (Date.parse(String(row.deadline_at)) <= Date.parse(now)) { throw new Error('The workflow run deadline has passed.'); }
			const plan = this.getPlanInternalByWorkflow(workflowId, Number(row.plan_version));
			if (!plan || plan.fingerprint !== String(row.fingerprint) || !this.hasApproval(workflowId, projectId, plan.version, plan.fingerprint)) { throw new Error('The reservation requires the exact approved plan fingerprint.'); }
			const session = this.db.prepare('SELECT revision, state FROM agent_sessions WHERE id = ? AND project_id = ?').get(String(row.session_id), projectId) as WorkflowRow | undefined;
			if (!session || Number(session.revision) !== expectedSessionRevision || !['created', 'idle'].includes(String(session.state))) { throw new Error('The selected session revision is stale or the session is not ready.'); }
			const prior = this.db.prepare('SELECT id, reserved_turn_id, expires_at, session_revision, approval_fingerprint, consumed_at, revoked_at FROM agent_workflow_turn_reservations WHERE run_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1').get(runId, nodeId) as WorkflowRow | undefined;
			if (prior && prior.consumed_at === null && prior.revoked_at === null && Date.parse(String(prior.expires_at)) > Date.parse(now)) {
				if (row.node_state !== 'launching' || Number(prior.session_revision) !== expectedSessionRevision || String(prior.approval_fingerprint) !== plan.fingerprint) { throw new Error('A prior launch reservation exists for a different session revision or approved plan.'); }
				return { reservationId: String(prior.id), turnId: String(prior.reserved_turn_id), expiresAt: String(prior.expires_at) };
			}
			if (prior && prior.consumed_at !== null) { throw new Error('This workflow node already consumed its single approved session turn.'); }
			if (row.node_state !== 'ready') { throw new Error('The workflow node is already launching or does not have a reusable unconsumed reservation.'); }
			const activeCapacity = this.countCapacitySlots(runId, now);
			if (activeCapacity >= plan.maxConcurrentNodes) { throw new Error('The workflow maximum concurrency is already reserved or in use.'); }
			const reservationId = randomUUID();
			const turnId = randomUUID();
			const expiresAt = new Date(Math.min(Date.parse(now) + 90_000, Date.parse(String(row.deadline_at)))).toISOString();
			this.db.prepare(`INSERT INTO agent_workflow_turn_reservations
				(id, workflow_id, project_id, run_id, node_id, session_id, approval_fingerprint, session_revision,
				reserved_turn_id, expires_at, consumed_at, consumed_turn_id, revoked_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`).run(
				reservationId, workflowId, projectId, runId, nodeId, String(row.session_id), plan.fingerprint,
				expectedSessionRevision, turnId, expiresAt, now,
			);
			const changed = this.db.prepare(`UPDATE agent_workflow_run_nodes SET state = 'launching', revision = revision + 1, updated_at = ?
				WHERE run_id = ? AND node_id = ? AND revision = ? AND state = 'ready' AND session_turn_id IS NULL`)
				.run(now, runId, nodeId, expectedNodeRevision);
			if (Number(changed.changes) !== 1) { throw new Error('The workflow node revision is stale or no longer ready to launch.'); }
			this.reconcileRunAndWorkflow(projectId, workflowId, runId, now);
			return { reservationId, turnId, expiresAt };
		});
	}

	/** Expires unused launch capabilities and releases only nodes with no persisted session turn. */
	expireExpiredLaunchReservations(now = new Date().toISOString()): number {
		this.assertOpen();
		if (!Number.isFinite(Date.parse(now))) { throw new Error('The expiration time must be a valid timestamp.'); }
		return this.transaction(() => this.expireExpiredLaunchReservationsInternal(now));
	}

	/** Marks overdue work as requiring cancellation; actual process stopping remains the runtime's responsibility. */
	expireOverdueRuns(now = new Date().toISOString()): number {
		this.assertOpen();
		if (!Number.isFinite(Date.parse(now))) { throw new Error('The expiration time must be a valid timestamp.'); }
		return this.transaction(() => {
			const overdue = this.db.prepare(`SELECT id, workflow_id, project_id, revision FROM agent_workflow_runs
				WHERE deadline_at <= ? AND state IN ('ready', 'running') ORDER BY deadline_at, id`).all(now) as WorkflowRow[];
			for (const run of overdue) {
				const runId = String(run.id);
				const workflowId = String(run.workflow_id);
				const projectId = String(run.project_id);
				this.db.prepare(`UPDATE agent_workflow_turn_reservations SET revoked_at = ?
					WHERE run_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`).run(now, runId);
				const nodes = this.db.prepare('SELECT node_id, state, revision FROM agent_workflow_run_nodes WHERE run_id = ?').all(runId) as WorkflowRow[];
				for (const node of nodes) {
					const state = String(node.state) as AgentWorkflowNodeState;
					if (state === 'waiting' || state === 'ready' || state === 'launching') {
						const consumedTurn = this.getConsumedReservationTurn(runId, String(node.node_id));
						this.updateNodeState(runId, String(node.node_id), Number(node.revision), consumedTurn ? 'cancelRequested' : 'blocked', now, consumedTurn ? now : null, consumedTurn?.turnId ?? null);
					}
					else if (state === 'running') { this.updateNodeState(runId, String(node.node_id), Number(node.revision), 'cancelRequested', now, now); }
				}
				const finalStates = this.db.prepare('SELECT state FROM agent_workflow_run_nodes WHERE run_id = ?').all(runId).map(row => String(row.state) as AgentWorkflowNodeState);
				const nextState = deriveRunState(finalStates);
				this.updateRunState(runId, Number(run.revision), nextState, now);
				const workflow = this.getWorkflowInternal(projectId, workflowId);
				if (workflow && workflow.state !== nextState) { this.updateWorkflowState(workflowId, projectId, workflow.revision, nextState, now); }
			}
			return overdue.length;
		});
	}

	transitionNode(projectId: string, workflowId: string, runId: string, nodeId: string, expectedRevision: number, nextState: AgentWorkflowNodeState, sessionTurnId?: string): AgentWorkflowRunDTO {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(workflowId, 'workflow ID');
		this.validateUuid(runId, 'workflow run ID');
		this.validateNodeId(nodeId);
		this.validateExpectedRevision(expectedRevision);
		if (!isNodeState(nextState)) { throw new Error('The requested workflow node state is invalid.'); }
		if (sessionTurnId !== undefined) { this.validateUuid(sessionTurnId, 'session turn ID'); }
		return this.transaction(() => {
			const node = this.db.prepare(`SELECT n.node_id, n.state, n.revision, n.session_id, n.session_turn_id, n.cancel_requested_at,
				r.plan_version, r.fingerprint, r.state AS run_state, r.deadline_at
				FROM agent_workflow_run_nodes n JOIN agent_workflow_runs r ON r.id = n.run_id AND r.workflow_id = n.workflow_id
				WHERE n.run_id = ? AND n.workflow_id = ? AND n.project_id = ? AND n.node_id = ?`).get(runId, workflowId, projectId, nodeId);
			if (!node) { throw new Error('The workflow node does not belong to this project and run.'); }
			const current = String(node.state) as AgentWorkflowNodeState;
			if (Number(node.revision) !== expectedRevision) { throw new Error('The workflow node revision is stale.'); }
			if (!canTransitionNode(current, nextState)) { throw new Error('The workflow node state transition is invalid.'); }
			if (nextState === 'ready' || nextState === 'blocked') {
				const consumedReservation = this.db.prepare(`SELECT 1 FROM agent_workflow_turn_reservations
					WHERE run_id = ? AND node_id = ? AND consumed_at IS NOT NULL LIMIT 1`).get(runId, nodeId);
				if (node.session_turn_id !== null || consumedReservation) {
					throw new Error('A launching node with a linked or consumed turn cannot return to ready or blocked.');
				}
			}
			const deadlinePassed = Date.parse(String(node.deadline_at)) <= Date.now();
			if (deadlinePassed && nextState !== 'cancelRequested' && nextState !== 'cancelled' && nextState !== 'failed' && nextState !== 'interrupted') {
				throw new Error('The workflow run deadline has passed; only cancellation and observed terminal outcomes may be recorded.');
			}
			if (nextState === 'ready' || nextState === 'running') { this.assertDependenciesSucceeded(workflowId, runId, Number(node.plan_version), nodeId); }
			if (nextState === 'running') {
				const plan = this.getPlanInternalByWorkflow(workflowId, Number(node.plan_version));
				if (!plan || this.countCapacitySlots(runId, new Date().toISOString()) > plan.maxConcurrentNodes) { throw new Error('The workflow maximum concurrency reservation is invalid.'); }
				if (!sessionTurnId) { throw new Error('A workflow node can run only after its approved persisted session turn is running.'); }
				if (deadlinePassed || !['ready', 'running'].includes(String(node.run_state))) { throw new Error('The workflow deadline or run state no longer permits a node launch.'); }
				if (current !== 'launching' || node.session_turn_id === null || String(node.session_turn_id) !== sessionTurnId) { throw new Error('A running node must retain the exact turn bound by its launch transaction.'); }
				const reservation = this.db.prepare(`SELECT reserved_turn_id, consumed_turn_id, approval_fingerprint, session_revision, expires_at, consumed_at, revoked_at
					FROM agent_workflow_turn_reservations WHERE workflow_id = ? AND project_id = ? AND run_id = ? AND node_id = ? AND session_id = ?`)
					.get(workflowId, projectId, runId, nodeId, String(node.session_id)) as WorkflowRow | undefined;
				if (!reservation || reservation.consumed_at === null || reservation.revoked_at !== null
					|| String(reservation.reserved_turn_id) !== sessionTurnId || String(reservation.consumed_turn_id) !== sessionTurnId
					|| String(reservation.approval_fingerprint) !== String(node.fingerprint)) {
					throw new Error('A node can run only with its exact turn consumed from the approved launch reservation.');
				}
				const turn = this.db.prepare(`SELECT snapshot_json, snapshot_sha256 FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ? AND state = 'running'`).get(sessionTurnId, projectId, String(node.session_id));
				if (!turn) { throw new Error('The running turn must belong to this node session and project.'); }
				if (!plan) { throw new Error('The approved workflow plan is unavailable.'); }
				this.assertTurnMatchesApprovedNode(turn, plan.nodes.find(candidate => candidate.nodeId === nodeId), projectId, String(node.session_id));
			}
			if (sessionTurnId && nextState !== 'running') { throw new Error('A session turn may be attached only when the node enters running.'); }
			if (current === 'cancelRequested' && nextState === 'cancelled') {
				this.assertTurnCleanup(node, projectId);
			}
			if (nextState === 'cancelled' && node.session_turn_id !== null) { this.assertTurnCleanup(node, projectId); }
			if (nextState === 'succeeded') {
				const turnId = node.session_turn_id === null ? null : String(node.session_turn_id);
				const turn = turnId && this.db.prepare(`SELECT exit_code FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ? AND state = 'exited' AND cleanup_verified = 1`).get(turnId, projectId, String(node.session_id));
				if (!turn || turn.exit_code !== 0) { throw new Error('A workflow node succeeds only after its linked session turn exits successfully and cleanup is verified.'); }
			}
			if (nextState === 'failed') {
				const turnId = node.session_turn_id === null ? null : String(node.session_turn_id);
				const turn = turnId && this.db.prepare(`SELECT state, exit_code FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ? AND state IN ('exited', 'interrupted', 'failed') AND cleanup_verified = 1`).get(turnId, projectId, String(node.session_id));
				if (!turn || (turn.state === 'exited' && (turn.exit_code === null || turn.exit_code === 0))) { throw new Error('A workflow node failure requires a linked terminal session turn and verified cleanup.'); }
			}
			if (nextState === 'interrupted') {
				const turnId = node.session_turn_id === null ? null : String(node.session_turn_id);
				if (!turnId || !this.db.prepare(`SELECT 1 FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ? AND state = 'interrupted'`).get(turnId, projectId, String(node.session_id))) {
					throw new Error('A workflow node can be interrupted only when its linked session turn is interrupted.');
				}
			}
			const now = new Date().toISOString();
			if (current === 'launching' && (nextState === 'ready' || nextState === 'blocked')) {
				this.db.prepare(`UPDATE agent_workflow_turn_reservations SET revoked_at = COALESCE(revoked_at, ?)
					WHERE run_id = ? AND node_id = ? AND consumed_at IS NULL`).run(now, runId, nodeId);
			}
			this.updateNodeState(runId, nodeId, expectedRevision, nextState, now, nextState === 'cancelRequested' ? now : null, sessionTurnId ?? null);
			if (nextState === 'failed') {
				const siblings = this.db.prepare(`SELECT node_id, state, revision FROM agent_workflow_run_nodes WHERE run_id = ? AND node_id <> ?`).all(runId, nodeId) as WorkflowRow[];
				for (const sibling of siblings) {
					const siblingState = String(sibling.state) as AgentWorkflowNodeState;
					if (siblingState === 'waiting' || siblingState === 'ready' || siblingState === 'launching') {
						const consumedTurn = this.getConsumedReservationTurn(runId, String(sibling.node_id));
						this.updateNodeState(runId, String(sibling.node_id), Number(sibling.revision), consumedTurn ? 'cancelRequested' : 'blocked', now, consumedTurn ? now : null, consumedTurn?.turnId ?? null);
					}
					else if (siblingState === 'running') { this.updateNodeState(runId, String(sibling.node_id), Number(sibling.revision), 'cancelRequested', now, now); }
				}
			}
			this.reconcileRunAndWorkflow(projectId, workflowId, runId, now);
			return this.getRunInternal(projectId, workflowId, runId)!;
		});
	}

	/** A repeated event key with identical bytes is acknowledged once; changed content is rejected. */
	recordSourceEvent(projectId: string, workflowId: string, sourceEventKey: string, event: Readonly<Record<string, string | number | boolean | null>>): { readonly duplicate: boolean; readonly fingerprint: string } {
		this.assertOpen();
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(workflowId, 'workflow ID');
		if (typeof sourceEventKey !== 'string' || !sourceEventKey.trim() || sourceEventKey.length > 256) { throw new Error('A source event key must contain 1 to 256 characters.'); }
		if (!event || typeof event !== 'object' || Array.isArray(event)) { throw new Error('The source event payload must be a record.'); }
		const canonical = canonicalJson(event);
		if (Buffer.byteLength(canonical, 'utf8') > MAX_SOURCE_EVENT_BYTES) { throw new Error('The source event payload exceeds 4 KiB.'); }
		const fingerprint = this.digest(canonical);
		return this.transaction(() => {
			if (!this.getWorkflowInternal(projectId, workflowId)) { throw new Error('The workflow does not belong to this project.'); }
			const prior = this.db.prepare(`SELECT event_fingerprint FROM agent_workflow_source_events WHERE workflow_id = ? AND source_event_key = ?`).get(workflowId, sourceEventKey);
			if (prior) {
				if (String(prior.event_fingerprint) !== fingerprint) { throw new Error('The source event key was already used for different event content.'); }
				return { duplicate: true, fingerprint };
			}
			this.db.prepare(`INSERT INTO agent_workflow_source_events (workflow_id, project_id, source_event_key, event_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`)
				.run(workflowId, projectId, sourceEventKey, fingerprint, new Date().toISOString());
			return { duplicate: false, fingerprint };
		});
	}

	private validatePlanCore(projectId: string, input: AgentWorkflowPlanInput, allowBusySessions = false): WorkflowCore {
		if (!input || typeof input !== 'object') { throw new Error('A workflow plan is required.'); }
		this.validateUuid(input.projectId, 'plan project ID');
		if (input.projectId !== projectId) { throw new Error('The plan project ID must match the owning project.'); }
		this.validateUuid(input.bindingId, 'binding ID');
		if (input.taskId !== null) { this.validateUuid(input.taskId, 'task ID'); }
		if (!Number.isSafeInteger(input.maxConcurrentNodes) || input.maxConcurrentNodes < 1 || input.maxConcurrentNodes > MAX_CONCURRENCY) { throw new Error(`Maximum concurrency must be between 1 and ${MAX_CONCURRENCY}.`); }
		if (!Number.isSafeInteger(input.maxTotalTurns) || input.maxTotalTurns < 1 || input.maxTotalTurns > MAX_TOTAL_TURNS) { throw new Error(`Maximum total turns must be between 1 and ${MAX_TOTAL_TURNS}.`); }
		if (!Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs < 1000 || input.maxDurationMs > MAX_DURATION_MS) { throw new Error(`Maximum duration must be between 1000 and ${MAX_DURATION_MS} milliseconds.`); }
		if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > MAX_NODES || input.nodes.length > input.maxTotalTurns) { throw new Error(`A workflow must contain 1 to ${Math.min(MAX_NODES, input.maxTotalTurns)} nodes.`); }
		const project = this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
		const binding = this.db.prepare('SELECT 1 FROM folder_bindings WHERE id = ? AND project_id = ?').get(input.bindingId, projectId);
		if (!project || !binding) { throw new Error('The workflow project and binding must exist and belong together.'); }
		if (input.taskId !== null) {
			const task = this.db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND project_id = ? AND binding_id = ? AND archived_at IS NULL AND trashed_at IS NULL`).get(input.taskId, projectId, input.bindingId);
			if (!task) { throw new Error('The workflow task must be active and belong to its project and binding.'); }
		}
		const nodes = input.nodes.map(node => this.validateNode(projectId, input.bindingId, input.taskId, node, allowBusySessions));
		if (new Set(nodes.map(node => node.nodeId)).size !== nodes.length) { throw new Error('Workflow node IDs must be unique.'); }
		if (new Set(nodes.map(node => node.sessionId)).size !== nodes.length) { throw new Error('A persisted session can appear only once in a workflow plan.'); }
		const nodeIds = new Set(nodes.map(node => node.nodeId));
		for (const node of nodes) {
			if (new Set(node.dependsOn).size !== node.dependsOn.length) { throw new Error(`Node ${node.nodeId} contains a duplicate dependency.`); }
			for (const dependency of node.dependsOn) {
				if (!nodeIds.has(dependency) || dependency === node.nodeId) { throw new Error(`Node ${node.nodeId} has an unknown or self dependency.`); }
			}
		}
		this.assertAcyclic(nodes);
		return {
			projectId: input.projectId, bindingId: input.bindingId, taskId: input.taskId,
			maxConcurrentNodes: input.maxConcurrentNodes, maxTotalTurns: input.maxTotalTurns, maxDurationMs: input.maxDurationMs,
			nodes: nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
		};
	}

	private validateNode(projectId: string, bindingId: string, taskId: string | null, node: AgentWorkflowNodePlan, allowBusySession: boolean): AgentWorkflowNodePlan {
		if (!node || typeof node !== 'object') { throw new Error('Each workflow node must be an object.'); }
		this.validateNodeId(node.nodeId);
		this.validateUuid(node.sessionId, 'session ID');
		if (!ROLES.has(node.role)) { throw new Error('The workflow role is not supported by this app version.'); }
		if (node.provider !== 'codex' && node.provider !== 'claude') { throw new Error('The workflow provider is invalid.'); }
		if (typeof node.model !== 'string' || !node.model.trim() || node.model.trim().length > 200) { throw new Error('The workflow model must contain 1 to 200 characters.'); }
		if (node.bindingId !== bindingId || node.taskId !== taskId) { throw new Error('Every workflow node must retain the exact workflow task and binding scope.'); }
		if (!node.permissionPolicy || !['read-only', 'mutating'].includes(node.permissionPolicy.mode) || !['never', 'on-request', 'always'].includes(node.permissionPolicy.approval)) { throw new Error('The node permission policy is invalid.'); }
		if (!Array.isArray(node.dependsOn) || node.dependsOn.length > MAX_NODES) { throw new Error('Node dependencies must be a bounded list.'); }
		if (!Array.isArray(node.referenceIds) || node.referenceIds.length > 64) { throw new Error('Node knowledge references must be a bounded list.'); }
		const session = this.db.prepare(`SELECT project_id, binding_id, task_id, provider, model, state FROM agent_sessions WHERE id = ?`).get(node.sessionId);
		if (!session || String(session.project_id) !== projectId || String(session.binding_id) !== bindingId
			|| (session.task_id === null ? null : String(session.task_id)) !== taskId) { throw new Error('Each workflow node must use a persisted session owned by the same project, task, and binding.'); }
		if (String(session.provider) !== node.provider || String(session.model) !== node.model) { throw new Error('The workflow node provider and model must match its persisted session.'); }
		if (!allowBusySession && session.state !== 'created' && session.state !== 'idle') { throw new Error('Workflow nodes may use only created or idle persisted sessions.'); }
		const refs = node.referenceIds.map(reference => this.validateReference(projectId, taskId, reference));
		if (refs.filter(reference => reference.kind === 'conventionVersion').length > 1) { throw new Error(`Node ${node.nodeId} may select at most one convention version.`); }
		const refKeys = refs.map(ref => `${ref.kind}:${ref.id}`);
		if (new Set(refKeys).size !== refs.length) { throw new Error(`Node ${node.nodeId} contains a duplicate knowledge reference.`); }
		return {
			nodeId: node.nodeId, sessionId: node.sessionId, role: node.role, provider: node.provider, model: node.model.trim(),
			taskId, bindingId, referenceIds: refs.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
			permissionPolicy: { mode: node.permissionPolicy.mode, approval: node.permissionPolicy.approval },
			dependsOn: [...node.dependsOn].sort(),
		};
	}

	private validateReference(projectId: string, taskId: string | null, reference: AgentWorkflowReference): AgentWorkflowReference {
		if (!reference || typeof reference !== 'object' || !['knowledgeSnapshot', 'conventionVersion'].includes(reference.kind)) { throw new Error('The workflow knowledge reference kind is invalid.'); }
		this.validateUuid(reference.id, 'knowledge reference ID');
		if (reference.kind === 'knowledgeSnapshot') {
			const owned = this.db.prepare(`SELECT 1 FROM reference_snapshots s JOIN reference_sources r ON r.id = s.source_id WHERE s.id = ? AND r.project_id = ?`).get(reference.id, projectId);
			if (!owned) { throw new Error('The knowledge snapshot does not belong to the workflow project.'); }
			if (taskId !== null && !this.db.prepare('SELECT 1 FROM task_reference_links WHERE task_id = ? AND snapshot_id = ?').get(taskId, reference.id)) { throw new Error('The knowledge snapshot is not attached to the workflow task.'); }
		} else {
			if (!this.db.prepare('SELECT 1 FROM convention_versions WHERE id = ? AND project_id = ?').get(reference.id, projectId)) { throw new Error('The convention version does not belong to the workflow project.'); }
		}
		return { kind: reference.kind, id: reference.id } as AgentWorkflowReference;
	}

	private assertAcyclic(nodes: readonly AgentWorkflowNodePlan[]): void {
		const byId = new Map(nodes.map(node => [node.nodeId, node]));
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (nodeId: string): void => {
			if (visiting.has(nodeId)) { throw new Error('The workflow dependency graph contains a cycle.'); }
			if (visited.has(nodeId)) { return; }
			visiting.add(nodeId);
			for (const dependency of byId.get(nodeId)!.dependsOn) { visit(dependency); }
			visiting.delete(nodeId);
			visited.add(nodeId);
		};
		for (const node of nodes) { visit(node.nodeId); }
	}

	private assertDependenciesSucceeded(workflowId: string, runId: string, planVersion: number, nodeId: string): void {
		const plan = this.getPlanInternalByWorkflow(workflowId, planVersion);
		const node = plan?.nodes.find(candidate => candidate.nodeId === nodeId);
		if (!node) { throw new Error('The workflow node is missing from its approved plan.'); }
		for (const dependency of node.dependsOn) {
			const result = this.db.prepare('SELECT state FROM agent_workflow_run_nodes WHERE run_id = ? AND node_id = ?').get(runId, dependency);
			if (result?.state !== 'succeeded') { throw new Error('Workflow dependencies must succeed before a node becomes ready or running.'); }
		}
	}

	private assertTurnMatchesApprovedNode(turnRow: WorkflowRow, node: AgentWorkflowNodePlan | undefined, projectId: string, sessionId: string): void {
		if (!node) { throw new Error('The session turn node is absent from the approved workflow plan.'); }
		const snapshotJson = String(turnRow.snapshot_json);
		if (this.digest(snapshotJson) !== String(turnRow.snapshot_sha256)) { throw new Error('The persisted session turn snapshot fingerprint is invalid.'); }
		const snapshot = JSON.parse(snapshotJson) as AgentSessionTurnSnapshot;
		if (snapshot.projectId !== projectId || snapshot.sessionId !== sessionId || snapshot.bindingId !== node.bindingId || snapshot.taskId !== node.taskId
			|| snapshot.provider !== node.provider || snapshot.model !== node.model
			|| snapshot.permissionPolicy.mode !== node.permissionPolicy.mode || snapshot.permissionPolicy.approval !== node.permissionPolicy.approval) {
			throw new Error('The session turn target and permission snapshot must exactly match the approved workflow node.');
		}
		const expectedKnowledgeIds = node.referenceIds.filter(reference => reference.kind === 'knowledgeSnapshot').map(reference => reference.id).sort();
		const actualKnowledgeIds = snapshot.references.map(reference => reference.id).sort();
		if (canonicalJson(expectedKnowledgeIds) !== canonicalJson(actualKnowledgeIds)) { throw new Error('The session turn knowledge references must exactly match the approved node references.'); }
		for (const reference of snapshot.references) {
			const persisted = this.db.prepare(`SELECT s.version, s.content_sha256 FROM reference_snapshots s JOIN reference_sources r ON r.id = s.source_id WHERE s.id = ? AND r.project_id = ?`).get(reference.id, projectId);
			if (!persisted || Number(persisted.version) !== reference.version || String(persisted.content_sha256) !== reference.sha256) { throw new Error('A session turn knowledge reference changed after workflow approval.'); }
		}
		const expectedConvention = node.referenceIds.find(reference => reference.kind === 'conventionVersion')?.id ?? null;
		if ((snapshot.convention?.id ?? null) !== expectedConvention) { throw new Error('The session turn convention must exactly match the approved node references.'); }
		if (expectedConvention) {
			const persisted = this.db.prepare('SELECT version, markdown FROM convention_versions WHERE id = ? AND project_id = ?').get(expectedConvention, projectId);
			if (!persisted || Number(persisted.version) !== snapshot.convention?.version || this.digest(String(persisted.markdown)) !== snapshot.convention?.sha256) { throw new Error('The session turn convention version changed after workflow approval.'); }
		}
	}

	private planWithMetadata(workflowId: string, version: number, core: WorkflowCore, fingerprint: string, createdAt: string): AgentWorkflowPlan {
		return { schemaVersion: 1, workflowId, version, ...core, fingerprint, createdAt };
	}

	private insertPlan(plan: AgentWorkflowPlan): void {
		const json = JSON.stringify(plan);
		if (Buffer.byteLength(json, 'utf8') > MAX_PLAN_BYTES) { throw new Error('The workflow plan exceeds 64 KiB.'); }
		this.db.prepare(`INSERT INTO agent_workflow_plans (workflow_id, project_id, version, plan_json, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
			.run(plan.workflowId, plan.projectId, plan.version, json, plan.fingerprint, plan.createdAt);
	}

	private getPlanInternal(projectId: string, workflowId: string, version: number): AgentWorkflowPlan | undefined {
		const row = this.db.prepare('SELECT plan_json, fingerprint FROM agent_workflow_plans WHERE workflow_id = ? AND project_id = ? AND version = ?').get(workflowId, projectId, version);
		if (!row) { return undefined; }
		const plan = JSON.parse(String(row.plan_json)) as AgentWorkflowPlan;
		if (plan.workflowId !== workflowId || plan.version !== version || plan.projectId !== projectId || plan.fingerprint !== String(row.fingerprint)) { throw new Error('The stored workflow plan integrity check failed.'); }
		return plan;
	}

	private getPlanInternalByWorkflow(workflowId: string, version: number): AgentWorkflowPlan | undefined {
		const row = this.db.prepare('SELECT project_id FROM agent_workflows WHERE id = ?').get(workflowId);
		return row ? this.getPlanInternal(String(row.project_id), workflowId, version) : undefined;
	}

	private fingerprint(value: unknown): string { return this.digest(canonicalJson(value)); }
	private digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

	private workflowFromRow(row: WorkflowRow): AgentWorkflowDTO {
		return {
			id: String(row.id), projectId: String(row.project_id), bindingId: String(row.binding_id),
			taskId: row.task_id === null ? null : String(row.task_id), revision: Number(row.revision), state: String(row.state) as AgentWorkflowState,
			planVersion: Number(row.plan_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
		};
	}

	private getWorkflowInternal(projectId: string, workflowId: string): AgentWorkflowDTO | undefined {
		const row = this.db.prepare(`SELECT id, project_id, binding_id, task_id, plan_version, revision, state, created_at, updated_at
			FROM agent_workflows WHERE id = ? AND project_id = ?`).get(workflowId, projectId);
		return row ? this.workflowFromRow(row) : undefined;
	}

	private approvalFromRow(row: WorkflowRow): AgentWorkflowApprovalReceipt {
		return { id: String(row.id), projectId: String(row.project_id), workflowId: String(row.workflow_id), planVersion: Number(row.plan_version), fingerprint: String(row.fingerprint), idempotencyKey: String(row.idempotency_key), approvedAt: String(row.approved_at) };
	}

	private getApprovalInternal(workflowId: string, approvalId: string): AgentWorkflowApprovalReceipt | undefined {
		const row = this.db.prepare(`SELECT id, project_id, workflow_id, plan_version, fingerprint, idempotency_key, approved_at FROM agent_workflow_approvals WHERE workflow_id = ? AND id = ?`).get(workflowId, approvalId);
		return row ? this.approvalFromRow(row) : undefined;
	}

	private hasApproval(workflowId: string, projectId: string, version: number, fingerprint: string): boolean {
		return Boolean(this.db.prepare(`SELECT 1 FROM agent_workflow_approvals WHERE workflow_id = ? AND project_id = ? AND plan_version = ? AND fingerprint = ?`).get(workflowId, projectId, version, fingerprint));
	}

	private getOperationReceipt(workflowId: string, operation: 'start' | 'cancel', idempotencyKey: string): WorkflowRow | undefined {
		return this.db.prepare(`SELECT request_fingerprint, result_json FROM agent_workflow_receipts WHERE workflow_id = ? AND operation = ? AND idempotency_key = ?`).get(workflowId, operation, idempotencyKey);
	}

	private insertOperationReceipt(workflowId: string, projectId: string, operation: 'start' | 'cancel', idempotencyKey: string, requestFingerprint: string, result: unknown, createdAt: string): void {
		this.db.prepare(`INSERT INTO agent_workflow_receipts (id, workflow_id, project_id, operation, idempotency_key, request_fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(randomUUID(), workflowId, projectId, operation, idempotencyKey, requestFingerprint, JSON.stringify(result), createdAt);
	}

	private getRunInternal(projectId: string, workflowId: string, runId: string): AgentWorkflowRunDTO | undefined {
		const row = this.db.prepare(`SELECT id, project_id, workflow_id, plan_version, fingerprint, idempotency_key, revision, state, deadline_at, created_at, updated_at
			FROM agent_workflow_runs WHERE id = ? AND workflow_id = ? AND project_id = ?`).get(runId, workflowId, projectId);
		if (!row) { return undefined; }
		const nodes = this.db.prepare(`SELECT workflow_id, run_id, node_id, session_id, session_turn_id, state, revision, cancel_requested_at, updated_at
			FROM agent_workflow_run_nodes WHERE run_id = ? ORDER BY node_id`).all(runId).map(node => this.nodeFromRow(node));
		return {
			id: String(row.id), projectId: String(row.project_id), workflowId: String(row.workflow_id), planVersion: Number(row.plan_version),
			fingerprint: String(row.fingerprint), idempotencyKey: String(row.idempotency_key), revision: Number(row.revision),
			state: String(row.state) as AgentWorkflowState, createdAt: String(row.created_at), updatedAt: String(row.updated_at), deadlineAt: String(row.deadline_at), nodes,
		};
	}

	private nodeFromRow(row: WorkflowRow): AgentWorkflowNodeExecutionDTO {
		return { workflowId: String(row.workflow_id), runId: String(row.run_id), nodeId: String(row.node_id), sessionId: String(row.session_id), sessionTurnId: row.session_turn_id === null ? null : String(row.session_turn_id), state: String(row.state) as AgentWorkflowNodeState, revision: Number(row.revision), cancelRequestedAt: row.cancel_requested_at === null ? null : String(row.cancel_requested_at), updatedAt: String(row.updated_at) };
	}

	private updateNodeState(runId: string, nodeId: string, expectedRevision: number, state: AgentWorkflowNodeState, now: string, cancelRequestedAt: string | null, sessionTurnId: string | null = null): void {
		const result = this.db.prepare(`UPDATE agent_workflow_run_nodes SET state = ?, revision = revision + 1, cancel_requested_at = COALESCE(cancel_requested_at, ?), session_turn_id = COALESCE(?, session_turn_id), updated_at = ?
			WHERE run_id = ? AND node_id = ? AND revision = ?`).run(state, cancelRequestedAt, sessionTurnId, now, runId, nodeId, expectedRevision);
		if (Number(result.changes) !== 1) { throw new Error('The workflow node revision is stale.'); }
	}

	private updateRunState(runId: string, expectedRevision: number, state: AgentWorkflowState, now: string): void {
		const current = this.db.prepare('SELECT state FROM agent_workflow_runs WHERE id = ?').get(runId);
		if (!current || !canTransitionWorkflowState(String(current.state) as AgentWorkflowState, state)) { throw new Error('The workflow run state transition is invalid.'); }
		const result = this.db.prepare(`UPDATE agent_workflow_runs SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`).run(state, now, runId, expectedRevision);
		if (Number(result.changes) !== 1) { throw new Error('The workflow run revision is stale.'); }
	}

	private updateWorkflowState(workflowId: string, projectId: string, expectedRevision: number, state: AgentWorkflowState, now: string): void {
		const current = this.db.prepare('SELECT state FROM agent_workflows WHERE id = ? AND project_id = ?').get(workflowId, projectId);
		if (!current || !canTransitionWorkflowState(String(current.state) as AgentWorkflowState, state)) { throw new Error('The workflow state transition is invalid.'); }
		const result = this.db.prepare(`UPDATE agent_workflows SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ?`).run(state, now, workflowId, projectId, expectedRevision);
		if (Number(result.changes) !== 1) { throw new Error('The workflow revision is stale.'); }
	}

	private assertTurnCleanup(node: WorkflowRow, projectId: string): void {
		const turnId = node.session_turn_id === null ? null : String(node.session_turn_id);
		const cleanup = turnId && this.db.prepare(`SELECT 1 FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ? AND state IN ('exited', 'interrupted', 'failed') AND cleanup_verified = 1`).get(turnId, projectId, String(node.session_id));
		if (!cleanup) { throw new Error('A cancellation cannot complete before the persisted session turn is terminal and host cleanup is verified.'); }
	}

	private getConsumedReservationTurn(runId: string, nodeId: string): { readonly turnId: string; readonly state: string; readonly cleanupVerified: boolean } | undefined {
		const row = this.db.prepare(`SELECT reservation.consumed_turn_id, turn.state, turn.cleanup_verified
			FROM agent_workflow_turn_reservations reservation JOIN agent_session_turns turn
				ON turn.id = reservation.consumed_turn_id AND turn.project_id = reservation.project_id AND turn.session_id = reservation.session_id
			WHERE reservation.run_id = ? AND reservation.node_id = ? AND reservation.consumed_at IS NOT NULL
			ORDER BY reservation.consumed_at DESC LIMIT 1`).get(runId, nodeId) as WorkflowRow | undefined;
		if (!row) { return undefined; }
		return { turnId: String(row.consumed_turn_id), state: String(row.state), cleanupVerified: Number(row.cleanup_verified) === 1 };
	}

	private expireExpiredLaunchReservationsInternal(now: string): number {
		const rows = this.db.prepare(`SELECT reservation.id, reservation.run_id, reservation.node_id, node.revision,
			run.workflow_id, run.project_id FROM agent_workflow_turn_reservations reservation
			JOIN agent_workflow_runs run ON run.id = reservation.run_id AND run.workflow_id = reservation.workflow_id AND run.project_id = reservation.project_id
			JOIN agent_workflow_run_nodes node ON node.run_id = reservation.run_id AND node.node_id = reservation.node_id
			WHERE reservation.expires_at <= ? AND reservation.consumed_at IS NULL AND reservation.revoked_at IS NULL
			AND run.deadline_at > ? AND run.state IN ('ready', 'running') AND node.state = 'launching' AND node.session_turn_id IS NULL`)
			.all(now, now) as WorkflowRow[];
		const affectedRuns = new Map<string, { workflowId: string; projectId: string }>();
		for (const row of rows) {
			const revoked = this.db.prepare(`UPDATE agent_workflow_turn_reservations SET revoked_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`)
				.run(now, row.id);
			if (Number(revoked.changes) !== 1) { throw new Error('A launch reservation changed while expiration was running.'); }
			const reset = this.db.prepare(`UPDATE agent_workflow_run_nodes SET state = 'ready', revision = revision + 1, updated_at = ?
				WHERE run_id = ? AND node_id = ? AND revision = ? AND state = 'launching' AND session_turn_id IS NULL`)
				.run(now, row.run_id, row.node_id, row.revision);
			if (Number(reset.changes) !== 1) { throw new Error('A launch node changed while expiration was running.'); }
			affectedRuns.set(String(row.run_id), { workflowId: String(row.workflow_id), projectId: String(row.project_id) });
		}
		for (const [runId, owner] of affectedRuns) { this.reconcileRunAndWorkflow(owner.projectId, owner.workflowId, runId, now); }
		return rows.length;
	}

	private countCapacitySlots(runId: string, now: string): number {
		return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM agent_workflow_run_nodes node WHERE node.run_id = ? AND (
			node.state IN ('running', 'cancelRequested') OR (
				node.state IN ('launching', 'interrupted', 'recoveryRequired') AND node.session_turn_id IS NOT NULL AND EXISTS (
					SELECT 1 FROM agent_session_turns turn WHERE turn.id = node.session_turn_id AND turn.cleanup_verified = 0
				)
			) OR EXISTS (
				SELECT 1 FROM agent_workflow_turn_reservations reservation WHERE reservation.run_id = node.run_id
				AND reservation.node_id = node.node_id AND reservation.consumed_at IS NULL AND reservation.revoked_at IS NULL
				AND reservation.expires_at > ?
			)
		)`).get(runId, now)?.count ?? 0);
	}

	private reconcileRunAndWorkflow(projectId: string, workflowId: string, runId: string, now: string): void {
		const run = this.db.prepare('SELECT revision, state FROM agent_workflow_runs WHERE id = ?').get(runId)!;
		const rows = this.db.prepare('SELECT state FROM agent_workflow_run_nodes WHERE run_id = ?').all(runId) as Array<{ state: string }>;
		const states = rows.map(row => row.state as AgentWorkflowNodeState);
		const next = deriveRunState(states);
		if (next !== run.state) { this.updateRunState(runId, Number(run.revision), next, now); }
		const workflow = this.getWorkflowInternal(projectId, workflowId)!;
		if (workflow.state !== next) { this.updateWorkflowState(workflowId, projectId, workflow.revision, next, now); }
	}

	private hasUnfinishedRun(workflowId: string): boolean {
		return Boolean(this.db.prepare(`SELECT 1 FROM agent_workflow_runs WHERE workflow_id = ? AND state NOT IN ('succeeded', 'failed', 'cancelled', 'blocked') LIMIT 1`).get(workflowId));
	}

	private recoverUnverifiableRunsAfterRestart(): void {
		const now = new Date().toISOString();
		this.transaction(() => {
			const active = this.db.prepare(`SELECT id, workflow_id, project_id, revision, state FROM agent_workflow_runs WHERE state IN ('running', 'cancelRequested')`).all() as WorkflowRow[];
			for (const run of active) {
				const runId = String(run.id);
				const nodes = this.db.prepare(`SELECT node_id, state, revision, session_turn_id FROM agent_workflow_run_nodes WHERE run_id = ?`).all(runId) as WorkflowRow[];
				for (const node of nodes) {
					const state = String(node.state) as AgentWorkflowNodeState;
					if (state === 'launching') {
						const consumedTurn = this.getConsumedReservationTurn(runId, String(node.node_id));
						if (node.session_turn_id !== null || consumedTurn) {
							this.db.prepare(`UPDATE agent_workflow_run_nodes SET state = 'recoveryRequired', session_turn_id = COALESCE(session_turn_id, ?), revision = revision + 1, updated_at = ?
								WHERE run_id = ? AND node_id = ? AND revision = ? AND state = 'launching'`)
								.run(consumedTurn?.turnId ?? null, now, runId, node.node_id, node.revision);
						} else {
							this.db.prepare(`UPDATE agent_workflow_turn_reservations SET revoked_at = ? WHERE run_id = ? AND node_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`).run(now, runId, node.node_id);
							this.db.prepare(`UPDATE agent_workflow_run_nodes SET state = 'ready', revision = revision + 1, updated_at = ?
								WHERE run_id = ? AND node_id = ? AND revision = ? AND state = 'launching' AND session_turn_id IS NULL`)
								.run(now, runId, node.node_id, node.revision);
						}
					} else if (state === 'running' || state === 'cancelRequested') {
						this.db.prepare(`UPDATE agent_workflow_run_nodes SET state = 'recoveryRequired', revision = revision + 1, updated_at = ?
							WHERE run_id = ? AND node_id = ? AND revision = ? AND state IN ('running', 'cancelRequested')`)
							.run(now, runId, node.node_id, node.revision);
					}
				}
				const states = this.db.prepare('SELECT state FROM agent_workflow_run_nodes WHERE run_id = ?').all(runId).map(row => String(row.state) as AgentWorkflowNodeState);
				const nextState = deriveRunState(states);
				if (nextState !== String(run.state)) { this.updateRunState(runId, Number(run.revision), nextState, now); }
				const workflow = this.getWorkflowInternal(String(run.project_id), String(run.workflow_id));
				if (workflow && workflow.state !== nextState) { this.updateWorkflowState(workflow.id, workflow.projectId, workflow.revision, nextState, now); }
			}
		});
	}

	private validateNodeId(value: string): void { if (typeof value !== 'string' || !NODE_ID_PATTERN.test(value)) { throw new Error('A workflow node ID must be 1 to 80 safe characters.'); } }
	private validateUuid(value: string, label: string): void { if (typeof value !== 'string' || !UUID_PATTERN.test(value)) { throw new Error(`The ${label} must be a UUID.`); } }
	private validateIdempotencyKey(value: string): void { if (typeof value !== 'string' || !value.trim() || value.length > 128) { throw new Error('An idempotency key must contain 1 to 128 characters.'); } }
	private validateExpectedRevision(value: number): void { if (!Number.isSafeInteger(value) || value < 1) { throw new Error('The expected workflow revision is invalid.'); } }

	private transaction<T>(run: () => T): T {
		this.assertOpen();
		const nested = this.db.isTransaction;
		this.db.exec(nested ? 'SAVEPOINT agent_workflow_store;' : 'BEGIN IMMEDIATE;');
		try {
			const value = run();
			this.db.exec(nested ? 'RELEASE SAVEPOINT agent_workflow_store;' : 'COMMIT;');
			return value;
		} catch (error) {
			this.db.exec(nested ? 'ROLLBACK TO SAVEPOINT agent_workflow_store; RELEASE SAVEPOINT agent_workflow_store;' : 'ROLLBACK;');
			throw error;
		}
	}
}

function canonicalJson(value: unknown): string {
	if (value === undefined) { throw new Error('Workflow fingerprints cannot contain undefined values.'); }
	if (value === null || typeof value !== 'object') {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) { throw new Error('Workflow fingerprints require JSON-safe values.'); }
		return encoded;
	}
	if (Array.isArray(value)) { return `[${value.map(canonicalJson).join(',')}]`; }
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function isNodeState(value: string): value is AgentWorkflowNodeState {
	return ['waiting', 'ready', 'launching', 'running', 'cancelRequested', 'succeeded', 'failed', 'cancelled', 'blocked', 'interrupted', 'recoveryRequired'].includes(value);
}

function canTransitionWorkflowState(current: AgentWorkflowState, next: AgentWorkflowState): boolean {
	const transitions: Readonly<Record<AgentWorkflowState, readonly AgentWorkflowState[]>> = {
		waiting: ['ready', 'cancelled', 'blocked'],
		ready: ['running', 'cancelRequested', 'cancelled', 'blocked', 'recoveryRequired'],
		running: ['ready', 'cancelRequested', 'cancelled', 'succeeded', 'failed', 'blocked', 'recoveryRequired'],
		cancelRequested: ['cancelled', 'failed', 'recoveryRequired'],
		interrupted: ['recoveryRequired', 'cancelRequested'],
		recoveryRequired: ['cancelRequested', 'cancelled', 'failed'],
		succeeded: [], failed: [], cancelled: [], blocked: [],
	};
	return current === next || transitions[current].includes(next);
}

function canTransitionNode(current: AgentWorkflowNodeState, next: AgentWorkflowNodeState): boolean {
	const transitions: Readonly<Record<AgentWorkflowNodeState, readonly AgentWorkflowNodeState[]>> = {
		waiting: ['ready', 'blocked', 'cancelled'],
		ready: ['launching', 'blocked', 'cancelled'],
		launching: ['ready', 'running', 'succeeded', 'cancelRequested', 'failed', 'cancelled', 'blocked', 'interrupted'],
		running: ['succeeded', 'failed', 'cancelRequested', 'interrupted'],
		cancelRequested: ['cancelled', 'failed', 'recoveryRequired'],
		interrupted: ['recoveryRequired', 'cancelRequested'],
		recoveryRequired: ['cancelRequested', 'cancelled', 'failed'],
		succeeded: [], failed: [], cancelled: [], blocked: [],
	};
	return transitions[current].includes(next);
}

function deriveRunState(states: readonly AgentWorkflowNodeState[]): AgentWorkflowState {
	if (states.some(state => state === 'recoveryRequired' || state === 'interrupted')) { return 'recoveryRequired'; }
	if (states.some(state => state === 'cancelRequested')) { return 'cancelRequested'; }
	if (states.some(state => state === 'launching' || state === 'running')) { return 'running'; }
	if (states.some(state => state === 'failed')) { return 'failed'; }
	if (states.some(state => state === 'blocked')) { return 'blocked'; }
	if (states.every(state => state === 'succeeded')) { return 'succeeded'; }
	if (states.every(state => state === 'succeeded' || state === 'cancelled')) { return 'cancelled'; }
	return 'ready';
}
