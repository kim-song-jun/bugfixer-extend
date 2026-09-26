/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
	type ProviderCommandSpec,
	type ProviderRunEvent,
	type ProviderRunHandle,
	type ProviderRunRequest,
	type ProviderRunResult,
	type ProviderRunPreflight,
	type ProviderTerminalState,
} from './providerRunTypes.js';
import { PROVIDER_MAX_EVENT_LINE_BYTES, PROVIDER_MAX_FINAL_TEXT_BYTES } from './providerRunTypes.js';

const MAX_LINE_BYTES = PROVIDER_MAX_EVENT_LINE_BYTES;
const DEFAULT_CANCEL_GRACE_MS = 2_000;
const GROUP_CLEANUP_TIMEOUT_MS = 2_000;
const GROUP_CHECK_INTERVAL_MS = 25;
// Keep this shell as the process-group leader until the supervisor has reaped
// the whole group. Reaping the leader first would make a later numeric-PGID
// signal unsafe because the kernel may already have reused that identifier.
const LAUNCH_GATE_SCRIPT = 'trap ":" TERM INT; IFS= read -r launch_gate <&3 || exit 125; [ "$launch_gate" = "GO" ] || exit 125; exec 3<&-; "$@" 4>&- <&0 & provider_pid=$!; wait "$provider_pid"; provider_status=$?; printf "%s\\n" "$provider_status" >&4 || exit 125; while :; do sleep 1; done';

/** Windows process-tree ownership is not implemented, so provider execution is unavailable there. */
export function isProviderProcessPlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
	return platform !== 'win32';
}

export function isProviderMutatingPlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
	return platform === 'darwin';
}

export interface ProviderProcessSupervisorOptions {
	readonly cancelGraceMs?: number;
	readonly maxLineBytes?: number;
}

/** Owns one app-launched provider process and its stdout/stderr parsers. */
export class ProviderProcessSupervisor {
	private readonly cancelGraceMs: number;
	private readonly maxLineBytes: number;

	constructor(options: ProviderProcessSupervisorOptions = {}) {
		this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
		this.maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
	}

	async run(
		request: ProviderRunRequest,
		spec: ProviderCommandSpec,
		onEvent: (event: ProviderRunEvent) => void,
		onOwnedProcessSpawned: (pgid: number) => Promise<void> | void,
	): Promise<ProviderRunHandle> {
		if (request.signal?.aborted) { return rejectedHandle(request, 'Provider run was cancelled before launch.'); }
		if (!isProviderProcessPlatformSupported()) {
			return rejectedHandle(request, 'Provider runs are not supported on Windows until owned process-tree termination is implemented.');
		}
		if (request.permissionPolicy.mode === 'mutating') {
			if (!isProviderMutatingPlatformSupported()) {
				return rejectedHandle(request, 'Mutating provider runs require the macOS native bound-checkout helper.');
			}
			if (!hasBoundHelperInvocation(request, spec)) {
				return rejectedHandle(request, 'Mutating provider runs require the native bound-checkout helper and matching folder identity.');
			}
		}
		let preflight: ProviderRunPreflight;
		try {
			preflight = await request.preflight(request);
		} catch {
			return rejectedHandle(request, 'Provider run preflight could not prove the folder and permission policy.');
		}
		if (request.signal?.aborted) { return rejectedHandle(request, 'Provider run was cancelled before launch.'); }
		if (!preflight.allowed) {
			return rejectedHandle(request, preflight.reason);
		}
		if (!preflight.cwdIdentity.trim() || !preflight.policyProof.trim()) {
			return rejectedHandle(request, 'Provider run preflight returned an incomplete folder or policy proof.');
		}
		if (!spec.executable.trim() || !Array.isArray(spec.args)) {
			return rejectedHandle(request, 'Provider adapter returned an invalid command specification.');
		}
		return launch(request, spec, onEvent, onOwnedProcessSpawned, this.cancelGraceMs, this.maxLineBytes);
	}
}

function hasBoundHelperInvocation(request: ProviderRunRequest, spec: ProviderCommandSpec): boolean {
	const folder = request.boundFolder;
	if (!folder || !isAbsolute(folder.rootPath) || !isAbsolute(folder.helperExecutable)
		|| !/^\d+$/.test(folder.dev) || !/^\d+$/.test(folder.ino) || spec.executable !== folder.helperExecutable) {
		return false;
	}
	const prefix = ['--root', folder.rootPath, '--dev', folder.dev, '--ino', folder.ino, 'provider', folder.helperMode];
	return prefix.every((value, index) => spec.args[index] === value);
}

function rejectedHandle(request: ProviderRunRequest, error: string): ProviderRunHandle {
	return {
		pid: undefined,
		result: Promise.resolve({
			attemptId: request.attemptId,
			providerId: request.providerId,
			state: 'failed',
			cleanupVerified: true,
			exitCode: null,
			signal: null,
			error,
		}),
		cancel() {
			// There is no owned process to terminate.
		},
	};
}

