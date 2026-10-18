/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type {
	AgentSessionTranscriptEntryDTO,
	AppendAgentSessionTranscriptLogInput,
	AgentSessionTranscriptPageDTO,
	AgentSessionTranscriptPageOptions,
	AgentSessionTranscriptReference,
	AppendAgentSessionTranscriptChunkInput,
} from '../../common/workspaceAgentSessionProtocol.js';
import { sanitizeCompleteAgentText } from './agentOutputRedactor.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_LOG_INPUT_BYTES = 1024 * 1024;
const MAX_REFERENCES = 16;
const MAX_REFERENCE_BYTES = 4096;
const MAX_PAGE_ENTRIES = 100;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export interface AgentSessionTranscriptRetention {
	/** Per-turn retained UTF-8 text bytes. Defaults to 10 MiB. */
	readonly maxBytesPerTurn?: number;
	/** Per-turn retained transcript entry count. Defaults to 20,000. */
	readonly maxEntriesPerTurn?: number;
}

interface TranscriptCursorRow {
	readonly highest_sequence: SQLOutputValue;
	readonly first_retained_sequence: SQLOutputValue;
	readonly evicted_through_sequence: SQLOutputValue;
	readonly retained_bytes: SQLOutputValue;
	readonly retained_count: SQLOutputValue;
}

interface TranscriptEntryRow {
	readonly project_id: SQLOutputValue;
	readonly session_id: SQLOutputValue;
	readonly turn_id: SQLOutputValue;
	readonly sequence: SQLOutputValue;
	readonly kind: SQLOutputValue;
	readonly text: SQLOutputValue;
	readonly byte_length: SQLOutputValue;
	readonly severity: SQLOutputValue;
	readonly source: SQLOutputValue;
	readonly references_json: SQLOutputValue;
	readonly created_at: SQLOutputValue;
	readonly content_sha256: SQLOutputValue;
}

/** Durable transcript sink. Terminal strings are trusted as whole-stream sanitizer output; never re-redact chunks here. */
export class AgentSessionTranscriptStore {
	private readonly maxBytesPerTurn: number;
	private readonly maxEntriesPerTurn: number;

	constructor(private readonly db: DatabaseSync, private readonly assertOpen: () => void, retention: AgentSessionTranscriptRetention = {}) {
		this.maxBytesPerTurn = retention.maxBytesPerTurn ?? 10 * 1024 * 1024;
		this.maxEntriesPerTurn = retention.maxEntriesPerTurn ?? 20_000;
		if (!Number.isSafeInteger(this.maxBytesPerTurn) || this.maxBytesPerTurn < 1 || this.maxBytesPerTurn > 100 * 1024 * 1024) {
			throw new RangeError('Transcript retention maxBytesPerTurn must be an integer from 1 byte to 100 MiB.');
		}
		if (!Number.isSafeInteger(this.maxEntriesPerTurn) || this.maxEntriesPerTurn < 0 || this.maxEntriesPerTurn > 100_000) {
			throw new RangeError('Transcript retention maxEntriesPerTurn must be an integer from 0 to 100,000.');
		}
	}

	/** Accept only output already emitted by the trusted PTY host's persistent per-stream sanitizer. */
	appendSanitizedTerminalChunk(input: AppendAgentSessionTranscriptChunkInput): AgentSessionTranscriptEntryDTO {
		this.assertOpen();
		this.validateOwnership(input.projectId, input.sessionId, input.turnId);
		this.validateSequence(input.sequence);
		if (typeof input.sanitizedTextFromTrustedPtyHost !== 'string') { throw new TypeError('Sanitized PTY output must be text from the trusted host.'); }
		return this.append(input.projectId, input.sessionId, input.turnId, input.sequence, 'terminal', input.sanitizedTextFromTrustedPtyHost, null, null, []);
	}

