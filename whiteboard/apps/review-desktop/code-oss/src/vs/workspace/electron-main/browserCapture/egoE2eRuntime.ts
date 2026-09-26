/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { WorkspaceE2eStep } from '../../common/workspaceE2eProtocol.js';
import { resolveEgoBrowserExecutable, EgoBrowserCaptureError } from './egoCaptureRuntime.js';

export interface EgoE2eRunResult { readonly passed: boolean; readonly screenshot: Uint8Array; readonly log: string; readonly failure: string | null; }

/** The Ego task space is closed, but its screenshot or event log was not captured. */
export class EgoE2eEvidenceError extends EgoBrowserCaptureError { }

export interface EgoE2eRuntime {
	createSpace(): Promise<number>;
	run(spaceId: number, targetUrl: string, scenario: readonly WorkspaceE2eStep[], evidenceId: string): Promise<EgoE2eRunResult>;
	finish(spaceId: number): Promise<EgoE2eRunResult>;
	stop?(evidenceId: string): Promise<void>;
	shutdown?(): Promise<void>;
}

const marker = '__REVIEW_DESKTOP_EGO_E2E__';
const inputMarker = '__EGO_E2E_INPUT__';
const receiptMarker = '__EGO_E2E_RECEIPT__';
const maxOutput = 8 * 1024 * 1024;
const operationTimeout = 120_000;
// Keep credentials and page text out of the Ego CLI receipt and process output.
const safeEventLogScript = `
const safeEventLog = events => {
  const allowed = new Set(['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']);
  const levels = new Set(['log', 'info', 'warn', 'warning', 'error', 'debug']);
  if (!Array.isArray(events)) return [];
  const saved = [];
  for (const event of events) {
    if (saved.length >= 2000) break;
    if (!event || typeof event !== 'object' || !allowed.has(event.method)) continue;
    const item = { method: event.method };
    const params = event.params && typeof event.params === 'object' ? event.params : {};
    if (event.method === 'Network.responseReceived') {
      const response = params.response && typeof params.response === 'object' ? params.response : {};
      const status = response.status ?? event.status;
      if (Number.isInteger(status) && status >= 100 && status <= 599) item.status = status;
    } else if (event.method === 'Runtime.consoleAPICalled' || event.method === 'Log.entryAdded') {
      const entry = params.entry && typeof params.entry === 'object' ? params.entry : {};
      const level = event.method === 'Log.entryAdded' ? entry.level : params.type;
      if (levels.has(level)) item.level = level;
    }
    saved.push(item);
  }
  return saved;
};
`;

/** Executes only the documented Ego Lite API; no Playwright imports or inferred APIs. */
export class EgoBrowserE2eRuntime implements EgoE2eRuntime {
	private readonly executable: string | undefined;
	private readonly active = new Map<string, ChildProcess>();
	private readonly children = new Set<ChildProcess>();

	constructor(configuredExecutablePath?: string) { this.executable = resolveEgoBrowserExecutable(configuredExecutablePath); }

	async createSpace(): Promise<number> {
		const result = await this.invoke(`
const emit = value => process.stdout.write('${marker}' + JSON.stringify(value) + '\\n');
const fs = await import('node:fs/promises');
let task;
try { task = await taskSpace('Bugfixer Extend frontend E2E'); await fs.writeFile(${receiptMarker}, JSON.stringify({ spaceId: task.spaceId }), { mode: 0o600, flag: 'wx' }); emit({ ok: true, spaceId: task.spaceId }); }
catch (error) {
  let cleanupConfirmed = false;
  if (task) { try { await task.finish({ keep: [] }); cleanupConfirmed = true; } catch (cleanupError) { emit({ ok: false, cleanupFailed: true, failure: cleanupError instanceof Error ? cleanupError.message.slice(0, 512) : 'Task-space cleanup could not be verified.' }); process.exitCode = 2; } }
  if (!cleanupConfirmed) emit({ ok: false, failure: error instanceof Error ? error.message.slice(0, 512) : 'Task-space creation failed.' });
}
`, {}, undefined, false, true);
		if (result.ok !== true || typeof result.spaceId !== 'number' || !Number.isSafeInteger(result.spaceId) || result.spaceId < 1) { throw new EgoBrowserCaptureError('Ego Browser could not create a task space.'); }
		return result.spaceId;
	}

