/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';

const TERMINATION_SETTLE_MS = 2_500;
const GROUP_CLEANUP_TIMEOUT_MS = 2_500;
const GROUP_CHECK_INTERVAL_MS = 25;
const GUARDIAN_PATH = fileURLToPath(new URL('./agentCliProbeGuardian.mjs', import.meta.url));

export interface BoundedAgentCliProcessOptions {
	readonly env: NodeJS.ProcessEnv;
	/** Trusted absolute probe directory; inherited by the guardian and its provider child. */
	readonly cwd?: string;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
	/** Trusted standalone Node executable. Electron hosts must provide this explicitly. */
	readonly guardianNodeExecutable?: string;
	/** Packaged guardian script path. Electron hosts should provide their packaged resource path. */
	readonly guardianScriptPath?: string;
}

export interface BoundedAgentCliProcessResult {
	readonly stdout: string;
	readonly stderr: string;
}

export class AgentCliProcessError extends Error {
	constructor(message: string, readonly cleanupVerified: boolean, readonly ownedProcessGroupId?: number) {
		super(message);
		this.name = 'AgentCliProcessError';
	}
}

/** Runs a bounded probe under a live Node guardian which owns all process-group signals. */
export function runBoundedAgentCliProcess(
	executable: string,
	args: readonly string[],
	options: BoundedAgentCliProcessOptions,
): Promise<BoundedAgentCliProcessResult> {
	if (!executable.trim() || /[\u0000-\u001f\u007f]/.test(executable) || args.length > 32
		|| args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg))) {
		return Promise.reject(new AgentCliProcessError('CLI probe command arguments are invalid.', true));
	}
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000
		|| !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > 1024 * 1024) {
		return Promise.reject(new AgentCliProcessError('CLI probe bounds are invalid.', true));
	}
	if (process.platform === 'win32') {
		return Promise.reject(new AgentCliProcessError('CLI capability probes require verified POSIX process-group cleanup.', true));
	}
	if (options.cwd !== undefined && (!isAbsolute(options.cwd) || options.cwd.length > 4096 || /[\u0000-\u001f\u007f]/.test(options.cwd))) {
		return Promise.reject(new AgentCliProcessError('The CLI probe working directory is invalid.', true));
	}
	const nodeExecutable = options.guardianNodeExecutable ?? (process.versions.electron ? undefined : process.execPath);
	if (!nodeExecutable || !isAbsolute(nodeExecutable) || !existsSync(nodeExecutable)) {
		return Promise.reject(new AgentCliProcessError('A trusted standalone Node executable is required for CLI probes.', true));
	}
	const guardianScriptPath = options.guardianScriptPath ?? (process.versions.electron ? undefined : GUARDIAN_PATH);
	if (!guardianScriptPath || !isAbsolute(guardianScriptPath) || !existsSync(guardianScriptPath)) {
		return Promise.reject(new AgentCliProcessError('The CLI probe guardian is unavailable.', true));
	}
	return runWithGuardian(nodeExecutable, guardianScriptPath, executable, args, options);
}

interface GuardianMessage {
	readonly event?: unknown;
	readonly stream?: unknown;
	readonly base64?: unknown;
	readonly code?: unknown;
	readonly signal?: unknown;
	readonly bytes?: unknown;
}

