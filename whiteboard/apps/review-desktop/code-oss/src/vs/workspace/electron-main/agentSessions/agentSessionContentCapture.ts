/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

export const AGENT_SESSION_MAX_INVENTORY_ENTRIES = 50_000;
export const AGENT_SESSION_MAX_CONTENT_FILES = 300;
export const AGENT_SESSION_MAX_FILE_BYTES = 1024 * 1024;
export const AGENT_SESSION_MAX_RETAINED_TEXT_BYTES = 8 * 1024 * 1024;
export const AGENT_SESSION_MAX_CHANGED_FILES = 300;
const maximumPathBytes = 4096;
const maximumInventoryOutputBytes = 64 * 1024 * 1024;
const maximumErrorBytes = 8192;

export interface AgentSessionContentRootIdentity {
	readonly canonicalPath: string;
	readonly dev: string;
	readonly ino: string;
}

export type AgentSessionContentFileKind = 'file' | 'directory' | 'symlink' | 'special';
export type AgentSessionContentUnavailableReason = 'binary' | 'invalidUtf8' | 'fileTooLarge' | 'contentFileLimit' | 'retainedTextLimit';

export interface AgentSessionContentFile {
	readonly path: string;
	readonly kind: AgentSessionContentFileKind;
	readonly size?: number;
	readonly sha256?: string;
	readonly target?: string;
	/** Strict UTF-8 text copied from native-helper output before the provider starts. */
	readonly content?: string;
	readonly contentUnavailableReason?: AgentSessionContentUnavailableReason;
}

export interface AgentSessionContentSnapshot {
	readonly schemaVersion: 1;
	readonly folderIdentity: AgentSessionContentRootIdentity;
	readonly capturedAt: string;
	readonly inventoryCoverage: 'complete';
	readonly contentCoverage: 'complete' | 'partial';
	readonly entryCount: number;
	readonly fileBytes: number;
	readonly retainedTextBytes: number;
	readonly contentReadCount: number;
	readonly entries: readonly AgentSessionContentFile[];
}

export interface AgentSessionContentCaptureOptions {
	readonly signal: AbortSignal;
	/** Total wall-clock budget across inventory and all content reads. Defaults to 60 seconds. */
	readonly timeoutMs?: number;
	readonly onSpawn?: (pid: number) => void;
}

export interface AgentSessionContentCaptureCleanupRecovery {
	readonly pid: number | undefined;
	retryCleanup(): Promise<boolean>;
}

/** Cleanup could not yet be confirmed; retain and retry this exact child before releasing its workspace. */
export class AgentSessionContentCaptureCleanupError extends Error {
	constructor(readonly recovery: AgentSessionContentCaptureCleanupRecovery, readonly stopReason: Error) {
		super(`Native helper cleanup is uncertain (pid ${recovery.pid ?? 'unknown'}): ${stopReason.message}`);
		this.name = 'AgentSessionContentCaptureCleanupError';
	}
}

export type AgentSessionContentChangeKind = 'created' | 'modified' | 'deleted' | 'typeChanged' | 'symlinkChanged';

export interface AgentSessionContentChange {
	readonly path: string;
	readonly change: AgentSessionContentChangeKind;
	readonly before: Omit<AgentSessionContentFile, 'content'> | null;
	readonly after: Omit<AgentSessionContentFile, 'content'> | null;
}

export interface AgentSessionContentChangeResult {
	readonly status: 'observed';
	readonly inventoryCoverage: 'complete';
	readonly contentCoverage: 'complete' | 'partial';
	readonly changedCount: number;
	readonly truncated: boolean;
	readonly changes: readonly AgentSessionContentChange[];
}

interface NativeInventoryEntry {
	readonly path: string;
	readonly kind: AgentSessionContentFileKind;
	readonly size?: number;
	readonly sha256?: string;
	readonly target?: string;
}

interface NativeInventory {
	readonly entries: readonly NativeInventoryEntry[];
	readonly entryCount: number;
	readonly fileBytes: number;
}

