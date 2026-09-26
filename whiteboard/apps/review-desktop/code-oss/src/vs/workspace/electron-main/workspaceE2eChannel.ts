/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import type { WebContents } from 'electron';
import { isUUID } from '../../base/common/uuid.js';
import type { WorkspaceDashboardDTO } from '../common/workspaceDashboardProtocol.js';
import type { StartWorkspaceE2eRequest, WorkspaceE2eEvidenceDTO, WorkspaceE2eRequest, WorkspaceE2eStep } from '../common/workspaceE2eProtocol.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase, type WorkspaceE2eEvidence } from './workspaceDatabase.js';
import { EgoBrowserCaptureError } from './browserCapture/egoCaptureRuntime.js';
import { EgoE2eEvidenceError, type EgoE2eRuntime, type EgoE2eRunResult } from './browserCapture/egoE2eRuntime.js';

const maximumScenarioSteps = 30;
const maximumSelectorLength = 500;
const maximumValueLength = 2000;
const maximumUrlLength = 4096;
const maximumEnvironmentLength = 500;
const maximumSavedBrowserEvents = 2000;
const savedBrowserEventMethods = new Set(['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']);
const savedConsoleLevels = new Set(['log', 'info', 'warn', 'warning', 'error', 'debug']);

/** Save only bounded browser diagnostics. CDP events can contain cookies, headers, tokens, and page text. */
function redactedBrowserLog(rawLog: string): Buffer {
	let events: unknown;
	try { events = JSON.parse(rawLog); }
	catch { throw new Error('Ego Browser returned an invalid event log.'); }
	if (!Array.isArray(events)) { throw new Error('Ego Browser returned an invalid event log.'); }
	const saved: Array<{ method: string; status?: number; level?: string }> = [];
	for (const value of events) {
		if (saved.length >= maximumSavedBrowserEvents) { break; }
		if (typeof value !== 'object' || value === null || Array.isArray(value)) { continue; }
		const event = value as Record<string, unknown>;
		if (typeof event.method !== 'string' || !savedBrowserEventMethods.has(event.method)) { continue; }
		const method = event.method;
		const params = typeof event.params === 'object' && event.params !== null && !Array.isArray(event.params) ? event.params as Record<string, unknown> : {};
		if (method === 'Network.responseReceived') {
			const response = typeof params.response === 'object' && params.response !== null && !Array.isArray(params.response) ? params.response as Record<string, unknown> : {};
			const rawStatus = response.status ?? event.status;
			const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
			saved.push({ method, ...(status !== undefined ? { status } : {}) });
		} else if (method === 'Runtime.consoleAPICalled' || method === 'Log.entryAdded') {
			const entry = typeof params.entry === 'object' && params.entry !== null && !Array.isArray(params.entry) ? params.entry as Record<string, unknown> : {};
			const rawLevel = method === 'Log.entryAdded' ? entry.level : params.type;
			const level = typeof rawLevel === 'string' && savedConsoleLevels.has(rawLevel) ? rawLevel : undefined;
			saved.push({ method, ...(level ? { level } : {}) });
		} else {
			saved.push({ method });
		}
	}
	return Buffer.from(JSON.stringify(saved), 'utf8');
}

interface ActiveCheck { readonly sender: WebContents; readonly projectId: string; readonly taskId: string; readonly spaceId: number; completion?: Promise<void>; }

/** Project-window-only broker for durable, task-linked Ego frontend checks. */
export class WorkspaceE2eChannel {
	private readonly active = new Map<string, ActiveCheck>();
	private readonly destroyed = new WeakSet<WebContents>();
	private readonly cancelling = new Set<string>();
	private readonly pendingStarts = new Set<Promise<unknown>>();
	private readonly pendingExecutions = new Set<Promise<void>>();
	private readonly pendingControls = new Map<string, { command: string; operation: Promise<{ evidence: WorkspaceE2eEvidenceDTO }> }>();
	private readonly recovery: Promise<void>;
	private recoveryError: unknown;
	private closing = false;

