/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { AgentSessionTurnDTO } from '../../common/workspaceAgentSessionProtocol.js';
import {
	compareAgentSessionContentSnapshots,
	validateAgentSessionContentSnapshot,
	type AgentSessionContentFile,
	type AgentSessionContentMetadata,
	type AgentSessionContentRootIdentity,
	type AgentSessionContentSnapshot,
} from './agentSessionContentCapture.js';
import type { AgentSessionChangeEvidenceDTO, AgentSessionChangeFileObservation } from './agentSessionChangeEvidenceStore.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_REASON_BYTES = 1024;
const TEMPORAL_ATTRIBUTION_NOTE = '이 기록은 턴 전후 시점의 파일 상태만 비교하며, 변경 작성자를 증명하지 않습니다.';

export interface AgentSessionContentScope {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
}

const RECONCILE_PAGE_SIZE = 100;
const RECONCILED_CAPTURE_REASON = 'The application stopped before it could retain an after-turn content snapshot.';
const MAX_PATH_BYTES = 4096;

export interface AgentSessionContentBaselineDTO {
	readonly scope: AgentSessionContentScope;
	readonly turnSnapshotSha256: string;
	readonly source: 'ordinaryFolder' | 'managedWorktree';
	readonly managedWorktreeOwnerId: string | null;
	readonly folderIdentity: AgentSessionContentRootIdentity;
	readonly capturedAt: string;
	readonly revision: string | null;
	readonly fingerprint: string;
	readonly entryCount: number;
	readonly fileBytes: number;
	readonly retainedTextBytes: number;
	readonly contentCoverage: 'complete' | 'partial';
}

export interface AgentSessionContentFinalDTO extends AgentSessionContentBaselineDTO {
	readonly evidenceVersion: number;
	readonly status: 'observed' | 'unverified';
	readonly coverage: 'complete' | 'partial';
	readonly missingReason: string | null;
	readonly beforeFingerprint: string | null;
	readonly afterFingerprint: string | null;
	readonly revision: string | null;
	readonly attributionNote: string;
}

export interface AgentSessionContentFileDTO {
	readonly scope: AgentSessionContentScope;
	readonly evidenceVersion: number;
	readonly path: string;
	readonly evidenceFingerprint: string;
	readonly before: AgentSessionContentFileSideDTO;
	readonly after: AgentSessionContentFileSideDTO;
}

export type AgentSessionContentFileSideDTO = { readonly state: 'absent' } | { readonly state: 'text'; readonly file: AgentSessionContentPublicFile } | { readonly state: 'unavailable'; readonly file?: AgentSessionContentPublicFile; readonly reason: string };
export type AgentSessionContentPublicFile = Omit<AgentSessionContentFile, 'rawBytesBase64'>;

export type AgentSessionRawContentFileSide =
	| { readonly state: 'absent' }
	| { readonly state: 'unavailable'; readonly reason: string }
	| { readonly state: 'retained'; readonly mode: '100644' | '100755' | '120000'; readonly size: number; readonly sha256: string; readonly bytes: Uint8Array };

export interface AgentSessionRawContentFileDTO {
	readonly scope: AgentSessionContentScope;
	readonly evidenceVersion: number;
	readonly path: string;
	readonly evidenceFingerprint: string;
	readonly before: AgentSessionRawContentFileSide;
	readonly after: AgentSessionRawContentFileSide;
}

interface SnapshotRow {
	readonly project_id: SQLOutputValue;
	readonly session_id: SQLOutputValue;
	readonly turn_id: SQLOutputValue;
	readonly turn_snapshot_sha256: SQLOutputValue;
	readonly source: SQLOutputValue;
	readonly managed_worktree_owner_id: SQLOutputValue;
	readonly canonical_path: SQLOutputValue;
	readonly folder_dev: SQLOutputValue;
	readonly folder_ino: SQLOutputValue;
	readonly captured_at: SQLOutputValue;
	readonly revision: SQLOutputValue;
	readonly fingerprint: SQLOutputValue;
	readonly evidence_fingerprint?: SQLOutputValue;
	readonly evidence_json?: SQLOutputValue;
	readonly snapshot_json: SQLOutputValue;
	readonly evidence_version?: SQLOutputValue;
	readonly status?: SQLOutputValue;
	readonly coverage?: SQLOutputValue;
	readonly missing_reason?: SQLOutputValue;
	readonly before_fingerprint?: SQLOutputValue;
	readonly after_fingerprint?: SQLOutputValue;
}

