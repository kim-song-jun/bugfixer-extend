/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

const compactPageId = /^[0-9a-f]{32}$/i;
const hyphenatedPageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notionHosts = ['notion.so', 'notion.site', 'notion.com'];

function canonicalPageId(value: string): string | undefined {
	if (!compactPageId.test(value) && !hyphenatedPageId.test(value)) return undefined;
	const compact = value.replace(/-/g, '').toLowerCase();
	return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

/** Accept a page UUID or a copied Notion page link whose path ends with that UUID. */
export function parseNotionPageInput(value: string): string | undefined {
	const input = value.trim();
	if (!input || input.length > 4096) return undefined;
	const direct = canonicalPageId(input);
	if (direct) return direct;

	let url: URL;
	try { url = new URL(input); } catch { return undefined; }
	if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
	const host = url.hostname.toLowerCase();
	if (!notionHosts.some(domain => host === domain || host.endsWith(`.${domain}`))) return undefined;
	const finalSegment = url.pathname.split('/').filter(Boolean).at(-1);
	if (!finalSegment) return undefined;
	const suffix = finalSegment.match(/-([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
	return canonicalPageId(finalSegment) ?? (suffix ? canonicalPageId(suffix[1]) : undefined);
}
