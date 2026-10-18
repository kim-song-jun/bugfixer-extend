/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { AgentSessionTurnDTO } from '../../common/workspaceAgentSessionProtocol.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_FILES = 300;
const MAX_PATH_BYTES = 4096;
const MAX_REASON_BYTES = 1024;
const MAX_PAGE_SIZE = 100;

export type AgentSessionChangeSource = 'ordinaryFolder' | 'managedWorktree';
export type AgentSessionChangeStatus = 'observed' | 'unverified';
export type AgentSessionChangeCoverage = 'complete' | 'partial';
export type AgentSessionChangeAttribution = 'unknown' | 'mixed';
export type AgentSessionChangeKind = 'created' | 'modified' | 'deleted' | 'renamed' | 'typeChanged' | 'symlinkChanged';
export type AgentSessionChangeFileKind = 'file' | 'directory' | 'symlink' | 'special';

export interface AgentSessionChangeFileMetadata {
	readonly kind: AgentSessionChangeFileKind;
	readonly size?: number;
	readonly sha256?: string;
	readonly targetSha256?: string;
}

export interface AgentSessionChangeFileObservation {
	/** Root-relative, slash-separated path. Symlink targets are never followed. */
	readonly path: string;
	readonly change: AgentSessionChangeKind;
	readonly previousPath?: string;
	readonly before: AgentSessionChangeFileMetadata | null;
	readonly after: AgentSessionChangeFileMetadata | null;
}

export interface AgentSessionChangeEvidenceInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	/** Optimistic append cursor. Zero means no prior observation; retries may only match the latest version. */
	readonly expectedLatestVersion: number;
	readonly folderIdentity: { readonly canonicalPath: string; readonly dev: string; readonly ino: string };
	readonly capturedAt: string;
	readonly beforeRevision: string | null;
	readonly afterRevision: string | null;
	readonly status: AgentSessionChangeStatus;
	readonly coverage: AgentSessionChangeCoverage;
	readonly missingReason: string | null;
	readonly attribution: AgentSessionChangeAttribution;
	readonly attributionNote: string | null;
	readonly files: readonly AgentSessionChangeFileObservation[];
}

export interface AgentSessionChangeEvidenceDTO {
	readonly id: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly version: number;
	readonly fingerprint: string;
	readonly turnSnapshotSha256: string;
	readonly source: AgentSessionChangeSource;
	readonly folderIdentity: { readonly canonicalPath: string; readonly dev: string; readonly ino: string };
	readonly managedWorktreeOwnerId: string | null;
	readonly capturedAt: string;
	readonly beforeRevision: string | null;
	readonly afterRevision: string | null;
	readonly status: AgentSessionChangeStatus;
	readonly coverage: AgentSessionChangeCoverage;
	readonly noChangesConfirmed: boolean;
	readonly missingReason: string | null;
	readonly attribution: AgentSessionChangeAttribution;
	readonly attributionNote: string | null;
	readonly files: readonly AgentSessionChangeFileObservation[];
	readonly createdAt: string;
}

export interface AgentSessionChangeEvidencePage {
	readonly snapshots: readonly AgentSessionChangeEvidenceDTO[];
	readonly nextVersion: number;
	readonly hasMore: boolean;
}

interface EvidenceRow extends Readonly<Record<string, SQLOutputValue>> {
	readonly id: SQLOutputValue;
	readonly project_id: SQLOutputValue;
	readonly session_id: SQLOutputValue;
	readonly turn_id: SQLOutputValue;
	readonly version: SQLOutputValue;
	readonly fingerprint: SQLOutputValue;
	readonly evidence_json: SQLOutputValue;
	readonly created_at: SQLOutputValue;
}

interface NormalizedEvidence {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly turnSnapshotSha256: string;
	readonly source: AgentSessionChangeSource;
	readonly folderIdentity: { readonly canonicalPath: string; readonly dev: string; readonly ino: string };
	readonly managedWorktreeOwnerId: string | null;
	readonly capturedAt: string;
	readonly beforeRevision: string | null;
	readonly afterRevision: string | null;
	readonly status: AgentSessionChangeStatus;
	readonly coverage: AgentSessionChangeCoverage;
	readonly missingReason: string | null;
	readonly attribution: AgentSessionChangeAttribution;
	readonly attributionNote: string | null;
	readonly files: readonly AgentSessionChangeFileObservation[];
}

