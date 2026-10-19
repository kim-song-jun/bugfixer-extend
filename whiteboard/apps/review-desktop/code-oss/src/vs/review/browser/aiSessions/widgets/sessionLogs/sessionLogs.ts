import type {
	AgentSessionTranscriptEntryDTO,
	AgentSessionTranscriptPageDTO,
	AgentSessionTranscriptPageOptions,
	AgentSessionTranscriptSeverity,
	AgentSessionTranscriptSource,
} from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';

export type SessionLogsPageLoader = (options: AgentSessionTranscriptPageOptions) => Promise<AgentSessionTranscriptPageDTO>;

export interface SessionLogsContext {
	readonly projectId: string;
	readonly sessionId: string;
	readonly turnId: string;
}

export interface SessionLogsActions {
	readonly loadPage: SessionLogsPageLoader;
	readonly copyText?: (text: string) => Promise<void>;
	readonly exportText?: (text: string, fileName: string, isCurrent: () => boolean) => Promise<boolean>;
	readonly onError?: (error: unknown) => void;
	readonly pollIntervalMs?: number;
}

export interface SessionLogsController {
	setVisible(visible: boolean): void;
	setConnected(connected: boolean): void;
	setContext(context: SessionLogsContext, loadPage: SessionLogsPageLoader): void;
	confirmContext(context: SessionLogsContext): Promise<boolean>;
	invalidateContext(): void;
	refresh(): void;
	dispose(): void;
}

const MAX_ENTRIES = 500;
const MAX_BYTES = 1024 * 1024;
const PAGE_ENTRIES = 100;
const PAGE_BYTES = 512 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 3000;
const MAX_GAP_MARKERS = 100;
const CONTEXT_CONFIRMATION_TIMEOUT_MS = 10_000;

type KindFilter = 'all' | 'terminal' | 'log';
type SeverityFilter = 'all' | AgentSessionTranscriptSeverity;
type SourceFilter = 'all' | AgentSessionTranscriptSource;

interface GapRange {
	readonly afterSequence: number;
	readonly throughSequence: number;
}

