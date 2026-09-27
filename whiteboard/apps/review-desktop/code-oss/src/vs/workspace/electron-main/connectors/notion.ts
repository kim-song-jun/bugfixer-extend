/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	boundedOmissions, connectorRequestTimeoutMs, defaultConnectorTransport, encodeReferenceText, encodeSourceArtifact, requireAccountRef,
	readJsonResponseWithBytes, requireCredential, retryAfterGuidance, richText, safeTitle, SourceArtifactLimitError, wouldExceedSourceArtifactLimit,
	type ConnectorCredentialResolver, type ConnectorTransport, type ImportedReferenceInput,
} from './types.js';

const notionApiOrigin = 'https://api.notion.com/v1/';
const notionApiHost = new URL(notionApiOrigin).origin;
const notionVersion = '2026-03-11';
const maxPages = 20;
const maxPropertyPages = 20;
const maxBlocks = 400;
const maxDepth = 4;

export interface NotionPageImportRequest {
	readonly pageId: string;
	readonly accountRef: string;
}

export async function importNotionPage(
	request: NotionPageImportRequest,
	credentials: ConnectorCredentialResolver,
	transport: ConnectorTransport = defaultConnectorTransport,
): Promise<ImportedReferenceInput> {
	const pageId = normalizeNotionId(request.pageId);
	const accountRef = requireAccountRef(request.accountRef);
	const token = requireCredential(await credentials.resolve('notion', accountRef), 'notion');
	const headers = {
		Authorization: `Bearer ${token}`,
		'Notion-Version': notionVersion,
		Accept: 'application/json',
	};
	const artifacts: Array<{ request: string; bytes: Uint8Array }> = [];
	let artifactLimitReached = false;
	const fetchJson = async (path: string): Promise<Record<string, unknown>> => {
		const url = new URL(path, notionApiOrigin);
		if (url.origin !== notionApiHost) { throw new Error('Notion request escaped the official API origin.'); }
		const response = await transport.fetch(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(connectorRequestTimeoutMs) });
		throwIfNotionTokenRejected(response);
		if (response.status === 429) {
			const guidance = retryAfterGuidance(response.headers.get('retry-after'));
			await response.body?.cancel();
			throw new Error(`Notion rate limit reached. ${guidance}`);
		}
		const { payload, bytes: raw } = await readJsonResponseWithBytes(response);
		const artifact = { request: path, bytes: raw };
		if (wouldExceedSourceArtifactLimit(artifacts, artifact)) { throw new SourceArtifactLimitError(); }
		artifacts.push(artifact);
		return payload;
	};
	const page = await fetchJson(`pages/${pageId}`);
	if (page.object !== 'page') { throw new Error('Notion returned an invalid page response.'); }
	const omissions: string[] = [];
	await hydratePaginatedProperties(pageId, page.properties, fetchJson, omissions);
	const pageTitle = extractPageTitle(page.properties);
	const propertyLines = extractPageProperties(page.properties, omissions);
	const lines: string[] = [];
	let pagesFetched = 0;
	let blocksFetched = 0;
	let truncated = false;

	const readChildren = async (parentId: string, depth: number): Promise<void> => {
		let cursor: string | undefined;
		do {
			if (artifactLimitReached) { return; }
			if (pagesFetched >= maxPages || blocksFetched >= maxBlocks) { truncated = true; return; }
			const url = new URL(`blocks/${parentId}/children`, notionApiOrigin);
			url.searchParams.set('page_size', '100');
			if (cursor) {
				if (cursor.length > 2048) { throw new Error('Notion returned an invalid pagination cursor.'); }
				url.searchParams.set('start_cursor', cursor);
			}
			const response = await transport.fetch(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(connectorRequestTimeoutMs) });
			throwIfNotionTokenRejected(response);
			if (response.status === 429) {
				const guidance = retryAfterGuidance(response.headers.get('retry-after'));
				await response.body?.cancel();
				throw new Error(`Notion rate limit reached. ${guidance}`);
			}
			const { payload, bytes: raw } = await readJsonResponseWithBytes(response);
			const artifact = { request: `${url.pathname}${url.search}`, bytes: raw };
			if (wouldExceedSourceArtifactLimit(artifacts, artifact)) {
				truncated = true;
				artifactLimitReached = true;
				return;
			}
			artifacts.push(artifact);
			pagesFetched++;
			if (!Array.isArray(payload.results)) { throw new Error('Notion returned an invalid block response.'); }
			for (const value of payload.results) {
				if (blocksFetched >= maxBlocks) { truncated = true; return; }
				if (!value || typeof value !== 'object') { continue; }
				const block = value as Record<string, unknown>;
				blocksFetched++;
				const type = typeof block.type === 'string' ? block.type : '';
				const data = block[type] && typeof block[type] === 'object' ? block[type] as Record<string, unknown> : {};
				const text = extractBlockText(data) || (['bookmark', 'embed'].includes(type) && typeof data.url === 'string' ? data.url : '');
				const blockIdentity = typeof block.id === 'string' ? ` [${type || 'block'} ${block.id}]` : '';
				if (text) { lines.push(`${'  '.repeat(Math.min(depth, maxDepth))}${blockIdentity} ${text}`); }
				else if (type === 'divider') {
					lines.push(`${'  '.repeat(Math.min(depth, maxDepth))}${blockIdentity}`);
				} else {
					lines.push(`${'  '.repeat(Math.min(depth, maxDepth))}${blockIdentity} [content preserved in source artifact]`);
					omissions.push(`Some ${type || 'unknown'} block content is preserved only in the source artifact.`);
				}
				if (['image', 'file', 'pdf', 'video', 'audio'].includes(type)) {
					omissions.push(`Notion ${type} payload is preserved only in the source artifact; derived text includes its caption when available.`);
				}
				if (block.has_children === true) {
					if (depth >= maxDepth) {
						truncated = true;
						omissions.push('Nested blocks beyond depth 4 were not included.');
					} else if (typeof block.id === 'string') {
						await readChildren(normalizeNotionId(block.id), depth + 1);
					}
				}
			}
			cursor = payload.has_more === true && typeof payload.next_cursor === 'string' && payload.next_cursor ? payload.next_cursor : undefined;
			if (payload.has_more === true && !cursor) { truncated = true; return; }
		} while (cursor && !artifactLimitReached);
	};

	await readChildren(pageId, 0);
	if (truncated) { omissions.push(artifactLimitReached
		? 'Page import stopped before the next response exceeded the 15 MiB source artifact limit; remaining blocks were omitted.'
		: 'Page content was truncated at the 400 block, 20 page, or nesting-depth limit.'); }
	const text = `${pageTitle}${propertyLines.length ? `\n\nProperties\n${propertyLines.join('\n')}` : ''}\n\n${lines.join('\n')}`.trim();
	const displayedOmissions = boundedOmissions(omissions);
	return {
		connectorId: 'notion', connectorVersion: notionVersion, externalId: pageId,
		sourceUri: `https://www.notion.so/${pageId.replace(/-/g, '')}`,
		accountRef, title: safeTitle(pageTitle, `Notion page ${pageId}`),
		contentType: 'application/vnd.bugfixer.notion-source+json', content: encodeSourceArtifact(artifacts),
		derivedText: new TextDecoder().decode(encodeReferenceText(`${text}${displayedOmissions.length ? `\n\nImport notes: ${displayedOmissions.join(' ')}` : ''}`, omissions)),
		omissions: boundedOmissions(omissions),
	};
}

