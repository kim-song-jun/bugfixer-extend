/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { PublicationFailure, publicationEnvironment, verifyPublicationExecutable, type PublicationExecutable } from './agentPublicationProcess.js';
import type { PublicationRuntime } from './agentSessionPublicationExecutor.js';

const execFileAsync = promisify(execFile);
const PR_REF_GUARD = 'review-runtime/bin/pr-ref-guard';

/** Resolve host-owned, canonical executable descriptors and the existing selected gh config root. */
export async function resolvePublicationEnvironment(input: {
	readonly profileDirectory: string;
	readonly resourcesPath: string;
}, environment: NodeJS.ProcessEnv = process.env): Promise<{ readonly runtime: PublicationRuntime; readonly configDirectory: string }> {
	const privateRoot = await ensurePublicationPrivateRoot(input.profileDirectory);
	const home = homedir();
	const configDirectory = await resolveGhConfigDirectory(home, environment);
	const runtimePath = (name: string) => join(input.resourcesPath, 'app', name);
	const prRefGuard = await executableDescriptor(runtimePath(PR_REF_GUARD));
	const gh = await findPublicationExecutable('gh');
	const git = await findPublicationExecutable('git');
	const httpsTransport = await resolveGitHttpsTransport(git, privateRoot);
	const runtime: PublicationRuntime = {
		privateRoot,
		gh,
		git: { git, httpsTransport, prePushGuard: prRefGuard },
	};
	return { runtime, configDirectory };
}

export async function ensurePublicationPrivateRoot(profileDirectory: string): Promise<string> {
	if (!isAbsolute(profileDirectory)) { throw new PublicationFailure('providerFailed'); }
	const profileRoot = await realpath(profileDirectory);
	const profileStat = await lstat(profileRoot);
	if (!profileStat.isDirectory() || profileStat.isSymbolicLink() || (process.getuid && profileStat.uid !== process.getuid())) { throw new PublicationFailure('providerFailed'); }
	const privateRoot = join(profileRoot, 'publication');
	await mkdir(privateRoot, { mode: 0o700 }).catch(error => {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw new PublicationFailure('providerFailed'); }
	});
	const privateStat = await lstat(privateRoot);
	if (!privateStat.isDirectory() || privateStat.isSymbolicLink() || (privateStat.mode & 0o077) !== 0
		|| (process.getuid && privateStat.uid !== process.getuid()) || await realpath(privateRoot) !== privateRoot) {
		throw new PublicationFailure('providerFailed');
	}
	return privateRoot;
}

export async function resolveGhConfigDirectory(home: string, environment: NodeJS.ProcessEnv): Promise<string> {
	const chosen = environment.GH_CONFIG_DIR !== undefined
		? environment.GH_CONFIG_DIR
		: environment.XDG_CONFIG_HOME !== undefined
			? join(environment.XDG_CONFIG_HOME, 'gh')
			: join(home, '.config', 'gh');
	if (!isAbsolute(chosen)) { throw new PublicationFailure('accountChanged'); }
	const stat = await lstat(chosen).catch(() => undefined);
	if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
		|| await realpath(chosen) !== chosen || (process.getuid && stat.uid !== process.getuid())) {
		throw new PublicationFailure('accountChanged');
	}
	return chosen;
}

async function findPublicationExecutable(name: 'git' | 'gh'): Promise<PublicationExecutable> {
	if (process.platform === 'win32') { throw new PublicationFailure('providerFailed'); }
	const candidates = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].map(directory => join(directory, name));
	const seen = new Set<string>();
	for (const candidate of candidates) {
		let canonical: string;
		try { canonical = await realpath(candidate); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') { continue; }
			throw new PublicationFailure('providerFailed');
		}
		if (seen.has(canonical)) { continue; }
		seen.add(canonical);
		await assertHostInstallation(canonical, name);
		try { await access(canonical, constants.X_OK); }
		catch { throw new PublicationFailure('providerFailed'); }
		return executableDescriptor(canonical);
	}
	throw new PublicationFailure('providerFailed');
}

async function resolveGitHttpsTransport(git: PublicationExecutable, privateRoot: string): Promise<PublicationExecutable> {
	await assertHostInstallation(git.path, 'git');
	await verifyPublicationExecutable(git);
	let execPath: string;
	try {
		const result = await execFileAsync(git.path, ['--exec-path'], {
			cwd: privateRoot,
			env: publicationEnvironment(privateRoot),
			encoding: 'utf8',
			timeout: 5_000,
			maxBuffer: 8_192,
		});
		execPath = result.stdout.trim();
	} catch {
		throw new PublicationFailure('providerFailed');
	}
	if (!isAbsolute(execPath) || await realpath(execPath) !== execPath) { throw new PublicationFailure('providerFailed'); }
	const helperPath = await realpath(join(execPath, 'git-remote-https'));
	await assertHostInstallation(helperPath, 'https');
	return executableDescriptor(helperPath);
}

/** Ambient PATH and project-owned tool locations never establish publication authority. */
async function assertHostInstallation(path: string, tool: 'git' | 'gh' | 'https'): Promise<void> {
	const formula = tool === 'gh' ? 'gh' : 'git';
	const roots = [`/opt/homebrew/Cellar/${formula}`, `/usr/local/Cellar/${formula}`,
		...(tool === 'https' ? ['/usr/lib/git-core', '/usr/libexec/git-core', '/Library/Developer/CommandLineTools/usr/libexec/git-core', '/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core'] : [])];
	const fixed = tool === 'https' ? [] : ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/Library/Developer/CommandLineTools/usr/bin', '/Applications/Xcode.app/Contents/Developer/usr/bin'].map(directory => join(directory, tool));
	const expectedName = tool === 'https' ? ['git-remote-https', 'git-remote-http'].includes(basename(path)) : basename(path) === tool;
	if (!expectedName || !isAbsolute(path) || await realpath(path) !== path || !fixed.includes(path) && !roots.some(root => path.startsWith(`${root}/`))) {
		throw new PublicationFailure('providerFailed');
	}
	const executable = await lstat(path);
	if (process.getuid && executable.uid !== 0 && executable.uid !== process.getuid()) { throw new PublicationFailure('providerFailed'); }
	let directory = dirname(path);
	while (true) {
		const stat = await lstat(directory);
		// macOS installers use the privileged admin group for /Applications and Homebrew.
		const adminWritable = process.platform === 'darwin' && stat.gid === 80;
		if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o002) !== 0 || (stat.mode & 0o020) !== 0 && !adminWritable
			|| (process.getuid && stat.uid !== 0 && stat.uid !== process.getuid())) { throw new PublicationFailure('providerFailed'); }
		const parent = dirname(directory);
		if (parent === directory) { break; }
		directory = parent;
	}
}

async function executableDescriptor(path: string): Promise<PublicationExecutable> {
	if (!isAbsolute(path) || await realpath(path) !== path) { throw new PublicationFailure('providerFailed'); }
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024 || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
		throw new PublicationFailure('providerFailed');
	}
	const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
	const descriptor = { path, sha256 };
	await verifyPublicationExecutable(descriptor);
	return descriptor;
}