interface EvidenceInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly expectedLatestVersion: number;
	readonly folderIdentity: AgentSessionContentRootIdentity;
	readonly capturedAt: string;
	readonly beforeRevision: string | null;
	readonly afterRevision: string | null;
	readonly status: 'observed' | 'unverified';
	readonly coverage: 'complete' | 'partial';
	readonly missingReason: string | null;
	readonly attribution: 'unknown';
	readonly attributionNote: null;
	readonly files: readonly AgentSessionChangeFileObservation[];
}

export class AgentSessionContentStore {
	constructor(
		private readonly db: DatabaseSync,
		private readonly assertOpen: () => void,
		private readonly getTurn: (projectId: string, sessionId: string, turnId: string) => AgentSessionTurnDTO | undefined,
		private readonly recordChangeEvidence: (input: EvidenceInput) => AgentSessionChangeEvidenceDTO,
	) { }

	recordBaseline(input: { readonly scope: AgentSessionContentScope; readonly snapshot: AgentSessionContentSnapshot; readonly revision: string | null }): AgentSessionContentBaselineDTO {
		this.assertOpen();
		this.assertExactKeys(input, ['scope', 'snapshot', 'revision'], 'baseline input');
		const scope = this.normalizeScope(input.scope);
		const snapshot = validateAgentSessionContentSnapshot(input.snapshot);
		const revision = this.normalizeRevision(input.revision, 'before');
		const turn = this.requireTurn(scope);
		this.assertFolder(snapshot.folderIdentity, turn);
		const fingerprint = digest(JSON.stringify(snapshot));
		const json = JSON.stringify(snapshot);
		return this.transaction(() => {
			const existing = this.getBaselineRow(scope);
			if (existing) {
				if (String(existing.fingerprint) !== fingerprint || String(existing.snapshot_json) !== json || existing.revision !== revision) { throw new Error('Agent-session content baseline is immutable and already exists with a different payload.'); }
				return this.baselineFromRow(existing);
			}
			const currentTurn = this.requireTurn(scope);
			if (currentTurn.state !== 'starting') { throw new Error('A before-content baseline may only be captured for a durable starting turn.'); }
			this.db.prepare(`INSERT INTO agent_session_content_baselines
				(project_id, session_id, turn_id, turn_snapshot_sha256, source, managed_worktree_owner_id, canonical_path, folder_dev, folder_ino, captured_at, revision, fingerprint, snapshot_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				scope.projectId, scope.sessionId, scope.turnId, currentTurn.snapshotSha256, currentTurn.snapshot.managedWorktreeOwnerId === null ? 'ordinaryFolder' : 'managedWorktree',
				currentTurn.snapshot.managedWorktreeOwnerId, snapshot.folderIdentity.canonicalPath, snapshot.folderIdentity.dev, snapshot.folderIdentity.ino,
				snapshot.capturedAt, revision, fingerprint, json,
			);
			return this.baselineFromRow(this.getBaselineRow(scope)!);
		});
	}

	getBaseline(scopeInput: AgentSessionContentScope): AgentSessionContentBaselineDTO | undefined {
		this.assertOpen();
		const scope = this.normalizeScope(scopeInput);
		this.requireTurn(scope);
		const row = this.getBaselineRow(scope);
		return row ? this.baselineFromRow(row) : undefined;
	}

	/** Main-process service callback after actual PTY cleanup; the durable turn may still be running until the service commits its terminal transition. */
	recordAfter(input: { readonly scope: AgentSessionContentScope; readonly snapshot: AgentSessionContentSnapshot; readonly expectedLatestVersion: number; readonly revision: string | null; readonly cleanupVerified: boolean }): AgentSessionContentFinalDTO {
		this.assertOpen();
		this.assertExactKeys(input, ['scope', 'snapshot', 'expectedLatestVersion', 'revision', 'cleanupVerified'], 'after input');
		if (input.cleanupVerified !== true) { throw new Error('An after-content snapshot requires an explicit trusted provider-cleanup receipt.'); }
		const scope = this.normalizeScope(input.scope);
		const snapshot = validateAgentSessionContentSnapshot(input.snapshot);
		const revision = this.normalizeRevision(input.revision, 'after');
		const baseline = this.getBaselineRow(scope);
		if (!baseline) { throw new Error('An after snapshot cannot establish a missing before baseline.'); }
		const turn = this.requireTurn(scope);
		this.assertFolder(snapshot.folderIdentity, turn);
		return this.transaction(() => {
			const before = this.readSnapshot(String(baseline.snapshot_json));
			const comparison = compareAgentSessionContentSnapshots(before, snapshot);
			const afterJson = JSON.stringify(snapshot);
			const currentVersion = this.latestVersion(scope);
			if (currentVersion === input.expectedLatestVersion + 1) {
				const existing = this.getFinalRow(scope, currentVersion);
				if (existing?.status === 'observed' && String(existing.snapshot_json) === afterJson && existing.revision === revision) { return this.finalFromRow(existing); }
				throw new Error('Content evidence append cursor is stale.');
			}
			if (currentVersion !== input.expectedLatestVersion) { throw new Error('Content evidence append cursor is stale.'); }
			const files: AgentSessionChangeFileObservation[] = [];
			let metadataTruncated = comparison.truncated;
			for (const change of comparison.changes) {
				const observation: AgentSessionChangeFileObservation = {
					path: change.path, change: change.change,
					before: change.before ? this.metadata(change.before) : null,
					after: change.after ? this.metadata(change.after) : null,
				};
				if (Buffer.byteLength(JSON.stringify([...files, observation]), 'utf8') > 60 * 1024) { metadataTruncated = true; break; }
				files.push(observation);
			}
			const partial = comparison.inventoryCoverage !== 'complete' || metadataTruncated;
			const missingReason = partial ? 'Changed file metadata exceeded the file-count or byte limit.' : null;
			const evidence = this.recordChangeEvidence({
				...scope, expectedLatestVersion: input.expectedLatestVersion, folderIdentity: snapshot.folderIdentity, capturedAt: snapshot.capturedAt,
				beforeRevision: baseline.revision as string | null, afterRevision: revision, status: 'observed', coverage: partial ? 'partial' : 'complete', missingReason,
				attribution: 'unknown', attributionNote: null, files,
			});
			this.db.prepare(`INSERT INTO agent_session_content_finals
				(project_id, session_id, turn_id, evidence_version, turn_snapshot_sha256, source, managed_worktree_owner_id, canonical_path, folder_dev, folder_ino, captured_at, revision, fingerprint, status, coverage, missing_reason, before_fingerprint, after_fingerprint, snapshot_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', ?, ?, ?, ?, ?)`).run(
				scope.projectId, scope.sessionId, scope.turnId, evidence.version, turn.snapshotSha256,
				turn.snapshot.managedWorktreeOwnerId === null ? 'ordinaryFolder' : 'managedWorktree', turn.snapshot.managedWorktreeOwnerId,
				snapshot.folderIdentity.canonicalPath, snapshot.folderIdentity.dev, snapshot.folderIdentity.ino, snapshot.capturedAt, revision,
				digest(afterJson), partial ? 'partial' : 'complete', missingReason, String(baseline.fingerprint), digest(afterJson), afterJson,
			);
			return this.finalFromRow(this.getFinalRow(scope, evidence.version)!);
		});
	}

	/** Reconciles interrupted post-cleanup captures using retained metadata only; it never reads project files. */
	reconcileInterruptedCaptures(): number {
		this.assertOpen();
		let cursor = '';
		let repaired = 0;
		while (true) {
			const rows = this.db.prepare(`SELECT b.project_id, b.session_id, b.turn_id
				FROM agent_session_content_baselines b
				JOIN agent_session_turns t ON t.id = b.turn_id AND t.project_id = b.project_id AND t.session_id = b.session_id
				LEFT JOIN agent_session_content_finals f ON f.turn_id = b.turn_id
				WHERE t.state IN ('exited', 'failed', 'cancelled', 'interrupted') AND f.turn_id IS NULL AND b.turn_id > ?
				ORDER BY b.turn_id LIMIT ?`).all(cursor, RECONCILE_PAGE_SIZE) as Array<{ readonly project_id: SQLOutputValue; readonly session_id: SQLOutputValue; readonly turn_id: SQLOutputValue }>;
			if (rows.length === 0) { break; }
			for (const row of rows) {
				const scope = { projectId: String(row.project_id), sessionId: String(row.session_id), turnId: String(row.turn_id) };
				this.recordUnavailable({ scope, capturedAt: new Date().toISOString(), expectedLatestVersion: this.latestVersion(scope), reason: RECONCILED_CAPTURE_REASON });
				cursor = scope.turnId;
				repaired++;
			}
		}
		return repaired;
	}

	recordUnavailable(input: { readonly scope: AgentSessionContentScope; readonly capturedAt: string; readonly expectedLatestVersion: number; readonly reason: string }): AgentSessionContentFinalDTO {
		this.assertOpen();
		this.assertExactKeys(input, ['scope', 'capturedAt', 'expectedLatestVersion', 'reason'], 'unavailable input');
		const scope = this.normalizeScope(input.scope);
		this.validateTimestamp(input.capturedAt);
		const reason = this.normalizeReason(input.reason);
		const turn = this.requireTurn(scope);
		const baseline = this.getBaselineRow(scope);
		return this.transaction(() => {
			const unavailableFingerprint = digest(JSON.stringify({ scope, evidenceVersion: input.expectedLatestVersion + 1, reason, capturedAt: input.capturedAt }));
			const currentVersion = this.latestVersion(scope);
			if (currentVersion === input.expectedLatestVersion + 1) {
				const existing = this.getFinalRow(scope, currentVersion);
				if (existing?.status === 'unverified' && String(existing.missing_reason) === reason && String(existing.captured_at) === input.capturedAt && String(existing.fingerprint) === unavailableFingerprint) {
					return this.finalFromRow(existing);
				}
				throw new Error('Content evidence append cursor is stale.');
			}
			if (currentVersion !== input.expectedLatestVersion) { throw new Error('Content evidence append cursor is stale.'); }
			const evidence = this.recordChangeEvidence({
				...scope, expectedLatestVersion: input.expectedLatestVersion, folderIdentity: turn.snapshot.folderIdentity, capturedAt: input.capturedAt,
				beforeRevision: baseline ? baseline.revision as string | null : null, afterRevision: null, status: 'unverified', coverage: 'partial', missingReason: reason,
				attribution: 'unknown', attributionNote: null, files: [],
			});
			this.db.prepare(`INSERT INTO agent_session_content_finals
				(project_id, session_id, turn_id, evidence_version, turn_snapshot_sha256, source, managed_worktree_owner_id, canonical_path, folder_dev, folder_ino, captured_at, revision, fingerprint, status, coverage, missing_reason, before_fingerprint, after_fingerprint, snapshot_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'unverified', 'partial', ?, ?, NULL, NULL)`).run(
				scope.projectId, scope.sessionId, scope.turnId, evidence.version, turn.snapshotSha256,
				turn.snapshot.managedWorktreeOwnerId === null ? 'ordinaryFolder' : 'managedWorktree', turn.snapshot.managedWorktreeOwnerId,
				turn.snapshot.folderIdentity.canonicalPath, turn.snapshot.folderIdentity.dev, turn.snapshot.folderIdentity.ino,
				input.capturedAt, digest(JSON.stringify({ scope, evidenceVersion: evidence.version, reason, capturedAt: input.capturedAt })), reason,
				baseline ? String(baseline.fingerprint) : null,
			);
			return this.finalFromRow(this.getFinalRow(scope, evidence.version)!);
		});
	}

	getFile(input: { readonly scope: AgentSessionContentScope; readonly evidenceVersion: number; readonly path: string }): AgentSessionContentFileDTO | undefined {
		this.assertOpen();
		this.assertExactKeys(input, ['scope', 'evidenceVersion', 'path'], 'file query');
		const scope = this.normalizeScope(input.scope);
		this.requireTurn(scope);
		if (!Number.isSafeInteger(input.evidenceVersion) || input.evidenceVersion < 1) { throw new Error('Content evidence version must be a positive safe integer.'); }
		if (typeof input.path !== 'string' || Buffer.byteLength(input.path, 'utf8') > MAX_PATH_BYTES || !isSafeRelativePath(input.path)) { throw new Error('Content evidence path must be a safe root-relative path of at most 4096 UTF-8 bytes.'); }
		const final = this.getFinalRow(scope, input.evidenceVersion);
		const metadataOnly = final
			? { fingerprint: final.evidence_fingerprint, evidence_json: final.evidence_json }
			: this.db.prepare(`SELECT fingerprint, evidence_json FROM agent_session_change_evidence
				WHERE project_id = ? AND session_id = ? AND turn_id = ? AND version = ?`).get(scope.projectId, scope.sessionId, scope.turnId, input.evidenceVersion) as { readonly fingerprint: SQLOutputValue; readonly evidence_json: SQLOutputValue } | undefined;
		if (!final && !metadataOnly) { return undefined; }
		const baseline = this.getBaselineRow(scope);
		const metadataCapturedAt = metadataOnly ? (JSON.parse(String(metadataOnly.evidence_json)) as { readonly capturedAt?: unknown }).capturedAt : undefined;
		const baselinePredatesMetadataEvidence = typeof metadataCapturedAt === 'string' && baseline !== undefined && String(baseline.captured_at) < metadataCapturedAt;
		const beforeSnapshot = baseline && (final !== undefined || baselinePredatesMetadataEvidence) ? this.readSnapshot(String(baseline.snapshot_json)) : undefined;
		const afterSnapshot = final?.snapshot_json === null || !final ? undefined : this.readSnapshot(String(final.snapshot_json));
		return {
			scope, evidenceVersion: input.evidenceVersion, path: input.path, evidenceFingerprint: String(metadataOnly?.fingerprint),
			before: beforeSnapshot ? this.fileState(beforeSnapshot.entries.find(entry => entry.path === input.path)) : { state: 'unavailable', reason: 'No durable before snapshot was retained.' },
			after: afterSnapshot ? this.fileState(afterSnapshot.entries.find(entry => entry.path === input.path)) : { state: 'unavailable', reason: String(final?.missing_reason ?? 'This metadata-only evidence version has no retained after-content snapshot.') },
		};
	}

	/** Main-process-only retained bytes for Git preview. Never used to read the live filesystem. */
	getRawEntry(input: { readonly scope: AgentSessionContentScope; readonly evidenceVersion: number; readonly path: string; readonly evidenceFingerprint: string }): AgentSessionRawContentFileDTO | undefined {
		this.assertOpen();
		this.assertExactKeys(input, ['scope', 'evidenceVersion', 'path', 'evidenceFingerprint'], 'raw file query');
		const result = this.getFile({ scope: input.scope, evidenceVersion: input.evidenceVersion, path: input.path });
		if (!result) { return undefined; }
		if (result.evidenceFingerprint !== input.evidenceFingerprint) { throw new Error('Raw content evidence fingerprint does not match the selected immutable version.'); }
		const beforeSnapshot = this.snapshotForSide(input.scope, input.evidenceVersion, true);
		const afterSnapshot = this.snapshotForSide(input.scope, input.evidenceVersion, false);
		return Object.freeze({
			scope: result.scope, evidenceVersion: result.evidenceVersion, path: result.path, evidenceFingerprint: result.evidenceFingerprint,
			before: beforeSnapshot ? this.rawFileState(beforeSnapshot.entries.find(entry => entry.path === input.path)) : result.before.state === 'unavailable' ? { state: 'unavailable' as const, reason: result.before.reason } : { state: 'absent' as const },
			after: afterSnapshot ? this.rawFileState(afterSnapshot.entries.find(entry => entry.path === input.path)) : result.after.state === 'unavailable' ? { state: 'unavailable' as const, reason: result.after.reason } : { state: 'absent' as const },
		});
	}

	private normalizeScope(value: AgentSessionContentScope): AgentSessionContentScope {
		if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'projectId,sessionId,turnId'
			|| !UUID_PATTERN.test(value.projectId) || !UUID_PATTERN.test(value.sessionId) || !UUID_PATTERN.test(value.turnId)) {
			throw new Error('Agent-session content scope must contain exact project, session, and turn UUIDs.');
		}
		return { projectId: value.projectId, sessionId: value.sessionId, turnId: value.turnId };
	}

