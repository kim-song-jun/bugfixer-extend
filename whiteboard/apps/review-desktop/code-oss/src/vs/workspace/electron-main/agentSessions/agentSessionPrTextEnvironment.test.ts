/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { createAgentSessionPrTextResolver } from './agentSessionPrTextEnvironment.js';

test('resolver binds sourceCwd to the selected completed turn and rejects changed folder identity at preflight', async () => {
	const root = mkdtempSync(join(tmpdir(), 'agent-pr-text-environment-'));
	const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot);
	mkdirSync(join(root, '.claude'), { mode: 0o700 });
	const packagedHelper = join(root, 'app', 'review-runtime', 'bin', 'provider-group-control.mjs');
	mkdirSync(join(root, 'app', 'review-runtime', 'bin'), { recursive: true });
	writeFileSync(packagedHelper, 'export {};', { mode: 0o600 });
	const database = WorkspaceDatabase.open(join(root, 'workspace.db'));
	let privateControlDirectory: string | undefined;
	try {
		const project = database.createProject('PR text environment');
		const binding = database.createFolderBinding({ projectId: project.id, path: sourceRoot, vcsKind: 'git', vcsRoot: sourceRoot });
		const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Source session', provider: 'claude', model: 'claude-test', profileRef: 'local-default-claude', workspaceMode: 'sharedFolder' });
		const canonicalSource = realpathSync(sourceRoot);
		const identity = statSync(canonicalSource, { bigint: true });
		const snapshot: AgentSessionTurnSnapshot = {
			schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: null,
			provider: session.provider, model: 'historical-model', profileRef: 'historical-profile', cwd: canonicalSource,
			folderIdentity: { canonicalPath: canonicalSource, dev: identity.dev.toString(), ino: identity.ino.toString() }, managedWorktreeOwnerId: null,
			permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [],
		};
		let turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
		const running = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, database.agentSessions.getSession(project.id, session.id)!.revision, { state: 'running' });
		turn = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, running.turn.revision, database.agentSessions.getSession(project.id, session.id)!.revision, { state: 'exited', exitCode: 0, cleanupVerified: true }).turn;
		const resolver = createAgentSessionPrTextResolver({
			database, resourcesPath: root, homeDirectory: () => root,
			runtimePaths: () => ({ standaloneNode: realpathSync(process.execPath), guardian: realpathSync(process.execPath), cliProbeGuardian: realpathSync(process.execPath), mcpGateway: realpathSync(process.execPath), providerIdentityHook: realpathSync(process.execPath) }),
			normalizeProfileRef: (_provider, profileRef) => profileRef ?? 'local-default-claude',
			resolveExecutable: () => realpathSync(process.execPath),
			buildLaunchEnvironment: () => ({ PATH: '/usr/bin' }),
			verifyWorkspace: async (currentSession, selectedTurn) => {
				assert.equal(currentSession.bindingId, binding.id);
				assert.equal(selectedTurn.snapshot.folderIdentity.canonicalPath, canonicalSource);
			},
		});
		const environment = await resolver.resolve(session, turn);
		assert.equal(environment.sourceCwd, canonicalSource);
		assert.equal(environment.profileDirectory, join(root, '.claude'));
		assert.equal(environment.model, 'claude-test');
		assert.deepEqual(environment.processControl, { nodeExecutable: realpathSync(process.execPath), helperScript: packagedHelper });

		privateControlDirectory = mkdtempSync(join('/tmp', 'bfx-prt-test-'));
		chmodSync(privateControlDirectory, 0o700);
		const allowed = await environment.preflight({ providerId: 'claude', attemptId: randomUUID(), cwd: privateControlDirectory, prompt: 'private',
			profileDirectory: environment.profileDirectory, model: environment.model, permissionPolicy: { mode: 'read-only', approval: 'never' },
			preflight: environment.preflight } as Parameters<typeof environment.preflight>[0]);
		assert.equal(allowed.allowed, true);

		renameSync(sourceRoot, join(root, 'source-before-replacement')); mkdirSync(sourceRoot);
		const denied = await environment.preflight({ providerId: 'claude', attemptId: randomUUID(), cwd: privateControlDirectory, prompt: 'private',
			profileDirectory: environment.profileDirectory, model: environment.model, permissionPolicy: { mode: 'read-only', approval: 'never' },
			preflight: environment.preflight } as Parameters<typeof environment.preflight>[0]);
		assert.equal(denied.allowed, false);
	} finally {
		database.close();
		if (privateControlDirectory) { rmSync(privateControlDirectory, { recursive: true, force: true }); }
		rmSync(root, { recursive: true, force: true });
	}
});