async function runWithGuardian(
	nodeExecutable: string,
	guardianScriptPath: string,
	executable: string,
	args: readonly string[],
	options: BoundedAgentCliProcessOptions,
): Promise<BoundedAgentCliProcessResult> {
	let guardian: ChildProcess;
	try {
		guardian = fork(guardianScriptPath, [], {
			execPath: nodeExecutable,
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			execArgv: [],
			detached: true,
			shell: false,
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			env: minimalGuardianEnvironment(options.env),
		});
	} catch {
		throw new AgentCliProcessError('The CLI probe guardian could not be started.', true);
	}
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let outputBytes = 0;
	let completed: { readonly code: number | null; readonly signal: string | null; readonly bytes: number } | undefined;
	let primaryFailure: string | undefined;
	let stopRequested = false;
	let settled = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let exitResolve!: () => void;
	const exited = new Promise<void>(resolve => { exitResolve = resolve; });
	const waitForExit = () => Promise.race([exited.then(() => true), delay(TERMINATION_SETTLE_MS).then(() => false)]);
	const sendStop = () => {
		if (stopRequested) { return; }
		stopRequested = true;
		try { if (guardian.connected) { guardian.send({ command: 'stop' }); } }
		catch { /* The guardian observes IPC disconnect and cleans its owned group. */ }
	};
	const terminateAndVerify = async (): Promise<boolean> => {
		sendStop();
		if (await waitForExit()) { return guardian.pid === undefined || await waitForProcessGroupExit(guardian.pid); }
		try { guardian.disconnect(); } catch { /* Already disconnected. */ }
		if (await waitForExit()) { return guardian.pid === undefined || await waitForProcessGroupExit(guardian.pid); }
		guardian.unref();
		guardian.channel?.unref();
		return false;
	};
	const output = (message: GuardianMessage) => {
		if ((message.stream !== 'stdout' && message.stream !== 'stderr') || typeof message.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.base64)) {
			primaryFailure ??= 'CLI capability output exceeded its size limit.';
			sendStop();
			return;
		}
		const chunk = Buffer.from(message.base64, 'base64');
		if (chunk.byteLength > options.maxOutputBytes) {
			primaryFailure ??= 'CLI capability output exceeded its size limit.';
			sendStop();
			return;
		}
		outputBytes += chunk.byteLength;
		if (outputBytes > options.maxOutputBytes) {
			primaryFailure ??= 'CLI capability output exceeded its size limit.';
			sendStop();
			return;
		}
		(message.stream === 'stdout' ? stdout : stderr).push(chunk);
	};
	const onMessage = (raw: unknown) => {
		if (!raw || typeof raw !== 'object') { return; }
		const message = raw as GuardianMessage;
		if (message.event === 'output') { output(message); }
		else if (message.event === 'complete' && (message.code === null || Number.isInteger(message.code)) && (message.signal === null || typeof message.signal === 'string') && Number.isSafeInteger(message.bytes)) {
			completed = { code: message.code as number | null, signal: message.signal as string | null, bytes: message.bytes as number };
		}
		else if (message.event === 'launchError') { primaryFailure ??= 'The selected CLI could not be started.'; }
		else if (message.event === 'outputError') { primaryFailure ??= 'CLI capability output could not be drained and verified.'; sendStop(); }
	};
	const finish = async (): Promise<BoundedAgentCliProcessResult> => {
		if (settled) { throw new AgentCliProcessError('CLI probe already settled.', false, guardian.pid); }
		settled = true;
		if (timeout) { clearTimeout(timeout); }
		const cleanupVerified = await terminateAndVerify();
		if (!cleanupVerified) {
			throw new AgentCliProcessError('CLI probe guardian cleanup could not be verified; owned processes may remain.', false, guardian.pid);
		}
		if (primaryFailure) { throw new AgentCliProcessError(primaryFailure, true, guardian.pid); }
		if (!completed) { throw new AgentCliProcessError('CLI probe guardian exited without a completion receipt.', true, guardian.pid); }
		if (completed.bytes !== outputBytes) { throw new AgentCliProcessError('CLI capability output byte count did not match its completion receipt.', true, guardian.pid); }
		if (completed.code !== 0) {
			throw new AgentCliProcessError(`CLI capability probe exited with status ${completed.code ?? completed.signal ?? 'unknown'}.`, true, guardian.pid);
		}
		return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
	};
	guardian.on('message', onMessage);
	guardian.once('error', () => { primaryFailure ??= 'The CLI probe guardian failed.'; exitResolve(); });
	guardian.once('exit', () => exitResolve());
	guardian.once('close', () => exitResolve());
	guardian.once('spawn', () => {
		if (stopRequested) { return; }
		try {
			guardian.send({ command: 'start', executable, args: [...args], env: options.env, maxOutputBytes: options.maxOutputBytes }, error => {
				if (error) { primaryFailure ??= 'The CLI probe launch request could not be delivered.'; sendStop(); }
			});
		} catch { primaryFailure ??= 'The CLI probe launch request could not be delivered.'; sendStop(); }
	});
	timeout = setTimeout(() => { primaryFailure ??= `CLI capability probe timed out after ${options.timeoutMs}ms.`; sendStop(); }, options.timeoutMs);
	const exitedInTime = await Promise.race([exited.then(() => true), delay(options.timeoutMs + TERMINATION_SETTLE_MS + 100).then(() => false)]);
	if (!exitedInTime) { primaryFailure ??= 'CLI probe guardian did not exit within its cleanup bound.'; }
	return finish();
}

function minimalGuardianEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { PATH: source.PATH ?? '', LANG: source.LANG ?? 'C.UTF-8', LC_ALL: source.LC_ALL ?? 'C.UTF-8' };
	for (const key of ['TMPDIR', 'TEMP']) { if (source[key] !== undefined) { env[key] = source[key]; } }
	return env;
}

function processGroupExists(pgid: number | undefined): boolean {
	if (!pgid) { return false; }
	try { process.kill(-pgid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return false; }
		return true;
	}
}

async function waitForProcessGroupExit(pgid: number | undefined): Promise<boolean> {
	if (!pgid) { return false; }
	const deadline = Date.now() + GROUP_CLEANUP_TIMEOUT_MS;
	while (processGroupExists(pgid) && Date.now() < deadline) { await delay(GROUP_CHECK_INTERVAL_MS); }
	return !processGroupExists(pgid);
}

function delay(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
