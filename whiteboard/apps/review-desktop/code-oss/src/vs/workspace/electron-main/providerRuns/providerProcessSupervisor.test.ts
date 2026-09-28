/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isOwnedProcessGroupGone, isProviderMutatingPlatformSupported, isProviderProcessPlatformSupported, ProviderProcessSupervisor } from './providerProcessSupervisor.js';
import { PROVIDER_MAX_FINAL_TEXT_BYTES, type ProviderCommandSpec, type ProviderRunEvent, type ProviderRunRequest } from './providerRunTypes.js';

const request: ProviderRunRequest = {
	providerId: 'codex',
	attemptId: 'attempt-test',
	cwd: process.cwd(),
	prompt: 'test prompt',
	profileDirectory: '/tmp/provider-profile-test',
	permissionPolicy: { mode: 'read-only', approval: 'never' },
	preflight: async () => ({ allowed: true, cwdIdentity: 'test-directory-identity', policyProof: 'test-read-only-policy' }),
};

function spec(script: string, parseEvent: ProviderCommandSpec['parseEvent'], extraArgs: readonly string[] = []): ProviderCommandSpec {
	return {
		executable: process.execPath,
		args: ['-e', script, ...extraArgs],
		parseEvent,
	};
}

test('fails closed on Windows where owned process-tree termination is unavailable', () => {
	assert.equal(isProviderProcessPlatformSupported('win32'), false);
	assert.equal(isProviderProcessPlatformSupported('darwin'), true);
	assert.equal(isProviderProcessPlatformSupported('linux'), true);
});

test('streams parsed lines and succeeds only after a provider terminal event and exit 0', async () => {
	const events: ProviderRunEvent[] = [];
	let persistedPgid: number | undefined;
	const handle = await new ProviderProcessSupervisor().run(
		request,
		spec(
			`process.stdout.write(JSON.stringify({type:'progress',metadata:{count:1}})+'\\n'); process.stdout.write(JSON.stringify({type:'done',terminalState:'succeeded'})+'\\n');`,
			(line) => {
				const parsed = JSON.parse(line) as { type: string; metadata?: Record<string, number>; terminalState?: 'succeeded' };
				return {
					event: { type: parsed.type, metadata: parsed.metadata },
					terminalState: parsed.terminalState,
				};
			},
		),
		(event) => {
			assert.ok(persistedPgid, 'provider output starts only after the owned PGID callback completes');
			events.push(event);
		},
		pgid => { persistedPgid = pgid; },
	);
	const result = await handle.result;
	assert.equal(result.state, 'succeeded', JSON.stringify(result));
	assert.equal(events.length, 2);
	assert.equal(events[0].attemptId, request.attemptId);
	assert.equal(events[0].metadata?.count, 1);
});

