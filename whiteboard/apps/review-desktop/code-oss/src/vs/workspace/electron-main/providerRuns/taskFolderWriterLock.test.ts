/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { ensureHostLockFile, TaskFolderWriterLock, WriterLockCancelledError, writerLockRootForFolder } from './taskFolderWriterLock.js';

test('separate lock instances serialize host writers and cancel only the waiting sidecar', { skip: process.platform !== 'darwin' }, async () => {
	const temp = mkdtempSync(join(tmpdir(), 'task-folder-writer-host-'));
	try {
		const firstRoot = join(temp, 'state-one');
		const secondRoot = join(temp, 'state-two');
		mkdirSync(firstRoot);
		mkdirSync(secondRoot);
		const firstLock = new TaskFolderWriterLock();
		const secondLock = new TaskFolderWriterLock();
		const first = await firstLock.acquire(firstRoot);
		await first.attachOwnedProcessGroup(process.pid);
		const abort = new AbortController();
		let secondAcquired = false;
		const waiting = secondLock.acquire(secondRoot, abort.signal).then(lease => { secondAcquired = true; return lease; });
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(secondAcquired, false, 'independent roots and lock instances must share the host lock');
		abort.abort();
		await assert.rejects(waiting, WriterLockCancelledError);
		first.release();
		const next = await secondLock.acquire(secondRoot);
		next.release();
	} finally { rmSync(temp, { recursive: true, force: true }); }
});

test('host writer lock rejects symlinked lock files', { skip: process.platform !== 'darwin' }, () => {
	const temp = mkdtempSync(join(tmpdir(), 'task-folder-writer-symlink-'));
	try {
		const target = join(temp, 'target');
		const alias = join(temp, 'task-folder-writer.lock');
		writeFileSync(target, 'outside lock target');
		symlinkSync(target, alias);
		assert.throws(() => ensureHostLockFile(alias), /Unable to safely open/);
	} finally { rmSync(temp, { recursive: true, force: true }); }
});

test('release after unexpected sidecar close removes its queue ticket', { skip: process.platform !== 'darwin' }, async () => {
	const temp = mkdtempSync(join(tmpdir(), 'task-folder-writer-sidecar-close-'));
	const beforeTickets = new Set(currentHostTickets());
	let lease: Awaited<ReturnType<TaskFolderWriterLock['acquire']>> | undefined;
	try {
		lease = await new TaskFolderWriterLock().acquire(temp);
		await lease.attachOwnedProcessGroup(process.pid);
		const newTicket = currentHostTickets().find(ticket => !beforeTickets.has(ticket));
		assert.ok(newTicket, 'the acquired lease must have a numbered queue ticket');
		let lostResolve!: () => void;
		const lost = new Promise<void>(resolve => { lostResolve = resolve; });
		lease.onLost(lostResolve);
		const sidecarPid = findOwnedHostLockSidecarPid();
		process.kill(-sidecarPid, 'SIGKILL');
		await lost;
		lease.release();
		await waitForTicketRemoved(newTicket);
	} finally { lease?.release(); rmSync(temp, { recursive: true, force: true }); }
});

test('independent app processes receive host writer leases in FIFO order', { skip: process.platform !== 'darwin' }, async () => {
	const temp = mkdtempSync(join(tmpdir(), 'task-folder-writer-fifo-'));
	const roots = [join(temp, 'one'), join(temp, 'two'), join(temp, 'three')];
	for (const root of roots) { mkdirSync(root); }
	const workers: ChildProcess[] = [];
	try {
		const first = startHostLockWorker(roots[0]); workers.push(first);
		await waitForWorkerLease(first);
		const second = startHostLockWorker(roots[1]); workers.push(second);
		await waitForQueuedCount(2);
		const third = startHostLockWorker(roots[2]); workers.push(third);
		await waitForQueuedCount(3);
		assert.equal(await workerAcquiresWithin(second, 100), false);
		assert.equal(await workerAcquiresWithin(third, 100), false);
		releaseHostLockWorker(first);
		await waitForWorkerLease(second);
		assert.equal(await workerAcquiresWithin(third, 100), false);
		releaseHostLockWorker(second);
		await waitForWorkerLease(third);
		releaseHostLockWorker(third);
	} finally {
		for (const worker of workers) { if (worker.exitCode === null && worker.signalCode === null) { releaseHostLockWorker(worker); worker.kill('SIGTERM'); } }
		await new Promise(resolve => setTimeout(resolve, 100));
		rmSync(temp, { recursive: true, force: true });
	}
});

