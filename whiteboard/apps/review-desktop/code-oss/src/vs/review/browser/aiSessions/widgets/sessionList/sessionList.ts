import type { AgentSessionDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import { agentSessionStateLabel, agentSessionSummary, buildAgentSessionHierarchy } from '../../entities/agentSession/index.js';

export interface SessionListActions {
	readonly onSelect: (sessionId: string) => void;
	readonly onCreate: () => void;
	readonly onOpen: (sessionId: string, view: 'terminal' | 'logs') => void;
	readonly onStop: (sessionId: string) => void;
	readonly onToggle: (sessionId: string) => void;
	readonly collapsedIds: ReadonlySet<string>;
	readonly busy: boolean;
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
	const scope = document.createElement('p');
	scope.className = 'ai-session__hierarchy-scope';
	scope.textContent = '앱에 등록된 부모·자식 세션을 표시합니다. CLI 내부의 미등록 에이전트는 관측할 수 없습니다.';
	parent.appendChild(scope);
	if (sessions.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'ai-session__muted';
		empty.textContent = '아직 세션이 없습니다.';
		parent.appendChild(empty);
		return;
	}
	const list = document.createElement('ul');
	list.className = 'ai-session__session-list';
	list.setAttribute('aria-label', '프로젝트 AI 세션 구조');
	const mounts = new Map<string, HTMLElement>();
	const byId = new Map(sessions.map(session => [session.id, session]));
	for (const node of buildAgentSessionHierarchy(sessions)) {
		const { session } = node;
		const mount = node.parentId ? mounts.get(node.parentId) : list;
		if (!mount) { continue; }
		const item = document.createElement('li');
		item.className = 'ai-session__node';
		item.dataset.sessionId = session.id;
		const heading = document.createElement('div'); heading.className = 'ai-session__node-heading';
		if (node.hasChildren) {
			const toggle = document.createElement('button');
			toggle.type = 'button'; toggle.className = 'ai-session__node-toggle';
			toggle.dataset.sessionToggle = session.id;
			toggle.setAttribute('aria-expanded', String(!actions.collapsedIds.has(session.id)));
			toggle.setAttribute('aria-label', `${session.name} 하위 세션 ${actions.collapsedIds.has(session.id) ? '펼치기' : '접기'}`);
			toggle.textContent = actions.collapsedIds.has(session.id) ? '▸' : '▾';
			toggle.addEventListener('click', () => actions.onToggle(session.id));
			heading.appendChild(toggle);
		}
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'ai-session__session-row';
		row.dataset.sessionSelect = session.id;
		row.setAttribute('aria-current', session.id === selectedId ? 'true' : 'false');
		row.setAttribute('aria-pressed', String(session.id === selectedId));
		row.setAttribute('aria-label', `${session.name}, ${agentSessionSummary(session)}, ${agentSessionStateLabel[session.state]}`);
		const name = document.createElement('span'); name.className = 'ai-session__session-name'; name.textContent = session.name;
		name.title = `${session.name} · ${session.id}`;
		const provider = document.createElement('span'); provider.className = 'ai-session__session-meta'; provider.textContent = agentSessionSummary(session);
		provider.title = agentSessionSummary(session);
		const task = document.createElement('span'); task.className = 'ai-session__session-task'; task.textContent = session.taskId ? taskNames.get(session.taskId) ?? '연결된 작업' : '연결된 작업 없음';
		const state = document.createElement('span'); state.className = 'ai-session__session-state'; state.textContent = agentSessionStateLabel[session.state];
		row.append(name, provider, task, state);
		const relation = document.createElement('span'); relation.className = 'ai-session__session-parent';
		relation.textContent = node.relationshipIssue ? '상위 관계 확인 필요'
			: node.parentId ? `상위 · ${byId.get(node.parentId)!.name}` : '독립 세션';
		relation.title = node.relationshipIssue ? `등록된 상위 관계를 표시할 수 없습니다 (${node.relationshipIssue}).`
			: node.parentId ? `${node.depth + 1}단계 · 상위 세션 ID ${node.parentId}` : '앱에 등록된 상위 세션 없음';
		row.appendChild(relation);
		row.addEventListener('click', () => actions.onSelect(session.id));
		heading.appendChild(row);
		const controls = document.createElement('div'); controls.className = 'ai-session__node-actions';
		for (const [label, handler] of [
			['로그', () => actions.onOpen(session.id, 'logs')], ['지시', () => actions.onOpen(session.id, 'terminal')], ['중단', () => actions.onStop(session.id)],
		] as const) {
			const button = document.createElement('button'); button.type = 'button'; button.className = 'ai-session__text-button';
			button.textContent = label; button.setAttribute('aria-label', `${session.name} ${label}`);
			button.dataset.sessionAction = `${session.id}:${label}`;
			button.disabled = actions.busy || label === '중단' && !['starting', 'running', 'waitingForInput', 'waitingForApproval'].includes(session.state);
			button.addEventListener('click', handler); controls.appendChild(button);
		}
		item.append(heading, controls);
		mount.appendChild(item);
		if (node.hasChildren && !actions.collapsedIds.has(session.id)) {
			const branch = document.createElement('ul'); branch.className = 'ai-session__branch';
			branch.setAttribute('aria-label', `${session.name} 하위 세션`);
			if (node.depth >= 3) { branch.classList.add('ai-session__branch--deep'); }
			item.appendChild(branch); mounts.set(session.id, branch);
		}
	}
	parent.appendChild(list);
}
