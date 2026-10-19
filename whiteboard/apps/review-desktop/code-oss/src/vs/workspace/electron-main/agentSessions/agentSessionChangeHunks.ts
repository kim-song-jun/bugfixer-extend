/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { DefaultLinesDiffComputer } from '../../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import type { RangeMapping } from '../../../editor/common/diff/rangeMapping.js';
import type { AgentSessionContentUnavailableReason } from './agentSessionContentCapture.js';
import type { AgentSessionContentFileDTO } from './agentSessionContentStore.js';

export const AGENT_SESSION_CHANGE_HUNKS_MAX_FILE_BYTES = 1024 * 1024;
export const AGENT_SESSION_CHANGE_HUNKS_MAX_LINES_PER_SIDE = 20_000;
export const AGENT_SESSION_CHANGE_HUNKS_MAX_HUNKS = 300;
export const AGENT_SESSION_CHANGE_HUNKS_DEFAULT_COMPUTATION_BUDGET_MS = 50;
export const AGENT_SESSION_CHANGE_HUNKS_MAX_COMPUTATION_BUDGET_MS = 100;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AgentSessionChangeHunkRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

export interface AgentSessionChangeHunk {
	readonly id: string;
	readonly originalStartLineNumber: number;
	readonly originalEndLineNumberExclusive: number;
	readonly modifiedStartLineNumber: number;
	readonly modifiedEndLineNumberExclusive: number;
	readonly ranges: readonly { readonly original: AgentSessionChangeHunkRange; readonly modified: AgentSessionChangeHunkRange }[];
}

export type AgentSessionChangeHunkFileState =
	| { readonly state: 'absent'; readonly sha256: null }
	| { readonly state: 'text'; readonly sha256: string }
	| { readonly state: 'unavailable'; readonly sha256: string | null; readonly reason: AgentSessionContentUnavailableReason | 'invalidHash' | 'invalidUtf8' | 'missing' | 'unavailable' };

export type AgentSessionChangeHunkStatus = 'hunks' | 'noTextChange' | 'eolOnly' | 'presenceChanged' | 'unavailable' | 'partial';

export interface AgentSessionChangeHunksDTO {
	readonly scope: AgentSessionContentFileDTO['scope'];
	readonly evidenceVersion: number;
	readonly evidenceFingerprint: string;
	readonly path: string;
	readonly before: AgentSessionChangeHunkFileState;
	readonly after: AgentSessionChangeHunkFileState;
	readonly status: AgentSessionChangeHunkStatus;
	readonly hunks: readonly AgentSessionChangeHunk[];
	readonly truncated: boolean;
	readonly timedOut: boolean;
	readonly unavailableReason: string | null;
}

export interface AgentSessionChangeHunksOptions {
	readonly computationBudgetMs?: number;
}

