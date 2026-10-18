/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionChangeEvidenceInput, AgentSessionChangeFileObservation } from './agentSessionChangeEvidenceStore.js';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';

function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-change-evidence-'));
	const root = join(directory, 'project');
	mkdirSync(root);
	const databasePath = join(directory, 'workspace.db');
	const database = WorkspaceDatabase.open(databasePath);
	const project = database.createProject('Change evidence project');
	const binding = database.createFolderBinding({ projectId: project.id, path: root });
	const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Evidence', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder' });
	const canonicalRoot = realpathSync(root);
	const stats = lstatSync(canonicalRoot, { bigint: true });
	const snapshot: AgentSessionTurnSnapshot = {
		schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: null,
		provider: session.provider, model: session.model, profileRef: null, cwd: canonicalRoot,
		folderIdentity: { canonicalPath: canonicalRoot, dev: stats.dev.toString(), ino: stats.ino.toString() },
		managedWorktreeOwnerId: null, permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [],
	};
	const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
	const base: AgentSessionChangeEvidenceInput = {
		projectId: project.id, sessionId: session.id, turnId: turn.id, expectedLatestVersion: 0,
		folderIdentity: snapshot.folderIdentity, capturedAt: '2026-10-19T00:00:00.000Z', beforeRevision: null, afterRevision: null,
		status: 'observed', coverage: 'complete', missingReason: null, attribution: 'unknown', attributionNote: null, files: [],
	};
	return { directory, databasePath, root: canonicalRoot, database, project, session, turn, base };
}

function withFixture(callback: (value: ReturnType<typeof fixture>) => void): void {
	const value = fixture();
	try { callback(value); }
	finally { value.database.close(); rmSync(value.directory, { recursive: true, force: true }); }
}

function fileObservation(name: string, change: 'created' | 'modified' | 'deleted', before: AgentSessionChangeFileObservation['before'], after: AgentSessionChangeFileObservation['after']): AgentSessionChangeFileObservation {
	return { path: name, change, before, after };
}

test('change evidence binds to the exact turn and folder and retains observed file and symlink hashes after reopen', () => {
	const value = fixture();
	try {
		const filePath = join(value.root, 'note.txt');
		writeFileSync(filePath, 'before');
		const before = { kind: 'file' as const, size: 6, sha256: sha(readFileSync(filePath)) };
		writeFileSync(filePath, 'after');
		const after = { kind: 'file' as const, size: 5, sha256: sha(readFileSync(filePath)) };
		const linkPath = join(value.root, 'shortcut');
		symlinkSync('note.txt', linkPath);
		const linkMetadata = { kind: 'symlink' as const, targetSha256: sha(readlinkSync(linkPath)) };
		const deletedPath = join(value.root, 'removed.txt');
		writeFileSync(deletedPath, 'remove me');
		const deletedMetadata = { kind: 'file' as const, size: 9, sha256: sha(readFileSync(deletedPath)) };
		unlinkSync(deletedPath);
		const files: AgentSessionChangeFileObservation[] = [
			fileObservation('note.txt', 'modified', before, after),
			fileObservation('shortcut', 'created', null, linkMetadata),
			fileObservation('removed.txt', 'deleted', deletedMetadata, null),
		];
		const recorded = value.database.agentSessionChangeEvidence.recordSnapshot({ ...value.base, files });
		assert.equal(recorded.version, 1);
		assert.equal(recorded.source, 'ordinaryFolder');
		assert.equal(recorded.managedWorktreeOwnerId, null);
		assert.equal(recorded.noChangesConfirmed, false);
		assert.deepEqual(recorded.files, files);
		writeFileSync(filePath, 'later mutation');
		value.database.close();
		const reopened = WorkspaceDatabase.open(value.databasePath);
		try {
			assert.deepEqual(reopened.agentSessionChangeEvidence.getLatest(value.project.id, value.session.id, value.turn.id), recorded);
			assert.equal(readFileSync(filePath, 'utf8'), 'later mutation');
		} finally { reopened.close(); }
	} finally { rmSync(value.directory, { recursive: true, force: true }); }
});

