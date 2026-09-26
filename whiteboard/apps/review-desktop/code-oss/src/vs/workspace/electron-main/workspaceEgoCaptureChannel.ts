/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { isUUID } from '../../base/common/uuid.js';
import type { WorkspaceDashboardDTO } from '../common/workspaceDashboardProtocol.js';
import type { StartWorkspaceEgoCaptureRequest, WorkspaceEgoCaptureRecoveryRequest, WorkspaceEgoCaptureRecoveryStatus, WorkspaceEgoCaptureRequest, WorkspaceEgoCaptureStatus, WorkspaceEgoSelectedText } from '../common/workspaceBrowserCaptureProtocol.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import { EgoBrowserCaptureError, type EgoCaptureRuntime } from './browserCapture/egoCaptureRuntime.js';

const maximumSelectedTextBytes = 512 * 1024;
const maximumSourceUrlLength = 4096;
const maximumTitleLength = 500;
const maximumActiveSessions = 16;

function isSessionPhase(session: CaptureSession, phase: CaptureSession['phase']): boolean {
	return session.phase === phase;
}

interface CaptureSession {
	readonly sender: WebContents;
	readonly projectId: string;
	readonly taskId: string;
	spaceId: number | undefined;
	phase: 'starting' | 'handoff' | 'capturing' | 'cancelling';
	cleanupPending: boolean;
	closing: boolean;
	operation: Promise<void> | undefined;
	finishOperation: (() => void) | undefined;
	closeOperation: Promise<void> | undefined;
}

