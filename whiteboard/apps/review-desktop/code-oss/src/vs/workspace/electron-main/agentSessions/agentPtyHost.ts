/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import type * as NodePty from 'node-pty';
import type { IDisposable } from '../../../base/common/lifecycle.js';

const nodeRequire = createRequire(import.meta.url);

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ENVIRONMENT_BYTES = 128 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_EVENT_BYTES = 256 * 1024;
const MAX_OUTPUT_CHUNKS = 256;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONTROL_MESSAGE_BYTES = 256 * 1024;
const MAX_READ_CHUNKS = 500;
const MAX_ROWS_OR_COLUMNS = 1000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_VERIFY_MS = 5_000;
const PROCESS_GROUP_POLL_MS = 25;
const CONTROL_HELLO_TIMEOUT_MS = 1_500;
const CONTROL_CLOSE_TIMEOUT_MS = 1_000;
const MAX_CONTROL_CONNECTIONS = 4;
const MAX_EXIT_LISTENERS = 8;
const MAX_OUTPUT_LISTENERS = 8;

// Handles are intentionally object-identity tokens. PID and PGID are never accepted from callers.
declare const agentPtyHandleBrand: unique symbol;

export interface AgentPtyHandle {
	readonly [agentPtyHandleBrand]: true;
}

export interface AgentPtyLaunch {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly cols: number;
	readonly rows: number;
}

/** A per-session streaming sanitizer. Its output is the only terminal text retained or emitted. */
export interface AgentPtyOutputSanitizer {
	push(text: string): string;
	flush(): string;
}

export interface AgentPtyOutputChunk {
	readonly sequence: number;
	readonly text: string;
	readonly gap: boolean;
}

export interface AgentPtyOutputPage {
	readonly chunks: readonly AgentPtyOutputChunk[];
	readonly cursor: number;
	readonly latestSequence: number;
	readonly retentionGap: boolean;
}

export type AgentPtyState = 'starting' | 'running' | 'exited' | 'stopping' | 'stopped' | 'cleanupUnverified';

export interface AgentPtySnapshot {
	readonly state: AgentPtyState;
	readonly providerExitCode?: number;
	readonly providerExitSignal?: string;
	readonly latestSequence: number;
	readonly outputSanitizerFailed: boolean;
	/** True when sanitized output could not be committed to the durable transcript before publishing. */
	readonly transcriptPersistenceFailed?: boolean;
	readonly failedOutputListeners: number;
	readonly failedExitListeners: number;
	readonly accessRevocationFailed: boolean;
}

export interface AgentPtyStopResult {
	readonly state: 'stopped' | 'cleanupUnverified';
	readonly cleanupVerified: boolean;
	readonly error?: string;
}

export interface AgentPtyAttachment extends IDisposable {
	readonly snapshot: AgentPtySnapshot;
	readonly initialPage: AgentPtyOutputPage;
	read(afterSequence: number, limit?: number): AgentPtyOutputPage;
}

export interface AgentPtyHostOptions {
	readonly createSanitizer: () => AgentPtyOutputSanitizer;
	/** Synchronously revokes launch-scoped access before any owned process stop or signal. */
	readonly revokeAccess: () => void;
	/** Synchronously persists already-sanitized output before any ring-buffer or listener publication. */
	readonly persistOutput?: (text: string, gap: boolean) => void;
	/** Trusted standalone Node executable used only for the guardian process. */
	readonly guardianNodeExecutable: string;
	/** Packaged path to agentPtyGuardian.mjs. */
	readonly guardianScriptPath: string;
	readonly startTimeoutMs?: number;
	readonly stopVerifyMs?: number;
	readonly maxOutputBytes?: number;
	readonly maxOutputChunks?: number;
}

/** Startup failure with an exact host-owned recovery capability when cleanup could not be proved. */
export class AgentPtyStartError extends Error {
	constructor(
		message: string,
		readonly cleanupVerified: boolean,
		readonly recoveryHandle?: AgentPtyHandle,
		readonly providerExitCode?: number,
		readonly providerExitSignal?: string,
	) {
		super(message);
		this.name = 'AgentPtyStartError';
		if (cleanupVerified && recoveryHandle) { throw new Error('A verified PTY startup cleanup cannot retain a recovery handle.'); }
		if (!cleanupVerified && !recoveryHandle) { throw new Error('Unverified PTY startup cleanup requires its exact recovery handle.'); }
	}
}

