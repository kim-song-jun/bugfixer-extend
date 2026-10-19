import type {
	AgentSessionPublicationEvent, AgentSessionPublicationOperationDTO,
	AgentSessionPublicationPageDTO, AgentSessionPublicationProposalDTO, WorkspaceAgentPublicationExecutionDTO,
	WorkspaceAgentPublicationMutationInput, WorkspaceAgentPublicationPageInput, WorkspaceAgentPublicationRecoveryInput,
	WorkspaceAgentPublicationScope, WorkspaceAgentPublicationTextPrepareInput, WorkspaceAgentPublicationAccountsDTO,
} from '../../../../../workspace/common/workspaceAgentPublicationProtocol.js';
import type { AgentSessionMergeProposalDTO } from '../../../../../workspace/common/workspaceAgentMergeProtocol.js';
import type { WorkspaceAgentPrTextSelection } from '../../../../../workspace/common/workspaceAgentPrTextHostProtocol.js';

const PAGE_SIZE = 5;

export interface SessionPublicationActions {
	readonly listPublicationAccounts: (scope: WorkspaceAgentPublicationScope) => Promise<WorkspaceAgentPublicationAccountsDTO>;
	readonly listPublicationProposals: (input: WorkspaceAgentPublicationPageInput) => Promise<AgentSessionPublicationPageDTO>;
	readonly preparePublicationProposal: (input: WorkspaceAgentPublicationTextPrepareInput) => Promise<AgentSessionPublicationProposalDTO>;
	readonly approvePublicationProposal: (input: WorkspaceAgentPublicationMutationInput) => Promise<{ readonly approved: boolean; readonly proposal: AgentSessionPublicationProposalDTO }>;
	readonly publishApprovedProposal: (input: WorkspaceAgentPublicationMutationInput) => Promise<WorkspaceAgentPublicationExecutionDTO>;
	readonly continuePublicationOperation: (input: WorkspaceAgentPublicationRecoveryInput) => Promise<WorkspaceAgentPublicationExecutionDTO>;
	readonly reconcilePublicationOperation: (input: WorkspaceAgentPublicationRecoveryInput) => Promise<WorkspaceAgentPublicationExecutionDTO>;
	readonly getPublicationOperation: (input: WorkspaceAgentPublicationMutationInput) => Promise<AgentSessionPublicationOperationDTO | null>;
}

interface SessionPublicationState {
	readonly render: (parent: HTMLElement, scope: WorkspaceAgentPublicationScope, actions: SessionPublicationActions, source: AgentSessionMergeProposalDTO, sourceIsCurrent: () => boolean, selectedText: WorkspaceAgentPrTextSelection | undefined, refresh: () => void) => void;
	readonly invalidate: () => void;
	readonly dispose: () => void;
}

