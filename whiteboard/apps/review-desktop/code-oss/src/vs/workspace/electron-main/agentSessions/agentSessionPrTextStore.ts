/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
	AGENT_PR_TEXT_MAX_BODY_BYTES,
	AGENT_PR_TEXT_MAX_INSTRUCTION_BYTES,
	AGENT_PR_TEXT_MAX_TITLE_BYTES,
	type AgentPrTextCandidateDTO,
	type AgentPrTextContent,
	type AgentPrTextDraftInput,
	type AgentPrTextErrorCode,
	type AgentPrTextProvider,
	type AgentPrTextRequestDTO,
	type AgentPrTextRequestPageDTO,
	type AgentPrTextRequestState,
	type AgentPrTextRevisionDTO,
	type AgentPrTextRevisionPageDTO,
	type AgentPrTextScope,
	type AgentPrTextSource,
	type CreateAgentPrTextRequestInput,
} from '../../common/workspaceAgentPrTextProtocol.js';
import { sanitizeCompleteAgentText } from './agentOutputRedactor.js';

export const AGENT_SESSION_PR_TEXT_MIGRATION_SQL = `
CREATE TABLE agent_session_pr_text_revisions (
	id TEXT PRIMARY KEY NOT NULL,
	project_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	target_turn_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision > 0),
	idempotency_key TEXT NOT NULL CHECK (length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128),
	input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'),
	author TEXT NOT NULL CHECK (author IN ('liveAgentTurn', 'providerAttempt', 'human')),
	source_json TEXT CHECK (source_json IS NULL OR (json_valid(source_json) AND length(CAST(source_json AS BLOB)) <= 1024)),
	title TEXT NOT NULL CHECK (length(CAST(title AS BLOB)) BETWEEN 1 AND ${AGENT_PR_TEXT_MAX_TITLE_BYTES}),
	body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= ${AGENT_PR_TEXT_MAX_BODY_BYTES}),
	content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
	created_at TEXT NOT NULL,
	UNIQUE (project_id, session_id, target_turn_id, revision),
	UNIQUE (project_id, session_id, target_turn_id, idempotency_key),
	CHECK ((author = 'human' AND source_json IS NULL) OR (author != 'human' AND source_json IS NOT NULL)),
	FOREIGN KEY (target_turn_id, project_id, session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_pr_text_revisions_page ON agent_session_pr_text_revisions(project_id, session_id, target_turn_id, revision DESC);
CREATE TRIGGER agent_session_pr_text_revision_immutable_update BEFORE UPDATE ON agent_session_pr_text_revisions
BEGIN SELECT RAISE(ABORT, 'PR text revisions are immutable'); END;
CREATE TRIGGER agent_session_pr_text_revision_immutable_delete BEFORE DELETE ON agent_session_pr_text_revisions
BEGIN SELECT RAISE(ABORT, 'PR text revisions are immutable'); END;

CREATE TABLE agent_session_pr_text_requests (
	id TEXT PRIMARY KEY NOT NULL,
	project_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	target_turn_id TEXT NOT NULL,
	sequence INTEGER NOT NULL CHECK (sequence > 0),
	idempotency_key TEXT NOT NULL CHECK (length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128),
	input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'),
	base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
	provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
	model TEXT NOT NULL CHECK (length(CAST(trim(model) AS BLOB)) BETWEEN 1 AND 200),
	profile_ref TEXT CHECK (profile_ref IS NULL OR length(CAST(profile_ref AS BLOB)) <= 512),
	context_digest TEXT NOT NULL CHECK (length(context_digest) = 64 AND context_digest NOT GLOB '*[^0-9a-f]*'),
	context_json TEXT NOT NULL CHECK (json_valid(context_json) AND length(CAST(context_json AS BLOB)) <= 65536),
	instruction TEXT NOT NULL CHECK (length(CAST(instruction AS BLOB)) <= ${AGENT_PR_TEXT_MAX_INSTRUCTION_BYTES}),
	state TEXT NOT NULL CHECK (state IN ('preview', 'running', 'succeeded', 'conflicted', 'failed', 'cancelled', 'interrupted')),
	state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
	error_code TEXT CHECK (error_code IS NULL OR error_code IN ('providerFailed', 'runnerUnavailable', 'invalidCandidate')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (project_id, session_id, target_turn_id, idempotency_key),
	UNIQUE (project_id, session_id, target_turn_id, sequence),
	UNIQUE (id, project_id, session_id, target_turn_id),
	FOREIGN KEY (target_turn_id, project_id, session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_pr_text_requests_page ON agent_session_pr_text_requests(project_id, session_id, target_turn_id, sequence DESC);
CREATE TRIGGER agent_session_pr_text_request_context_immutable BEFORE UPDATE OF
	project_id, session_id, target_turn_id, sequence, idempotency_key, input_fingerprint, base_revision, provider, model, profile_ref, context_digest, context_json, instruction, created_at
ON agent_session_pr_text_requests
BEGIN SELECT RAISE(ABORT, 'PR text request context is immutable'); END;
CREATE TRIGGER agent_session_pr_text_request_transition_guard BEFORE UPDATE OF state, state_revision, error_code, updated_at ON agent_session_pr_text_requests
WHEN NEW.state_revision != OLD.state_revision + 1 OR NOT (
	(OLD.state = 'preview' AND NEW.state IN ('running', 'cancelled', 'interrupted')) OR
	(OLD.state = 'running' AND NEW.state IN ('succeeded', 'conflicted', 'failed', 'cancelled', 'interrupted'))
)
BEGIN SELECT RAISE(ABORT, 'PR text request state transition is invalid'); END;

CREATE TABLE agent_session_pr_text_request_events (
	request_id TEXT NOT NULL REFERENCES agent_session_pr_text_requests(id) ON DELETE RESTRICT,
	sequence INTEGER NOT NULL CHECK (sequence > 0),
	event_type TEXT NOT NULL CHECK (event_type IN ('preview', 'running', 'candidate', 'succeeded', 'conflicted', 'failed', 'cancelled', 'interrupted')),
	event_json TEXT NOT NULL CHECK (json_valid(event_json) AND length(CAST(event_json AS BLOB)) <= 524288),
	created_at TEXT NOT NULL,
	PRIMARY KEY (request_id, sequence),
	UNIQUE (request_id, event_type)
) STRICT;
CREATE TRIGGER agent_session_pr_text_request_event_immutable_update BEFORE UPDATE ON agent_session_pr_text_request_events
BEGIN SELECT RAISE(ABORT, 'PR text request events are immutable'); END;
CREATE TRIGGER agent_session_pr_text_request_event_immutable_delete BEFORE DELETE ON agent_session_pr_text_request_events
BEGIN SELECT RAISE(ABORT, 'PR text request events are immutable'); END;
`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PAGE_SIZE = 100;
const MAX_CONTEXT_JSON_BYTES = 64 * 1024;