	async run(spaceId: number, targetUrl: string, scenario: readonly WorkspaceE2eStep[], evidenceId: string): Promise<EgoE2eRunResult> {
		const result = await this.invoke(`
const emit = value => process.stdout.write('${marker}' + JSON.stringify(value) + '\\n');
const fs = await import('node:fs/promises');
const os = await import('node:os');
const path = await import('node:path');
${safeEventLogScript}
let task;
let passed = false;
let failure = null;
let screenshot;
let log = [];
let cleanupConfirmed = false;
try {
  const input = JSON.parse(await fs.readFile(${inputMarker}, 'utf8'));
  task = await taskSpace(input.spaceId);
  const page = task.page('p1');
  await page.cdp('Network.enable', {});
  await page.cdp('Network.setCacheDisabled', { cacheDisabled: true });
  await page.cdp('Runtime.enable', {});
  await page.goto(input.targetUrl);
  for (const step of input.scenario) {
    if (step.type === 'click') await page.click(step.selector);
    else if (step.type === 'fill') await page.fill(step.selector, step.value);
    else if (step.type === 'assertText') {
      await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text) === true,
        { selector: step.selector, text: step.value }, { timeout: 5000 });
    }
  }
  passed = true;
} catch (error) { failure = error instanceof Error ? error.message.slice(0, 512) : 'E2E scenario failed.'; }
try {
  const input = JSON.parse(await fs.readFile(${inputMarker}, 'utf8'));
  task ??= await takeOverTaskSpace(input.spaceId);
  const page = task.page('p1');
  const events = await page.events();
  log = safeEventLog(events);
  const shot = path.join(os.tmpdir(), 'bugfixer-e2e-' + input.evidenceId + '.png');
  await page.screenshot({ path: shot, fullPage: true });
  screenshot = (await fs.readFile(shot)).toString('base64');
  await fs.rm(shot, { force: true });
} catch (error) {
  failure ??= error instanceof Error ? error.message.slice(0, 512) : 'Could not capture E2E evidence.';
  passed = false;
} finally {
  if (task) { try { await task.finish({ keep: [] }); cleanupConfirmed = true; } catch (error) { failure ??= error instanceof Error ? error.message.slice(0, 512) : 'Ego task space cleanup failed.'; process.exitCode = 2; } }
}
const result = { ok: Boolean(screenshot), cleanupConfirmed, cleanupFailed: process.exitCode === 2, passed, screenshot, log, failure };
await fs.writeFile(${receiptMarker}, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
emit(result);
`, { spaceId, targetUrl, scenario, evidenceId }, evidenceId, true);
		if (result.cleanupConfirmed !== true) { throw new EgoBrowserCaptureError('Ego Browser cleanup failed or could not be confirmed; retry is required.'); }
		if (result.ok !== true || typeof result.screenshot !== 'string' || !Array.isArray(result.log)) { throw new EgoE2eEvidenceError('Ego Browser closed the task space, but did not return complete E2E evidence.'); }
		return { passed: result.passed === true, screenshot: Buffer.from(result.screenshot, 'base64'), log: JSON.stringify(result.log), failure: typeof result.failure === 'string' ? result.failure : null };
	}