/** Project-window-only broker for user-confirmed Ego selected-text captures. */
export class WorkspaceEgoCaptureChannel {
	private readonly sessions = new Map<string, CaptureSession>();
	private readonly startQueues = new Map<WebContents, Promise<void>>();
	private readonly destructionListeners = new Set<WebContents>();
	private readonly destroyedSenders = new WeakSet<WebContents>();

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly dashboardChannel: WorkspaceDashboardChannel,
		private readonly runtime: EgoCaptureRuntime,
	) { }

	async closeSessionsForSender(sender: WebContents): Promise<void> {
		const failures: Error[] = [];
		for (const [captureId, session] of [...this.sessions]) {
			if (session.sender !== sender) { continue; }
			try { await this.closeSession(captureId, session); }
			catch { failures.push(new Error(`Could not close Ego capture session ${captureId}.`)); }
		}
		if (failures.length) { throw new AggregateError(failures, 'One or more Ego capture sessions could not be closed.'); }
	}

	async shutdown(): Promise<void> {
		const failures: Error[] = [];
		for (const [captureId, session] of [...this.sessions]) {
			try { await this.closeSession(captureId, session); }
			catch { failures.push(new Error(`Could not close Ego capture session ${captureId}.`)); }
		}
		try { await this.runtime.shutdown?.(); }
		catch { failures.push(new Error('Could not stop the Ego Browser adapter process.')); }
		if (failures.length) { throw new AggregateError(failures, 'Ego Browser capture cleanup did not finish cleanly.'); }
	}

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		if (command === 'startCapture') { return await this.startCapture(sender, this.startRequest(arg)) as T; }
		if (command === 'getActiveCapture') { return await this.getActiveCapture(sender, this.recoveryRequest(arg)) as T; }
		const request = this.captureRequest(arg);
		const session = this.requireSession(sender, request);
		await this.authorizeTask(sender, request.projectId, request.taskId);
		if (command === 'captureSelection') { return await this.captureSelection(request.captureId, session) as T; }
		if (command === 'cancelCapture') { return await this.cancelCapture(request.captureId, session) as T; }
		throw new Error(`Call not found: ${command}`);
	}

	private async startCapture(sender: WebContents, request: StartWorkspaceEgoCaptureRequest): Promise<WorkspaceEgoCaptureStatus> {
		const previous = this.startQueues.get(sender);
		let release!: () => void;
		const queued = new Promise<void>(resolve => { release = resolve; });
		this.startQueues.set(sender, queued);
		await previous;
		try { return await this.startCaptureSerialized(sender, request); }
		finally {
			release();
			if (this.startQueues.get(sender) === queued) { this.startQueues.delete(sender); }
		}
	}

	private async startCaptureSerialized(sender: WebContents, request: StartWorkspaceEgoCaptureRequest): Promise<WorkspaceEgoCaptureStatus> {
		this.watchSender(sender);
		const captureId = randomUUID();
		if (this.isSenderDestroyed(sender)) { return { state: 'failed', captureId, message: 'The project window closed before Ego Browser was ready.' }; }
		await this.authorizeTask(sender, request.projectId, request.taskId);
		if (this.isSenderDestroyed(sender)) { return { state: 'failed', captureId, message: 'The project window closed before Ego Browser was ready.' }; }
		let existing = [...this.sessions].find(([, session]) => session.sender === sender);
		if (existing?.[1].phase === 'starting') {
			await existing[1].operation;
			existing = this.sessions.has(existing[0]) ? existing : undefined;
		}
		if (existing) {
			const [existingId, session] = existing;
			if (session.projectId !== request.projectId || session.taskId !== request.taskId) {
				throw new Error('An Ego capture is already active for this window. Close it before starting a capture for another task.');
			}
			if (session.phase !== 'handoff' || session.closing) { throw new Error('An Ego capture is already being completed.'); }
			return { state: 'handoff', captureId: existingId };
		}
		if (this.sessions.size >= maximumActiveSessions) { throw new Error('Too many Ego capture sessions are active.'); }
		const session: CaptureSession = { sender, projectId: request.projectId, taskId: request.taskId, spaceId: undefined, phase: 'starting', cleanupPending: false, closing: false, operation: undefined, finishOperation: undefined, closeOperation: undefined };
		this.sessions.set(captureId, session);
		this.beginOperation(session, 'starting');
		try {
			const spaceId = await this.runtime.start(this.validateSourceUrl(request.url));
			if (!Number.isSafeInteger(spaceId) || spaceId < 1) {
				this.sessions.delete(captureId);
				throw new EgoBrowserCaptureError('Ego Browser returned an invalid TaskSpace.');
			}
			session.spaceId = spaceId;
			session.phase = 'handoff';
			if (session.closing) {
				session.finishOperation?.();
				await this.closeSession(captureId, session);
				return { state: 'failed', captureId, message: 'The project window closed before Ego Browser was ready.' };
			}
			return { state: 'handoff', captureId };
		} catch (error) {
			if (session.spaceId === undefined && error instanceof EgoBrowserCaptureError && error.cleanupPending && typeof error.createdSpaceId === 'number' && Number.isSafeInteger(error.createdSpaceId) && error.createdSpaceId > 0) {
				session.spaceId = error.createdSpaceId;
				session.phase = 'handoff';
				session.cleanupPending = true;
				session.closing = false;
			} else if (session.spaceId === undefined) { this.sessions.delete(captureId); }
			else { session.phase = 'handoff'; session.closing = false; }
			return { state: 'failed', captureId, message: this.errorMessage(error) };
		} finally {
			session.finishOperation?.();
		}
	}

	private async getActiveCapture(sender: WebContents, request: WorkspaceEgoCaptureRecoveryRequest): Promise<WorkspaceEgoCaptureRecoveryStatus> {
		const sessionEntry = [...this.sessions].find(([, session]) => session.sender === sender && session.projectId === request.projectId);
		if (!sessionEntry) { return { state: 'none' }; }
		const [captureId, session] = sessionEntry;
		await this.authorizeTask(sender, session.projectId, session.taskId);
		if (session.phase !== 'handoff') {
			await session.operation;
			if (!this.sessions.has(captureId)) { return { state: 'none' }; }
		}
		if (session.phase !== 'handoff' || session.closing) { throw new Error('The active Ego capture is being completed. Try recovery again shortly.'); }
		return { state: 'handoff', captureId, taskId: session.taskId, cleanupPending: session.cleanupPending };
	}

	private async captureSelection(captureId: string, session: CaptureSession): Promise<WorkspaceEgoCaptureStatus> {
		if (session.phase !== 'handoff') { throw new Error('This Ego capture is already being completed.'); }
		if (session.cleanupPending) { throw new Error('Ego Browser cleanup is pending. Retry by cancelling this capture.'); }
		const spaceId = this.requireSpaceId(session);
		this.beginOperation(session, 'capturing');
		try {
			const source = this.validateSelection(await this.runtime.captureSelection(spaceId));
			const reference = this.database.knowledge.importReference({
				projectId: session.projectId,
				connectorId: 'ego-selected-text',
				connectorVersion: '1',
				externalId: captureId,
				sourceUri: source.url,
				title: source.title,
				contentType: 'text/plain; charset=utf-8',
				content: Buffer.from(source.text, 'utf8'),
			});
			this.database.knowledge.attachReferenceToTask(session.taskId, reference.id);
			const { content: _content, derivedText: _derivedText, ...metadata } = reference;
			return { state: 'captured', captureId, reference: metadata };
		} catch (error) {
			const message = this.errorMessage(error);
			if (error instanceof EgoBrowserCaptureError && /session could not be closed/.test(error.message)) { session.phase = 'handoff'; }
			else { this.sessions.delete(captureId); }
			return { state: 'failed', captureId, message };
		} finally {
			if (isSessionPhase(session, 'capturing')) { this.sessions.delete(captureId); }
			session.finishOperation?.();
		}
	}

	private async cancelCapture(captureId: string, session: CaptureSession): Promise<WorkspaceEgoCaptureStatus> {
		if (session.phase !== 'handoff') { throw new Error('This Ego capture is already being completed.'); }
		const spaceId = this.requireSpaceId(session);
		this.beginOperation(session, 'cancelling');
		try {
			await this.runtime.cancel(spaceId);
			session.cleanupPending = false;
			return { state: 'cancelled', captureId };
		} catch (error) {
			session.phase = 'handoff';
			return { state: 'failed', captureId, message: this.errorMessage(error) };
		} finally {
			if (isSessionPhase(session, 'cancelling')) { this.sessions.delete(captureId); }
			session.finishOperation?.();
		}
	}

	private async closeSession(captureId: string, session: CaptureSession): Promise<void> {
		if (session.closeOperation) { return session.closeOperation; }
		session.closing = true;
		const closeOperation = this.finishCloseSession(captureId, session);
		session.closeOperation = closeOperation;
		try { await closeOperation; }
		finally { if (session.closeOperation === closeOperation) { session.closeOperation = undefined; } }
	}

	private async finishCloseSession(captureId: string, session: CaptureSession): Promise<void> {
		await session.operation;
		if (!this.sessions.has(captureId)) { return; }
		if (session.spaceId === undefined) { this.sessions.delete(captureId); return; }
		this.beginOperation(session, 'cancelling');
		try {
			await this.runtime.cancel(session.spaceId);
			this.sessions.delete(captureId);
		} catch (error) {
			session.phase = 'handoff';
			session.closing = false;
			throw error;
		} finally {
			session.finishOperation?.();
		}
	}

	private beginOperation(session: CaptureSession, phase: CaptureSession['phase']): void {
		session.phase = phase;
		session.operation = new Promise<void>(resolve => {
			session.finishOperation = () => {
				session.operation = undefined;
				session.finishOperation = undefined;
				resolve();
			};
		});
	}

	private watchSender(sender: WebContents): void {
		if (this.destructionListeners.has(sender)) { return; }
		this.destructionListeners.add(sender);
		sender.once('destroyed', () => {
			this.destructionListeners.delete(sender);
			this.destroyedSenders.add(sender);
			void this.closeSessionsForSender(sender).catch(() => {
				console.error('Ego Browser capture cleanup failed after its project window closed.');
			});
		});
	}

	private isSenderDestroyed(sender: WebContents): boolean {
		return this.destroyedSenders.has(sender) || (typeof sender.isDestroyed === 'function' && sender.isDestroyed());
	}

	private async authorizeTask(sender: WebContents, projectId: string, taskId: string): Promise<void> {
		const dashboard = await this.dashboardChannel.call<WorkspaceDashboardDTO>(sender, 'getDashboard', projectId);
		if (!dashboard.tasks.some(task => task.id === taskId)) { throw new Error('The task does not belong to this project.'); }
	}

	private requireSession(sender: WebContents, request: WorkspaceEgoCaptureRequest): CaptureSession {
		const session = this.sessions.get(request.captureId);
		if (!session || session.sender !== sender) { throw new Error('Capture session is unavailable in this window.'); }
		if (session.closing) { throw new Error('Capture session is closing.'); }
		if (session.projectId !== request.projectId || session.taskId !== request.taskId) { throw new Error('Capture session does not match this project and task.'); }
		return session;
	}

	private requireSpaceId(session: CaptureSession): number {
		if (session.spaceId === undefined) { throw new Error('Ego Browser has not opened a TaskSpace for this capture.'); }
		return session.spaceId;
	}

	private validateSelection(value: WorkspaceEgoSelectedText): WorkspaceEgoSelectedText {
		if (!value || typeof value !== 'object' || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text, 'utf8') > maximumSelectedTextBytes) {
			throw new Error('Selected text must contain 1 byte to 512 KiB of UTF-8 text.');
		}
		if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > maximumTitleLength) { throw new Error('A page title of at most 500 characters is required.'); }
		if (typeof value.url !== 'string') { throw new Error('A valid source URL is required.'); }
		return { text: value.text, title: value.title.trim(), url: this.validateSourceUrl(value.url) };
	}

	private validateSourceUrl(value: string): string {
		if (typeof value !== 'string' || value.length > maximumSourceUrlLength) { throw new Error('The source URL is too long.'); }
		let url: URL;
		try { url = new URL(value); }
		catch { throw new Error('The source URL must be valid.'); }
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { throw new Error('The source URL must use HTTP or HTTPS without embedded credentials.'); }
		return url.toString();
	}

	private startRequest(value: unknown): StartWorkspaceEgoCaptureRequest {
		const request = this.record(value);
		if (typeof request.projectId !== 'string' || !isUUID(request.projectId)) { throw new Error('A valid project ID is required.'); }
		if (typeof request.taskId !== 'string' || !isUUID(request.taskId)) { throw new Error('A valid task ID is required.'); }
		if (typeof request.url !== 'string') { throw new Error('A valid source URL is required.'); }
		return { projectId: request.projectId, taskId: request.taskId, url: request.url };
	}

	private recoveryRequest(value: unknown): WorkspaceEgoCaptureRecoveryRequest {
		if (!value || typeof value !== 'object' || typeof (value as WorkspaceEgoCaptureRecoveryRequest).projectId !== 'string' || !isUUID((value as WorkspaceEgoCaptureRecoveryRequest).projectId)) {
			throw new Error('Invalid Ego capture recovery request.');
		}
		return value as WorkspaceEgoCaptureRecoveryRequest;
	}

	private captureRequest(value: unknown): WorkspaceEgoCaptureRequest {
		const request = this.record(value);
		if (typeof request.projectId !== 'string' || !isUUID(request.projectId)) { throw new Error('A valid project ID is required.'); }
		if (typeof request.taskId !== 'string' || !isUUID(request.taskId)) { throw new Error('A valid task ID is required.'); }
		if (typeof request.captureId !== 'string' || !isUUID(request.captureId)) { throw new Error('A valid capture ID is required.'); }
		return { projectId: request.projectId, taskId: request.taskId, captureId: request.captureId };
	}

	private record(value: unknown): Record<string, unknown> {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('A capture request is required.'); }
		return value as Record<string, unknown>;
	}

	private errorMessage(error: unknown): string {
		if (error instanceof EgoBrowserCaptureError) { return error.message; }
		if (error instanceof Error && /512 KiB/.test(error.message)) { return error.message; }
		return 'Ego Browser could not complete the selected-text capture.';
	}
}
