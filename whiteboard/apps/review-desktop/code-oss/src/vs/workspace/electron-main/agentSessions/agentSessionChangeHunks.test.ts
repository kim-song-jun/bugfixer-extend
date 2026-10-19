/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { AGENT_SESSION_CHANGE_HUNKS_MAX_FILE_BYTES, AGENT_SESSION_CHANGE_HUNKS_MAX_LINES_PER_SIDE, computeAgentSessionChangeHunks } from './agentSessionChangeHunks.js';
import type { AgentSessionContentFileDTO } from './agentSessionContentStore.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';

const scope = {
	projectId: '3ac07298-b44f-4fe2-8f17-717ca5bc1843',
	sessionId: '07c9042f-26fd-4275-82be-2a62ce39c0d0',
	turnId: '424bc8b0-41c0-4bdf-9518-975bb9552620',
};

function file(path: string, content: string) {
	const bytes = Buffer.from(content, 'utf8');
	return { path, kind: 'file' as const, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), content };
}

function input(before: AgentSessionContentFileDTO['before'], after: AgentSessionContentFileDTO['after'], path = 'src/example.ts'): AgentSessionContentFileDTO {
	return { scope, evidenceVersion: 2, path, evidenceFingerprint: 'a'.repeat(64), before, after };
}

function textState(path: string, content: string): AgentSessionContentFileDTO['before'] { return { state: 'text', file: file(path, content) }; }

test('retained text changes produce stable identities and Code OSS one-based exclusive line ranges', () => {
	const candidate = input(textState('src/example.ts', 'before\nstay\nafter'), textState('src/example.ts', 'before\ninserted\nstay\nafter'));
	const first = computeAgentSessionChangeHunks(candidate);
	const second = computeAgentSessionChangeHunks(candidate);
	assert.equal(first.status, 'hunks');
	assert.equal(first.hunks.length, 1);
	assert.deepEqual(first.hunks[0], second.hunks[0]);
	assert.match(first.hunks[0].id, /^[a-f0-9]{64}$/u);
	assert.deepEqual({
		originalStart: first.hunks[0].originalStartLineNumber,
		originalEndExclusive: first.hunks[0].originalEndLineNumberExclusive,
		modifiedStart: first.hunks[0].modifiedStartLineNumber,
		modifiedEndExclusive: first.hunks[0].modifiedEndLineNumberExclusive,
	}, { originalStart: 2, originalEndExclusive: 2, modifiedStart: 2, modifiedEndExclusive: 3 });
	assert.equal(Object.isFrozen(first), true);
	assert.equal(Object.isFrozen(first.hunks), true);
	assert.equal(Object.isFrozen(first.hunks[0].ranges[0].original), true);
});

test('separate changes remain separate and are deterministically scoped to exact evidence', () => {
	const candidate = input(textState('src/example.ts', 'one\nstay\nthree\nstay\nfive'), textState('src/example.ts', 'ONE\nstay\nTHREE\nstay\nFIVE'));
	const result = computeAgentSessionChangeHunks(candidate);
	assert.equal(result.hunks.length, 3);
	assert.equal(new Set(result.hunks.map(hunk => hunk.id)).size, 3);
	const otherEvidence = computeAgentSessionChangeHunks({ ...candidate, evidenceVersion: 3 });
	assert.notEqual(result.hunks[0].id, otherEvidence.hunks[0].id);
});

test('nonempty created and deleted files diff against empty text while empty-file presence is explicit', () => {
	const created = computeAgentSessionChangeHunks(input({ state: 'absent' }, textState('src/example.ts', 'new line')));
	assert.equal(created.status, 'presenceChanged');
	assert.equal(created.hunks.length, 1);
	assert.equal(created.before.state, 'absent');
	const deleted = computeAgentSessionChangeHunks(input(textState('src/example.ts', 'old line'), { state: 'absent' }));
	assert.equal(deleted.status, 'presenceChanged');
	assert.equal(deleted.hunks.length, 1);
	const emptyCreated = computeAgentSessionChangeHunks(input({ state: 'absent' }, textState('src/example.ts', '')));
	assert.equal(emptyCreated.status, 'presenceChanged');
	assert.equal(emptyCreated.hunks.length, 0);
});

test('line-ending-only edits remain distinguishable without fabricated hunks', () => {
	const eol = computeAgentSessionChangeHunks(input(textState('src/example.ts', 'one\r\ntwo\r\n'), textState('src/example.ts', 'one\ntwo\n')));
	assert.equal(eol.status, 'eolOnly');
	assert.equal(eol.hunks.length, 0);
	const unchanged = computeAgentSessionChangeHunks(input(textState('src/example.ts', 'same\n'), textState('src/example.ts', 'same\n')));
	assert.equal(unchanged.status, 'noTextChange');
});

