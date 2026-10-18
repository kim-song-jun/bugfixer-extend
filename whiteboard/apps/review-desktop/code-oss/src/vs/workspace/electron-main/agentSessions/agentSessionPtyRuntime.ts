/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from 'node:path';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { AgentSessionPermissionPolicy, AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { AgentPtyHost, AgentPtyStartError, type AgentPtyAttachment, type AgentPtyHandle, type AgentPtyHostOptions, type AgentPtyLaunch, type AgentPtyOutputChunk, type AgentPtyOutputPage, type AgentPtySnapshot, type AgentPtyStopResult } from './agentPtyHost.js';
import { createAgentPtyOutputSanitizer } from './agentOutputRedactor.js';
import { AGENT_CLI_COMMAND_SPEC_VERSION } from './agentCliCapabilities.js';
import type { AgentSessionCommandSpec } from './agentSessionCommands.js';
import { AgentSessionRuntimeStartError, type AgentSessionRuntimeFactory, type AgentSessionRuntimeHandle } from './agentSessionService.js';

export interface PreparedAgentSessionPtyLaunch {
	readonly command: AgentSessionCommandSpec;
	readonly permissionPolicy: AgentSessionPermissionPolicy;
	readonly profileDirectory: string;
	readonly launch: AgentPtyLaunch;
	/** Explicit trusted launch values such as the scoped MCP capability. Never inferred from output. */
	readonly knownSecrets: readonly string[];
	/** Must be idempotent; revokes any launch-scoped bridge access and runs before PTY stop. */
	revokeAccess(): void;
	/** Must be idempotent; removes private config only after verified process cleanup. */
	releasePrivateConfig(): Promise<void>;
}

/** Preparation must clean any partial resources before rejecting and honor abort before resolving. */
export type AgentSessionPrepareLaunch = (
	snapshot: AgentSessionTurnSnapshot,
	turnId: string,
	signal: AbortSignal,
) => Promise<PreparedAgentSessionPtyLaunch>;

export interface AgentSessionPtyRuntimeOptions extends Omit<AgentPtyHostOptions, 'createSanitizer' | 'revokeAccess'> {
	/** Trusted app adapter; it resolves the selected profile and uses the versioned command builder. */
	readonly prepareLaunch: AgentSessionPrepareLaunch;
}

interface RuntimeRecord {
	host?: AgentPtyHost;
	readonly prepared: PreparedAgentSessionPtyLaunch;
	hostHandle?: AgentPtyHandle;
	accessRevoked: boolean;
	privateConfigReleased: boolean;
}

/** Per-turn bridge from trusted launch preparation to one real PTY host and its opaque capability. */
export class AgentSessionPtyRuntimeFactory implements AgentSessionRuntimeFactory {
	private readonly records = new Map<AgentSessionRuntimeHandle, RuntimeRecord>();

	constructor(private readonly options: AgentSessionPtyRuntimeOptions) {
		if (typeof options.prepareLaunch !== 'function') { throw new Error('A trusted session launch preparer is required.'); }
	}

	async start(snapshot: AgentSessionTurnSnapshot, turnId: string, signal: AbortSignal): Promise<AgentSessionRuntimeHandle> {
		if (signal.aborted) { throw new AgentSessionRuntimeStartError('The session launch was cancelled before preparation.', true); }
		let prepared: PreparedAgentSessionPtyLaunch;
		try {
			prepared = await this.options.prepareLaunch(snapshot, turnId, signal);
		} catch {
			throw new Error('Trusted session launch preparation failed; the preparer must clean partial resources before rejecting.');
		}

		const handle = Object.freeze({}) as AgentSessionRuntimeHandle;
		const record: RuntimeRecord = { prepared, accessRevoked: false, privateConfigReleased: false };
		this.records.set(handle, record);

		try {
			record.host = new AgentPtyHost({
				guardianNodeExecutable: this.options.guardianNodeExecutable,
				guardianScriptPath: this.options.guardianScriptPath,
				...(this.options.startTimeoutMs !== undefined ? { startTimeoutMs: this.options.startTimeoutMs } : {}),
				...(this.options.stopVerifyMs !== undefined ? { stopVerifyMs: this.options.stopVerifyMs } : {}),
				...(this.options.maxOutputBytes !== undefined ? { maxOutputBytes: this.options.maxOutputBytes } : {}),
				...(this.options.maxOutputChunks !== undefined ? { maxOutputChunks: this.options.maxOutputChunks } : {}),
				createSanitizer: () => createAgentPtyOutputSanitizer({ knownSecrets: [...prepared.knownSecrets] }),
				revokeAccess: () => {
					if (!this.tryRevokePreparedAccess(record)) { throw new Error('Launch-scoped access revocation failed.'); }
				},
			});
			validatePreparedLaunch(snapshot, prepared);
			if (signal.aborted) { throw new Error('The session launch was cancelled before PTY creation.'); }
			record.hostHandle = await record.host.start(prepared.launch, signal);
			return handle;
		} catch (error) {
			const startError = error instanceof AgentPtyStartError ? error : undefined;
			if (startError?.recoveryHandle) { record.hostHandle = startError.recoveryHandle; }
			let cleanupVerified = false;
			let cleanupError: string | undefined;
			try {
				const cleanup = await this.stop(handle);
				cleanupVerified = cleanup.cleanupVerified && (startError?.cleanupVerified ?? true);
				cleanupError = cleanup.error;
			} catch {
				cleanupError = 'Owned runtime cleanup could not be verified.';
			}
			if (cleanupVerified) {
				try { await this.release(handle); }
				catch {
					cleanupVerified = false;
					cleanupError = 'Owned runtime resources could not be released.';
				}
			}
			throw new AgentSessionRuntimeStartError(
				[startError?.message ?? 'Trusted session PTY startup failed.', cleanupError].filter(Boolean).join(' '),
				cleanupVerified,
				startError?.providerExitCode,
				startError?.providerExitSignal,
				cleanupVerified ? undefined : handle,
			);
		}
	}

	watchExit(handle: AgentSessionRuntimeHandle, listener: (snapshot: AgentPtySnapshot) => void): IDisposable {
		const record = this.requireHostRecord(handle);
		return record.host.watchExit(record.hostHandle!, listener);
	}

	getSnapshot(handle: AgentSessionRuntimeHandle): AgentPtySnapshot {
		const record = this.requireRecord(handle);
		if (!record.host || !record.hostHandle) {
			return { state: 'cleanupUnverified', latestSequence: 0, outputSanitizerFailed: false, failedOutputListeners: 0, failedExitListeners: 0, accessRevocationFailed: !record.accessRevoked };
		}
		return record.host.getSnapshot(record.hostHandle);
	}

	write(handle: AgentSessionRuntimeHandle, text: string): Promise<void> {
		const record = this.requireHostRecord(handle);
		return record.host.write(record.hostHandle!, text);
	}

	resize(handle: AgentSessionRuntimeHandle, cols: number, rows: number): Promise<void> {
		const record = this.requireHostRecord(handle);
		return record.host.resize(record.hostHandle!, cols, rows);
	}

	attach(handle: AgentSessionRuntimeHandle, listener: (chunk: AgentPtyOutputChunk) => void, afterSequence: number): Promise<AgentPtyAttachment> {
		const record = this.requireHostRecord(handle);
		return record.host.attach(record.hostHandle!, listener, afterSequence);
	}

	async stop(handle: AgentSessionRuntimeHandle): Promise<AgentPtyStopResult> {
		const record = this.requireRecord(handle);
		if (!record.hostHandle && !this.tryRevokePreparedAccess(record)) {
			return { state: 'cleanupUnverified', cleanupVerified: false, error: 'Launch-scoped access revocation failed.' };
		}
		let hostResult: AgentPtyStopResult = { state: 'stopped', cleanupVerified: true };
		if (record.hostHandle && record.host) {
			try { hostResult = await record.host.stop(record.hostHandle); }
			catch { return { state: 'cleanupUnverified', cleanupVerified: false, error: 'Owned PTY cleanup could not be verified.' }; }
		}
		if (!hostResult.cleanupVerified) { return hostResult; }
		if (!record.privateConfigReleased) {
			try {
				await record.prepared.releasePrivateConfig();
				record.privateConfigReleased = true;
			} catch {
				return { state: 'cleanupUnverified', cleanupVerified: false, error: 'Private launch configuration could not be released.' };
			}
		}
		return { state: 'stopped', cleanupVerified: true };
	}

	async release(handle: AgentSessionRuntimeHandle): Promise<void> {
		const record = this.requireRecord(handle);
		if (!record.accessRevoked || !record.privateConfigReleased) { throw new Error('A PTY runtime can be released only after its access and private configuration are cleaned up.'); }
		if (record.hostHandle && record.host) { await record.host.release(record.hostHandle); }
		this.records.delete(handle);
	}

	private requireRecord(handle: AgentSessionRuntimeHandle): RuntimeRecord {
		const record = this.records.get(handle);
		if (!record) { throw new Error('The session runtime handle was not created by this factory.'); }
		return record;
	}

	private requireHostRecord(handle: AgentSessionRuntimeHandle): RuntimeRecord & { readonly host: AgentPtyHost; readonly hostHandle: AgentPtyHandle } {
		const record = this.requireRecord(handle);
		if (!record.host || !record.hostHandle) { throw new Error('The session runtime has no owned PTY handle.'); }
		return record as RuntimeRecord & { readonly host: AgentPtyHost; readonly hostHandle: AgentPtyHandle };
	}

	private tryRevokePreparedAccess(record: RuntimeRecord): boolean {
		if (record.accessRevoked) { return true; }
		try {
			record.prepared.revokeAccess();
			record.accessRevoked = true;
			return true;
		} catch {
			return false;
		}
	}
}

function validatePreparedLaunch(snapshot: AgentSessionTurnSnapshot, prepared: PreparedAgentSessionPtyLaunch): void {
	if (!prepared || typeof prepared !== 'object' || !prepared.command || !prepared.launch
		|| typeof prepared.revokeAccess !== 'function' || typeof prepared.releasePrivateConfig !== 'function'
		|| !Array.isArray(prepared.knownSecrets) || prepared.knownSecrets.some(secret => typeof secret !== 'string')) {
		throw new Error('The trusted session launch preparation is incomplete.');
	}
	const { command, launch } = prepared;
	if (command.commandSpecVersion !== AGENT_CLI_COMMAND_SPEC_VERSION
		|| command.provider !== snapshot.provider || command.model !== snapshot.model || command.profileRef !== snapshot.profileRef
		|| command.cwd !== snapshot.cwd || prepared.permissionPolicy.mode !== snapshot.permissionPolicy.mode
		|| prepared.permissionPolicy.approval !== snapshot.permissionPolicy.approval) {
		throw new Error('The trusted command specification does not match the persisted session snapshot.');
	}
	if (!isAbsolute(prepared.profileDirectory) || command.executable !== launch.executable || command.cwd !== launch.cwd
		|| command.args.length !== launch.args.length || command.args.some((argument, index) => argument !== launch.args[index])) {
		throw new Error('The PTY launch command does not match the trusted versioned command specification.');
	}
	const profileSelector = snapshot.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
	if (Object.keys(command.env).length !== 1 || command.env[profileSelector] !== prepared.profileDirectory
		|| Object.keys(launch.env).length !== Object.keys(command.env).length || launch.env[profileSelector] !== command.env[profileSelector]) {
		throw new Error('The PTY launch environment must select only the persisted provider profile.');
	}
}