/** Captures metadata and bounded text through the root-bound native helper only. */
export async function captureAgentSessionContentSnapshot(helper: string, folderIdentity: AgentSessionContentRootIdentity, options: AgentSessionContentCaptureOptions): Promise<AgentSessionContentSnapshot> {
	validateFolderIdentity(folderIdentity);
	const rootIdentity = Object.freeze({ ...folderIdentity });
	const deadline = Date.now() + normalizeTimeout(options.timeoutMs);
	const args = ['--root', rootIdentity.canonicalPath, '--dev', rootIdentity.dev, '--ino', rootIdentity.ino];
	const inventoryOutput = await runBoundedHelper(helper, [...args, 'inventory'], options, deadline, maximumInventoryOutputBytes);
	let inventoryText: string;
	try { inventoryText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(inventoryOutput); }
	catch { throw new Error('Native folder inventory was not valid UTF-8.'); }
	const inventory = parseNativeInventory(inventoryText);
	let contentReadCount = 0;
	let retainedTextBytes = 0;
	let hasMissingContent = false;
	const entries: AgentSessionContentFile[] = [];

	for (const entry of inventory.entries) {
		if (entry.kind !== 'file') {
			entries.push(Object.freeze({ ...entry }));
			continue;
		}
		if (entry.size! > AGENT_SESSION_MAX_FILE_BYTES) {
			hasMissingContent = true;
			entries.push(Object.freeze({ ...entry, contentUnavailableReason: 'fileTooLarge' }));
			continue;
		}
		if (contentReadCount >= AGENT_SESSION_MAX_CONTENT_FILES) {
			hasMissingContent = true;
			entries.push(Object.freeze({ ...entry, contentUnavailableReason: 'contentFileLimit' }));
			continue;
		}
		if (retainedTextBytes >= AGENT_SESSION_MAX_RETAINED_TEXT_BYTES) {
			hasMissingContent = true;
			entries.push(Object.freeze({ ...entry, contentUnavailableReason: 'retainedTextLimit' }));
			continue;
		}

		contentReadCount++;
		const bytes = await runBoundedHelper(helper, [...args, 'read', entry.path], options, deadline, AGENT_SESSION_MAX_FILE_BYTES + 1);
		if (sha256(bytes) !== entry.sha256 || bytes.byteLength !== entry.size) {
			throw new Error(`Native content for ${entry.path} did not match its inventory metadata.`);
		}
		if (bytes.includes(0)) {
			hasMissingContent = true;
			entries.push(Object.freeze({ ...entry, contentUnavailableReason: 'binary' }));
			continue;
		}
		let content: string;
		try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
		catch (error) {
			if (!(error instanceof TypeError)) { throw error; }
			hasMissingContent = true;
			entries.push(Object.freeze({ ...entry, contentUnavailableReason: 'invalidUtf8' }));
			continue;
		}
		const textBytes = Buffer.byteLength(content, 'utf8');
		if (retainedTextBytes + textBytes > AGENT_SESSION_MAX_RETAINED_TEXT_BYTES) {
			hasMissingContent = true;
			entries.push(Object.freeze({ ...entry, contentUnavailableReason: 'retainedTextLimit' }));
			continue;
		}
		retainedTextBytes += textBytes;
		entries.push(Object.freeze({ ...entry, content }));
	}

	return validateAgentSessionContentSnapshot({
		schemaVersion: 1,
		folderIdentity: rootIdentity,
		capturedAt: new Date().toISOString(),
		inventoryCoverage: 'complete',
		contentCoverage: hasMissingContent ? 'partial' : 'complete',
		entryCount: inventory.entryCount,
		fileBytes: inventory.fileBytes,
		retainedTextBytes,
		contentReadCount,
		entries,
	});
}