async function hydratePaginatedProperties(
	pageId: string,
	value: unknown,
	fetchJson: (path: string) => Promise<Record<string, unknown>>,
	omissions: string[],
): Promise<void> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return; }
	let propertyPagesFetched = 0;
	for (const [name, propertyValue] of Object.entries(value as Record<string, unknown>)) {
		if (!propertyValue || typeof propertyValue !== 'object' || Array.isArray(propertyValue)) { continue; }
		const property = propertyValue as Record<string, unknown>;
		const type = typeof property.type === 'string' ? property.type : '';
		if (type === 'relation' && property.has_more !== true) { continue; }
		if (!['relation', 'people', 'title', 'rich_text'].includes(type)) {
			if (property.has_more === true) {
				omissions.push(`Notion property “${name}” (${type || 'unknown type'}) has more values, but this property type cannot be paginated by the importer; remaining values were omitted.`);
			}
			continue;
		}
		if (typeof property.id !== 'string' || !isSafeNotionPropertyId(property.id, pageId)) {
			omissions.push(`Notion property “${name}” (${type}) has no valid property ID; its full value could not be verified and remaining values, if any, were omitted.`);
			continue;
		}
		const entries: unknown[] = [];
		let cursor: string | undefined;
		let incomplete = false;
		const initiallyTruncated = property.has_more === true;
		do {
			if (propertyPagesFetched >= maxPropertyPages) { incomplete = true; break; }
			const query = new URLSearchParams({ page_size: '100' });
			if (cursor) { query.set('start_cursor', cursor); }
			const path = `pages/${pageId}/properties/${property.id}?${query}`;
			let response: Record<string, unknown>;
			try { response = await fetchJson(path); }
			catch (error) {
				if (error instanceof SourceArtifactLimitError) { incomplete = true; break; }
				throw error;
			}
			if (!Array.isArray(response.results)) { throw new Error('Notion returned an invalid property response.'); }
			propertyPagesFetched++;
			for (const item of response.results) {
				if (!item || typeof item !== 'object' || Array.isArray(item)) { continue; }
				const record = item as Record<string, unknown>;
				entries.push(record.type === type ? record[type] : record);
			}
			cursor = response.has_more === true && typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
			if (response.has_more === true && !cursor) { incomplete = true; break; }
		} while (cursor);
		if (entries.length === 0 && initiallyTruncated) { incomplete = true; }
		if (entries.length > 0) { property[type] = entries; }
		property.has_more = incomplete;
		if (incomplete) {
			omissions.push(`Notion property “${name}” (${type}) still has values that could not be retrieved; remaining values were omitted.`);
		}
	}
}