test('abort while durable process ownership is being recorded prevents GO and provider execution', async () => {
	const temp = mkdtempSync(join(tmpdir(), 'provider-launch-abort-'));
	const sentinel = join(temp, 'provider-ran');
	const controller = new AbortController();
	let notifySpawned!: () => void;
	let allowOwnershipWrite!: () => void;
	const spawned = new Promise<void>(resolve => notifySpawned = resolve);
	const ownershipWrite = new Promise<void>(resolve => allowOwnershipWrite = resolve);
	try {
		const pendingRun = new ProviderProcessSupervisor().run(
			{ ...request, signal: controller.signal },
			spec(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran'); process.stdout.write('provider ran\\n');`, line => ({ event: { type: line } })),
			() => assert.fail('provider must not execute before the launch gate receives GO'),
			async () => { notifySpawned(); await ownershipWrite; },
		);
		await spawned;
		controller.abort();
		allowOwnershipWrite();
		const handle = await pendingRun;
		const result = await handle.result;
		assert.equal(handle.pid, undefined);
		assert.equal(result.state, 'cancelled');
		assert.equal(result.cleanupVerified, true);
		assert.equal(existsSync(sentinel), false);
	} finally { rmSync(temp, { recursive: true, force: true }); }
});

test('cancels only the owned benign child and reports cancelled', async () => {
	let notifyReady!: () => void;
	const ready = new Promise<void>((resolve) => notifyReady = resolve);
	const handle = await new ProviderProcessSupervisor({ cancelGraceMs: 100 }).run(
		request,
		spec('process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);', (line) => ({ event: { type: line } })),
		() => notifyReady(),
		() => undefined,
	);
	assert.ok(handle.pid);
	await Promise.race([
		ready,
		new Promise<void>((_, reject) => setTimeout(() => reject(new Error('child did not become ready')), 2_000)),
	]);
	handle.cancel();
	const result = await handle.result;
	assert.equal(result.state, 'cancelled');
	assert.equal(result.signal, 'SIGKILL');
});

test('escalates the owned process group after its parent closes on TERM', { skip: process.platform === 'win32' }, async (t) => {
	let notifyHelperReady!: () => void;
	let helperPid: number | undefined;
	const helperReady = new Promise<void>((resolve) => notifyHelperReady = resolve);
	const handle = await new ProviderProcessSupervisor({ cancelGraceMs: 100 }).run(
		request,
		spec(
			`const { spawn } = require('node:child_process'); const helper = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write('helper:' + helper.pid + '\\n'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`,
			(line) => ({ event: { type: line } }),
		),
		(event) => {
			const match = /^helper:(\d+)$/.exec(event.type);
			if (match) {
				helperPid = Number(match[1]);
				notifyHelperReady();
			}
		},
		() => undefined,
	);
	assert.ok(handle.pid);
	t.after(() => {
		if (!handle.pid) return;
		try { process.kill(-handle.pid, 'SIGKILL'); } catch { /* The test-owned process group has already exited. */ }
	});
	await Promise.race([
		helperReady,
		new Promise<void>((_, reject) => setTimeout(() => reject(new Error('forked child did not become ready')), 2_000)),
	]);
	assert.ok(helperPid);
	handle.cancel();
	const result = await handle.result;
	assert.equal(result.state, 'cancelled');
	assert.equal(result.cleanupVerified, true);
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			process.kill(-handle.pid, 0);
			await new Promise((resolve) => setTimeout(resolve, 25));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
			throw error;
		}
	}
	assert.fail(`owned process group ${handle.pid} remained after cancellation cleanup`);
});

test('a provider parent that exits successfully cannot leave an owned helper behind', { skip: process.platform === 'win32' }, async (t) => {
	let notifyHelperReady!: () => void;
	const helperReady = new Promise<void>((resolve) => notifyHelperReady = resolve);
	const handle = await new ProviderProcessSupervisor({ cancelGraceMs: 100 }).run(
		request,
		spec(
			`const { spawn } = require('node:child_process'); const helper = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' }); helper.unref(); process.stdout.write('helper:' + helper.pid + '\\n'); process.stdout.write('succeeded\\n');`,
			(line) => line === 'succeeded' ? { terminalState: 'succeeded' } : { event: { type: line } },
		),
		(event) => { if (event.type.startsWith('helper:')) notifyHelperReady(); },
		() => undefined,
	);
	assert.ok(handle.pid);
	t.after(() => {
		if (!handle.pid) return;
		try { process.kill(-handle.pid, 'SIGKILL'); } catch { /* The test-owned process group has already exited. */ }
	});
	await Promise.race([
		helperReady,
		new Promise<void>((_, reject) => setTimeout(() => reject(new Error('owned helper did not become ready')), 2_000)),
	]);
	const result = await handle.result;
	assert.equal(result.state, 'succeeded');
	assert.equal(result.cleanupVerified, true);
	assert.throws(() => process.kill(-handle.pid!, 0), { code: 'ESRCH' });
});

