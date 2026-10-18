/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type { AgentWorkflowDTO, AgentWorkflowNodeExecutionDTO, AgentWorkflowPlan, AgentWorkflowRunDTO } from '../../common/workspaceAgentWorkflowProtocol.js';
import type { AgentSessionPermissionPolicy, AgentSessionTurnDTO } from '../../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';
import type { AgentSessionService } from './agentSessionService.js';

const PUMP_INTERVAL_MS = 200;
const MAX_TRACKED_RUNS = 32;
const MAX_RETAINED_ERRORS = 64;

export type AgentWorkflowHostErrorCode =
	| 'launchFailed'
	| 'stopUnverified'
	| 'deadlineReached'
	| 'recoveryRequired'
	| 'schedulerPersistenceFailed';

interface ActiveRun {
	readonly projectId: string;
	readonly workflowId: string;
	readonly runId: string;
	readonly plan: AgentWorkflowPlan;
}

interface LaunchOperation {
	readonly active: ActiveRun;
	readonly nodeId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly abortController: AbortController;
}

interface StopOperation {
	readonly active: ActiveRun;
	readonly nodeId: string;
	readonly sessionId: string;
}

/** Main-process scheduler for approved finite runs. It never interprets provider output as task completion. */
export class AgentWorkflowScheduler {
	private readonly activeRuns = new Map<string, ActiveRun>();
	private readonly launches = new Map<string, LaunchOperation>();
	private readonly stops = new Map<string, StopOperation>();
	private readonly stopFailures = new Set<string>();
	private readonly hostErrors = new Map<string, AgentWorkflowHostErrorCode>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pumping = false;
	private stopped = false;

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly sessions: AgentSessionService,
		private readonly now: () => number = Date.now,
		private readonly intervalMs = PUMP_INTERVAL_MS,
	) {
		if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) { throw new Error('The workflow scheduler interval is invalid.'); }
	}

	start(projectId: string, workflowId: string, expectedRevision: number, idempotencyKey: string): AgentWorkflowRunDTO {
		if (this.stopped) { throw new Error('The workflow scheduler is shutting down.'); }
		const workflow = this.database.agentWorkflows.getWorkflow(projectId, workflowId);
		if (!workflow) { throw new Error('The workflow does not belong to this project.'); }
		const alreadyTracked = [...this.activeRuns.values()].some(run => run.workflowId === workflowId && run.projectId === projectId);
		if (!alreadyTracked && this.activeRuns.size >= MAX_TRACKED_RUNS) { throw new Error('The host is already tracking the maximum number of active workflows.'); }
		const run = this.database.agentWorkflows.startWorkflow(projectId, workflowId, expectedRevision, idempotencyKey);
		const plan = this.database.agentWorkflows.getPlan(projectId, workflowId, run.planVersion);
		if (!plan || plan.fingerprint !== run.fingerprint) { throw new Error('The approved workflow plan is unavailable or changed.'); }
		const active: ActiveRun = { projectId, workflowId, runId: run.id, plan };
		this.activeRuns.set(run.id, active);
		this.recordEvent(active, 'runStarted');
		this.schedulePump();
		return run;
	}

	cancel(projectId: string, workflowId: string, expectedRevision: number, idempotencyKey: string): AgentWorkflowDTO {
		const workflow = this.database.agentWorkflows.requestWorkflowCancellation(projectId, workflowId, expectedRevision, idempotencyKey);
		const active = [...this.activeRuns.values()].find(run => run.projectId === projectId && run.workflowId === workflowId);
		if (active) { this.recordEvent(active, 'cancelRequested'); this.abortPendingLaunches(active); this.schedulePump(); }
		return workflow;
	}

	getHostError(projectId: string, workflowId: string, runId?: string): AgentWorkflowHostErrorCode | null {
		if (runId) { return this.hostErrors.get(this.statusKey(projectId, workflowId, runId)) ?? null; }
		const prefix = `${projectId}:${workflowId}:`;
		let latest: AgentWorkflowHostErrorCode | null = null;
		for (const [key, code] of this.hostErrors) { if (key.startsWith(prefix)) { latest = code; } }
		return latest;
	}

	/** Stops scheduler work synchronously; the session service owns aborting pending acquisitions and PTYs. */
	stopScheduling(): void {
		this.stopped = true;
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
	}

	/** Called before AgentSessionService.shutdown so tracked workflows become non-resumable. */
	requestShutdownCancellation(): void {
		for (const active of this.activeRuns.values()) {
			const workflow = this.database.agentWorkflows.getWorkflow(active.projectId, active.workflowId);
			if (!workflow || ['succeeded', 'failed', 'cancelled', 'blocked'].includes(workflow.state)) { continue; }
			try {
				this.database.agentWorkflows.requestWorkflowCancellation(active.projectId, active.workflowId, workflow.revision, randomUUID());
				this.recordEvent(active, 'cancelRequested');
				this.abortPendingLaunches(active);
			} catch {
				this.setHostError(active, 'schedulerPersistenceFailed');
			}
		}
	}

	/** Reconciles terminal service receipts after shutdown without waiting on scheduler promises. */
	reconcileAfterShutdown(): void {
		for (const active of this.activeRuns.values()) {
			const run = this.database.agentWorkflows.getRun(active.projectId, active.workflowId, active.runId);
			if (!run) { this.setHostError(active, 'schedulerPersistenceFailed'); continue; }
			for (const node of run.nodes) {
				if (node.state !== 'cancelRequested') { continue; }
				if (!node.sessionTurnId) {
					this.transitionNode(active, this.database.agentWorkflows.getRun(active.projectId, active.workflowId, active.runId)!, node, 'cancelled');
					continue;
				}
				const turn = this.database.agentSessionTurns.getTurn(active.projectId, node.sessionId, node.sessionTurnId);
				if (!turn) { this.transitionToRecoveryRequired(active, node); continue; }
				this.finishCancellation(active, node, turn);
			}
		}
		this.activeRuns.clear();
		this.launches.clear();
		this.stops.clear();
		this.stopFailures.clear();
	}

	private schedulePump(): void {
		if (this.stopped || this.timer || this.pumping || this.activeRuns.size === 0) { return; }
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.pump();
		}, this.intervalMs);
		this.timer.unref?.();
	}

	private async pump(): Promise<void> {
		if (this.stopped || this.pumping) { return; }
		this.pumping = true;
		try {
			const timestamp = new Date(this.now()).toISOString();
			if ([...this.activeRuns.values()].some(active => {
				const run = this.database.agentWorkflows.getRun(active.projectId, active.workflowId, active.runId);
				return run && Date.parse(run.deadlineAt) <= this.now() && ['ready', 'running'].includes(run.state);
			})) {
				this.database.agentWorkflows.expireOverdueRuns(timestamp);
				for (const active of this.activeRuns.values()) {
					const run = this.database.agentWorkflows.getRun(active.projectId, active.workflowId, active.runId);
					if (run && Date.parse(run.deadlineAt) <= this.now()) {
						this.recordEvent(active, 'deadlineReached');
						this.setHostError(active, 'deadlineReached');
						this.abortPendingLaunches(active);
					}
				}
			}
			for (const active of [...this.activeRuns.values()]) { this.reconcileRun(active); }
		} catch {
			for (const active of this.activeRuns.values()) { this.setHostError(active, 'schedulerPersistenceFailed'); }
		} finally {
			this.pumping = false;
			this.schedulePump();
		}
	}

	private reconcileRun(active: ActiveRun): void {
		let run = this.database.agentWorkflows.getRun(active.projectId, active.workflowId, active.runId);
		if (!run || run.fingerprint !== active.plan.fingerprint || run.planVersion !== active.plan.version) {
			this.setHostError(active, 'schedulerPersistenceFailed');
			return;
		}
		for (const node of run.nodes) {
			if (node.state === 'waiting' && this.dependenciesSucceeded(active.plan, run, node.nodeId)) {
				run = this.transitionNode(active, run, node, 'ready');
				continue;
			}
			if (node.state === 'cancelRequested') {
				if (!node.sessionTurnId) {
					this.abortPendingLaunches(active, node.nodeId);
					if (![...this.launches.values()].some(operation => operation.active.runId === active.runId && operation.nodeId === node.nodeId)) {
						this.transitionNode(active, run, node, 'cancelled');
					}
				} else {
					const turn = this.database.agentSessionTurns.getTurn(active.projectId, node.sessionId, node.sessionTurnId);
					if (turn && !this.isTerminalTurn(turn)) { this.stopExactTurn(active, node, turn.id); }
					else if (turn) { this.finishCancellation(active, node, turn); }
					else { this.transitionToRecoveryRequired(active, node); }
				}
				continue;
			}
			if ((node.state === 'launching' || node.state === 'running') && node.sessionTurnId) {
				const turn = this.database.agentSessionTurns.getTurn(active.projectId, node.sessionId, node.sessionTurnId);
				if (turn) { this.reconcileTurn(active, run, node, turn); }
				continue;
			}
			if (node.state === 'launching' && !node.sessionTurnId) { continue; }
			if (node.state === 'ready' && this.dependenciesSucceeded(active.plan, run, node.nodeId) && ['ready', 'running'].includes(run.state)) {
				this.launchReadyNode(active, run, node);
			}
		}
		run = this.database.agentWorkflows.getRun(active.projectId, active.workflowId, active.runId) ?? run;
		if (this.isTerminalRun(run) && !this.hasPendingOperation(active.runId)) {
			this.activeRuns.delete(active.runId);
			for (const node of run.nodes) { if (node.sessionTurnId) { this.stopFailures.delete(node.sessionTurnId); } }
		}
	}

	private reconcileTurn(active: ActiveRun, run: AgentWorkflowRunDTO, node: AgentWorkflowNodeExecutionDTO, turn: AgentSessionTurnDTO): void {
		if (node.state === 'cancelRequested') { this.finishCancellation(active, node, turn); return; }
		if (turn.state === 'running' && node.state === 'launching') {
			this.transitionNode(active, run, node, 'running', turn.id);
			return;
		}
		if (!this.isTerminalTurn(turn)) { return; }
		if (turn.state === 'interrupted') {
			this.transitionNode(active, run, node, 'interrupted');
			this.setHostError(active, 'recoveryRequired');
			this.recordEvent(active, 'recoveryRequired', node.nodeId, node.revision);
			return;
		}
		if (!turn.cleanupVerified) {
			const requested = node.state === 'cancelRequested' ? node : this.transitionNode(active, run, node, 'cancelRequested').nodes.find(value => value.nodeId === node.nodeId)!;
			this.stopExactTurn(active, requested, turn.id);
			return;
		}
		if (turn.state === 'exited' && turn.exitCode === 0) {
			this.transitionNode(active, run, node, 'succeeded');
			this.recordEvent(active, 'executionSucceeded', node.nodeId, node.revision);
			return;
		}
		if (turn.state === 'failed' || turn.state === 'exited') {
			this.transitionNode(active, run, node, 'failed');
			this.recordEvent(active, 'executionFailed', node.nodeId, node.revision);
		}
	}

	private launchReadyNode(active: ActiveRun, run: AgentWorkflowRunDTO, node: AgentWorkflowNodeExecutionDTO): void {
		const planNode = active.plan.nodes.find(candidate => candidate.nodeId === node.nodeId);
		const session = planNode && this.database.agentSessions.getSession(active.projectId, planNode.sessionId);
		if (!planNode || !session) {
			this.blockNode(active, run, node, 'launchFailed');
			return;
		}
		let reservation: ReturnType<WorkspaceDatabase['agentWorkflows']['reserveNodeTurnLaunch']>;
		try {
			reservation = this.database.agentWorkflows.reserveNodeTurnLaunch(active.projectId, active.workflowId, active.runId, node.nodeId, node.revision, session.revision);
		} catch (error) {
			if (error instanceof Error && /maximum concurrency/i.test(error.message)) { return; }
			this.blockNode(active, run, node, 'launchFailed');
			return;
		}
		if (this.launches.has(reservation.turnId)) { return; }
		const operation: LaunchOperation = { active, nodeId: node.nodeId, sessionId: planNode.sessionId, turnId: reservation.turnId, abortController: new AbortController() };
		this.launches.set(reservation.turnId, operation);
		void this.sessions.startWorkflowNode({
			projectId: active.projectId,
			sessionId: planNode.sessionId,
			permissionPolicy: planNode.permissionPolicy,
			reservationId: reservation.reservationId,
			signal: operation.abortController.signal,
		}).then(() => undefined, () => this.handleLaunchFailure(operation)).finally(() => {
			this.launches.delete(reservation.turnId);
			this.schedulePump();
		}).catch(() => {
			this.setHostError(active, 'schedulerPersistenceFailed');
		});
	}

	private handleLaunchFailure(operation: LaunchOperation): void {
		const { active, nodeId, sessionId, turnId } = operation;
		this.setHostError(active, 'launchFailed');
		this.recordEvent(active, 'launchFailed', nodeId, this.database.agentWorkflows.getRun(active.projectId, active.workflowId, active.runId)?.nodes.find(value => value.nodeId === nodeId)?.revision ?? 1);
		const turn = this.database.agentSessionTurns.getTurn(active.projectId, sessionId, turnId);
		if (turn) { return; }
		const run = this.database.agentWorkflows.getRun(active.projectId, active.workflowId, active.runId);
		const node = run?.nodes.find(value => value.nodeId === nodeId);
		if (run && node?.state === 'launching' && node.sessionTurnId === null) {
			try { this.transitionNode(active, run, node, 'blocked'); }
			catch { this.setHostError(active, 'schedulerPersistenceFailed'); }
		}
	}

	private blockNode(active: ActiveRun, run: AgentWorkflowRunDTO, node: AgentWorkflowNodeExecutionDTO, code: AgentWorkflowHostErrorCode): void {
		this.setHostError(active, code);
		this.recordEvent(active, code, node.nodeId, node.revision);
		try { this.transitionNode(active, run, node, 'blocked'); }
		catch { this.setHostError(active, 'schedulerPersistenceFailed'); }
	}

	private stopExactTurn(active: ActiveRun, node: AgentWorkflowNodeExecutionDTO, turnId: string): void {
		if (this.stops.has(turnId) || this.stopFailures.has(turnId)) { return; }
		const operation: StopOperation = { active, nodeId: node.nodeId, sessionId: node.sessionId };
		this.stops.set(turnId, operation);
		void this.sessions.stop(active.projectId, node.sessionId, turnId).then(turn => {
			if (!turn.cleanupVerified) { this.stopFailures.add(turnId); this.markStopUnverified(active, node); }
		}, () => {
			this.stopFailures.add(turnId);
			this.markStopUnverified(active, node);
		}).finally(() => {
			this.stops.delete(turnId);
			this.schedulePump();
		}).catch(() => {
			this.setHostError(active, 'schedulerPersistenceFailed');
		});
	}

	private finishCancellation(active: ActiveRun, node: AgentWorkflowNodeExecutionDTO, turn: AgentSessionTurnDTO): void {
		if (!turn.cleanupVerified) {
			this.markStopUnverified(active, node);
			return;
		}
		this.transitionNode(active, this.database.agentWorkflows.getRun(active.projectId, active.workflowId, active.runId)!, node, 'cancelled');
	}

	private transitionToRecoveryRequired(active: ActiveRun, node: AgentWorkflowNodeExecutionDTO): void {
		this.setHostError(active, 'recoveryRequired');
		this.recordEvent(active, 'recoveryRequired', node.nodeId, node.revision);
		if (node.state === 'recoveryRequired') { return; }
		const run = this.database.agentWorkflows.getRun(active.projectId, active.workflowId, active.runId);
		if (!run) { return; }
		try { this.transitionNode(active, run, node, 'recoveryRequired'); }
		catch { this.setHostError(active, 'schedulerPersistenceFailed'); }
	}

	private transitionNode(active: ActiveRun, run: AgentWorkflowRunDTO, node: AgentWorkflowNodeExecutionDTO, state: Parameters<WorkspaceDatabase['agentWorkflows']['transitionNode']>[5], turnId?: string): AgentWorkflowRunDTO {
		try {
			return this.database.agentWorkflows.transitionNode(active.projectId, active.workflowId, active.runId, node.nodeId, node.revision, state, turnId);
		} catch {
			this.setHostError(active, 'schedulerPersistenceFailed');
			throw new Error('Workflow state reconciliation failed.');
		}
	}

	private dependenciesSucceeded(plan: AgentWorkflowPlan, run: AgentWorkflowRunDTO, nodeId: string): boolean {
		const node = plan.nodes.find(value => value.nodeId === nodeId);
		return Boolean(node && node.dependsOn.every(dependency => run.nodes.find(value => value.nodeId === dependency)?.state === 'succeeded'));
	}

	private isTerminalTurn(turn: AgentSessionTurnDTO): boolean { return turn.state === 'exited' || turn.state === 'failed' || turn.state === 'interrupted'; }
	private isTerminalRun(run: AgentWorkflowRunDTO): boolean { return ['succeeded', 'failed', 'cancelled', 'blocked', 'recoveryRequired'].includes(run.state); }
	private hasPendingOperation(runId: string): boolean {
		return [...this.launches.values()].some(operation => operation.active.runId === runId)
			|| [...this.stops.values()].some(operation => operation.active.runId === runId);
	}

	private recordEvent(active: ActiveRun, kind: string, nodeId?: string, revision?: number): void {
		try {
			const currentRevision = nodeId ? this.database.agentWorkflows.getRun(active.projectId, active.workflowId, active.runId)?.nodes.find(value => value.nodeId === nodeId)?.revision : undefined;
			const eventRevision = nodeId ? revision ?? currentRevision ?? 1 : 1;
			const subject = nodeId ? `node:${nodeId}:revision:${eventRevision}` : 'run';
			const key = `scheduler:${active.runId}:${subject}:${kind}`;
			this.database.agentWorkflows.recordSourceEvent(active.projectId, active.workflowId, key, { source: 'hostScheduler', kind, nodeId: nodeId ?? null, revision: nodeId ? eventRevision : null });
		} catch {
			this.setHostError(active, 'schedulerPersistenceFailed');
		}
	}

	private abortPendingLaunches(active: ActiveRun, nodeId?: string): void {
		for (const operation of this.launches.values()) {
			if (operation.active.runId === active.runId && (!nodeId || operation.nodeId === nodeId)) { operation.abortController.abort(); }
		}
	}

	private markStopUnverified(active: ActiveRun, node: AgentWorkflowNodeExecutionDTO): void {
		this.setHostError(active, 'stopUnverified');
		this.recordEvent(active, 'stopUnverified', node.nodeId, node.revision);
		this.transitionToRecoveryRequired(active, node);
	}

	private setHostError(active: ActiveRun, code: AgentWorkflowHostErrorCode): void {
		const key = this.statusKey(active.projectId, active.workflowId, active.runId);
		this.hostErrors.delete(key);
		this.hostErrors.set(key, code);
		while (this.hostErrors.size > MAX_RETAINED_ERRORS) { this.hostErrors.delete(this.hostErrors.keys().next().value!); }
	}

	private statusKey(projectId: string, workflowId: string, runId: string): string { return `${projectId}:${workflowId}:${runId}`; }
}