interface RetainedChunk {
	readonly sequence: number;
	readonly text: string;
	readonly gap: boolean;
	readonly bytes: number;
}

interface OwnedPty {
	readonly handle: AgentPtyHandle;
	readonly sanitizer: AgentPtyOutputSanitizer;
	readonly output: RetainedChunk[];
	readonly listeners: Set<(chunk: AgentPtyOutputChunk) => void>;
	readonly exitListeners: Set<(snapshot: AgentPtySnapshot) => void>;
	readonly disposables: IDisposable[];
	readonly capability: string;
	controlPort: number;
	readonly controlServer: Server;
	readonly resolveStartup: () => void;
	readonly rejectStartup: (error: Error) => void;
	readonly controlSockets: Set<Socket>;
	readonly controlSocketTimers: Map<Socket, ReturnType<typeof setTimeout>>;
	readonly ptyExitPromise: Promise<void>;
	pty?: NodePty.IPty;
	controlSocket?: Socket;
	controlServerClosePromise?: Promise<void>;
	controlServerWasListening: boolean;
	controlServerBindFailed: boolean;
	stopPromise?: Promise<AgentPtyStopResult>;
	state: AgentPtyState;
	providerExitCode?: number;
	providerExitSignal?: string;
	sequence: number;
	outputBytes: number;
	ptyExited: boolean;
	providerExited: boolean;
	controlAuthenticated: boolean;
	controlDisconnected: boolean;
	guardianCleanup: boolean;
	controlClosing: boolean;
	outputFinalized: boolean;
	outputDrainGapAdded: boolean;
	outputSanitizerFailed: boolean;
	transcriptPersistenceFailed: boolean;
	failedOutputListeners: number;
	failedExitListeners: number;
	accessRevoked: boolean;
	accessRevocationFailed: boolean;
}

/** Main-process owner for interactive PTYs. This foundation is not wired to app launch. */
export class AgentPtyHost {
	private readonly owned = new Map<AgentPtyHandle, OwnedPty>();
	private readonly startTimeoutMs: number;
	private readonly stopVerifyMs: number;
	private readonly maxOutputBytes: number;
	private readonly maxOutputChunks: number;
	private shuttingDown = false;

	constructor(private readonly options: AgentPtyHostOptions) {
		this.startTimeoutMs = boundedInteger(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, 100, 30_000, 'start timeout');
		this.stopVerifyMs = boundedInteger(options.stopVerifyMs ?? DEFAULT_STOP_VERIFY_MS, 100, 30_000, 'stop verification timeout');
		this.maxOutputBytes = boundedInteger(options.maxOutputBytes ?? MAX_OUTPUT_BYTES, 1024, 16 * 1024 * 1024, 'output byte limit');
		this.maxOutputChunks = boundedInteger(options.maxOutputChunks ?? MAX_OUTPUT_CHUNKS, 8, 4096, 'output chunk limit');
		if (typeof options.createSanitizer !== 'function') { throw new Error('An output sanitizer factory is required.'); }
		if (typeof options.revokeAccess !== 'function') { throw new Error('A synchronous launch access revoker is required.'); }
		if (!isAbsolute(options.guardianNodeExecutable) || !isAbsolute(options.guardianScriptPath)) { throw new Error('Trusted guardian paths must be absolute.'); }
	}