interface RequestRow extends Readonly<Record<string, SQLOutputValue>> {
	id: SQLOutputValue; project_id: SQLOutputValue; session_id: SQLOutputValue; target_turn_id: SQLOutputValue;
	sequence: SQLOutputValue; idempotency_key: SQLOutputValue; input_fingerprint: SQLOutputValue; base_revision: SQLOutputValue;
	provider: SQLOutputValue; model: SQLOutputValue; profile_ref: SQLOutputValue; context_digest: SQLOutputValue;
	context_json: SQLOutputValue; instruction: SQLOutputValue; state: SQLOutputValue; state_revision: SQLOutputValue; error_code: SQLOutputValue;
	created_at: SQLOutputValue; updated_at: SQLOutputValue;
}

interface RevisionRow extends Readonly<Record<string, SQLOutputValue>> {
	id: SQLOutputValue; project_id: SQLOutputValue; session_id: SQLOutputValue; target_turn_id: SQLOutputValue;
	revision: SQLOutputValue; idempotency_key: SQLOutputValue; input_fingerprint: SQLOutputValue; author: SQLOutputValue; source_json: SQLOutputValue; title: SQLOutputValue;
	body: SQLOutputValue; content_hash: SQLOutputValue; created_at: SQLOutputValue;
}

type StoredCandidate = { readonly source: AgentPrTextSource; readonly content: AgentPrTextContent; readonly receivedAt: string };
type StoredCandidateEvent = StoredCandidate & { readonly late: boolean; readonly contentFingerprint: string };

export interface AgentPrTextRequestContext {
	readonly requestId: string;
	readonly scope: AgentPrTextScope;
	readonly baseRevision: number;
	readonly provider: AgentPrTextProvider;
	readonly model: string;
	readonly profileRef: string | null;
	readonly contextDigest: string;
	readonly contextJSON: string;
	readonly instruction: string;
}

/** Synchronous, SQLite-only PR text revision and request journal. */
export class AgentSessionPrTextStore {
	constructor(private readonly db: DatabaseSync) { }

	getHead(scopeInput: AgentPrTextScope): AgentPrTextRevisionDTO | undefined {
		const scope = this.normalizeScope(scopeInput);
		const row = this.db.prepare(`SELECT id, project_id, session_id, target_turn_id, revision, idempotency_key, input_fingerprint, author, source_json, title, body, content_hash, created_at
			FROM agent_session_pr_text_revisions WHERE project_id = ? AND session_id = ? AND target_turn_id = ? ORDER BY revision DESC LIMIT 1`).get(scope.projectId, scope.sessionId, scope.targetTurnId) as RevisionRow | undefined;
		return row ? this.revisionFromRow(row) : undefined;
	}

	getRevision(scopeInput: AgentPrTextScope, revision: number): AgentPrTextRevisionDTO | undefined {
		const scope = this.normalizeScope(scopeInput); this.assertRevision(revision, true);
		const row = this.db.prepare(`SELECT id, project_id, session_id, target_turn_id, revision, idempotency_key, input_fingerprint, author, source_json, title, body, content_hash, created_at
			FROM agent_session_pr_text_revisions WHERE project_id = ? AND session_id = ? AND target_turn_id = ? AND revision = ?`).get(scope.projectId, scope.sessionId, scope.targetTurnId, revision) as RevisionRow | undefined;
		return row ? this.revisionFromRow(row) : undefined;
	}

	listRevisions(scopeInput: AgentPrTextScope, options: { readonly afterRevision: number; readonly limit: number; readonly newestFirst?: boolean }): AgentPrTextRevisionPageDTO {
		const scope = this.normalizeScope(scopeInput); this.validatePage(options.afterRevision, options.limit, 'revision');
		const cursor = options.newestFirst && options.afterRevision === 0 ? Number.MAX_SAFE_INTEGER : options.afterRevision;
		const rows = this.db.prepare(`SELECT id, project_id, session_id, target_turn_id, revision, idempotency_key, input_fingerprint, author, source_json, title, body, content_hash, created_at
			FROM agent_session_pr_text_revisions WHERE project_id = ? AND session_id = ? AND target_turn_id = ? AND revision ${options.newestFirst ? '<' : '>'} ? ORDER BY revision ${options.newestFirst ? 'DESC' : 'ASC'} LIMIT ?`)
			.all(scope.projectId, scope.sessionId, scope.targetTurnId, cursor, options.limit + 1) as RevisionRow[];
		const hasMore = rows.length > options.limit; const revisions = rows.slice(0, options.limit).map(row => this.revisionFromRow(row));
		return { revisions, nextRevision: revisions.at(-1)?.revision ?? options.afterRevision, hasMore };
	}

