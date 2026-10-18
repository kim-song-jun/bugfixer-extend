/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { AgentSessionContentCaptureCleanupError, captureAgentSessionContentSnapshot, compareAgentSessionContentSnapshots, validateAgentSessionContentSnapshot, type AgentSessionContentCaptureCleanupRecovery, type AgentSessionContentRootIdentity } from './agentSessionContentCapture.js';

const execFileAsync = promisify(execFile);
const nativeTest = process.platform === 'darwin';
const temporaryRoots: string[] = [];
let compiledHelper: string | undefined;

after(async () => { await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true }))); });

async function createHelper(): Promise<string> {
	if (compiledHelper) { return compiledHelper; }
	const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-session-content-helper-'));
	temporaryRoots.push(temporaryRoot);
	compiledHelper = path.join(temporaryRoot, 'bound-checkout');
	const source = new URL('../../../../../../native/bound-checkout/bound-checkout.c', import.meta.url);
	await execFileAsync('clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source.pathname, '-o', compiledHelper]);
	return compiledHelper;
}

async function createFixture(): Promise<{ directory: string; root: string; helper: string; identity: AgentSessionContentRootIdentity }> {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-session-content-'));
	temporaryRoots.push(directory);
	const root = path.join(directory, 'root');
	await mkdir(root);
	const canonicalPath = await realpath(root);
	const identityStat = await lstat(canonicalPath, { bigint: true });
	return {
		directory, root: canonicalPath, helper: await createHelper(),
		identity: { canonicalPath, dev: identityStat.dev.toString(), ino: identityStat.ino.toString() },
	};
}

test('native before and after snapshots retain bytes and report filesystem changes without following symlinks', { skip: !nativeTest }, async () => {
	const fixture = await createFixture();
	const outside = path.join(fixture.directory, 'outside.txt');
	await writeFile(path.join(fixture.root, 'modified.txt'), 'before');
	await writeFile(path.join(fixture.root, 'deleted.txt'), 'gone');
	await writeFile(path.join(fixture.root, 'kind.txt'), 'file first');
	await writeFile(outside, 'must never be read');
	await symlink(outside, path.join(fixture.root, 'link'));
	const before = await captureAgentSessionContentSnapshot(fixture.helper, fixture.identity, { signal: new AbortController().signal });
	assert.deepEqual(validateAgentSessionContentSnapshot(before), before);
	assert.throws(() => validateAgentSessionContentSnapshot({ ...before, entries: before.entries.map(entry => entry.path === 'modified.txt' ? { ...entry, sha256: '0'.repeat(64) } : entry) }), /text content is invalid/u);
	await assert.rejects(captureAgentSessionContentSnapshot(fixture.helper, { ...fixture.identity, ino: `${BigInt(fixture.identity.ino) + 1n}` }, { signal: new AbortController().signal }), /root identity mismatch/u);

	await writeFile(path.join(fixture.root, 'modified.txt'), 'after');
	await rm(path.join(fixture.root, 'deleted.txt'));
	await writeFile(path.join(fixture.root, 'created.txt'), 'created');
	await rm(path.join(fixture.root, 'kind.txt'));
	await mkdir(path.join(fixture.root, 'kind.txt'));
	await rm(path.join(fixture.root, 'link'));
	await symlink('modified.txt', path.join(fixture.root, 'link'));
	const after = await captureAgentSessionContentSnapshot(fixture.helper, fixture.identity, { signal: new AbortController().signal });

	assert.equal(before.entries.find(entry => entry.path === 'modified.txt')?.content, 'before');
	assert.equal(before.entries.some(entry => entry.path === 'outside.txt'), false);
	assert.equal(after.entries.find(entry => entry.path === 'link')?.target, 'modified.txt');
	assert.deepEqual(compareAgentSessionContentSnapshots(before, after).changes.map(item => [item.path, item.change]), [
		['created.txt', 'created'], ['deleted.txt', 'deleted'], ['kind.txt', 'typeChanged'], ['link', 'symlinkChanged'], ['modified.txt', 'modified'],
	]);
});

test('native snapshots expose binary, invalid UTF-8, per-file and retained-text limits as partial content coverage', { skip: !nativeTest }, async () => {
	const fixture = await createFixture();
	await writeFile(path.join(fixture.root, 'binary.dat'), Buffer.from([0xff, 0x00, 0x80]));
	await writeFile(path.join(fixture.root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
	await writeFile(path.join(fixture.root, 'oversized.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61));
	for (let index = 0; index < 9; index++) {
		await writeFile(path.join(fixture.root, `large-${index}.txt`), Buffer.alloc(1024 * 1024, 0x61));
	}
	const snapshot = await captureAgentSessionContentSnapshot(fixture.helper, fixture.identity, { signal: new AbortController().signal });
	assert.equal(snapshot.inventoryCoverage, 'complete');
	assert.equal(snapshot.contentCoverage, 'partial');
	assert.equal(snapshot.entries.find(entry => entry.path === 'binary.dat')?.contentUnavailableReason, 'binary');
	assert.equal(snapshot.entries.find(entry => entry.path === 'invalid.txt')?.contentUnavailableReason, 'invalidUtf8');
	assert.equal(snapshot.entries.find(entry => entry.path === 'oversized.txt')?.contentUnavailableReason, 'fileTooLarge');
	assert.equal(snapshot.retainedTextBytes, 8 * 1024 * 1024);
	assert.equal(snapshot.entries.filter(entry => entry.contentUnavailableReason === 'retainedTextLimit').length, 1);
});

test('content reads stop at the bounded file count and a cancelled helper is reaped', { skip: !nativeTest }, async () => {
	const fixture = await createFixture();
	for (let index = 0; index < 301; index++) { await writeFile(path.join(fixture.root, `${String(index).padStart(3, '0')}.txt`), 'x'); }
	const snapshot = await captureAgentSessionContentSnapshot(fixture.helper, fixture.identity, { signal: new AbortController().signal });
	assert.equal(snapshot.contentReadCount, 300);
	assert.equal(snapshot.entries.filter(entry => entry.contentUnavailableReason === 'contentFileLimit').length, 1);

	const hangingHelper = path.join(fixture.directory, 'hanging-helper');
	await writeFile(hangingHelper, '#!/bin/sh\ntrap \'\' TERM\n/bin/sleep 2 &\nprintf ready > "$2/helper-ready"\nwait\n');
	await chmod(hangingHelper, 0o755);
	const controller = new AbortController();
	let spawnedPid = 0;
	let recovery: AgentSessionContentCaptureCleanupRecovery | undefined;
	const running = captureAgentSessionContentSnapshot(hangingHelper, fixture.identity, {
		signal: controller.signal,
		onSpawn: pid => { spawnedPid = pid; },
	});
	let rejectionAssertionError: unknown;
	const rejected = assert.rejects(running, error => {
		assert.ok(error instanceof AgentSessionContentCaptureCleanupError);
		recovery = error.recovery;
		assert.match(error.stopReason.message, /cancelled/u);
		return true;
	}).catch(error => { rejectionAssertionError = error; });
	try {
		// Wait for the actual trap and inherited stdout holder, rather than racing shell startup with TERM.
		const readyDeadline = Date.now() + 1500;
		while (true) {
			try { await readFile(path.join(fixture.root, 'helper-ready')); break; }
			catch (error) {
				if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT' || Date.now() >= readyDeadline) { throw error; }
			}
			await delay(10);
		}
		controller.abort();
		await rejected;
		if (rejectionAssertionError !== undefined) { throw rejectionAssertionError; }
		assert.ok(spawnedPid > 0);
		assert.ok(recovery);
		assert.equal(recovery.pid, spawnedPid);
		assert.equal(await recovery.retryCleanup(), true);
		assert.throws(() => process.kill(spawnedPid, 0));
	} finally {
		controller.abort();
		await running.catch(error => {
			if (error instanceof AgentSessionContentCaptureCleanupError) { recovery = error.recovery; }
		});
		await rejected;
		if (recovery && !await recovery.retryCleanup()) { throw new Error(`Fixture helper cleanup remains unverified for pid ${recovery.pid ?? 'unknown'}.`); }
	}
});
