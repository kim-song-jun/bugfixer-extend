/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcRenderer } from '../../../base/parts/sandbox/electron-browser/globals.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { FocusMode } from '../../../platform/native/common/native.js';
import { REVIEW_CONTROL_ACK_CHANNEL, REVIEW_CONTROL_DISPATCH_CHANNEL, runReviewControlOpen, type ReviewControlAck, type ReviewControlDispatch, type ReviewControlCancel } from '../../common/reviewControlDispatch.js';
import { REVIEW_SOFTWARE_MAP_SETTING } from '../../common/reviewConfigurationDefaults.js';
import type { ReviewVerbResponse } from '../../common/reviewProtocol.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import { IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IReviewApiCatalogService } from '../../services/reviewApiCatalogService.js';
import { IReviewCanvasEditorTabsService } from '../../services/reviewCanvasEditorTabsService.js';
import { IReviewVerbsService } from './reviewVerbs.js';

/** Executes only main-selected control commands in this window and reports a receipt. */
class ReviewControlContribution extends Disposable {
	private readonly pending = new Map<string, { generation: number; cancelled: boolean }>();
	private readonly latestReviewRequest = new Map<string, string>();

	constructor(
		@IReviewVerbsService private readonly verbs: IReviewVerbsService,
		@IReviewCanvasEditorTabsService private readonly tabs: IReviewCanvasEditorTabsService,
		@IReviewApiCatalogService private readonly catalog: IReviewApiCatalogService,
		@IEditorService private readonly editor: IEditorService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IHostService private readonly host: IHostService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		const listener = (_event: unknown, payload: unknown) => {
			const value = payload as ReviewControlDispatch | ReviewControlCancel;
			if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !Number.isSafeInteger(value.generation)) return;
			if (value.kind === 'cancel') {
				const current = this.pending.get(value.id);
				if (current?.generation === value.generation) current.cancelled = true;
				return;
			}
			if (value.kind !== 'dispatch' || this.pending.has(value.id)) return;
			const state = { generation: value.generation, cancelled: false };
			this.pending.set(value.id, state);
			void this.execute(value, state).then(response => {
				if (!state.cancelled) {
					const ack: ReviewControlAck = { id: value.id, generation: value.generation, response };
					ipcRenderer.send(REVIEW_CONTROL_ACK_CHANNEL, ack);
				}
			}).catch(error => console.error('[Whiteboard] Review control acknowledgement failed:', error))
				.finally(() => this.pending.delete(value.id));
		};
		ipcRenderer.on(REVIEW_CONTROL_DISPATCH_CHANNEL, listener);
		this._register({ dispose: () => ipcRenderer.removeListener(REVIEW_CONTROL_DISPATCH_CHANNEL, listener) });
	}

	private async execute(value: ReviewControlDispatch, state: { cancelled: boolean }): Promise<ReviewVerbResponse> {
		try {
			const request = value.request;
			if (request.name === 'authoringCapabilities') return { ok: true, result: { softwareMapEnabled: this.softwareMapEnabled() } };
			if (request.name === 'focusWindow') {
				await this.host.focus(window, { mode: FocusMode.Force });
				return { ok: true };
			}
			if (request.name === 'openApiReview' || request.name === 'openReview') {
				const reviewId = request.name === 'openApiReview' ? request.args.reviewId : request.args.reviewUuid;
				const title = request.name === 'openApiReview' ? request.args.title : await this.reviewTitle(reviewId);
				if (state.cancelled) return { ok: false, error: localize('reviewControlRequestCancelled', '리뷰 열기 요청이 취소됐습니다.') };
				const key = `api:${reviewId}`;
				const input = this.tabs.inputFor({ kind: 'api', reviewId, title });
				const existing = this.groups.groups.some(group => group.contains(input));
				const group = this.groups.groups.find(candidate => candidate.contains(input)) ?? this.groups.mainPart.activeGroup;
				let matchingOpens = 0;
				const opening = this.editor.onWillOpenEditor(event => {
					if (event.groupId === group.id && event.editor.matches(input)) matchingOpens++;
				});
				let committed: boolean;
				try {
					committed = await runReviewControlOpen(
						value.id, key, this.latestReviewRequest, () => state.cancelled,
						() => this.editor.openEditor(input, { pinned: true, inactive: request.name === 'openReview' && !request.args.active, revealIfVisible: true }, group),
						async () => { if (!existing && group.contains(input)) await group.closeEditor(input); },
						() => !existing && matchingOpens === 1,
					);
				} finally {
					opening.dispose();
				}
				if (!committed) {
					return { ok: false, error: localize('reviewControlRequestCancelled', '리뷰 열기 요청이 취소됐습니다.') };
				}
				return { ok: true, result: { softwareMapEnabled: this.softwareMapEnabled() } };
			}
			if (state.cancelled) return { ok: false, error: localize('reviewControlRequestCancelled', '리뷰 열기 요청이 취소됐습니다.') };
			return await this.verbs.dispatch(request);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async reviewTitle(reviewId: string): Promise<string> {
		await this.catalog.initialize();
		const review = this.catalog.reviews.find(candidate => candidate.reviewId === reviewId);
		if (!review) throw new Error(localize('reviewControlSessionNotFound', '리뷰를 찾을 수 없습니다. 목록을 새로고침해 주세요.'));
		return review.title;
	}

	private softwareMapEnabled(): boolean {
		return this.configuration.getValue<boolean>(REVIEW_SOFTWARE_MAP_SETTING) === true;
	}
}

registerWorkbenchContribution2('review.control.dispatch', ReviewControlContribution, WorkbenchPhase.BlockRestore);