async function launch(
	request: ProviderRunRequest,
	spec: ProviderCommandSpec,
	onEvent: (event: ProviderRunEvent) => void,
	onOwnedProcessSpawned: (pgid: number) => Promise<void> | void,
	cancelGraceMs: number,
	maxLineBytes: number,
): Promise<ProviderRunHandle> {
	let child: ChildProcess;
	let spawnFailed = false;
	let launchGateFailed = false;
	let launchGateWriteAttempted = false;
	try {
		child = spawn('/bin/sh', ['-c', LAUNCH_GATE_SCRIPT, 'provider-launch-gate', spec.executable, ...spec.args], {
			cwd: request.cwd,
			env: childEnvironment(spec.env, request.providerId),
			shell: false,
			windowsHide: true,
			detached: process.platform !== 'win32',
			stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
		});
	} catch {
		return rejectedHandle(request, 'Provider process could not be started.');
	}
	child.once('error', () => { spawnFailed = true; });
	const launchGate = child.stdio[3] as NodeJS.WritableStream | null;
	// Attach before any async persistence callback: a shell that exits early can
	// close fd3 while the callback is pending, and EPIPE must never be unhandled.
	launchGate?.on('error', () => { launchGateFailed = true; });
	launchGate?.on('close', () => { if (!launchGateWriteAttempted) launchGateFailed = true; });

	let terminalState: ProviderTerminalState | undefined;
	let exitCode: number | null = null;
	let providerExitCode: number | undefined;
	let exitSignal: NodeJS.Signals | null = null;
	let cancelled = false;
	let closeSeen = false;
	let cleanupPromise: Promise<GroupCleanupResult> | undefined;
	let parserError: string | undefined;
	let finalText: string | undefined;
	let resolveResult!: (result: ProviderRunResult) => void;
	const result = new Promise<ProviderRunResult>((resolve) => resolveResult = resolve);
	const requestTermination = (): Promise<GroupCleanupResult> => {
		cleanupPromise ??= child.pid
			? terminateOwnedGroup(child.pid, cancelGraceMs)
			: Promise.resolve({ verified: true });
		return cleanupPromise;
	};
	const statusStream = child.stdio[4] as NodeJS.ReadableStream | null;
	if (statusStream) {
		let status = '';
		statusStream.on('data', (chunk: Buffer | string) => {
			status += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			const newline = status.indexOf('\n');
			if (newline < 0) return;
			const parsed = Number(status.slice(0, newline));
			if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 255) {
				providerExitCode = parsed;
				requestTermination();
			}
		});
	}

	const acceptLine = (line: string, stream: 'stdout' | 'stderr'): void => {
		if (closeSeen || parserError) return;
		try {
			const parsed = spec.parseEvent(line, stream);
			if (request.captureFinalText && parsed.finalText !== undefined) {
				if (typeof parsed.finalText !== 'string' || Buffer.byteLength(parsed.finalText, 'utf8') > PROVIDER_MAX_FINAL_TEXT_BYTES) {
					parserError = 'Provider final text exceeded the configured limit.';
					requestTermination();
					return;
				}
				finalText = parsed.finalText;
			}
			if (parsed.event) {
				onEvent({
					...parsed.event,
					providerId: request.providerId,
					attemptId: request.attemptId,
					timestamp: Date.now(),
				});
			}
			if (parsed.terminalState) {
				if (terminalState && terminalState !== parsed.terminalState) {
					throw new Error('Conflicting provider terminal events.');
				}
				terminalState = parsed.terminalState;
			}
		} catch {
			parserError = 'Provider output could not be parsed safely.';
			requestTermination();
		}
	};

	const attachLines = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr'): void => {
		const decoder = new StringDecoder('utf8');
		let pending = '';
		stream.on('data', (chunk: Buffer | string) => {
			pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
			if (Buffer.byteLength(pending, 'utf8') > maxLineBytes && !pending.includes('\n')) {
				parserError = 'Provider emitted a line larger than the configured limit.';
				requestTermination();
				pending = '';
				return;
			}
			let newline: number;
			while ((newline = pending.indexOf('\n')) >= 0) {
				const line = pending.slice(0, newline).replace(/\r$/, '');
				pending = pending.slice(newline + 1);
				if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
					parserError = 'Provider emitted a line larger than the configured limit.';
					requestTermination();
					pending = '';
					return;
				}
				acceptLine(line, name);
			}
			if (Buffer.byteLength(pending, 'utf8') > maxLineBytes) {
				parserError = 'Provider emitted a line larger than the configured limit.';
				requestTermination();
				pending = '';
			}
		});
		stream.on('end', () => {
			pending += decoder.end();
			if (pending.length > 0 && Buffer.byteLength(pending, 'utf8') <= maxLineBytes) acceptLine(pending, name);
			else if (pending.length > 0) parserError = 'Provider emitted a line larger than the configured limit.';
		});
	};

	if (child.stdout) attachLines(child.stdout, 'stdout');
	if (child.stderr) attachLines(child.stderr, 'stderr');
	child.once('close', (code, signal) => {
		closeSeen = true;
			exitCode = providerExitCode ?? code;
		exitSignal = signal;
		void (async () => {
			// The guardian owns the PGID until termination completes. Never signal
			// after close: at that point a numeric PGID may identify another group.
			const unexpectedDescendants = !cleanupPromise && child.pid !== undefined && ownedGroupExists(child.pid);
			const cleanup: GroupCleanupResult = cleanupPromise ? await cleanupPromise : { verified: true };
			const state: ProviderTerminalState = !cleanup.verified || unexpectedDescendants
				? 'interrupted'
				: cancelled
				? 'cancelled'
				: launchGateFailed
					? 'failed'
					: spawnFailed || parserError || exitCode !== 0 || terminalState !== 'succeeded'
						? terminalState === 'cancelled' ? 'cancelled' : terminalState === 'interrupted' ? 'interrupted' : 'failed'
						: 'succeeded';
			resolveResult({
				attemptId: request.attemptId,
				providerId: request.providerId,
				state,
				cleanupVerified: cleanup.verified,
				exitCode,
				signal: exitSignal,
				error: cleanup.error ?? parserError ?? (unexpectedDescendants ? 'Owned provider process group remained after its guardian exited.' : !cancelled && launchGateFailed ? 'Provider launch gate closed before execution was authorized.' : spawnFailed ? 'Provider process failed to start.' : undefined),
				...(request.captureFinalText && finalText !== undefined ? { finalText } : {}),
			});
		})().catch(() => resolveResult({
			attemptId: request.attemptId,
			providerId: request.providerId,
			state: 'interrupted',
			cleanupVerified: false,
			exitCode,
			signal: exitSignal,
			error: 'Owned provider process cleanup could not be verified.',
		}));
	});

	const handle = {
		pid: child.pid,
		result,
		cancel() {
			if (closeSeen || cancelled) return;
			cancelled = true;
			requestTermination();
		},
	};
	const removeAbortListener = () => request.signal?.removeEventListener('abort', handle.cancel);
	request.signal?.addEventListener('abort', handle.cancel, { once: true });
	void result.then(removeAbortListener);
	if (!child.pid) { return { ...handle, pid: undefined }; }
	try {
		await onOwnedProcessSpawned(child.pid);
	} catch {
		handle.cancel();
		await result;
		return { ...handle, pid: undefined };
	}
	// The gate remains closed until durable ownership is recorded. This final
	// synchronous check closes the cancel/delete race immediately before GO.
	if (request.signal?.aborted || cancelled) {
		handle.cancel();
		await result;
		return { ...handle, pid: undefined };
	}
	if (!launchGate || !child.stdin) {
		handle.cancel();
		await result;
		return { ...handle, pid: undefined };
	}
	launchGateWriteAttempted = true;
	try { launchGate.end('GO\n'); }
	catch { launchGateFailed = true; handle.cancel(); await result; return { ...handle, pid: undefined }; }
	child.stdin.once('error', () => { spawnFailed = true; });
	child.stdin.end(spec.stdin);
	return handle;
}

