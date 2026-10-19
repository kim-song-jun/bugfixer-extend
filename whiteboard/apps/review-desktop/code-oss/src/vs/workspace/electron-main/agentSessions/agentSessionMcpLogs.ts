/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AgentSessionTranscriptPageDTO, AgentSessionTranscriptPageOptions } from '../../common/workspaceAgentSessionProtocol.js';
import { sanitizeCompleteAgentText } from './agentOutputRedactor.js';

const MAX_FRAGMENT_CHARACTERS = 1_000;
const MAX_PAGE_ENTRIES = 20;

export interface AgentSessionMcpLogReadInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly afterSequence?: number;
	readonly limit?: number;
	readonly maxCharacters?: number;
	readonly kind?: AgentSessionTranscriptPageOptions['kind'];
	readonly severity?: AgentSessionTranscriptPageOptions['severity'];
	readonly source?: AgentSessionTranscriptPageOptions['source'];
	readonly cursor?: string;
}

interface LogCursor {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly sequence: number;
	readonly offset: number;
	readonly textHash: string;
	readonly kind?: AgentSessionTranscriptPageOptions['kind'];
	readonly severity?: AgentSessionTranscriptPageOptions['severity'];
	readonly source?: AgentSessionTranscriptPageOptions['source'];
}

