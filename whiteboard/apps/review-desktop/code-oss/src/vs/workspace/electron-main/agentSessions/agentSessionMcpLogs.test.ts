/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionPermissionPolicy, AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { readAgentSessionMcpLogs } from './agentSessionMcpLogs.js';

const POLICY: AgentSessionPermissionPolicy = { mode: 'mutating', approval: 'on-request' };

test('SQLite transcript reads redact before Unicode fragmentation and pin the continuation cursor', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-mcp-log-helper-'));
	const root = join(directory, 'workspace');
	mkdirSync(root);
	const database = WorkspaceDatabase.open(':memory:');
	try {
		const project = database.createProject('MCP transcript test');
		const binding = database.createFolderBinding({ projectId: project.id, path: realpathSync(root) });
		const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Read retained transcript' });
		const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, taskId: task.id,
			name: 'Transcript session', provider: 'codex', model: 'gpt-test', workspaceMode: 'sharedFolder' });
		const stats = statSync(root, { bigint: true });
		const snapshot: AgentSessionTurnSnapshot = { schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision,
			bindingId: binding.id, taskId: task.id, provider: session.provider, model: session.model, profileRef: session.profileRef, cwd: root,
			folderIdentity: { canonicalPath: root, dev: stats.dev.toString(), ino: stats.ino.toString() }, managedWorktreeOwnerId: null,
			permissionPolicy: POLICY, convention: null, references: [] };
		const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
		const secret = 'private-secret-crossing-boundary';
		const secretId = randomUUID();
		const raw = `${'😀'.repeat(997)}${secret}${'漢'.repeat(30)}`;
		database.agentSessionTranscripts.appendStructuredLog({ projectId: project.id, sessionId: session.id, turnId: turn.id,
			sequence: 1, text: raw, severity: 'error', source: 'host', references: [{ kind: 'task', id: secretId }], trustedKnownSecrets: [secret, secretId] });
		database.agentSessionTranscripts.appendStructuredLog({ projectId: project.id, sessionId: session.id, turnId: turn.id,
			sequence: 4, text: 'second retained record', severity: 'info', source: 'provider' });
		database.agentSessionTranscripts.appendStructuredLog({ projectId: project.id, sessionId: session.id, turnId: turn.id,
			sequence: 7, text: 'third retained record', severity: 'info', source: 'provider' });
		const safeText = database.agentSessionTranscripts.readPage(project.id, session.id, turn.id, { limit: 1 }).entries[0].text;
		let authorizationChecks = 0;
		const readPage = (afterSequence: number, options: Parameters<typeof database.agentSessionTranscripts.readPage>[3]) => {
			return database.agentSessionTranscripts.readPage(project.id, session.id, turn.id, { ...options, afterSequence });
		};
		const first = readAgentSessionMcpLogs(readPage, { projectId: project.id, sessionId: session.id, turnId: turn.id, maxCharacters: 1_000 }, [secret, secretId], () => authorizationChecks++);
		const firstEntry = (first as { entries: Array<{ textFragment: string; hasMoreFragments: boolean }> }).entries[0];
		assert.equal(firstEntry.hasMoreFragments, true);
		assert.equal(firstEntry.textFragment.includes(secret), false);
		const cursor = (first as { nextCursor: string }).nextCursor;
		const second = readAgentSessionMcpLogs(readPage, { projectId: project.id, sessionId: session.id, turnId: turn.id, cursor, maxCharacters: 1_000 }, [secret, secretId], () => authorizationChecks++);
		const secondEntries = (second as { entries: Array<{ textFragment: string; references: Array<{ id: string }> }> }).entries;
		const secondEntry = secondEntries[0];
		assert.equal(firstEntry.textFragment + secondEntry.textFragment, safeText);
		assert.equal(secondEntries[0].references[0].id, '***');
		assert.deepEqual((second as { gaps: Array<{ afterSequence: number; throughSequence: number }> }).gaps,
			[{ afterSequence: 1, throughSequence: 3 }, { afterSequence: 4, throughSequence: 6 }]);
		assert.equal(authorizationChecks, 4);
		assert.throws(() => readAgentSessionMcpLogs(readPage, { projectId: randomUUID(), sessionId: session.id, turnId: turn.id, cursor, maxCharacters: 1_000 }, [secret, secretId], () => undefined), /scope|filter/i);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