	async start(launch: AgentPtyLaunch, signal?: AbortSignal): Promise<AgentPtyHandle> {
		if (signal?.aborted) { throw new AgentPtyStartError('The PTY launch was cancelled before resource creation.', true); }
		if (this.shuttingDown) { throw new AgentPtyStartError('The PTY host is shutting down.', true); }
		if (process.platform === 'win32') { throw new Error('Verified PTY process-group cleanup is unavailable on Windows.'); }
		validateLaunch(launch);
		const pty = nodeRequire('node-pty') as typeof import('node-pty');
		const sanitizer = this.options.createSanitizer();
		if (!sanitizer || typeof sanitizer.push !== 'function' || typeof sanitizer.flush !== 'function') { throw new Error('The PTY output sanitizer is invalid.'); }

		const capability = randomBytes(32).toString('hex');
		const server = createServer();
		const handle = Object.freeze({}) as unknown as AgentPtyHandle;
		let resolveStartup!: () => void;
		let rejectStartup!: (error: Error) => void;
		const startPromise = new Promise<void>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
		// A control-server error can reject startup while listen is pending; observe immediately.
		void startPromise.catch(() => undefined);
		let resolvePtyExit!: () => void;
		const ptyExitPromise = new Promise<void>(resolve => { resolvePtyExit = resolve; });
		const record: OwnedPty = {
			handle,
			sanitizer,
			output: [],
			listeners: new Set(),
			exitListeners: new Set(),
			disposables: [],
			capability,
			controlPort: 0,
			controlServer: server,
			resolveStartup,
			rejectStartup,
			controlSockets: new Set(),
			controlSocketTimers: new Map(),
			ptyExitPromise,
			controlServerWasListening: false,
			controlServerBindFailed: false,
			state: 'starting',
			sequence: 0,
			outputBytes: 0,
			ptyExited: false,
			providerExited: false,
			controlAuthenticated: false,
			controlDisconnected: false,
			guardianCleanup: false,
			controlClosing: false,
			outputFinalized: false,
			outputDrainGapAdded: false,
			outputSanitizerFailed: false,
			transcriptPersistenceFailed: false,
			failedOutputListeners: 0,
			failedExitListeners: 0,
			accessRevoked: false,
			accessRevocationFailed: false,
		};
		server.on('connection', socket => this.acceptControlConnection(record, socket, launch));
		server.on('error', () => {
			if (record.state !== 'stopping' && record.state !== 'stopped') {
				record.controlDisconnected = true;
				record.state = 'cleanupUnverified';
				record.rejectStartup(new Error('guardian control server failed'));
				this.notifyExitListeners(record);
				void this.stop(handle);
			}
		});
		this.owned.set(handle, record);
		const abortStartup = () => {
			record.rejectStartup(new Error('PTY launch was cancelled.'));
			void this.stop(handle);
		};
		signal?.addEventListener('abort', abortStartup, { once: true });

		try {
			try {
				record.controlPort = await listen(server);
				record.controlServerWasListening = true;
			} catch (error) {
				record.controlServerWasListening = server.listening;
				record.controlServerBindFailed = !server.listening;
				throw error;
			}
			if (this.shuttingDown || signal?.aborted) { throw new Error('The PTY launch was cancelled before guardian creation.'); }
			const guardianEnvironment: Record<string, string> = {
				PATH: process.env.PATH ?? '/usr/bin:/bin',
				...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
			};
			const child = pty.spawn(this.options.guardianNodeExecutable, [this.options.guardianScriptPath, String(record.controlPort), capability], {
				name: 'xterm-256color',
				cols: launch.cols,
				rows: launch.rows,
				cwd: launch.cwd,
				env: guardianEnvironment,
				encoding: 'utf8',
				handleFlowControl: true,
			});
			record.pty = child;
			record.disposables.push(child.onData(data => this.acceptPtyData(record, data)));
			record.disposables.push(child.onExit(() => {
				record.ptyExited = true;
				resolvePtyExit();
				if (record.state === 'starting') { record.rejectStartup(new Error('guardian exited before provider startup completed')); }
				if (record.state !== 'stopping') {
					const gone = processGroupGone(child.pid);
					record.state = gone === true ? 'stopped' : 'cleanupUnverified';
				}
				this.notifyExitListeners(record);
				void this.stop(handle);
			}));
			const timer = setTimeout(() => rejectStartup(new Error('guardian start timeout')), this.startTimeoutMs);
			try {
				await startPromise;
				if (this.shuttingDown || signal?.aborted) { throw new Error('The PTY launch was cancelled during startup.'); }
			}
			finally { clearTimeout(timer); }
			return handle;
		} catch (error) {
			const message = error instanceof Error && /cancel/i.test(error.message)
				? 'The trusted PTY guardian launch was cancelled.'
				: 'The trusted PTY guardian failed to start.';
			const result = await this.stop(handle);
			if (result.cleanupVerified) { this.owned.delete(handle); }
			throw new AgentPtyStartError(
				`${message}${result.error ? ` ${result.error}` : ''}`,
				result.cleanupVerified,
				result.cleanupVerified ? undefined : handle,
				record.providerExitCode,
				record.providerExitSignal,
			);
		} finally {
			signal?.removeEventListener('abort', abortStartup);
		}
	}

