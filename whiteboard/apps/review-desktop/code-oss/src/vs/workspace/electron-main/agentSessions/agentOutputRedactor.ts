/**
 * Streaming, bounded-memory redaction for agent terminal output.
 *
 * This is a credential-pattern filter, not a secret detector. Callers must pass
 * trusted launch secrets (for example, per-session MCP capabilities) explicitly.
 * It cannot identify arbitrary unlabelled account-file contents that happen to
 * appear as ordinary text. Complete CSI terminal commands are retained for
 * interactive terminals, while matching uses a control-free projection so a
 * secret split by CSI commands is still recognized and redacted. OSC and other
 * string controls are removed because their payload is not terminal content.
 */
export interface AgentPtyOutputSanitizer {
	push(text: string): string;
	flush(): string;
}

export interface AgentOutputRedactorOptions {
	/** Values from trusted launch configuration. Empty values are ignored. */
	knownSecrets?: readonly string[];
	/** Maximum raw code units retained between calls. Defaults to 4096. */
	maxPendingCodeUnits?: number;
}

type ActiveMask = { kind: 'token' | 'field'; quote: string | undefined; quoteOpened: boolean; valueStarted: boolean; escaped: boolean; markerEmitted: boolean } | { kind: 'pem'; tail: string; footer: string | undefined };

const DEFAULT_MAX_PENDING = 4096;
const MAX_PENDING_LIMIT = 65536;
const REDACTION = '***';
const ESC = '\u001b';

type ControlSequenceKind = 'csi' | 'osc' | 'string';

/** One parser owns all ANSI state, including bytes arriving while a value is masked. */
class StreamingTerminalControlParser {
	private pending = '';
	private discarding: ControlSequenceKind | undefined;
	private stringSawEscape = false;

	constructor(private readonly maxPending: number) { }

	push(chunk: string): { text: string; overflowed: boolean } {
		const input = this.pending + chunk;
		this.pending = '';
		let output = '';
		let overflowed = false;
		let index = 0;
		while (index < input.length) {
			if (this.discarding) {
				const end = this.findDiscardEnd(input, index);
				if (end < 0) { return { text: output, overflowed }; }
				index = end;
				this.discarding = undefined;
				this.stringSawEscape = false;
				continue;
			}
			const code = input.charCodeAt(index);
			if (input[index] === ESC) {
				if (index + 1 >= input.length) { this.holdOrDiscard(input.slice(index), 'string'); return { text: output, overflowed: this.consumeOverflowFlag() }; }
				const kind = this.kindFor(input.charCodeAt(index + 1));
				if (kind === 'csi') {
					const end = this.findCsiEnd(input, index + 2);
					if (end < 0) { this.holdOrDiscard(input.slice(index), 'csi'); return { text: output, overflowed: this.consumeOverflowFlag() }; }
					const sequence = input.slice(index, end);
					output += sequence;
					index = end;
					continue;
				}
				if (kind) {
					const end = this.findStringEnd(input, index + 2, kind);
					if (end < 0) { this.holdOrDiscard(input.slice(index), kind); return { text: output, overflowed: this.consumeOverflowFlag() }; }
					index = end;
					continue;
				}
				index += 2;
				continue;
			}
			if (code === 0x9b || code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
				const kind: ControlSequenceKind = code === 0x9b ? 'csi' : code === 0x9d ? 'osc' : 'string';
				const end = kind === 'csi' ? this.findCsiEnd(input, index + 1) : this.findStringEnd(input, index + 1, kind);
				if (end < 0) { this.holdOrDiscard(input.slice(index), kind); return { text: output, overflowed: this.consumeOverflowFlag() }; }
				if (kind === 'csi') { output += input.slice(index, end); }
				index = end;
				continue;
			}
			const value = String.fromCodePoint(input.codePointAt(index)!);
			if ((code >= 0x20 || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0d) && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) { output += value; }
			index += value.length;
		}
		return { text: output, overflowed };
	}

	flush(): boolean {
		const hadIncomplete = this.pending.length > 0 || this.discarding !== undefined;
		this.pending = '';
		this.discarding = undefined;
		this.stringSawEscape = false;
		return hadIncomplete;
	}

	private overflowFlag = false;
	private consumeOverflowFlag(): boolean {
		const overflowed = this.overflowFlag;
		this.overflowFlag = false;
		return overflowed;
	}

