/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, createPublicKey, verify } from 'node:crypto';

const maxManifestBytes = 128 * 1024;
const maxSources = 32;
const maxDomains = 8;
const maxTextPaths = 12;
const packageIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,78}[a-z0-9])?$/;
const sourceIdPattern = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const pathPattern = /^[A-Za-z0-9._~!$&'()*+,;=:@/-]*(?:\{sourceKey\}[A-Za-z0-9._~!$&'()*+,;=:@/-]*)?$/;
const pathValuePattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,15}$/;
const cursorParameterPattern = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export interface SignedDeclarativePackageEnvelope {
	readonly manifestBytesBase64: string;
	readonly signatureBase64: string;
	readonly publicKeyBase64: string;
}

export interface DeclarativePackageSource {
	readonly sourceId: string;
	readonly label: string;
	readonly domain: string;
	readonly path: string;
	readonly recordsPath?: string;
	readonly titlePath?: string;
	readonly textPaths: readonly string[];
	readonly nextCursorPath?: string;
	readonly cursorParameter?: string;
	readonly requiredScope?: string;
}

export interface DeclarativePackageManifest {
	readonly schemaVersion: 1;
	readonly packageId: string;
	readonly version: string;
	readonly name: string;
	readonly description: string;
	readonly domains: readonly string[];
	readonly accountAccess: 'none' | 'bearer-token';
	readonly requestedScopes: readonly string[];
	readonly sources: readonly DeclarativePackageSource[];
}

export type DeclarativePackageTrustStatus = 'first-install' | 'installed' | 'same-key-update';

export interface DeclarativePackageReview {
	readonly packageId: string;
	readonly version: string;
	readonly name: string;
	readonly description: string;
	readonly fingerprint: string;
	readonly manifestDigest: string;
	readonly domains: readonly string[];
	readonly accountAccess: 'none' | 'bearer-token';
	readonly requestedScopes: readonly string[];
	readonly sourceLabels: readonly string[];
	readonly sourceRules: readonly {
		readonly sourceId: string;
		readonly label: string;
		readonly domain: string;
		readonly requiredScope?: string;
		readonly method: 'GET';
		readonly path: string;
		readonly fields: readonly string[];
		readonly paginated: boolean;
	}[];
	readonly trustStatus: DeclarativePackageTrustStatus;
}

export interface DeclarativePackageTrustContext {
	readonly fingerprint: string;
	readonly version: string;
	readonly manifestDigest: string;
}

const validatedPackages = new WeakSet<object>();

export interface ValidatedDeclarativePackage {
	readonly manifest: DeclarativePackageManifest;
	readonly fingerprint: string;
	readonly manifestDigest: string;
	readonly trustStatus: DeclarativePackageTrustStatus;
	readonly review: DeclarativePackageReview;
}

