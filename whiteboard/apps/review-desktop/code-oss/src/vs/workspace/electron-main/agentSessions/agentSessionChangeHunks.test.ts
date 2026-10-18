/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AGENT_SESSION_CHANGE_HUNKS_MAX_FILE_BYTES, AGENT_SESSION_CHANGE_HUNKS_MAX_LINES_PER_SIDE, computeAgentSessionChangeHunks } from './agentSessionChangeHunks.js';
import type { AgentSessionContentFileDTO } from './agentSessionContentStore.js';

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
