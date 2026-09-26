/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { join, relative, sep } from 'node:path';

export class WriterLockCancelledError extends Error {
	constructor() { super('The task run was cancelled while waiting for its folder.'); }
}

interface Waiter {
	readonly path: string | null;
	readonly signal: AbortSignal | undefined;
	readonly resolve: (lease: TaskFolderWriterLease) => void;
	readonly reject: (error: Error) => void;
	abortListener?: () => void;
}

export class TaskFolderWriterLease {
	private released = false;
	private attachProviderProcess: ((pgid: number) => Promise<void>) | undefined;
	private subscribeToLost: ((callback: () => void) => { dispose(): void }) | undefined;
	constructor(private readonly lock: TaskFolderWriterLock, readonly path: string | null, private readonly hostRelease: () => void, hooks?: { attach: (pgid: number) => Promise<void>; onLost: (callback: () => void) => { dispose(): void } }) {
		this.attachProviderProcess = hooks?.attach;
		this.subscribeToLost = hooks?.onLost;
	}
	onLost(callback: () => void): { dispose(): void } { return this.subscribeToLost?.(callback) ?? { dispose() { } }; }
	attachOwnedProcessGroup(pgid: number): Promise<void> {
		if (this.released || !Number.isSafeInteger(pgid) || pgid <= 0) { throw new Error('Cannot attach an invalid provider process group to this writer lease.'); }
		return this.attachProviderProcess?.(pgid) ?? Promise.reject(new Error('This writer lease cannot attach a provider process group.'));
	}
	release(): void {
		if (!this.released) { this.released = true; this.attachProviderProcess = undefined; this.subscribeToLost = undefined; this.hostRelease(); this.lock.release(this); }
	}
}

/** Fair, process-local writer serialization over canonical folder paths. */
export class TaskFolderWriterLock {
	private readonly held = new Set<TaskFolderWriterLease>();
	private readonly waiters: Waiter[] = [];

	acquire(rootPath: string, signal?: AbortSignal): Promise<TaskFolderWriterLease> {
		if (signal?.aborted) { return Promise.reject(new WriterLockCancelledError()); }
		const canonical = realpathSync(rootPath);
		if (!statSync(canonical).isDirectory()) { return Promise.reject(new Error('The task folder is not a directory.')); }
		return this.enqueue(canonical, signal);
	}

	reserveGlobal(): TaskFolderWriterLease {
		const lease = new TaskFolderWriterLease(this, null, () => undefined);
		this.held.add(lease);
		return lease;
	}

	get hasGlobalReservation(): boolean { return [...this.held].some(lease => lease.path === null); }

	release(lease: TaskFolderWriterLease): void {
		if (this.held.delete(lease)) { this.drain(); }
	}

	private enqueue(path: string, signal?: AbortSignal): Promise<TaskFolderWriterLease> {
		return new Promise((resolve, reject) => {
			const waiter: Waiter = { path, signal, resolve, reject };
			if (signal) {
				waiter.abortListener = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) {
						this.waiters.splice(index, 1);
						signal.removeEventListener('abort', waiter.abortListener!);
						reject(new WriterLockCancelledError());
						this.drain();
					}
				};
				signal.addEventListener('abort', waiter.abortListener, { once: true });
			}
			this.waiters.push(waiter);
			this.drain();
		});
	}

	private drain(): void {
		for (let index = 0; index < this.waiters.length;) {
			const waiter = this.waiters[index];
			if (waiter.signal?.aborted) {
				this.waiters.splice(index, 1);
				waiter.signal.removeEventListener('abort', waiter.abortListener!);
				waiter.reject(new WriterLockCancelledError());
				continue;
			}
			const earlierConflict = this.waiters.slice(0, index).some(earlier => pathsConflict(earlier.path, waiter.path));
			const heldConflict = [...this.held].some(lease => pathsConflict(lease.path, waiter.path));
			if (earlierConflict || heldConflict) { index++; continue; }
			this.waiters.splice(index, 1);
			waiter.signal?.removeEventListener('abort', waiter.abortListener!);
			const lease = new TaskFolderWriterLease(this, waiter.path, () => undefined);
			this.held.add(lease);
			acquireHostWriterLock(waiter.signal).then(hostRelease => {
				if (waiter.signal?.aborted) {
					hostRelease.release();
					this.held.delete(lease);
					waiter.reject(new WriterLockCancelledError());
					this.drain();
					return;
				}
				const readyLease = new TaskFolderWriterLease(this, waiter.path, hostRelease.release, { attach: hostRelease.attachOwnedProcessGroup, onLost: hostRelease.onLost });
				this.held.delete(lease);
				this.held.add(readyLease);
				waiter.resolve(readyLease);
			}).catch(error => {
				this.held.delete(lease);
				waiter.reject(error instanceof Error ? error : new Error(String(error)));
				this.drain();
			});
		}
	}
}

