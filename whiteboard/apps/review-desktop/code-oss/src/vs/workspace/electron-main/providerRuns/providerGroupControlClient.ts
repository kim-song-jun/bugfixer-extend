/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { mkdirSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isOwnedProcessGroupGone } from './providerProcessSupervisor.js';

const controlTimeoutMs = 2_000;
const groupExitTimeoutMs = 7_000;

export interface ProviderGroupControl {
	readonly nodeExecutable: string;
	readonly helperScript: string;
	readonly socketPath: string;
	readonly nonce: string;
}

export interface ProviderGroupRecoveryEndpoint {
	readonly socketPath: string;
	readonly nonce: string;
}

function currentUserId(): number {
	if (typeof process.getuid !== 'function') { throw new Error('Provider recovery requires a Unix user ID.'); }
	return process.getuid();
}

function validatePrivateControlDirectory(directory: string): void {
	const uid = currentUserId();
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
		throw new Error('Provider control directory is not a private directory owned by the current user.');
	}
}

export function createProviderGroupControlPaths(nodeExecutable: string, helperScript: string, attemptId: string, nonce = randomBytes(32).toString('hex')): ProviderGroupControl {
	if (process.platform !== 'darwin') { throw new Error('Authenticated provider group recovery is available only on macOS.'); }
	const uid = currentUserId();
	const directory = join('/tmp', `bfx-ctrl-${uid}`);
	try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
	}
	validatePrivateControlDirectory(directory);
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId) || !/^[a-f0-9]{64}$/.test(nonce)) { throw new Error('Invalid provider recovery control identity.'); }
	const socketPath = join(directory, attemptId);
	if (Buffer.byteLength(socketPath) > 103) { throw new Error('Provider control socket path exceeds the macOS socket path limit.'); }
	return { nodeExecutable, helperScript, socketPath, nonce };
}

export function providerGroupControlSocketPath(attemptId: string): string {
	if (process.platform !== 'darwin' || typeof process.getuid !== 'function' || !/^[A-Za-z0-9_-]{1,128}$/.test(attemptId)) {
		throw new Error('The provider control socket identity is invalid.');
	}
	const directory = join('/tmp', `bfx-ctrl-${currentUserId()}`);
	try { validatePrivateControlDirectory(directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
	}
	const socketPath = join(directory, attemptId);
	if (Buffer.byteLength(socketPath) > 103) { throw new Error('Provider control socket path exceeds the macOS socket path limit.'); }
	return socketPath;
}

export function providerGroupRecoveryEndpoint(attemptId: string, nonce: string): ProviderGroupRecoveryEndpoint {
	if (!/^[a-f0-9]{64}$/.test(nonce)) { throw new Error('The durable provider recovery nonce is invalid.'); }
	return { socketPath: providerGroupControlSocketPath(attemptId), nonce };
}

export async function cancelProviderProcessGroup(control: ProviderGroupRecoveryEndpoint, attemptId: string, pgid: number, exitTimeoutMs = groupExitTimeoutMs, signal?: AbortSignal): Promise<string | undefined> {
	validateControl(control, attemptId, pgid);
	validatePrivateControlDirectory(dirname(control.socketPath));
	const socketStat = lstatSync(control.socketPath);
	if (!socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.uid !== currentUserId() || (socketStat.mode & 0o777) !== 0o600) {
		throw new Error('The provider control socket is missing or has unsafe ownership or permissions.');
	}
	const reply = await requestCancellation(control.socketPath, JSON.stringify({ attemptId, nonce: control.nonce, command: 'cancel' }) + '\n', signal);
	if (reply !== 'accepted\n') { throw new Error('The provider control helper rejected authenticated cancellation.'); }
	const deadline = Date.now() + Math.max(0, exitTimeoutMs);
	while (!isOwnedProcessGroupGone(pgid)) {
		if (signal?.aborted) { throw new Error('Provider recovery was cancelled during shutdown.'); }
		if (Date.now() >= deadline) { throw new Error(`Provider process group ${pgid} did not exit before the recovery timeout.`); }
		await new Promise<void>(resolve => setTimeout(resolve, 50));
	}
	try { removeProviderControlSocketIfPresent(control.socketPath); }
	catch (error) { return `The verified provider group exited, but its control socket could not be removed: ${(error as Error).message}`; }
	return undefined;
}

export function removeProviderControlSocket(socketPath: string): void {
	validatePrivateControlDirectory(dirname(socketPath));
	const stat = lstatSync(socketPath);
	if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== currentUserId() || (stat.mode & 0o777) !== 0o600) {
		throw new Error('The provider control socket has unsafe ownership or permissions.');
	}
	unlinkSync(socketPath);
}

export function removeProviderControlSocketIfPresent(socketPath: string): void {
	try { removeProviderControlSocket(socketPath); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
	}
}

function validateControl(control: ProviderGroupRecoveryEndpoint, attemptId: string, pgid: number): void {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId) || !Number.isSafeInteger(pgid) || pgid < 1
		|| !/^[a-f0-9]{64}$/.test(control.nonce) || !control.socketPath.startsWith('/') || Buffer.byteLength(control.socketPath) > 103) {
		throw new Error('The durable provider recovery control record is invalid.');
	}
}

function requestCancellation(path: string, payload: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(path);
		let response = '';
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			socket.destroy();
			if (error) { reject(error); } else { resolve(response); }
		};
		const onAbort = (): void => finish(new Error('Provider recovery was cancelled during shutdown.'));
		const timer = setTimeout(() => finish(new Error('Timed out contacting the provider control helper.')), controlTimeoutMs);
		socket.once('error', error => finish(new Error(`Could not contact the provider control helper: ${error.message}`)));
		signal?.addEventListener('abort', onAbort, { once: true });
		if (signal?.aborted) { onAbort(); return; }
		socket.once('connect', () => socket.write(payload));
		socket.on('data', chunk => {
			response += chunk.toString('utf8');
			if (response.length > 16) { finish(new Error('Provider control helper returned an invalid response.')); }
			else if (response.includes('\n')) { finish(); }
		});
		socket.once('end', () => finish());
	});
}