	private holdOrDiscard(suffix: string, kind: ControlSequenceKind): void {
		if (suffix.length <= this.maxPending) { this.pending = suffix; return; }
		this.discarding = kind;
		this.stringSawEscape = false;
		this.overflowFlag = true;
	}

	private kindFor(code: number): ControlSequenceKind | undefined {
		if (code === 0x5b) { return 'csi'; }
		if (code === 0x5d) { return 'osc'; }
		if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) { return 'string'; }
		return undefined;
	}

	private findCsiEnd(input: string, start: number): number {
	for (let index = start; index < input.length; index++) {
		const code = input.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) { return index + 1; }
	}
	return -1;
	}

	private findStringEnd(input: string, start: number, kind: ControlSequenceKind): number {
	for (let index = start; index < input.length; index++) {
		if (kind === 'osc' && input.charCodeAt(index) === 0x07) { return index + 1; }
		if (input[index] === ESC && input[index + 1] === '\\') { return index + 2; }
	}
	return -1;
	}

	private findDiscardEnd(input: string, start: number): number {
	if (this.discarding === 'csi') { return this.findCsiEnd(input, start); }
	for (let index = start; index < input.length; index++) {
		const code = input.charCodeAt(index);
		if (this.discarding === 'osc' && code === 0x07) { return index + 1; }
		if (this.stringSawEscape) {
			this.stringSawEscape = false;
			if (input[index] === '\\') { return index + 1; }
		}
		if (input[index] === ESC) { this.stringSawEscape = true; }
	}
	return -1;
	}
}