/** Validates and freezes a serialized snapshot before persistence or after a database read. */
export function validateAgentSessionContentSnapshot(value: unknown): AgentSessionContentSnapshot {
	if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'folderIdentity', 'capturedAt', 'inventoryCoverage', 'contentCoverage', 'entryCount', 'fileBytes', 'retainedTextBytes', 'contentReadCount', 'entries'])
		|| value.schemaVersion !== 1 || value.inventoryCoverage !== 'complete' || (value.contentCoverage !== 'complete' && value.contentCoverage !== 'partial')
		|| typeof value.capturedAt !== 'string' || !isCanonicalTimestamp(value.capturedAt) || !isRecord(value.folderIdentity)
		|| !hasExactKeys(value.folderIdentity, ['canonicalPath', 'dev', 'ino']) || typeof value.folderIdentity.canonicalPath !== 'string'
		|| typeof value.folderIdentity.dev !== 'string' || typeof value.folderIdentity.ino !== 'string' || !Array.isArray(value.entries)) {
		throw new Error('Agent-session content snapshot has an invalid shape.');
	}
	const folderIdentity = { canonicalPath: value.folderIdentity.canonicalPath, dev: value.folderIdentity.dev, ino: value.folderIdentity.ino };
	validateFolderIdentity(folderIdentity);
	if (folderIdentity.canonicalPath.length > maximumPathBytes || !Number.isSafeInteger(value.entryCount) || (value.entryCount as number) < 0 || (value.entryCount as number) > AGENT_SESSION_MAX_INVENTORY_ENTRIES
		|| value.entries.length !== value.entryCount || !Number.isSafeInteger(value.fileBytes) || (value.fileBytes as number) < 0 || (value.fileBytes as number) > 2 * 1024 * 1024 * 1024
		|| !Number.isSafeInteger(value.retainedTextBytes) || (value.retainedTextBytes as number) < 0 || (value.retainedTextBytes as number) > AGENT_SESSION_MAX_RETAINED_TEXT_BYTES
		|| !Number.isSafeInteger(value.contentReadCount) || (value.contentReadCount as number) < 0 || (value.contentReadCount as number) > AGENT_SESSION_MAX_CONTENT_FILES) {
		throw new Error('Agent-session content snapshot exceeds its inventory or retention bounds.');
	}
	let fileBytes = 0;
	let retainedTextBytes = 0;
	let hasMissingContent = false;
	let contentFiles = 0;
	let minimumContentReads = 0;
	let eligibleContentFiles = 0;
	let serializedBytes = Buffer.byteLength('{"schemaVersion":1,"folderIdentity":', 'utf8')
		+ Buffer.byteLength(JSON.stringify(folderIdentity), 'utf8') + Buffer.byteLength(`,"capturedAt":${JSON.stringify(value.capturedAt)},"inventoryCoverage":"complete","contentCoverage":${JSON.stringify(value.contentCoverage)},"entryCount":${value.entryCount},"fileBytes":${value.fileBytes},"retainedTextBytes":${value.retainedTextBytes},"contentReadCount":${value.contentReadCount},"entries":[`, 'utf8') + 1;
	const entries: AgentSessionContentFile[] = [];
	let previousPath: string | undefined;
	for (const candidate of value.entries) {
		if (!isRecord(candidate) || typeof candidate.path !== 'string' || !isSafeRelativePath(candidate.path) || (previousPath !== undefined && compareCodeUnits(previousPath, candidate.path) >= 0)) {
			throw new Error('Agent-session content snapshot paths are unsafe, duplicated, or unordered.');
		}
		previousPath = candidate.path;
		let entry: AgentSessionContentFile;
		if (candidate.kind === 'file') {
			contentFiles++;
			if (typeof candidate.size !== 'number' || !Number.isSafeInteger(candidate.size) || candidate.size < 0 || candidate.size > 128 * 1024 * 1024
				|| typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.sha256)) {
				throw new Error(`Agent-session content metadata is invalid for ${candidate.path}.`);
			}
			fileBytes += candidate.size;
			if (!Number.isSafeInteger(fileBytes) || fileBytes > 2 * 1024 * 1024 * 1024) { throw new Error('Agent-session content byte total exceeds its bound.'); }
			if (candidate.size <= AGENT_SESSION_MAX_FILE_BYTES && candidate.contentUnavailableReason !== 'contentFileLimit') { eligibleContentFiles++; }
			if (typeof candidate.content === 'string' && !Object.hasOwn(candidate, 'contentUnavailableReason') && hasExactKeys(candidate, ['path', 'kind', 'size', 'sha256', 'content'])) {
				const textBytes = Buffer.byteLength(candidate.content, 'utf8');
				if (textBytes > AGENT_SESSION_MAX_FILE_BYTES || candidate.content.includes('\0') || !isRoundTripUtf8(candidate.content) || textBytes !== candidate.size
					|| sha256(Buffer.from(candidate.content, 'utf8')) !== candidate.sha256) {
					throw new Error(`Agent-session text content is invalid for ${candidate.path}.`);
				}
				retainedTextBytes += textBytes;
				if (retainedTextBytes > AGENT_SESSION_MAX_RETAINED_TEXT_BYTES) { throw new Error('Agent-session retained text exceeds its bound.'); }
				minimumContentReads++;
				entry = { path: candidate.path, kind: 'file', size: candidate.size, sha256: candidate.sha256, content: candidate.content };
			} else if (typeof candidate.contentUnavailableReason === 'string' && Object.hasOwn(candidate, 'contentUnavailableReason') && !Object.hasOwn(candidate, 'content')
				&& hasExactKeys(candidate, ['path', 'kind', 'size', 'sha256', 'contentUnavailableReason']) && isContentUnavailableReason(candidate.contentUnavailableReason)) {
				if (candidate.contentUnavailableReason === 'fileTooLarge' && candidate.size <= AGENT_SESSION_MAX_FILE_BYTES) { throw new Error(`Agent-session file-size reason is inconsistent for ${candidate.path}.`); }
				if (candidate.contentUnavailableReason !== 'fileTooLarge' && candidate.size > AGENT_SESSION_MAX_FILE_BYTES) { throw new Error(`Agent-session text reason is inconsistent for ${candidate.path}.`); }
				if (candidate.contentUnavailableReason === 'binary' || candidate.contentUnavailableReason === 'invalidUtf8') { minimumContentReads++; }
				hasMissingContent = true;
				entry = { path: candidate.path, kind: 'file', size: candidate.size, sha256: candidate.sha256, contentUnavailableReason: candidate.contentUnavailableReason };
			} else { throw new Error(`Agent-session content state is invalid for ${candidate.path}.`); }
		} else if (candidate.kind === 'symlink' && typeof candidate.target === 'string' && Buffer.byteLength(candidate.target, 'utf8') <= maximumPathBytes && hasExactKeys(candidate, ['path', 'kind', 'target'])) {
			entry = { path: candidate.path, kind: 'symlink', target: candidate.target };
		} else if ((candidate.kind === 'directory' || candidate.kind === 'special') && hasExactKeys(candidate, ['path', 'kind'])) {
			entry = { path: candidate.path, kind: candidate.kind };
		} else { throw new Error(`Agent-session inventory entry is invalid for ${candidate.path}.`); }
		serializedBytes += Buffer.byteLength(JSON.stringify(entry), 'utf8') + (entries.length ? 1 : 0);
		if (serializedBytes > 64 * 1024 * 1024) { throw new Error('Agent-session content snapshot exceeds 64 MiB serialized.'); }
		entries.push(Object.freeze(entry));
	}
	if (fileBytes !== value.fileBytes || retainedTextBytes !== value.retainedTextBytes
		|| (hasMissingContent ? 'partial' : 'complete') !== value.contentCoverage
		|| contentFiles < (value.contentReadCount as number) || eligibleContentFiles < (value.contentReadCount as number)
		|| minimumContentReads > (value.contentReadCount as number) || minimumContentReads > AGENT_SESSION_MAX_CONTENT_FILES) {
		throw new Error('Agent-session content snapshot accounting does not match its entries.');
	}
	const snapshot: AgentSessionContentSnapshot = {
		schemaVersion: 1, folderIdentity: Object.freeze(folderIdentity), capturedAt: value.capturedAt,
		inventoryCoverage: 'complete', contentCoverage: value.contentCoverage, entryCount: value.entryCount as number,
		fileBytes, retainedTextBytes, contentReadCount: value.contentReadCount as number, entries: Object.freeze(entries),
	};
	if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 64 * 1024 * 1024) { throw new Error('Agent-session content snapshot exceeds 64 MiB serialized.'); }
	return Object.freeze(snapshot);
}