function isSafeNotionPropertyId(value: string, pageId: string): boolean {
	if (value.length > 200 || !/^(?:[A-Za-z0-9_-]|%[A-Fa-f0-9]{2}){1,200}$/.test(value)) { return false; }
	const path = `pages/${pageId}/properties/${value}`;
	const url = new URL(path, notionApiOrigin);
	return url.origin === notionApiHost && url.pathname === `/v1/${path}` && !url.search && !url.hash;
}

function throwIfNotionTokenRejected(response: Response): void {
	if (response.status === 401) {
		throw new Error('This Notion token was rejected. It may have expired or been revoked; reconnect with a new personal access token.');
	}
}

function normalizeNotionId(value: string): string {
	if (typeof value !== 'string' || !/^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.test(value)) {
		throw new Error('A valid Notion page or block ID is required.');
	}
	const compact = value.replace(/-/g, '').toLowerCase();
	return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function extractPageTitle(properties: unknown): string {
	if (!properties || typeof properties !== 'object') { return ''; }
	for (const value of Object.values(properties as Record<string, unknown>)) {
		if (!value || typeof value !== 'object') { continue; }
		const property = value as Record<string, unknown>;
		if (property.type === 'title' || Array.isArray(property.title)) {
			return richText(property.title);
		}
	}
	return '';
}

function extractPageProperties(properties: unknown, omissions: string[]): string[] {
	if (!properties || typeof properties !== 'object' || Array.isArray(properties)) { return []; }
	const lines: string[] = [];
	for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { continue; }
		const property = value as Record<string, unknown>;
		const type = typeof property.type === 'string' ? property.type : '';
		if (type === 'title') { continue; }
		const field = property[type];
		let text = '';
		switch (type) {
			case 'rich_text': text = extractBlockText(field); break;
			case 'number': text = typeof field === 'number' ? String(field) : ''; break;
			case 'select': case 'status': text = selectName(field); break;
			case 'multi_select':
				text = Array.isArray(field) ? field.map(selectName).filter(Boolean).join(', ') : '';
				break;
			case 'checkbox': text = typeof field === 'boolean' ? String(field) : ''; break;
			case 'date': text = dateText(field); break;
			case 'url': case 'email': case 'phone_number':
				text = typeof field === 'string' ? field : '';
				break;
			case 'created_time': case 'last_edited_time': text = typeof field === 'string' ? field : ''; break;
			case 'formula': text = formulaText(field); break;
			case 'rollup': text = rollupText(field); break;
			case 'relation': case 'people': case 'files':
				text = Array.isArray(field) ? field.map(itemNameOrId).filter(Boolean).join(', ') : '';
				omissions.push(type === 'relation'
					? `Notion relation property “${name}” is represented by names or IDs; linked page content was not imported.`
					: `Notion ${type} property “${name}” is represented by names or IDs; linked content was not imported.`);
				break;
			default:
				omissions.push(`Notion property “${name}” (${type || 'unknown type'}) is preserved only in the source artifact.`);
				break;
		}
		if (text) { lines.push(`${name}: ${text}`); }
		else if (!['relation', 'people', 'files'].includes(type) && type) {
			omissions.push(`Notion property “${name}” (${type}) has no readable value; it is preserved only in the source artifact.`);
		}
		if ((type === 'formula' || type === 'rollup') && field !== undefined && field !== null) {
			omissions.push(`Notion ${type} property “${name}” may depend on values omitted by Notion’s calculation limits; its displayed result may be incomplete.`);
		}
	}
	return lines;
}

