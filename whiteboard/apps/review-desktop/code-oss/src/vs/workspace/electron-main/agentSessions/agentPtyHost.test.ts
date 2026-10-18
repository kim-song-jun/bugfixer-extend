/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const GUARDIAN_PATH = fileURLToPath(new URL('./pty/agentPtyGuardian.mjs', import.meta.url));

test('PTY guardian authenticates over a loopback port and the closed listener refuses new connections', async () => {
	const connections = new Set<Socket>();
	const server = createServer();
	await listen(server);
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	assert.equal(address.address, '127.0.0.1');
	assert.ok(address.port >= 1 && address.port <= 65_535);
	const capability = randomBytes(32).toString('hex');
	let guardian: ChildProcess | undefined;
	let helloBuffer = '';
	let resolveHello!: (message: Record<string, unknown>) => void;
	let rejectHello!: (error: Error) => void;
	const hello = new Promise<Record<string, unknown>>((resolve, reject) => { resolveHello = resolve; rejectHello = reject; });
	const helloTimeout = setTimeout(() => rejectHello(new Error('The PTY guardian did not authenticate before the test deadline.')), 5_000);
	server.on('connection', socket => {
		connections.add(socket);
		socket.once('close', () => connections.delete(socket));
		socket.on('data', chunk => {
			helloBuffer += chunk.toString('utf8');
			const newline = helloBuffer.indexOf('\n');
			if (newline < 0) { return; }
			try { resolveHello(JSON.parse(helloBuffer.slice(0, newline)) as Record<string, unknown>); }
			catch (error) { rejectHello(error instanceof Error ? error : new Error(String(error))); }
		});
	});

	try {
		guardian = spawn(process.execPath, [GUARDIAN_PATH, String(address.port), capability], { detached: true, stdio: 'ignore' });
		guardian.once('error', error => rejectHello(error));
		const message = await hello;
		clearTimeout(helloTimeout);
		assert.deepEqual(Object.keys(message).sort(), ['capability', 'event', 'pid']);
		assert.equal(message.event, 'hello');
		assert.equal(message.capability, capability);
		assert.equal(message.pid, guardian.pid);
	} finally {
		clearTimeout(helloTimeout);
		for (const socket of connections) { socket.destroy(); }
		await closeServer(server);
		if (guardian?.pid) {
			await waitForChildExit(guardian, 3_000);
			if (guardian.exitCode === null && guardian.signalCode === null) {
				try { process.kill(-guardian.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
				await waitForChildExit(guardian, 2_000);
			}
		}
	}

	await assert.rejects(connectLoopback(address.port), error => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED');
});

async function listen(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
	});
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) { return; }
	await new Promise<void>((resolve, reject) => {
		server.close(error => error ? reject(error) : resolve());
	});
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) { return; }
	await new Promise<void>(resolve => {
		const onExit = () => { clearTimeout(timer); resolve(); };
		const timer = setTimeout(() => { child.off('exit', onExit); resolve(); }, timeoutMs);
		child.once('exit', onExit);
	});
}

function connectLoopback(port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port });
		socket.once('connect', () => resolve(socket));
		socket.once('error', reject);
	});
}