	private requireTurn(scope: AgentSessionContentScope): AgentSessionTurnDTO {
		const turn = this.getTurn(scope.projectId, scope.sessionId, scope.turnId);
		if (!turn) { throw new Error('Agent-session content scope does not identify a durable turn.'); }
		return turn;
	}

	private assertFolder(identity: AgentSessionContentRootIdentity, turn: AgentSessionTurnDTO): void {
		if (identity.canonicalPath !== turn.snapshot.folderIdentity.canonicalPath || identity.dev !== turn.snapshot.folderIdentity.dev || identity.ino !== turn.snapshot.folderIdentity.ino) {
			throw new Error('Agent-session content folder identity must match the durable turn snapshot.');
		}
	}

	private latestVersion(scope: AgentSessionContentScope): number {
		const row = this.db.prepare('SELECT MAX(version) AS version FROM agent_session_change_evidence WHERE project_id = ? AND session_id = ? AND turn_id = ?').get(scope.projectId, scope.sessionId, scope.turnId);
		return Number(row?.version ?? 0);
	}

	private getBaselineRow(scope: AgentSessionContentScope): SnapshotRow | undefined {
		return this.db.prepare(`SELECT project_id, session_id, turn_id, turn_snapshot_sha256, source, managed_worktree_owner_id, canonical_path, folder_dev, folder_ino, captured_at, revision, fingerprint, snapshot_json
			FROM agent_session_content_baselines WHERE project_id = ? AND session_id = ? AND turn_id = ?`).get(scope.projectId, scope.sessionId, scope.turnId) as SnapshotRow | undefined;
	}

