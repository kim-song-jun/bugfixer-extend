/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	AgentWorkflowApprovalResult, AgentWorkflowDTO, AgentWorkflowNodePlan, AgentWorkflowPageDTO,
	AgentWorkflowNodeState, AgentWorkflowPlan, AgentWorkflowPlanInput, AgentWorkflowReference,
	AgentWorkflowRole, AgentWorkflowRunDTO, AgentWorkflowState, AgentWorkflowStatusDTO,
	CreateAgentWorkflowInput,
} from '../../../../../workspace/common/workspaceAgentWorkflowProtocol.js';
import type { AgentSessionDTO, AgentSessionPermissionPolicy } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import type { WorkspaceKnowledgeDTO } from '../../../../../workspace/common/workspaceKnowledgeProtocol.js';

const PAGE_SIZE = 40;
const MAX_LOADED_WORKFLOWS = 160;
const POLL_INTERVAL_MS = 3500;
const RUNNING_STATES = new Set(['ready', 'running', 'cancelRequested']);
const ROLE_LABELS: Readonly<Record<AgentWorkflowRole, string>> = {
	coordinator: '조정', implementer: '구현', reviewer: '검토', researcher: '조사', tester: '테스트',
};
const WORKFLOW_STATE_LABELS: Readonly<Record<AgentWorkflowState, string>> = {
	waiting: '승인 대기', ready: '시작 가능', running: '실행 중', cancelRequested: '중단 요청 중',
	succeeded: '실행 성공', failed: '실행 실패', cancelled: '중단 완료', blocked: '차단됨',
	interrupted: '연결 끊김', recoveryRequired: '복구 필요',
};
const SESSION_STATE_LABELS: Readonly<Record<AgentSessionDTO['state'], string>> = {
	created: '생성됨', starting: '시작 중', running: '실행 중', waitingForInput: '입력 대기',
	waitingForApproval: '승인 대기', idle: '대기', stopping: '중단 중', stopped: '중단됨',
	interrupted: '연결 끊김', failed: '실패',
};
const WORKFLOW_HOST_ERRORS: Readonly<Record<string, string>> = {
	launchFailed: '세션 시작 실패', stopUnverified: '세션 중단 확인 실패', deadlineReached: '실행 시간 한도 도달',
	recoveryRequired: '복구 확인 필요', schedulerPersistenceFailed: '실행 상태 저장 실패',
};

export interface SessionWorkflowContext {
	readonly projectId: string;
	readonly session: AgentSessionDTO;
	readonly sessions: readonly AgentSessionDTO[];
}

export interface SessionWorkflowActions {
	readonly listWorkflows: (afterId: string | undefined, limit: number) => Promise<AgentWorkflowPageDTO>;
	readonly getWorkflow: (workflowId: string) => Promise<AgentWorkflowStatusDTO>;
	readonly createWorkflow: (input: CreateAgentWorkflowInput) => Promise<AgentWorkflowStatusDTO>;
	readonly reviseWorkflow: (workflowId: string, expectedRevision: number, plan: AgentWorkflowPlanInput) => Promise<AgentWorkflowStatusDTO>;
	readonly approveWorkflow: (workflowId: string, expectedRevision: number, planVersion: number, fingerprint: string, idempotencyKey: string) => Promise<AgentWorkflowApprovalResult>;
	readonly startWorkflow: (workflowId: string, expectedRevision: number, idempotencyKey: string) => Promise<AgentWorkflowStatusDTO>;
	readonly cancelWorkflow: (workflowId: string, expectedRevision: number, idempotencyKey: string) => Promise<AgentWorkflowStatusDTO>;
	readonly loadKnowledge: (projectId: string) => Promise<WorkspaceKnowledgeDTO>;
	readonly loadSessions: (projectId: string) => Promise<readonly AgentSessionDTO[]>;
}

export interface SessionWorkflowController {
	setContext(context: SessionWorkflowContext, actions: SessionWorkflowActions): void;
	setVisible(visible: boolean): void;
	dispose(): void;
}

interface DraftNode {
	readonly nodeId: string;
	readonly sessionId: string;
	role: AgentWorkflowRole;
	mode: AgentSessionPermissionPolicy['mode'];
	approval: AgentSessionPermissionPolicy['approval'];
	dependsOn: string[];
	references: AgentWorkflowReference[];
}