export function createSessionPublication(): SessionPublicationState {
	let contextKey = '';
	let sourceKey = '';
	let generation = 0;
	let disposed = false;
	let proposalPage: AgentSessionPublicationPageDTO | undefined;
	let proposals: AgentSessionPublicationProposalDTO[] = [];
	let selectedProposalId: string | undefined;
	let operation: AgentSessionPublicationOperationDTO | null | undefined;
	let operationReadError = false;
	let accountPage: WorkspaceAgentPublicationAccountsDTO | undefined;
	let selectedAccountRef = '';
	let remoteName = 'origin';
	let baseRef = 'refs/heads/main';
	let status = '';
	let error = '';
	let busy = false;
	let proposalsLoading = false;
	let accountsLoading = false;
	let pageLoading = false;
	let initialListAttempted = false;
	let operationRefreshNeeded = false;
	let operationLoading = false;
	let operationReadToken = 0;
	let proposalDetailsOpen = false;
	let sourceIsCurrent: () => boolean = () => false;
	let refreshView: (() => void) | undefined;

	const reset = (): void => {
		generation++;
		operationReadToken++; proposalPage = undefined; proposals = []; selectedProposalId = undefined; operation = undefined; operationReadError = false; operationRefreshNeeded = false; operationLoading = false; proposalDetailsOpen = false;
		accountPage = undefined; selectedAccountRef = ''; remoteName = 'origin'; baseRef = 'refs/heads/main';
		status = ''; error = ''; busy = false; proposalsLoading = false; accountsLoading = false; pageLoading = false; initialListAttempted = false;
	};
	const isCurrent = (request: number, proposalId?: string): boolean => !disposed && request === generation && sourceIsCurrent() && (!proposalId || selectedProposalId === proposalId);
	const update = (): void => { if (!disposed) { refreshView?.(); } };
	const invalidate = (): void => { generation++; operationReadToken++; sourceIsCurrent = () => false; refreshView = undefined; busy = false; proposalsLoading = false; accountsLoading = false; pageLoading = false; operationLoading = false; operationRefreshNeeded = !!selectedProposalId; };
	const mutationInput = (scope: WorkspaceAgentPublicationScope, proposal: AgentSessionPublicationProposalDTO): WorkspaceAgentPublicationMutationInput => ({
		...scope, proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint,
	});

	const loadOperation = async (scope: WorkspaceAgentPublicationScope, actions: SessionPublicationActions, proposal: AgentSessionPublicationProposalDTO, request: number): Promise<void> => {
		const readToken = ++operationReadToken;
		operationLoading = true; operationReadError = false; operationRefreshNeeded = false; update();
		try {
			const result = await actions.getPublicationOperation(mutationInput(scope, proposal));
			if (readToken !== operationReadToken || !isCurrent(request, proposal.id)) { return; }
			operation = result; operationReadError = false;
		} catch {
			if (readToken !== operationReadToken || !isCurrent(request, proposal.id)) { return; }
			operationReadError = true; error = '저장된 게시 작업을 읽지 못했습니다. 민감한 응답은 표시하지 않습니다.';
		} finally { if (readToken === operationReadToken && isCurrent(request, proposal.id)) { operationLoading = false; } }
		if (readToken === operationReadToken && isCurrent(request, proposal.id)) { update(); }
	};

	const loadPage = async (scope: WorkspaceAgentPublicationScope, actions: SessionPublicationActions, source: AgentSessionMergeProposalDTO, request: number, afterRevision: number, append: boolean): Promise<void> => {
		if (proposalsLoading) { return; }
		proposalsLoading = true; pageLoading = append; error = ''; update();
		try {
			const page = await actions.listPublicationProposals({ ...scope, afterRevision, limit: PAGE_SIZE });
			if (!isCurrent(request)) { return; }
			if (!page || !Array.isArray(page.proposals) || page.proposals.length > PAGE_SIZE || page.proposals.some((item, index) => item.projectId !== scope.projectId || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId || (index > 0 && item.revision <= page.proposals[index - 1].revision)) || (page.proposals.length > 0 && page.nextRevision !== page.proposals.at(-1)?.revision)) {
				throw new Error('invalid publication proposal page');
			}
			proposalPage = page;
			proposals = append ? [...proposals, ...page.proposals] : [...page.proposals];
			if (proposals.length > PAGE_SIZE) { proposals = proposals.slice(-PAGE_SIZE); }
			if (!append && !selectedProposalId) {
				const matching = proposals.filter(item => item.sourceMergeId === source.id);
				selectedProposalId = matching.at(-1)?.id;
			}
			if (selectedProposalId && proposals.some(item => item.id === selectedProposalId)) {
				operationRefreshNeeded = true;
			}
		} catch {
			if (!isCurrent(request)) { return; }
			error = '초안 PR 기록을 불러오지 못했습니다. 다시 시도해 주세요.';
		} finally {
			if (isCurrent(request)) { proposalsLoading = false; pageLoading = false; update(); }
		}
	};

	const loadAccounts = async (scope: WorkspaceAgentPublicationScope, actions: SessionPublicationActions, request: number): Promise<void> => {
		if (accountsLoading) { return; }
		accountsLoading = true; error = ''; update();
		try {
			const result = await actions.listPublicationAccounts(scope);
			if (!isCurrent(request)) { return; }
			if (!result || !Array.isArray(result.accounts) || result.accounts.some(account => account.host !== 'github.com' || !account.accountRef || !account.login)) { throw new Error('invalid account metadata'); }
			accountPage = result;
			if (!result.accounts.some(account => account.accountRef === selectedAccountRef && account.state === 'success')) { selectedAccountRef = ''; }
			status = result.available ? '연결 가능한 GitHub 계정 목록을 확인했습니다.' : 'GitHub 계정을 사용할 수 없습니다.';
		} catch {
			if (!isCurrent(request)) { return; }
			accountPage = undefined; error = 'GitHub 계정 상태를 확인하지 못했습니다. 계정이나 인증 내용은 표시하지 않습니다.';
		} finally {
			if (isCurrent(request)) { accountsLoading = false; update(); }
		}
	};

	const perform = async (
		scope: WorkspaceAgentPublicationScope,
		actions: SessionPublicationActions,
		proposal: AgentSessionPublicationProposalDTO,
		source: AgentSessionMergeProposalDTO,
		request: number,
		kind: 'publish' | 'continue' | 'reconcile',
	): Promise<void> => {
		const isLiveProposal = (): boolean => proposal.sourceMergeId === source.id && source.state === 'merged' && source.fingerprint === proposal.sourceMergeFingerprint && Date.parse(proposal.expiresAt) > Date.now() && sourceIsCurrent();
		const currentProposal = isLiveProposal();
		if (busy || !isCurrent(request, proposal.id) || operationRefreshNeeded || operationLoading || operationReadError ||
			(kind !== 'reconcile' && (!currentProposal || proposal.approval?.proposalFingerprint !== proposal.fingerprint)) ||
			(kind === 'publish' && operation !== null) || (kind === 'continue' && !canContinueOperation(operation, proposal)) ||
			((kind === 'continue' || kind === 'reconcile') && !operation)) { return; }
		busy = true; error = ''; status = kind === 'reconcile' ? 'GitHub의 현재 상태를 읽고 있습니다.' : 'GitHub 초안 PR 작업을 진행하고 있습니다.'; update();
		try {
			const input = mutationInput(scope, proposal);
			const recoveryInput = { ...input, operationId: operation?.id ?? '' };
			const result = kind === 'reconcile'
				? await actions.reconcilePublicationOperation(recoveryInput)
				: kind === 'continue'
					? await actions.continuePublicationOperation(recoveryInput)
					: await actions.publishApprovedProposal(input);
			if (!isCurrent(request, proposal.id)) { return; }
			if (!result || result.proposal.id !== proposal.id || result.proposal.fingerprint !== proposal.fingerprint || result.operation.proposalId !== proposal.id) { throw new Error('publication response mismatch'); }
			proposals = proposals.map(item => item.id === proposal.id ? result.proposal : item);
			selectedProposalId = result.proposal.id; operation = result.operation; operationReadError = false;
			status = result.operation.state === 'published' ? '초안 PR이 GitHub에서 확인되었습니다.' : result.operation.state === 'recoveryRequired' ? '원격 상태 확인이 더 필요합니다. 새 쓰기 작업 없이 다시 조회할 수 있습니다.' : result.operation.state === 'notPublished' ? '외부에 생성된 PR이 없음을 확인했습니다.' : result.operation.state === 'failed' ? '작업이 실패했습니다. 기록된 외부 변경을 확인해 주세요.' : '게시 작업이 기록되었습니다.';
		} catch {
			if (!isCurrent(request, proposal.id)) { return; }
			try {
				const observed = await actions.getPublicationOperation(mutationInput(scope, proposal));
				if (!isCurrent(request, proposal.id)) { return; }
				operation = observed; operationReadError = false;
			} catch {
				if (!isCurrent(request, proposal.id)) { return; }
				operationReadError = true;
			}
			error = '초안 PR 작업을 확인하지 못했습니다. 저장된 기록을 다시 조회해 주세요.';
		} finally {
			if (isCurrent(request, proposal.id)) { busy = false; update(); }
		}
	};

	const render = (parent: HTMLElement, scope: WorkspaceAgentPublicationScope, actions: SessionPublicationActions, source: AgentSessionMergeProposalDTO, isSourceCurrent: () => boolean, selectedText: WorkspaceAgentPrTextSelection | undefined, refresh: () => void): void => {
		const nextContextKey = `${scope.projectId}:${scope.sessionId}:${scope.turnId}`;
		const nextSourceKey = `${source.id}:${source.fingerprint}:${source.outcomes.at(-1)?.receipt.resultingHead ?? ''}`;
		if (contextKey !== nextContextKey || sourceKey !== nextSourceKey) {
			contextKey = nextContextKey; sourceKey = nextSourceKey; reset();
		}
		sourceIsCurrent = isSourceCurrent;
		refreshView = refresh;
		const request = generation;
		const section = document.createElement('section'); section.className = 'ai-session-publication'; section.setAttribute('aria-label', 'GitHub 초안 PR');
		const heading = document.createElement('h4'); heading.textContent = 'GitHub 초안 PR'; section.appendChild(heading);
		appendText(section, 'ai-session-publication__note', '완료된 로컬 병합 결과를 GitHub에 초안 PR로 게시합니다. PR 작성은 별도 사람 승인 뒤에 진행합니다.');
		appendText(section, 'ai-session-publication__facts', `로컬 병합 ${source.id} · 작업 ${source.outcomes.at(-1)?.receipt.operationId ?? '—'} · 결과 HEAD ${source.outcomes.at(-1)?.receipt.resultingHead ?? '확인할 수 없음'}`);
		if (selectedText) {
			appendText(section, 'ai-session-publication__facts', `선택한 저장 PR 문구 v${selectedText.revision} · 지문 ${selectedText.contentHash}`);
		} else {
			appendText(section, 'ai-session-publication__note', '위의 PR 문안을 먼저 저장해 주세요. 저장한 제목과 본문으로 검토안을 준비합니다.');
		}
		const artifact = source.artifacts.find(item => item.event.phase === 'published');
		if (artifact?.event.phase === 'published') { appendText(section, 'ai-session-publication__facts', `로컬 병합 기준 ${artifact.event.targetRef} · ${artifact.event.resultingHead}`); }
		if (error) { appendText(section, 'ai-session-publication__error', error); }
		if (status) { appendText(section, 'ai-session-publication__status', status); }
		if (accountsLoading) { appendText(section, 'ai-session-publication__status', 'GitHub 계정 연결 상태를 확인하는 중입니다.'); }
		const discover = button(accountsLoading ? '계정 확인 중…' : accountPage ? 'GitHub 계정 상태 다시 확인' : 'GitHub 계정 확인', 'publication-discover-account'); discover.disabled = accountsLoading || busy; discover.addEventListener('click', () => void loadAccounts(scope, actions, request)); section.appendChild(discover);
		let prepareButton: HTMLButtonElement | undefined;
		const syncPrepareDisabled = (): void => {
			if (prepareButton) { prepareButton.disabled = busy || proposalsLoading || !proposalPage || !selectedText || !accountPage?.available || !accountPage.accounts.some(account => account.accountRef === selectedAccountRef && account.state === 'success') || !isRemoteName(remoteName) || !baseRef.trim(); }
		};
		if (accountPage) {
			const accountLabel = fieldLabel('GitHub 계정'); const accountSelect = document.createElement('select'); accountSelect.dataset.focusKey = 'publication-account'; accountSelect.setAttribute('aria-label', 'GitHub 계정');
			const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '사용할 GitHub 계정을 선택하세요'; accountSelect.appendChild(placeholder);
			for (const account of accountPage.accounts) { const option = document.createElement('option'); option.value = account.accountRef; option.textContent = `github.com · ${account.login}${account.active ? ' · 기본 계정' : account.state === 'success' ? '' : ' · 연결 필요'}`; option.disabled = account.state !== 'success'; accountSelect.appendChild(option); }
			accountSelect.value = selectedAccountRef; accountSelect.disabled = busy || !accountPage.available; accountSelect.addEventListener('change', () => { selectedAccountRef = accountSelect.value; update(); }); accountLabel.appendChild(accountSelect); section.appendChild(accountLabel);
			if (!accountPage.available) { appendText(section, 'ai-session-publication__note', '사용 가능한 GitHub 계정이 없습니다. 연결 상태를 확인해 주세요.'); }
			const remote = textInput('원격 이름', remoteName); remote.input.maxLength = 64; remote.input.addEventListener('input', () => { remoteName = remote.input.value; syncPrepareDisabled(); }); section.appendChild(remote.label);
			const base = textInput('기준 브랜치', baseRef); base.input.placeholder = 'refs/heads/main'; base.input.addEventListener('input', () => { baseRef = base.input.value; syncPrepareDisabled(); }); section.appendChild(base.label);
			prepareButton = button('초안 PR 제안 고정', 'publication-prepare'); syncPrepareDisabled(); prepareButton.addEventListener('click', () => void thisPrepare()); section.appendChild(prepareButton);
		}
		if (proposalsLoading && !proposalPage) { appendText(section, 'ai-session-publication__status', '저장된 초안 PR 제안을 불러오는 중입니다.'); }
		if (initialListAttempted && !proposalPage && !proposalsLoading) { const retry = button('초안 PR 기록 다시 불러오기', 'publication-retry-list'); retry.disabled = busy; retry.addEventListener('click', () => void loadPage(scope, actions, source, request, 0, false)); section.appendChild(retry); }
		if (proposalPage && !proposals.length) { appendText(section, 'ai-session-publication__empty', '저장된 초안 PR 제안이 없습니다.'); }
		if (proposals.length) {
			const list = document.createElement('ol'); list.className = 'ai-session-publication__history'; list.setAttribute('aria-label', '초안 PR 제안 기록');
			for (const proposal of proposals) {
				const item = document.createElement('li'); const select = button(`v${proposal.revision} · ${proposal.title} · ${proposal.sourceMergeId === source.id ? '현재 로컬 병합' : '다른 로컬 병합'}`, `publication-proposal:${proposal.id}`); select.setAttribute('aria-pressed', String(proposal.id === selectedProposalId)); select.disabled = busy || proposalsLoading; select.addEventListener('click', () => { selectedProposalId = proposal.id; operation = undefined; operationRefreshNeeded = false; status = ''; error = ''; void loadOperation(scope, actions, proposal, request); update(); }); item.appendChild(select); list.appendChild(item);
			}
			section.appendChild(list);
			if (proposalPage?.hasMore) { const next = button(pageLoading ? '기록 불러오는 중…' : '다음 제안 기록', 'publication-next-page'); next.disabled = pageLoading || busy; next.addEventListener('click', () => void loadPage(scope, actions, source, request, proposalPage!.nextRevision, true)); section.appendChild(next); }
			const proposal = proposals.find(item => item.id === selectedProposalId);
			if (proposal) { renderProposal(section, proposal, source, scope, actions, request); }
		}
		parent.appendChild(section);
		if (!proposalPage && !proposalsLoading && !initialListAttempted && source.state === 'merged') {
			queueMicrotask(() => { if (!disposed && request === generation && sourceIsCurrent() && !proposalPage && !proposalsLoading && !initialListAttempted) { initialListAttempted = true; void loadPage(scope, actions, source, request, 0, false); } });
		}
		if (operationRefreshNeeded && selectedProposalId) {
			const selected = proposals.find(item => item.id === selectedProposalId);
			if (selected && !operationLoading) { queueMicrotask(() => { if (!disposed && request === generation && sourceIsCurrent() && operationRefreshNeeded && !operationLoading) { void loadOperation(scope, actions, selected, request); } }); }
		}

		async function thisPrepare(): Promise<void> {
			if (!isCurrent(request) || busy || !selectedAccountRef || !proposalPage || !selectedText) { return; }
			if (!isRemoteName(remoteName)) { error = '원격 이름을 입력해 주세요. 원격 URL은 입력할 수 없습니다.'; update(); return; }
			const revision = Math.max(0, ...proposals.map(item => item.revision));
			busy = true; status = '검토용 초안 PR 제안을 저장하고 있습니다.'; error = ''; update();
			try {
				const created = await actions.preparePublicationProposal({ ...scope, sourceMergeId: source.id, remoteName: remoteName.trim(), baseRef: baseRef.trim(), accountRef: selectedAccountRef,
					textRevision: selectedText, expectedRevision: revision });
				if (!isCurrent(request)) { return; }
				if (created.projectId !== scope.projectId || created.sessionId !== scope.sessionId || created.turnId !== scope.turnId || created.sourceMergeId !== source.id) { throw new Error('proposal scope mismatch'); }
				proposals = [...proposals.filter(item => item.id !== created.id), created].sort((left, right) => left.revision - right.revision).slice(-PAGE_SIZE);
				proposalPage = { proposals, nextRevision: created.revision, hasMore: proposalPage?.hasMore ?? false };
				selectedProposalId = created.id; operation = null; operationReadError = false; status = '제안이 저장되었습니다. 고정된 원격 정보와 전체 변경 내용을 확인한 뒤 사람 승인을 진행하세요.';
			} catch { if (isCurrent(request)) { error = '초안 PR 제안을 저장하지 못했습니다. 입력과 기록 상태를 확인해 주세요.'; } }
			finally { if (isCurrent(request)) { busy = false; update(); } }
		}
	};

	const renderProposal = (parent: HTMLElement, proposal: AgentSessionPublicationProposalDTO, source: AgentSessionMergeProposalDTO, scope: WorkspaceAgentPublicationScope, actions: SessionPublicationActions, request: number): void => {
		const detail = document.createElement('div'); detail.className = 'ai-session-publication__detail';
		const heading = document.createElement('h5'); heading.textContent = `고정된 초안 PR 제안 v${proposal.revision}`; detail.appendChild(heading);
		appendText(detail, 'ai-session-publication__facts', `계정 github.com · ${proposal.account.login}`);
		appendText(detail, 'ai-session-publication__facts', `저장소 ${proposal.remote.owner}/${proposal.remote.repository} · ${proposal.remote.visibility} · ${proposal.remote.canonicalUrl}`);
		appendText(detail, 'ai-session-publication__facts', `기준 ${proposal.baseRef} @ ${proposal.baseOid} · 게시 브랜치 ${proposal.publicationRef} · 예상 HEAD ${proposal.resultCommit}`);
		const unknownCount = proposal.diff.paths.reduce((total, path) => total + path.unknowns.length, 0);
		appendText(detail, 'ai-session-publication__note', `초안 PR · ${proposal.diff.paths.length}개 변경 경로 · 확인되지 않은 항목 ${unknownCount}개 · 기존 원격 브랜치는 덮어쓰지 않습니다.`);
		appendText(detail, 'ai-session-publication__facts', `고정된 제목: ${proposal.title}`);
		appendText(detail, 'ai-session-publication__facts', `고정된 설명: ${proposal.body || '(비어 있음)'}`);
		const proposalDetails = document.createElement('details'); proposalDetails.className = 'ai-session-publication__provenance'; proposalDetails.open = proposalDetailsOpen;
		const proposalSummary = document.createElement('summary'); proposalSummary.dataset.focusKey = `publication-details:${proposal.id}`; proposalSummary.textContent = '승인 대상 상세 정보'; proposalDetails.appendChild(proposalSummary);
		proposalDetails.addEventListener('toggle', () => { proposalDetailsOpen = proposalDetails.open; });
		appendText(proposalDetails, 'ai-session-publication__facts', `제안 ${proposal.id} · 지문 ${proposal.fingerprint} · 만료 ${proposal.expiresAt}`);
		appendText(proposalDetails, 'ai-session-publication__facts', `계정 ID ${proposal.account.stableId} · 저장소 ID ${proposal.remote.repositoryId} · GitHub 호스트 ${proposal.remote.host}`);
		appendText(proposalDetails, 'ai-session-publication__facts', `예상 이전 원격 HEAD ${proposal.expectedOldRemoteOid ?? '없음'}`);
		appendText(proposalDetails, 'ai-session-publication__facts', `로컬 병합 ${proposal.sourceMergeId} · 통합 소유자 ${proposal.integrationOwnerId} · 병합 작업 ${proposal.sourceMergeOperationId}`);
		appendText(proposalDetails, 'ai-session-publication__facts', `로컬 병합 artifact ${proposal.publishedArtifact.targetRef} · 결과 ${proposal.publishedArtifact.resultingHead} · generation ${proposal.publishedArtifact.currentGenerationId}${proposal.publishedArtifact.priorGenerationId ? ` · 이전 ${proposal.publishedArtifact.priorGenerationId}` : ''}`);
		appendText(proposalDetails, 'ai-session-publication__facts', `차이 ${proposal.diff.baseCommit} → ${proposal.diff.headCommit} · 전체 diff SHA-256 ${proposal.diff.fingerprint}`);
		appendText(proposalDetails, 'ai-session-publication__facts', `GitHub 초안: ${proposal.draft ? '예' : '아니요'}`);
		detail.appendChild(proposalDetails);
		const paths = document.createElement('ol'); paths.className = 'ai-session-publication__paths'; paths.setAttribute('aria-label', '고정된 변경 경로와 검토 근거');
		for (const path of proposal.diff.paths) {
			const item = document.createElement('li'); const label = document.createElement('code'); label.textContent = `${path.status} · ${path.path}${path.previousPath ? ` ← ${path.previousPath}` : ''}`; item.appendChild(label);
			if (path.explanationReferences.length) { appendText(item, 'ai-session-publication__note', `설명 참조: ${path.explanationReferences.join(', ')}`); }
			if (path.checkReferences.length) { appendText(item, 'ai-session-publication__note', `검사 참조: ${path.checkReferences.join(', ')}`); }
			for (const unknown of path.unknowns) { appendText(item, 'ai-session-publication__warning', `확인되지 않음: ${unknown}`); }
			paths.appendChild(item);
		}
		detail.appendChild(paths);
		const diff = document.createElement('pre'); diff.className = 'ai-session-publication__diff'; diff.dataset.focusKey = `publication-diff:${proposal.id}`; diff.tabIndex = 0; diff.setAttribute('aria-label', '고정된 전체 base부터 결과까지 diff'); diff.textContent = proposal.diff.text; detail.appendChild(diff);
		appendText(detail, 'ai-session-publication__note', `게시할 내용은 초안입니다. 로컬 병합 결과 ${source.outcomes.at(-1)?.receipt.resultingHead ?? proposal.resultCommit}을 원본으로 사용합니다.`);
		if (proposal.approval) { appendText(detail, 'ai-session-publication__facts', `사람 승인 · ${proposal.approval.approvedAt} · 승인 지문 ${proposal.approval.proposalFingerprint}`); }
		if (operationLoading) { appendText(detail, 'ai-session-publication__status', '저장된 게시 작업을 새로 조회하고 있습니다.'); }
		else if (operation === undefined && !operationReadError) { appendText(detail, 'ai-session-publication__status', '저장된 작업 기록을 확인하고 있습니다.'); }
		if (operationReadError) { appendText(detail, 'ai-session-publication__warning', '저장된 작업을 읽지 못해 외부 쓰기 작업을 막았습니다. 먼저 작업 기록을 다시 조회해 주세요.'); }
		if (operation) { renderOperation(detail, operation, proposal); }
		const isLiveProposal = (): boolean => proposal.sourceMergeId === source.id && source.state === 'merged' && source.fingerprint === proposal.sourceMergeFingerprint && Date.parse(proposal.expiresAt) > Date.now() && sourceIsCurrent();
		const currentProposal = isLiveProposal();
		const operationReadReady = !operationRefreshNeeded && !operationLoading && !operationReadError;
		const controls = document.createElement('div'); controls.className = 'ai-session-publication__actions';
		if (currentProposal && !proposal.approval && operation === null && operationReadReady) {
			const approve = button('승인하고 초안 PR 만들기', 'publication-approve-and-publish'); approve.disabled = busy; approve.addEventListener('click', () => void approveAndPublish()); controls.appendChild(approve);
		} else if (currentProposal && proposal.approval?.proposalFingerprint === proposal.fingerprint && operation === null && operationReadReady) {
			const publish = button('승인된 제안으로 초안 PR 만들기', 'publication-publish-approved'); publish.disabled = busy; publish.addEventListener('click', () => void perform(scope, actions, proposal, source, request, 'publish')); controls.appendChild(publish);
		}
		if (currentProposal && proposal.approval?.proposalFingerprint === proposal.fingerprint && operationReadReady && canContinueOperation(operation, proposal)) {
			const proceed = button('확인된 브랜치로 초안 PR 이어 만들기', 'publication-continue'); proceed.disabled = busy; proceed.addEventListener('click', () => void perform(scope, actions, proposal, source, request, 'continue')); controls.appendChild(proceed);
		}
		if (operationReadError) {
			const reload = button('게시 작업 기록 다시 조회', 'publication-reload-operation'); reload.disabled = busy; reload.addEventListener('click', () => void loadOperation(scope, actions, proposal, request)); controls.appendChild(reload);
		}
		if (operation && operationReadReady && (operation.state === 'started' || operation.state === 'recoveryRequired')) {
			const reconcile = button('GitHub 상태 다시 조회', 'publication-reconcile'); reconcile.disabled = busy; reconcile.addEventListener('click', () => void perform(scope, actions, proposal, source, request, 'reconcile')); controls.appendChild(reconcile);
		}
		if (!currentProposal) { appendText(detail, 'ai-session-publication__warning', '현재 선택한 로컬 병합과 승인 만료 상태가 이 제안과 일치하지 않아 새 외부 작업은 진행할 수 없습니다.'); }
		if (proposal.approval && proposal.approval.proposalFingerprint !== proposal.fingerprint) { appendText(detail, 'ai-session-publication__warning', '승인 지문이 제안과 일치하지 않습니다. 게시 작업을 막았습니다.'); }
		detail.appendChild(controls); parent.appendChild(detail);

		async function approveAndPublish(): Promise<void> {
			if (!isCurrent(request, proposal.id) || busy || !isLiveProposal() || proposal.approval || operation !== null || operationRefreshNeeded || operationLoading || operationReadError) { return; }
			busy = true; error = ''; status = '사람 승인 확인을 요청하고 있습니다.'; update();
			try {
				const result = await actions.approvePublicationProposal(mutationInput(scope, proposal));
				if (!isCurrent(request, proposal.id)) { return; }
				if (!result.approved) { status = '승인이 취소되었습니다. 외부 게시를 시작하지 않았습니다.'; proposals = proposals.map(item => item.id === proposal.id ? result.proposal : item); return; }
				if (result.proposal.id !== proposal.id || result.proposal.fingerprint !== proposal.fingerprint || result.proposal.approval?.proposalFingerprint !== proposal.fingerprint || !isCurrent(request, proposal.id) || !isLiveProposal()) { throw new Error('approved proposal mismatch'); }
				proposals = proposals.map(item => item.id === proposal.id ? result.proposal : item); status = '승인되었습니다. 같은 로컬 병합과 세션이 유지되어 초안 PR을 진행합니다.'; update();
				if (!isCurrent(request, proposal.id) || !isLiveProposal() || operation !== null || operationRefreshNeeded || operationLoading || operationReadError) { return; }
				const published = await actions.publishApprovedProposal(mutationInput(scope, result.proposal));
				if (!isCurrent(request, proposal.id)) { return; }
				if (published.proposal.fingerprint !== proposal.fingerprint || published.operation.proposalId !== proposal.id) { throw new Error('publication response mismatch'); }
				proposals = proposals.map(item => item.id === proposal.id ? published.proposal : item); operation = published.operation;
				status = published.operation.state === 'published' ? '초안 PR이 GitHub에서 확인되었습니다.' : '게시 작업이 저장되었습니다. 실제 외부 상태를 확인해 주세요.';
			} catch {
				if (!isCurrent(request, proposal.id)) { return; }
				try {
					const observed = await actions.getPublicationOperation(mutationInput(scope, proposal));
					if (!isCurrent(request, proposal.id)) { return; }
					operation = observed; operationReadError = false;
				} catch {
					if (!isCurrent(request, proposal.id)) { return; }
					operationReadError = true;
				}
				error = '승인 또는 게시 상태를 확인하지 못했습니다. 저장된 작업 기록을 다시 조회해 주세요.';
			} finally { if (isCurrent(request, proposal.id)) { busy = false; update(); } }
		}
	};

	const renderOperation = (parent: HTMLElement, value: AgentSessionPublicationOperationDTO, proposal: AgentSessionPublicationProposalDTO): void => {
		appendText(parent, 'ai-session-publication__facts', `게시 작업 ${value.id} · ${operationLabel(value.state)} · 마지막 기록 v${value.revision}`);
		appendText(parent, 'ai-session-publication__facts', `작업에 고정된 계정 ${value.accountStableId} · 저장소 ${value.repositoryId} · 브랜치 ${value.publicationRef} · 예상 이전 원격 HEAD ${value.expectedOldRemoteOid ?? '없음'} · 게시 HEAD ${value.headOid}`);
		const timeline = document.createElement('ol'); timeline.className = 'ai-session-publication__events'; timeline.setAttribute('aria-label', '초안 PR 게시 단계 기록');
		for (const record of value.events) {
			const item = document.createElement('li'); item.className = 'ai-session-publication__event';
			appendText(item, 'ai-session-publication__facts', `v${record.revision} · ${eventLabel(record.event)} · ${record.recordedAt}`);
			const event = record.event;
			if (event.type === 'branchObserved' || event.type === 'branchReobserved') { appendText(item, 'ai-session-publication__note', `브랜치 ${proposal.publicationRef} · ${event.oid ?? 'OID 없음'} · ${event.outcome} · ${event.errorCode}`); }
			if (event.type === 'pullRequestObserved' || event.type === 'pullRequestReobserved') {
				appendText(item, 'ai-session-publication__note', `PR ${event.id ?? 'ID 없음'} · 저장소 ${event.repositoryId} · ${event.headRef}@${event.headOid} → ${event.baseRef}@${event.baseOid} · 초안 ${event.draft ? '예' : '아니요'} · ${event.outcome} · ${event.errorCode}`);
				const safeUrl = trustedPullRequestUrl(event.url, proposal, event.id, event.repositoryId);
				if (safeUrl) { const link = document.createElement('a'); link.href = safeUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'GitHub PR 열기'; item.appendChild(link); }
			}
			if (event.type === 'published') {
				appendText(item, 'ai-session-publication__note', `PR ${event.pullRequestId} · 브랜치 ${proposal.publicationRef}@${event.branchOid} · PR head ${event.headOid} · 기준 ${event.baseRef} · 초안 ${event.draft ? '예' : '아니요'}`);
				const safeUrl = trustedPullRequestUrl(event.url, proposal, event.pullRequestId, value.repositoryId);
				if (safeUrl) { const link = document.createElement('a'); link.href = safeUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'GitHub PR 열기'; item.appendChild(link); }
			}
			if (event.type === 'recoveryRequired' || event.type === 'notPublished' || event.type === 'failed') { appendText(item, 'ai-session-publication__warning', `PR ID ${event.pullRequestId ?? '없음'} · 브랜치 HEAD ${event.branchOid ?? '없음'}`); }
			timeline.appendChild(item);
		}
		parent.appendChild(timeline);
	};

	return { render, invalidate, dispose: () => { disposed = true; reset(); refreshView = undefined; } };
}

