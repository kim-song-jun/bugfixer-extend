/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebContents } from 'electron';
import { URI } from '../../../base/common/uri.js';
import type { ICodeWindow } from '../../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../../platform/windows/electron-main/windows.js';
import type { ResolvedNetworkAddress } from './declarativePackageTransport.js';
import { PublicWebsiteImportTransport } from './publicWebsiteImport.js';
import { WorkspaceDashboardChannel } from '../workspaceDashboardChannel.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { WorkspaceWebsiteChannel } from '../workspaceWebsiteChannel.js';

const publicAddress: ResolvedNetworkAddress = { address: '93.184.216.34', family: 4 };

test('public website transport rejects private DNS and revalidates each redirect hop', async () => {
	const privateTransport = new PublicWebsiteImportTransport({ resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }] });
	await assert.rejects(privateTransport.fetch('https://public.example/page'), /private or reserved/);
	let calls = 0;
	const redirected = new PublicWebsiteImportTransport({
		resolveAddresses: async hostname => hostname === 'public.example' ? [publicAddress] : [{ address: '10.0.0.4', family: 4 }],
		executePinnedRequest: async request => {
			calls++;
			assert.equal(request.hostname, 'public.example');
			return { statusCode: 302, headers: { location: 'http://internal.example/admin' }, body: Buffer.alloc(0) };
		},
	});
	await assert.rejects(redirected.fetch('https://public.example/start'), /private or reserved/);
	assert.equal(calls, 1, 'the private redirect destination must never be requested');
});

test('public website transport bounds the final redirected URL and normalizes oversized titles', async () => {
	let requests = 0;
	const redirected = new PublicWebsiteImportTransport({
		resolveAddresses: async () => [publicAddress],
		executePinnedRequest: async () => {
			requests++;
			return { statusCode: 302, headers: { location: `https://public.example/${'a'.repeat(2050)}` }, body: Buffer.alloc(0) };
		},
	});
	await assert.rejects(redirected.fetch('https://public.example/start'), /Canonical website URL must be at most 2048 characters/);
	assert.equal(requests, 1, 'an oversized redirect target must not be requested');

	const oversizedTitle = 'x'.repeat(600);
	const titled = new PublicWebsiteImportTransport({
		resolveAddresses: async () => [publicAddress],
		executePinnedRequest: async () => ({
			statusCode: 200, headers: { 'content-type': 'text/html' },
			body: Buffer.from(`<title>${oversizedTitle}</title><p>Readable text.</p>`),
		}),
	});
	const result = await titled.fetch('https://public.example/page');
	assert.equal(result.title.length, 500);
	assert.ok(result.omissions.includes('Page title truncated to 500 characters'));
});

test('public website transport decodes declared windows-1252 and retains plain-text MIME provenance', async () => {
	const windows1252Bytes = Buffer.from('<title>Café</title><p>Résumé</p>', 'latin1');
	const windows1252 = new PublicWebsiteImportTransport({
		resolveAddresses: async () => [publicAddress],
		executePinnedRequest: async () => ({
			statusCode: 200, headers: { 'content-type': 'text/html; charset=windows-1252' }, body: windows1252Bytes,
		}),
	});
	const htmlResult = await windows1252.fetch('https://public.example/article');
	assert.equal(htmlResult.title, 'Café');
	assert.match(htmlResult.derivedText, /Résumé/);
	assert.equal(htmlResult.contentType, 'text/html; charset=windows-1252');
	assert.deepEqual(htmlResult.content, windows1252Bytes);
	assert.equal(htmlResult.contentSha256, createHash('sha256').update(windows1252Bytes).digest('hex'));

	const plainText = new PublicWebsiteImportTransport({
		resolveAddresses: async () => [publicAddress],
		executePinnedRequest: async () => ({
			statusCode: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Plain text page.'),
		}),
	});
	const textResult = await plainText.fetch('https://public.example/readme');
	assert.equal(textResult.contentType, 'text/plain; charset=utf-8');
	assert.equal(textResult.derivedText, 'Plain text page.');
});