test('host sidecar terminates an attached provider group after its app process crashes', { skip: process.platform !== 'darwin' }, async () => {
	const temp = mkdtempSync(join(tmpdir(), 'task-folder-writer-crash-'));
	const root = join(temp, 'root');
	mkdirSync(root);
	let owner: ChildProcess | undefined;
	let waiter: ChildProcess | undefined;
	try {
		owner = startHostLockWorker(root, true);
		const attached = await waitForWorkerMessage(owner, 'ATTACHED:');
		const pgid = Number(attached.slice('ATTACHED:'.length));
		assert.ok(Number.isSafeInteger(pgid) && pgid > 0);
		if (owner.exitCode === null && owner.signalCode === null) { await new Promise<void>(resolve => owner!.once('exit', () => resolve())); }
		waiter = startHostLockWorker(root);
		await waitForWorkerLease(waiter);
		assert.throws(() => process.kill(-pgid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
		releaseHostLockWorker(waiter);
	} finally {
		for (const worker of [owner, waiter]) { if (worker && worker.exitCode === null && worker.signalCode === null) { releaseHostLockWorker(worker); worker.kill('SIGTERM'); } }
		await new Promise(resolve => setTimeout(resolve, 100));
		rmSync(temp, { recursive: true, force: true });
	}
});

function startHostLockWorker(root: string, crashAfterAttach = false): ChildProcess {
	const moduleUrl = new URL('./taskFolderWriterLock.ts', import.meta.url).href;
	const code = `const { TaskFolderWriterLock } = await import(${JSON.stringify(moduleUrl)}); const { spawn } = await import('node:child_process'); const lease = await new TaskFolderWriterLock().acquire(${JSON.stringify(root)}); console.log('ACQUIRED'); ${crashAfterAttach ? "const provider = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' }); await lease.attachOwnedProcessGroup(provider.pid); console.log('ATTACHED:' + provider.pid); process.exit(0);" : "process.stdin.once('data', () => lease.release());"}`;
	return spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
}

async function waitForQueuedCount(count: number): Promise<void> {
	const queue = join(homedir(), 'Library', 'Application Support', 'ReviewDesktop', 'task-folder-writer-queue');
	const until = Date.now() + 3000;
	while (Date.now() < until) {
		try { if (readdirSync(queue).filter(entry => /^\d{20}$/.test(entry)).length >= count) { return; } } catch { /* first writer has not initialized storage */ }
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error(`Expected ${count} queued host writers before timeout.`);
}

function currentHostTickets(): string[] {
	const queue = join(homedir(), 'Library', 'Application Support', 'ReviewDesktop', 'task-folder-writer-queue');
	try { return readdirSync(queue).filter(entry => /^\d{20}$/.test(entry)); } catch { return []; }
}

function findOwnedHostLockSidecarPid(): number {
	const lockPath = join(homedir(), 'Library', 'Application Support', 'ReviewDesktop', 'task-folder-writer.lock');
	const listing = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
	assert.equal(listing.status, 0, `ps failed while locating the owned lockf sidecar: ${listing.stderr}`);
	const expectedCommand = `/usr/bin/lockf -k ${lockPath} `;
	const matches = listing.stdout.split('\n').flatMap(line => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
		return match && Number(match[2]) === process.pid && match[3].startsWith(expectedCommand) ? [Number(match[1])] : [];
	});
	assert.equal(matches.length, 1, `expected exactly one lockf sidecar for ${lockPath} owned by test pid ${process.pid}; found ${matches.length}`);
	return matches[0];
}


async function waitForTicketRemoved(ticket: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) { if (!currentHostTickets().includes(ticket)) { return; } await new Promise(resolve => setTimeout(resolve, 10)); }
	assert.ok(!currentHostTickets().includes(ticket), 'released sidecar ticket must be removed');
}

function waitForWorkerLease(worker: ChildProcess): Promise<void> {
	return waitForWorkerMessage(worker, 'ACQUIRED').then(() => undefined);
}

function waitForWorkerMessage(worker: ChildProcess, message: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = '';
		let errors = '';
		const timeout = setTimeout(() => reject(new Error('Timed out waiting for host writer worker acquisition.')), 3000);
		worker.stdout!.setEncoding('utf8');
		worker.stderr!.setEncoding('utf8');
		worker.stderr!.on('data', (chunk: string) => { errors += chunk; });
		worker.stdout!.on('data', (chunk: string) => { output += chunk; if (output.includes(message)) { clearTimeout(timeout); resolve(output.slice(output.indexOf(message)).split('\n')[0]); } });
		worker.once('exit', code => { if (!output.includes(message)) { clearTimeout(timeout); reject(new Error(`Host writer worker exited before emitting ${message} (${code}): ${errors}`)); } });
	});
}

