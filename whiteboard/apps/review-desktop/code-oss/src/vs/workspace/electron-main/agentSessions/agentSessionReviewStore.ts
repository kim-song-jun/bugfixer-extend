/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { AgentSessionChangeEvidenceDTO } from './agentSessionChangeEvidenceStore.js';
import { computeAgentSessionChangeHunks } from './agentSessionChangeHunks.js';
import type { AgentSessionContentFileDTO } from './agentSessionContentStore.js';
import type { AgentSessionTurnDTO } from '../../common/workspaceAgentSessionProtocol.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_CITATIONS = 20;
const MAX_CHECK_CLAIMS = 10;
const MAX_JSON_BYTES = 30 * 1024;
const MAX_PATH_BYTES = 4096;

export interface AgentSessionExplanationTarget {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly evidenceVersion: number;
	readonly evidenceFingerprint: string;
	readonly path: string;
	readonly hunkId: string | null;
}

export interface AgentSessionExplanationCitation {
	readonly kind: 'reference' | 'convention';
	readonly id: string;
	readonly version: number;
	readonly sha256: string;
}

export interface AgentSessionReportedCheck {
	readonly label: string;
	readonly outcome: 'reportedPass' | 'reportedFail' | 'notRun';
	readonly detail?: string;
}

export interface AgentSessionExplanationDTO {
	readonly id: string;
	readonly target: AgentSessionExplanationTarget;
	readonly revision: number;
	readonly turnSnapshotSha256: string;
	readonly actor: 'agent' | 'human';
	readonly authorTurnId: string | null;
	readonly status: 'draft' | 'confirmed';
	readonly what: string;
	readonly why: string;
	readonly citations: readonly AgentSessionExplanationCitation[];
	readonly grounding: 'linked' | 'unlinked';
	readonly checkClaims: readonly AgentSessionReportedCheck[];
	readonly verification: 'unverified';
	readonly createdAt: string;
}

export interface AgentSessionExplanationPage {
	readonly revisions: readonly AgentSessionExplanationDTO[];
	readonly nextRevision: number;
	readonly hasMore: boolean;
}

interface ExplanationPayload {
	readonly actor: 'agent' | 'human';
	readonly authorTurnId: string | null;
	readonly status: 'draft' | 'confirmed';
	readonly what: string;
	readonly why: string;
	readonly citations: readonly AgentSessionExplanationCitation[];
	readonly checkClaims: readonly AgentSessionReportedCheck[];
}

interface ReviewRow extends Readonly<Record<string, SQLOutputValue>> {
	readonly id: SQLOutputValue;
	readonly project_id: SQLOutputValue;
	readonly session_id: SQLOutputValue;
	readonly turn_id: SQLOutputValue;
	readonly evidence_version: SQLOutputValue;
	readonly evidence_fingerprint: SQLOutputValue;
	readonly target_path: SQLOutputValue;
	readonly hunk_id: SQLOutputValue;
	readonly revision: SQLOutputValue;
	readonly turn_snapshot_sha256: SQLOutputValue;
	readonly payload_json: SQLOutputValue;
	readonly created_at: SQLOutputValue;
}

/** Append-only main-process explanation text tied to immutable session change evidence. */
export class AgentSessionReviewStore {
	constructor(
		private readonly db: DatabaseSync,
		private readonly assertOpen: () => void,
		private readonly getTurn: (projectId: string, sessionId: string, turnId: string) => AgentSessionTurnDTO | undefined,
		private readonly getEvidence: (projectId: string, sessionId: string, turnId: string, evidenceVersion: number) => AgentSessionChangeEvidenceDTO | undefined,
		private readonly getContentFile: (input: { readonly scope: { readonly projectId: string; readonly sessionId: string; readonly turnId: string }; readonly evidenceVersion: number; readonly path: string }) => AgentSessionContentFileDTO | undefined,
	) { }

	getLatest(targetInput: AgentSessionExplanationTarget): AgentSessionExplanationDTO | undefined {
		this.assertOpen();
		const context = this.resolveTarget(targetInput, false);
		const row = this.db.prepare(`SELECT id, project_id, session_id, turn_id, evidence_version, evidence_fingerprint, target_path, hunk_id,
			revision, turn_snapshot_sha256, payload_json, created_at FROM agent_session_explanations
			WHERE project_id = ? AND session_id = ? AND turn_id = ? AND evidence_version = ? AND target_path = ? AND hunk_id = ?
			ORDER BY revision DESC LIMIT 1`).get(
			context.target.projectId, context.target.sessionId, context.target.turnId, context.target.evidenceVersion,
			context.target.path, context.hunkKey,
		) as ReviewRow | undefined;
		return row ? this.fromRow(row, context.target, context.turn) : undefined;
	}