/**
 * A single macOS-wide advisory lock deliberately serializes all provider writers,
 * including writers whose state roots or selected folders differ. lockf owns the
 * kernel lock; its protected shell emits the marker only after acquisition and
 * watches the owning app process so a crashed app cannot leave a stale lock.
 */
interface HostWriterLease {
	readonly release: () => void;
	readonly attachOwnedProcessGroup: (pgid: number) => Promise<void>;
	readonly onLost: (callback: () => void) => { dispose(): void };
}

interface HostPaths { readonly directory: string; readonly lockPath: string; readonly queuePath: string; readonly sequenceLockPath: string; }

async function acquireHostWriterLock(signal?: AbortSignal): Promise<HostWriterLease> {
	if (platform() !== 'darwin') { throw new Error('Host-wide task writer serialization requires macOS lockf.'); }
	if (signal?.aborted) { throw new WriterLockCancelledError(); }
	const paths = prepareHostPaths();
	const ownerStart = processStartIdentity(process.pid);
	if (!ownerStart) { throw new Error('Unable to identify this application process for the host writer sidecar.'); }
	const ticket = await createQueueTicket(paths.queuePath, paths.sequenceLockPath, ownerStart, signal);
	let child: ChildProcess | undefined;
	let cancelled = false;
	let released = false;
	let lost = false;
	let sidecarClosed = false;
	const lostListeners = new Set<() => void>();
	const notifyLost = () => {
		if (released || lost) { return; }
		lost = true;
		for (const listener of [...lostListeners]) { listener(); }
	};
	try {
		while (!(await isQueueHead(paths.queuePath, ticket))) {
			if (signal?.aborted) { throw new WriterLockCancelledError(); }
			await delay(25, signal);
		}
		const before = ensureHostLockFile(paths.lockPath);
		child = spawn('/usr/bin/lockf', ['-k', paths.lockPath, '/bin/sh', '-c', sidecarScript], { detached: true, env: { ...process.env, TASK_WRITER_LOCK_OWNER: String(process.pid), TASK_WRITER_LOCK_OWNER_START: ownerStart, TASK_WRITER_LOCK_TICKET: join(paths.queuePath, ticket), TASK_WRITER_LOCK_STATE: join(paths.queuePath, `${ticket}.state`), TASK_WRITER_LOCK_ACK: join(paths.queuePath, `${ticket}.ack`) }, stdio: ['ignore', 'pipe', 'pipe'] });
		await new Promise<void>((resolve, reject) => {
			let output = '';
			let settled = false;
			const stop = () => { if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { child?.kill('SIGTERM'); } } } };
			const onAbort = () => { if (!settled) { settled = true; cancelled = true; signal?.removeEventListener('abort', onAbort); stop(); reject(new WriterLockCancelledError()); } };
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) { onAbort(); }
			child!.stdout!.setEncoding('utf8');
			child!.stdout!.on('data', (chunk: string) => {
				output += chunk;
				if (settled || !output.includes('TASK_WRITER_LOCK_ACQUIRED\n')) { return; }
				try {
					const after = ensureHostLockFile(paths.lockPath);
					if (before.dev !== after.dev || before.ino !== after.ino) { throw new Error(`The host writer lock file changed while lockf was acquiring it (${before.dev}:${before.ino} -> ${after.dev}:${after.ino}).`); }
				} catch (error) { settled = true; signal?.removeEventListener('abort', onAbort); stop(); reject(error instanceof Error ? error : new Error(String(error))); return; }
				if (signal?.aborted) { onAbort(); return; }
				settled = true;
				signal?.removeEventListener('abort', onAbort);
				resolve();
			});
			child!.stderr!.resume();
			child!.once('error', error => { if (!settled) { settled = true; signal?.removeEventListener('abort', onAbort); reject(new Error(`Host writer lock process failed: ${error.message}`)); } else { notifyLost(); } });
			child!.once('close', (code, terminationSignal) => { sidecarClosed = true; if (!settled) { settled = true; signal?.removeEventListener('abort', onAbort); reject(new Error(`Host writer lock exited before acquisition (code ${code}, signal ${terminationSignal}).`)); } else { notifyLost(); } });
		});
		const statePath = join(paths.queuePath, `${ticket}.state`);
		const ackPath = join(paths.queuePath, `${ticket}.ack`);
		const updateState = (value: string) => {
			if (released) { throw new Error('Cannot update a released host writer lease.'); }
			const temporary = `${statePath}.${process.pid}.tmp`;
			writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
			renameSync(temporary, statePath);
		};
		return {
			attachOwnedProcessGroup: async pgid => {
				if (lost) { throw new Error('Host writer lock sidecar exited before the provider process group was attached.'); }
				const identity = processStartIdentity(pgid);
				if (!identity) { throw new Error('Could not verify the provider process group leader identity.'); }
				updateState(`pgid:${pgid}:${identity}`);
				while (!released) {
					if (lost || child?.exitCode !== null && child?.exitCode !== undefined || child?.signalCode !== null && child?.signalCode !== undefined) { throw new Error('Host lock sidecar exited before acknowledging the provider process group.'); }
					try { if (readFileSync(ackPath, 'utf8').trim() === String(pgid)) { return; } } catch { /* sidecar has not acknowledged yet */ }
					await delay(25);
				}
				throw new Error('Writer lease was released before provider process group attachment completed.');
			},
			onLost: callback => {
				if (lost) { callback(); return { dispose() { } }; }
				lostListeners.add(callback);
				return { dispose: () => lostListeners.delete(callback) };
			},
			release: () => {
				if (released) { return; }
				released = true;
				if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { child.kill('SIGTERM'); } } }
				const cleanup = () => { try { rmSync(join(paths.queuePath, ticket), { force: true }); rmSync(statePath, { force: true }); rmSync(ackPath, { force: true }); } catch { /* surfaced through retained ticket; lock remains fail-closed */ } };
				if (sidecarClosed || child?.exitCode !== null && child?.exitCode !== undefined || child?.signalCode !== null && child?.signalCode !== undefined) { cleanup(); }
				else { child?.once('close', cleanup); }
			},
		};
	} catch (error) {
		if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
		if (!cancelled) { try { rmSync(join(paths.queuePath, ticket), { force: true }); rmSync(join(paths.queuePath, `${ticket}.state`), { force: true }); } catch { /* fail closed if filesystem cleanup is unavailable */ } }
		else { try { rmSync(join(paths.queuePath, ticket), { force: true }); } catch { /* next waiter can identify the dead owner */ } }
		throw error;
	}
}