test('append cursor makes exact retries idempotent, preserves A-B-A observations, and rejects stale delayed writes', () => {
	withFixture(({ database, project, session, turn, base }) => {
		const store = database.agentSessionChangeEvidence;
		const A = { ...base, files: [fileObservation('a.txt', 'created', null, { kind: 'file', size: 1, sha256: 'a'.repeat(64) })] };
		const first = store.recordSnapshot(A);
		assert.deepEqual(store.recordSnapshot(A), first);
		const B = { ...base, expectedLatestVersion: 1, capturedAt: '2026-10-19T00:01:00.000Z', files: [fileObservation('b.txt', 'created', null, { kind: 'file', size: 1, sha256: 'b'.repeat(64) })] };
		const second = store.recordSnapshot(B);
		assert.equal(second.version, 2);
		assert.throws(() => store.recordSnapshot(A), /append cursor is stale/i);
		const third = store.recordSnapshot({ ...A, expectedLatestVersion: 2 });
		assert.equal(third.version, 3);
		assert.equal(third.fingerprint, first.fingerprint);
		assert.equal(store.recordSnapshot({ ...A, expectedLatestVersion: 2 }).id, third.id);
		const changedMetadata = store.recordSnapshot({ ...A, expectedLatestVersion: 3, attribution: 'mixed', attributionNote: 'Contains both tracked and untracked observations.' });
		assert.equal(changedMetadata.version, 4);
		assert.notEqual(changedMetadata.fingerprint, third.fingerprint);
		assert.deepEqual(store.listVersions(project.id, session.id, turn.id, { limit: 2 }), { snapshots: [first, second], nextVersion: 2, hasMore: true });
		assert.deepEqual(store.listVersions(project.id, session.id, turn.id, { afterVersion: 2, limit: 2 }).snapshots, [third, changedMetadata]);
		assert.throws(() => store.listVersions(project.id, session.id, turn.id, { afterVersion: -1 }), /cursor/i);
		assert.throws(() => store.listVersions(project.id, session.id, turn.id, { limit: 101 }), /page size/i);
	});
});

test('file ordering and fingerprint are stable for reversed Unicode path input', () => {
	withFixture(({ database, base }) => {
		const files = [
			fileObservation('é.txt', 'created', null, { kind: 'file', size: 1, sha256: 'a'.repeat(64) }),
			fileObservation('e\u0301.txt', 'created', null, { kind: 'file', size: 1, sha256: 'b'.repeat(64) }),
		];
		const first = database.agentSessionChangeEvidence.recordSnapshot({ ...base, files });
		const retry = database.agentSessionChangeEvidence.recordSnapshot({ ...base, files: [...files].reverse() });
		assert.equal(retry.id, first.id);
		assert.equal(retry.fingerprint, first.fingerprint);
		assert.deepEqual(retry.files, first.files);
	});
});

test('empty partial or unverified observations never confirm no changes; scope and evidence bounds are enforced', () => {
	withFixture(({ database, project, session, turn, base }) => {
		const partial = database.agentSessionChangeEvidence.recordSnapshot({ ...base, status: 'unverified', coverage: 'partial', missingReason: 'Filesystem observation was interrupted.' });
		assert.equal(partial.noChangesConfirmed, false);
		assert.deepEqual(partial.files, []);
		const confirmedEmpty = database.agentSessionChangeEvidence.recordSnapshot({ ...base, expectedLatestVersion: 1 });
		assert.equal(confirmedEmpty.noChangesConfirmed, true);
		assert.throws(() => database.agentSessionChangeEvidence.recordSnapshot({ ...base, expectedLatestVersion: 2, folderIdentity: { ...base.folderIdentity, ino: '999999' } }), /exactly match/i);
		const other = database.agentSessions.createSession({ projectId: project.id, bindingId: turn.snapshot.bindingId, name: 'Other', provider: 'claude', model: 'sonnet', workspaceMode: 'sharedFolder' });
		assert.throws(() => database.agentSessionChangeEvidence.getLatest(project.id, other.id, turn.id), /does not belong/i);
		assert.throws(() => database.agentSessionChangeEvidence.recordSnapshot({ ...base, expectedLatestVersion: 2, extra: true } as never), /unsupported or missing fields/i);
		assert.throws(() => database.agentSessionChangeEvidence.recordSnapshot({ ...base, expectedLatestVersion: 2, files: [fileObservation('../escape', 'created', null, { kind: 'file', size: 1, sha256: 'a'.repeat(64) })] }), /root-relative/i);
		assert.throws(() => database.agentSessionChangeEvidence.recordSnapshot({ ...base, expectedLatestVersion: 2, files: Array.from({ length: 301 }, (_, index) => fileObservation(`f${index}`, 'created', null, { kind: 'file', size: 1, sha256: 'a'.repeat(64) })) }), /at most 300/i);
		const oversized = Array.from({ length: 180 }, (_, index) => fileObservation(`${String(index).padStart(3, '0')}-${'x'.repeat(400)}`, 'created', null, { kind: 'file', size: 1, sha256: 'a'.repeat(64) }));
		assert.throws(() => database.agentSessionChangeEvidence.recordSnapshot({ ...base, expectedLatestVersion: 2, files: oversized }), /exceeds 64 KiB/i);
	});
});
