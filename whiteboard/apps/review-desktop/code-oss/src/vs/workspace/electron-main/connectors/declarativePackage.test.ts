/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import test from 'node:test';
import {
	approveDeclarativePackage, validateDeclarativePackage,
	type DeclarativePackageManifest, type SignedDeclarativePackageEnvelope,
} from './declarativePackage.js';
import { importDeclarativePackageSource } from './declarativePackageRuntime.js';
import {
	isPublicAddress, maxDeclarativePackageResponseBytes, PinnedDeclarativePackageTransport,
	type DeclarativePackageTransport, type PinnedHttpsRequest,
} from './declarativePackageTransport.js';

const manifest: DeclarativePackageManifest = {
	schemaVersion: 1,
	packageId: 'public-issues',
	version: '1.0.0',
	name: 'Public issue feed',
	description: 'Reads selected public issue records.',
	domains: ['api.example.org'],
	accountAccess: 'none',
	requestedScopes: [],
	sources: [{
		sourceId: 'issues', label: 'Issue feed', domain: 'api.example.org', path: '/v1/issues/{sourceKey}',
		recordsPath: 'items', titlePath: 'metadata.title', textPaths: ['number', 'title', 'body'],
		nextCursorPath: 'metadata.next', cursorParameter: 'cursor',
	}],
};

interface Ed25519KeyPair { readonly publicKey: KeyObject; readonly privateKey: KeyObject }

function signedEnvelope(value: unknown = manifest, keys: Ed25519KeyPair = generateKeyPairSync('ed25519')): {
	envelope: SignedDeclarativePackageEnvelope;
	keys: Ed25519KeyPair;
	bytes: Buffer;
} {
	const bytes = Buffer.from(JSON.stringify(value), 'utf8');
	const publicDer = Buffer.from(keys.publicKey.export({ format: 'der', type: 'spki' }));
	const rawPublicKey = publicDer.subarray(publicDer.byteLength - 32);
	return {
		keys,
		bytes,
		envelope: {
			manifestBytesBase64: bytes.toString('base64'),
			signatureBase64: sign(null, bytes, keys.privateKey).toString('base64'),
			publicKeyBase64: rawPublicKey.toString('base64'),
		},
	};
}

function trustContext(validated: ReturnType<typeof validateDeclarativePackage>) {
	return { fingerprint: validated.fingerprint, version: validated.manifest.version, manifestDigest: validated.manifestDigest };
}

function approve(envelope: SignedDeclarativePackageEnvelope) {
	const validated = validateDeclarativePackage(envelope);
	return approveDeclarativePackage(validated, {
		packageId: validated.manifest.packageId,
		version: validated.manifest.version,
		fingerprint: validated.fingerprint,
		manifestDigest: validated.manifestDigest,
	});
}

const anonymousBinding = {
	accountRef: '00000000-0000-4000-8000-000000000042', packageId: 'public-issues', manifestDigest: '',
	host: 'api.example.org', grantedScopes: [], credential: null,
};
function bindingFor(approved: ReturnType<typeof approve>, overrides: Partial<typeof anonymousBinding> = {}) {
	return { ...anonymousBinding, manifestDigest: approved.manifestDigest, ...overrides };
}

test('signature is verified over exact manifest bytes and first install remains explicitly untrusted until approval', async () => {
	const { envelope, bytes } = signedEnvelope();
	const validated = validateDeclarativePackage(envelope);
	assert.equal(validated.trustStatus, 'first-install');
	assert.match(validated.fingerprint, /^[a-f0-9]{64}$/);
	assert.equal(validated.manifestDigest, (awaitHash(bytes)));
	assert.deepEqual(validated.review.domains, ['api.example.org']);
	assert.equal(validated.review.accountAccess, 'none');
	assert.deepEqual(validated.review.sourceRules, [{
		sourceId: 'issues', label: 'Issue feed', domain: 'api.example.org', method: 'GET',
		requiredScope: undefined, path: '/v1/issues/{sourceKey}', fields: ['number', 'title', 'body'], paginated: true,
	}]);
	await assert.rejects(importDeclarativePackageSource(validated as never, { sourceId: 'issues', sourceKey: 'one' }, undefined as never, anonymousBinding), /approved/i);
	const byteChange = Buffer.from(bytes);
	byteChange[byteChange.length - 3] ^= 1;
	assert.throws(() => validateDeclarativePackage({ ...envelope, manifestBytesBase64: byteChange.toString('base64') }), /signature is invalid/i);
});