	async finish(spaceId: number): Promise<EgoE2eRunResult> {
		const result = await this.invoke(`
const emit = value => process.stdout.write('${marker}' + JSON.stringify(value) + '\\n');
const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
${safeEventLogScript}
let task; let screenshot; let log = []; let failure = null; let cleanupConfirmed = false;
try {
  const input = JSON.parse(await fs.readFile(${inputMarker}, 'utf8'));
  task = await takeOverTaskSpace(input.spaceId);
  const page = task.page('p1'); log = safeEventLog(await page.events());
  const shot = path.join(os.tmpdir(), 'bugfixer-e2e-cleanup-' + input.spaceId + '.png');
  await page.screenshot({ path: shot, fullPage: true }); screenshot = (await fs.readFile(shot)).toString('base64'); await fs.rm(shot, { force: true });
} catch (error) { failure = error instanceof Error ? error.message.slice(0, 512) : 'Could not collect final E2E evidence.'; }
finally { if (task) { try { await task.finish({ keep: [] }); cleanupConfirmed = true; } catch (error) { failure ??= error instanceof Error ? error.message.slice(0, 512) : 'Ego task-space cleanup failed.'; process.exitCode = 2; } } }
const result = { ok: Boolean(screenshot), cleanupConfirmed, cleanupFailed: process.exitCode === 2, passed: false, screenshot, log, failure };
await fs.writeFile(${receiptMarker}, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
emit(result);
`, { spaceId }, undefined, true);
		if (result.cleanupConfirmed !== true) { throw new EgoBrowserCaptureError('Ego Browser could not close the task space; retry is required.'); }
		if (result.ok !== true || typeof result.screenshot !== 'string' || !Array.isArray(result.log)) { throw new EgoE2eEvidenceError('Ego Browser closed the task space, but could not collect final evidence.'); }
		return { passed: false, screenshot: Buffer.from(result.screenshot, 'base64'), log: JSON.stringify(result.log), failure: typeof result.failure === 'string' ? result.failure : null };
	}

	async stop(evidenceId: string): Promise<void> {
		const child = this.active.get(evidenceId);
		if (child) { await this.terminateChild(child); }
	}

	async shutdown(): Promise<void> { await Promise.all([...this.children].map(child => this.terminateChild(child))); }

	private async terminateChild(child: ChildProcess): Promise<void> {
		if (!child.pid) { return; }
		const directChildExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
		if (!directChildExited() || (process.platform !== 'win32' && this.processGroupAlive(child.pid))) { this.signalChild(child, 'SIGTERM'); }
		await Promise.race([new Promise<void>(resolve => child.once('close', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 1000))]);
		const ownedProcessStillAlive = process.platform !== 'win32' ? this.processGroupAlive(child.pid) : !directChildExited();
		if (ownedProcessStillAlive) { this.signalChild(child, 'SIGKILL'); }
		if (!directChildExited()) { await Promise.race([new Promise<void>(resolve => child.once('close', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 1000))]); }
	}