/** Create one sanitizer per output stream; do not share it across sessions. */
export function createAgentPtyOutputSanitizer(options: AgentOutputRedactorOptions = {}): AgentPtyOutputSanitizer {
	if (options.maxPendingCodeUnits !== undefined && (!Number.isFinite(options.maxPendingCodeUnits) || !Number.isInteger(options.maxPendingCodeUnits))) {
		throw new RangeError('maxPendingCodeUnits must be a finite integer.');
	}
	if (options.knownSecrets !== undefined && (!Array.isArray(options.knownSecrets) || options.knownSecrets.some(secret => typeof secret !== 'string'))) {
		throw new TypeError('knownSecrets must be an array of strings.');
	}
	const knownSecrets = [...new Set((options.knownSecrets ?? []).filter(secret => secret.length > 0))]
		.sort((left, right) => right.length - left.length);
	if (knownSecrets.length > 1024 || knownSecrets.reduce((total, secret) => total + secret.length, 0) > MAX_PENDING_LIMIT) {
		throw new RangeError('Trusted secrets exceed the bounded secret-set limit.');
	}
	const requestedMaxPending = Math.max(128, Math.min(MAX_PENDING_LIMIT, Math.floor(options.maxPendingCodeUnits ?? DEFAULT_MAX_PENDING)));
	const longestSecret = knownSecrets.reduce((max, secret) => Math.max(max, secret.length), 0);
	if (longestSecret > MAX_PENDING_LIMIT - 128) {
		throw new RangeError(`Trusted secret exceeds the ${MAX_PENDING_LIMIT - 128} code-unit limit.`);
	}
	const maxPending = Math.max(requestedMaxPending, longestSecret + 128);
	const knownSecretTrie = buildSecretTrie(knownSecrets);
	const controlParser = new StreamingTerminalControlParser(maxPending);
	let pending = '';
	let activeMask: ActiveMask | undefined;
	let ended = false;

	const sanitize = (raw: string): string => {
		const cleaned = raw;
		const { text, rawOffsets, rawEnds } = normalizeTerminalText(cleaned);
		if (!text.length) {
			return cleaned;
		}
		const ranges = findSensitiveRanges(text, knownSecretTrie);
		if (!ranges.length) { return cleaned; }
		ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
		const merged: Array<[number, number]> = [];
		for (const range of ranges) {
			const last = merged[merged.length - 1];
			if (last && range[0] <= last[1]) { last[1] = Math.max(last[1], range[1]); }
			else { merged.push([...range]); }
		}
		let output = '';
		let rawCursor = 0;
		for (const [start, end] of merged) {
			const rawStart = rawOffsets[start];
			const rawEnd = rawEnds[end - 1] ?? cleaned.length;
			output += cleaned.slice(rawCursor, rawStart) + REDACTION;
			rawCursor = rawEnd;
		}
		return output + cleaned.slice(rawCursor);
	};

	return {
		push(text: string): string {
			if (ended) { throw new Error('Cannot push output after sanitizer flush.'); }
			const parsed = controlParser.push(text);
			let input = parsed.text;
			let output = parsed.overflowed ? REDACTION : '';
			while (input.length > 0) {
				if (activeMask) {
					const active = consumeMasked(activeMask, input);
					activeMask = active.mode;
					output += active.output;
					if (!active.remainder) { return output; }
					input = active.remainder;
					continue;
				}
				const combined = pending + input;
				pending = '';
				const complete = combined.length;
				const completeText = combined.slice(0, complete);
				let candidate = findOpenSensitiveTail(completeText, knownSecretTrie);
				const projection = normalizeTerminalText(completeText);
				const completeSensitiveRanges = findSensitiveRanges(projection.text, knownSecretTrie);
				if (candidate && completeSensitiveRanges.some(([start, end]) => {
					const rawStart = projection.rawOffsets[start];
					const rawEnd = projection.rawEnds[end - 1];
					return rawStart < candidate!.start && candidate!.start < rawEnd;
				})) {
					// A partial prefix at the end of a complete value must not make us
					// sanitize only its prefix (notably the final dashes of a PEM footer).
					candidate = undefined;
				}
				if (candidate && complete - candidate.start > maxPending) {
					const maskStart = candidate.kind === 'field' && candidate.releasePrefix ? candidate.valueStart : candidate.start;
					output += sanitize(combined.slice(0, maskStart)) + REDACTION;
					activeMask = candidate.kind === 'pem'
						? { kind: 'pem', tail: '', footer: candidate.pemFooter }
						: { kind: candidate.kind, quote: candidate.quote, quoteOpened: false, valueStarted: true, escaped: false, markerEmitted: true };
					const body = combined.slice(candidate.valueStart, complete);
					const consumed = consumeMasked(activeMask, body);
					activeMask = consumed.mode;
					input = consumed.remainder + combined.slice(complete);
					continue;
				}
				if (candidate?.kind === 'field' && candidate.releasePrefix) {
					output += sanitize(combined.slice(0, candidate.valueStart));
					activeMask = { kind: 'field', quote: candidate.quote, quoteOpened: false, valueStarted: false, escaped: false, markerEmitted: false };
					const active = consumeMasked(activeMask, combined.slice(candidate.valueStart, complete));
					activeMask = active.mode;
					output += active.output;
					if (active.remainder) { input = active.remainder; continue; }
					return output;
				}
				let safeEnd = candidate ? candidate.start : findCandidateHoldStart(completeText, knownSecretTrie);
				for (const [start, end] of completeSensitiveRanges) {
					const rawStart = projection.rawOffsets[start];
					const rawEnd = projection.rawEnds[end - 1];
					if (rawStart < safeEnd && safeEnd < rawEnd) {
						// Sanitize the whole recognized value in one pass instead of
						// buffering an arbitrarily large PEM/token tail.
						safeEnd = rawEnd;
					}
				}
				const boundary = safeEnd > 0 ? codePointBoundary(combined, Math.min(safeEnd, complete)) : 0;
				if (!boundary) {
					// An incomplete or hostile control sequence must never grow without bound.
					if (combined.length > maxPending) {
						pending = '';
						return output + REDACTION;
					}
					pending = combined;
					return output;
				}
				output += sanitize(combined.slice(0, boundary));
				pending = combined.slice(boundary);
				if (pending.length > maxPending) {
					pending = '';
					return output + REDACTION;
				}
				return output;
			}
			return output;
		},
		flush(): string {
			if (ended) { return ''; }
			ended = true;
			const controlGap = controlParser.flush();
			const remainder = pending;
			pending = '';
			if (activeMask) { activeMask = undefined; return controlGap ? REDACTION : ''; }
			const candidate = findOpenSensitiveTail(remainder, knownSecretTrie);
			if (candidate) {
				return (controlGap ? REDACTION : '') + sanitize(remainder.slice(0, candidate.start)) + REDACTION;
			}
			return (controlGap ? REDACTION : '') + sanitize(remainder);
		}
	};
}

