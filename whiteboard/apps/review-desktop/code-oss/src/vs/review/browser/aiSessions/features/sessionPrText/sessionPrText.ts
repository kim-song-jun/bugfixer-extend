import type {
	AgentPrTextRequestDTO, AgentPrTextRevisionDTO, AgentPrTextScope,
} from '../../../../../workspace/common/workspaceAgentPrTextProtocol.js';
import { AGENT_PR_TEXT_MAX_BODY_BYTES } from '../../../../../workspace/common/workspaceAgentPrTextProtocol.js';
import type {
	IWorkspaceAgentPrTextService, WorkspaceAgentPrTextDraftDTO, WorkspaceAgentPrTextPreviewDTO, WorkspaceAgentPrTextSelection,
} from '../../../../../workspace/common/workspaceAgentPrTextHostProtocol.js';
import './sessionPrText.css';

const PAGE_SIZE = 5;
const MAX_HISTORY = 20;
const MAX_POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 1500;
const DEFAULT_INSTRUCTION = '이 변경 내용을 바탕으로 검토자가 이해하기 쉬운 한국어 PR 제목과 설명을 작성해 주세요.';
const REQUEST_STATES: readonly AgentPrTextRequestDTO['state'][] = ['preview', 'running', 'succeeded', 'conflicted', 'failed', 'cancelled', 'interrupted'];

export type SessionPrTextActions = IWorkspaceAgentPrTextService;

export interface SessionPrTextController {
	render(parent: HTMLElement, scope: AgentPrTextScope, actions: SessionPrTextActions, refresh: () => void, onSelectedRevision?: (selection: WorkspaceAgentPrTextSelection | undefined) => void): void;
	invalidate(): void;
	dispose(): void;
	getSelectedRevision(): WorkspaceAgentPrTextSelection | undefined;
}

