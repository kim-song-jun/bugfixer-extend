import type { AgentSessionProvider, AgentSessionDTO, AgentSessionTurnDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import type { WorkspaceAgentSetupInspectionDTO } from '../../../../../workspace/common/workspaceAgentSetupProtocol.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import {
	advanceSessionOnboarding,
	clearSessionOnboardingState,
	completeSessionOnboarding,
	initialSessionOnboardingState,
	loadSessionOnboardingState,
	reopenSessionOnboarding,
	resumeSessionOnboarding,
	saveSessionOnboardingState,
	skipSessionOnboarding,
	type SessionOnboardingState,
} from '../../features/onboarding/index.js';
import { agentSessionStateLabel } from '../../entities/agentSession/index.js';

const STEPS = ['프로젝트', 'CLI와 계정', '세션·모델', '작업 범위', '첫 작업'] as const;

export interface SessionOnboardingTask {
	readonly id: string;
	readonly title: string;
}

export interface SessionOnboardingPreview {
	readonly ticketId: string;
	readonly expiresAt: string;
	readonly snapshot: AgentSessionTurnDTO['snapshot'];
}

export type SessionOnboardingTab = 'logs' | 'messages' | 'workflow' | 'changes';

export interface SessionOnboardingContext {
	readonly project: { readonly id: string; readonly name: string; readonly path: string; readonly bindingLabel?: string };
	readonly tasks: readonly SessionOnboardingTask[];
	readonly sessions: readonly AgentSessionDTO[];
	readonly selectedSessionId?: string;
	readonly selectedTurn?: AgentSessionTurnDTO;
	readonly preview?: SessionOnboardingPreview;
	readonly inspection?: WorkspaceAgentSetupInspectionDTO;
	readonly inspectionLoading: boolean;
	readonly inspectionError?: string;
}

export interface SessionOnboardingActions {
	readonly inspect: (provider: AgentSessionProvider) => void;
	readonly openCreate: (provider: AgentSessionProvider, taskId?: string) => void;
	readonly selectSession: (sessionId: string) => void;
	readonly openPreview: (sessionId: string) => void;
	readonly openTab: (sessionId: string, tab: SessionOnboardingTab) => void;
	readonly stopExact: (sessionId: string, turnId: string) => void;
	readonly openProviderGuide: (provider: AgentSessionProvider) => void;
	readonly copyText: (text: string) => Promise<void>;
}

export interface SessionOnboardingController {
	setContext(context: SessionOnboardingContext, actions: SessionOnboardingActions): void;
	setVisible(visible: boolean): void;
	reopen(): void;
	getState(): SessionOnboardingState;
	dispose(): void;
}