	private getFinalRow(scope: AgentSessionContentScope, version: number): SnapshotRow | undefined {
		return this.db.prepare(`SELECT f.project_id, f.session_id, f.turn_id, f.turn_snapshot_sha256, f.source, f.managed_worktree_owner_id, f.canonical_path, f.folder_dev, f.folder_ino, f.captured_at, f.revision, f.fingerprint, f.snapshot_json, f.evidence_version, f.status, f.coverage, f.missing_reason, f.before_fingerprint, f.after_fingerprint,
			e.fingerprint AS evidence_fingerprint, e.evidence_json AS evidence_json
			FROM agent_session_content_finals f JOIN agent_session_change_evidence e ON e.project_id = f.project_id AND e.session_id = f.session_id AND e.turn_id = f.turn_id AND e.version = f.evidence_version
			WHERE f.project_id = ? AND f.session_id = ? AND f.turn_id = ? AND f.evidence_version = ?`).get(scope.projectId, scope.sessionId, scope.turnId, version) as SnapshotRow | undefined;
	}

	private baselineFromRow(row: SnapshotRow): AgentSessionContentBaselineDTO {
		const snapshot = this.readSnapshot(String(row.snapshot_json));
		return {
			scope: { projectId: String(row.project_id), sessionId: String(row.session_id), turnId: String(row.turn_id) },
			turnSnapshotSha256: String(row.turn_snapshot_sha256), source: row.source as AgentSessionContentBaselineDTO['source'],
			managedWorktreeOwnerId: row.managed_worktree_owner_id as string | null,
			folderIdentity: { canonicalPath: String(row.canonical_path), dev: String(row.folder_dev), ino: String(row.folder_ino) },
			capturedAt: String(row.captured_at), revision: row.revision as string | null, fingerprint: String(row.fingerprint), entryCount: snapshot.entryCount,
			fileBytes: snapshot.fileBytes, retainedTextBytes: snapshot.retainedTextBytes, contentCoverage: snapshot.contentCoverage,
		};
	}