/** Reads only retained transcript entries and emits bounded, whole-entry-redacted fragments. */
export function readAgentSessionMcpLogs(
	readPage: (afterSequence: number, options: AgentSessionTranscriptPageOptions) => AgentSessionTranscriptPageDTO,
	input: AgentSessionMcpLogReadInput,
	knownSecrets: readonly string[],
	authorizeRead: () => void,
): unknown {
	const limit = input.limit ?? 20;
	const maxCharacters = input.maxCharacters ?? MAX_FRAGMENT_CHARACTERS;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_ENTRIES) { throw new Error('Transcript page limit must be from 1 to 20.'); }
	if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > MAX_FRAGMENT_CHARACTERS) { throw new Error('Transcript fragment limit must be from 1 to 1000 characters.'); }
	let filters: Pick<LogCursor, 'kind' | 'severity' | 'source'> = { ...(input.kind ? { kind: input.kind } : {}), ...(input.severity ? { severity: input.severity } : {}), ...(input.source ? { source: input.source } : {}) };
	let state: LogCursor | undefined;
	let afterSequence = input.afterSequence ?? 0;
	if (input.cursor !== undefined) {
		if (input.afterSequence !== undefined) { throw new Error('A transcript cursor cannot be combined with afterSequence.'); }
		state = decodeCursor(input.cursor, knownSecrets);
		if (state.projectId !== input.projectId || state.sessionId !== input.sessionId || state.turnId !== input.turnId
			|| (input.kind !== undefined && state.kind !== input.kind) || (input.severity !== undefined && state.severity !== input.severity)
			|| (input.source !== undefined && state.source !== input.source)) {
			throw new Error('The transcript cursor belongs to a different scope or filter.');
		}
		filters = { ...(state.kind ? { kind: state.kind } : {}), ...(state.severity ? { severity: state.severity } : {}), ...(state.source ? { source: state.source } : {}) };
		if (state.textHash === '') { afterSequence = state.sequence; state = undefined; }
	} else if (input.afterSequence !== undefined && (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0)) {
		throw new Error('Transcript cursor must be a non-negative safe integer.');
	}

	const entries: unknown[] = [];
	if (state) { afterSequence = state.sequence - 1; }
	let hasMore = false;
	let nextCursor: string | null = null;
	let highestSequence = 0;
	let firstRetainedSequence: number | null = null;
	let gaps: Array<{ afterSequence: number; throughSequence: number }> = [];
	while (entries.length < limit) {
		authorizeRead();
		const page = readPage(afterSequence, { ...filters, afterSequence, limit: 1 });
		highestSequence = Math.max(highestSequence, page.highestSequence);
		if (page.firstRetainedSequence !== null && (firstRetainedSequence === null || page.firstRetainedSequence > firstRetainedSequence)) {
			firstRetainedSequence = page.firstRetainedSequence;
		}
		gaps = mergeGaps(gaps, page.gaps);
		const entry = page.entries[0];
		if (!entry) {
			if (state) { throw expiredFragmentCursor(state, page); }
			afterSequence = Math.max(afterSequence, page.nextSequence);
			hasMore = false;
			break;
		}
		if (state && state.sequence !== entry.sequence) { throw expiredFragmentCursor(state, page); }
		const safeText = sanitizeCompleteAgentText(entry.text, { knownSecrets });
		const textHash = createHash('sha256').update(safeText, 'utf8').digest('hex');
		const offset = state?.sequence === entry.sequence ? state.offset : 0;
		if (state && state.sequence === entry.sequence && state.textHash !== textHash) { throw new Error('The transcript entry changed after its cursor was issued.'); }
		const characters = [...safeText];
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > characters.length) { throw new Error('The transcript fragment cursor is invalid.'); }
		const end = Math.min(offset + maxCharacters, characters.length);
		const references = entry.references.map(reference => ({ kind: reference.kind, id: sanitizeCompleteAgentText(reference.id, { knownSecrets }) }));
		const resultEntry = { sequence: entry.sequence, kind: entry.kind, severity: entry.severity, source: entry.source,
			references,
			createdAt: entry.createdAt, textFragment: characters.slice(offset, end).join(''), afterCharacter: offset, nextCharacter: end,
			totalCharacters: characters.length, hasMoreFragments: end < characters.length,
			redactionApplied: safeText !== entry.text || references.some((reference, index) => reference.id !== entry.references[index].id) };
		if (!fitsMcpResult({ entries: [...entries, resultEntry], nextSequence: end < characters.length ? afterSequence : entry.sequence,
			highestSequence, firstRetainedSequence, gaps: gapsThrough(gaps, end < characters.length ? afterSequence : entry.sequence),
			hasMore: end < characters.length || page.hasMore, nextCursor: 'x'.repeat(2_048) })) {
			if (!entries.length) { throw new Error('A transcript entry cannot be represented within the session MCP response limit.'); }
			hasMore = true;
			nextCursor = encodeCursor({ ...scopeAndFilters(input, filters), sequence: entry.sequence, offset: 0, textHash }, knownSecrets);
			break;
		}
		entries.push(resultEntry);
		if (end < characters.length) {
			nextCursor = encodeCursor({ ...scopeAndFilters(input, filters), sequence: entry.sequence, offset: end, textHash }, knownSecrets);
			hasMore = true;
			break;
		}
		afterSequence = entry.sequence;
		state = undefined;
		hasMore = page.hasMore;
		if (!page.hasMore) { break; }
	}
	if (!nextCursor && hasMore) {
		nextCursor = encodeCursor({ ...scopeAndFilters(input, filters), sequence: afterSequence, offset: 0, textHash: '' }, knownSecrets);
	}
	return { entries, nextSequence: afterSequence, highestSequence, firstRetainedSequence,
		gaps: gapsThrough(gaps, afterSequence), hasMore, nextCursor };
}

function mergeGaps(current: readonly { afterSequence: number; throughSequence: number }[], added: readonly { afterSequence: number; throughSequence: number }[]): Array<{ afterSequence: number; throughSequence: number }> {
	const ordered = [...current, ...added].sort((left, right) => left.afterSequence - right.afterSequence || left.throughSequence - right.throughSequence);
	const merged: Array<{ afterSequence: number; throughSequence: number }> = [];
	for (const gap of ordered) {
		const previous = merged[merged.length - 1];
		if (previous && gap.afterSequence <= previous.throughSequence) {
			merged[merged.length - 1] = { afterSequence: previous.afterSequence, throughSequence: Math.max(previous.throughSequence, gap.throughSequence) };
		} else {
			merged.push({ afterSequence: gap.afterSequence, throughSequence: gap.throughSequence });
		}
	}
	return merged;
}

function gapsThrough(gaps: readonly { afterSequence: number; throughSequence: number }[], sequence: number) {
	return gaps.filter(gap => gap.afterSequence < sequence).map(gap => ({
		afterSequence: gap.afterSequence,
		throughSequence: Math.min(gap.throughSequence, sequence),
	}));
}

