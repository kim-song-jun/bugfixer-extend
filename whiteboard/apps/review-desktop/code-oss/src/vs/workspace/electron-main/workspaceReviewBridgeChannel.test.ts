/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { WebContents } from 'electron';
import { URI } from '../../base/common/uri.js';
import type { ICodeWindow } from '../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type { ReviewDesktopConnection } from '../../review/common/reviewDesktopBootstrap.js';
import type { ReviewDesktopHost } from '../../review/electron-main/reviewDesktopHost.js';
import type { TaskReviewAvailability, TaskReviewOpenResult } from '../common/workspaceReviewBridgeProtocol.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import { WorkspaceReviewBridgeChannel } from './workspaceReviewBridgeChannel.js';

const createCommandId = 'bd9de749-7447-47e4-bfd6-771f182fac81';
const secondCommandId = '999dc74d-58ba-4b6d-9923-df3bb7d9ce97';

function withBridge(run: (context: {
	bridge: WorkspaceReviewBridgeChannel;
	database: WorkspaceDatabase;
	projectId: string;
	taskId: string;
	otherProjectId: string;
	sender: WebContents;
	root: string;
	commandBodies: string[];
}) => Promise<void>, options: { loseFirstCommandResponse?: boolean; mismatchedTarget?: boolean; malformedRepository?: boolean; unavailable?: boolean; missingReviewIds?: Set<string>; retargetReviewIds?: Set<string>; snapshotRetargetReviewIds?: Set<string> } = {}): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-review-bridge-'));
	const unresolvedRoot = join(directory, 'repository');
	mkdirSync(unresolvedRoot);
	const root = realpathSync(unresolvedRoot);
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	const descriptorUri = URI.file(join(directory, 'project.code-workspace')).toString();
	const workspace = database.createProjectWorkspace('Bridge project', root, descriptorUri);
	database.updateFolderBinding(workspace.binding.id, { expectedPath: root, vcsKind: 'git', vcsRoot: root });
	const task = database.createTask({ projectId: workspace.project.id, bindingId: workspace.binding.id, title: 'Create a bound Review' });
	const other = database.createProjectWorkspace('Other project', join(directory, 'other'), URI.file(join(directory, 'other.code-workspace')).toString());
	const codeWindow = {
		config: { reviewWindowLaunch: { kind: 'project', projectId: workspace.project.id } },
		openedWorkspace: { id: 'workspace-id', configPath: URI.parse(descriptorUri) },
	} as unknown as ICodeWindow;
	const sender = {} as WebContents;
	const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender ? codeWindow : undefined } as IWindowsMainService;
	const dashboard = new WorkspaceDashboardChannel(database, windows);
	const connection: ReviewDesktopConnection = {
		version: 3, url: 'http://127.0.0.1:43119', token: 'main-only-token', instanceId: 'instance', appSessionId: 'session',
	};
	const host = { whenConnected: () => options.unavailable ? Promise.reject(new Error('offline')) : Promise.resolve(connection) } as Pick<ReviewDesktopHost, 'whenConnected'>;
	const commandBodies: string[] = [];
	const commandResults = new Map<string, { reviewId: string; review: { reviewId: string; target: { kind: string; repositoryId: string } } }>();
	let commandRequests = 0;
	const fakeFetch: typeof fetch = async (input, init) => {
		assert.equal(new URL(String(input)).origin, connection.url);
		assert.equal(new Headers(init?.headers).get('x-review-token'), 'main-only-token');
		assert.equal(new Headers(init?.headers).get('authorization'), null);
		assert.equal(init?.redirect, 'error');
		const route = new URL(String(input)).pathname;
		if (init?.method === 'GET') {
			if (route === '/reviews-api') {
				return Response.json([...commandResults.values()]
					.filter(result => !options.missingReviewIds?.has(result.reviewId))
					.map(result => ({
						reviewId: result.reviewId,
						version: 0,
						title: 'Bound task Review',
						repositoryPath: root,
						target: { kind: 'worktree', repositoryId: options.retargetReviewIds?.has(result.reviewId) ? 'another-repository' : result.review.target.repositoryId },
					})));
			}
			const reviewId = route.split('/')[2];
			assert.match(route, /^\/reviews-api\/review-(?:one|two)$/);
			assert.equal(new URL(String(input)).searchParams.get('full'), 'true');
			assert.equal(new URL(String(input)).searchParams.get('version'), '0');
			const result = [...commandResults.values()].find(item => item.reviewId === reviewId);
			assert.ok(result);
			const repositoryId = options.snapshotRetargetReviewIds?.has(reviewId) ? 'another-repository' : result.review.target.repositoryId;
			return Response.json({ reviewId, version: 0, title: 'Bound task Review', target: { kind: 'worktree', repositoryId }, pins: { repositoryId }, document: [] });
		}
		const request = JSON.parse(String(init?.body)) as Record<string, any>;
		if (route === '/reviews-api/repositories') {
			if (options.malformedRepository) { return Response.json({ id: 'repository-one', name: 'repository', verified: true, rootIdentity: { canonicalPath: '/wrong', dev: '1', ino: '2' } }); }
			const stats = await import('node:fs/promises').then(fs => fs.stat(root, { bigint: true }));
			assert.deepEqual(request.expectedRoot, { canonicalPath: root, dev: stats.dev.toString(), ino: stats.ino.toString() });
			return Response.json({ id: 'repository-one', name: 'repository', verified: true, rootIdentity: request.expectedRoot });
		}
		assert.equal(route, '/reviews-api/commands');
		assert.equal(request.operation.open, false);
		assert.equal(request.operation.target.repositoryId, 'repository-one');
		const encoded = String(init?.body);
		commandBodies.push(encoded);
		const existing = commandResults.get(request.commandId);
		const result = existing ?? {
			reviewId: request.commandId === createCommandId ? 'review-one' : 'review-two',
			review: { reviewId: request.commandId === createCommandId ? 'review-one' : 'review-two', target: { kind: 'worktree', repositoryId: options.mismatchedTarget ? 'another-repository' : 'repository-one' } },
		};
		commandResults.set(request.commandId, result);
		commandRequests++;
		if (options.loseFirstCommandResponse && commandRequests === 1) { throw new Error('connection dropped after server commit'); }
		return Response.json(result);
	};
	const bridge = new WorkspaceReviewBridgeChannel(database, dashboard, host, fakeFetch);
	const runResult = run({ bridge, database, projectId: workspace.project.id, taskId: task.id, otherProjectId: other.project.id, sender, root, commandBodies });
	return runResult.finally(() => {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	});
}

