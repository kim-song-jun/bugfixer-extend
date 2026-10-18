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
import { AgentSessionTranscriptStore } from './agentSessionTranscriptStore.js';

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-transcript-'));
	const root = join(directory, 'project');
	mkdirSync(root);
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	const project = database.createProject('Transcript project');
	const binding = database.createFolderBinding({ projectId: project.id, path: root });
	const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Transcript', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder' });
	const canonicalRoot = realpathSync(root);
	const stats = statSync(canonicalRoot, { bigint: true });
	const snapshot: AgentSessionTurnSnapshot = {
		schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: null,
		provider: session.provider, model: session.model, profileRef: null, cwd: canonicalRoot,
		folderIdentity: { canonicalPath: canonicalRoot, dev: stats.dev.toString(), ino: stats.ino.toString() },
		managedWorktreeOwnerId: null, permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [],
	};
	const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
	return { directory, database, project, session, turn };
}

function withFixture(callback: (value: ReturnType<typeof fixture>) => void): void {
	const value = fixture();
	try { callback(value); }
	finally { value.database.close(); rmSync(value.directory, { recursive: true, force: true }); }
}

test('transcript sink enforces open database and exact project/session/turn ownership', () => {
	withFixture(({ database, project, session, turn }) => {
		const valid = database.agentSessionTranscripts.appendSanitizedTerminalChunk({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 1, sanitizedTextFromTrustedPtyHost: 'x' });
		assert.deepEqual(database.agentSessionTranscripts.readPage(project.id, session.id, turn.id).entries, [valid]);
		const otherSession = database.agentSessions.createSession({ projectId: project.id, bindingId: session.bindingId, name: 'Other', provider: 'claude', model: 'sonnet', workspaceMode: 'sharedFolder' });
		assert.throws(() => database.agentSessionTranscripts.appendSanitizedTerminalChunk({ projectId: project.id, sessionId: otherSession.id, turnId: turn.id, sequence: 2, sanitizedTextFromTrustedPtyHost: 'wrong owner' }), /does not belong to this project and session/i);
		assert.throws(() => database.agentSessionTranscripts.readPage(project.id, otherSession.id, turn.id), /does not belong to this project and session/i);
		assert.throws(() => database.agentSessionTranscripts.readPage(project.id, session.id, '00000000-0000-4000-8000-000000000099'), /does not belong to this project and session/i);
		database.close();
		assert.throws(() => database.agentSessionTranscripts.appendSanitizedTerminalChunk({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 1, sanitizedTextFromTrustedPtyHost: 'x' }), /closed/i);
	});
});

test('same sequence retries are idempotent only for identical sanitized content and survive reopen', () => {
	const value = fixture();
	try {
		const first = value.database.agentSessionTranscripts.appendSanitizedTerminalChunk({ projectId: value.project.id, sessionId: value.session.id, turnId: value.turn.id, sequence: 1, sanitizedTextFromTrustedPtyHost: 'ready 😀\n' });
		assert.deepEqual(value.database.agentSessionTranscripts.appendSanitizedTerminalChunk({ projectId: value.project.id, sessionId: value.session.id, turnId: value.turn.id, sequence: 1, sanitizedTextFromTrustedPtyHost: 'ready 😀\n' }), first);
		assert.throws(() => value.database.agentSessionTranscripts.appendSanitizedTerminalChunk({ projectId: value.project.id, sessionId: value.session.id, turnId: value.turn.id, sequence: 1, sanitizedTextFromTrustedPtyHost: 'changed' }), /different content/i);
		value.database.close();
		const reopened = WorkspaceDatabase.open(join(value.directory, 'workspace.db'));
		try { assert.deepEqual(reopened.agentSessionTranscripts.readPage(value.project.id, value.session.id, value.turn.id).entries, [first]); }
		finally { reopened.close(); }
	} finally { rmSync(value.directory, { recursive: true, force: true }); }
});

