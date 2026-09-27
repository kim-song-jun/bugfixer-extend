/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { isIP } from 'node:net';

export const maxDeclarativePackageResponseBytes = 2 * 1024 * 1024;
export const maxDeclarativePackageRequestMs = 15_000;

export interface ResolvedNetworkAddress {
	readonly address: string;
	readonly family: 4 | 6;
}

export interface PinnedHttpsRequest {
	readonly hostname: string;
	readonly servername: string;
	readonly rejectUnauthorized: true;
	readonly hostHeader: string;
	readonly method: 'GET';
	readonly path: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly addresses: readonly ResolvedNetworkAddress[];
	readonly lookup: NonNullable<RequestOptions['lookup']>;
}

export interface PinnedHttpsResponse {
	readonly statusCode: number;
	readonly contentLength?: number;
	readonly body: Uint8Array;
}

export interface DeclarativePackageTransport {
	get(url: URL, allowedDomain: string, bearerToken?: string): Promise<Record<string, unknown>>;
}

export interface DeclarativePackageTransportTestHooks {
	readonly resolveAddresses: (hostname: string) => Promise<readonly ResolvedNetworkAddress[]>;
	readonly executePinnedRequest: (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>;
}

export class PinnedDeclarativePackageTransport implements DeclarativePackageTransport {
	constructor(private readonly testHooks?: DeclarativePackageTransportTestHooks) { }

	async get(url: URL, allowedDomain: string, bearerToken?: string): Promise<Record<string, unknown>> {
		if (bearerToken !== undefined && (Buffer.byteLength(bearerToken, 'utf8') > 16 * 1024 || !/^[\x21-\x7e]+$/.test(bearerToken))) {
			throw new Error('Declarative connector bearer credential has an invalid format.');
		}
		if (url.protocol !== 'https:' || url.hostname !== allowedDomain || url.username || url.password || url.port
			|| isIP(url.hostname) !== 0 || url.origin !== `https://${allowedDomain}`) {
			throw new Error('Declarative connector request escaped its HTTPS domain allowlist.');
		}
		const addresses = await this.resolveAddresses(allowedDomain);
		if (!addresses.length || addresses.length > 32 || addresses.some(address => !isPublicAddress(address))) {
			throw new Error('Declarative connector domain resolved to a private or reserved network address.');
		}
		const request: PinnedHttpsRequest = Object.freeze({
			hostname: allowedDomain,
			servername: allowedDomain,
			rejectUnauthorized: true,
			hostHeader: allowedDomain,
			method: 'GET',
			path: `${url.pathname}${url.search}`,
			headers: Object.freeze(bearerToken === undefined ? {} : { Authorization: `Bearer ${bearerToken}` }),
			addresses: Object.freeze([...addresses]),
			lookup: createPinnedLookup(allowedDomain, addresses),
		});
		const response = await this.executePinnedRequest(request);
		if (response.statusCode >= 300 && response.statusCode < 400) {
			throw new Error('Declarative connector redirects are not allowed.');
		}
		if (response.statusCode < 200 || response.statusCode >= 300) {
			throw new Error(`Declarative connector request failed with HTTP ${response.statusCode}.`);
		}
		if (response.contentLength !== undefined && response.contentLength > maxDeclarativePackageResponseBytes) {
			throw new Error('Declarative connector response exceeded the 2 MiB limit.');
		}
		if (response.body.byteLength > maxDeclarativePackageResponseBytes) {
			throw new Error('Declarative connector response exceeded the 2 MiB limit.');
		}
		if (bearerToken && Buffer.from(response.body).includes(Buffer.from(bearerToken, 'ascii'))) {
			throw new Error('Declarative connector response echoed its bearer credential.');
		}
		let value: unknown;
		try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); }
		catch { throw new Error('Declarative connector returned an invalid JSON response.'); }
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Declarative connector returned an invalid JSON object.');
		}
		return value as Record<string, unknown>;
	}

	private async resolveAddresses(hostname: string): Promise<readonly ResolvedNetworkAddress[]> {
		if (this.testHooks) { return this.testHooks.resolveAddresses(hostname); }
		let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('DNS resolution exceeded the 15 second limit.')), maxDeclarativePackageRequestMs);
		});
		let addresses: LookupAddress[];
		try { addresses = await Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]) as LookupAddress[]; }
		finally { if (timer) { clearTimeout(timer); } }
		return addresses.map(({ address, family }) => {
			if (family !== 4 && family !== 6) { throw new Error('DNS returned an unsupported address family.'); }
			return { address, family };
		});
	}

	private executePinnedRequest(request: PinnedHttpsRequest): Promise<PinnedHttpsResponse> {
		return this.testHooks?.executePinnedRequest(request) ?? executePinnedHttpsRequest(request);
	}
}