	private processGroupAlive(pid: number): boolean {
		try { process.kill(-pid, 0); return true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return false; } throw error; }
	}

	private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
		if (!child.pid) { return; }
		try { if (process.platform === 'win32') { child.kill(signal); } else { process.kill(-child.pid, signal); } }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
	}

	private async invoke(script: string, input: unknown, activeId?: string, durableResult = false, cleanupSpaceReceipt = false): Promise<Record<string, unknown>> {
		if (!this.executable) { throw new EgoBrowserCaptureError('Ego Browser CLI was not found. Install it or configure its absolute executable path.'); }
		const directory = await mkdtemp(join(tmpdir(), 'bugfixer-ego-e2e-'));
		try {
			const inputPath = join(directory, 'request.json');
			const receiptPath = join(directory, 'receipt.json');
			await writeFile(inputPath, JSON.stringify(input), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			const source = script.replaceAll(inputMarker, JSON.stringify(inputPath)).replaceAll(receiptMarker, JSON.stringify(receiptPath));
			return await new Promise((resolve, reject) => {
				const child = spawn(this.executable!, ['nodejs', '-e', source], { cwd: process.cwd(), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: [dirname(this.executable!), '/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/bin'].join(':'), HOME: homedir(), USER: userInfo().username, TMPDIR: tmpdir(), ...(process.env.LANG ? { LANG: process.env.LANG } : {}) } });
				this.children.add(child);
				if (activeId) { this.active.set(activeId, child); }
				let output = ''; let diagnostics = ''; let outputBytes = 0; let settled = false;
				const terminate = async (): Promise<void> => { await this.terminateChild(child); };
				const failAfterStop = (message: string): void => { void terminate().then(
					() => { if (!settled) { settled = true; reject(new EgoBrowserCaptureError(message)); } },
					error => { if (!settled) { settled = true; reject(new EgoBrowserCaptureError(`${message} Process termination failed: ${error instanceof Error ? error.message : String(error)}`)); } },
				); };
				const timer = setTimeout(() => failAfterStop('Ego Browser operation timed out.'), operationTimeout);
				const collect = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
					outputBytes += chunk.byteLength;
					if (outputBytes > maxOutput) { failAfterStop('Ego Browser returned too much data.'); return; }
					if (stream === 'stdout') { output += chunk.toString('utf8'); }
					else { diagnostics += chunk.toString('utf8'); }
				};
				child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
				child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
				child.once('error', () => { this.children.delete(child); if (!settled) { settled = true; clearTimeout(timer); reject(new EgoBrowserCaptureError('Ego Browser CLI could not be started.')); } });
				child.once('close', code => {
					void (async () => {
						try { await this.terminateChild(child); }
						catch (error) { if (!settled) { settled = true; clearTimeout(timer); reject(new EgoBrowserCaptureError(`Ego Browser process-group cleanup failed: ${error instanceof Error ? error.message : String(error)}`)); } return; }
						this.children.delete(child);
						if (activeId) { this.active.delete(activeId); }
						if (settled) { return; } settled = true; clearTimeout(timer);
						// Ego's nodejs command writes script output to stderr on macOS.
						const line = [...output.split('\n'), ...diagnostics.split('\n')].findLast(value => value.includes(marker));
						let parsed: Record<string, unknown> | undefined;
						if (line) { try { parsed = JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as Record<string, unknown>; } catch { /* Use the durable receipt when the marker is malformed. */ } }
						let receipt: Record<string, unknown> | undefined;
						if (!parsed) {
							try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>; }
							catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { reject(new EgoBrowserCaptureError('Ego Browser receipt could not be read.')); return; } }
							parsed = receipt;
						}
						if (code !== 0 && cleanupSpaceReceipt && typeof parsed?.spaceId === 'number' && Number.isSafeInteger(parsed.spaceId) && parsed.spaceId > 0) {
							try {
								const closed = await this.invoke(`
const emit = value => process.stdout.write('${marker}' + JSON.stringify(value) + '\\n');
try { const task = await takeOverTaskSpace(${parsed.spaceId}); await task.finish({ keep: [] }); emit({ ok: true, cleanupConfirmed: true }); }
catch (error) { emit({ ok: false, cleanupConfirmed: false, failure: error instanceof Error ? error.message.slice(0, 512) : 'Exact task-space cleanup failed.' }); process.exitCode = 2; }
`, { spaceId: parsed.spaceId });
								if (closed.cleanupConfirmed !== true) { throw new Error(typeof closed.failure === 'string' ? closed.failure : 'Ego did not confirm task-space cleanup.'); }
							} catch (error) { reject(new EgoBrowserCaptureError(`Ego CLI failed after creating task space ${parsed.spaceId}; cleanup was not verified: ${error instanceof Error ? error.message : String(error)}`)); return; }
							reject(new EgoBrowserCaptureError(`Ego CLI failed after creating task space ${parsed.spaceId}; the space was closed successfully.`)); return;
						}
						if (!parsed) { reject(new EgoBrowserCaptureError(code === 0 ? 'Ego Browser returned no result.' : 'Ego Browser operation failed.')); return; }
						if (code !== 0 && parsed.cleanupFailed !== true && parsed.cleanupConfirmed !== true && !receipt) { reject(new EgoBrowserCaptureError('Ego Browser operation failed.')); return; }
						resolve(parsed);
					})();
				});
			});
		} finally { await rm(directory, { recursive: true, force: true }); }
	}
}
