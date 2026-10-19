/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';

test('SQLite retains v1 snapshots unchanged and exposes v2 binary bytes only through exact host-only raw lookup', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-agent-session-content-'));
	const folder = join(directory, 'workspace');
	mkdirSync(folder);
	const databasePath = join(directory, 'workspace.db');
	let database = WorkspaceDatabase.open(databasePath);
	try {
		const project = database.createProject('Content evidence');
		const binding = database.createFolderBinding({ projectId: project.id, path: folder });
		const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Content session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder' });
		const canonicalFolder = realpathSync(folder);
		const identity = statSync(canonicalFolder, { bigint: true });
		const folderIdentity = { canonicalPath: canonicalFolder, dev: identity.dev.toString(), ino: identity.ino.toString() };
		const snapshot: AgentSessionTurnSnapshot = {
			schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: null,
			provider: session.provider, model: session.model, profileRef: null, cwd: canonicalFolder, folderIdentity,
			managedWorktreeOwnerId: null, permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [],
		};
		const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
		const scope = { projectId: project.id, sessionId: session.id, turnId: turn.id };
		const legacyText = 'legacy';
		const legacyHash = createHash('sha256').update(legacyText, 'utf8').digest('hex');
		const before = {
			schemaVersion: 1 as const, folderIdentity, capturedAt: '2026-10-19T00:00:00.000Z', inventoryCoverage: 'complete' as const, contentCoverage: 'complete' as const,
			entryCount: 1, fileBytes: Buffer.byteLength(legacyText), retainedTextBytes: Buffer.byteLength(legacyText), contentReadCount: 1,
			entries: [{ path: 'legacy.txt', kind: 'file' as const, size: Buffer.byteLength(legacyText), sha256: legacyHash, content: legacyText }],
		};
		const beforeJson = JSON.stringify(before);
		database.agentSessionContents.recordBaseline({ scope, snapshot: before, revision: null });
		const currentSession = database.agentSessions.getSession(project.id, session.id)!;
		const running = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, currentSession.revision, { state: 'running' });
		const raw = Buffer.from([0x00, 0x7f, 0xff]);
		const rawHash = createHash('sha256').update(raw).digest('hex');
		const oversizedSize = 1024 * 1024 + 1;
		const oversizedHash = createHash('sha256').update(Buffer.alloc(oversizedSize, 0x61)).digest('hex');
		const after = {
			schemaVersion: 2 as const, folderIdentity, capturedAt: '2026-10-19T00:01:00.000Z', inventoryCoverage: 'complete' as const, contentCoverage: 'partial' as const,
			entryCount: 3, fileBytes: Buffer.byteLength(legacyText) + raw.byteLength + oversizedSize, retainedTextBytes: Buffer.byteLength(legacyText), retainedBinaryBytes: raw.byteLength, contentReadCount: 2,
			entries: [
				{ path: 'legacy.txt', kind: 'file' as const, size: Buffer.byteLength(legacyText), sha256: legacyHash, executable: false, content: legacyText },
				{ path: 'tool.bin', kind: 'file' as const, size: raw.byteLength, sha256: rawHash, executable: true, contentUnavailableReason: 'binary' as const, rawBytesBase64: raw.toString('base64') },
				{ path: 'oversized.bin', kind: 'file' as const, size: oversizedSize, sha256: oversizedHash, executable: false, contentUnavailableReason: 'fileTooLarge' as const },
			],
		};
		const final = database.agentSessionContents.recordAfter({ scope, snapshot: after, expectedLatestVersion: 0, revision: null, cleanupVerified: true });
		assert.equal(final.contentCoverage, 'partial');
		database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, running.turn.revision, running.session.revision, { state: 'exited', exitCode: 0, cleanupVerified: true });
		const evidence = database.agentSessionChangeEvidence.getLatest(project.id, session.id, turn.id)!;
		assert.equal(evidence.coverage, 'complete');
		assert.equal(evidence.files.find(file => file.path === 'tool.bin')?.after?.executable, true);
		const publicFile = database.agentSessionContents.getFile({ scope, evidenceVersion: evidence.version, path: 'tool.bin' })!;
		assert.equal(publicFile.after.state, 'unavailable');
		assert.equal('rawBytesBase64' in (publicFile.after.state === 'unavailable' ? publicFile.after.file ?? {} : {}), false);
		database.close();
		database = WorkspaceDatabase.open(databasePath);
		const reopened = database.agentSessionContents.getRawEntry({ scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'tool.bin' })!;
		assert.equal(reopened.before.state, 'absent');
		assert.equal(reopened.after.state, 'retained');
		if (reopened.after.state !== 'retained') { throw new Error('Binary bytes were not retained after reopening SQLite.'); }
		assert.equal(reopened.after.mode, '100755');
		assert.deepEqual(Buffer.from(reopened.after.bytes), raw);
		reopened.after.bytes[0] = 1;
		const secondRead = database.agentSessionContents.getRawEntry({ scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'tool.bin' })!;
		assert.equal(secondRead.after.state === 'retained' ? secondRead.after.bytes[0] : -1, raw[0]);
		assert.throws(() => database.agentSessionContents.getRawEntry({ scope, evidenceVersion: evidence.version, evidenceFingerprint: '0'.repeat(64), path: 'tool.bin' }), /fingerprint/u);
		const legacy = database.agentSessionContents.getRawEntry({ scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'legacy.txt' })!;
		assert.equal(legacy.before.state, 'unavailable');
		assert.equal(legacy.after.state, 'retained');
		const notRetained = database.agentSessionContents.getRawEntry({ scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'oversized.bin' })!;
		assert.equal(notRetained.after.state, 'unavailable');
		assert.equal(JSON.stringify(before), beforeJson);
		assert.equal(database.agentSessionContents.getBaseline(scope)?.fingerprint, createHash('sha256').update(beforeJson, 'utf8').digest('hex'));
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