test('guardian loss with a surviving child leaves cleanup unverified', { skip: process.platform === 'win32' }, async (t) => {
	let helperPid: number | undefined;
	let providerPid: number | undefined;
	let guardianPid: number | undefined;
	let notifyHelperReady!: () => void;
	const helperReady = new Promise<void>(resolve => notifyHelperReady = resolve);
	t.after(async () => {
		if (helperPid !== undefined) {
			try { process.kill(helperPid, 'SIGKILL'); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
			}
		}
		if (guardianPid !== undefined) {
			for (let attempt = 0; attempt < 80 && !isOwnedProcessGroupGone(guardianPid); attempt++) await delay(25);
			assert.equal(isOwnedProcessGroupGone(guardianPid), true, 'test-owned helper process group should be gone after PID cleanup');
		}
	});
	const handle = await new ProviderProcessSupervisor().run(
		request,
		spec(
			`const { spawn } = require('node:child_process'); const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); helper.unref(); process.stdout.write('provider:' + process.pid + '\\nhelper:' + helper.pid + '\\n'); setInterval(() => {}, 1000);`,
			line => ({ event: { type: line } }),
		),
		event => {
			if (event.type.startsWith('provider:')) providerPid = Number(event.type.slice('provider:'.length));
			if (event.type.startsWith('helper:')) {
				helperPid = Number(event.type.slice('helper:'.length));
				// The leader is known to be alive from the persisted launch callback.
				// Kill only that PID, then the provider PID; the helper remains alive.
				if (guardianPid !== undefined) process.kill(guardianPid, 'SIGKILL');
				if (providerPid !== undefined) process.kill(providerPid, 'SIGKILL');
				notifyHelperReady();
			}
		},
		pgid => { guardianPid = pgid; },
	);
	assert.ok(handle.pid);
	await Promise.race([
		helperReady,
		new Promise<void>((_, reject) => setTimeout(() => reject(new Error('owned helper did not become ready')), 2_000)),
	]);
	const result = await handle.result;
	assert.equal(result.state, 'interrupted');
	assert.equal(result.cleanupVerified, false);
});

test('guardian loss with inherited child stdio settles while leaving cleanup unverified', { skip: process.platform === 'win32' }, async (t) => {
	let helperPid: number | undefined;
	let providerPid: number | undefined;
	let guardianPid: number | undefined;
	let lateOutputSeen = false;
	let helperReceivedTerm = false;
	let notifyHelperReady!: () => void;
	const helperReady = new Promise<void>(resolve => notifyHelperReady = resolve);
	t.after(async () => {
		if (helperPid === undefined) return;
		try { process.kill(helperPid, 'SIGKILL'); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
		}
		if (guardianPid !== undefined) {
			for (let attempt = 0; attempt < 80 && !isOwnedProcessGroupGone(guardianPid); attempt++) await delay(25);
			assert.equal(isOwnedProcessGroupGone(guardianPid), true, 'test-owned inherited-stdio helper group should be gone after PID cleanup');
		}
	});
	const handle = await new ProviderProcessSupervisor().run(
		request,
		spec(
			`const { spawn } = require('node:child_process'); const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => console.log('helper-term')); setTimeout(() => console.log('late-descendant-output'), 150); setInterval(() => {}, 1000)"], { stdio: 'inherit' }); helper.unref(); process.stdout.write('provider:' + process.pid + '\\nhelper:' + helper.pid + '\\n'); setInterval(() => {}, 1000);`,
			line => ({ event: { type: line } }),
		),
		event => {
			if (event.type === 'late-descendant-output') lateOutputSeen = true;
			if (event.type === 'helper-term') helperReceivedTerm = true;
			if (event.type.startsWith('provider:')) providerPid = Number(event.type.slice('provider:'.length));
			if (event.type.startsWith('helper:')) {
				helperPid = Number(event.type.slice('helper:'.length));
				if (guardianPid !== undefined) process.kill(guardianPid, 'SIGKILL');
				if (providerPid !== undefined) process.kill(providerPid, 'SIGKILL');
				notifyHelperReady();
			}
		},
		pgid => { guardianPid = pgid; },
	);
	assert.ok(handle.pid);
	await Promise.race([
		helperReady,
		new Promise<void>((_, reject) => setTimeout(() => reject(new Error('owned helper did not become ready')), 2_000)),
	]);
	for (let attempt = 0; attempt < 80; attempt++) {
		try {
			process.kill(guardianPid!, 0);
			await delay(25);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
			break;
		}
	}
	assert.throws(() => process.kill(guardianPid!, 0), { code: 'ESRCH' }, 'guardian must be gone before cancellation is requested');
	handle.cancel();
	await delay(100);
	assert.equal(helperReceivedTerm, false, 'late cancellation must not signal the unowned process group');
	const result = await Promise.race([
		handle.result,
		delay(3_500).then(() => undefined),
	]);
	assert.ok(result, 'guardian exit must settle after the bounded stdio drain');
	assert.equal(result.state, 'interrupted');
	assert.equal(result.cleanupVerified, false);
	assert.equal(lateOutputSeen, true, 'output written by the inherited-stdio descendant during the drain must be parsed');
	assert.doesNotThrow(() => process.kill(helperPid!, 0), 'the inherited helper must remain alive until test teardown');
});