/** Computes bounded hunk identities only from the immutable text retained in the before/after DTO. */
export function computeAgentSessionChangeHunks(input: AgentSessionContentFileDTO, options: AgentSessionChangeHunksOptions = {}): AgentSessionChangeHunksDTO {
	validateInput(input);
	if (!isRecord(options) || !exactKeys(options, Object.hasOwn(options, 'computationBudgetMs') ? ['computationBudgetMs'] : [])) {
		throw new Error('Hunk computation options contain missing or unknown fields.');
	}
	const rawBudget: unknown = options.computationBudgetMs;
	if (rawBudget !== undefined && (typeof rawBudget !== 'number' || !Number.isFinite(rawBudget) || !Number.isInteger(rawBudget)
		|| rawBudget < 1 || rawBudget > AGENT_SESSION_CHANGE_HUNKS_MAX_COMPUTATION_BUDGET_MS)) {
		throw new Error(`Hunk computation budget must be an integer from 1 to ${AGENT_SESSION_CHANGE_HUNKS_MAX_COMPUTATION_BUDGET_MS} milliseconds.`);
	}
	const budget = typeof rawBudget === 'number' ? rawBudget : AGENT_SESSION_CHANGE_HUNKS_DEFAULT_COMPUTATION_BUDGET_MS;
	const before = validateState(input.before, input.path);
	const after = validateState(input.after, input.path);
	const base = {
		scope: Object.freeze({ ...input.scope }), evidenceVersion: input.evidenceVersion, evidenceFingerprint: input.evidenceFingerprint,
		path: input.path, before, after,
	};
	if (before.state === 'unavailable' || after.state === 'unavailable') {
		return freezeResult({ ...base, status: 'unavailable', hunks: [], truncated: false, timedOut: false, unavailableReason: before.state === 'unavailable' ? before.reason : after.state === 'unavailable' ? after.reason : null });
	}
	const presenceChanged = before.state !== after.state;
	const originalText = before.state === 'text' ? (input.before as Extract<AgentSessionContentFileDTO['before'], { state: 'text' }>).file.content! : '';
	const modifiedText = after.state === 'text' ? (input.after as Extract<AgentSessionContentFileDTO['after'], { state: 'text' }>).file.content! : '';
	if (!presenceChanged && originalText === modifiedText) {
		return freezeResult({ ...base, status: 'noTextChange', hunks: [], truncated: false, timedOut: false, unavailableReason: null });
	}
	if (presenceChanged && originalText.length === 0 && modifiedText.length === 0) {
		return freezeResult({ ...base, status: 'presenceChanged', hunks: [], truncated: false, timedOut: false, unavailableReason: null });
	}
	const originalLines = originalText.split(/\r\n|\r|\n/u);
	const modifiedLines = modifiedText.split(/\r\n|\r|\n/u);
	if (originalLines.length > AGENT_SESSION_CHANGE_HUNKS_MAX_LINES_PER_SIDE || modifiedLines.length > AGENT_SESSION_CHANGE_HUNKS_MAX_LINES_PER_SIDE) {
		return freezeResult({ ...base, status: 'unavailable', hunks: [], truncated: false, timedOut: false, unavailableReason: 'lineLimit' });
	}
	if (!presenceChanged && sameLines(originalLines, modifiedLines)) {
		return freezeResult({ ...base, status: 'eolOnly', hunks: [], truncated: false, timedOut: false, unavailableReason: null });
	}
	const startedAt = Date.now();
	const diff = new DefaultLinesDiffComputer().computeDiff(originalLines, modifiedLines, {
		ignoreTrimWhitespace: false,
		maxComputationTimeMs: budget,
		computeMoves: false,
	});
	const timedOut = diff.hitTimeout || Date.now() - startedAt > budget;
	const rawChanges = diff.changes;
	const truncated = rawChanges.length > AGENT_SESSION_CHANGE_HUNKS_MAX_HUNKS;
	if (timedOut) {
		return freezeResult({ ...base, status: 'partial', hunks: [], truncated, timedOut: true, unavailableReason: 'computationTimeout' });
	}
	const hunks = rawChanges.slice(0, AGENT_SESSION_CHANGE_HUNKS_MAX_HUNKS).map((change, index) => {
		const ranges = Object.freeze((change.innerChanges ?? []).map(mapping => copyRangeMapping(mapping)));
		const identity = {
			scope: base.scope, evidenceVersion: base.evidenceVersion, evidenceFingerprint: base.evidenceFingerprint, path: base.path,
			before: base.before, after: base.after,
			originalStartLineNumber: change.original.startLineNumber, originalEndLineNumberExclusive: change.original.endLineNumberExclusive,
			modifiedStartLineNumber: change.modified.startLineNumber, modifiedEndLineNumberExclusive: change.modified.endLineNumberExclusive,
			ranges,
		};
		return Object.freeze({ ...identity, id: sha256(JSON.stringify({ ...identity, index })) });
	});
	if (truncated) {
		return freezeResult({ ...base, status: 'partial', hunks, truncated: true, timedOut: false, unavailableReason: 'hunkLimit' });
	}
	if (hunks.length === 0) {
		const status = presenceChanged ? 'presenceChanged' : originalText !== modifiedText ? 'eolOnly' : 'noTextChange';
		return freezeResult({ ...base, status, hunks, truncated: false, timedOut: false, unavailableReason: null });
	}
	return freezeResult({ ...base, status: presenceChanged ? 'presenceChanged' : 'hunks', hunks, truncated: false, timedOut: false, unavailableReason: null });
}

function validateInput(value: unknown): asserts value is AgentSessionContentFileDTO {
	if (!isRecord(value) || !exactKeys(value, ['scope', 'evidenceVersion', 'path', 'evidenceFingerprint', 'before', 'after']) || !isRecord(value.scope)
		|| !exactKeys(value.scope, ['projectId', 'sessionId', 'turnId']) || !Object.values(value.scope).every(item => typeof item === 'string' && uuidPattern.test(item))
		|| typeof value.evidenceVersion !== 'number' || !Number.isSafeInteger(value.evidenceVersion) || value.evidenceVersion < 1
		|| typeof value.evidenceFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.evidenceFingerprint)
		|| typeof value.path !== 'string' || !isSafeRelativePath(value.path)
		|| !isRecord(value.before) || !isRecord(value.after)) {
		throw new Error('Agent-session change hunk input is invalid or unscoped.');
	}
}