test('task review retries the durable command ID after a lost response and persists the receipt', async () => {
	await withBridge(async ({ bridge, database, projectId, taskId, sender, commandBodies }) => {
		const request = { projectId, taskId, commandId: createCommandId };
		await assert.rejects(bridge.call(sender, 'createTaskReview', request), /connection dropped/);
		assert.equal(database.getReviewCommand(createCommandId)?.status, 'failed');
		const pending = await bridge.call<TaskReviewAvailability>(sender, 'listTaskReviews', { projectId, taskId });
		assert.deepEqual(pending.pendingCreates.map(item => [item.commandId, item.status]), [[createCommandId, 'failed']]);
		const task = database.getTask(taskId)!;
		database.updateTask(taskId, task.revision, { title: 'Renamed after request was sent' });
		const result = await bridge.call<{ command: { reviewId: string; status: string }; reviews: Array<{ reviewId: string; isPrimary: boolean }> }>(sender, 'createTaskReview', request);
		assert.equal(result.command.reviewId, 'review-one');
		assert.equal(result.command.status, 'complete');
		assert.equal(commandBodies.length, 2);
		assert.equal(commandBodies[0], commandBodies[1]);
		assert.deepEqual(result.reviews.map(review => [review.reviewId, review.isPrimary]), [['review-one', true]]);
		assert.equal(database.getReviewCommand(createCommandId)?.status, 'complete');
	}, { loseFirstCommandResponse: true });
});

