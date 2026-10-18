import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ipcRenderer } from '../../../../../base/parts/sandbox/electron-browser/globals.js';
import { ProcessPropertyType, type IProcessPropertyMap, type IProcessReadyEvent, type ITerminalChildProcess } from '../../../../../platform/terminal/common/terminal.js';
import type { AgentSessionTurnDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import { WORKSPACE_AGENT_SESSIONS_CHANNEL, WORKSPACE_AGENT_SESSIONS_OUTPUT_EVENT, type WorkspaceAgentSessionOutputEvent } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import { ITerminalService, type ITerminalInstance } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { BasePty } from '../../../../../workbench/contrib/terminal/common/basePty.js';

interface AttachmentResult {
	readonly attachmentId: string;
	readonly initialPage: { readonly chunks: readonly { readonly sequence: number; readonly text: string; readonly gap: boolean }[]; readonly cursor: number; readonly retentionGap: boolean };
}

const MAX_PENDING_ATTACH_OUTPUT_CHARS = 512_000;

interface TerminalRecord { readonly key: string; readonly instance: ITerminalInstance; lastUsed: number; }
interface PendingRecord { readonly promise: Promise<TerminalRecord>; }

export class SessionTerminalController extends Disposable {
	private readonly records = new Map<string, TerminalRecord>();
	private readonly ptys = new Map<string, SessionPty>();
	private readonly pending = new Map<string, PendingRecord>();
	private attachedKey: string | undefined;
	private desiredKey: string | undefined;
	private viewGeneration = 0;
	private readonly maximumTerminals = 3;
	private disposed = false;

	constructor(private readonly projectId: string, private readonly terminalService: ITerminalService, private readonly onError: (message: string) => void) { super(); }

	async show(container: HTMLElement, sessionId: string, turn: AgentSessionTurnDTO): Promise<void> {
		const key = `${sessionId}:${turn.id}`;
		const generation = ++this.viewGeneration;
		this.detachCurrent();
		this.desiredKey = key;
		let record = this.records.get(key);
		if (!record) {
			let work = this.pending.get(key);
			if (!work) {
				work = { promise: this.createRecord(key, sessionId, turn) };
				this.pending.set(key, work);
				void work.promise.finally(() => {
					if (this.pending.get(key) === work) this.pending.delete(key);
				}).catch(() => undefined);
			}
			try {
				record = await work.promise;
			} catch (error) {
				if (generation !== this.viewGeneration || this.desiredKey !== key || this.disposed) return;
				throw error;
			}
		}
		if (generation !== this.viewGeneration || this.desiredKey !== key || this.disposed) return;
		record.lastUsed = Date.now();
		this.attachedKey = key;
		record.instance.attachToElement(container);
		record.instance.setVisible(true);
		const bounds = container.getBoundingClientRect();
		if (bounds.width > 0 && bounds.height > 0) record.instance.layout({ width: bounds.width, height: bounds.height });
	}

	private async createRecord(key: string, sessionId: string, turn: AgentSessionTurnDTO): Promise<TerminalRecord> {
		let resolvePty!: (pty: SessionPty) => void;
		let rejectPty!: (error: Error) => void;
		let ptyCreated = false;
		const ptyReady = new Promise<SessionPty>((resolve, reject) => { resolvePty = resolve; rejectPty = reject; });
		let pty: SessionPty | undefined;
		let instance: ITerminalInstance | undefined;
		let disposedBeforePty = false;
		try {
			instance = await this.terminalService.createTerminal({
				resource: URI.from({ scheme: 'devfast-agent-session-terminal', path: `/${this.projectId}/${sessionId}/${turn.id}` }),
				config: { name: 'AI 세션', hideFromUser: true, customPtyImplementation: terminalId => {
					pty = new SessionPty(terminalId, this.projectId, sessionId, turn, message => this.onError(message));
					this.ptys.set(key, pty);
					ptyCreated = true;
					resolvePty(pty);
					return pty;
				}, isFeatureTerminal: false },
			});
			instance.onDisposed(() => {
				if (!ptyCreated && !disposedBeforePty) {
					disposedBeforePty = true;
					rejectPty(new Error('세션 터미널 인스턴스가 PTY 준비 전에 종료되었습니다.'));
				}
				if (this.records.get(key)?.instance === instance) this.records.delete(key);
				if (this.ptys.get(key) === pty) this.ptys.delete(key);
				pty?.dispose();
			});
			if (instance.isDisposed && !ptyCreated && !disposedBeforePty) {
				disposedBeforePty = true;
				rejectPty(new Error('세션 터미널 인스턴스가 PTY 준비 전에 종료되었습니다.'));
			}
			await ptyReady;
			if (instance.isDisposed) throw new Error('세션 터미널 인스턴스가 준비 중 종료되었습니다.');
			const record: TerminalRecord = { key, instance, lastUsed: Date.now() };
			this.records.set(key, record);
			this.trim(key);
			if (this.desiredKey !== key || this.disposed) {
				if (this.records.get(key) === record) this.records.delete(key);
				instance.dispose();
				throw new Error('세션 터미널 요청이 취소되었습니다.');
			}
			return record;
		} catch (error) {
			pty?.dispose();
			if (this.ptys.get(key) === pty) this.ptys.delete(key);
			if (instance && !instance.isDisposed) instance.dispose();
			throw error;
		}
	}

	hasTerminal(sessionId: string, turnId: string): boolean { return this.records.has(`${sessionId}:${turnId}`); }

	finish(sessionId: string, turnId: string, exitCode: number | undefined): void {
		this.ptys.get(`${sessionId}:${turnId}`)?.finish(exitCode);
	}

	hide(): void {
		this.viewGeneration++;
		this.desiredKey = undefined;
		this.detachCurrent();
	}

	private detachCurrent(): void {
		if (!this.attachedKey) return;
		const current = this.records.get(this.attachedKey)?.instance;
		current?.setVisible(false);
		current?.detachFromElement();
		this.attachedKey = undefined;
	}

	layout(): void {
		const record = this.attachedKey ? this.records.get(this.attachedKey) : undefined;
		if (!record) return;
		const bounds = record.instance.domElement.parentElement?.getBoundingClientRect();
		if (bounds && bounds.width > 0 && bounds.height > 0) record.instance.layout({ width: bounds.width, height: bounds.height });
	}

	private trim(exceptKey: string): void {
		if (this.records.size <= this.maximumTerminals) return;
		const victim = [...this.records.values()].filter(record => record.key !== exceptKey && record.key !== this.attachedKey).sort((a, b) => a.lastUsed - b.lastUsed)[0];
		if (victim) {
			if (this.records.get(victim.key) === victim) this.records.delete(victim.key);
			victim.instance.dispose();
		}
	}

	override dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.hide();
		for (const record of this.records.values()) record.instance.dispose();
		this.records.clear();
		this.pending.clear();
		this.ptys.clear();
		super.dispose();
	}
}