export function validateDeclarativePackage(
	envelope: SignedDeclarativePackageEnvelope,
	trustContext?: DeclarativePackageTrustContext,
): ValidatedDeclarativePackage {
	if (!envelope || typeof envelope !== 'object') { throw new Error('A signed connector package is required.'); }
	const manifestBytes = decodeBase64(envelope.manifestBytesBase64, maxManifestBytes, 'manifest');
	const signature = decodeBase64(envelope.signatureBase64, 64, 'signature');
	const publicKeyBytes = decodeBase64(envelope.publicKeyBase64, 32, 'public key');
	assertExactKeys(envelope as unknown as Record<string, unknown>, ['manifestBytesBase64', 'signatureBase64', 'publicKeyBase64'], 'package envelope');
	if (signature.byteLength !== 64 || publicKeyBytes.byteLength !== 32) { throw new Error('The connector package signature or key has an invalid length.'); }
	const fingerprint = createHash('sha256').update(publicKeyBytes).digest('hex');
	const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
	if (trustContext && trustContext.fingerprint !== fingerprint) {
		throw new Error('The connector package signing key changed. Reinstall it only after separately reviewing the new fingerprint.');
	}
	const publicKey = createPublicKey({
		key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKeyBytes]),
		format: 'der', type: 'spki',
	});
	if (!verify(null, manifestBytes, publicKey, signature)) { throw new Error('The connector package signature is invalid.'); }
	const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
	rejectDuplicateObjectKeys(manifestText);
	let parsed: unknown;
	try { parsed = JSON.parse(manifestText); }
	catch { throw new Error('The connector package manifest is not valid JSON.'); }
	const manifest = parseManifest(parsed);
	const trustStatus: DeclarativePackageTrustStatus = !trustContext ? 'first-install' : resolveTrustStatus(manifest.version, manifestDigest, trustContext);
	const immutableManifest = deepFreeze(manifest);
	const validated: ValidatedDeclarativePackage = Object.freeze({
		manifest: immutableManifest,
		fingerprint,
		manifestDigest,
		trustStatus,
		review: Object.freeze({
			packageId: manifest.packageId,
			version: manifest.version,
			name: manifest.name,
			description: manifest.description,
			fingerprint,
			manifestDigest,
			domains: Object.freeze([...manifest.domains]),
			accountAccess: manifest.accountAccess,
			requestedScopes: Object.freeze([...manifest.requestedScopes]),
			sourceLabels: Object.freeze(manifest.sources.map(source => source.label)),
			sourceRules: Object.freeze(manifest.sources.map(source => Object.freeze({
				sourceId: source.sourceId,
				label: source.label,
				domain: source.domain,
				requiredScope: source.requiredScope,
				method: 'GET' as const,
				path: source.path,
				fields: Object.freeze([...source.textPaths]),
				paginated: !!source.cursorParameter,
			}))),
			trustStatus,
		}),
	});
	validatedPackages.add(validated);
	return validated;
}

export interface DeclarativePackageApproval {
	readonly packageId: string;
	readonly version: string;
	readonly fingerprint: string;
	readonly manifestDigest: string;
}

const approvedPackages = new WeakSet<object>();
export interface ApprovedDeclarativePackage extends ValidatedDeclarativePackage {
	readonly approval: DeclarativePackageApproval;
}

/** Call only after the user approves the review shown by `validateDeclarativePackage`. */
export function approveDeclarativePackage(
	validated: ValidatedDeclarativePackage,
	approval: DeclarativePackageApproval,
): ApprovedDeclarativePackage {
	if (!validatedPackages.has(validated) || !approval || typeof approval !== 'object'
		|| approval.packageId !== validated.manifest.packageId || approval.version !== validated.manifest.version
		|| approval.fingerprint !== validated.fingerprint || approval.manifestDigest !== validated.manifestDigest) {
		throw new Error('Connector package approval does not match the reviewed package.');
	}
	const approved = Object.freeze({ ...validated, approval: Object.freeze({ ...approval }) });
	approvedPackages.add(approved);
	return approved;
}

export function assertApprovedDeclarativePackage(value: ApprovedDeclarativePackage): void {
	if (!approvedPackages.has(value)) {
		throw new Error('Connector package must be validated and approved before use.');
	}
}

function resolveTrustStatus(version: string, manifestDigest: string, context: DeclarativePackageTrustContext): DeclarativePackageTrustStatus {
	if (!/^[a-f0-9]{64}$/.test(context.fingerprint) || !/^[a-f0-9]{64}$/.test(context.manifestDigest)
		|| !isValidVersion(context.version)) {
		throw new Error('Stored connector package trust data is invalid.');
	}
	const comparison = compareVersions(version, context.version);
	if (comparison < 0) { throw new Error('Connector package updates may not roll back to an earlier version.'); }
	if (comparison === 0) {
		if (manifestDigest !== context.manifestDigest) { throw new Error('A connector package cannot change its manifest without increasing its version.'); }
		return 'installed';
	}
	return 'same-key-update';
}

