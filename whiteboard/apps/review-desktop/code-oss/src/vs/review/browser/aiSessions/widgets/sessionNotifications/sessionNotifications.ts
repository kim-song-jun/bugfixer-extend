import type { AgentSessionDTO, SessionNotificationDTO, SessionPageOptions } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import type { WorkspaceAgentSessionNotificationStatus } from '../../../../../workspace/common/workspaceAgentCommunicationProtocol.js';

const PAGE_SIZE = 50;
const MAX_NOTIFICATIONS = 200;
const POLL_INTERVAL_MS = 5000;

export interface SessionNotificationsActions {
	readonly loadPage: (options: SessionPageOptions) => Promise<readonly SessionNotificationDTO[]>;
	readonly loadStatus: () => Promise<WorkspaceAgentSessionNotificationStatus>;
	readonly markRead: (notificationId: string) => Promise<void>;
	readonly onOpen: (notification: SessionNotificationDTO) => Promise<boolean>;
}

export interface SessionNotificationsController {
	setContext(projectId: string, sessions: readonly AgentSessionDTO[], actions: SessionNotificationsActions): void;
	setVisible(visible: boolean): void;
	refresh(): void;
	dispose(): void;
}

export function createSessionNotifications(parent: HTMLElement, projectId: string, sessions: readonly AgentSessionDTO[], actions: SessionNotificationsActions): SessionNotificationsController {
	parent.classList.add('ai-session-notifications');
	parent.replaceChildren();

	const trigger = document.createElement('button');
	trigger.type = 'button';
	trigger.className = 'ai-session-notifications__trigger';
	trigger.setAttribute('aria-haspopup', 'dialog');
	trigger.setAttribute('aria-expanded', 'false');
	const triggerLabel = document.createElement('span');
	triggerLabel.textContent = '알림';
	const badge = document.createElement('span');
	badge.className = 'ai-session-notifications__badge';
	badge.setAttribute('aria-hidden', 'true');
	trigger.append(triggerLabel, badge);
	const newAlertsButton = makeButton('새 알림 보기');
	newAlertsButton.classList.add('ai-session-notifications__new-alerts');

	const popover = document.createElement('section');
	popover.className = 'ai-session-notifications__popover';
	popover.id = `ai-session-notifications-${projectId}`;
	popover.setAttribute('role', 'dialog');
	popover.setAttribute('aria-label', '프로젝트 알림');
	popover.hidden = true;
	trigger.setAttribute('aria-controls', popover.id);

	const heading = document.createElement('header');
	heading.className = 'ai-session-notifications__heading';
	const title = document.createElement('h2');
	title.textContent = '프로젝트 알림';
	const closeButton = document.createElement('button');
	closeButton.type = 'button';
	closeButton.className = 'ai-session-notifications__close';
	closeButton.setAttribute('aria-label', '알림 닫기');
	closeButton.textContent = '닫기';
	heading.append(title, closeButton);

	const status = document.createElement('p');
	status.className = 'ai-session-notifications__status';
	status.setAttribute('role', 'status');
	status.setAttribute('aria-live', 'polite');
	const error = document.createElement('p');
	error.className = 'ai-session-notifications__error';
	error.setAttribute('role', 'alert');
	error.hidden = true;
	const list = document.createElement('ol');
	list.className = 'ai-session-notifications__list';
	list.setAttribute('aria-label', '불러온 프로젝트 알림');
	const controls = document.createElement('div');
	controls.className = 'ai-session-notifications__controls';
	const firstButton = makeButton('처음 알림 다시 읽기');
	const nextButton = makeButton('다음 알림 불러오기');
	const retryButton = makeButton('다시 시도');
	controls.append(firstButton, nextButton, retryButton);
	popover.append(heading, status, error, list, controls);
	parent.append(trigger, newAlertsButton, popover);

	let currentProjectId = projectId;
	let currentSessions = sessions;
	let currentActions = actions;
	let visible = false;
	let expanded = false;
	let disposed = false;
	let loading = false;
	let connected = true;
	let cursor = 0;
	let hasMore = true;
	let requestGeneration = 0;
	let contextGeneration = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let trimmedCount = 0;
	let errorMessage: string | undefined;
	let openErrorMessage: string | undefined;
	let statusErrorMessage: string | undefined;
	let unreadCount: number | undefined;
	let latestSequence = 0;
	let statusLoading = false;
	let statusRequestGeneration = 0;
	let notifications: SessionNotificationDTO[] = [];
	let listDirty = true;

	const setExpanded = (value: boolean, restoreFocus = false, refresh = true): void => {
		expanded = value;
		popover.hidden = !expanded;
		trigger.setAttribute('aria-expanded', String(expanded));
		if (expanded) {
			if (refresh) {
				void refreshStatus();
				void refreshLoadedWindow();
				requestAnimationFrame(() => (list.querySelector<HTMLButtonElement>('.ai-session-notifications__item') ?? closeButton).focus({ preventScroll: true }));
			}
		} else if (restoreFocus) {
			trigger.focus({ preventScroll: true });
		}
	};

	const render = (): void => {
		const loadedUnread = notifications.filter(notification => notification.readAt === null).length;
		badge.hidden = unreadCount === undefined || unreadCount === 0;
		badge.textContent = unreadCount !== undefined && unreadCount > 99 ? '99+' : String(unreadCount ?? '');
		let triggerLabel: string;
		if (unreadCount !== undefined) {
			triggerLabel = `알림, 전체 읽지 않은 ${unreadCount}개`;
		} else if (statusErrorMessage) {
			triggerLabel = '알림, 전체 읽지 않은 수 확인 실패. 다시 시도해 주세요.';
		} else {
			triggerLabel = `알림, 전체 읽지 않은 수 ${statusLoading ? '확인 중' : '확인 불가'}`;
		}
		trigger.setAttribute('aria-label', triggerLabel);
		newAlertsButton.hidden = latestSequence <= cursor;
		newAlertsButton.disabled = loading || statusLoading || latestSequence <= cursor;

		if (listDirty) {
			const popoverScrollTop = popover.scrollTop;
			const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement)
				? document.activeElement.dataset.notificationId
				: undefined;
			list.replaceChildren();
			for (const notification of notifications) {
				const item = document.createElement('li');
				const button = document.createElement('button');
				button.type = 'button';
				button.className = `ai-session-notifications__item${notification.readAt ? '' : ' ai-session-notifications__item--unread'}`;
				button.dataset.notificationId = notification.id;
				button.setAttribute('aria-current', 'false');
				const recipient = currentSessions.find(session => session.id === notification.sessionId);
				const sessionLabel = recipient?.name ?? `이름 확인 불가 · 세션 ID ${notification.sessionId}`;
				const itemTitle = document.createElement('span');
				itemTitle.className = 'ai-session-notifications__item-title';
				itemTitle.textContent = `${notificationKindLabel(notification.kind)} · ${sessionLabel}`;
				const itemMeta = document.createElement('span');
				itemMeta.className = 'ai-session-notifications__item-meta';
				itemMeta.textContent = `${formatDate(notification.createdAt)} · ${notification.readAt ? '열어 본 알림' : '읽지 않은 알림'}`;
				button.append(itemTitle, itemMeta);
				button.addEventListener('click', () => { void openNotification(notification); });
				item.appendChild(button);
				list.appendChild(item);
			}
			if (focused) {
				list.querySelector<HTMLButtonElement>(`[data-notification-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
			}
			popover.scrollTop = popoverScrollTop;
			listDirty = false;
		}

		const state = loading ? '불러오는 중' : connected ? '연결됨' : '연결 끊김 · 마지막으로 불러온 알림을 유지합니다.';
		const bounds = notifications.length ? `순번 ${notifications[0].sequence}–${notifications.at(-1)!.sequence}` : '알림 없음';
		const trim = trimmedCount ? ` · 화면 한도에 따라 오래된 알림 ${trimmedCount}개를 목록에서 잘랐습니다.` : '';
		let unreadSummary: string;
		if (unreadCount !== undefined) {
			unreadSummary = `전체 읽지 않음 ${unreadCount}개 · 불러온 목록에서 ${loadedUnread}개`;
		} else if (statusErrorMessage) {
			unreadSummary = '전체 읽지 않은 수 확인 실패 · 다시 시도해 주세요';
		} else {
			unreadSummary = '전체 읽지 않은 수 확인 불가';
		}
		const newest = latestSequence > cursor ? ` · 새 알림 있음 · 최신 순번 ${latestSequence}` : '';
		status.textContent = `${state} · ${unreadSummary} · 불러온 목록 ${notifications.length}/${MAX_NOTIFICATIONS}개 · ${bounds}${trim}${newest}`;
		const errors = [
			errorMessage ? `알림 목록: ${errorMessage}` : '',
			statusErrorMessage ? `읽지 않은 알림 수: ${statusErrorMessage}` : '',
			openErrorMessage ? `알림 열기: ${openErrorMessage}` : '',
		].filter(Boolean);
		error.hidden = errors.length === 0;
		error.textContent = errors.join(' · ');
		retryButton.hidden = !errorMessage && !statusErrorMessage;
		firstButton.disabled = loading;
		nextButton.disabled = loading || !hasMore || cursor === 0;
	};

	const schedulePoll = (): void => {
		if (timer) { clearTimeout(timer); timer = undefined; }
		if (disposed || !visible) { return; }
		timer = setTimeout(() => {
			timer = undefined;
			schedulePoll();
			void refreshStatus();
			void refreshLoadedWindow();
		}, POLL_INTERVAL_MS);
	};

	const refreshStatus = async (): Promise<void> => {
		if (disposed || !visible || statusLoading) { return; }
		statusLoading = true;
		const generation = ++statusRequestGeneration;
		const context = contextGeneration;
		const project = currentProjectId;
		const actionsForRequest = currentActions;
		render();
		try {
			const response = await actionsForRequest.loadStatus();
			if (disposed || generation !== statusRequestGeneration || context !== contextGeneration || project !== currentProjectId) { return; }
			if (!Number.isSafeInteger(response.unreadCount) || response.unreadCount < 0 || !Number.isSafeInteger(response.latestSequence) || response.latestSequence < 0) {
				throw new Error('프로젝트 알림 상태 응답이 올바르지 않습니다.');
			}
			unreadCount = response.unreadCount;
			latestSequence = response.latestSequence;
			statusErrorMessage = undefined;
		} catch (cause) {
			if (disposed || generation !== statusRequestGeneration || context !== contextGeneration || project !== currentProjectId) { return; }
			unreadCount = undefined;
			latestSequence = 0;
			statusErrorMessage = describeError(cause);
		} finally {
			if (!disposed && generation === statusRequestGeneration && context === contextGeneration) {
				statusLoading = false;
				render();
			}
		}
	};

	const refreshLoadedWindow = async (): Promise<void> => {
		if (disposed || !visible || !connected || loading) { return; }
		if (!notifications.length) { void fetchPage(cursor); return; }
		loading = true;
		errorMessage = undefined;
		const generation = ++requestGeneration;
		const context = contextGeneration;
		const firstSequence = notifications[0].sequence;
		const lastSequence = notifications.at(-1)!.sequence;
		const updatedNotifications = new Map<string, SessionNotificationDTO>();
		render();
		try {
			let afterSequence = Math.max(0, firstSequence - 1);
			while (afterSequence < lastSequence) {
				const page = await currentActions.loadPage({ afterSequence, limit: PAGE_SIZE });
				if (disposed || generation !== requestGeneration || context !== contextGeneration) { return; }
				for (const notification of page) {
					if (notification.sequence > lastSequence) { break; }
					if (notifications.some(existing => existing.id === notification.id)) { updatedNotifications.set(notification.id, notification); }
				}
				const pageCursor = page.at(-1)?.sequence ?? afterSequence;
				if (pageCursor <= afterSequence) { break; }
				afterSequence = pageCursor;
				if (page.length < PAGE_SIZE && afterSequence < lastSequence) { break; }
			}
			notifications = notifications.map(notification => {
				const updated = updatedNotifications.get(notification.id);
				if (updated && updated.readAt !== notification.readAt) { listDirty = true; }
				return updated ?? notification;
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
				if (connected && !hasMore) { void fetchPage(cursor); }
				else { schedulePoll(); }
			}
		}
	};

	const fetchPage = async (afterSequence: number): Promise<void> => {
		if (disposed || !visible || !connected || loading) { render(); return; }
		loading = true;
		errorMessage = undefined;
		const generation = ++requestGeneration;
		const generationForContext = contextGeneration;
		const requestedProject = currentProjectId;
		render();
		try {
			const page = await currentActions.loadPage({ afterSequence, limit: PAGE_SIZE });
			if (disposed || generation !== requestGeneration || generationForContext !== contextGeneration || requestedProject !== currentProjectId) { return; }
			errorMessage = undefined;
			connected = true;
			hasMore = page.length === PAGE_SIZE;
			for (const notification of page) {
				if (!notifications.some(existing => existing.id === notification.id)) { notifications.push(notification); listDirty = true; }
				cursor = Math.max(cursor, notification.sequence);
			}
			notifications.sort((left, right) => left.sequence - right.sequence);
			while (notifications.length > MAX_NOTIFICATIONS) {
				notifications.shift();
				trimmedCount++;
				listDirty = true;
			}
		} catch (cause) {
			if (disposed || generation !== requestGeneration || generationForContext !== contextGeneration) { return; }
			connected = false;
			errorMessage = describeError(cause);
		} finally {
			if (generation === requestGeneration) {
				loading = false;
				render();
				schedulePoll();
			}
		}
	};

	const showLatestNotifications = async (): Promise<void> => {
		if (disposed || !visible || loading || statusLoading || latestSequence <= cursor) { return; }
		setExpanded(true, false, false);
		loading = true;
		connected = true;
		errorMessage = undefined;
		const generation = ++requestGeneration;
		const context = contextGeneration;
		const project = currentProjectId;
		const sequence = latestSequence;
		const actionsForRequest = currentActions;
		render();
		let opened = false;
		try {
			const page = await actionsForRequest.loadPage({ afterSequence: Math.max(0, sequence - 1), limit: PAGE_SIZE });
			if (disposed || generation !== requestGeneration || context !== contextGeneration || project !== currentProjectId) { return; }
			if (!page.length) { throw new Error('새 알림을 불러오지 못했습니다. 알림 상태를 다시 확인해 주세요.'); }
			if (page.some(notification => notification.projectId !== project)) { throw new Error('다른 프로젝트의 알림 응답을 받았습니다.'); }
			notifications = [...page].sort((left, right) => left.sequence - right.sequence);
			cursor = notifications.at(-1)?.sequence ?? cursor;
			hasMore = page.length === PAGE_SIZE;
			trimmedCount = 0;
			listDirty = true;
			connected = true;
			opened = true;
		} catch (cause) {
			if (disposed || generation !== requestGeneration || context !== contextGeneration || project !== currentProjectId) { return; }
			connected = false;
			errorMessage = describeError(cause);
		} finally {
			if (!disposed && generation === requestGeneration && context === contextGeneration) {
				loading = false;
				render();
				if (opened) {
					const newestId = notifications.at(-1)?.id;
					if (newestId) { list.querySelector<HTMLButtonElement>(`[data-notification-id="${CSS.escape(newestId)}"]`)?.focus({ preventScroll: true }); }
				}
				void refreshStatus();
				schedulePoll();
			}
		}
	};

	const openNotification = async (notification: SessionNotificationDTO): Promise<void> => {
		const requestContext = contextGeneration;
		loading = true;
		openErrorMessage = undefined;
		render();
		let opened = false;
		try {
			opened = await currentActions.onOpen(notification);
		} catch (cause) {
			if (!disposed && requestContext === contextGeneration) { openErrorMessage = describeError(cause); }
		} finally {
			if (!disposed && requestContext === contextGeneration) { loading = false; render(); }
		}
		if (!opened) {
			if (!disposed && requestContext === contextGeneration) { openErrorMessage = '알림의 정확한 항목을 열지 못했습니다. 읽지 않은 상태로 보존했습니다.'; render(); }
			return;
		}
		if (disposed || requestContext !== contextGeneration) { return; }
		if (notification.readAt === null) {
			try {
				await currentActions.markRead(notification.id);
			} catch (cause) {
				if (!disposed && requestContext === contextGeneration) {
					errorMessage = describeError(cause);
					render();
				}
				return;
			}
			if (disposed || requestContext !== contextGeneration) { return; }
			statusRequestGeneration++;
			statusLoading = false;
			notifications = notifications.map(item => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item);
			listDirty = true;
			render();
			void refreshStatus();
		}
		if (disposed || requestContext !== contextGeneration) { return; }
		setExpanded(false);
	};

	trigger.addEventListener('click', () => setExpanded(!expanded));
	newAlertsButton.addEventListener('click', () => { void showLatestNotifications(); });
	closeButton.addEventListener('click', () => setExpanded(false, true));
	popover.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			event.preventDefault();
			setExpanded(false, true);
		}
	});
	firstButton.addEventListener('click', () => {
		if (timer) { clearTimeout(timer); timer = undefined; }
		requestGeneration++;
		loading = false;
		notifications = [];
		listDirty = true;
		cursor = 0;
		hasMore = true;
		trimmedCount = 0;
		connected = true;
		void fetchPage(0);
	});
	nextButton.addEventListener('click', () => { void fetchPage(cursor); });
	retryButton.addEventListener('click', () => {
		connected = true;
		void refreshStatus();
		void refreshLoadedWindow();
	});

	render();

	return {
		setContext(projectIdValue, sessionsValue, actionsValue): void {
			if (disposed) { return; }
			currentActions = actionsValue;
			if (currentProjectId === projectIdValue) {
				if (currentSessions !== sessionsValue) {
					currentSessions = sessionsValue;
					listDirty = true;
					render();
				}
				return;
			}
			contextGeneration++;
			statusRequestGeneration++;
			currentProjectId = projectIdValue;
			currentSessions = sessionsValue;
			if (timer) { clearTimeout(timer); timer = undefined; }
			expanded = false;
			popover.hidden = true;
			trigger.setAttribute('aria-expanded', 'false');
			popover.id = `ai-session-notifications-${projectIdValue}`;
			trigger.setAttribute('aria-controls', popover.id);
			requestGeneration++;
			loading = false;
			connected = true;
			cursor = 0;
			hasMore = true;
			trimmedCount = 0;
			errorMessage = undefined;
			openErrorMessage = undefined;
			statusErrorMessage = undefined;
			unreadCount = undefined;
			latestSequence = 0;
			statusLoading = false;
			notifications = [];
			listDirty = true;
			render();
			if (visible) {
				void refreshStatus();
				void fetchPage(0);
				schedulePoll();
			}
		},
		setVisible(value): void {
			if (disposed || visible === value) { return; }
			visible = value;
			if (!visible) {
				if (timer) { clearTimeout(timer); timer = undefined; }
				requestGeneration++;
				statusRequestGeneration++;
				loading = false;
				statusLoading = false;
			} else {
				connected = true;
				void refreshStatus();
				void refreshLoadedWindow();
				schedulePoll();
			}
			render();
		},
		refresh(): void {
			connected = true;
			void refreshStatus();
			void refreshLoadedWindow();
		},
		dispose(): void {
			if (disposed) { return; }
			disposed = true;
			contextGeneration++;
			requestGeneration++;
			statusRequestGeneration++;
			if (timer) { clearTimeout(timer); timer = undefined; }
			parent.replaceChildren();
		},
	};
}

function makeButton(text: string): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'ai-session-notifications__control';
	button.textContent = text;
	return button;
}

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR');
}

function describeError(cause: unknown): string {
	if (cause instanceof Error && cause.message) { return cause.message; }
	return '알 수 없는 오류';
}

function notificationKindLabel(kind: SessionNotificationDTO['kind']): string {
	return ({ input: '입력 필요', approval: '승인 검토', error: '실행 실패', completion: '실행 종료', message: '새 메시지', prReady: 'PR 검토안 준비' })[kind];
}
