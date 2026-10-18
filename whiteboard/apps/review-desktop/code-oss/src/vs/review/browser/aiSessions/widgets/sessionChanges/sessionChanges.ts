import type {
	WorkspaceAgentChangeEvidenceDTO, WorkspaceAgentChangeEvidencePageDTO, WorkspaceAgentChangeFileDTO,
	WorkspaceAgentChangeHunksDTO, WorkspaceAgentExplanationCitationDTO, WorkspaceAgentExplanationDTO,
	WorkspaceAgentExplanationPageDTO, WorkspaceAgentExplanationTargetDTO, WorkspaceAgentReportedCheckDTO,
} from '../../../../../workspace/common/workspaceAgentChangesProtocol.js';
import './sessionChanges.css';

export interface SessionChangesKnowledgeReference extends WorkspaceAgentExplanationCitationDTO { readonly label: string; }
export interface SessionChangesContext { readonly projectId: string; readonly sessionId: string; readonly turnId: string; readonly knowledgeReferences: readonly SessionChangesKnowledgeReference[]; }
export interface SessionChangesActions {
	readonly latest: () => Promise<WorkspaceAgentChangeEvidenceDTO | null>;
	readonly list: (beforeVersion: number, limit: number) => Promise<WorkspaceAgentChangeEvidencePageDTO>;
	readonly file: (evidence: WorkspaceAgentChangeEvidenceDTO, path: string) => Promise<WorkspaceAgentChangeFileDTO | null>;
	readonly hunks: (evidence: WorkspaceAgentChangeEvidenceDTO, path: string) => Promise<WorkspaceAgentChangeHunksDTO | null>;
	readonly explanation: (target: WorkspaceAgentExplanationTargetDTO) => Promise<WorkspaceAgentExplanationDTO | null>;
	readonly explanationRevisions: (target: WorkspaceAgentExplanationTargetDTO, afterRevision: number, limit: number) => Promise<WorkspaceAgentExplanationPageDTO>;
	readonly saveExplanation: (target: WorkspaceAgentExplanationTargetDTO, expectedLatestRevision: number, what: string, why: string, citations: readonly WorkspaceAgentExplanationCitationDTO[], checkClaims: readonly WorkspaceAgentReportedCheckDTO[], status: 'draft' | 'confirmed') => Promise<WorkspaceAgentExplanationDTO>;
	readonly openDiff: (evidence: WorkspaceAgentChangeEvidenceDTO, path: string, before: string, after: string, isCurrent: () => boolean) => Promise<void>;
}
export interface SessionChangesController {
	setContext(context: SessionChangesContext, actions: SessionChangesActions): void;
	setVisible(visible: boolean): void;
	refresh(): void;
	dispose(): void;
}

const PAGE_SIZE = 50;

