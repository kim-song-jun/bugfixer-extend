/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUUID } from '../../base/common/uuid.js';

export type VaultService = 'slack' | 'notion' | 'declarative-package';

const maximumSecretBytes = 16 * 1024;
const vaultTimeoutMs = 120_000;

export function resolveKeychainVaultHelper(isPackaged: boolean, resourcesPath: string, devHelper = process.env['DEV_FAST_REVIEW_KEYCHAIN_VAULT_HELPER']): string {
	const path = isPackaged ? join(resourcesPath, 'app', 'review-runtime', 'bin', 'keychain-vault') : devHelper;
	if (!path) { throw new Error('The macOS Keychain helper is unavailable in this development launch.'); }
	const canonical = realpathSync(path);
	const stats = statSync(canonical);
	if (!stats.isFile() || (stats.mode & 0o111) === 0) { throw new Error('The macOS Keychain helper is not executable.'); }
	return canonical;
}

/** Keeps connector tokens out of argv, environment variables, workspace.db, and logs. */
export class KeychainVault {
	constructor(private readonly helperPath: string) {
		if (process.platform !== 'darwin') { throw new Error('The macOS Keychain vault is available only on macOS.'); }
	}

	async put(service: VaultService, accountId: string, secret: string): Promise<void> {
		this.validateScope(service, accountId);
		if (!isPrintableToken(secret)) { throw new Error('The connector token must be 1–16384 printable ASCII bytes without spaces.'); }
		await this.run('put', service, accountId, secret);
	}

	async get(service: VaultService, accountId: string): Promise<string | undefined> {
		this.validateScope(service, accountId);
		const output = await this.run('get', service, accountId);
		if (output === undefined) { return undefined; }
		const secret = output.toString('utf8');
		output.fill(0);
		if (!isPrintableToken(secret)) { throw new Error('The saved connector token has an invalid format.'); }
		return secret;
	}

	async delete(service: VaultService, accountId: string): Promise<void> {
		this.validateScope(service, accountId);
		await this.run('delete', service, accountId);
	}

	private validateScope(service: VaultService, accountId: string): void {
		if ((service !== 'slack' && service !== 'notion' && service !== 'declarative-package') || !isUUID(accountId)) { throw new Error('A valid connector and account ID are required.'); }
	}

	private run(operation: 'put' | 'get' | 'delete', service: VaultService, accountId: string, secret?: string): Promise<Buffer | undefined> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.helperPath, [operation, service, accountId], {
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false,
				env: { HOME: homedir(), TMPDIR: tmpdir(), LANG: 'C' },
			});
			const chunks: Buffer[] = [];
			let outputBytes = 0;
			let inputFailed = false;
			let outputExceeded = false;
			let timedOut = false;
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const timeout = setTimeout(() => {
				timedOut = true;
				child.kill('SIGTERM');
				killTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 2_000);
			}, vaultTimeoutMs);
			const finish = (error?: Error, output?: Buffer): void => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timeout);
				if (killTimer) { clearTimeout(killTimer); }
				if (error) { for (const chunk of chunks) chunk.fill(0); reject(error); }
				else { resolve(output); }
			};
			child.stdin.on('error', () => { inputFailed = true; });
			child.stdout.on('data', (chunk: Buffer) => {
				outputBytes += chunk.byteLength;
				if (outputBytes > maximumSecretBytes) { outputExceeded = true; child.kill('SIGTERM'); return; }
				chunks.push(chunk);
			});
			// The helper emits only fixed diagnostic messages; do not pass stderr to a UI or logger.
			child.stderr.resume();
			child.once('error', () => finish(new Error('The macOS Keychain helper could not start.')));
			child.once('close', code => {
				if (timedOut) { finish(new Error('The macOS Keychain operation timed out.')); return; }
				if (outputExceeded) { finish(new Error('The macOS Keychain helper returned too much data.')); return; }
				if (inputFailed) { finish(new Error('The macOS Keychain helper did not accept the token.')); return; }
				if (code === 3 && (operation === 'get' || operation === 'delete')) { finish(); return; }
				if (code !== 0) { finish(new Error('The macOS Keychain operation failed.')); return; }
				if (operation !== 'get' && outputBytes > 0) { finish(new Error('The macOS Keychain helper returned unexpected data.')); return; }
				if (operation === 'get') {
					const output = Buffer.concat(chunks);
					for (const chunk of chunks) chunk.fill(0);
					finish(undefined, output);
				}
				else { finish(); }
			});
			child.stdin.end(secret ?? '');
		});
	}
}

function isPrintableToken(value: string): boolean {
	return value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximumSecretBytes && /^[\x21-\x7e]+$/.test(value);
}
