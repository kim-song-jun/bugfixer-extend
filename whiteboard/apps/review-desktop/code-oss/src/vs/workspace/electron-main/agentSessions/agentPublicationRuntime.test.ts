/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { PublicationFailure, verifyPublicationExecutable } from './agentPublicationProcess.js';
import { resolveGhConfigDirectory, resolvePublicationEnvironment } from './agentPublicationRuntime.js';

test('publication runtime resolves real host Git and gh with a private operation root and pins the shipped guard descriptor', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-publication-runtime-')));
	const profileDirectory = join(root, 'agent-sessions');
	const configDirectory = join(root, 'gh-config');
	const resourcesPath = join(root, 'resources');
	const helperDirectory = join(resourcesPath, 'app', 'review-runtime', 'bin');
	const guardPath = join(helperDirectory, 'pr-ref-guard');
	const guardBytes = Buffer.from('#!/bin/sh\nexit 0\n');
	const projectBin = join(root, 'project-bin');
	const executedMarker = join(root, 'project-executable-ran');

	try {
		await Promise.all([
			mkdir(profileDirectory, { mode: 0o700 }),
			mkdir(configDirectory, { mode: 0o700 }),
			mkdir(helperDirectory, { recursive: true }),
			mkdir(projectBin, { mode: 0o700 }),
		]);
		await writeFile(guardPath, guardBytes, { mode: 0o700 });
		for (const name of ['git', 'gh']) {
			await writeFile(join(projectBin, name), `#!/bin/sh\nprintf compromised > '${executedMarker}'\n`, { mode: 0o755 });
		}
		const guardSha256 = digest(guardBytes);

		const resolved = await resolvePublicationEnvironment({ profileDirectory, resourcesPath }, {
			PATH: `${projectBin}${delimiter}${process.env.PATH ?? ''}`,
			GH_CONFIG_DIR: configDirectory,
		});
		assert.equal(resolved.configDirectory, configDirectory);
		assert.equal(resolved.runtime.privateRoot, await realpath(join(profileDirectory, 'publication')));
		assert.equal((await stat(resolved.runtime.privateRoot)).mode & 0o077, 0);
		assert.equal(resolved.runtime.gh.path, await realpath(resolved.runtime.gh.path));
		assert.equal(resolved.runtime.git.git.path, await realpath(resolved.runtime.git.git.path));
		assert.match(resolved.runtime.git.httpsTransport.path, /\/git-remote-https?$/u);
		assert.ok(!resolved.runtime.gh.path.startsWith(`${projectBin}/`) && !resolved.runtime.git.git.path.startsWith(`${projectBin}/`), 'Project PATH entries must never select publication executables.');
		await assert.rejects(stat(executedMarker), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
		assert.equal(resolved.runtime.git.prePushGuard.path, guardPath);
		assert.equal(resolved.runtime.git.prePushGuard.sha256, guardSha256);
		assert.equal(resolved.runtime.gh.sha256, digest(await readFile(resolved.runtime.gh.path)));
		assert.equal(resolved.runtime.git.git.sha256, digest(await readFile(resolved.runtime.git.git.path)));
		assert.equal(resolved.runtime.git.httpsTransport.sha256, digest(await readFile(resolved.runtime.git.httpsTransport.path)));

		await writeFile(guardPath, Buffer.concat([guardBytes, Buffer.from('# changed\n')]));
		await assert.rejects(verifyPublicationExecutable(resolved.runtime.git.prePushGuard),
			(error: unknown) => error instanceof PublicationFailure && error.code === 'providerFailed');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('gh config selection honors the host explicit directory and rejects a bad selection without fallback', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-publication-gh-config-')));
	const xdgConfigHome = join(root, 'xdg');
	const xdgGhDirectory = join(xdgConfigHome, 'gh');
	const explicitDirectory = join(root, 'explicit-gh');
	const defaultHome = join(root, 'default-home');
	const defaultGhDirectory = join(defaultHome, '.config', 'gh');

	try {
		await Promise.all([
			mkdir(xdgGhDirectory, { recursive: true, mode: 0o700 }),
			mkdir(explicitDirectory, { mode: 0o700 }),
			mkdir(defaultGhDirectory, { recursive: true, mode: 0o700 }),
		]);
		assert.equal(await resolveGhConfigDirectory(homedir(), { XDG_CONFIG_HOME: xdgConfigHome }), xdgGhDirectory);
		assert.equal(await resolveGhConfigDirectory(defaultHome, {}), defaultGhDirectory);
		assert.equal(await resolveGhConfigDirectory(homedir(), { GH_CONFIG_DIR: explicitDirectory, XDG_CONFIG_HOME: xdgConfigHome }), explicitDirectory);
		await assert.rejects(resolveGhConfigDirectory(homedir(), { GH_CONFIG_DIR: join(root, 'missing'), XDG_CONFIG_HOME: xdgConfigHome }),
			(error: unknown) => error instanceof PublicationFailure && error.code === 'accountChanged');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('publication runtime refuses an existing app-private root with permissive mode', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-publication-root-mode-')));
	const profileDirectory = join(root, 'agent-sessions');
	const privateRoot = join(profileDirectory, 'publication');

	try {
		await mkdir(privateRoot, { recursive: true, mode: 0o755 });
		await chmod(privateRoot, 0o755);
		await assert.rejects(resolvePublicationEnvironment({ profileDirectory, resourcesPath: root }, {}),
			(error: unknown) => error instanceof PublicationFailure && error.code === 'providerFailed');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function digest(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
