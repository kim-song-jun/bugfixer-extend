/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { WebContents } from 'electron';
import { isUUID } from '../../base/common/uuid.js';
import type { ReviewDesktopHost } from '../../review/electron-main/reviewDesktopHost.js';
import type { CreateTaskReviewRequest, TaskReviewListRequest, ChoosePrimaryTaskReviewRequest, TaskReviewAvailability, TaskReviewOpenResult } from '../common/workspaceReviewBridgeProtocol.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase, type WorkspaceFolderBinding, type WorkspaceTask } from './workspaceDatabase.js';

const requestTimeoutMs = 8_000;
const maximumResponseBytes = 64 * 1024;
const maximumCatalogBytes = 8 * 1024 * 1024;

interface RootIdentity {
	readonly canonicalPath: string;
	readonly dev: string;
	readonly ino: string;
}

type Fetch = typeof fetch;

/** Main-process bridge from an authorized project task to a local Review. */
export class WorkspaceReviewBridgeChannel {
	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly dashboard: WorkspaceDashboardChannel,
		private readonly reviewHost: Pick<ReviewDesktopHost, 'whenConnected'>,
		private readonly fetchImpl: Fetch = fetch,
	) { }

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'createTaskReview':
				return await this.createTaskReview(sender, this.parseCreateRequest(arg)) as T;
			case 'listTaskReviews': {
				const request = this.parseTaskRequest(arg);
				await this.requireAuthorizedTask(sender, request);
				const pendingCreates: TaskReviewAvailability['pendingCreates'] = this.database.listReviewCommands(request.taskId)
					.flatMap(item => item.status === 'complete' ? [] : [{
						commandId: item.commandId, status: item.status, lastError: item.lastError, createdAt: item.createdAt,
					}]);
				const availability = await this.verifyTaskReviews(request.taskId);
				return {
					...availability,
					pendingCreates,
				} as T;
			}
			case 'choosePrimaryReview': {
				const request = this.parseChoosePrimaryRequest(arg);
				await this.requireAuthorizedTask(sender, request);
				const availability = await this.verifyTaskReviews(request.taskId);
				if (availability.state !== 'available') { throw new Error(availability.error ?? 'Review is unavailable. Refresh the task reviews and try again.'); }
				if (!availability.reviews.some(link => link.reviewId === request.reviewId && link.state === 'available')) {
					throw new Error('This Review is missing or now points to another repository. Choose another available Review.');
				}
				return this.database.choosePrimaryReview(request.taskId, request.expectedRevision, request.reviewId) as T;
			}
			case 'openTaskReview': {
				const request = this.parseOpenTaskReviewRequest(arg);
				const task = await this.requireAuthorizedTask(sender, request);
				return await this.openTaskReview(task, request.reviewId) as T;
			}
			default:
				throw new Error(`Workspace Review bridge command not found: ${command}`);
		}
	}

	private async openTaskReview(task: WorkspaceTask, reviewId: string): Promise<TaskReviewOpenResult> {
		const availability = await this.verifyTaskReviews(task.id);
		if (availability.state !== 'available') { throw new Error(availability.error ?? 'Review is unavailable. Recheck the task links.'); }
		if (!availability.reviews.some(link => link.reviewId === reviewId && link.state === 'available')) {
			throw new Error('This Review is no longer available for the current project repository.');
		}
		const binding = this.database.listFolderBindings(task.projectId).find(candidate => candidate.id === task.bindingId);
		if (!binding || (binding.vcsKind !== 'git' && binding.vcsKind !== 'jj') || !binding.vcsRoot) {
			throw new Error('This task no longer has a bound Git or jj repository.');
		}
		const rootIdentity = this.readRootIdentity(binding);
		const receipt = this.database.listReviewCommands(task.id).find(command => command.status === 'complete' && command.reviewId === reviewId);
		const expectedRepositoryId = receipt && this.repositoryIdFromCommand(receipt.body);
		if (!expectedRepositoryId) { throw new Error('The linked Review has no verified repository receipt.'); }
		const connection = await this.reviewHost.whenConnected();
		const origin = this.requireLocalOrigin(connection.url);
		const catalog = this.parseCatalog(await this.requestJson(origin, '/reviews-api', connection.token, undefined, 'GET', maximumCatalogBytes));
		const summary = catalog.get(reviewId);
		if (!summary || summary.kind !== 'worktree' || summary.repositoryId !== expectedRepositoryId
			|| (binding.reviewRepositoryId && binding.reviewRepositoryId !== expectedRepositoryId)
			|| !this.matchesRootIdentity(summary.repositoryPath, rootIdentity)
			|| !Number.isSafeInteger(summary.version) || summary.version! < 0 || !summary.title) {
			throw new Error('The linked Review changed its repository or cannot be verified. Recheck the task links.');
		}
		const version = summary.version!;
		const snapshot = await this.requestJson(origin, `/reviews-api/${encodeURIComponent(reviewId)}?full=true&version=${version}`, connection.token, undefined, 'GET', maximumCatalogBytes);
		if (!this.isRecord(snapshot) || snapshot.reviewId !== reviewId || snapshot.version !== version
			|| !this.isRecord(snapshot.target) || snapshot.target.kind !== 'worktree' || snapshot.target.repositoryId !== expectedRepositoryId
			|| !this.isRecord(snapshot.pins) || snapshot.pins.repositoryId !== expectedRepositoryId) {
			throw new Error('The selected Review version no longer matches this project repository.');
		}
		const currentBinding = this.database.listFolderBindings(task.projectId).find(candidate => candidate.id === task.bindingId);
		if (!currentBinding || currentBinding.path !== binding.path || currentBinding.vcsKind !== binding.vcsKind
			|| currentBinding.vcsRoot !== binding.vcsRoot || currentBinding.reviewRepositoryId !== binding.reviewRepositoryId) {
			throw new Error('The project repository changed while opening this Review. Recheck the task links.');
		}
		this.assertRootIdentity(currentBinding, rootIdentity);
		return { reviewId, version, title: summary.title };
	}

	private async verifyTaskReviews(taskId: string): Promise<Pick<TaskReviewAvailability, 'state' | 'reviews' | 'error'>> {
		const links = this.database.listTaskReviews(taskId);
		let connection: Awaited<ReturnType<ReviewDesktopHost['whenConnected']>>;
		let origin: string;
		try {
			connection = await this.reviewHost.whenConnected();
			origin = this.requireLocalOrigin(connection.url);
		} catch (error) {
			return { state: 'unavailable', reviews: links, error: this.errorMessage(error, 'Review host is unavailable.') };
		}
		if (links.length === 0) { return { state: 'available', reviews: links }; }
		try {
			const task = this.database.getTask(taskId);
			const binding = task && this.database.listFolderBindings(task.projectId).find(candidate => candidate.id === task.bindingId);
			if (!binding || (binding.vcsKind !== 'git' && binding.vcsKind !== 'jj') || !binding.vcsRoot) {
				for (const link of links) { this.database.setTaskReviewAvailability(taskId, link.reviewId, 'unavailable'); }
				return { state: 'unavailable', reviews: this.database.listTaskReviews(taskId), error: 'This task no longer has a bound Git or jj repository.' };
			}
			const boundRoot = this.readRootIdentity(binding);
			const catalog = this.parseCatalog(await this.requestJson(origin, '/reviews-api', connection.token, undefined, 'GET', maximumCatalogBytes));
			const commands = this.database.listReviewCommands(taskId);
			for (const link of links) {
				const receipt = commands.find(command => command.status === 'complete' && command.reviewId === link.reviewId);
				const expectedRepositoryId = receipt ? this.repositoryIdFromCommand(receipt.body) : undefined;
				if (!expectedRepositoryId) { throw new Error('A linked Review has no verified repository receipt.'); }
				const target = catalog.get(link.reviewId);
				this.database.setTaskReviewAvailability(taskId, link.reviewId,
					target?.kind === 'worktree' && target.repositoryId === expectedRepositoryId
						&& (!binding.reviewRepositoryId || binding.reviewRepositoryId === expectedRepositoryId)
						&& this.matchesRootIdentity(target.repositoryPath, boundRoot) ? 'available' : 'unavailable');
			}
		} catch (error) {
			return { state: 'unavailable', reviews: this.database.listTaskReviews(taskId), error: this.errorMessage(error, 'Could not verify linked Reviews.') };
		}
		return {
			state: 'available',
			reviews: this.database.listTaskReviews(taskId),
		};
	}

	private matchesRootIdentity(path: string | undefined, expected: RootIdentity): boolean {
		if (!path) { return false; }
		try {
			const canonicalPath = realpathSync(path);
			const stats = statSync(canonicalPath, { bigint: true });
			return stats.isDirectory() && canonicalPath === expected.canonicalPath && stats.dev.toString() === expected.dev && stats.ino.toString() === expected.ino;
		} catch { return false; }
	}

	private parseCatalog(value: unknown): Map<string, { kind: string; repositoryId: string; repositoryPath?: string; version?: number; title?: string }> {
		if (!Array.isArray(value)) { throw new Error('Review returned an invalid catalog.'); }
		const targets = new Map<string, { kind: string; repositoryId: string; repositoryPath?: string; version?: number; title?: string }>();
		for (const entry of value) {
			if (!this.isRecord(entry) || typeof entry.reviewId !== 'string') { throw new Error('Review returned an invalid catalog entry.'); }
			if (targets.has(entry.reviewId)) { throw new Error('Review returned duplicate catalog entries.'); }
			const target = entry.target;
			if (this.isRecord(target) && typeof target.kind === 'string' && typeof target.repositoryId === 'string') {
				targets.set(entry.reviewId, { kind: target.kind, repositoryId: target.repositoryId,
					...(typeof entry.repositoryPath === 'string' ? { repositoryPath: entry.repositoryPath } : {}),
					...(typeof entry.version === 'number' ? { version: entry.version } : {}),
					...(typeof entry.title === 'string' ? { title: entry.title } : {}) });
			} else {
				targets.set(entry.reviewId, { kind: '', repositoryId: '' });
			}
		}
		return targets;
	}

	private repositoryIdFromCommand(body: string): string | undefined {
		let value: unknown;
		try { value = JSON.parse(body) as unknown; } catch { return undefined; }
		if (!this.isRecord(value) || !this.isRecord(value.operation) || !this.isRecord(value.operation.target)) { return undefined; }
		return value.operation.type === 'create' && value.operation.target.kind === 'worktree' && typeof value.operation.target.repositoryId === 'string'
			? value.operation.target.repositoryId : undefined;
	}

	private errorMessage(error: unknown, fallback: string): string {
		return error instanceof Error && error.message ? error.message : fallback;
	}

	private async createTaskReview(sender: WebContents, request: CreateTaskReviewRequest) {
		const task = await this.requireAuthorizedTask(sender, request);
		if (task.archivedAt || task.trashedAt || task.deletionPendingAt) { throw new Error('Only an active task can create a Review.'); }
		const existing = this.database.getReviewCommand(request.commandId);
		if (existing?.taskId !== undefined && existing.taskId !== task.id) { throw new Error('This Review command belongs to a different task.'); }
		if (existing?.status === 'complete') { return { command: existing, reviews: this.database.listTaskReviews(task.id) }; }
		const binding = this.database.listFolderBindings(task.projectId).find(candidate => candidate.id === task.bindingId);
		if (!binding || (binding.vcsKind !== 'git' && binding.vcsKind !== 'jj') || !binding.vcsRoot) {
			throw new Error('This task needs a Git or jj repository binding before it can create a Review.');
		}

		const rootIdentity = this.readRootIdentity(binding);
		const connection = await this.reviewHost.whenConnected().catch(() => { throw new Error('Review is unavailable. Start Review and retry this task.'); });
		const origin = this.requireLocalOrigin(connection.url);
		const repository = this.parseRepository(await this.requestJson(origin, '/reviews-api/repositories', connection.token, {
			path: rootIdentity.canonicalPath,
			expectedRoot: rootIdentity,
		}, 'POST'), rootIdentity);
		if (binding.reviewRepositoryId && binding.reviewRepositoryId !== repository.id) { throw new Error('Review returned a repository ID that does not match this project binding.'); }
		this.assertRootIdentity(binding, rootIdentity);

		const body = existing?.body ?? JSON.stringify({
			commandId: request.commandId,
			operation: {
				type: 'create',
				title: task.title,
				target: { kind: 'worktree', repositoryId: repository.id },
				open: false,
			},
		});
		if (existing) {
			let prior: unknown;
			try { prior = JSON.parse(body) as unknown; }
			catch { throw new Error('The saved Review command is malformed.'); }
			if (!this.isRecord(prior) || prior.commandId !== request.commandId || !this.isRecord(prior.operation)
				|| prior.operation.type !== 'create' || !this.isRecord(prior.operation.target)
				|| prior.operation.target.kind !== 'worktree' || prior.operation.target.repositoryId !== repository.id
				|| prior.operation.open !== false) {
				throw new Error('The saved Review command no longer matches this repository.');
			}
		}
		const outbox = this.database.enqueueReviewRequest({ commandId: request.commandId, taskId: task.id, body });
		if (outbox.status === 'complete') {
			return { command: outbox, reviews: this.database.listTaskReviews(task.id) };
		}

		try {
			this.assertRootIdentity(binding, rootIdentity);
			const result = this.parseCreateResult(await this.requestJson(origin, '/reviews-api/commands', connection.token, outbox.body, 'POST'), repository.id);
			this.assertRootIdentity(binding, rootIdentity);
			const completed = this.database.completeReviewRequest(request.commandId, result.reviewId);
			return { command: completed, reviews: this.database.listTaskReviews(task.id) };
		} catch (error) {
			this.database.markReviewRequestFailed(request.commandId, error instanceof Error ? error.message : 'Review request failed.');
			throw error;
		}
	}

	private async requireAuthorizedTask(sender: WebContents, request: TaskReviewListRequest): Promise<WorkspaceTask> {
		await this.dashboard.call(sender, 'getDashboard', request.projectId);
		const task = this.database.getTask(request.taskId);
		if (!task || task.projectId !== request.projectId) { throw new Error('The task does not belong to this project.'); }
		return task;
	}

	private readRootIdentity(binding: WorkspaceFolderBinding): RootIdentity {
		const canonicalPath = realpathSync(binding.vcsRoot!);
		const stats = statSync(canonicalPath, { bigint: true });
		if (!stats.isDirectory()) { throw new Error('The bound repository root is not a directory.'); }
		const boundFolder = realpathSync(binding.path);
		const fromRoot = relative(canonicalPath, boundFolder);
		if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) { throw new Error('The task folder is outside its bound repository root.'); }
		return { canonicalPath, dev: stats.dev.toString(), ino: stats.ino.toString() };
	}

	private assertRootIdentity(binding: WorkspaceFolderBinding, expected: RootIdentity): void {
		const current = this.readRootIdentity(binding);
		if (current.canonicalPath !== expected.canonicalPath || current.dev !== expected.dev || current.ino !== expected.ino) {
			throw new Error('The bound repository root changed while creating the Review. Retry after refreshing the project binding.');
		}
	}

	private requireLocalOrigin(value: string): string {
		const url = new URL(value);
		if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
			throw new Error('Review supplied an invalid local server URL.');
		}
		return url.origin;
	}

	private async requestJson(origin: string, route: string, token: string, body: unknown, method: 'GET' | 'POST', maximumBytes = maximumResponseBytes): Promise<unknown> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error('Review request timed out.')), requestTimeoutMs);
		try {
			const response = await this.fetchImpl(`${origin}${route}`, {
				method,
				redirect: 'error',
				signal: controller.signal,
				headers: { 'x-review-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }), accept: 'application/json' },
				...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
			});
			const contentLength = Number(response.headers.get('content-length') ?? 0);
			if (Number.isFinite(contentLength) && contentLength > maximumBytes) { throw new Error('Review returned an oversized response.'); }
			const reader = response.body?.getReader();
			if (!reader) { throw new Error('Review returned an empty response.'); }
			const chunks: Uint8Array[] = [];
			let totalBytes = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }
				totalBytes += value.byteLength;
				if (totalBytes > maximumBytes) {
					await reader.cancel();
					throw new Error('Review returned an oversized response.');
				}
				chunks.push(value);
			}
			const bytes = new Uint8Array(totalBytes);
			let offset = 0;
			for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
			const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			if (!response.ok) { throw new Error(`Review request failed (${response.status}).`); }
			try { return JSON.parse(text) as unknown; } catch { throw new Error('Review returned malformed JSON.'); }
		} finally {
			clearTimeout(timeout);
		}
	}

	private parseRepository(value: unknown, expected: RootIdentity): { id: string } {
		if (!this.isRecord(value) || typeof value.id !== 'string' || !value.id || value.verified !== true || !this.isRecord(value.rootIdentity)
			|| value.rootIdentity.canonicalPath !== expected.canonicalPath || value.rootIdentity.dev !== expected.dev || value.rootIdentity.ino !== expected.ino) {
			throw new Error('Review returned an invalid repository registration.');
		}
		return { id: value.id };
	}

	private parseCreateResult(value: unknown, repositoryId: string): { reviewId: string } {
		if (!this.isRecord(value) || typeof value.reviewId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.reviewId) || !this.isRecord(value.review) || value.review.reviewId !== value.reviewId || !this.isRecord(value.review.target)) {
			throw new Error('Review returned an invalid create receipt.');
		}
		const target = value.review.target;
		if (target.kind !== 'worktree' || target.repositoryId !== repositoryId) { throw new Error('Review returned a Review outside the bound project repository.'); }
		return { reviewId: value.reviewId };
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	private parseCreateRequest(value: unknown): CreateTaskReviewRequest {
		if (!this.isRecord(value) || typeof value.projectId !== 'string' || !isUUID(value.projectId) || typeof value.taskId !== 'string' || !isUUID(value.taskId) || typeof value.commandId !== 'string' || !isUUID(value.commandId)) {
			throw new Error('A valid project, task, and stable command ID are required.');
		}
		return { projectId: value.projectId, taskId: value.taskId, commandId: value.commandId };
	}

	private parseTaskRequest(value: unknown): TaskReviewListRequest {
		if (!this.isRecord(value) || typeof value.projectId !== 'string' || !isUUID(value.projectId) || typeof value.taskId !== 'string' || !isUUID(value.taskId)) { throw new Error('A valid project and task are required.'); }
		return { projectId: value.projectId, taskId: value.taskId };
	}

	private parseOpenTaskReviewRequest(value: unknown): Pick<ChoosePrimaryTaskReviewRequest, 'projectId' | 'taskId' | 'reviewId'> {
		const request = this.parseTaskRequest(value);
		if (!this.isRecord(value) || typeof value.reviewId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.reviewId)) { throw new Error('A valid review ID is required.'); }
		return { ...request, reviewId: value.reviewId };
	}

	private parseChoosePrimaryRequest(value: unknown): ChoosePrimaryTaskReviewRequest {
		const request = this.parseOpenTaskReviewRequest(value);
		if (!this.isRecord(value) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) { throw new Error('A valid task revision is required to choose a primary Review.'); }
		return { ...request, expectedRevision: Number(value.expectedRevision) };
	}
}