test('identical and EOL-only maximum-line inputs short-circuit under the minimum computation budget', () => {
	const lines = Array.from({ length: AGENT_SESSION_CHANGE_HUNKS_MAX_LINES_PER_SIDE }, (_, index) => `line-${index}`);
	const lf = lines.join('\n');
	const crlf = lines.join('\r\n');
	const exact = computeAgentSessionChangeHunks(input(textState('src/example.ts', lf), textState('src/example.ts', lf)), { computationBudgetMs: 1 });
	assert.equal(exact.status, 'noTextChange');
	assert.equal(exact.timedOut, false);
	const eolOnly = computeAgentSessionChangeHunks(input(textState('src/example.ts', crlf), textState('src/example.ts', lf)), { computationBudgetMs: 1 });
	assert.equal(eolOnly.status, 'eolOnly');
	assert.equal(eolOnly.timedOut, false);
});

test('a diff exceeding its clock budget exposes no unstable hunk identities', context => {
	const candidate = input(textState('src/example.ts', 'before\nstay\nafter'), textState('src/example.ts', 'before\ninserted\nstay\nafter'));
	let clock = 0;
	context.mock.method(Date, 'now', () => clock += 1000);
	const result = computeAgentSessionChangeHunks(candidate, { computationBudgetMs: 1 });
	assert.equal(result.status, 'partial');
	assert.equal(result.timedOut, true);
	assert.equal(result.unavailableReason, 'computationTimeout');
	assert.deepEqual(result.hunks, []);
});

test('unavailable inputs are explicit and malformed scope, hashes, sizes, and line counts cannot yield hunks', () => {
	const unavailable = computeAgentSessionChangeHunks(input({ state: 'unavailable', reason: 'No durable before snapshot was retained.' }, textState('src/example.ts', 'text')));
	assert.equal(unavailable.status, 'unavailable');
	assert.equal(unavailable.before.state, 'unavailable');
	assert.equal(unavailable.before.reason, 'missing');
	const mismatched = input(textState('src/example.ts', 'old'), textState('src/example.ts', 'new'));
	const badAfter = mismatched.after as Extract<AgentSessionContentFileDTO['after'], { state: 'text' }>;
	const corrupt: AgentSessionContentFileDTO = { ...mismatched, after: { ...badAfter, file: { ...badAfter.file, sha256: 'b'.repeat(64) } } };
	assert.equal(computeAgentSessionChangeHunks(corrupt).status, 'unavailable');
	assert.equal(computeAgentSessionChangeHunks(corrupt).after.state, 'unavailable');
	assert.throws(() => computeAgentSessionChangeHunks({ ...mismatched, scope: { ...scope, projectId: '' } }), /unscoped/u);
	assert.throws(() => computeAgentSessionChangeHunks({ ...mismatched, extra: true } as AgentSessionContentFileDTO), /unscoped/u);
	const overByteLimit = computeAgentSessionChangeHunks(input(textState('src/example.ts', 'x'.repeat(AGENT_SESSION_CHANGE_HUNKS_MAX_FILE_BYTES + 1)), textState('src/example.ts', 'short')));
	assert.equal(overByteLimit.status, 'unavailable');
	assert.equal(overByteLimit.before.state, 'unavailable');
	const manyLines = `x\n`.repeat(20_000);
	const lineCapped = computeAgentSessionChangeHunks(input(textState('src/example.ts', manyLines), textState('src/example.ts', 'short')));
	assert.equal(lineCapped.status, 'unavailable');
	assert.equal(lineCapped.unavailableReason, 'lineLimit');
	assert.throws(() => computeAgentSessionChangeHunks(mismatched, { computationBudgetMs: 101 }), /budget/u);
});

