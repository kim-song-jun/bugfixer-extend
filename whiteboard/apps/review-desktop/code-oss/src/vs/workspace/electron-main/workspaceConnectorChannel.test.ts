/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebContents } from 'electron';
import { URI } from '../../base/common/uri.js';
import type { ILogService } from '../../platform/log/common/log.js';
import type { ICodeWindow } from '../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type { WorkspaceConnectorAccountDTO, WorkspaceConnectorPreviewDTO } from '../common/workspaceConnectorProtocol.js';
import type { WorkspaceReferenceDTO } from '../common/workspaceKnowledgeProtocol.js';
import type { ConnectorTransport } from './connectors/index.js';
import { encodeSourceArtifact, safeTitle } from './connectors/types.js';
import { WorkspaceConnectorChannel } from './workspaceConnectorChannel.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';

test('connector IPC previews a project-scoped Slack snapshot before importing that exact source', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-connector-channel-'));
	const databasePath = join(directory, 'workspace.db');
	const database = WorkspaceDatabase.open(databasePath);
	let now = Date.now();
	try {
		const descriptor = URI.file(join(directory, 'one.code-workspace')).toString();
		const one = database.createProjectWorkspace('One', directory, descriptor);
		const two = database.createProjectWorkspace('Two', directory, URI.file(join(directory, 'two.code-workspace')).toString());
		const archivedTask = database.createTask({ projectId: one.project.id, bindingId: one.binding.id, title: 'Archived task' });
		const selectedTask = database.createTask({ projectId: one.project.id, bindingId: one.binding.id, title: 'Selected task' });
		const sender = { id: 1 } as WebContents;
		const otherSender = { id: 2 } as WebContents;
		const projectWindow = {
			config: { reviewWindowLaunch: { kind: 'project', projectId: one.project.id } },
			openedWorkspace: { configPath: URI.parse(descriptor) },
		} as unknown as ICodeWindow;
		const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender ? projectWindow : undefined } as IWindowsMainService;
		const secrets = new Map<string, string>();
		const vault = {
			put: async (_provider: 'slack' | 'notion', id: string, secret: string) => { secrets.set(id, secret); },
			get: async (_provider: 'slack' | 'notion', id: string) => secrets.get(id),
			delete: async (_provider: 'slack' | 'notion', id: string) => { secrets.delete(id); },
		};
		const requests: string[] = [];
		const transport: ConnectorTransport = {
			fetch: async (input, init) => {
				const url = new URL(String(input));
				requests.push(url.toString());
				assert.equal(url.origin, 'https://slack.com');
				assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer xoxb-test-secret');
				if (url.pathname === '/api/auth.test') {
					return Response.json({ ok: true, team_id: 'TTEAM', user_id: 'UUSER', team: 'Team', user: 'User' });
				}
				assert.equal(url.pathname, '/api/conversations.history');
				assert.equal(url.searchParams.get('channel'), 'C123');
				return Response.json({ ok: true, messages: [{ ts: '100.001', user: 'UUSER', text: 'A real imported message' }], has_more: false });
			},
		};
		const channel = new WorkspaceConnectorChannel(database, new WorkspaceDashboardChannel(database, windows), () => vault,
			{ error: () => undefined } as unknown as ILogService, transport, () => now);
		await assert.rejects(channel.call(sender, 'connectAccount', { projectId: one.project.id, provider: 'slack', token: 'nonascii-é' }), /valid token/);
		const account = await channel.call<WorkspaceConnectorAccountDTO>(sender, 'connectAccount', {
			projectId: one.project.id, provider: 'slack', token: 'xoxb-test-secret',
		});
		assert.equal(account.state, 'active');
		assert.equal(account.label, 'User · Team');
		assert.equal(secrets.get(account.id), 'xoxb-test-secret');
		assert.equal((await channel.call<WorkspaceConnectorAccountDTO[]>(sender, 'listAccounts', one.project.id)).length, 1);
		await assert.rejects(channel.call(sender, 'listAccounts', two.project.id), /does not match this window/);
		await assert.rejects(channel.call(otherSender, 'listAccounts', one.project.id), /open project window/);
		await assert.rejects(channel.call(sender, 'importSlackConversation', {
			projectId: two.project.id, accountId: account.id, channelId: 'C123',
		}), /does not match this window/);
		const preview = await channel.call<WorkspaceConnectorPreviewDTO>(sender, 'previewSlackConversation', {
			projectId: one.project.id, accountId: account.id, channelId: 'C123',
		});
		assert.equal(preview.connectorId, 'slack');
		assert.equal(preview.externalId, 'C123');
		assert.equal(preview.sourceUri, 'https://app.slack.com/archives/C123');
		assert.equal(preview.title, 'Slack conversation C123');
		assert.match(preview.contentSha256, /^[a-f0-9]{64}$/);
		const expectedSource = encodeSourceArtifact([{
			request: 'conversations.history?channel=C123&limit=100',
			bytes: Buffer.from(JSON.stringify({ ok: true, messages: [{ ts: '100.001', user: 'UUSER', text: 'A real imported message' }], has_more: false })),
		}]);
	assert.equal(preview.contentSha256, createHash('sha256').update(expectedSource).digest('hex'));
		assert.equal(preview.derivedText, '[100.001] UUSER: A real imported message');
		assert.equal('content' in preview, false);
		assert.equal('accountRef' in preview, false);
		assert.equal(JSON.stringify(preview).includes('xoxb-test-secret'), false);
		assert.equal(database.knowledge.listProjectReferences(one.project.id).length, 0, 'preview must not persist source data');
		const reference = await channel.call<WorkspaceReferenceDTO>(sender, 'importPreview', {
			projectId: one.project.id, accountId: account.id, previewId: preview.previewId,
		});
		assert.equal(reference.connectorId, 'slack');
		assert.equal(reference.externalId, preview.externalId);
		assert.equal(reference.sourceUri, preview.sourceUri);
		assert.equal(reference.title, preview.title);
		assert.equal(reference.contentSha256, preview.contentSha256);
		const importedSnapshot = database.knowledge.readReference(reference.id)!;
		assert.equal(importedSnapshot.derivedText, '[100.001] UUSER: A real imported message');
		assert.equal(createHash('sha256').update(importedSnapshot.content).digest('hex'), preview.contentSha256);
		assert.equal('derivedText' in reference, false);
		assert.equal(requests.length, 2);
		assert.equal(safeTitle(`${'x'.repeat(499)} tail`, 'fallback'), 'x'.repeat(499), 'truncation must trim whitespace at the 500-character boundary');
		const titleAtLimit = 'x'.repeat(500);
		const taskPreview = await channel.call<WorkspaceConnectorPreviewDTO>(sender, 'previewSlackConversation', {
			projectId: one.project.id, accountId: account.id, channelId: 'C123', title: titleAtLimit,
		});
		assert.equal(taskPreview.title, titleAtLimit);
		database.archiveTask(archivedTask.id, archivedTask.revision);
		await assert.rejects(channel.call(sender, 'importPreview', {
			projectId: one.project.id, accountId: account.id, previewId: taskPreview.previewId, taskId: archivedTask.id,
		}), /same project/);
		assert.equal(database.knowledge.listProjectReferences(one.project.id).length, 1, 'failed task links must not persist an extra snapshot version');
		assert.deepEqual(database.knowledge.listTaskReferences(archivedTask.id), []);
		const retriedReference = await channel.call<WorkspaceReferenceDTO>(sender, 'importPreview', {
			projectId: one.project.id, accountId: account.id, previewId: taskPreview.previewId, taskId: selectedTask.id,
		});
		assert.equal(retriedReference.externalId, taskPreview.externalId);
		assert.equal(retriedReference.title, taskPreview.title);
		assert.deepEqual(database.knowledge.listTaskReferences(selectedTask.id).map(item => item.id), [retriedReference.id]);
		assert.equal(database.knowledge.readReference(retriedReference.id)?.version, 2);
		assert.deepEqual(database.knowledge.listProjectReferences(one.project.id).map(item => item.version).sort(), [1, 2], 'the failed link must add no version and the successful retry must add exactly one');
		for (const databaseFile of readdirSync(directory).filter(name => name.startsWith('workspace.db'))) {
			assert.equal(readFileSync(join(directory, databaseFile)).includes(Buffer.from('xoxb-test-secret')), false, `${databaseFile} contains a connector credential`);
		}
		const clearablePreview = await channel.call<WorkspaceConnectorPreviewDTO>(sender, 'previewSlackConversation', {
			projectId: one.project.id, accountId: account.id, channelId: 'C123',
		});
		await channel.call(sender, 'clearPreviews', { projectId: one.project.id });
		await assert.rejects(channel.call(sender, 'importPreview', {
			projectId: one.project.id, accountId: account.id, previewId: clearablePreview.previewId,
		}), /no longer available/);
		const expiringPreview = await channel.call<WorkspaceConnectorPreviewDTO>(sender, 'previewSlackConversation', {
			projectId: one.project.id, accountId: account.id, channelId: 'C123',
		});
		now = Date.parse(expiringPreview.expiresAt);
		await assert.rejects(channel.call(sender, 'importPreview', {
			projectId: one.project.id, accountId: account.id, previewId: expiringPreview.previewId,
		}), /expired/);
		now++;
		const disconnectingPreview = await channel.call<WorkspaceConnectorPreviewDTO>(sender, 'previewSlackConversation', {
			projectId: one.project.id, accountId: account.id, channelId: 'C123',
		});
		await channel.call(sender, 'disconnectAccount', { projectId: one.project.id, accountId: account.id });
		assert.equal(secrets.has(account.id), false);
		await assert.rejects(channel.call(sender, 'importPreview', {
			projectId: one.project.id, accountId: account.id, previewId: disconnectingPreview.previewId,
		}), /no longer available/);
		await assert.rejects(channel.call(sender, 'importSlackConversation', {
			projectId: one.project.id, accountId: account.id, channelId: 'C123',
		}), /Call not found/);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Notion previews stay in the main process until the reviewed snapshot is imported', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-notion-preview-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const descriptor = URI.file(join(directory, 'notion.code-workspace')).toString();
		const project = database.createProjectWorkspace('Notion', directory, descriptor);
		const sender = { id: 91 } as WebContents;
		const projectWindow = {
			config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } },
			openedWorkspace: { configPath: URI.parse(descriptor) },
		} as unknown as ICodeWindow;
		const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender ? projectWindow : undefined } as IWindowsMainService;
		const secrets = new Map<string, string>();
		const vault = {
			put: async (_provider: 'slack' | 'notion', id: string, secret: string) => { secrets.set(id, secret); },
			get: async (_provider: 'slack' | 'notion', id: string) => secrets.get(id),
			delete: async (_provider: 'slack' | 'notion', id: string) => { secrets.delete(id); },
		};
		const pageId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
		const credentialShapedId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
		const transport: ConnectorTransport = { fetch: async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname === '/v1/users/me') {
				if (new Headers(init?.headers).get('Authorization') === `Bearer ${credentialShapedId}`) {
					return Response.json({ object: 'user', id: credentialShapedId, type: 'bot', name: 'Compromised identity' });
				}
				return Response.json({ object: 'user', id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', type: 'bot', name: 'Project Notion Bot' });
			}
			if (url.pathname === `/v1/pages/${pageId}`) {
				return Response.json({ object: 'page', properties: { Name: { type: 'title', title: [{ plain_text: 'Reviewed Notion page' }] } } });
			}
			assert.equal(url.pathname, `/v1/blocks/${pageId}/children`);
			return Response.json({ results: [{ type: 'paragraph', has_children: false, paragraph: { rich_text: [{ plain_text: 'Reviewed Notion content' }] } }], has_more: false });
		} };
		const channel = new WorkspaceConnectorChannel(database, new WorkspaceDashboardChannel(database, windows), () => vault,
			{ error: () => undefined } as unknown as ILogService, transport);
		const account = await channel.call<WorkspaceConnectorAccountDTO>(sender, 'connectAccount', {
			projectId: project.project.id, provider: 'notion', token: 'secret-notion-token', accountLabel: 'Personal workspace',
		});
		const sameIdentityAccount = await channel.call<WorkspaceConnectorAccountDTO>(sender, 'connectAccount', {
			projectId: project.project.id, provider: 'notion', token: 'another-secret-notion-token', accountLabel: 'Client workspace',
		});
		assert.equal(account.remoteIdentity, sameIdentityAccount.remoteIdentity);
		assert.notEqual(account.id, sameIdentityAccount.id);
		assert.equal(account.label, 'Personal workspace');
		assert.equal(sameIdentityAccount.label, 'Client workspace');
		assert.deepEqual((await channel.call<WorkspaceConnectorAccountDTO[]>(sender, 'listAccounts', project.project.id)).map(item => item.label), ['Personal workspace', 'Client workspace']);
		await assert.rejects(channel.call(sender, 'connectAccount', {
			projectId: project.project.id, provider: 'notion', token: 'another-secret-notion-token', accountLabel: '  ',
		}), /label for this Notion connection/);
		const credentialInLabel = 'Third-Secret-Notion-Token';
		await assert.rejects(channel.call(sender, 'connectAccount', {
			projectId: project.project.id, provider: 'notion', token: credentialInLabel,
			accountLabel: `Workspace ${credentialInLabel.toLowerCase()}`,
		}), /연결 라벨에 개인 액세스 토큰을 포함할 수 없습니다/);
		assert.equal(secrets.has(credentialInLabel), false);
		await assert.rejects(channel.call(sender, 'connectAccount', {
			projectId: project.project.id, provider: 'notion', token: credentialShapedId,
			accountLabel: 'Credential shaped identity',
		}), /account ID containing the personal access token/);
		const visibleAccounts = await channel.call<WorkspaceConnectorAccountDTO[]>(sender, 'listAccounts', project.project.id);
		assert.equal(visibleAccounts.length, 2, 'unsafe labels and identities must not create connector accounts');
		assert.equal(JSON.stringify(visibleAccounts).includes(credentialInLabel), false);
		assert.equal(JSON.stringify(visibleAccounts).includes(credentialShapedId), false);
		const preview = await channel.call<WorkspaceConnectorPreviewDTO>(sender, 'previewNotionPage', {
			projectId: project.project.id, accountId: account.id, pageId,
		});
		assert.equal(preview.connectorId, 'notion');
		assert.equal(preview.externalId, pageId);
		assert.equal(preview.title, 'Reviewed Notion page');
		assert.match(preview.derivedText, /Reviewed Notion content/);
		assert.equal('content' in preview, false);
		assert.equal(JSON.stringify(preview).includes('secret-notion-token'), false);
		assert.equal(database.knowledge.listProjectReferences(project.project.id).length, 0);
		const reference = await channel.call<WorkspaceReferenceDTO>(sender, 'importPreview', {
			projectId: project.project.id, accountId: account.id, previewId: preview.previewId,
		});
		assert.equal(reference.connectorId, preview.connectorId);
		assert.equal(reference.externalId, preview.externalId);
		assert.equal(reference.sourceUri, preview.sourceUri);
		assert.equal(reference.title, preview.title);
		assert.equal(reference.contentSha256, preview.contentSha256);
		assert.equal(database.knowledge.listProjectReferences(project.project.id).length, 1);
		for (const databaseFile of readdirSync(directory).filter(name => name.startsWith('workspace.db'))) {
			const bytes = readFileSync(join(directory, databaseFile));
			assert.equal(bytes.includes(Buffer.from('secret-notion-token')), false, `${databaseFile} contains a Notion credential`);
			assert.equal(bytes.includes(Buffer.from('another-secret-notion-token')), false, `${databaseFile} contains another Notion credential`);
			assert.equal(bytes.includes(Buffer.from(credentialInLabel)), false, `${databaseFile} contains a token rejected in the label`);
			assert.equal(bytes.includes(Buffer.from(credentialShapedId)), false, `${databaseFile} contains a token returned as an identity`);
		}
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