export function createSessionWorkflow(parent: HTMLElement, context: SessionWorkflowContext, actions: SessionWorkflowActions): SessionWorkflowController {
	parent.classList.add('ai-session-workflows');
	parent.replaceChildren();
	const heading = document.createElement('header');
	heading.className = 'ai-session-workflows__heading';
	const title = document.createElement('h2');
	title.textContent = '위임 워크플로';
	const description = document.createElement('p');
	description.textContent = '저장된 세션을 작업 순서로 묶습니다. 승인과 시작은 별도 단계이며, 실행 종료를 작업 완료로 판단하지 않습니다.';
	heading.append(title, description);

	const layout = document.createElement('div');
	layout.className = 'ai-session-workflows__layout';
	const history = document.createElement('section');
	history.className = 'ai-session-workflows__history';
	const historyTitle = document.createElement('h3');
	historyTitle.textContent = '저장된 워크플로';
	const list = document.createElement('ol');
	list.className = 'ai-session-workflows__list';
	list.setAttribute('aria-label', '프로젝트 워크플로 목록');
	const historyStatus = document.createElement('p');
	historyStatus.className = 'ai-session-workflows__muted';
	historyStatus.setAttribute('role', 'status');
	const listError = document.createElement('p');
	listError.className = 'ai-session-workflows__error';
	listError.setAttribute('role', 'alert');
	listError.hidden = true;
	const loadOlder = makeButton('다음 페이지 불러오기');
	const reload = makeButton('다시 불러오기');
	history.append(historyTitle, historyStatus, listError, list, loadOlder, reload);

	const editor = document.createElement('section');
	editor.className = 'ai-session-workflows__editor';
	const editorTitle = document.createElement('h3');
	editorTitle.textContent = '계획';
	const scope = document.createElement('p');
	scope.className = 'ai-session-workflows__muted';
	const savedPlan = document.createElement('p');
	savedPlan.className = 'ai-session-workflows__muted';
	const draftWarning = document.createElement('p');
	draftWarning.className = 'ai-session-workflows__error';
	draftWarning.setAttribute('role', 'status');
	draftWarning.hidden = true;
	const contextMessage = document.createElement('p');
	contextMessage.className = 'ai-session-workflows__muted';
	contextMessage.setAttribute('role', 'status');
	const limits = document.createElement('div');
	limits.className = 'ai-session-workflows__limits';
	const concurrency = makeNumberField('동시 실행 수', 1, 8, 1);
	const turns = makeNumberField('최대 전체 실행 수', 1, 64, 8);
	const duration = makeNumberField('최대 시간(분)', 1, 120, 30);
	limits.append(concurrency.wrapper, turns.wrapper, duration.wrapper);
	const nodes = document.createElement('div');
	nodes.className = 'ai-session-workflows__nodes';
	nodes.setAttribute('aria-label', '워크플로에 포함할 저장된 세션');
	const formMessage = document.createElement('p');
	formMessage.className = 'ai-session-workflows__muted';
	formMessage.setAttribute('role', 'status');
	const formError = document.createElement('p');
	formError.className = 'ai-session-workflows__error';
	formError.setAttribute('role', 'alert');
	formError.hidden = true;
	const formActions = document.createElement('div');
	formActions.className = 'ai-session-workflows__actions';
	const newPlan = makeButton('새 계획');
	const save = makeButton('계획 저장');
	const approve = makeButton('승인 요청');
	const start = makeButton('실행 시작');
	const cancel = makeButton('실행 중단 요청');
	const refreshStatus = makeButton('상태·참조 다시 읽기');
	formActions.append(newPlan, save, approve, start, cancel, refreshStatus);
	const status = document.createElement('div');
	status.className = 'ai-session-workflows__status';
	status.setAttribute('aria-live', 'polite');
	editor.append(editorTitle, scope, savedPlan, draftWarning, contextMessage, limits, nodes, formMessage, formError, formActions, status);
	layout.append(history, editor);
	parent.append(heading, layout);

	let currentContext = context;
	let currentActions = actions;
	let visible = false;
	let disposed = false;
	let contextGeneration = 0;
	let operationGeneration = 0;
	let statusRequestGeneration = 0;
	let listLoading = false;
	let statusLoading = false;
	let operation = false;
	let listHasMore = false;
	let historyWindowAdvanced = false;
	let nextCursor: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let knowledge: WorkspaceKnowledgeDTO | undefined;
	let knowledgeLoading = false;
	let knowledgeError: string | undefined;
	let listErrorMessage: string | undefined;
	let formErrorMessage: string | undefined;
	let selectedWorkflowId: string | undefined;
	let selectedStatus: AgentWorkflowStatusDTO | undefined;
	let workflows: AgentWorkflowDTO[] = [];
	let draftNodes: DraftNode[] = [];
	let draftDirty = false;
	let nodeRowsSignature = '';
	let listSignature = '';
	let notice = '';
	let candidateSignature = '';

	function candidateSessions(): readonly AgentSessionDTO[] {
		return currentContext.sessions.filter(session => session.projectId === currentContext.projectId
			&& session.bindingId === currentContext.session.bindingId
			&& session.taskId === currentContext.session.taskId);
	}

	function eligibleSessions(): readonly AgentSessionDTO[] {
		return candidateSessions().filter(session => session.state === 'created' || session.state === 'idle');
	}

	function updateScope(): void {
		const task = currentContext.session.taskId ? `작업 ID ${currentContext.session.taskId}` : '작업에 연결되지 않은 세션';
		scope.textContent = `${task} · 바인딩 ${currentContext.session.bindingId} · 프로젝트 범위`;
		const candidates = candidateSessions();
		const eligibleCount = eligibleSessions().length;
		contextMessage.textContent = candidates.length
			? `이 작업과 바인딩에 저장된 세션 ${candidates.length}개 · 새 계획에 추가 가능한 세션 ${eligibleCount}개. 실행 중 세션은 기존 계획에서만 확인할 수 있습니다. provider와 model은 저장된 값입니다.`
			: '같은 작업과 바인딩에 저장된 세션이 없습니다. 세션을 먼저 저장해 주세요.';
	}

	function schedulePoll(): void {
		if (timer) { clearTimeout(timer); timer = undefined; }
		if (!visible || disposed || operation || !selectedWorkflowId || !selectedStatus || !RUNNING_STATES.has(selectedStatus.workflow.state)) { return; }
		timer = setTimeout(() => { timer = undefined; void loadSelectedStatus(true); }, POLL_INTERVAL_MS);
	}

	function renderList(): void {
		const scopedWorkflows = workflows.filter(item => item.bindingId === currentContext.session.bindingId && item.taskId === currentContext.session.taskId);
		const signature = scopedWorkflows.map(item => `${item.id}:${item.state}:${item.revision}`).join('|');
		if (signature !== listSignature) {
			const workspace = parent.closest<HTMLElement>('.ai-session-workspace');
			const scrollTop = workspace?.scrollTop;
			const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.workflowId : undefined;
			list.replaceChildren();
			for (const workflow of scopedWorkflows) {
				const item = document.createElement('li');
				item.className = 'ai-session-workflows__row';
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'ai-session-workflows__select';
				button.dataset.workflowId = workflow.id;
				button.setAttribute('aria-current', String(workflow.id === selectedWorkflowId));
				button.disabled = operation;
				button.textContent = `${WORKFLOW_STATE_LABELS[workflow.state]} · 버전 ${workflow.planVersion} · ${workflow.id}`;
				button.addEventListener('click', () => void selectWorkflow(workflow.id));
				item.appendChild(button);
				list.appendChild(item);
			}
			listSignature = signature;
			if (focusedId) { list.querySelector<HTMLElement>(`[data-workflow-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true }); }
			if (workspace && scrollTop !== undefined) { workspace.scrollTop = scrollTop; }
		}
		for (const button of list.querySelectorAll<HTMLButtonElement>('.ai-session-workflows__select')) { button.disabled = operation; }
		loadOlder.hidden = !listHasMore;
		loadOlder.textContent = workflows.length >= MAX_LOADED_WORKFLOWS ? '이전 목록을 내리고 다음 페이지 불러오기' : '다음 페이지 불러오기';
		loadOlder.disabled = listLoading || operation;
		reload.disabled = listLoading || operation;
		const pageState = historyWindowAdvanced ? '화면 한도를 지켜 이전 페이지 목록을 내리고 이동했습니다. 다시 불러오기로 첫 페이지를 볼 수 있습니다. ' : '';
		const pageDescription = scopedWorkflows.length
			? `${scopedWorkflows.length}개를 표시 중입니다. 프로젝트 기록은 ID 순서로 제한된 페이지씩 불러옵니다.`
			: listErrorMessage ? '목록을 읽지 못했습니다. 다시 시도할 수 있습니다.'
				: workflows.length ? '불러온 페이지에 현재 작업과 바인딩의 워크플로가 없습니다. 다른 기록은 다음 페이지에서 확인할 수 있습니다.' : '현재 작업과 바인딩에 저장된 워크플로가 없습니다.';
		historyStatus.textContent = listLoading ? '워크플로 목록을 불러오는 중입니다.' : `${pageState}${pageDescription}`;
		listError.hidden = !listErrorMessage;
		listError.textContent = listErrorMessage ? `워크플로 목록 오류: ${listErrorMessage}` : '';
	}

	function renderStatus(): void {
		const workspace = parent.closest<HTMLElement>('.ai-session-workspace');
		const scrollTop = workspace?.scrollTop;
		status.replaceChildren();
		const workflow = selectedStatus?.workflow;
		if (!workflow) {
			const empty = document.createElement('p');
			empty.className = 'ai-session-workflows__muted';
			empty.textContent = statusLoading ? '선택한 워크플로 상태를 불러오는 중입니다.' : '기록을 선택하거나 계획을 저장하면 상태와 실행 기록이 여기에 표시됩니다.';
			status.appendChild(empty);
		} else {
			const state = document.createElement('p');
			state.className = 'ai-session-workflows__state';
			state.textContent = `상태 · ${WORKFLOW_STATE_LABELS[workflow.state]} · 계획 v${workflow.planVersion} · revision ${workflow.revision}`;
			status.appendChild(state);
			const summary = document.createElement('p');
			summary.className = 'ai-session-workflows__muted';
			summary.textContent = selectedStatus!.run
				? `계획 한도 · 동시 ${selectedStatus!.plan.maxConcurrentNodes}개 · 전체 ${selectedStatus!.plan.maxTotalTurns}회 · ${Math.round(selectedStatus!.plan.maxDurationMs / 60_000)}분 · 실행 ${selectedStatus!.run.id} · ${WORKFLOW_STATE_LABELS[selectedStatus!.run.state]} · 마감 ${new Date(selectedStatus!.run.deadlineAt).toLocaleString('ko-KR')}. 실행 상태는 작업 완료를 의미하지 않습니다.`
				: '실행 기록 없음 · 계획 저장, 호스트 승인, 실행 시작은 각각 분리되어 있습니다.';
			status.appendChild(summary);
			if (formErrorMessage) {
				const stale = document.createElement('p'); stale.className = 'ai-session-workflows__muted';
				stale.textContent = `마지막으로 읽은 상태 ${new Date(workflow.updatedAt).toLocaleString('ko-KR')} · 최신 상태인지 확인하지 못했습니다.`;
				status.appendChild(stale);
			}
			if (selectedStatus!.hostError) {
				const host = document.createElement('p');
				host.className = 'ai-session-workflows__error';
				host.textContent = `호스트 실행 오류 · ${WORKFLOW_HOST_ERRORS[selectedStatus!.hostError] ?? '상태 확인 필요'}. 상태를 다시 읽고 필요한 경우 새 계획으로 재시도하세요.`;
				status.appendChild(host);
			}
			if (selectedStatus!.run) {
				const listEl = document.createElement('ol');
				listEl.className = 'ai-session-workflows__execution-list';
				for (const node of selectedStatus!.run.nodes) {
					const planNode = selectedStatus!.plan.nodes.find(candidate => candidate.nodeId === node.nodeId);
					const session = currentContext.sessions.find(candidate => candidate.id === node.sessionId);
					const row = document.createElement('li');
					row.textContent = `${ROLE_LABELS[planNode?.role ?? 'implementer']} · ${session?.name ?? `세션 ID ${node.sessionId}`} · ${nodeStateLabel(node.state)}${node.sessionTurnId ? ` · 실행 ID ${node.sessionTurnId}` : ''}`;
					listEl.appendChild(row);
				}
				status.appendChild(listEl);
			}
		}
		formMessage.textContent = notice;
		formError.hidden = !formErrorMessage;
		formError.textContent = formErrorMessage ? `요청 실패: ${formErrorMessage}` : '';
		updateButtons();
		if (workspace && scrollTop !== undefined) { workspace.scrollTop = scrollTop; }
	}

	function updateButtons(): void {
		const workflow = selectedStatus?.workflow;
		const activeWorkflow = !!workflow && ['ready', 'running', 'cancelRequested'].includes(workflow.state);
		const nodesEligible = draftNodes.every(node => eligibleSessions().some(session => session.id === node.sessionId));
		const savingAllowed = !operation && !activeWorkflow && draftNodes.length > 0 && nodesEligible;
		save.disabled = !savingAllowed;
		newPlan.disabled = operation;
		approve.hidden = !workflow || workflow.state !== 'waiting';
		approve.disabled = operation || !workflow || draftDirty;
		start.hidden = !workflow || workflow.state !== 'ready';
		start.disabled = operation || !workflow || draftDirty;
		savedPlan.textContent = selectedStatus
			? `저장된 계획 · v${selectedStatus.plan.version} · 지문 ${selectedStatus.plan.fingerprint}`
			: '';
		draftWarning.hidden = !draftDirty || !selectedStatus;
		draftWarning.textContent = draftDirty && selectedStatus
			? '저장하지 않은 변경이 있습니다. 승인과 실행은 저장된 계획에만 적용되므로 먼저 계획을 저장하거나 새 계획을 선택하세요.'
			: '';
		cancel.hidden = !workflow || !['ready', 'running', 'cancelRequested'].includes(workflow.state);
		cancel.disabled = operation || !workflow || workflow.state === 'cancelRequested';
		refreshStatus.disabled = operation || statusLoading || (!selectedWorkflowId && !knowledgeError);
		for (const control of editor.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.ai-session-workflows__limits input, .ai-session-workflows__nodes input, .ai-session-workflows__nodes select')) { control.disabled = operation || activeWorkflow; }
	}

	function nodeSignature(): string {
		return JSON.stringify([candidateSessions().map(session => session.id), draftNodes.map(node => [node.nodeId, node.sessionId, node.role, node.mode, node.approval, node.dependsOn, node.references]), knowledge?.references.map(ref => ref.id), knowledge?.conventions.map(ref => ref.id)]);
	}

	function renderNodes(force = false): void {
		const signature = nodeSignature();
		if (!force && signature === nodeRowsSignature) { return; }
		const workspace = parent.closest<HTMLElement>('.ai-session-workspace');
		const scrollTop = workspace?.scrollTop;
		const focusedControl = document.activeElement instanceof HTMLElement && nodes.contains(document.activeElement)
			? document.activeElement.dataset.controlKey
			: undefined;
		nodes.replaceChildren();
		const available = candidateSessions();
		for (const session of available) {
			const row = document.createElement('div');
			row.className = 'ai-session-workflows__node-row';
			const existing = draftNodes.find(node => node.sessionId === session.id);
			const include = document.createElement('input');
			include.type = 'checkbox';
			include.dataset.controlKey = `include-${session.id}`;
			include.checked = !!existing;
			include.disabled = !existing && session.state !== 'created' && session.state !== 'idle';
			include.setAttribute('aria-label', `${session.name} 세션 포함`);
			include.addEventListener('change', () => {
				if (include.checked && !draftNodes.some(node => node.sessionId === session.id)) {
					draftNodes = [...draftNodes, { nodeId: crypto.randomUUID(), sessionId: session.id, role: 'implementer', mode: 'read-only', approval: 'never', dependsOn: [], references: [] }];
				} else if (!include.checked) {
					const removed = draftNodes.find(node => node.sessionId === session.id);
					draftNodes = draftNodes.filter(node => node.sessionId !== session.id).map(node => ({ ...node, dependsOn: node.dependsOn.filter(id => id !== removed?.nodeId) }));
				}
				draftDirty = true;
				renderNodes(true);
				updateButtons();
			});
			const identity = document.createElement('div');
			identity.className = 'ai-session-workflows__identity';
			const name = document.createElement('strong');
			name.textContent = session.name;
			const actualProvider = document.createElement('span');
			actualProvider.textContent = `${session.provider} · ${session.model}`;
			const actualSession = document.createElement('span');
			actualSession.textContent = `세션 ID ${session.id} · ${SESSION_STATE_LABELS[session.state]}`;
			identity.append(name, actualProvider, actualSession);
			row.append(include, identity);
			if (existing) {
				row.append(makeSelect('역할', 'role', session.id, Object.entries(ROLE_LABELS).map(([value, label]) => [value, label] as const), existing.role, value => updateDraft(session.id, { role: value as AgentWorkflowRole })));
				row.append(makeSelect('권한·승인', 'policy', session.id, [['read-only', '읽기 전용'], ['mutating', '승인 후 파일 수정']], existing.mode, value => updateDraft(session.id, {
					mode: value as AgentSessionPermissionPolicy['mode'], approval: value === 'mutating' ? 'on-request' : 'never',
				})));
				const dependencies = document.createElement('fieldset');
				dependencies.className = 'ai-session-workflows__dependencies';
				const legend = document.createElement('legend'); legend.textContent = '선행 세션'; dependencies.appendChild(legend);
				for (const dependency of draftNodes.filter(candidate => candidate.nodeId !== existing.nodeId)) {
					const depSession = available.find(candidate => candidate.id === dependency.sessionId);
					if (!depSession) { continue; }
					const label = document.createElement('label');
					const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.controlKey = `depends-${session.id}-${dependency.nodeId}`; checkbox.checked = existing.dependsOn.includes(dependency.nodeId);
					checkbox.addEventListener('change', () => updateDraft(session.id, { dependsOn: checkbox.checked ? [...existing.dependsOn, dependency.nodeId] : existing.dependsOn.filter(id => id !== dependency.nodeId) }));
					label.append(checkbox, document.createTextNode(depSession.name)); dependencies.appendChild(label);
				}
				row.appendChild(dependencies);
				const refs = document.createElement('fieldset'); refs.className = 'ai-session-workflows__references';
				const refsLegend = document.createElement('legend'); refsLegend.textContent = '참조 (선택)'; refs.appendChild(refsLegend);
				const availableRefs = referenceOptions();
				const visibleRefs = [...availableRefs];
				for (const selected of existing.references) {
					if (knowledge && !availableRefs.some(option => option.value.kind === selected.kind && option.value.id === selected.id)) {
						visibleRefs.push({ label: `기존 계획 참조 · ${selected.kind} · ${selected.id} (현재 목록에서 확인 불가)`, value: selected, selectable: false });
					}
				}
				for (const ref of visibleRefs) {
					const label = document.createElement('label');
					const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.controlKey = `reference-${session.id}-${ref.value.kind}-${ref.value.id}`;
					checkbox.checked = existing.references.some(selected => selected.kind === ref.value.kind && selected.id === ref.value.id);
					checkbox.disabled = !ref.selectable && !checkbox.checked;
					checkbox.addEventListener('change', () => {
						if (!ref.selectable && checkbox.checked) { checkbox.checked = false; return; }
						let values = existing.references.filter(selected => selected.kind !== ref.value.kind || selected.id !== ref.value.id);
						if (checkbox.checked) {
							if (ref.value.kind === 'conventionVersion') { values = values.filter(selected => selected.kind !== 'conventionVersion'); }
							values = [...values, ref.value];
						}
						updateDraft(session.id, { references: values });
					});
					label.append(checkbox, document.createTextNode(ref.label)); refs.appendChild(label);
				}
				if (!visibleRefs.length) {
					const none = document.createElement('p'); none.className = 'ai-session-workflows__muted';
					none.textContent = knowledgeLoading ? '저장된 참조를 확인하는 중입니다.' : knowledgeError
						? `저장된 참조를 확인하지 못했습니다. ${knowledgeError}` : knowledge ? '선택할 수 있는 기존 참조가 없습니다. 참조 없이 계획을 저장할 수 있습니다.' : '저장된 참조 목록을 아직 불러오지 않았습니다.';
					refs.appendChild(none);
				}
				row.appendChild(refs);
			}
			nodes.appendChild(row);
		}
		if (available.length === 0) {
			const empty = document.createElement('p'); empty.className = 'ai-session-workflows__muted'; empty.textContent = '선택 가능한 세션이 없습니다.'; nodes.appendChild(empty);
		}
		nodeRowsSignature = nodeSignature();
		if (focusedControl) { nodes.querySelector<HTMLElement>(`[data-control-key="${CSS.escape(focusedControl)}"]`)?.focus({ preventScroll: true }); }
		if (workspace && scrollTop !== undefined) { workspace.scrollTop = scrollTop; }
	}

	function referenceOptions(): { readonly label: string; readonly value: AgentWorkflowReference; readonly selectable: boolean }[] {
		if (!knowledge) { return []; }
		const taskReferences = currentContext.session.taskId ? knowledge.taskReferences[currentContext.session.taskId] ?? [] : [];
		const snapshots = currentContext.session.taskId ? taskReferences : knowledge.references;
		return [
			...snapshots.map(reference => ({ label: `지식 ${reference.title} · v${reference.version} · ${reference.id}`, value: { kind: 'knowledgeSnapshot' as const, id: reference.id }, selectable: true })),
			...knowledge.conventions.map(version => ({ label: `규칙 v${version.version}${version.active ? ' · 적용 중' : ''} · ${version.id}`, value: { kind: 'conventionVersion' as const, id: version.id }, selectable: true })),
		];
	}

	function updateDraft(sessionId: string, values: Partial<DraftNode>): void {
		draftNodes = draftNodes.map(node => node.sessionId === sessionId ? { ...node, ...values } : node);
		draftDirty = true;
		nodeRowsSignature = '';
		renderNodes();
		updateButtons();
	}

	function planInput(): AgentWorkflowPlanInput {
		const nodes: AgentWorkflowNodePlan[] = draftNodes.map(node => {
			const session = currentContext.sessions.find(candidate => candidate.id === node.sessionId);
			if (!session) { throw new Error('선택한 저장 세션을 다시 찾을 수 없습니다.'); }
			return {
				nodeId: node.nodeId, sessionId: session.id, role: node.role, provider: session.provider, model: session.model,
				taskId: currentContext.session.taskId, bindingId: currentContext.session.bindingId,
				referenceIds: [...node.references], permissionPolicy: { mode: node.mode, approval: node.approval }, dependsOn: [...node.dependsOn],
			};
		});
		return {
			projectId: currentContext.projectId, bindingId: currentContext.session.bindingId, taskId: currentContext.session.taskId,
			maxConcurrentNodes: Number(concurrency.input.value), maxTotalTurns: Number(turns.input.value),
			maxDurationMs: Number(duration.input.value) * 60_000, nodes,
		};
	}

	function validatePlan(plan: AgentWorkflowPlanInput): void {
		if (!Number.isInteger(plan.maxConcurrentNodes) || plan.maxConcurrentNodes < 1 || plan.maxConcurrentNodes > 8) { throw new Error('동시 실행 수는 1~8 사이로 입력하세요.'); }
		if (!Number.isInteger(plan.maxTotalTurns) || plan.maxTotalTurns < 1 || plan.maxTotalTurns > 64) { throw new Error('최대 전체 실행 수는 1~64 사이로 입력하세요.'); }
		if (!Number.isInteger(plan.maxDurationMs) || plan.maxDurationMs < 60_000 || plan.maxDurationMs > 120 * 60_000) { throw new Error('최대 시간은 1~120분 사이로 입력하세요.'); }
		if (!plan.nodes.length || plan.nodes.length > 64 || plan.nodes.length > plan.maxTotalTurns) { throw new Error('선택한 세션 수는 1~64이며 최대 전체 실행 수 이하여야 합니다.'); }
		if (plan.nodes.some(node => node.dependsOn.some(dependency => !plan.nodes.some(candidate => candidate.nodeId === dependency)))) { throw new Error('선행 세션 선택이 현재 계획과 일치하지 않습니다.'); }
	}

	async function loadList(firstPage: boolean): Promise<void> {
		if (disposed || !visible || listLoading) { return; }
		const generation = contextGeneration;
		const replaceWindow = !firstPage && workflows.length >= MAX_LOADED_WORKFLOWS;
		const pageLimit = firstPage || replaceWindow ? PAGE_SIZE : Math.min(PAGE_SIZE, MAX_LOADED_WORKFLOWS - workflows.length);
		listLoading = true;
		listErrorMessage = undefined;
		renderList();
		try {
			const page = await currentActions.listWorkflows(firstPage ? undefined : nextCursor, pageLimit);
			if (disposed || generation !== contextGeneration) { return; }
			if (firstPage || replaceWindow) { workflows = []; }
			if (firstPage) { historyWindowAdvanced = false; }
			if (replaceWindow) { historyWindowAdvanced = true; }
			const existing = new Set(workflows.map(workflow => workflow.id));
			for (const workflow of page.workflows.slice(0, pageLimit)) {
				if (!existing.has(workflow.id)) { workflows.push(workflow); existing.add(workflow.id); }
			}
			listHasMore = page.hasMore;
			nextCursor = page.nextCursor ?? undefined;
		} catch (error) {
			if (!disposed && generation === contextGeneration) { listErrorMessage = errorText(error); }
		} finally {
			if (!disposed && generation === contextGeneration) { listLoading = false; renderList(); }
		}
	}

	async function loadSelectedStatus(isPoll = false): Promise<void> {
		const workflowId = selectedWorkflowId;
		if (!workflowId || disposed || !visible || statusLoading) { return; }
		const generation = contextGeneration;
		const requestGeneration = ++statusRequestGeneration;
		statusLoading = true;
		if (!isPoll) { renderStatus(); }
		try {
			const [result, sessions] = await Promise.all([currentActions.getWorkflow(workflowId), currentActions.loadSessions(currentContext.projectId)]);
			if (disposed || generation !== contextGeneration || selectedWorkflowId !== workflowId || requestGeneration !== statusRequestGeneration) { return; }
			const refreshedSession = sessions.find(session => session.id === currentContext.session.id);
			currentContext = { ...currentContext, session: refreshedSession ?? currentContext.session, sessions };
			updateScope();
			const nextCandidateSignature = candidateSessions().map(session => `${session.id}:${session.name}:${session.provider}:${session.model}:${session.state}`).join('|');
			if (candidateSignature !== nextCandidateSignature) { candidateSignature = nextCandidateSignature; nodeRowsSignature = ''; renderNodes(); }
			selectedStatus = result;
			formErrorMessage = undefined;
			if (!isPoll && !draftDirty) { updateFromPlan(result.plan); }
			const index = workflows.findIndex(item => item.id === result.workflow.id);
			if (index >= 0) { workflows[index] = result.workflow; }
			renderList(); renderStatus();
		} catch (error) {
			if (!disposed && generation === contextGeneration && selectedWorkflowId === workflowId && requestGeneration === statusRequestGeneration) {
				formErrorMessage = errorText(error);
				renderStatus();
			}
		} finally {
			if (!disposed && generation === contextGeneration && selectedWorkflowId === workflowId && requestGeneration === statusRequestGeneration) {
				statusLoading = false;
				renderStatus();
				schedulePoll();
			}
		}
	}

	async function selectWorkflow(workflowId: string): Promise<void> {
		if (timer) { clearTimeout(timer); timer = undefined; }
		statusRequestGeneration++;
		selectedWorkflowId = workflowId;
		selectedStatus = undefined;
		statusLoading = false;
		draftDirty = false;
		formErrorMessage = undefined;
		listSignature = '';
		renderList(); renderStatus();
		await loadSelectedStatus();
	}

	async function runOperation(action: () => Promise<AgentWorkflowStatusDTO>, success: string): Promise<void> {
		if (operation || disposed) { return; }
		const generation = contextGeneration;
		const operationId = ++operationGeneration;
		operation = true; formErrorMessage = undefined; notice = ''; renderStatus(); renderList();
		try {
			const result = await action();
			if (disposed || generation !== contextGeneration || operationId !== operationGeneration) { return; }
			selectedStatus = result; selectedWorkflowId = result.workflow.id;
			updateFromPlan(result.plan);
			const index = workflows.findIndex(item => item.id === result.workflow.id);
			if (index >= 0) { workflows[index] = result.workflow; } else { workflows.push(result.workflow); }
			workflows.sort((left, right) => left.id.localeCompare(right.id));
			if (workflows.length > MAX_LOADED_WORKFLOWS) { workflows = workflows.slice(0, MAX_LOADED_WORKFLOWS); historyWindowAdvanced = true; }
			draftDirty = false;
			notice = success;
			renderList(); renderStatus();
		} catch (error) {
			if (!disposed && generation === contextGeneration && operationId === operationGeneration) { formErrorMessage = errorText(error); renderStatus(); }
		} finally {
			if (!disposed && generation === contextGeneration && operationId === operationGeneration) { operation = false; renderStatus(); renderList(); schedulePoll(); }
		}
	}

	function updateFromPlan(plan: AgentWorkflowPlan): void {
		draftNodes = plan.nodes.map(node => ({
			nodeId: node.nodeId, sessionId: node.sessionId, role: node.role,
			mode: node.permissionPolicy.mode, approval: node.permissionPolicy.approval,
			dependsOn: [...node.dependsOn], references: [...node.referenceIds],
		}));
		concurrency.input.value = String(plan.maxConcurrentNodes);
		turns.input.value = String(plan.maxTotalTurns);
		duration.input.value = String(Math.max(1, Math.ceil(plan.maxDurationMs / 60_000)));
		draftDirty = false;
		renderNodes(true);
	}

	async function loadKnowledge(): Promise<void> {
		if (knowledgeLoading) { return; }
		const generation = contextGeneration;
		knowledgeLoading = true; knowledgeError = undefined; renderNodes(true);
		try {
			const result = await currentActions.loadKnowledge(currentContext.projectId);
			if (!disposed && generation === contextGeneration) { knowledge = result; nodeRowsSignature = ''; renderNodes(); }
		} catch (error) {
			if (!disposed && generation === contextGeneration) { knowledgeError = errorText(error); }
		} finally {
			if (!disposed && generation === contextGeneration) { knowledgeLoading = false; nodeRowsSignature = ''; renderNodes(); renderStatus(); }
		}
	}

	function setContext(nextContext: SessionWorkflowContext, nextActions: SessionWorkflowActions): void {
		const changed = currentContext.projectId !== nextContext.projectId || currentContext.session.id !== nextContext.session.id
			|| currentContext.session.taskId !== nextContext.session.taskId || currentContext.session.bindingId !== nextContext.session.bindingId;
		currentContext = nextContext;
		currentActions = nextActions;
		updateScope();
		if (changed) {
			contextGeneration++;
			operationGeneration++;
			statusRequestGeneration++;
			operation = false; listLoading = false; statusLoading = false; knowledgeLoading = false;
			selectedWorkflowId = undefined; selectedStatus = undefined; workflows = []; nextCursor = undefined; listHasMore = false; historyWindowAdvanced = false;
			listSignature = ''; nodeRowsSignature = ''; knowledge = undefined; knowledgeError = undefined; draftNodes = []; draftDirty = false;
			candidateSignature = candidateSessions().map(session => `${session.id}:${session.name}:${session.provider}:${session.model}:${session.state}`).join('|');
			formErrorMessage = undefined; listErrorMessage = undefined; notice = '';
			if (timer) { clearTimeout(timer); timer = undefined; }
			concurrency.input.value = '1'; turns.input.value = '8'; duration.input.value = '30';
			renderNodes(true); renderList(); renderStatus();
			if (visible) { void loadList(true); void loadKnowledge(); }
		} else {
			const nextCandidateSignature = candidateSessions().map(session => `${session.id}:${session.name}:${session.provider}:${session.model}:${session.state}`).join('|');
			if (candidateSignature !== nextCandidateSignature) {
				candidateSignature = nextCandidateSignature;
				nodeRowsSignature = '';
				renderNodes();
			}
		}
	}

	function setVisible(nextVisible: boolean): void {
		if (visible === nextVisible || disposed) { return; }
		visible = nextVisible;
		if (!visible) {
			contextGeneration++;
			statusRequestGeneration++;
			if (timer) { clearTimeout(timer); timer = undefined; }
			listLoading = false; statusLoading = false; operation = false; knowledgeLoading = false; operationGeneration++;
			return;
		}
		contextGeneration++;
		statusRequestGeneration++;
		void loadList(true);
		void loadKnowledge();
		if (selectedWorkflowId) { void loadSelectedStatus(); }
	}

	function dispose(): void {
		if (disposed) { return; }
		disposed = true; contextGeneration++; operationGeneration++; statusRequestGeneration++;
		if (timer) { clearTimeout(timer); timer = undefined; }
	}

	loadOlder.addEventListener('click', () => void loadList(false));
	reload.addEventListener('click', () => { workflows = []; nextCursor = undefined; listHasMore = false; historyWindowAdvanced = false; listSignature = ''; void loadList(true); });
	newPlan.addEventListener('click', () => {
		if (timer) { clearTimeout(timer); timer = undefined; }
		statusRequestGeneration++;
		statusLoading = false;
		selectedWorkflowId = undefined; selectedStatus = undefined; draftNodes = []; draftDirty = false; formErrorMessage = undefined; notice = '새 계획을 작성합니다. 저장 전에는 프로젝트에 기록되지 않습니다.';
		concurrency.input.value = '1'; turns.input.value = '8'; duration.input.value = '30';
		listSignature = ''; renderList(); renderStatus(); renderNodes(true);
	});
	refreshStatus.addEventListener('click', () => {
		if (selectedWorkflowId) { void loadSelectedStatus(); }
		if (knowledgeError) { void loadKnowledge(); }
	});
	save.addEventListener('click', () => {
		void (async () => {
			try {
				const plan = planInput(); validatePlan(plan);
				if (selectedWorkflowId && selectedStatus) {
					await runOperation(() => currentActions.reviseWorkflow(selectedWorkflowId!, selectedStatus!.workflow.revision, plan), '새 계획 버전을 저장했습니다. 별도 승인이 필요합니다.');
				} else {
					const input: CreateAgentWorkflowInput = { ...plan, idempotencyKey: crypto.randomUUID() };
					await runOperation(() => currentActions.createWorkflow(input), '계획을 저장했습니다. 별도 호스트 승인이 필요합니다.');
				}
			} catch (error) { formErrorMessage = errorText(error); renderStatus(); }
		})();
	});
	approve.addEventListener('click', () => {
		const selected = selectedStatus;
		if (!selected || operation || draftDirty) { return; }
		void (async () => {
			if (operation) { return; }
			const generation = contextGeneration;
			const operationId = ++operationGeneration;
			operation = true; formErrorMessage = undefined; notice = '호스트의 native 승인 확인을 기다리는 중입니다.'; renderStatus(); renderList();
			try {
				const result = await currentActions.approveWorkflow(selected.workflow.id, selected.workflow.revision, selected.plan.version, selected.plan.fingerprint, crypto.randomUUID());
				if (disposed || generation !== contextGeneration || operationId !== operationGeneration) { return; }
				selectedStatus = result.status;
				if (result.approved) { notice = '호스트에서 계획 승인을 확인했습니다. 실행은 별도로 시작해야 합니다.'; }
				else { notice = '승인이 완료되지 않았습니다. 계획은 실행되지 않았습니다.'; }
				const index = workflows.findIndex(item => item.id === result.status.workflow.id);
				if (index >= 0) { workflows[index] = result.status.workflow; }
				renderList(); renderStatus();
			} catch (error) {
				if (!disposed && generation === contextGeneration && operationId === operationGeneration) { formErrorMessage = errorText(error); renderStatus(); }
			} finally {
				if (!disposed && generation === contextGeneration && operationId === operationGeneration) { operation = false; renderStatus(); renderList(); schedulePoll(); }
			}
		})();
	});
	start.addEventListener('click', () => {
		const selected = selectedStatus;
		if (!selected || draftDirty) { return; }
		void runOperation(() => currentActions.startWorkflow(selected.workflow.id, selected.workflow.revision, crypto.randomUUID()), '실행을 시작했습니다. 각 세션의 실제 실행 상태를 확인하세요.');
	});
	cancel.addEventListener('click', () => {
		const selected = selectedStatus;
		if (!selected) { return; }
		void runOperation(() => currentActions.cancelWorkflow(selected.workflow.id, selected.workflow.revision, crypto.randomUUID()), '중단 요청을 저장했습니다. 실제 정리 상태는 새로고침 후 확인하세요.');
	});
	for (const field of [concurrency.input, turns.input, duration.input]) { field.addEventListener('input', () => { draftDirty = true; updateButtons(); }); }

	updateScope(); renderNodes(true); renderList(); renderStatus();
	return { setContext, setVisible, dispose };
}

function makeButton(label: string): HTMLButtonElement {
	const button = document.createElement('button'); button.type = 'button'; button.className = 'ai-session__secondary'; button.textContent = label; return button;
}

function makeNumberField(labelText: string, min: number, max: number, value: number): { wrapper: HTMLLabelElement; input: HTMLInputElement } {
	const wrapper = document.createElement('label'); wrapper.className = 'ai-session-workflows__limit-field'; wrapper.appendChild(document.createTextNode(labelText));
	const input = document.createElement('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = '1'; input.value = String(value); wrapper.appendChild(input); return { wrapper, input };
}

function makeSelect(labelText: string, field: string, nodeId: string, values: readonly (readonly [string, string])[], selected: string, onChange: (value: string) => void): HTMLElement {
	const label = document.createElement('label'); label.className = 'ai-session-workflows__inline-field'; label.textContent = labelText;
	const select = document.createElement('select'); select.dataset.field = field; select.dataset.nodeId = nodeId;
	select.dataset.controlKey = `${field}-${nodeId}`;
	for (const [value, text] of values) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.appendChild(option); }
	select.value = selected; select.addEventListener('change', () => onChange(select.value)); label.appendChild(select); return label;
}

function nodeStateLabel(state: AgentWorkflowNodeState): string {
	return state === 'launching' ? '시작 확인 중' : WORKFLOW_STATE_LABELS[state];
}

function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message && /[\uac00-\ud7a3]/.test(message) ? message : `요청을 처리하지 못했습니다. ${message || '알 수 없는 오류'}`;
}