function awaitHash(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

test('same key accepts a higher version but rejects key changes, rollbacks, and same-version republishing', () => {
	const first = signedEnvelope();
	const installed = validateDeclarativePackage(first.envelope);
	const context = trustContext(installed);
	assert.equal(validateDeclarativePackage(first.envelope, context).trustStatus, 'installed');
	const updatedManifest = { ...manifest, version: '1.1.0' };
	assert.equal(validateDeclarativePackage(signedEnvelope(updatedManifest, first.keys).envelope, context).trustStatus, 'same-key-update');
	assert.throws(() => validateDeclarativePackage(signedEnvelope({ ...manifest, version: '0.9.0' }, first.keys).envelope, context), /roll back/i);
	assert.throws(() => validateDeclarativePackage(signedEnvelope({ ...manifest, description: 'Changed without a version bump' }, first.keys).envelope, context), /without increasing its version/i);
	assert.throws(() => validateDeclarativePackage(signedEnvelope({ ...manifest, version: '2.0.0' }).envelope, context), /key changed/i);
});

test('anonymous packages accept empty or omitted requestedScopes for legacy compatibility', () => {
	const { requestedScopes: _scopes, ...legacyManifest } = manifest;
	assert.deepEqual(validateDeclarativePackage(signedEnvelope(legacyManifest).envelope).manifest.requestedScopes, []);
	assert.deepEqual(validateDeclarativePackage(signedEnvelope(manifest).envelope).manifest.requestedScopes, []);
});

test('strict schema rejects credentials, executable fields, undeclared domains, IPs, and malformed JSON keys', () => {
	for (const invalid of [
		{ ...manifest, accountAccess: 'bearer-token' },
		{ ...manifest, transform: 'process.env.SECRET' },
		{ ...manifest, sources: [{ ...manifest.sources[0], domain: 'other.example.org' }] },
		{ ...manifest, domains: ['127.0.0.1'] },
		{ ...manifest, domains: ['*.example.org'] },
		{ ...manifest, sources: [{ ...manifest.sources[0], path: '/v1/../admin' }] },
		{ ...manifest, sources: [{ ...manifest.sources[0], path: '/v1/issues' }] },
	]) {
		assert.throws(() => validateDeclarativePackage(signedEnvelope(invalid).envelope));
	}
	const duplicate = Buffer.from('{"schemaVersion":1,"schemaVersion":1}');
	const keys = generateKeyPairSync('ed25519');
	const publicDer = Buffer.from(keys.publicKey.export({ format: 'der', type: 'spki' }));
	assert.throws(() => validateDeclarativePackage({
		manifestBytesBase64: duplicate.toString('base64'),
		signatureBase64: sign(null, duplicate, keys.privateKey).toString('base64'),
		publicKeyBase64: publicDer.subarray(-32).toString('base64'),
	}), /duplicate JSON keys/i);
});

test('bearer imports require the reviewed package binding, matching host and per-source granted scope', async () => {
	const bearerManifest = {
		...manifest, accountAccess: 'bearer-token', requestedScopes: ['issues:read'],
		sources: [{ ...manifest.sources[0], requiredScope: 'issues:read' }],
	};
	const approved = approve(signedEnvelope(bearerManifest).envelope);
	const connection = {
		accountRef: '00000000-0000-4000-8000-000000000043', packageId: approved.manifest.packageId,
		manifestDigest: approved.manifestDigest, host: 'api.example.org', grantedScopes: ['issues:read'], credential: 'synthetic-token',
	};
	let receivedCredential: string | undefined;
	const transport: DeclarativePackageTransport = { get: async (_url, _host, token) => { receivedCredential = token; return { items: [] }; } };
	const result = await importDeclarativePackageSource(approved, { sourceId: 'issues', sourceKey: 'team' }, transport, connection);
	assert.equal(receivedCredential, 'synthetic-token');
	assert.equal(result.accountRef, connection.accountRef);
	await assert.rejects(importDeclarativePackageSource(approved, { sourceId: 'issues', sourceKey: 'team' }, transport, { ...connection, host: 'evil.example.org' }), /host/i);
	await assert.rejects(importDeclarativePackageSource(approved, { sourceId: 'issues', sourceKey: 'team' }, transport, { ...connection, manifestDigest: '0'.repeat(64) }), /bound/i);
	await assert.rejects(importDeclarativePackageSource(approved, { sourceId: 'issues', sourceKey: 'team' }, transport, { ...connection, grantedScopes: [] }), /scope/i);
	await assert.rejects(importDeclarativePackageSource(approved, { sourceId: 'issues', sourceKey: 'team' }, transport, { ...connection, credential: null }), /credential/i);
	assert.throws(() => validateDeclarativePackage(signedEnvelope({ ...bearerManifest, domains: ['api.example.org', 'other.example.org'] }).envelope), /exactly one/i);
	assert.throws(() => validateDeclarativePackage(signedEnvelope({ ...bearerManifest, sources: [{ ...bearerManifest.sources[0], requiredScope: 'issues:write' }] }).envelope), /declared requested scope/i);
});

test('signed declarative source fetch returns normalized bytes with pagination and bounded output', async () => {
	const approved = approve(signedEnvelope().envelope);
	const urls: URL[] = [];
	const pages = [
		{ metadata: { title: 'Open issues', next: 'cursor 2' }, items: [{ number: 1, title: 'Broken export', body: 'Fix the CSV export.' }] },
		{ metadata: { next: '' }, items: [{ number: 2, title: 'Slow load', body: 'Reduce query time.' }] },
	];
	const transport: DeclarativePackageTransport = {
		get: async url => { urls.push(url); return pages.shift()!; },
	};
	const result = await importDeclarativePackageSource(approved, { sourceId: 'issues', sourceKey: 'team_1' }, transport, bindingFor(approved));
	assert.equal(urls.length, 2);
	assert.equal(urls[0].origin, 'https://api.example.org');
	assert.equal(urls[0].pathname, '/v1/issues/team_1');
	assert.equal(urls[1].searchParams.get('cursor'), 'cursor 2');
	assert.equal(result.connectorId, 'local:public-issues');
	assert.equal(result.externalId, `public-issues:${anonymousBinding.accountRef}:issues:team_1`);
	assert.equal(result.accountRef, anonymousBinding.accountRef);
	assert.equal(result.title, 'Open issues');
	assert.match(new TextDecoder().decode(result.content), /Fix the CSV export/);
	assert.match(new TextDecoder().decode(result.content), /Reduce query time/);
	const secondResource = await importDeclarativePackageSource(approved, { sourceId: 'issues', sourceKey: 'team_2' }, {
		get: async url => { urls.push(url); return { metadata: {}, items: [{ number: 3, title: 'Third', body: 'Another issue.' }] }; },
	}, bindingFor(approved));
	assert.equal(urls[2].pathname, '/v1/issues/team_2');
	assert.notEqual(urls[0].toString(), urls[2].toString());
	assert.equal(secondResource.sourceUri, urls[2].toString());
	assert.equal(secondResource.externalId, `public-issues:${anonymousBinding.accountRef}:issues:team_2`);

	const huge = 'x'.repeat(1024 * 1024 + 32);
	const bounded = await importDeclarativePackageSource(approved, { sourceId: 'issues', sourceKey: 'team_1' }, { get: async () => ({ metadata: { title: 'Big' }, items: [{ number: 3, title: 'Large', body: huge }] }) }, bindingFor(approved));
	assert.ok(bounded.content.byteLength <= 1024 * 1024);
	assert.ok(bounded.omissions.some(label => /truncated/.test(label)));
});

test('pinned HTTPS transport uses the exact allowlisted host for TLS SNI and host routing, and rejects redirects/private DNS', async () => {
	let captured: PinnedHttpsRequest | undefined;
	const transport = new PinnedDeclarativePackageTransport({
		resolveAddresses: async hostname => {
			assert.equal(hostname, 'api.example.org');
			return [{ address: '93.184.216.34', family: 4 }];
		},
		executePinnedRequest: async request => {
			captured = request;
			return { statusCode: 200, body: Buffer.from('{"ok":true}') };
		},
	});
	assert.deepEqual(await transport.get(new URL('https://api.example.org/v1/items/1'), 'api.example.org'), { ok: true });
	assert.equal(captured?.hostname, 'api.example.org');
	assert.equal(captured?.servername, 'api.example.org');
	assert.equal(captured?.rejectUnauthorized, true);
	assert.equal(captured?.hostHeader, 'api.example.org');
	assert.deepEqual(captured?.addresses, [{ address: '93.184.216.34', family: 4 }]);
	assert.equal(captured?.method, 'GET');
	assert.deepEqual(captured?.headers, {});
	const resolvePinned = captured?.lookup as unknown as (hostname: string, options: object, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => void;
	const pinnedAddress = await new Promise<{ address: string; family: number }>((resolve, reject) => {
		resolvePinned('api.example.org', {}, (error, address, family) => error ? reject(error) : resolve({ address, family }));
	});
	assert.deepEqual(pinnedAddress, { address: '93.184.216.34', family: 4 });

	const redirectTransport = new PinnedDeclarativePackageTransport({
		resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
		executePinnedRequest: async () => ({ statusCode: 302, body: Buffer.from('') }),
	});
	await assert.rejects(redirectTransport.get(new URL('https://api.example.org/v1/items/1'), 'api.example.org'), /redirects are not allowed/i);

	let executorCalled = false;
	const privateDnsTransport = new PinnedDeclarativePackageTransport({
		resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
		executePinnedRequest: async () => { executorCalled = true; return { statusCode: 200, body: Buffer.from('{}') }; },
	});
	await assert.rejects(privateDnsTransport.get(new URL('https://api.example.org/v1/items/1'), 'api.example.org'), /private or reserved/i);
	assert.equal(executorCalled, false);

	const oversizedTransport = new PinnedDeclarativePackageTransport({
		resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
		executePinnedRequest: async () => ({ statusCode: 200, body: Buffer.alloc(maxDeclarativePackageResponseBytes + 1) }),
	});
	await assert.rejects(oversizedTransport.get(new URL('https://api.example.org/v1/items/1'), 'api.example.org'), /2 MiB limit/i);

	let credentialRequest: PinnedHttpsRequest | undefined;
	const echoingTransport = new PinnedDeclarativePackageTransport({
		resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
		executePinnedRequest: async request => { credentialRequest = request; return { statusCode: 200, body: Buffer.from('{"echo":"synthetic-token"}') }; },
	});
	await assert.rejects(echoingTransport.get(new URL('https://api.example.org/v1/items/1'), 'api.example.org', 'synthetic-token'), /echoed its bearer credential/i);
	assert.deepEqual(credentialRequest?.headers, { Authorization: 'Bearer synthetic-token' });
});

test('address classifier blocks private, reserved, and literal address ranges', () => {
	for (const address of [
		{ address: '127.0.0.1', family: 4 as const },
		{ address: '10.0.0.1', family: 4 as const },
		{ address: '100.64.0.1', family: 4 as const },
		{ address: '169.254.10.2', family: 4 as const },
		{ address: '192.0.2.1', family: 4 as const },
		{ address: '192.31.196.12', family: 4 as const },
		{ address: '2001:db8::1', family: 6 as const },
		{ address: '2001:3::1', family: 6 as const },
		{ address: '2620:4f:8000::1', family: 6 as const },
		{ address: '::1', family: 6 as const },
		{ address: 'fc00::1', family: 6 as const },
	]) { assert.equal(isPublicAddress(address), false, address.address); }
	assert.equal(isPublicAddress({ address: '8.8.8.8', family: 4 }), true);
	assert.equal(isPublicAddress({ address: '2606:4700:4700::1111', family: 6 }), true);
});