/** Compares complete native inventories. Text availability never changes metadata conclusions. */
export function compareAgentSessionContentSnapshots(before: AgentSessionContentSnapshot, after: AgentSessionContentSnapshot): AgentSessionContentChangeResult {
	if (!sameFolderIdentity(before.folderIdentity, after.folderIdentity)) { throw new Error('Content snapshots belong to different bound folders.'); }
	const left = new Map(before.entries.map(entry => [entry.path, entry]));
	const right = new Map(after.entries.map(entry => [entry.path, entry]));
	const paths = [...new Set([...left.keys(), ...right.keys()])].sort(compareCodeUnits);
	const changes: AgentSessionContentChange[] = [];
	let changedCount = 0;
	for (const path of paths) {
		const previous = left.get(path);
		const current = right.get(path);
		let change: AgentSessionContentChangeKind | undefined;
		if (!previous) { change = 'created'; }
		else if (!current) { change = 'deleted'; }
		else if (previous.kind !== current.kind) { change = 'typeChanged'; }
		else if (previous.kind === 'file' && (previous.size !== current.size || previous.sha256 !== current.sha256)) { change = 'modified'; }
		else if (previous.kind === 'symlink' && previous.target !== current.target) { change = 'symlinkChanged'; }
		if (!change) { continue; }
		changedCount++;
		if (changes.length < AGENT_SESSION_MAX_CHANGED_FILES) {
			changes.push(Object.freeze({ path, change, before: metadataOnly(previous), after: metadataOnly(current) }));
		}
	}
	return Object.freeze({
		status: 'observed',
		inventoryCoverage: 'complete',
		contentCoverage: before.contentCoverage === 'complete' && after.contentCoverage === 'complete' ? 'complete' : 'partial',
		changedCount,
		truncated: changedCount > changes.length,
		changes: Object.freeze(changes),
	});
}

