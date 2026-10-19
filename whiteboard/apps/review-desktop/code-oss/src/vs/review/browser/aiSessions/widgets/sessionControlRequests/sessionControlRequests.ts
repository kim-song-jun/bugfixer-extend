import type { AgentSessionControlRequestDTO, AgentSessionControlRequestState, WorkspaceAgentSessionControlPageDTO } from '../../../../../workspace/common/workspaceAgentSessionControlProtocol.js';
import type { AgentSessionDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';

const labels: Readonly<Record<AgentSessionControlRequestState, string>> = {
	pendingReview: '사람 검토 대기', starting: '승인 후 시작 처리 중', started: '실행 시작 기록', startFailed: '시작 처리 실패', rejected: '요청 거절', cancelled: '요청 취소', interrupted: '시작 결과 확인 필요',
	stopAccepted: '중단 접수 · 정리 미확인', stopCompleted: '중단 정리 확인', stopUnverified: '중단 정리 확인 필요', stopFailed: '중단 처리 확인 필요',
};

export function renderSessionControlRequests(parent: HTMLElement, state: {
	readonly page: WorkspaceAgentSessionControlPageDTO | undefined; readonly loading: boolean; readonly error: string | undefined;
	readonly history: boolean; readonly sessions: readonly AgentSessionDTO[]; readonly busy: boolean;
}, actions: {
	readonly onPreview: (request: AgentSessionControlRequestDTO) => void; readonly onReject: (request: AgentSessionControlRequestDTO) => void;
	readonly onFilter: (history: boolean) => void; readonly onFirst: () => void; readonly onNext: () => void; readonly onClose: () => void;
}): void {
	parent.replaceChildren();
	parent.className = 'ai-session-control';
	const heading = document.createElement('header'); heading.className = 'ai-session-control__heading';
	const title = document.createElement('h2'); title.textContent = 'AI 제어 요청';
	const close = button('요청 닫기', actions.onClose); heading.append(title, close);
	const description = document.createElement('p'); description.textContent = '새 시작 요청은 실행 권한이 없습니다. 범위를 검토하고 macOS 확인 창에서 승인해야 실행합니다. 중단 접수와 실제 정리 완료는 별도 기록입니다.';
	const toolbar = document.createElement('div'); toolbar.className = 'ai-session-control__actions';
	for (const [label, history] of [['검토 대기', false], ['모든 요청 기록', true]] as const) {
		const filter = button(label, () => actions.onFilter(history)); filter.setAttribute('aria-pressed', String(state.history === history)); filter.disabled = state.loading || state.busy; toolbar.appendChild(filter);
	}
	const first = button('처음부터 새로고침', actions.onFirst); first.disabled = state.loading || state.busy;
	const next = button('다음 요청', actions.onNext); next.disabled = state.loading || state.busy || !state.page?.hasMore;
	toolbar.append(first, next);
	const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
	status.textContent = state.loading ? '요청 기록을 불러오는 중입니다.' : state.busy ? '요청을 처리 중입니다.' : `${state.page?.requests.length ?? 0}개 표시${state.page?.hasMore ? ' · 다음 페이지 있음' : ''}`;
	parent.append(heading, description, toolbar, status);
	if (state.error) { const error = document.createElement('p'); error.className = 'ai-session__message--error'; error.setAttribute('role', 'alert'); error.textContent = state.error; parent.appendChild(error); }
	const list = document.createElement('ul'); list.className = 'ai-session-control__list'; list.setAttribute('aria-label', 'AI 제어 요청 기록');
	for (const request of state.page?.requests ?? []) {
		const item = document.createElement('li'); item.className = 'ai-session-control__row';
		item.dataset.controlRequest = request.id; item.dataset.controlTarget = request.targetSessionId;
		const target = state.sessions.find(session => session.id === request.targetSessionId);
		const name = document.createElement('strong'); name.textContent = `${target?.name ?? request.targetSessionId} · ${request.kind === 'start' ? '시작 요청' : '중단 요청'}`;
		const facts = document.createElement('p'); facts.textContent = `${labels[request.state]} · ${new Date(request.createdAt).toLocaleString('ko-KR')} · 요청 ${request.id}`;
		item.append(name, facts);
		if (request.reason) { const reason = document.createElement('p'); reason.textContent = request.reason; item.appendChild(reason); }
		if (request.error) { const error = document.createElement('p'); error.className = 'ai-session__message--error'; error.textContent = request.error; item.appendChild(error); }
		if (request.resultTurnId || request.targetTurnId) { const turn = document.createElement('p'); turn.textContent = `실행 ID · ${request.resultTurnId ?? request.targetTurnId}`; item.appendChild(turn); }
		if (request.state === 'pendingReview') {
			const controls = document.createElement('div'); controls.className = 'ai-session-control__actions';
			const preview = button('실행 범위 검토', () => actions.onPreview(request)); preview.disabled = state.loading || state.busy; preview.setAttribute('aria-label', `${target?.name ?? request.targetSessionId} 시작 요청 검토`); preview.dataset.controlAction = `${request.id}:preview`;
			const reject = button('요청 거절', () => actions.onReject(request)); reject.disabled = state.loading || state.busy; reject.setAttribute('aria-label', `${target?.name ?? request.targetSessionId} 시작 요청 거절`); reject.dataset.controlAction = `${request.id}:reject`;
			controls.append(preview, reject); item.appendChild(controls);
		}
		list.appendChild(item);
	}
	parent.appendChild(list);
	if (!state.loading && !state.error && state.page?.requests.length === 0) { const empty = document.createElement('p'); empty.textContent = state.history ? '이 프로젝트의 제어 요청 기록이 없습니다.' : '검토를 기다리는 시작 요청이 없습니다.'; parent.appendChild(empty); }
}

function button(label: string, action: () => void): HTMLButtonElement {
	const element = document.createElement('button'); element.type = 'button'; element.className = 'ai-session__secondary'; element.textContent = label; element.dataset.controlAction = label; element.addEventListener('click', action); return element;
}