async function executePinnedHttpsRequest(request: PinnedHttpsRequest): Promise<PinnedHttpsResponse> {
	const options: RequestOptions = {
		method: 'GET',
		servername: request.servername,
		rejectUnauthorized: request.rejectUnauthorized,
		headers: { Accept: 'application/json', Host: request.hostHeader, ...request.headers },
		lookup: request.lookup,
		agent: false,
		signal: AbortSignal.timeout(maxDeclarativePackageRequestMs),
	};
	return new Promise((resolve, reject) => {
		let completed = false;
		let totalBytes = 0;
		const chunks: Buffer[] = [];
		let activeResponse: IncomingMessage | undefined;
		const finish = (error?: Error, response?: PinnedHttpsResponse) => {
			if (completed) { return; }
			completed = true;
			if (error) { reject(error); }
			else if (response) { resolve(response); }
			else { reject(new Error('HTTPS request ended without a response.')); }
		};
		const outgoing = https.request({ protocol: 'https:', hostname: request.hostname, path: request.path, ...options }, incoming => {
			activeResponse = incoming;
			const contentLengthText = incoming.headers['content-length'];
			const contentLength = typeof contentLengthText === 'string' ? Number(contentLengthText) : undefined;
			if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxDeclarativePackageResponseBytes) {
				incoming.destroy();
				finish(new Error('Declarative connector response exceeded the 2 MiB limit.'));
				return;
			}
			incoming.on('data', (chunk: Buffer) => {
				totalBytes += chunk.byteLength;
				if (totalBytes > maxDeclarativePackageResponseBytes) {
					incoming.destroy();
					finish(new Error('Declarative connector response exceeded the 2 MiB limit.'));
					return;
				}
				chunks.push(chunk);
			});
			incoming.once('end', () => finish(undefined, {
				statusCode: incoming.statusCode ?? 0,
				contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
				body: Buffer.concat(chunks, totalBytes),
			}));
			incoming.once('error', error => finish(error));
		});
		outgoing.once('error', error => finish(error));
		outgoing.once('close', () => {
			if (!completed && activeResponse?.complete !== true) { finish(new Error('HTTPS request closed before completing the response.')); }
		});
		outgoing.end();
	});
}

function createPinnedLookup(hostname: string, addresses: readonly ResolvedNetworkAddress[]): NonNullable<RequestOptions['lookup']> {
	const pinned = addresses[0];
	return (requestedHostname, options, callback) => {
		if (requestedHostname !== hostname) {
			callback(new Error('Pinned DNS lookup received an unexpected hostname.'), '', 0);
			return;
		}
		if (typeof options === 'object' && options.all) {
			callback(null, addresses.map(address => ({ address: address.address, family: address.family })) as LookupAddress[]);
			return;
		}
		callback(null, pinned.address, pinned.family);
	};
}

export function isPublicAddress(address: ResolvedNetworkAddress): boolean {
	if (isIP(address.address) !== address.family) { return false; }
	if (address.family === 4) { return isPublicIpv4(address.address); }
	return isPublicIpv6(address.address);
}

function isPublicIpv4(address: string): boolean {
	// Keep these blocks aligned with IANA's special-purpose registry; special-purpose anycast is excluded too.
	// https://www.iana.org/assignments/iana-ipv4-special-registry
	const octets = address.split('.').map(Number);
	if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) { return false; }
	const [a, b, c] = octets;
	if (a === 0 || a === 10 || a === 127 || a >= 224) { return false; }
	if (a === 100 && b >= 64 && b <= 127) { return false; }
	if (a === 169 && b === 254) { return false; }
	if (a === 172 && b >= 16 && b <= 31) { return false; }
	if (a === 192 && b === 0 && c === 0) { return false; }
	if (a === 192 && b === 0 && c === 2) { return false; }
	if (a === 192 && b === 31 && c === 196) { return false; }
	if (a === 192 && b === 52 && c === 193) { return false; }
	if (a === 192 && b === 88 && c === 99) { return false; }
	if (a === 192 && b === 168) { return false; }
	if (a === 192 && b === 175 && c === 48) { return false; }
	if (a === 198 && (b === 18 || b === 19)) { return false; }
	if (a === 198 && b === 51 && c === 100) { return false; }
	if (a === 203 && b === 0 && c === 113) { return false; }
	return true;
}

function isPublicIpv6(address: string): boolean {
	// Only global unicast is accepted; IANA special-purpose, documentation, transition, and reserved ranges are blocked.
	// https://www.iana.org/assignments/iana-ipv6-special-registry
	if (address.includes('%')) { return false; }
	const words = parseIpv6(address);
	if (!words) { return false; }
	const first = words[0];
	if (first < 0x2000 || first > 0x3fff) { return false; }
	if (words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0003 || words[1] === 0x0001 || words[1] === 0x0030)) { return false; }
	if (words[0] === 0x2001 && words[1] === 0x0004 && words[2] === 0x0112) { return false; }
	if (words[0] === 0x2001 && words[1] === 0x0db8) { return false; }
	if (words[0] === 0x2002) { return false; }
	if (words[0] === 0x3fff && (words[1] & 0xf000) === 0) { return false; }
	if (words[0] === 0x2620 && words[1] === 0x004f && words[2] === 0x8000) { return false; }
	return true;
}

function parseIpv6(address: string): number[] | undefined {
	const normalized = address.toLowerCase();
	if ((normalized.match(/::/g) ?? []).length > 1) { return undefined; }
	let value = normalized;
	if (value.includes('.')) {
		const lastColon = value.lastIndexOf(':');
		const ipv4 = value.slice(lastColon + 1);
		if (!isPublicIpv4(ipv4)) { return undefined; }
		const octets = ipv4.split('.').map(Number);
		const words = [((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
		value = `${value.slice(0, lastColon)}:${words.join(':')}`;
	}
	const halves = value.split('::');
	const left = halves[0] ? halves[0].split(':') : [];
	const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
	if ([...left, ...right].some(word => !/^[0-9a-f]{1,4}$/.test(word))) { return undefined; }
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) { return undefined; }
	const words = [...left, ...Array<number>(missing).fill(0), ...right].map(word => typeof word === 'number' ? word : Number.parseInt(word, 16));
	return words.length === 8 ? words : undefined;
}