async function workerAcquiresWithin(worker: ChildProcess, milliseconds: number): Promise<boolean> {
	let acquired = false;
	const listener = (chunk: string) => { if (chunk.includes('ACQUIRED')) { acquired = true; } };
	worker.stdout!.setEncoding('utf8');
	worker.stdout!.on('data', listener);
	await new Promise(resolve => setTimeout(resolve, milliseconds));
	worker.stdout!.off('data', listener);
	return acquired;
}

function releaseHostLockWorker(worker: ChildProcess): void { if (worker.exitCode === null && worker.signalCode === null) { worker.stdin!.write('release\n'); } }

test('canonical symlink aliases and ancestor folders serialize while unrelated roots proceed', async () => {
	const temp = mkdtempSync(join(tmpdir(), 'task-folder-writer-lock-'));
	try {
		const root = join(temp, 'root');
		const nested = join(root, 'nested');
		const alias = join(temp, 'alias');
		const unrelated = join(temp, 'unrelated');
		mkdirSync(nested, { recursive: true });
		mkdirSync(unrelated);
		symlinkSync(root, alias);
		const lock = new TaskFolderWriterLock();
		const first = await lock.acquire(root);
		const abort = new AbortController();
		let aliasAcquired = false;
		const aliasWaiter = lock.acquire(alias, abort.signal).then(lease => { aliasAcquired = true; return lease; });
		const nestedWaiter = lock.acquire(nested);
		assert.equal(aliasAcquired, false, 'the alias must resolve to the held canonical root');
		abort.abort();
		await assert.rejects(aliasWaiter, WriterLockCancelledError);
		first.release();
		const nestedLease = await nestedWaiter;
		nestedLease.release();
		const independent = await lock.acquire(unrelated);
		independent.release();
	} finally { rmSync(temp, { recursive: true, force: true }); }
});

test('cancelling a queued writer prevents its launch callback from running', async () => {
	const temp = mkdtempSync(join(tmpdir(), 'task-folder-writer-cancel-'));
	try {
		const lock = new TaskFolderWriterLock();
		const held = await lock.acquire(temp);
		const controller = new AbortController();
		let launched = false;
		const queuedLaunch = lock.acquire(temp, controller.signal).then(lease => {
			launched = true;
			lease.release();
		});
		controller.abort();
		await assert.rejects(queuedLaunch, WriterLockCancelledError);
		held.release();
		assert.equal(launched, false);
	} finally { rmSync(temp, { recursive: true, force: true }); }
});

test('global restart reservation excludes every new folder writer until released', async () => {
	const temp = mkdtempSync(join(tmpdir(), 'task-folder-writer-barrier-'));
	try {
		const lock = new TaskFolderWriterLock();
		const barrier = lock.reserveGlobal();
		const abort = new AbortController();
		const waiting = lock.acquire(temp, abort.signal);
		assert.equal(lock.hasGlobalReservation, true);
		abort.abort();
		await assert.rejects(waiting, WriterLockCancelledError);
		barrier.release();
		assert.equal(lock.hasGlobalReservation, false);
		const lease = await lock.acquire(temp);
		lease.release();
	} finally { rmSync(temp, { recursive: true, force: true }); }
});

test('different VCS bindings inside one checkout share the canonical repository writer lock', async () => {
	const temp = mkdtempSync(join(tmpdir(), 'task-folder-writer-vcs-root-'));
	try {
		const repository = join(temp, 'repository');
		const nestedTaskFolder = join(repository, 'packages', 'app');
		mkdirSync(nestedTaskFolder, { recursive: true });
		const rootBinding = { vcsKind: 'git', vcsRoot: repository };
		const nestedBinding = { vcsKind: 'git', vcsRoot: repository };
		const firstKey = writerLockRootForFolder(rootBinding, repository);
		const secondKey = writerLockRootForFolder(nestedBinding, nestedTaskFolder);
		assert.equal(firstKey, secondKey);
		const lock = new TaskFolderWriterLock();
		const first = await lock.acquire(firstKey);
		let secondAcquired = false;
		const secondWaiter = lock.acquire(secondKey).then(lease => { secondAcquired = true; return lease; });
		await Promise.resolve();
		assert.equal(secondAcquired, false);
		first.release();
		const second = await secondWaiter;
		second.release();
	} finally { rmSync(temp, { recursive: true, force: true }); }
});