class SessionPty extends BasePty implements ITerminalChildProcess {
	private attachmentId: string | undefined;
	private sequence = 0;
	private disposed = false;
	private readonly pendingOutput: WorkspaceAgentSessionOutputEvent[] = [];
	private pendingOutputChars = 0;
	private pendingOutputGap = false;
	private readonly listeners = new DisposableStore();

	constructor(id: number, private readonly projectId: string, private readonly sessionId: string, private readonly turn: AgentSessionTurnDTO, private readonly onError: (message: string) => void) {
		super(id, false);
		const output = (_event: unknown, ...args: unknown[]): void => {
			const value = args[0] as WorkspaceAgentSessionOutputEvent | undefined;
			if (!value || typeof value !== 'object' || !value.chunk || typeof value.chunk.text !== 'string') return;
			if (value.projectId !== this.projectId || value.sessionId !== this.sessionId || value.turnId !== this.turn.id) return;
			if (!this.attachmentId) {
				while (this.pendingOutput.length && this.pendingOutputChars + value.chunk.text.length > MAX_PENDING_ATTACH_OUTPUT_CHARS) {
					this.pendingOutputChars -= this.pendingOutput.shift()!.chunk.text.length;
					this.pendingOutputGap = true;
				}
				if (value.chunk.text.length > MAX_PENDING_ATTACH_OUTPUT_CHARS) { this.pendingOutputGap = true; return; }
				this.pendingOutput.push(value);
				this.pendingOutputChars += value.chunk.text.length;
				return;
			}
			if (value.attachmentId !== this.attachmentId) return;
			this.emitChunk(value.chunk);
		};
		ipcRenderer.on(WORKSPACE_AGENT_SESSIONS_OUTPUT_EVENT, output);
		this.listeners.add(toDisposable(() => ipcRenderer.removeListener(WORKSPACE_AGENT_SESSIONS_OUTPUT_EVENT, output)));
	}