test('task review rejects cross-project authority and a Review receipt targeting another repository', async () => {
	await withBridge(async ({ bridge, database, projectId, taskId, otherProjectId, sender }) => {
		await assert.rejects(bridge.call(sender, 'createTaskReview', { projectId: otherProjectId, taskId, commandId: createCommandId }), /does not match this window/);
		await assert.rejects(bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: createCommandId }), /outside the bound project repository/);
		assert.equal(database.getReviewCommand(createCommandId)?.status, 'failed');
		assert.deepEqual(database.listTaskReviews(taskId), []);
	}, { mismatchedTarget: true });
});

test('task reviews can choose exactly one primary review and report Review unavailability explicitly', async () => {
	await withBridge(async ({ bridge, database, projectId, taskId, sender }) => {
		await bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: createCommandId });
		await bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: secondCommandId });
		await bridge.call(sender, 'choosePrimaryReview', { projectId, taskId, reviewId: 'review-two', expectedRevision: database.getTask(taskId)!.revision });
		const result = await bridge.call<{ state: string; reviews: Array<{ reviewId: string; isPrimary: boolean }> }>(sender, 'listTaskReviews', { projectId, taskId });
		assert.equal(result.state, 'available');
		assert.deepEqual(result.reviews.map(review => [review.reviewId, review.isPrimary]), [['review-two', true], ['review-one', false]]);
	});
	await withBridge(async ({ bridge, database, projectId, taskId, sender }) => {
		const result = await bridge.call<{ state: string; reviews: unknown[] }>(sender, 'listTaskReviews', { projectId, taskId });
		assert.equal(result.state, 'unavailable');
		assert.deepEqual(result.reviews, []);
	}, { unavailable: true });
});

test('choosing a primary Review rejects a stale task revision without changing the primary link', async () => {
	await withBridge(async ({ bridge, database, projectId, taskId, sender }) => {
		await bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: createCommandId });
		await bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: secondCommandId });
		const staleRevision = database.getTask(taskId)!.revision;
		database.updateTask(taskId, staleRevision, { title: 'Changed in another window' });
		const revisionAfterEdit = database.getTask(taskId)!.revision;
		await assert.rejects(bridge.call(sender, 'choosePrimaryReview', { projectId, taskId, reviewId: 'review-two', expectedRevision: staleRevision }), /changed since revision/);
		assert.equal(database.getTask(taskId)!.revision, revisionAfterEdit);
		assert.equal(database.listTaskReviews(taskId).find(link => link.isPrimary)?.reviewId, 'review-one');
	});
});

test('a deleted primary Review is marked missing and can be repaired without replacing the chosen primary automatically', async () => {
	const missingReviewIds = new Set<string>();
	await withBridge(async ({ bridge, database, projectId, taskId, sender }) => {
		await bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: createCommandId });
		await bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: secondCommandId });
		missingReviewIds.add('review-one');
		const missing = await bridge.call<TaskReviewAvailability>(sender, 'listTaskReviews', { projectId, taskId });
		assert.deepEqual(missing.reviews.map(link => [link.reviewId, link.state, link.isPrimary]), [
			['review-one', 'unavailable', true], ['review-two', 'available', false],
		]);
		await assert.rejects(bridge.call(sender, 'choosePrimaryReview', { projectId, taskId, reviewId: 'review-one', expectedRevision: database.getTask(taskId)!.revision }), /missing or now points/);
		await bridge.call(sender, 'choosePrimaryReview', { projectId, taskId, reviewId: 'review-two', expectedRevision: database.getTask(taskId)!.revision });
		assert.equal(database.listTaskReviews(taskId).find(link => link.isPrimary)?.reviewId, 'review-two');
		missingReviewIds.delete('review-one');
		const restored = await bridge.call<TaskReviewAvailability>(sender, 'listTaskReviews', { projectId, taskId });
		assert.deepEqual(restored.reviews.map(link => [link.reviewId, link.state, link.isPrimary]), [
			['review-two', 'available', true], ['review-one', 'available', false],
		]);
	}, { missingReviewIds });
});

