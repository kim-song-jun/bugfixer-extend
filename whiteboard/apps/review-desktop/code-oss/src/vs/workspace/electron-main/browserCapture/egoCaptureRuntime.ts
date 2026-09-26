/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants, accessSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { WorkspaceEgoSelectedText } from '../../common/workspaceBrowserCaptureProtocol.js';

const maximumSelectionBytes = 512 * 1024;
const maximumStartOutputBytes = 2048;
const maximumCaptureOutputBytes = 4 * 1024 * 1024;
const maximumErrorOutputBytes = 8 * 1024;
const startTimeoutMs = 60_000;
const operationTimeoutMs = 30_000;
const shutdownGraceMs = 1_000;
const outputMarker = '__REVIEW_DESKTOP_EGO__';
const inputPathMarker = '__EGO_CAPTURE_INPUT_FILE__';

export interface EgoCaptureRuntime {
	start(url: string): Promise<number>;
	captureSelection(spaceId: number): Promise<WorkspaceEgoSelectedText>;
	cancel(spaceId: number): Promise<void>;
	shutdown?(): Promise<void>;
}

interface ProcessRecord {
	readonly pid: number;
	readonly ppid: number;
	readonly startedAt: string;
	readonly command: string;
	readonly cwd: string;
	readonly child: ChildProcess;
}

interface CliResult {
	readonly ok: boolean;
	readonly spaceId?: number;
	readonly selection?: WorkspaceEgoSelectedText;
	readonly tooLong?: boolean;
	readonly closeFailed?: boolean;
	readonly stage?: string;
	readonly closed?: boolean;
}

/** Bounded, shell-free adapter around the documented `ego-browser nodejs -e` API. */
export class EgoBrowserCliRuntime implements EgoCaptureRuntime {
	private readonly processes = new Map<number, ProcessRecord>();
	private readonly executable: string | undefined;

	constructor(configuredExecutablePath?: string) {
		this.executable = resolveEgoBrowserExecutable(configuredExecutablePath);
	}

	async start(url: string): Promise<number> {
		let observedSpaceId: number | undefined;
		let startupCleanupConfirmed = false;
		try {
			const result = await this.invoke(startScript, { url }, maximumStartOutputBytes, startTimeoutMs, spaceId => { observedSpaceId = spaceId; });
			if (!result.ok || !this.validSpaceId(result.spaceId)) {
				startupCleanupConfirmed = result.closed === true;
				if (this.validSpaceId(result.spaceId) && result.closed === false) { throw new EgoBrowserCaptureError('Ego Browser could not start or close the capture session.', result.stage, result.spaceId, true); }
				throw new EgoBrowserCaptureError('Ego Browser could not start a capture page.', result.stage);
			}
			return result.spaceId;
		} catch (error) {
			if (startupCleanupConfirmed) { throw error; }
			if (error instanceof EgoBrowserCaptureError && error.cleanupPending) { throw error; }
			if (observedSpaceId !== undefined) {
				try { await this.finishSpace(observedSpaceId); }
				catch { throw new EgoBrowserCaptureError('Ego Browser could not start or close the capture session.', undefined, observedSpaceId, true); }
			}
			throw error;
		}
	}

	async captureSelection(spaceId: number): Promise<WorkspaceEgoSelectedText> {
		let result: CliResult;
		try {
			result = await this.invoke(captureScript, { spaceId, maximumSelectionBytes }, maximumCaptureOutputBytes, operationTimeoutMs);
		} catch (error) {
			try { await this.finishSpace(spaceId); }
			catch { throw new EgoBrowserCaptureError('Ego Browser capture failed and the capture session could not be closed.'); }
			throw error;
		}
		if (!result.ok) {
			if (result.tooLong) { throw new EgoBrowserCaptureError('The selected text exceeds 512 KiB.'); }
			if (result.closeFailed) { throw new EgoBrowserCaptureError('Ego Browser capture failed and the capture session could not be closed.'); }
			throw new EgoBrowserCaptureError('Ego Browser could not capture the current selection.');
		}
		if (!result.selection || typeof result.selection.text !== 'string' || typeof result.selection.url !== 'string' || typeof result.selection.title !== 'string') {
			throw new EgoBrowserCaptureError('Ego Browser returned an invalid selection.');
		}
		return result.selection;
	}

