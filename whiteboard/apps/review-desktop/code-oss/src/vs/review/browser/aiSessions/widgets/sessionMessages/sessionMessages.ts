import type { WorkspaceAgentSessionMailboxMessage, WorkspaceAgentSessionMailboxPage } from '../../../../../workspace/common/workspaceAgentCommunicationProtocol.js';
import type { AgentSessionDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import { agentSessionSummary } from '../../entities/agentSession/index.js';

const PAGE_SIZE = 50;
const MAX_MESSAGES = 500;
const MAX_BYTES = 1024 * 1024;
const POLL_INTERVAL_MS = 3500;
const TARGET_REVEAL_TIMEOUT_MS = 10_000;

export interface SessionMessagesActions {
	readonly loadPage: (afterSequence: number, limit: number) => Promise<WorkspaceAgentSessionMailboxPage>;
	readonly loadMessage: (messageId: string) => Promise<WorkspaceAgentSessionMailboxMessage | null>;
	readonly sessions: readonly AgentSessionDTO[];
}

export interface SessionMessagesController {
	setContext(projectId: string, recipientSessionId: string, actions: SessionMessagesActions, targetMessageId?: string): void;
	setTargetMessageId(messageId: string | undefined): void;
	revealMessage(messageId: string): Promise<boolean>;
	setVisible(visible: boolean): void;
	refresh(): void;
	dispose(): void;
}

export function createSessionMessages(parent: HTMLElement, projectId: string, recipientSessionId: string, actions: SessionMessagesActions, targetMessageId?: string): SessionMessagesController {
	parent.classList.add('ai-session-messages');
	parent.replaceChildren();

	const heading = document.createElement('header');
	heading.className = 'ai-session-messages__heading';
	const title = document.createElement('h2');
	title.textContent = '세션 메시지';
	const description = document.createElement('p');
	description.className = 'ai-session-messages__description';
	description.textContent = '선택한 세션의 우편함을 읽습니다. 사람이 열어 봐도 AI 읽음 상태는 바뀌지 않습니다.';
	heading.append(title, description);

	const toolbar = document.createElement('div');
	toolbar.className = 'ai-session-messages__toolbar';
	const firstButton = makeButton('처음 메시지 다시 읽기');
	const nextButton = makeButton('다음 메시지 불러오기');
	const retryButton = makeButton('다시 시도');
	toolbar.append(firstButton, nextButton, retryButton);

	const status = document.createElement('p');
	status.className = 'ai-session-messages__status';
	status.setAttribute('role', 'status');
	status.setAttribute('aria-live', 'polite');
	const error = document.createElement('p');
	error.className = 'ai-session-messages__error';
	error.setAttribute('role', 'alert');
	error.hidden = true;
	const empty = document.createElement('p');
	empty.className = 'ai-session-messages__empty';
	empty.setAttribute('role', 'status');
	empty.hidden = true;
	const list = document.createElement('ol');
	list.className = 'ai-session-messages__list';
	list.setAttribute('aria-label', '세션 우편함 메시지');
	parent.append(heading, toolbar, status, error, empty, list);

	let currentProjectId = projectId;
	let currentRecipientSessionId = recipientSessionId;
	let currentActions = actions;
	let currentTargetMessageId = targetMessageId;
	let visible = false;
	let disposed = false;
	let connected = true;
	let loading = false;
	let hasMore = true;
	let cursor = 0;
	let requestGeneration = 0;
	let contextGeneration = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let trimmedMessages = 0;
	let trimmedBytes = 0;
	let errorMessage: string | undefined;
	let targetNotice: string | undefined;
	let findingTarget = false;
	let targetLookupFailed = false;
	let targetFocusPending = !!targetMessageId;
	let messages: WorkspaceAgentSessionMailboxMessage[] = [];
	let locateGeneration = 0;
	let listDirty = true;
	let targetRevealTimer: ReturnType<typeof setTimeout> | undefined;
	let resolveTargetReveal: ((opened: boolean) => void) | undefined;

	const finishTargetReveal = (opened: boolean): void => {
		if (targetRevealTimer) { clearTimeout(targetRevealTimer); targetRevealTimer = undefined; }
		const resolve = resolveTargetReveal;
		resolveTargetReveal = undefined;
		resolve?.(opened);
	};

	const beginTargetReveal = (): Promise<boolean> => {
		finishTargetReveal(false);
		return new Promise(resolve => {
			resolveTargetReveal = resolve;
			targetRevealTimer = setTimeout(() => {
				targetFocusPending = false;
				finishTargetReveal(false);
			}, TARGET_REVEAL_TIMEOUT_MS);
		});
	};

	const totalBytes = (): number => messages.reduce((sum, message) => sum + utf8Bytes(message.body), 0);

	const render = (): void => {
		if (listDirty) {
			const workspace = parent.closest<HTMLElement>('.ai-session-workspace');
			const workspaceScrollTop = workspace?.scrollTop;
			const focusedMessageId = document.activeElement instanceof HTMLElement && list.contains(document.activeElement)
				? document.activeElement.dataset.messageId
				: undefined;
			list.replaceChildren();
			for (const message of messages) {
				list.appendChild(renderMessage(message));
			}
			if (focusedMessageId) {
				list.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focusedMessageId)}"]`)?.focus({ preventScroll: true });
			}
			if (workspace && workspaceScrollTop !== undefined) { workspace.scrollTop = workspaceScrollTop; }
			listDirty = false;
		}

		const bytes = totalBytes();
		const first = messages[0]?.sequence;
		const last = messages.at(-1)?.sequence;
		const range = first !== undefined && last !== undefined ? `순번 ${first}–${last}` : '메시지 없음';
		const state = loading ? '불러오는 중' : connected ? '연결됨' : '연결 끊김 · 마지막으로 불러온 우편함 기록을 유지합니다.';
		const trim = trimmedMessages ? ` · 화면 한도에 따라 오래된 메시지 ${trimmedMessages}개(${formatBytes(trimmedBytes)})를 목록에서 잘랐습니다.` : '';
		const localCap = messages.length >= MAX_MESSAGES || bytes >= MAX_BYTES ? ' · 화면 한도에 도달했습니다. 처음 메시지를 다시 읽어 목록을 교체할 수 있습니다.' : '';
		status.textContent = `${state} · ${messages.length}/${MAX_MESSAGES}개 · ${formatBytes(bytes)}/${formatBytes(MAX_BYTES)} · ${range}${trim}${localCap}${targetNotice ? ` · ${targetNotice}` : ''}`;
		error.hidden = !errorMessage;
		error.textContent = errorMessage ? `우편함을 불러오지 못했습니다: ${errorMessage}` : '';
		retryButton.hidden = !errorMessage;
		empty.hidden = messages.length > 0 || loading || !!errorMessage;
		empty.textContent = '이 세션의 받은 메시지가 없습니다.';
		firstButton.disabled = loading;
		nextButton.disabled = loading || !hasMore || messages.length >= MAX_MESSAGES || bytes >= MAX_BYTES;
	};

	const focusTarget = (): boolean => {
		if (!currentTargetMessageId) { return false; }
		const target = list.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(currentTargetMessageId)}"]`);
		if (!target) { return false; }
		target.scrollIntoView({ block: 'center' });
		target.focus({ preventScroll: true });
		return document.activeElement === target;
	};

	const focusPendingTarget = (): boolean => {
		if (disposed || !visible || !targetFocusPending || !focusTarget()) { return false; }
		targetFocusPending = false;
		targetNotice = '알림에서 연 메시지를 강조했습니다. 사람의 조회는 AI 읽음 상태를 바꾸지 않습니다.';
		finishTargetReveal(true);
		return true;
	};

	const renderMessage = (message: WorkspaceAgentSessionMailboxMessage): HTMLLIElement => {
		const item = document.createElement('li');
		item.className = 'ai-session-messages__item';
		const messageContent = document.createElement('article');
		messageContent.className = 'ai-session-messages__message';
		messageContent.tabIndex = 0;
		messageContent.dataset.messageId = message.id;
		const highlighted = message.id === currentTargetMessageId;
		messageContent.setAttribute('aria-current', String(highlighted));
		if (highlighted) { messageContent.classList.add('ai-session-messages__highlight'); }
		const meta = document.createElement('div');
		meta.className = 'ai-session-messages__meta';
		const sender = currentActions.sessions.find(session => session.id === message.senderSessionId);
		const senderName = document.createElement('strong');
		senderName.className = 'ai-session-messages__sender';
		senderName.textContent = sender?.name ?? `이름 확인 불가 · 세션 ID ${message.senderSessionId}`;
		meta.appendChild(senderName);
		if (sender) {
			const senderModel = document.createElement('span');
			senderModel.textContent = `${agentSessionSummary(sender)} · 세션 ID ${sender.id}`;
			meta.appendChild(senderModel);
		}
		const time = document.createElement('time');
		time.dateTime = message.createdAt;
		time.textContent = formatDate(message.createdAt);
		meta.appendChild(time);
		const body = document.createElement('p');
		body.className = 'ai-session-messages__body';
		body.textContent = message.body;
		const readState = document.createElement('span');
		readState.className = `ai-session-messages__read-state${message.readAt ? ' ai-session-messages__read-state--read' : ''}`;
		readState.textContent = message.readAt ? `AI가 읽음 · ${formatDate(message.readAt)}` : '우편함에 보관됨 · AI 읽음 표시 없음';
		messageContent.append(meta, body, readState);
		item.appendChild(messageContent);
		return item;
	};

	const trimMessages = (): void => {
		let bytes = totalBytes();
		while (messages.length > MAX_MESSAGES || bytes > MAX_BYTES) {
			const oldest = messages.shift();
			if (!oldest) { break; }
			const size = utf8Bytes(oldest.body);
			trimmedMessages++;
			trimmedBytes += size;
			bytes -= size;
		}
	};

	const schedulePoll = (): void => {
		if (timer) { clearTimeout(timer); timer = undefined; }
		if (disposed || !visible || !connected || findingTarget || targetLookupFailed) { return; }
		timer = setTimeout(() => {
			timer = undefined;
			void refreshLoadedWindow();
		}, POLL_INTERVAL_MS);
	};

	const refreshLoadedWindow = async (): Promise<void> => {
		if (disposed || !visible || !connected || loading) { return; }
		if (!messages.length) { void fetchPage(cursor); return; }
		loading = true;
		errorMessage = undefined;
		const generation = ++requestGeneration;
		const context = contextGeneration;
		const requestedRecipientId = currentRecipientSessionId;
		const firstSequence = messages[0].sequence;
		const lastSequence = messages.at(-1)!.sequence;
		const updatedMessages = new Map<string, WorkspaceAgentSessionMailboxMessage>();
		render();
		try {
			let afterSequence = Math.max(0, firstSequence - 1);
			while (afterSequence < lastSequence) {
				const page = await currentActions.loadPage(afterSequence, PAGE_SIZE);
				if (disposed || generation !== requestGeneration || context !== contextGeneration) { return; }
				for (const message of page.messages) {
					if (message.recipientSessionId !== requestedRecipientId) { throw new Error('다른 세션의 우편함 응답을 받았습니다.'); }
					if (message.sequence > lastSequence) { break; }
					if (messages.some(existing => existing.id === message.id)) { updatedMessages.set(message.id, message); }
				}
				const nextCursor = page.nextCursor > afterSequence ? page.nextCursor : page.messages.at(-1)?.sequence ?? afterSequence;
				if (nextCursor <= afterSequence) { break; }
				afterSequence = nextCursor;
				if (!page.hasMore && afterSequence < lastSequence) { break; }
			}
			messages = messages.map(message => {
				const updated = updatedMessages.get(message.id);
				if (!updated) { return message; }
				if (updated.readAt !== message.readAt) { listDirty = true; }
				return updated;
			});
			connected = true;
		} catch (cause) {
			if (disposed || generation !== requestGeneration || context !== contextGeneration) { return; }
			connected = false;
			errorMessage = describeError(cause);
		} finally {
			if (generation === requestGeneration) {
				loading = false;
				render();
				if (connected && !hasMore && messages.length < MAX_MESSAGES && totalBytes() < MAX_BYTES) { void fetchPage(cursor); }
				else { schedulePoll(); }
			}
		}
	};

	const fetchPage = async (afterSequence: number): Promise<boolean> => {
		if (disposed || !visible || !connected || loading || messages.length >= MAX_MESSAGES || totalBytes() >= MAX_BYTES) { render(); return false; }
		loading = true;
		errorMessage = undefined;
		const generation = ++requestGeneration;
		const context = contextGeneration;
		const requestedRecipientId = currentRecipientSessionId;
		render();
		let added = false;
		try {
			const page = await currentActions.loadPage(afterSequence, PAGE_SIZE);
			if (disposed || generation !== requestGeneration || context !== contextGeneration) { return false; }
			connected = true;
			errorMessage = undefined;
			hasMore = page.hasMore;
			for (const message of page.messages) {
				if (message.recipientSessionId !== requestedRecipientId) { throw new Error('다른 세션의 우편함 응답을 받았습니다.'); }
				if (!messages.some(existing => existing.id === message.id)) { messages.push(message); added = true; }
				cursor = Math.max(cursor, message.sequence);
			}
			if (page.nextCursor > cursor) { cursor = page.nextCursor; }
			messages.sort((left, right) => left.sequence - right.sequence);
			trimMessages();
			if (added) { listDirty = true; }
			return added;
		} catch (cause) {
			if (disposed || generation !== requestGeneration || context !== contextGeneration) { return false; }
			connected = false;
			errorMessage = describeError(cause);
			return false;
		} finally {
			if (generation === requestGeneration) {
				loading = false;
				render();
				schedulePoll();
			}
		}
	};

	const loadTargetMessage = async (): Promise<void> => {
		const targetId = currentTargetMessageId;
		if (!targetId || !targetFocusPending || findingTarget || disposed || !visible) { return; }
		if (messages.some(message => message.id === targetId)) {
			render();
			if (focusPendingTarget()) { render(); }
			return;
		}
		findingTarget = true;
		loading = true;
		errorMessage = undefined;
		targetNotice = '알림 메시지를 불러오는 중입니다.';
		const generation = ++locateGeneration;
		const request = ++requestGeneration;
		const context = contextGeneration;
		const requestedProjectId = currentProjectId;
		const requestedRecipientId = currentRecipientSessionId;
		const actionsForRequest = currentActions;
		render();
		let found = false;
		try {
			const target = await actionsForRequest.loadMessage(targetId);
			if (disposed || generation !== locateGeneration || request !== requestGeneration || context !== contextGeneration
				|| requestedProjectId !== currentProjectId || requestedRecipientId !== currentRecipientSessionId || targetId !== currentTargetMessageId) { return; }
			if (!target) {
				throw new Error('알림에서 연 메시지를 현재 세션 우편함에서 찾을 수 없습니다.');
			}
			if (target.id !== targetId || target.recipientSessionId !== requestedRecipientId) {
				throw new Error('알림 메시지가 현재 세션 우편함과 일치하지 않습니다.');
			}
			const page = await actionsForRequest.loadPage(Math.max(0, target.sequence - 1), PAGE_SIZE);
			if (disposed || generation !== locateGeneration || request !== requestGeneration || context !== contextGeneration
				|| requestedProjectId !== currentProjectId || requestedRecipientId !== currentRecipientSessionId || targetId !== currentTargetMessageId) { return; }
			if (page.messages.some(message => message.recipientSessionId !== requestedRecipientId)) {
				throw new Error('다른 세션의 우편함 응답을 받았습니다.');
			}
			const pageTarget = page.messages.find(message => message.id === targetId) ?? target;
			messages = [pageTarget, ...page.messages.filter(message => message.id !== targetId)];
			messages.sort((left, right) => left.sequence - right.sequence);
			cursor = Math.max(target.sequence, page.nextCursor);
			hasMore = page.hasMore;
			trimmedMessages = 0;
			trimmedBytes = 0;
			trimMessages();
			listDirty = true;
			connected = true;
			errorMessage = undefined;
			targetLookupFailed = false;
			targetNotice = '알림에서 연 메시지와 그 이후 우편함 기록을 표시합니다.';
			found = true;
		} catch (cause) {
			if (disposed || generation !== locateGeneration || request !== requestGeneration || context !== contextGeneration
				|| requestedProjectId !== currentProjectId || requestedRecipientId !== currentRecipientSessionId || targetId !== currentTargetMessageId) { return; }
			connected = true;
			errorMessage = describeError(cause);
			targetNotice = errorMessage;
			targetFocusPending = false;
			targetLookupFailed = true;
			finishTargetReveal(false);
		} finally {
			if (!disposed && generation === locateGeneration && request === requestGeneration && context === contextGeneration) {
				findingTarget = false;
				loading = false;
				if (found) { listDirty = true; }
				render();
				if (found && focusPendingTarget()) { render(); }
				schedulePoll();
			}
		}
	};

	firstButton.addEventListener('click', () => {
		finishTargetReveal(false);
		if (timer) { clearTimeout(timer); timer = undefined; }
		requestGeneration++;
		locateGeneration++;
		findingTarget = false;
		loading = false;
		messages = [];
		listDirty = true;
		cursor = 0;
		hasMore = true;
		trimmedMessages = 0;
		trimmedBytes = 0;
		errorMessage = undefined;
		connected = true;
		targetFocusPending = false;
		targetLookupFailed = false;
		targetNotice = undefined;
		void fetchPage(0);
	});
	nextButton.addEventListener('click', () => { void fetchPage(cursor); });
	retryButton.addEventListener('click', () => {
		connected = true;
		if (currentTargetMessageId && targetLookupFailed) {
			targetLookupFailed = false;
			targetFocusPending = true;
			void loadTargetMessage();
		} else {
			void refreshLoadedWindow();
		}
	});

	render();

	return {
		setContext(projectIdValue, recipientSessionIdValue, actionsValue, targetMessageIdValue): void {
			if (disposed) { return; }
			const sessionsChanged = currentActions.sessions !== actionsValue.sessions;
			currentActions = actionsValue;
			const changed = currentProjectId !== projectIdValue || currentRecipientSessionId !== recipientSessionIdValue;
			const targetChanged = currentTargetMessageId !== targetMessageIdValue;
			if (changed || targetChanged) { finishTargetReveal(false); }
			if (changed) {
				if (timer) { clearTimeout(timer); timer = undefined; }
				contextGeneration++;
				requestGeneration++;
				locateGeneration++;
				findingTarget = false;
				currentProjectId = projectIdValue;
				currentRecipientSessionId = recipientSessionIdValue;
				currentTargetMessageId = targetMessageIdValue;
				targetFocusPending = !!targetMessageIdValue;
				messages = [];
				listDirty = true;
				cursor = 0;
				hasMore = true;
				trimmedMessages = 0;
				trimmedBytes = 0;
				loading = false;
				connected = true;
				errorMessage = undefined;
				targetNotice = undefined;
				targetLookupFailed = false;
			}
			if (targetChanged) {
				currentTargetMessageId = targetMessageIdValue;
				targetFocusPending = !!targetMessageIdValue;
				targetLookupFailed = false;
				requestGeneration++;
				locateGeneration++;
				findingTarget = false;
				loading = false;
				errorMessage = undefined;
				targetNotice = undefined;
			}
			if (!changed && !targetChanged && !sessionsChanged) { return; }
			if (targetChanged || sessionsChanged) { listDirty = true; }
			render();
			if (visible && currentTargetMessageId && targetFocusPending) { void loadTargetMessage(); }
			else if (visible && changed) { void fetchPage(0); }
		},
		setTargetMessageId(messageId): void {
			if (disposed || currentTargetMessageId === messageId) { return; }
			finishTargetReveal(false);
			currentTargetMessageId = messageId;
			targetFocusPending = !!messageId;
			targetLookupFailed = false;
			requestGeneration++;
			listDirty = true;
			locateGeneration++;
			findingTarget = false;
			loading = false;
			errorMessage = undefined;
			targetNotice = undefined;
			render();
			if (messageId && messages.some(message => message.id === messageId)) {
				requestAnimationFrame(() => { if (focusPendingTarget()) { render(); } });
			} else if (messageId && visible && !loading) {
				void loadTargetMessage();
			}
		},
		revealMessage(messageId): Promise<boolean> {
			if (disposed || !messageId || !visible) { return Promise.resolve(false); }
			const completion = beginTargetReveal();
			if (currentTargetMessageId !== messageId) {
				currentTargetMessageId = messageId;
				targetFocusPending = true;
				targetLookupFailed = false;
				requestGeneration++;
				locateGeneration++;
				findingTarget = false;
				loading = false;
				errorMessage = undefined;
				targetNotice = undefined;
				listDirty = true;
				render();
				if (messages.some(message => message.id === messageId)) {
					requestAnimationFrame(() => { if (focusPendingTarget()) { render(); } });
				} else if (visible && !loading) {
					void loadTargetMessage();
				}
				return completion;
			}
			if (targetFocusPending || findingTarget) { return completion; }
			targetFocusPending = true;
			targetLookupFailed = false;
			errorMessage = undefined;
			targetNotice = undefined;
			if (messages.some(message => message.id === messageId)) {
				requestAnimationFrame(() => { if (focusPendingTarget()) { render(); } });
			} else if (visible) {
				void loadTargetMessage();
			}
			return completion;
		},
		setVisible(value): void {
			if (disposed || visible === value) { return; }
			visible = value;
			if (!visible) {
				finishTargetReveal(false);
				if (timer) { clearTimeout(timer); timer = undefined; }
				requestGeneration++;
				locateGeneration++;
				findingTarget = false;
				loading = false;
			} else {
				connected = true;
				if (currentTargetMessageId && targetFocusPending) { void loadTargetMessage(); }
				else if (!targetLookupFailed) { void refreshLoadedWindow(); }
			}
			render();
		},
		refresh(): void { connected = true; void refreshLoadedWindow(); },
		dispose(): void {
			if (disposed) { return; }
			disposed = true;
			finishTargetReveal(false);
			contextGeneration++;
			requestGeneration++;
			locateGeneration++;
			if (timer) { clearTimeout(timer); timer = undefined; }
			parent.replaceChildren();
		},
	};
}

function makeButton(text: string): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'ai-session-messages__button';
	button.textContent = text;
	return button;
}

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR');
}

function formatBytes(value: number): string {
	return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function describeError(cause: unknown): string {
	if (cause instanceof Error && cause.message) { return cause.message; }
	return '알 수 없는 오류';
}
