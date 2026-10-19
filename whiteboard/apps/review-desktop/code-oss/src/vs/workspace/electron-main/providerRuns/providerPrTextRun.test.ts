/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ProviderProcessSupervisor } from './providerProcessSupervisor.js';
import type { ProviderRunHandle } from './providerRunTypes.js';
import type { ProviderPrTextRunRequest } from './providerPrTextRun.js';
import { queryProviderPrTextCapability, runProviderPrText } from './providerPrTextRun.js';

const SOURCE = 'Commit 123 changed the account recovery flow and adds coverage for expired links.';
const MODEL_OUTPUT = { title: 'Handle expired recovery links', body: 'Recovery links now expire safely, with regression coverage for expired tokens.' };
const HELPER_SCRIPT = fileURLToPath(new URL('../../../../../../scripts/provider-group-control.mjs', import.meta.url));

function request(overrides: Partial<ProviderPrTextRunRequest> = {}): ProviderPrTextRunRequest {
	return {
		providerId: 'claude',
		model: 'claude-sonnet-4-5',
		sourceCwd: '/approved/source/workspace',
		profileDirectory: '/profile/selected-claude-account',
		executable: '/tmp/claude-fixture',
		processControl: { nodeExecutable: process.execPath, helperScript: HELPER_SCRIPT },
		requestId: 'request-1',
		attemptId: 'attempt-1',
		snapshot: {
			snapshotId: 'snapshot-1',
			sourceText: SOURCE,
			sha256: createHash('sha256').update(SOURCE).digest('hex'),
		},
		task: 'Draft concise, factual PR title and body.',
		preflight: async () => ({ allowed: true, cwdIdentity: 'temporary-cwd', policyProof: 'read-only' }),
		onOwnedProcessSpawned: () => undefined,
		onCleanupVerified: () => undefined,
		...overrides,
	};
}

async function fixtureExecutable(script: string): Promise<{ root: string; executable: string }> {
	const root = await mkdtemp(join(tmpdir(), 'provider-pr-text-fixture-'));
	const executable = join(root, 'claude-fixture');
	await writeFile(executable, `#!/bin/sh\n${script}`, { mode: 0o700 });
	await chmod(executable, 0o700);
	return { root, executable };
}