const sidecarScript = 'printf "TASK_WRITER_LOCK_ACQUIRED\\n"; while [ "$(/bin/ps -p "$TASK_WRITER_LOCK_OWNER" -o lstart= | /usr/bin/sed "s/^ *//;s/ *$//")" = "$TASK_WRITER_LOCK_OWNER_START" ]; do state=$(/bin/cat "$TASK_WRITER_LOCK_STATE" 2>/dev/null); case "$state" in pgid:*) record=${state#pgid:}; pgid=${record%%:*}; [ -e "$TASK_WRITER_LOCK_ACK" ] || printf "%s\\n" "$pgid" > "$TASK_WRITER_LOCK_ACK" ;; esac; /bin/sleep 0.05; done; state=$(/bin/cat "$TASK_WRITER_LOCK_STATE" 2>/dev/null); case "$state" in unarmed) /bin/rm -f "$TASK_WRITER_LOCK_TICKET" "$TASK_WRITER_LOCK_STATE" ;; pgid:*) record=${state#pgid:}; pgid=${record%%:*}; identity=${record#*:}; leader_start=$(/bin/ps -p "$pgid" -o lstart= | /usr/bin/sed "s/^ *//;s/ *$//"); if [ "$leader_start" = "$identity" ]; then /bin/kill -TERM -"$pgid" 2>/dev/null || true; /bin/sleep 2; /bin/kill -0 -"$pgid" 2>/dev/null && /bin/kill -KILL -"$pgid" 2>/dev/null || true; fi; while /bin/kill -0 -"$pgid" 2>/dev/null; do /bin/sleep 0.1; done; /bin/rm -f "$TASK_WRITER_LOCK_TICKET" "$TASK_WRITER_LOCK_STATE" "$TASK_WRITER_LOCK_ACK" ;; *) while :; do /bin/sleep 60; done ;; esac';

