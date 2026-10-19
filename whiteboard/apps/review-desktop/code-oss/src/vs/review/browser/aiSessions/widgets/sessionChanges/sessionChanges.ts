import type {
	WorkspaceAgentChangeEvidenceDTO, WorkspaceAgentChangeEvidencePageDTO, WorkspaceAgentChangeFileDTO,
	WorkspaceAgentChangeHunksDTO, WorkspaceAgentExplanationCitationDTO, WorkspaceAgentExplanationDTO,
	WorkspaceAgentExplanationPageDTO, WorkspaceAgentExplanationTargetDTO, WorkspaceAgentReportedCheckDTO,
} from '../../../../../workspace/common/workspaceAgentChangesProtocol.js';
import type {
	AgentSessionIntegrationProposalDTO, WorkspaceAgentCommitPrepareInput, WorkspaceAgentCommitProposalInput,
	WorkspaceAgentCommitRecoveryInput,
} from '../../../../../workspace/common/workspaceAgentIntegrationProtocol.js';
import type {
	AgentSessionMergeProposalDTO, WorkspaceAgentMergeProposalMutationInput,
	WorkspaceAgentMergePrepareInput, WorkspaceAgentMergeProposalPageDTO, WorkspaceAgentMergeProposalRecoveryInput,
} from '../../../../../workspace/common/workspaceAgentMergeProtocol.js';
import { AGENT_SESSION_MERGE_PROPOSAL_PAGE_LIMIT as MERGE_PAGE_SIZE } from '../../../../../workspace/common/workspaceAgentMergeProtocol.js';
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
	readonly listCommitProposals: (afterRevision: number, limit: number) => Promise<{ readonly proposals: readonly AgentSessionIntegrationProposalDTO[]; readonly nextRevision: number; readonly hasMore: boolean }>;
	readonly prepareCommitProposal: (input: WorkspaceAgentCommitPrepareInput) => Promise<AgentSessionIntegrationProposalDTO>;
	readonly approveCommitProposal: (input: WorkspaceAgentCommitProposalInput) => Promise<{ readonly approved: boolean; readonly proposal: AgentSessionIntegrationProposalDTO }>;
	readonly applyCommitProposal: (input: WorkspaceAgentCommitProposalInput) => Promise<AgentSessionIntegrationProposalDTO>;
	readonly recoverCommitProposal: (input: WorkspaceAgentCommitRecoveryInput) => Promise<AgentSessionIntegrationProposalDTO>;
	readonly listMergeProposals: (afterRevision: number, limit: number) => Promise<WorkspaceAgentMergeProposalPageDTO>;
	readonly prepareMergeProposal: (input: WorkspaceAgentMergePrepareInput) => Promise<AgentSessionMergeProposalDTO>;
	readonly approveMergeProposal: (input: WorkspaceAgentMergeProposalMutationInput) => Promise<{ readonly approved: boolean; readonly proposal: AgentSessionMergeProposalDTO }>;
	readonly applyMergeProposal: (input: WorkspaceAgentMergeProposalMutationInput) => Promise<AgentSessionMergeProposalDTO>;
	readonly reconcileMergeProposal: (input: WorkspaceAgentMergeProposalRecoveryInput) => Promise<AgentSessionMergeProposalDTO>;
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
	let selectedCommitPaths = new Set<string>();
	let commitExplanations = new Map<string, { readonly revisions: readonly WorkspaceAgentExplanationDTO[]; readonly selectedRevision?: number; readonly loading: boolean; readonly error?: string }>();
	let commitMessage = '';
	let commitBusy = false;
	let commitError: string | undefined;
	let commitNotice: string | undefined;
	let commitGeneration = 0;
	let proposalWindow: AgentSessionIntegrationProposalDTO[] = [];
	let selectedProposalId: string | undefined;
	let proposalAfterRevision = 0;
	let proposalHasMore = false;
	let proposalLoading = false;
	let proposalInitialized = false;
	let proposalError: string | undefined;
	let proposalDetails = new Map<string, WorkspaceAgentExplanationDTO | null>();
	let proposalDetailsLoading = false;
	let proposalDetailsError: string | undefined;
	let proposalDetailsGeneration = 0;
	let mergeWindow: AgentSessionMergeProposalDTO[] = [];
	let selectedMergeProposalId: string | undefined;
	let mergeAfterRevision = 0;
	let mergeHasMore = false;
	let mergeLatestWindow = true;
	let mergeInitialized = false;
	let mergeLoading = false;
	let mergeBusy = false;
	let mergeError: string | undefined;
	let mergeNotice: string | undefined;
	let mergeGeneration = 0;
	let mergeCommitProposalId: string | undefined;

	const render = (): void => {
		const active = document.activeElement instanceof HTMLElement && parent.contains(document.activeElement) ? document.activeElement as HTMLElement & { selectionStart?: number | null; selectionEnd?: number | null } : undefined;
		const focusKey = active?.dataset.focusKey;
		const selectionStart = active?.selectionStart ?? undefined;
		const selectionEnd = active?.selectionEnd ?? undefined;
		parent.replaceChildren();
		const toolbar = document.createElement('div'); toolbar.className = 'ai-session-changes__toolbar';
		const refresh = button('새로고침'); refresh.dataset.focusKey = 'refresh'; refresh.disabled = loading || saving || commitBusy || mergeBusy; refresh.addEventListener('click', () => void loadLatest());
		const older = button(loading ? '기록 불러오는 중…' : '이전 기록'); older.dataset.focusKey = 'older-evidence'; older.disabled = !hasMore || loading || saving || commitBusy || mergeBusy; older.addEventListener('click', () => void loadOlder());
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
			for (const evidence of snapshots) { const item = document.createElement('li'); const select = button(`v${evidence.version} · ${formatTime(evidence.capturedAt)}`); select.dataset.focusKey = `version:${evidence.version}`; select.disabled = saving || commitBusy || mergeBusy; select.setAttribute('aria-pressed', String(evidence === selected)); select.addEventListener('click', () => { if (saving || commitBusy || mergeBusy) { return; } selected = evidence; clearFileSelection(); render(); void loadProposalWindow(0); }); item.appendChild(select); versionList.appendChild(item); }
			parent.appendChild(versionList);
		}
		const fileList = document.createElement('ul'); fileList.className = 'ai-session-changes__files'; fileList.setAttribute('aria-label', '변경 파일');
		for (const file of selected.files) {
			const item = document.createElement('li'); item.className = 'ai-session-changes__file';
			const info = document.createElement('div'); info.className = 'ai-session-changes__file-info';
			const path = document.createElement('code'); path.textContent = file.path;
			const detail = document.createElement('span'); detail.textContent = `${changeLabel(file.change)}${file.previousPath ? ` · 이전 경로 ${file.previousPath}` : ''}`; info.append(path, detail);
			const modeFacts = modeSummary(file);
			if (modeFacts) { const mode = document.createElement('span'); mode.className = 'ai-session-changes__mode'; mode.textContent = modeFacts; info.appendChild(mode); }
			const controls = document.createElement('div'); controls.className = 'ai-session-changes__file-controls';
			const commitLabel = document.createElement('label'); commitLabel.className = 'ai-session-changes__commit-select';
			const commitSelect = document.createElement('input'); commitSelect.type = 'checkbox'; commitSelect.checked = selectedCommitPaths.has(file.path); commitSelect.disabled = commitBusy || mergeBusy || selected.status !== 'observed' || selected.coverage !== 'complete' || file.change === 'renamed'; commitSelect.dataset.focusKey = `commit-file:${file.path}`; commitSelect.setAttribute('aria-label', `${file.path} 커밋 검토에 포함`);
			commitSelect.addEventListener('change', () => { if (selected) { toggleCommitPath(selected, file.path, commitSelect.checked); } });
			const commitSelectText = document.createElement('span'); commitSelectText.textContent = '커밋 검토'; commitLabel.append(commitSelect, commitSelectText); controls.appendChild(commitLabel);
			const choose = button(selectedPath === file.path ? '선택됨' : file.change === 'renamed' ? '경로 변경 · 설명 불가' : '파일 설명'); choose.dataset.focusKey = `file:${file.path}`; choose.setAttribute('aria-pressed', String(selectedPath === file.path)); choose.disabled = saving || commitBusy || mergeBusy || selected.status !== 'observed' || file.change === 'renamed'; choose.addEventListener('click', () => void selectFile(selected!, file.path));
			controls.appendChild(choose);
			if (selectedPath === file.path && fileData) {
				const compare = button('비교 열기'); compare.dataset.focusKey = `compare:${file.path}`; compare.disabled = !diffText(fileData); compare.addEventListener('click', () => void openDiff(selected!, file.path)); controls.appendChild(compare);
			}
			item.append(info, controls); fileList.appendChild(item);
		}
		parent.appendChild(fileList);
		if (!selected.files.length && !selected.noChangesConfirmed) { appendText(parent, 'ai-session-changes__note', '바뀐 파일 목록을 확인할 수 없습니다.'); }
		if (selectedPath) { renderSelectedFile(parent); }
		renderCommitReview(parent);
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
		const selectedFileEvidence = selected?.files.find(file => file.path === selectedPath);
		if (selectedFileEvidence) {
			const modeFacts = modeSummary(selectedFileEvidence);
			if (modeFacts) { appendText(fileSection, 'ai-session-changes__facts', modeFacts); }
			const textComparison = sameTextComparison(fileData);
			if (textComparison === 'same' && hasExecutableModeChange(selectedFileEvidence)) { appendText(fileSection, 'ai-session-changes__note', '텍스트는 같고 실행 권한이 변경되었습니다.'); }
			else if (textComparison === 'unavailable' && hasPrivateBinaryCandidate(fileData)) { appendText(fileSection, 'ai-session-changes__note', '바이너리 또는 UTF-8이 아닌 파일은 텍스트 비교를 할 수 없습니다. 원본 바이트는 보관된 경우 별도 검토 경로에서만 사용됩니다.'); }
		}
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
			selector.disabled = saving || commitBusy || mergeBusy || hunkData.status === 'unavailable' || hunkData.timedOut;
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
		const whatInput = textArea('무엇이 바뀌었나요?', 'what', what); whatInput.maxLength = 4096; whatInput.disabled = saving || commitBusy || mergeBusy; whatInput.addEventListener('input', () => { what = whatInput.value; dirty = true; });
		const whyInput = textArea('왜 바뀌었나요?', 'why', why); whyInput.maxLength = 8192; whyInput.disabled = saving || commitBusy || mergeBusy; whyInput.addEventListener('input', () => { why = whyInput.value; dirty = true; });
		field(editor, '변경 내용', whatInput); field(editor, '변경 이유', whyInput);
		if (currentContext.knowledgeReferences.length) {
			const citationsTitle = document.createElement('p'); citationsTitle.className = 'ai-session-changes__field-title'; citationsTitle.textContent = '실행 시점에 고정된 참고 자료'; editor.appendChild(citationsTitle);
			for (const reference of currentContext.knowledgeReferences) {
				const label = document.createElement('label'); label.className = 'ai-session-changes__citation';
				const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = citations.some(item => sameCitation(item, reference)); checkbox.disabled = saving || commitBusy || mergeBusy; checkbox.dataset.focusKey = `citation:${reference.kind}:${reference.id}`;
				checkbox.addEventListener('change', () => { citations = checkbox.checked ? [...citations, citationOnly(reference)] : citations.filter(item => !sameCitation(item, reference)); dirty = true; });
				const text = document.createElement('span'); text.textContent = `${reference.kind === 'convention' ? '규칙' : '참고'} · ${reference.label} · v${reference.version} · ${reference.sha256.slice(0, 12)}`; label.append(checkbox, text); editor.appendChild(label);
			}
		} else { appendText(editor, 'ai-session-changes__note', '이 실행에 고정된 참고 자료가 없습니다.'); }
		appendText(editor, 'ai-session-changes__note', '실행 결과 검증: 미검증. 설명 확인은 코드 변경, 병합, PR 승인을 뜻하지 않습니다.');
		const saveControls = document.createElement('div'); saveControls.className = 'ai-session-changes__toolbar';
		const saveDraft = button(saving ? '저장 중…' : '초안 저장'); saveDraft.dataset.focusKey = 'save-draft'; saveDraft.disabled = saving || commitBusy || mergeBusy || explanationLoading || fileLoading || revisionLoading || !fileData || !what.trim() || !why.trim() || hunkData?.timedOut === true; saveDraft.addEventListener('click', () => void save('draft'));
		const confirm = button(saving ? '저장 중…' : '설명만 확인'); confirm.dataset.focusKey = 'save-confirmed'; confirm.disabled = saveDraft.disabled; confirm.addEventListener('click', () => void save('confirmed'));
		saveControls.append(saveDraft, confirm); editor.appendChild(saveControls);
		if (explanationError) { appendText(editor, 'ai-session-changes__message', explanationError); }
		if (explanationNotice) { appendText(editor, 'ai-session-changes__status', explanationNotice); }
		if (reloadRevisionAvailable) { const reload = button('최신 설명 다시 확인'); reload.dataset.focusKey = 'reload-revision'; reload.disabled = explanationLoading || saving || commitBusy || mergeBusy; reload.addEventListener('click', () => void reloadRevisionCursor()); editor.appendChild(reload); }
		fileSection.appendChild(editor);
		renderLatestExplanation(fileSection);
		renderRevisionHistory(fileSection);
		parentNode.appendChild(fileSection);
	};

	const renderCommitReview = (parentNode: HTMLElement): void => {
		if (!selected) { return; }
		const section = document.createElement('section'); section.className = 'ai-session-changes__commit-review'; section.setAttribute('aria-label', '커밋 검토');
		const heading = document.createElement('h3'); heading.textContent = '커밋 검토'; section.appendChild(heading);
		appendText(section, 'ai-session-changes__note', '선택한 실행의 보관 내용으로만 제안을 만듭니다. 승인은 코드 설명 확인과 별도이며, 병합이나 PR을 만들지 않습니다.');
		const evidenceEligible = selected.status === 'observed' && selected.coverage === 'complete' && selected.source === 'managedWorktree' && !!selected.afterRevision;
		if (!evidenceEligible) { appendText(section, 'ai-session-changes__message', '완전하게 관찰된 관리 작업 트리 기록과 원본 Git 커밋 정보가 있어야 제안을 만들 수 있습니다.'); }
		if (selectedCommitPaths.size === 0) { appendText(section, 'ai-session-changes__empty', '커밋 검토에 포함할 파일을 선택하세요. 파일은 기본으로 선택되지 않습니다.'); }
		const selectedFiles = selected.files.filter(file => selectedCommitPaths.has(file.path));
		if (selectedFiles.length) {
			const paths = document.createElement('ul'); paths.className = 'ai-session-changes__commit-paths'; paths.setAttribute('aria-label', '커밋 검토 파일');
			for (const file of selectedFiles) {
				const item = document.createElement('li'); item.className = 'ai-session-changes__commit-path';
				const path = document.createElement('code'); path.textContent = file.path; item.appendChild(path);
				const record = commitExplanations.get(file.path);
				if (!record || record.loading) { appendText(item, 'ai-session-changes__status', '파일 설명 기록을 불러오는 중입니다.'); }
				else if (record.error) { appendText(item, 'ai-session-changes__message', record.error); }
				else if (!record.revisions.length) { appendText(item, 'ai-session-changes__empty', '연결할 파일 설명 기록이 없습니다. 먼저 파일 전체 설명을 저장하세요.'); }
				else {
					const label = document.createElement('label'); label.className = 'ai-session-changes__field'; label.append(document.createTextNode('연결할 파일 설명 기록'));
					const selector = document.createElement('select'); selector.dataset.focusKey = `commit-explanation:${file.path}`; selector.setAttribute('aria-label', `${file.path}에 연결할 파일 설명 기록`); selector.disabled = commitBusy || mergeBusy;
					const prompt = document.createElement('option'); prompt.value = ''; prompt.textContent = '설명 기록 선택'; selector.appendChild(prompt);
					for (const revision of record.revisions) {
						const option = document.createElement('option'); option.value = String(revision.revision);
						option.textContent = `v${revision.revision} · ${revision.actor === 'human' ? '사람' : '에이전트'} · ${revision.status === 'confirmed' ? '설명만 확인' : '초안'} · ${formatTime(revision.createdAt)}`;
						selector.appendChild(option);
					}
					selector.value = record.selectedRevision === undefined ? '' : String(record.selectedRevision);
					selector.addEventListener('change', () => {
						const revision = selector.value ? Number(selector.value) : undefined;
						commitExplanations.set(file.path, revision === undefined ? { revisions: record.revisions, loading: false } : { ...record, selectedRevision: revision });
						commitError = undefined; commitNotice = undefined; render();
					});
					label.appendChild(selector); item.appendChild(label);
					const chosen = record.revisions.find(revision => revision.revision === record.selectedRevision);
					if (chosen) { renderExplanationSummary(item, chosen); }
				}
				paths.appendChild(item);
			}
			section.appendChild(paths);
		}
		const message = textArea('커밋 메시지', 'commit-message', commitMessage); message.maxLength = 1000; message.setAttribute('aria-label', '커밋 메시지'); message.disabled = commitBusy || mergeBusy;
		message.addEventListener('input', () => { commitMessage = message.value; commitError = undefined; render(); });
		field(section, '커밋 메시지', message);
		const selectedPathsReady = selectedFiles.length > 0 && selectedFiles.every(file => {
			const record = commitExplanations.get(file.path);
			return !!record && !record.loading && !record.error && record.revisions.some(item => item.revision === record.selectedRevision);
		});
		const controls = document.createElement('div'); controls.className = 'ai-session-changes__toolbar';
		const prepare = button(commitBusy ? '제안 만드는 중…' : '커밋 제안 만들기'); prepare.dataset.focusKey = 'prepare-commit-proposal'; prepare.disabled = commitBusy || mergeBusy || proposalLoading || !evidenceEligible || !selectedPathsReady || !commitMessage.trim(); prepare.addEventListener('click', () => void prepareCommitProposal()); controls.appendChild(prepare); section.appendChild(controls);
		if (commitError) { appendText(section, 'ai-session-changes__message', commitError); }
		if (commitNotice) { appendText(section, 'ai-session-changes__status', commitNotice); }
		renderProposalHistory(section);
		const proposal = proposalWindow.find(item => item.id === selectedProposalId);
		if (proposal) { renderProposal(section, proposal); }
		parentNode.appendChild(section);
	};

	const renderExplanationSummary = (parentNode: HTMLElement, value: WorkspaceAgentExplanationDTO): void => {
		appendText(parentNode, 'ai-session-changes__facts', `설명 ${value.id} · v${value.revision} · ${value.actor === 'human' ? '사람 작성' : '에이전트 작성'} · ${value.status === 'confirmed' ? '설명만 확인' : '초안'} · 실행 결과 미검증`);
		appendText(parentNode, 'ai-session-changes__note', `무엇: ${value.what}`);
		appendText(parentNode, 'ai-session-changes__note', `이유: ${value.why}`);
		for (const citation of value.citations) { appendText(parentNode, 'ai-session-changes__note', `고정 참고 ${citation.kind === 'convention' ? '규칙' : '자료'} · ${citation.id} · v${citation.version} · ${citation.sha256}`); }
		for (const claim of value.checkClaims) { appendText(parentNode, 'ai-session-changes__note', reportedCheckLabel(claim)); }
	};

	const renderProposalHistory = (parentNode: HTMLElement): void => {
		const heading = document.createElement('h4'); heading.textContent = '커밋 제안 기록'; parentNode.appendChild(heading);
		if (proposalLoading) { appendText(parentNode, 'ai-session-changes__status', '커밋 제안 기록을 불러오는 중입니다.'); }
		if (proposalError) { appendText(parentNode, 'ai-session-changes__message', proposalError); }
		if (!proposalInitialized && !proposalLoading) {
			const load = button('제안 기록 불러오기'); load.dataset.focusKey = 'load-commit-proposals'; load.disabled = commitBusy || mergeBusy; load.addEventListener('click', () => void loadProposalWindow(0)); parentNode.appendChild(load);
		}
		if (proposalInitialized && !proposalWindow.length && !proposalLoading) { appendText(parentNode, 'ai-session-changes__empty', '저장된 커밋 제안이 없습니다.'); }
		if (proposalWindow.length) {
			const first = proposalWindow[0].revision; const last = proposalWindow.at(-1)!.revision;
			appendText(parentNode, 'ai-session-changes__status', `제안 기록 v${first}–v${last}${proposalHasMore ? ' · 다음 기록이 있습니다.' : ' · 마지막 기록입니다.'}`);
			const list = document.createElement('ol'); list.className = 'ai-session-changes__proposal-list'; list.setAttribute('aria-label', '커밋 제안 기록');
			for (const proposal of proposalWindow) {
				const item = document.createElement('li'); const select = button(`v${proposal.revision} · ${proposal.commitMessage} · ${proposalStateLabel(proposal)}`); select.dataset.focusKey = `proposal:${proposal.id}`; select.setAttribute('aria-pressed', String(proposal.id === selectedProposalId));
				select.disabled = commitBusy || mergeBusy || proposalLoading;
				select.addEventListener('click', () => { if (commitBusy || mergeBusy || proposalLoading) { return; } selectedProposalId = proposal.id; resetMergeReview(); proposalDetails = new Map(); proposalDetailsError = undefined; proposalDetailsLoading = false; proposalDetailsGeneration++; render(); void loadProposalExplanations(proposal); });
				item.appendChild(select); list.appendChild(item);
			}
			parentNode.appendChild(list);
			if (proposalHasMore) { const more = button(proposalLoading ? '불러오는 중…' : '다음 제안 기록'); more.dataset.focusKey = 'more-commit-proposals'; more.disabled = proposalLoading || commitBusy || mergeBusy; more.addEventListener('click', () => void loadProposalWindow(proposalAfterRevision)); parentNode.appendChild(more); }
		}
	};

	const renderProposal = (parentNode: HTMLElement, proposal: AgentSessionIntegrationProposalDTO): void => {
		const heading = document.createElement('h4'); heading.textContent = `제안 v${proposal.revision} 검토`; parentNode.appendChild(heading);
		appendText(parentNode, 'ai-session-changes__facts', `${proposalStateLabel(proposal)} · ${proposal.paths.length}개 선택 파일 · 만료 ${formatTime(proposal.expiresAt)}`);
		appendText(parentNode, 'ai-session-changes__facts', `제안 ID ${proposal.id} · 지문 ${proposal.fingerprint}`);
		appendText(parentNode, 'ai-session-changes__facts', `원본 커밋 ${proposal.sourceHead} · 제안 트리 ${proposal.proposedGitTreeHash} · 변경 지문 ${proposal.diffFingerprint}`);
		appendText(parentNode, 'ai-session-changes__facts', `커밋 메시지: ${proposal.commitMessage}`);
		appendText(parentNode, 'ai-session-changes__facts', `작성자 ${proposal.author.name} <${proposal.author.email}> · ${proposal.author.date}`);
		appendText(parentNode, 'ai-session-changes__facts', `커미터 ${proposal.committer.name} <${proposal.committer.email}> · ${proposal.committer.date}`);
		const paths = document.createElement('ul'); paths.className = 'ai-session-changes__commit-paths'; paths.setAttribute('aria-label', '제안에 고정된 파일과 설명');
		for (const path of proposal.paths) {
			const item = document.createElement('li'); item.className = 'ai-session-changes__commit-path';
			const pathLabel = document.createElement('code'); pathLabel.textContent = path.path; item.appendChild(pathLabel);
			for (const explanation of path.explanations) {
				const key = `${proposal.id}:${explanation.id}`;
				const loaded = proposalDetails.get(key);
				if (loaded) { renderExplanationSummary(item, loaded); }
				else if (proposalDetailsLoading) { appendText(item, 'ai-session-changes__status', '고정된 설명을 불러오는 중입니다.'); }
				else if (proposalDetailsError) { appendText(item, 'ai-session-changes__message', proposalDetailsError); }
				else { appendText(item, 'ai-session-changes__facts', `고정 설명 ID ${explanation.id} · v${explanation.revision} · ${explanation.actor === 'human' ? '사람' : '에이전트'} · ${explanation.status === 'confirmed' ? '설명만 확인' : '초안'} · 실행 결과 미검증`); }
			}
			paths.appendChild(item);
		}
		parentNode.appendChild(paths);
		const evidenceIsCurrent = selected?.version === proposal.evidenceVersion && selected.fingerprint === proposal.evidenceFingerprint;
		if (!evidenceIsCurrent) { appendText(parentNode, 'ai-session-changes__message', '이 제안은 현재 선택한 변경 기록과 연결되지 않습니다. 현재 기록에서는 승인하거나 적용할 수 없습니다.'); }
		if (proposal.approval) { appendText(parentNode, 'ai-session-changes__facts', `사람 승인 ${proposal.approval.id} · ${formatTime(proposal.approval.approvedAt)} · 제안 지문 ${proposal.approval.proposalFingerprint}`); }
		for (const outcome of proposal.outcomes) {
			appendText(parentNode, 'ai-session-changes__facts', `적용 기록 ${outcome.revision} · ${outcome.state === 'applying' ? '적용 중' : outcome.state === 'succeeded' ? '적용 성공' : outcome.state === 'failed' ? '적용 실패' : '복구 필요'} · 작업 ${outcome.receipt.operationId} · 후보 ${outcome.receipt.candidateHead}${outcome.receipt.resultingHead ? ` · 결과 ${outcome.receipt.resultingHead}` : ''}`);
			if (outcome.receipt.changedPaths.length) { appendText(parentNode, 'ai-session-changes__note', `적용된 경로: ${outcome.receipt.changedPaths.join(', ')}`); }
			if (outcome.receipt.failureCode) { appendText(parentNode, 'ai-session-changes__message', `적용 오류 코드: ${outcome.receipt.failureCode}`); }
		}
		appendText(parentNode, 'ai-session-changes__note', '이 제안은 병합, PR 생성, 보드 완료 또는 검증 통과를 의미하지 않습니다.');
		const controls = document.createElement('div'); controls.className = 'ai-session-changes__toolbar';
		const expired = Date.parse(proposal.expiresAt) <= Date.now();
		if (!proposal.approval && proposal.state === 'pending') {
			const approve = button(commitBusy ? '승인 확인 중…' : '커밋 제안 승인'); approve.dataset.focusKey = 'approve-commit-proposal'; approve.disabled = commitBusy || mergeBusy || expired || !evidenceIsCurrent; approve.addEventListener('click', () => void approveCommitProposal(proposal)); controls.appendChild(approve);
		}
		const apply = button(commitBusy ? '적용 중…' : '승인한 커밋 적용'); apply.dataset.focusKey = 'apply-commit-proposal'; apply.disabled = commitBusy || mergeBusy || !proposal.approval || expired || !evidenceIsCurrent || proposal.state !== 'pending'; apply.addEventListener('click', () => void applyCommitProposal(proposal)); controls.appendChild(apply);
		if (proposal.approval && (proposal.state === 'applying' || proposal.state === 'recoveryRequired')) {
			const recover = button(commitBusy ? '상태 확인 중…' : '적용 상태 복구 확인'); recover.dataset.focusKey = 'recover-commit-proposal'; recover.disabled = commitBusy || mergeBusy; recover.addEventListener('click', () => void recoverCommitProposal(proposal)); controls.appendChild(recover);
		}
		parentNode.appendChild(controls);
		if (proposal.state === 'succeeded') { renderMergeReview(parentNode, proposal); }
	};

	const renderMergeReview = (parentNode: HTMLElement, commitProposal: AgentSessionIntegrationProposalDTO): void => {
		if (mergeCommitProposalId !== commitProposal.id) { resetMergeReview(); mergeCommitProposalId = commitProposal.id; void loadFirstMergeWindow(); }
		const section = document.createElement('section'); section.className = 'ai-session-changes__merge-review'; section.setAttribute('aria-label', '로컬 병합 검토');
		const heading = document.createElement('h4'); heading.textContent = '로컬 병합 검토'; section.appendChild(heading);
		appendText(section, 'ai-session-changes__note', '성공한 커밋 제안을 별도 앱 통합 브랜치에 검토합니다. 사람 승인과 적용은 각각 별도 단계이며 PR은 만들지 않습니다.');
		appendText(section, 'ai-session-changes__facts', `원본 커밋 제안 ${commitProposal.id} · v${commitProposal.revision} · ${commitProposal.fingerprint}`);
		if (selected?.version !== commitProposal.evidenceVersion || selected.fingerprint !== commitProposal.evidenceFingerprint) {
			appendText(section, 'ai-session-changes__message', '선택한 변경 기록이 원본 커밋 제안과 다릅니다. 이 기록에서는 병합 검토를 진행할 수 없습니다.');
		}
		if (mergeLoading) { appendText(section, 'ai-session-changes__status', '병합 제안 기록을 불러오는 중입니다.'); }
		if (mergeError && !mergeInitialized && !mergeLoading) { const retry = button('병합 제안 기록 다시 불러오기'); retry.dataset.focusKey = 'load-merge-proposals'; retry.disabled = mergeBusy || commitBusy; retry.addEventListener('click', () => void loadFirstMergeWindow()); section.appendChild(retry); }
		if (mergeError) { appendText(section, 'ai-session-changes__message', mergeError); }
		if (mergeNotice) { appendText(section, 'ai-session-changes__status', mergeNotice); }
		if (mergeInitialized && !mergeWindow.length && !mergeLoading) { appendText(section, 'ai-session-changes__empty', '저장된 병합 제안이 없습니다.'); }
		if (mergeWindow.length) {
			const first = mergeWindow[0].revision; const last = mergeWindow.at(-1)!.revision;
			appendText(section, 'ai-session-changes__status', `병합 제안 v${first}–v${last}${mergeLatestWindow ? ' · 최근 기록' : ''}${mergeHasMore ? ' · 다음 기록이 있습니다.' : ' · 마지막 기록입니다.'}`);
			const list = document.createElement('ol'); list.className = 'ai-session-changes__merge-list'; list.setAttribute('aria-label', '병합 제안 기록');
			for (const item of mergeWindow) {
				const row = document.createElement('li');
				const select = button(`v${item.revision} · ${mergeStateLabel(item.state)} · ${item.id}`); select.dataset.focusKey = `merge-proposal:${item.id}`;
				select.setAttribute('aria-pressed', String(item.id === selectedMergeProposalId)); select.disabled = mergeBusy || mergeLoading;
				select.addEventListener('click', () => { if (mergeBusy || mergeLoading) { return; } selectedMergeProposalId = item.id; mergeError = undefined; mergeNotice = undefined; render(); });
				row.appendChild(select); list.appendChild(row);
			}
			section.appendChild(list);
			if (first > 1) { const firstPage = button('처음 병합 제안 보기'); firstPage.dataset.focusKey = 'first-merge-proposals'; firstPage.disabled = mergeBusy || mergeLoading; firstPage.addEventListener('click', () => void loadMergeWindow(0)); section.appendChild(firstPage); }
			if (mergeHasMore) { const more = button(mergeLoading ? '불러오는 중…' : '다음 병합 제안 더 보기'); more.dataset.focusKey = 'more-merge-proposals'; more.disabled = mergeBusy || mergeLoading; more.addEventListener('click', () => void loadMergeWindow(mergeAfterRevision)); section.appendChild(more); }
		}
		const selectedMerge = mergeWindow.find(item => item.id === selectedMergeProposalId);
		if (selectedMerge) { renderMergeProposal(section, selectedMerge, commitProposal); }
		const current = selected?.version === commitProposal.evidenceVersion && selected.fingerprint === commitProposal.evidenceFingerprint;
		const conflictProposal = selectedMerge?.state === 'conflict' ? selectedMerge : undefined;
		const conflictSourceMatches = !conflictProposal || conflictProposal.commitProposalId === commitProposal.id
			&& conflictProposal.commitProposalRevision === commitProposal.revision && conflictProposal.commitProposalFingerprint === commitProposal.fingerprint;
		if (!conflictSourceMatches) { appendText(section, 'ai-session-changes__message', '선택한 충돌 제안에 연결된 원본 커밋 제안을 먼저 선택해 주세요.'); }
		const prepare = button(mergeBusy ? '병합 제안 준비 중…' : conflictProposal ? '수정한 충돌 결과로 새 제안 준비' : '병합 제안 준비'); prepare.dataset.focusKey = 'prepare-merge-proposal';
		prepare.disabled = mergeBusy || commitBusy || !current || !mergeInitialized || !conflictSourceMatches;
		prepare.addEventListener('click', () => void prepareMergeProposal(commitProposal, conflictProposal?.id)); section.appendChild(prepare);
		parentNode.appendChild(section);
	};

	const renderMergeProposal = (parentNode: HTMLElement, proposal: AgentSessionMergeProposalDTO, commitProposal: AgentSessionIntegrationProposalDTO): void => {
		const sourceMatches = proposal.commitProposalId === commitProposal.id && proposal.commitProposalRevision === commitProposal.revision && proposal.commitProposalFingerprint === commitProposal.fingerprint;
		const detail = document.createElement('div'); detail.className = 'ai-session-changes__merge-detail';
		const heading = document.createElement('h4'); heading.textContent = `${proposal.resolution ? '충돌 해결 제안' : '병합 제안'} v${proposal.revision} 검토`; detail.appendChild(heading);
		appendText(detail, 'ai-session-changes__facts', `${mergeStateLabel(proposal.state)} · 만료 ${formatTime(proposal.expiresAt)} · 원본 커밋 제안 ${proposal.commitProposalId} v${proposal.commitProposalRevision} · ${proposal.commitProposalFingerprint}`);
		appendText(detail, 'ai-session-changes__facts', `제안 ID ${proposal.id} · 지문 ${proposal.fingerprint}`);
		appendText(detail, 'ai-session-changes__facts', `원본 브랜치 bugfixer/session/${proposal.sessionOwnerId} · 앱 통합 브랜치 bugfixer/integration/${proposal.integrationOwnerId}`);
		appendText(detail, 'ai-session-changes__facts', `원본 HEAD ${proposal.sourceHead} · 대상 HEAD ${proposal.targetHead} · 공통 기반 ${proposal.mergeBase}`);
		appendText(detail, 'ai-session-changes__facts', `병합 커밋 메시지: ${proposal.commitMessage}`);
		appendText(detail, 'ai-session-changes__facts', `작성자 ${proposal.author.name} <${proposal.author.email}> · ${proposal.author.date}`);
		appendText(detail, 'ai-session-changes__facts', `커미터 ${proposal.committer.name} <${proposal.committer.email}> · ${proposal.committer.date}`);
		appendText(detail, 'ai-session-changes__facts', `변경 지문 ${proposal.diffFingerprint} · ${proposal.paths.length}개 전체 경로`);
		if (proposal.resolution) {
			appendText(detail, 'ai-session-changes__facts', `이전 충돌 제안 ${proposal.resolution.proposalId} · 작업 ${proposal.resolution.operationId} · 작업 폴더 ID ${proposal.resolution.generationId} · 등록 ${proposal.resolution.registrationId}`);
			appendText(detail, 'ai-session-changes__facts', `해결 트리 ${proposal.resolution.treeOid} · 인덱스 내용 지문 ${proposal.resolution.indexDigest} · 인덱스 파일 지문 ${proposal.resolution.indexFileDigest} · 작업 파일 지문 ${proposal.resolution.treeDigest}`);
			appendText(detail, 'ai-session-changes__note', '현재 통합 커밋에서 수정한 충돌 결과까지의 전체 차이입니다. 이전 병합 승인은 이 제안을 승인하지 않습니다.');
			if (!proposal.paths.length) { appendText(detail, 'ai-session-changes__note', '해결 결과의 파일 내용은 현재 통합 커밋과 같습니다. 새 병합 커밋은 원본과 통합 커밋의 연결을 기록합니다.'); }
		}
		const paths = document.createElement('ul'); paths.className = 'ai-session-changes__merge-paths'; paths.setAttribute('aria-label', '병합 제안 전체 변경 경로');
		for (const path of proposal.paths) {
			const item = document.createElement('li'); item.className = 'ai-session-changes__merge-path';
			const code = document.createElement('code'); code.textContent = path.path; item.appendChild(code);
			if (path.explanationState === 'unknown') { appendText(item, 'ai-session-changes__note', '이 경로에는 병합 제안에 연결된 설명 기록이 없습니다.'); }
			else {
				for (const reference of path.explanations) {
					appendText(item, 'ai-session-changes__facts', `설명 ${reference.id} · v${reference.revision} · ${reference.actor === 'human' ? '사람 작성' : '에이전트 작성'} · ${reference.status === 'confirmed' ? '설명만 확인' : '초안'} · 실행 결과 미검증`);
					if (sourceMatches) {
						const explanation = proposalDetails.get(`${commitProposal.id}:${reference.id}`);
						if (explanation) { renderExplanationSummary(item, explanation); }
						else if (proposalDetailsLoading) { appendText(item, 'ai-session-changes__status', '고정된 설명을 불러오는 중입니다.'); }
						else if (proposalDetailsError) { appendText(item, 'ai-session-changes__message', proposalDetailsError); }
					}
				}
			}
			paths.appendChild(item);
		}
		detail.appendChild(paths);
		const diffTitle = proposal.resolution ? '보관된 전체 충돌 해결 diff' : '보관된 전체 병합 diff';
		const diffLabel = document.createElement('p'); diffLabel.className = 'ai-session-changes__field-title'; diffLabel.textContent = diffTitle; detail.appendChild(diffLabel);
		const diff = document.createElement('pre'); diff.className = 'ai-session-changes__merge-diff'; diff.tabIndex = 0; diff.setAttribute('aria-label', diffTitle); diff.textContent = proposal.diffText; detail.appendChild(diff);
		if (proposal.approval) { appendText(detail, 'ai-session-changes__facts', `사람 승인 ${proposal.approval.id} · ${formatTime(proposal.approval.approvedAt)} · 제안 지문 ${proposal.approval.proposalFingerprint}`); }
		for (const outcome of proposal.outcomes) {
			appendText(detail, 'ai-session-changes__facts', `적용 기록 ${outcome.revision} · ${mergeStateLabel(outcome.state)} · 작업 ${outcome.receipt.operationId}${outcome.receipt.resultingHead ? ` · 결과 HEAD ${outcome.receipt.resultingHead}` : ''}`);
			if (outcome.receipt.conflictedPaths.length) { appendText(detail, 'ai-session-changes__message', `충돌 경로: ${outcome.receipt.conflictedPaths.join(', ')}. 파일을 직접 해결한 뒤 새 병합 검토를 만들어 주세요.`); }
			if (outcome.receipt.changedPaths.length) { appendText(detail, 'ai-session-changes__note', `적용 경로: ${outcome.receipt.changedPaths.join(', ')}`); }
			if (outcome.receipt.failureCode) { appendText(detail, 'ai-session-changes__message', `적용 오류 코드: ${outcome.receipt.failureCode}`); }
		}
		if (proposal.generationDirectory) { appendText(detail, 'ai-session-changes__facts', `이번 병합 작업 폴더: ${proposal.generationDirectory}`); }
		if (proposal.generationDirectoryError) { appendText(detail, 'ai-session-changes__message', `작업 폴더 확인 오류: ${proposal.generationDirectoryError}`); }
		for (const artifact of proposal.artifacts) {
			if (artifact.event.phase === 'intent') {
				appendText(detail, 'ai-session-changes__facts', `서명된 작업 폴더 경로(앱 보관소 기준): ${artifact.event.generationPath}`);
				if (artifact.event.priorGeneration) { appendText(detail, 'ai-session-changes__note', `이전 작업 폴더는 보존됩니다(앱 보관소 기준): ${artifact.event.priorGeneration.generationPath}`); }
			}
			if (artifact.event.phase === 'candidatePrepared' && artifact.event.outcome === 'conflict') {
				for (const conflict of artifact.event.conflicts) { appendText(detail, 'ai-session-changes__message', `${conflict.path}: ${conflict.message}`); }
			}
		}
		if (proposal.state === 'merged') { appendText(detail, 'ai-session-changes__status', '앱 통합 브랜치에 병합되었습니다.'); }
		if (proposal.state === 'notApplied') { appendText(detail, 'ai-session-changes__note', '적용되지 않았습니다. 새 제안을 준비한 뒤 다시 사람 승인을 받아야 합니다.'); }
		if (proposal.state === 'failed') { appendText(detail, 'ai-session-changes__message', '병합 적용이 실패했습니다. 기록을 확인하고 새 검토를 준비해 주세요.'); }
		appendText(detail, 'ai-session-changes__note', '병합은 이 앱의 로컬 통합 브랜치에만 반영됩니다. PR, 보드 완료 또는 검증 통과를 뜻하지 않습니다.');
		const controls = document.createElement('div'); controls.className = 'ai-session-changes__toolbar';
		const current = selected?.version === commitProposal.evidenceVersion && selected.fingerprint === commitProposal.evidenceFingerprint;
		if (!sourceMatches) { appendText(detail, 'ai-session-changes__message', '이 병합 제안은 다른 성공한 커밋 제안에 연결되어 있습니다. 해당 원본 커밋 제안을 선택해야 승인하거나 적용할 수 있습니다.'); }
		const expired = Date.parse(proposal.expiresAt) <= Date.now();
		if (!proposal.approval && proposal.state === 'pending') {
			const approve = button(mergeBusy ? '승인 확인 중…' : '병합 제안 사람 승인'); approve.dataset.focusKey = 'approve-merge-proposal'; approve.disabled = mergeBusy || commitBusy || expired || !current || !sourceMatches; approve.addEventListener('click', () => void approveMergeProposal(proposal)); controls.appendChild(approve);
		}
		const apply = button(mergeBusy ? '병합 적용 중…' : '승인한 병합 적용'); apply.dataset.focusKey = 'apply-merge-proposal'; apply.disabled = mergeBusy || commitBusy || expired || !current || !sourceMatches || !proposal.approval || proposal.state !== 'pending'; apply.addEventListener('click', () => void applyMergeProposal(proposal)); controls.appendChild(apply);
		if (proposal.approval && (proposal.state === 'applying' || proposal.state === 'recoveryRequired')) {
			const reconcile = button(mergeBusy ? '상태 확인 중…' : '병합 적용 상태 복구 확인'); reconcile.dataset.focusKey = 'reconcile-merge-proposal'; reconcile.disabled = mergeBusy || commitBusy || !sourceMatches; reconcile.addEventListener('click', () => void reconcileMergeProposal(proposal)); controls.appendChild(reconcile);
		}
		if (proposal.state === 'conflict') { appendText(detail, 'ai-session-changes__message', '충돌 작업 폴더의 파일을 수정하고 Git에 스테이징한 뒤 새 제안을 준비하세요. 수정 결과 전체를 다시 검토하고 승인해야 적용됩니다.'); }
		detail.appendChild(controls); parentNode.appendChild(detail);
	};

	const loadFirstMergeWindow = async (): Promise<void> => {
		if (!selected || !mergeCommitProposalId || mergeLoading || mergeBusy) { return; }
		const evidence = selected; const sourceProposalId = mergeCommitProposalId; const request = mergeGeneration; const commitRequest = commitGeneration; const requested = currentContext; const source = currentActions;
		const isCurrentRequest = (): boolean => isMergeCurrent(request, commitRequest, requested, evidence, sourceProposalId);
		mergeLoading = true; mergeError = undefined; render();
		try {
			const latestPage = await source.listMergeProposals(0, MERGE_PAGE_SIZE);
			if (!isCurrentRequest()) { return; }
			assertMergePage(latestPage, requested, 0);
			mergeWindow = [...latestPage.proposals]; mergeAfterRevision = latestPage.nextRevision; mergeHasMore = latestPage.hasMore; mergeLatestWindow = !latestPage.hasMore; mergeInitialized = true;
			selectedMergeProposalId = mergeWindow.at(-1)?.id;
		} catch (error) { if (isCurrentRequest()) { mergeError = describe(error); mergeInitialized = false; } }
		finally { if (isCurrentRequest()) { mergeLoading = false; render(); } }
	};

	const loadMergeWindow = async (afterRevision: number, selectedId?: string): Promise<void> => {
		if (!selected || !mergeCommitProposalId || mergeLoading || mergeBusy) { return; }
		const evidence = selected; const sourceProposalId = mergeCommitProposalId; const request = mergeGeneration; const commitRequest = commitGeneration; const requested = currentContext; const source = currentActions;
		const isCurrentRequest = (): boolean => isMergeCurrent(request, commitRequest, requested, evidence, sourceProposalId);
		mergeLoading = true; mergeError = undefined; render();
		try {
			const page = await source.listMergeProposals(afterRevision, MERGE_PAGE_SIZE);
			if (!isCurrentRequest()) { return; }
			assertMergePage(page, requested, afterRevision);
			mergeWindow = [...page.proposals]; mergeAfterRevision = page.nextRevision; mergeHasMore = page.hasMore; mergeLatestWindow = !page.hasMore; mergeInitialized = true;
			selectedMergeProposalId = selectedId && mergeWindow.some(item => item.id === selectedId) ? selectedId : mergeWindow.at(-1)?.id;
			mergeNotice = undefined;
		} catch (error) { if (isCurrentRequest()) { mergeError = describe(error); } }
		finally { if (isCurrentRequest()) { mergeLoading = false; render(); } }
	};

	const prepareMergeProposal = async (commitProposal: AgentSessionIntegrationProposalDTO, resolutionOfProposalId?: string): Promise<void> => {
		if (!selected || mergeBusy || commitBusy || commitProposal.state !== 'succeeded' || !mergeInitialized) { return; }
		const evidence = selected; const sourceProposalId = commitProposal.id; const request = mergeGeneration; const commitRequest = commitGeneration; const requested = currentContext; const source = currentActions;
		const isCurrentRequest = (): boolean => isMergeCurrent(request, commitRequest, requested, evidence, sourceProposalId);
		mergeBusy = true; mergeError = undefined; mergeNotice = undefined; render();
		try {
			const expectedLatestRevision = await latestMergeProposalRevision(source, requested, isCurrentRequest);
			const proposal = await source.prepareMergeProposal({ ...scopeOf(requested), commitProposalId: sourceProposalId, expectedLatestRevision, ...(resolutionOfProposalId ? { resolutionOfProposalId } : {}) });
			if (!isCurrentRequest()) { return; }
			assertMergeProposal(proposal, requested, commitProposal);
			if ((proposal.resolution?.proposalId ?? undefined) !== resolutionOfProposalId) { throw new Error('새 제안이 선택한 충돌 해결 작업과 일치하지 않습니다.'); }
			mergeNotice = '병합 제안을 저장했습니다. 사람 승인 전에는 적용되지 않습니다.';
			mergeWindow = [proposal]; mergeAfterRevision = proposal.revision; mergeHasMore = proposal.revision > 1; mergeLatestWindow = true; mergeInitialized = true; selectedMergeProposalId = proposal.id;
			const pageStart = Math.max(0, proposal.revision - MERGE_PAGE_SIZE);
			try {
				const page = await source.listMergeProposals(pageStart, MERGE_PAGE_SIZE);
				if (!isCurrentRequest()) { return; }
				assertMergePage(page, requested, pageStart);
				mergeWindow = [...page.proposals]; mergeAfterRevision = page.nextRevision; mergeHasMore = page.hasMore; mergeLatestWindow = true; selectedMergeProposalId = proposal.id;
			} catch (error) { if (isCurrentRequest()) { mergeError = `제안은 저장됐지만 기록 목록을 새로고침하지 못했습니다: ${describe(error)}`; } }
		} catch (error) { if (isCurrentRequest()) { mergeError = `${describe(error)} 병합 제안 기록을 다시 확인하세요.`; } }
		finally { if (isCurrentRequest()) { mergeBusy = false; render(); } }
	};

	const approveMergeProposal = async (proposal: AgentSessionMergeProposalDTO): Promise<void> => {
		if (!selected || mergeBusy || commitBusy || !mergeCommitProposalId) { return; }
		const sourceCommitProposal = proposalWindow.find(item => item.id === mergeCommitProposalId);
		if (!sourceCommitProposal) { mergeError = '원본 커밋 제안을 다시 불러와 주세요.'; render(); return; }
		const evidence = selected; const sourceProposalId = mergeCommitProposalId; const request = mergeGeneration; const commitRequest = commitGeneration; const requested = currentContext; const source = currentActions;
		const isCurrentRequest = (): boolean => isMergeCurrent(request, commitRequest, requested, evidence, sourceProposalId);
		mergeBusy = true; mergeError = undefined; mergeNotice = undefined; render();
		try {
			const result = await source.approveMergeProposal(mergeProposalInput(proposal));
			if (!isCurrentRequest()) { return; }
			assertMergeProposal(result.proposal, requested, sourceCommitProposal);
			if (result.proposal.id !== proposal.id || result.proposal.revision !== proposal.revision || result.proposal.fingerprint !== proposal.fingerprint) { throw new Error('승인 응답이 현재 병합 제안과 일치하지 않습니다.'); }
			if (result.approved && (!result.proposal.approval || result.proposal.approval.actor !== 'human' || result.proposal.approval.proposalFingerprint !== proposal.fingerprint)) { throw new Error('사람 승인 기록이 현재 병합 제안 지문과 일치하지 않습니다.'); }
			updateMergeProposal(result.proposal); mergeNotice = result.approved ? '사람이 병합 제안을 승인했습니다. 적용은 별도 동작입니다.' : '승인 창에서 취소했습니다. 병합 제안은 그대로입니다.';
		} catch (error) { if (isCurrentRequest()) { mergeError = `${describe(error)} 병합 제안 상태를 다시 불러 확인하세요.`; } }
		finally { if (isCurrentRequest()) { mergeBusy = false; render(); } }
	};

	const applyMergeProposal = async (proposal: AgentSessionMergeProposalDTO): Promise<void> => {
		if (!selected || mergeBusy || commitBusy || !proposal.approval || !mergeCommitProposalId) { return; }
		const sourceCommitProposal = proposalWindow.find(item => item.id === mergeCommitProposalId);
		if (!sourceCommitProposal) { mergeError = '원본 커밋 제안을 다시 불러와 주세요.'; render(); return; }
		const evidence = selected; const sourceProposalId = mergeCommitProposalId; const request = mergeGeneration; const commitRequest = commitGeneration; const requested = currentContext; const source = currentActions;
		const isCurrentRequest = (): boolean => isMergeCurrent(request, commitRequest, requested, evidence, sourceProposalId);
		mergeBusy = true; mergeError = undefined; mergeNotice = undefined; render();
		try {
			const updated = await source.applyMergeProposal(mergeProposalInput(proposal));
			if (!isCurrentRequest()) { return; }
			assertMergeProposal(updated, requested, sourceCommitProposal); if (updated.id !== proposal.id || updated.revision !== proposal.revision || updated.fingerprint !== proposal.fingerprint) { throw new Error('적용 응답이 선택한 병합 제안과 일치하지 않습니다.'); }
			updateMergeProposal(updated); mergeNotice = `병합 적용 상태: ${mergeStateLabel(updated.state)}.`;
		} catch (error) { if (isCurrentRequest()) { mergeError = `${describe(error)} 병합 제안과 적용 기록을 다시 확인하세요.`; } }
		finally { if (isCurrentRequest()) { mergeBusy = false; render(); } }
	};

	const reconcileMergeProposal = async (proposal: AgentSessionMergeProposalDTO): Promise<void> => {
		if (!selected || mergeBusy || commitBusy || !proposal.approval || !mergeCommitProposalId) { return; }
		const sourceCommitProposal = proposalWindow.find(item => item.id === mergeCommitProposalId);
		if (!sourceCommitProposal) { mergeError = '원본 커밋 제안을 다시 불러와 주세요.'; render(); return; }
		const evidence = selected; const sourceProposalId = mergeCommitProposalId; const request = mergeGeneration; const commitRequest = commitGeneration; const requested = currentContext; const source = currentActions;
		const operationId = proposal.outcomes.at(-1)?.state === 'applying' ? proposal.outcomes.at(-1)!.receipt.operationId : undefined;
		const isCurrentRequest = (): boolean => isMergeCurrent(request, commitRequest, requested, evidence, sourceProposalId);
		mergeBusy = true; mergeError = undefined; mergeNotice = undefined; render();
		try {
			const updated = await source.reconcileMergeProposal({ ...mergeProposalInput(proposal), ...(operationId ? { operationId } : {}) });
			if (!isCurrentRequest()) { return; }
			assertMergeProposal(updated, requested, sourceCommitProposal); if (updated.id !== proposal.id || updated.revision !== proposal.revision || updated.fingerprint !== proposal.fingerprint) { throw new Error('복구 응답이 선택한 병합 제안과 일치하지 않습니다.'); }
			updateMergeProposal(updated); mergeNotice = `저장된 병합 작업 기록을 확인했습니다: ${mergeStateLabel(updated.state)}.`;
		} catch (error) { if (isCurrentRequest()) { mergeError = `${describe(error)} 병합 제안과 작업 기록을 다시 확인하세요.`; } }
		finally { if (isCurrentRequest()) { mergeBusy = false; render(); } }
	};

	function updateMergeProposal(proposal: AgentSessionMergeProposalDTO): void {
		mergeWindow = mergeWindow.map(item => item.id === proposal.id ? proposal : item); selectedMergeProposalId = proposal.id;
	}

	const toggleCommitPath = (evidence: WorkspaceAgentChangeEvidenceDTO, path: string, checked: boolean): void => {
		if (commitBusy || mergeBusy || selected !== evidence) { return; }
		if (checked) {
			selectedCommitPaths.add(path);
			commitExplanations.set(path, { revisions: [], loading: true });
			render();
			void loadFileExplanationChoices(evidence, path);
		} else {
			selectedCommitPaths.delete(path);
			commitExplanations.delete(path);
			commitError = undefined;
			render();
		}
	};

	const loadFileExplanationChoices = async (evidence: WorkspaceAgentChangeEvidenceDTO, path: string): Promise<void> => {
		const request = commitGeneration; const requested = currentContext; const source = currentActions;
		const target = targetFor(evidence, path, null);
		try {
			const latest = await source.explanation(target);
			if (!isCommitCurrent(request, requested, evidence) || !selectedCommitPaths.has(path)) { return; }
			assertExplanation(latest, target);
			if (!latest) { commitExplanations.set(path, { revisions: [], loading: false }); render(); return; }
			const page = await source.explanationRevisions(target, Math.max(0, latest.revision - PAGE_SIZE), Math.min(PAGE_SIZE, latest.revision));
			if (!isCommitCurrent(request, requested, evidence) || !selectedCommitPaths.has(path)) { return; }
			assertExplanationPage(page, target);
			if (!page.revisions.some(item => item.revision === latest.revision && item.id === latest.id)) { throw new Error('최신 파일 설명이 선택 가능한 기록에 없습니다. 다시 불러와 주세요.'); }
			commitExplanations.set(path, { revisions: [...page.revisions], loading: false });
		} catch (error) {
			if (isCommitCurrent(request, requested, evidence) && selectedCommitPaths.has(path)) { commitExplanations.set(path, { revisions: [], loading: false, error: describe(error) }); }
		}
		if (isCommitCurrent(request, requested, evidence)) { render(); }
	};

	const loadProposalWindow = async (afterRevision: number, selectedId?: string): Promise<void> => {
		if (!selected || proposalLoading) { return; }
		const evidence = selected; const request = commitGeneration; const requested = currentContext; const source = currentActions;
		proposalLoading = true; proposalError = undefined; render();
		try {
			const page = await source.listCommitProposals(afterRevision, PAGE_SIZE);
			if (!isCommitCurrent(request, requested, evidence)) { return; }
		assertProposalPage(page, requested, afterRevision);
			proposalWindow = [...page.proposals]; proposalAfterRevision = page.nextRevision; proposalHasMore = page.hasMore; proposalInitialized = true;
			selectedProposalId = selectedId && proposalWindow.some(proposal => proposal.id === selectedId) ? selectedId : proposalWindow.at(-1)?.id;
			proposalDetails = new Map(); proposalDetailsError = undefined; proposalDetailsLoading = false; proposalDetailsGeneration++;
			const proposal = proposalWindow.find(item => item.id === selectedProposalId);
			if (proposal) { void loadProposalExplanations(proposal); }
		} catch (error) { if (isCommitCurrent(request, requested, evidence)) { proposalError = describe(error); proposalInitialized = true; } }
		finally { if (isCommitCurrent(request, requested, evidence)) { proposalLoading = false; render(); } }
	};

	const loadProposalExplanations = async (proposal: AgentSessionIntegrationProposalDTO): Promise<void> => {
		const evidence = selected; if (!evidence || proposal.id !== selectedProposalId) { return; }
		const generation = ++proposalDetailsGeneration; const request = commitGeneration; const requested = currentContext; const source = currentActions;
		const isCurrentRequest = (): boolean => isCommitCurrent(request, requested, evidence) && generation === proposalDetailsGeneration && selectedProposalId === proposal.id;
		proposalDetailsLoading = true; proposalDetailsError = undefined; render();
		try {
			for (const path of proposal.paths) {
				for (const reference of path.explanations) {
					const target = { projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId, evidenceVersion: proposal.evidenceVersion, evidenceFingerprint: proposal.evidenceFingerprint, path: reference.path, hunkId: reference.hunkId };
					const page = await source.explanationRevisions(target, reference.revision - 1, 1);
					if (!isCurrentRequest()) { return; }
					assertExplanationPage(page, target);
					const exact = page.revisions.find(item => item.revision === reference.revision && item.id === reference.id);
					if (!exact) { throw new Error(`고정 설명 ${reference.id} v${reference.revision}을 다시 확인할 수 없습니다.`); }
					proposalDetails.set(`${proposal.id}:${reference.id}`, exact);
				}
			}
		} catch (error) { if (isCurrentRequest()) { proposalDetailsError = describe(error); } }
		finally { if (isCurrentRequest()) { proposalDetailsLoading = false; render(); } }
	};

	const prepareCommitProposal = async (): Promise<void> => {
		if (!selected || commitBusy || mergeBusy || !commitMessage.trim()) { return; }
		const evidence = selected; const request = commitGeneration; const requested = currentContext; const source = currentActions;
		commitBusy = true; commitError = undefined; commitNotice = undefined; render();
		try {
			const paths = evidence.files.filter(file => selectedCommitPaths.has(file.path)).map(file => {
				const record = commitExplanations.get(file.path); const revision = record?.revisions.find(item => item.revision === record.selectedRevision);
				if (!revision) { throw new Error(`파일 설명 기록을 선택하세요: ${file.path}`); }
				return { path: file.path, explanationTargets: [{ path: file.path, hunkId: null, revision: revision.revision }] };
			});
			if (paths.length === 0) { throw new Error('커밋 검토에 포함할 파일을 선택하세요.'); }
			const expectedLatestRevision = await latestProposalRevision(source, requested, () => isCommitCurrent(request, requested, evidence));
			const proposal = await source.prepareCommitProposal({ projectId: requested.projectId, sessionId: requested.sessionId, turnId: requested.turnId, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, paths, commitMessage: commitMessage.trim(), expectedLatestRevision });
			if (!isCommitCurrent(request, requested, evidence)) { return; }
			assertProposal(proposal, requested, evidence);
			commitNotice = '제안을 저장했습니다. 승인 전에는 커밋이 적용되지 않습니다.';
			await loadProposalWindow(Math.max(0, proposal.revision - PAGE_SIZE), proposal.id);
		} catch (error) { if (isCommitCurrent(request, requested, evidence)) { commitError = `${describe(error)} 입력은 보존했습니다.`; } }
		finally { if (isCommitCurrent(request, requested, evidence)) { commitBusy = false; render(); } }
	};

	const approveCommitProposal = async (proposal: AgentSessionIntegrationProposalDTO): Promise<void> => {
		if (!selected || commitBusy || mergeBusy) { return; }
		const evidence = selected; const request = commitGeneration; const requested = currentContext; const source = currentActions;
		commitBusy = true; commitError = undefined; commitNotice = undefined; render();
		try {
			const result = await source.approveCommitProposal(proposalInput(proposal));
			if (!isCommitCurrent(request, requested, evidence)) { return; }
			assertProposal(result.proposal, requested, evidence);
			if (result.proposal.id !== proposal.id || result.proposal.revision !== proposal.revision || result.proposal.fingerprint !== proposal.fingerprint) { throw new Error('승인 응답이 현재 제안과 일치하지 않습니다.'); }
			if (result.approved && (!result.proposal.approval || result.proposal.approval.actor !== 'human' || result.proposal.approval.proposalFingerprint !== proposal.fingerprint)) { throw new Error('사람 승인 기록이 현재 제안 지문과 일치하지 않습니다.'); }
			commitNotice = result.approved ? '사람이 이 제안을 승인했습니다. 적용은 별도 동작입니다.' : '승인 창에서 취소했습니다. 제안은 그대로입니다.';
			updateProposal(result.proposal);
		} catch (error) { if (isCommitCurrent(request, requested, evidence)) { commitError = `${describe(error)} 제안 상태를 다시 불러와 확인하세요.`; } }
		finally { if (isCommitCurrent(request, requested, evidence)) { commitBusy = false; render(); } }
	};

	const applyCommitProposal = async (proposal: AgentSessionIntegrationProposalDTO): Promise<void> => {
		if (!selected || commitBusy || mergeBusy || !proposal.approval) { return; }
		const evidence = selected; const request = commitGeneration; const requested = currentContext; const source = currentActions;
		commitBusy = true; commitError = undefined; commitNotice = undefined; render();
		try {
			const updated = await source.applyCommitProposal(proposalInput(proposal));
			if (!isCommitCurrent(request, requested, evidence)) { return; }
			assertProposal(updated, requested, evidence); if (updated.id !== proposal.id) { throw new Error('적용 응답이 선택한 제안과 일치하지 않습니다.'); }
			updateProposal(updated); commitNotice = updated.state === 'succeeded' ? '보관된 제안이 적용되었습니다. 병합이나 PR은 생성되지 않았습니다.' : `적용 상태: ${proposalStateLabel(updated)}. 결과를 확인하세요.`;
		} catch (error) { if (isCommitCurrent(request, requested, evidence)) { commitError = `${describe(error)} 제안과 적용 기록을 다시 확인하세요.`; } }
		finally { if (isCommitCurrent(request, requested, evidence)) { commitBusy = false; render(); } }
	};

	const recoverCommitProposal = async (proposal: AgentSessionIntegrationProposalDTO): Promise<void> => {
		if (!selected || commitBusy || mergeBusy || !proposal.approval) { return; }
		const evidence = selected; const request = commitGeneration; const requested = currentContext; const source = currentActions;
		const operationId = proposal.outcomes.at(-1)?.state === 'applying' ? proposal.outcomes.at(-1)!.receipt.operationId : undefined;
		commitBusy = true; commitError = undefined; commitNotice = undefined; render();
		try {
			const updated = await source.recoverCommitProposal({ ...proposalInput(proposal), ...(operationId ? { operationId } : {}) });
			if (!isCommitCurrent(request, requested, evidence)) { return; }
			if (!updated || updated.kind !== 'commit' || updated.projectId !== requested.projectId || updated.sessionId !== requested.sessionId || updated.turnId !== requested.turnId
				|| updated.id !== proposal.id || updated.revision !== proposal.revision || updated.fingerprint !== proposal.fingerprint
				|| updated.evidenceVersion !== proposal.evidenceVersion || updated.evidenceFingerprint !== proposal.evidenceFingerprint) { throw new Error('복구 응답이 선택한 제안과 일치하지 않습니다.'); }
			updateProposal(updated); commitNotice = `저장된 적용 기록을 확인했습니다: ${proposalStateLabel(updated)}.`;
		} catch (error) { if (isCommitCurrent(request, requested, evidence)) { commitError = `${describe(error)} 제안과 적용 기록을 다시 확인하세요.`; } }
		finally { if (isCommitCurrent(request, requested, evidence)) { commitBusy = false; render(); } }
	};

	function updateProposal(proposal: AgentSessionIntegrationProposalDTO): void {
		proposalWindow = proposalWindow.map(item => item.id === proposal.id ? proposal : item);
		selectedProposalId = proposal.id;
		proposalDetails = new Map(); proposalDetailsLoading = false; proposalDetailsError = undefined; proposalDetailsGeneration++;
		void loadProposalExplanations(proposal);
	}

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
		if (!latestRevisionWindow) { const latest = button('최근 설명 보기'); latest.dataset.focusKey = 'latest-revisions'; latest.disabled = revisionLoading || saving || mergeBusy; latest.addEventListener('click', () => void loadLatestRevisionWindow()); parentNode.appendChild(latest); }
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
		if (hasMoreRevisions) { const more = button(revisionLoading ? '불러오는 중…' : '이전 설명 더 보기'); more.dataset.focusKey = 'more-revisions'; more.disabled = revisionLoading || saving || mergeBusy; more.addEventListener('click', () => void loadMoreRevisions()); parentNode.appendChild(more); }
	};

	const loadLatest = async (): Promise<void> => {
		if (disposed || loading || saving || commitBusy || mergeBusy) { return; }
		loading = true; errorText = undefined; const request = ++generation; const requested = currentContext; const source = currentActions; render();
		try {
			const latest = await source.latest();
			if (!isCurrent(request, requested)) { return; }
			if (latest && (latest.projectId !== requested.projectId || latest.sessionId !== requested.sessionId || latest.turnId !== requested.turnId)) { throw new Error('다른 실행의 기록을 받았습니다.'); }
			snapshots = latest ? [latest] : []; selected = latest ?? undefined; beforeVersion = latest?.version ?? 0; hasMore = (latest?.version ?? 0) > 1; latestWindow = true; clearFileSelection(); if (latest) { void loadProposalWindow(0); }
		} catch (error) { if (isCurrent(request, requested)) { errorText = describe(error); } }
		finally { if (isCurrent(request, requested)) { loading = false; render(); } }
	};

	const loadOlder = async (): Promise<void> => {
		if (disposed || loading || saving || commitBusy || mergeBusy || !hasMore) { return; }
		loading = true; errorText = undefined; const request = ++generation; const requested = currentContext; const source = currentActions; render();
		try {
			const page = await source.list(beforeVersion, PAGE_SIZE);
			if (!isCurrent(request, requested)) { return; }
			assertEvidencePage(page, requested, beforeVersion);
			snapshots = [...page.snapshots]; selected = snapshots[0]; beforeVersion = page.nextVersion; hasMore = page.hasMore; latestWindow = false; clearFileSelection(); if (selected) { void loadProposalWindow(0); }
		} catch (error) { if (isCurrent(request, requested)) { errorText = describe(error); } }
		finally { if (isCurrent(request, requested)) { loading = false; render(); } }
	};

	const selectFile = async (evidence: WorkspaceAgentChangeEvidenceDTO, path: string, retry = false): Promise<void> => {
		if (disposed || fileLoading || saving || mergeBusy || (selectedPath === path && !retry)) { return; }
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
		if (!selected || !selectedPath || mergeBusy) { return; }
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
		if (!selected || !selectedPath || revisionLoading || saving || mergeBusy) { return; }
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
		if (!selected || !selectedPath || !fileData || !hunkData || saving || mergeBusy || !what.trim() || !why.trim()) { return; }
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
		if (!selected || !selectedPath || revisionLoading || saving || mergeBusy || !hasMoreRevisions) { return; }
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
	function clearFileSelection(): void { rememberDraft(); activeDraftKey = undefined; fileGeneration++; selectedPath = undefined; fileData = undefined; hunkData = undefined; fileLoading = false; fileError = undefined; selectedHunkId = null; explanation = null; explanationLoading = false; explanationError = undefined; explanationNotice = undefined; reloadRevisionAvailable = false; expectedRevision = 0; what = ''; why = ''; citations = []; dirty = false; revisions = []; hasMoreRevisions = false; latestRevisionWindow = true; saving = false; resetCommitReview(); }
	function resetCommitReview(): void { commitGeneration++; selectedCommitPaths = new Set(); commitExplanations = new Map(); commitMessage = ''; commitBusy = false; commitError = undefined; commitNotice = undefined; proposalWindow = []; selectedProposalId = undefined; proposalAfterRevision = 0; proposalHasMore = false; proposalLoading = false; proposalInitialized = false; proposalError = undefined; proposalDetails = new Map(); proposalDetailsLoading = false; proposalDetailsError = undefined; proposalDetailsGeneration++; resetMergeReview(); }
	function resetMergeReview(): void { mergeGeneration++; mergeWindow = []; selectedMergeProposalId = undefined; mergeAfterRevision = 0; mergeHasMore = false; mergeLatestWindow = true; mergeInitialized = false; mergeLoading = false; mergeBusy = false; mergeError = undefined; mergeNotice = undefined; mergeCommitProposalId = undefined; }
	function isCommitCurrent(request: number, requested: SessionChangesContext, evidence: WorkspaceAgentChangeEvidenceDTO): boolean { return !disposed && request === commitGeneration && requested === currentContext && evidence === selected; }
	function isMergeCurrent(request: number, commitRequest: number, requested: SessionChangesContext, evidence: WorkspaceAgentChangeEvidenceDTO, sourceProposalId: string): boolean { return !disposed && request === mergeGeneration && commitRequest === commitGeneration && requested === currentContext && evidence === selected && mergeCommitProposalId === sourceProposalId; }

	return {
		setContext(next, nextActions) { if (next.projectId === currentContext.projectId && next.sessionId === currentContext.sessionId && next.turnId === currentContext.turnId) { currentActions = nextActions; currentContext = next; return; } currentContext = next; currentActions = nextActions; generation++; loading = false; snapshots = []; selected = undefined; beforeVersion = 0; hasMore = true; latestWindow = true; errorText = undefined; clearFileSelection(); if (visible) { void loadLatest(); } else { render(); } },
		setVisible(next) { visible = next; if (next && !snapshots.length && !loading) { void loadLatest(); } },
		refresh() { void loadLatest(); },
		dispose() { disposed = true; generation++; fileGeneration++; parent.replaceChildren(); },
	};

}

