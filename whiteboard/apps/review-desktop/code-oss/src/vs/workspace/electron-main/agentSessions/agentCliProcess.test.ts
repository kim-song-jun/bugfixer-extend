/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentCliProcessError, runBoundedAgentCliProcess } from './agentCliProcess.js';

const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME, LANG: 'C.UTF-8' };

describe('bounded CLI probe process ownership', () => {
	it('returns bounded output after a successful probe', async () => {
		const result = await runBoundedAgentCliProcess(process.execPath, ['-e', "process.stdout.write('version 1.2.3')"], { env, timeoutMs: 1_000, maxOutputBytes: 1024 });
		assert.equal(result.stdout, 'version 1.2.3');
	});

	it('preserves exact late output bytes and verifies the flushed output receipt', async () => {
		const payload = 'z'.repeat(768 * 1024);
		const expectedHash = createHash('sha256').update(payload).digest('hex');
		const result = await runBoundedAgentCliProcess(process.execPath, ['-e', "const value='z'.repeat(768*1024);process.stdout.write(value,()=>process.exit(0))"], { env, timeoutMs: 2_000, maxOutputBytes: 1024 * 1024 });
		assert.equal(result.stdout.length, payload.length);
		assert.equal(createHash('sha256').update(result.stdout).digest('hex'), expectedHash);
	});

	it('settles spawn errors and nonzero exits with explicit cleanup proof', async () => {
		await assert.rejects(
			runBoundedAgentCliProcess('/definitely/missing/agent-cli', ['--version'], { env, timeoutMs: 500, maxOutputBytes: 1024 }),
			error => error instanceof AgentCliProcessError && error.cleanupVerified,
		);
		await assert.rejects(
			runBoundedAgentCliProcess(process.execPath, ['-e', 'process.exit(7)'], { env, timeoutMs: 1_000, maxOutputBytes: 1024 }),
			error => error instanceof AgentCliProcessError && error.cleanupVerified,
		);
	});

	it('kills a TERM-resistant owned group when its descendant holds the inherited output streams', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'agent-cli-group-'));
		const pidFile = join(directory, 'pids');
		const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
		const parent = "const fs=require('node:fs');const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',process.argv[1]],{stdio:'inherit'});fs.writeFileSync(process.argv[2],String(process.pid)+'\\n'+String(c.pid));setInterval(()=>{},1000)";
		try {
			await assert.rejects(
				runBoundedAgentCliProcess(process.execPath, ['-e', parent, descendant, pidFile], { env, timeoutMs: 150, maxOutputBytes: 1024 }),
				error => {
					assert.ok(error instanceof AgentCliProcessError);
					assert.equal(error.cleanupVerified, true);
					assert.ok(error.ownedProcessGroupId);
					assert.throws(() => process.kill(-error.ownedProcessGroupId!, 0), { code: 'ESRCH' });
					return true;
				},
			);
			const pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
			assert.equal(pids.length, 2);
			for (const pid of pids) {
				assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('terminates an oversized-output process within the configured bound', async () => {
		const startedAt = Date.now();
		await assert.rejects(
			runBoundedAgentCliProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(1000000));setInterval(()=>{},1000)"], { env, timeoutMs: 2_000, maxOutputBytes: 1024 }),
			error => error instanceof AgentCliProcessError && error.cleanupVerified,
		);
		assert.ok(Date.now() - startedAt < 4_000);
	});

	it('fails closed and cleans a descendant when the CLI leader exits but stdio stays open', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'agent-cli-exited-leader-'));
		const pidFile = join(directory, 'descendant-pid');
		const escapedDescendant = "const fs=require('node:fs');const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'});fs.writeFileSync(process.argv[1],String(c.pid));process.exit(0)";
		let descendantPid: number | undefined;
		try {
			await assert.rejects(
				runBoundedAgentCliProcess(process.execPath, ['-e', escapedDescendant, pidFile], { env, timeoutMs: 1_000, maxOutputBytes: 1024 }),
				error => error instanceof AgentCliProcessError && error.cleanupVerified && /could not be drained/.test(error.message),
			);
			assert.ok(existsSync(pidFile));
			descendantPid = Number(readFileSync(pidFile, 'utf8'));
			assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
			assert.throws(() => process.kill(descendantPid!, 0), { code: 'ESRCH' });
		} finally {
			if (descendantPid !== undefined && processExists(descendantPid)) { process.kill(descendantPid, 'SIGKILL'); await waitUntilProcessGone(descendantPid); }
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

async function waitUntilProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (processExists(pid) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 25)); }
	assert.equal(processExists(pid), false);
}

function processExists(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
