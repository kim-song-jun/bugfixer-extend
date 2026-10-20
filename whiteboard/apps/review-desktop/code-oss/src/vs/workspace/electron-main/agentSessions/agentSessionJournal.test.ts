/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { createAgentPtyOutputSanitizer } from './agentOutputRedactor.js';
import { AgentSessionJournal } from './agentSessionJournal.js';

test('journal serializes sanitized host events and terminal output durably with one monotonic cursor', () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-journal-'));
	const databasePath = join(directory, 'workspace.db');
	const projectPath = join(directory, 'project');
	mkdirSync(projectPath);
	let database = WorkspaceDatabase.open(databasePath);
	try {
		const project = database.createProject('Journal project');
		const binding = database.createFolderBinding({ projectId: project.id, path: projectPath });
		const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Journal', provider: 'codex', model: 'fixture', workspaceMode: 'sharedFolder' });
		const cwd = realpathSync(projectPath);
		const stat = statSync(cwd, { bigint: true });
		const snapshot: AgentSessionTurnSnapshot = {
			schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: null,
			provider: session.provider, model: session.model, profileRef: null, cwd,
			folderIdentity: { canonicalPath: cwd, dev: stat.dev.toString(), ino: stat.ino.toString() }, managedWorktreeOwnerId: null,
			permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [],
		};
		const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
		const secret = 'journal-cross-chunk-secret';
		const sanitizer = createAgentPtyOutputSanitizer({ knownSecrets: [secret] });
		const journal = new AgentSessionJournal(database.agentSessionTranscripts, snapshot, turn.id, [secret]);
		journal.appendEvent('info', 'host', 'session.turn-starting');
		journal.appendTerminal(sanitizer.push(`prefix ${secret.slice(0, 11)}`));
		journal.appendTerminal(sanitizer.push(`${secret.slice(11)} suffix`));
		journal.appendTerminal(sanitizer.flush());
		journal.appendGap();
		journal.appendCleanupFailure('processGroupStillLive');
		const page = database.agentSessionTranscripts.readPage(project.id, session.id, turn.id);
		assert.deepEqual(page.entries.map(entry => entry.sequence), [1, 2, 3, 4, 5, 6]);
		assert.equal(page.entries[0].kind, 'log');
		assert.equal(page.entries[4].severity, 'warning');
		assert.equal(page.entries[5].severity, 'error');
		assert.equal(page.entries[5].text, 'The owned process group remained live after the stop request.');
		assert.ok(page.entries.filter(entry => entry.kind === 'terminal').every(entry => !entry.text.includes(secret)));
		assert.ok(page.entries.some(entry => entry.kind === 'terminal' && entry.text.includes('***')));
		assert.equal(page.entries.some(entry => entry.text.includes('PGID') || entry.text.includes('PID')), false);
		database.close();
		database = WorkspaceDatabase.open(databasePath);
		assert.deepEqual(database.agentSessionTranscripts.readPage(project.id, session.id, turn.id).entries, page.entries);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
