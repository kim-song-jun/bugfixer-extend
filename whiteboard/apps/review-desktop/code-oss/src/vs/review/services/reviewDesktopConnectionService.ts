/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from "../../base/common/event.js";
import { Disposable, type IDisposable, toDisposable } from "../../base/common/lifecycle.js";
import { ipcRenderer } from "../../base/parts/sandbox/electron-browser/globals.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { IStorageService,StorageScope,StorageTarget } from "../../platform/storage/common/storage.js";
import {
	REVIEW_DESKTOP_CHANNEL,
	REVIEW_DESKTOP_CONNECTION_VERSION,
} from "../common/reviewDesktopBootstrap.js";
import type { ReviewDesktopRequest, ReviewDesktopStreamEvent } from "../common/reviewDesktopGateway.js";
import { REVIEW_CONTROL_CONNECTION_CHANNEL } from '../common/reviewControlDispatch.js';
import {
	type JsonValue,
	type ReviewDiffrConfig,
	type ReviewDiffrSummarizerInput,
	isJsonObject,
	parseReviewDiffrConfig,
	parseReviewCliInstallApplyResponse,
	parseReviewCliInstallStatus,
	parseReviewTutorialOpenResponse,
	type ReviewCliInstallApplyResponse,
	type ReviewCliInstallStatus,
	type ReviewTutorialOpenResponse,
} from "../common/reviewProtocol.js";
import {
	REVIEW_SERVER_STARTUP_TIMEOUT_MS,
	reconnectUntilAborted,
} from "../common/reviewReconnect.js";

const REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY = "review.tutorial.autoPrepareSuppressed.v1";

interface ReviewDesktopStatus {
	readonly version: number;
	readonly instanceId: string;
	readonly appSessionId: string;
}


export const IReviewDesktopConnectionService = createDecorator<IReviewDesktopConnectionService>(
	"reviewDesktopConnectionService",
);

export interface IReviewDesktopConnectionService {
	readonly _serviceBrand: undefined;
	readonly onDidFail: Event<Error>;
	readonly onDidChangeLists: Event<void>;
	/** Fires when the desktop connection is established. */
	readonly onDidChangeConnection: Event<void>;
	initialize(): Promise<void>;
	getAppSessionId(): Promise<string>;
	/** Authenticated, route-allowlisted JSON request handled by the main process. */
	request<T>(request: ReviewDesktopRequest): Promise<T>;
	follow<T>(path: string, signal: AbortSignal, accept: (value: T) => void | Promise<void>, disconnected: (error: unknown) => void, options?: { reconnect?: boolean; onComplete?: () => void }): IDisposable;
	readDiffrConfig(): Promise<ReviewDiffrConfig>;
	saveDiffrSummarizer(input: ReviewDiffrSummarizerInput): Promise<ReviewDiffrConfig>;
	testDiffrSummarizer(input: ReviewDiffrSummarizerInput): Promise<string>;
	setDiffrConfigValue(key: string, value: JsonValue): Promise<ReviewDiffrConfig>;
	/** The scratchpad preference: a server preference, since the review server reads it. */
	readScratchpadEnabled(): Promise<boolean>;
	setScratchpadEnabled(enabled: boolean): Promise<boolean>;
	getTutorialStatus(): Promise<{ version: 1; reviewUuid: string | null }>;
	prepareTutorial(): Promise<void>;
	openTutorial(): Promise<ReviewTutorialOpenResponse>;
	deleteTutorial(): Promise<void>;
	getCliInstallStatus(): Promise<ReviewCliInstallStatus>;
	applyCliInstall(request: {
		autoUpdate?: boolean;
		shim?: boolean;
		trace?: true | { endpoint?: string; bucket?: string; key?: string; secret?: string };
	}): Promise<ReviewCliInstallApplyResponse>;
	removeCliInstall(request: { shim?: boolean; trace?: true }): Promise<void>;
	removeLegacySkills(): Promise<void>;
	finishCliInstallUpdate(): Promise<void>;
	declineCliInstall(): Promise<void>;
	skipCliInstallPrompts(): Promise<void>;
	resetCliInstallPrompts(): Promise<void>;
}