function canContinueOperation(operation: AgentSessionPublicationOperationDTO | null | undefined, proposal: AgentSessionPublicationProposalDTO): boolean {
	if (!operation || operation.proposalId !== proposal.id || operation.proposalFingerprint !== proposal.fingerprint || operation.state !== 'started') { return false; }
	const last = operation.events.at(-1)?.event;
	return last?.type === 'branchObserved' && last.outcome === 'created' && last.oid === proposal.resultCommit && !operation.events.some(record => record.event.type === 'pullRequestWriteStarted');
}

function trustedPullRequestUrl(value: string | null, proposal: AgentSessionPublicationProposalDTO, id: string | null, repositoryId: string): string | null {
	if (!value || !id || repositoryId !== proposal.remote.repositoryId || proposal.remote.host !== 'github.com' || !/^\d+$/u.test(id)) { return null; }
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.host === 'github.com' && !url.username && !url.password && !url.search && !url.hash && url.pathname === `/${proposal.remote.owner}/${proposal.remote.repository}/pull/${id}` ? url.toString() : null;
	} catch { return null; }
}

function appendText(parent: HTMLElement, className: string, value: string): void {
	const element = document.createElement('p'); element.className = className; element.textContent = value;
	if (className.endsWith('__status')) { element.setAttribute('role', 'status'); }
	if (className.endsWith('__error') || className.endsWith('__warning')) { element.setAttribute('role', 'alert'); }
	parent.appendChild(element);
}
function isRemoteName(value: string): boolean { return /^[A-Za-z0-9._-]{1,64}$/u.test(value.trim()); }
function button(label: string, focusKey?: string): HTMLButtonElement { const element = document.createElement('button'); element.type = 'button'; element.className = 'ai-session-changes__button'; element.textContent = label; if (focusKey) { element.dataset.focusKey = focusKey; } return element; }
function fieldLabel(label: string): HTMLLabelElement { const element = document.createElement('label'); element.className = 'ai-session-publication__field'; const title = document.createElement('span'); title.textContent = label; element.appendChild(title); return element; }
function textInput(label: string, value: string): { readonly label: HTMLLabelElement; readonly input: HTMLInputElement } {
	const container = fieldLabel(label); const input = document.createElement('input'); input.type = 'text'; input.className = 'ai-session-publication__input'; input.dataset.focusKey = `publication-input:${label}`; input.value = value; input.setAttribute('aria-label', label); container.appendChild(input); return { label: container, input };
}
function operationLabel(value: AgentSessionPublicationOperationDTO['state']): string { return value === 'started' ? '진행 중 또는 조회 필요' : value === 'published' ? '게시 확인됨' : value === 'recoveryRequired' ? '복구 조회 필요' : value === 'notPublished' ? '게시되지 않음' : '실패'; }
function eventLabel(value: AgentSessionPublicationEvent): string {
	switch (value.type) {
		case 'branchWriteStarted': return '원격 브랜치 쓰기 시작';
		case 'branchObserved': return '브랜치 결과 관찰';
		case 'branchReobserved': return '브랜치 상태 재조회';
		case 'pullRequestWriteStarted': return 'GitHub PR 쓰기 시작';
		case 'pullRequestObserved': return 'PR 결과 관찰';
		case 'pullRequestReobserved': return 'PR 상태 재조회';
		case 'published': return '초안 PR 게시 확인';
		case 'recoveryRequired': return '복구 필요';
		case 'notPublished': return '게시되지 않음 확인';
		case 'failed': return '작업 실패';
	}
}
