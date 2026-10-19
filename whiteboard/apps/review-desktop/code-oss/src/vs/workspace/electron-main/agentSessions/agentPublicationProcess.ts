/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AgentSessionPublicationProviderErrorCode } from '../../common/workspaceAgentPublicationProtocol.js';

/** Supplied by the packaged native host, never by renderer, project config, PATH, or MCP. */
export interface PublicationExecutable {
	readonly path: string;
	readonly sha256: string;
}

/** No provider stderr, response text, command, environment, or credential is attached to errors. */
export class PublicationFailure extends Error {
	constructor(readonly code: AgentSessionPublicationProviderErrorCode) { super(`Publication failed: ${code}`); }
}

export async function createPublicationDirectory(privateRoot: string): Promise<string> {
	if (!isAbsolute(privateRoot) || await realpath(privateRoot) !== privateRoot) { throw new PublicationFailure('providerFailed'); }
	const stat = await lstat(privateRoot);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) { throw new PublicationFailure('providerFailed'); }
	const directory = await mkdtemp(join(privateRoot, 'publication-')); await chmod(directory, 0o700); return directory;
}

export async function verifyPublicationExecutable(executable: PublicationExecutable): Promise<void> {
	if (!isAbsolute(executable.path) || !/^[a-f0-9]{64}$/u.test(executable.sha256)) { throw new PublicationFailure('providerFailed'); }
	const stat = await lstat(executable.path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024 || (stat.mode & 0o022) !== 0
		|| await realpath(executable.path) !== executable.path || createHash('sha256').update(await readFile(executable.path)).digest('hex') !== executable.sha256) {
		throw new PublicationFailure('providerFailed');
	}
}

export interface PublicationProcessRequest {
	readonly executable: PublicationExecutable;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly input?: Buffer;
	readonly maxOutputBytes?: number;
	readonly timeoutMs?: number;
}

/** Each invocation owns a process group; group cleanup also runs when the parent exits first. */
export async function runPublicationProcess(request: PublicationProcessRequest): Promise<Buffer> {
	await verifyPublicationExecutable(request.executable);
	if (process.platform === 'win32') { throw new PublicationFailure('providerFailed'); }
	return new Promise<Buffer>((resolve, reject) => {
		const child = spawn(request.executable.path, [...request.args], {
			cwd: request.cwd, env: { ...request.env }, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
		});
		const chunks: Buffer[] = []; let outputBytes = 0; let stderrBytes = 0; let failed = false; let settled = false;
		const group = (signal: NodeJS.Signals) => {
			if (!child.pid) { return; }
			try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { failed = true; } }
		};
		const groupExists = () => {
			if (!child.pid) { return false; }
			try { process.kill(-child.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { failed = true; return true; } return false; }
		};
		const finish = (ok: boolean) => {
			if (settled) { return; } settled = true; clearTimeout(deadline);
			group('SIGTERM');
			// Even an early parent exit must not leave its git transport or credential child alive.
			setTimeout(() => {
				group('SIGKILL'); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
				const cleanupDeadline = Date.now() + 2_000;
				const verifyCleanup = () => {
					if (groupExists() && Date.now() < cleanupDeadline) { setTimeout(verifyCleanup, 25); return; }
					if (groupExists()) { failed = true; }
					if (ok && !failed) { resolve(Buffer.concat(chunks)); } else { reject(new PublicationFailure('providerFailed')); }
				};
				verifyCleanup();
			}, 150);
		};
		const abort = () => { failed = true; group('SIGTERM'); finish(false); };
		const deadline = setTimeout(abort, request.timeoutMs ?? 30_000);
		child.on('error', abort);
		child.stdin.on('error', () => { failed = true; });
		child.stdout.on('data', (data: Buffer) => { outputBytes += data.length; if (outputBytes > (request.maxOutputBytes ?? 4 * 1024 * 1024)) { abort(); } else { chunks.push(data); } });
		child.stderr.on('data', (data: Buffer) => { stderrBytes += data.length; if (stderrBytes > 1024 * 1024) { abort(); } });
		child.on('close', (code, signal) => finish(code === 0 && signal === null));
		child.stdin.end(request.input);
	});
}

/** Intentionally copies no ambient Git/GH/debug/proxy/loader configuration. */
export function publicationEnvironment(privateHome: string): Record<string, string> {
	return {
		HOME: privateHome, XDG_CONFIG_HOME: privateHome, TMPDIR: privateHome, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
		GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
		GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1',
		GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
	};
}