/** Credential-shaped values and labelled account-file material. */
interface CredentialPattern {
	readonly pattern: RegExp;
	/** Start of the value to redact relative to a match; omitted means redact the complete match. */
	readonly valueOffset?: (match: RegExpExecArray) => number;
}

const credentialPatterns: readonly CredentialPattern[] = [
	{ pattern: /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/gi },
	{ pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16})\b/gi },
	{ pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
	{ pattern: /\b(authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi, valueOffset: match => match[1].length },
	{
		pattern: /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|credential)\s*[=:])\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
		valueOffset: match => {
			let offset = match[1].length;
			while (offset < match[0].length && /\s/.test(match[0][offset])) { offset++; }
			return offset;
		}
	},
];

/** Remove unsafe controls, retain SGR styling, and map visible indexes to raw offsets. */
function normalizeTerminalText(raw: string): { text: string; rawOffsets: number[]; rawEnds: number[] } {
	let text = '';
	const rawOffsets: number[] = [];
	const rawEnds: number[] = [];
	for (let i = 0; i < raw.length;) {
		if (raw.charCodeAt(i) === 0x9b) {
			const end = c1CsiEnd(raw, i + 1);
			if (end >= 0) { i = end; continue; }
		}
		if (raw[i] === ESC) {
			const end = escapeEnd(raw, i);
			if (end < 0) { break; }
			const sequence = raw.slice(i, end);
			if (/^\u001b\[[0-?]*[ -/]*m$/.test(sequence)) {
				// SGR codes are kept in output but excluded from matching; map gaps to next visible char.
			}
			i = end;
			continue;
		}
		const cp = raw.codePointAt(i)!;
		const value = String.fromCodePoint(cp);
		if ((cp >= 0x20 || cp === 0x0a || cp === 0x09) && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f) && !isZeroWidth(cp)) {
			text += value;
			for (let j = 0; j < value.length; j++) { rawOffsets.push(i); rawEnds.push(i + value.length); }
		}
		i += value.length;
	}
	return { text, rawOffsets, rawEnds };
}

function escapeEnd(text: string, start: number): number {
	if (text[start + 1] !== '[') { return start + 2; }
	for (let index = start + 2; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) { return index + 1; }
	}
	return -1;
}

const credentialPrefixes = [
	'authorization:', 'authorization :', 'bearer ', 'basic ', 'api_key=', 'api-key=', 'apikey=',
	'access_token=', 'access-token=', 'refresh_token=', 'refresh-token=', 'auth_token=', 'auth-token=',
	'client_secret=', 'client-secret=', 'password=', 'passwd=', 'secret=', 'credential=',
	'-----begin private key-----', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_',
	'sk-', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'akia', 'eyj'
];

function findCandidateHoldStart(raw: string, knownSecretTrie: SecretTrieNode): number {
	const { text, rawOffsets } = normalizeTerminalText(raw);
	let heldVisibleLength = 0;
	const lower = text.toLowerCase();
	for (const prefix of credentialPrefixes) {
		const limit = Math.min(prefix.length, text.length);
		for (let length = 1; length <= limit; length++) {
			if (lower.endsWith(prefix.slice(0, length))) { heldVisibleLength = Math.max(heldVisibleLength, length); }
		}
	}
	const state = stepSecretTrie(knownSecretTrie, text);
	heldVisibleLength = Math.max(heldVisibleLength, state.depth);
	return heldVisibleLength ? rawOffsets[text.length - heldVisibleLength] : raw.length;
}

interface SecretTrieNode {
	next: Map<string, SecretTrieNode>;
	fail: SecretTrieNode;
	depth: number;
	outputs: number[];
}

const rootSecretNode = (): SecretTrieNode => ({ next: new Map(), fail: undefined as unknown as SecretTrieNode, depth: 0, outputs: [] });

function buildSecretTrie(secrets: readonly string[]): SecretTrieNode {
	const root = rootSecretNode();
	root.fail = root;
	for (const secret of secrets) {
		let node = root;
		for (let index = 0; index < secret.length; index++) {
			const character = secret[index];
			let next = node.next.get(character);
			if (!next) { next = rootSecretNode(); next.depth = node.depth + 1; node.next.set(character, next); }
			node = next;
		}
		node.outputs.push(secret.length);
	}
	const queue = [...root.next.values()];
	for (const child of queue) { child.fail = root; }
	for (let index = 0; index < queue.length; index++) {
		const node = queue[index];
		for (const [character, child] of node.next) {
			let fallback = node.fail;
			while (fallback !== root && !fallback.next.has(character)) { fallback = fallback.fail; }
			child.fail = fallback.next.get(character) ?? root;
			child.outputs.push(...child.fail.outputs);
			queue.push(child);
		}
	}
	return root;
}