export class ReviewDesktopConnectionService extends Disposable implements IReviewDesktopConnectionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeLists = this._register(new Emitter<void>());
	readonly onDidChangeLists = this._onDidChangeLists.event;
	private readonly _onDidFail = this._register(new Emitter<Error>());
	readonly onDidFail = this._onDidFail.event;
	private readonly connectionChanged = this._register(new Emitter<void>());
	readonly onDidChangeConnection = this.connectionChanged.event;

	private initializePromise: Promise<void> | null = null;
	private tutorialPreparePromise: Promise<void> | undefined;
	private tutorialPrepareAttempted = false;
	private cliInstallStatusPromise: Promise<ReviewCliInstallStatus> | undefined;
	/**
	 * The main process owns the embedded server's endpoint and credentials and
	 * publishes them only once it has validated the server's ready event.
	 */
	private connection: ReviewDesktopStatus | undefined;
	private get instanceId(): string {
		return this.requireConnection().instanceId;
	}

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		const onControlConnection = () => this.connectionChanged.fire();
		ipcRenderer.on(REVIEW_CONTROL_CONNECTION_CHANNEL, onControlConnection);
		this._register(toDisposable(() => ipcRenderer.removeListener(REVIEW_CONTROL_CONNECTION_CHANNEL, onControlConnection)));
	}

	private requireConnection(): ReviewDesktopStatus {
		if (!this.connection) {
			throw new Error("The Whiteboard connection is not established yet.");
		}
		return this.connection;
	}

	private async connect(): Promise<void> {
		if (this.connection) return;
		const connection = await ipcRenderer.invoke(REVIEW_DESKTOP_CHANNEL, "getStatus") as ReviewDesktopStatus;
		if (connection?.version !== REVIEW_DESKTOP_CONNECTION_VERSION) {
			throw new Error(`Unsupported Whiteboard Desktop connection version: ${String(connection?.version)}.`);
		}
		this.connection = connection;
	}

	initialize(): Promise<void> {
		this.initializePromise ??= this.initializeGlobalState().catch((error) => {
			this.initializePromise = null;
			throw error;
		});
		return this.initializePromise;
	}

	async getAppSessionId(): Promise<string> {
		await this.initialize();
		return this.requireConnection().appSessionId;
	}

	async request<T>(request: ReviewDesktopRequest): Promise<T> {
		await this.initialize();
		return this.requestDirect<T>(request);
	}

	private requestDirect<T>(request: ReviewDesktopRequest): Promise<T> {
		return ipcRenderer.invoke(REVIEW_DESKTOP_CHANNEL, "request", request) as Promise<T>;
	}

	follow<T>(path: string, signal: AbortSignal, accept: (value: T) => void | Promise<void>, disconnected: (error: unknown) => void, options: { reconnect?: boolean; onComplete?: () => void } = {}): IDisposable {
		if (signal.aborted) return toDisposable(() => undefined);
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		let activeId: string | undefined;
		const connect = async (onConnected: () => void): Promise<void> => {
			await this.initialize();
			const started = await ipcRenderer.invoke(REVIEW_DESKTOP_CHANNEL, "streamStart", { path }) as { id: string };
			activeId = started.id;
			onConnected();
			try {
				while (!controller.signal.aborted) {
					const frame = await ipcRenderer.invoke(REVIEW_DESKTOP_CHANNEL, "streamNext", { id: started.id }) as ReviewDesktopStreamEvent | { pending: true } | { done: true };
					if ("pending" in frame) continue;
					if ("done" in frame) {
						if (options.reconnect === false) { options.onComplete?.(); return; }
						throw new Error("Review Desktop stream ended.");
					}
					if ("error" in frame) throw new Error(frame.error);
					await accept(frame.value as T);
				}
			} finally {
				await ipcRenderer.invoke(REVIEW_DESKTOP_CHANNEL, "streamCancel", { id: started.id });
				if (activeId === started.id) activeId = undefined;
			}
		};
		if (options.reconnect === false) {
			void connect(() => undefined).catch(error => { if (!controller.signal.aborted) disconnected(error); });
		} else {
			void reconnectUntilAborted(controller.signal, connect, { onRetry: disconnected });
		}
		return toDisposable(() => {
			signal.removeEventListener("abort", abort);
			controller.abort();
			if (activeId) void ipcRenderer.invoke(REVIEW_DESKTOP_CHANNEL, "streamCancel", { id: activeId });
		});
	}

	/**
	 * The dismissed review retention window. It is a server preference rather
	 * than a workbench setting because the reaper runs inside the review server.
	 * `null` means never reap.
	 */
	async readDiffrConfig(): Promise<ReviewDiffrConfig> {
		await this.initialize();
		return parseReviewDiffrConfig(await this.requestDirect<JsonValue>({ path: "/diffr-config" }));
	}

	async setDiffrConfigValue(key: string, value: JsonValue): Promise<ReviewDiffrConfig> {
		await this.initialize();
		return parseReviewDiffrConfig(await this.requestDirect<JsonValue>({ path: "/diffr-config", method: "PUT", body: { key, value } }));
	}

	async readScratchpadEnabled(): Promise<boolean> {
		await this.initialize();
		return parseScratchpadPreference(await this.requestDirect<unknown>({ path: "/preferences/scratchpad" }));
	}

	async setScratchpadEnabled(enabled: boolean): Promise<boolean> {
		await this.initialize();
		return parseScratchpadPreference(await this.requestDirect<unknown>({ path: "/preferences/scratchpad", method: "PUT", body: { enabled } }));
	}

	async saveDiffrSummarizer(input: ReviewDiffrSummarizerInput): Promise<ReviewDiffrConfig> {
		await this.initialize();
		return parseReviewDiffrConfig(await this.requestDirect<JsonValue>({ path: "/diffr-config/summarizer", method: "PUT", body: input }));
	}

	async testDiffrSummarizer(input: ReviewDiffrSummarizerInput): Promise<string> {
		await this.initialize();
		const result: unknown = await this.requestDirect({ path: "/diffr-config/summarizer/test", method: "POST", body: input });
		if (!isJsonObject(result) || typeof result.summary !== "string") throw new Error("Malformed summary test response.");
		return result.summary;
	}

	async getTutorialStatus(): Promise<{ version: 1; reviewUuid: string | null }> {
		await this.initialize();
		const payload = (await this.requestDirect<unknown>({ path: "/tutorial/status" })) as {
			version?: unknown;
			reviewUuid?: unknown;
		};
		if (payload.version !== 1 || (payload.reviewUuid !== null && typeof payload.reviewUuid !== "string")) {
			throw new Error("Whiteboard tutorial status is invalid.");
		}
		return { version: 1, reviewUuid: payload.reviewUuid as string | null };
	}

	prepareTutorial(): Promise<void> {
		if (this.storageService.getBoolean(REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY, StorageScope.APPLICATION, false)) {
			return Promise.resolve();
		}
		if (this.tutorialPreparePromise) return this.tutorialPreparePromise;
		if (this.tutorialPrepareAttempted) return Promise.resolve();
		this.tutorialPrepareAttempted = true;
		const operation = this.requestTutorialPreparation();
		this.tutorialPreparePromise = operation;
		const clearOperation = () => {
			if (this.tutorialPreparePromise === operation) {
				this.tutorialPreparePromise = undefined;
			}
		};
		void operation.then(clearOperation, clearOperation);
		return operation;
	}

	private async requestTutorialPreparation(): Promise<void> {
		await this.initialize();
		await this.requestDirect({ path: "/tutorial/prepare", method: "POST" });
	}

	async openTutorial(): Promise<ReviewTutorialOpenResponse> {
		await this.initialize();
		const payload = parseReviewTutorialOpenResponse(await this.requestDirect<JsonValue>({ path: "/tutorial/open", method: "POST" }));
		this.tutorialPrepareAttempted = true;
		this.storageService.remove(REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY, StorageScope.APPLICATION);
		return payload;
	}

	async deleteTutorial(): Promise<void> {
		await this.initialize();
		await this.requestDirect({ path: "/tutorial", method: "DELETE" });
		this.tutorialPreparePromise = undefined;
		this.tutorialPrepareAttempted = true;
		this.storageService.store(
			REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY,
			true,
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
		this._onDidChangeLists.fire();
	}

	async getCliInstallStatus(): Promise<ReviewCliInstallStatus> {
		await this.initialize();
		this.cliInstallStatusPromise ??= (async () => {
				return parseReviewCliInstallStatus(await this.requestDirect<JsonValue>({ path: "/install/status" }));
		})().finally(() => {
			this.cliInstallStatusPromise = undefined;
		});
		return this.cliInstallStatusPromise;
	}

	async applyCliInstall(request: {
		autoUpdate?: boolean;
		shim?: boolean;
		trace?: true | { endpoint?: string; bucket?: string; key?: string; secret?: string };
	}): Promise<ReviewCliInstallApplyResponse> {
		await this.initialize();
		const payload = await this.requestDirect<JsonValue>({
			path: "/install/apply", method: "POST", body: {
				...(request.autoUpdate ? { autoUpdate: true } : {}),
				...(request.shim !== undefined ? { shim: request.shim } : {}),
				...(request.trace !== undefined ? { trace: request.trace } : {}),
			},
		});
		return parseReviewCliInstallApplyResponse(payload);
	}

	async removeCliInstall(request: { shim?: boolean; trace?: true }): Promise<void> {
		await this.initialize();
		await this.requestDirect({
			path: "/install/remove", method: "POST", body: {
				...(request.shim ? { shim: true } : {}),
				...(request.trace ? { trace: true } : {}),
			},
		});
	}

	async removeLegacySkills(): Promise<void> {
		await this.postCliInstallVerb("legacy-skills/remove");
	}

	async finishCliInstallUpdate(): Promise<void> {
		await this.postCliInstallVerb("finish-update");
	}

	async declineCliInstall(): Promise<void> {
		await this.postCliInstallVerb("decline");
	}

	async skipCliInstallPrompts(): Promise<void> {
		await this.postCliInstallVerb("skip");
	}

	async resetCliInstallPrompts(): Promise<void> {
		await this.postCliInstallVerb("reset");
	}

	private async postCliInstallVerb(verb: "decline" | "skip" | "reset" | "legacy-skills/remove" | "finish-update"): Promise<void> {
		await this.initialize();
		await this.requestDirect({ path: `/install/${verb}`, method: "POST" });
	}

	private async initializeGlobalState(): Promise<void> {
		await this.connect();
		await this.waitForHealth();
		this.connectionChanged.fire();
	}

	private async waitForHealth(): Promise<void> {
		const deadline = Date.now() + REVIEW_SERVER_STARTUP_TIMEOUT_MS;
		while (Date.now() < deadline) {
			try {
				const value = await this.requestDirect<{ instanceId?: unknown }>({ path: '/health' });
				if (value.instanceId === this.instanceId) return;
			} catch {
				// The utility host may still be starting.
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		throw new Error('The embedded Whiteboard server did not become healthy.');
	}

}

export async function reviewResponseError(response: Response, fallback: string): Promise<Error> {
	const payload = (await response.json().catch(() => null)) as {
		error?: unknown;
	} | null;
	return new Error(typeof payload?.error === "string" && payload.error ? payload.error : fallback);
}

function parseScratchpadPreference(value: unknown): boolean {
	if (typeof value !== "object" || value === null || !("enabled" in value) || typeof value.enabled !== "boolean") {
		throw new Error("scratchpad preference response is malformed.");
	}
	return value.enabled;
}