test('in-flight group termination does not escalate after guardian loss', { skip: process.platform === 'win32' }, async (t) => {
	let helperPid: number | undefined;
	let providerPid: number | undefined;
	let guardianPid: number | undefined;
	let notifyHelperReady!: () => void;
	let notifyHelperTerm!: () => void;
	let providerKillAttempted = false;
	const helperReady = new Promise<void>(resolve => notifyHelperReady = resolve);
	const helperTerm = new Promise<void>(resolve => notifyHelperTerm = resolve);
	let heartbeatCount = 0;
	t.after(async () => {
		for (const pid of [helperPid, providerKillAttempted ? undefined : providerPid]) {
			if (pid === undefined) continue;
			try { process.kill(pid, 'SIGKILL'); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
			}
		}
		if (guardianPid !== undefined) {
			for (let attempt = 0; attempt < 160 && !isOwnedProcessGroupGone(guardianPid); attempt++) await delay(25);
			assert.equal(isOwnedProcessGroupGone(guardianPid), true, 'test-owned in-flight helper group should be gone after PID cleanup');
		}
	});
	const helperScript = "process.on('SIGTERM', () => console.log('helper-term')); console.log('helper-ready'); setInterval(() => console.log('helper-heartbeat'), 20)";
	const handle = await new ProviderProcessSupervisor({ cancelGraceMs: 100 }).run(
		request,
		spec(
			`const { spawn } = require('node:child_process'); process.on('SIGTERM', () => {}); const helper = spawn(process.execPath, ['-e', ${JSON.stringify(helperScript)}], { stdio: 'inherit' }); helper.unref(); process.stdout.write('provider:' + process.pid + '\\nhelper:' + helper.pid + '\\n'); setInterval(() => {}, 1000);`,
			line => ({ event: { type: line } }),
		),
		event => {
			if (event.type.startsWith('provider:')) providerPid = Number(event.type.slice('provider:'.length));
			if (event.type.startsWith('helper:')) {
				helperPid = Number(event.type.slice('helper:'.length));
			}
			if (event.type === 'helper-ready') notifyHelperReady();
			if (event.type === 'helper-heartbeat') heartbeatCount++;
			if (event.type === 'helper-term') {
				notifyHelperTerm();
				if (guardianPid !== undefined) process.kill(guardianPid, 'SIGKILL');
				if (providerPid !== undefined) {
					providerKillAttempted = true;
					process.kill(providerPid, 'SIGKILL');
				}
			}
		},
		pgid => { guardianPid = pgid; },
	);
	assert.ok(handle.pid);
	await Promise.race([
		helperReady,
		new Promise<void>((_, reject) => setTimeout(() => reject(new Error('owned helper did not become ready')), 2_000)),
	]);
	handle.cancel();
	await Promise.race([
		helperTerm,
		new Promise<void>((_, reject) => setTimeout(() => reject(new Error('owned helper did not receive the initial TERM')), 2_000)),
	]);
	const heartbeatCountAfterTerm = heartbeatCount;
	await delay(300);
	assert.ok(heartbeatCount > heartbeatCountAfterTerm, 'the helper must remain alive after guardian loss and the cleanup grace period');
	const result = await Promise.race([handle.result, delay(3_500).then(() => undefined)]);
	assert.ok(result, 'guardian exit must settle after the bounded stdio drain');
	assert.equal(result.state, 'interrupted');
	assert.equal(result.cleanupVerified, false);
});