	listRevisions(input: { readonly target: AgentSessionExplanationTarget; readonly afterRevision?: number; readonly limit?: number }): AgentSessionExplanationPage {
		this.assertOpen();
		this.assertKeys(input, ['target'], ['afterRevision', 'limit'], 'revision page');
		const context = this.resolveTarget(input.target, false);
		const afterRevision = input.afterRevision ?? 0;
		const limit = input.limit ?? 50;
		if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) { throw new Error('Review revision cursor must be a non-negative safe integer.'); }
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { throw new Error('Review revision page size must be from 1 to 100.'); }
		const rows = this.db.prepare(`SELECT id, project_id, session_id, turn_id, evidence_version, evidence_fingerprint, target_path, hunk_id,
			revision, turn_snapshot_sha256, payload_json, created_at FROM agent_session_explanations
			WHERE project_id = ? AND session_id = ? AND turn_id = ? AND evidence_version = ? AND target_path = ? AND hunk_id = ? AND revision > ?
			ORDER BY revision LIMIT ?`).all(
			context.target.projectId, context.target.sessionId, context.target.turnId, context.target.evidenceVersion,
			context.target.path, context.hunkKey, afterRevision, limit + 1,
		) as ReviewRow[];
		const hasMore = rows.length > limit;
		const revisions = rows.slice(0, limit).map(row => this.fromRow(row, context.target, context.turn));
		return { revisions, nextRevision: revisions.at(-1)?.revision ?? afterRevision, hasMore };
	}

	recordAgentExplanation(input: {
		readonly target: AgentSessionExplanationTarget;
		readonly authorTurnId: string;
		readonly expectedLatestRevision: number;
		readonly what: string;
		readonly why: string;
		readonly citations: readonly AgentSessionExplanationCitation[];
		readonly checkClaims: readonly AgentSessionReportedCheck[];
	}): AgentSessionExplanationDTO {
		this.assertOpen();
		this.assertKeys(input, ['target', 'authorTurnId', 'expectedLatestRevision', 'what', 'why', 'citations', 'checkClaims'], [], 'agent explanation');
		this.preflightPayload(input.what, input.why, input.citations, input.checkClaims);
		const target = this.resolveTarget(input.target, true);
		if (!UUID_PATTERN.test(input.authorTurnId)) { throw new Error('Agent explanation author turn ID must be a UUID.'); }
		const authorTurn = this.getTurn(target.target.projectId, target.target.sessionId, input.authorTurnId);
		if (!authorTurn) { throw new Error('Agent explanation author turn must belong to the target session.'); }
		const payload = this.normalizePayload({
			actor: 'agent', authorTurnId: input.authorTurnId, status: 'draft',
			what: input.what, why: input.why, citations: input.citations, checkClaims: input.checkClaims,
		}, target.turn);
		return this.append(target, input.expectedLatestRevision, payload);
	}

	/** A human confirmation approves only this explanation text; it does not approve a merge or publication. */
	recordHumanExplanation(input: {
		readonly target: AgentSessionExplanationTarget;
		readonly expectedLatestRevision: number;
		readonly what: string;
		readonly why: string;
		readonly citations: readonly AgentSessionExplanationCitation[];
		readonly checkClaims: readonly AgentSessionReportedCheck[];
		readonly status: 'draft' | 'confirmed';
	}): AgentSessionExplanationDTO {
		this.assertOpen();
		this.assertKeys(input, ['target', 'expectedLatestRevision', 'what', 'why', 'citations', 'checkClaims', 'status'], [], 'human explanation');
		this.preflightPayload(input.what, input.why, input.citations, input.checkClaims);
		const target = this.resolveTarget(input.target, true);
		if (input.status !== 'draft' && input.status !== 'confirmed') { throw new Error('Human explanation status must be draft or confirmed.'); }
		const payload = this.normalizePayload({
			actor: 'human', authorTurnId: null, status: input.status,
			what: input.what, why: input.why, citations: input.citations, checkClaims: input.checkClaims,
		}, target.turn);
		return this.append(target, input.expectedLatestRevision, payload);
	}

	private append(target: ReturnType<AgentSessionReviewStore['resolveTarget']>, expectedLatestRevision: number, payload: ExplanationPayload): AgentSessionExplanationDTO {
		if (!Number.isSafeInteger(expectedLatestRevision) || expectedLatestRevision < 0) { throw new Error('Expected review revision must be a non-negative safe integer.'); }
		const payloadJson = JSON.stringify(payload);
		if (Buffer.byteLength(payloadJson, 'utf8') > MAX_JSON_BYTES) { throw new Error('Review explanation exceeds 30 KiB.'); }
		const payloadFingerprint = digest(payloadJson);
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const latestRow = this.db.prepare(`SELECT id, project_id, session_id, turn_id, evidence_version, evidence_fingerprint, target_path, hunk_id,
				revision, turn_snapshot_sha256, payload_json, created_at FROM agent_session_explanations
				WHERE project_id = ? AND session_id = ? AND turn_id = ? AND evidence_version = ? AND target_path = ? AND hunk_id = ?
				ORDER BY revision DESC LIMIT 1`).get(
				target.target.projectId, target.target.sessionId, target.target.turnId, target.target.evidenceVersion,
				target.target.path, target.hunkKey,
			) as ReviewRow | undefined;
			const latestRevision = latestRow ? Number(latestRow.revision) : 0;
			if (latestRevision === expectedLatestRevision + 1 && latestRow && digest(String(latestRow.payload_json)) === payloadFingerprint) {
				const existing = this.fromRow(latestRow, target.target, target.turn);
				this.db.exec('COMMIT');
				return existing;
			}
			if (latestRevision !== expectedLatestRevision) { throw new Error('Review revision cursor is stale.'); }
			const revision = latestRevision + 1;
			const id = randomUUID();
			const createdAt = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_session_explanations
				(id, project_id, session_id, turn_id, evidence_version, evidence_fingerprint, target_path, hunk_id, revision, turn_snapshot_sha256, payload_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				id, target.target.projectId, target.target.sessionId, target.target.turnId, target.target.evidenceVersion,
				target.evidence.fingerprint, target.target.path, target.hunkKey, revision, target.turn.snapshotSha256, payloadJson, createdAt,
			);
			const inserted = this.db.prepare(`SELECT id, project_id, session_id, turn_id, evidence_version, evidence_fingerprint, target_path, hunk_id,
				revision, turn_snapshot_sha256, payload_json, created_at FROM agent_session_explanations WHERE id = ?`).get(id) as ReviewRow | undefined;
			if (!inserted) { throw new Error('Persisted review revision could not be read back.'); }
			const dto = this.fromRow(inserted, target.target, target.turn);
			this.db.exec('COMMIT');
			return dto;
		} catch (error) {
			try { this.db.exec('ROLLBACK'); } catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Review revision write and rollback both failed.'); }
			throw error;
		}
	}

	private resolveTarget(targetInput: AgentSessionExplanationTarget, validateHunk: boolean): {
		readonly target: AgentSessionExplanationTarget;
		readonly hunkKey: string;
		readonly turn: AgentSessionTurnDTO;
		readonly evidence: AgentSessionChangeEvidenceDTO;
	} {
		const target = this.normalizeTarget(targetInput);
		const turn = this.getTurn(target.projectId, target.sessionId, target.turnId);
		if (!turn) { throw new Error('Review target does not identify a durable turn.'); }
		const evidence = this.getEvidence(target.projectId, target.sessionId, target.turnId, target.evidenceVersion);
		if (!evidence || evidence.fingerprint !== target.evidenceFingerprint || evidence.turnSnapshotSha256 !== turn.snapshotSha256) {
			throw new Error('Review target does not match the exact immutable change evidence and turn snapshot.');
		}
		if (!evidence.files.some(file => file.path === target.path)) { throw new Error('Review target path is not part of this change evidence version.'); }
		if (target.hunkId !== null && !SHA256_PATTERN.test(target.hunkId)) { throw new Error('Review hunk ID must be a SHA-256 digest.'); }
		if (validateHunk && target.hunkId !== null) {
			const file = this.getContentFile({
				scope: { projectId: target.projectId, sessionId: target.sessionId, turnId: target.turnId },
				evidenceVersion: target.evidenceVersion, path: target.path,
			});
			if (!file || file.evidenceFingerprint !== target.evidenceFingerprint || file.path !== target.path
				|| file.scope.projectId !== target.projectId || file.scope.sessionId !== target.sessionId || file.scope.turnId !== target.turnId) {
				throw new Error('Review hunk has no exact retained before/after content.');
			}
			const hunks = computeAgentSessionChangeHunks(file);
			if (hunks.timedOut) { throw new Error('Review hunk computation timed out. Retry against the same retained evidence.'); }
			if (!hunks.hunks.some(hunk => hunk.id === target.hunkId)) { throw new Error('Review hunk ID is not present in the exact retained file content.'); }
		}
		return { target, hunkKey: target.hunkId ?? '', turn, evidence };
	}

	private normalizeTarget(value: AgentSessionExplanationTarget): AgentSessionExplanationTarget {
		this.assertKeys(value, ['projectId', 'sessionId', 'turnId', 'evidenceVersion', 'evidenceFingerprint', 'path', 'hunkId'], [], 'review target');
		if (!UUID_PATTERN.test(value.projectId) || !UUID_PATTERN.test(value.sessionId) || !UUID_PATTERN.test(value.turnId)) { throw new Error('Review target scope must contain UUIDs.'); }
		if (!Number.isSafeInteger(value.evidenceVersion) || value.evidenceVersion < 1) { throw new Error('Review evidence version must be a positive safe integer.'); }
		if (typeof value.evidenceFingerprint !== 'string' || !SHA256_PATTERN.test(value.evidenceFingerprint)) { throw new Error('Review evidence fingerprint must be a SHA-256 digest.'); }
		if (typeof value.path !== 'string' || Buffer.byteLength(value.path, 'utf8') < 1 || Buffer.byteLength(value.path, 'utf8') > MAX_PATH_BYTES
			|| value.path.includes('\0') || value.path.includes('\\') || value.path.startsWith('/')
			|| value.path.split('/').some(part => !part || part === '.' || part === '..')) { throw new Error('Review target path must be a safe root-relative path.'); }
		if (value.hunkId !== null && (typeof value.hunkId !== 'string' || !SHA256_PATTERN.test(value.hunkId))) { throw new Error('Review hunk ID must be null or a SHA-256 digest.'); }
		return Object.freeze({
			projectId: value.projectId, sessionId: value.sessionId, turnId: value.turnId,
			evidenceVersion: value.evidenceVersion, evidenceFingerprint: value.evidenceFingerprint,
			path: value.path, hunkId: value.hunkId,
		});
	}

	private normalizePayload(input: ExplanationPayload, turn: AgentSessionTurnDTO): ExplanationPayload {
		this.assertKeys(input, ['actor', 'authorTurnId', 'status', 'what', 'why', 'citations', 'checkClaims'], [], 'review payload');
		const what = this.requiredText(input.what, 'What changed', 4 * 1024);
		const why = this.requiredText(input.why, 'Why it changed', 8 * 1024);
		if (!Array.isArray(input.citations) || input.citations.length > MAX_CITATIONS) { throw new Error('A review may cite at most 20 exact reference or convention versions.'); }
		const allowedCitations = [
			...(turn.snapshot.convention ? [{ kind: 'convention' as const, ...turn.snapshot.convention }] : []),
			...turn.snapshot.references.map(reference => ({ kind: 'reference' as const, ...reference })),
		];
		const citations = input.citations.map(candidate => {
			this.assertKeys(candidate, ['kind', 'id', 'version', 'sha256'], [], 'review citation');
			if ((candidate.kind !== 'reference' && candidate.kind !== 'convention') || !UUID_PATTERN.test(candidate.id)
				|| !Number.isSafeInteger(candidate.version) || candidate.version < 1 || !SHA256_PATTERN.test(candidate.sha256)) {
				throw new Error('Review citation must identify an exact selected reference or convention version.');
			}
			if (!allowedCitations.some(item => item.kind === candidate.kind && item.id === candidate.id && item.version === candidate.version && item.sha256 === candidate.sha256)) {
				throw new Error('Review citation is not present in the target turn knowledge snapshot.');
			}
			return Object.freeze({ kind: candidate.kind, id: candidate.id, version: candidate.version, sha256: candidate.sha256 });
		}).sort((left, right) => compareCodeUnits(`${left.kind}\0${left.id}\0${left.version}\0${left.sha256}`, `${right.kind}\0${right.id}\0${right.version}\0${right.sha256}`));
		if (new Set(citations.map(item => `${item.kind}\0${item.id}\0${item.version}\0${item.sha256}`)).size !== citations.length) { throw new Error('Review citations cannot contain duplicates.'); }
		if (!Array.isArray(input.checkClaims) || input.checkClaims.length > MAX_CHECK_CLAIMS) { throw new Error('A review may contain at most 10 reported check claims.'); }
		const checkClaims = input.checkClaims.map(candidate => {
			this.assertKeys(candidate, ['label', 'outcome'], ['detail'], 'reported check claim');
			const label = this.requiredText(candidate.label, 'Check label', 256);
			const detail = candidate.detail === undefined ? '' : this.optionalText(candidate.detail, 'Check detail', 1024);
			if (!['reportedPass', 'reportedFail', 'notRun'].includes(candidate.outcome)) { throw new Error('Reported check outcome is invalid.'); }
			return Object.freeze({ label, outcome: candidate.outcome, detail });
		});
		if (input.actor !== 'agent' && input.actor !== 'human') { throw new Error('Review actor must be assigned by the trusted recording method.'); }
		if (input.actor === 'agent' && (typeof input.authorTurnId !== 'string' || !UUID_PATTERN.test(input.authorTurnId) || input.status !== 'draft')) {
			throw new Error('Agent explanations require an author turn and always remain drafts.');
		}
		if (input.actor === 'human' && (input.authorTurnId !== null || (input.status !== 'draft' && input.status !== 'confirmed'))) {
			throw new Error('Human review status must be draft or confirmed without an agent author turn.');
		}
		return Object.freeze({
			actor: input.actor, authorTurnId: input.authorTurnId, status: input.status,
			what, why, citations: Object.freeze(citations), checkClaims: Object.freeze(checkClaims),
		});
	}

	private fromRow(row: ReviewRow, target: AgentSessionExplanationTarget, turn: AgentSessionTurnDTO): AgentSessionExplanationDTO {
		const payload = this.normalizePayload(JSON.parse(String(row.payload_json)) as ExplanationPayload, turn);
		const persistedTarget = {
			projectId: String(row.project_id), sessionId: String(row.session_id), turnId: String(row.turn_id),
			evidenceVersion: Number(row.evidence_version), evidenceFingerprint: String(row.evidence_fingerprint),
			path: String(row.target_path), hunkId: String(row.hunk_id) || null,
		};
		if (JSON.stringify(persistedTarget) !== JSON.stringify(target) || String(row.evidence_fingerprint) !== target.evidenceFingerprint
			|| String(row.turn_snapshot_sha256) !== turn.snapshotSha256 || !UUID_PATTERN.test(String(row.id)) || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1) {
			throw new Error('Stored review revision does not match the requested immutable target and turn snapshot.');
		}
		return Object.freeze({
			id: String(row.id), target: Object.freeze(persistedTarget), revision: Number(row.revision),
			turnSnapshotSha256: String(row.turn_snapshot_sha256), ...payload,
			grounding: payload.citations.length ? 'linked' : 'unlinked', verification: 'unverified',
			createdAt: String(row.created_at),
		});
	}

	private requiredText(value: unknown, name: string, maxBytes: number): string {
		if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
			throw new Error(`${name} must be non-empty, NUL-free UTF-8 within ${maxBytes} bytes.`);
		}
		return value;
	}

	private optionalText(value: unknown, name: string, maxBytes: number): string {
		if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
			throw new Error(`${name} must be NUL-free UTF-8 within ${maxBytes} bytes.`);
		}
		return value;
	}

	private preflightPayload(what: unknown, why: unknown, citations: unknown, checkClaims: unknown): void {
		this.requiredText(what, 'What changed', 4 * 1024);
		this.requiredText(why, 'Why it changed', 8 * 1024);
		if (!Array.isArray(citations) || citations.length > MAX_CITATIONS || !Array.isArray(checkClaims) || checkClaims.length > MAX_CHECK_CLAIMS) {
			throw new Error('Review explanation exceeds the citation or check-claim count limit.');
		}
		const serialized = JSON.stringify({ what, why, citations, checkClaims });
		if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) { throw new Error('Review explanation exceeds 30 KiB.'); }
	}

	private assertKeys(value: unknown, required: readonly string[], optional: readonly string[], name: string): asserts value is Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`${name} must be an object.`); }
		const keys = Object.keys(value);
		if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) {
			throw new Error(`${name} contains missing or unknown fields.`);
		}
	}
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