async function assertMissing(path: string): Promise<void> {
	await assert.rejects(access(path), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
}

async function waitForPath(path: string, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await access(path);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		await new Promise<void>(resolve => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

test('PR text capability supports either explicitly selected provider without a fallback policy gate', () => {
	for (const providerId of ['codex', 'claude'] as const) {
		const capability = queryProviderPrTextCapability(request({ providerId }));
		assert.equal(capability.available, process.platform === 'darwin');
		if (process.platform !== 'darwin') { assert.match(capability.reason ?? '', /macOS owner-lifetime/u); }
	}
});

test('uses the exact hash-verified snapshot and validates real child output before returning a receipt', { skip: process.platform !== 'darwin' }, async () => {
	const expectedJson = JSON.stringify(MODEL_OUTPUT);
	const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: expectedJson });
	const fixture = await fixtureExecutable(`cat >/dev/null\nprintf '%s\\n' '${resultLine}'\n`);
	let executionCwd: string | undefined;
	let recoveryDirectory: string | undefined;
	let capturedPrompt = '';
	let cleanupReceiptPersisted = false;
	try {
		const result = await runProviderPrText(request({
			sourceCwd: fixture.root,
			executable: fixture.executable,
			preflight: async (run) => {
				executionCwd = run.cwd;
				capturedPrompt = run.prompt;
				assert.notEqual(run.cwd, fixture.root, 'provider starts in a fresh private directory');
				return { allowed: true, cwdIdentity: 'verified-private-cwd', policyProof: 'read-only' };
			},
			onOwnedProcessSpawned: (_pgid, _nonce, control) => { recoveryDirectory = control ? dirname(control.socketPath) : undefined; },
			onCleanupVerified: async receipt => {
				assert.ok(recoveryDirectory);
				assert.equal(await access(recoveryDirectory).then(() => true), true, 'the host persists cleanup proof before directory removal');
				assert.equal(receipt.requestId, 'request-1');
				assert.equal(receipt.attemptId, 'attempt-1');
				assert.ok(receipt.pgid);
				assert.ok(receipt.controlNonce);
				cleanupReceiptPersisted = true;
			},
		}));
		assert.equal(result.state, 'succeeded');
		assert.equal(result.cleanupVerified, true);
		assert.deepEqual(result.content, MODEL_OUTPUT);
		assert.equal(result.receipt?.providerId, 'claude');
		assert.equal(result.receipt?.model, 'claude-sonnet-4-5');
		assert.equal(result.receipt?.snapshotSha256, request().snapshot.sha256);
		assert.equal(result.receipt?.contentSha256, createHash('sha256').update(expectedJson).digest('hex'));
		assert.equal(cleanupReceiptPersisted, true);
		assert.equal(capturedPrompt.includes(fixture.root), true, 'the approved source root is supplemental local context');
		assert.equal(capturedPrompt.includes(SOURCE), true, 'retained snapshot is supplied as the authoritative input');
		assert.ok(executionCwd);
		await assertMissing(executionCwd);
		assert.ok(recoveryDirectory);
		await assertMissing(recoveryDirectory);
		assert.equal(await access(fixture.root).then(() => true), true, 'the selected source workspace is not removed');
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test('launches the explicitly selected Codex model read-only from a private cwd without changing the approved source workspace', { skip: process.platform !== 'darwin' }, async () => {
	const fixture = await fixtureExecutable('cat >/dev/null\n');
	const sourceCwd = await mkdtemp(join(tmpdir(), 'provider-pr-text-source-'));
	const sourcePath = join(sourceCwd, 'selected.ts');
	const beforeSource = 'export const selected = true;\n';
	await writeFile(sourcePath, beforeSource, 'utf8');
	const argvPath = join(fixture.root, 'argv.txt');
	const codexOutput = [
		JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(MODEL_OUTPUT) } }),
		JSON.stringify({ type: 'turn.completed' }),
	];
	await writeFile(fixture.executable, `#!/bin/sh\nfor arg do printf '%s\\n' "$arg"; done > '${argvPath}'\nprintf 'CODEX_HOME=%s\\n' "$CODEX_HOME" >> '${argvPath}'\ncat >/dev/null\nprintf '%s\\n' '${codexOutput[0]}'\nprintf '%s\\n' '${codexOutput[1]}'\n`, { mode: 0o700 });
	await chmod(fixture.executable, 0o700);
	let executionCwd: string | undefined;
	let prompt = '';
	try {
		const result = await runProviderPrText(request({ providerId: 'codex', model: 'gpt-6.1-codex', sourceCwd,
			profileDirectory: '/profile/selected-codex-account', executable: fixture.executable,
			preflight: async run => { executionCwd = run.cwd; prompt = run.prompt; assert.notEqual(run.cwd, sourceCwd); return { allowed: true, cwdIdentity: 'private-cwd', policyProof: 'read-only' }; },
		}));
		assert.equal(result.state, 'succeeded');
		assert.equal(result.cleanupVerified, true);
		assert.deepEqual(result.content, MODEL_OUTPUT);
		assert.equal(result.receipt?.providerId, 'codex');
		assert.equal(result.receipt?.model, 'gpt-6.1-codex');
		assert.equal(prompt.includes(sourceCwd), true);
		assert.equal(prompt.includes(SOURCE), true);
		assert.ok(executionCwd);
		await assertMissing(executionCwd);
		const argv = await readFile(argvPath, 'utf8');
		assert.match(argv, /--ignore-user-config/u);
		assert.match(argv, /--model\ngpt-6\.1-codex\n/u);
		assert.match(argv, /--sandbox\nread-only\n/u);
		assert.match(argv, /CODEX_HOME=\/profile\/selected-codex-account/u);
		assert.equal(await readFile(sourcePath, 'utf8'), beforeSource, 'the approved source tree remains untouched');
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
		await rm(sourceCwd, { recursive: true, force: true });
	}
});

test('does not launch on a changed source snapshot or return non-contract model output', { skip: process.platform !== 'darwin' }, async () => {
	const fixture = await fixtureExecutable(`cat >/dev/null\nexit 99\n`);
	try {
		let launches = 0;
		const mismatch = await runProviderPrText(request({
			executable: fixture.executable,
			snapshot: { ...request().snapshot, sourceText: 'changed after selection' },
			onOwnedProcessSpawned: () => { launches += 1; },
		}));
		assert.equal(mismatch.state, 'failed');
		assert.match(mismatch.reason ?? '', /changed after it was selected/);
		assert.equal(launches, 0);

		const invalidOutput = JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify({ ...MODEL_OUTPUT, extra: 'not allowed' }) });
		const invalidFixture = await fixtureExecutable(`cat >/dev/null\nprintf '%s\\n' '${invalidOutput}'\n`);
		try {
			const result = await runProviderPrText(request({ executable: invalidFixture.executable }));
			assert.equal(result.state, 'failed');
			assert.match(result.reason ?? '', /strict title\/body JSON contract/);
			assert.equal(result.receipt, undefined);
			assert.equal(result.cleanupVerified, true);
		} finally {
			await rm(invalidFixture.root, { recursive: true, force: true });
		}
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test('cancels the owned child and removes only its private execution directory', { skip: process.platform !== 'darwin' }, async () => {
	const fixture = await fixtureExecutable('cat >/dev/null\nsleep 30\n');
	const controller = new AbortController();
	let executionCwd: string | undefined;
	try {
		const result = await runProviderPrText(request({
			sourceCwd: fixture.root,
			executable: fixture.executable,
			signal: controller.signal,
			preflight: async (run) => {
				executionCwd = run.cwd;
				return { allowed: true, cwdIdentity: 'verified-private-cwd', policyProof: 'read-only' };
			},
			onOwnedProcessSpawned: () => {
				setTimeout(() => controller.abort(), 200);
			},
		}));
		assert.equal(result.state, 'cancelled');
		assert.equal(result.cleanupVerified, true);
		assert.equal(result.content, undefined);
		assert.ok(executionCwd);
		await assertMissing(executionCwd);
		assert.equal(await access(fixture.root).then(() => true), true, 'cancellation never removes the selected source workspace');
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test('keeps the private directory when the verified cleanup receipt cannot be durably confirmed', { skip: process.platform !== 'darwin' }, async () => {
	const expectedJson = JSON.stringify(MODEL_OUTPUT);
	const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: expectedJson });
	const fixture = await fixtureExecutable(`cat >/dev/null\nprintf '%s\\n' '${resultLine}'\n`);
	let executionCwd: string | undefined;
	let recoverySocket: string | undefined;
	try {
		const result = await runProviderPrText(request({
			executable: fixture.executable,
			preflight: async run => { executionCwd = run.cwd; return { allowed: true, cwdIdentity: 'private-cwd', policyProof: 'read-only' }; },
			onOwnedProcessSpawned: (_pgid, _nonce, control) => { recoverySocket = control?.socketPath; },
			onCleanupVerified: async () => { throw new Error('fixture models durable cleanup receipt write failure'); },
		}));
		assert.equal(result.state, 'interrupted');
		assert.equal(result.cleanupVerified, false);
		assert.match(result.reason ?? '', /cleanup could not be verified/u);
		assert.ok(executionCwd);
		assert.ok(recoverySocket);
		assert.equal(await access(executionCwd).then(() => true), true, 'a failed durable receipt leaves the private directory for recovery');
	} finally {
		if (executionCwd) await rm(executionCwd, { recursive: true, force: true });
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test('a supervisor throw after a real owned spawn cannot report cleanup as verified', { skip: process.platform !== 'darwin' }, async () => {
	class ThrowAfterOwnedSpawnSupervisor extends ProviderProcessSupervisor {
		handle: ProviderRunHandle | undefined;
		override async run(...args: Parameters<ProviderProcessSupervisor['run']>): Promise<ProviderRunHandle> {
			this.handle = await super.run(...args);
			throw new Error('supervisor threw after returning the owned process handle');
		}
	}
	const fixture = await fixtureExecutable('cat >/dev/null\nsleep 30\n');
	const supervisor = new ThrowAfterOwnedSpawnSupervisor();
	let executionCwd: string | undefined;
	let recoverySocket: string | undefined;
	try {
		const result = await runProviderPrText(request({
			sourceCwd: fixture.root,
			executable: fixture.executable,
			preflight: async run => { executionCwd = run.cwd; return { allowed: true, cwdIdentity: 'verified-private-cwd', policyProof: 'read-only' }; },
			onOwnedProcessSpawned: async (_pgid, _nonce, control) => {
				assert.ok(control, 'the durable owned-process callback receives its recovery endpoint');
				recoverySocket = control.socketPath;
			},
		}), supervisor);
		assert.equal(supervisor.handle?.pid === undefined, false);
		assert.equal(result.state, 'interrupted');
		assert.equal(result.cleanupVerified, false);
		assert.match(result.reason ?? '', /could not complete PR text generation safely/u);
		assert.doesNotMatch(result.reason ?? '', /supervisor threw after returning the owned process handle/u);
		assert.ok(executionCwd);
		assert.ok(recoverySocket);
		assert.equal(await access(executionCwd).then(() => true), true, 'an unverified owned process keeps its private recovery directory');
		await waitForPath(recoverySocket, 'the owned helper to bind its exact recovery socket');
		assert.equal(await access(recoverySocket).then(() => true), true, 'the durable receipt endpoint remains available for exact recovery');
		supervisor.handle?.cancel();
		assert.equal((await supervisor.handle!.result).cleanupVerified, true);
		await rm(executionCwd, { recursive: true, force: false });
		await assertMissing(executionCwd);
	} finally {
		let cleanupVerified = supervisor.handle === undefined && executionCwd === undefined;
		if (supervisor.handle) {
			supervisor.handle.cancel();
			cleanupVerified = (await supervisor.handle.result).cleanupVerified;
		}
		if (!cleanupVerified) throw new Error('Owned provider cleanup is unverified; preserving its recovery directory and fixture.');
		if (executionCwd) await rm(executionCwd, { recursive: true, force: true });
		await rm(fixture.root, { recursive: true, force: true });
	}
});