	private finalFromRow(row: SnapshotRow): AgentSessionContentFinalDTO {
		const scope = { projectId: String(row.project_id), sessionId: String(row.session_id), turnId: String(row.turn_id) };
		const snapshot = row.snapshot_json === null ? undefined : this.readSnapshot(String(row.snapshot_json));
		return {
			scope, turnSnapshotSha256: String(row.turn_snapshot_sha256), source: row.source as AgentSessionContentFinalDTO['source'],
			managedWorktreeOwnerId: row.managed_worktree_owner_id as string | null,
			folderIdentity: { canonicalPath: String(row.canonical_path), dev: String(row.folder_dev), ino: String(row.folder_ino) },
			capturedAt: String(row.captured_at), revision: row.revision as string | null, fingerprint: String(row.fingerprint), entryCount: snapshot?.entryCount ?? 0,
			fileBytes: snapshot?.fileBytes ?? 0, retainedTextBytes: snapshot?.retainedTextBytes ?? 0, contentCoverage: snapshot?.contentCoverage ?? 'partial',
			evidenceVersion: Number(row.evidence_version), status: row.status as AgentSessionContentFinalDTO['status'],
			coverage: row.coverage as AgentSessionContentFinalDTO['coverage'], missingReason: row.missing_reason as string | null,
			beforeFingerprint: row.before_fingerprint as string | null, afterFingerprint: row.after_fingerprint as string | null,
			attributionNote: TEMPORAL_ATTRIBUTION_NOTE,
		};
	}

