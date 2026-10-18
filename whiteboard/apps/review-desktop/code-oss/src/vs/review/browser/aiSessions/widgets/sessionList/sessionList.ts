import type { AgentSessionDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import { agentSessionStateLabel, agentSessionSummary } from '../../entities/agentSession/index.js';

export interface SessionListActions {
	readonly onSelect: (sessionId: string) => void;
	readonly onCreate: () => void;
}

export function renderSessionList(parent: HTMLElement, sessions: readonly AgentSessionDTO[], selectedId: string | undefined, actions: SessionListActions, taskNames: ReadonlyMap<string, string> = new Map()): void {
	parent.replaceChildren();
	const heading = document.createElement('div');
	heading.className = 'ai-session__list-heading';
	const title = document.createElement('h2');
	title.textContent = 'AI 세션';
	const create = document.createElement('button');
	create.type = 'button';
	create.className = 'ai-session__text-button';
	create.textContent = '새 세션';
	create.setAttribute('aria-label', '새 AI 세션 만들기');
	create.addEventListener('click', actions.onCreate);
	heading.append(title, create);
	parent.appendChild(heading);
	if (sessions.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'ai-session__muted';
		empty.textContent = '아직 세션이 없습니다.';
		parent.appendChild(empty);
		return;
	}
	const list = document.createElement('div');
	list.className = 'ai-session__session-list';
	list.setAttribute('role', 'group');
	list.setAttribute('aria-label', '프로젝트 AI 세션');
	for (const session of sessions) {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'ai-session__session-row';
		row.setAttribute('aria-current', session.id === selectedId ? 'true' : 'false');
		row.setAttribute('aria-pressed', String(session.id === selectedId));
		row.setAttribute('aria-label', `${session.name}, ${agentSessionSummary(session)}, ${agentSessionStateLabel[session.state]}`);
		const name = document.createElement('span'); name.className = 'ai-session__session-name'; name.textContent = session.name;
		const provider = document.createElement('span'); provider.className = 'ai-session__session-meta'; provider.textContent = agentSessionSummary(session);
		const task = document.createElement('span'); task.className = 'ai-session__session-task'; task.textContent = session.taskId ? taskNames.get(session.taskId) ?? '연결된 작업' : '연결된 작업 없음';
		const state = document.createElement('span'); state.className = 'ai-session__session-state'; state.textContent = agentSessionStateLabel[session.state];
		row.append(name, provider, task, state);
		row.addEventListener('click', () => actions.onSelect(session.id));
		list.appendChild(row);
	}
	parent.appendChild(list);
}
