/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:http';
import { isIP } from 'node:net';
import { isPublicAddress, type ResolvedNetworkAddress } from './declarativePackageTransport.js';

export const maxPublicWebsiteResponseBytes = 2 * 1024 * 1024;
export const maxPublicWebsiteRequestMs = 15_000;
export const maxPublicWebsiteRedirects = 5;
export const maxPublicWebsiteUrlLength = 2048;
const maxPublicWebsiteTitleLength = 500;

export interface PinnedWebsiteRequest {
	readonly protocol: 'http:' | 'https:';
	readonly hostname: string;
	readonly servername: string;
	readonly hostHeader: string;
	readonly path: string;
	readonly addresses: readonly ResolvedNetworkAddress[];
	readonly lookup: NonNullable<RequestOptions['lookup']>;
}

export interface WebsiteResponse { readonly statusCode: number; readonly headers: Readonly<Record<string, string | string[] | undefined>>; readonly body: Uint8Array; }
export interface PublicWebsiteImportResult {
	readonly requestedUrl: string;
	readonly canonicalUrl: string;
	readonly title: string;
	readonly content: Uint8Array;
	readonly derivedText: string;
	readonly contentType: string;
	readonly contentSha256: string;
	readonly omissions: readonly string[];
}
export interface PublicWebsiteTransportTestHooks {
	readonly resolveAddresses?: (hostname: string) => Promise<readonly ResolvedNetworkAddress[]>;
	readonly executePinnedRequest?: (request: PinnedWebsiteRequest) => Promise<WebsiteResponse>;
}

/** Credential-free fetcher for public web pages. Every hop resolves and pins its own public DNS answers. */
export class PublicWebsiteImportTransport {
	constructor(private readonly testHooks?: PublicWebsiteTransportTestHooks) { }

	async fetch(input: string): Promise<PublicWebsiteImportResult> {
		const requestedUrl = canonicalizePublicWebsiteUrl(input).toString();
		let url = new URL(requestedUrl);
		let response: WebsiteResponse | undefined;
		for (let redirects = 0; redirects <= maxPublicWebsiteRedirects; redirects++) {
			response = await this.get(url);
			if (response.statusCode >= 300 && response.statusCode < 400) {
				const location = header(response.headers, 'location');
				if (!location) { throw new Error('The website returned a redirect without a destination.'); }
				if (redirects === maxPublicWebsiteRedirects) { throw new Error('The website exceeded the redirect limit.'); }
				url = canonicalizePublicWebsiteUrl(new URL(location, url).toString());
				continue;
			}
			if (response.statusCode < 200 || response.statusCode >= 300) { throw new Error(`Website request failed with HTTP ${response.statusCode}.`); }
			break;
		}
		if (!response) { throw new Error('The website request returned no response.'); }
		if (response.body.byteLength > maxPublicWebsiteResponseBytes) { throw new Error('The website response exceeded the 2 MiB limit.'); }
		const encoding = header(response.headers, 'content-encoding');
		if (encoding && encoding.toLowerCase() !== 'identity') { throw new Error('Compressed website responses are not supported.'); }
		const rawContentType = header(response.headers, 'content-type') ?? '';
		const mime = rawContentType.split(';', 1)[0].trim().toLowerCase();
		if (mime !== 'text/html' && mime !== 'text/plain' && mime !== 'application/xhtml+xml') { throw new Error('The website must return HTML or plain text.'); }
		const charsetParameter = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(rawContentType);
		const declaredCharset = charsetParameter ? (charsetParameter[1] ?? charsetParameter[2] ?? charsetParameter[3] ?? '').trim() : undefined;
		const charset = declaredCharset === undefined ? 'utf-8' : declaredCharset;
		let decoder: TextDecoder;
		try { decoder = new TextDecoder(charset, { fatal: true }); }
		catch { throw new Error(`The website declared an unsupported or invalid charset: ${charset || '(empty)'}.`); }
		let source: string;
		try { source = decoder.decode(response.body); }
		catch { throw new Error(`The website response is not valid ${decoder.encoding} text.`); }
		const html = mime !== 'text/plain';
		const extracted = html ? extractReadableHtml(source) : { title: '', text: normalizeText(source), omissions: [] as string[] };
		if (!extracted.text) { throw new Error('The website did not contain readable text.'); }
		const title = extracted.title || url.hostname;
		if (title.length > maxPublicWebsiteTitleLength) { extracted.omissions.push('Page title truncated to 500 characters'); }
		return {
			requestedUrl, canonicalUrl: url.toString(), title: title.slice(0, maxPublicWebsiteTitleLength).trim(),
			content: Buffer.from(response.body), derivedText: extracted.text,
			contentType: `${mime}; charset=${decoder.encoding}`,
			contentSha256: createSha256(response.body), omissions: extracted.omissions,
		};
	}

	private async get(url: URL): Promise<WebsiteResponse> {
		const addresses = await this.resolve(url.hostname);
		if (!addresses.length || addresses.length > 32 || addresses.some(address => !isPublicAddress(address))) {
			throw new Error('Website hostname resolved to a private or reserved network address.');
		}
		const port = url.protocol === 'https:' ? 443 : 80;
		if (url.port && Number(url.port) !== port) { throw new Error('Only the default HTTP and HTTPS ports are allowed.'); }
		const request: PinnedWebsiteRequest = Object.freeze({
			protocol: url.protocol as 'http:' | 'https:', hostname: url.hostname, servername: url.hostname,
			hostHeader: url.host, path: `${url.pathname}${url.search}`, addresses: Object.freeze([...addresses]),
			lookup: createPinnedLookup(url.hostname, addresses),
		});
		return this.testHooks?.executePinnedRequest
			? this.testHooks.executePinnedRequest(request)
			: executePinnedWebsiteRequest(request);
	}

