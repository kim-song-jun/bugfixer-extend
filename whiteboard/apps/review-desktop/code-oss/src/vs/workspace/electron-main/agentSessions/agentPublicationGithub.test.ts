/* Controlled CLI/HTTP protocol tests only. These do not prove an actual GitHub login. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverPublicationAccounts, PublicationGithubSession, publicationRepository, type PublicationHttpTransport } from './agentPublicationGithub.js';
import { publicationEnvironment, runPublicationProcess, type PublicationExecutable } from './agentPublicationProcess.js';

test('existing selected CLI account is verified against HTTP identity; ambient auth/debug and response secrets do not escape', async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'publication-github-ci-'))); const profile = join(root, 'profile'); mkdirSync(profile, { mode: 0o700 });
	const token = 'ghp_PROTOCOL_FIXTURE_SECRET_1234567890'; const calls: string[] = [];
	let mode: 'ok' | 'switched' | 'denied' | 'redirect' | 'large' = 'ok';
	const server = createServer((req, res) => {
		calls.push(req.url ?? ''); assert.equal(req.headers.authorization, `Bearer ${token}`);
		if (mode === 'denied') { res.writeHead(403); res.end(`private diagnostic ${token}`); return; }
		if (mode === 'redirect') { res.writeHead(302, { Location: '/unexpected-redirect' }); res.end(); return; }
		if (mode === 'large') { res.end(JSON.stringify({ value: 'x'.repeat(4 * 1024 * 1024 + 1) })); return; }
		res.setHeader('Content-Type', 'application/json');
		if (req.url === '/user') { res.end(JSON.stringify({ id: mode === 'switched' ? 12 : 11, login: mode === 'switched' ? 'other' : 'reviewer' })); return; }
		if (req.url === '/repos/acme/widget') { res.end(JSON.stringify({ id: 91, owner: { login: 'acme' }, name: 'widget', html_url: 'https://github.com/acme/widget', permissions: { push: true }, visibility: 'private', archived: false, disabled: false })); return; }
		res.writeHead(404); res.end('{}');
	});
	try {
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address(); assert.ok(address && typeof address !== 'string');
		const transport = ((options: RequestOptions, callback?: (response: IncomingMessage) => void) => {
			assert.equal(options.hostname, 'api.github.com');
			return httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: address.port }, callback);
		}) as PublicationHttpTransport;
		const executable = join(root, 'gh-fixture');
		writeFileSync(executable, `#!/bin/sh\n[ "$1 $2 $3 $4 $5 $6" = 'auth token --hostname github.com --user reviewer' ] || exit 91\n[ -z "\${GH_TOKEN+x}" ] && [ -z "\${GITHUB_TOKEN+x}" ] && [ -z "\${GH_DEBUG+x}" ] && [ -z "\${NODE_OPTIONS+x}" ] && [ -z "\${GIT_CONFIG_PARAMETERS+x}" ] || exit 92\nprintf '%s\\n' '${token}'\n`, { mode: 0o700 });
		const gh = descriptor(executable); const selected = { accountRef: 'selected', login: 'reviewer', configDirectory: profile };
		const session = await PublicationGithubSession.open(gh, selected, root, transport);
		assert.deepEqual(session.account, { accountRef: 'selected', stableId: '11', login: 'reviewer', host: 'github.com' });
		const remote = await session.resolveRemote({ name: 'origin', canonicalUrl: 'https://github.com/acme/widget.git' });
		assert.equal(remote.repositoryId, '91'); assert.equal(remote.visibility, 'private');
		assert.equal(await session.readBranch(remote, 'refs/heads/missing'), null);
		for (const canonicalUrl of ['http://github.com/acme/widget.git', 'https://token@github.com/acme/widget.git', 'https://evil.example/acme/widget.git', 'https://github.com/acme/widget.git?secret=x']) {
			assert.throws(() => publicationRepository({ name: 'origin', canonicalUrl }));
		}
		mode = 'switched'; await assert.rejects(PublicationGithubSession.open(gh, selected, root, transport), /accountChanged/);
		mode = 'denied'; await assert.rejects(PublicationGithubSession.open(gh, selected, root, transport), error => !String(error).includes(token) && /permissionDenied/.test(String(error)));
		mode = 'redirect'; const before = calls.length; await assert.rejects(PublicationGithubSession.open(gh, selected, root, transport), /providerFailed/); assert.equal(calls.length, before + 1);
		assert.equal(calls.includes('/unexpected-redirect'), false);
		mode = 'large'; await assert.rejects(PublicationGithubSession.open(gh, selected, root, transport), /invalidObservation/);
		const roster = { hosts: { 'github.com': [{ host: 'github.com', login: 'reviewer', active: true, state: 'success', token, error: `private ${token}`, tokenSource: profile },
			{ host: 'github.com', login: 'expired', active: false, state: 'error', error: 'expired token' }] } };
		writeFileSync(executable, `#!/bin/sh\n[ "$1 $2 $3 $4 $5 $6" = 'auth status --hostname github.com --json hosts' ] || exit 91\nprintf '%s\\n' '${JSON.stringify(roster)}'\n`); chmodSync(executable, 0o700);
		const choices = await discoverPublicationAccounts(descriptor(executable), profile, root);
		assert.deepEqual(choices, [{ host: 'github.com', login: 'reviewer', active: true, state: 'success' }, { host: 'github.com', login: 'expired', active: false, state: 'error' }]);
		assert.equal(JSON.stringify(choices).includes(token), false); assert.equal(JSON.stringify(choices).includes(profile), false);
		writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${token}' >&2\nexit 1\n`); chmodSync(executable, 0o700);
		await assert.rejects(PublicationGithubSession.open(descriptor(executable), selected, root, transport), error => !String(error).includes(token) && /providerFailed/.test(String(error)));
		await assert.rejects(runPublicationProcess({ executable: gh, args: [], cwd: root, env: publicationEnvironment(root) }), /providerFailed/, 'changed executable hash fails before execution');
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

function descriptor(path: string): PublicationExecutable { return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }; }
