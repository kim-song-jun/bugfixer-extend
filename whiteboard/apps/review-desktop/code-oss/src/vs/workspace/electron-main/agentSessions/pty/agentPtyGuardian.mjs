/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const MAX_CONTROL_MESSAGE_BYTES = 256 * 1024;
const CLEANUP_GRACE_MS = 1500;
const guardianArguments = process.argv.slice(2);
const [portArgument, capability] = guardianArguments;
const port = typeof portArgument === 'string' && /^[1-9][0-9]{0,4}$/.test(portArgument) ? Number(portArgument) : NaN;
let socket;
let pending = '';
let authenticated = false;
let startAccepted = false;
let cleanupStarted = false;
let cleanupPromise;
let provider;
let providerExitSent = false;

function send(message) {
	if (!socket || socket.destroyed) { return false; }
	const encoded = `${JSON.stringify(message)}\n`;
	if (Buffer.byteLength(encoded, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) { socket.destroy(); return false; }
	return socket.write(encoded);
}

function validLaunch(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
	const keys = Object.keys(value).sort().join(',');
	// Exact host-to-guardian start schema: command, executable, args, cwd, env.
	if (keys !== 'args,command,cwd,env,executable') { return false; }
	return value.command === 'start'
		&& typeof value.executable === 'string' && value.executable.length > 0 && !value.executable.includes('\0')
		&& Array.isArray(value.args) && value.args.length <= 256 && value.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))
		&& value.args.reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8'), 0) <= 64 * 1024
		&& typeof value.cwd === 'string' && value.cwd.startsWith('/') && !value.cwd.includes('\0')
		&& value.env && typeof value.env === 'object' && !Array.isArray(value.env)
		&& Object.entries(value.env).length <= 256
		&& Object.entries(value.env).every(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === 'string' && !item.includes('\0'))
		&& Object.entries(value.env).reduce((total, [key, item]) => total + Buffer.byteLength(key, 'utf8') + Buffer.byteLength(item, 'utf8'), 0) <= 128 * 1024;
}

function terminateGroup(signal) {
	try { process.kill(-process.pid, signal); return true; }
	catch (error) { return error?.code === 'ESRCH'; }
}

function sendProviderExit(code, signal) {
	if (providerExitSent) { return; }
	providerExitSent = true;
	send({ event: 'providerExit', code, signal });
}

function sendLaunchError() {
	if (providerExitSent) { return; }
	providerExitSent = true;
	send({ event: 'launchError', code: 127 });
}

function cleanupOwnedGroup() {
	if (cleanupPromise) { return cleanupPromise; }
	cleanupStarted = true;
	cleanupPromise = (async () => {
		const termSent = terminateGroup('SIGTERM');
		if (!termSent) {
			process.exit(1);
		}
		await new Promise(resolve => setTimeout(resolve, CLEANUP_GRACE_MS));
		const killSent = terminateGroup('SIGKILL');
		if (!killSent) {
			process.exit(1);
		}
	})();
	return cleanupPromise;
}

function handleControlMessage(value) {
	if (!authenticated) {
		if (!validLaunch(value)) { socket.destroy(); return; }
		authenticated = true;
		startAccepted = true;
		try {
			provider = spawn(value.executable, value.args, {
				cwd: value.cwd,
				env: value.env,
				stdio: 'inherit',
				detached: false,
			});
		} catch {
			sendLaunchError();
			return;
		}
		provider.once('spawn', () => send({ event: 'providerStarted' }));
		provider.once('error', sendLaunchError);
		provider.once('exit', (code, signal) => {
			if (!providerExitSent) { sendProviderExit(code, signal); }
		});
		return;
	}
	if (!startAccepted || !value || typeof value !== 'object' || Array.isArray(value)) { socket.destroy(); return; }
	if (Object.keys(value).length === 1 && value.command === 'stop') {
		void cleanupOwnedGroup();
		return;
	}
	socket.destroy();
}

if (guardianArguments.length !== 2 || !Number.isSafeInteger(port) || port < 1 || port > 65_535
	|| typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability)) {
	process.exit(2);
}

socket = connect({ host: '127.0.0.1', port });
socket.once('connect', () => send({ event: 'hello', capability, pid: process.pid }));
socket.on('data', chunk => {
	pending += chunk.toString('utf8');
	if (Buffer.byteLength(pending, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) { socket.destroy(); return; }
	let newline;
	while ((newline = pending.indexOf('\n')) >= 0) {
		const line = pending.slice(0, newline);
		pending = pending.slice(newline + 1);
		let message;
		try { message = JSON.parse(line); }
		catch { socket.destroy(); return; }
		handleControlMessage(message);
	}
});
socket.on('error', () => socket.destroy());
socket.on('close', () => { void cleanupOwnedGroup(); });

process.on('SIGTERM', () => {
	if (cleanupStarted) { return; }
	send({ event: 'guardianSignal', signal: 'SIGTERM' });
});
process.on('SIGINT', () => {
	if (cleanupStarted) { return; }
	send({ event: 'guardianSignal', signal: 'SIGINT' });
});
process.on('SIGHUP', () => {
	if (cleanupStarted) { return; }
	send({ event: 'guardianSignal', signal: 'SIGHUP' });
	send({ event: 'guardianCleanup', reason: 'ptyHangup' });
	void cleanupOwnedGroup();
});