/** A bounded, incremental view of the retained transcript for the selected turn. */
export function createSessionLogs(parent: HTMLElement, initialContext: SessionLogsContext, actions: SessionLogsActions): SessionLogsController {
	parent.classList.add('ai-session-logs');
	parent.replaceChildren();

	const heading = document.createElement('header');
	heading.className = 'ai-session-logs__heading';
	const title = document.createElement('h2');
	title.textContent = '세션 로그';
	const distinction = document.createElement('p');
	distinction.className = 'ai-session-logs__distinction';
	distinction.textContent = '구조화 로그와 터미널 출력은 종류를 나누어 표시합니다. 이 화면은 현재 실행의 저장된 기록을 읽습니다.';
	heading.append(title, distinction);

	const toolbar = document.createElement('div');
	toolbar.className = 'ai-session-logs__toolbar';
	const kindSelect = makeSelect('기록 종류', [
		['all', '전체 기록'], ['log', '구조화 로그'], ['terminal', '터미널 출력'],
	]);
	const severitySelect = makeSelect('심각도', [
		['all', '모든 심각도'], ['debug', '디버그'], ['info', '정보'], ['warning', '경고'], ['error', '오류'],
	]);
	const sourceSelect = makeSelect('출처', [
		['all', '모든 출처'], ['pty', '터미널'], ['provider', 'AI 제공자'], ['host', '호스트'], ['workspace', '작업 공간'],
	]);
	const searchLabel = document.createElement('label');
	searchLabel.className = 'ai-session-logs__search';
	searchLabel.append(document.createTextNode('불러온 기록에서 검색'));
	const searchInput = document.createElement('input');
	searchInput.type = 'search';
	searchInput.autocomplete = 'off';
	searchInput.placeholder = '검색어';
	searchLabel.appendChild(searchInput);
	const followButton = makeButton('따라가기 켜짐');
	followButton.setAttribute('aria-pressed', 'true');
	const firstButton = makeButton('처음 기록 다시 읽기');
	const newerButton = makeButton('다음 기록 불러오기');
	const retryButton = makeButton('다시 시도');
	const copyButton = makeButton('불러온 기록 복사');
	const exportButton = makeButton('불러온 기록 내보내기');
	copyButton.disabled = !actions.copyText;
	exportButton.disabled = !actions.exportText;
	toolbar.append(kindSelect.wrapper, severitySelect.wrapper, sourceSelect.wrapper, searchLabel, followButton, firstButton, newerButton, retryButton, copyButton, exportButton);

	const status = document.createElement('p');
	status.className = 'ai-session-logs__status';
	status.setAttribute('role', 'status');
	status.setAttribute('aria-live', 'polite');
	const error = document.createElement('p');
	error.className = 'ai-session-logs__error';
	error.setAttribute('role', 'alert');
	error.hidden = true;
	const list = document.createElement('ol');
	list.className = 'ai-session-logs__entries';
	list.setAttribute('aria-label', '불러온 세션 기록');
	const viewport = document.createElement('div');
	viewport.className = 'ai-session-logs__viewport';
	viewport.tabIndex = 0;
	viewport.setAttribute('aria-label', '세션 기록 목록');
	viewport.appendChild(list);
	parent.append(heading, toolbar, status, error, viewport);

	let context = initialContext;
	let loadPage = actions.loadPage;
	let visible = false;
	let connected = true;
	let disposed = false;
	let follow = true;
	let requestGeneration = 0;
	let contextGeneration = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let loading = false;
	let hasMore = true;
	let highestSequence = 0;
	let cursor = 0;
	let retainedStart: number | null = null;
	let droppedEntries = 0;
	let droppedBytes = 0;
	let lastError: string | undefined;
	let entries: AgentSessionTranscriptEntryDTO[] = [];
	let gaps: GapRange[] = [];
	let collapsedGapCount = 0;
	let collapsedGapStart = 0;
	let collapsedGapEnd = 0;
	let kindFilter: KindFilter = 'all';
	let severityFilter: SeverityFilter = 'all';
	let sourceFilter: SourceFilter = 'all';
	let searchText = '';
	let confirmedContextKey: string | undefined;
	const contextConfirmations = new Set<{ readonly key: string; readonly resolve: (confirmed: boolean) => void; readonly timer: ReturnType<typeof setTimeout> }>();
	const contextKey = (value: SessionLogsContext): string => JSON.stringify([value.projectId, value.sessionId, value.turnId]);
	const settleContextConfirmations = (key: string, confirmed: boolean): void => {
		for (const pending of [...contextConfirmations]) {
			if (pending.key !== key) { continue; }
			contextConfirmations.delete(pending);
			clearTimeout(pending.timer);
			pending.resolve(confirmed);
		}
	};
	const cancelContextConfirmations = (): void => {
		for (const pending of contextConfirmations) { clearTimeout(pending.timer); pending.resolve(false); }
		contextConfirmations.clear();
	};

	const render = (): void => {
		const filtered = entries.filter(entry => matches(entry, kindFilter, severityFilter, sourceFilter, searchText));
		const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40;
		const active = document.activeElement;
		const restoreFocus = active instanceof HTMLElement && parent.contains(active) ? active : undefined;
		const oldTop = viewport.scrollTop;
		list.replaceChildren();
		for (const entry of filtered) {
			list.appendChild(renderEntry(entry));
		}
		for (const gap of gaps) {
			const marker = document.createElement('li');
			marker.className = 'ai-session-logs__gap';
			marker.setAttribute('role', 'note');
			marker.textContent = `기록 누락: 순번 ${gap.afterSequence + 1}–${gap.throughSequence} 구간을 보존된 기록에서 찾을 수 없습니다.`;
			list.insertBefore(marker, list.firstChild);
		}
		if (collapsedGapCount > 0) {
			const collapsed = document.createElement('li');
			collapsed.className = 'ai-session-logs__gap';
			collapsed.setAttribute('role', 'note');
			collapsed.textContent = `순번 ${collapsedGapStart}–${collapsedGapEnd} 사이의 이전 누락 구간 ${collapsedGapCount}개는 화면 한도에 따라 접어 표시합니다. 처음 기록 다시 읽기로 해당 페이지를 확인할 수 있습니다.`;
			list.insertBefore(collapsed, list.firstChild);
		}
		if (droppedEntries > 0) {
			const trim = document.createElement('li');
			trim.className = 'ai-session-logs__gap';
			trim.setAttribute('role', 'note');
			trim.textContent = `화면 한도에 따라 오래된 기록 ${droppedEntries}개 (${formatBytes(droppedBytes)})를 목록에서 잘랐습니다. 저장된 기록은 삭제하지 않았습니다.`;
			list.insertBefore(trim, list.firstChild);
		}
		if (restoreFocus?.isConnected) { restoreFocus.focus({ preventScroll: true }); }
		if (follow && nearBottom) { viewport.scrollTop = viewport.scrollHeight; }
		else { viewport.scrollTop = oldTop; }
		refreshStatus(filtered.length);
		newerButton.disabled = loading || !hasMore || cursor >= highestSequence;
		retryButton.hidden = !lastError;
		error.hidden = !lastError;
		error.textContent = lastError ? `기록을 불러오지 못했습니다: ${lastError}` : '';
	};

	const fetchPage = async (direction: 'newer' | 'refresh'): Promise<void> => {
		if (disposed || !visible || !connected || loading) { render(); return; }
		loading = true;
		lastError = undefined;
		const generation = ++requestGeneration;
		const requestedContext = context;
		const requestedContextKey = contextKey(requestedContext);
		const afterSequence = cursor;
		const options: AgentSessionTranscriptPageOptions = {
			afterSequence,
			limit: PAGE_ENTRIES,
			maxOutputBytes: PAGE_BYTES,
		};
		render();
		try {
			const page = await loadPage(options);
			if (disposed || generation !== requestGeneration || requestedContext !== context) { return; }
			applyPage(page, direction);
			confirmedContextKey = requestedContextKey;
		} catch (cause) {
			if (disposed || generation !== requestGeneration) { return; }
			connected = false;
			lastError = errorMessage(cause);
			actions.onError?.(cause);
		} finally {
			if (generation === requestGeneration) {
				loading = false;
				render();
				settleContextConfirmations(requestedContextKey, confirmedContextKey === requestedContextKey && !lastError);
			}
		}
	};

	const applyPage = (page: AgentSessionTranscriptPageDTO, _direction: 'newer' | 'refresh'): void => {
		highestSequence = Math.max(highestSequence, page.highestSequence);
		retainedStart = page.firstRetainedSequence;
		hasMore = page.hasMore;
		for (const gap of page.gaps) {
			if (gap.throughSequence > gap.afterSequence && !gaps.some(existing => existing.afterSequence === gap.afterSequence && existing.throughSequence === gap.throughSequence)) {
				gaps.push(gap);
			}
		}
		while (gaps.length > MAX_GAP_MARKERS) {
			const removed = gaps.shift()!;
			if (collapsedGapCount === 0) { collapsedGapStart = removed.afterSequence + 1; }
			collapsedGapEnd = removed.throughSequence;
			collapsedGapCount++;
		}
		const known = new Set(entries.map(entry => entry.sequence));
		const added = page.entries.filter(entry => !known.has(entry.sequence));
		entries = [...entries, ...added].sort((a, b) => a.sequence - b.sequence);
		cursor = Math.max(cursor, page.nextSequence);
		trimEntries();
	};
	const clearLoadedRecords = (): void => {
		entries = [];
		gaps = [];
		collapsedGapCount = 0;
		collapsedGapStart = 0;
		collapsedGapEnd = 0;
		cursor = 0;
		highestSequence = 0;
		retainedStart = null;
		droppedEntries = 0;
		droppedBytes = 0;
		hasMore = true;
		lastError = undefined;
	};

	const trimEntries = (): void => {
		let totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
		while (entries.length > MAX_ENTRIES || totalBytes > MAX_BYTES) {
			const removed = entries.shift();
			if (!removed) { break; }
			droppedEntries++;
			droppedBytes += removed.byteLength;
			totalBytes -= removed.byteLength;
		}
	};

	const refreshStatus = (visibleCount: number): void => {
		const range = entries.length ? `순번 ${entries[0].sequence}–${entries[entries.length - 1].sequence}` : '기록 없음';
		const highWater = highestSequence ? `저장된 마지막 순번 ${highestSequence}` : '저장된 기록 없음';
		const retained = retainedStart ? `보존 시작 순번 ${retainedStart}` : '보존된 기록 없음';
		const state = loading ? '불러오는 중' : !connected ? '연결 끊김 · 마지막으로 불러온 기록을 유지합니다.' : !follow ? '일시 정지 · 기록 저장은 계속됩니다.' : '연결됨';
		const empty = entries.length === 0 ? ' · 아직 불러온 기록이 없습니다.' : '';
		const localSearch = searchText ? ` · 현재 검색은 불러온 ${entries.length}개 기록에서만 수행합니다.` : '';
		status.textContent = `${state} · ${range} · ${visibleCount}/${entries.length}개 표시 · ${highWater} · ${retained}${empty}${localSearch}`;
	};

	const schedulePoll = (): void => {
		if (timer) { clearTimeout(timer); timer = undefined; }
		if (disposed || !visible || !connected || !follow) { return; }
		timer = setTimeout(() => {
			timer = undefined;
			void fetchPage('refresh').finally(schedulePoll);
		}, Math.max(1000, actions.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
	};

	const onFilterChange = (): void => {
		kindFilter = kindSelect.select.value as KindFilter;
		severityFilter = severitySelect.select.value as SeverityFilter;
		sourceFilter = sourceSelect.select.value as SourceFilter;
		searchText = searchInput.value.trim().toLocaleLowerCase();
		render();
	};
	kindSelect.select.addEventListener('change', onFilterChange);
	severitySelect.select.addEventListener('change', onFilterChange);
	sourceSelect.select.addEventListener('change', onFilterChange);
	searchInput.addEventListener('input', onFilterChange);
	const pauseFollowing = (): void => {
		follow = false;
		requestGeneration++;
		loading = false;
		if (timer) { clearTimeout(timer); timer = undefined; }
		followButton.setAttribute('aria-pressed', 'false');
		followButton.textContent = '따라가기 일시 정지';
		render();
	};
	followButton.addEventListener('click', () => {
		if (follow) { pauseFollowing(); return; }
		follow = true;
		followButton.setAttribute('aria-pressed', 'true');
		followButton.textContent = '따라가기 켜짐';
		viewport.scrollTop = viewport.scrollHeight;
		void fetchPage('refresh').finally(schedulePoll);
	});
	newerButton.addEventListener('click', () => { void fetchPage('newer'); });
	firstButton.addEventListener('click', () => {
		pauseFollowing();
		clearLoadedRecords();
		connected = true;
		void fetchPage('newer');
	});
	retryButton.addEventListener('click', () => { connected = true; void fetchPage('refresh'); });
	copyButton.addEventListener('click', () => { void transferLoaded('copy'); });
	exportButton.addEventListener('click', () => { void transferLoaded('export'); });
	viewport.addEventListener('scroll', () => {
		if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 40 && follow) {
			pauseFollowing();
		}
	});

	function renderEntry(entry: AgentSessionTranscriptEntryDTO): HTMLLIElement {
		const item = document.createElement('li');
		item.className = `ai-session-logs__entry ai-session-logs__entry--${entry.kind}`;
		const meta = document.createElement('div');
		meta.className = 'ai-session-logs__entry-meta';
		const kind = document.createElement('strong');
		kind.textContent = entry.kind === 'log' ? '구조화 로그' : '터미널 출력';
		const sequence = document.createElement('span');
		sequence.textContent = `#${entry.sequence}`;
		const time = document.createElement('time');
		time.dateTime = entry.createdAt;
		time.textContent = formatDate(entry.createdAt);
		meta.append(kind, sequence, time);
		if (entry.severity) { const severity = document.createElement('span'); severity.className = `ai-session-logs__severity ai-session-logs__severity--${entry.severity}`; severity.textContent = severityLabel(entry.severity); meta.appendChild(severity); }
		if (entry.source) { const source = document.createElement('span'); source.textContent = `출처 · ${sourceLabel(entry.source)}`; meta.appendChild(source); }
		const body = document.createElement('pre');
		body.className = 'ai-session-logs__entry-text';
		body.textContent = entry.text;
		item.append(meta, body);
		return item;
	}

	async function transferLoaded(kind: 'copy' | 'export'): Promise<void> {
		const transferContext = context;
		const transferGeneration = contextGeneration;
		const entryCount = entries.length;
		const isCurrent = (): boolean => !disposed && contextGeneration === transferGeneration && context === transferContext;
		const loadedText = serializeLoaded(entries, transferContext);
		try {
			if (kind === 'copy' && actions.copyText) {
				await actions.copyText(loadedText);
				if (isCurrent()) { status.textContent = `불러온 ${entryCount}개 기록을 복사했습니다. 전체 기록 내보내기가 아닙니다.`; }
			} else if (kind === 'export' && actions.exportText) {
				const saved = await actions.exportText(loadedText, `ai-session-${transferContext.sessionId}-${transferContext.turnId}-loaded.txt`, isCurrent);
				if (isCurrent()) {
					status.textContent = saved
						? `불러온 ${entryCount}개 기록을 내보냈습니다. 전체 기록 내보내기가 아닙니다.`
						: '내보내기를 취소했습니다.';
				}
			}
		} catch (cause) {
			if (!isCurrent()) { return; }
			lastError = errorMessage(cause);
			actions.onError?.(cause);
			render();
		}
	}

	render();
	return {
		setVisible(value): void {
			if (disposed || visible === value) { return; }
			visible = value;
			if (!visible) {
				cancelContextConfirmations();
				if (timer) { clearTimeout(timer); timer = undefined; }
				requestGeneration++;
				loading = false;
			} else if (follow || entries.length === 0) {
				void fetchPage(entries.length ? 'refresh' : 'newer').finally(schedulePoll);
			}
			render();
		},
		setConnected(value): void {
			if (disposed || connected === value) { return; }
			connected = value;
			if (!connected && timer) { clearTimeout(timer); timer = undefined; }
			if (connected && visible) { void fetchPage('refresh').finally(schedulePoll); }
			render();
		},
		setContext(value, nextLoadPage): void {
			if (disposed) { return; }
			cancelContextConfirmations();
			contextGeneration++;
			context = value;
			confirmedContextKey = undefined;
			loadPage = nextLoadPage;
			connected = true;
			requestGeneration++;
			loading = false;
			clearLoadedRecords();
			render();
			if (visible && connected) { void fetchPage('newer').finally(schedulePoll); }
		},
		confirmContext(value): Promise<boolean> {
			const key = contextKey(value);
			if (disposed || !visible || contextKey(context) !== key) { return Promise.resolve(false); }
			if (confirmedContextKey === key && !loading && !lastError) { return Promise.resolve(true); }
			return new Promise(resolve => {
				const timer = setTimeout(() => {
					for (const pending of contextConfirmations) {
						if (pending.key === key && pending.resolve === resolve) { contextConfirmations.delete(pending); break; }
					}
					resolve(false);
				}, CONTEXT_CONFIRMATION_TIMEOUT_MS);
				contextConfirmations.add({ key, resolve, timer });
				if (!loading) { void fetchPage('newer'); }
			});
		},
		invalidateContext(): void {
			if (disposed) { return; }
			cancelContextConfirmations();
			contextGeneration++;
			requestGeneration++;
			visible = false;
			loading = false;
			if (timer) { clearTimeout(timer); timer = undefined; }
			render();
		},
		refresh(): void { void fetchPage('refresh').finally(schedulePoll); },
		dispose(): void {
			if (disposed) { return; }
			disposed = true;
			cancelContextConfirmations();
			contextGeneration++;
			requestGeneration++;
			if (timer) { clearTimeout(timer); timer = undefined; }
			parent.replaceChildren();
		},
	};
}

function makeSelect(labelText: string, options: readonly (readonly [string, string])[]): { readonly wrapper: HTMLLabelElement; readonly select: HTMLSelectElement } {
	const wrapper = document.createElement('label');
	wrapper.className = 'ai-session-logs__filter';
	wrapper.append(document.createTextNode(labelText));
	const select = document.createElement('select');
	for (const [value, text] of options) {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = text;
		select.appendChild(option);
	}
	wrapper.appendChild(select);
	return { wrapper, select };
}

function makeButton(label: string): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'ai-session-logs__button';
	button.textContent = label;
	return button;
}