export class AgentSessionChangeEvidenceStore {
	constructor(
		private readonly db: DatabaseSync,
		private readonly assertOpen: () => void,
		private readonly getTurn: (projectId: string, sessionId: string, turnId: string) => AgentSessionTurnDTO | undefined,
	) { }

	/** Stores an immutable, turn-scoped observation. The fingerprint is not an authorship claim or a review approval. */
	recordSnapshot(input: AgentSessionChangeEvidenceInput): AgentSessionChangeEvidenceDTO {
		this.assertOpen();
		const normalized = this.normalize(input);
		const turn = this.requireTurn(input.projectId, input.sessionId, input.turnId);
		if (input.folderIdentity.canonicalPath !== turn.snapshot.folderIdentity.canonicalPath
			|| input.folderIdentity.dev !== turn.snapshot.folderIdentity.dev || input.folderIdentity.ino !== turn.snapshot.folderIdentity.ino) {
			throw new Error('Change evidence folder identity must exactly match the durable turn snapshot.');
		}
		const expectedSource: AgentSessionChangeSource = turn.snapshot.managedWorktreeOwnerId === null ? 'ordinaryFolder' : 'managedWorktree';
		if (normalized.source !== expectedSource) { throw new Error('Change evidence source does not match the durable turn workspace.'); }
		const fingerprint = digest(JSON.stringify(normalized));
		const evidenceJson = JSON.stringify(normalized);
		if (Buffer.byteLength(evidenceJson, 'utf8') > MAX_EVIDENCE_BYTES) { throw new Error('Change evidence exceeds 64 KiB.'); }
		return this.transaction(() => {
			const latest = this.db.prepare(`SELECT id, project_id, session_id, turn_id, version, fingerprint, evidence_json, created_at
				FROM agent_session_change_evidence WHERE project_id = ? AND session_id = ? AND turn_id = ? ORDER BY version DESC LIMIT 1`)
				.get(input.projectId, input.sessionId, input.turnId) as EvidenceRow | undefined;
			const latestVersion = latest ? Number(latest.version) : 0;
			if (latestVersion === input.expectedLatestVersion + 1 && latest?.fingerprint === fingerprint) { return this.fromRow(latest); }
			if (latestVersion !== input.expectedLatestVersion) { throw new Error('Change evidence append cursor is stale.'); }
			const version = latestVersion + 1;
			const id = randomUUID();
			const createdAt = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_session_change_evidence
				(id, project_id, session_id, turn_id, version, fingerprint, status, coverage, attribution, evidence_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				id, input.projectId, input.sessionId, input.turnId, version, fingerprint, normalized.status,
				normalized.coverage, normalized.attribution, evidenceJson, createdAt,
			);
			return this.getSnapshot(input.projectId, input.sessionId, input.turnId, version)!;
		});
	}

	getLatest(projectId: string, sessionId: string, turnId: string): AgentSessionChangeEvidenceDTO | undefined {
		this.assertOpen();
		this.requireTurn(projectId, sessionId, turnId);
		const row = this.db.prepare(`SELECT id, project_id, session_id, turn_id, version, fingerprint, evidence_json, created_at
			FROM agent_session_change_evidence WHERE project_id = ? AND session_id = ? AND turn_id = ? ORDER BY version DESC LIMIT 1`)
			.get(projectId, sessionId, turnId) as EvidenceRow | undefined;
		return row ? this.fromRow(row) : undefined;
	}