	async start(): Promise<undefined> {
		let result: AttachmentResult;
		try {
			result = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'attach', { projectId: this.projectId, sessionId: this.sessionId, turnId: this.turn.id, afterSequence: 0 }) as AttachmentResult;
		} catch (error) {
			const message = this.errorMessage(error);
			this.onError(`세션 터미널에 연결할 수 없습니다: ${message}`);
			this.handleData(`\r\n[세션 터미널 연결 실패: ${message}]\r\n`);
			this.handleExit(1);
			this.shutdown(false);
			return undefined;
		}
		if (this.disposed) {
			void ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'disconnect', { projectId: this.projectId, sessionId: this.sessionId, turnId: this.turn.id, attachmentId: result.attachmentId })
				.catch(error => this.onError(this.errorMessage(error)));
			return undefined;
		}
		this.attachmentId = result.attachmentId;
		this.sequence = 0;
		if (result.initialPage.retentionGap) this.handleData('\r\n[저장 한도 때문에 이전 터미널 출력 일부가 없습니다.]\r\n');
		for (const chunk of result.initialPage.chunks) this.emitChunk(chunk);
		if (this.pendingOutputGap) this.handleData('\r\n[재연결 중 출력 일부가 복구되지 않았습니다.]\r\n');
		this.pendingOutputGap = false;
		const pendingOutput = this.pendingOutput.splice(0);
		this.pendingOutputChars = 0;
		for (const event of pendingOutput) {
			if (event.attachmentId === this.attachmentId) this.emitChunk(event.chunk);
		}
		const cwd = this.turn.snapshot.cwd;
		this._properties.cwd = cwd;
		this._properties.initialCwd = this.turn.snapshot.cwd;
		const ready: IProcessReadyEvent = { pid: -1, cwd, windowsPty: undefined };
		this.handleReady(ready);
		return undefined;
	}

	private emitChunk(chunk: { readonly sequence: number; readonly text: string; readonly gap: boolean }): void {
		if (chunk.sequence <= this.sequence && chunk.sequence !== 0) return;
		if (chunk.gap) this.handleData('\r\n[출력 일부가 보존 기간을 지나 복구되지 않았습니다.]\r\n');
		if (chunk.text) this.handleData(chunk.text);
		this.sequence = Math.max(this.sequence, chunk.sequence);
	}

	input(data: string): void {
		if (!this.attachmentId || this.disposed) return;
		void ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'write', { projectId: this.projectId, sessionId: this.sessionId, turnId: this.turn.id, text: data }).catch(error => this.onError(this.errorMessage(error)));
	}

	resize(cols: number, rows: number): void {
		if (!this.attachmentId || this.disposed || cols < 1 || rows < 1) return;
		void ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'resize', { projectId: this.projectId, sessionId: this.sessionId, turnId: this.turn.id, cols, rows }).catch(error => this.onError(this.errorMessage(error)));
	}

	processBinary(data: string): Promise<void> { return this.write(data); }
	private async write(data: string): Promise<void> {
		if (!this.attachmentId || this.disposed) return;
		await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'write', { projectId: this.projectId, sessionId: this.sessionId, turnId: this.turn.id, text: data });
	}
	shutdown(_immediate: boolean): void {
		if (this.disposed) return;
		this.disposed = true;
		this.listeners.dispose();
		const attachmentId = this.attachmentId;
		this.attachmentId = undefined;
		if (attachmentId) {
			void ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'disconnect', { projectId: this.projectId, sessionId: this.sessionId, turnId: this.turn.id, attachmentId })
				.catch(error => this.onError(this.errorMessage(error)));
		}
	}

	finish(exitCode: number | undefined): void {
		if (this.disposed) return;
		this.handleExit(exitCode);
		this.shutdown(false);
	}

	sendSignal(signal: string): void {
		if (signal === 'SIGINT') this.input('\u0003');
	else this.onError(`이 터미널 연결은 ${signal} 신호를 전달하지 않습니다.`);
	}
	acknowledgeDataEvent(_charCount: number): void {
		// Session IPC exposes bounded retained output and has no per-chunk acknowledgement command.
	}
	setUnicodeVersion(): Promise<void> { return Promise.resolve(); }
	async getInitialCwd(): Promise<string> { return this.turn.snapshot.cwd; }
	async getCwd(): Promise<string> { return this._properties.cwd || this.turn.snapshot.cwd; }
	override refreshProperty<T extends ProcessPropertyType>(property: T): Promise<IProcessPropertyMap[T]> {
		return Promise.resolve(this._properties[property] as IProcessPropertyMap[T]);
	}
	override clearBuffer(): void { this.handleData('\u001b[2J\u001b[H'); }
	async updateProperty<T extends ProcessPropertyType>(property: T, value: IProcessPropertyMap[T]): Promise<void> {
		this.handleDidChangeProperty({ type: property, value });
	}
	private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
	override dispose(): void { this.shutdown(true); super.dispose(); }
}