function compareVersions(left: string, right: string): number {
	const [leftCore, leftPre = ''] = left.split('-', 2);
	const [rightCore, rightPre = ''] = right.split('-', 2);
	const leftNumbers = leftCore.split('.').map(BigInt);
	const rightNumbers = rightCore.split('.').map(BigInt);
	for (let index = 0; index < 3; index++) {
		if (leftNumbers[index] !== rightNumbers[index]) { return leftNumbers[index] > rightNumbers[index] ? 1 : -1; }
	}
	if (!leftPre || !rightPre) { return leftPre === rightPre ? 0 : leftPre ? -1 : 1; }
	const leftParts = leftPre.split('.');
	const rightParts = rightPre.split('.');
	for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
		const leftNumeric = /^\d+$/.test(leftParts[index]);
		const rightNumeric = /^\d+$/.test(rightParts[index]);
		if (leftNumeric && rightNumeric) {
			const leftNumber = BigInt(leftParts[index]);
			const rightNumber = BigInt(rightParts[index]);
			if (leftNumber !== rightNumber) { return leftNumber > rightNumber ? 1 : -1; }
		} else if (leftNumeric !== rightNumeric) { return leftNumeric ? -1 : 1; }
		else if (leftParts[index] !== rightParts[index]) { return leftParts[index] > rightParts[index] ? 1 : -1; }
	}
	return leftParts.length === rightParts.length ? 0 : leftParts.length > rightParts.length ? 1 : -1;
}

export function parseManifest(value: unknown): DeclarativePackageManifest {
	const root = record(value, 'manifest');
	assertExactKeys(root, ['schemaVersion', 'packageId', 'version', 'name', 'description', 'domains', 'accountAccess', 'requestedScopes', 'sources'], 'manifest');
	if (root.schemaVersion !== 1) { throw new Error('Unsupported connector package schema version.'); }
	const packageId = boundedString(root.packageId, 'packageId', 80);
	if (!packageIdPattern.test(packageId)) { throw new Error('Connector package ID has an invalid format.'); }
	const version = boundedString(root.version, 'version', 80);
	if (!isValidVersion(version)) { throw new Error('Connector package version must use semantic version format.'); }
	const name = boundedString(root.name, 'name', 100);
	const description = boundedString(root.description, 'description', 500);
	if (root.accountAccess !== 'none' && root.accountAccess !== 'bearer-token') { throw new Error('Connector package authentication mode is unsupported.'); }
	const requestedScopes = root.requestedScopes === undefined && root.accountAccess === 'none' ? [] : parseScopes(root.requestedScopes);
	if (root.accountAccess === 'none' && requestedScopes.length) { throw new Error('Anonymous connector packages may not request scopes.'); }
	if (root.accountAccess === 'bearer-token' && !requestedScopes.length) { throw new Error('Bearer connector packages must declare requested scopes.'); }
	if (!Array.isArray(root.domains) || root.domains.length < 1 || root.domains.length > maxDomains) { throw new Error('Connector package must declare between 1 and 8 domains.'); }
	const domains = root.domains.map(domain => validateDomain(domain));
	if (new Set(domains).size !== domains.length) { throw new Error('Connector package domains must be unique.'); }
	if (root.accountAccess === 'bearer-token' && domains.length !== 1) { throw new Error('Bearer connector packages must use exactly one approved HTTPS domain.'); }
	if (!Array.isArray(root.sources) || root.sources.length < 1 || root.sources.length > maxSources) { throw new Error('Connector package must declare between 1 and 32 sources.'); }
	const sources = root.sources.map((source, index) => parseSource(source, domains, index));
	for (const source of sources) {
		if (root.accountAccess === 'none' && source.requiredScope !== undefined) { throw new Error('Anonymous connector sources may not declare a requiredScope.'); }
		if (root.accountAccess === 'bearer-token' && (!source.requiredScope || !requestedScopes.includes(source.requiredScope))) {
			throw new Error('Every bearer connector source must require a declared requested scope.');
		}
	}
	if (new Set(sources.map(source => source.sourceId)).size !== sources.length) { throw new Error('Connector source identifiers must be unique.'); }
	return { schemaVersion: 1, packageId, version, name, description, domains, accountAccess: root.accountAccess, requestedScopes, sources };
}

