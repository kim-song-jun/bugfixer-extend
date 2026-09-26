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
import type { WorkspaceConventionDTO, WorkspaceKnowledgeDTO, WorkspaceReferenceContentDTO, WorkspaceReferenceDTO } from '../common/workspaceKnowledgeProtocol.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import { WorkspaceKnowledgeChannel } from './workspaceKnowledgeChannel.js';

test('knowledge IPC imports immutable text, attaches it to its task, and rejects other project windows', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-knowledge-channel-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const descriptor = URI.file(join(directory, 'one.code-workspace')).toString();
		const one = database.createProjectWorkspace('One', directory, descriptor);
		const two = database.createProjectWorkspace('Two', directory, URI.file(join(directory, 'two.code-workspace')).toString());
		const task = database.createTask({ projectId: one.project.id, bindingId: one.binding.id, title: 'Read source' });
		const sender = {} as WebContents;
		const otherSender = {} as WebContents;
		const window = {
			config: { reviewWindowLaunch: { kind: 'project', projectId: one.project.id } },
			openedWorkspace: { configPath: URI.parse(descriptor) },
		} as unknown as ICodeWindow;
		const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender ? window : undefined } as IWindowsMainService;
		const dashboard = new WorkspaceDashboardChannel(database, windows);
		const channel = new WorkspaceKnowledgeChannel(database, dashboard);
		const imported = await channel.call<WorkspaceReferenceDTO>(sender, 'importTextReference', {
			projectId: one.project.id, title: 'Design notes', content: 'Keep the example readable.\n', sourceUri: 'https://example.com/design',
		});
		const content = await channel.call<WorkspaceReferenceContentDTO>(sender, 'getReference', { projectId: one.project.id, snapshotId: imported.id });
		assert.equal(content.content, 'Keep the example readable.\n');
		assert.equal('derivedText' in content, false);
		assert.equal('derivedText' in imported, false);
		await channel.call(sender, 'attachTaskReference', { projectId: one.project.id, taskId: task.id, snapshotId: imported.id });
		const snapshot = await channel.call<WorkspaceKnowledgeDTO>(sender, 'getProjectKnowledge', one.project.id);
		assert.equal(snapshot.taskReferences[task.id][0].id, imported.id);
		assert.equal(snapshot.references[0].contentSha256, content.contentSha256);
		const draft = await channel.call<WorkspaceConventionDTO>(sender, 'createConventionDraft', {
			projectId: one.project.id, markdown: '# Project conventions\n\nKeep examples readable.', sourceSnapshotIds: [imported.id],
		});
		assert.equal(draft.latestCheckVerdict, null);
		assert.equal((await channel.call<WorkspaceKnowledgeDTO>(sender, 'getProjectKnowledge', one.project.id)).conventions[0].latestCheckVerdict, null);
		const reimported = await channel.call<WorkspaceReferenceDTO>(sender, 'importTextReference', {
			projectId: one.project.id, sourceId: imported.sourceId, title: 'Design notes v2', content: 'A newer version.',
		});
		assert.equal(reimported.version, 2);
		assert.equal((await channel.call<WorkspaceKnowledgeDTO>(sender, 'getProjectKnowledge', one.project.id)).taskReferences[task.id][0].id, imported.id);
		await assert.rejects(channel.call(otherSender, 'getProjectKnowledge', one.project.id), /open project window/);
		await assert.rejects(channel.call(sender, 'getProjectKnowledge', two.project.id), /does not match this window/);
		await assert.rejects(channel.call(sender, 'importTextReference', { projectId: one.project.id, title: 'Bad URL', content: 'text', sourceUri: 'file:///etc/passwd' }), /HTTP or HTTPS/);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
