import type { WorkspaceAgentChangeEvidenceDTO, WorkspaceAgentChangeEvidencePageDTO, WorkspaceAgentChangeFileDTO } from '../../../../../workspace/common/workspaceAgentChangesProtocol.js';
import './sessionChanges.css';

export interface SessionChangesContext { readonly projectId: string; readonly sessionId: string; readonly turnId: string; }
export interface SessionChangesActions {
	readonly latest: () => Promise<WorkspaceAgentChangeEvidenceDTO | null>;
	readonly list: (beforeVersion: number, limit: number) => Promise<WorkspaceAgentChangeEvidencePageDTO>;
	readonly file: (evidence: WorkspaceAgentChangeEvidenceDTO, path: string) => Promise<WorkspaceAgentChangeFileDTO | null>;
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
	parent.replaceChildren();
	const toolbar = document.createElement('div'); toolbar.className = 'ai-session-changes__toolbar';
	const refresh = button('새로고침');
	const older = button('이전 기록 불러오기');
	toolbar.append(refresh, older);
	const status = document.createElement('p'); status.className = 'ai-session-changes__status'; status.setAttribute('role', 'status');	
	const message = document.createElement('p'); message.className = 'ai-session-changes__message'; message.setAttribute('role', 'alert'); message.hidden = true;
	const summary = document.createElement('div'); summary.className = 'ai-session-changes__summary';
	const versions = document.createElement('ol'); versions.className = 'ai-session-changes__versions'; versions.setAttribute('aria-label', '변경 기록 버전');
	const files = document.createElement('ul'); files.className = 'ai-session-changes__files'; files.setAttribute('aria-label', '선택한 변경 기록 파일');
	parent.append(toolbar, status, message, summary, versions, files);
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
	let disposed = false;

	const render = (): void => {
		const focused = document.activeElement instanceof HTMLButtonElement && parent.contains(document.activeElement)
			? { version: document.activeElement.dataset.evidenceVersion, path: document.activeElement.dataset.filePath }
			: undefined;
	const firstVersion = snapshots.at(-1)?.version;
	const lastVersion = snapshots[0]?.version;
	const windowLabel = firstVersion !== undefined && lastVersion !== undefined ? `${latestWindow ? '최신 기록' : '기록'} · v${firstVersion}${firstVersion === lastVersion ? '' : `–v${lastVersion}`}` : '기록 없음';
	status.textContent = loading ? '변경 기록을 불러오는 중입니다.' : `${windowLabel} · 선택한 실행 ${currentContext.turnId}`;
		message.hidden = !errorText;
		message.textContent = errorText ? `변경 기록을 불러오지 못했습니다. ${errorText}` : '';
	older.disabled = loading || !hasMore;
		refresh.disabled = loading;
		versions.replaceChildren();
		for (const evidence of snapshots) {
			const item = document.createElement('li');
			const select = button(`v${evidence.version} · ${formatTime(evidence.capturedAt)}`);
			select.dataset.evidenceVersion = String(evidence.version);
			select.setAttribute('aria-pressed', String(evidence === selected));
			select.addEventListener('click', () => { selected = evidence; render(); });
			item.appendChild(select); versions.appendChild(item);
		}
		summary.replaceChildren(); files.replaceChildren();
		if (!selected) {
			const empty = document.createElement('p'); empty.className = 'ai-session-changes__empty';
			empty.textContent = loading ? '기록을 확인하고 있습니다.' : errorText ? '다시 새로고침해 주세요.' : '확인 가능한 변경 기록이 없습니다. 파일이 바뀌지 않았다는 뜻은 아닙니다.';
			summary.appendChild(empty); restoreFocus(focused); return;
		}
		const facts = document.createElement('p'); facts.className = 'ai-session-changes__facts';
		facts.textContent = `${selected.status === 'observed' ? '파일 상태 관찰됨' : '관찰 확인 불가'} · 범위 ${selected.coverage === 'complete' ? '전체' : '일부'} · 작성자 알 수 없음 · ${selected.source === 'managedWorktree' ? '관리 작업 트리' : '공유 폴더'} · ${formatTime(selected.capturedAt)}`;
		const fingerprint = document.createElement('code'); fingerprint.className = 'ai-session-changes__fingerprint'; fingerprint.textContent = `v${selected.version} · ${selected.fingerprint}`; fingerprint.title = selected.fingerprint;
		summary.append(facts, fingerprint);
		if (selected.missingReason) { appendNote(summary, `확인할 수 없는 이유: ${selected.missingReason}`); }
		if (selected.attribution === 'mixed' && selected.attributionNote) { appendNote(summary, `작성자 확인: 알 수 없음. ${selected.attributionNote}`); }
		if (selected.noChangesConfirmed) { appendNote(summary, '완전하게 관찰된 기록이며 바뀐 파일이 없습니다.'); }
		for (const file of selected.files) {
			const item = document.createElement('li'); item.className = 'ai-session-changes__file';
			const info = document.createElement('div'); info.className = 'ai-session-changes__file-info';
			const path = document.createElement('code'); path.textContent = file.path;
			const detail = document.createElement('span'); detail.textContent = `${changeLabel(file.change)}${file.previousPath ? ` · 이전 경로 ${file.previousPath}` : ''}`;
			info.append(path, detail);
			const canCompare = file.change !== 'renamed' && (file.before?.kind === 'file' || file.after?.kind === 'file');
			const open = button(canCompare ? '비교 열기' : file.change === 'renamed' ? '경로 변경 · 비교 불가' : '텍스트 비교 불가');
			open.dataset.filePath = file.path;
			open.disabled = selected.status !== 'observed' || !canCompare;
			if (canCompare) { open.addEventListener('click', () => void openFile(selected!, file.path)); }
			item.append(info, open); files.appendChild(item);
		}
		if (!selected.files.length && !selected.noChangesConfirmed) { appendNote(summary, '바뀐 파일 목록을 확인할 수 없습니다.'); }
		restoreFocus(focused);
	};