const scopePattern = /^[a-z0-9][a-z0-9:._-]{0,79}$/;
function parseScopes(value: unknown): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some(scope => typeof scope !== 'string' || !scopePattern.test(scope))) {
		throw new Error('Connector requestedScopes must contain between 1 and 32 valid scope labels.');
	}
	const scopes = value as string[];
	if (new Set(scopes).size !== scopes.length) { throw new Error('Connector requestedScopes must be unique.'); }
	return scopes;
}

function isValidVersion(value: string): boolean {
	return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/.test(value);
}

function parseSource(value: unknown, domains: readonly string[], index: number): DeclarativePackageSource {
	const source = record(value, `sources[${index}]`);
	assertExactKeys(source, ['sourceId', 'label', 'domain', 'path', 'recordsPath', 'titlePath', 'textPaths', 'nextCursorPath', 'cursorParameter', 'requiredScope'], `sources[${index}]`);
	const sourceId = boundedString(source.sourceId, 'sourceId', 64);
	if (!sourceIdPattern.test(sourceId)) { throw new Error('Connector source ID has an invalid format.'); }
	const label = boundedString(source.label, 'source label', 120);
	const domain = validateDomain(source.domain);
	if (!domains.includes(domain)) { throw new Error('A source uses a domain that is not declared in the package allowlist.'); }
	const path = boundedString(source.path, 'source path', 1024);
	if (!path.startsWith('/') || path.startsWith('//') || !pathPattern.test(path) || path.includes('?') || path.includes('#') || path.includes('\\') || path.includes('%')) {
		throw new Error('Source paths must be fixed HTTPS paths with one sourceKey segment.');
	}
	if (!path.includes('{sourceKey}')) { throw new Error('Each connector source path must interpolate the selected sourceKey.'); }
	if (path.split('/').some(segment => segment === '.' || segment === '..')) { throw new Error('Source paths may not traverse parent directories.'); }
	const recordsPath = source.recordsPath === undefined ? undefined : validateFieldPath(source.recordsPath, 'recordsPath');
	const titlePath = source.titlePath === undefined ? undefined : validateFieldPath(source.titlePath, 'titlePath');
	if (!Array.isArray(source.textPaths) || source.textPaths.length < 1 || source.textPaths.length > maxTextPaths) {
		throw new Error('Each connector source must select between 1 and 12 text fields.');
	}
	const textPaths = source.textPaths.map(item => validateFieldPath(item, 'textPath'));
	const nextCursorPath = source.nextCursorPath === undefined ? undefined : validateFieldPath(source.nextCursorPath, 'nextCursorPath');
	const cursorParameter = source.cursorParameter === undefined ? undefined : boundedString(source.cursorParameter, 'cursorParameter', 40);
	if (!!nextCursorPath !== !!cursorParameter) { throw new Error('Pagination requires both nextCursorPath and cursorParameter.'); }
	if (cursorParameter && !cursorParameterPattern.test(cursorParameter)) { throw new Error('Pagination parameter has an invalid format.'); }
	const requiredScope = source.requiredScope === undefined || source.requiredScope === null ? undefined : boundedString(source.requiredScope, 'requiredScope', 80);
	return { sourceId, label, domain, path, recordsPath, titlePath, textPaths, nextCursorPath, cursorParameter, requiredScope };
}

