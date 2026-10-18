/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionPermissionPolicy, AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { AgentSessionCollaborationService } from './agentSessionCollaborationService.js';
import { AgentSessionMcpBridge } from './agentSessionMcpBridge.js';
import { AgentSessionPreparationError } from './agentSessionPreparationError.js';

const POLICY: AgentSessionPermissionPolicy = { mode: 'mutating', approval: 'on-request' };

test('MCP setup failure retains exact cleanup hooks and retries a real socket resource', async () => {
	const root = mkdtempSync(join(tmpdir(), 'agent-session-mcp-setup-recovery-'));
	const temporaryDirectory = join(root, 'private');
	mkdirSync(temporaryDirectory);
	const workspace = join(root, 'workspace');
	mkdirSync(workspace);
	const database = WorkspaceDatabase.open(':memory:');
	try {
		const project = database.createProject('MCP setup cleanup fixture');
		const binding = database.createFolderBinding({ projectId: project.id, path: realpathSync(workspace) });
		const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'setup cleanup', provider: 'codex', model: 'fixture-model', workspaceMode: 'sharedFolder' });
		const identity = statSync(workspace, { bigint: true });
		const snapshot: AgentSessionTurnSnapshot = {
			schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision,
			bindingId: binding.id, taskId: null, provider: 'codex', model: 'fixture-model', profileRef: session.profileRef,
			cwd: workspace, folderIdentity: { canonicalPath: workspace, dev: identity.dev.toString(), ino: identity.ino.toString() },
			managedWorktreeOwnerId: null, permissionPolicy: POLICY, convention: null, references: [],
		};
		const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
		let failSocketUnlink = true;
		let failDirectoryRemoval = true;
		const bridge = new AgentSessionMcpBridge(new AgentSessionCollaborationService(database), {
			temporaryDirectory,
			chmod: () => { throw new Error('Injected chmod failure after real socket listen.'); },
			unlink: async path => {
				if (failSocketUnlink) {
					failSocketUnlink = false;
					throw Object.assign(new Error('Injected one-time socket unlink failure.'), { code: 'EACCES' });
				}
				await unlink(path);
			},
			rmdir: async path => {
				if (failDirectoryRemoval) {
					failDirectoryRemoval = false;
					throw Object.assign(new Error('Injected one-time private directory removal failure.'), { code: 'EACCES' });
				}
				await rmdir(path);
			},
		});
		let recovery: AgentSessionPreparationError['recovery'];
		try {
			await assert.rejects(bridge.issueAccess({ projectId: project.id, sessionId: session.id, turnId: turn.id, permissionPolicy: POLICY }), error => {
				assert.ok(error instanceof AgentSessionPreparationError);
				assert.equal(error.cleanupVerified, false, 'A failed cleanup receipt cannot be upgraded to verified.');
				recovery = error.recovery;
				return Boolean(recovery);
			});
			assert.equal(readdirSync(temporaryDirectory).length, 1, 'The test must observe the retained private socket directory after the injected cleanup failure.');
			assert.ok(recovery);
			recovery.revokeAccess();
			await recovery.releasePrivateConfig();
			assert.deepEqual(readdirSync(temporaryDirectory), [], 'The exact retained socket and directory must be removed by the recovery handle.');
		} finally {
			if (recovery) {
				const cleanupFailures: unknown[] = [];
				try { recovery.revokeAccess(); } catch (error) { cleanupFailures.push(error); }
				try { await recovery.releasePrivateConfig(); } catch (error) { cleanupFailures.push(error); }
				if (cleanupFailures.length) { throw new AggregateError(cleanupFailures, 'The bridge failure fixture could not release its retained resources.'); }
			}
		}
	} finally {
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
});