	constructor(private readonly database: WorkspaceDatabase, private readonly dashboardChannel: WorkspaceDashboardChannel, private readonly runtime: EgoE2eRuntime, private readonly artifactDirectory: string) {
		this.recovery = this.recoverInterruptedChecks().catch(error => { this.recoveryError = error; });
	}

	async call<T>(sender: WebContents, command: string, value?: unknown): Promise<T> {
		if (this.closing) { throw new Error('The project app is closing; E2E checks are unavailable.'); }
		await this.recovery;
		if (this.recoveryError) { throw new Error(`Could not recover previous E2E checks: ${this.safeFailure(this.recoveryError)}`); }
		if (this.closing) { throw new Error('The project app is closing; E2E checks are unavailable.'); }
		if (command === 'start') {
			const pending = this.start(sender, this.parseStart(value));
			this.pendingStarts.add(pending);
			try { return await pending as T; }
			finally { this.pendingStarts.delete(pending); }
		}
		if (command === 'list') { const request = this.parseScope(value); await this.authorizeTask(sender, request.projectId, request.taskId); return { evidence: this.database.listWorkspaceE2eEvidence(request.taskId).map(item => this.dto(item)) } as T; }
		const request = this.parseRequest(value);
		await this.authorizeTask(sender, request.projectId, request.taskId);
		const evidence = this.requireEvidence(request);
		if (command !== 'cancel' && command !== 'retryCleanup') { throw new Error(`Call not found: ${command}`); }
		const existing = this.pendingControls.get(evidence.id);
		if (existing) {
			if (existing.command === 'cancel' && command === 'cancel') { return await existing.operation as T; }
			throw new Error('An E2E cleanup operation is already in progress for this check.');
		}
		const operation = command === 'cancel' ? this.cancel(evidence) : this.retryCleanup(evidence);
		this.pendingControls.set(evidence.id, { command, operation });
		try { return await operation as T; }
		finally { if (this.pendingControls.get(evidence.id)?.operation === operation) { this.pendingControls.delete(evidence.id); } }
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		const failures: Error[] = [];
		await this.recovery;
		const activeIds = new Set(this.active.keys());
		for (const id of activeIds) { this.cancelling.add(id); }
		try { await this.runtime.shutdown?.(); } catch (error) { failures.push(new Error(`Could not stop Ego E2E processes: ${this.safeFailure(error)}`)); }
		const starting = await Promise.allSettled([...this.pendingStarts, this.recovery]);
		for (const result of starting) { if (result.status === 'rejected') { failures.push(new Error(`E2E start failed during shutdown: ${this.safeFailure(result.reason)}`)); } }
		for (const id of this.active.keys()) { activeIds.add(id); this.cancelling.add(id); }
		try { await this.runtime.shutdown?.(); } catch (error) { failures.push(new Error(`Could not stop Ego E2E processes: ${this.safeFailure(error)}`)); }
		const pending = await Promise.allSettled([...this.pendingExecutions]);
		for (const result of pending) { if (result.status === 'rejected') { failures.push(new Error(`E2E operation failed during shutdown: ${this.safeFailure(result.reason)}`)); } }
		const controls = await Promise.allSettled([...this.pendingControls.values()].map(item => item.operation));
		for (const result of controls) { if (result.status === 'rejected') { failures.push(new Error(`E2E cleanup operation failed during shutdown: ${this.safeFailure(result.reason)}`)); } }
		if (this.recoveryError) { failures.push(new Error(`E2E restart recovery failed: ${this.safeFailure(this.recoveryError)}`)); }
		for (const id of activeIds) {
			const evidence = this.database.getWorkspaceE2eEvidence(id);
			if (!evidence || (evidence.state !== 'running' && evidence.state !== 'cleanupFailed')) { this.cancelling.delete(id); continue; }
			let result: EgoE2eRunResult;
			try { result = await this.runtime.finish(evidence.taskSpaceId); }
			catch (error) {
				if (error instanceof EgoE2eEvidenceError) { this.markEvidenceFailure(id, `Ego closed during app shutdown, but evidence could not be captured: ${this.safeFailure(error)}`); failures.push(new Error(`E2E check ${id} evidence could not be captured.`)); }
				else { this.markCleanupFailure(id, `App closing cleanup failed: ${this.safeFailure(error)}`); failures.push(new Error(`E2E check ${id} cleanup is unverified.`)); }
				this.cancelling.delete(id); continue;
			}
			try {
				const artifacts = await this.persistArtifacts(id, result);
				this.database.finishWorkspaceE2eEvidence({ id, state: 'cancelled', ...artifacts, failure: 'Check cancelled because the project app is closing.', cleanupError: null });
			} catch (error) { this.markEvidenceFailure(id, `Ego closed, but evidence could not be saved: ${this.safeFailure(error)}`); failures.push(new Error(`E2E check ${id} evidence could not be saved.`)); }
			this.cancelling.delete(id);
		}
		try { await this.runtime.shutdown?.(); } catch (error) { failures.push(new Error(`Could not stop Ego E2E processes: ${this.safeFailure(error)}`)); }
		if (failures.length) { throw new AggregateError(failures, 'Ego E2E cleanup did not finish cleanly.'); }
	}