export function createSessionChanges(parent: HTMLElement, context: SessionChangesContext, actions: SessionChangesActions): SessionChangesController {
	parent.classList.add('ai-session-changes');
	let currentContext = context;
	let currentActions = actions;
	let snapshots: WorkspaceAgentChangeEvidenceDTO[] = [];
	let selected: WorkspaceAgentChangeEvidenceDTO | undefined;
	let beforeVersion = 0;
	let latestWindow = true;
	let hasMore = true;
	let visible = false;
	let loading = false;
	let errorText: string | undefined;
	let generation = 0;
	let fileGeneration = 0;
	let disposed = false;
	let selectedPath: string | undefined;
	let fileData: WorkspaceAgentChangeFileDTO | undefined;
	let hunkData: WorkspaceAgentChangeHunksDTO | undefined;
	let fileLoading = false;
	let fileError: string | undefined;
	let selectedHunkId: string | null = null;
	let explanation: WorkspaceAgentExplanationDTO | null = null;
	let explanationLoading = false;
	let explanationError: string | undefined;
	let explanationNotice: string | undefined;
	let reloadRevisionAvailable = false;
	let expectedRevision = 0;
	let what = '';
	let why = '';
	let citations: WorkspaceAgentExplanationCitationDTO[] = [];
	let dirty = false;
	const localDrafts = new Map<string, { readonly what: string; readonly why: string; readonly citations: readonly WorkspaceAgentExplanationCitationDTO[] }>();
	let activeDraftKey: string | undefined;
	let saving = false;
	let revisions: WorkspaceAgentExplanationDTO[] = [];
	let hasMoreRevisions = false;
	let latestRevisionWindow = true;
	let revisionLoading = false;

	const render = (): void => {
		const active = document.activeElement instanceof HTMLElement && parent.contains(document.activeElement) ? document.activeElement as HTMLElement & { selectionStart?: number | null; selectionEnd?: number | null } : undefined;
		const focusKey = active?.dataset.focusKey;
		const selectionStart = active?.selectionStart ?? undefined;
		const selectionEnd = active?.selectionEnd ?? undefined;
		parent.replaceChildren();
		const toolbar = document.createElement('div'); toolbar.className = 'ai-session-changes__toolbar';
		const refresh = button('새로고침'); refresh.dataset.focusKey = 'refresh'; refresh.disabled = loading || saving; refresh.addEventListener('click', () => void loadLatest());
		const older = button(loading ? '기록 불러오는 중…' : '이전 기록'); older.dataset.focusKey = 'older-evidence'; older.disabled = !hasMore || loading || saving; older.addEventListener('click', () => void loadOlder());
		toolbar.append(refresh, older); parent.appendChild(toolbar);
		const status = document.createElement('p'); status.className = 'ai-session-changes__status'; status.setAttribute('role', 'status');
		const firstVersion = snapshots.at(-1)?.version; const lastVersion = snapshots[0]?.version;
		const windowLabel = firstVersion === undefined ? '기록 없음' : `${latestWindow ? '최신 기록' : '기록'} · v${firstVersion}${firstVersion === lastVersion ? '' : `–v${lastVersion}`}`;
		status.textContent = loading ? '변경 기록을 불러오는 중입니다.' : `${windowLabel} · 선택한 실행 ${currentContext.turnId}`; parent.appendChild(status);
		if (errorText) { const error = document.createElement('p'); error.className = 'ai-session-changes__message'; error.setAttribute('role', 'alert'); error.textContent = errorText; parent.appendChild(error); }
		if (!selected) {
			const empty = document.createElement('p'); empty.className = 'ai-session-changes__empty'; empty.textContent = loading ? '기록을 확인하고 있습니다.' : errorText ? '다시 새로고침해 주세요.' : '확인 가능한 변경 기록이 없습니다. 파일이 바뀌지 않았다는 뜻은 아닙니다.'; parent.appendChild(empty); restoreFocus(); return;
		}
		const facts = document.createElement('p'); facts.className = 'ai-session-changes__facts';
		facts.textContent = `${selected.status === 'observed' ? '파일 상태 관찰됨' : '관찰 확인 불가'} · 범위 ${selected.coverage === 'complete' ? '전체' : '일부'} · 작성자 알 수 없음 · ${selected.source === 'managedWorktree' ? '관리 작업 트리' : '공유 폴더'} · ${formatTime(selected.capturedAt)}`; parent.appendChild(facts);
		const fingerprint = document.createElement('code'); fingerprint.className = 'ai-session-changes__fingerprint'; fingerprint.textContent = `v${selected.version} · ${selected.fingerprint}`; fingerprint.title = selected.fingerprint; parent.appendChild(fingerprint);
		if (selected.missingReason) { appendText(parent, 'ai-session-changes__note', `확인할 수 없는 이유: ${selected.missingReason}`); }
		if (selected.attribution === 'mixed' && selected.attributionNote) { appendText(parent, 'ai-session-changes__note', `작성자 확인: 알 수 없음. ${selected.attributionNote}`); }
		if (selected.noChangesConfirmed) { appendText(parent, 'ai-session-changes__note', '완전하게 관찰된 기록이며 바뀐 파일이 없습니다.'); }
		if (snapshots.length > 1) {
			const versionList = document.createElement('ol'); versionList.className = 'ai-session-changes__versions'; versionList.setAttribute('aria-label', '변경 기록 버전');
			for (const evidence of snapshots) { const item = document.createElement('li'); const select = button(`v${evidence.version} · ${formatTime(evidence.capturedAt)}`); select.dataset.focusKey = `version:${evidence.version}`; select.disabled = saving; select.setAttribute('aria-pressed', String(evidence === selected)); select.addEventListener('click', () => { if (saving) { return; } selected = evidence; clearFileSelection(); render(); }); item.appendChild(select); versionList.appendChild(item); }
			parent.appendChild(versionList);
		}
		const fileList = document.createElement('ul'); fileList.className = 'ai-session-changes__files'; fileList.setAttribute('aria-label', '변경 파일');
		for (const file of selected.files) {
			const item = document.createElement('li'); item.className = 'ai-session-changes__file';
			const info = document.createElement('div'); info.className = 'ai-session-changes__file-info';
			const path = document.createElement('code'); path.textContent = file.path;
			const detail = document.createElement('span'); detail.textContent = `${changeLabel(file.change)}${file.previousPath ? ` · 이전 경로 ${file.previousPath}` : ''}`; info.append(path, detail);
			const controls = document.createElement('div'); controls.className = 'ai-session-changes__file-controls';
			const choose = button(selectedPath === file.path ? '선택됨' : file.change === 'renamed' ? '경로 변경 · 설명 불가' : '파일 설명'); choose.dataset.focusKey = `file:${file.path}`; choose.setAttribute('aria-pressed', String(selectedPath === file.path)); choose.disabled = saving || selected.status !== 'observed' || file.change === 'renamed'; choose.addEventListener('click', () => void selectFile(selected!, file.path));
			controls.appendChild(choose);
			if (selectedPath === file.path && fileData) {
				const compare = button('비교 열기'); compare.dataset.focusKey = `compare:${file.path}`; compare.disabled = !diffText(fileData); compare.addEventListener('click', () => void openDiff(selected!, file.path)); controls.appendChild(compare);
			}
			item.append(info, controls); fileList.appendChild(item);
		}
		parent.appendChild(fileList);
		if (!selected.files.length && !selected.noChangesConfirmed) { appendText(parent, 'ai-session-changes__note', '바뀐 파일 목록을 확인할 수 없습니다.'); }
		if (selectedPath) { renderSelectedFile(parent); }
		restoreFocus();

		function restoreFocus(): void {
			if (!focusKey) { return; }
			const target = [...parent.querySelectorAll<HTMLElement>('[data-focus-key]')].find(element => element.dataset.focusKey === focusKey);
			if (!target || ('disabled' in target && (target as HTMLButtonElement).disabled)) { return; }
			target.focus({ preventScroll: true });
			if (target instanceof HTMLTextAreaElement && selectionStart !== undefined && selectionEnd !== undefined) { target.setSelectionRange(selectionStart, selectionEnd); }
		}
	};

	const renderSelectedFile = (parentNode: HTMLElement): void => {
		const fileSection = document.createElement('section'); fileSection.className = 'ai-session-changes__detail';
		const heading = document.createElement('h3'); heading.textContent = `파일 설명 · ${selectedPath}`; fileSection.appendChild(heading);
		if (fileLoading) { appendText(fileSection, 'ai-session-changes__status', '보관된 파일과 변경 구간을 불러오는 중입니다.'); parentNode.appendChild(fileSection); return; }
		if (fileError) { appendText(fileSection, 'ai-session-changes__message', fileError); parentNode.appendChild(fileSection); return; }
		if (!fileData || !hunkData) { appendText(fileSection, 'ai-session-changes__empty', '보관된 파일 내용을 확인할 수 없습니다.'); parentNode.appendChild(fileSection); return; }
		appendText(fileSection, 'ai-session-changes__facts', hunkStatusLabel(hunkData));
		if (hunkData.unavailableReason) { appendText(fileSection, 'ai-session-changes__note', `비교 구간을 계산할 수 없습니다: ${hunkData.unavailableReason}`); }
		if (hunkData.timedOut) {
			appendText(fileSection, 'ai-session-changes__message', '비교 구간 계산 시간이 초과되었습니다. 다시 계산할 수 있습니다. 시간 초과 결과에는 설명을 연결할 수 없습니다.');
			const retry = button('다시 계산'); retry.dataset.focusKey = `file:${selectedPath}`; retry.addEventListener('click', () => { if (selected && selectedPath) { void selectFile(selected, selectedPath, true); } }); fileSection.appendChild(retry);
		} else {
			const hunkLabel = document.createElement('label'); hunkLabel.className = 'ai-session-changes__field'; hunkLabel.append(document.createTextNode('설명 범위'));
			const selector = document.createElement('select'); selector.dataset.focusKey = 'hunk-select'; selector.setAttribute('aria-label', '설명을 연결할 변경 구간');
			const fileOption = document.createElement('option'); fileOption.value = ''; fileOption.textContent = '파일 전체'; selector.appendChild(fileOption);
			for (const hunk of hunkData.hunks) {
				const option = document.createElement('option'); option.value = hunk.id;
				option.textContent = `변경 구간 ${hunk.originalStartLineNumber}–${Math.max(hunk.originalStartLineNumber, hunk.originalEndLineNumberExclusive - 1)}행 → ${hunk.modifiedStartLineNumber}–${Math.max(hunk.modifiedStartLineNumber, hunk.modifiedEndLineNumberExclusive - 1)}행`;
				selector.appendChild(option);
			}
			selector.value = selectedHunkId ?? '';
			selector.disabled = saving || hunkData.status === 'unavailable' || hunkData.timedOut;
			selector.addEventListener('change', () => {
				const nextHunkId = selector.value || null;
				if (saving) { selector.value = selectedHunkId ?? ''; return; }
				if (selected && selectedPath && !activateDraft(targetFor(selected, selectedPath, nextHunkId))) { selector.value = selectedHunkId ?? ''; return; }
				selectedHunkId = nextHunkId; explanationError = undefined; void loadExplanationTarget();
			});
			hunkLabel.appendChild(selector); fileSection.appendChild(hunkLabel);
			if (hunkData.truncated) { appendText(fileSection, 'ai-session-changes__note', '변경 구간이 많아 앞의 300개만 표시합니다.'); }
		}
		if (explanationLoading) { appendText(fileSection, 'ai-session-changes__status', '설명을 불러오는 중입니다.'); }
		const editor = document.createElement('div'); editor.className = 'ai-session-changes__editor';
		const whatInput = textArea('무엇이 바뀌었나요?', 'what', what); whatInput.maxLength = 4096; whatInput.disabled = saving; whatInput.addEventListener('input', () => { what = whatInput.value; dirty = true; });
		const whyInput = textArea('왜 바뀌었나요?', 'why', why); whyInput.maxLength = 8192; whyInput.disabled = saving; whyInput.addEventListener('input', () => { why = whyInput.value; dirty = true; });
		field(editor, '변경 내용', whatInput); field(editor, '변경 이유', whyInput);
		if (currentContext.knowledgeReferences.length) {
			const citationsTitle = document.createElement('p'); citationsTitle.className = 'ai-session-changes__field-title'; citationsTitle.textContent = '실행 시점에 고정된 참고 자료'; editor.appendChild(citationsTitle);
			for (const reference of currentContext.knowledgeReferences) {
				const label = document.createElement('label'); label.className = 'ai-session-changes__citation';
				const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = citations.some(item => sameCitation(item, reference)); checkbox.disabled = saving; checkbox.dataset.focusKey = `citation:${reference.kind}:${reference.id}`;
				checkbox.addEventListener('change', () => { citations = checkbox.checked ? [...citations, citationOnly(reference)] : citations.filter(item => !sameCitation(item, reference)); dirty = true; });
				const text = document.createElement('span'); text.textContent = `${reference.kind === 'convention' ? '규칙' : '참고'} · ${reference.label} · v${reference.version} · ${reference.sha256.slice(0, 12)}`; label.append(checkbox, text); editor.appendChild(label);
			}
		} else { appendText(editor, 'ai-session-changes__note', '이 실행에 고정된 참고 자료가 없습니다.'); }
		appendText(editor, 'ai-session-changes__note', '실행 결과 검증: 미검증. 설명 확인은 코드 변경, 병합, PR 승인을 뜻하지 않습니다.');
		const saveControls = document.createElement('div'); saveControls.className = 'ai-session-changes__toolbar';
		const saveDraft = button(saving ? '저장 중…' : '초안 저장'); saveDraft.dataset.focusKey = 'save-draft'; saveDraft.disabled = explanationLoading || fileLoading || revisionLoading || !fileData || !what.trim() || !why.trim() || hunkData?.timedOut === true; saveDraft.addEventListener('click', () => void save('draft'));
		const confirm = button(saving ? '저장 중…' : '설명만 확인'); confirm.dataset.focusKey = 'save-confirmed'; confirm.disabled = saveDraft.disabled; confirm.addEventListener('click', () => void save('confirmed'));
		saveControls.append(saveDraft, confirm); editor.appendChild(saveControls);
		if (explanationError) { appendText(editor, 'ai-session-changes__message', explanationError); }
		if (explanationNotice) { appendText(editor, 'ai-session-changes__status', explanationNotice); }
		if (reloadRevisionAvailable) { const reload = button('최신 설명 다시 확인'); reload.dataset.focusKey = 'reload-revision'; reload.disabled = explanationLoading || saving; reload.addEventListener('click', () => void reloadRevisionCursor()); editor.appendChild(reload); }
		fileSection.appendChild(editor);
		renderLatestExplanation(fileSection);
		renderRevisionHistory(fileSection);
		parentNode.appendChild(fileSection);
	};

	const renderLatestExplanation = (parentNode: HTMLElement): void => {
		if (!explanation) { appendText(parentNode, 'ai-session-changes__empty', '저장된 설명이 없습니다. 무엇이 바뀌었는지 초안을 작성할 수 있습니다.'); return; }
		const actorLabel = explanation.actor === 'human' ? '사람 작성' : '에이전트 작성';
		appendText(parentNode, 'ai-session-changes__facts', `${actorLabel} · ${explanation.status === 'confirmed' ? '설명만 확인됨' : '초안'} · ${explanation.verification === 'unverified' ? '실행 결과 미검증' : '검증 상태 확인 불가'} · 설명 버전 ${explanation.revision}`);
		appendText(parentNode, 'ai-session-changes__note', `무엇: ${explanation.what}`);
		appendText(parentNode, 'ai-session-changes__note', `이유: ${explanation.why}`);
		for (const claim of explanation.checkClaims) { appendText(parentNode, 'ai-session-changes__note', reportedCheckLabel(claim)); }
		for (const citation of explanation.citations) { appendText(parentNode, 'ai-session-changes__note', `고정 참고 ${citation.kind === 'convention' ? '규칙' : '자료'} · ${citation.id} · v${citation.version} · ${citation.sha256.slice(0, 12)}`); }
	};

	const renderRevisionHistory = (parentNode: HTMLElement): void => {
		const heading = document.createElement('h4'); heading.textContent = revisions.length ? `설명 기록 ${revisions[0].revision}–${revisions.at(-1)!.revision}` : '설명 기록'; parentNode.appendChild(heading);
		if (!latestRevisionWindow) { const latest = button('최근 설명 보기'); latest.dataset.focusKey = 'latest-revisions'; latest.disabled = revisionLoading || saving; latest.addEventListener('click', () => void loadLatestRevisionWindow()); parentNode.appendChild(latest); }
		if (!revisions.length && !revisionLoading) { appendText(parentNode, 'ai-session-changes__empty', '이전 설명 기록이 없습니다.'); }
		const list = document.createElement('ol'); list.className = 'ai-session-changes__revision-list';
		for (const revision of revisions) {
			const item = document.createElement('li'); item.className = 'ai-session-changes__revision';
			const title = document.createElement('p'); title.textContent = `설명 버전 ${revision.revision} · ${revision.actor === 'human' ? '사람' : '에이전트'} · ${revision.status === 'confirmed' ? '설명만 확인' : '초안'} · ${formatTime(revision.createdAt)} · 실행 결과 미검증`;
			const body = document.createElement('p'); body.textContent = `${revision.what} / 이유: ${revision.why}`;
			item.append(title, body);
			for (const claim of revision.checkClaims) { const check = document.createElement('p'); check.textContent = reportedCheckLabel(claim); item.appendChild(check); }
			for (const citation of revision.citations) { const reference = document.createElement('p'); reference.textContent = `고정 참고 ${citation.kind === 'convention' ? '규칙' : '자료'} · ${citation.id} · v${citation.version} · ${citation.sha256.slice(0, 12)}`; item.appendChild(reference); }
			list.appendChild(item);
		}
		parentNode.appendChild(list);
		if (revisionLoading) { appendText(parentNode, 'ai-session-changes__status', '이전 설명을 불러오는 중입니다.'); }
		if (hasMoreRevisions) { const more = button(revisionLoading ? '불러오는 중…' : '이전 설명 더 보기'); more.dataset.focusKey = 'more-revisions'; more.disabled = revisionLoading || saving; more.addEventListener('click', () => void loadMoreRevisions()); parentNode.appendChild(more); }
	};

	const loadLatest = async (): Promise<void> => {
		if (disposed || loading || saving) { return; }
		loading = true; errorText = undefined; const request = ++generation; const requested = currentContext; const source = currentActions; render();
		try {
			const latest = await source.latest();
			if (!isCurrent(request, requested)) { return; }
			if (latest && (latest.projectId !== requested.projectId || latest.sessionId !== requested.sessionId || latest.turnId !== requested.turnId)) { throw new Error('다른 실행의 기록을 받았습니다.'); }
			snapshots = latest ? [latest] : []; selected = latest ?? undefined; beforeVersion = latest?.version ?? 0; hasMore = (latest?.version ?? 0) > 1; latestWindow = true; clearFileSelection();
		} catch (error) { if (isCurrent(request, requested)) { errorText = describe(error); } }
		finally { if (isCurrent(request, requested)) { loading = false; render(); } }
	};

	const loadOlder = async (): Promise<void> => {
		if (disposed || loading || saving || !hasMore) { return; }
		loading = true; errorText = undefined; const request = ++generation; const requested = currentContext; const source = currentActions; render();
		try {
			const page = await source.list(beforeVersion, PAGE_SIZE);
			if (!isCurrent(request, requested)) { return; }
			assertEvidencePage(page, requested, beforeVersion);
			snapshots = [...page.snapshots]; selected = snapshots[0]; beforeVersion = page.nextVersion; hasMore = page.hasMore; latestWindow = false; clearFileSelection();
		} catch (error) { if (isCurrent(request, requested)) { errorText = describe(error); } }
		finally { if (isCurrent(request, requested)) { loading = false; render(); } }
	};

	const selectFile = async (evidence: WorkspaceAgentChangeEvidenceDTO, path: string, retry = false): Promise<void> => {
		if (disposed || fileLoading || saving || (selectedPath === path && !retry)) { return; }
		if (!activateDraft(targetFor(evidence, path, null))) { explanationError = '작성 중인 설명을 보존할 수 없습니다. 현재 항목에서 먼저 초안으로 저장해 주세요.'; render(); return; }
		selectedPath = path; fileData = undefined; hunkData = undefined; fileError = undefined; selectedHunkId = null; explanation = null; explanationNotice = undefined; revisions = []; hasMoreRevisions = false; latestRevisionWindow = true; revisionLoading = false; explanationLoading = true; fileLoading = true;
		const request = ++fileGeneration; const requested = currentContext; const source = currentActions; render();
		try {
			const [file, hunks] = await Promise.all([source.file(evidence, path), source.hunks(evidence, path)]);
			if (!isFileCurrent(request, requested, evidence, path)) { return; }
			if (!file || !hunks) { throw new Error('보관된 파일 내용 또는 비교 구간을 확인할 수 없습니다.'); }
			if (file.scope.projectId !== requested.projectId || file.scope.sessionId !== requested.sessionId || file.scope.turnId !== requested.turnId
				|| file.path !== path || file.evidenceVersion !== evidence.version || file.evidenceFingerprint !== evidence.fingerprint
				|| hunks.scope.projectId !== requested.projectId || hunks.scope.sessionId !== requested.sessionId || hunks.scope.turnId !== requested.turnId
				|| hunks.path !== path || hunks.evidenceVersion !== evidence.version || hunks.evidenceFingerprint !== evidence.fingerprint) { throw new Error('선택한 기록의 보관 파일과 변경 구간이 일치하지 않습니다.'); }
			fileData = file; hunkData = hunks;
		} catch (error) { if (isFileCurrent(request, requested, evidence, path)) { fileError = describe(error); } }
		finally {
			if (isFileCurrent(request, requested, evidence, path)) { fileLoading = false; explanationLoading = false; await loadExplanationTarget(); render(); }
		}
	};

	const loadExplanationTarget = async (): Promise<void> => {
		if (!selected || !selectedPath || !fileData || !hunkData || (hunkData.timedOut && selectedHunkId !== null)) { return; }
		const target = targetFor(selected, selectedPath, selectedHunkId);
		if (!activateDraft(target)) { explanationError = '작성 중인 설명을 보존할 수 없습니다. 현재 항목에서 먼저 초안으로 저장해 주세요.'; render(); return; }
		const request = ++fileGeneration; const requested = currentContext; const evidence = selected; const path = selectedPath; const source = currentActions;
		explanationLoading = true; revisionLoading = false; explanationError = undefined; explanationNotice = undefined; reloadRevisionAvailable = false; explanation = null; revisions = []; hasMoreRevisions = false; latestRevisionWindow = true; expectedRevision = 0;
		render();
		try {
			const latest = await source.explanation(target);
			if (!isFileCurrent(request, requested, evidence, path) || selectedHunkId !== target.hunkId) { return; }
			assertExplanation(latest, target);
			const page = await source.explanationRevisions(target, Math.max(0, (latest?.revision ?? 0) - PAGE_SIZE), PAGE_SIZE);
			if (!isFileCurrent(request, requested, evidence, path) || selectedHunkId !== target.hunkId) { return; }
			assertExplanation(latest, target); assertExplanationPage(page, target);
			explanation = latest; expectedRevision = latest?.revision ?? 0; revisions = [...page.revisions]; hasMoreRevisions = (revisions[0]?.revision ?? 1) > 1; latestRevisionWindow = true;
			if (!dirty && latest) { what = latest.what; why = latest.why; citations = latest.citations.map(citationOnly); }
		} catch (error) { if (isFileCurrent(request, requested, evidence, path) && selectedHunkId === target.hunkId) { explanationError = describe(error); } }
		finally { if (isFileCurrent(request, requested, evidence, path) && selectedHunkId === target.hunkId) { explanationLoading = false; render(); } }
	};

	const reloadRevisionCursor = async (): Promise<void> => {
		if (!selected || !selectedPath) { return; }
		const target = targetFor(selected, selectedPath, selectedHunkId); const request = fileGeneration; const source = currentActions; const requested = currentContext; const evidence = selected; const path = selectedPath; const hunkId = target.hunkId;
		const isCurrentRequest = (): boolean => isFileCurrent(request, requested, evidence, path) && selectedHunkId === hunkId;
		explanationLoading = true; render();
		try {
			const latest = await source.explanation(target);
			if (!isCurrentRequest()) { return; }
			assertExplanation(latest, target);
			const page = await source.explanationRevisions(target, Math.max(0, (latest?.revision ?? 0) - PAGE_SIZE), PAGE_SIZE);
			if (!isCurrentRequest()) { return; }
			assertExplanationPage(page, target); expectedRevision = latest?.revision ?? 0; explanation = latest; revisions = [...page.revisions]; hasMoreRevisions = (revisions[0]?.revision ?? 1) > 1; latestRevisionWindow = true; reloadRevisionAvailable = false; explanationError = undefined; explanationNotice = dirty ? '최신 설명을 확인했습니다. 작성 중인 내용은 보존했습니다.' : '최신 설명을 불러왔습니다.';
			if (!dirty && latest) { what = latest.what; why = latest.why; citations = latest.citations.map(citationOnly); }
		}
		catch (error) { if (isCurrentRequest()) { explanationError = describe(error); } }
		finally { if (isCurrentRequest()) { explanationLoading = false; render(); } }
	};

	const loadLatestRevisionWindow = async (): Promise<void> => {
		if (!selected || !selectedPath || revisionLoading || saving) { return; }
		const target = targetFor(selected, selectedPath, selectedHunkId); const request = fileGeneration; const source = currentActions; const requested = currentContext; const evidence = selected; const path = selectedPath; const hunkId = target.hunkId;
		const isCurrentRequest = (): boolean => isFileCurrent(request, requested, evidence, path) && selectedHunkId === hunkId;
		revisionLoading = true; render();
		try {
			const latest = await source.explanation(target);
			if (!isCurrentRequest()) { return; }
			assertExplanation(latest, target);
			const page = await source.explanationRevisions(target, Math.max(0, (latest?.revision ?? 0) - PAGE_SIZE), PAGE_SIZE);
			if (!isCurrentRequest()) { return; }
			assertExplanationPage(page, target); explanation = latest; expectedRevision = latest?.revision ?? 0; revisions = [...page.revisions]; hasMoreRevisions = (revisions[0]?.revision ?? 1) > 1; latestRevisionWindow = true; reloadRevisionAvailable = false; explanationError = undefined; explanationNotice = dirty ? '최신 설명을 확인했습니다. 작성 중인 내용은 보존했습니다.' : '최신 설명을 불러왔습니다.';
			if (!dirty && latest) { what = latest.what; why = latest.why; citations = latest.citations.map(citationOnly); }
		} catch (error) { if (isCurrentRequest()) { explanationError = describe(error); } }
		finally { if (isCurrentRequest()) { revisionLoading = false; render(); } }
	};

	const save = async (status: 'draft' | 'confirmed'): Promise<void> => {
		if (!selected || !selectedPath || !fileData || !hunkData || saving || !what.trim() || !why.trim()) { return; }
		const target = targetFor(selected, selectedPath, selectedHunkId); const request = fileGeneration; const requested = currentContext; const evidence = selected; const path = selectedPath; const source = currentActions;
		saving = true; reloadRevisionAvailable = false; explanationError = undefined; explanationNotice = undefined; render();
		try {
			const saved = await source.saveExplanation(target, expectedRevision, what, why, citations, [], status);
			if (!isFileCurrent(request, requested, evidence, path) || selectedHunkId !== target.hunkId) { return; }
			assertExplanation(saved, target); if (saved.actor !== 'human' || saved.authorTurnId !== null || saved.verification !== 'unverified') { throw new Error('저장 응답의 작성자 또는 검증 상태가 올바르지 않습니다.'); }
			explanation = saved; expectedRevision = saved.revision; dirty = false; localDrafts.delete(targetKey(target)); explanationNotice = status === 'confirmed' ? '설명만 확인했습니다. 실행 결과는 검증되지 않았습니다.' : '초안을 저장했습니다. 실행 결과는 검증되지 않았습니다.';
			try {
				const latest = await source.explanation(target);
				if (!isFileCurrent(request, requested, evidence, path) || selectedHunkId !== target.hunkId) { return; }
				assertExplanation(latest, target);
				const newerRevisionExists = latest !== null && latest.revision !== saved.revision;
				const page = await source.explanationRevisions(target, Math.max(0, saved.revision - PAGE_SIZE), PAGE_SIZE);
				if (isFileCurrent(request, requested, evidence, path) && selectedHunkId === target.hunkId) {
					assertExplanationPage(page, target);
					revisions = [...page.revisions]; hasMoreRevisions = (revisions[0]?.revision ?? 1) > 1; latestRevisionWindow = !newerRevisionExists;
					if (newerRevisionExists) { reloadRevisionAvailable = true; explanationError = '저장 후 새 설명이 추가되었습니다. 최신 설명 다시 확인을 눌러 내용을 확인하세요.'; }
				}
			} catch (error) {
				if (isFileCurrent(request, requested, evidence, path) && selectedHunkId === target.hunkId) { explanationError = `설명은 저장했지만 변경 이력을 갱신하지 못했습니다: ${describe(error)}`; }
			}
		} catch (error) { if (isFileCurrent(request, requested, evidence, path)) { const message = describe(error); reloadRevisionAvailable = message.toLowerCase().includes('stale'); explanationNotice = undefined; explanationError = `${message} 입력한 내용은 보존했습니다.`; } }
		finally { if (isFileCurrent(request, requested, evidence, path)) { saving = false; render(); } }
	};

	const loadMoreRevisions = async (): Promise<void> => {
		if (!selected || !selectedPath || revisionLoading || saving || !hasMoreRevisions) { return; }
		const target = targetFor(selected, selectedPath, selectedHunkId); const request = fileGeneration; const requested = currentContext; const evidence = selected; const path = selectedPath; const hunkId = target.hunkId; const source = currentActions;
		const isCurrentRequest = (): boolean => isFileCurrent(request, requested, evidence, path) && selectedHunkId === hunkId;
		revisionLoading = true; render();
		const oldestRevision = revisions[0]?.revision ?? 1;
		const olderLimit = Math.min(PAGE_SIZE, oldestRevision - 1);
		try { const page = await source.explanationRevisions(target, Math.max(0, oldestRevision - PAGE_SIZE - 1), olderLimit); if (!isCurrentRequest()) { return; } assertExplanationPage(page, target); revisions = [...page.revisions]; hasMoreRevisions = (revisions[0]?.revision ?? 1) > 1; latestRevisionWindow = false; }
		catch (error) { if (isCurrentRequest()) { explanationError = describe(error); } }
		finally { if (isCurrentRequest()) { revisionLoading = false; render(); } }
	};

	const openDiff = async (evidence: WorkspaceAgentChangeEvidenceDTO, path: string): Promise<void> => {
		if (!fileData) { return; }
		const texts = diffText(fileData); if (!texts) { fileError = '보관된 텍스트가 없어 비교를 열 수 없습니다.'; render(); return; }
		const request = fileGeneration; const requested = currentContext; const source = currentActions;
		try { await source.openDiff(evidence, path, texts.before, texts.after, () => isFileCurrent(request, requested, evidence, path)); }
		catch (error) { if (isFileCurrent(request, requested, evidence, path)) { fileError = describe(error); render(); } }
	};

	function isCurrent(request: number, requested: SessionChangesContext): boolean { return !disposed && request === generation && requested === currentContext; }
	function isFileCurrent(request: number, requested: SessionChangesContext, evidence: WorkspaceAgentChangeEvidenceDTO, path: string): boolean { return !disposed && request === fileGeneration && requested === currentContext && evidence === selected && path === selectedPath; }
	function rememberDraft(): void { if (activeDraftKey && dirty) { localDrafts.set(activeDraftKey, { what, why, citations: citations.map(citationOnly) }); } }
	function activateDraft(target: WorkspaceAgentExplanationTargetDTO): boolean {
		const key = targetKey(target);
		if (activeDraftKey === key) { return true; }
		rememberDraft();
		activeDraftKey = key;
		const draft = localDrafts.get(key);
		what = draft?.what ?? ''; why = draft?.why ?? ''; citations = draft?.citations.map(citationOnly) ?? []; dirty = !!draft;
		return true;
	}
	function clearFileSelection(): void { rememberDraft(); activeDraftKey = undefined; fileGeneration++; selectedPath = undefined; fileData = undefined; hunkData = undefined; fileLoading = false; fileError = undefined; selectedHunkId = null; explanation = null; explanationLoading = false; explanationError = undefined; explanationNotice = undefined; reloadRevisionAvailable = false; expectedRevision = 0; what = ''; why = ''; citations = []; dirty = false; revisions = []; hasMoreRevisions = false; latestRevisionWindow = true; saving = false; }

	return {
		setContext(next, nextActions) { if (next.projectId === currentContext.projectId && next.sessionId === currentContext.sessionId && next.turnId === currentContext.turnId) { currentActions = nextActions; currentContext = next; return; } currentContext = next; currentActions = nextActions; generation++; loading = false; snapshots = []; selected = undefined; beforeVersion = 0; hasMore = true; latestWindow = true; errorText = undefined; clearFileSelection(); if (visible) { void loadLatest(); } else { render(); } },
		setVisible(next) { visible = next; if (next && !snapshots.length && !loading) { void loadLatest(); } },
		refresh() { void loadLatest(); },
		dispose() { disposed = true; generation++; fileGeneration++; parent.replaceChildren(); },
	};

}