export function createSessionPrText(): SessionPrTextController {
	let parent: HTMLElement | undefined;
	let currentScope: AgentPrTextScope | undefined;
	let currentActions: SessionPrTextActions | undefined;
	let refreshView: (() => void) | undefined;
	let selectionChanged: ((selection: WorkspaceAgentPrTextSelection | undefined) => void) | undefined;
	let generation = 0;
	let disposed = false;
	let active = false;
	let draftLoading = false;
	let draftReady = false;
	let initialLoadStarted = false;
	let head: AgentPrTextRevisionDTO | null = null;
	let revisions: AgentPrTextRevisionDTO[] = [];
	let revisionCursor = 0;
	let revisionsHaveMore = false;
	let revisionsLoading = false;
	let requests: AgentPrTextRequestDTO[] = [];
	let requestCursor = 0;
	let requestsHaveMore = false;
	let requestsLoading = false;
	let title = '';
	let body = '';
	let instruction = DEFAULT_INSTRUCTION;
	let editEpoch = 0;
	let instructionEpoch = 0;
	let dirtyBuffer = false;
	let loadingError = '';
	let actionError = '';
	let status = '';
	let busy = false;
	let preview: WorkspaceAgentPrTextPreviewDTO | undefined;
	let selectedRequest: AgentPrTextRequestDTO | undefined;
	let selectedRequestId: string | undefined;
	let previewEditEpoch = -1;
	let previewInstructionEpoch = -1;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pollAttempts = 0;

	const contextKey = (scope: AgentPrTextScope): string => `${scope.projectId}\u0000${scope.sessionId}\u0000${scope.targetTurnId}`;
	const isCurrent = (requestGeneration: number, scope: AgentPrTextScope): boolean => !disposed && active && requestGeneration === generation && !!currentScope && sameScope(scope, currentScope);
	const update = (): void => { if (!disposed && active) { if (refreshView) { refreshView(); } else { renderView(); } } };
	const clearPoll = (): void => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
	const invalidate = (): void => { generation++; active = false; initialLoadStarted = false; clearPoll(); busy = false; draftLoading = false; revisionsLoading = false; requestsLoading = false; };

	const selectedRevision = (): WorkspaceAgentPrTextSelection | undefined => {
		if (!currentScope || !head || dirtyBuffer || title !== head.content.title || body !== head.content.body) { return undefined; }
		return { scope: currentScope, revision: head.revision, contentHash: head.content.contentHash };
	};
	const notifySelection = (): void => { selectionChanged?.(selectedRevision()); };
	const isVisible = (): boolean => !!parent && parent.isConnected && !parent.closest('[hidden]') && parent.getClientRects().length > 0;
	const authorLabel = (revision: AgentPrTextRevisionDTO): string => revision.author === 'human' ? '사람 수정' : revision.author === 'liveAgentTurn' ? '에이전트 작성' : 'AI 제안';
	const requestLabel = (request: AgentPrTextRequestDTO): string => ({ preview: '실행 대기', running: '작성 중', succeeded: '완료', conflicted: '기준 변경 충돌', failed: '실패', cancelled: '취소됨', interrupted: '중단됨' })[request.state];
	const hasSavedHead = (): boolean => head !== null;
	const invalidatePreparedPreview = (): void => { if (preview?.request.state === 'preview') { preview = undefined; previewEditEpoch = -1; previewInstructionEpoch = -1; } };

	const loadDraft = async (scope: AgentPrTextScope, actions: SessionPrTextActions, requestGeneration: number): Promise<void> => {
		if (draftLoading) { return; }
		const startEditEpoch = editEpoch;
		const startInstructionEpoch = instructionEpoch;
		draftLoading = true; loadingError = ''; update();
		try {
			const result = await actions.getPrTextDraft(scope);
			if (!isCurrent(requestGeneration, scope)) { return; }
			assertDraft(result, scope);
			head = result.head;
			revisions = [...result.revisions.revisions].slice(-MAX_HISTORY);
			revisionCursor = result.revisions.nextRevision;
			revisionsHaveMore = result.revisions.hasMore;
			requests = [...result.requests.requests].slice(-MAX_HISTORY);
			requestCursor = result.requests.nextSequence;
			requestsHaveMore = result.requests.hasMore;
			draftReady = true;
			if (!dirtyBuffer && startEditEpoch === editEpoch && head) { title = head.content.title; body = head.content.body; }
			if (startInstructionEpoch === instructionEpoch && instruction === '') { instruction = DEFAULT_INSTRUCTION; }
			loadingError = '';
			status = head ? `저장된 PR 문구 v${head.revision}을 불러왔습니다.` : '저장된 PR 문구가 없습니다. AI 제안을 실행해 첫 문구를 만들어 주세요.';
		} catch {
			if (!isCurrent(requestGeneration, scope)) { return; }
			loadingError = 'PR 문구 기록을 불러오지 못했습니다. 다시 시도해 주세요.';
		} finally {
			if (isCurrent(requestGeneration, scope)) { draftLoading = false; update(); notifySelection(); }
		}
	};

	const loadRevisions = async (scope: AgentPrTextScope, actions: SessionPrTextActions, requestGeneration: number): Promise<void> => {
		if (revisionsLoading || !revisionsHaveMore) { return; }
		revisionsLoading = true; actionError = ''; update();
		try {
			const page = await actions.listPrTextRevisions({ scope, after: revisionCursor, limit: PAGE_SIZE });
			if (!isCurrent(requestGeneration, scope)) { return; }
			assertRevisionPage(page, scope, revisionCursor);
			revisions = [...revisions, ...page.revisions].slice(-MAX_HISTORY);
			revisionCursor = page.nextRevision; revisionsHaveMore = page.hasMore;
		} catch {
			if (!isCurrent(requestGeneration, scope)) { return; }
			actionError = '이전 PR 문구 기록을 불러오지 못했습니다.';
		} finally { if (isCurrent(requestGeneration, scope)) { revisionsLoading = false; update(); } }
	};

	const loadRequests = async (scope: AgentPrTextScope, actions: SessionPrTextActions, requestGeneration: number): Promise<void> => {
		if (requestsLoading || !requestsHaveMore) { return; }
		requestsLoading = true; actionError = ''; update();
		try {
			const page = await actions.listPrTextRequests({ scope, after: requestCursor, limit: PAGE_SIZE });
			if (!isCurrent(requestGeneration, scope)) { return; }
			assertRequestPage(page, scope, requestCursor);
			requests = [...requests, ...page.requests].slice(-MAX_HISTORY);
			requestCursor = page.nextSequence; requestsHaveMore = page.hasMore;
		} catch {
			if (!isCurrent(requestGeneration, scope)) { return; }
			actionError = 'AI 작성 요청 기록을 불러오지 못했습니다.';
		} finally { if (isCurrent(requestGeneration, scope)) { requestsLoading = false; update(); } }
	};

	const refreshRequest = async (scope: AgentPrTextScope, actions: SessionPrTextActions, requestGeneration: number, requestId: string): Promise<void> => {
		try {
			const result = await actions.getPrTextRequest({ scope, requestId });
			if (!isCurrent(requestGeneration, scope)) { return; }
			assertRequest(result, scope);
			upsertRequest(result);
			if (selectedRequestId === result.id) { selectedRequest = result; }
			if (preview?.request.id === result.id) { preview = { ...preview, request: result }; }
			if (result.state === 'running') { schedulePoll(scope, actions, requestGeneration, result); }
			if (result.state === 'succeeded' && result.candidate) {
				status = 'AI 작성이 완료되었습니다. 저장된 최신 문구를 확인하세요.';
				void loadDraft(scope, actions, requestGeneration);
			} else if (result.state === 'conflicted') { status = '작성 중 최신 PR 문구가 바뀌었습니다. 후보를 확인하고 현재 저장본에 명시적으로 적용해 주세요.'; }
			else if (result.state === 'failed') { actionError = result.errorCode === 'runnerUnavailable' ? 'AI 작성 실행기를 사용할 수 없습니다. 제공자 설정을 확인해 주세요.' : result.errorCode === 'invalidCandidate' ? 'AI가 사용할 수 없는 문구를 반환했습니다.' : 'AI 작성에 실패했습니다. 요청 기록을 확인해 주세요.'; }
			else if (result.state === 'interrupted') { status = 'AI 작성이 중단되었습니다. 요청을 다시 실행해 주세요.'; }
			else if (result.state === 'cancelled') { status = 'AI 작성 요청을 취소했습니다.'; }
			update();
		} catch {
			if (isCurrent(requestGeneration, scope)) { actionError = 'AI 작성 상태를 확인하지 못했습니다. 다시 불러와 주세요.'; update(); }
		}
	};

	const schedulePoll = (scope: AgentPrTextScope, actions: SessionPrTextActions, requestGeneration: number, request: AgentPrTextRequestDTO): void => {
		clearPoll();
		if (disposed || !active || request.state !== 'running' || pollAttempts >= MAX_POLL_ATTEMPTS || !isVisible()) { return; }
		timer = setTimeout(() => {
			timer = undefined;
			if (!isCurrent(requestGeneration, scope) || !isVisible()) { return; }
			pollAttempts++;
			void refreshRequest(scope, actions, requestGeneration, request.id).then(() => {
				const latest = requests.find(item => item.id === request.id);
				if (latest?.state === 'running') {
					if (pollAttempts >= MAX_POLL_ATTEMPTS) { status = '상태 자동 확인을 마쳤습니다. 직접 다시 확인할 수 있습니다.'; update(); }
					else { schedulePoll(scope, actions, requestGeneration, latest); }
				}
			});
		}, POLL_INTERVAL_MS);
	};

	const runPreview = async (scope: AgentPrTextScope, actions: SessionPrTextActions, requestGeneration: number): Promise<void> => {
		if (busy || !draftReady || !instruction.trim() || dirtyBuffer) { return; }
		busy = true; actionError = ''; status = '요청 범위와 AI 제공자 설정을 확인하고 있습니다.'; const capturedEditEpoch = editEpoch; const capturedInstructionEpoch = instructionEpoch; update();
		try {
			const result = await actions.previewPrTextRequest({ scope, baseRevision: head?.revision ?? 0, idempotencyKey: newId(), instruction: instruction.trim() });
			if (!isCurrent(requestGeneration, scope)) { return; }
			assertPreview(result, scope);
			upsertRequest(result.request); selectedRequestId = result.request.id; selectedRequest = result.request; pollAttempts = 0;
			if (capturedEditEpoch !== editEpoch || capturedInstructionEpoch !== instructionEpoch || dirtyBuffer) {
				preview = undefined;
				status = '요청 준비 중 입력이 바뀌어 이 미리보기는 폐기했습니다. 저장한 뒤 다시 준비해 주세요.';
				return;
			}
			preview = result;
			previewEditEpoch = capturedEditEpoch;
			previewInstructionEpoch = capturedInstructionEpoch;
			status = '제공자와 모델, 전달할 변경 근거를 확인한 뒤 AI 작성을 실행할 수 있습니다.';
		} catch {
			if (!isCurrent(requestGeneration, scope)) { return; }
			preview = undefined; actionError = 'AI 작성 요청을 준비하지 못했습니다. 제공자 사용 가능 상태를 확인해 주세요. 다른 제공자로 자동 전환하지 않았습니다.';
		} finally { if (isCurrent(requestGeneration, scope)) { busy = false; update(); } }
	};

	const startRequest = async (scope: AgentPrTextScope, actions: SessionPrTextActions, requestGeneration: number): Promise<void> => {
		const request = preview?.request;
		if (busy || !request || request.state !== 'preview' || preview?.digest !== request.contextDigest || dirtyBuffer || previewEditEpoch !== editEpoch || previewInstructionEpoch !== instructionEpoch) {
			invalidatePreparedPreview();
			return;
		}
		busy = true; actionError = ''; status = `${request.provider} · ${request.model} AI 작성 중입니다.`; update();
		try {
			const result = await actions.startPrTextRequest({ scope, requestId: request.id, expectedStateRevision: request.stateRevision, expectedDigest: preview.digest });
			if (!isCurrent(requestGeneration, scope)) { return; }
			assertRequest(result, scope); upsertRequest(result); selectedRequest = result; preview = { ...preview, request: result }; pollAttempts = 0;
			if (result.state === 'running') { schedulePoll(scope, actions, requestGeneration, result); }
			else { void refreshRequest(scope, actions, requestGeneration, result.id); }
		} catch {
			if (isCurrent(requestGeneration, scope)) { actionError = 'AI 작성을 시작하지 못했습니다. 요청 상태를 다시 확인해 주세요.'; }
		} finally { if (isCurrent(requestGeneration, scope)) { busy = false; update(); } }
	};

	const cancelRequest = async (scope: AgentPrTextScope, actions: SessionPrTextActions, requestGeneration: number, request: AgentPrTextRequestDTO): Promise<void> => {
		if (busy || request.state !== 'running') { return; }
		busy = true; actionError = ''; status = 'AI 작성 취소를 요청하고 있습니다.'; clearPoll(); update();
		try {
			const result = await actions.cancelPrTextRequest({ scope, requestId: request.id, expectedStateRevision: request.stateRevision });
			if (!isCurrent(requestGeneration, scope)) { return; }
			assertRequest(result, scope); upsertRequest(result); if (preview?.request.id === result.id) { preview = { ...preview, request: result }; }
			status = result.state === 'cancelled' ? 'AI 작성 요청을 취소했습니다.' : `취소 요청 후 상태: ${requestLabel(result)}.`;
		} catch {
			if (isCurrent(requestGeneration, scope)) { actionError = 'AI 작성 취소를 확인하지 못했습니다. 현재 상태를 다시 읽어 주세요.'; }
		} finally { if (isCurrent(requestGeneration, scope)) { busy = false; update(); } }
	};

	const save = async (scope: AgentPrTextScope, actions: SessionPrTextActions, requestGeneration: number): Promise<void> => {
		if (busy || !head || !dirtyBuffer || !title.trim() || utf8ByteLength(body) > AGENT_PR_TEXT_MAX_BODY_BYTES) { return; }
		const saveTitle = title; const saveBody = body; const saveEpoch = editEpoch; const expectedRevision = head.revision;
		busy = true; actionError = ''; status = '새 PR 문구 버전을 저장하고 있습니다.'; update();
		try {
			const saved = await actions.savePrTextRevision({ scope, expectedRevision, idempotencyKey: newId(), title: saveTitle, body: saveBody });
			if (!isCurrent(requestGeneration, scope)) { return; }
			assertRevision(saved, scope);
			head = saved; revisions = [saved, ...revisions.filter(item => item.revision !== saved.revision)].slice(0, MAX_HISTORY);
			if (editEpoch === saveEpoch) { title = saved.content.title; body = saved.content.body; dirtyBuffer = false; }
			invalidatePreparedPreview();
			status = `PR 문구를 v${saved.revision}으로 저장했습니다.`;
			notifySelection();
		} catch {
			if (!isCurrent(requestGeneration, scope)) { return; }
			actionError = '저장하지 못했습니다. 최신 저장본이 바뀌었을 수 있습니다. 입력한 제목과 설명은 그대로 보존했습니다.';
			status = '최신 저장 기록을 다시 확인한 뒤 필요하면 직접 적용해 주세요.';
			void loadDraft(scope, actions, requestGeneration);
		} finally { if (isCurrent(requestGeneration, scope)) { busy = false; update(); } }
	};

	const applyCandidate = async (scope: AgentPrTextScope, actions: SessionPrTextActions, requestGeneration: number, request: AgentPrTextRequestDTO): Promise<void> => {
		if (!request.candidate || busy || !['conflicted', 'cancelled', 'interrupted', 'failed'].includes(request.state)) { return; }
		const applyEpoch = editEpoch;
		busy = true; actionError = ''; status = '저장된 AI 후보를 최신 저장본 기준으로 적용하고 있습니다.'; update();
		try {
			const revision = await actions.applyPrTextCandidate({ scope, requestId: request.id, expectedStateRevision: request.stateRevision,
				expectedHeadRevision: head?.revision ?? 0, idempotencyKey: newId() });
			if (!isCurrent(requestGeneration, scope)) { return; }
			assertRevision(revision, scope);
			head = revision; revisions = [revision, ...revisions.filter(item => item.revision !== revision.revision)].sort((left, right) => right.revision - left.revision).slice(0, MAX_HISTORY);
			if (editEpoch === applyEpoch && !dirtyBuffer) { title = revision.content.title; body = revision.content.body; }
			status = `AI 후보를 제공자 출처를 유지한 새 버전 v${revision.revision}으로 적용했습니다.`;
			notifySelection();
		} catch {
			if (!isCurrent(requestGeneration, scope)) { return; }
			actionError = 'AI 후보를 적용하지 못했습니다. 요청 상태와 최신 저장본을 확인해 주세요.';
			void loadDraft(scope, actions, requestGeneration);
		} finally { if (isCurrent(requestGeneration, scope)) { busy = false; update(); } }
	};

	const renderView = (): void => {
		if (!parent || disposed) { return; }
		const focused = document.activeElement instanceof HTMLElement && parent.contains(document.activeElement) ? document.activeElement as HTMLElement & { selectionStart?: number | null; selectionEnd?: number | null } : undefined;
		const focusKey = focused?.dataset.focusKey;
		const selectionStart = focused?.selectionStart ?? undefined;
		const selectionEnd = focused?.selectionEnd ?? undefined;
		const section = document.createElement('section'); section.className = 'ai-session-pr-text'; section.setAttribute('aria-label', 'GitHub PR 제목과 설명');
		const heading = document.createElement('h3'); heading.textContent = 'GitHub PR 문구'; section.appendChild(heading);
		append(section, 'ai-session-pr-text__note', 'AI가 첫 제목과 설명을 작성합니다. 채팅 지시나 직접 편집으로 수정하면 저장할 때 새 버전으로 남습니다. 게시 승인은 별도 단계입니다.');
		append(section, 'ai-session-pr-text__scope', '선택한 실행의 변경 내용과 저장된 검토 이유를 바탕으로 작성합니다.');
		if (currentScope) {
			const scopeDetails = document.createElement('details'); scopeDetails.className = 'ai-session-pr-text__details';
			const summary = document.createElement('summary'); summary.textContent = '실행 상세'; scopeDetails.appendChild(summary);
			append(scopeDetails, 'ai-session-pr-text__detail', `프로젝트 식별자: ${currentScope.projectId}`);
			append(scopeDetails, 'ai-session-pr-text__detail', `세션 식별자: ${currentScope.sessionId}`);
			append(scopeDetails, 'ai-session-pr-text__detail', `실행 식별자: ${currentScope.targetTurnId}`);
			section.appendChild(scopeDetails);
		}
		const liveStatus = document.createElement('p'); liveStatus.className = 'ai-session-pr-text__status'; liveStatus.setAttribute('role', 'status'); liveStatus.setAttribute('aria-live', 'polite'); liveStatus.textContent = draftLoading ? '저장된 PR 문구를 불러오는 중입니다.' : status; section.appendChild(liveStatus);
		if (loadingError || actionError) { const error = document.createElement('p'); error.className = 'ai-session-pr-text__error'; error.setAttribute('role', 'alert'); error.textContent = loadingError || actionError; section.appendChild(error); }
		const sourceInfo = head ? `저장된 최신 문구 v${head.revision} · ${authorLabel(head)}${head.source?.kind === 'providerAttempt' ? ` · ${head.source.provider} · ${head.source.model}` : ''}` : '저장된 PR 문구 없음';
		append(section, 'ai-session-pr-text__head', sourceInfo);
		const hasEditableHead = draftReady && hasSavedHead();
		const titleInput = document.createElement('input'); titleInput.type = 'text'; titleInput.maxLength = 200; titleInput.value = title; titleInput.readOnly = !hasEditableHead; titleInput.placeholder = 'PR 제목'; titleInput.dataset.focusKey = 'pr-title'; titleInput.setAttribute('aria-label', 'PR 제목');
		titleInput.addEventListener('input', () => { title = titleInput.value; dirtyBuffer = true; editEpoch++; invalidatePreparedPreview(); actionError = ''; notifySelection(); update(); });
		field(section, hasEditableHead ? 'PR 제목' : 'AI 초안 제목', titleInput);
		const bodyInput = document.createElement('textarea'); bodyInput.maxLength = 20000; bodyInput.value = body; bodyInput.readOnly = !hasEditableHead; bodyInput.placeholder = '변경 내용과 검토 지점을 설명합니다.'; bodyInput.dataset.focusKey = 'pr-body'; bodyInput.setAttribute('aria-label', 'PR 설명');
		bodyInput.addEventListener('input', () => { body = bodyInput.value; dirtyBuffer = true; editEpoch++; invalidatePreparedPreview(); actionError = ''; notifySelection(); update(); });
		field(section, hasEditableHead ? 'PR 설명' : 'AI 초안 설명', bodyInput);
		const editState = document.createElement('p'); editState.className = 'ai-session-pr-text__note'; editState.textContent = dirtyBuffer ? '저장되지 않은 편집 내용이 있습니다.' : hasSavedHead() ? '저장된 최신 문구를 보고 있습니다.' : 'AI 초안을 만들 지시를 적어 주세요.'; section.appendChild(editState);
		const bodyBytes = utf8ByteLength(body);
		if (bodyBytes > AGENT_PR_TEXT_MAX_BODY_BYTES) { append(section, 'ai-session-pr-text__error', `PR 설명은 UTF-8 ${AGENT_PR_TEXT_MAX_BODY_BYTES}바이트 이하여야 합니다. 현재 ${bodyBytes}바이트입니다.`); }
		const saveButton = button(busy ? '저장 중…' : '새 문구 버전 저장', 'save-pr-text');
		saveButton.disabled = busy || !hasSavedHead() || !dirtyBuffer || !title.trim() || bodyBytes > AGENT_PR_TEXT_MAX_BODY_BYTES; saveButton.addEventListener('click', () => currentScope && currentActions && void save(currentScope, currentActions, generation)); section.appendChild(saveButton);
		if (!hasSavedHead()) { append(section, 'ai-session-pr-text__note', 'AI가 첫 문구를 저장하면 제목과 설명을 직접 편집해 새 버전으로 저장할 수 있습니다.'); }

		const ai = document.createElement('section'); ai.className = 'ai-session-pr-text__section'; ai.setAttribute('aria-label', 'AI 문구 작성 요청');
		const aiTitle = document.createElement('h4'); aiTitle.textContent = hasSavedHead() ? 'AI에게 수정 요청' : 'AI 초안 작성'; ai.appendChild(aiTitle);
		const chat = document.createElement('textarea'); chat.maxLength = 4000; chat.value = instruction; chat.dataset.focusKey = 'pr-chat'; chat.setAttribute('aria-label', 'AI 수정 지시'); chat.placeholder = hasSavedHead() ? '수정할 방향을 적어 주세요.' : '원하는 첫 PR 초안의 내용을 적어 주세요.';
		chat.addEventListener('input', () => { instruction = chat.value; instructionEpoch++; if (preview?.request.state === 'preview') { status = '수정 지시가 바뀌어 미리보기를 폐기했습니다. 다시 준비해 주세요.'; } invalidatePreparedPreview(); update(); }); field(ai, hasSavedHead() ? '수정 지시' : '작성 지시', chat);
		const previewButton = button(busy ? '요청 준비 중…' : 'AI 요청 미리보기', 'preview-pr-text'); previewButton.disabled = busy || !draftReady || !instruction.trim() || dirtyBuffer; previewButton.addEventListener('click', () => currentScope && currentActions && void runPreview(currentScope, currentActions, generation)); ai.appendChild(previewButton);
		if (dirtyBuffer) { append(ai, 'ai-session-pr-text__note', '미저장된 제목 또는 설명이 있습니다. 저장한 뒤 AI 수정 요청을 준비할 수 있습니다.'); }
		const displayedRequest = selectedRequestId ? (preview?.request.id === selectedRequestId ? preview.request : selectedRequest?.id === selectedRequestId ? selectedRequest : undefined) : (preview?.request ?? selectedRequest);
		if (displayedRequest) {
			const request = displayedRequest;
			append(ai, 'ai-session-pr-text__request', `${request.provider} · ${request.model} · ${requestLabel(request)} · 수정 기준 v${request.baseRevision}`);
			append(ai, 'ai-session-pr-text__note', '실행 시 연결한 계정의 사용량이 발생할 수 있습니다.');
			const requestDetails = document.createElement('details'); requestDetails.className = 'ai-session-pr-text__details';
			const requestSummary = document.createElement('summary'); requestSummary.textContent = '실행 상세'; requestDetails.appendChild(requestSummary);
			append(requestDetails, 'ai-session-pr-text__detail', `프로필 식별자: ${request.profileRef ?? '기본 프로필'}`);
			append(requestDetails, 'ai-session-pr-text__detail', `프로젝트 식별자: ${request.scope.projectId}`);
			append(requestDetails, 'ai-session-pr-text__detail', `세션 식별자: ${request.scope.sessionId}`);
			append(requestDetails, 'ai-session-pr-text__detail', `실행 식별자: ${request.scope.targetTurnId}`);
			append(requestDetails, 'ai-session-pr-text__detail', `문맥 지문: ${request.contextDigest}`);
			ai.appendChild(requestDetails);
			if (preview?.request.id === request.id) {
				const summary = document.createElement('ul'); summary.className = 'ai-session-pr-text__summary'; summary.setAttribute('aria-label', 'AI에 전달할 문맥 요약');
				for (const item of preview.sourceSummary) { const li = document.createElement('li'); li.textContent = readableSourceSummary(item); summary.appendChild(li); }
				if (!preview.sourceSummary.length) { const li = document.createElement('li'); li.textContent = '전달할 추가 문맥 없음'; summary.appendChild(li); }
				ai.appendChild(summary);
			}
			if (request.candidate) { renderCandidate(ai, request); }
			if (preview?.request.id === request.id && request.state === 'preview') { const run = button('이 제공자로 AI 작성 실행', 'run-pr-text'); run.disabled = busy || dirtyBuffer; run.addEventListener('click', () => currentScope && currentActions && void startRequest(currentScope, currentActions, generation)); ai.appendChild(run); }
			if (request.state === 'running') {
				const cancel = button(busy ? '처리 중…' : 'AI 작성 취소', 'cancel-pr-text'); cancel.disabled = busy; cancel.addEventListener('click', () => currentScope && currentActions && void cancelRequest(currentScope, currentActions, generation, request)); ai.appendChild(cancel);
				const reload = button('AI 상태 다시 확인', 'refresh-pr-text-request'); reload.disabled = busy; reload.addEventListener('click', () => currentScope && currentActions && void refreshRequest(currentScope, currentActions, generation, request.id)); ai.appendChild(reload);
			}
		}
		section.appendChild(ai);

		const revisionSection = document.createElement('section'); revisionSection.className = 'ai-session-pr-text__section';
		const revisionTitle = document.createElement('h4'); revisionTitle.textContent = '저장된 문구 기록'; revisionSection.appendChild(revisionTitle);
		if (!revisions.length) { append(revisionSection, 'ai-session-pr-text__note', '저장된 버전이 없습니다.'); }
		const revisionList = document.createElement('ol'); revisionList.className = 'ai-session-pr-text__history'; revisionList.setAttribute('aria-label', '저장된 PR 문구 버전');
		for (const revision of revisions) {
			const item = document.createElement('li'); const summaryText = `v${revision.revision} · ${authorLabel(revision)} · ${revision.content.title || '(제목 없음)'}`; const select = button(summaryText, `revision:${revision.id}`); select.setAttribute('aria-pressed', String(revision.id === head?.id));
			select.addEventListener('click', () => { if (!hasSavedHead() || !currentScope || !currentActions) { return; } title = revision.content.title; body = revision.content.body; dirtyBuffer = true; editEpoch++; invalidatePreparedPreview(); status = `v${revision.revision} 문구를 편집창에 복사했습니다. 저장하면 최신 저장본 기준 새 버전이 됩니다.`; actionError = ''; update(); });
			item.appendChild(select); revisionList.appendChild(item);
		}
		if (revisions.length) { revisionSection.appendChild(revisionList); }
		if (revisionsHaveMore) { const more = button(revisionsLoading ? '불러오는 중…' : '이전 문구 더 보기', 'more-pr-text-revisions'); more.disabled = revisionsLoading; more.addEventListener('click', () => currentScope && currentActions && void loadRevisions(currentScope, currentActions, generation)); revisionSection.appendChild(more); }
		section.appendChild(revisionSection);

		const requestSection = document.createElement('section'); requestSection.className = 'ai-session-pr-text__section';
		const requestTitle = document.createElement('h4'); requestTitle.textContent = 'AI 요청 기록'; requestSection.appendChild(requestTitle);
		const requestList = document.createElement('ol'); requestList.className = 'ai-session-pr-text__history'; requestList.setAttribute('aria-label', 'AI 작성 요청 이력');
		for (const item of requests) {
			const row = document.createElement('li'); const select = button(`${item.provider} · ${item.model} · ${requestLabel(item)} · 기준 v${item.baseRevision}`, `request:${item.id}`); select.setAttribute('aria-pressed', String(item.id === selectedRequestId));
			select.addEventListener('click', () => {
				selectedRequestId = item.id;
				selectedRequest = preview?.request.id === item.id ? preview.request : undefined;
				if (!selectedRequest && currentScope && currentActions) { void refreshRequest(currentScope, currentActions, generation, item.id); }
				update();
			}); row.appendChild(select); requestList.appendChild(row);
		}
		if (!requests.length) { append(requestSection, 'ai-session-pr-text__note', 'AI 요청 기록이 없습니다.'); } else { requestSection.appendChild(requestList); }
		if (requestsHaveMore) { const more = button(requestsLoading ? '불러오는 중…' : '이전 요청 더 보기', 'more-pr-text-requests'); more.disabled = requestsLoading; more.addEventListener('click', () => currentScope && currentActions && void loadRequests(currentScope, currentActions, generation)); requestSection.appendChild(more); }
		section.appendChild(requestSection);
		const reload = button(draftLoading ? '기록 확인 중…' : '최신 저장 기록 확인', 'reload-pr-text'); reload.disabled = draftLoading; reload.addEventListener('click', () => currentScope && currentActions && void loadDraft(currentScope, currentActions, generation)); section.appendChild(reload);
		parent.replaceChildren(section);
		notifySelection();
		if (focusKey) { const next = parent.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`); if (next) { next.focus(); if (selectionStart !== undefined && (next instanceof HTMLTextAreaElement || next instanceof HTMLInputElement && next.type === 'text')) { next.setSelectionRange(selectionStart, selectionEnd ?? selectionStart); } } }
		const running = preview?.request.state === 'running' ? preview.request : selectedRequest?.state === 'running' ? selectedRequest : undefined;
		if (running && isVisible()) { const currentScopeValue = currentScope; const currentActionsValue = currentActions; if (currentScopeValue && currentActionsValue) { schedulePoll(currentScopeValue, currentActionsValue, generation, running); } } else { clearPoll(); }
	};

	function render(parentElement: HTMLElement, scope: AgentPrTextScope, actions: SessionPrTextActions, refresh: () => void, onSelectedRevision?: (selection: WorkspaceAgentPrTextSelection | undefined) => void): void {
		if (disposed) { return; }
		const changedScope = !currentScope || contextKey(currentScope) !== contextKey(scope);
		if (changedScope) {
			generation++; clearPoll(); currentScope = { ...scope }; head = null; revisions = []; revisionCursor = 0; revisionsHaveMore = false; requests = []; requestCursor = 0; requestsHaveMore = false;
			title = ''; body = ''; instruction = DEFAULT_INSTRUCTION; editEpoch = 0; instructionEpoch = 0; dirtyBuffer = false; loadingError = ''; actionError = ''; status = ''; busy = false; preview = undefined; selectedRequest = undefined; selectedRequestId = undefined; draftLoading = false; draftReady = false; initialLoadStarted = false; revisionsLoading = false; requestsLoading = false; pollAttempts = 0;
		}
		parent = parentElement; parent.classList.add('ai-session-pr-text-mount'); currentActions = actions; refreshView = refresh; selectionChanged = onSelectedRevision; active = true;
		const requestGeneration = generation;
		renderView();
		if (!initialLoadStarted) { initialLoadStarted = true; queueMicrotask(() => { if (isCurrent(requestGeneration, scope) && currentActions) { void loadDraft(scope, currentActions, requestGeneration); } }); }
	}

	function dispose(): void { if (disposed) { return; } disposed = true; invalidate(); parent?.replaceChildren(); parent = undefined; currentActions = undefined; refreshView = undefined; selectionChanged?.(undefined); selectionChanged = undefined; }

	return { render, invalidate, dispose, getSelectedRevision: selectedRevision };

	function renderCandidate(container: HTMLElement, request: AgentPrTextRequestDTO): void {
		const candidate = request.candidate;
		if (!candidate) { return; }
		const block = document.createElement('div'); block.className = 'ai-session-pr-text__candidate';
		append(block, 'ai-session-pr-text__candidate-title', `AI 후보 · ${candidate.source.kind === 'providerAttempt' ? `${candidate.source.provider} · ${candidate.source.model}` : '에이전트 작성'}`);
		const titlePreview = document.createElement('strong'); titlePreview.textContent = candidate.content.title; block.appendChild(titlePreview);
		const bodyPreview = document.createElement('pre'); bodyPreview.textContent = candidate.content.body; block.appendChild(bodyPreview);
		if (request.state === 'conflicted') { append(block, 'ai-session-pr-text__note', '현재 저장본이 요청 기준과 달라 자동으로 반영하지 않았습니다.'); }
		const canApply = ['conflicted', 'cancelled', 'interrupted', 'failed'].includes(request.state);
		const apply = button(canApply ? 'AI 후보를 최신 저장본 기준으로 적용' : request.state === 'succeeded' ? 'AI 후보가 저장된 버전으로 기록됨' : '요청이 끝난 뒤 후보를 적용할 수 있음', `apply-candidate:${request.id}`);
		apply.disabled = busy || !canApply;
		apply.addEventListener('click', () => currentScope && currentActions && void applyCandidate(currentScope, currentActions, generation, request)); block.appendChild(apply); container.appendChild(block);
	}

	function upsertRequest(request: AgentPrTextRequestDTO): void { const index = requests.findIndex(item => item.id === request.id); if (index >= 0) { requests[index] = request; } else { requests.unshift(request); requests = requests.slice(0, MAX_HISTORY); } }
}

function sameScope(left: AgentPrTextScope, right: AgentPrTextScope): boolean { return left.projectId === right.projectId && left.sessionId === right.sessionId && left.targetTurnId === right.targetTurnId; }
function assertDraft(value: WorkspaceAgentPrTextDraftDTO, scope: AgentPrTextScope): void {
	if (!value || !Array.isArray(value.revisions?.revisions) || !Array.isArray(value.requests?.requests)) { throw new Error('invalid PR text draft'); }
	if (value.head) { assertRevision(value.head, scope); }
	assertRevisionPage(value.revisions, scope, 0);
	assertRequestPage(value.requests, scope, 0);
	if (value.head && value.revisions.revisions.some(item => item.revision > value.head!.revision)) { throw new Error('draft page exceeds head'); }
}
function assertRevision(value: AgentPrTextRevisionDTO, scope: AgentPrTextScope): void {
	if (!value || !sameScope(value.scope, scope) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !value.content || typeof value.content.title !== 'string' || typeof value.content.body !== 'string' || !/^[0-9a-f]{64}$/iu.test(value.content.contentHash)) { throw new Error('invalid PR text revision'); }
}
function assertRevisionPage(value: { readonly revisions: readonly AgentPrTextRevisionDTO[]; readonly nextRevision: number; readonly hasMore: boolean }, scope: AgentPrTextScope, after: number): void {
	if (!value || !Array.isArray(value.revisions) || value.revisions.length > PAGE_SIZE || !Number.isSafeInteger(value.nextRevision) || typeof value.hasMore !== 'boolean' || value.revisions.some((item, index) => !sameScope(item.scope, scope) || !Number.isSafeInteger(item.revision) || item.revision < 1 || (after > 0 && item.revision >= after) || (index > 0 && item.revision >= value.revisions[index - 1].revision)) || value.nextRevision !== (value.revisions.at(-1)?.revision ?? after)) { throw new Error('invalid PR text revision page'); }
	for (const revision of value.revisions) { assertRevision(revision, scope); }
}
function assertRequestPage(value: { readonly requests: readonly AgentPrTextRequestDTO[]; readonly nextSequence: number; readonly hasMore: boolean }, scope: AgentPrTextScope, after: number): void {
	if (!value || !Array.isArray(value.requests) || value.requests.length > PAGE_SIZE || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 0 || typeof value.hasMore !== 'boolean' || value.requests.some(item => !sameScope(item.scope, scope)) || (value.requests.length > 0 && (value.nextSequence < 1 || (after > 0 && value.nextSequence >= after))) || (value.requests.length === 0 && value.nextSequence !== after)) { throw new Error('invalid PR text request page'); }
	for (const request of value.requests) { assertRequest(request, scope); }
}
function assertRequest(value: AgentPrTextRequestDTO, scope: AgentPrTextScope): void {
	if (!value || !value.id || !sameScope(value.scope, scope) || !Number.isSafeInteger(value.stateRevision) || value.stateRevision < 0 || !REQUEST_STATES.includes(value.state) || !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0 || !/^[0-9a-f]{64}$/iu.test(value.contextDigest) || (value.candidate && (!value.candidate.source || typeof value.candidate.content.title !== 'string' || typeof value.candidate.content.body !== 'string' || !/^[0-9a-f]{64}$/iu.test(value.candidate.content.contentHash)))) { throw new Error('invalid PR text request'); }
}
function assertPreview(value: WorkspaceAgentPrTextPreviewDTO, scope: AgentPrTextScope): void { if (!value || !/^[0-9a-f]{64}$/iu.test(value.digest) || !Array.isArray(value.sourceSummary) || value.sourceSummary.length > 20 || value.sourceSummary.some(item => typeof item !== 'string' || item.length > 500)) { throw new Error('invalid PR text preview'); } assertRequest(value.request, scope); if (value.request.state !== 'preview' || value.request.contextDigest !== value.digest) { throw new Error('preview digest mismatch'); } }
function field(parent: HTMLElement, labelText: string, control: HTMLElement): void { const label = document.createElement('label'); label.className = 'ai-session-pr-text__field'; label.append(document.createTextNode(labelText), control); parent.appendChild(label); }
function append(parent: HTMLElement, className: string, text: string): void { const element = document.createElement('p'); element.className = className; element.textContent = text; parent.appendChild(element); }
function button(label: string, focusKey: string): HTMLButtonElement { const element = document.createElement('button'); element.type = 'button'; element.className = 'ai-session-pr-text__button'; element.textContent = label; element.dataset.focusKey = focusKey; return element; }
function newId(): string { return crypto.randomUUID(); }
function utf8ByteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function readableSourceSummary(value: string): string { return value.replace(/\b[0-9a-f]{64}\b/giu, '검증됨'); }
