/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	assertApprovedDeclarativePackage, type ApprovedDeclarativePackage,
} from './declarativePackage.js';
import {
	minimumDeclarativePackageCredentialLength, type DeclarativePackageTransport,
} from './declarativePackageTransport.js';

const maxPages = 20;
const maxRecords = 500;
const maxOutputBytes = 1024 * 1024;
const sourceKeyPattern = /^[A-Za-z0-9_-]{1,200}$/;

export interface DeclarativePackageImportRequest {
	readonly sourceId: string;
	/** User-selected remote resource identifier; never treated as code or a URL. */
	readonly sourceKey: string;
}

export interface DeclarativePackageConnectionBinding {
	readonly accountRef: string;
	readonly packageId: string;
	readonly manifestDigest: string;
	readonly host: string;
	readonly grantedScopes: readonly string[];
	readonly credential: string | null;
}

/** Store-compatible reference fields, keeping this local connector ID outside the built-in connector union. */
export interface DeclarativeImportedReferenceInput {
	readonly connectorId: string;
	readonly connectorVersion: string;
	readonly externalId: string;
	readonly sourceUri: string;
	readonly accountRef: string;
	readonly title: string;
	readonly contentType: 'text/plain; charset=utf-8';
	readonly content: Uint8Array;
	readonly omissions: readonly string[];
}