test('a closed launch gate is handled as a failed launch without executing provider input', { skip: process.platform === 'win32' }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'provider-launch-early-close-'));
	const marker = join(directory, 'provider-started');
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const handle = await new ProviderProcessSupervisor().run(
		request,
		spec(`require('node:fs').writeFileSync(process.argv[1], 'started');`, () => ({}), [marker]),
		() => undefined,
		async pgid => {
			// Simulate the child closing fd3 before the parent writes GO.
			process.kill(pgid, 'SIGKILL');
			for (let attempt = 0; attempt < 80 && !isOwnedProcessGroupGone(pgid); attempt++) await delay(25);
			assert.equal(isOwnedProcessGroupGone(pgid), true);
		},
	);
	const result = await handle.result;
	assert.equal(result.state, 'failed');
	assert.match(result.error ?? '', /launch gate closed/);
	assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
});

test('mutating execution is macOS-only and requires an explicit native bound-helper invocation', async () => {
	const mutatingRequest: ProviderRunRequest = {
		...request,
		permissionPolicy: { mode: 'mutating', approval: 'on-request' },
	};
	assert.equal(isProviderMutatingPlatformSupported('darwin'), true);
	assert.equal(isProviderMutatingPlatformSupported('linux'), false);
	assert.equal(isProviderMutatingPlatformSupported('win32'), false);
	const handle = await new ProviderProcessSupervisor().run(
		mutatingRequest,
		spec('process.exit(0);', () => ({})),
		() => undefined,
		() => undefined,
	);
	const result = await handle.result;
	assert.equal(handle.pid, undefined);
	assert.equal(result.state, 'failed');
	assert.match(result.error ?? '', process.platform === 'darwin' ? /native bound-checkout helper/ : /macOS native bound-checkout helper/);
});

test('sends private input through stdin and filters inherited and non-profile environment values', async () => {
	const events: ProviderRunEvent[] = [];
	const handle = await new ProviderProcessSupervisor().run(
		request,
		{
			executable: process.execPath,
			args: ['-e', 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.stringify({input, env: process.env})))'],
			stdin: 'private prompt starting --as-a-flag',
			env: { CODEX_HOME: '/selected/profile', ANTHROPIC_API_KEY: 'must-not-pass' },
			parseEvent: (line) => {
				const parsed = JSON.parse(line) as { input: string; env: NodeJS.ProcessEnv };
				return { event: { type: 'launch', metadata: { input: parsed.input, profile: parsed.env.CODEX_HOME ?? '', apiKeyLeaked: Boolean(parsed.env.ANTHROPIC_API_KEY) } }, terminalState: 'succeeded' };
			},
		},
		(event) => events.push(event),
		() => undefined,
	);
	const result = await handle.result;
	assert.equal(result.state, 'succeeded');
	assert.deepEqual(events[0].metadata, { input: 'private prompt starting --as-a-flag', profile: '/selected/profile', apiKeyLeaked: false });
});