	listVersions(projectId: string, sessionId: string, turnId: string, options: { readonly afterVersion?: number; readonly limit?: number } = {}): AgentSessionChangeEvidencePage {
		this.assertOpen();
		this.requireTurn(projectId, sessionId, turnId);
		this.assertAllowedKeys(options, [], ['afterVersion', 'limit'], 'page options');
		const afterVersion = options.afterVersion ?? 0;
		const limit = options.limit ?? 50;
		if (!Number.isSafeInteger(afterVersion) || afterVersion < 0) { throw new Error('Change evidence cursor must be a non-negative safe integer.'); }
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) { throw new Error('Change evidence page size must be from 1 to 100.'); }
		const rows = this.db.prepare(`SELECT id, project_id, session_id, turn_id, version, fingerprint, evidence_json, created_at
			FROM agent_session_change_evidence WHERE project_id = ? AND session_id = ? AND turn_id = ? AND version > ?
			ORDER BY version LIMIT ?`).all(projectId, sessionId, turnId, afterVersion, limit + 1) as EvidenceRow[];
		const hasMore = rows.length > limit;
		const snapshots = rows.slice(0, limit).map(row => this.fromRow(row));
		return { snapshots, nextVersion: snapshots.at(-1)?.version ?? afterVersion, hasMore };
	}

	private getSnapshot(projectId: string, sessionId: string, turnId: string, version: number): AgentSessionChangeEvidenceDTO | undefined {
		const row = this.db.prepare(`SELECT id, project_id, session_id, turn_id, version, fingerprint, evidence_json, created_at
			FROM agent_session_change_evidence WHERE project_id = ? AND session_id = ? AND turn_id = ? AND version = ?`)
			.get(projectId, sessionId, turnId, version) as EvidenceRow | undefined;
		return row ? this.fromRow(row) : undefined;
	}

	private fromRow(row: EvidenceRow): AgentSessionChangeEvidenceDTO {
		const evidence = JSON.parse(String(row.evidence_json)) as NormalizedEvidence;
		return {
			...evidence,
			id: String(row.id), projectId: String(row.project_id), sessionId: String(row.session_id), turnId: String(row.turn_id),
			version: Number(row.version), fingerprint: String(row.fingerprint),
			noChangesConfirmed: evidence.status === 'observed' && evidence.coverage === 'complete' && evidence.files.length === 0,
			createdAt: String(row.created_at),
		};
	}

	private normalize(input: AgentSessionChangeEvidenceInput): NormalizedEvidence {
		this.assertExactKeys(input, ['projectId', 'sessionId', 'turnId', 'expectedLatestVersion', 'folderIdentity', 'capturedAt', 'beforeRevision', 'afterRevision', 'status', 'coverage', 'missingReason', 'attribution', 'attributionNote', 'files'], 'change evidence');
		this.validateUuid(input.projectId, 'project ID');
		this.validateUuid(input.sessionId, 'session ID');
		this.validateUuid(input.turnId, 'turn ID');
		if (!Number.isSafeInteger(input.expectedLatestVersion) || input.expectedLatestVersion < 0) { throw new Error('Change evidence append cursor must be a non-negative safe integer.'); }
		this.assertExactKeys(input.folderIdentity, ['canonicalPath', 'dev', 'ino'], 'folder identity');
		if (typeof input.folderIdentity.canonicalPath !== 'string' || !isAbsolute(input.folderIdentity.canonicalPath)
			|| input.folderIdentity.canonicalPath.includes('\\') || input.folderIdentity.canonicalPath.includes('\0')
			|| !/^\d+$/.test(input.folderIdentity.dev) || !/^\d+$/.test(input.folderIdentity.ino)) {
			throw new Error('Change evidence folder identity is invalid.');
		}
		if (typeof input.capturedAt !== 'string' || !Number.isFinite(Date.parse(input.capturedAt)) || new Date(input.capturedAt).toISOString() !== input.capturedAt) {
			throw new Error('Change evidence capture time must be a canonical ISO timestamp.');
		}
		if (!['observed', 'unverified'].includes(input.status) || !['complete', 'partial'].includes(input.coverage)) { throw new Error('Change evidence status or coverage is invalid.'); }
		const missingReason = this.optionalReason(input.missingReason, 'missing evidence reason');
		if ((input.status === 'observed' && input.coverage === 'complete' && missingReason !== null)
			|| ((input.coverage === 'partial' || input.status === 'unverified') && missingReason === null)
			|| (input.status === 'unverified' && input.coverage !== 'partial')) {
			throw new Error('Incomplete or unverified change evidence must retain a missing reason.');
		}
		if (!['unknown', 'mixed'].includes(input.attribution)) { throw new Error('Change evidence attribution must remain unknown or mixed.'); }
		const attributionNote = this.optionalReason(input.attributionNote, 'attribution note');
		if ((input.attribution === 'mixed') !== (attributionNote !== null)) { throw new Error('Mixed attribution requires an evidence note; unknown attribution has no source claim.'); }
		if (!Array.isArray(input.files) || input.files.length > MAX_FILES) { throw new Error('Change evidence may contain at most 300 file observations.'); }
		const files = input.files.map(file => this.normalizeFile(file));
		const paths = new Set<string>();
		for (const file of files) {
			if (paths.has(file.path)) { throw new Error('Change evidence contains duplicate file paths.'); }
			paths.add(file.path);
			if (file.previousPath && paths.has(file.previousPath)) { throw new Error('Change evidence contains duplicate rename paths.'); }
			if (file.previousPath) { paths.add(file.previousPath); }
		}
		files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
		const turn = this.requireTurn(input.projectId, input.sessionId, input.turnId);
		const source: AgentSessionChangeSource = turn.snapshot.managedWorktreeOwnerId === null ? 'ordinaryFolder' : 'managedWorktree';
		const beforeRevision = this.revision(input.beforeRevision, 'before revision');
		const afterRevision = this.revision(input.afterRevision, 'after revision');
		if (source === 'managedWorktree' && (!beforeRevision || !afterRevision)) { throw new Error('Managed worktree change evidence requires before and after Git revisions.'); }
		return {
			projectId: input.projectId, sessionId: input.sessionId, turnId: input.turnId,
			turnSnapshotSha256: turn.snapshotSha256, source,
			folderIdentity: { canonicalPath: input.folderIdentity.canonicalPath, dev: input.folderIdentity.dev, ino: input.folderIdentity.ino },
			managedWorktreeOwnerId: turn.snapshot.managedWorktreeOwnerId,
			capturedAt: input.capturedAt, beforeRevision, afterRevision,
			status: input.status, coverage: input.coverage, missingReason, attribution: input.attribution,
			attributionNote, files,
		};
	}

	private normalizeFile(input: AgentSessionChangeFileObservation): AgentSessionChangeFileObservation {
		this.assertAllowedKeys(input, ['path', 'change', 'before', 'after'], ['previousPath'], 'file observation');
		const path = this.validateRelativePath(input.path);
		if (!['created', 'modified', 'deleted', 'renamed', 'typeChanged', 'symlinkChanged'].includes(input.change)) { throw new Error('Change evidence file change kind is invalid.'); }
		const previousPath = input.previousPath === undefined ? undefined : this.validateRelativePath(input.previousPath);
		if ((input.change === 'renamed' && (!previousPath || previousPath === path)) || (input.change !== 'renamed' && previousPath !== undefined)) {
			throw new Error('Rename evidence must include a distinct previous path.');
		}
		const before = input.before === null ? null : this.normalizeMetadata(input.before);
		const after = input.after === null ? null : this.normalizeMetadata(input.after);
		if (input.change === 'created' && (before !== null || after === null)) { throw new Error('Created file evidence requires only an after observation.'); }
		if (input.change === 'deleted' && (before === null || after !== null)) { throw new Error('Deleted file evidence requires only a before observation.'); }
		if (input.change === 'renamed' && (before === null || after === null)) { throw new Error('Renamed file evidence requires before and after observations.'); }
		if (input.change === 'typeChanged' && (before === null || after === null || before.kind === after.kind)) { throw new Error('Type-change evidence requires different before and after kinds.'); }
		if (input.change === 'modified' && (before?.kind !== 'file' || after?.kind !== 'file' || (before.sha256 === after.sha256 && before.size === after.size))) {
			throw new Error('Modified file evidence requires a changed file hash or size.');
		}
		if (input.change === 'symlinkChanged' && (before?.kind !== 'symlink' || after?.kind !== 'symlink' || before.targetSha256 === after.targetSha256)) {
			throw new Error('Changed symlink evidence requires different target hashes.');
		}
		return { path, change: input.change, ...(previousPath ? { previousPath } : {}), before, after };
	}

	private normalizeMetadata(input: AgentSessionChangeFileMetadata): AgentSessionChangeFileMetadata {
		if (!input || typeof input !== 'object' || Array.isArray(input)) { throw new Error('Change evidence file metadata is invalid.'); }
		if (input.kind === 'file') {
			this.assertExactKeys(input, ['kind', 'size', 'sha256'], 'file metadata');
			if (!Number.isSafeInteger(input.size) || input.size! < 0 || typeof input.sha256 !== 'string' || !SHA256_PATTERN.test(input.sha256)) { throw new Error('File evidence size or content hash is invalid.'); }
			return { kind: 'file', size: input.size, sha256: input.sha256 };
		}
		if (input.kind === 'symlink') {
			this.assertExactKeys(input, ['kind', 'targetSha256'], 'symlink metadata');
			if (typeof input.targetSha256 !== 'string' || !SHA256_PATTERN.test(input.targetSha256)) { throw new Error('Symlink evidence target hash is invalid.'); }
			return { kind: 'symlink', targetSha256: input.targetSha256 };
		}
		if (input.kind === 'directory' || input.kind === 'special') {
			this.assertExactKeys(input, ['kind'], 'non-file metadata');
			return { kind: input.kind };
		}
		throw new Error('Change evidence file metadata kind is invalid.');
	}

	private validateRelativePath(value: unknown): string {
		if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 1 || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
			|| value.includes('\0') || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:/.test(value)
			|| value.split('/').some(part => part === '' || part === '.' || part === '..')) {
			throw new Error('Change evidence path must be a bounded, normalized, root-relative path.');
		}
		return value;
	}

	private revision(value: string | null, label: string): string | null {
		if (value === null) { return null; }
		if (typeof value !== 'string' || !GIT_SHA_PATTERN.test(value)) { throw new Error(`Change evidence ${label} must be a full Git SHA-1 or SHA-256 revision.`); }
		return value.toLowerCase();
	}

	private optionalReason(value: string | null, label: string): string | null {
		if (value === null) { return null; }
		if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > MAX_REASON_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
			throw new Error(`Change evidence ${label} must contain 1 to 1024 printable UTF-8 bytes.`);
		}
		return value.trim();
	}

	private requireTurn(projectId: string, sessionId: string, turnId: string): AgentSessionTurnDTO {
		this.validateUuid(projectId, 'project ID');
		this.validateUuid(sessionId, 'session ID');
		this.validateUuid(turnId, 'turn ID');
		const turn = this.getTurn(projectId, sessionId, turnId);
		if (!turn) { throw new Error('Change evidence turn does not belong to this project and session.'); }
		return turn;
	}

	private assertExactKeys(value: object, keys: readonly string[], label: string): void {
		if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
			throw new Error(`Change evidence ${label} has unsupported or missing fields.`);
		}
	}

	private assertAllowedKeys(value: object, required: readonly string[], optional: readonly string[], label: string): void {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`Change evidence ${label} has unsupported or missing fields.`); }
		const keys = Object.keys(value);
		if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) {
			throw new Error(`Change evidence ${label} has unsupported or missing fields.`);
		}
	}

	private validateUuid(value: string, label: string): void {
		if (typeof value !== 'string' || !UUID_PATTERN.test(value)) { throw new Error(`Change evidence ${label} is invalid.`); }
	}

	private transaction<T>(run: () => T): T {
		if (this.db.isTransaction) { return run(); }
		this.db.exec('BEGIN IMMEDIATE;');
		try { const value = run(); this.db.exec('COMMIT;'); return value; }
		catch (error) { this.db.exec('ROLLBACK;'); throw error; }
	}
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