	private readSnapshot(json: string): AgentSessionContentSnapshot {
		return validateAgentSessionContentSnapshot(JSON.parse(json));
	}

	private metadata(file: AgentSessionContentMetadata | null): AgentSessionChangeFileObservation['before'] {
		if (!file) { return null; }
		if (file.kind === 'symlink') { return { kind: 'symlink', targetSha256: digest(file.target ?? '') }; }
		if (file.kind === 'file') { return { kind: 'file', size: file.size, sha256: file.sha256, ...(file.executable !== undefined ? { executable: file.executable } : {}) }; }
		return { kind: file.kind };
	}

	private fileState(file: AgentSessionContentFile | undefined): AgentSessionContentFileSideDTO {
		if (!file) { return { state: 'absent' }; }
		if (file.kind !== 'file') { return { state: 'unavailable', reason: 'Entry is not a retained text file.' }; }
		const publicFile = this.publicFile(file);
		if (file.content !== undefined) { return { state: 'text', file: publicFile }; }
		return { state: 'unavailable', file: publicFile, reason: file.contentUnavailableReason ?? 'Text content is unavailable.' };
	}

	private publicFile(file: AgentSessionContentFile): AgentSessionContentPublicFile {
		return Object.freeze({
			path: file.path, kind: file.kind,
			...(file.size !== undefined ? { size: file.size } : {}), ...(file.sha256 !== undefined ? { sha256: file.sha256 } : {}),
			...(file.target !== undefined ? { target: file.target } : {}), ...(file.content !== undefined ? { content: file.content } : {}),
			...(file.contentUnavailableReason !== undefined ? { contentUnavailableReason: file.contentUnavailableReason } : {}),
			...(file.executable !== undefined ? { executable: file.executable } : {}),
		});
	}