function matches(entry: AgentSessionTranscriptEntryDTO, kind: KindFilter, severity: SeverityFilter, source: SourceFilter, search: string): boolean {
	if (kind !== 'all' && entry.kind !== kind) { return false; }
	if (severity !== 'all' && entry.severity !== severity) { return false; }
	if (source !== 'all' && entry.source !== source) { return false; }
	return !search || `${entry.sequence} ${entry.kind} ${entry.severity ?? ''} ${entry.source ?? ''} ${entry.text}`.toLocaleLowerCase().includes(search);
}

function serializeLoaded(entries: readonly AgentSessionTranscriptEntryDTO[], context: SessionLogsContext): string {
	const header = [
		'# AI 세션 로그 · 불러온 기록만',
		`# 프로젝트: ${context.projectId}`,
		`# 세션: ${context.sessionId}`,
		`# 실행: ${context.turnId}`,
		`# 기록 수: ${entries.length}`,
		'# 전체 기록 내보내기가 아닙니다.',
		'',
	];
	const body = entries.map(entry => [
		`[${entry.sequence}] ${entry.createdAt} ${entry.kind === 'log' ? '구조화 로그' : '터미널 출력'}${entry.severity ? ` ${severityLabel(entry.severity)}` : ''}${entry.source ? ` · ${sourceLabel(entry.source)}` : ''}`,
		entry.text,
		'',
	].join('\n'));
	return [...header, ...body].join('\n');
}

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

function formatBytes(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function severityLabel(severity: AgentSessionTranscriptSeverity): string {
	return ({ debug: '디버그', info: '정보', warning: '경고', error: '오류' } satisfies Record<AgentSessionTranscriptSeverity, string>)[severity];
}

function sourceLabel(source: AgentSessionTranscriptSource): string {
	return ({ pty: '터미널', provider: 'AI 제공자', host: '호스트', workspace: '작업 공간' } satisfies Record<AgentSessionTranscriptSource, string>)[source];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