	/** Subscribes to provider/guardian lifecycle events and replays an already-observed terminal state. */
	watchExit(handle: AgentPtyHandle, listener: (snapshot: AgentPtySnapshot) => void): IDisposable {
		const record = this.requireOwned(handle);
		if (typeof listener !== 'function') { throw new Error('A PTY exit listener is required.'); }
		if (record.exitListeners.size >= MAX_EXIT_LISTENERS) { throw new Error('The PTY exit listener limit was reached.'); }
		record.exitListeners.add(listener);
		let subscribed = true;
		const subscription = {
			dispose: () => {
				if (!subscribed) { return; }
				subscribed = false;
				record.exitListeners.delete(listener);
			},
		};
		if (isTerminalState(record.state)) {
			queueMicrotask(() => {
				if (subscribed && record.exitListeners.has(listener)) { this.notifyExitListener(record, listener); }
			});
		}
		return subscription;
	}

	async write(handle: AgentPtyHandle, text: string): Promise<void> {
		const record = this.requireOwned(handle);
		if (record.state !== 'running' || !record.pty) { throw new Error('The PTY session is not accepting input.'); }
		if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) { throw new Error('PTY input exceeds the allowed size.'); }
		try { record.pty.write(text); }
		catch { throw new Error('PTY input could not be delivered.'); }
	}

	async resize(handle: AgentPtyHandle, cols: number, rows: number): Promise<void> {
		const record = this.requireOwned(handle);
		if (record.state !== 'running' || !record.pty) { throw new Error('The PTY session is not active.'); }
		validateDimension(cols, 'columns');
		validateDimension(rows, 'rows');
		try { record.pty.resize(cols, rows); }
		catch { throw new Error('PTY resize could not be applied.'); }
	}

	async attach(handle: AgentPtyHandle, listener: (chunk: AgentPtyOutputChunk) => void, afterSequence = 0): Promise<AgentPtyAttachment> {
		const record = this.requireOwned(handle);
		if (typeof listener !== 'function') { throw new Error('An output listener is required.'); }
		validateCursor(afterSequence);
		if (record.listeners.has(listener)) { throw new Error('The output listener already has an active PTY attachment.'); }
		if (record.listeners.size >= MAX_OUTPUT_LISTENERS) { throw new Error('The PTY output attachment limit was reached.'); }
		const initialPage = this.read(handle, afterSequence);
		record.listeners.add(listener);
		let attached = true;
		return {
			snapshot: snapshot(record),
			initialPage,
			read: (cursor, limit) => {
				if (!attached) { throw new Error('The PTY attachment is detached.'); }
				return this.read(handle, cursor, limit);
			},
			dispose: () => {
				if (!attached) { return; }
				attached = false;
				record.listeners.delete(listener);
			},
		};
	}

	read(handle: AgentPtyHandle, afterSequence: number, limit = 100): AgentPtyOutputPage {
		const record = this.requireOwned(handle);
		validateCursor(afterSequence);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_CHUNKS) { throw new Error('The PTY output page size is invalid.'); }
		if (afterSequence > record.sequence) { throw new Error('The PTY output cursor is ahead of the current stream.'); }
		const firstSequence = record.output[0]?.sequence ?? record.sequence + 1;
		const chunks = record.output.filter(item => item.sequence > afterSequence).slice(0, limit).map(({ sequence, text, gap }) => ({ sequence, text, gap }));
		const cursor = chunks.length ? chunks[chunks.length - 1].sequence : afterSequence;
		return { chunks, cursor, latestSequence: record.sequence, retentionGap: afterSequence < firstSequence - 1 };
	}

	getSnapshot(handle: AgentPtyHandle): AgentPtySnapshot {
		return snapshot(this.requireOwned(handle));
	}

	async stop(handle: AgentPtyHandle): Promise<AgentPtyStopResult> {
		const record = this.requireOwned(handle);
		if (record.stopPromise) { return record.stopPromise; }
		const operation = this.stopOwned(record);
		record.stopPromise = operation;
		const result = await operation;
		if (!result.cleanupVerified) { record.stopPromise = undefined; }
		return result;
	}

	async shutdown(): Promise<readonly AgentPtyStopResult[]> {
		this.shuttingDown = true;
		return Promise.all([...this.owned.keys()].map(handle => this.stop(handle)));
	}

	async release(handle: AgentPtyHandle): Promise<void> {
		const record = this.requireOwned(handle);
		if (record.state !== 'stopped' || record.listeners.size > 0 || record.exitListeners.size > 0) { throw new Error('A PTY handle can be released only after verified stop and detach.'); }
		if (!(await this.cleanupControlResources(record))) { throw new Error('PTY control resources could not be closed safely.'); }
		record.output.length = 0;
		record.outputBytes = 0;
		this.owned.delete(handle);
	}

	private acceptControlConnection(record: OwnedPty, socket: Socket, launch: AgentPtyLaunch): void {
		if (record.controlClosing || record.controlSockets.size >= MAX_CONTROL_CONNECTIONS || record.controlSocket || record.controlAuthenticated || record.state === 'stopped') { socket.destroy(); return; }
		record.controlSockets.add(socket);
		const helloTimer = setTimeout(() => socket.destroy(), CONTROL_HELLO_TIMEOUT_MS);
		record.controlSocketTimers.set(socket, helloTimer);
		let pending = '';
		let authenticated = false;
		socket.on('data', chunk => {
			pending += chunk.toString('utf8');
			if (Buffer.byteLength(pending, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) { socket.destroy(); return; }
			let newline: number;
			while ((newline = pending.indexOf('\n')) >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				let message: unknown;
				try { message = JSON.parse(line); }
				catch { socket.destroy(); return; }
				if (!authenticated) {
					if (!isGuardianHello(message, record.capability, record.pty?.pid)) { socket.destroy(); return; }
					if (record.state !== 'starting') { socket.destroy(); return; }
					authenticated = true;
					clearTimeout(helloTimer);
					record.controlSocketTimers.delete(socket);
					record.controlAuthenticated = true;
					record.controlSocket = socket;
					this.sendControl(socket, {
						command: 'start',
						executable: launch.executable,
						args: launch.args,
						cwd: launch.cwd,
						env: launch.env,
					});
					continue;
				}
				this.acceptGuardianMessage(record, socket, message);
			}
		});
		socket.on('error', () => socket.destroy());
		socket.on('close', () => {
			record.controlSockets.delete(socket);
			const timer = record.controlSocketTimers.get(socket);
			if (timer) { clearTimeout(timer); record.controlSocketTimers.delete(socket); }
			if (record.controlSocket === socket) { record.controlSocket = undefined; }
			if (!authenticated) { return; }
			if (record.state === 'stopping' || record.state === 'stopped') { return; }
			record.controlDisconnected = true;
			record.state = 'cleanupUnverified';
			record.rejectStartup(new Error('guardian control disconnected'));
			this.notifyExitListeners(record);
			void this.stop(record.handle);
		});
	}

	private acceptGuardianMessage(record: OwnedPty, socket: Socket, message: unknown): void {
		if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.destroy(); return; }
		const value = message as Record<string, unknown>;
		if (value.event === 'providerStarted' && Object.keys(value).length === 1) {
			if (record.state === 'starting') {
				record.state = 'running';
				record.resolveStartup();
			}
			return;
		}
		if (value.event === 'launchError' && Object.keys(value).length === 2 && value.code === 127) {
			record.providerExited = true;
			record.providerExitCode = 127;
			record.rejectStartup(new Error('trusted guardian could not start the provider'));
			return;
		}
		if (value.event === 'providerExit' && Object.keys(value).length === 3
			&& (value.code === null || Number.isInteger(value.code) && Number(value.code) >= 0 && Number(value.code) <= 255)
			&& (value.signal === null || typeof value.signal === 'string' && /^SIG[A-Z0-9]+$/.test(value.signal))) {
			record.providerExited = true;
			record.providerExitCode = value.code === null ? undefined : Number(value.code);
			record.providerExitSignal = value.signal === null ? undefined : String(value.signal);
			const wasStarting = record.state === 'starting';
			if (!wasStarting && record.state !== 'stopping') { record.state = 'exited'; }
			if (wasStarting) {
				record.state = 'exited';
				record.rejectStartup(new Error('provider exited before startup completed'));
			}
			if (isTerminalState(record.state)) {
				this.notifyExitListeners(record);
				void this.stop(record.handle);
			}
			return;
		}
		if (value.event === 'guardianSignal' && Object.keys(value).length === 2 && (value.signal === 'SIGTERM' || value.signal === 'SIGINT')) { return; }
		if (value.event === 'guardianSignal' && Object.keys(value).length === 2 && value.signal === 'SIGHUP') {
			record.guardianCleanup = true;
			record.state = 'stopping';
			record.rejectStartup(new Error('guardian cleanup started'));
			return;
		}
		if (value.event === 'guardianCleanup' && Object.keys(value).length === 2 && typeof value.reason === 'string') {
			record.guardianCleanup = true;
			record.state = 'stopping';
			record.rejectStartup(new Error('guardian cleanup started'));
			return;
		}
		socket.destroy();
	}

	private sendControl(socket: Socket, message: unknown): void {
		const encoded = `${JSON.stringify(message)}\n`;
		if (Buffer.byteLength(encoded, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) { socket.destroy(); return; }
		socket.write(encoded);
	}

	private async stopOwned(record: OwnedPty): Promise<AgentPtyStopResult> {
		let revocationError: string | undefined;
		if (!record.accessRevoked) {
			try {
				this.options.revokeAccess();
				record.accessRevoked = true;
				record.accessRevocationFailed = false;
			} catch {
				record.accessRevocationFailed = true;
				revocationError = 'Launch-scoped access revocation failed.';
			}
		}
		if (record.state === 'starting') { record.rejectStartup(new Error('PTY stopped while starting')); }
		const child = record.pty;
		if (!child) { return this.withRevocationResult(await this.finishStop(record, true), revocationError); }
		if (record.state === 'stopped') { return this.withRevocationResult(await this.finishStop(record, true), revocationError); }
		record.state = 'stopping';
		const pgid = child.pid;
		const before = processGroupGone(pgid);
		if (before === true) { return this.withRevocationResult(await this.waitForGroupCleanup(record, pgid), revocationError); }
		if (before === undefined) { return this.withRevocationResult(await this.finishStop(record, false, 'The PTY process group cannot be inspected.'), revocationError); }
		if (!record.controlDisconnected && !record.guardianCleanup && record.controlSocket && !record.controlSocket.destroyed) {
			this.sendControl(record.controlSocket, { command: 'stop' });
		} else {
			for (const socket of record.controlSockets) { socket.destroy(); }
		}
		return this.withRevocationResult(await this.waitForGroupCleanup(record, pgid), revocationError);
	}

	private withRevocationResult(result: AgentPtyStopResult, revocationError?: string): AgentPtyStopResult {
		if (!revocationError) { return result; }
		return { state: 'cleanupUnverified', cleanupVerified: false, error: [result.error, revocationError].filter(Boolean).join(' ') };
	}

	private async waitForGroupCleanup(record: OwnedPty, pgid: number): Promise<AgentPtyStopResult> {
		const deadline = Date.now() + this.stopVerifyMs;
		let gone = processGroupGone(pgid);
		while (gone === false && Date.now() < deadline) {
			await delay(PROCESS_GROUP_POLL_MS);
			gone = processGroupGone(pgid);
		}
		if (gone !== true) { return this.finishStop(record, false, 'The owned PTY process group is still live or cannot be verified.'); }
		if (record.pty && !record.ptyExited && !(await waitForPromise(record.ptyExitPromise, this.stopVerifyMs))) {
			if (!record.outputDrainGapAdded) {
				record.outputDrainGapAdded = true;
				this.appendOutput(record, '', true);
			}
			return this.finishStop(record, false, 'The PTY exit event did not confirm output drain.');
		}
		return this.finishStop(record, true);
	}

	private async finishStop(record: OwnedPty, verified: boolean, error?: string): Promise<AgentPtyStopResult> {
		record.state = verified ? 'stopped' : 'cleanupUnverified';
		if (verified && record.ptyExited) {
			this.finishSanitizer(record);
			this.disposePtyListeners(record);
		}
		if (verified) {
			try {
				if (!(await this.cleanupControlResources(record))) {
					record.state = 'cleanupUnverified';
					this.notifyExitListeners(record);
					return { state: 'cleanupUnverified', cleanupVerified: false, error: 'PTY control resources did not close within the bounded cleanup window.' };
				}
			} catch {
				record.state = 'cleanupUnverified';
				this.notifyExitListeners(record);
				return { state: 'cleanupUnverified', cleanupVerified: false, error: 'PTY control resources could not be closed.' };
			}
		}
		this.notifyExitListeners(record);
		return { state: record.state, cleanupVerified: verified, ...(error ? { error } : {}) };
	}

	private async cleanupControlResources(record: OwnedPty): Promise<boolean> {
		record.controlClosing = true;
		for (const timer of record.controlSocketTimers.values()) { clearTimeout(timer); }
		record.controlSocketTimers.clear();
		for (const socket of record.controlSockets) { socket.destroy(); }
		record.controlSocket?.destroy();
		record.controlSocket = undefined;
		if (record.controlServerBindFailed) {
			// listen rejected before binding, so there was no active server to close.
		} else if (!record.controlServerWasListening) {
			return false;
		} else if (!record.controlServer.listening && record.controlSockets.size === 0) {
			return true;
		} else {
			if (!record.controlServerClosePromise) {
				record.controlServerClosePromise = new Promise<void>((resolve, reject) => {
					record.controlServer.close(error => error ? reject(error) : resolve());
				}).catch(error => {
					record.controlServerClosePromise = undefined;
					throw error;
				});
			}
			if (!(await waitForPromise(record.controlServerClosePromise, CONTROL_CLOSE_TIMEOUT_MS))) { return false; }
		}
		return true;
	}

	private acceptPtyData(record: OwnedPty, data: string): void {
		if (record.outputSanitizerFailed) { return; }
		if (Buffer.byteLength(data, 'utf8') > MAX_OUTPUT_EVENT_BYTES) {
			this.appendOutput(record, '', true);
			void this.stop(record.handle);
			return;
		}
		try {
			const sanitized = record.sanitizer.push(data);
			if (typeof sanitized !== 'string' || Buffer.byteLength(sanitized, 'utf8') > MAX_OUTPUT_EVENT_BYTES) {
				this.failSanitizer(record);
				return;
			}
			if (sanitized.length > 0) { this.appendOutput(record, sanitized, false); }
		} catch { this.failSanitizer(record); }
	}

	private failSanitizer(record: OwnedPty): void {
		record.outputSanitizerFailed = true;
		this.appendOutput(record, '', true);
		void this.stop(record.handle);
	}

	private appendOutput(record: OwnedPty, text: string, gap: boolean): void {
		if (record.transcriptPersistenceFailed) { return; }
		try {
			this.options.persistOutput?.(gap ? '' : text, gap);
		} catch {
			record.transcriptPersistenceFailed = true;
			void this.stop(record.handle);
			return;
		}
		const bytes = gap ? 0 : Buffer.byteLength(text, 'utf8');
		const chunk: RetainedChunk = { sequence: ++record.sequence, text: gap ? '' : text, gap, bytes };
		record.output.push(chunk);
		record.outputBytes += bytes;
		while (record.output.length > this.maxOutputChunks || record.outputBytes > this.maxOutputBytes) {
			const removed = record.output.shift()!;
			record.outputBytes -= removed.bytes;
		}
		for (const listener of record.listeners) {
			try { listener({ sequence: chunk.sequence, text: chunk.text, gap: chunk.gap }); }
			catch {
				record.listeners.delete(listener);
				record.failedOutputListeners++;
			}
		}
	}

	private finishSanitizer(record: OwnedPty): void {
		if (record.outputFinalized) { return; }
		record.outputFinalized = true;
		if (record.outputSanitizerFailed) { return; }
		try {
			const sanitized = record.sanitizer.flush();
			if (typeof sanitized !== 'string' || Buffer.byteLength(sanitized, 'utf8') > MAX_OUTPUT_EVENT_BYTES) { this.failSanitizer(record); }
			else if (sanitized.length > 0) { this.appendOutput(record, sanitized, false); }
		} catch { this.failSanitizer(record); }
	}

	private disposePtyListeners(record: OwnedPty): void {
		for (const disposable of record.disposables.splice(0)) { disposable.dispose(); }
	}

	private notifyExitListeners(record: OwnedPty): void {
		for (const listener of [...record.exitListeners]) { this.notifyExitListener(record, listener); }
	}

	private notifyExitListener(record: OwnedPty, listener: (snapshot: AgentPtySnapshot) => void): void {
		try { listener(snapshot(record)); }
		catch {
			record.exitListeners.delete(listener);
			record.failedExitListeners++;
		}
	}

	private requireOwned(handle: AgentPtyHandle): OwnedPty {
		const record = this.owned.get(handle);
		if (!record) { throw new Error('The PTY handle was not created by this host.'); }
		return record;
	}
}