	private snapshotForSide(scopeInput: AgentSessionContentScope, version: number, before: boolean): AgentSessionContentSnapshot | undefined {
		const scope = this.normalizeScope(scopeInput);
		const final = this.getFinalRow(scope, version);
		const metadataOnly = final ? undefined : this.db.prepare(`SELECT evidence_json FROM agent_session_change_evidence WHERE project_id = ? AND session_id = ? AND turn_id = ? AND version = ?`).get(scope.projectId, scope.sessionId, scope.turnId, version) as { readonly evidence_json: SQLOutputValue } | undefined;
		if (!final && !metadataOnly) { return undefined; }
		if (!before) { return final?.snapshot_json === null || !final ? undefined : this.readSnapshot(String(final.snapshot_json)); }
		const baseline = this.getBaselineRow(scope);
		if (!baseline) { return undefined; }
		const metadataCapturedAt = metadataOnly ? (JSON.parse(String(metadataOnly.evidence_json)) as { readonly capturedAt?: unknown }).capturedAt : undefined;
		if (!final && (typeof metadataCapturedAt !== 'string' || String(baseline.captured_at) >= metadataCapturedAt)) { return undefined; }
		return this.readSnapshot(String(baseline.snapshot_json));
	}

	private rawFileState(file: AgentSessionContentFile | undefined): AgentSessionRawContentFileSide {
		if (!file) { return { state: 'absent' }; }
		if (file.kind === 'symlink') {
			const bytes = Buffer.from(file.target ?? '', 'utf8');
			return { state: 'retained', mode: '120000', size: bytes.byteLength, sha256: digestBytes(bytes), bytes: Uint8Array.from(bytes) };
		}
		if (file.kind !== 'file') { return { state: 'unavailable', reason: 'Entry is not a regular file or symlink.' }; }
		if (file.executable === undefined) { return { state: 'unavailable', reason: 'Executable mode is unknown in this legacy snapshot.' }; }
		let bytes: Buffer;
		if (file.content !== undefined) { bytes = Buffer.from(file.content, 'utf8'); }
		else if (file.rawBytesBase64 !== undefined) { bytes = Buffer.from(file.rawBytesBase64, 'base64'); }
		else { return { state: 'unavailable', reason: file.contentUnavailableReason ?? 'Raw bytes were not retained.' }; }
		if (bytes.byteLength !== file.size || digestBytes(bytes) !== file.sha256) { throw new Error('Retained raw file bytes failed immutable metadata verification.'); }
		return { state: 'retained', mode: file.executable ? '100755' : '100644', size: bytes.byteLength, sha256: file.sha256, bytes: Uint8Array.from(bytes) };
	}

