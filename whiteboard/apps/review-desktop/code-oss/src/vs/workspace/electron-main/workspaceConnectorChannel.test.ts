/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebContents } from 'electron';
import { URI } from '../../base/common/uri.js';
import type { ILogService } from '../../platform/log/common/log.js';
import type { ICodeWindow } from '../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type { WorkspaceConnectorAccountDTO } from '../common/workspaceConnectorProtocol.js';
import type { WorkspaceReferenceDTO } from '../common/workspaceKnowledgeProtocol.js';
import type { ConnectorTransport } from './connectors/index.js';
import { WorkspaceConnectorChannel } from './workspaceConnectorChannel.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';

test('connector IPC keeps a selected account scoped to its project and persists only imported content', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-connector-channel-'));
	const databasePath = join(directory, 'workspace.db');
	const database = WorkspaceDatabase.open(databasePath);
	try {
		const descriptor = URI.file(join(directory, 'one.code-workspace')).toString();
		const one = database.createProjectWorkspace('One', directory, descriptor);
		const two = database.createProjectWorkspace('Two', directory, URI.file(join(directory, 'two.code-workspace')).toString());
		const sender = {} as WebContents;
		const otherSender = {} as WebContents;
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
			{ error: () => undefined } as unknown as ILogService, transport);
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
		const reference = await channel.call<WorkspaceReferenceDTO>(sender, 'importSlackConversation', {
			projectId: one.project.id, accountId: account.id, channelId: 'C123',
		});
		assert.equal(reference.connectorId, 'slack');
		assert.equal(database.knowledge.readReference(reference.id)!.derivedText, '[100.001] UUSER: A real imported message');
		assert.equal('derivedText' in reference, false);
		assert.equal(requests.length, 2);
		for (const databaseFile of readdirSync(directory).filter(name => name.startsWith('workspace.db'))) {
			assert.equal(readFileSync(join(directory, databaseFile)).includes(Buffer.from('xoxb-test-secret')), false, `${databaseFile} contains a connector credential`);
		}
		await channel.call(sender, 'disconnectAccount', { projectId: one.project.id, accountId: account.id });
		assert.equal(secrets.has(account.id), false);
		await assert.rejects(channel.call(sender, 'importSlackConversation', {
			projectId: one.project.id, accountId: account.id, channelId: 'C123',
		}), /unavailable/);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