function validateLaunch(launch: AgentPtyLaunch): void {
	if (!launch || typeof launch.executable !== 'string' || launch.executable.length === 0 || launch.executable.includes('\0')) { throw new Error('The PTY executable is invalid.'); }
	if (!isAbsolute(launch.cwd) || launch.cwd.includes('\0')) { throw new Error('The PTY working directory must be absolute.'); }
	if (!Array.isArray(launch.args) || launch.args.length > MAX_ARGUMENTS || launch.args.some(value => typeof value !== 'string' || value.includes('\0'))) { throw new Error('The PTY arguments are invalid.'); }
	if (launch.args.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0) > MAX_ARGUMENT_BYTES) { throw new Error('The PTY arguments exceed the allowed size.'); }
	if (!launch.env || Object.keys(launch.env).length > MAX_ENVIRONMENT_ENTRIES || Object.entries(launch.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))) { throw new Error('The PTY environment is invalid.'); }
	if (Object.entries(launch.env).reduce((total, [key, value]) => total + Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8'), 0) > MAX_ENVIRONMENT_BYTES) { throw new Error('The PTY environment exceeds the allowed size.'); }
	validateDimension(launch.cols, 'columns');
	validateDimension(launch.rows, 'rows');
}

function validateDimension(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 2 || value > MAX_ROWS_OR_COLUMNS) { throw new Error(`PTY ${name} are outside the allowed range.`); }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) { throw new Error(`The PTY ${name} is outside the allowed range.`); }
	return value;
}