function prepareHostPaths(): HostPaths {
	const home = realpathSync(homedir());
	const libraryPath = join(home, 'Library');
	const applicationSupportPath = join(libraryPath, 'Application Support');
	const directory = join(applicationSupportPath, 'ReviewDesktop');
	const queuePath = join(directory, 'task-folder-writer-queue');
	try {
		ensureDirectory(libraryPath, 0o755);
		ensureDirectory(applicationSupportPath, 0o755);
		ensureDirectory(directory, 0o700);
		ensureDirectory(queuePath, 0o700);
		const lockPath = join(directory, 'task-folder-writer.lock');
		const sequenceLockPath = join(queuePath, '.sequence-lock');
		ensureHostLockFile(lockPath);
		ensureHostLockFile(sequenceLockPath);
		return { directory, lockPath, queuePath, sequenceLockPath };
	} catch (error) { throw new Error(`Unable to prepare secure host writer lock storage: ${String(error)}`); }
}

export function ensureHostLockFile(lockPath: string): { dev: number; ino: number } {
	let descriptor: number;
	try { descriptor = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
	catch (error) { throw new Error(`Unable to safely open the host writer lock file: ${String(error)}`); }
	try {
		const opened = fstatSync(descriptor);
		const named = lstatSync(lockPath);
		if (!opened.isFile() || !named.isFile() || opened.dev !== named.dev || opened.ino !== named.ino
			|| (typeof process.getuid === 'function' && (opened.uid !== process.getuid() || named.uid !== process.getuid()))) {
			throw new Error('The host writer lock file is not a stable app-owned regular file.');
		}
		fchmodSync(descriptor, 0o600);
		return { dev: opened.dev, ino: opened.ino };
	} finally { closeSync(descriptor); }
}

function ensureDirectory(path: string, mode: number): void {
	try { mkdirSync(path, { mode }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
	const metadata = lstatSync(path);
	if (!metadata.isDirectory() || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) { throw new Error(`Unsafe host writer lock directory: ${path}`); }
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { fchmodSync(descriptor, mode); } finally { closeSync(descriptor); }
}

const ticketScript = 'set -e; sequence=$(/bin/cat "$TASK_WRITER_SEQUENCE" 2>/dev/null || printf 0); case "$sequence" in ""|*[!0-9]*) exit 70 ;; esac; sequence=$((sequence + 1)); ticket=$(printf "%020d" "$sequence"); printf "%s\\n" "$sequence" > "$TASK_WRITER_SEQUENCE_TMP"; /bin/mv -f "$TASK_WRITER_SEQUENCE_TMP" "$TASK_WRITER_SEQUENCE"; printf "unarmed\\n" > "$TASK_WRITER_STATE_TMP"; /bin/mv -f "$TASK_WRITER_STATE_TMP" "$TASK_WRITER_QUEUE/$ticket.state"; printf "%s\\n%s\\n%s\\n" "$TASK_WRITER_OWNER" "$TASK_WRITER_OWNER_START" "$TASK_WRITER_TOKEN" > "$TASK_WRITER_TICKET_TMP"; /bin/mv -f "$TASK_WRITER_TICKET_TMP" "$TASK_WRITER_QUEUE/$ticket"; printf "TASK_WRITER_TICKET:%s\\n" "$ticket"';

async function createQueueTicket(queuePath: string, sequenceLockPath: string, ownerStart: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) { throw new WriterLockCancelledError(); }
	const token = randomUUID();
	const sequencePath = join(queuePath, '.sequence');
	const temporaryBase = `${process.pid}.${token}`;
	const child = spawn('/usr/bin/lockf', ['-k', sequenceLockPath, '/bin/sh', '-c', ticketScript], {
		detached: true,
		env: { ...process.env, TASK_WRITER_SEQUENCE: sequencePath, TASK_WRITER_SEQUENCE_TMP: `${sequencePath}.${temporaryBase}.tmp`, TASK_WRITER_STATE_TMP: join(queuePath, `${temporaryBase}.state.tmp`), TASK_WRITER_TICKET_TMP: join(queuePath, `${temporaryBase}.ticket.tmp`), TASK_WRITER_QUEUE: queuePath, TASK_WRITER_OWNER: String(process.pid), TASK_WRITER_OWNER_START: ownerStart, TASK_WRITER_TOKEN: token },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let childClosed = false;
	let resolveClosed!: () => void;
	const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
	child.once('close', () => { childClosed = true; resolveClosed(); });
	const stop = () => {
		if (child.pid && child.exitCode === null && child.signalCode === null) {
			try { process.kill(-child.pid, 'SIGTERM'); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { child.kill('SIGTERM'); } }
		}
	};
	const cleanupToken = () => {
		for (const name of readdirSync(queuePath).filter(entry => /^\d{20}$/.test(entry))) {
			const ticketPath = join(queuePath, name);
			try {
				if (readFileSync(ticketPath, 'utf8').split('\n')[2] === token) {
					rmSync(ticketPath, { force: true });
					rmSync(join(queuePath, `${name}.state`), { force: true });
					rmSync(join(queuePath, `${name}.ack`), { force: true });
				}
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
		}
		for (const suffix of ['.state.tmp', '.ticket.tmp']) { rmSync(join(queuePath, `${temporaryBase}${suffix}`), { force: true }); }
		rmSync(`${sequencePath}.${temporaryBase}.tmp`, { force: true });
	};
	try {
		return await new Promise<string>((resolve, reject) => {
			let output = '';
			let errors = '';
			let settled = false;
			const onAbort = () => {
				if (settled) { return; }
				settled = true;
				signal?.removeEventListener('abort', onAbort);
				stop();
				void closed.then(() => { try { cleanupToken(); reject(new WriterLockCancelledError()); } catch (error) { reject(new Error(`Cancelled host writer ticket cleanup failed: ${String(error)}`)); } });
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) { onAbort(); }
			child.stdout!.setEncoding('utf8');
			child.stderr!.setEncoding('utf8');
			child.stdout!.on('data', (chunk: string) => {
				output += chunk;
				const match = output.match(/TASK_WRITER_TICKET:(\d{20})/);
				if (settled || !match) { return; }
				if (signal?.aborted) { onAbort(); return; }
				settled = true;
				signal?.removeEventListener('abort', onAbort);
				resolve(match[1]);
			});
			child.stderr!.on('data', (chunk: string) => { errors += chunk; });
			child.once('error', error => {
				if (!settled) { settled = true; signal?.removeEventListener('abort', onAbort); stop(); void closed.then(() => reject(new Error(`Unable to sequence host writer ticket: ${error.message}`))); }
			});
			child.once('close', (code, terminationSignal) => {
				if (!settled) { settled = true; signal?.removeEventListener('abort', onAbort); reject(new Error(`Host writer ticket sequencer exited before creating a ticket (code ${code}, signal ${terminationSignal}): ${errors}`)); }
			});
		});
	} catch (error) {
		stop();
		if (!childClosed) { await closed; }
		try { cleanupToken(); }
		catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Host writer ticket sequencing failed and ticket cleanup could not be verified.'); }
		throw error;
	}
}

function processStartIdentity(pid: number): string | undefined {
	const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
	const identity = result.status === 0 ? result.stdout.trim() : '';
	return identity || undefined;
}

async function isQueueHead(queuePath: string, ticket: string): Promise<boolean> {
	const tickets = readdirSync(queuePath).filter(entry => /^\d{20}$/.test(entry)).sort();
	for (const entry of tickets) {
		if (entry === ticket) { return true; }
		const ticketPath = join(queuePath, entry);
		const [pidText, expectedOwnerStart, token] = readFileSync(ticketPath, 'utf8').trimEnd().split('\n');
		const pid = Number(pidText);
		if (!Number.isSafeInteger(pid) || pid <= 0 || !expectedOwnerStart || !token) { throw new Error(`Host writer ticket ${entry} has invalid owner metadata; refusing to skip it.`); }
		const statePath = join(queuePath, `${entry}.state`);
		let state: string;
		try { state = readFileSync(statePath, 'utf8').trim(); } catch { throw new Error(`Host writer ticket ${entry} has no state record; refusing to skip it.`); }
		let ownerExists = true;
		try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { ownerExists = false; } else { throw error; } }
		const currentOwnerStart = ownerExists ? processStartIdentity(pid) : undefined;
		if (ownerExists && !currentOwnerStart) { throw new Error(`Host writer ticket ${entry} owner identity cannot be verified; manual reconciliation is required.`); }
		if (currentOwnerStart === expectedOwnerStart) { return false; }
		if (state === 'unarmed') { rmSync(ticketPath, { force: true }); rmSync(statePath, { force: true }); continue; }
		const processGroup = state.match(/^pgid:(\d+):(.+)$/);
		if (!processGroup) { throw new Error(`Host writer ticket ${entry} has unknown cleanup state; manual reconciliation is required.`); }
		await recoverOrphanProviderGroup(queuePath, entry, Number(processGroup[1]), processGroup[2]);
	}
	return false;
}

async function recoverOrphanProviderGroup(queuePath: string, ticket: string, pgid: number, expectedLeaderStart: string): Promise<void> {
	const groupAlive = () => {
		try { process.kill(-pgid, 0); return true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return false; } throw error; }
	};
	if (groupAlive()) {
		const actualLeaderStart = processStartIdentity(pgid);
		if (!actualLeaderStart || actualLeaderStart !== expectedLeaderStart) { throw new Error(`Orphan provider group ${pgid} for writer ticket ${ticket} cannot be safely identified; manual cleanup is required.`); }
		try { process.kill(-pgid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
		if (await waitForGroupGone(groupAlive, 1000)) { cleanupOrphanTicket(queuePath, ticket); return; }
		try { process.kill(-pgid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
		if (!await waitForGroupGone(groupAlive, 2000)) { throw new Error(`Orphan provider group ${pgid} for writer ticket ${ticket} did not stop; manual cleanup is required.`); }
	}
	cleanupOrphanTicket(queuePath, ticket);
}

async function waitForGroupGone(groupAlive: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) { if (!groupAlive()) { return true; } await delay(50); }
	return !groupAlive();
}

function cleanupOrphanTicket(queuePath: string, ticket: string): void {
	for (const suffix of ['', '.state', '.ack']) { rmSync(join(queuePath, `${ticket}${suffix}`), { force: true }); }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
		const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new WriterLockCancelledError()); };
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) { abort(); }
	});
}

export function writerLockRootForFolder(binding: { readonly vcsKind: string | null; readonly vcsRoot: string | null }, canonicalFolder: string): string {
	if (binding.vcsKind === null) { return realpathSync(canonicalFolder); }
	if (!binding.vcsRoot) { throw new Error('The verified VCS root is unavailable for writer serialization.'); }
	const root = realpathSync(binding.vcsRoot);
	if (!statSync(root).isDirectory() || !isSameOrAncestor(root, realpathSync(canonicalFolder))) {
		throw new Error('The verified VCS root does not contain the selected task folder.');
	}
	return root;
}

function pathsConflict(left: string | null, right: string | null): boolean {
	if (left === null || right === null) { return true; }
	return isSameOrAncestor(left, right) || isSameOrAncestor(right, left);
}

function isSameOrAncestor(parent: string, child: string): boolean {
	const difference = relative(parent, child);
	return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !difference.startsWith(sep));
}