function parseNativeInventory(text: string): NativeInventory {
	let value: unknown;
	try { value = JSON.parse(text); }
	catch { throw new Error('Native folder inventory returned invalid JSON.'); }
	if (!isRecord(value) || !hasExactKeys(value, ['entries', 'entryCount', 'fileBytes']) || typeof value.entryCount !== 'number' || !Number.isSafeInteger(value.entryCount) || value.entryCount < 0 || value.entryCount > AGENT_SESSION_MAX_INVENTORY_ENTRIES
		|| typeof value.fileBytes !== 'number' || !Number.isSafeInteger(value.fileBytes) || value.fileBytes < 0 || value.fileBytes > 2 * 1024 * 1024 * 1024 || !Array.isArray(value.entries) || value.entries.length !== value.entryCount) {
		throw new Error('Native folder inventory failed count or size validation.');
	}
	const seen = new Set<string>();
	let fileBytes = 0;
	const entries: NativeInventoryEntry[] = [];
	for (const candidate of value.entries) {
		if (!isRecord(candidate) || typeof candidate.path !== 'string' || !isSafeRelativePath(candidate.path) || seen.has(candidate.path)) {
			throw new Error('Native folder inventory contains an invalid or duplicate path.');
		}
		seen.add(candidate.path);
		if (candidate.kind === 'file') {
			if (!hasExactKeys(candidate, ['path', 'kind', 'size', 'sha256']) || typeof candidate.size !== 'number' || !Number.isSafeInteger(candidate.size) || candidate.size < 0 || candidate.size > 128 * 1024 * 1024 || typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.sha256)) {
				throw new Error(`Native folder inventory metadata is invalid for ${candidate.path}.`);
			}
			fileBytes += candidate.size;
			if (!Number.isSafeInteger(fileBytes)) { throw new Error('Native folder inventory byte total is invalid.'); }
			entries.push({ path: candidate.path, kind: 'file', size: candidate.size, sha256: candidate.sha256 });
		} else if (candidate.kind === 'symlink') {
			if (!hasExactKeys(candidate, ['path', 'kind', 'target']) || typeof candidate.target !== 'string' || Buffer.byteLength(candidate.target, 'utf8') > maximumPathBytes) { throw new Error(`Native symlink metadata is invalid for ${candidate.path}.`); }
			entries.push({ path: candidate.path, kind: 'symlink', target: candidate.target });
		} else if (candidate.kind === 'directory' || candidate.kind === 'special') {
			if (!hasExactKeys(candidate, ['path', 'kind'])) { throw new Error(`Native folder inventory has unexpected metadata for ${candidate.path}.`); }
			entries.push({ path: candidate.path, kind: candidate.kind });
		} else { throw new Error(`Native folder inventory has an unsupported kind for ${candidate.path}.`); }
	}
	if (fileBytes !== value.fileBytes) { throw new Error('Native folder inventory byte total does not match its entries.'); }
	entries.sort((left, right) => compareCodeUnits(left.path, right.path));
	return { entries, entryCount: value.entryCount, fileBytes };
}

