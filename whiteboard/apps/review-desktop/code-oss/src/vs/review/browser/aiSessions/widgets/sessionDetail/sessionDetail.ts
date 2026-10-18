import type { AgentSessionDTO, AgentSessionTurnDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import { agentSessionStateLabel, agentSessionSummary } from '../../entities/agentSession/index.js';
import { createSessionViewTabs, type AgentSessionViewTab } from '../../features/sessionViewTabs/index.js';

export interface SessionDetailActions {
	readonly onStart: () => void;
	readonly onStop: () => void;
	readonly onTab: (tab: AgentSessionViewTab) => void;
}

export function renderSessionDetail(parent: HTMLElement, session: AgentSessionDTO, turn: AgentSessionTurnDTO | undefined, tab: AgentSessionViewTab, actions: SessionDetailActions, taskName?: string, logsPanel?: HTMLElement, messagesPanel?: HTMLElement, workflowPanel?: HTMLElement): { terminal: HTMLElement } {
	parent.replaceChildren();
	parent.className = 'ai-session__detail';
	const header = document.createElement('header'); header.className = 'ai-session__detail-header';
	const copy = document.createElement('div'); copy.className = 'ai-session__detail-copy';
	const title = document.createElement('h1'); title.textContent = session.name;
	const meta = document.createElement('p'); meta.textContent = `${agentSessionSummary(session)} · ${agentSessionStateLabel[session.state]}`;
	if (taskName) { const task = document.createElement('p'); task.className = 'ai-session__task-name'; task.textContent = `작업 · ${taskName}`; copy.append(title, meta, task); }
	else copy.append(title, meta);
	const cwd = document.createElement('p'); cwd.className = 'ai-session__cwd';
	cwd.textContent = turn ? `실행 폴더 · ${turn.snapshot.cwd}` : '실행 폴더 · 아직 실행 전';
	copy.appendChild(cwd);
	if (session.state === 'waitingForApproval') {
		const pending = document.createElement('p'); pending.className = 'ai-session__permission-wait'; pending.setAttribute('role', 'status');
		pending.textContent = '승인 대기 · 승인 범위와 승인 동작을 제공하는 연결이 준비되지 않았습니다.';
		copy.appendChild(pending);
	}
	const actionsEl = document.createElement('div'); actionsEl.className = 'ai-session__actions';
	const start = document.createElement('button'); start.type = 'button'; start.className = 'ai-session__primary'; start.textContent = turn && ['running', 'starting', 'stopping'].includes(turn.state) ? '새 실행 준비' : '실행 준비'; start.addEventListener('click', actions.onStart);
	const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'ai-session__secondary'; stop.textContent = '중단'; stop.disabled = !turn || !['running', 'starting'].includes(turn.state); stop.addEventListener('click', actions.onStop);
	actionsEl.append(start, stop); header.append(copy, actionsEl); parent.appendChild(header);
	const tabs = createSessionViewTabs(tab, actions.onTab); parent.appendChild(tabs);
	const panel = document.createElement('section'); panel.className = 'ai-session__panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `ai-session-tab-${tab}`);
	if (tab === 'terminal') {
		const terminal = document.createElement('div'); terminal.className = 'ai-session__terminal'; terminal.setAttribute('aria-label', 'AI 세션 터미널'); panel.appendChild(terminal); parent.appendChild(panel);
		return { terminal };
	}
	if (tab === 'logs' && logsPanel) {
		panel.appendChild(logsPanel);
	} else if (tab === 'messages' && messagesPanel) {
		panel.appendChild(messagesPanel);
	} else if (tab === 'workflow' && workflowPanel) {
		panel.appendChild(workflowPanel);
	} else {
		const unavailable = document.createElement('div'); unavailable.className = 'ai-session__unavailable'; unavailable.setAttribute('role', 'status');
		unavailable.textContent = '변경 내역 연결은 아직 준비되지 않았습니다. 현재 세션의 파일 변경을 조회하는 데이터 연결이 필요합니다.';
		panel.appendChild(unavailable);
	}
	parent.appendChild(panel);
	return { terminal: document.createElement('div') };
}