	const restoreFocus = (focused: { readonly version?: string; readonly path?: string } | undefined): void => {
		if (!focused) { return; }
		const target = focused.version !== undefined
			? [...versions.querySelectorAll<HTMLButtonElement>('button[data-evidence-version]')].find(element => element.dataset.evidenceVersion === focused.version)
			: focused.path !== undefined
				? [...files.querySelectorAll<HTMLButtonElement>('button[data-file-path]')].find(element => element.dataset.filePath === focused.path)
				: undefined;
		if (target && !target.disabled) { target.focus({ preventScroll: true }); }
	};

	const loadLatest = async (): Promise<void> => {
		if (disposed || loading) { return; }
		loading = true; errorText = undefined; const request = ++generation; const requested = currentContext; const source = currentActions; render();
		try {
			const latest = await source.latest();
			if (disposed || request !== generation || requested !== currentContext) { return; }
			if (latest && (latest.projectId !== requested.projectId || latest.sessionId !== requested.sessionId || latest.turnId !== requested.turnId)) { throw new Error('다른 실행의 기록을 받았습니다.'); }
			snapshots = latest ? [latest] : []; selected = latest ?? undefined; beforeVersion = latest?.version ?? 0; hasMore = !!latest; latestWindow = true;
		} catch (error) { if (!disposed && request === generation) { errorText = describe(error); } }
		finally { if (!disposed && request === generation) { loading = false; render(); } }
	};

	const loadOlder = async (): Promise<void> => {
		if (disposed || loading || !hasMore) { return; }
		loading = true; errorText = undefined; const request = ++generation; const requested = currentContext; const source = currentActions; render();
		try {
			const page = await source.list(beforeVersion, PAGE_SIZE);
			if (disposed || request !== generation || requested !== currentContext) { return; }
			assertPage(page, requested, beforeVersion);
			snapshots = [...page.snapshots];
			selected = snapshots[0];
			beforeVersion = page.nextVersion; hasMore = page.hasMore;
			latestWindow = false;
		} catch (error) { if (!disposed && request === generation) { errorText = describe(error); } }
		finally { if (!disposed && request === generation) { loading = false; render(); } }
	};