	private async resolve(hostname: string): Promise<readonly ResolvedNetworkAddress[]> {
		if (this.testHooks?.resolveAddresses) { return this.testHooks.resolveAddresses(hostname); }
		let timer: ReturnType<typeof setTimeout> | undefined;
		let addresses: LookupAddress[];
		try {
			addresses = await Promise.race([
				dnsLookup(hostname, { all: true, verbatim: true }),
				new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Website DNS resolution timed out.')), maxPublicWebsiteRequestMs); }),
			]) as LookupAddress[];
		} finally { if (timer) { clearTimeout(timer); } }
		return addresses.map(({ address, family }) => {
			if (family !== 4 && family !== 6) { throw new Error('DNS returned an unsupported address family.'); }
			return { address, family };
		});
	}
}

function createSha256(content: Uint8Array): string { return createHash('sha256').update(content).digest('hex'); }

export function canonicalizePublicWebsiteUrl(input: string): URL {
	if (typeof input !== 'string' || !input.trim() || input.length > 4096) { throw new Error('A valid public website URL is required.'); }
	let url: URL;
	try { url = new URL(input); } catch { throw new Error('A valid HTTP or HTTPS website URL is required.'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isIP(url.hostname) !== 0) {
		throw new Error('Website URL must use HTTP or HTTPS, omit credentials, and use a hostname.');
	}
	const defaultPort = url.protocol === 'https:' ? '443' : '80';
	if (url.port && url.port !== defaultPort) { throw new Error('Only the default HTTP and HTTPS ports are allowed.'); }
	url.port = '';
	url.hash = '';
	url.hostname = url.hostname.toLowerCase();
	if (url.toString().length > maxPublicWebsiteUrlLength) {
		throw new Error(`Canonical website URL must be at most ${maxPublicWebsiteUrlLength} characters.`);
	}
	return url;
}

function createPinnedLookup(hostname: string, addresses: readonly ResolvedNetworkAddress[]): NonNullable<RequestOptions['lookup']> {
	return (requestedHostname, options, callback) => {
		if (requestedHostname !== hostname) { callback(new Error('Pinned DNS lookup received an unexpected hostname.'), '', 0); return; }
		if (typeof options === 'object' && options.all) {
			callback(null, addresses.map(({ address, family }) => ({ address, family })) as LookupAddress[]);
			return;
		}
		callback(null, addresses[0].address, addresses[0].family);
	};
}

async function executePinnedWebsiteRequest(request: PinnedWebsiteRequest): Promise<WebsiteResponse> {
	const options: https.RequestOptions = {
		method: 'GET', servername: request.servername, rejectUnauthorized: true,
		headers: { Accept: 'text/html, text/plain;q=0.9', 'Accept-Encoding': 'identity', Host: request.hostHeader },
		lookup: request.lookup, agent: false, signal: AbortSignal.timeout(maxPublicWebsiteRequestMs),
	};
	const client = request.protocol === 'https:' ? https : http;
	return new Promise((resolve, reject) => {
		let total = 0;
		const chunks: Buffer[] = [];
		const outgoing = client.request({ protocol: request.protocol, hostname: request.hostname, path: request.path, ...options }, (incoming: IncomingMessage) => {
			const size = Number(incoming.headers['content-length']);
			if (Number.isFinite(size) && size > maxPublicWebsiteResponseBytes) { incoming.destroy(); reject(new Error('The website response exceeded the 2 MiB limit.')); return; }
			incoming.on('data', (chunk: Buffer) => {
				total += chunk.byteLength;
				if (total > maxPublicWebsiteResponseBytes) { incoming.destroy(new Error('The website response exceeded the 2 MiB limit.')); return; }
				chunks.push(chunk);
			});
			incoming.once('end', () => resolve({ statusCode: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks, total) }));
			incoming.once('error', reject);
		});
		outgoing.once('error', reject);
		outgoing.end();
	});
}

function header(headers: WebsiteResponse['headers'], name: string): string | undefined {
	const value = headers[name] ?? headers[name.toLowerCase()];
	return Array.isArray(value) ? value[0] : value;
}

function extractReadableHtml(source: string): { title: string; text: string; omissions: string[] } {
	const omissions: string[] = [];
	const removed = (tag: string, label: string) => {
		const matcher = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
		if (matcher.test(source)) { omissions.push(label); source = source.replace(matcher, ' '); }
	};
	for (const [tag, label] of [['script', 'Scripts'], ['style', 'Styles'], ['template', 'Templates'], ['noscript', 'No-script content'], ['svg', 'SVG graphics']] as const) { removed(tag, label); }
	const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source);
	const title = normalizeText(decodeEntities(titleMatch?.[1] ?? ''));
	const withoutHidden = source.replace(/<!--([\s\S]*?)-->/g, ' ').replace(/<(?:head|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/(?:head|nav|footer|header|aside)\s*>/gi, ' ');
	const text = normalizeText(decodeEntities(withoutHidden.replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|article|section)\s*>/gi, '\n').replace(/<[^>]*>/g, ' ')));
	if (/<(?:nav|footer|header|aside)\b/i.test(source)) { omissions.push('Navigation and page chrome'); }
	return { title, text, omissions: [...new Set(omissions)] };
}

function normalizeText(value: string): string { return value.replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
function decodeEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_whole, entity: string) => {
		if (entity[0] === '#') {
			const hex = entity[1]?.toLowerCase() === 'x';
			const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
		}
		return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[entity.toLowerCase()] ?? ' ';
	});
}