function runBoundedHelper(helper: string, args: readonly string[], options: AgentSessionContentCaptureOptions, deadline: number, outputLimit: number): Promise<Buffer> {
	if (options.signal.aborted) { return Promise.reject(new Error('Content capture cancelled before native helper launch.')); }
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) { return Promise.reject(new Error('Content capture exceeded its total deadline.')); }
	return new Promise((resolve, reject) => {
		let child: ChildProcessByStdio<null, Readable, Readable>;
		try { child = spawn(helper, [...args], { stdio: ['ignore', 'pipe', 'pipe'] }); }
		catch (error) { reject(error); return; }
		let closed = false;
		let outerSettled = false;
		let stopReason: Error | undefined;
		let terminationStarted = false;
		let recoveryAttempt: Promise<boolean> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const releaseCaptureHooks = () => {
			if (timeout) { clearTimeout(timeout); }
			options.signal.removeEventListener('abort', abort);
		};
		const waitForClose = (milliseconds: number): Promise<boolean> => new Promise(resolveCloseWithin => {
			if (closed) { resolveCloseWithin(true); return; }
			const onClose = () => {
				clearTimeout(timer);
				resolveCloseWithin(true);
			};
			const timer = setTimeout(() => {
				child.off('close', onClose);
				resolveCloseWithin(closed);
			}, milliseconds);
			child.once('close', onClose);
		});
		let signalFailure: Error | undefined;
		const signalIfRunning = (signal: NodeJS.Signals): void => {
			if (closed || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) { return; }
			try {
				if (!child.kill(signal)) { signalFailure = new Error(`Could not send ${signal} to native helper pid ${child.pid}.`); }
			} catch (error) { signalFailure = error instanceof Error ? error : new Error(String(error)); }
		};
		const terminateAndAwait = async (): Promise<boolean> => {
			if (closed) { return true; }
			signalIfRunning('SIGTERM');
			if (await waitForClose(500)) { return true; }
			signalIfRunning('SIGKILL');
			return waitForClose(1000);
		};
		const recovery: AgentSessionContentCaptureCleanupRecovery = Object.freeze({
			pid: child.pid,
			retryCleanup: () => {
				if (closed) { return Promise.resolve(true); }
				if (!recoveryAttempt) {
					recoveryAttempt = terminateAndAwait().finally(() => { recoveryAttempt = undefined; });
				}
				return recoveryAttempt;
			},
		});
		function abort(): void { requestStop(new Error('Content capture cancelled.')); }
		const reportUncertainCleanup = () => {
			if (closed || outerSettled) { return; }
			outerSettled = true;
			releaseCaptureHooks();
			const reason = stopReason ?? new Error('Native helper cleanup could not be confirmed.');
			reject(new AgentSessionContentCaptureCleanupError(recovery, signalFailure ? new Error(`${reason.message} ${signalFailure.message}`) : reason));
		};
		function requestStop(reason: Error): void {
			stopReason ??= reason;
			if (terminationStarted) { return; }
			terminationStarted = true;
			stdout.length = 0;
			stderr.length = 0;
			void terminateAndAwait().then(cleaned => {
				if (!cleaned) { reportUncertainCleanup(); }
				else if (!closed && !outerSettled) { outerSettled = true; releaseCaptureHooks(); reject(stopReason); }
			});
		}
		timeout = setTimeout(() => requestStop(new Error('Content capture exceeded its total deadline.')), remainingMs);
		options.signal.addEventListener('abort', abort, { once: true });
		if (options.signal.aborted) { abort(); }
		child.stdout.on('data', chunk => {
			if (stopReason || outerSettled) { return; }
			stdoutBytes += chunk.length;
			if (stdoutBytes > outputLimit) { requestStop(new Error('Native helper output exceeded its capture limit.')); return; }
			stdout.push(Buffer.from(chunk));
		});
		child.stderr.on('data', chunk => {
			if (stopReason || outerSettled) { return; }
			if (stderrBytes >= maximumErrorBytes) { return; }
			const kept = Buffer.from(chunk).subarray(0, maximumErrorBytes - stderrBytes);
			stderr.push(kept);
			stderrBytes += kept.length;
		});
		child.once('error', error => { requestStop(error); });
		child.once('close', (code, signal) => {
			closed = true;
			releaseCaptureHooks();
			if (outerSettled) { return; }
			outerSettled = true;
			if (stopReason) { reject(stopReason); return; }
			if (code !== 0) { reject(new Error(`Native helper failed (${code ?? signal ?? 'unknown'}): ${Buffer.concat(stderr).toString('utf8').trim().slice(0, 1000)}`)); return; }
			resolve(Buffer.concat(stdout));
		});
		if (child.pid) {
			try { options.onSpawn?.(child.pid); }
			catch (error) { requestStop(new Error(`Could not record native helper pid: ${error instanceof Error ? error.message : String(error)}`)); }
		}
	});
}