	/** Sanitizes each complete structured event with host-provided launch secrets before SQLite persistence. */
	appendStructuredLog(input: AppendAgentSessionTranscriptLogInput): AgentSessionTranscriptEntryDTO {
		this.assertOpen();
		this.validateOwnership(input.projectId, input.sessionId, input.turnId);
		this.validateSequence(input.sequence);
		if (!['debug', 'info', 'warning', 'error'].includes(input.severity)) { throw new Error('Transcript log severity is invalid.'); }
		if (!['pty', 'provider', 'host', 'workspace'].includes(input.source)) { throw new Error('Transcript log source is invalid.'); }
		if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > MAX_LOG_INPUT_BYTES) { throw new Error('Structured transcript text exceeds 1 MiB.'); }
		const knownSecrets = input.trustedKnownSecrets ?? [];
		if (!Array.isArray(knownSecrets) || knownSecrets.some(secret => typeof secret !== 'string')) { throw new TypeError('Trusted log secrets must be strings.'); }
		const sanitizedText = sanitizeCompleteAgentText(input.text, { knownSecrets });
		const references = this.validateReferences(input.references ?? []);
		return this.append(input.projectId, input.sessionId, input.turnId, input.sequence, 'log', sanitizedText, input.severity, input.source, references);
	}

	readPage(projectId: string, sessionId: string, turnId: string, options: AgentSessionTranscriptPageOptions = {}): AgentSessionTranscriptPageDTO {
		this.assertOpen();
		this.validateOwnership(projectId, sessionId, turnId);
		const afterSequence = options.afterSequence ?? 0;
		const limit = options.limit ?? 50;
		const maxOutputBytes = options.maxOutputBytes ?? MAX_PAGE_BYTES;
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) { throw new Error('Transcript cursor must be a non-negative safe integer.'); }
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_ENTRIES) { throw new Error('Transcript page limit must be from 1 to 100.'); }
		if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < MAX_ENTRY_BYTES || maxOutputBytes > MAX_PAGE_BYTES) { throw new Error('Transcript output budget must be from 256 KiB to 2 MiB.'); }
		this.validateFilters(options);
		const cursor = this.cursor(projectId, sessionId, turnId);
		if (!cursor) { return { entries: [], nextSequence: afterSequence, highestSequence: 0, firstRetainedSequence: null, gaps: [], hasMore: false }; }
		const highestSequence = Number(cursor.highest_sequence);
		const firstRetainedSequence = cursor.first_retained_sequence === null ? null : Number(cursor.first_retained_sequence);
		const rows = this.db.prepare(`SELECT project_id, session_id, turn_id, sequence, kind, text, byte_length, severity, source,
			references_json, created_at, content_sha256 FROM agent_session_transcript_entries
			WHERE project_id = ? AND session_id = ? AND turn_id = ? AND sequence > ?
			AND (? IS NULL OR kind = ?) AND (? IS NULL OR severity = ?) AND (? IS NULL OR source = ?)
			ORDER BY sequence LIMIT ?`).all(projectId, sessionId, turnId, afterSequence,
			options.kind ?? null, options.kind ?? null, options.severity ?? null, options.severity ?? null,
			options.source ?? null, options.source ?? null, MAX_PAGE_ENTRIES + 1) as TranscriptEntryRow[];
		const entries: AgentSessionTranscriptEntryDTO[] = [];
		let outputBytes = 0;
		let nextSequence = afterSequence;
		let hasMore = rows.length > limit;
		for (const row of rows) {
			if (entries.length >= limit) { hasMore = true; break; }
			const size = Number(row.byte_length);
			if (outputBytes + size > maxOutputBytes) { hasMore = true; break; }
			entries.push(this.entryFromRow(row));
			outputBytes += size;
			nextSequence = Number(row.sequence);
		}
		if (entries.length === 0 && rows.length === 0) { nextSequence = Math.max(afterSequence, highestSequence); }
		const gaps: Array<{ afterSequence: number; throughSequence: number }> = [];
		let observed = afterSequence;
		const endSequence = nextSequence;
		const evictedThrough = Math.min(Number(cursor.evicted_through_sequence), endSequence);
		if (evictedThrough > observed) { gaps.push({ afterSequence: observed, throughSequence: evictedThrough }); observed = evictedThrough; }
		if (endSequence > observed) {
			const retainedSequences = this.db.prepare(`SELECT sequence FROM agent_session_transcript_entries WHERE turn_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence`)
				.all(turnId, observed, endSequence).map(row => Number(row.sequence));
			for (const retainedSequence of retainedSequences) {
				if (retainedSequence > observed + 1) { gaps.push({ afterSequence: observed, throughSequence: retainedSequence - 1 }); }
				observed = retainedSequence;
			}
			if (endSequence > observed) { gaps.push({ afterSequence: observed, throughSequence: endSequence }); }
		}
		return { entries, nextSequence, highestSequence, firstRetainedSequence, gaps, hasMore };
	}

	/** O(1) journal cursor lookup used by the trusted main-process append coordinator. */
	highestSequence(projectId: string, sessionId: string, turnId: string): number {
		this.assertOpen();
		this.validateOwnership(projectId, sessionId, turnId);
		return Number(this.cursor(projectId, sessionId, turnId)?.highest_sequence ?? 0);
	}

	private append(projectId: string, sessionId: string, turnId: string, sequence: number, kind: 'terminal' | 'log', text: string,
		severity: AgentSessionTranscriptEntryDTO['severity'], source: AgentSessionTranscriptEntryDTO['source'], references: readonly AgentSessionTranscriptReference[]): AgentSessionTranscriptEntryDTO {
		const byteLength = Buffer.byteLength(text, 'utf8');
		if (byteLength > MAX_ENTRY_BYTES) { throw new Error('A transcript entry exceeds 256 KiB UTF-8.'); }
		const referencesJson = JSON.stringify(references);
		if (Buffer.byteLength(referencesJson, 'utf8') > MAX_REFERENCE_BYTES) { throw new Error('Transcript references exceed 4 KiB.'); }
		const hash = digest(JSON.stringify({ kind, text, severity, source, references }));
		return this.transaction(() => {
			const turn = this.db.prepare(`SELECT 1 FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ?`)
				.get(turnId, projectId, sessionId);
			if (!turn) { throw new Error('The transcript turn does not belong to this project and session.'); }
			let cursor = this.cursor(projectId, sessionId, turnId);
			if (!cursor) {
				this.db.prepare(`INSERT INTO agent_session_transcript_cursors (turn_id, project_id, session_id) VALUES (?, ?, ?)`).run(turnId, projectId, sessionId);
				cursor = this.cursor(projectId, sessionId, turnId)!;
			}
			const prior = this.db.prepare(`SELECT project_id, session_id, turn_id, sequence, kind, text, byte_length, severity, source,
				references_json, created_at, content_sha256 FROM agent_session_transcript_entries
				WHERE turn_id = ? AND sequence = ?`).get(turnId, sequence) as TranscriptEntryRow | undefined;
			if (prior) {
				if (String(prior.content_sha256) !== hash) { throw new Error('The transcript sequence was retried with different content.'); }
				return this.entryFromRow(prior);
			}
			if (sequence <= Number(cursor.highest_sequence)) { throw new Error('This transcript sequence was pruned; its content can no longer be verified.'); }
			const createdAt = new Date().toISOString();
			this.db.prepare(`INSERT INTO agent_session_transcript_entries
				(turn_id, project_id, session_id, sequence, kind, text, content_sha256, byte_length, severity, source, references_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(turnId, projectId, sessionId, sequence, kind, text, hash, byteLength, severity, source, referencesJson, createdAt);
			this.db.prepare(`UPDATE agent_session_transcript_cursors SET highest_sequence = ?, retained_bytes = retained_bytes + ?,
				retained_count = retained_count + 1, first_retained_sequence = COALESCE(first_retained_sequence, ?)
				WHERE turn_id = ?`).run(sequence, byteLength, sequence, turnId);
			this.evict(projectId, sessionId, turnId);
			const stored = this.db.prepare(`SELECT project_id, session_id, turn_id, sequence, kind, text, byte_length, severity, source,
				references_json, created_at, content_sha256 FROM agent_session_transcript_entries WHERE turn_id = ? AND sequence = ?`).get(turnId, sequence) as TranscriptEntryRow | undefined;
			if (stored) { return this.entryFromRow(stored); }
			return { projectId, sessionId, turnId, sequence, kind, text, byteLength, retained: false, severity, source, references, createdAt };
		});
	}

	private evict(projectId: string, sessionId: string, turnId: string): void {
		const cursor = this.cursor(projectId, sessionId, turnId)!;
		let retainedBytes = Number(cursor.retained_bytes);
		let retainedCount = Number(cursor.retained_count);
		while (retainedBytes > this.maxBytesPerTurn || retainedCount > this.maxEntriesPerTurn) {
			const oldest = this.db.prepare(`SELECT sequence, byte_length FROM agent_session_transcript_entries WHERE turn_id = ? ORDER BY sequence LIMIT 1`).get(turnId) as { sequence: SQLOutputValue; byte_length: SQLOutputValue } | undefined;
			if (!oldest) { break; }
			const removedSequence = Number(oldest.sequence);
			const removedBytes = Number(oldest.byte_length);
			this.db.prepare(`DELETE FROM agent_session_transcript_entries WHERE turn_id = ? AND sequence = ?`).run(turnId, removedSequence);
			retainedBytes -= removedBytes;
			retainedCount--;
			const next = this.db.prepare(`SELECT MIN(sequence) AS first_sequence FROM agent_session_transcript_entries WHERE turn_id = ?`).get(turnId)?.first_sequence;
			this.db.prepare(`UPDATE agent_session_transcript_cursors SET evicted_through_sequence = ?, retained_bytes = ?, retained_count = ?, first_retained_sequence = ? WHERE turn_id = ?`)
				.run(removedSequence, retainedBytes, retainedCount, next ?? null, turnId);
		}
	}

	private validateOwnership(projectId: string, sessionId: string, turnId: string): void {
		this.validateUuid(projectId, 'project ID'); this.validateUuid(sessionId, 'session ID'); this.validateUuid(turnId, 'turn ID');
		if (!this.db.prepare(`SELECT 1 FROM agent_session_turns WHERE id = ? AND project_id = ? AND session_id = ?`).get(turnId, projectId, sessionId)) {
			throw new Error('The transcript turn does not belong to this project and session.');
		}
	}

	private validateSequence(sequence: number): void {
		if (!Number.isSafeInteger(sequence) || sequence < 1) { throw new Error('Transcript sequence must be a positive safe integer.'); }
	}

	private validateReferences(references: readonly AgentSessionTranscriptReference[]): readonly AgentSessionTranscriptReference[] {
		if (!Array.isArray(references) || references.length > MAX_REFERENCES) { throw new Error('Transcript reference count exceeds the allowlist.'); }
		return references.map(reference => {
			if (!reference || Object.keys(reference).sort().join(',') !== 'id,kind' || !['task', 'turn', 'knowledge', 'diff'].includes(reference.kind)
				|| typeof reference.id !== 'string' || !UUID_PATTERN.test(reference.id)) { throw new Error('Transcript reference is invalid.'); }
			return { kind: reference.kind, id: reference.id };
		});
	}

	private validateFilters(options: AgentSessionTranscriptPageOptions): void {
		if (options.kind !== undefined && !['terminal', 'log'].includes(options.kind)) { throw new Error('Transcript kind filter is invalid.'); }
		if (options.severity !== undefined && !['debug', 'info', 'warning', 'error'].includes(options.severity)) { throw new Error('Transcript severity filter is invalid.'); }
		if (options.source !== undefined && !['pty', 'provider', 'host', 'workspace'].includes(options.source)) { throw new Error('Transcript source filter is invalid.'); }
	}

	private cursor(projectId: string, sessionId: string, turnId: string): TranscriptCursorRow | undefined {
		return this.db.prepare(`SELECT highest_sequence, first_retained_sequence, evicted_through_sequence, retained_bytes, retained_count
			FROM agent_session_transcript_cursors WHERE turn_id = ? AND project_id = ? AND session_id = ?`).get(turnId, projectId, sessionId) as TranscriptCursorRow | undefined;
	}

	private entryFromRow(row: TranscriptEntryRow): AgentSessionTranscriptEntryDTO {
		return {
			projectId: String(row.project_id), sessionId: String(row.session_id), turnId: String(row.turn_id), sequence: Number(row.sequence),
			kind: String(row.kind) as AgentSessionTranscriptEntryDTO['kind'], text: String(row.text), byteLength: Number(row.byte_length), retained: true,
			severity: row.severity === null ? null : String(row.severity) as AgentSessionTranscriptEntryDTO['severity'],
			source: row.source === null ? null : String(row.source) as AgentSessionTranscriptEntryDTO['source'],
			references: JSON.parse(String(row.references_json)) as AgentSessionTranscriptReference[], createdAt: String(row.created_at),
		};
	}

	private validateUuid(value: string, label: string): void {
		if (typeof value !== 'string' || !UUID_PATTERN.test(value)) { throw new Error(`The ${label} is invalid.`); }
	}

	private transaction<T>(callback: () => T): T {
		if (this.db.isTransaction) { return callback(); }
		this.db.exec('BEGIN IMMEDIATE;');
		try { const result = callback(); this.db.exec('COMMIT;'); return result; }
		catch (error) { this.db.exec('ROLLBACK;'); throw error; }
	}
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