function validateDomain(value: unknown): string {
	const domain = boundedString(value, 'domain', 253).toLowerCase();
	if (domain !== value || domain.endsWith('.') || domain.includes('*') || domain.includes(':') || domain.includes('/') || domain.includes('@')) {
		throw new Error('Domains must be exact lowercase DNS hostnames without wildcards, paths, ports, or credentials.');
	}
	const url = new URL(`https://${domain}`);
	if (url.hostname !== domain || url.host !== domain || isIpAddress(domain) || !domain.includes('.')
		|| domain.split('.').some(label => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) {
		throw new Error('A package domain is not a valid exact DNS hostname.');
	}
	return domain;
}

function isIpAddress(value: string): boolean {
	return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':');
}

function validateFieldPath(value: unknown, name: string): string {
	const path = boundedString(value, name, 300);
	if (!pathValuePattern.test(path)) { throw new Error(`${name} must be a simple dotted JSON field path.`); }
	return path;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new Error(`Connector package ${label} is missing or invalid.`);
	}
	return value.trim();
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`Connector package ${label} must be an object.`); }
	return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) { throw new Error(`Connector package ${label} contains unsupported fields.`); }
}

function decodeBase64(value: string, maxBytes: number, label: string): Buffer {
	if (typeof value !== 'string' || !value || value.length > maxBytes * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		throw new Error(`Connector package ${label} is not valid base64.`);
	}
	const decoded = Buffer.from(value, 'base64');
	if (decoded.toString('base64') !== value || decoded.byteLength > maxBytes) { throw new Error(`Connector package ${label} is too large or invalid.`); }
	return decoded;
}

function rejectDuplicateObjectKeys(json: string): void {
	let offset = 0;
	const skipWhitespace = () => { while (/\s/.test(json[offset] ?? '')) { offset++; } };
	const parseString = (): string => {
		const start = offset++;
		while (offset < json.length) {
			const character = json[offset++];
			if (character === '\\') { offset++; continue; }
			if (character === '"') { return JSON.parse(json.slice(start, offset)) as string; }
		}
		throw new Error('Connector package manifest has an invalid JSON string.');
	};
	const parseValue = (depth = 0): void => {
		if (depth > 64) { throw new Error('Connector package manifest JSON nesting is too deep.'); }
		skipWhitespace();
		if (json[offset] === '{') {
			offset++;
			skipWhitespace();
			const keys = new Set<string>();
			if (json[offset] === '}') { offset++; return; }
			while (offset < json.length) {
				skipWhitespace();
				if (json[offset] !== '"') { throw new Error('Connector package manifest has an invalid JSON object.'); }
				const key = parseString();
				if (keys.has(key)) { throw new Error('Connector package manifest contains duplicate JSON keys.'); }
				keys.add(key);
				skipWhitespace();
				if (json[offset++] !== ':') { throw new Error('Connector package manifest has an invalid JSON object.'); }
				parseValue(depth + 1);
				skipWhitespace();
				const separator = json[offset++];
				if (separator === '}') { return; }
				if (separator !== ',') { throw new Error('Connector package manifest has an invalid JSON object.'); }
			}
			throw new Error('Connector package manifest has an invalid JSON object.');
		}
		if (json[offset] === '[') {
			offset++;
			skipWhitespace();
			if (json[offset] === ']') { offset++; return; }
			while (offset < json.length) {
				parseValue(depth + 1);
				skipWhitespace();
				const separator = json[offset++];
				if (separator === ']') { return; }
				if (separator !== ',') { throw new Error('Connector package manifest has an invalid JSON array.'); }
			}
			throw new Error('Connector package manifest has an invalid JSON array.');
		}
		if (json[offset] === '"') { parseString(); return; }
		const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(json.slice(offset));
		if (!primitive) { throw new Error('Connector package manifest has an invalid JSON value.'); }
		offset += primitive[0].length;
	};
	parseValue();
	skipWhitespace();
	if (offset !== json.length) { throw new Error('Connector package manifest has trailing data.'); }
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) { deepFreeze(child); }
	}
	return value;
}
