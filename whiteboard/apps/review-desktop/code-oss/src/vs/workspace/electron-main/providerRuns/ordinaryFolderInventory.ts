/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
const maximumEntries = 50000;
const maximumChangedEntries = 300;

interface InventoryEntry {
	readonly path: string;
	readonly kind: 'file' | 'directory' | 'symlink' | 'special';
	readonly size?: number;
	readonly sha256?: string;
	readonly target?: string;
}

export interface InventorySnapshot {
	readonly entries: readonly InventoryEntry[];
	readonly entryCount: number;
	readonly fileBytes: number;
}

export interface InventoryCaptureOptions {
	readonly signal: AbortSignal;
	readonly timeoutMs?: number;
	readonly onSpawn?: (pid: number) => void;
}

export interface OrdinaryFolderChangeReport {
	readonly status: 'observed' | 'unverified';
	readonly summary: string;
	readonly changes: readonly { readonly path: string; readonly change: 'created' | 'modified' | 'deleted' | 'symlink changed' | 'type changed'; readonly before?: string; readonly after?: string }[];
	readonly truncated: boolean;
}

export async function captureOrdinaryFolderInventory(helper: string, root: string, dev: string, ino: string, options: InventoryCaptureOptions): Promise<InventorySnapshot> {
	const stdout = await runInventoryHelper(helper, ['--root', root, '--dev', dev, '--ino', ino, 'inventory'], options);
	const parsed = JSON.parse(stdout) as InventorySnapshot;
	if (!Array.isArray(parsed.entries) || parsed.entries.length !== parsed.entryCount || parsed.entryCount > maximumEntries) { throw new Error('Inventory output failed validation.'); }
	return parsed;
}

export function compareOrdinaryFolderInventories(before: InventorySnapshot, after: InventorySnapshot): OrdinaryFolderChangeReport {
	const left = new Map(before.entries.map(entry => [entry.path, entry]));
	const right = new Map(after.entries.map(entry => [entry.path, entry]));
	const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
	const changes: OrdinaryFolderChangeReport['changes'][number][] = [];
	let total = 0;
	let reportLimitReached = false;
	for (const path of paths) {
		const oldEntry = left.get(path);
		const newEntry = right.get(path);
		let change: OrdinaryFolderChangeReport['changes'][number]['change'] | undefined;
		if (!oldEntry) { change = 'created'; }
		else if (!newEntry) { change = 'deleted'; }
		else if (oldEntry.kind !== newEntry.kind) { change = 'type changed'; }
		else if (oldEntry.kind === 'file' && (oldEntry.sha256 !== newEntry.sha256 || oldEntry.size !== newEntry.size)) { change = 'modified'; }
		else if (oldEntry.kind === 'symlink' && oldEntry.target !== newEntry.target) { change = 'symlink changed'; }
		if (!change) { continue; }
		total++;
		if (!reportLimitReached && changes.length < maximumChangedEntries) {
			const item = { path, change, ...(oldEntry ? { before: oldEntry.kind === 'file' ? oldEntry.sha256 : oldEntry.kind === 'symlink' ? `link:${oldEntry.target}` : oldEntry.kind } : {}), ...(newEntry ? { after: newEntry.kind === 'file' ? newEntry.sha256 : newEntry.kind === 'symlink' ? `link:${newEntry.target}` : newEntry.kind } : {}) } as OrdinaryFolderChangeReport['changes'][number];
			changes.push(item);
			if (Buffer.byteLength(JSON.stringify({ status: 'observed', summary: `${total} changed paths observed.`, changes, truncated: true }), 'utf8') > 60 * 1024) { changes.pop(); reportLimitReached = true; }
		}
	}
	return { status: 'observed', summary: `${total} changed path${total === 1 ? '' : 's'} observed.`, changes, truncated: total > changes.length };
}

function runInventoryHelper(helper: string, args: readonly string[], options: InventoryCaptureOptions): Promise<string> {
	if (options.signal.aborted) { return Promise.reject(new Error('Inventory cancelled before helper launch.')); }
	return new Promise((resolve, reject) => {
		let child: ChildProcessByStdio<null, Readable, Readable>;
		try { child = spawn(helper, [...args], { stdio: ['ignore', 'pipe', 'pipe'] }); }
		catch (error) { reject(error); return; }
		if (child.pid) { options.onSpawn?.(child.pid); }
		const output: Buffer[] = [];
		const errors: Buffer[] = [];
		let errorBytes = 0;
		let outputBytes = 0;
		let failure: Error | undefined;
		let terminating = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0 ? Math.min(options.timeoutMs!, 60000) : 15000;
		const stop = (reason: Error) => {
			if (failure) { return; }
			failure = reason;
			terminating = true;
			child.kill('SIGTERM');
			killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); } }, 1000);
		};
		const timeout = setTimeout(() => stop(new Error(`Inventory helper exceeded ${timeoutMs} ms.`)), timeoutMs);
		const abort = () => stop(new Error('Inventory cancelled.'));
		options.signal.addEventListener('abort', abort, { once: true });
		child.stdout.on('data', chunk => {
			outputBytes += chunk.length;
			if (outputBytes > 64 * 1024 * 1024) { stop(new Error('Inventory output exceeded the 64 MB limit.')); return; }
			output.push(Buffer.from(chunk));
		});
		child.stderr.on('data', chunk => { if (errorBytes < 8192) { const kept = Buffer.from(chunk).subarray(0, 8192 - errorBytes); errors.push(kept); errorBytes += kept.length; } });
		child.once('error', error => { failure ??= error; });
		child.once('close', (code, signal) => {
			clearTimeout(timeout);
			if (killTimer) { clearTimeout(killTimer); }
			options.signal.removeEventListener('abort', abort);
			if (failure) { reject(failure); return; }
			if (code !== 0) { reject(new Error(`Inventory helper failed (${code ?? signal ?? 'unknown'}): ${Buffer.concat(errors).toString('utf8').trim().slice(0, 1000)}`)); return; }
			if (terminating) { reject(new Error('Inventory helper stopped unexpectedly.')); return; }
			resolve(Buffer.concat(output).toString('utf8'));
		});
	});
}

export function unverifiedOrdinaryFolderChanges(reason: unknown): OrdinaryFolderChangeReport {
	const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Inventory could not be verified.';
	return { status: 'unverified', summary: `Changes unverified: ${message.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').slice(0, 300)}`, changes: [], truncated: false };
}

export function parseOrdinaryFolderChangeReport(value: unknown): OrdinaryFolderChangeReport | null {
	if (typeof value !== 'string') { return null; }
	try {
		const report = JSON.parse(value) as OrdinaryFolderChangeReport;
		return (report.status === 'observed' || report.status === 'unverified') && typeof report.summary === 'string' && Array.isArray(report.changes) ? report : null;
	} catch { return null; }
}