	async cancel(spaceId: number): Promise<void> {
		const result = await this.invoke(finishScript, { spaceId }, maximumStartOutputBytes, operationTimeoutMs);
		if (!result.ok) { throw new EgoBrowserCaptureError('Ego Browser could not close the capture session.'); }
	}

	/** Kill only process groups created by this adapter, then await their exit. */
	async shutdown(): Promise<void> {
		await Promise.all([...this.processes.values()].map(record => this.terminate(record.child)));
	}

	private async finishSpace(spaceId: number): Promise<void> {
		const result = await this.invoke(finishScript, { spaceId }, maximumStartOutputBytes, operationTimeoutMs);
		if (!result.ok) { throw new EgoBrowserCaptureError('Ego Browser could not close the capture session.'); }
	}

	private async invoke(
		script: string,
		input: unknown,
		maximumStdoutBytes: number,
		timeoutMs: number,
		onSpaceCreated?: (spaceId: number) => void,
	): Promise<CliResult> {
		const executable = this.executable;
		if (!executable) {
			throw new EgoBrowserCaptureError('Ego Browser CLI was not found. Install it or configure its absolute executable path.');
		}
		let temporaryDirectory: string;
		try { temporaryDirectory = await mkdtemp(join(tmpdir(), 'review-desktop-ego-capture-')); }
		catch { throw new EgoBrowserCaptureError('Could not prepare the Ego Browser request.'); }
		try {
			const inputPath = join(temporaryDirectory, 'request.json');
			try { await writeFile(inputPath, JSON.stringify(input), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
			catch { throw new EgoBrowserCaptureError('Could not securely prepare the Ego Browser request.'); }
			const preparedScript = script.replaceAll(inputPathMarker, JSON.stringify(inputPath));
			return await new Promise((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawn(executable, ['nodejs', '-e', preparedScript], {
					shell: false,
					cwd: process.cwd(),
					detached: process.platform !== 'win32',
					stdio: ['pipe', 'pipe', 'pipe'],
					env: this.cliEnvironment(),
				});
			} catch {
				reject(new EgoBrowserCaptureError('Ego Browser CLI could not be started. Install ego-browser and make it available on PATH.'));
				return;
			}
			if (!child.pid) {
				child.once('error', () => reject(new EgoBrowserCaptureError('Ego Browser CLI did not start.')));
				child.once('close', () => reject(new EgoBrowserCaptureError('Ego Browser CLI did not start.')));
				return;
			}
			const record: ProcessRecord = { pid: child.pid, ppid: process.pid, startedAt: new Date().toISOString(), command: `${executable} nodejs -e <capture-script>`, cwd: process.cwd(), child };
			this.processes.set(record.pid, record);
			let totalOutputBytes = 0;
			let diagnosticBytes = 0;
			let stdoutRemainder = '';
			let stderrRemainder = '';
			let result: CliResult | undefined;
			let failure: Error | undefined;
			let settled = false;
			const timer = setTimeout(() => {
				failure = new EgoBrowserCaptureError('Ego Browser operation timed out.');
				void this.terminate(child);
			}, timeoutMs);
			const consumeLine = (line: string): void => {
				const markerIndex = line.indexOf(outputMarker);
				if (markerIndex < 0) {
					diagnosticBytes += Buffer.byteLength(line, 'utf8');
					if (diagnosticBytes > maximumErrorOutputBytes) {
						failure = new EgoBrowserCaptureError('Ego Browser emitted too much diagnostic output.');
						void this.terminate(child);
					}
					return;
				}
				diagnosticBytes += Buffer.byteLength(line.slice(0, markerIndex), 'utf8');
				if (diagnosticBytes > maximumErrorOutputBytes) {
					failure = new EgoBrowserCaptureError('Ego Browser emitted too much diagnostic output.');
					void this.terminate(child);
					return;
				}
				try {
					const message = JSON.parse(line.slice(markerIndex + outputMarker.length)) as { event?: string; result?: CliResult; spaceId?: number };
					if (message.event === 'space-created' && this.validSpaceId(message.spaceId)) { onSpaceCreated?.(message.spaceId); }
					if (message.event === 'result' && message.result) { result = message.result; }
				} catch {
					failure = new EgoBrowserCaptureError('Ego Browser returned an invalid response.');
					void this.terminate(child);
				}
			};
			const consumeChunk = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
				totalOutputBytes += chunk.byteLength;
				if (totalOutputBytes > maximumStdoutBytes + maximumErrorOutputBytes) {
					failure = new EgoBrowserCaptureError('Ego Browser returned too much data.');
					void this.terminate(child);
					return;
				}
				const pending = stream === 'stdout' ? stdoutRemainder : stderrRemainder;
				const lines = (pending + chunk.toString('utf8')).split('\n');
				const remainder = lines.pop() ?? '';
				if (stream === 'stdout') { stdoutRemainder = remainder; } else { stderrRemainder = remainder; }
				for (const line of lines) { consumeLine(line); }
				if (Buffer.byteLength(remainder, 'utf8') > maximumStdoutBytes + maximumErrorOutputBytes) {
					failure = new EgoBrowserCaptureError('Ego Browser output line exceeded its limit.');
					void this.terminate(child);
				}
			};
			child.stdout?.on('data', (chunk: Buffer) => consumeChunk(chunk, 'stdout'));
			child.stderr?.on('data', (chunk: Buffer) => consumeChunk(chunk, 'stderr'));
			child.once('error', error => {
				failure = (error as NodeJS.ErrnoException).code === 'ENOENT'
					? new EgoBrowserCaptureError('Ego Browser CLI is missing. Install ego-browser and make it available on PATH.')
					: new EgoBrowserCaptureError('Ego Browser CLI failed to start.');
			});
			child.once('close', code => {
				clearTimeout(timer);
				this.processes.delete(record.pid);
				if (settled) { return; }
				settled = true;
				if (stdoutRemainder) { consumeLine(stdoutRemainder); }
				if (stderrRemainder) { consumeLine(stderrRemainder); }
				if (failure) { reject(failure); return; }
				if (code !== 0) { reject(new EgoBrowserCaptureError('Ego Browser operation failed.')); return; }
				if (!result) { reject(new EgoBrowserCaptureError('Ego Browser returned no result.', `exit code ${code}; ${totalOutputBytes} output bytes; ${diagnosticBytes} diagnostic bytes`)); return; }
				resolve(result);
			});
			child.stdin?.end();
			});
		} finally {
			try { await rm(temporaryDirectory, { recursive: true, force: true }); }
			catch { throw new EgoBrowserCaptureError('Could not remove the temporary Ego Browser request.'); }
		}
	}