async function latestProposalRevision(actions: SessionChangesActions, context: SessionChangesContext, isCurrentRequest: () => boolean): Promise<number> {
	let afterRevision = 0;
	let latestRevision = 0;
	for (;;) {
		const page = await actions.listCommitProposals(afterRevision, PAGE_SIZE);
		if (!isCurrentRequest()) { throw new Error('선택한 실행이 바뀌었습니다. 제안을 다시 만들어 주세요.'); }
		assertProposalPage(page, context, afterRevision);
		if (page.proposals.length) { latestRevision = page.proposals.at(-1)!.revision; }
		if (!page.hasMore) { return latestRevision; }
		if (page.nextRevision <= afterRevision) { throw new Error('커밋 제안 기록의 페이지 위치가 앞으로 이동하지 않습니다.'); }
		afterRevision = page.nextRevision;
	}
}

async function latestMergeProposalRevision(actions: SessionChangesActions, context: SessionChangesContext, isCurrentRequest: () => boolean): Promise<number> {
	let afterRevision = 0;
	let latestRevision = 0;
	for (;;) {
		const page = await actions.listMergeProposals(afterRevision, MERGE_PAGE_SIZE);
		if (!isCurrentRequest()) { throw new Error('선택한 실행이 바뀌었습니다. 병합 제안을 다시 준비해 주세요.'); }
		assertMergePage(page, context, afterRevision);
		if (page.proposals.length) { latestRevision = page.proposals.at(-1)!.revision; }
		if (!page.hasMore) { return latestRevision; }
		if (page.nextRevision <= afterRevision) { throw new Error('병합 제안 기록의 페이지 위치가 앞으로 이동하지 않습니다.'); }
		afterRevision = page.nextRevision;
	}
}