test('UTF-8 byte limits, output page budget, and sequence holes are reported without claiming complete history', () => {
	withFixture(({ database, project, session, turn }) => {
		const store = database.agentSessionTranscripts;
		store.appendSanitizedTerminalChunk({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 1, sanitizedTextFromTrustedPtyHost: '한😀'.repeat(20) });
		store.appendSanitizedTerminalChunk({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 3, sanitizedTextFromTrustedPtyHost: 'tail' });
		assert.throws(() => store.appendSanitizedTerminalChunk({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 4, sanitizedTextFromTrustedPtyHost: '😀'.repeat(65_537) }), /256 KiB UTF-8/i);
		const page = store.readPage(project.id, session.id, turn.id, { limit: 1, maxOutputBytes: 256 * 1024 });
		assert.equal(page.entries[0].byteLength, Buffer.byteLength('한😀'.repeat(20), 'utf8'));
		assert.equal(page.hasMore, true);
		assert.deepEqual(page.gaps, []);
		const tail = store.readPage(project.id, session.id, turn.id, { afterSequence: 1 });
		assert.equal(tail.entries[0].sequence, 3);
		assert.deepEqual(tail.gaps, [{ afterSequence: 1, throughSequence: 2 }]);
	});
});

test('retention eviction preserves the highest cursor and reports prefix loss; pruned retries are unverifiable', () => {
	withFixture(({ database, project, session, turn }) => {
		const sqlite = Reflect.get(database, 'db');
		const store = new AgentSessionTranscriptStore(sqlite, () => { }, { maxBytesPerTurn: 256 * 1024, maxEntriesPerTurn: 2 });
		for (const [sequence, text] of [[1, 'one'], [2, 'two'], [3, 'three']] as const) {
			store.appendSanitizedTerminalChunk({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence, sanitizedTextFromTrustedPtyHost: text });
		}
		const page = store.readPage(project.id, session.id, turn.id, { afterSequence: 0 });
		assert.equal(page.highestSequence, 3);
		assert.equal(page.firstRetainedSequence, 2);
		assert.deepEqual(page.gaps, [{ afterSequence: 0, throughSequence: 1 }]);
		assert.deepEqual(page.entries.map(entry => entry.sequence), [2, 3]);
		assert.throws(() => store.appendSanitizedTerminalChunk({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 1, sanitizedTextFromTrustedPtyHost: 'one' }), /pruned.*no longer be verified/i);
	});
});

test('zero-entry retention records the cursor and explicit loss after deleting the entire prefix', () => {
	withFixture(({ database, project, session, turn }) => {
		const store = new AgentSessionTranscriptStore(Reflect.get(database, 'db'), () => { }, { maxBytesPerTurn: 1, maxEntriesPerTurn: 0 });
		const receipt = store.appendSanitizedTerminalChunk({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 5, sanitizedTextFromTrustedPtyHost: 'bounded away' });
		assert.equal(receipt.retained, false);
		const page = store.readPage(project.id, session.id, turn.id);
		assert.equal(page.highestSequence, 5);
		assert.equal(page.firstRetainedSequence, null);
		assert.deepEqual(page.entries, []);
		assert.deepEqual(page.gaps, [{ afterSequence: 0, throughSequence: 5 }]);
	});
});

test('structured logs are fully sanitized and filter by severity/source; references reject arbitrary metadata', () => {
	withFixture(({ database, project, session, turn }) => {
		const secret = 'host-known-secret-678';
		database.agentSessionTranscripts.appendStructuredLog({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 1,
			text: `provider error contains ${secret}`, severity: 'error', source: 'provider', trustedKnownSecrets: [secret],
			references: [{ kind: 'turn', id: turn.id }] });
		database.agentSessionTranscripts.appendStructuredLog({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 2,
			text: 'host ready', severity: 'info', source: 'host' });
		const patternSecret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno';
		database.agentSessionTranscripts.appendStructuredLog({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 3,
			text: `Authorization: Bearer ${patternSecret}`, severity: 'warning', source: 'provider' });
		const errors = database.agentSessionTranscripts.readPage(project.id, session.id, turn.id, { severity: 'error', source: 'provider' });
		assert.equal(errors.entries.length, 1);
		assert.equal(errors.entries[0].text.includes(secret), false);
		assert.deepEqual(errors.entries[0].references, [{ kind: 'turn', id: turn.id }]);
		const warnings = database.agentSessionTranscripts.readPage(project.id, session.id, turn.id, { severity: 'warning', source: 'provider' });
		assert.equal(warnings.entries[0].text.includes(patternSecret), false);
		assert.throws(() => database.agentSessionTranscripts.appendStructuredLog({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 4,
			text: 'bad metadata', severity: 'info', source: 'host', references: [{ kind: 'turn', id: turn.id, path: '/private' } as never] }), /reference is invalid/i);
		assert.throws(() => database.agentSessionTranscripts.appendStructuredLog({ projectId: project.id, sessionId: session.id, turnId: turn.id, sequence: 4,
			text: 'bad severity', severity: 'trace' as never, source: 'host' }), /severity is invalid/i);
	});
});