test('passes USER only to Claude with its selected authentication profile', async () => {
	const events: ProviderRunEvent[] = [];
	const claudeHandle = await new ProviderProcessSupervisor().run(
		{ ...request, providerId: 'claude' },
		{
			executable: process.execPath,
			args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
			env: { CLAUDE_CONFIG_DIR: '/selected/claude-profile', OPENAI_API_KEY: 'must-not-pass' },
			parseEvent: line => {
				const childEnv = JSON.parse(line) as NodeJS.ProcessEnv;
				return { event: { type: 'launch', metadata: { user: childEnv.USER ?? '', profile: childEnv.CLAUDE_CONFIG_DIR ?? '', unrelatedSecretLeaked: Boolean(childEnv.OPENAI_API_KEY) } }, terminalState: 'succeeded' };
			},
		},
		event => events.push(event),
		() => undefined,
	);
	assert.equal((await claudeHandle.result).state, 'succeeded');
	assert.deepEqual(events[0].metadata, {
		user: process.env.USER ?? '',
		profile: '/selected/claude-profile',
		unrelatedSecretLeaked: false,
	});
});

test('captures only an explicitly requested bounded final answer', async () => {
	const spec = (answer: string): ProviderCommandSpec => ({
		executable: process.execPath,
		args: ['-e', 'process.stdout.write("answer\\n");'],
		parseEvent: () => ({ terminalState: 'succeeded', finalText: answer }),
	});
	const ordinary = await new ProviderProcessSupervisor().run(request, spec('hidden'), () => undefined, () => undefined);
	assert.equal((await ordinary.result).finalText, undefined);
	const captured = await new ProviderProcessSupervisor().run({ ...request, captureFinalText: true }, spec('reviewable markdown'), () => undefined, () => undefined);
	const result = await captured.result;
	assert.equal(result.state, 'succeeded');
	assert.equal(result.finalText, 'reviewable markdown');
	const oversized = await new ProviderProcessSupervisor().run(
		{ ...request, captureFinalText: true }, spec('x'.repeat(PROVIDER_MAX_FINAL_TEXT_BYTES + 1)), () => undefined, () => undefined,
	);
	const oversizedResult = await oversized.result;
	assert.equal(oversizedResult.state, 'failed');
	assert.match(oversizedResult.error ?? '', /final text exceeded/);
});

test('fails a nonzero process exit even if the adapter reports provider success', async () => {
	const handle = await new ProviderProcessSupervisor().run(
		request,
		spec('process.stdout.write("succeeded\\n"); process.exit(7);', (line) => ({ terminalState: line === 'succeeded' ? 'succeeded' : undefined })),
		() => undefined,
		() => undefined,
	);
	const result = await handle.result;
	assert.equal(result.state, 'failed');
	assert.equal(result.exitCode, 7);
});

test('terminates and fails closed on a provider line larger than the configured bound', async () => {
	const handle = await new ProviderProcessSupervisor({ maxLineBytes: 32, cancelGraceMs: 100 }).run(
		request,
		spec('process.stdout.write("x".repeat(128)); setInterval(() => {}, 1000);', () => ({})),
		() => undefined,
		() => undefined,
	);
	const result = await handle.result;
	assert.equal(result.state, 'failed');
	assert.match(result.error ?? '', /line larger than the configured limit/);
});

test('does not execute the provider when the persisted-PGID gate callback fails', { skip: process.platform === 'win32' }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'provider-launch-gate-'));
	const marker = join(directory, 'provider-started');
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const handle = await new ProviderProcessSupervisor({ cancelGraceMs: 100 }).run(
		request,
		spec(`require('node:fs').writeFileSync(process.argv[1], 'started');`, () => ({}), [marker]),
		() => undefined,
		() => { throw new Error('database persistence failed'); },
	);
	const result = await handle.result;
	assert.equal(handle.pid, undefined);
	assert.equal(result.cleanupVerified, true);
	assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
});