	private validateTimestamp(value: string): void {
		if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) { throw new Error('Content capture time must be a canonical ISO timestamp.'); }
	}

	private normalizeReason(value: string): string {
		if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > MAX_REASON_BYTES || /[\r\n\0]/u.test(value)) { throw new Error('Content evidence reason must be a bounded single-line message.'); }
		return value;
	}

	private normalizeRevision(value: string | null, label: string): string | null {
		if (value === null) { return null; }
		if (typeof value !== 'string' || !GIT_SHA_PATTERN.test(value)) { throw new Error(`Content ${label} revision must be a full Git SHA-1 or SHA-256 value, or null.`); }
		return value.toLowerCase();
	}

	private assertExactKeys(value: unknown, required: readonly string[], label: string): void {
		if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...required].sort().join('\0')) {
			throw new Error(`Agent-session content ${label} contains missing or unknown fields.`);
		}
	}

	private transaction<T>(operation: () => T): T {
		const nested = this.db.isTransaction;
		this.db.exec(nested ? 'SAVEPOINT agent_session_content;' : 'BEGIN IMMEDIATE;');
		try {
			const value = operation();
			this.db.exec(nested ? 'RELEASE SAVEPOINT agent_session_content;' : 'COMMIT;');
			return value;
		} catch (error) {
			this.db.exec(nested ? 'ROLLBACK TO SAVEPOINT agent_session_content; RELEASE SAVEPOINT agent_session_content;' : 'ROLLBACK;');
			throw error;
		}
	}
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function digestBytes(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function isSafeRelativePath(value: string): boolean {
	return value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES && !isAbsolute(value) && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(segment => segment === '' || segment === '.' || segment === '..');
}
