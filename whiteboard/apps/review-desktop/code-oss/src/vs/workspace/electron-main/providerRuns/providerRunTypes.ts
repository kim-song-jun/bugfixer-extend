/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ProviderId = 'codex' | 'claude';

/** Upper bound for one provider JSONL line; large enough for verbose events but finite. */
export const PROVIDER_MAX_EVENT_LINE_BYTES = 1024 * 1024;
export const PROVIDER_MAX_FINAL_TEXT_BYTES = 256 * 1024;

export type ProviderTerminalState = 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export type ProviderPermissionPolicy = {
	readonly mode: 'read-only' | 'mutating';
	readonly approval: 'never' | 'on-request' | 'always';
};

export interface ProviderBoundFolder {
	readonly rootPath: string;
	readonly dev: string;
	readonly ino: string;
	readonly helperExecutable: string;
	readonly helperMode: 'claude' | 'codex-node';
}

export interface ProviderRecoveryControl {
	readonly nodeExecutable: string;
	readonly helperScript: string;
	readonly socketPath: string;
	readonly nonce: string;
}

export interface ProviderRunRequest {
	readonly providerId: ProviderId;
	readonly attemptId: string;
	readonly cwd: string;
	readonly prompt: string;
	readonly profileDirectory: string;
	readonly permissionPolicy: ProviderPermissionPolicy;
	/** Opt in only for convention authoring/checking; ordinary task runs discard model prose. */
	readonly captureFinalText?: boolean;
	/** Aborts a run that is queued or still behind the durable launch gate. */
	readonly signal?: AbortSignal;
	/** Required for mutating task runs; the helper binds and rechecks this exact folder identity before CLI exec. */
	readonly boundFolder?: ProviderBoundFolder;
	/** macOS-only recovery endpoint for a provider group that may outlive the app. */
	readonly recoveryControl?: ProviderRecoveryControl;
	/** Must prove the selected folder identity and the effective policy for this attempt. */
	readonly preflight: (request: ProviderRunRequest) => Promise<ProviderRunPreflight>;
}

export type ProviderRunPreflight =
	| { readonly allowed: true; readonly cwdIdentity: string; readonly policyProof: string }
	| { readonly allowed: false; readonly reason: string };

/** An allowlisted, non-content event produced by a provider-specific parser. */
export interface ProviderRunEvent {
	readonly type: string;
	readonly providerId: ProviderId;
	readonly attemptId: string;
	readonly timestamp: number;
	readonly providerSessionId?: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ProviderCommandSpec {
	readonly executable: string;
	readonly args: readonly string[];
	/** Optional private input sent through stdin so prompt text never appears in argv. */
	readonly stdin?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Return only allowlisted event metadata. Never return prompt, model text, tool I/O, or credentials. */
	readonly parseEvent: (line: string, stream: 'stdout' | 'stderr') => {
		readonly event?: Omit<ProviderRunEvent, 'providerId' | 'attemptId' | 'timestamp'>;
		readonly terminalState?: ProviderTerminalState;
		/** Extracted answer only; never tool I/O or intermediate reasoning. */
		readonly finalText?: string;
	};
}

export interface ProviderRunResult {
	readonly attemptId: string;
	readonly providerId: ProviderId;
	readonly state: ProviderTerminalState;
	/** True only after the app has proved its owned process group is gone. */
	readonly cleanupVerified: boolean;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly error?: string;
	readonly finalText?: string;
}

export interface ProviderRunHandle {
	readonly pid: number | undefined;
	readonly result: Promise<ProviderRunResult>;
	cancel(): void;
}
