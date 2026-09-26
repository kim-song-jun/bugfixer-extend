/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureOrdinaryFolderInventory, compareOrdinaryFolderInventories, parseOrdinaryFolderChangeReport, unverifiedOrdinaryFolderChanges, type InventorySnapshot } from './ordinaryFolderInventory.js';

test('ordinary folder inventory comparison reports file create, modification, deletion, and symlink changes', () => {
	const before: InventorySnapshot = { entryCount: 4, fileBytes: 10, entries: [
		{ path: 'change.txt', kind: 'file', size: 3, sha256: 'old' },
		{ path: 'delete.txt', kind: 'file', size: 3, sha256: 'gone' },
		{ path: 'link', kind: 'symlink', target: '../outside' },
		{ path: 'outside-marker', kind: 'file', size: 4, sha256: 'same' },
	] };
	const after: InventorySnapshot = { entryCount: 3, fileBytes: 11, entries: [
		{ path: 'change.txt', kind: 'file', size: 4, sha256: 'new' },
		{ path: 'create.txt', kind: 'file', size: 3, sha256: 'new-file' },
		{ path: 'outside-marker', kind: 'file', size: 4, sha256: 'same' },
	] };
	const report = compareOrdinaryFolderInventories(before, after);
	assert.deepEqual(report.changes.map(change => [change.path, change.change]), [
		['change.txt', 'modified'], ['create.txt', 'created'], ['delete.txt', 'deleted'], ['link', 'deleted'],
	]);
	assert.equal(report.status, 'observed');
	assert.equal(parseOrdinaryFolderChangeReport(JSON.stringify(report))?.changes.length, 4);
});

test('failed inventory identity verification is exposed as unverified rather than an empty change list', () => {
	const report = unverifiedOrdinaryFolderChanges(new Error('root identity mismatch'));
	assert.equal(report.status, 'unverified');
	assert.match(report.summary, /root identity mismatch/u);
	assert.equal(report.changes.length, 0);
});

test('inventory helper timeout and run cancellation terminate and reap only the owned helper process', { skip: process.platform === 'win32' }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'ordinary-inventory-cancel-'));
	const helper = path.join(directory, 'inventory-helper');
	await writeFile(helper, '#!/bin/sh\nexec /bin/sleep 30\n');
	await chmod(helper, 0o755);
	try {
		let timedOutPid = 0;
		await assert.rejects(captureOrdinaryFolderInventory(helper, directory, '1', '1', { signal: new AbortController().signal, timeoutMs: 50, onSpawn: pid => { timedOutPid = pid; } }), /exceeded 50 ms/u);
		assert.ok(timedOutPid > 0);
		assert.throws(() => process.kill(timedOutPid, 0));

		const controller = new AbortController();
		let cancelledPid = 0;
		const running = captureOrdinaryFolderInventory(helper, directory, '1', '1', { signal: controller.signal, timeoutMs: 5000, onSpawn: pid => { cancelledPid = pid; } });
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(running, /Inventory cancelled/u);
		assert.ok(cancelledPid > 0);
		assert.throws(() => process.kill(cancelledPid, 0));
	} finally { await rm(directory, { recursive: true, force: true }); }
});