function validateFolderIdentity(identity: AgentSessionContentRootIdentity): void {
	if (!identity || typeof identity.canonicalPath !== 'string' || !identity.canonicalPath.startsWith('/') || identity.canonicalPath.includes('\\') || identity.canonicalPath.includes('\0')
		|| !/^\d+$/u.test(identity.dev) || !/^\d+$/u.test(identity.ino)) {
		throw new Error('A canonical bound-folder identity is required for content capture.');
	}
}

function isSafeRelativePath(value: string): boolean {
	if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximumPathBytes) { return false; }
	return value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function sameFolderIdentity(left: AgentSessionContentRootIdentity, right: AgentSessionContentRootIdentity): boolean {
	return left.canonicalPath === right.canonicalPath && left.dev === right.dev && left.ino === right.ino;
}

function metadataOnly(file: AgentSessionContentFile | undefined): Omit<AgentSessionContentFile, 'content'> | null {
	if (!file) { return null; }
	const { content: _content, ...metadata } = file;
	return Object.freeze(metadata);
}

function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function isContentUnavailableReason(value: string): value is AgentSessionContentUnavailableReason { return value === 'binary' || value === 'invalidUtf8' || value === 'fileTooLarge' || value === 'contentFileLimit' || value === 'retainedTextLimit'; }
function isRoundTripUtf8(value: string): boolean { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(value, 'utf8')) === value; }
function normalizeTimeout(value: number | undefined): number { return Number.isFinite(value) && (value ?? 0) > 0 ? Math.min(Math.floor(value!), 60_000) : 60_000; }