export async function importDeclarativePackageSource(
	approvedPackage: ApprovedDeclarativePackage,
	request: DeclarativePackageImportRequest,
	transport: DeclarativePackageTransport,
	binding: DeclarativePackageConnectionBinding,
): Promise<DeclarativeImportedReferenceInput> {
	assertApprovedDeclarativePackage(approvedPackage);
	if (!binding || typeof binding !== 'object' || !Array.isArray(binding.grantedScopes) || binding.packageId !== approvedPackage.manifest.packageId
		|| binding.manifestDigest !== approvedPackage.manifestDigest || typeof binding.accountRef !== 'string' || !binding.accountRef.trim()) {
		throw new Error('Connector connection is not bound to this approved package and account.');
	}
	if (typeof request.sourceId !== 'string' || !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(request.sourceId)) {
		throw new Error('A valid connector source identifier is required.');
	}
	if (typeof request.sourceKey !== 'string' || !sourceKeyPattern.test(request.sourceKey)) {
		throw new Error('A valid selected source identifier is required.');
	}
	const manifest = approvedPackage.manifest;
	const source = manifest.sources.find(candidate => candidate.sourceId === request.sourceId);
	if (!source) { throw new Error('The selected source is not declared by this connector package.'); }
	if (binding.host !== source.domain || !approvedPackage.manifest.domains.includes(binding.host)) {
		throw new Error('Connector connection is not approved for this source host.');
	}
	const requiredScope = source.requiredScope;
	if (approvedPackage.manifest.accountAccess === 'none') {
		if (binding.credential !== null || requiredScope !== undefined) { throw new Error('Anonymous connector source received an unexpected credential or scope.'); }
	} else if (typeof binding.credential !== 'string' || binding.credential.length < minimumDeclarativePackageCredentialLength
		|| !/^[\x21-\x7e]+$/.test(binding.credential) || !requiredScope
		|| !approvedPackage.manifest.requestedScopes.includes(requiredScope) || !binding.grantedScopes.includes(requiredScope)) {
		throw new Error('Connector connection is missing its required credential or granted scope.');
	}
	if (!source.path.includes('{sourceKey}')) { throw new Error('The selected source path does not identify the selected sourceKey.'); }

	const path = source.path.replace('{sourceKey}', encodeURIComponent(request.sourceKey));
	const firstUrl = new URL(path, `https://${source.domain}`);
	if (firstUrl.origin !== `https://${source.domain}`) { throw new Error('Connector source URL escaped its declared domain.'); }
	const seenCursors = new Set<string>();
	const output: Buffer[] = [];
	const omissions: string[] = [];
	let outputBytes = 0;
	let recordsSeen = 0;
	let truncated = false;
	let title = source.label;
	let cursor: string | undefined;
	let firstResponse = true;

	const append = (text: string): boolean => {
		if (!text) { return true; }
		const bytes = Buffer.from(text, 'utf8');
		const remaining = maxOutputBytes - outputBytes;
		if (bytes.byteLength <= remaining) { output.push(bytes); outputBytes += bytes.byteLength; return true; }
		if (remaining > 0) {
			let end = remaining;
			while (end > 0 && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) { end--; }
			const prefix = bytes.subarray(0, end);
			output.push(prefix);
			outputBytes += prefix.byteLength;
		}
		truncated = true;
		return false;
	};

	for (let page = 0; page < maxPages; page++) {
		const url = new URL(path, `https://${source.domain}`);
		if (cursor && source.cursorParameter) { url.searchParams.set(source.cursorParameter, cursor); }
		const payload = await transport.get(url, source.domain, binding.credential ?? undefined);
		if (firstResponse) {
			const pageTitle = source.titlePath ? pathValue(payload, source.titlePath) : undefined;
			if (typeof pageTitle === 'string' && pageTitle.trim()) { title = pageTitle.trim().slice(0, 500); }
			firstResponse = false;
		}
		const selectedRecords = source.recordsPath ? pathValue(payload, source.recordsPath) : payload;
		if (source.recordsPath && !Array.isArray(selectedRecords)) { throw new Error('Connector response did not match its declared records field.'); }
		const records = Array.isArray(selectedRecords) ? selectedRecords : [selectedRecords];
		for (const value of records) {
			if (recordsSeen >= maxRecords) { truncated = true; break; }
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				omissions.push('Some response records were not objects and were omitted.');
				continue;
			}
			recordsSeen++;
			if (!append(`Record ${recordsSeen}\n`)) { break; }
			for (const fieldPath of source.textPaths) {
				const field = pathValue(value, fieldPath);
				const fieldText = scalarText(field);
				if (fieldText === undefined) {
					omissions.push(`Some values for ${fieldPath} were missing or not plain text.`);
					continue;
				}
				if (!append(`${fieldPath}: ${fieldText}\n`)) { break; }
			}
			if (truncated) { break; }
		}
		if (truncated) { break; }
		if (!source.nextCursorPath) { break; }
		const nextCursor = pathValue(payload, source.nextCursorPath);
		if (nextCursor === undefined || nextCursor === null || nextCursor === '') { break; }
		if (typeof nextCursor !== 'string' || nextCursor.length > 2048 || seenCursors.has(nextCursor)) {
			throw new Error('Connector returned an invalid or repeated pagination cursor.');
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
		if (page === maxPages - 1) { truncated = true; }
	}
	if (truncated) { omissions.push('Source content was truncated at the 500 record, 20 page, or 1 MiB output limit.'); }
	if (recordsSeen === 0) { omissions.push('The selected source returned no usable records.'); }
	const content = Buffer.concat(output, outputBytes);
	return {
		connectorId: `local:${manifest.packageId}`,
		connectorVersion: manifest.version,
		externalId: `${manifest.packageId}:${binding.accountRef}:${source.sourceId}:${request.sourceKey}`,
		sourceUri: firstUrl.toString(),
		accountRef: binding.accountRef,
		title: safeTitle(title, source.label),
		contentType: 'text/plain; charset=utf-8',
		content,
		omissions: [...new Set(omissions)],
	};
}

function pathValue(value: unknown, path: string): unknown {
	let current = value;
	for (const part of path.split('.')) {
		if (!current || typeof current !== 'object' || Array.isArray(current)) { return undefined; }
		const record = current as Record<string, unknown>;
		if (!Object.hasOwn(record, part)) { return undefined; }
		current = record[part];
	}
	return current;
}

function scalarText(value: unknown): string | undefined {
	if (typeof value === 'string') { return value; }
	if (typeof value === 'number' && Number.isFinite(value)) { return String(value); }
	if (typeof value === 'boolean') { return String(value); }
	if (Array.isArray(value) && value.every(item => typeof item === 'string')) { return value.join(', '); }
	return undefined;
}

function safeTitle(value: string, fallback: string): string {
	const title = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
	return title || fallback;
}