function validateState(value: Record<string, unknown>, path: string): AgentSessionChangeHunkFileState {
	if (value.state === 'absent' && exactKeys(value, ['state'])) { return Object.freeze({ state: 'absent', sha256: null }); }
	if (value.state === 'text' && exactKeys(value, ['state', 'file'])) {
		const file = value.file;
		if (!isRecord(file) || !exactKeysWithOptionalExecutable(file, ['path', 'kind', 'size', 'sha256', 'content']) || file.path !== path || file.kind !== 'file'
			|| !Number.isSafeInteger(file.size) || (file.size as number) < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256) || typeof file.content !== 'string') {
			throw new Error('Agent-session hunk input has malformed retained text metadata.');
		}
		if ((file.size as number) > AGENT_SESSION_CHANGE_HUNKS_MAX_FILE_BYTES) { return Object.freeze({ state: 'unavailable', sha256: file.sha256, reason: 'fileTooLarge' }); }
		if (Buffer.byteLength(file.content, 'utf8') > AGENT_SESSION_CHANGE_HUNKS_MAX_FILE_BYTES) { return Object.freeze({ state: 'unavailable', sha256: file.sha256, reason: 'fileTooLarge' }); }
		const bytes = Buffer.from(file.content, 'utf8');
		if (bytes.byteLength > AGENT_SESSION_CHANGE_HUNKS_MAX_FILE_BYTES) { return Object.freeze({ state: 'unavailable', sha256: file.sha256, reason: 'fileTooLarge' }); }
		if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) {
			return Object.freeze({ state: 'unavailable', sha256: file.sha256, reason: 'invalidHash' });
		}
		if (bytes.toString('utf8') !== file.content) { return Object.freeze({ state: 'unavailable', sha256: file.sha256, reason: 'invalidUtf8' }); }
		return Object.freeze({ state: 'text', sha256: file.sha256 });
	}
	if (value.state === 'unavailable' && (exactKeys(value, ['state', 'reason']) || exactKeys(value, ['state', 'file', 'reason']))) {
		const file = value.file;
		if (typeof value.reason !== 'string' || value.reason.length > 1024 || /[\r\n\0]/u.test(value.reason) || (file !== undefined && (!isRecord(file) || !exactKeysWithOptionalExecutable(file, ['path', 'kind', 'size', 'sha256', 'contentUnavailableReason']) || file.path !== path || file.kind !== 'file'
			|| !Number.isSafeInteger(file.size) || (file.size as number) < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)
			|| !isUnavailableReason(file.contentUnavailableReason)))) {
			return Object.freeze({ state: 'unavailable', sha256: null, reason: 'invalidHash' });
		}
		const unavailableReason = file ? file.contentUnavailableReason as AgentSessionContentUnavailableReason : /missing|no durable|no retained|no before|no after/iu.test(value.reason) ? 'missing' : 'unavailable';
		return Object.freeze({ state: 'unavailable', sha256: file && typeof file.sha256 === 'string' ? file.sha256 : null, reason: unavailableReason });
	}
	throw new Error('Agent-session hunk input has an unknown or malformed content state.');
}

function copyRangeMapping(mapping: RangeMapping): { readonly original: AgentSessionChangeHunkRange; readonly modified: AgentSessionChangeHunkRange } {
	return Object.freeze({ original: copyRange(mapping.originalRange), modified: copyRange(mapping.modifiedRange) });
}

function copyRange(range: RangeMapping['originalRange']): AgentSessionChangeHunkRange {
	return Object.freeze({
		startLineNumber: range.startLineNumber, startColumn: range.startColumn,
		endLineNumber: range.endLineNumber, endColumn: range.endColumn,
	});
}

function freezeResult(value: AgentSessionChangeHunksDTO): AgentSessionChangeHunksDTO {
	return Object.freeze({ ...value, scope: Object.freeze({ ...value.scope }), before: Object.freeze({ ...value.before }), after: Object.freeze({ ...value.after }), hunks: Object.freeze([...value.hunks]) });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'); }
function exactKeysWithOptionalExecutable(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return exactKeys(value, keys) || (exactKeys(value, [...keys, 'executable']) && typeof value.executable === 'boolean');
}
function sameLines(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((line, index) => line === right[index]); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isUnavailableReason(value: unknown): value is AgentSessionContentUnavailableReason { return value === 'binary' || value === 'invalidUtf8' || value === 'fileTooLarge' || value === 'contentFileLimit' || value === 'retainedTextLimit'; }
function isSafeRelativePath(value: string): boolean { return value.length > 0 && Buffer.byteLength(value, 'utf8') <= 4096 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(part => part === '' || part === '.' || part === '..'); }
function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