function selectName(value: unknown): string {
	return value && typeof value === 'object' && typeof (value as Record<string, unknown>).name === 'string'
		? String((value as Record<string, unknown>).name) : '';
}

function dateText(value: unknown): string {
	if (!value || typeof value !== 'object') { return ''; }
	const date = value as Record<string, unknown>;
	return [date.start, date.end].filter(item => typeof item === 'string').join(' – ');
}

function formulaText(value: unknown): string {
	if (!value || typeof value !== 'object') { return ''; }
	const formula = value as Record<string, unknown>;
	return typeof formula.string === 'string' ? formula.string
		: typeof formula.number === 'number' ? String(formula.number)
			: typeof formula.boolean === 'boolean' ? String(formula.boolean) : dateText(formula.date);
}

function rollupText(value: unknown): string {
	if (!value || typeof value !== 'object') { return ''; }
	const rollup = value as Record<string, unknown>;
	return typeof rollup.number === 'number' ? String(rollup.number)
		: typeof rollup.string === 'string' ? rollup.string
			: extractBlockText(rollup.rich_text) || (Array.isArray(rollup.array) ? rollup.array.map(itemNameOrId).filter(Boolean).join(', ') : '');
}

function itemNameOrId(value: unknown): string {
	if (!value || typeof value !== 'object') { return ''; }
	const item = value as Record<string, unknown>;
	return typeof item.name === 'string' ? item.name : typeof item.id === 'string' ? item.id : '';
}

function extractBlockText(value: unknown): string {
	if (typeof value === 'string') { return value; }
	if (!value || typeof value !== 'object') { return ''; }
	if (Array.isArray(value)) { return value.map(extractBlockText).filter(Boolean).join(''); }
	const record = value as Record<string, unknown>;
	if (typeof record.plain_text === 'string') {
		const link = typeof record.href === 'string' ? record.href : '';
		return link ? `${record.plain_text} (${link})` : record.plain_text;
	}
	if (typeof record.expression === 'string') { return record.expression; }
	return ['rich_text', 'title', 'cells', 'caption', 'description'].map(key => extractBlockText(record[key])).filter(Boolean).join(' ');
}