test('controlled macOS launch persists nonce and binds its socket before provider output', { skip: process.platform !== 'darwin' }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'provider-controlled-launch-'));
	chmodSync(directory, 0o700);
	const socketPath = join(directory, 'control.sock');
	const helperScript = fileURLToPath(new URL('../../../../../../scripts/provider-group-control.mjs', import.meta.url));
	const nonce = 'a'.repeat(64);
	let callbackPgid: number | undefined;
	let callbackNonce: string | undefined;
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const events: string[] = [];
	const handle = await new ProviderProcessSupervisor().run(
		{ ...request, recoveryControl: { nodeExecutable: process.execPath, helperScript, socketPath, nonce } },
		spec('process.stdout.write(require("node:fs").existsSync(process.argv[1]) ? "socket-ready\\n" : "socket-missing\\n"); process.stdout.write("succeeded\\n");', line => line === 'succeeded' ? { terminalState: 'succeeded' } : { event: { type: line } }, [socketPath]),
		event => events.push(event.type),
		(pgid, persistedNonce) => { callbackPgid = pgid; callbackNonce = persistedNonce; },
	);
	const result = await handle.result;
	assert.equal(callbackPgid, handle.pid);
	assert.equal(callbackNonce, nonce);
	assert.deepEqual(events, ['socket-ready']);
	assert.equal(result.state, 'succeeded');
	assert.equal(result.cleanupVerified, true);
});

test('controlled launch does not start its helper when durable ownership persistence fails', { skip: process.platform !== 'darwin' }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'provider-controlled-fail-closed-'));
	chmodSync(directory, 0o700);
	const socketPath = join(directory, 'control.sock');
	const providerMarker = join(directory, 'provider-started');
	const helperScript = fileURLToPath(new URL('../../../../../../scripts/provider-group-control.mjs', import.meta.url));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const handle = await new ProviderProcessSupervisor({ cancelGraceMs: 100 }).run(
		{ ...request, recoveryControl: { nodeExecutable: process.execPath, helperScript, socketPath, nonce: 'b'.repeat(64) } },
		spec(`require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'started');`, () => ({})),
		() => assert.fail('provider output must not be produced'),
		() => { throw new Error('durable persistence failed'); },
	);
	const result = await handle.result;
	assert.equal(handle.pid, undefined);
	assert.equal(result.cleanupVerified, true);
	assert.equal(existsSync(socketPath), false, 'the helper must not bind before persistence succeeds and GO is sent');
	assert.equal(existsSync(providerMarker), false, 'the provider must not start before persistence succeeds and GO is sent');
});