	appendHumanRevision(input: { readonly scope: AgentPrTextScope; readonly expectedRevision: number; readonly idempotencyKey: string; readonly content: AgentPrTextDraftInput }, knownSecrets: readonly string[] = []): AgentPrTextRevisionDTO {
		this.assertExactKeys(input, ['scope', 'expectedRevision', 'idempotencyKey', 'content']);
		const scope = this.normalizeScope(input.scope); this.assertRevision(input.expectedRevision, true);
		const idempotencyKey = this.normalizeText(input.idempotencyKey, 128, 'revision idempotency key', false);
		const content = this.normalizeContent(input.content, knownSecrets);
		return this.transaction(() => {
			return this.appendRevisionIdempotently(scope, input.expectedRevision, idempotencyKey, 'human', null, content);
		});
	}

	appendGeneratedRevision(input: {
		readonly scope: AgentPrTextScope;
		readonly expectedRevision: number;
		readonly idempotencyKey: string;
		readonly source: AgentPrTextSource;
		readonly sanitizedCompleteAgentText: AgentPrTextDraftInput;
		readonly knownSecrets: readonly string[];
	}): AgentPrTextRevisionDTO {
		this.assertExactKeys(input, ['scope', 'expectedRevision', 'idempotencyKey', 'source', 'sanitizedCompleteAgentText', 'knownSecrets']);
		const scope = this.normalizeScope(input.scope); this.assertRevision(input.expectedRevision, true);
		const idempotencyKey = this.normalizeText(input.idempotencyKey, 128, 'revision idempotency key', false);
		const source = this.normalizeSource(input.source); this.verifySource(scope, source);
		const content = this.normalizeContent(input.sanitizedCompleteAgentText, input.knownSecrets);
		const author = source.kind;
		return this.transaction(() => {
			return this.appendRevisionIdempotently(scope, input.expectedRevision, idempotencyKey, author, source, content);
		});
	}