	private cliEnvironment(): NodeJS.ProcessEnv {
		const systemPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'];
		return {
			PATH: [dirname(this.executable!), ...systemPath].join(':'),
			HOME: homedir(),
			USER: userInfo().username,
			TMPDIR: tmpdir(),
			...(process.env.LANG ? { LANG: process.env.LANG } : {}),
			...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
		};
	}

	private async terminate(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || child.killed) { return; }
		const pid = child.pid;
		if (pid === undefined) { return; }
		try {
			if (process.platform === 'win32') { child.kill('SIGTERM'); }
			else { process.kill(-pid, 'SIGTERM'); }
		} catch { /* The owned process already exited. */ }
		await Promise.race([
			new Promise<void>(resolve => child.once('close', () => resolve())),
			new Promise<void>(resolve => setTimeout(resolve, shutdownGraceMs)),
		]);
		if (child.exitCode === null) {
			try {
				if (process.platform === 'win32') { child.kill('SIGKILL'); }
				else { process.kill(-pid, 'SIGKILL'); }
			} catch { /* The owned process already exited. */ }
		}
	}

	private validSpaceId(value: unknown): value is number {
		return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
	}
}

/** Resolve only explicit or standard user install locations; never search project PATH. */
export function resolveEgoBrowserExecutable(configuredExecutablePath?: string): string | undefined {
	const candidates = configuredExecutablePath !== undefined
		? [configuredExecutablePath]
		: [
			join(homedir(), '.local', 'bin', 'ego-browser'),
			'/opt/homebrew/bin/ego-browser',
			'/usr/local/bin/ego-browser',
			'/usr/bin/ego-browser',
		];
	for (const candidate of candidates) {
		if (!isAbsolute(candidate)) { continue; }
		try {
			const realPath = realpathSync(candidate);
			if (!statSync(realPath).isFile()) { continue; }
			accessSync(realPath, fsConstants.X_OK);
			return realPath;
		} catch {
			// Missing or non-executable candidates are surfaced as the clear unavailable error.
		}
	}
	return undefined;
}

