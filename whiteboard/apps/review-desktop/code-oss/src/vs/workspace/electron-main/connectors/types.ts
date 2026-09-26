/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ConnectorId = 'slack' | 'notion';

/** Connector output accepted by WorkspaceKnowledgeStore.importReference after projectId is added. */
export interface ImportedReferenceInput {
	readonly connectorId: ConnectorId;
	readonly connectorVersion: string;
	readonly externalId: string;
	readonly sourceUri: string;
	readonly accountRef: string;
	readonly title: string;
	readonly contentType: string;
	readonly content: Uint8Array;
	/** UTF-8 display text derived from the provider response. */
	readonly derivedText: string;
	readonly omissions: readonly string[];
}

/** Resolves an opaque local account ID to an in-memory secret; callers own Keychain storage. */
export interface ConnectorCredentialResolver {
	resolve(connector: ConnectorId, accountRef: string): Promise<string | undefined>;
}

export interface ConnectorTransport {
	fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export const defaultConnectorTransport: ConnectorTransport = { fetch: (input, init) => globalThis.fetch(input, init) };

export const connectorRequestTimeoutMs = 15_000;
export const maxConnectorResponseBytes = 2 * 1024 * 1024;
export const maxReferenceBytes = 1 * 1024 * 1024;

/** Formats a bounded, actionable Retry-After value for the connector's user-visible error. */
export function retryAfterGuidance(value: string | null, now = Date.now()): string {
	const header = value?.trim();
	if (!header) { return 'Retry the import later.'; }
	let seconds: number;
	if (/^\d+$/.test(header)) {
		seconds = Number(header);
	} else {
		const httpDate = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/;
		if (!httpDate.test(header)) { return 'Retry the import later.'; }
		const asctimeDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
		const retryAt = Date.parse(asctimeDate.test(header) ? `${header} GMT` : header);
		if (!Number.isFinite(retryAt)) { return 'Retry the import later.'; }
		seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
	}
	if (!Number.isSafeInteger(seconds) || seconds > 24 * 60 * 60) { return 'Retry after more than 24 hours.'; }
	return seconds === 0 ? 'Retry now.' : `Retry after ${seconds} seconds.`;
}

export function requireAccountRef(value: string): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
		throw new Error('A valid opaque connector account reference is required.');
	}
	return value;
}

export function requireCredential(value: string | undefined, connector: ConnectorId): string {
	if (!value || value.length > 8192 || /[\r\n]/.test(value)) {
		throw new Error(`Connect a valid ${connector === 'slack' ? 'Slack' : 'Notion'} account before importing.`);
	}
	return value;
}

export async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
	return (await readJsonResponseWithBytes(response)).payload;
}

export async function readJsonResponseWithBytes(response: Response): Promise<{ payload: Record<string, unknown>; bytes: Uint8Array }> {
	if (!response.ok) {
		throw new Error(`Connector request failed with HTTP ${response.status}.`);
	}
	const length = Number(response.headers.get('content-length'));
	if (Number.isFinite(length) && length > maxConnectorResponseBytes) {
		throw new Error('Connector response exceeded the 2 MiB limit.');
	}
	if (!response.body) { throw new Error('Connector returned an empty response.'); }
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) { break; }
		totalBytes += value.byteLength;
		if (totalBytes > maxConnectorResponseBytes) {
			await reader.cancel();
			throw new Error('Connector response exceeded the 2 MiB limit.');
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	let value: unknown;
	try { value = JSON.parse(body); }
	catch { throw new Error('Connector returned an invalid response.'); }
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Connector returned an invalid response.');
	}
	return { payload: value as Record<string, unknown>, bytes };
}

export function encodeSourceArtifact(entries: readonly { readonly request: string; readonly bytes: Uint8Array }[]): Uint8Array {
	const artifact = new TextEncoder().encode(JSON.stringify(entries.map(entry => ({ request: entry.request, responseBase64: Buffer.from(entry.bytes).toString('base64') }))));
	if (artifact.byteLength > maxSourceArtifactBytes) { throw new SourceArtifactLimitError(); }
	return artifact;
}

const maxSourceArtifactBytes = 15 * 1024 * 1024;

export class SourceArtifactLimitError extends Error {
	constructor() { super('Source response artifact exceeded the 15 MiB import limit.'); this.name = 'SourceArtifactLimitError'; }
}

export function wouldExceedSourceArtifactLimit(entries: readonly { readonly request: string; readonly bytes: Uint8Array }[], next: { readonly request: string; readonly bytes: Uint8Array }): boolean {
	return new TextEncoder().encode(JSON.stringify([...entries, next].map(entry => ({ request: entry.request, responseBase64: Buffer.from(entry.bytes).toString('base64') })))).byteLength > maxSourceArtifactBytes;
}

export function encodeReferenceText(text: string, omissions: string[]): Uint8Array {
	const content = Buffer.from(text, 'utf8');
	if (content.byteLength > maxReferenceBytes) {
		const notice = Buffer.from('\n\n[Extracted text clipped at the 1 MiB limit.]', 'utf8');
		let end = maxReferenceBytes - notice.byteLength;
		while (end > 0 && (content[end] & 0xc0) === 0x80) { end--; }
		const truncated = Buffer.concat([content.subarray(0, end), notice]);
		omissions.push('Content truncated at the 1 MiB import limit.');
		return truncated;
	}
	return content;
}

export function boundedOmissions(omissions: readonly string[]): string[] {
	const unique = [...new Set(omissions)];
	return unique.length <= 50 ? unique : [...unique.slice(0, 49), 'Additional source fields or content were omitted; inspect the source artifact for complete details.'];
}

export function richText(value: unknown): string {
	if (!Array.isArray(value)) { return ''; }
	return value.map(item => {
		if (!item || typeof item !== 'object') { return ''; }
		const record = item as Record<string, unknown>;
		if (typeof record.plain_text === 'string') { return record.plain_text; }
		return '';
	}).join('');
}

export function safeTitle(value: string, fallback: string): string {
	const title = value.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 500);
	return title || fallback;
}