	createRequest(input: CreateAgentPrTextRequestInput, knownSecrets: readonly string[] = []): AgentPrTextRequestDTO {
		this.assertExactKeys(input, ['scope', 'idempotencyKey', 'baseRevision', 'provider', 'model', 'profileRef', 'contextDigest', 'contextJSON', 'instruction']);
		const scope = this.normalizeScope(input.scope); this.assertRevision(input.baseRevision, true);
		const idempotencyKey = this.normalizeText(input.idempotencyKey, 128, 'idempotency key', false);
		const provider = this.normalizeProvider(input.provider);
		const model = this.normalizeText(input.model, 200, 'model', false);
		const profileRef = input.profileRef === null ? null : this.normalizeText(input.profileRef, 512, 'profile ref', false);
		const rawContextJSON = this.normalizeText(input.contextJSON, MAX_CONTEXT_JSON_BYTES, 'context JSON', true);
		let parsedContext: unknown;
		try { parsedContext = JSON.parse(rawContextJSON); } catch { throw this.error('Context JSON is invalid.'); }
		if (!HASH_PATTERN.test(input.contextDigest) || digest(rawContextJSON) !== input.contextDigest) { throw this.error('Context digest does not match its bounded JSON.'); }
		const { contextJSON, contextDigest: actualContextDigest } = this.sanitizeContextJSONValue(parsedContext, knownSecrets);
		const instruction = this.normalizeText(this.sanitizeCompleteText(this.normalizeText(input.instruction, AGENT_PR_TEXT_MAX_INSTRUCTION_BYTES, 'instruction', true), knownSecrets), AGENT_PR_TEXT_MAX_INSTRUCTION_BYTES, 'sanitized instruction', true);
		const semantic = { scope, baseRevision: input.baseRevision, provider, model, profileRef, contextDigest: actualContextDigest, instruction };
		const fingerprint = digest(JSON.stringify(semantic));
		return this.transaction(() => {
			this.assertScopeExists(scope);
			const existing = this.db.prepare(`SELECT * FROM agent_session_pr_text_requests WHERE project_id = ? AND session_id = ? AND target_turn_id = ? AND idempotency_key = ?`)
				.get(scope.projectId, scope.sessionId, scope.targetTurnId, idempotencyKey) as RequestRow | undefined;
			if (existing) {
				if (String(existing.input_fingerprint) !== fingerprint) { throw this.error('Idempotency key was reused with different PR text input.'); }
				return this.requestFromRow(existing);
			}
			const headRevision = this.headRevision(scope);
			if (headRevision !== input.baseRevision) { throw this.error('PR text base revision is stale.'); }
			const sequence = Number((this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM agent_session_pr_text_requests
				WHERE project_id = ? AND session_id = ? AND target_turn_id = ?`).get(scope.projectId, scope.sessionId, scope.targetTurnId) as { next: SQLOutputValue }).next);
			const id = randomUUID(); const now = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_session_pr_text_requests (id, project_id, session_id, target_turn_id, sequence, idempotency_key, input_fingerprint,
				base_revision, provider, model, profile_ref, context_digest, context_json, instruction, state, state_revision, error_code, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preview', 0, NULL, ?, ?)`).run(id, scope.projectId, scope.sessionId, scope.targetTurnId, sequence,
				idempotencyKey, fingerprint, input.baseRevision, provider, model, profileRef, actualContextDigest, contextJSON, instruction, now, now);
			this.appendRequestEvent(id, 1, 'preview', { stateRevision: 0 });
			return this.getRequestInternal(id)!;
		});
	}

	/** Reuses the exact host redaction and canonicalization used when persisting request context. */
	sanitizeContextJSON(rawContextJSON: string, knownSecrets: readonly string[] = []): { readonly contextJSON: string; readonly contextDigest: string } {
		const bounded = this.normalizeText(rawContextJSON, MAX_CONTEXT_JSON_BYTES, 'context JSON', true);
		let parsed: unknown;
		try { parsed = JSON.parse(bounded); } catch { throw this.error('Context JSON is invalid.'); }
		return this.sanitizeContextJSONValue(parsed, knownSecrets);
	}

	getRequest(scopeInput: AgentPrTextScope, requestId: string): AgentPrTextRequestDTO | undefined {
		const scope = this.normalizeScope(scopeInput); this.assertUuid(requestId, 'request ID');
		const row = this.db.prepare('SELECT * FROM agent_session_pr_text_requests WHERE id = ? AND project_id = ? AND session_id = ? AND target_turn_id = ?')
			.get(requestId, scope.projectId, scope.sessionId, scope.targetTurnId) as RequestRow | undefined;
		return row ? this.requestFromRow(row) : undefined;
	}

	/** Host-only runner context. Do not expose this method through renderer IPC. */
	getRequestContext(scopeInput: AgentPrTextScope, requestId: string): AgentPrTextRequestContext | undefined {
		const scope = this.normalizeScope(scopeInput); this.assertUuid(requestId, 'request ID');
		const row = this.db.prepare('SELECT base_revision, provider, model, profile_ref, context_digest, context_json, instruction FROM agent_session_pr_text_requests WHERE id = ? AND project_id = ? AND session_id = ? AND target_turn_id = ?')
			.get(requestId, scope.projectId, scope.sessionId, scope.targetTurnId) as { base_revision: SQLOutputValue; provider: SQLOutputValue; model: SQLOutputValue; profile_ref: SQLOutputValue; context_digest: SQLOutputValue; context_json: SQLOutputValue; instruction: SQLOutputValue } | undefined;
		if (!row) { return undefined; }
		const contextJSON = String(row.context_json);
		if (digest(contextJSON) !== String(row.context_digest)) { throw this.error('Persisted PR text context digest is invalid.'); }
		return { requestId, scope, baseRevision: Number(row.base_revision), provider: this.normalizeProvider(String(row.provider)), model: String(row.model),
			profileRef: row.profile_ref === null ? null : String(row.profile_ref), contextDigest: String(row.context_digest), contextJSON, instruction: String(row.instruction) };
	}

	listRequests(scopeInput: AgentPrTextScope, options: { readonly afterSequence: number; readonly limit: number; readonly newestFirst?: boolean }): AgentPrTextRequestPageDTO {
		const scope = this.normalizeScope(scopeInput); this.validatePage(options.afterSequence, options.limit, 'request');
		const cursor = options.newestFirst && options.afterSequence === 0 ? Number.MAX_SAFE_INTEGER : options.afterSequence;
		const rows = this.db.prepare(`SELECT * FROM agent_session_pr_text_requests WHERE project_id = ? AND session_id = ? AND target_turn_id = ? AND sequence ${options.newestFirst ? '<' : '>'} ? ORDER BY sequence ${options.newestFirst ? 'DESC' : 'ASC'} LIMIT ?`)
			.all(scope.projectId, scope.sessionId, scope.targetTurnId, cursor, options.limit + 1) as RequestRow[];
		const hasMore = rows.length > options.limit; const requests = rows.slice(0, options.limit).map(row => this.requestFromRow(row));
		return { requests, nextSequence: requests.length ? Number(rows[requests.length - 1].sequence) : options.afterSequence, hasMore };
	}

	/** Host-runner entry point. Persist the owned attempt identity before any provider work begins. */
	startRequest(input: { readonly requestId: string; readonly expectedStateRevision: number; readonly attemptId: string }): AgentPrTextRequestDTO {
		this.assertExactKeys(input, ['requestId', 'expectedStateRevision', 'attemptId']); this.assertUuid(input.requestId, 'request ID'); this.assertRevision(input.expectedStateRevision, true); this.assertUuid(input.attemptId, 'attempt ID');
		return this.transaction(() => {
			const request = this.requireRequest(input.requestId);
			if (request.state === 'running' && request.stateRevision === input.expectedStateRevision + 1) {
				const running = this.runningEvent(request.id);
				if (running?.attemptId === input.attemptId) { return request; }
				throw this.error('PR text start retry has a different host attempt ID.');
			}
			if (request.state !== 'preview' || request.stateRevision !== input.expectedStateRevision) { throw this.error('PR text request state is stale or cannot start.'); }
			return this.transitionRequest(request, 'running', null, { attemptId: input.attemptId });
		});
	}

	/** Trusted runner completion only; renderer-facing APIs must never forward this receipt shape. */
	completeRequest(input: {
		readonly requestId: string;
		readonly expectedRunningRevision: number;
		readonly source: Extract<AgentPrTextSource, { readonly kind: 'providerAttempt' }>;
		readonly sanitizedCompleteAgentText: AgentPrTextDraftInput;
		readonly knownSecrets: readonly string[];
	}): AgentPrTextRequestDTO {
		this.assertExactKeys(input, ['requestId', 'expectedRunningRevision', 'source', 'sanitizedCompleteAgentText', 'knownSecrets']);
		this.assertUuid(input.requestId, 'request ID'); this.assertRevision(input.expectedRunningRevision, false);
		const source = this.normalizeSource(input.source);
		if (source.kind !== 'providerAttempt') { throw this.error('Only a trusted provider-attempt receipt can complete a PR text request.'); }
		const content = this.normalizeContent(input.sanitizedCompleteAgentText, input.knownSecrets);
		return this.transaction(() => {
			const request = this.requireRequest(input.requestId); this.verifySource(request.scope, source, request);
			const fingerprint = digest(JSON.stringify({ source, content }));
			const priorCandidate = this.candidateEvent(request.id);
			if (priorCandidate) {
				if (priorCandidate.contentFingerprint !== fingerprint) { throw this.error('A different candidate was already recorded for this PR text request.'); }
				return request;
			}
			const runningEvent = this.runningEvent(request.id);
			if (!runningEvent || runningEvent.stateRevision !== input.expectedRunningRevision || (source.kind === 'providerAttempt' && runningEvent.attemptId !== source.attemptId)) { throw this.error('Candidate source does not match this request run.'); }
			const late = request.state !== 'running';
			if (!late && request.stateRevision !== input.expectedRunningRevision) { throw this.error('PR text request state is stale.'); }
			if (late && !['cancelled', 'interrupted', 'failed'].includes(request.state)) { throw this.error('PR text request is no longer eligible for a candidate receipt.'); }
			const candidate: StoredCandidateEvent = { source, content, receivedAt: new Date().toISOString(), late, contentFingerprint: fingerprint };
			const nextSequence = this.nextEventSequence(request.id);
			this.appendRequestEvent(request.id, nextSequence, 'candidate', candidate);
			if (late) { return this.requireRequest(request.id); }
			const currentHead = this.headRevision(request.scope);
			let next: AgentPrTextRequestState;
			if (currentHead === request.baseRevision) {
				this.appendRevisionIdempotently(request.scope, currentHead, `request:${request.id}`, source.kind, source, content); next = 'succeeded';
			} else { next = 'conflicted'; }
			return this.transitionRequest(this.requireRequest(request.id), next, null);
		});
	}

	/** Apply a stored provider candidate without accepting renderer-authored source metadata. */
	applyCandidate(input: { readonly requestId: string; readonly expectedStateRevision: number; readonly expectedHeadRevision: number; readonly idempotencyKey: string }): AgentPrTextRevisionDTO {
		this.assertExactKeys(input, ['requestId', 'expectedStateRevision', 'expectedHeadRevision', 'idempotencyKey']);
		this.assertUuid(input.requestId, 'request ID'); this.assertRevision(input.expectedStateRevision, true); this.assertRevision(input.expectedHeadRevision, true);
		const idempotencyKey = this.normalizeText(input.idempotencyKey, 128, 'revision idempotency key', false);
		return this.transaction(() => {
			const request = this.requireRequest(input.requestId);
			if (request.stateRevision !== input.expectedStateRevision) { throw this.error('PR text request state is stale.'); }
			const candidate = this.candidateEvent(request.id);
			const conflictedCandidate = request.state === 'conflicted' && candidate?.late === false;
			const lateCandidate = ['cancelled', 'interrupted', 'failed'].includes(request.state) && candidate?.late === true;
			if ((!conflictedCandidate && !lateCandidate) || !candidate || candidate.source.kind !== 'providerAttempt') { throw this.error('A conflicted or late provider-attempt candidate receipt is not available.'); }
			this.verifySource(request.scope, candidate.source, request);
			return this.appendRevisionIdempotently(request.scope, input.expectedHeadRevision, idempotencyKey, 'providerAttempt', candidate.source, candidate.content);
		});
	}

	failRequest(input: { readonly requestId: string; readonly expectedStateRevision: number; readonly errorCode: AgentPrTextErrorCode }): AgentPrTextRequestDTO {
		this.assertExactKeys(input, ['requestId', 'expectedStateRevision', 'errorCode']); this.assertUuid(input.requestId, 'request ID'); this.assertRevision(input.expectedStateRevision, true);
		if (!['providerFailed', 'runnerUnavailable', 'invalidCandidate'].includes(input.errorCode)) { throw this.error('PR text error code is invalid.'); }
		return this.transitionTo(input.requestId, input.expectedStateRevision, 'failed', input.errorCode);
	}

	cancelRequest(input: { readonly requestId: string; readonly expectedStateRevision: number }): AgentPrTextRequestDTO {
		this.assertExactKeys(input, ['requestId', 'expectedStateRevision']); this.assertUuid(input.requestId, 'request ID'); this.assertRevision(input.expectedStateRevision, true);
		return this.transitionTo(input.requestId, input.expectedStateRevision, 'cancelled', null);
	}

	interruptRunningRequests(): number {
		return this.transaction(() => {
			const rows = this.db.prepare(`SELECT * FROM agent_session_pr_text_requests WHERE state = 'running' ORDER BY created_at, sequence`).all() as RequestRow[];
			for (const row of rows) { this.transitionRequest(this.requestFromRow(row), 'interrupted', null); }
			return rows.length;
		});
	}

	interruptRequest(input: { readonly requestId: string; readonly expectedStateRevision: number }): AgentPrTextRequestDTO {
		this.assertExactKeys(input, ['requestId', 'expectedStateRevision']); this.assertUuid(input.requestId, 'request ID'); this.assertRevision(input.expectedStateRevision, true);
		return this.transitionTo(input.requestId, input.expectedStateRevision, 'interrupted', null);
	}

	private transitionTo(requestId: string, expectedRevision: number, state: AgentPrTextRequestState, errorCode: AgentPrTextErrorCode | null): AgentPrTextRequestDTO {
		return this.transaction(() => {
			const request = this.requireRequest(requestId);
			if (request.state === state && request.stateRevision === expectedRevision + 1 && request.errorCode === errorCode) { return request; }
			if (request.stateRevision !== expectedRevision) { throw this.error('PR text request state is stale.'); }
			return this.transitionRequest(request, state, errorCode);
		});
	}

	private transitionRequest(request: AgentPrTextRequestDTO, state: AgentPrTextRequestState, errorCode: AgentPrTextErrorCode | null, eventPayload?: Readonly<Record<string, unknown>>): AgentPrTextRequestDTO {
		const now = new Date().toISOString(); const nextRevision = request.stateRevision + 1;
		const result = this.db.prepare(`UPDATE agent_session_pr_text_requests SET state = ?, state_revision = ?, error_code = ?, updated_at = ?
			WHERE id = ? AND state_revision = ?`).run(state, nextRevision, errorCode, now, request.id, request.stateRevision);
		if (Number(result.changes) !== 1) { throw this.error('PR text request state is stale.'); }
		this.appendRequestEvent(request.id, this.nextEventSequence(request.id), state, { stateRevision: nextRevision, errorCode, ...eventPayload });
		return this.requireRequest(request.id);
	}

	private assertExpectedHead(scope: AgentPrTextScope, expectedRevision: number, human: boolean): void {
		const actual = this.headRevision(scope);
		if (actual !== expectedRevision) { throw this.error('PR text head revision is stale.'); }
		if (human && actual === 0) { throw this.error('The first PR text revision must come from an agent.'); }
	}

	private headRevision(scope: AgentPrTextScope): number {
		return Number((this.db.prepare(`SELECT COALESCE(MAX(revision), 0) AS revision FROM agent_session_pr_text_revisions WHERE project_id = ? AND session_id = ? AND target_turn_id = ?`)
			.get(scope.projectId, scope.sessionId, scope.targetTurnId) as { revision: SQLOutputValue }).revision);
	}

	private appendRevisionIdempotently(scope: AgentPrTextScope, expectedRevision: number, idempotencyKey: string, author: AgentPrTextRevisionDTO['author'], source: AgentPrTextSource | null, content: AgentPrTextContent): AgentPrTextRevisionDTO {
		const fingerprint = digest(JSON.stringify({ scope, expectedRevision, author, source, content }));
		const existing = this.db.prepare(`SELECT id, project_id, session_id, target_turn_id, revision, idempotency_key, input_fingerprint, author, source_json, title, body, content_hash, created_at
			FROM agent_session_pr_text_revisions WHERE project_id = ? AND session_id = ? AND target_turn_id = ? AND idempotency_key = ?`)
			.get(scope.projectId, scope.sessionId, scope.targetTurnId, idempotencyKey) as RevisionRow | undefined;
		if (existing) {
			if (String(existing.input_fingerprint) !== fingerprint) { throw this.error('Revision idempotency key was reused with different PR text content or source.'); }
			return this.revisionFromRow(existing);
		}
		this.assertExpectedHead(scope, expectedRevision, author === 'human');
		const revision = expectedRevision + 1; const id = randomUUID(); const createdAt = new Date().toISOString();
		this.db.prepare(`INSERT INTO agent_session_pr_text_revisions (id, project_id, session_id, target_turn_id, revision, idempotency_key, input_fingerprint, author, source_json, title, body, content_hash, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, scope.projectId, scope.sessionId, scope.targetTurnId, revision, idempotencyKey, fingerprint, author, source ? JSON.stringify(source) : null,
			content.title, content.body, content.contentHash, createdAt);
		return { id, scope, revision, author, source, content, createdAt };
	}

	private requestFromRow(row: RequestRow): AgentPrTextRequestDTO {
		const id = String(row.id);
		const candidateEvent = this.candidateEvent(id);
		const candidate: AgentPrTextCandidateDTO | undefined = candidateEvent ? { source: candidateEvent.source, content: candidateEvent.content, receivedAt: candidateEvent.receivedAt } : undefined;
		const state = this.assertState(String(row.state));
		const errorCode = row.error_code === null ? undefined : this.assertErrorCode(String(row.error_code));
		const scope = { projectId: String(row.project_id), sessionId: String(row.session_id), targetTurnId: String(row.target_turn_id) };
		return {
			id, scope, baseRevision: Number(row.base_revision), headRevision: this.headRevision(scope), state, stateRevision: Number(row.state_revision), provider: this.normalizeProvider(String(row.provider)),
			model: String(row.model), profileRef: row.profile_ref === null ? null : String(row.profile_ref), contextDigest: String(row.context_digest),
			instruction: String(row.instruction), ...(candidate ? { candidate } : {}), ...(errorCode ? { errorCode } : {}),
			createdAt: String(row.created_at), updatedAt: String(row.updated_at),
		};
	}

	private revisionFromRow(row: RevisionRow): AgentPrTextRevisionDTO {
		const author = String(row.author) as AgentPrTextRevisionDTO['author'];
		if (!['liveAgentTurn', 'providerAttempt', 'human'].includes(author)) { throw this.error('Persisted PR text revision author is invalid.'); }
		const source = row.source_json === null ? null : this.normalizeSource(JSON.parse(String(row.source_json)) as AgentPrTextSource);
		const title = String(row.title); const body = String(row.body); const contentHash = String(row.content_hash);
		if (digest(JSON.stringify([title, body])) !== contentHash) { throw this.error('Persisted PR text revision content hash is invalid.'); }
		return { id: String(row.id), scope: { projectId: String(row.project_id), sessionId: String(row.session_id), targetTurnId: String(row.target_turn_id) },
			revision: Number(row.revision), author, source, content: { title, body, contentHash }, createdAt: String(row.created_at) };
	}

	private getRequestInternal(id: string): AgentPrTextRequestDTO | undefined {
		const row = this.db.prepare('SELECT * FROM agent_session_pr_text_requests WHERE id = ?').get(id) as RequestRow | undefined;
		return row ? this.requestFromRow(row) : undefined;
	}

	private requireRequest(id: string): AgentPrTextRequestDTO {
		const request = this.getRequestInternal(id); if (!request) { throw this.error('PR text request does not exist.'); } return request;
	}

	private candidateEvent(requestId: string): StoredCandidateEvent | undefined {
		const row = this.db.prepare(`SELECT event_json FROM agent_session_pr_text_request_events WHERE request_id = ? AND event_type = 'candidate'`).get(requestId) as { event_json: SQLOutputValue } | undefined;
		if (!row) { return undefined; }
		const value = JSON.parse(String(row.event_json)) as StoredCandidateEvent;
		if (!value || typeof value !== 'object' || typeof value.contentFingerprint !== 'string' || !HASH_PATTERN.test(value.contentFingerprint)) { throw this.error('Persisted PR text candidate receipt is invalid.'); }
		const source = this.normalizeSource(value.source); const content = this.normalizeStoredContent(value.content);
		if (digest(JSON.stringify({ source, content })) !== value.contentFingerprint) { throw this.error('Persisted PR text candidate fingerprint is invalid.'); }
		return { ...value, source, content };
	}

	private appendRequestEvent(requestId: string, sequence: number, type: string, value: unknown): void {
		this.db.prepare(`INSERT INTO agent_session_pr_text_request_events (request_id, sequence, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)`)
			.run(requestId, sequence, type, JSON.stringify(value), new Date().toISOString());
	}

	private nextEventSequence(requestId: string): number {
		return Number((this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM agent_session_pr_text_request_events WHERE request_id = ?').get(requestId) as { next: SQLOutputValue }).next);
	}

	private runningEvent(requestId: string): { readonly stateRevision: number; readonly attemptId: string } | undefined {
		const row = this.db.prepare(`SELECT event_json FROM agent_session_pr_text_request_events WHERE request_id = ? AND event_type = 'running'`).get(requestId) as { event_json: SQLOutputValue } | undefined;
		if (!row) { return undefined; }
		const event = JSON.parse(String(row.event_json)) as { stateRevision?: unknown; attemptId?: unknown };
		if (typeof event.stateRevision !== 'number' || !Number.isSafeInteger(event.stateRevision) || typeof event.attemptId !== 'string' || !UUID_PATTERN.test(event.attemptId)) { throw this.error('Persisted PR text run receipt is invalid.'); }
		return { stateRevision: Number(event.stateRevision), attemptId: event.attemptId };
	}

	private verifySource(scope: AgentPrTextScope, source: AgentPrTextSource, request?: AgentPrTextRequestDTO): void {
		if (source.kind === 'liveAgentTurn') {
			const turn = this.db.prepare(`SELECT source.ordinal AS source_ordinal, target.ordinal AS target_ordinal, source.provider, source.model, source.profile_ref
				FROM agent_session_turns source JOIN agent_session_turns target ON target.project_id = source.project_id AND target.session_id = source.session_id
				WHERE source.id = ? AND target.id = ? AND source.project_id = ? AND source.session_id = ?`)
				.get(source.turnId, scope.targetTurnId, scope.projectId, scope.sessionId) as { source_ordinal: SQLOutputValue; target_ordinal: SQLOutputValue; provider: SQLOutputValue; model: SQLOutputValue; profile_ref: SQLOutputValue } | undefined;
			if (!turn || Number(turn.source_ordinal) < Number(turn.target_ordinal) || (request && (String(turn.provider) !== request.provider || String(turn.model) !== request.model || (turn.profile_ref === null ? null : String(turn.profile_ref)) !== request.profileRef))) {
				throw this.error('Generated PR text source turn is not a later turn in the target session.');
			}
			return;
		}
		const running = request ? this.runningEvent(request.id) : undefined;
		if (!request || source.requestId !== request.id || !running || running.attemptId !== source.attemptId || !source.cleanupVerified || source.provider !== request.provider || source.model !== request.model || source.profileRef !== request.profileRef
			|| !HASH_PATTERN.test(source.receiptHash)) { throw this.error('Provider attempt source does not match the request-bound trusted runner receipt.'); }
	}

	private assertScopeExists(scope: AgentPrTextScope): void {
		const exists = this.db.prepare('SELECT 1 AS found FROM agent_session_turns WHERE id = ? AND session_id = ? AND project_id = ?').get(scope.targetTurnId, scope.sessionId, scope.projectId);
		if (!exists) { throw this.error('PR text scope does not identify a turn in this project and session.'); }
	}

	private normalizeScope(value: AgentPrTextScope): AgentPrTextScope {
		this.assertExactKeys(value, ['projectId', 'sessionId', 'targetTurnId']);
		this.assertUuid(value.projectId, 'project ID'); this.assertUuid(value.sessionId, 'session ID'); this.assertUuid(value.targetTurnId, 'target turn ID');
		return { projectId: value.projectId, sessionId: value.sessionId, targetTurnId: value.targetTurnId };
	}

	private normalizeSource(value: AgentPrTextSource): AgentPrTextSource {
		if (!value || typeof value !== 'object') { throw this.error('PR text source is invalid.'); }
		if (value.kind === 'liveAgentTurn') {
			this.assertExactKeys(value, ['kind', 'turnId']); this.assertUuid(value.turnId, 'source turn ID'); return { kind: value.kind, turnId: value.turnId };
		}
		if (value.kind === 'providerAttempt') {
			this.assertExactKeys(value, ['kind', 'requestId', 'attemptId', 'provider', 'model', 'profileRef', 'receiptHash', 'cleanupVerified']);
			this.assertUuid(value.requestId, 'provider attempt request ID'); this.assertUuid(value.attemptId, 'provider attempt ID');
			const provider = this.normalizeProvider(value.provider);
			const model = this.normalizeText(value.model, 200, 'source model', false);
			const profileRef = value.profileRef === null ? null : this.normalizeText(value.profileRef, 512, 'source profile ref', false);
			if (typeof value.receiptHash !== 'string' || !HASH_PATTERN.test(value.receiptHash) || value.cleanupVerified !== true) { throw this.error('Provider attempt execution receipt is invalid.'); }
			return { kind: value.kind, requestId: value.requestId, attemptId: value.attemptId, provider, model, profileRef, receiptHash: value.receiptHash, cleanupVerified: true };
		}
		throw this.error('PR text source kind is invalid.');
	}

	private normalizeContent(value: AgentPrTextDraftInput, knownSecrets: readonly string[]): AgentPrTextContent {
		this.assertExactKeys(value, ['title', 'body']);
		if (!Array.isArray(knownSecrets) || knownSecrets.some(secret => typeof secret !== 'string' || !secret.length || Buffer.byteLength(secret, 'utf8') > 8192)) { throw this.error('Known-secret list is invalid.'); }
		let title = this.normalizeText(value.title, AGENT_PR_TEXT_MAX_TITLE_BYTES, 'title', false);
		let body = this.normalizeText(value.body, AGENT_PR_TEXT_MAX_BODY_BYTES, 'body', true);
		title = this.sanitizeCompleteText(title, knownSecrets); body = this.sanitizeCompleteText(body, knownSecrets);
		title = this.normalizeText(title, AGENT_PR_TEXT_MAX_TITLE_BYTES, 'redacted title', false);
		body = this.normalizeText(body, AGENT_PR_TEXT_MAX_BODY_BYTES, 'redacted body', true);
		if (/[\u0000-\u001f\u007f]/u.test(title)) { throw this.error('PR text title must be a single line.'); }
		return { title, body, contentHash: digest(JSON.stringify([title, body])) };
	}

	private normalizeStoredContent(value: unknown): AgentPrTextContent {
		this.assertExactKeys(value, ['title', 'body', 'contentHash']);
		const content = this.normalizeContent({ title: (value as AgentPrTextContent).title, body: (value as AgentPrTextContent).body }, []);
		if ((value as AgentPrTextContent).contentHash !== content.contentHash) { throw this.error('Persisted PR text candidate content hash is invalid.'); }
		return content;
	}

	private sanitizeCompleteText(value: string, knownSecrets: readonly string[]): string {
		this.validateKnownSecrets(knownSecrets);
		try { return sanitizeCompleteAgentText(value, { knownSecrets }); }
		catch { throw this.error('PR text redaction failed.'); }
	}

	private sanitizeContextJSONValue(value: unknown, knownSecrets: readonly string[]): { readonly contextJSON: string; readonly contextDigest: string } {
		this.validateKnownSecrets(knownSecrets);
		const contextJSON = JSON.stringify(this.sanitizeJson(value, knownSecrets));
		if (typeof contextJSON !== 'string') { throw this.error('Sanitized PR text context is invalid.'); }
		this.normalizeText(contextJSON, MAX_CONTEXT_JSON_BYTES, 'sanitized context JSON', true);
		return { contextJSON, contextDigest: digest(contextJSON) };
	}

	private validateKnownSecrets(knownSecrets: readonly string[]): void {
		if (!Array.isArray(knownSecrets) || knownSecrets.some(secret => typeof secret !== 'string' || !secret.length || Buffer.byteLength(secret, 'utf8') > 8192)) { throw this.error('Known-secret list is invalid.'); }
	}

	private sanitizeJson(value: unknown, knownSecrets: readonly string[], depth = 0): unknown {
		if (depth > 64) { throw this.error('PR text context nesting is too deep.'); }
		if (typeof value === 'string') { return this.sanitizeCompleteText(value, knownSecrets); }
		if (Array.isArray(value)) { return value.map(item => this.sanitizeJson(item, knownSecrets, depth + 1)); }
		if (value && typeof value === 'object') {
			const result = Object.create(null) as Record<string, unknown>;
			for (const [key, item] of Object.entries(value)) {
				const sanitizedKey = this.sanitizeCompleteText(key, knownSecrets);
				if (Object.hasOwn(result, sanitizedKey)) { throw this.error('Secret sanitization produced duplicate context keys.'); }
				result[sanitizedKey] = this.sanitizeJson(item, knownSecrets, depth + 1);
			}
			return result;
		}
		return value;
	}

	private normalizeText(value: string, maxBytes: number, label: string, allowEmpty: boolean): string {
		if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value) { throw this.error(`PR text ${label} is invalid or exceeds its byte limit.`); }
		return value.replace(/\r\n?/gu, '\n');
	}

	private normalizeProvider(value: string): AgentPrTextProvider {
		if (value !== 'codex' && value !== 'claude') { throw this.error('PR text provider is invalid.'); } return value;
	}

	private assertState(value: string): AgentPrTextRequestState {
		if (!['preview', 'running', 'succeeded', 'conflicted', 'failed', 'cancelled', 'interrupted'].includes(value)) { throw this.error('Persisted PR text request state is invalid.'); }
		return value as AgentPrTextRequestState;
	}

	private assertErrorCode(value: string): AgentPrTextErrorCode {
		if (!['providerFailed', 'runnerUnavailable', 'invalidCandidate'].includes(value)) { throw this.error('Persisted PR text error code is invalid.'); } return value as AgentPrTextErrorCode;
	}

	private assertRevision(value: number, allowZero: boolean): void {
		if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) { throw this.error('PR text revision is invalid.'); }
	}

	private validatePage(after: number, limit: number, label: string): void {
		if (!Number.isSafeInteger(after) || after < 0) { throw this.error(`PR text ${label} cursor is invalid.`); }
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) { throw this.error(`PR text ${label} page size must be from 1 to ${MAX_PAGE_SIZE}.`); }
	}

	private assertUuid(value: string, label: string): void {
		if (typeof value !== 'string' || !UUID_PATTERN.test(value)) { throw this.error(`PR text ${label} is invalid.`); }
	}

	private assertExactKeys(value: unknown, required: readonly string[]): void {
		if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...required].sort().join(',')) { throw this.error('PR text input has unexpected fields.'); }
	}

	private transaction<T>(run: () => T): T {
		this.db.exec('BEGIN IMMEDIATE;');
		try { const value = run(); this.db.exec('COMMIT;'); return value; }
		catch (error) { if (this.db.isTransaction) { this.db.exec('ROLLBACK;'); } throw error; }
	}

	private error(message: string): Error { return new Error(message); }
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