function findSensitiveRanges(text: string, root: SecretTrieNode): Array<[number, number]> {
	const ranges = findKnownSecretRanges(text, root);
	for (const { pattern, valueOffset } of credentialPatterns) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			const start = match.index + (valueOffset?.(match) ?? 0);
			const end = match.index + match[0].length;
			if (start < end) { ranges.push([start, end]); }
			if (!match[0].length) { pattern.lastIndex++; }
		}
	}
	ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
	return ranges;
}

function findKnownSecretRanges(text: string, root: SecretTrieNode): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let node = root;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		while (node !== root && !node.next.has(character)) { node = node.fail; }
		node = node.next.get(character) ?? root;
		for (const length of node.outputs) { ranges.push([index - length + 1, index + 1]); }
	}
	return ranges;
}

function stepSecretTrie(root: SecretTrieNode, text: string): SecretTrieNode {
	let node = root;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		while (node !== root && !node.next.has(character)) { node = node.fail; }
		node = node.next.get(character) ?? root;
	}
	return node;
}

type OpenSensitiveTail = { start: number; valueStart: number; kind: 'field' | 'token' | 'pem'; quote?: string; pemFooter?: string; releasePrefix?: boolean };

function findOpenSensitiveTail(raw: string, knownSecretTrie: SecretTrieNode): OpenSensitiveTail | undefined {
	const { text, rawOffsets } = normalizeTerminalText(raw);
	const label = /\b(authorization\s*:\s*(?:bearer|basic)\s+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|credential)\s*[=:]\s*)(["']?)/gi;
	let match: RegExpExecArray | null;
	let candidate: OpenSensitiveTail | undefined;
	const consider = (next: OpenSensitiveTail) => {
		if (!candidate || next.start < candidate.start) { candidate = next; }
	};
	while ((match = label.exec(text)) !== null) {
		const valueIndex = match.index + match[0].length;
		const quote = match[2] === '"' || match[2] === "'" ? match[2] : undefined;
		const tail = text.slice(valueIndex);
		if (valueIndex === text.length || (tail.length && (quote ? findUnescapedQuote(tail, quote) < 0 : !/[\s,;]/.test(tail)))) {
			const contentStart = quote ? match.index + match[1].length : valueIndex;
			consider({ start: match.index, valueStart: contentStart, kind: 'field', quote, releasePrefix: !/^authorization/i.test(match[1]) });
		}
		if (!match[0].length) { label.lastIndex++; }
	}
	const authHeader = /\bauthorization\s*:\s*[^,\s;]*(?:\s+[^,\s;]*)?$/i.exec(text);
	if (authHeader) {
		consider({ start: authHeader.index, valueStart: text.length, kind: 'field' });
	}
	const labelTail = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|credential)\s*[=:]?\s*$/i.exec(text);
	if (labelTail) {
		consider({ start: labelTail.index, valueStart: text.length, kind: 'field' });
	}
	const pemStart = text.toLowerCase().lastIndexOf('-----begin ');
	if (pemStart >= 0) {
		const header = /-----BEGIN ([A-Z0-9 ]+)-----/i.exec(text.slice(pemStart));
		const footer = header ? `-----END ${header[1]}-----` : undefined;
		if (!footer || !text.slice(pemStart).toLowerCase().includes(footer.toLowerCase())) {
			consider({ start: pemStart, valueStart: pemStart, kind: 'pem', pemFooter: footer });
		}
	}
	const tokenPrefixes = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'sk-', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'akia', 'eyj'];
	for (const prefix of tokenPrefixes) {
		const index = text.toLowerCase().lastIndexOf(prefix);
		if (index >= 0 && !/[\s,;]/.test(text.slice(index + prefix.length))) {
			const valueIndex = index + prefix.length;
			consider({ start: index, valueStart: valueIndex, kind: 'token' });
		}
	}
	const secretState = stepSecretTrie(knownSecretTrie, text);
	if (secretState.depth && text.length >= secretState.depth) {
		const start = text.length - secretState.depth;
		consider({ start, valueStart: start, kind: 'token' });
	}
	if (!candidate) { return undefined; }
	return { ...candidate, start: rawOffsets[candidate.start] ?? raw.length, valueStart: rawOffsets[candidate.valueStart] ?? raw.length };
}

