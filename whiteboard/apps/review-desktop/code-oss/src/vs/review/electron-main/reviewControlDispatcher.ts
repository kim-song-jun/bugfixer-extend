/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { dialog, type WebContents } from 'electron';
import { Disposable } from '../../base/common/lifecycle.js';
import { localize } from '../../nls.js';
import { OpenContext, type IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type { ICodeWindow } from '../../platform/window/electron-main/window.js';
import type { WorkspaceDatabase } from '../../workspace/electron-main/workspaceDatabase.js';
import { REVIEW_CONTROL_CONNECTION_CHANNEL, REVIEW_CONTROL_DISPATCH_CHANNEL, REVIEW_CONTROL_DEADLINE_MS, ReviewControlReceipt, reviewControlDestination, type ReviewControlAck, type ReviewControlCancel, type ReviewControlDispatch } from '../common/reviewControlDispatch.js';
import { requestReviewDesktopServer, validatedReviewDesktopOrigin } from '../common/reviewDesktopGateway.js';
import { consumeReviewEventStream } from '../common/reviewEventStream.js';
import { parseReviewDesktopVerbFrame, type ReviewVerbRequest, type ReviewVerbResponse } from '../common/reviewProtocol.js';
import { reconnectUntilAborted } from '../common/reviewReconnect.js';
import type { ReviewDesktopHost } from './reviewDesktopHost.js';

/** The sole authenticated control reader and result writer in the desktop app. */
export class ReviewControlDispatcher extends Disposable {
	private readonly controller = new AbortController();
	private readonly receipts = new ReviewControlReceipt<WebContents>();
	private readonly generation = new WeakMap<WebContents, number>();

	constructor(
		private readonly host: ReviewDesktopHost,
		private readonly windows: IWindowsMainService,
		private readonly database: WorkspaceDatabase | undefined,
		private readonly openProject: (projectId: string) => Promise<void>,
		private readonly isProjectWindow: (window: ICodeWindow, projectId: string) => boolean,
		private readonly logError: (error: unknown) => void,
	) {
		super();
		this._register(windows.onDidOpenWindow(window => this.watchWindow(window)));
		for (const window of windows.getWindows()) this.watchWindow(window);
		void reconnectUntilAborted(this.controller.signal, async onConnected => {
			const connection = await this.host.whenConnected();
			const response = await fetch(new URL('/control', validatedReviewDesktopOrigin(connection)), {
				headers: { 'x-review-token': connection.token, accept: 'text/event-stream' },
				signal: this.controller.signal,
				redirect: 'error',
			});
			if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
				throw new Error(`Review control stream failed (${response.status}).`);
			}
			onConnected();
			this.windows.sendToAll(REVIEW_CONTROL_CONNECTION_CHANNEL);
			await consumeReviewEventStream(response.body, async value => {
				let id: string | undefined;
				let verbResponse: ReviewVerbResponse;
				try {
					const frame = parseReviewDesktopVerbFrame(value);
					id = frame.id;
					verbResponse = await this.dispatch(frame.request);
				} catch (error) {
					verbResponse = { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
				if (id !== undefined && !this.controller.signal.aborted) {
					await requestReviewDesktopServer(connection, { path: '/control/result', method: 'POST', body: { id, response: verbResponse } });
				}
			}, this.controller.signal);
			if (!this.controller.signal.aborted) throw new Error('Review control stream ended.');
		}, { onRetry: this.logError });
	}

	ack(sender: WebContents, value: unknown): void {
		if (!this.windows.getWindowByWebContents(sender)) return;
		this.receipts.ack(sender, value as ReviewControlAck);
	}

	private watchWindow(window: ICodeWindow): void {
		const contents = window.win?.webContents;
		if (!contents) return;
		this.generation.set(contents, (this.generation.get(contents) ?? 0) + 1);
		this._register(window.onWillLoad(() => {
			this.generation.set(contents, (this.generation.get(contents) ?? 0) + 1);
			this.receipts.cancelTarget(contents, localize('reviewControlWindowReloaded', '리뷰 창을 다시 불러와 요청이 취소됐습니다.'));
		}));
		this._register(window.onDidDestroy(() => this.receipts.cancelTarget(contents, localize('reviewControlWindowClosed', '리뷰 창이 닫혀 요청이 취소됐습니다.'))));
	}

	private async dispatch(request: ReviewVerbRequest): Promise<ReviewVerbResponse> {
		const deadline = Date.now() + REVIEW_CONTROL_DEADLINE_MS;
		const reviewId = request.name === 'openReview' ? request.args.reviewUuid : request.name === 'openApiReview' ? request.args.reviewId : undefined;
		const window = await this.withDeadline(
			signal => reviewId
				? this.destinationForReview(reviewId, signal)
				: request.name === 'focusWindow' || request.name === 'authoringCapabilities'
					? this.globalDestination(signal)
					: this.homeWindow(signal),
			deadline,
		);
		if (!window) return { ok: false, error: localize('reviewControlSelectionCancelled', '리뷰를 열 위치 선택을 취소했습니다.') };
		if (!window.isReady) await this.waitUntilReady(window, deadline);
		if (Date.now() >= deadline) throw new Error(localize('reviewControlSelectionTimedOut', '리뷰를 열 위치를 정하는 데 시간이 초과됐습니다.'));
		const contents = window.win?.webContents;
		if (!contents || contents.isDestroyed() || this.windows.getWindowByWebContents(contents) !== window) throw new Error(localize('reviewControlWindowUnavailable', '리뷰를 열 창을 사용할 수 없습니다.'));
		const launch = window.config?.reviewWindowLaunch;
		const expectedProjectId = launch?.kind === 'project' ? launch.projectId : undefined;
		if (reviewId && expectedProjectId) this.assertReviewProjectOwner(reviewId, expectedProjectId);
		if (reviewId && expectedProjectId && !this.isProjectWindow(window, expectedProjectId)) throw new Error(localize('reviewControlProjectWindowChanged', '리뷰를 열 프로젝트 창이 바뀌었습니다.'));
		const generation = this.generation.get(contents) ?? 0;
		const id = randomUUID();
		const pending = this.receipts.wait(id, contents, generation, deadline - Date.now());
		try {
			const message: ReviewControlDispatch = { kind: 'dispatch', id, generation, request };
			window.send(REVIEW_CONTROL_DISPATCH_CHANNEL, message);
			const response = await pending;
			if (contents.isDestroyed() || this.windows.getWindowByWebContents(contents) !== window || this.generation.get(contents) !== generation || window.config?.reviewWindowLaunch.kind !== launch?.kind || (expectedProjectId && !this.isProjectWindow(window, expectedProjectId))) {
				throw new Error(localize('reviewControlDestinationChanged', '리뷰를 열 창이 응답 전에 바뀌었습니다.'));
			}
			if (reviewId && expectedProjectId) this.assertReviewProjectOwner(reviewId, expectedProjectId);
			return response;
		} catch (error) {
			this.receipts.cancel(id, localize('reviewControlRequestCancelled', '리뷰 열기 요청이 취소됐습니다.'));
			if (!contents.isDestroyed()) {
				const cancel: ReviewControlCancel = { kind: 'cancel', id, generation };
				window.send(REVIEW_CONTROL_DISPATCH_CHANNEL, cancel);
			}
			throw error;
		}
	}

	private assertReviewProjectOwner(reviewId: string, projectId: string): void {
		if (!this.database?.listProjectIdsForReview(reviewId).includes(projectId)) {
			throw new Error(localize('reviewControlProjectLinkChanged', '리뷰와 프로젝트의 연결이 바뀌었습니다. 작업에서 다시 열어 주세요.'));
		}
	}

	private async destinationForReview(reviewId: string, signal: AbortSignal): Promise<ICodeWindow | undefined> {
		const owners = this.database?.listProjectIdsForReview(reviewId) ?? [];
		const destination = reviewControlDestination(owners);
		let projectId: string | undefined;
		if (destination.kind === 'project') {
			projectId = destination.projectId;
		} else {
			const parent = [this.windows.getFocusedWindow(), this.windows.getLastActiveWindow(), ...this.windows.getWindows()]
				.map(window => window?.win)
				.find(window => window && !window.isDestroyed()) ?? (await this.homeWindow(signal))?.win;
			if (!parent || signal.aborted) return undefined;
			const projects = destination.projectIds.map(id => this.database?.getProject(id)).filter(project => !!project);
			const buttons = [...projects.map(project => project.name), localize('reviewControlHome', '리뷰 홈'), localize('reviewControlCancel', '취소')];
			const choice = await dialog.showMessageBox(parent, {
				title: localize('reviewControlTitle', '리뷰 열기'),
				message: owners.length === 0
					? localize('reviewControlNoOwner', '이 리뷰를 열 위치를 선택하세요.')
					: localize('reviewControlMultipleOwners', '이 리뷰가 여러 프로젝트에 연결되어 있습니다. 열 위치를 선택하세요.'),
				buttons, cancelId: buttons.length - 1, defaultId: buttons.length - 1, noLink: true, signal,
			});
			if (signal.aborted) return undefined;
			if (choice.response === buttons.length - 1) return undefined;
			projectId = choice.response < projects.length ? projects[choice.response].id : undefined;
			if (!projectId) return this.homeWindow(signal);
		}
		if (!projectId) throw new Error(localize('reviewControlProjectSelectionUnavailable', '선택한 프로젝트를 사용할 수 없습니다.'));
		if (signal.aborted) return undefined;
		this.assertReviewProjectOwner(reviewId, projectId);
		await this.openProject(projectId);
		if (signal.aborted) return undefined;
		return this.windows.getWindows().find(window => this.isProjectWindow(window, projectId) && !!window.win?.webContents && !window.win.webContents.isDestroyed());
	}

	private async globalDestination(signal: AbortSignal): Promise<ICodeWindow | undefined> {
		const eligible = (window: ICodeWindow | undefined) => window?.config?.reviewWindowLaunch.kind === 'home' || window?.config?.reviewWindowLaunch.kind === 'project';
		const focused = this.windows.getFocusedWindow();
		if (eligible(focused)) return focused;
		const last = this.windows.getLastActiveWindow();
		if (eligible(last)) return last;
		return this.homeWindow(signal);
	}

	private async homeWindow(signal: AbortSignal): Promise<ICodeWindow | undefined> {
		if (signal.aborted) return undefined;
		const existing = this.windows.getWindows().find(window => window.config?.reviewWindowLaunch.kind === 'home' && !!window.win?.webContents && !window.win.webContents.isDestroyed());
		if (existing) return existing;
		const opened = (await this.windows.openEmptyWindow({ context: OpenContext.API }))[0];
		return signal.aborted ? undefined : opened;
	}

	private async withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, deadline: number): Promise<T> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(localize('reviewControlSelectionTimedOut', '리뷰를 열 위치를 정하는 데 시간이 초과됐습니다.'));
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation(controller.signal),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error(localize('reviewControlSelectionTimedOut', '리뷰를 열 위치를 정하는 데 시간이 초과됐습니다.')));
					}, remaining);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			controller.abort();
		}
	}

	private async waitUntilReady(window: ICodeWindow, deadline: number): Promise<void> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(localize('reviewControlWindowNotReady', '리뷰를 열 창이 준비되지 않았습니다.'));
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				window.ready(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(localize('reviewControlWindowNotReady', '리뷰를 열 창이 준비되지 않았습니다.'))), remaining);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	override dispose(): void {
		this.controller.abort();
		this.receipts.dispose();
		super.dispose();
	}
}