function button(label: string): HTMLButtonElement { const element = document.createElement('button'); element.type = 'button'; element.className = 'ai-session-changes__button'; element.textContent = label; return element; }
function textArea(placeholder: string, focusKey: string, value: string): HTMLTextAreaElement { const element = document.createElement('textarea'); element.placeholder = placeholder; element.dataset.focusKey = focusKey; element.value = value; return element; }
function field(parent: HTMLElement, labelText: string, control: HTMLElement): void { const label = document.createElement('label'); label.className = 'ai-session-changes__field'; label.append(document.createTextNode(labelText), control); parent.appendChild(label); }
function appendText(parent: HTMLElement, className: string, value: string): void { const element = document.createElement('p'); element.className = className; element.textContent = value; parent.appendChild(element); }
function changeLabel(change: WorkspaceAgentChangeEvidenceDTO['files'][number]['change']): string { return ({ created: '추가됨', modified: '수정됨', deleted: '삭제됨', renamed: '이름 변경', typeChanged: '종류 변경', symlinkChanged: '링크 변경' })[change]; }
function formatTime(value: string): string { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleString('ko-KR') : '시간 확인 불가'; }
function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sideText(side: WorkspaceAgentChangeFileDTO['before']): string | undefined { return side.state === 'absent' ? '' : side.state === 'text' ? side.file.content : undefined; }
function diffText(file: WorkspaceAgentChangeFileDTO): { readonly before: string; readonly after: string } | undefined { const before = sideText(file.before); const after = sideText(file.after); return before === undefined || after === undefined ? undefined : { before, after }; }
function targetFor(evidence: WorkspaceAgentChangeEvidenceDTO, path: string, hunkId: string | null): WorkspaceAgentExplanationTargetDTO { return { projectId: evidence.projectId, sessionId: evidence.sessionId, turnId: evidence.turnId, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path, hunkId }; }
function targetKey(target: WorkspaceAgentExplanationTargetDTO): string { return JSON.stringify([target.projectId, target.sessionId, target.turnId, target.evidenceVersion, target.evidenceFingerprint, target.path, target.hunkId]); }
function hunkStatusLabel(result: WorkspaceAgentChangeHunksDTO): string { return ({ hunks: '보관된 내용에서 변경 구간을 계산했습니다.', noTextChange: '텍스트 내용에 차이가 없습니다.', eolOnly: '줄바꿈 형식만 다릅니다.', presenceChanged: '파일 생성 또는 삭제가 관찰되었습니다.', unavailable: '변경 구간을 확인할 수 없습니다.', partial: '일부 변경 구간을 계산했습니다.' })[result.status]; }
function reportedCheckLabel(check: WorkspaceAgentReportedCheckDTO): string { const outcome = check.outcome === 'reportedPass' ? '통과 보고' : check.outcome === 'reportedFail' ? '실패 보고' : '실행 안 함'; return `실행 결과 미검증 · 기록된 주장: ${check.label} · ${outcome}${check.detail ? ` · ${check.detail}` : ''}`; }
function citationOnly(reference: WorkspaceAgentExplanationCitationDTO): WorkspaceAgentExplanationCitationDTO { return { kind: reference.kind, id: reference.id, version: reference.version, sha256: reference.sha256 }; }
function sameCitation(left: WorkspaceAgentExplanationCitationDTO, right: WorkspaceAgentExplanationCitationDTO): boolean { return left.kind === right.kind && left.id === right.id && left.version === right.version && left.sha256 === right.sha256; }
function assertEvidencePage(page: WorkspaceAgentChangeEvidencePageDTO, context: SessionChangesContext, beforeVersion: number): void { if (!page || !Array.isArray(page.snapshots) || page.snapshots.some((item, index) => item.projectId !== context.projectId || item.sessionId !== context.sessionId || item.turnId !== context.turnId || item.version >= beforeVersion || (index > 0 && item.version >= page.snapshots[index - 1].version)) || (page.snapshots.length > 0 && page.nextVersion !== page.snapshots.at(-1)?.version)) { throw new Error('다른 실행의 변경 기록을 받았습니다.'); } }
function assertExplanation(value: WorkspaceAgentExplanationDTO | null, target: WorkspaceAgentExplanationTargetDTO): void { if (value && !sameTarget(value.target, target)) { throw new Error('다른 파일 또는 변경 구간의 설명을 받았습니다.'); } }
function assertExplanationPage(page: WorkspaceAgentExplanationPageDTO, target: WorkspaceAgentExplanationTargetDTO): void { if (!page || !Array.isArray(page.revisions) || page.revisions.some((item, index) => !sameTarget(item.target, target) || (index > 0 && item.revision <= page.revisions[index - 1].revision)) || (page.revisions.length > 0 && page.nextRevision !== page.revisions.at(-1)?.revision)) { throw new Error('다른 파일 또는 변경 구간의 설명 기록을 받았습니다.'); } }
function sameTarget(left: WorkspaceAgentExplanationTargetDTO, right: WorkspaceAgentExplanationTargetDTO): boolean { return left.projectId === right.projectId && left.sessionId === right.sessionId && left.turnId === right.turnId && left.evidenceVersion === right.evidenceVersion && left.evidenceFingerprint === right.evidenceFingerprint && left.path === right.path && left.hunkId === right.hunkId; }