function consumeMasked(mode: ActiveMask, raw: string): { mode: ActiveMask | undefined; remainder: string; output: string } {
	const { text, rawOffsets, rawEnds } = normalizeTerminalText(raw);
	if (mode.kind === 'pem') {
		const combined = mode.tail + text;
		const footerIndex = mode.footer ? combined.toLowerCase().indexOf(mode.footer.toLowerCase()) : -1;
		const footerLength = mode.footer?.length ?? 0;
		if (footerIndex >= 0) {
			const footerEnd = footerIndex + footerLength;
			const consumedFromText = Math.max(0, footerEnd - mode.tail.length);
			const rawEnd = rawEnds[consumedFromText - 1] ?? 0;
			return { mode: undefined, remainder: raw.slice(rawEnd), output: '' };
		}
		const keep = Math.min(128, combined.length);
		return { mode: { ...mode, tail: combined.slice(-keep) }, remainder: '', output: '' };
	}
	let quote = mode.quote;
	let escaped = mode.escaped;
	let markerEmitted = mode.markerEmitted;
	let quoteOpened = mode.quoteOpened;
	let valueStarted = mode.valueStarted;
	let output = '';
	let rawCursor = 0;
	for (let index = 0; index < text.length; index++) {
		const rawGap = raw.slice(rawCursor, rawOffsets[index] ?? rawCursor);
		if (!quote && mode.kind === 'field' && !markerEmitted && !quoteOpened && (text[index] === '"' || text[index] === "'")) {
			output += rawGap;
			rawCursor = rawEnds[index] ?? raw.length;
			quote = text[index];
			quoteOpened = true;
			continue;
		}
		if (quote) {
			if (!quoteOpened) {
				output += rawGap;
				rawCursor = rawEnds[index] ?? raw.length;
				quoteOpened = true;
				if (text[index] === quote) { continue; }
			}
			if (escaped) { escaped = false; continue; }
			if (text[index] === '\\') { escaped = true; continue; }
			if (text[index] === quote) {
				if (!valueStarted && !markerEmitted) { output += REDACTION; markerEmitted = true; }
				return { mode: undefined, remainder: raw.slice(rawEnds[index] ?? raw.length), output };
			}
		} else if (!valueStarted && (text[index] === ' ' || text[index] === '\t')) {
			// Whitespace before the first value character is safe to display and
			// must be preserved so output does not depend on chunk boundaries.
			output += rawGap + raw.slice(rawOffsets[index] ?? rawCursor, rawEnds[index] ?? raw.length);
			rawCursor = rawEnds[index] ?? raw.length;
			continue;
		} else if (!valueStarted && (text[index] === '\n' || text[index] === '\r')) {
			return { mode: undefined, remainder: raw.slice((rawOffsets[index] ?? rawCursor)), output: output + rawGap };
		} else if (/[\s,;]/.test(text[index])) {
			return { mode: undefined, remainder: raw.slice((rawOffsets[index] ?? rawCursor)), output };
		}
		valueStarted = true;
		if (!markerEmitted && !quote) { output += rawGap; }
		if (!markerEmitted) { output += REDACTION; markerEmitted = true; }
	}
	return { mode: { ...mode, quote, quoteOpened, valueStarted, escaped, markerEmitted }, remainder: '', output };
}

function c1CsiEnd(text: string, start: number): number {
	for (let index = start; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) { return index + 1; }
	}
	return -1;
}

function findUnescapedQuote(text: string, quote: string): number {
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== quote) { continue; }
		let slashes = 0;
		for (let previous = index - 1; previous >= 0 && text[previous] === '\\'; previous--) { slashes++; }
		if (slashes % 2 === 0) { return index; }
	}
	return -1;
}

function codePointBoundary(text: string, index: number): number {
	return index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]) ? index - 1 : index;
}

function isZeroWidth(codePoint: number): boolean {
	return codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0xfeff;
}