test('a Review retargeted to another repository is not offered as a task Review', async () => {
	const retargetReviewIds = new Set<string>();
	await withBridge(async ({ bridge, database, projectId, taskId, sender }) => {
		await bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: createCommandId });
		retargetReviewIds.add('review-one');
		const moved = await bridge.call<TaskReviewAvailability>(sender, 'listTaskReviews', { projectId, taskId });
		assert.deepEqual(moved.reviews.map(link => [link.reviewId, link.state]), [['review-one', 'unavailable']]);
		await assert.rejects(bridge.call(sender, 'choosePrimaryReview', { projectId, taskId, reviewId: 'review-one', expectedRevision: database.getTask(taskId)!.revision }), /another repository/);
		retargetReviewIds.delete('review-one');
		const repaired = await bridge.call<TaskReviewAvailability>(sender, 'listTaskReviews', { projectId, taskId });
		assert.deepEqual(repaired.reviews.map(link => [link.reviewId, link.state]), [['review-one', 'available']]);
	}, { retargetReviewIds });
});

test('task Review open returns only a verified immutable version and rejects a retargeted version', async () => {
	await withBridge(async ({ bridge, projectId, taskId, sender }) => {
		await bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: createCommandId });
		const opened = await bridge.call<TaskReviewOpenResult>(sender, 'openTaskReview', { projectId, taskId, reviewId: 'review-one' });
		assert.deepEqual(opened, { reviewId: 'review-one', version: 0, title: 'Bound task Review' });
		await assert.rejects(bridge.call(sender, 'openTaskReview', { projectId, taskId, reviewId: 'unlinked' }), /no longer available/);
	});
	await withBridge(async ({ bridge, projectId, taskId, sender }) => {
		await bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: createCommandId });
		await assert.rejects(bridge.call(sender, 'openTaskReview', { projectId, taskId, reviewId: 'review-one' }), /version no longer matches/);
	}, { snapshotRetargetReviewIds: new Set(['review-one']) });
});

test('rebinding a project folder makes its old Review links unavailable even after another Git root is bound', async () => {
	await withBridge(async ({ bridge, database, projectId, taskId, sender, root }) => {
		await bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: createCommandId });
		const newRoot = join(root, 'different-checkout');
		mkdirSync(newRoot);
		const bindingId = database.getTask(taskId)!.bindingId;
		database.rebindProjectFolder(projectId, newRoot, root);
		const afterRebind = await bridge.call<TaskReviewAvailability>(sender, 'listTaskReviews', { projectId, taskId });
		assert.deepEqual(afterRebind.reviews.map(link => link.state), ['unavailable']);
		await assert.rejects(bridge.call(sender, 'openTaskReview', { projectId, taskId, reviewId: 'review-one' }), /no longer has a bound Git or jj repository/);
		database.updateFolderBinding(bindingId, { expectedPath: newRoot, vcsKind: 'git', vcsRoot: newRoot });
		const afterNewCheckout = await bridge.call<TaskReviewAvailability>(sender, 'listTaskReviews', { projectId, taskId });
		assert.deepEqual(afterNewCheckout.reviews.map(link => link.state), ['unavailable']);
		await assert.rejects(bridge.call(sender, 'openTaskReview', { projectId, taskId, reviewId: 'review-one' }), /no longer available/);
	});
});

test('bridge rejects malformed repository identity responses without sending a create command', async () => {
	await withBridge(async ({ bridge, projectId, taskId, sender, database, commandBodies }) => {
		await assert.rejects(bridge.call(sender, 'createTaskReview', { projectId, taskId, commandId: createCommandId }), /invalid repository registration/);
		assert.equal(database.getReviewCommand(createCommandId), undefined);
		assert.deepEqual(commandBodies, []);
	}, { malformedRepository: true });
});