interface GroupCleanupResult {
	readonly verified: boolean;
	readonly error?: string;
}

function ownedGroupExists(pgid: number): boolean {
	try { process.kill(-pgid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** An ESRCH probe is the only safe positive proof after a prior app instance exits. */
export function isOwnedProcessGroupGone(pgid: number): boolean {
	if (process.platform === 'win32' || !Number.isSafeInteger(pgid) || pgid < 2) { return false; }
	return !ownedGroupExists(pgid);
}

async function waitForOwnedGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (ownedGroupExists(pgid) && Date.now() < deadline) {
		await new Promise<void>(resolve => setTimeout(resolve, GROUP_CHECK_INTERVAL_MS));
	}
	return !ownedGroupExists(pgid);
}

async function terminateOwnedGroup(pgid: number, graceMs: number): Promise<GroupCleanupResult> {
	if (!ownedGroupExists(pgid)) { return { verified: true }; }
	try { process.kill(-pgid, 'SIGTERM'); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return { verified: true }; }
		return { verified: false, error: 'The owned provider process group could not be signalled.' };
	}
	if (await waitForOwnedGroupExit(pgid, graceMs)) { return { verified: true }; }
	try { process.kill(-pgid, 'SIGKILL'); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return { verified: true }; }
		return { verified: false, error: 'The owned provider process group could not be terminated.' };
	}
	if (await waitForOwnedGroupExit(pgid, GROUP_CLEANUP_TIMEOUT_MS)) { return { verified: true }; }
	return { verified: false, error: 'The owned provider process group is still running after cancellation.' };
}

/** Pass only launch essentials; provider credentials must come from the selected profile. */
function childEnvironment(profileEnv: ProviderCommandSpec['env'], providerId: ProviderRunRequest['providerId']): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	const profileKey = providerId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
	const profileDirectory = profileEnv?.[profileKey];
	if (profileDirectory !== undefined) env[profileKey] = profileDirectory;
	return env;
}