test('SQLite content-store DTOs retain optional executable metadata without changing text hunk semantics', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-agent-session-hunks-'));
	const folder = join(directory, 'workspace');
	mkdirSync(folder);
	let database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const project = database.createProject('Hunk evidence');
		const binding = database.createFolderBinding({ projectId: project.id, path: folder });
		const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Hunk session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder' });
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
		const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
		const beforeText = 'before\n';
		const afterText = 'after\n';
		const stableText = 'stable\n';
		const raw = Buffer.from([0x00, 0x7f, 0xff]);
		const before = {
			schemaVersion: 2 as const, folderIdentity, capturedAt: '2026-10-19T00:00:00.000Z', inventoryCoverage: 'complete' as const, contentCoverage: 'complete' as const,
			entryCount: 2, fileBytes: Buffer.byteLength(beforeText) + Buffer.byteLength(stableText), retainedTextBytes: Buffer.byteLength(beforeText) + Buffer.byteLength(stableText), retainedBinaryBytes: 0, contentReadCount: 2,
			entries: [
				{ path: 'script.sh', kind: 'file' as const, size: Buffer.byteLength(beforeText), sha256: digest(beforeText), executable: false, content: beforeText },
				{ path: 'stable.txt', kind: 'file' as const, size: Buffer.byteLength(stableText), sha256: digest(stableText), executable: false, content: stableText },
			],
		};
		database.agentSessionContents.recordBaseline({ scope, snapshot: before, revision: null });
		const currentSession = database.agentSessions.getSession(project.id, session.id)!;
		const running = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, currentSession.revision, { state: 'running' });
		const after = {
			schemaVersion: 2 as const, folderIdentity, capturedAt: '2026-10-19T00:01:00.000Z', inventoryCoverage: 'complete' as const, contentCoverage: 'partial' as const,
			entryCount: 3, fileBytes: Buffer.byteLength(afterText) + Buffer.byteLength(stableText) + raw.byteLength,
			retainedTextBytes: Buffer.byteLength(afterText) + Buffer.byteLength(stableText), retainedBinaryBytes: raw.byteLength, contentReadCount: 3,
			entries: [
				{ path: 'script.sh', kind: 'file' as const, size: Buffer.byteLength(afterText), sha256: digest(afterText), executable: true, content: afterText },
				{ path: 'stable.txt', kind: 'file' as const, size: Buffer.byteLength(stableText), sha256: digest(stableText), executable: false, content: stableText },
				{ path: 'tool.bin', kind: 'file' as const, size: raw.byteLength, sha256: digest(raw), executable: true, contentUnavailableReason: 'binary' as const, rawBytesBase64: raw.toString('base64') },
			],
		};
		database.agentSessionContents.recordAfter({ scope, snapshot: after, expectedLatestVersion: 0, revision: null, cleanupVerified: true });
		database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, running.turn.revision, running.session.revision, { state: 'exited', exitCode: 0, cleanupVerified: true });
		const evidence = database.agentSessionChangeEvidence.getLatest(project.id, session.id, turn.id)!;
		const changed = database.agentSessionContents.getFile({ scope, evidenceVersion: evidence.version, path: 'script.sh' })!;
		assert.equal(changed.before.state, 'text');
		assert.equal(changed.before.state === 'text' ? changed.before.file.executable : null, false);
		assert.equal(changed.after.state, 'text');
		assert.equal(changed.after.state === 'text' ? changed.after.file.executable : null, true);
		assert.equal(computeAgentSessionChangeHunks(changed).status, 'hunks');
		const unchanged = database.agentSessionContents.getFile({ scope, evidenceVersion: evidence.version, path: 'stable.txt' })!;
		assert.equal(unchanged.before.state === 'text' ? unchanged.before.file.executable : null, false);
		assert.equal(unchanged.after.state === 'text' ? unchanged.after.file.executable : null, false);
		assert.equal(computeAgentSessionChangeHunks(unchanged).status, 'noTextChange');
		const binary = database.agentSessionContents.getFile({ scope, evidenceVersion: evidence.version, path: 'tool.bin' })!;
		assert.equal(binary.after.state, 'unavailable');
		assert.equal(binary.after.state === 'unavailable' ? binary.after.file?.executable : null, true);
		assert.equal(computeAgentSessionChangeHunks(binary).unavailableReason, 'binary');
		const invalidUnavailableExecutable = { ...binary, after: { ...binary.after, file: { ...(binary.after.state === 'unavailable' ? binary.after.file : {}), executable: 'true' } } } as AgentSessionContentFileDTO;
		assert.equal(computeAgentSessionChangeHunks(invalidUnavailableExecutable).unavailableReason, 'invalidHash');
		const unknownUnavailableFileKey = { ...binary, after: { ...binary.after, file: { ...(binary.after.state === 'unavailable' ? binary.after.file : {}), unexpected: true } } } as AgentSessionContentFileDTO;
		assert.equal(computeAgentSessionChangeHunks(unknownUnavailableFileKey).unavailableReason, 'invalidHash');
		const invalidExecutable = { ...changed, after: { ...changed.after, file: { ...(changed.after.state === 'text' ? changed.after.file : {}), executable: 'true' } } } as AgentSessionContentFileDTO;
		assert.throws(() => computeAgentSessionChangeHunks(invalidExecutable), /malformed retained text metadata/u);
		const unknownFileKey = { ...changed, after: { ...changed.after, file: { ...(changed.after.state === 'text' ? changed.after.file : {}), unexpected: true } } } as AgentSessionContentFileDTO;
		assert.throws(() => computeAgentSessionChangeHunks(unknownFileKey), /malformed retained text metadata/u);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