export function createSessionOnboarding(parent: HTMLElement, context: SessionOnboardingContext, actions: SessionOnboardingActions, storage: IStorageService, onFinished?: (status: 'skipped' | 'completed') => void): SessionOnboardingController {
	parent.classList.add('ai-session-onboarding');
	parent.replaceChildren();
	let currentContext = context;
	let currentActions = actions;
	let currentProjectId = context.project.id;
	let disposed = false;
	let provider: AgentSessionProvider = context.inspection?.provider ?? 'codex';
	let stateError = false;
	let saveError = false;
	let state = initialSessionOnboardingState();
	try {
		state = loadSessionOnboardingState(context.project.id, storage);
	} catch {
		stateError = true;
	}

	const heading = document.createElement('header'); heading.className = 'ai-session-onboarding__heading';
	const title = document.createElement('h2'); title.textContent = 'AI 세션 시작 안내';
	const summary = document.createElement('p'); summary.className = 'ai-session-onboarding__summary'; summary.textContent = '현재 프로젝트와 실제 세션 상태를 확인하면서 단계별로 진행합니다.';
	heading.append(title, summary);
	const progress = document.createElement('ol'); progress.className = 'ai-session-onboarding__progress'; progress.setAttribute('aria-label', '온보딩 진행 단계');
	const stepNodes = STEPS.map((label, index) => {
		const item = document.createElement('li'); item.className = 'ai-session-onboarding__progress-item';
		const button = document.createElement('button'); button.type = 'button'; button.dataset.step = String(index); button.textContent = `${index + 1}. ${label}`;
		button.addEventListener('click', () => navigateTo(index)); item.appendChild(button); progress.appendChild(item); return { item, button };
	});
	const status = document.createElement('p'); status.className = 'ai-session-onboarding__status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
	const error = document.createElement('p'); error.className = 'ai-session-onboarding__error'; error.setAttribute('role', 'alert');
	const content = document.createElement('section'); content.className = 'ai-session-onboarding__content'; content.setAttribute('aria-live', 'polite');
	const footer = document.createElement('nav'); footer.className = 'ai-session-onboarding__footer'; footer.setAttribute('aria-label', '온보딩 탐색');
	const back = makeButton('이전 단계', 'secondary'); back.addEventListener('click', () => navigateTo(Math.max(0, state.step - 1)));
	const skip = makeButton('건너뛰기', 'quiet'); skip.addEventListener('click', () => updateState(skipSessionOnboarding(state)));
	const next = makeButton('다음 단계', 'primary'); next.addEventListener('click', () => updateState(advanceSessionOnboarding(state)));
	const resume = makeButton('이어서 보기', 'primary'); resume.addEventListener('click', () => updateState(resumeSessionOnboarding(state)));
	footer.append(back, skip, resume, next);
	parent.append(heading, progress, status, error, content, footer);

	function updateState(nextState: SessionOnboardingState): void {
		if (disposed || stateError) { return; }
		const previousStatus = state.status;
		try {
			saveSessionOnboardingState(currentContext.project.id, nextState, storage);
			state = nextState;
			saveError = false;
			render();
			if (previousStatus === 'active' && (nextState.status === 'skipped' || nextState.status === 'completed')) {
				onFinished?.(nextState.status);
			}
		} catch {
			saveError = true;
			render();
		}
	}

	function navigateTo(index: number): void {
		if (index < 0 || index >= STEPS.length || stateError || state.status === 'skipped' || state.status === 'completed') { return; }
		if (index > state.step + 1) { return; }
		updateState({ version: state.version, step: index as SessionOnboardingState['step'], status: 'active' });
	}

	function render(): void {
		if (disposed) { return; }
		const focusedKey = document.activeElement instanceof HTMLElement && parent.contains(document.activeElement)
			? document.activeElement.dataset.onboardingFocus
			: undefined;
		const skipped = state.status === 'skipped';
		const completed = state.status === 'completed';
		status.textContent = stateError ? '저장된 안내 진행 상태를 읽지 못했습니다. 진행 단계를 표시하지 않습니다.' : skipped ? `안내를 건너뛰었습니다. 현재 단계: ${state.step + 1}/${STEPS.length}` : completed ? '안내를 마쳤습니다. 설정에서 다시 열 수 있습니다.' : `진행 단계 ${state.step + 1}/${STEPS.length} · ${STEPS[state.step]}`;
		error.textContent = stateError ? saveError ? '이 프로젝트의 안내 상태 초기화에 실패했습니다. 저장 공간을 확인하고 다시 시도해 주세요.' : '저장 상태를 복구하거나 이 프로젝트의 안내 진행 상태만 초기화할 수 있습니다.' : saveError ? '안내 진행 상태를 저장하지 못했습니다. 저장 공간을 확인하고 다시 시도해 주세요.' : '';
		if (stateError) {
			progress.hidden = true;
			footer.hidden = true;
			content.replaceChildren(makeHeading('안내 진행 상태를 열 수 없습니다.'));
			content.appendChild(makeText('다른 프로젝트의 진행 상태는 사용하지 않았습니다. 현재 프로젝트의 안내 상태를 초기화하면 새 단계 1부터 시작합니다.'));
			const repair = makeButton('이 프로젝트의 안내 상태 초기화', 'secondary');
			repair.dataset.onboardingFocus = 'repair-project-state';
			repair.addEventListener('click', () => {
				try {
					clearSessionOnboardingState(currentContext.project.id, storage);
					state = initialSessionOnboardingState();
					stateError = false;
					saveError = false;
					render();
					requestAnimationFrame(() => progress.querySelector<HTMLButtonElement>('[data-onboarding-focus="step-0"]')?.focus({ preventScroll: true }));
				} catch {
					saveError = true;
					render();
				}
			});
			content.appendChild(repair);
			restoreFocus(focusedKey);
			return;
		}
		progress.hidden = false;
		footer.hidden = false;
		stepNodes.forEach(({ button }, index) => { button.dataset.onboardingFocus = `step-${index}`; });
		stepNodes.forEach(({ item, button }, index) => {
			item.setAttribute('aria-current', index === state.step ? 'step' : 'false');
			button.disabled = skipped || completed || index > state.step + 1;
		});
		back.disabled = skipped || completed || state.step === 0;
		back.dataset.onboardingFocus = 'back'; skip.dataset.onboardingFocus = 'skip'; resume.dataset.onboardingFocus = 'resume'; next.dataset.onboardingFocus = 'next';
		skip.hidden = skipped || completed;
		resume.hidden = !skipped;
		next.hidden = skipped || completed || state.step === 4;
		footer.querySelector('[data-onboarding-finish]')?.remove();
		if (state.step === 4 && !completed && !skipped && !stateError) {
			const finish = makeButton('안내 마치기', 'primary');
			finish.dataset.onboardingFinish = 'true';
			finish.dataset.onboardingFocus = 'finish';
			finish.addEventListener('click', () => updateState(completeSessionOnboarding(state)));
			footer.appendChild(finish);
		}
		content.replaceChildren();
		if (skipped) {
			renderSkipped(content);
		} else {
			switch (state.step) {
				case 0: renderProjectStep(content); break;
				case 1: renderInspectionStep(content); break;
				case 2: renderSessionStep(content); break;
				case 3: renderScopeStep(content); break;
				case 4: renderFirstTaskStep(content); break;
			}
		}
		if (saveError) { error.textContent = '안내 진행 상태를 저장하지 못했습니다. 저장 공간을 확인하고 다시 시도해 주세요.'; }
		restoreFocus(focusedKey);
	}

	function restoreFocus(key: string | undefined): void {
		if (!key) { return; }
		const matching = [...parent.querySelectorAll<HTMLElement>('[data-onboarding-focus]')].find(element => element.dataset.onboardingFocus === key && !element.hasAttribute('disabled'));
		matching?.focus({ preventScroll: true });
	}

	function currentSession(): AgentSessionDTO | undefined {
		return currentContext.sessions.find(session => session.projectId === currentContext.project.id && session.id === currentContext.selectedSessionId);
	}

	function currentTurn(): AgentSessionTurnDTO | undefined {
		const session = currentSession();
		const turn = currentContext.selectedTurn;
		return session && turn?.projectId === currentContext.project.id && turn.sessionId === session.id
			&& turn.snapshot.projectId === currentContext.project.id && turn.snapshot.sessionId === session.id ? turn : undefined;
	}

	function currentPreview(): SessionOnboardingPreview | undefined {
		const session = currentSession();
		const preview = currentContext.preview;
		return session && preview?.snapshot.projectId === currentContext.project.id
			&& preview.snapshot.sessionId === session.id
			&& preview.snapshot.bindingId === session.bindingId ? preview : undefined;
	}

	function renderSkipped(target: HTMLElement): void {
		const title = makeHeading('안내를 건너뛰었습니다.');
		const detail = makeText(`저장된 진행 위치는 ${state.step + 1}단계입니다. 이어서 보면 이 프로젝트의 실제 상태를 다시 확인합니다.`);
		target.append(title, detail);
	}

	function renderProjectStep(target: HTMLElement): void {
		target.append(makeHeading('현재 프로젝트'), makeText(currentContext.project.name));
		const path = makeText(currentContext.project.path); path.classList.add('ai-session-onboarding__path'); target.append(path);
		if (currentContext.project.bindingLabel) { target.append(makeText(`연결된 폴더 · ${currentContext.project.bindingLabel}`)); }
		target.append(makeText('이 안내는 이 프로젝트의 세션과 작업 상태를 사용합니다. 예시 데이터는 만들지 않습니다.'));
		target.append(makeText('Slack, Notion 등 외부 연결은 선택 사항이며 나중에 프로젝트 대시보드에서 설정할 수 있습니다. 연결하지 않아도 CLI 세션을 시작할 수 있습니다.'));
	}

	function renderInspectionStep(target: HTMLElement): void {
		target.append(makeHeading('설치된 CLI와 로컬 프로필 확인'));
		const select = document.createElement('select'); select.setAttribute('aria-label', '확인할 CLI');
		for (const [value, label] of [['codex', 'Codex CLI'], ['claude', 'Claude Code CLI']] as const) {
			const option = document.createElement('option'); option.value = value; option.textContent = label; select.appendChild(option);
		}
		select.value = provider; select.dataset.onboardingFocus = 'provider-select';
		select.addEventListener('change', () => {
			provider = select.value as AgentSessionProvider;
			inspect.dataset.onboardingFocus = `inspect-${provider}`;
			renderInspectionResult(result);
		});
		const inspect = makeButton(currentContext.inspectionLoading ? 'CLI 확인 중' : '읽기 전용 CLI 확인', 'secondary');
		inspect.dataset.onboardingFocus = `inspect-${provider}`;
		if (currentContext.inspectionLoading) {
			inspect.setAttribute('aria-disabled', 'true');
			inspect.setAttribute('aria-busy', 'true');
		}
		inspect.addEventListener('click', () => {
			if (!currentContext.inspectionLoading) { currentActions.inspect(provider); }
		});
		const controls = document.createElement('div'); controls.className = 'ai-session-onboarding__inline-actions'; controls.append(select, inspect);
		const result = document.createElement('div'); result.className = 'ai-session-onboarding__inspection';
		target.append(controls, result);
		if (currentContext.inspectionLoading) { result.setAttribute('role', 'status'); result.textContent = `${providerLabel(provider)} CLI를 읽기 전용으로 확인하고 있습니다. 세션은 시작하지 않습니다.`; }
		else if (currentContext.inspectionError) { result.setAttribute('role', 'alert'); result.textContent = 'CLI 상태를 확인하지 못했습니다. 다시 시도해 주세요.'; }
		else if (currentContext.inspection?.provider === provider) { renderInspectionResult(result); }
		else { result.setAttribute('role', 'status'); result.textContent = '확인을 누르면 설치 상태와 버전을 조회합니다. 이 조회는 로그인이나 모델 실행을 검증하지 않습니다.'; }
	}

	function renderInspectionResult(target: HTMLElement): void {
		target.replaceChildren();
		const inspection = currentContext.inspection;
		if (!inspection || inspection.provider !== provider) {
			target.setAttribute('role', 'status');
			target.textContent = '선택한 CLI는 아직 확인되지 않았습니다.';
			return;
		}
		target.removeAttribute('role');
		const install = inspection.installation;
		const installText = install.state === 'available'
			? `설치됨 · ${install.version ?? '버전 정보 없음'}${install.executablePath ? ` · ${install.executablePath}` : ''}`
			: install.state === 'missing' ? '설치되지 않음' : install.state === 'unsupported' ? '지원하지 않는 CLI 상태' : '설치 상태를 확인할 수 없음';
		target.append(makeText(`CLI · ${installText}`));
		if (install.state === 'missing') {
			target.append(makeText('이 CLI는 설치되어 있지 않습니다. 공급자 공식 설치 안내를 열어 직접 설치한 뒤 다시 확인해 주세요. 다른 공급자로 자동 전환하지 않습니다.'));
			const installGuide = makeButton('공식 CLI 설치 안내 열기', 'quiet'); installGuide.dataset.onboardingFocus = `install-guide-${provider}`; installGuide.addEventListener('click', () => currentActions.openProviderGuide(provider));
			target.appendChild(installGuide);
		}
		const authLabel = inspection.authentication.state === 'credentialPresent'
			? 'CLI 로그인 기록 확인 · 실제 인증 상태나 실행 권한을 확인한 것은 아닙니다.'
			: inspection.authentication.state === 'signedOut' ? '로그인 필요'
			: '로그인 기록을 확인할 수 없음';
		target.append(makeText(`계정 · ${authLabel}`));
		if (inspection.authentication.state !== 'credentialPresent') {
			const guidance = document.createElement('p'); guidance.className = 'ai-session-onboarding__command-guidance';
			if (inspection.authentication.state === 'signedOut') {
				const command = provider === 'codex' ? 'codex login' : 'claude auth login';
				const code = document.createElement('code'); code.textContent = command;
				const copy = makeButton('명령 복사', 'quiet'); copy.dataset.onboardingFocus = `copy-login-${provider}`; copy.addEventListener('click', () => { void currentActions.copyText(command).catch(() => { target.setAttribute('role', 'alert'); target.append(makeText('명령 복사에 실패했습니다. 다시 시도해 주세요.')); }); });
				guidance.appendChild(code);
				guidance.appendChild(copy);
			}
			const open = makeButton('공식 로그인 안내 열기', 'quiet'); open.dataset.onboardingFocus = `login-guide-${provider}`; open.addEventListener('click', () => currentActions.openProviderGuide(provider));
			guidance.appendChild(open);
			target.append(guidance, makeText(inspection.authentication.state === 'signedOut'
				? '로그인은 공급자 CLI에서 직접 진행합니다. 이 앱은 비밀번호나 토큰을 받지 않습니다. 명령은 복사하거나 안내를 열 때만 표시하며 자동 실행하지 않습니다.'
				: '로그인 기록을 확인할 수 없습니다. 공식 안내에서 직접 상태를 확인할 수 있습니다. 이 앱은 비밀번호나 토큰을 받지 않습니다.'));
		}
	}

	function renderSessionStep(target: HTMLElement): void {
		target.append(makeHeading('기존 작업이나 세션·모델 선택'));
		target.append(makeText('새 세션에서는 공급자를 고르고 모델 ID를 입력합니다. 세션 목록에서 공급자와 모델을 함께 확인할 수 있습니다.'));
		if (currentContext.tasks.length) {
			const taskList = document.createElement('ul'); taskList.className = 'ai-session-onboarding__list';
			for (const task of currentContext.tasks) {
				const item = document.createElement('li');
				const create = makeButton(`“${task.title}” 작업으로 ${providerLabel(provider)} 세션 만들기`, 'quiet');
				create.dataset.onboardingFocus = `create-task-${task.id}`; create.addEventListener('click', () => currentActions.openCreate(provider, task.id)); item.appendChild(create); taskList.appendChild(item);
			}
			target.appendChild(taskList);
		} else {
			target.append(makeText('연결할 진행 중 작업이 없습니다. 프로젝트 대시보드에서 실제 작업을 만든 뒤 다시 열어 주세요.'));
		}
		if (currentContext.sessions.length) {
			const sessionHeading = makeHeading('이 프로젝트의 저장된 세션'); target.appendChild(sessionHeading);
			const list = document.createElement('ul'); list.className = 'ai-session-onboarding__list';
			for (const session of currentContext.sessions) {
				const item = document.createElement('li');
				const select = makeButton(`${session.name} · ${providerLabel(session.provider)} · ${session.model} · ${agentSessionStateLabel[session.state]}`, 'quiet');
				select.setAttribute('aria-current', session.id === currentContext.selectedSessionId ? 'true' : 'false');
				select.dataset.onboardingFocus = `select-session-${session.id}`; select.addEventListener('click', () => currentActions.selectSession(session.id)); item.appendChild(select); list.appendChild(item);
			}
			target.appendChild(list);
		} else {
			target.append(makeText('이 프로젝트에는 아직 저장된 AI 세션이 없습니다.'));
		}
	}

	function renderScopeStep(target: HTMLElement): void {
		target.append(makeHeading('폴더와 규칙을 실행 전에 확인'));
		const session = currentSession();
		if (!session) {
			target.append(makeText('실제 세션을 선택하거나 기존 작업으로 세션을 만든 뒤 범위를 확인할 수 있습니다.'));
			return;
		}
		target.append(makeText(`${providerLabel(session.provider)} · ${session.model} · ${session.workspaceMode === 'gitWorktree' ? '세션 전용 Git worktree' : '기존 폴더의 단일 수정자 정책'}`));
		const preview = currentPreview();
		if (preview) {
			const snapshot = preview.snapshot;
			target.append(makeText(`작업 폴더 · ${snapshot.cwd}`));
			target.append(makeText(`권한 · ${snapshot.permissionPolicy.mode === 'read-only' ? '파일 수정 없이 읽기' : '파일 수정 허용 · 승인 정책 적용'}`));
			target.append(makeText(`규칙 · ${snapshot.convention ? `실제 연결본 ${snapshot.convention.sha256.slice(0, 12)}` : '연결된 규칙 없음'}`));
			target.append(makeText(`참고 자료 · ${snapshot.references.length}개`));
			target.append(makeText(`미리보기 만료 · ${new Date(preview.expiresAt).toLocaleString('ko-KR')}`));
		} else {
			target.append(makeText('실행 미리보기를 열면 현재 폴더, 권한, 규칙 스냅샷과 참고 자료를 표시합니다. 미리보기만으로 세션은 실행되지 않습니다.'));
		}
		const previewButton = makeButton('실행 미리보기 열기', 'secondary'); previewButton.dataset.onboardingFocus = 'open-preview'; previewButton.addEventListener('click', () => currentActions.openPreview(session.id));
		target.appendChild(previewButton);
		target.append(makeText(session.provider === 'codex'
			? '앱의 MCP 권한은 프로젝트와 세션에 적용됩니다. Codex 프로필에 이미 설정된 MCP 도구와 외부 접근 범위까지 제한하지는 않습니다.'
			: '앱의 MCP 권한은 프로젝트와 세션에 적용됩니다. Claude 프로필의 기존 MCP/외부 도구와 파일 읽기 전용 설정은 별도로 확인해야 합니다.'));
	}

	function renderFirstTaskStep(target: HTMLElement): void {
		target.append(makeHeading('첫 실제 작업에서 확인할 항목'));
		const session = currentSession();
		const turn = currentTurn();
		if (turn) {
			const cleanup = turn.cleanupVerified ? '정리 확인됨' : ['starting', 'running', 'stopping'].includes(turn.state) ? '종료 정리 대기 중' : '종료 정리 확인되지 않음';
			target.append(makeText(`실제 실행 상태 · ${turn.state}${turn.exitCode === null ? '' : ` · 종료 코드 ${turn.exitCode}`} · ${cleanup}`));
		} else {
			target.append(makeText('아직 선택된 실제 실행 기록이 없습니다. 실행 미리보기에서 범위를 확인한 뒤 직접 시작해야 합니다.'));
		}
		const guidance = [
			'공유 범위 · 세션은 프로젝트 안에서 저장됩니다. MCP 도구의 제공자별 범위도 미리보기 문구로 확인하세요.',
			'로그 · 터미널 출력과 구조화 로그를 구분해 볼 수 있습니다. 로그 마스킹은 모든 민감 정보를 완벽히 제거한다고 보장하지 않으므로 공유 전 직접 확인하세요.',
			'알림 · 앱 안의 프로젝트 알림을 확인할 수 있습니다. 운영 체제 알림 권한은 선택 사항이며, 권한이 없어도 저장된 알림 목록을 열 수 있습니다.',
			'중단과 복구 · 현재 실행한 정확한 세션과 실행만 중단하세요. 종료 정리가 확인되지 않거나 복구가 필요하면 상태와 근거를 확인한 뒤 다시 시도하세요.',
			'검토와 PR · 변경을 검토하고 별도 승인 후 통합하세요. PR 게시도 별도 승인이 필요합니다.',
	];
	for (const text of guidance) { target.append(makeText(text)); }
		if (session) {
			const preview = makeButton('실행 미리보기 열기', 'secondary'); preview.dataset.onboardingFocus = 'first-task-preview';
			preview.addEventListener('click', () => currentActions.openPreview(session.id)); target.appendChild(preview);
		} else if (currentContext.tasks.length) {
			const createList = document.createElement('ul'); createList.className = 'ai-session-onboarding__list';
			for (const task of currentContext.tasks) {
				const item = document.createElement('li');
				const create = makeButton(`“${task.title}” 작업으로 세션 만들기`, 'quiet');
				create.dataset.onboardingFocus = `first-task-create-${task.id}`;
				create.addEventListener('click', () => currentActions.openCreate(provider, task.id));
				item.appendChild(create); createList.appendChild(item);
			}
			target.appendChild(createList);
		}
		const sessionId = currentContext.selectedSessionId;
		const turnActive = turn && ['starting', 'running', 'stopping'].includes(turn.state);
		if (sessionId && turn) {
			const tabButtons = document.createElement('div'); tabButtons.className = 'ai-session-onboarding__inline-actions';
			for (const [tab, label] of [['logs', '로그 열기'], ['messages', '메시지 열기'], ['workflow', '작업 흐름 열기'], ['changes', '변경 검토 열기']] as const) {
				const button = makeButton(label, 'quiet'); button.dataset.onboardingFocus = `open-tab-${tab}`; button.addEventListener('click', () => currentActions.openTab(sessionId, tab)); tabButtons.appendChild(button);
			}
			target.appendChild(tabButtons);
			if (turnActive) {
				const stop = makeButton('현재 실행 중단', 'danger');
				stop.dataset.onboardingFocus = 'stop-exact-turn';
				stop.addEventListener('click', () => currentActions.stopExact(sessionId, turn.id)); target.appendChild(stop);
			}
		}
		if (turn?.state === 'failed' || turn?.state === 'interrupted' || (turn?.state === 'exited' && turn.exitCode !== 0)) {
			target.append(makeText('첫 실행이 정상 종료되지 않았습니다. 기존 오류와 정리 상태를 확인한 뒤 미리보기를 다시 열어 재개할지 결정하세요.'));
		}
	}

	function makeHeading(text: string): HTMLHeadingElement { const heading = document.createElement('h3'); heading.textContent = text; return heading; }
	function makeText(text: string): HTMLParagraphElement { const paragraph = document.createElement('p'); paragraph.textContent = text; return paragraph; }
	function makeButton(text: string, kind: 'primary' | 'secondary' | 'quiet' | 'danger'): HTMLButtonElement {
		const button = document.createElement('button'); button.type = 'button'; button.className = `ai-session-onboarding__button ai-session-onboarding__button--${kind}`; button.textContent = text; return button;
	}

	function providerLabel(value: AgentSessionProvider): string { return value === 'codex' ? 'Codex' : 'Claude'; }

	function setContext(nextContext: SessionOnboardingContext, nextActions: SessionOnboardingActions): void {
		if (currentProjectId !== nextContext.project.id) {
			currentProjectId = nextContext.project.id;
			provider = nextContext.inspection?.provider ?? 'codex';
			state = initialSessionOnboardingState();
			stateError = false;
			saveError = false;
			try {
				state = loadSessionOnboardingState(nextContext.project.id, storage);
			} catch {
				stateError = true;
			}
		}
		currentContext = nextContext;
		currentActions = nextActions;
		render();
	}

	function setVisible(value: boolean): void {
		parent.hidden = !value;
		if (value) { render(); }
	}

	function reopen(): void {
		if (stateError) { return; }
		updateState(reopenSessionOnboarding(state));
	}

	function getState(): SessionOnboardingState { return state; }

	function dispose(): void {
		disposed = true;
		parent.classList.remove('ai-session-onboarding');
		parent.replaceChildren();
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) { return; }
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) { return; }
		if (event.key === 'ArrowLeft' && state.step > 0 && state.status === 'active') { event.preventDefault(); navigateTo(state.step - 1); }
		if (event.key === 'ArrowRight' && state.step < 4 && state.status === 'active') { event.preventDefault(); updateState(advanceSessionOnboarding(state)); }
		if (event.key === 'Escape' && state.status === 'active') { event.preventDefault(); updateState(skipSessionOnboarding(state)); }
	}

	parent.addEventListener('keydown', onKeyDown);
	const originalDispose = dispose;
	return {
		setContext,
		setVisible,
		reopen,
		getState,
		dispose: () => { parent.removeEventListener('keydown', onKeyDown); originalDispose(); },
	};
}
