/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';

const MAX_CONTROL_BYTES = 256 * 1024;
const TERM_GRACE_MS = 250;
const MAX_QUEUED_OUTPUT_BYTES = 512 * 1024;
const OUTPUT_CHUNK_BYTES = 48 * 1024;
const OUTPUT_DRAIN_TIMEOUT_MS = 500;
let provider;
let startAccepted = false;
let cleanupStarted = false;
let outputFailure;
let providerExit;
let stdoutClosed = false;
let stderrClosed = false;
let totalOutputBytes = 0;
let queuedOutputBytes = 0;
let outputQueue = [];
let sendingOutput = false;
let outputDrainTimer;
let completionSending = false;

function send(message, callback) {
	if (!process.connected) { return false; }
	try { return process.send(message, callback) !== false; }
	catch { return false; }
}

function validStart(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
	if (Object.keys(value).sort().join(',') !== 'args,command,env,executable,maxOutputBytes') { return false; }
	if (value.command !== 'start' || typeof value.executable !== 'string' || value.executable.length === 0 || value.executable.length > 4096 || /[\u0000-\u001f\u007f]/.test(value.executable)) { return false; }
	if (!Number.isSafeInteger(value.maxOutputBytes) || value.maxOutputBytes < 1 || value.maxOutputBytes > 1024 * 1024) { return false; }
	if (!Array.isArray(value.args) || value.args.length > 32 || value.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg))
		|| value.args.reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8'), 0) > 64 * 1024) { return false; }
	if (!value.env || typeof value.env !== 'object' || Array.isArray(value.env) || Object.keys(value.env).length > 64) { return false; }
	return Object.entries(value.env).every(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === 'string' && !/[\u0000-\u001f\u007f]/.test(item))
		&& Object.entries(value.env).reduce((total, [key, item]) => total + Buffer.byteLength(key, 'utf8') + Buffer.byteLength(item, 'utf8'), 0) <= 128 * 1024;
}

function signalOwnedGroup(signal) {
	try { process.kill(-process.pid, signal); return true; }
	catch (error) { return error?.code === 'ESRCH'; }
}

function cleanupOwnedGroup() {
	if (cleanupStarted) { return; }
	cleanupStarted = true;
	signalOwnedGroup('SIGTERM');
	setTimeout(() => signalOwnedGroup('SIGKILL'), TERM_GRACE_MS);
}

function forwardOutput(stream, chunk) {
	if (outputFailure || cleanupStarted) { return; }
	totalOutputBytes += chunk.byteLength;
	if (totalOutputBytes > activeMaxOutputBytes) { failOutput('CLI capability output exceeded its size limit.'); return; }
	for (let offset = 0; offset < chunk.byteLength; offset += OUTPUT_CHUNK_BYTES) {
		const part = chunk.subarray(offset, Math.min(offset + OUTPUT_CHUNK_BYTES, chunk.byteLength));
		queuedOutputBytes += part.byteLength;
		if (queuedOutputBytes > MAX_QUEUED_OUTPUT_BYTES) { failOutput('CLI capability output could not be forwarded within its bounded queue.'); return; }
		outputQueue.push({ stream, base64: part.toString('base64'), bytes: part.byteLength });
	}
	if (queuedOutputBytes > MAX_QUEUED_OUTPUT_BYTES / 2) { provider.stdout.pause(); provider.stderr.pause(); }
	drainOutputQueue();
}

let activeMaxOutputBytes = 0;

function failOutput(message) {
	if (outputFailure || cleanupStarted) { return; }
	outputFailure = message;
	provider?.stdout?.pause();
	provider?.stderr?.pause();
	outputQueue.push({ event: 'outputError', message });
	drainOutputQueue();
}

function drainOutputQueue() {
	if (sendingOutput || outputQueue.length === 0 || !process.connected) {
		if (outputQueue.length === 0) { finishProviderIfDrained(); }
		return;
	}
	sendingOutput = true;
	const item = outputQueue.shift();
	const message = item.event ? { event: item.event, message: item.message } : { event: 'output', stream: item.stream, base64: item.base64 };
	send(message, error => {
		sendingOutput = false;
		if (error) { cleanupOwnedGroup(); return; }
		queuedOutputBytes -= item.bytes ?? 0;
		if (!outputFailure && queuedOutputBytes < MAX_QUEUED_OUTPUT_BYTES / 4 && provider) {
			provider.stdout.resume();
			provider.stderr.resume();
		}
		if (item.event === 'outputError') { cleanupOwnedGroup(); return; }
		drainOutputQueue();
	});
}

function finishProviderIfDrained() {
	if (!providerExit || !stdoutClosed || !stderrClosed || sendingOutput || outputQueue.length > 0 || cleanupStarted || completionSending) { return; }
	if (outputDrainTimer) { clearTimeout(outputDrainTimer); outputDrainTimer = undefined; }
	if (outputFailure) { return; }
	completionSending = true;
	send({ event: 'complete', code: providerExit.code, signal: providerExit.signal, bytes: totalOutputBytes }, error => {
		if (error) { cleanupOwnedGroup(); return; }
		cleanupOwnedGroup();
	});
}

function handleMessage(value) {
	if (!startAccepted) {
		if (cleanupStarted || !validStart(value)) { cleanupOwnedGroup(); return; }
		startAccepted = true;
		activeMaxOutputBytes = value.maxOutputBytes;
		try {
			provider = spawn(value.executable, value.args, { env: value.env, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		} catch {
			send({ event: 'launchError' });
			cleanupOwnedGroup();
			return;
		}
		provider.stdout.on('data', chunk => forwardOutput('stdout', chunk));
		provider.stderr.on('data', chunk => forwardOutput('stderr', chunk));
		provider.stdout.once('error', () => failOutput('CLI capability stdout stream failed.'));
		provider.stderr.once('error', () => failOutput('CLI capability stderr stream failed.'));
		provider.stdout.once('close', () => { stdoutClosed = true; finishProviderIfDrained(); });
		provider.stderr.once('close', () => { stderrClosed = true; finishProviderIfDrained(); });
		provider.once('error', () => { send({ event: 'launchError' }, () => cleanupOwnedGroup()); });
		provider.once('exit', (code, signal) => {
			providerExit = { code, signal };
			outputDrainTimer = setTimeout(() => failOutput('CLI capability output streams did not drain after provider exit.'), OUTPUT_DRAIN_TIMEOUT_MS);
			finishProviderIfDrained();
		});
		return;
	}
	if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value.command === 'stop') {
		cleanupOwnedGroup();
		return;
	}
	cleanupOwnedGroup();
}

process.on('message', handleMessage);
process.once('disconnect', cleanupOwnedGroup);
process.on('SIGTERM', cleanupOwnedGroup);
process.on('SIGINT', cleanupOwnedGroup);
process.on('SIGHUP', cleanupOwnedGroup);