function validateCursor(cursor: number): void {
	if (!Number.isSafeInteger(cursor) || cursor < 0) { throw new Error('The PTY output cursor is invalid.'); }
}

function snapshot(record: OwnedPty): AgentPtySnapshot {
	return {
		state: record.state,
		...(record.providerExitCode !== undefined ? { providerExitCode: record.providerExitCode } : {}),
		...(record.providerExitSignal !== undefined ? { providerExitSignal: record.providerExitSignal } : {}),
		latestSequence: record.sequence,
		outputSanitizerFailed: record.outputSanitizerFailed,
		...(record.transcriptPersistenceFailed ? { transcriptPersistenceFailed: true } : {}),
		failedOutputListeners: record.failedOutputListeners,
		failedExitListeners: record.failedExitListeners,
		accessRevocationFailed: record.accessRevocationFailed,
	};
}

function isTerminalState(state: AgentPtyState): boolean {
	return state === 'exited' || state === 'stopped' || state === 'cleanupUnverified';
}

function processGroupGone(pgid: number): boolean | undefined {
	try { process.kill(-pgid, 0); return false; }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === 'ESRCH' ? true : undefined;
	}
}

function isGuardianHello(value: unknown, capability: string, expectedPid: number | undefined): value is { event: 'hello'; capability: string; pid: number } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
	const hello = value as Record<string, unknown>;
	if (Object.keys(hello).length !== 3 || hello.event !== 'hello' || typeof hello.capability !== 'string' || !Number.isSafeInteger(hello.pid) || expectedPid === undefined || hello.pid !== expectedPid) { return false; }
	const supplied = Buffer.from(hello.capability, 'utf8');
	const expected = Buffer.from(capability, 'utf8');
	return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
		const onListening = () => {
			server.off('error', onError);
			const address = server.address();
			if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port < 1 || address.port > 65_535) {
				reject(new Error('The PTY guardian control server did not bind an ephemeral loopback port.'));
				return;
			}
			resolve(address.port);
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
	});
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		promise.then(
			() => { clearTimeout(timer); resolve(true); },
			() => { clearTimeout(timer); resolve(false); },
		);
	});
}