	private async start(sender: WebContents, request: StartWorkspaceE2eRequest): Promise<{ evidence: WorkspaceE2eEvidenceDTO }> {
		this.watchSender(sender);
		await this.authorizeTask(sender, request.projectId, request.taskId);
		if (this.destroyed.has(sender) || sender.isDestroyed()) { throw new Error('The project window closed before the E2E check could start.'); }
		const task = this.database.getTask(request.taskId)!;
		const attempt = this.database.getProviderAttempt(request.attemptId);
		if (!attempt || attempt.taskId !== task.id || attempt.purpose !== 'task') { throw new Error('Frontend E2E checks require a provider attempt linked to this task.'); }
		const targetUrl = this.validateTargetUrl(request.targetUrl);
		const scenario = this.validateScenario(request.scenario);
		const environmentIdentity = this.validateEnvironment(request.environmentIdentity);
		const evidenceId = randomUUID();
		let spaceId: number | undefined;
		try {
			spaceId = await this.runtime.createSpace();
			const evidence = this.database.createWorkspaceE2eEvidence({ id: evidenceId, projectId: request.projectId, taskId: request.taskId, attemptId: request.attemptId, targetUrl, environmentIdentity, scenario, taskSpaceId: spaceId });
			if (this.closing || this.destroyed.has(sender) || sender.isDestroyed()) {
				let result: EgoE2eRunResult;
				try { result = await this.runtime.finish(spaceId); }
				catch (error) {
					if (error instanceof EgoE2eEvidenceError) { this.markEvidenceFailure(evidence.id, `Window closed and Ego was cleaned up, but evidence could not be captured: ${this.safeFailure(error)}`); }
					else { this.markCleanupFailure(evidence.id, `Window closed before check start; Ego cleanup failed: ${this.safeFailure(error)}`); }
					spaceId = undefined; throw error;
				}
				spaceId = undefined;
				try {
					const artifacts = await this.persistArtifacts(evidence.id, result);
					this.database.finishWorkspaceE2eEvidence({ id: evidence.id, state: 'cancelled', ...artifacts, failure: 'The project window closed before the check started.', cleanupError: null });
				} catch (error) { this.markEvidenceFailure(evidence.id, `The project window closed and Ego was cleaned up, but evidence could not be saved: ${this.safeFailure(error)}`); }
				throw new Error('The project window closed before the E2E check could start.');
			}
			const active: ActiveCheck = { sender, projectId: request.projectId, taskId: request.taskId, spaceId };
			this.active.set(evidence.id, active);
			const completion = this.execute(evidence.id, active, targetUrl, scenario);
			active.completion = completion;
			this.pendingExecutions.add(completion);
			void completion.then(() => this.pendingExecutions.delete(completion), () => this.pendingExecutions.delete(completion));
			return { evidence: this.dto(evidence) };
		} catch (error) {
			if (spaceId !== undefined) { try { await this.runtime.finish(spaceId); } catch (cleanupError) {
				if (this.database.getWorkspaceE2eEvidence(evidenceId)) {
					if (cleanupError instanceof EgoE2eEvidenceError) { this.markEvidenceFailure(evidenceId, `Ego setup failed after cleanup, but evidence could not be captured: ${this.safeFailure(cleanupError)}`); }
					else { this.markCleanupFailure(evidenceId, `Ego setup failed and cleanup is unverified: ${this.safeFailure(cleanupError)}`); }
				}
				throw cleanupError;
			} }
			throw error;
		}
	}