	const openFile = async (evidence: WorkspaceAgentChangeEvidenceDTO, path: string): Promise<void> => {
		if (disposed || loading) { return; }
		loading = true; errorText = undefined; const request = ++generation; const requested = currentContext; const source = currentActions; render();
		try {
			const result = await source.file(evidence, path);
			if (disposed || request !== generation || requested !== currentContext || evidence !== selected) { return; }
			if (!result || result.scope.projectId !== requested.projectId || result.scope.sessionId !== requested.sessionId || result.scope.turnId !== requested.turnId
				|| result.evidenceVersion !== evidence.version || result.evidenceFingerprint !== evidence.fingerprint || result.path !== path) { throw new Error('선택한 기록과 파일 내용이 일치하지 않습니다.'); }
			const before = sideText(result.before); const after = sideText(result.after);
			if (before === undefined || after === undefined) {
				const reason = result.before.state === 'unavailable' ? result.before.reason : result.after.state === 'unavailable' ? result.after.reason : '파일 내용을 보관하지 않았습니다.';
				throw new Error(`비교할 파일 내용을 사용할 수 없습니다. ${reason}`);
			}
			await source.openDiff(evidence, path, before, after, () => !disposed && request === generation && requested === currentContext && evidence === selected);
		} catch (error) { if (!disposed && request === generation) { errorText = describe(error); } }
		finally { if (!disposed && request === generation) { loading = false; render(); } }
	};

	refresh.addEventListener('click', () => void loadLatest()); older.addEventListener('click', () => void loadOlder());
	return {
		setContext(next, nextActions) { if (next.projectId === currentContext.projectId && next.sessionId === currentContext.sessionId && next.turnId === currentContext.turnId) { currentActions = nextActions; return; } currentContext = next; currentActions = nextActions; generation++; loading = false; snapshots = []; selected = undefined; beforeVersion = 0; hasMore = true; latestWindow = true; errorText = undefined; if (visible) { void loadLatest(); } else { render(); } },
		setVisible(next) { visible = next; if (next && !snapshots.length && !loading) { void loadLatest(); } },
		refresh() { void loadLatest(); },
		dispose() { disposed = true; generation++; parent.replaceChildren(); },
	};
}

function button(label: string): HTMLButtonElement { const element = document.createElement('button'); element.type = 'button'; element.className = 'ai-session-changes__button'; element.textContent = label; return element; }
function appendNote(parent: HTMLElement, value: string): void { const note = document.createElement('p'); note.className = 'ai-session-changes__note'; note.textContent = value; parent.appendChild(note); }
function changeLabel(change: WorkspaceAgentChangeEvidenceDTO['files'][number]['change']): string { return ({ created: '추가됨', modified: '수정됨', deleted: '삭제됨', renamed: '이름 변경', typeChanged: '종류 변경', symlinkChanged: '링크 변경' })[change]; }
function formatTime(value: string): string { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleString('ko-KR') : '시간 확인 불가'; }
function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sideText(side: WorkspaceAgentChangeFileDTO['before']): string | undefined { return side.state === 'absent' ? '' : side.state === 'text' ? side.file.content : undefined; }
function assertPage(page: WorkspaceAgentChangeEvidencePageDTO, context: SessionChangesContext, beforeVersion: number): void {
	if (!page || !Array.isArray(page.snapshots) || page.snapshots.some((item, index) => item.projectId !== context.projectId || item.sessionId !== context.sessionId || item.turnId !== context.turnId
		|| item.version >= beforeVersion || (index > 0 && item.version >= page.snapshots[index - 1].version))
		|| (page.snapshots.length > 0 && page.nextVersion !== page.snapshots.at(-1)?.version)) { throw new Error('다른 실행의 변경 기록을 받았습니다.'); }
}
