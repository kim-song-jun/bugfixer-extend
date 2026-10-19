/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AGENT_PR_TEXT_MAX_BODY_BYTES, type AgentPrTextScope, type CreateAgentPrTextRequestInput } from '../../common/workspaceAgentPrTextProtocol.js';
import { AGENT_SESSION_PR_TEXT_MIGRATION_SQL, AgentSessionPrTextStore } from './agentSessionPrTextStore.js';

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'agent-pr-text-'));
	const path = join(directory, 'workspace.db');
	let db = new DatabaseSync(path);
		db.exec(`PRAGMA foreign_keys = ON;
		CREATE TABLE agent_sessions (id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, profile_ref TEXT,
			PRIMARY KEY (id), UNIQUE (id, project_id));
		CREATE TABLE agent_session_turns (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, profile_ref TEXT,
			UNIQUE (id, project_id, session_id), FOREIGN KEY (session_id, project_id) REFERENCES agent_sessions(id, project_id));
		${AGENT_SESSION_PR_TEXT_MIGRATION_SQL}`);
	const scope: AgentPrTextScope = { projectId: randomUUID(), sessionId: randomUUID(), targetTurnId: randomUUID() };
	db.prepare('INSERT INTO agent_sessions (id, project_id, task_id, provider, model, profile_ref) VALUES (?, ?, ?, ?, ?, ?)')
		.run(scope.sessionId, scope.projectId, null, 'codex', 'gpt-test', 'profile-a');
	db.prepare('INSERT INTO agent_session_turns (id, project_id, session_id, ordinal, provider, model, profile_ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.run(scope.targetTurnId, scope.projectId, scope.sessionId, 1, 'codex', 'gpt-test', 'profile-a');
	return {
		directory,
		path,
		scope,
		get db() { return db; },
		store() { return new AgentSessionPrTextStore(db); },
		reopen() { db.close(); db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys = ON;'); return new AgentSessionPrTextStore(db); },
		close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
	};
}

function requestInput(scope: AgentPrTextScope, overrides: Partial<CreateAgentPrTextRequestInput> = {}): CreateAgentPrTextRequestInput {
	const contextJSON = JSON.stringify({ changedPaths: ['src/example.ts'], checks: ['unit'] });
	return {
		scope, idempotencyKey: 'draft-1', baseRevision: 0, provider: 'codex', model: 'gpt-test', profileRef: 'profile-a',
		contextDigest: digest(contextJSON), contextJSON, instruction: 'Write a concise PR draft.', ...overrides,
	};
}

function providerSource(requestId: string, attemptId: string) {
	return { kind: 'providerAttempt' as const, requestId, attemptId, provider: 'codex' as const, model: 'gpt-test', profileRef: 'profile-a',
		receiptHash: digest(JSON.stringify({ requestId, attemptId, result: 'runner receipt' })), cleanupVerified: true as const };
}

function candidate(store: AgentSessionPrTextStore, requestId: string, attemptId: string, overrides: { expectedRunningRevision?: number; title?: string; body?: string; knownSecrets?: readonly string[] } = {}) {
	return store.completeRequest({ requestId, expectedRunningRevision: overrides.expectedRunningRevision ?? 1, source: providerSource(requestId, attemptId),
		sanitizedCompleteAgentText: { title: overrides.title ?? 'Draft title', body: overrides.body ?? 'Draft body' }, knownSecrets: overrides.knownSecrets ?? ['hidden-secret'] });
}

test('PR text request is idempotent, writes a sanitized AI-first revision, and survives SQLite reopen', () => {
	const value = fixture();
	try {
		const store = value.store(); const input = requestInput(value.scope);
		const created = store.createRequest(input);
		assert.deepEqual(store.createRequest(input), created);
		assert.throws(() => store.createRequest({ ...input, instruction: 'Different request.' }), /Idempotency key/u);
		assert.throws(() => store.appendHumanRevision({ scope: value.scope, expectedRevision: 0, idempotencyKey: 'human-first', content: { title: 'Human first', body: '' } }), /first PR text revision/u);
		const attemptId = randomUUID();
		const running = store.startRequest({ requestId: created.id, expectedStateRevision: 0, attemptId });
		assert.equal(running.state, 'running');
		assert.deepEqual(store.startRequest({ requestId: created.id, expectedStateRevision: 0, attemptId }), running);
		assert.throws(() => store.startRequest({ requestId: created.id, expectedStateRevision: 0, attemptId: randomUUID() }), /different host attempt ID/u);
		const done = candidate(store, created.id, attemptId, { body: 'Draft with hidden-secret.' });
		assert.equal(done.state, 'succeeded');
		assert.equal(done.candidate?.content.body, 'Draft with ***.');
		assert.deepEqual(candidate(store, created.id, attemptId, { body: 'Draft with hidden-secret.' }), done);
		assert.equal(store.getHead(value.scope)?.author, 'providerAttempt');
		const reopened = value.reopen();
		assert.deepEqual(reopened.getRequest(value.scope, created.id), done);
		assert.equal(reopened.getRequest({ ...value.scope, sessionId: randomUUID() }, created.id), undefined);
		assert.deepEqual(reopened.listRevisions(value.scope, { afterRevision: 0, limit: 5 }).revisions.map(item => item.content.body), ['Draft with ***.']);
		const humanInput = { scope: value.scope, expectedRevision: 1, idempotencyKey: 'human-edit-1', content: { title: 'Edited title', body: 'Human body' } };
		const human = reopened.appendHumanRevision(humanInput);
		assert.deepEqual(reopened.appendHumanRevision(humanInput), human);
		assert.throws(() => reopened.appendHumanRevision({ ...humanInput, content: { title: 'Changed retry', body: 'Human body' } }), /idempotency key/u);
		assert.equal(human.author, 'human');
		assert.equal(reopened.getHead(value.scope)?.revision, 2);
	} finally { value.close(); }
});

test('scope, provider receipt, byte limits, and revision CAS reject forged or stale PR text writes', () => {
	const value = fixture();
	try {
		const store = value.store(); const created = store.createRequest(requestInput(value.scope));
		assert.throws(() => store.createRequest(requestInput(value.scope, { idempotencyKey: 'long-instruction', instruction: 'x'.repeat(8193) })), /byte limit/u);
		assert.throws(() => store.appendGeneratedRevision({ scope: { ...value.scope, targetTurnId: randomUUID() }, expectedRevision: 0, idempotencyKey: 'bad-source',
			source: { kind: 'liveAgentTurn', turnId: value.scope.targetTurnId }, sanitizedCompleteAgentText: { title: 'x', body: '' }, knownSecrets: [] }), /scope|source/u);
		assert.throws(() => store.appendHumanRevision({ scope: value.scope, expectedRevision: 0, idempotencyKey: 'long-title', content: { title: 'x'.repeat(257), body: '' } }), /byte limit/u);
		assert.throws(() => store.appendHumanRevision({ scope: value.scope, expectedRevision: 0, idempotencyKey: 'long-body', content: { title: 'x', body: 'x'.repeat(AGENT_PR_TEXT_MAX_BODY_BYTES + 1) } }), /byte limit/u);
		assert.throws(() => store.appendHumanRevision({ scope: value.scope, expectedRevision: 0, idempotencyKey: 'human-first', content: { title: 'x', body: '' } }), /first PR text revision/u);
		const attemptId = randomUUID();
		store.startRequest({ requestId: created.id, expectedStateRevision: 0, attemptId });
		assert.throws(() => candidate(store, created.id, randomUUID()), /Provider attempt source does not match/u);
		const success = candidate(store, created.id, attemptId);
		assert.equal(success.state, 'succeeded');
		assert.throws(() => store.appendHumanRevision({ scope: value.scope, expectedRevision: 0, idempotencyKey: 'stale-human', content: { title: 'Stale', body: '' } }), /stale/u);
	} finally { value.close(); }
});

test('shared PR body byte ceiling accepts 32 KiB and rejects the next byte in both DTO writes and SQL', () => {
	const value = fixture();
	try {
		assert.match(AGENT_SESSION_PR_TEXT_MIGRATION_SQL, /length\(CAST\(body AS BLOB\)\) <= 32768/u);
		assert.equal(AGENT_PR_TEXT_MAX_BODY_BYTES, 32_768);
		const store = value.store();
		const saved = store.appendGeneratedRevision({ scope: value.scope, expectedRevision: 0, idempotencyKey: 'body-limit', source: { kind: 'liveAgentTurn', turnId: value.scope.targetTurnId },
			sanitizedCompleteAgentText: { title: 'At the contract limit', body: 'x'.repeat(AGENT_PR_TEXT_MAX_BODY_BYTES) }, knownSecrets: [] });
		assert.equal(Buffer.byteLength(saved.content.body, 'utf8'), AGENT_PR_TEXT_MAX_BODY_BYTES);
		assert.throws(() => store.appendGeneratedRevision({ scope: value.scope, expectedRevision: 1, idempotencyKey: 'body-limit-plus-one', source: { kind: 'liveAgentTurn', turnId: value.scope.targetTurnId },
			sanitizedCompleteAgentText: { title: 'Over the contract limit', body: 'x'.repeat(AGENT_PR_TEXT_MAX_BODY_BYTES + 1) }, knownSecrets: [] }), /byte limit/u);
	} finally { value.close(); }
});

test('request context is persisted host-only after secret sanitization while the renderer DTO stays bounded', () => {
	const value = fixture();
	try {
		const store = value.store();
		const contextJSON = JSON.stringify({ paths: ['src/file.ts'], note: 'visible-secret' });
		const input = requestInput(value.scope, { contextJSON, contextDigest: digest(contextJSON), instruction: 'Explain visible-secret.' });
		const request = store.createRequest(input, ['visible-secret']);
		assert.equal(request.instruction, 'Explain ***.');
		assert.equal('contextJSON' in request, false);
		const context = store.getRequestContext(value.scope, request.id)!;
		assert.match(context.contextJSON, /\*\*\*/u);
		assert.equal(context.contextDigest, digest(context.contextJSON));
		assert.equal(context.instruction, request.instruction);
	} finally { value.close(); }
});

test('host redaction removes credential-shaped values before hashing and persists matching content on reopen', () => {
	const value = fixture();
	try {
		const store = value.store();
		const contextJSON = JSON.stringify({ note: 'password=fixture-secret', explicit: 'visible-secret' });
		const input = requestInput(value.scope, { contextJSON, contextDigest: digest(contextJSON), instruction: 'token=fixture-secret visible-secret' });
		const request = store.createRequest(input, ['visible-secret']);
		const sanitized = store.sanitizeContextJSON(contextJSON, ['visible-secret']);
		const context = store.getRequestContext(value.scope, request.id)!;
		assert.deepEqual({ contextJSON: context.contextJSON, contextDigest: context.contextDigest }, sanitized);
		assert.doesNotMatch(context.contextJSON, /fixture-secret|visible-secret/u);
		assert.doesNotMatch(request.instruction, /fixture-secret|visible-secret/u);
		const attemptId = randomUUID(); store.startRequest({ requestId: request.id, expectedStateRevision: 0, attemptId });
		const result = candidate(store, request.id, attemptId, { title: 'password=fixture-secret', body: 'token=fixture-secret visible-secret', knownSecrets: ['visible-secret'] });
		assert.equal(result.candidate?.content.title, 'password=***');
		assert.equal(result.candidate?.content.body, 'token=*** ***');
		const raw = value.db.prepare("SELECT event_json FROM agent_session_pr_text_request_events WHERE request_id = ? AND event_type = 'candidate'").get(request.id) as { event_json: string };
		assert.doesNotMatch(raw.event_json, /fixture-secret|visible-secret/u);
		const persisted = value.db.prepare('SELECT title, body, content_hash FROM agent_session_pr_text_revisions WHERE target_turn_id = ?').get(value.scope.targetTurnId) as { title: string; body: string; content_hash: string };
		assert.doesNotMatch(`${persisted.title} ${persisted.body}`, /fixture-secret|visible-secret/u);
		assert.equal(persisted.content_hash, digest(JSON.stringify([persisted.title, persisted.body])));
		const reopened = value.reopen();
		assert.deepEqual(reopened.getRequest(value.scope, request.id), result);
		assert.equal(reopened.getHead(value.scope)?.content.contentHash, result.candidate?.content.contentHash);
	} finally { value.close(); }
});

test('request completion rejects live-turn source even when it matches provider and model', () => {
	const value = fixture();
	try {
		const store = value.store(); const request = store.createRequest(requestInput(value.scope)); const attemptId = randomUUID();
		store.startRequest({ requestId: request.id, expectedStateRevision: 0, attemptId });
		const forgedCompletion = { requestId: request.id, expectedRunningRevision: 1, source: { kind: 'liveAgentTurn' as const, turnId: value.scope.targetTurnId },
			sanitizedCompleteAgentText: { title: 'Looks valid', body: 'But has no runner receipt.' }, knownSecrets: [] };
		assert.throws(() => store.completeRequest(forgedCompletion as never), /Only a trusted provider-attempt receipt/u);
		assert.equal(store.getRequest(value.scope, request.id)?.state, 'running');
	} finally { value.close(); }
});

test('live agent revisions use host-derived authorship and exact retry keys', () => {
	const value = fixture();
	try {
		const store = value.store();
		const input = { scope: value.scope, expectedRevision: 0, idempotencyKey: 'live-turn-1', source: { kind: 'liveAgentTurn' as const, turnId: value.scope.targetTurnId },
			sanitizedCompleteAgentText: { title: 'Generated title', body: 'Generated body' }, knownSecrets: [] };
		const first = store.appendGeneratedRevision(input);
		assert.equal(first.author, 'liveAgentTurn');
		assert.deepEqual(store.appendGeneratedRevision(input), first);
		assert.throws(() => store.appendGeneratedRevision({ ...input, sanitizedCompleteAgentText: { title: 'Different title', body: 'Generated body' } }), /idempotency key/u);
		assert.throws(() => store.appendGeneratedRevision({ ...input, expectedRevision: 1 }), /idempotency key/u);
		const laterTurnId = randomUUID();
		value.db.prepare('INSERT INTO agent_session_turns (id, project_id, session_id, ordinal, provider, model, profile_ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.run(laterTurnId, value.scope.projectId, value.scope.sessionId, 2, 'claude', 'other-model', null);
		const laterSourceInput = { ...input, expectedRevision: 1, idempotencyKey: 'later-agent-turn', source: { kind: 'liveAgentTurn' as const, turnId: laterTurnId }, sanitizedCompleteAgentText: { title: 'Later title', body: 'From a later turn.' } };
		assert.equal(store.appendGeneratedRevision(laterSourceInput).author, 'liveAgentTurn');
	} finally { value.close(); }
});

test('generated save idempotency fingerprints provider attempt source metadata', () => {
	const value = fixture();
	try {
		const store = value.store(); const request = store.createRequest(requestInput(value.scope)); const attemptId = randomUUID();
		store.startRequest({ requestId: request.id, expectedStateRevision: 0, attemptId });
		const source = providerSource(request.id, attemptId);
		const input = { scope: value.scope, expectedRevision: 0, idempotencyKey: 'provider-save', source, sanitizedCompleteAgentText: { title: 'Provider title', body: 'Provider body' }, knownSecrets: [] };
		const revision = store.appendGeneratedRevision(input);
		assert.equal(revision.author, 'providerAttempt');
		assert.deepEqual(store.appendGeneratedRevision(input), revision);
		assert.throws(() => store.appendGeneratedRevision({ ...input, source: { ...source, receiptHash: digest('different receipt') } }), /idempotency key/u);
		assert.throws(() => store.appendGeneratedRevision({ ...input, expectedRevision: 1 }), /idempotency key/u);
	} finally { value.close(); }
});

test('a request whose base moves records conflict candidate without replacing the current head', () => {
	const value = fixture();
	try {
		const store = value.store();
		const seed = store.createRequest(requestInput(value.scope)); const seedAttempt = randomUUID(); store.startRequest({ requestId: seed.id, expectedStateRevision: 0, attemptId: seedAttempt });
		candidate(store, seed.id, seedAttempt);
		const next = store.createRequest(requestInput(value.scope, { idempotencyKey: 'draft-2', baseRevision: 1 }));
		const nextAttempt = randomUUID(); store.startRequest({ requestId: next.id, expectedStateRevision: 0, attemptId: nextAttempt });
		store.appendHumanRevision({ scope: value.scope, expectedRevision: 1, idempotencyKey: 'new-head', content: { title: 'New head', body: 'Keep me' } });
		const conflicted = candidate(store, next.id, nextAttempt, { title: 'Old candidate' });
		assert.equal(conflicted.state, 'conflicted');
		assert.equal(conflicted.candidate?.content.title, 'Old candidate');
		assert.equal(store.getHead(value.scope)?.content.title, 'New head');
		const applied = store.applyCandidate({ requestId: next.id, expectedStateRevision: conflicted.stateRevision, expectedHeadRevision: 2, idempotencyKey: 'apply-conflict-candidate' });
		assert.equal(applied.author, 'providerAttempt');
		assert.equal(applied.content.title, 'Old candidate');
		assert.deepEqual(store.applyCandidate({ requestId: next.id, expectedStateRevision: conflicted.stateRevision, expectedHeadRevision: 2, idempotencyKey: 'apply-conflict-candidate' }), applied);
	} finally { value.close(); }
});

test('cancellation and restart interruption remain terminal when late candidates arrive', () => {
	const value = fixture();
	try {
		const store = value.store();
		const cancelled = store.createRequest(requestInput(value.scope)); const cancelledAttempt = randomUUID(); store.startRequest({ requestId: cancelled.id, expectedStateRevision: 0, attemptId: cancelledAttempt });
		const cancelledReceipt = store.cancelRequest({ requestId: cancelled.id, expectedStateRevision: 1 });
		const late = candidate(store, cancelled.id, cancelledAttempt);
		assert.equal(late.state, 'cancelled'); assert.ok(late.candidate); assert.equal(late.stateRevision, cancelledReceipt.stateRevision);
		const interrupted = store.createRequest(requestInput(value.scope, { idempotencyKey: 'draft-2', baseRevision: 0 }));
		const interruptedAttempt = randomUUID(); store.startRequest({ requestId: interrupted.id, expectedStateRevision: 0, attemptId: interruptedAttempt });
		assert.equal(store.interruptRunningRequests(), 1);
		const lateInterrupted = candidate(store, interrupted.id, interruptedAttempt);
		assert.equal(lateInterrupted.state, 'interrupted'); assert.ok(lateInterrupted.candidate);
		assert.equal(store.getHead(value.scope), undefined);
	} finally { value.close(); }
});

test('host per-request interruption uses state-revision CAS and leaves concurrent requests running', () => {
	const value = fixture();
	try {
		const store = value.store();
		const first = store.createRequest(requestInput(value.scope)); const firstAttempt = randomUUID();
		const second = store.createRequest(requestInput(value.scope, { idempotencyKey: 'draft-2' })); const secondAttempt = randomUUID();
		store.startRequest({ requestId: first.id, expectedStateRevision: 0, attemptId: firstAttempt });
		store.startRequest({ requestId: second.id, expectedStateRevision: 0, attemptId: secondAttempt });
		assert.equal(store.interruptRequest({ requestId: first.id, expectedStateRevision: 1 }).state, 'interrupted');
		assert.equal(store.getRequest(value.scope, second.id)?.state, 'running');
		assert.throws(() => store.interruptRequest({ requestId: second.id, expectedStateRevision: 0 }), /state is stale/u);
		assert.equal(store.interruptRequest({ requestId: second.id, expectedStateRevision: 1 }).state, 'interrupted');
	} finally { value.close(); }
});

test('request pagination is bounded and returns stable sequence cursors', () => {
	const value = fixture();
	try {
		const store = value.store();
		store.createRequest(requestInput(value.scope));
		store.createRequest(requestInput(value.scope, { idempotencyKey: 'draft-2' }));
		const first = store.listRequests(value.scope, { afterSequence: 0, limit: 1 });
		assert.equal(first.requests.length, 1); assert.equal(first.hasMore, true); assert.equal(first.nextSequence, 1);
		const second = store.listRequests(value.scope, { afterSequence: first.nextSequence, limit: 1 });
		assert.equal(second.requests.length, 1); assert.equal(second.hasMore, false); assert.equal(second.nextSequence, 2);
		assert.throws(() => store.listRequests(value.scope, { afterSequence: 0, limit: 101 }), /page size/u);
	} finally { value.close(); }
});

test('reopened newest-first history starts with the latest revision and conflicted request and pages backwards', () => {
	const value = fixture();
	try {
		let store = value.store();
		store.appendGeneratedRevision({ scope: value.scope, expectedRevision: 0, idempotencyKey: 'initial-history',
			source: { kind: 'liveAgentTurn', turnId: value.scope.targetTurnId }, sanitizedCompleteAgentText: { title: 'Initial', body: '' }, knownSecrets: [] });
		for (let revision = 2; revision <= 7; revision++) {
			store.appendHumanRevision({ scope: value.scope, expectedRevision: revision - 1, idempotencyKey: `history-${revision}`, content: { title: `Version ${revision}`, body: '' } });
		}
		const requestIds: string[] = [];
		for (let index = 0; index < 7; index++) {
			requestIds.push(store.createRequest(requestInput(value.scope, { idempotencyKey: `history-request-${index}`, baseRevision: 7 })).id);
		}
		const lastRequest = requestIds[6]; const attemptId = randomUUID();
		store.startRequest({ requestId: lastRequest, expectedStateRevision: 0, attemptId });
		store.appendHumanRevision({ scope: value.scope, expectedRevision: 7, idempotencyKey: 'newer-than-request', content: { title: 'Keep manual version', body: '' } });
		candidate(store, lastRequest, attemptId);
		store = value.reopen();
		const revisions = store.listRevisions(value.scope, { afterRevision: 0, limit: 5, newestFirst: true });
		assert.deepEqual(revisions.revisions.map(item => item.revision), [8, 7, 6, 5, 4]);
		assert.equal(revisions.hasMore, true);
		assert.deepEqual(store.listRevisions(value.scope, { afterRevision: revisions.nextRevision, limit: 5, newestFirst: true }).revisions.map(item => item.revision), [3, 2, 1]);
		const requests = store.listRequests(value.scope, { afterSequence: 0, limit: 5, newestFirst: true });
		assert.equal(requests.requests[0].id, lastRequest);
		assert.equal(requests.requests[0].state, 'conflicted');
		assert.ok(requests.requests[0].candidate);
		assert.deepEqual(requests.requests.map(item => item.id), requestIds.slice(2).reverse());
		assert.deepEqual(store.listRequests(value.scope, { afterSequence: requests.nextSequence, limit: 5, newestFirst: true }).requests.map(item => item.id), requestIds.slice(0, 2).reverse());
		assert.deepEqual(store.listRevisions(value.scope, { afterRevision: 0, limit: 5 }).revisions.map(item => item.revision), [1, 2, 3, 4, 5], 'MCP forward history retains its original cursor contract');
	} finally { value.close(); }
});

test('PR text canonicalizes line endings before hashing and rejects invalid title or Unicode', () => {
	const value = fixture();
	try {
		const store = value.store();
		const saved = store.appendGeneratedRevision({ scope: value.scope, expectedRevision: 0, idempotencyKey: 'canonical-text',
			source: { kind: 'liveAgentTurn', turnId: value.scope.targetTurnId }, sanitizedCompleteAgentText: { title: 'PR 문안', body: '첫 줄\r\n다음 줄\r끝' }, knownSecrets: [] });
		assert.equal(saved.content.body, '첫 줄\n다음 줄\n끝');
		assert.equal(saved.content.contentHash, digest(JSON.stringify(['PR 문안', '첫 줄\n다음 줄\n끝'])));
		assert.throws(() => store.appendHumanRevision({ scope: value.scope, expectedRevision: 1, idempotencyKey: 'bad-title', content: { title: '첫 줄\n다음 줄', body: '' } }), /single line/u);
		assert.throws(() => store.appendHumanRevision({ scope: value.scope, expectedRevision: 1, idempotencyKey: 'bad-unicode', content: { title: '\ud800', body: '' } }), /invalid/u);
		assert.deepEqual(store.getHead(value.scope), saved);
	} finally { value.close(); }
});

test('provider failure is a durable terminal receipt with bounded error codes', () => {
	const value = fixture();
	try {
		const store = value.store(); const request = store.createRequest(requestInput(value.scope));
		const attemptId = randomUUID(); store.startRequest({ requestId: request.id, expectedStateRevision: 0, attemptId });
		const failed = store.failRequest({ requestId: request.id, expectedStateRevision: 1, errorCode: 'providerFailed' });
		assert.equal(failed.state, 'failed'); assert.equal(failed.errorCode, 'providerFailed');
		assert.deepEqual(store.failRequest({ requestId: request.id, expectedStateRevision: 1, errorCode: 'providerFailed' }), failed);
		assert.equal(store.getHead(value.scope), undefined);
	} finally { value.close(); }
});
