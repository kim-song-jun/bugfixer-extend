/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebContents } from 'electron';
import type { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import { WorkspaceE2eChannel } from './workspaceE2eChannel.js';
import { EgoE2eEvidenceError, type EgoE2eRuntime } from './browserCapture/egoE2eRuntime.js';

test('E2E channel persists TaskSpace and requester snapshot before navigation, then stores hashed artifacts after cleanup', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-e2e-channel-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const checkoutPath = join(directory, 'checkout');
		mkdirSync(checkoutPath);
		execFileSync('git', ['-C', checkoutPath, 'init', '-q']);
		execFileSync('git', ['-C', checkoutPath, 'config', 'user.name', 'E2E test']);
		execFileSync('git', ['-C', checkoutPath, 'config', 'user.email', 'e2e@example.invalid']);
		writeFileSync(join(checkoutPath, 'tracked.txt'), 'committed content\n');
		execFileSync('git', ['-C', checkoutPath, 'add', 'tracked.txt']);
		execFileSync('git', ['-C', checkoutPath, 'commit', '-q', '-m', 'initial snapshot']);
		const checkoutRevision = execFileSync('git', ['-C', checkoutPath, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' }).trim();
		const project = database.createProject('Project');
		const binding = database.createFolderBinding({ projectId: project.id, path: checkoutPath, vcsKind: 'git', vcsRoot: checkoutPath });
		const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Check page' });
		const createdAttempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'profile-1', folderIdentity: 'dev:inode', cwd: '/checkout/project', mode: 'mutating', prompt: 'Fix page' });
		const attempt = database.setProviderAttemptRunning(createdAttempt.attemptId, task.revision, 9876);
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents;
		const dashboard = { call: async () => ({ tasks: [{ id: task.id }] }) } as unknown as WorkspaceDashboardChannel;
		let runFinished!: () => void;
		const finished = new Promise<void>(resolve => { runFinished = resolve; });
		const runtime: EgoE2eRuntime = {
			createSpace: async () => 71,
			run: async (spaceId, target, scenario, evidenceId) => {
				const evidence = database.getWorkspaceE2eEvidence(evidenceId);
				assert.equal(spaceId, 71);
				assert.equal(evidence?.taskSpaceId, 71);
				assert.equal(evidence?.state, 'running');
				assert.equal(evidence?.targetUrl, target);
				assert.equal(evidence?.attemptId, attempt.attemptId);
				assert.equal(evidence?.checkoutRevision, checkoutRevision);
				assert.equal(evidence?.checkoutRevisionUnavailableReason, null);
				assert.deepEqual(scenario, [{ type: 'assertText', selector: 'h1', value: 'Welcome' }]);
				runFinished();
				return { passed: true, screenshot: Buffer.from('png-proof'), log: JSON.stringify([
					{ method: 'Network.responseReceived', params: { response: { status: 200, url: 'https://example.test/?token=private-token', headers: { 'Set-Cookie': 'session=private-cookie' } } } },
					{ method: 'Network.requestWillBeSentExtraInfo', params: { associatedCookies: [{ cookie: { value: 'private-cookie' } }] } },
					{ method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [{ value: 'private-console-text' }] } }
				]), failure: null };
			},
			finish: async () => { throw new Error('run owns cleanup'); },
		};
		const channel = new WorkspaceE2eChannel(database, dashboard, runtime, join(directory, 'artifacts'));
		const response = await channel.call<{ evidence: { id: string; state: string; checkoutRevision: string | null; checkoutRevisionUnavailableReason: string | null } }>(sender, 'start', {
			projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000',
			environmentIdentity: 'native-macos:project-server', scenario: [{ type: 'assertText', selector: 'h1', value: 'Welcome' }],
		});
		assert.equal(response.evidence.state, 'running');
		assert.equal(response.evidence.checkoutRevision, checkoutRevision);
		assert.equal(response.evidence.checkoutRevisionUnavailableReason, null);
		await finished;
		for (let attemptNumber = 0; attemptNumber < 50 && database.getWorkspaceE2eEvidence(response.evidence.id)?.state === 'running'; attemptNumber++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		const evidence = database.getWorkspaceE2eEvidence(response.evidence.id)!;
		assert.equal(evidence.state, 'passed');
		assert.equal(evidence.screenshotSha256?.length, 64);
		assert.equal(evidence.logSha256?.length, 64);
		const savedLog = readFileSync(evidence.logPath!, 'utf8');
		assert.deepEqual(JSON.parse(savedLog), [{ method: 'Network.responseReceived', status: 200 }, { method: 'Runtime.consoleAPICalled', level: 'error' }]);
		assert.doesNotMatch(savedLog, /private-token|private-cookie|private-console-text/);
		await assert.rejects(channel.call(sender, 'start', {
			projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'test',
			scenario: Array.from({ length: 31 }, () => ({ type: 'click', selector: 'button' })),
		}), /Scenario must contain 1 to 30 steps/);
	} finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cleanup retry cannot close a running or completed check', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-e2e-retry-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const project = database.createProject('Project');
		const binding = database.createFolderBinding({ projectId: project.id, path: '/checkout/project' });
		const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Check page' });
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'profile-1', folderIdentity: 'dev:inode', cwd: '/checkout/project', mode: 'mutating', prompt: 'Fix page' });
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents;
		const dashboard = { call: async () => ({ tasks: [{ id: task.id }] }) } as unknown as WorkspaceDashboardChannel;
		let finishes = 0;
		const runtime: EgoE2eRuntime = { createSpace: async () => 71, run: async () => { throw new Error('unexpected run'); }, finish: async () => { finishes++; throw new Error('unexpected finish'); } };
		const channel = new WorkspaceE2eChannel(database, dashboard, runtime, join(directory, 'artifacts'));
		const evidence = database.createWorkspaceE2eEvidence({ projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'macOS', scenario: [{ type: 'assertText', selector: 'h1', value: 'Ready' }], taskSpaceId: 71, checkoutRevision: 'c'.repeat(40), checkoutRevisionUnavailableReason: null });
		const request = { projectId: project.id, taskId: task.id, evidenceId: evidence.id };
		await assert.rejects(channel.call(sender, 'retryCleanup', request), /Cleanup can only be retried/);
		assert.equal(finishes, 0);
		database.finishWorkspaceE2eEvidence({ id: evidence.id, state: 'failed', screenshotSha256: null, screenshotPath: null, logSha256: null, logPath: null, failure: 'Ego closed, but capture failed.', cleanupError: null });
		await assert.rejects(channel.call(sender, 'retryCleanup', request), /Cleanup can only be retried/);
		assert.equal(finishes, 0);
	} finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a destroyed project window cannot navigate after task-space creation', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-e2e-window-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const project = database.createProject('Project');
		const binding = database.createFolderBinding({ projectId: project.id, path: '/checkout/project' });
		const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Check page' });
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'profile-1', folderIdentity: 'dev:inode', cwd: '/checkout/project', mode: 'mutating', prompt: 'Fix page' });
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents;
		const dashboard = { call: async () => ({ tasks: [{ id: task.id }] }) } as unknown as WorkspaceDashboardChannel;
		let releaseCreate!: () => void;
		const creating = new Promise<void>(resolve => { releaseCreate = resolve; });
		let enteredCreate!: () => void;
		const entered = new Promise<void>(resolve => { enteredCreate = resolve; });
		let runs = 0;
		let finishes = 0;
		const runtime: EgoE2eRuntime = { createSpace: async () => { enteredCreate(); await creating; return 72; }, run: async () => { runs++; throw new Error('unexpected run'); }, finish: async () => { finishes++; return { passed: false, screenshot: Buffer.from('closed'), log: '[]', failure: null }; } };
		const channel = new WorkspaceE2eChannel(database, dashboard, runtime, join(directory, 'artifacts'));
		const starting = channel.call(sender, 'start', { projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'macOS', scenario: [{ type: 'assertText', selector: 'h1', value: 'Ready' }] });
		await entered;
		sender.emit('destroyed');
		releaseCreate();
		await assert.rejects(starting, /project window closed/);
		assert.equal(runs, 0);
		assert.equal(finishes, 1);
		assert.equal(database.listWorkspaceE2eEvidence(task.id)[0].state, 'cancelled');
	} finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('artifact write failure records confirmed cleanup without finishing the Ego space twice', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-e2e-artifact-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const project = database.createProject('Project');
		const binding = database.createFolderBinding({ projectId: project.id, path: '/checkout/project' });
		const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Check page' });
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'profile-1', folderIdentity: 'dev:inode', cwd: '/checkout/project', mode: 'mutating', prompt: 'Fix page' });
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents;
		const dashboard = { call: async () => ({ tasks: [{ id: task.id }] }) } as unknown as WorkspaceDashboardChannel;
		const artifactDirectory = join(directory, 'blocked');
		writeFileSync(artifactDirectory, 'not a directory');
		let finishes = 0;
		const runtime: EgoE2eRuntime = { createSpace: async () => 73, run: async () => ({ passed: true, screenshot: Buffer.from('png'), log: '[]', failure: null }), finish: async () => { finishes++; throw new Error('space already closed'); } };
		const channel = new WorkspaceE2eChannel(database, dashboard, runtime, artifactDirectory);
		await channel.call(sender, 'start', { projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'macOS', scenario: [{ type: 'assertText', selector: 'h1', value: 'Ready' }] });
		for (let i = 0; i < 50 && database.listWorkspaceE2eEvidence(task.id)[0].state === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
		const evidence = database.listWorkspaceE2eEvidence(task.id)[0];
		assert.equal(evidence.state, 'failed');
		assert.match(evidence.failure ?? '', /Ego closed, but evidence could not be saved/);
		assert.equal(evidence.cleanupError, null);
		assert.equal(evidence.screenshotPath, null);
		assert.equal(finishes, 0);
	} finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('capture failure after confirmed Ego cleanup records evidence failure without a second finish', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-e2e-capture-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const project = database.createProject('Project');
		const binding = database.createFolderBinding({ projectId: project.id, path: '/checkout/project' });
		const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Check page' });
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'profile-1', folderIdentity: 'dev:inode', cwd: '/checkout/project', mode: 'mutating', prompt: 'Fix page' });
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents;
		const dashboard = { call: async () => ({ tasks: [{ id: task.id }] }) } as unknown as WorkspaceDashboardChannel;
		let finishes = 0;
		const runtime: EgoE2eRuntime = {
			createSpace: async () => 75,
			run: async () => { throw new EgoE2eEvidenceError('Screenshot failed after task.finish succeeded.'); },
			finish: async () => { finishes++; throw new Error('Task space was already closed.'); },
		};
		const channel = new WorkspaceE2eChannel(database, dashboard, runtime, join(directory, 'artifacts'));
		await channel.call(sender, 'start', { projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'macOS', scenario: [{ type: 'assertText', selector: 'h1', value: 'Ready' }] });
		for (let i = 0; i < 50 && database.listWorkspaceE2eEvidence(task.id)[0].state === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
		const evidence = database.listWorkspaceE2eEvidence(task.id)[0];
		assert.equal(evidence.state, 'failed');
		assert.equal(evidence.cleanupError, null);
		assert.match(evidence.failure ?? '', /evidence could not be captured/);
		assert.equal(finishes, 0);
	} finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent cleanup retries close one task space once', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-e2e-serial-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const project = database.createProject('Project');
		const binding = database.createFolderBinding({ projectId: project.id, path: '/checkout/project' });
		const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Check page' });
		const attempt = database.createProviderAttempt({ taskId: task.id, provider: 'codex', purpose: 'task', profileRef: 'profile-1', folderIdentity: 'dev:inode', cwd: '/checkout/project', mode: 'mutating', prompt: 'Fix page' });
		const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents;
		const dashboard = { call: async () => ({ tasks: [{ id: task.id }] }) } as unknown as WorkspaceDashboardChannel;
		let releaseFinish!: () => void;
		const finishing = new Promise<void>(resolve => { releaseFinish = resolve; });
		let finishes = 0;
		const runtime: EgoE2eRuntime = {
			createSpace: async () => 76,
			run: async () => { throw new Error('unexpected run'); },
			finish: async () => { finishes++; await finishing; return { passed: false, screenshot: Buffer.from('proof'), log: '[]', failure: null }; },
		};
		const channel = new WorkspaceE2eChannel(database, dashboard, runtime, join(directory, 'artifacts'));
		await channel.call(sender, 'list', { projectId: project.id, taskId: task.id });
		const evidence = database.createWorkspaceE2eEvidence({ projectId: project.id, taskId: task.id, attemptId: attempt.attemptId, targetUrl: 'http://127.0.0.1:3000', environmentIdentity: 'macOS', scenario: [{ type: 'assertText', selector: 'h1', value: 'Ready' }], taskSpaceId: 76, checkoutRevision: null, checkoutRevisionUnavailableReason: 'This task uses an ordinary folder without Git or jj revision history.' });
		database.finishWorkspaceE2eEvidence({ id: evidence.id, state: 'cleanupFailed', screenshotSha256: null, screenshotPath: null, logSha256: null, logPath: null, failure: 'Interrupted.', cleanupError: 'Task space unverified.' });
		const request = { projectId: project.id, taskId: task.id, evidenceId: evidence.id };
		const first = channel.call(sender, 'retryCleanup', request);
		await assert.rejects(channel.call(sender, 'retryCleanup', request), /already in progress/);
		releaseFinish();
		await first;
		assert.equal(finishes, 1);
		assert.equal(database.getWorkspaceE2eEvidence(evidence.id)?.state, 'failed');
		assert.equal(database.getWorkspaceE2eEvidence(evidence.id)?.cleanupError, null);
	} finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