	private async execute(id: string, active: ActiveCheck, targetUrl: string, scenario: readonly WorkspaceE2eStep[]): Promise<void> {
		let result: EgoE2eRunResult | undefined;
		try {
			result = await this.runtime.run(active.spaceId, targetUrl, scenario, id);
			const artifacts = await this.persistArtifacts(id, result);
			const latest = this.database.getWorkspaceE2eEvidence(id)!;
			if (latest.state === 'running') {
				this.database.finishWorkspaceE2eEvidence({ id, state: this.cancelling.has(id) ? 'cancelled' : result.passed ? 'passed' : 'failed', ...artifacts, failure: this.cancelling.has(id) ? 'Check cancelled by the user.' : result.failure, cleanupError: null });
			}
		} catch (error) {
			if (result) { this.markEvidenceFailure(id, `Ego closed, but evidence could not be saved: ${this.safeFailure(error)}`); return; }
			if (error instanceof EgoE2eEvidenceError) { this.markEvidenceFailure(id, `Ego closed, but evidence could not be captured: ${this.safeFailure(error)}`); return; }
			if (this.cancelling.has(id)) { return; }
			if (error instanceof EgoBrowserCaptureError && /cleanup failed|could not close/.test(error.message)) { this.markCleanupFailure(id, error.message); }
			else {
				let cleanupResult: EgoE2eRunResult;
				try { cleanupResult = await this.runtime.finish(active.spaceId); }
				catch (cleanupError) { this.markCleanupFailure(id, `${this.safeFailure(error)} Task-space cleanup could not be confirmed: ${this.safeFailure(cleanupError)}`); return; }
				try {
					const artifacts = await this.persistArtifacts(id, cleanupResult);
					this.database.finishWorkspaceE2eEvidence({ id, state: 'failed', ...artifacts, failure: this.safeFailure(error), cleanupError: null });
				} catch (captureError) { this.markEvidenceFailure(id, `Ego closed after an E2E error, but evidence could not be saved: ${this.safeFailure(captureError)}`); }
			}
		} finally { this.active.delete(id); }
	}

	private async persistArtifacts(id: string, result: EgoE2eRunResult): Promise<{ screenshotSha256: string; screenshotPath: string; logSha256: string; logPath: string }> {
		await mkdir(this.artifactDirectory, { recursive: true, mode: 0o700 });
		const screenshotPath = `${this.artifactDirectory}/${id}.png`;
		const logPath = `${this.artifactDirectory}/${id}.json`;
		const log = redactedBrowserLog(result.log);
		try {
			await this.writeArtifact(screenshotPath, result.screenshot);
			await this.writeArtifact(logPath, log);
		} catch (error) {
			const cleanup = await Promise.allSettled([rm(screenshotPath, { force: true }), rm(logPath, { force: true })]);
			const failures = cleanup.filter(item => item.status === 'rejected').map(item => (item as PromiseRejectedResult).reason);
			if (failures.length) { throw new AggregateError([error, ...failures], 'Could not save or clean up E2E artifacts.'); }
			throw error;
		}
		return { screenshotSha256: createHash('sha256').update(result.screenshot).digest('hex'), screenshotPath, logSha256: createHash('sha256').update(log).digest('hex'), logPath };
	}