test('public website preview exposes readable text and import creates immutable versions for the same canonical URL', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-website-import-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const descriptor = URI.file(join(directory, 'one.code-workspace')).toString();
		const project = database.createProjectWorkspace('One', directory, descriptor);
		const task = database.createTask({ projectId: project.project.id, bindingId: project.binding.id, title: 'Review page' });
		const sender = {} as WebContents;
		const window = { config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } }, openedWorkspace: { configPath: URI.parse(descriptor) } } as unknown as ICodeWindow;
		const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender ? window : undefined } as IWindowsMainService;
		const html = '<html><head><title>Example &amp; Guide</title><script>secret()</script></head><body><nav>Menu</nav><main><h1>Hello</h1><p>Readable page.</p></main></body></html>';
		let fetchCount = 0;
		const requests: { hostname: string; path: string }[] = [];
		const transport = new PublicWebsiteImportTransport({
			resolveAddresses: async () => [publicAddress],
			executePinnedRequest: async request => {
				requests.push({ hostname: request.hostname, path: request.path });
				if (request.hostname === 'example.org') {
					return { statusCode: 302, headers: { location: 'https://www.example.org/canonical-article' }, body: Buffer.alloc(0) };
				}
				assert.equal(request.hostname, 'www.example.org');
				fetchCount++;
				return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html.replace('Readable page.', `Readable page ${fetchCount}.`)) };
			},
		});
		const channel = new WorkspaceWebsiteChannel(database, new WorkspaceDashboardChannel(database, windows), () => transport);
		const preview = await channel.call<{ previewId: string; requestedUri: string; sourceUri: string; title: string; contentType: string; derivedText: string; contentSha256: string; omissions: string[] }>(sender, 'previewPage', {
			projectId: project.project.id, url: 'https://EXAMPLE.org:443/article#part',
		});
		assert.equal(preview.requestedUri, 'https://example.org/article');
		assert.equal(preview.sourceUri, 'https://www.example.org/canonical-article');
		assert.equal(preview.title, 'Example & Guide');
		assert.equal(preview.contentType, 'text/html; charset=utf-8');
		assert.match(preview.derivedText, /Hello/);
		assert.doesNotMatch(preview.derivedText, /secret|Menu/);
		assert.ok(preview.omissions.includes('Scripts'));
		const first = await channel.call<{ id: string; version: number; previousId: string | null; contentSha256: string; sourceUri: string; externalId: string }>(sender, 'importPreview', {
			projectId: project.project.id, previewId: preview.previewId, taskId: task.id,
		});
		assert.equal(first.version, 1);
		assert.equal(first.previousId, null);
		assert.equal(first.sourceUri, preview.requestedUri);
		assert.equal(first.externalId, preview.sourceUri);
		assert.equal(first.contentSha256, createHash('sha256').update(Buffer.from(html.replace('Readable page.', 'Readable page 1.'))).digest('hex'));
		assert.equal(database.knowledge.listTaskReferences(task.id)[0].id, first.id);
		const nextPreview = await channel.call<{ previewId: string; requestedUri: string; sourceUri: string }>(sender, 'previewPage', { projectId: project.project.id, url: first.sourceUri! });
		assert.equal(nextPreview.requestedUri, first.sourceUri);
		assert.equal(nextPreview.sourceUri, first.externalId);
		assert.equal(requests.filter(request => request.hostname === 'example.org' && request.path === '/article').length, 2,
			'refreshing from the persisted source URI must fetch the originally requested URL');
		const second = await channel.call<{ version: number; previousId: string | null }>(sender, 'importPreview', { projectId: project.project.id, previewId: nextPreview.previewId });
		assert.equal(second.version, 2);
		assert.equal(second.previousId, first.id);
		assert.equal(database.knowledge.listProjectReferences(project.project.id).length, 2);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