function expiredFragmentCursor(cursor: LogCursor, page: AgentSessionTranscriptPageDTO): Error {
	const gaps = page.gaps.slice(0, 4);
	const moreGaps = page.gaps.length > gaps.length ? `, omitted=${page.gaps.length - gaps.length}` : '';
	return new Error(`Transcript fragment cursor expired: sequence ${cursor.sequence} is no longer retained; firstRetainedSequence=${page.firstRetainedSequence ?? 'none'}, highestSequence=${page.highestSequence}, gaps=${JSON.stringify(gaps)}${moreGaps}.`);
}

function scopeAndFilters(input: AgentSessionMcpLogReadInput, filters: Pick<LogCursor, 'kind' | 'severity' | 'source'>) {
	return { projectId: input.projectId, sessionId: input.sessionId, turnId: input.turnId, ...filters };
}

function encodeCursor(cursor: LogCursor, knownSecrets: readonly string[]): string {
	const key = knownSecrets.at(-1);
	if (!key) { throw new Error('A trusted capability key is required for transcript cursors.'); }
	const payload = JSON.stringify(cursor);
	return Buffer.from(JSON.stringify({ payload: cursor, signature: createHmac('sha256', key).update(payload, 'utf8').digest('hex') }), 'utf8').toString('base64url');
}

function fitsMcpResult(result: unknown): boolean {
	const toolResult = { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
	const bridgeFrame = `${JSON.stringify({ type: 'response', id: 'x'.repeat(32), result })}\n`;
	const mcpFrame = `${JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(32), result: toolResult })}\n`;
	return Buffer.byteLength(bridgeFrame, 'utf8') <= 65_024 && Buffer.byteLength(mcpFrame, 'utf8') <= 65_024;
}

function decodeCursor(value: string, knownSecrets: readonly string[]): LogCursor {
	if (typeof value !== 'string' || value.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(value)) { throw new Error('The transcript cursor is invalid.'); }
	let parsed: unknown;
	try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new Error('The transcript cursor is invalid.'); }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error('The transcript cursor is invalid.'); }
	const envelope = parsed as Record<string, unknown>;
	if (Object.keys(envelope).length !== 2 || !('payload' in envelope) || typeof envelope.signature !== 'string' || !/^[0-9a-f]{64}$/u.test(envelope.signature)
		|| !envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) { throw new Error('The transcript cursor is invalid.'); }
	const key = knownSecrets.at(-1);
	if (!key) { throw new Error('A trusted capability key is required for transcript cursors.'); }
	const expectedSignature = createHmac('sha256', key).update(JSON.stringify(envelope.payload), 'utf8').digest();
	const actualSignature = Buffer.from(envelope.signature, 'hex');
	if (!timingSafeEqual(actualSignature, expectedSignature)) { throw new Error('The transcript cursor signature is invalid.'); }
	const cursor = envelope.payload as Record<string, unknown>;
	const allowed = ['projectId', 'sessionId', 'turnId', 'sequence', 'offset', 'textHash', 'kind', 'severity', 'source'];
	if (Object.keys(cursor).some(key => !allowed.includes(key)) || typeof cursor.projectId !== 'string' || typeof cursor.sessionId !== 'string'
		|| typeof cursor.turnId !== 'string' || !Number.isSafeInteger(cursor.sequence) || (cursor.sequence as number) < 1
		|| !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0 || typeof cursor.textHash !== 'string'
		|| (cursor.textHash !== '' && !/^[0-9a-f]{64}$/u.test(cursor.textHash))
		|| (cursor.kind !== undefined && !['terminal', 'log'].includes(String(cursor.kind)))
		|| (cursor.severity !== undefined && !['debug', 'info', 'warning', 'error'].includes(String(cursor.severity)))
		|| (cursor.source !== undefined && !['pty', 'provider', 'host', 'workspace'].includes(String(cursor.source)))) {
		throw new Error('The transcript cursor is invalid.');
	}
	return cursor as unknown as LogCursor;
}