	private async writeArtifact(path: string, data: Uint8Array): Promise<void> {
		const temporaryPath = `${path}.${randomUUID()}.tmp`;
		try { await writeFile(temporaryPath, data, { flag: 'wx', mode: 0o600 }); await rename(temporaryPath, path); }
		catch (error) { try { await rm(temporaryPath, { force: true }); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Could not persist or clean up an E2E artifact.'); } throw new Error(`Could not persist E2E artifact: ${this.safeFailure(error)}`); }
	}

	private async cancel(evidence: WorkspaceE2eEvidence): Promise<{ evidence: WorkspaceE2eEvidenceDTO }> {
		if (!['running', 'cleanupFailed'].includes(evidence.state)) { return { evidence: this.dto(evidence) }; }
		const active = this.active.get(evidence.id);
		this.cancelling.add(evidence.id);
		try {
			if (active) {
				try { await this.runtime.stop?.(evidence.id); }
				catch (error) { console.error(`Could not stop E2E check ${evidence.id} before cancellation: ${this.safeFailure(error)}`); }
				await active.completion;
			}
			const current = this.database.getWorkspaceE2eEvidence(evidence.id)!;
			if (current.state !== 'running' && current.state !== 'cleanupFailed') { return { evidence: this.dto(current) }; }
			let result: EgoE2eRunResult;
			try { result = await this.runtime.finish(evidence.taskSpaceId); }
			catch (error) {
				if (error instanceof EgoE2eEvidenceError) { this.markEvidenceFailure(evidence.id, `Ego closed after cancellation, but evidence could not be captured: ${this.safeFailure(error)}`); }
				else { this.markCleanupFailure(evidence.id, `Check cancelled, but Ego cleanup failed: ${this.safeFailure(error)}`); }
				return { evidence: this.dto(this.database.getWorkspaceE2eEvidence(evidence.id)!) };
			}
			try {
				const artifacts = await this.persistArtifacts(evidence.id, result);
				const updated = this.database.finishWorkspaceE2eEvidence({ id: evidence.id, state: 'cancelled', ...artifacts, failure: 'Check cancelled by the user.', cleanupError: null });
				return { evidence: this.dto(updated) };
			} catch (error) { this.markEvidenceFailure(evidence.id, `Ego closed after cancellation, but evidence could not be saved: ${this.safeFailure(error)}`); return { evidence: this.dto(this.database.getWorkspaceE2eEvidence(evidence.id)!) }; }
		} catch (error) {
			this.markCleanupFailure(evidence.id, `Check cancellation failed: ${this.safeFailure(error)}`);
			return { evidence: this.dto(this.database.getWorkspaceE2eEvidence(evidence.id)!) };
		} finally { this.cancelling.delete(evidence.id); }
	}

	private async retryCleanup(evidence: WorkspaceE2eEvidence): Promise<{ evidence: WorkspaceE2eEvidenceDTO }> {
		if (evidence.state !== 'cleanupFailed' || this.active.has(evidence.id)) { throw new Error('Cleanup can only be retried after a check has stopped with an unverified Ego task space.'); }
		let result: EgoE2eRunResult;
		try { result = await this.runtime.finish(evidence.taskSpaceId); }
		catch (error) {
			if (error instanceof EgoE2eEvidenceError) { this.markEvidenceFailure(evidence.id, `Ego closed after cleanup retry, but evidence could not be captured: ${this.safeFailure(error)}`); }
			else { this.markCleanupFailure(evidence.id, `Cleanup retry failed: ${this.safeFailure(error)}`); }
			return { evidence: this.dto(this.database.getWorkspaceE2eEvidence(evidence.id)!) };
		}
		try {
			const artifacts = await this.persistArtifacts(evidence.id, result);
			const state = evidence.failure?.startsWith('Check cancelled') ? 'cancelled' : 'failed';
			const updated = this.database.finishWorkspaceE2eEvidence({ id: evidence.id, state, ...artifacts, failure: evidence.failure ?? 'The E2E check was interrupted before a result was captured.', cleanupError: null });
			return { evidence: this.dto(updated) };
		} catch (error) {
			this.markEvidenceFailure(evidence.id, `Ego closed after cleanup retry, but evidence could not be saved: ${this.safeFailure(error)}`);
			return { evidence: this.dto(this.database.getWorkspaceE2eEvidence(evidence.id)!) };
		}
	}

	private async recoverInterruptedChecks(): Promise<void> {
		for (const project of this.database.listProjects()) {
			for (const task of this.database.listTasks(project.id)) {
				for (const evidence of this.database.listWorkspaceE2eEvidence(task.id)) {
					if (evidence.state !== 'running' && evidence.state !== 'cleanupFailed') { continue; }
					let result: EgoE2eRunResult;
					try { result = await this.runtime.finish(evidence.taskSpaceId); }
					catch (error) {
						if (error instanceof EgoE2eEvidenceError) { this.markEvidenceFailure(evidence.id, `Ego closed after restart, but evidence could not be captured: ${this.safeFailure(error)}`); }
						else { this.markCleanupFailure(evidence.id, `Restart cleanup failed: ${this.safeFailure(error)}`); }
						continue;
					}
					try {
						const artifacts = await this.persistArtifacts(evidence.id, result);
						this.database.finishWorkspaceE2eEvidence({ id: evidence.id, state: 'failed', ...artifacts, failure: 'The app restarted before this check completed.', cleanupError: null });
					} catch (error) { this.markEvidenceFailure(evidence.id, `Ego closed after restart, but evidence could not be saved: ${this.safeFailure(error)}`); }
				}
			}
		}
	}

	private markCleanupFailure(id: string, message: string): void {
		try { this.database.finishWorkspaceE2eEvidence({ id, state: 'cleanupFailed', screenshotSha256: null, screenshotPath: null, logSha256: null, logPath: null, failure: message.slice(0, 512), cleanupError: message.slice(0, 512) }); }
		catch (error) { console.error(`Could not persist cleanup failure for E2E check ${id}: ${this.safeFailure(error)}`); }
	}

	private markEvidenceFailure(id: string, message: string): void {
		try { this.database.finishWorkspaceE2eEvidence({ id, state: 'failed', screenshotSha256: null, screenshotPath: null, logSha256: null, logPath: null, failure: message.slice(0, 512), cleanupError: null }); }
		catch (error) { console.error(`Could not persist evidence failure for E2E check ${id}: ${this.safeFailure(error)}`); }
	}

	private watchSender(sender: WebContents): void {
		sender.once('destroyed', () => {
			this.destroyed.add(sender);
			for (const [id, active] of this.active) {
				if (active.sender === sender) { void (async () => {
					try { await this.runtime.stop?.(id); }
					catch (error) { console.error(`Could not stop E2E check ${id} after its window closed: ${this.safeFailure(error)}`); }
				})(); }
			}
		});
	}

	private async authorizeTask(sender: WebContents, projectId: string, taskId: string): Promise<void> {
		const dashboard = await this.dashboardChannel.call<WorkspaceDashboardDTO>(sender, 'getDashboard', projectId);
		if (!dashboard.tasks.some(task => task.id === taskId)) { throw new Error('The task does not belong to this project.'); }
	}

	private requireEvidence(request: WorkspaceE2eRequest): WorkspaceE2eEvidence {
		const evidence = this.database.getWorkspaceE2eEvidence(request.evidenceId);
		if (!evidence || evidence.projectId !== request.projectId || evidence.taskId !== request.taskId) { throw new Error('E2E evidence is unavailable in this project and task.'); }
		return evidence;
	}

	private validateTargetUrl(value: string): string {
		if (typeof value !== 'string' || value.length > maximumUrlLength) { throw new Error('Target URL is too long.'); }
		let url: URL; try { url = new URL(value); } catch { throw new Error('Target URL must be valid HTTP or HTTPS.'); }
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { throw new Error('Target URL must use HTTP or HTTPS without embedded credentials.'); }
		return url.toString();
	}

	private validateScenario(value: readonly WorkspaceE2eStep[]): readonly WorkspaceE2eStep[] {
		if (!Array.isArray(value) || value.length < 1 || value.length > maximumScenarioSteps) { throw new Error(`Scenario must contain 1 to ${maximumScenarioSteps} steps.`); }
		return value.map((step, index) => {
			if (!step || !['click', 'fill', 'assertText'].includes(step.type) || typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > maximumSelectorLength) { throw new Error(`Scenario step ${index + 1} is invalid.`); }
			if (step.type === 'click') { return { type: 'click', selector: step.selector.trim() }; }
			if (typeof step.value !== 'string' || step.value.length > maximumValueLength || (step.type === 'assertText' && !step.value.trim())) { throw new Error(`Scenario step ${index + 1} has an invalid value.`); }
			return { type: step.type, selector: step.selector.trim(), value: step.value };
		});
	}

	private validateEnvironment(value: string): string { if (typeof value !== 'string' || !value.trim() || value.length > maximumEnvironmentLength || /[\r\n\u0000-\u001f]/.test(value)) { throw new Error('A short environment identity is required.'); } return value.trim(); }
	private parseStart(value: unknown): StartWorkspaceE2eRequest { const item = this.record(value); const scope = this.parseScope(item); if (typeof item.attemptId !== 'string' || !isUUID(item.attemptId) || typeof item.targetUrl !== 'string' || typeof item.environmentIdentity !== 'string' || !Array.isArray(item.scenario)) { throw new Error('A provider attempt, target, environment, and scenario are required.'); } return { ...scope, attemptId: item.attemptId, targetUrl: item.targetUrl, environmentIdentity: item.environmentIdentity, scenario: item.scenario as WorkspaceE2eStep[] }; }
	private parseScope(value: unknown): { projectId: string; taskId: string } { const item = this.record(value); if (typeof item.projectId !== 'string' || !isUUID(item.projectId) || typeof item.taskId !== 'string' || !isUUID(item.taskId)) { throw new Error('Valid project and task IDs are required.'); } return { projectId: item.projectId, taskId: item.taskId }; }
	private parseRequest(value: unknown): WorkspaceE2eRequest { const item = this.record(value); const scope = this.parseScope(item); if (typeof item.evidenceId !== 'string' || !isUUID(item.evidenceId)) { throw new Error('A valid E2E evidence ID is required.'); } return { ...scope, evidenceId: item.evidenceId }; }
	private record(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('An E2E request is required.'); } return value as Record<string, unknown>; }
	private dto(value: WorkspaceE2eEvidence): WorkspaceE2eEvidenceDTO { return { id: value.id, taskId: value.taskId, attemptId: value.attemptId, targetUrl: value.targetUrl, environmentIdentity: value.environmentIdentity, scenario: value.scenario, state: value.state, taskSpaceId: value.taskSpaceId, screenshotSha256: value.screenshotSha256, screenshotPath: value.screenshotPath, logSha256: value.logSha256, logPath: value.logPath, failure: value.failure, cleanupError: value.cleanupError, createdAt: value.createdAt, completedAt: value.completedAt }; }
	private safeFailure(error: unknown): string { return (error instanceof Error ? error.message : 'Ego E2E operation failed.').replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 512); }
}