test('controlled shell kills its owned group if the helper exits with a surviving descendant', { skip: process.platform !== 'darwin' }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'provider-controlled-helper-loss-'));
	chmodSync(directory, 0o700);
	const helperPath = join(directory, 'helper.mjs');
	const childPidPath = join(directory, 'child.pid');
	const descendantIdentity = `provider-orphan-${process.pid}-${Date.now()}`;
	const helperSource = `
		import { spawn } from 'node:child_process';
		import { writeFileSync } from 'node:fs';
	const child = spawn(process.execPath, ['-e', ${JSON.stringify(`process.on("SIGTERM", () => {}); setInterval(() => { void ${JSON.stringify(descendantIdentity)}; }, 1000)`)}], { stdio: 'ignore' });
		child.unref();
		writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
		process.exit(0);
	`;
	writeFileSync(helperPath, helperSource);
	let pgid: number | undefined;
	let childPid: number | undefined;
	const commandForPid = (pid: number): string => {
		try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); }
		catch (error) {
			if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) return '';
			throw error;
		}
	};
	const descendantIsStillTestOwned = (): boolean => childPid !== undefined && commandForPid(childPid).includes(descendantIdentity);
	t.after(async () => {
		if (childPid === undefined && existsSync(childPidPath)) childPid = Number(readFileSync(childPidPath, 'utf8'));
		if (pgid !== undefined && !isOwnedProcessGroupGone(pgid)) {
			if (descendantIsStillTestOwned()) {
				process.kill(childPid!, 'SIGTERM');
				for (let attempt = 0; attempt < 8 && descendantIsStillTestOwned(); attempt++) await delay(25);
				if (descendantIsStillTestOwned()) process.kill(childPid!, 'SIGKILL');
			}
			for (let attempt = 0; attempt < 80 && !isOwnedProcessGroupGone(pgid); attempt++) await delay(25);
			assert.equal(isOwnedProcessGroupGone(pgid), true, 'test-owned group should be gone after exact descendant cleanup');
		}
		rmSync(directory, { recursive: true, force: true });
	});
	const handle = await new ProviderProcessSupervisor().run(
		{ ...request, attemptId: `orphan-test-${process.pid}-${Date.now()}`, recoveryControl: { nodeExecutable: process.execPath, helperScript: helperPath, socketPath: join(directory, 'control.sock'), nonce: 'c'.repeat(64) } },
		spec('process.stdout.write("provider-ran\\n");', line => ({ event: { type: line } })),
		() => undefined,
		ownedPgid => { pgid = ownedPgid; },
	);
	const result = await handle.result;
	childPid = Number(readFileSync(childPidPath, 'utf8'));
	assert.equal(result.cleanupVerified, true);
	assert.equal(isOwnedProcessGroupGone(pgid!), true, 'the pinned shell must terminate all members when its helper exits');
	assert.throws(() => process.kill(childPid!, 0), { code: 'ESRCH' }, 'helper descendant must not survive its helper');
});

test('a parent crash closes the gate pipe before provider execution', { skip: process.platform === 'win32' }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), 'provider-launch-crash-gate-'));
	const marker = join(directory, 'provider-started');
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const supervisorUrl = new URL('./providerProcessSupervisor.js', import.meta.url).href;
	const providerScript = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`;
	const source = `
		import { ProviderProcessSupervisor } from ${JSON.stringify(supervisorUrl)};
		const request = { providerId: 'codex', attemptId: 'crash-gate', cwd: process.cwd(), prompt: 'private', profileDirectory: '/tmp/profile', permissionPolicy: { mode: 'read-only', approval: 'never' }, preflight: async () => ({ allowed: true, cwdIdentity: 'test-root', policyProof: 'read-only' }) };
		const spec = { executable: process.execPath, args: ['-e', ${JSON.stringify(providerScript)}], parseEvent: () => ({}) };
		await new ProviderProcessSupervisor().run(request, spec, () => {}, async pid => { process.stdout.write('GATE_PGID:' + pid + '\\n'); await new Promise(() => {}); });
	`;
	const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '';
	parent.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
	let resolveGate!: (pid: number) => void;
	const gatePid = new Promise<number>(resolve => resolveGate = resolve);
	const poll = setInterval(() => {
		const match = /GATE_PGID:(\d+)/.exec(stdout);
		if (match) { clearInterval(poll); resolveGate(Number(match[1])); }
	}, 10);
	t.after(() => clearInterval(poll));
	const pgid = await Promise.race([
		gatePid,
		new Promise<number>((_, reject) => setTimeout(() => reject(new Error('launch gate did not reach PGID persistence')), 3_000)),
	]);
	t.after(() => { if (!isOwnedProcessGroupGone(pgid)) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* Test-owned group already exited. */ } } });
	parent.kill('SIGKILL');
	await new Promise<void>((resolve, reject) => { parent.once('error', reject); parent.once('close', () => resolve()); });
	for (let attempt = 0; attempt < 80 && !isOwnedProcessGroupGone(pgid); attempt++) {
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	assert.equal(isOwnedProcessGroupGone(pgid), true);
	assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
});