export class EgoBrowserCaptureError extends Error {
	constructor(message: string, readonly diagnostic?: string, readonly createdSpaceId?: number, readonly cleanupPending = false) { super(message); }
}

const startScript = `
const emit = value => process.stdout.write('${outputMarker}' + JSON.stringify(value) + '\\n');
let task;
let handedOff = false;
let spaceId;
let stage = 'input';
let closed = true;
try {
  const input = JSON.parse(await (await import('node:fs/promises')).readFile(${inputPathMarker}, 'utf8'));
  stage = 'task-space';
  task = await taskSpace('Review Desktop selected text capture');
  spaceId = task.spaceId;
  emit({ event: 'space-created', spaceId });
  stage = 'navigation';
  await task.page('p1').goto(input.url);
  stage = 'handoff';
  await task.handOff();
  handedOff = true;
  emit({ event: 'result', result: { ok: true, spaceId } });
} catch {
  if (task && !handedOff) { try { await task.finish({ keep: [] }); } catch { closed = false; } }
  emit({ event: 'result', result: { ok: false, spaceId, closed, stage } });
}
`;

const captureScript = `
const emit = value => process.stdout.write('${outputMarker}' + JSON.stringify(value) + '\\n');
let task;
let result = { ok: false };
try {
  const input = JSON.parse(await (await import('node:fs/promises')).readFile(${inputPathMarker}, 'utf8'));
  task = await takeOverTaskSpace(input.spaceId);
  const page = task.userPage();
  if (!page || page.spaceId !== input.spaceId) { throw new Error('No active capture page.'); }
  const selection = await page.evaluate(({ maximumBytes }) => {
    const text = window.getSelection()?.toString() ?? '';
    const tooLong = new TextEncoder().encode(text).byteLength > maximumBytes;
    return tooLong ? { tooLong: true } : { text, url: window.location.href, title: document.title };
  }, { maximumBytes: ${maximumSelectionBytes} });
  result = selection.tooLong ? { ok: false, tooLong: true } : { ok: true, selection };
} catch {
  result = { ok: false };
} finally {
  if (task) { try { await task.finish({ keep: [] }); } catch { result = { ok: false, closeFailed: true }; } }
}
emit({ event: 'result', result });
`;

const finishScript = `
const emit = value => process.stdout.write('${outputMarker}' + JSON.stringify(value) + '\\n');
let task;
let ok = false;
try {
  const input = JSON.parse(await (await import('node:fs/promises')).readFile(${inputPathMarker}, 'utf8'));
  task = await takeOverTaskSpace(input.spaceId);
  await task.finish({ keep: [] });
  task = undefined;
  ok = true;
} catch {
  if (task) { try { await task.finish({ keep: [] }); } catch { ok = false; } }
}
emit({ event: 'result', result: { ok } });
`;
