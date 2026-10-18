/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionPermissionPolicy, AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { AgentSessionCollaborationService } from './agentSessionCollaborationService.js';
import { AgentSessionMcpBridge } from './agentSessionMcpBridge.js';
import { AgentSessionPreparationError } from './agentSessionPreparationError.js';

const POLICY: AgentSessionPermissionPolicy = { mode: 'mutating', approval: 'on-request' };

test('MCP setup failure revokes the real listener and retains retryable cleanup after a close error', async () => {
	const root = mkdtempSync(join(tmpdir(), 'agent-session-mcp-setup-recovery-'));
	const workspace = join(root, 'workspace');
	mkdirSync(workspace);
	const canonicalWorkspace = realpathSync(workspace);
	const database = WorkspaceDatabase.open(':memory:');
	let access: Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>> | undefined;
	let recovery: AgentSessionPreparationError['recovery'];
	let databaseClosed = false;
	try {
		const project = database.createProject('MCP setup cleanup fixture');
		const binding = database.createFolderBinding({ projectId: project.id, path: canonicalWorkspace });
		const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'setup cleanup', provider: 'codex', model: 'fixture-model', workspaceMode: 'sharedFolder' });
		const foreignProject = database.createProject('Unrelated project');
		const foreignBinding = database.createFolderBinding({ projectId: foreignProject.id, path: canonicalWorkspace });
		const foreignSession = database.agentSessions.createSession({ projectId: foreignProject.id, bindingId: foreignBinding.id, name: 'unrelated session', provider: 'claude', model: 'fixture-model', workspaceMode: 'sharedFolder' });
		const identity = statSync(workspace, { bigint: true });
		const snapshot: AgentSessionTurnSnapshot = {
			schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision,
			bindingId: binding.id, taskId: null, provider: 'codex', model: 'fixture-model', profileRef: session.profileRef,
			cwd: canonicalWorkspace, folderIdentity: { canonicalPath: canonicalWorkspace, dev: identity.dev.toString(), ino: identity.ino.toString() },
			managedWorktreeOwnerId: null, permissionPolicy: POLICY, convention: null, references: [],
		};
		const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
		let boundPort: number | undefined;
		let failAddressInspection = true;
		let failFirstClose = true;
		const collaboration = new AgentSessionCollaborationService(database);
		const bridge = new AgentSessionMcpBridge(collaboration, listener => {
			const server = createServer(listener);
			const actualAddress = server.address.bind(server);
			const actualClose = server.close.bind(server);
			Object.defineProperty(server, 'address', {
				value: () => {
					const address = actualAddress();
					if (failAddressInspection) {
						failAddressInspection = false;
						assert.ok(address && typeof address !== 'string');
						boundPort = address.port;
						throw new Error('Injected address inspection failure after real loopback bind.');
					}
					return address;
				},
			});
			Object.defineProperty(server, 'close', {
				value: (callback?: (error?: Error) => void) => {
					if (failFirstClose) {
						failFirstClose = false;
						queueMicrotask(() => callback?.(new Error('Injected first listener close failure.')));
						return server;
					}
					return actualClose(callback);
				},
			});
			return server;
		});

		let setupError: unknown;
		try {
			access = await bridge.issueAccess({ projectId: project.id, sessionId: session.id, turnId: turn.id, permissionPolicy: POLICY });
		} catch (error) {
			setupError = error;
		}
		assert.ok(setupError instanceof AgentSessionPreparationError);
		assert.equal(setupError.cleanupVerified, false, 'The failed close receipt must remain unverified.');
		recovery = setupError.recovery;
		assert.ok(recovery, 'Incomplete real-listener cleanup must retain an explicit recovery handle.');
		assert.ok(boundPort, 'The injected failure must happen only after the real ephemeral port is known.');
		assert.equal(database.agentSessionTurns.getTurn(project.id, session.id, turn.id)?.state, 'starting', 'Revoking the MCP grant must not mutate the session turn.');
		assert.equal(database.agentSessions.getSession(foreignProject.id, foreignSession.id)?.state, 'created', 'Setup cleanup must not affect a session in another project.');
		await assertRevokedListenerClosesConnection(boundPort);

		recovery.revokeAccess();
		await recovery.releasePrivateConfig();
		recovery = undefined;
		await assertLoopbackRefused(boundPort);
		assert.equal(database.agentSessionTurns.getTurn(project.id, session.id, turn.id)?.state, 'starting');
		assert.equal(database.agentSessions.getSession(foreignProject.id, foreignSession.id)?.state, 'created');
	} finally {
		const failures: unknown[] = [];
		if (access) {
			try { access.revokeAccess(); } catch (error) { failures.push(error); }
			try { await access.releasePrivateConfig(); } catch (error) { failures.push(error); }
		}
		if (recovery) {
			try { recovery.revokeAccess(); } catch (error) { failures.push(error); }
			try { await recovery.releasePrivateConfig(); } catch (error) { failures.push(error); }
		}
		try { database.close(); databaseClosed = true; } catch (error) { failures.push(error); }
		rmSync(root, { recursive: true, force: true });
		if (failures.length) { throw new AggregateError(failures, 'The MCP setup failure fixture could not release its real listener.'); }
	}
	assert.equal(databaseClosed, true);
});

function assertRevokedListenerClosesConnection(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port });
		const timer = setTimeout(() => { socket.destroy(); reject(new Error('The revoked MCP listener did not reject a connection.')); }, 2_000);
		socket.once('connect', () => undefined);
		socket.once('close', () => { clearTimeout(timer); resolve(); });
		socket.once('error', error => { clearTimeout(timer); reject(error); });
	});
}

function assertLoopbackRefused(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port });
		socket.once('connect', () => { socket.destroy(); reject(new Error('The released MCP listener accepted a connection.')); });
		socket.once('error', error => {
			if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') { resolve(); }
			else { reject(error); }
		});
	});
}