function button(label: string): HTMLButtonElement { const element = document.createElement('button'); element.type = 'button'; element.className = 'ai-session-changes__button'; element.textContent = label; return element; }
function textArea(placeholder: string, focusKey: string, value: string): HTMLTextAreaElement { const element = document.createElement('textarea'); element.placeholder = placeholder; element.dataset.focusKey = focusKey; element.value = value; return element; }
function field(parent: HTMLElement, labelText: string, control: HTMLElement): void { const label = document.createElement('label'); label.className = 'ai-session-changes__field'; label.append(document.createTextNode(labelText), control); parent.appendChild(label); }
function appendText(parent: HTMLElement, className: string, value: string): void { const element = document.createElement('p'); element.className = className; element.textContent = value; parent.appendChild(element); }
function changeLabel(change: WorkspaceAgentChangeEvidenceDTO['files'][number]['change']): string { return ({ created: '추가됨', modified: '수정됨', deleted: '삭제됨', renamed: '이름 변경', typeChanged: '종류 변경', symlinkChanged: '링크 변경' })[change]; }
function modeSummary(file: WorkspaceAgentChangeEvidenceDTO['files'][number]): string | undefined {
	const beforeFile = file.before?.kind === 'file' ? file.before : undefined;
	const afterFile = file.after?.kind === 'file' ? file.after : undefined;
	if (!beforeFile && !afterFile) { return undefined; }
	const before = file.before === null ? '없음' : beforeFile ? executableLabel(beforeFile.executable) : '일반 파일 아님';
	const after = file.after === null ? '없음' : afterFile ? executableLabel(afterFile.executable) : '일반 파일 아님';
	const transition = beforeFile && afterFile && beforeFile.executable !== undefined && afterFile.executable !== undefined
		? beforeFile.executable === afterFile.executable ? ' · 변경 없음' : ' · 변경됨'
		: '';
	return `실행 권한 · 전 ${before} → 후 ${after}${transition}`;
}
function executableLabel(value: boolean | undefined): string { return value === undefined ? '기록 없음' : value ? '실행 가능' : '실행 안 됨'; }
function hasExecutableModeChange(file: WorkspaceAgentChangeEvidenceDTO['files'][number]): boolean {
	return file.before?.kind === 'file' && file.after?.kind === 'file' && file.before.executable !== undefined && file.after.executable !== undefined && file.before.executable !== file.after.executable;
}
function sameTextComparison(file: WorkspaceAgentChangeFileDTO): 'same' | 'different' | 'unavailable' {
	const before = sideText(file.before);
	const after = sideText(file.after);
	if (before === undefined || after === undefined) { return 'unavailable'; }
	return before === after ? 'same' : 'different';
}
function hasPrivateBinaryCandidate(file: WorkspaceAgentChangeFileDTO): boolean {
	return [file.before, file.after].some(side => side.state === 'unavailable' && (side.file?.contentUnavailableReason === 'binary' || side.file?.contentUnavailableReason === 'invalidUtf8'));
}
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
function assertProposalPage(page: { readonly proposals: readonly AgentSessionIntegrationProposalDTO[]; readonly nextRevision: number; readonly hasMore: boolean }, context: SessionChangesContext, afterRevision: number): void {
	if (!page || !Array.isArray(page.proposals) || !Number.isSafeInteger(page.nextRevision) || typeof page.hasMore !== 'boolean'
		|| page.proposals.some((item, index) => item.projectId !== context.projectId || item.sessionId !== context.sessionId || item.turnId !== context.turnId
			|| item.revision <= afterRevision || (index > 0 && item.revision <= page.proposals[index - 1].revision))
		|| page.nextRevision !== (page.proposals.at(-1)?.revision ?? afterRevision)) { throw new Error('다른 실행 또는 잘못된 커밋 제안 기록을 받았습니다.'); }
}
function assertMergePage(page: WorkspaceAgentMergeProposalPageDTO, context: SessionChangesContext, afterRevision: number): void {
	if (!page || !Array.isArray(page.proposals) || !Number.isSafeInteger(page.nextRevision) || typeof page.hasMore !== 'boolean'
		|| page.proposals.length > MERGE_PAGE_SIZE || page.proposals.some((item, index) => item.projectId !== context.projectId || item.sessionId !== context.sessionId || item.turnId !== context.turnId
			|| item.revision <= afterRevision || (index > 0 && item.revision <= page.proposals[index - 1].revision))
		|| page.nextRevision !== (page.proposals.at(-1)?.revision ?? afterRevision)) { throw new Error('다른 실행 또는 잘못된 병합 제안 기록을 받았습니다.'); }
}
function assertMergeProposal(proposal: AgentSessionMergeProposalDTO, context: SessionChangesContext, commitProposal: AgentSessionIntegrationProposalDTO): void {
	if (!proposal || proposal.kind !== 'merge' || proposal.projectId !== context.projectId || proposal.sessionId !== context.sessionId || proposal.turnId !== context.turnId
		|| proposal.commitProposalId !== commitProposal.id || proposal.commitProposalRevision !== commitProposal.revision || proposal.commitProposalFingerprint !== commitProposal.fingerprint
		|| !Number.isSafeInteger(proposal.revision) || proposal.revision < 1
		|| !Array.isArray(proposal.paths) || typeof proposal.diffText !== 'string' || !proposal.fingerprint || !proposal.diffFingerprint) {
		throw new Error('다른 실행 또는 다른 원본 커밋의 병합 제안을 받았습니다.');
	}
}
function mergeProposalInput(proposal: AgentSessionMergeProposalDTO): WorkspaceAgentMergeProposalMutationInput {
	return { projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId, proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint };
}
function scopeOf(context: SessionChangesContext): Pick<WorkspaceAgentMergePrepareInput, 'projectId' | 'sessionId' | 'turnId'> { return { projectId: context.projectId, sessionId: context.sessionId, turnId: context.turnId }; }
function mergeStateLabel(state: AgentSessionMergeProposalDTO['state'] | AgentSessionMergeProposalDTO['outcomes'][number]['state']): string {
	return ({ pending: '검토 대기', applying: '적용 중', merged: '병합 완료', conflict: '충돌', notApplied: '미적용', recoveryRequired: '복구 필요', failed: '적용 실패' })[state];
}
function assertProposal(proposal: AgentSessionIntegrationProposalDTO, context: SessionChangesContext, evidence: WorkspaceAgentChangeEvidenceDTO): void {
	if (!proposal || proposal.kind !== 'commit' || proposal.projectId !== context.projectId || proposal.sessionId !== context.sessionId || proposal.turnId !== context.turnId
		|| proposal.evidenceVersion !== evidence.version || proposal.evidenceFingerprint !== evidence.fingerprint || !Number.isSafeInteger(proposal.revision)
		|| proposal.revision < 1 || !/^[0-9a-f]{64}$/iu.test(proposal.fingerprint)) { throw new Error('커밋 제안이 선택한 실행 또는 변경 기록과 일치하지 않습니다.'); }
}
function proposalInput(proposal: AgentSessionIntegrationProposalDTO): WorkspaceAgentCommitProposalInput {
	return { projectId: proposal.projectId, sessionId: proposal.sessionId, turnId: proposal.turnId, proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint };
}
function proposalStateLabel(proposal: AgentSessionIntegrationProposalDTO): string {
	if (proposal.state === 'pending') { return proposal.approval ? '승인됨 · 적용 대기' : '승인 전'; }
	return proposal.state === 'applying' ? '적용 중' : proposal.state === 'succeeded' ? '적용 성공' : proposal.state === 'failed' ? '적용 실패' : '복구 필요';
}
function assertExplanation(value: WorkspaceAgentExplanationDTO | null, target: WorkspaceAgentExplanationTargetDTO): void { if (value && !sameTarget(value.target, target)) { throw new Error('다른 파일 또는 변경 구간의 설명을 받았습니다.'); } }
function assertExplanationPage(page: WorkspaceAgentExplanationPageDTO, target: WorkspaceAgentExplanationTargetDTO): void { if (!page || !Array.isArray(page.revisions) || page.revisions.some((item, index) => !sameTarget(item.target, target) || (index > 0 && item.revision <= page.revisions[index - 1].revision)) || (page.revisions.length > 0 && page.nextRevision !== page.revisions.at(-1)?.revision)) { throw new Error('다른 파일 또는 변경 구간의 설명 기록을 받았습니다.'); } }
function sameTarget(left: WorkspaceAgentExplanationTargetDTO, right: WorkspaceAgentExplanationTargetDTO): boolean { return left.projectId === right.projectId && left.sessionId === right.sessionId && left.turnId === right.turnId && left.evidenceVersion === right.evidenceVersion && left.evidenceFingerprint === right.evidenceFingerprint && left.path === right.path && left.hunkId === right.hunkId; }
