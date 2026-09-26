/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebContents } from 'electron';
import { URI } from '../../base/common/uri.js';
import type { ICodeWindow } from '../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type { ConventionAgentPreviewDTO } from '../common/workspaceConventionAgentProtocol.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import { WorkspaceConventionAgentChannel } from './workspaceConventionAgentChannel.js';

async function withChannel(run: (context: {
	channel: WorkspaceConventionAgentChannel;
	database: WorkspaceDatabase;
	projectId: string;
	taskId: string;
	sender: WebContents;
	otherSender: WebContents;
}) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-convention-agent-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	const descriptor = URI.file(join(directory, 'project.code-workspace')).toString();
	const project = database.createProjectWorkspace('Convention project', directory, descriptor);
	const task = database.createTask({ projectId: project.project.id, bindingId: project.binding.id, title: 'Document review practices' });
	const sender = {} as WebContents;
	const otherSender = {} as WebContents;
	const window = {
		config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } },
		openedWorkspace: { configPath: URI.parse(descriptor) },
	} as unknown as ICodeWindow;
	const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender ? window : undefined } as IWindowsMainService;
	const dashboard = new WorkspaceDashboardChannel(database, windows);
	const logger = { error() { /* Agent subprocesses are never started by these preview boundary tests. */ } } as never;
	const channel = new WorkspaceConventionAgentChannel(database, dashboard, logger);
	try { await run({ channel, database, projectId: project.project.id, taskId: task.id, sender, otherSender }); }
	finally { await channel.shutdown(); database.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('draft preview is project-window scoped and binds the selected immutable source snapshot', async () => {
	await withChannel(async ({ channel, database, projectId, taskId, sender, otherSender }) => {
		const source = database.knowledge.importReference({
			projectId, connectorId: 'manual-text', connectorVersion: '1', externalId: 'policy-source',
			sourceUri: 'https://docs.example.test/review-notes',
			title: 'Review notes', contentType: 'application/vnd.bugfixer.notion-source+json',
			content: Buffer.from('{"block":"RAW JSON MUST STAY OUT OF PROMPT"}'), derivedText: 'Review the test first. Prefer small changes.',
		});
		const request = { projectId, taskId, providerId: 'codex' as const, sourceSnapshotIds: [source.id] };
		const preview = await channel.call<ConventionAgentPreviewDTO>(sender, 'previewDraft', request);
		assert.equal(preview.operation, 'draft');
		assert.deepEqual(preview.references.map(item => ({ id: item.id, version: item.version, hash: item.contentSha256, title: item.title, sourceUri: item.sourceUri, content: item.content })), [
			{ id: source.id, version: 1, hash: source.contentSha256, title: 'Review notes', sourceUri: 'https://docs.example.test/review-notes', content: 'Review the test first. Prefer small changes.' },
		]);
		assert.match(preview.prompt, /## Principles/);
		assert.match(preview.prompt, /## Examples/);
		assert.match(preview.prompt, new RegExp(source.id));
		assert.match(preview.prompt, new RegExp(source.contentSha256));
		assert.match(preview.prompt, new RegExp(source.sourceUri!));
		assert.match(preview.prompt, /Do not assume company or product names/);
		assert.doesNotMatch(preview.prompt, /RAW JSON MUST STAY OUT OF PROMPT/);
		assert.equal(preview.allowed, false);
		assert.match(preview.blockedReason ?? '', /Codex cannot currently guarantee reads are limited/);
		await assert.rejects(channel.call(otherSender, 'previewDraft', request), /open project window/);
		const otherProject = database.createProjectWorkspace('Other project', process.cwd(), URI.file(join(process.cwd(), 'other.code-workspace')).toString());
		const foreign = database.knowledge.importReference({
			projectId: otherProject.project.id, connectorId: 'manual-text', connectorVersion: '1', externalId: 'foreign',
			title: 'Foreign', contentType: 'text/plain; charset=utf-8', content: Buffer.from('Must not cross project boundary.'),
		});
		await assert.rejects(channel.call(sender, 'previewDraft', { ...request, sourceSnapshotIds: [foreign.id] }), /unavailable in this project/);
		await assert.rejects(channel.call(sender, 'draft', { ...request, digest: preview.digest }), /Codex cannot currently guarantee reads are limited/);
		assert.deepEqual(database.listProviderAttempts(taskId), []);
	});
});

test('saved convention Markdown appends escaped deterministic provenance and rejects model-authored citations', async () => {
	await withChannel(async ({ channel, database, projectId, taskId }) => {
		const withUri = database.knowledge.importReference({
			projectId, connectorId: 'manual-text', connectorVersion: '1', externalId: 'provenance-source',
			sourceUri: 'https://docs.example.test/policy?q=[draft]', title: 'Review `notes` [team]',
			contentType: 'text/plain; charset=utf-8', content: Buffer.from('Review the test before changing it.'),
		});
		const withoutUri = database.knowledge.importReference({
			projectId, connectorId: 'manual-text', connectorVersion: '1', externalId: 'no-uri-source',
			title: 'Local guidance', contentType: 'text/plain; charset=utf-8', content: Buffer.from('Prefer small verified changes.'),
		});
		const makeAttempt = (prompt: string) => {
			const attempt = database.createProviderAttempt({ taskId, provider: 'claude', purpose: 'connectionTest', profileRef: 'local-default-claude', folderIdentity: 'test-folder', cwd: process.cwd(), mode: 'convention-draft', prompt, refSnapshotIds: [withUri.id, withoutUri.id] });
			database.setProviderAttemptRunning(attempt.attemptId, database.getTask(taskId)!.revision, process.pid);
			return attempt;
		};
		const context = {
			operation: 'draft', projectId, providerId: 'claude', sourceSnapshotIds: [withUri.id, withoutUri.id],
			references: [withUri, withoutUri].map(reference => ({
				id: reference.id, version: reference.version, title: reference.title, sourceUri: reference.sourceUri,
				contentType: reference.contentType, contentSha256: reference.contentSha256, content: reference.derivedText,
			})),
		};
		const validMarkdown = `# Project conventions

## Principles
Prefer precise guidance grounded in the selected source snapshots.

## Do
Check the relevant behavior before changing it and state the expected result.

## Avoid
Avoid claiming a change is verified before checking the result.

## Examples
### Example 1
Situation: A behavior needs correction. Preferred response: make the smallest change and check it.

### Example 2
Situation: Evidence is incomplete. Preferred response: state the gap and request the missing source.`;
		type StoredAttempt = ReturnType<typeof makeAttempt>;
		type ProviderResult = { attemptId: string; providerId: 'claude'; state: 'succeeded'; cleanupVerified: boolean; exitCode: number; signal: null; finalText: string };
		const internal = channel as unknown as {
			finishAttempt(context: unknown, attempt: StoredAttempt, sessionId: string | null, result: ProviderResult): Promise<void>;
		};
		const validAttempt = makeAttempt('valid draft');
		await internal.finishAttempt(context, validAttempt, null, {
			attemptId: validAttempt.attemptId, providerId: 'claude', state: 'succeeded', cleanupVerified: true, exitCode: 0, signal: null, finalText: validMarkdown,
		});
		const saved = database.knowledge.listConventions(projectId).find(version => version.authorAttemptId === validAttempt.attemptId)!;
		assert.match(saved.markdown, /## Input snapshots/);
		assert.ok(saved.markdown.includes('Title: ``"Review `notes` [team]"``'));
		assert.ok(saved.markdown.includes('URI: `"https://docs.example.test/policy?q=[draft]"`'));
		assert.ok(saved.markdown.includes('snapshot ID: `"' + withUri.id + '"`; version: ' + withUri.version + '; SHA-256: `"' + withUri.contentSha256 + '"`'));
		assert.ok(saved.markdown.includes('Title: `' + JSON.stringify(withoutUri.title) + '`; URI: unavailable; snapshot ID: `"' + withoutUri.id + '"`; version: ' + withoutUri.version + ';'));
		assert.doesNotMatch(saved.markdown, /Molcube/i);

		const unsupportedAttempt = makeAttempt('unsupported draft');
		await internal.finishAttempt(context, unsupportedAttempt, null, {
			attemptId: unsupportedAttempt.attemptId, providerId: 'claude', state: 'succeeded', cleanupVerified: true, exitCode: 0, signal: null,
			finalText: validMarkdown.replace('Prefer precise guidance grounded in the selected source snapshots.', 'Use Molcube for every review.'),
		});
		const unsupported = database.knowledge.listConventions(projectId).find(version => version.authorAttemptId === unsupportedAttempt.attemptId)!;
		assert.match(unsupported.markdown, /Use Molcube for every review/);
		assert.match(unsupported.markdown, /## Input snapshots/);
		assert.throws(() => database.knowledge.applyConventionVersion(projectId, unsupported.id), /requires a passing check/);

		const citationAttempt = makeAttempt('cited draft');
		await internal.finishAttempt(context, citationAttempt, null, {
			attemptId: citationAttempt.attemptId, providerId: 'claude', state: 'succeeded', cleanupVerified: true, exitCode: 0, signal: null,
			finalText: `${validMarkdown}\n\n[Invented source](https://invented.example.test)`,
		});
		const failed = database.getProviderAttempt(citationAttempt.attemptId)!;
		assert.equal(failed.state, 'failed');
		assert.match(failed.errorSummary ?? '', /leave citations and source provenance to the application/);
		assert.equal(database.knowledge.listConventions(projectId).some(version => version.authorAttemptId === citationAttempt.attemptId), false);
	});
});

test('draft preview digest changes when the selected immutable snapshot changes', async () => {
	await withChannel(async ({ channel, database, projectId, taskId, sender }) => {
		const first = database.knowledge.importReference({
			projectId, connectorId: 'manual-text', connectorVersion: '1', externalId: 'mutable-source',
			title: 'Policy', contentType: 'text/plain; charset=utf-8', content: Buffer.from('First source revision.'),
		});
		const second = database.knowledge.importReference({
			projectId, connectorId: 'manual-text', connectorVersion: '1', externalId: 'mutable-source',
			title: 'Policy v2', contentType: 'text/plain; charset=utf-8', content: Buffer.from('Second source revision.'),
		});
		const base = { projectId, taskId, providerId: 'claude' as const };
		const one = await channel.call<ConventionAgentPreviewDTO>(sender, 'previewDraft', { ...base, sourceSnapshotIds: [first.id] });
		const two = await channel.call<ConventionAgentPreviewDTO>(sender, 'previewDraft', { ...base, sourceSnapshotIds: [second.id] });
		assert.equal(one.references[0].content, 'First source revision.');
		assert.equal(two.references[0].content, 'Second source revision.');
		assert.notEqual(one.digest, two.digest);
		await assert.rejects(channel.call(sender, 'draft', { ...base, sourceSnapshotIds: [second.id], digest: one.digest }), /changed after preview/);
		assert.deepEqual(database.listProviderAttempts(taskId), []);
	});
});

test('check preview pins the exact convention version and never applies it', async () => {
	await withChannel(async ({ channel, database, projectId, taskId, sender, otherSender }) => {
		const source = database.knowledge.importReference({
			projectId, connectorId: 'manual-text', connectorVersion: '1', externalId: 'check-source',
			title: 'Source', contentType: 'text/plain; charset=utf-8', content: Buffer.from('Use plain language.'),
		});
		const version = database.knowledge.createConventionVersion({
			projectId, markdown: '# Project conventions\n\n## Principles\nPrefer plain language.', sourceSnapshotIds: [source.id], authoredBy: 'person',
		});
		const request = { projectId, taskId, providerId: 'claude' as const, versionId: version.id };
		const preview = await channel.call<ConventionAgentPreviewDTO>(sender, 'previewCheck', request);
		assert.equal(preview.operation, 'check');
		assert.deepEqual(preview.references.map(item => item.id), [source.id]);
		assert.equal(preview.convention?.id, version.id);
		assert.equal(preview.convention?.markdown, version.markdown);
		assert.match(preview.prompt, /Return one JSON object only/);
		await assert.rejects(channel.call(otherSender, 'previewCheck', request), /open project window/);
		assert.equal(database.knowledge.activeConvention(projectId), undefined);
		assert.deepEqual(database.listProviderAttempts(taskId), []);
	});
});

test('atomic draft save failure leaves a failed cleaned attempt and no orphan success', async () => {
	await withChannel(async ({ channel, database, projectId, taskId }) => {
		const task = database.getTask(taskId)!;
		const source = database.knowledge.importReference({
			projectId, connectorId: 'manual-text', connectorVersion: '1', externalId: 'draft-atomic-source',
			title: 'Draft source', contentType: 'text/plain; charset=utf-8', content: Buffer.from('Ground the document in this source.'),
		});
		const attempt = database.createProviderAttempt({
			taskId, provider: 'claude', purpose: 'connectionTest', profileRef: 'local-default-claude',
			folderIdentity: 'test-folder', cwd: process.cwd(), mode: 'convention-draft', prompt: 'draft', refSnapshotIds: [source.id],
		});
		database.setProviderAttemptRunning(attempt.attemptId, task.revision, process.pid);
		const context = {
			operation: 'draft', projectId, providerId: 'claude', sourceSnapshotIds: ['00000000-0000-4000-8000-000000000000'],
			references: [{
				id: source.id, version: source.version, title: source.title, sourceUri: source.sourceUri,
				contentType: source.contentType, contentSha256: source.contentSha256, content: source.derivedText,
			}],
		};
		const validMarkdown = `# Project conventions

## Principles
Prefer precise language that states the action and its reason.

## Do
Describe the smallest useful change and name its expected result.

## Avoid
Avoid vague requests that leave the intended behavior unclear.

## Examples
### Example 1
Good: State which behavior needs to change.

### Example 2
Avoid: Make it better.`;
		const result = {
			attemptId: attempt.attemptId, providerId: 'claude', state: 'succeeded', cleanupVerified: true,
			exitCode: 0, signal: null, finalText: validMarkdown,
		};
		type StoredAttempt = typeof attempt;
		type ProviderResult = typeof result;
		const internal = channel as unknown as {
			finishAttempt(context: unknown, attempt: StoredAttempt, sessionId: string | null, result: ProviderResult): Promise<void>;
		};
		await internal.finishAttempt(context, attempt, null, result);
		const persisted = database.getProviderAttempt(attempt.attemptId)!;
		assert.equal(persisted.state, 'failed');
		assert.equal(persisted.cleanupVerified, true);
		assert.match(persisted.errorSummary ?? '', /Convention output was not saved/);
		assert.equal(database.knowledge.listConventions(projectId).some(version => version.authorAttemptId === attempt.attemptId), false);
	});
});
