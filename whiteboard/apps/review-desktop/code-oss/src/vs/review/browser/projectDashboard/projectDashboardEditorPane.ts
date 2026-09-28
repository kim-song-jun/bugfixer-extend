import { $, clearNode, type Dimension } from '../../../base/browser/dom.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { ipcRenderer } from '../../../base/parts/sandbox/electron-browser/globals.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../workbench/browser/parts/editor/editorPane.js';
import { ViewContainerLocation } from '../../../workbench/common/views.js';
import type { IEditorGroup } from '../../../workbench/services/editor/common/editorGroupsService.js';
import type { IEditorOpenContext } from '../../../workbench/common/editor.js';
import { INativeWorkbenchEnvironmentService } from '../../../workbench/services/environment/electron-browser/environmentService.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../workbench/services/panecomposite/browser/panecomposite.js';
import type { ReorderWorkspaceDashboardTasksRequest, TrashWorkspaceDashboardTaskRequest, UpdateWorkspaceDashboardStateRequest, UpdateWorkspaceDashboardTaskRequest, WorkspaceDashboardDTO, WorkspaceDashboardTaskDTO, WorkspaceDashboardTaskItemDTO, WorkspaceDashboardTaskLifecycleRequest } from '../../../workspace/common/workspaceDashboardProtocol.js';
import { WORKSPACE_DASHBOARD_CHANNEL } from '../../../workspace/common/workspaceDashboardProtocol.js';
import type { OrdinaryFolderMutationGrantDTO, ProviderAttemptDTO, ProviderAttemptEventDTO, ProviderId, ProviderRunPreviewDTO } from '../../../workspace/common/workspaceProviderRunProtocol.js';
import { WORKSPACE_PROVIDER_RUNS_CHANNEL } from '../../../workspace/common/workspaceProviderRunProtocol.js';
import type { WorkspaceKnowledgeDTO, WorkspaceReferenceContentDTO, WorkspaceReferenceDTO, WorkspaceTaskInstructionPromotionDTO } from '../../../workspace/common/workspaceKnowledgeProtocol.js';
import { WORKSPACE_KNOWLEDGE_CHANNEL } from '../../../workspace/common/workspaceKnowledgeProtocol.js';
import { WORKSPACE_WEBSITE_CHANNEL, type WorkspaceWebsitePreviewDTO } from '../../../workspace/common/workspaceWebsiteProtocol.js';
import type { PreviewNotionPageRequest, PreviewSlackConversationRequest, WorkspaceConnectorAccountDTO, WorkspaceConnectorId, WorkspaceConnectorPreviewDTO } from '../../../workspace/common/workspaceConnectorProtocol.js';
import { WORKSPACE_CONNECTOR_CHANNEL } from '../../../workspace/common/workspaceConnectorProtocol.js';
import type { WorkspaceInstalledPackageDTO, WorkspacePackageConnectionDTO, WorkspacePackagePreviewDTO, WorkspacePackageReviewDTO, WorkspaceSignedPackageEnvelope } from '../../../workspace/common/workspacePackageConnectorProtocol.js';
import { WORKSPACE_PACKAGE_CONNECTOR_CHANNEL } from '../../../workspace/common/workspacePackageConnectorProtocol.js';
import { WORKSPACE_EGO_CAPTURE_CHANNEL, type WorkspaceEgoCaptureRecoveryStatus, type WorkspaceEgoCaptureStatus } from '../../../workspace/common/workspaceBrowserCaptureProtocol.js';
import { WORKSPACE_E2E_CHANNEL, type WorkspaceE2eEvidenceDTO, type WorkspaceE2eStep } from '../../../workspace/common/workspaceE2eProtocol.js';
import { WORKSPACE_CONVENTION_AGENT_CHANNEL, type ConventionAgentPreviewDTO, type ConventionAgentResultDTO } from '../../../workspace/common/workspaceConventionAgentProtocol.js';
import { WORKSPACE_REVIEW_BRIDGE_CHANNEL, type WorkspaceTaskReviewLink, type TaskReviewAvailability, type TaskReviewOpenResult } from '../../../workspace/common/workspaceReviewBridgeProtocol.js';
import { IReviewCanvasEditorTabsService } from '../../services/reviewCanvasEditorTabsService.js';
import { IProjectInspectSnapshotService } from '../../services/projectInspectSnapshotService.js';
import { parseNotionPageInput } from './notionPageInput.js';
import { ProjectDashboardEditorInput } from './projectDashboardEditorInput.js';
import { getPackageRefreshCandidates, type PackageRefreshCandidate } from './packageRefreshCandidates.js';
import { PROJECT_SIDEBAR_CONTAINER_ID, setProjectSidebarSection } from './projectSidebar.contribution.js';

import './projectDashboard.css';

const columns = [
	{ state: 'ready', label: '대기' },
	{ state: 'inProgress', label: '진행 중' },
	{ state: 'review', label: '검토' },
	{ state: 'done', label: '완료' },
] as const;
type DashboardTaskState = WorkspaceDashboardTaskItemDTO['state'];
type DashboardTaskView = 'board' | 'archived' | 'trash';
type KnowledgeView = 'references' | 'conventions';
type ConnectorPreviewRequest =
	| { readonly command: 'previewSlackConversation'; readonly payload: PreviewSlackConversationRequest }
	| { readonly command: 'previewNotionPage'; readonly payload: PreviewNotionPageRequest };
interface PackageRefreshState {
	readonly state: 'loading' | 'error' | 'success';
	readonly message: string;
}

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className) element.className = className;
	return element;
}

function packageTokenValidationMessage(value: string): string {
	if ([...value].some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) > 0x7e)) {
		return '토큰은 공백 없는 ASCII 출력 가능 문자만 사용할 수 있습니다.';
	}
	return value.length > 0 && value.length < 16 ? '토큰은 공백 없는 ASCII 출력 가능 문자 16자 이상이어야 합니다.' : '';
}

function notionAccountLabelValidationMessage(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return 'Notion 연결 이름을 입력해 주세요.';
	if (trimmed.length > 80) return 'Notion 연결 이름은 공백을 제외하고 80자 이하여야 합니다.';
	if (/[\r\n\t\x00-\x1f\x7f]/.test(value)) return 'Notion 연결 이름에는 제어 문자를 사용할 수 없습니다.';
	return '';
}

function e2eEnvironmentLabel(identity: string): string {
	return identity === 'local macOS' ? '로컬 macOS' : identity;
}

function e2eRevisionLabel(evidence: WorkspaceE2eEvidenceDTO): string {
	if (evidence.checkoutRevision) return evidence.checkoutRevision;
	const reason = evidence.checkoutRevisionUnavailableReason;
	return reason === 'This task uses an ordinary folder without Git or jj revision history.'
		? '이 작업은 Git 또는 jj 버전 이력이 없는 일반 폴더에서 진행됩니다.'
		: reason ?? '정보 없음';
}

const subagentItemTypeLabels: Readonly<Record<string, string>> = {
	agent_message: '응답',
	reasoning: '작업 판단',
	command_execution: '명령 실행',
	file_change: '파일 변경',
	mcp_tool_call: '외부 도구 호출',
	web_search: '웹 검색',
	image_view: '이미지 확인',
	entered_review_mode: '검토 모드 진입',
	exited_review_mode: '검토 모드 종료',
	plan: '계획 정리',
	todo_list: '작업 목록',
	error: '오류',
};

const subagentItemOutcomeLabels: Readonly<Record<string, string>> = {
	denied: '권한 요청 거부',
	failed: '실패',
	unresolved: '결과 확인 필요',
};

function subagentEventLabel(event: ProviderAttemptEventDTO): string {
	const itemType = typeof event.metadata.itemType === 'string' ? subagentItemTypeLabels[event.metadata.itemType] ?? '작업 항목' : '작업 항목';
	const outcome = typeof event.metadata.itemOutcome === 'string' ? subagentItemOutcomeLabels[event.metadata.itemOutcome] : undefined;

	switch (event.type) {
		case 'session.started': return '세션 연결';
		case 'turn.started': return '작업 시작';
		case 'item.started': return `${itemType} 시작`;
		case 'item.updated': return `${itemType} 진행`;
		case 'item.completed': return outcome ? `${itemType} ${outcome}` : `${itemType} 완료`;
		case 'turn.completed': return event.metadata.itemOutcome === 'denied' ? '권한 요청 거부' : event.metadata.itemOutcome === 'failed' ? '검증 실패' : '작업 완료';
		case 'turn.failed': return '작업 실패';
		case 'permission.denied': return '권한 요청 거부';
		case 'error': return '오류 발생';
		case 'ordinaryFolderInventoryStarted': return '폴더 변경 확인 시작';
		case 'ordinaryFolderChanges': return '폴더 변경 확인 완료';
		default: return '기타 이벤트';
	}
}

function e2eFailureLabel(failure: string): string {
	return /^page\.waitForFunction timed out after \d+ms/.test(failure)
		? '기대한 텍스트가 정해진 시간 안에 나타나지 않았습니다. 선택자와 기대 텍스트를 확인해 주세요.'
		: '브라우저 확인에 실패했습니다. 증거 파일 정보에서 기술 오류를 확인해 주세요.';
}

export class ProjectDashboardEditorPane extends EditorPane {
	static readonly ID = ProjectDashboardEditorInput.EDITOR_ID;
	private root: HTMLElement | undefined;
	private inputActive = false;
	private projectId: string | undefined;
	private dashboard: WorkspaceDashboardDTO | undefined;
	private selectedTaskId: string | undefined;
	private draggingTaskId: string | undefined;
	private loading = false;
	private error: string | undefined;
	private navigationError: string | undefined;
	private creating = false;
	private createFormOpen = false;
	private pendingCreateTaskFocus = false;
	private createTaskTitleDraft = '';
	private createTaskDescriptionDraft = '';
	private providerId: ProviderId = 'codex';
	private preview: ProviderRunPreviewDTO | undefined;
	private attempts: readonly ProviderAttemptDTO[] = [];
	private subagentProviderId: ProviderId = 'codex';
	private subagentTaskId: string | undefined;
	private subagentScopeDraft = '';
	private subagentPreview: ProviderRunPreviewDTO | undefined;
	private subagentParentAttemptId: string | undefined;
	private subagentFormOpen = false;
	private expandedSubagentRootId: string | undefined;
	private subagentEvents: Readonly<Record<string, readonly ProviderAttemptEventDTO[]>> = {};
	private subagentError: string | undefined;
	private subagentEventsError: string | undefined;
	private e2eEvidence: readonly WorkspaceE2eEvidenceDTO[] = [];
	private e2eLoading = false;
	private e2eRequestGeneration = 0;
	private e2eRequestTaskId: string | undefined;
	private e2ePendingRequest: { taskId: string; force: boolean } | undefined;
	private e2eBusy = false;
	private e2eError: string | undefined;
	private e2eLoadedTaskId: string | undefined;
	private e2eDraftAttemptId = '';
	private e2eAttemptChosenByUser = false;
	private e2eFormOpen = false;
	private e2eUrlDraft = '';
	private e2eEnvironmentDraft = '로컬 macOS';
	private e2eScenarioDraft: { type: WorkspaceE2eStep['type']; selector: string; value: string }[] = [{ type: 'assertText', selector: 'h1', value: '' }];
	private providerError: string | undefined;
	private providerErrorKind: 'operation' | 'history' | 'inspect' | undefined;
	private providerBusy = false;
	private folderMutationGrant: OrdinaryFolderMutationGrantDTO | undefined;
	private editingTaskId: string | undefined;
	private editTitleDraft = '';
	private editDescriptionDraft = '';
	private taskEditBusy = false;
	private taskEditError: string | undefined;
	private taskMutationBusy: string | undefined;
	private taskMutationError: string | undefined;
	private taskView: DashboardTaskView = 'board';
	private archivedTasks: readonly WorkspaceDashboardTaskItemDTO[] = [];
	private trashedTasks: readonly WorkspaceDashboardTaskItemDTO[] = [];
	private lifecycleLoading = false;
	private lifecycleError: string | undefined;
	private trashConfirmationTaskId: string | undefined;
	private readonly trashRequestIds = new Map<string, string>();
	private stateSaveTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingDashboardState: { request: UpdateWorkspaceDashboardStateRequest; generation: number } | undefined;
	private stateSaveGeneration = 0;
	private stateSaveRunning = false;
	private stateSavePromise: Promise<void> | undefined;
	private lastSavedDashboardPosition: string | null = null;
	private boardScrollPosition = 0;
	private dashboardStateError: string | undefined;
	private pendingDashboardPosition: number | undefined;
	private programmaticScrollTarget: number | undefined;
	private programmaticScrollTimer: ReturnType<typeof setTimeout> | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private polling = false;
	private attemptRefreshPending = false;
	private refreshDashboardAfterPendingAttemptRefresh = true;
	private lastFocusKey: string | undefined;
	private lastFocusSignature: string | undefined;
	private knowledge: WorkspaceKnowledgeDTO | undefined;
	private knowledgeLoading = false;
	private knowledgeError: string | undefined;
	private knowledgeMessage: string | undefined;
	private taskPromotions: readonly WorkspaceTaskInstructionPromotionDTO[] = [];
	private taskPromotionsTaskId: string | undefined;
	private taskPromotionRequestTaskId: string | undefined;
	private taskPromotionGeneration = 0;
	private taskPromotionLoading = false;
	private taskPromotionLoadFailed = false;
	private taskPromotionBusy = false;
	private taskPromotionError: string | undefined;
	private promotionExcerptDraft = '';
	private referenceViewerId: string | undefined;
	private referenceViewer: WorkspaceReferenceContentDTO | undefined;
	private referenceViewerLoading = false;
	private referenceViewerError: string | undefined;
	private referenceViewerGeneration = 0;
	private preservedReferenceViewerElement: HTMLElement | undefined;
	private referenceViewerPage = 0;
	private referenceViewerPageStarts: readonly number[] = [0];
	private knowledgeView: KnowledgeView = 'references';
	private activeSection: 'dashboard' | KnowledgeView = 'dashboard';
	private pendingSectionNavigation: 'dashboard' | KnowledgeView | undefined;
	private connectorManagementOpen = false;
	private focusTaskDetailOnRender = false;
	private knowledgeBusy = false;
	private referenceTitleDraft = '';
	private referenceContentDraft = '';
	private websiteUrlDraft = '';
	private websitePreview: WorkspaceWebsitePreviewDTO | undefined;
	private websitePreviewExpiryTimer: ReturnType<typeof setTimeout> | undefined;
	private websiteBusy = false;
	private websiteError: string | undefined;
	private websiteMessage: string | undefined;
	private conventionDraft = '';
	private conventionSourceIdsDraft = new Set<string>();
	private egoUrlDraft = '';
	private egoCaptureId: string | undefined;
	private egoTaskId: string | undefined;
	private egoProjectId: string | undefined;
	private egoStatus: WorkspaceEgoCaptureStatus | undefined;
	private egoCleanupPending = false;
	private egoBusy = false;
	private egoCloseRequested = false;
	private egoError: string | undefined;
	private egoCapturedTaskTitle: string | undefined;
	private conventionAgentProvider: ProviderId = 'claude';
	private conventionAgentOperation: 'draft' | 'check' = 'draft';
	private conventionCheckVersionId: string | undefined;
	private conventionAgentSourceIds = new Set<string>();
	private conventionAgentPreview: ConventionAgentPreviewDTO | undefined;
	private conventionAgentResult: ConventionAgentResultDTO | undefined;
	private conventionAgentBusy = false;
	private conventionAgentError: string | undefined;
	private conventionAgentNotice: string | undefined;
	private reviewLinks: readonly WorkspaceTaskReviewLink[] = [];
	private reviewPendingCreates: TaskReviewAvailability['pendingCreates'] = [];
	private reviewLinksTaskId: string | undefined;
	private reviewAvailability: TaskReviewAvailability['state'] = 'unavailable';
	private reviewAvailabilityError: string | undefined;
	private reviewBridgeBusy = false;
	private reviewBridgeError: string | undefined;
	private reviewBridgeNotice: string | undefined;
	private connectorAccounts: readonly WorkspaceConnectorAccountDTO[] = [];
	private connectorLoading = false;
	private connectorBusy = false;
	private connectorError: string | undefined;
	private connectorMessage: string | undefined;
	private connectorProvider: WorkspaceConnectorId = 'slack';
	private connectorTokenDraft = '';
	private connectorAccountLabelDraft = '';
	private connectorImportAccountId = '';
	private connectorImportIdDraft = '';
	private connectorImportTitleDraft = '';
	private connectorImportMessageTsDraft = '';
	private connectorPreview: WorkspaceConnectorPreviewDTO | undefined;
	private connectorPreviewAccountId: string | undefined;
	private connectorPreviewRequest: ConnectorPreviewRequest | undefined;
	private connectorPreviewLoading = false;
	private connectorPreviewError: string | undefined;
	private connectorPreviewGeneration = 0;
	private connectorOperationGeneration = 0;
	private installedPackages: readonly WorkspaceInstalledPackageDTO[] = [];
	private packageConnections: readonly WorkspacePackageConnectionDTO[] = [];
	private readonly installedPackageDetailsOpen = new Set<string>();
	private readonly packageConnectionIds = new Map<string, string>();
	private packageConnectionLabel = '';
	private readonly packageConnectionScopes = new Map<string, Set<string>>();
	private packageReview: WorkspacePackageReviewDTO | undefined;
	private packageEnvelope: WorkspaceSignedPackageEnvelope | undefined;
	private packageBusy = false;
	private packageLoading = false;
	private packageError: string | undefined;
	private packageMessage: string | undefined;
	private packageFileName = '';
	private readonly packageSourceIds = new Map<string, string>();
	private packageSourceKey = '';
	private packagePreview: WorkspacePackagePreviewDTO | undefined;
	private packagePreviewTaskId: string | undefined;
	private packagePreviewGeneration = 0;
	private readonly packageRefreshReferenceIds = new Map<string, string>();
	private readonly packageRefreshStates = new Map<string, PackageRefreshState>();
	private packageRefreshGeneration = 0;
	private readonly refreshOnReturn = () => {
		if (document.visibilityState === 'visible' && this.selectedTaskId) {
			void this.loadAttempts();
			void this.loadTaskPromotions(this.selectedTaskId, true);
		}
	};
	private readonly persistScrollPosition = () => {
		if (!this.inputActive || this.activeSection !== 'dashboard' || this.taskView !== 'board') return;
		if (this.programmaticScrollTarget !== undefined) {
			this.programmaticScrollTarget = undefined;
			if (this.programmaticScrollTimer) clearTimeout(this.programmaticScrollTimer);
			this.programmaticScrollTimer = undefined;
			return;
		}
		this.boardScrollPosition = Math.min(10_000_000, Math.max(0, Math.floor(this.root?.scrollTop ?? 0)));
		const position = this.boardScrollPosition.toString();
		if (position === this.lastSavedDashboardPosition && (!this.pendingDashboardState || this.pendingDashboardState.request.dashboardPosition === position)) return;
		this.scheduleDashboardStateSave(true);
	};

	constructor(group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@INativeWorkbenchEnvironmentService private readonly environment: INativeWorkbenchEnvironmentService,
		@IReviewCanvasEditorTabsService private readonly reviewTabs: IReviewCanvasEditorTabsService,
		@IProjectInspectSnapshotService private readonly inspectSnapshots: IProjectInspectSnapshotService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService) {
		super(ProjectDashboardEditorPane.ID, group, telemetryService, themeService, storageService);
		this._register(this.layoutService.onDidChangePartVisibility(event => {
			if (event.partId !== Parts.SIDEBAR_PART) return;
			const navigation = this.root?.querySelector<HTMLButtonElement>('.project-dashboard__navigation');
			if (navigation) navigation.hidden = event.visible;
		}));
	}

	private async openProjectNavigation(): Promise<void> {
		this.navigationError = undefined;
		try {
			this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
			const sidebar = await this.paneCompositeService.openPaneComposite(PROJECT_SIDEBAR_CONTAINER_ID, ViewContainerLocation.Sidebar, true);
			if (!sidebar) throw new Error('프로젝트 메뉴를 열지 못했습니다.');
			this.root?.querySelector('.project-dashboard__navigation-error')?.remove();
		} catch (error) {
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			this.navigationError = this.errorMessage(error, '프로젝트 메뉴를 열지 못했습니다.');
			this.render();
		}
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = $('.project-dashboard');
		this.root.tabIndex = 0;
		parent.appendChild(this.root);
		this.root.addEventListener('scroll', this.persistScrollPosition, { passive: true });
		document.addEventListener('visibilitychange', this.refreshOnReturn);
		window.addEventListener('focus', this.refreshOnReturn);
	}

	navigateToSection(section: 'dashboard' | KnowledgeView): void {
		if (section !== 'references') this.closeReferenceViewer(false);
		if (this.activeSection === 'dashboard' && this.taskView === 'board') {
			this.boardScrollPosition = Math.min(10_000_000, Math.max(0, Math.floor(this.root?.scrollTop ?? 0)));
		}
		this.activeSection = section;
		if (section === 'dashboard') {
			this.taskView = 'board';
			this.pendingDashboardPosition = this.boardScrollPosition;
		}
		else this.knowledgeView = section;
		this.pendingCreateTaskFocus = false;
		setProjectSidebarSection(section);
		this.pendingSectionNavigation = section;
		this.focusTaskDetailOnRender = false;
		this.render();
	}

	startTaskCreation(): void {
		this.openCreateTaskForm();
	}

	private openCreateTaskForm(): void {
		this.activeSection = 'dashboard';
		setProjectSidebarSection('dashboard');
		this.createFormOpen = true;
		this.pendingCreateTaskFocus = true;
		this.pendingSectionNavigation = undefined;
		this.pendingDashboardPosition = undefined;
		if (this.taskView === 'board') this.render();
		else {
			this.setTaskView('board');
			this.pendingCreateTaskFocus = true;
		}
	}

	override async setInput(input: ProjectDashboardEditorInput, options: unknown, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		if (this.projectId) {
			try { await ipcRenderer.invoke(WORKSPACE_CONNECTOR_CHANNEL, 'clearPreviews', { projectId: this.projectId }); }
			catch (error) { console.error('Could not clear source previews while changing dashboard input.', error); }
			try { await ipcRenderer.invoke(WORKSPACE_WEBSITE_CHANNEL, 'clearPreviews', { projectId: this.projectId }); }
			catch (error) { console.error('Could not clear website previews while changing dashboard input.', error); }
		}
		this.clearConnectorPreview();
		this.clearWebsitePreview();
		await this.closeEgoCapture();
		await this.flushDashboardState();
		await super.setInput(input, options as never, context, token);
		this.inputActive = true;
		this.stopPolling();
		this.activeSection = 'dashboard';
		setProjectSidebarSection('dashboard');
		this.boardScrollPosition = 0;
		this.taskView = 'board';
		this.dashboard = undefined;
		this.error = undefined;
		this.knowledge = undefined;
		this.knowledgeLoading = false;
		this.knowledgeError = undefined;
		this.knowledgeMessage = undefined;
		this.closeReferenceViewer(false);
		this.websiteUrlDraft = '';
		this.websiteBusy = false;
		this.websiteError = undefined;
		this.websiteMessage = undefined;
		this.connectorAccounts = [];
		this.connectorLoading = false;
		this.connectorError = undefined;
		this.connectorMessage = undefined;
		this.connectorBusy = false;
		this.connectorPreviewLoading = false;
		this.connectorTokenDraft = '';
		this.connectorAccountLabelDraft = '';
		this.connectorImportIdDraft = '';
		this.connectorImportTitleDraft = '';
		this.connectorImportMessageTsDraft = '';
		this.connectorImportAccountId = '';
		this.e2eFormOpen = false;
		this.e2eRequestGeneration++;
		this.e2eLoading = false;
		this.e2eRequestTaskId = undefined;
		this.e2ePendingRequest = undefined;
		this.installedPackages = [];
		this.packageReview = undefined;
		this.packageEnvelope = undefined;
		this.packageBusy = false;
		this.packageLoading = false;
		this.packageError = undefined;
		this.packageMessage = undefined;
		this.packageFileName = '';
		this.packageSourceIds.clear();
		this.packageSourceKey = '';
		this.clearPackagePreview();
		this.packageRefreshReferenceIds.clear();
		this.packageRefreshStates.clear();
		this.packageRefreshGeneration++;
		this.conventionSourceIdsDraft.clear();
		this.egoStatus = undefined;
		if (!this.egoCaptureId) { this.egoTaskId = undefined; this.egoProjectId = undefined; this.egoError = undefined; }
		this.conventionAgentPreview = undefined; this.conventionAgentResult = undefined; this.conventionAgentError = undefined; this.conventionAgentNotice = undefined;
		this.conventionCheckVersionId = undefined;
		this.reviewLinks = []; this.reviewPendingCreates = []; this.reviewLinksTaskId = undefined; this.reviewAvailabilityError = undefined; this.reviewBridgeError = undefined; this.reviewBridgeNotice = undefined;
		this.trashConfirmationTaskId = undefined;
		this.selectedTaskId = undefined;
		this.preview = undefined;
		++this.taskPromotionGeneration;
		this.taskPromotions = [];
		this.taskPromotionsTaskId = undefined;
		this.taskPromotionRequestTaskId = undefined;
		this.taskPromotionLoading = false;
		this.taskPromotionLoadFailed = false;
		this.taskPromotionBusy = false;
		this.taskPromotionError = undefined;
		this.promotionExcerptDraft = '';
		this.folderMutationGrant = undefined;
		this.attempts = [];
		this.e2eEvidence = []; this.e2eLoadedTaskId = undefined; this.e2eError = undefined; this.e2eScenarioDraft = [{ type: 'assertText', selector: 'h1', value: '' }];
		this.providerError = undefined;
		this.providerErrorKind = undefined;
		if (token.isCancellationRequested) return;
		if (this.environment.reviewWindowLaunch.kind !== 'project' || this.environment.reviewWindowLaunch.projectId !== input.projectId) {
			this.error = '이 대시보드는 현재 프로젝트 창에 속하지 않습니다.';
			this.render();
			return;
		}
		this.projectId = input.projectId;
		if (!this.egoCaptureId) { await this.recoverEgoCapture(input.projectId); }
		await this.load();
	}

	private async load(): Promise<void> {
		if (!this.projectId) return;
		this.loading = true;
		this.error = undefined;
		this.render();
		try {
			this.dashboard = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'getDashboard', this.projectId) as WorkspaceDashboardDTO;
			for (const task of this.dashboard.tasks) {
				if (task.deletionRequestId) this.trashRequestIds.set(task.id, task.deletionRequestId);
			}
			this.dashboardStateError = undefined;
			this.lastSavedDashboardPosition = this.dashboard.view.dashboardPosition;
			const selectedTaskExists = (taskId: string | null | undefined) => !!taskId && this.dashboard!.tasks.some(task => task.id === taskId);
			if (!selectedTaskExists(this.selectedTaskId)) this.selectedTaskId = selectedTaskExists(this.dashboard.view.selectedTaskId) ? this.dashboard.view.selectedTaskId! : undefined;
			const savedPosition = this.dashboard.view.dashboardPosition;
			this.boardScrollPosition = savedPosition === null ? 0 : Math.min(10_000_000, Number(savedPosition));
			this.pendingDashboardPosition = this.activeSection === 'dashboard' && this.taskView === 'board' && !this.pendingCreateTaskFocus
				? this.boardScrollPosition : undefined;
		} catch (error) {
			this.error = this.errorMessage(error, '프로젝트를 불러오지 못했습니다. 다시 시도해 주세요.');
		} finally {
			this.loading = false;
			this.render();
		}
		if (this.dashboard) void this.loadKnowledge();
		if (this.dashboard) void this.loadConnectorAccounts();
		if (this.dashboard) void this.loadInstalledPackages();
		if (this.selectedTaskId) void this.loadAttempts();
	}

	private async loadConnectorAccounts(): Promise<void> {
		const projectId = this.projectId;
		if (!projectId) return;
		this.connectorLoading = true;
		this.connectorError = undefined;
		this.render();
		try {
			const accounts = await ipcRenderer.invoke(WORKSPACE_CONNECTOR_CHANNEL, 'listAccounts', projectId) as readonly WorkspaceConnectorAccountDTO[];
			if (this.projectId === projectId) {
				this.connectorAccounts = accounts;
				if (this.connectorPreviewAccountId && !accounts.some(account => account.id === this.connectorPreviewAccountId && account.state === 'active')) this.clearConnectorPreview();
				if (!accounts.some(account => account.id === this.connectorImportAccountId && account.state === 'active')) this.connectorImportAccountId = accounts.find(account => account.provider === this.connectorProvider && account.state === 'active')?.id ?? accounts.find(account => account.state === 'active')?.id ?? '';
			}
		} catch (error) {
			if (this.projectId === projectId) this.connectorError = this.errorMessage(error, '연결된 계정을 불러오지 못했습니다.');
		} finally {
			if (this.projectId === projectId) { this.connectorLoading = false; this.render(); }
		}
	}

	private clearConnectorPreview(): void {
		this.connectorPreviewGeneration++;
		this.connectorPreview = undefined;
		this.connectorPreviewAccountId = undefined;
		this.connectorPreviewRequest = undefined;
		this.connectorPreviewLoading = false;
		this.connectorPreviewError = undefined;
	}

	private async requestConnectorPreview(request: ConnectorPreviewRequest): Promise<void> {
		if (this.connectorBusy || !this.projectId) return;
		const projectId = this.projectId;
		const generation = ++this.connectorPreviewGeneration;
		const operation = ++this.connectorOperationGeneration;
		this.connectorPreview = undefined;
		this.connectorPreviewAccountId = request.payload.accountId;
		this.connectorPreviewRequest = request;
		this.connectorPreviewLoading = true;
		this.connectorPreviewError = undefined;
		this.connectorError = undefined;
		this.connectorMessage = undefined;
		this.connectorBusy = true;
		this.render();
		try {
			const preview = await ipcRenderer.invoke(WORKSPACE_CONNECTOR_CHANNEL, request.command, request.payload) as WorkspaceConnectorPreviewDTO;
			if (this.projectId !== projectId || this.connectorPreviewGeneration !== generation) return;
			if (!/^[a-f0-9-]{36}$/i.test(preview.previewId) || !/^[a-f0-9]{64}$/.test(preview.contentSha256)
				|| !Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now()
				|| new TextEncoder().encode(preview.derivedText).byteLength > 1024 * 1024) {
				throw new Error('자료 미리보기가 유효하지 않거나 만료되었습니다. 다시 미리보기해 주세요.');
			}
			this.connectorPreview = preview;
			this.connectorMessage = '미리보기가 준비되었습니다. 가져오기 전에 내용을 확인하세요.';
		} catch (error) {
			if (this.projectId === projectId && this.connectorPreviewGeneration === generation) {
				this.connectorPreviewError = this.errorMessage(error, '자료를 미리보지 못했습니다.');
			}
		} finally {
			if (this.connectorOperationGeneration === operation) {
				this.connectorPreviewLoading = false;
				this.connectorBusy = false;
				this.render();
			}
		}
	}

	private async importReviewedConnectorPreview(preview: WorkspaceConnectorPreviewDTO, accountId: string): Promise<void> {
		if (this.connectorBusy || !this.projectId || this.connectorPreview?.previewId !== preview.previewId || this.connectorPreviewAccountId !== accountId) return;
		const projectId = this.projectId;
		if (!Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now()) {
			this.clearConnectorPreview();
			this.connectorPreviewError = '자료 미리보기가 만료되었습니다. 다시 미리보기한 뒤 가져오세요.';
			this.render();
			return;
		}
		const taskId = this.selectedTaskId;
		const generation = this.connectorPreviewGeneration;
		const operation = ++this.connectorOperationGeneration;
		this.connectorBusy = true;
		this.connectorPreviewError = undefined;
		this.connectorError = undefined;
		this.connectorMessage = undefined;
		this.render();
		try {
			const reference = await ipcRenderer.invoke(WORKSPACE_CONNECTOR_CHANNEL, 'importPreview', {
				projectId, accountId, previewId: preview.previewId,
			}) as WorkspaceReferenceDTO;
			if (reference.connectorId !== preview.connectorId || reference.externalId !== preview.externalId
				|| reference.sourceUri !== preview.sourceUri || reference.title !== preview.title
				|| reference.contentSha256 !== preview.contentSha256) {
				throw new Error('저장된 자료 정보가 확인한 미리보기와 일치하지 않습니다.');
			}
			if (this.projectId !== projectId || this.connectorPreviewGeneration !== generation) return;
			this.clearConnectorPreview();
			this.connectorImportIdDraft = '';
			this.connectorImportTitleDraft = '';
			this.connectorImportMessageTsDraft = '';
			if (taskId) {
				try {
					await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'attachTaskReference', { projectId, taskId, snapshotId: reference.id });
				} catch (error) {
					this.connectorPreviewError = `자료를 가져왔지만 선택한 작업에 연결하지 못했습니다: ${this.errorMessage(error, '연결 실패')}`;
					this.connectorMessage = '자료를 가져왔습니다. 자료 목록에서 작업에 연결할 수 있습니다.';
					await this.loadKnowledge();
					return;
				}
			}
			this.connectorMessage = taskId ? '자료를 가져와 원래 작업에 연결했습니다.' : '자료를 가져왔습니다. 작업을 선택해 연결하세요.';
			await this.loadKnowledge();
		} catch (error) {
			if (this.projectId === projectId) {
				const expired = /source preview (?:expired|is no longer available)/i.test(this.rawErrorMessage(error));
				const message = this.errorMessage(error, '확인한 자료를 가져오지 못했습니다.');
				if (expired) this.clearConnectorPreview();
				this.connectorPreviewError = message;
			}
		} finally {
			if (this.connectorOperationGeneration === operation) {
				this.connectorBusy = false;
				this.render();
			}
		}
	}

	private async runConnectorAction(action: () => Promise<unknown>, success: string, reload = true): Promise<void> {
		if (this.connectorBusy) return;
		const projectId = this.projectId;
		this.connectorBusy = true;
		this.connectorError = undefined;
		this.connectorMessage = undefined;
		this.render();
		try {
			await action();
			if (this.projectId === projectId) {
				this.connectorMessage = success;
				if (reload) await this.loadConnectorAccounts();
			}
		} catch (error) {
			if (this.projectId === projectId) this.connectorError = this.errorMessage(error, '커넥터 작업을 완료하지 못했습니다.');
		} finally {
			this.connectorBusy = false;
			this.render();
		}
	}

	private renderConnectors(panel: HTMLElement): void {
		const projectId = this.projectId;
		const section = panel.appendChild($('.project-dashboard__connectors'));
		const heading = section.appendChild($('.project-dashboard__knowledge-section-heading'));
		const title = heading.appendChild($('h3')); title.textContent = '연결된 자료';
		const intro = section.appendChild($('p')); intro.className = 'project-dashboard__connector-note'; intro.textContent = '이 프로젝트 창에 계정을 연결하세요. 인증 정보는 macOS 키체인에 저장되며, 이 화면에는 계정 정보만 표시됩니다.';
		if (this.connectorError) { const error = section.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert'); const text = error.appendChild($('span')); text.textContent = this.connectorError; const retry = error.appendChild(createElement('button', 'project-dashboard__retry')); retry.type = 'button'; retry.textContent = '다시 시도'; retry.addEventListener('click', () => void this.loadConnectorAccounts()); }
		if (this.connectorMessage) { const status = section.appendChild($('.project-dashboard__knowledge-success')); status.setAttribute('role', 'status'); status.textContent = this.connectorMessage; }
		if (this.connectorLoading) { const status = section.appendChild($('.project-dashboard__status')); status.setAttribute('role', 'status'); status.textContent = '연결된 계정 불러오는 중…'; }
		const accounts = section.appendChild($('.project-dashboard__connector-accounts'));
		for (const account of this.connectorAccounts) {
			const row = accounts.appendChild($('.project-dashboard__connector-account'));
			const details = row.appendChild($('.project-dashboard__connector-account-main'));
			const label = details.appendChild($('strong')); label.textContent = `${account.provider === 'slack' ? 'Slack' : 'Notion'} · ${account.label}`;
			const meta = details.appendChild($('span')); meta.textContent = `${account.remoteIdentity} · ${account.state === 'active' ? '연결됨' : '키체인 정리 대기 중'}`;
			if (account.provider === 'notion') {
				const lifecycleNote = details.appendChild($('p')); lifecycleNote.className = 'project-dashboard__connector-note project-dashboard__connector-account-disclosure';
				lifecycleNote.textContent = '이 앱에서 연결을 해제하면 로컬 키체인 자격 증명만 삭제됩니다. Notion의 토큰이나 연결은 폐기되지 않습니다.';
			}
			const action = row.appendChild(createElement('button', 'project-dashboard__secondary')); action.type = 'button'; action.disabled = this.connectorBusy;
			action.textContent = account.state === 'active' ? '연결 해제' : '정리 다시 시도';
			action.addEventListener('click', () => { if (!projectId) return; if (account.id === this.connectorPreviewAccountId) { this.clearConnectorPreview(); } void this.runConnectorAction(() => ipcRenderer.invoke(WORKSPACE_CONNECTOR_CHANNEL, account.state === 'active' ? 'disconnectAccount' : 'retryAccountCleanup', { projectId, accountId: account.id }), account.state === 'active' ? '계정 연결을 해제했습니다.' : '키체인 정리를 완료했습니다.'); });
		}
		const form = section.appendChild(createElement('form', 'project-dashboard__connector-connect'));
		const formTitle = form.appendChild($('h4')); formTitle.textContent = '계정 연결';
		const providerLabel = form.appendChild(createElement('label')); providerLabel.htmlFor = 'connector-provider'; providerLabel.textContent = '서비스';
		const provider = form.appendChild(createElement('select')); provider.id = 'connector-provider'; provider.disabled = this.connectorBusy;
		for (const [value, text] of [['slack', 'Slack'], ['notion', 'Notion']] as const) { const option = provider.appendChild($('option') as HTMLOptionElement); option.value = value; option.textContent = text; }
		provider.value = this.connectorProvider;
		const notionLabelField = form.appendChild(createElement('div', 'project-dashboard__connector-notion-label'));
		const notionLabel = notionLabelField.appendChild(createElement('label')); notionLabel.htmlFor = 'connector-notion-label'; notionLabel.textContent = '연결 이름 (워크스페이스/용도)';
		const notionLabelInput = notionLabelField.appendChild(createElement('input')); notionLabelInput.id = 'connector-notion-label'; notionLabelInput.type = 'text'; notionLabelInput.required = this.connectorProvider === 'notion'; notionLabelInput.value = this.connectorAccountLabelDraft; notionLabelInput.disabled = this.connectorBusy; notionLabelInput.dataset.focusKey = 'connector-notion-label';
		const notionLabelHint = notionLabelField.appendChild($('p')); notionLabelHint.id = 'connector-notion-label-hint'; notionLabelHint.className = 'project-dashboard__connector-note'; notionLabelHint.textContent = '앞뒤 공백은 저장할 때 제거됩니다. 1–80자 이름을 입력하세요.';
		notionLabelInput.setAttribute('aria-describedby', notionLabelHint.id);
		notionLabelInput.addEventListener('input', () => {
			this.connectorAccountLabelDraft = notionLabelInput.value;
			const message = notionAccountLabelValidationMessage(notionLabelInput.value);
			notionLabelInput.setCustomValidity(this.connectorProvider === 'notion' ? message : '');
			if (this.connectorProvider === 'notion' && message) notionLabelInput.setAttribute('aria-invalid', 'true');
			else notionLabelInput.removeAttribute('aria-invalid');
		});
		notionLabelField.hidden = this.connectorProvider !== 'notion';
		const tokenLabel = form.appendChild(createElement('label')); tokenLabel.htmlFor = 'connector-token'; tokenLabel.textContent = this.connectorProvider === 'notion' ? 'Notion 개인 액세스 토큰' : '액세스 토큰';
		const token = form.appendChild(createElement('input')); token.id = 'connector-token'; token.type = 'password'; token.autocomplete = 'off'; token.spellcheck = false; token.required = true; token.value = this.connectorTokenDraft; token.disabled = this.connectorBusy; token.dataset.focusKey = 'connector-token';
		token.addEventListener('input', () => { this.connectorTokenDraft = token.value; });
		const tokenHelp = form.appendChild($('p')); tokenHelp.className = 'project-dashboard__connector-note';
		const notionDisclosure = form.appendChild($('p')); notionDisclosure.className = 'project-dashboard__connector-note project-dashboard__connector-notion-disclosure'; notionDisclosure.hidden = this.connectorProvider !== 'notion';
		notionDisclosure.textContent = '개인 액세스 토큰은 만든 사람의 Notion 권한으로 동작하며, Notion API 권한에는 콘텐츠 읽기와 변경이 모두 포함됩니다. 이 앱의 가져오기는 지정한 페이지 ID에 읽기 요청만 보냅니다. 토큰은 다른 접근 가능한 페이지에도 권한이 있을 수 있으니 앱 전용 토큰을 만들고 더는 쓰지 않으면 Notion에서 폐기하세요.';
		const updateProviderFields = () => {
			const isNotion = provider.value === 'notion';
			this.connectorProvider = provider.value as WorkspaceConnectorId;
			notionLabelField.hidden = !isNotion;
			notionLabelInput.required = isNotion;
			const labelError = isNotion ? notionAccountLabelValidationMessage(notionLabelInput.value) : '';
			notionLabelInput.setCustomValidity(labelError);
			if (labelError) notionLabelInput.setAttribute('aria-invalid', 'true');
			else notionLabelInput.removeAttribute('aria-invalid');
			tokenLabel.textContent = isNotion ? 'Notion 개인 액세스 토큰' : '액세스 토큰';
			tokenHelp.replaceChildren();
			if (isNotion) {
				tokenHelp.append('Notion에서 토큰을 만들고 붙여넣으세요. ');
				const setupLink = tokenHelp.appendChild(createElement('a'));
				setupLink.href = 'https://developers.notion.com/guides/get-started/personal-access-tokens'; setupLink.target = '_blank'; setupLink.rel = 'noreferrer'; setupLink.textContent = 'Notion 개인 액세스 토큰 설정 방법';
				tokenHelp.append(' 제출하면 입력란이 비워집니다.');
				notionDisclosure.hidden = false;
			} else {
				tokenHelp.textContent = 'Slack 사용자 토큰(xoxp-)을 붙여넣으세요. 제출하면 입력란이 비워집니다.';
				notionDisclosure.hidden = true;
			}
		};
		provider.addEventListener('change', () => { updateProviderFields(); clearReview(); });
		updateProviderFields();
		const connectActions = form.appendChild($('.project-dashboard__form-actions'));
		const connect = connectActions.appendChild(createElement('button', 'project-dashboard__primary')); connect.type = 'submit'; connect.disabled = this.connectorBusy; connect.textContent = this.connectorBusy ? '연결 중…' : '연결';
		form.addEventListener('submit', event => {
			event.preventDefault();
			const tokenValue = token.value;
			const connectionProvider = this.connectorProvider;
			const accountLabel = connectionProvider === 'notion' ? notionLabelInput.value.trim() : undefined;
			if (connectionProvider === 'notion') {
				const labelError = notionAccountLabelValidationMessage(notionLabelInput.value);
				notionLabelInput.setCustomValidity(labelError);
				if (labelError) { notionLabelInput.setAttribute('aria-invalid', 'true'); notionLabelInput.reportValidity(); return; }
			}
			if (!projectId || !tokenValue) return;
			token.value = ''; this.connectorTokenDraft = '';
			void this.runConnectorAction(async () => {
				await ipcRenderer.invoke(WORKSPACE_CONNECTOR_CHANNEL, 'connectAccount', { projectId, provider: connectionProvider, token: tokenValue, ...(accountLabel ? { accountLabel } : {}) });
				if (connectionProvider === 'notion') this.connectorAccountLabelDraft = '';
			}, '계정을 연결했습니다.');
		});
		const importForm = section.appendChild(createElement('form', 'project-dashboard__connector-import'));
		const previewRegion = section.appendChild($('.project-dashboard__connector-preview-region'));
		const clearReview = () => {
			this.clearConnectorPreview();
			if (this.connectorMessage?.startsWith('미리보기가 준비되었습니다.')) this.connectorMessage = undefined;
			previewRegion.replaceChildren();
		};
		const importTitle = importForm.appendChild($('h4')); importTitle.textContent = '대화 또는 페이지 미리보기 및 가져오기';
		const accountLabel = importForm.appendChild(createElement('label')); accountLabel.htmlFor = 'connector-account'; accountLabel.textContent = '연결된 계정';
		const accountSelect = importForm.appendChild(createElement('select')); accountSelect.id = 'connector-account'; accountSelect.disabled = this.connectorBusy;
		for (const account of this.connectorAccounts.filter(item => item.state === 'active')) { const option = accountSelect.appendChild($('option') as HTMLOptionElement); option.value = account.id; option.textContent = `${account.provider === 'slack' ? 'Slack' : 'Notion'} · ${account.label}`; }
		accountSelect.value = this.connectorImportAccountId;
		const selectedAccount = () => this.connectorAccounts.find(item => item.id === accountSelect.value && item.state === 'active');
		const idLabel = importForm.appendChild(createElement('label')); idLabel.htmlFor = 'connector-remote-id';
		const remoteId = importForm.appendChild(createElement('input')); remoteId.id = 'connector-remote-id'; remoteId.required = true; remoteId.autocomplete = 'off'; remoteId.value = this.connectorImportIdDraft; remoteId.disabled = this.connectorBusy || !selectedAccount(); remoteId.dataset.focusKey = 'connector-remote-id'; remoteId.addEventListener('input', () => { this.connectorImportIdDraft = remoteId.value; remoteId.setCustomValidity(''); clearReview(); });
		const messageTsField = importForm.appendChild(createElement('div')); messageTsField.hidden = selectedAccount()?.provider !== 'slack';
		const messageTsLabel = messageTsField.appendChild(createElement('label')); messageTsLabel.htmlFor = 'connector-slack-message-ts'; messageTsLabel.textContent = 'Slack 메시지 타임스탬프 (선택)';
		const messageTs = messageTsField.appendChild(createElement('input')); messageTs.id = 'connector-slack-message-ts'; messageTs.type = 'text'; messageTs.autocomplete = 'off'; messageTs.placeholder = '1712345678.123456'; messageTs.value = this.connectorImportMessageTsDraft; messageTs.disabled = this.connectorBusy; messageTs.dataset.focusKey = 'connector-slack-message-ts'; messageTs.addEventListener('input', () => { this.connectorImportMessageTsDraft = messageTs.value; clearReview(); });
		const messageTsHelp = messageTsField.appendChild($('p')); messageTsHelp.className = 'project-dashboard__connector-note'; messageTsHelp.textContent = '비워 두면 채널 대화를 가져옵니다. 메시지 타임스탬프를 입력하면 해당 메시지와 스레드 답글을 가져옵니다.';
		const titleLabel = importForm.appendChild(createElement('label')); titleLabel.htmlFor = 'connector-import-title'; titleLabel.textContent = '제목 (선택)';
		const remoteTitle = importForm.appendChild(createElement('input')); remoteTitle.id = 'connector-import-title'; remoteTitle.value = this.connectorImportTitleDraft; remoteTitle.disabled = this.connectorBusy; remoteTitle.dataset.focusKey = 'connector-import-title'; remoteTitle.addEventListener('input', () => { this.connectorImportTitleDraft = remoteTitle.value; clearReview(); });
		const importActions = importForm.appendChild($('.project-dashboard__form-actions'));
		const doImport = importActions.appendChild(createElement('button', 'project-dashboard__primary')); doImport.type = 'submit'; doImport.textContent = this.connectorPreviewLoading ? '미리보기 불러오는 중…' : '자료 미리보기';
		const updateImportFields = () => {
			const provider = selectedAccount()?.provider;
			idLabel.textContent = provider === 'notion' ? 'Notion 페이지 링크 또는 UUID' : provider === 'slack' ? 'Slack 채널 ID' : 'Slack 채널 ID 또는 Notion 페이지 링크';
			remoteId.placeholder = provider === 'notion' ? 'Notion에서 복사한 페이지 링크 또는 UUID' : 'Slack 채널 ID (C…)';
			remoteId.disabled = this.connectorBusy || !provider;
			remoteId.setCustomValidity('');
			messageTsField.hidden = provider !== 'slack';
			titleLabel.hidden = provider !== 'slack';
			remoteTitle.hidden = provider !== 'slack';
			doImport.disabled = this.connectorBusy || !provider;
		};
		accountSelect.addEventListener('change', () => {
			this.connectorImportAccountId = accountSelect.value;
			this.connectorImportIdDraft = ''; remoteId.value = '';
			this.connectorImportMessageTsDraft = ''; messageTs.value = '';
			this.connectorImportTitleDraft = ''; remoteTitle.value = '';
			updateImportFields(); clearReview();
		});
		updateImportFields();
		importForm.addEventListener('submit', event => {
			event.preventDefault();
			const account = selectedAccount(); const externalId = remoteId.value.trim();
			if (!projectId || !account || !externalId) return;
			let request: ConnectorPreviewRequest;
			if (account.provider === 'notion') {
				const pageId = parseNotionPageInput(externalId);
				if (!pageId) {
					remoteId.setCustomValidity('Notion에서 복사한 페이지 링크 또는 페이지 UUID를 입력해 주세요.');
					remoteId.reportValidity();
					return;
				}
				request = { command: 'previewNotionPage', payload: { projectId, accountId: account.id, pageId } };
			} else {
				const messageTimestamp = messageTs.value.trim();
				request = { command: 'previewSlackConversation', payload: { projectId, accountId: account.id, channelId: externalId, title: remoteTitle.value.trim() || undefined, ...(messageTimestamp ? { messageTs: messageTimestamp } : {}) } };
			}
			void this.requestConnectorPreview(request);
		});
		if (this.connectorPreviewLoading) { const loading = previewRegion.appendChild($('.project-dashboard__status')); loading.setAttribute('role', 'status'); loading.textContent = '자료 미리보기 불러오는 중…'; }
		if (this.connectorPreviewError) {
			const error = previewRegion.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert');
			const text = error.appendChild($('span')); text.textContent = this.connectorPreviewError;
			if (this.connectorPreviewRequest) { const retry = error.appendChild(createElement('button', 'project-dashboard__retry')); retry.type = 'button'; retry.textContent = '미리보기 다시 시도'; retry.disabled = this.connectorBusy; retry.addEventListener('click', () => void this.requestConnectorPreview(this.connectorPreviewRequest!)); }
		}
		const reviewedPreview = this.connectorPreview;
		const previewAccountId = this.connectorPreviewAccountId;
		if (reviewedPreview && previewAccountId) {
			const card = previewRegion.appendChild($('.project-dashboard__connector-preview'));
			const previewHeading = card.appendChild($('h4')); previewHeading.textContent = '자료 스냅샷 확인';
			const metadata = card.appendChild($('dl'));
			for (const [label, value] of [['자료', reviewedPreview.title], ['자료 URI', reviewedPreview.sourceUri], ['내용 SHA-256', reviewedPreview.contentSha256], ['미리보기 만료', new Date(reviewedPreview.expiresAt).toLocaleString()]] as const) { const term = metadata.appendChild($('dt')); term.textContent = label; const detail = metadata.appendChild($('dd')); detail.textContent = value; }
			if (reviewedPreview.omissions.length) { const omitted = card.appendChild($('p')); omitted.className = 'project-dashboard__connector-note'; omitted.textContent = `미리보기에서 제외된 항목: ${reviewedPreview.omissions.join(' · ')}`; }
			const contentLabel = card.appendChild($('h5')); contentLabel.textContent = '텍스트 미리보기';
			const artifactNotice = card.appendChild($('p')); artifactNotice.className = 'project-dashboard__connector-preview-disclosure'; artifactNotice.textContent = '가져오면 여기에 표시되지 않은 메타데이터와 속성을 포함해 Slack 또는 Notion의 원본 응답을 저장합니다. 여기의 읽기 쉬운 텍스트는 미리보기이며, 위 SHA-256은 저장되는 전체 자료의 값입니다.';
			const content = card.appendChild($('pre')); content.className = 'project-dashboard__connector-preview-content'; content.textContent = reviewedPreview.derivedText;
			const actions = card.appendChild($('.project-dashboard__form-actions'));
			const confirm = actions.appendChild(createElement('button', 'project-dashboard__primary')); confirm.type = 'button'; confirm.textContent = this.connectorBusy ? '확인한 스냅샷 가져오는 중…' : '확인한 자료 가져오기'; confirm.disabled = this.connectorBusy || Date.parse(reviewedPreview.expiresAt) <= Date.now(); confirm.addEventListener('click', () => void this.importReviewedConnectorPreview(reviewedPreview, previewAccountId));
		}
		this.renderPackageConnectors(panel);
	}

	private async loadInstalledPackages(): Promise<boolean> {
		const projectId = this.projectId;
		if (!projectId) return false;
		this.packageLoading = true;
		this.packageError = undefined;
		this.render();
		let loaded = false;
		try {
			const packages = await ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'listPackages', projectId) as readonly WorkspaceInstalledPackageDTO[];
			const connections = (await Promise.all(packages.map(item => ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'listPackageConnections', { projectId, packageId: item.packageId })))) as readonly (readonly WorkspacePackageConnectionDTO[])[];
			if (this.projectId === projectId) {
				this.installedPackages = packages;
				this.packageConnections = connections.flat();
				for (const item of packages) {
					const available = this.packageConnections.filter(connection => connection.packageId === item.packageId && connection.state === 'active');
					if (!available.some(connection => connection.connectionId === this.packageConnectionIds.get(item.packageId))) {
						if (available[0]) this.packageConnectionIds.set(item.packageId, available[0].connectionId);
						else this.packageConnectionIds.delete(item.packageId);
					}
				}
				loaded = true;
			}
		} catch (error) {
			if (this.projectId === projectId) this.packageError = this.errorMessage(error, '설치된 커넥터 패키지를 불러오지 못했습니다.');
		} finally {
			if (this.projectId === projectId) { this.packageLoading = false; this.render(); }
		}
		return loaded;
	}

	private clearPackagePreview(): void {
		this.packagePreviewGeneration++;
		this.packagePreview = undefined;
		this.packagePreviewTaskId = undefined;
	}

	private selectedPackageConnection(installed: WorkspaceInstalledPackageDTO): WorkspacePackageConnectionDTO | undefined {
		const id = this.packageConnectionIds.get(installed.packageId);
		return this.packageConnections.find(connection => connection.packageId === installed.packageId && connection.connectionId === id && connection.state === 'active');
	}

	private async requestPackagePreview(installed: WorkspaceInstalledPackageDTO, sourceId: string, sourceKey: string): Promise<void> {
		if (this.packageBusy || !this.projectId || !this.selectedPackageConnection(installed)) return;
		const projectId = this.projectId;
		this.clearPackagePreview();
		const generation = this.packagePreviewGeneration;
		const taskId = this.selectedTaskId;
		this.packageBusy = true;
		this.packageError = undefined;
		this.packageMessage = undefined;
		this.render();
		try {
			const preview = await ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'previewPackageSource', {
				projectId, packageId: installed.packageId, sourceId, sourceKey, connectionId: this.packageConnectionIds.get(installed.packageId),
			}) as WorkspacePackagePreviewDTO;
			if (this.projectId !== projectId || this.packagePreviewGeneration !== generation) return;
			if (preview.packageId !== installed.packageId || preview.sourceId !== sourceId || preview.sourceKey !== sourceKey
				|| preview.connectorVersion !== installed.version || preview.accountRef !== this.selectedPackageConnection(installed)?.accountRef || !/^[a-f0-9-]{36}$/i.test(preview.previewId)
				|| !/^[a-f0-9]{64}$/.test(preview.contentSha256)
				|| !Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now()
				|| new TextEncoder().encode(preview.content).byteLength > 1024 * 1024) {
				throw new Error('패키지 자료 미리보기가 유효하지 않거나 만료되었습니다. 다시 미리보기해 주세요.');
			}
			this.packagePreview = preview;
			this.packagePreviewTaskId = taskId;
			this.packageMessage = '자료 미리보기가 준비되었습니다. 내용을 확인한 뒤 가져오세요.';
		} catch (error) {
			if (this.projectId === projectId && this.packagePreviewGeneration === generation) this.packageError = this.errorMessage(error, '패키지 자료를 미리보지 못했습니다.');
		} finally {
			if (this.projectId === projectId && this.packagePreviewGeneration === generation) {
				this.packageBusy = false;
				this.render();
			}
		}
	}

	private async importReviewedPackagePreview(preview: WorkspacePackagePreviewDTO): Promise<void> {
		if (this.packageBusy || !this.projectId || this.packagePreview?.previewId !== preview.previewId) return;
		const installed = this.installedPackages.find(item => item.packageId === preview.packageId);
		if (!installed || preview.accountRef !== this.selectedPackageConnection(installed)?.accountRef) {
			this.clearPackagePreview();
			this.packageError = '선택한 계정이 바뀌었습니다. 같은 계정으로 다시 미리보기해 주세요.';
			this.render();
			return;
		}
		const projectId = this.projectId;
		if (!Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now()) {
			this.clearPackagePreview();
			this.packageError = '자료 미리보기가 만료되었습니다. 다시 확인한 뒤 가져오세요.';
			this.render();
			return;
		}
		const taskId = this.packagePreviewTaskId;
		const generation = this.packagePreviewGeneration;
		this.packageBusy = true;
		this.packageError = undefined;
		this.packageMessage = undefined;
		this.render();
		let importedReference: WorkspaceReferenceDTO | undefined;
		try {
			const reference = importedReference = await ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'importPackagePreview', {
				projectId, packageId: preview.packageId, previewId: preview.previewId, connectionId: this.packageConnectionIds.get(preview.packageId), ...(taskId ? { taskId } : {}),
			}) as WorkspaceReferenceDTO;
			if (reference.projectId !== projectId || reference.connectorId !== `local:${preview.packageId}`
				|| reference.connectorVersion !== preview.connectorVersion || reference.externalId !== preview.externalId
				|| reference.sourceUri !== preview.sourceUri || reference.title !== preview.title || reference.accountRef !== preview.accountRef
				|| reference.contentSha256 !== preview.contentSha256) {
				throw new Error('저장된 자료 정보가 확인한 미리보기와 일치하지 않습니다.');
			}
			if (this.projectId !== projectId || this.packagePreviewGeneration !== generation) return;
			this.clearPackagePreview();
			this.packageSourceKey = '';
			this.packageMessage = taskId ? '확인한 자료를 가져와 원래 작업에 연결했습니다.' : '확인한 자료를 가져왔습니다. 작업을 선택해 연결하세요.';
			await this.loadKnowledge();
		} catch (error) {
			if (this.projectId === projectId && this.packagePreviewGeneration === generation) {
				if (importedReference) {
					this.clearPackagePreview();
					this.packageError = `자료는 저장됐지만 결과를 확인하지 못했습니다: ${this.errorMessage(error, '확인 실패')}`;
					await this.loadKnowledge();
				} else {
					this.packageError = this.errorMessage(error, '확인한 패키지 자료를 가져오지 못했습니다.');
				}
			}
		} finally {
			if (this.projectId === projectId) {
				this.packageBusy = false;
				this.render();
			}
		}
	}

	private async runPackageAction(action: () => Promise<unknown>, successMessage: string, reload = true): Promise<void> {
		if (this.packageBusy) return;
		const projectId = this.projectId;
		this.clearPackagePreview();
		this.packageBusy = true;
		this.packageError = undefined;
		this.packageMessage = undefined;
		this.render();
		try {
			await action();
			if (this.projectId === projectId) {
				this.packageMessage = successMessage;
				if (reload) await this.loadInstalledPackages();
			}
		} catch (error) {
			const operationError = this.errorMessage(error, '커넥터 패키지 작업을 완료하지 못했습니다.');
			const loaded = this.projectId === projectId && await this.loadInstalledPackages();
			if (this.projectId === projectId) this.packageError = loaded ? operationError : `${operationError} · ${this.packageError ?? '설치 및 계정 상태도 다시 불러오지 못했습니다.'}`;
		} finally {
			this.packageBusy = false;
			this.render();
		}
	}

	private async reviewPackageFile(file: File): Promise<void> {
		const projectId = this.projectId;
		if (!projectId) return;
		this.packageReview = undefined;
		this.packageEnvelope = undefined;
		this.packageError = undefined;
		this.packageMessage = undefined;
		this.packageFileName = file.name;
		if (file.size === 0 || file.size > 192 * 1024) {
			this.packageError = '비어 있지 않은 192 KiB 이하의 JSON 파일을 선택하세요.';
			this.render();
			return;
		}
		this.packageBusy = true;
		this.render();
		try {
			const parsed: unknown = JSON.parse(await file.text());
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('파일에 서명된 패키지 봉투 객체가 있어야 합니다.');
			const envelope = parsed as Partial<WorkspaceSignedPackageEnvelope>;
			if (typeof envelope.manifestBytesBase64 !== 'string' || typeof envelope.signatureBase64 !== 'string' || typeof envelope.publicKeyBase64 !== 'string'
				|| Object.keys(parsed).length !== 3 || !Object.keys(parsed).every(key => ['manifestBytesBase64', 'signatureBase64', 'publicKeyBase64'].includes(key))) {
				throw new Error('JSON에는 manifestBytesBase64, signatureBase64, publicKeyBase64 항목만 있어야 합니다.');
			}
			const review = await ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'reviewPackage', { projectId, envelope }) as WorkspacePackageReviewDTO;
			if (this.projectId === projectId) { this.packageEnvelope = envelope as WorkspaceSignedPackageEnvelope; this.packageReview = review; }
		} catch (error) {
			if (this.projectId === projectId) this.packageError = this.errorMessage(error, '서명된 패키지를 확인하지 못했습니다.');
		} finally {
			if (this.projectId === projectId) { this.packageBusy = false; this.render(); }
		}
	}

	private packageRefreshCandidates(installed: WorkspaceInstalledPackageDTO): PackageRefreshCandidate[] {
		const accountRef = this.selectedPackageConnection(installed)?.accountRef;
		if (!accountRef) return [];
		return getPackageRefreshCandidates(this.knowledge?.references ?? [], installed.packageId, installed.sources, accountRef);
	}

	private async refreshInstalledPackageSource(installed: WorkspaceInstalledPackageDTO, candidate: PackageRefreshCandidate): Promise<void> {
		if (!this.projectId || this.packageBusy) return;
		const projectId = this.projectId;
		const generation = ++this.packageRefreshGeneration;
		const latest = this.packageRefreshCandidates(installed).find(item => item.reference.id === candidate.reference.id);
		if (!latest || latest.sourceId !== candidate.sourceId || latest.sourceKey !== candidate.sourceKey) {
			this.packageRefreshStates.set(installed.packageId, { state: 'error', message: '새로고침할 설치 패키지 자료의 가장 최근 스냅샷을 선택하세요.' });
			this.render();
			return;
		}
		this.packageBusy = true;
		this.packageError = undefined;
		this.packageMessage = undefined;
		this.packageRefreshStates.set(installed.packageId, { state: 'loading', message: `${latest.sourceLabel} 자료의 v${latest.reference.version}에서 새로고침 중…` });
		this.render();
		let refreshed: WorkspaceReferenceDTO | undefined;
		try {
			refreshed = await ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'refreshPackageSource', {
				projectId, packageId: installed.packageId, sourceId: latest.sourceId, sourceKey: latest.sourceKey, connectionId: this.selectedPackageConnection(installed)?.connectionId,
				previousReferenceId: latest.reference.id,
			}) as WorkspaceReferenceDTO;
			if (refreshed.sourceId !== latest.reference.sourceId || refreshed.previousId !== latest.reference.id
				|| refreshed.connectorId !== latest.reference.connectorId || refreshed.externalId !== latest.reference.externalId
				|| refreshed.accountRef !== this.selectedPackageConnection(installed)?.accountRef || refreshed.version <= latest.reference.version) {
				throw new Error('새 스냅샷이 선택한 패키지 자료 기록을 이어받지 않았습니다.');
			}
			const knowledge = await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'getProjectKnowledge', projectId) as WorkspaceKnowledgeDTO;
			if (this.projectId === projectId) {
				this.knowledge = knowledge;
				this.packageRefreshReferenceIds.set(installed.packageId, refreshed.id);
				this.packageRefreshStates.set(installed.packageId, {
					state: 'success', message: `${latest.sourceLabel} 업데이트: v${latest.reference.version} → v${refreshed.version} · SHA-256 ${refreshed.contentSha256}`,
				});
			}
		} catch (error) {
			if (this.projectId === projectId) {
				const detail = this.errorMessage(error, '새로고침 요청 실패');
				const message = refreshed
					? `v${refreshed.version} 스냅샷을 받았지만 기록을 확인하거나 다시 불러오지 못했습니다: ${detail}`
					: `패키지 자료를 새로고침하지 못했습니다: ${detail}`;
				this.packageRefreshStates.set(installed.packageId, { state: 'error', message });
			}
		} finally {
			if (this.packageRefreshGeneration === generation) {
				this.packageBusy = false;
				this.render();
			}
		}
	}

	private async connectInstalledPackage(installed: WorkspaceInstalledPackageDTO, label: string, credential: string, grantedScopes: readonly string[]): Promise<void> {
		if (!this.projectId || this.packageBusy || !credential.trim()) return;
		const projectId = this.projectId;
		this.packageBusy = true;
		this.packageError = undefined;
		this.packageMessage = undefined;
		this.clearPackagePreview();
		this.render();
		try {
			const connection = await ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'connectPackageConnection', {
				projectId, packageId: installed.packageId, host: installed.domains[0], label: label.trim(), credential, grantedScopes,
			}) as WorkspacePackageConnectionDTO;
			if (this.projectId === projectId) {
				this.packageConnectionIds.set(installed.packageId, connection.connectionId);
				this.packageMessage = `${connection.label} 연결을 저장했습니다.`;
				await this.loadInstalledPackages();
			}
		} catch (error) {
			const operationError = this.errorMessage(error, '패키지 계정을 연결하지 못했습니다.');
			const loaded = this.projectId === projectId && await this.loadInstalledPackages();
			if (this.projectId === projectId) this.packageError = loaded ? operationError : `${operationError} · 계정 상태도 다시 불러오지 못했습니다.`;
		} finally {
			this.packageBusy = false;
			this.render();
		}
	}

	private renderPackageConnectors(panel: HTMLElement): void {
		const projectId = this.projectId;
		const section = panel.appendChild($('.project-dashboard__package-connectors'));
		const heading = section.appendChild($('.project-dashboard__knowledge-section-heading'));
		const title = heading.appendChild($('h3')); title.textContent = '서명된 로컬 커넥터 패키지';
		const note = section.appendChild($('p')); note.className = 'project-dashboard__connector-note'; note.textContent = '패키지에는 HTTPS 자료 규칙만 들어 있으며 코드를 실행하거나 계정 인증 정보에 접근할 수 없습니다. 설치 전에 도메인과 서명 정보를 확인하세요.';
		if (this.packageError) { const error = section.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert'); const text = error.appendChild($('span')); text.textContent = this.packageError; const retry = error.appendChild(createElement('button', 'project-dashboard__retry')); retry.type = 'button'; retry.textContent = '목록 다시 불러오기'; retry.addEventListener('click', () => void this.loadInstalledPackages()); }
		if (this.packageMessage) { const message = section.appendChild($('.project-dashboard__knowledge-success')); message.setAttribute('role', 'status'); message.textContent = this.packageMessage; }
		if (this.packageLoading) { const status = section.appendChild($('.project-dashboard__status')); status.setAttribute('role', 'status'); status.textContent = '설치된 패키지 불러오는 중…'; }
		const upload = section.appendChild(createElement('div', 'project-dashboard__package-upload'));
		const uploadLabel = upload.appendChild(createElement('label')); uploadLabel.htmlFor = 'connector-package-file'; uploadLabel.textContent = '서명된 패키지 JSON 파일 선택';
		const fileInput = upload.appendChild(createElement('input')); fileInput.id = 'connector-package-file'; fileInput.type = 'file'; fileInput.accept = '.json,application/json'; fileInput.disabled = this.packageBusy; fileInput.dataset.focusKey = 'connector-package-file';
		const fileHint = upload.appendChild($('p')); fileHint.className = 'project-dashboard__connector-note'; fileHint.textContent = this.packageFileName ? `선택한 파일: ${this.packageFileName} · 최대 192 KiB` : '로컬 .json 파일 선택 · 최대 192 KiB';
		fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void this.reviewPackageFile(file); });
		if (this.packageBusy) { const status = section.appendChild($('.project-dashboard__status')); status.setAttribute('role', 'status'); status.textContent = '커넥터 작업 진행 중…'; }
		if (this.packageReview) {
			const review = section.appendChild($('.project-dashboard__package-review'));
			const title = review.appendChild($('h4')); title.textContent = `${this.packageReview.name} · v${this.packageReview.version}`;
			const description = review.appendChild($('p')); description.textContent = this.packageReview.description;
			const metadata = review.appendChild($('dl'));
			const trustStatusLabels: Record<WorkspacePackageReviewDTO['trustStatus'], string> = {
				'first-install': '새 패키지',
				installed: '설치된 패키지',
				'same-key-update': '같은 서명 키로 업데이트',
			};
			const accountAccessLabels: Record<WorkspacePackageReviewDTO['accountAccess'], string> = {
				none: '익명 (계정 정보 없음)',
				'bearer-token': '앱에서 관리하는 토큰',
			};
			for (const [label, value] of [
				['패키지 ID', this.packageReview.packageId], ['신뢰 상태', trustStatusLabels[this.packageReview.trustStatus]],
				['서명 지문', this.packageReview.fingerprint], ['매니페스트 해시 (SHA-256)', this.packageReview.manifestDigest],
				['인증 방식', accountAccessLabels[this.packageReview.accountAccess]],
				['요청 권한 (패키지 주장)', this.packageReview.requestedScopes.length ? this.packageReview.requestedScopes.join(', ') : '없음'],
			] as const) { const term = metadata.appendChild($('dt')); term.textContent = label; const detail = metadata.appendChild($('dd')); detail.textContent = value; }
			const domainsTitle = review.appendChild($('h5')); domainsTitle.textContent = '전체 네트워크 도메인';
			const domains = review.appendChild($('ul')); for (const domain of this.packageReview.domains) { const item = domains.appendChild($('li')); item.textContent = domain; }
			const sourcesTitle = review.appendChild($('h5')); sourcesTitle.textContent = '포함된 자료';
			const sources = review.appendChild($('ul')); for (const source of this.packageReview.sources) { const item = sources.appendChild($('li')); item.textContent = source.label; }
			const rulesTitle = review.appendChild($('h5')); rulesTitle.textContent = '자료 수집 규칙';
			const rules = review.appendChild($('.project-dashboard__package-rules'));
			for (const rule of this.packageReview.sourceRules) {
				const ruleCard = rules.appendChild($('.project-dashboard__package-rule'));
				const ruleTitle = ruleCard.appendChild($('strong')); ruleTitle.textContent = rule.label;
				const ruleRoute = ruleCard.appendChild($('code')); ruleRoute.textContent = `${rule.domain} · ${rule.method} ${rule.path}`;
				const ruleFields = ruleCard.appendChild($('p')); ruleFields.textContent = `필드: ${rule.fields.join(', ')}`;
				const rulePagination = ruleCard.appendChild($('p')); rulePagination.textContent = `페이지 탐색: ${rule.paginated ? '서명된 규칙 사용' : '사용 안 함'}`;
			}
			const existing = this.installedPackages.find(item => item.packageId === this.packageReview!.packageId);
			const consent = section.appendChild(createElement('button', 'project-dashboard__primary')); consent.type = 'button'; consent.disabled = this.packageBusy || !this.packageEnvelope;
			consent.textContent = this.packageBusy ? '확인 대기 중…' : existing ? '업데이트 승인 및 설치' : '승인 및 설치';
			consent.addEventListener('click', () => {
				const currentReview = this.packageReview; const envelope = this.packageEnvelope;
				if (!projectId || !currentReview || !envelope) return;
				const approval = { packageId: currentReview.packageId, version: currentReview.version, fingerprint: currentReview.fingerprint, manifestDigest: currentReview.manifestDigest };
				void this.runPackageAction(async () => {
					await ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'installPackage', { projectId, envelope, approval });
					if (this.projectId === projectId && this.packageEnvelope === envelope) {
						this.packageReview = undefined; this.packageEnvelope = undefined; this.packageFileName = '';
					}
				}, '패키지 설치를 승인하고 완료했습니다.');
			});
		}
		const installedHeading = section.appendChild($('.project-dashboard__knowledge-section-heading'));
		const installedTitle = installedHeading.appendChild($('h4')); installedTitle.textContent = '설치된 패키지';
		if (!this.installedPackages.length && !this.packageLoading) { const empty = section.appendChild($('.project-dashboard__knowledge-empty')); empty.textContent = '이 프로젝트에 설치된 로컬 커넥터 패키지가 없습니다.'; }
		for (const packageId of this.installedPackageDetailsOpen) {
			if (!this.installedPackages.some(installed => installed.packageId === packageId)) this.installedPackageDetailsOpen.delete(packageId);
		}
		for (const installed of this.installedPackages) {
			const card = section.appendChild($('.project-dashboard__package-card'));
			const packageConnections = this.packageConnections.filter(connection => connection.packageId === installed.packageId);
			const activeConnections = packageConnections.filter(connection => connection.state === 'active').length;
			const pendingConnections = packageConnections.some(connection => connection.state === 'pending' || connection.state === 'disconnecting');
			const packageDetails = card.appendChild(document.createElement('details'));
			packageDetails.className = 'project-dashboard__package-disclosure';
			packageDetails.open = this.installedPackageDetailsOpen.has(installed.packageId);
			packageDetails.addEventListener('toggle', () => {
				if (packageDetails.open) this.installedPackageDetailsOpen.add(installed.packageId);
				else this.installedPackageDetailsOpen.delete(installed.packageId);
			});
			const packageDisclosureSummary = packageDetails.appendChild(document.createElement('summary'));
			packageDisclosureSummary.className = 'project-dashboard__package-summary';
			const packageSummary = packageDisclosureSummary.appendChild(createElement('span', 'project-dashboard__package-summary-info'));
			const packageTitle = packageSummary.appendChild($('strong')); packageTitle.textContent = `${installed.name} · v${installed.version}`;
			const packageStatus = packageSummary.appendChild($('span')); packageStatus.className = 'project-dashboard__package-status';
			packageStatus.textContent = pendingConnections
				? '계정 정리 필요'
				: activeConnections
					? `연결 계정 ${activeConnections}개`
					: installed.accountAccess === 'bearer-token' ? '계정 연결 필요' : '익명 인증';
			const packageAction = packageDisclosureSummary.appendChild($('span')); packageAction.className = 'project-dashboard__package-action';
			packageAction.textContent = pendingConnections ? '계정 확인' : installed.accountAccess === 'bearer-token' && !activeConnections ? '계정 연결' : '자료 가져오기';
			const packageContent = packageDetails.appendChild(createElement('div', 'project-dashboard__package-content'));
			const packageMeta = packageContent.appendChild($('p')); packageMeta.textContent = `${installed.packageId} · 키 ${installed.fingerprint} · 업데이트 ${new Date(installed.updatedAt).toLocaleDateString()}`;
			const auth = packageContent.appendChild(createElement('section', 'project-dashboard__package-auth'));
			const authTitle = auth.appendChild($('h5')); authTitle.textContent = '계정 연결';
			const authNote = auth.appendChild($('p')); authNote.className = 'project-dashboard__connector-note';
			authNote.textContent = installed.accountAccess === 'bearer-token'
				? `인증 방식: 앱이 관리하는 bearer token · 호스트: ${installed.domains[0]} · 요청 권한(패키지 주장): ${installed.requestedScopes.join(', ')}. 권한은 패키지의 주장으로, 제공자가 검증한 권한이 아닙니다.`
				: '인증 방식: 익명 · 이 패키지의 안정적인 앱 계정이 자동으로 선택됩니다.';
			if (packageConnections.length) {
				const accountLabel = auth.appendChild(createElement('label')); accountLabel.htmlFor = `package-account-${installed.packageId}`; accountLabel.textContent = '자료 미리보기와 새로고침에 사용할 계정';
				const accountSelect = auth.appendChild(document.createElement('select')); accountSelect.id = accountLabel.htmlFor; accountSelect.disabled = this.packageBusy;
				for (const connection of packageConnections.filter(item => item.state === 'active')) {
					const option = accountSelect.appendChild(document.createElement('option')); option.value = connection.connectionId;
					option.textContent = `${connection.label} · ${connection.authKind === 'none' ? '익명' : connection.grantedScopes.join(', ')}`;
					option.selected = connection.connectionId === this.packageConnectionIds.get(installed.packageId);
				}
				accountSelect.addEventListener('change', () => { this.packageConnectionIds.set(installed.packageId, accountSelect.value); this.clearPackagePreview(); this.packageRefreshStates.delete(installed.packageId); this.render(); });
			}
			for (const connection of packageConnections) {
				const connectionRow = auth.appendChild(createElement('div', 'project-dashboard__package-connection'));
				const connectionInfo = connectionRow.appendChild($('span')); connectionInfo.textContent = `${connection.label} · ${connection.state === 'active' ? '연결됨' : connection.state === 'disconnecting' ? '정리 대기' : connection.state === 'pending' ? '연결 준비 중' : '연결 해제됨'} · 권한(패키지 주장): ${connection.grantedScopes.join(', ') || '없음'}`;
				if (connection.state === 'active' && connection.authKind === 'bearer-token') {
					const revoke = connectionRow.appendChild(createElement('button', 'project-dashboard__danger')); revoke.type = 'button'; revoke.disabled = this.packageBusy; revoke.textContent = '연결 해제';
					revoke.addEventListener('click', () => void this.runPackageAction(() => ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'disconnectPackageConnection', { projectId: this.projectId, packageId: installed.packageId, connectionId: connection.connectionId }), `${connection.label} 연결을 해제했습니다.`));
				} else if (connection.state === 'disconnecting' || connection.state === 'pending') {
					const retryCleanup = connectionRow.appendChild(createElement('button', 'project-dashboard__retry')); retryCleanup.type = 'button'; retryCleanup.disabled = this.packageBusy; retryCleanup.textContent = '정리 다시 시도';
					retryCleanup.addEventListener('click', () => void this.runPackageAction(() => ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'retryPackageConnectionCleanup', { projectId: this.projectId, packageId: installed.packageId, connectionId: connection.connectionId }), '연결 정보 정리를 다시 시도했습니다.'));
				}
			}
			if (installed.accountAccess === 'bearer-token') {
				const connect = auth.appendChild(createElement('form', 'project-dashboard__package-connect'));
				const connectHeading = connect.appendChild($('h5')); connectHeading.textContent = '계정 추가';
				const label = connect.appendChild(createElement('label')); label.htmlFor = `package-account-label-${installed.packageId}`; label.textContent = '계정 이름';
				const labelInput = connect.appendChild(document.createElement('input')); labelInput.id = label.htmlFor; labelInput.required = true; labelInput.autocomplete = 'off'; labelInput.value = this.packageConnectionLabel; labelInput.disabled = this.packageBusy;
				const tokenLabel = connect.appendChild(createElement('label')); tokenLabel.htmlFor = `package-token-${installed.packageId}`; tokenLabel.textContent = 'Bearer token (16자 이상)';
				const tokenInput = connect.appendChild(document.createElement('input')); tokenInput.id = tokenLabel.htmlFor; tokenInput.type = 'password'; tokenInput.required = true; tokenInput.minLength = 16; tokenInput.pattern = '[!-~]{16,}'; tokenInput.autocomplete = 'new-password'; tokenInput.disabled = this.packageBusy;
				const tokenHint = connect.appendChild($('p')); tokenHint.id = `package-token-hint-${installed.packageId}`; tokenHint.className = 'project-dashboard__connector-note'; tokenHint.textContent = '공백 없는 ASCII 출력 가능 문자만 사용할 수 있으며, 최소 16자여야 합니다.';
				tokenInput.setAttribute('aria-describedby', tokenHint.id);
				tokenInput.addEventListener('input', () => {
					const message = packageTokenValidationMessage(tokenInput.value);
					tokenInput.setCustomValidity(message);
					if (message) tokenInput.setAttribute('aria-invalid', 'true');
					else tokenInput.removeAttribute('aria-invalid');
				});
				const scopesHeading = connect.appendChild($('p')); scopesHeading.className = 'project-dashboard__connector-note'; scopesHeading.textContent = '허용할 권한을 확인하세요. 이 목록은 패키지 주장으로, 제공자가 검증하지 않았습니다.';
				const scopes = connect.appendChild(createElement('div', 'project-dashboard__package-scopes'));
				const chosenScopes = new Set(this.packageConnectionScopes.get(installed.packageId) ?? installed.requestedScopes);
				for (const scope of installed.requestedScopes) {
					const scopeLabel = scopes.appendChild(createElement('label'));
					const checkbox = scopeLabel.appendChild(document.createElement('input')); checkbox.type = 'checkbox'; checkbox.value = scope; checkbox.checked = chosenScopes.has(scope); checkbox.disabled = this.packageBusy;
					const scopeName = scopeLabel.appendChild($('span')); scopeName.textContent = scope;
					checkbox.addEventListener('change', () => { if (checkbox.checked) chosenScopes.add(scope); else chosenScopes.delete(scope); this.packageConnectionScopes.set(installed.packageId, new Set(chosenScopes)); });
				}
				connect.addEventListener('submit', event => {
					event.preventDefault();
					const credential = tokenInput.value;
					const tokenError = packageTokenValidationMessage(credential);
					tokenInput.setCustomValidity(tokenError);
					if (tokenError) { tokenInput.reportValidity(); return; }
					this.packageConnectionLabel = labelInput.value;
					tokenInput.value = '';
					void this.connectInstalledPackage(installed, labelInput.value, credential, [...chosenScopes]);
				});
			}
			const sourceForm = packageContent.appendChild(createElement('form', 'project-dashboard__package-import'));
			const sourceLabel = sourceForm.appendChild(createElement('label')); sourceLabel.htmlFor = `package-source-${installed.packageId}`; sourceLabel.textContent = '자료';
			const sourceSelect = sourceForm.appendChild(createElement('select')); sourceSelect.id = `package-source-${installed.packageId}`; sourceSelect.required = true; sourceSelect.disabled = this.packageBusy;
			for (const source of installed.sources) { const option = sourceSelect.appendChild($('option') as HTMLOptionElement); option.value = source.sourceId; option.textContent = source.label; }
			if (!installed.sources.some(source => source.sourceId === this.packageSourceIds.get(installed.packageId))) this.packageSourceIds.set(installed.packageId, installed.sources[0]?.sourceId ?? '');
			sourceSelect.value = this.packageSourceIds.get(installed.packageId) ?? ''; sourceSelect.addEventListener('change', () => { this.packageSourceIds.set(installed.packageId, sourceSelect.value); this.clearPackagePreview(); this.render(); });
			const keyLabel = sourceForm.appendChild(createElement('label')); keyLabel.htmlFor = `package-source-key-${installed.packageId}`; keyLabel.textContent = '원격 자료 ID';
			const sourceKey = sourceForm.appendChild(createElement('input')); sourceKey.id = `package-source-key-${installed.packageId}`; sourceKey.required = true; sourceKey.autocomplete = 'off'; sourceKey.placeholder = '자료 식별자를 입력하세요'; sourceKey.value = this.packageSourceKey; sourceKey.disabled = this.packageBusy; sourceKey.dataset.focusKey = 'package-source-key'; sourceKey.addEventListener('input', () => { this.packageSourceKey = sourceKey.value; if (this.packagePreview) { this.clearPackagePreview(); this.render(); } });
			const importButton = sourceForm.appendChild(createElement('button', 'project-dashboard__secondary')); importButton.type = 'submit'; importButton.disabled = this.packageBusy || !installed.sources.length || !this.selectedPackageConnection(installed); importButton.textContent = this.packageBusy ? '미리보기 준비 중…' : '자료 미리보기';
			sourceForm.addEventListener('submit', event => {
				event.preventDefault();
				const sourceKeyValue = sourceKey.value.trim(); const sourceId = sourceSelect.value;
				if (!projectId || !sourceKeyValue || !sourceId) return;
				void this.requestPackagePreview(installed, sourceId, sourceKeyValue);
			});
			const preview = this.packagePreview?.packageId === installed.packageId ? this.packagePreview : undefined;
			if (preview) {
				const previewCard = packageContent.appendChild($('.project-dashboard__connector-preview'));
				const previewTitle = previewCard.appendChild($('h4')); previewTitle.textContent = '가져올 자료 확인';
				const metadata = previewCard.appendChild($('dl'));
				const taskTitle = this.packagePreviewTaskId ? this.dashboard?.tasks.find(task => task.id === this.packagePreviewTaskId)?.title ?? this.packagePreviewTaskId : '연결할 작업 없음';
				for (const [label, value] of [['자료', preview.title], ['자료 URI', preview.sourceUri], ['내용 SHA-256', preview.contentSha256], ['미리보기 만료', new Date(preview.expiresAt).toLocaleString()], ['연결할 작업', taskTitle]] as const) {
					const term = metadata.appendChild($('dt')); term.textContent = label;
					const detail = metadata.appendChild($('dd')); detail.textContent = value;
				}
				if (preview.omissions.length) { const omitted = previewCard.appendChild($('p')); omitted.className = 'project-dashboard__connector-note'; omitted.textContent = `제외된 항목: ${preview.omissions.join(' · ')}`; }
				const contentLabel = previewCard.appendChild($('h5')); contentLabel.textContent = '저장할 텍스트';
				const content = previewCard.appendChild($('pre')); content.className = 'project-dashboard__connector-preview-content'; content.textContent = preview.content;
				const actions = previewCard.appendChild($('.project-dashboard__form-actions'));
				const confirm = actions.appendChild(createElement('button', 'project-dashboard__primary')); confirm.type = 'button'; confirm.textContent = this.packageBusy ? '확인한 자료 가져오는 중…' : '확인한 자료 가져오기'; confirm.disabled = this.packageBusy || Date.parse(preview.expiresAt) <= Date.now(); confirm.addEventListener('click', () => void this.importReviewedPackagePreview(preview));
			}
			const refreshCard = packageContent.appendChild(createElement('div', 'project-dashboard__package-refresh'));
			const refreshTitle = refreshCard.appendChild($('h5')); refreshTitle.textContent = '기존 자료 새로고침';
			const refreshHint = refreshCard.appendChild($('p')); refreshHint.textContent = '이 패키지 자료의 가장 최근 스냅샷을 선택하세요. 서명된 자료 규칙과 저장된 자료 ID를 사용해 새로고침합니다.';
			const candidates = this.packageRefreshCandidates(installed);
			let selectedReferenceId = this.packageRefreshReferenceIds.get(installed.packageId);
			if (!candidates.some(candidate => candidate.reference.id === selectedReferenceId)) {
				selectedReferenceId = candidates[0]?.reference.id;
				if (selectedReferenceId) this.packageRefreshReferenceIds.set(installed.packageId, selectedReferenceId);
				else this.packageRefreshReferenceIds.delete(installed.packageId);
			}
			const refreshLabel = refreshCard.appendChild(createElement('label')); refreshLabel.htmlFor = `package-refresh-source-${installed.packageId}`; refreshLabel.textContent = '가장 최근에 저장한 자료 스냅샷';
			const refreshSelect = refreshCard.appendChild(document.createElement('select')); refreshSelect.id = `package-refresh-source-${installed.packageId}`; refreshSelect.disabled = this.packageBusy || !candidates.length; refreshSelect.dataset.focusKey = `package-refresh-source:${installed.packageId}`;
			for (const candidate of candidates) {
				const option = refreshSelect.appendChild(document.createElement('option')); option.value = candidate.reference.id;
				option.textContent = `${candidate.sourceLabel} · ${candidate.sourceKey} · 버전 ${candidate.reference.version} · ${new Date(candidate.reference.retrievedAt).toLocaleString()}`;
				option.selected = candidate.reference.id === selectedReferenceId;
			}
			if (!candidates.length) {
				const option = refreshSelect.appendChild(document.createElement('option')); option.value = ''; option.textContent = this.knowledge ? '일치하는 자료 스냅샷이 없습니다' : '프로젝트 자료 기록을 불러오는 중';
			}
			refreshSelect.addEventListener('change', () => {
				this.packageRefreshReferenceIds.set(installed.packageId, refreshSelect.value);
				this.packageRefreshStates.delete(installed.packageId);
				this.render();
			});
			const selectedCandidate = candidates.find(candidate => candidate.reference.id === selectedReferenceId);
			const refreshButton = refreshCard.appendChild(createElement('button', 'project-dashboard__secondary')); refreshButton.type = 'button';
			const refreshState = this.packageRefreshStates.get(installed.packageId);
			refreshButton.textContent = refreshState?.state === 'loading' ? '새로고침 중…' : '선택한 자료 새로고침';
			refreshButton.disabled = this.packageBusy || !selectedCandidate;
			refreshButton.addEventListener('click', () => { if (selectedCandidate) void this.refreshInstalledPackageSource(installed, selectedCandidate); });
			if (refreshState) {
				const status = refreshCard.appendChild(createElement('p', `project-dashboard__package-refresh-status is-${refreshState.state}`));
				status.setAttribute('role', refreshState.state === 'error' ? 'alert' : 'status'); status.textContent = refreshState.message;
				if (refreshState.state === 'error') {
					const reloadHistory = refreshCard.appendChild(createElement('button', 'project-dashboard__retry')); reloadHistory.type = 'button'; reloadHistory.textContent = '자료 기록 다시 불러오기';
					reloadHistory.addEventListener('click', () => void this.loadKnowledge());
				}
			}
			if (selectedCandidate) {
				const historyDetails = refreshCard.appendChild(document.createElement('details'));
				const historySummary = historyDetails.appendChild(document.createElement('summary')); historySummary.textContent = '스냅샷 기록';
				const historyList = historyDetails.appendChild(document.createElement('ol'));
				for (const snapshot of (this.knowledge?.references ?? []).filter(reference => reference.sourceId === selectedCandidate.reference.sourceId
					&& reference.accountRef === this.selectedPackageConnection(installed)?.accountRef).sort((left, right) => left.version - right.version)) {
					const item = historyList.appendChild(document.createElement('li'));
					item.textContent = `버전 ${snapshot.version} · ${new Date(snapshot.retrievedAt).toLocaleString()}${snapshot.id === selectedCandidate.reference.id ? ' · 최신' : ''}`;
				}
			}
			const uninstall = packageContent.appendChild(createElement('button', 'project-dashboard__danger')); uninstall.type = 'button'; uninstall.disabled = this.packageBusy; uninstall.textContent = '패키지 제거'; uninstall.addEventListener('click', () => { if (!projectId) return; void this.runPackageAction(() => ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'uninstallPackage', { projectId, packageId: installed.packageId }), '패키지를 제거했습니다.'); });
		}
	}

	private async loadKnowledge(): Promise<void> {
		const projectId = this.projectId;
		if (!projectId) return;
		this.knowledgeLoading = true;
		this.knowledgeError = undefined;
		this.render();
		try {
			const knowledge = await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'getProjectKnowledge', projectId) as WorkspaceKnowledgeDTO;
			if (this.projectId === projectId) {
				this.knowledge = knowledge;
				this.conventionSourceIdsDraft = new Set([...this.conventionSourceIdsDraft].filter(id => knowledge.references.some(reference => reference.id === id)));
			}
		} catch (error) {
			if (this.projectId === projectId) this.knowledgeError = this.errorMessage(error, '프로젝트 자료와 작업 규칙을 불러오지 못했습니다.');
		} finally {
			if (this.projectId === projectId) { this.knowledgeLoading = false; this.render(); }
		}
	}

	private async loadTaskPromotions(taskId: string, force = false): Promise<void> {
		const projectId = this.projectId;
		if (!projectId || (!force && (this.taskPromotionsTaskId === taskId || this.taskPromotionRequestTaskId === taskId))) return;
		const generation = ++this.taskPromotionGeneration;
		this.taskPromotionRequestTaskId = taskId;
		this.taskPromotionLoading = true;
		this.taskPromotionLoadFailed = false;
		this.taskPromotionError = undefined;
		if (this.taskPromotionsTaskId !== taskId) this.taskPromotions = [];
		this.render();
		try {
			const promotions = await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'listTaskInstructionPromotions', { projectId, taskId }) as readonly WorkspaceTaskInstructionPromotionDTO[];
			if (generation === this.taskPromotionGeneration && this.projectId === projectId && this.selectedTaskId === taskId) {
				this.taskPromotions = promotions;
				this.taskPromotionsTaskId = taskId;
			}
		} catch (error) {
			if (generation === this.taskPromotionGeneration && this.projectId === projectId && this.selectedTaskId === taskId) {
				this.taskPromotionError = this.errorMessage(error, '승인한 작업 지시를 불러오지 못했습니다.');
				this.taskPromotionLoadFailed = true;
				this.taskPromotionsTaskId = taskId;
				this.invalidateReferenceViewer();
			}
		} finally {
			if (generation === this.taskPromotionGeneration) {
				this.taskPromotionRequestTaskId = undefined;
				this.taskPromotionLoading = false;
				if (this.projectId === projectId && this.selectedTaskId === taskId) this.render();
			}
		}
	}

	private invalidateReferenceViewer(): void {
		this.root?.querySelector<HTMLElement>('.project-dashboard__reference-viewer')?.removeAttribute('data-reference-loaded');
		this.preservedReferenceViewerElement = undefined;
	}

	private async promoteReferenceExcerpt(reference: WorkspaceReferenceContentDTO): Promise<void> {
		const projectId = this.projectId;
		const taskId = this.selectedTaskId;
		if (!projectId || !taskId || this.taskPromotionBusy) return;
		const excerpt = this.promotionExcerptDraft;
		if (!excerpt.trim()) { this.taskPromotionError = '승인할 자료 문장을 선택하거나 입력해 주세요.'; this.invalidateReferenceViewer(); this.render(); return; }
		this.taskPromotionBusy = true;
		this.taskPromotionError = undefined;
		this.taskPromotionLoadFailed = false;
		this.invalidateReferenceViewer(); this.render();
		try {
			await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'promoteReferenceExcerpt', { projectId, taskId, sourceSnapshotId: reference.id, excerpt });
			if (this.projectId === projectId && this.selectedTaskId === taskId) {
				this.promotionExcerptDraft = '';
				this.knowledgeMessage = '선택한 문장을 이 작업의 지시로 승인했습니다. 다음 실행 미리보기에서 전달될 내용을 확인하세요.';
				this.preview = undefined;
				this.subagentPreview = undefined;
				await this.loadTaskPromotions(taskId, true);
			}
		} catch (error) {
			if (this.projectId === projectId && this.selectedTaskId === taskId) this.taskPromotionError = this.errorMessage(error, '선택한 문장을 작업 지시로 승인하지 못했습니다.');
		} finally {
			this.taskPromotionBusy = false;
			this.invalidateReferenceViewer(); this.render();
		}
	}

	private async withdrawReferenceExcerpt(promotionId: string): Promise<void> {
		const projectId = this.projectId;
		const taskId = this.selectedTaskId;
		if (!projectId || !taskId || this.taskPromotionBusy) return;
		this.taskPromotionBusy = true;
		this.taskPromotionError = undefined;
		this.taskPromotionLoadFailed = false;
		this.render();
		try {
			await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'withdrawReferenceExcerpt', { projectId, taskId, promotionId });
			if (this.projectId === projectId && this.selectedTaskId === taskId) {
				this.preview = undefined;
				this.subagentPreview = undefined;
				await this.loadTaskPromotions(taskId, true);
			}
		} catch (error) {
			if (this.projectId === projectId && this.selectedTaskId === taskId) this.taskPromotionError = this.errorMessage(error, '작업 지시 승인을 취소하지 못했습니다.');
		} finally {
			this.taskPromotionBusy = false;
			this.render();
		}
	}

	private async mutateKnowledge(operation: () => Promise<unknown>, successMessage: string): Promise<void> {
		if (this.knowledgeBusy) return;
		this.knowledgeBusy = true;
		this.knowledgeError = undefined;
		this.knowledgeMessage = undefined;
		this.render();
		try {
			await operation();
			this.knowledgeMessage = successMessage;
			this.invalidateReferenceViewer();
			await this.loadKnowledge();
		} catch (error) {
			this.knowledgeError = this.errorMessage(error, '프로젝트 자료를 저장하지 못했습니다.');
		} finally {
			this.knowledgeBusy = false;
			this.render();
		}
	}

	private async previewWebsite(url: string): Promise<void> {
		if (!this.projectId || this.websiteBusy) return;
		const projectId = this.projectId;
		this.websiteBusy = true;
		this.websiteError = undefined;
		this.websiteMessage = undefined;
		this.clearWebsitePreview();
		this.render();
		try {
			const preview = await ipcRenderer.invoke(WORKSPACE_WEBSITE_CHANNEL, 'previewPage', { projectId, url }) as WorkspaceWebsitePreviewDTO;
			if (this.projectId === projectId) {
				this.websitePreview = preview;
				const expiresIn = Date.parse(preview.expiresAt) - Date.now();
				if (Number.isFinite(expiresIn) && expiresIn > 0) {
					this.websitePreviewExpiryTimer = setTimeout(() => {
						this.websitePreviewExpiryTimer = undefined;
						if (this.inputActive && this.projectId === projectId && this.websitePreview?.previewId === preview.previewId) this.render();
					}, expiresIn);
				}
			}
		} catch (error) {
			if (this.projectId === projectId) this.websiteError = this.errorMessage(error, '공개 페이지를 미리보지 못했습니다. URL을 확인하고 다시 시도해 주세요.');
		} finally {
			if (this.projectId === projectId) { this.websiteBusy = false; this.render(); }
		}
	}

	private async importWebsitePreview(): Promise<void> {
		const projectId = this.projectId;
		const preview = this.websitePreview;
		const taskId = this.selectedTaskId;
		if (!projectId || !preview || this.websiteBusy) return;
		if (!Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now()) {
			this.websiteError = '미리보기가 만료됐습니다. 페이지를 다시 미리보고 저장해 주세요.';
			this.render();
			return;
		}
		this.websiteBusy = true;
		this.websiteError = undefined;
		this.render();
		try {
			const reference = await ipcRenderer.invoke(WORKSPACE_WEBSITE_CHANNEL, 'importPreview', {
				projectId, previewId: preview.previewId, ...(taskId ? { taskId } : {}),
			}) as WorkspaceReferenceDTO;
			if (this.projectId === projectId) {
				this.clearWebsitePreview();
				const matchesPreview = !!reference && reference.connectorId === 'public-website'
					&& reference.sourceUri === preview.requestedUri
					&& reference.externalId === preview.sourceUri
					&& reference.title === preview.title
					&& reference.contentSha256 === preview.contentSha256;
				if (matchesPreview) {
					this.websiteMessage = taskId ? '페이지를 저장하고 선택한 작업에 연결했습니다.' : '페이지를 프로젝트 참고자료에 저장했습니다.';
				} else {
					this.websiteError = '페이지 가져오기는 완료됐지만 저장된 자료가 미리보기와 일치하지 않습니다. 참고자료 목록을 새로고침했습니다. 저장 결과를 확인하고 중복 가져오기는 피해주세요.';
				}
				await this.loadKnowledge();
			}
		} catch (error) {
			if (this.projectId === projectId) this.websiteError = this.errorMessage(error, '페이지를 저장하지 못했습니다. 다시 시도해 주세요.');
		} finally {
			if (this.projectId === projectId) { this.websiteBusy = false; this.render(); }
		}
	}

	private clearWebsitePreview(): void {
		if (this.websitePreviewExpiryTimer) clearTimeout(this.websitePreviewExpiryTimer);
		this.websitePreviewExpiryTimer = undefined;
		this.websitePreview = undefined;
	}

	private renderKnowledge(shell: HTMLElement): void {
		const section = shell.appendChild($('.project-dashboard__knowledge'));
		const heading = section.appendChild($('.project-dashboard__knowledge-heading'));
		const copy = heading.appendChild($('.project-dashboard__knowledge-copy'));
		const eyebrow = copy.appendChild($('.project-dashboard__eyebrow')); eyebrow.textContent = this.knowledgeView === 'references' ? '자료 연결' : '작업 기준';
		const title = copy.appendChild($('h2')); title.textContent = this.knowledgeView === 'references' ? '참고자료' : '프로젝트 규칙';
		const description = copy.appendChild($('p')); description.textContent = this.knowledgeView === 'references'
			? '연결한 서비스에서 자료를 가져오고 작업에 연결하세요.'
			: '참고자료를 바탕으로 규칙을 작성하고 검수하세요.';
		const tabs = section.appendChild($('.project-dashboard__knowledge-tabs'));
		tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '프로젝트 자료');
		for (const [view, label] of [['references', '참고자료'], ['conventions', '작업 규칙']] as const) {
			const tab = tabs.appendChild(createElement('button', 'project-dashboard__knowledge-tab'));
			tab.type = 'button'; tab.id = `knowledge-tab-${view}`; tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', String(this.knowledgeView === view)); tab.setAttribute('aria-controls', 'project-knowledge-panel');
			tab.tabIndex = this.knowledgeView === view ? 0 : -1; tab.textContent = label; tab.dataset.focusKey = `knowledge-tab:${view}`;
			tab.addEventListener('click', () => { if (view !== 'references') this.closeReferenceViewer(false); this.activeSection = view; this.knowledgeView = view; setProjectSidebarSection(view); this.render(); this.root?.querySelector<HTMLElement>(`#knowledge-tab-${view}`)?.focus({ preventScroll: true }); });
			tab.addEventListener('keydown', event => {
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
				event.preventDefault(); this.knowledgeView = this.knowledgeView === 'references' ? 'conventions' : 'references'; this.activeSection = this.knowledgeView;
				if (this.knowledgeView !== 'references') this.closeReferenceViewer(false);
				setProjectSidebarSection(this.knowledgeView);
				this.render(); this.root?.querySelector<HTMLElement>(`#knowledge-tab-${this.knowledgeView}`)?.focus({ preventScroll: true });
			});
		}
		const panel = section.appendChild($('.project-dashboard__knowledge-panel'));
		panel.id = 'project-knowledge-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `knowledge-tab-${this.knowledgeView}`); panel.tabIndex = 0;
		if (this.knowledgeLoading) { const status = panel.appendChild($('.project-dashboard__status')); status.setAttribute('role', 'status'); status.textContent = '프로젝트 자료 불러오는 중…'; return; }
		if (this.knowledgeError) {
			const error = panel.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert');
			const text = error.appendChild($('span')); text.textContent = this.knowledgeError;
			const retry = error.appendChild(createElement('button', 'project-dashboard__retry')); retry.type = 'button'; retry.textContent = '다시 시도'; retry.addEventListener('click', () => void this.loadKnowledge());
		}
		if (this.knowledgeMessage) { const message = panel.appendChild($('.project-dashboard__knowledge-success')); message.setAttribute('role', 'status'); message.textContent = this.knowledgeMessage; }
		if (!this.knowledge) {
			const status = panel.appendChild($('.project-dashboard__status')); status.textContent = '프로젝트 자료를 아직 불러올 수 없습니다.';
			if (this.knowledgeView === 'references') this.renderConnectorManagement(panel);
			return;
		}
		if (this.knowledgeView === 'references') {
			this.renderProjectReferences(panel);
			this.renderConnectorManagement(panel);
		} else {
			this.renderProjectConventions(panel);
		}
	}

	private renderConnectorManagement(panel: HTMLElement): void {
		const details = panel.appendChild(createElement('details', 'project-dashboard__connector-management'));
		details.open = this.connectorManagementOpen;
		details.addEventListener('toggle', () => { this.connectorManagementOpen = details.open; });
		const summary = details.appendChild(createElement('summary'));
		summary.textContent = '연결된 계정과 패키지';
		const content = details.appendChild(createElement('div'));
		this.renderConnectors(content);
	}

	private renderProjectReferences(panel: HTMLElement): void {
		const knowledge = this.knowledge!;
		const capture = panel.appendChild($('.project-dashboard__flow-card'));
		const captureTitle = capture.appendChild($('h3')); captureTitle.textContent = 'Ego에서 선택한 텍스트 가져오기';
		const captureNote = capture.appendChild($('p')); captureNote.textContent = 'Ego에서 URL을 열고 필요한 텍스트를 선택한 다음 직접 가져오세요. 페이지 내용은 자동으로 수집하지 않습니다.';
		const captureForm = capture.appendChild(createElement('form', 'project-dashboard__knowledge-form'));
		const urlLabel = captureForm.appendChild(createElement('label')); urlLabel.htmlFor = 'ego-capture-url'; urlLabel.textContent = '시작 URL';
		const url = captureForm.appendChild(createElement('input')); url.id = 'ego-capture-url'; url.type = 'url'; url.required = true; url.placeholder = 'https://…'; url.value = this.egoUrlDraft; url.disabled = this.egoBusy;
		url.addEventListener('input', () => this.egoUrlDraft = url.value);
		const captureActions = captureForm.appendChild($('.project-dashboard__form-actions'));
		const start = captureActions.appendChild(createElement('button', 'project-dashboard__primary')); start.type = 'submit'; start.textContent = this.egoBusy ? '처리 중…' : 'Ego에서 열기'; start.disabled = this.egoBusy || !!this.egoCaptureId || !this.selectedTaskId;
		captureForm.addEventListener('submit', event => { event.preventDefault(); if (this.selectedTaskId && this.projectId) void this.startEgoCapture(url.value.trim()); });
		if (!this.selectedTaskId) { const hint = capture.appendChild($('.project-dashboard__flow-status')); hint.textContent = '가져온 자료를 연결할 작업을 보드에서 선택하세요.'; }
		if (this.egoCaptureId) {
			const instructions = capture.appendChild($('.project-dashboard__flow-status')); instructions.setAttribute('role', 'status'); instructions.textContent = this.egoCleanupPending ? 'Ego가 시작 정리를 확인하지 못했습니다. 새로 가져오기 전에 현재 세션을 닫으세요.' : this.egoStatus?.state === 'handoff' ? 'Ego가 열려 있습니다. 텍스트를 선택한 뒤 여기로 돌아와 ‘선택 영역 가져오기’를 누르세요. 언제든 취소할 수 있습니다.' : '이 대시보드에서 시작한 Ego 세션이 아직 열려 있습니다. 새 세션을 시작하기 전에 닫으세요.';
			const actions = capture.appendChild($('.project-dashboard__flow-actions'));
			if (this.egoStatus?.state === 'handoff' && !this.egoCleanupPending) { const confirm = actions.appendChild(createElement('button', 'project-dashboard__primary')); confirm.type = 'button'; confirm.textContent = '선택 영역 가져오기'; confirm.disabled = this.egoBusy; confirm.addEventListener('click', () => void this.finishEgoCapture(false)); }
			const cancel = actions.appendChild(createElement('button', 'project-dashboard__secondary')); cancel.type = 'button'; cancel.textContent = this.egoCleanupPending || this.egoStatus?.state === 'failed' ? 'Ego 닫기 다시 시도' : '취소'; cancel.disabled = this.egoBusy; cancel.addEventListener('click', () => void this.closeEgoCapture());
		}
		if (this.egoError || this.egoStatus?.state === 'failed') { const error = capture.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert'); error.textContent = this.egoError ?? (this.egoStatus?.state === 'failed' ? this.errorMessage(new Error(this.egoStatus.message), 'Ego에서 텍스트를 가져오지 못했습니다.') : 'Ego에서 텍스트를 가져오지 못했습니다.'); }
		if (this.egoStatus?.state === 'captured') { const done = capture.appendChild($('.project-dashboard__flow-status')); done.setAttribute('role', 'status'); done.textContent = `‘${this.egoStatus.reference.title}’ 자료를 가져와 ${this.egoCapturedTaskTitle ?? '원래 작업'}에 연결했습니다.`; }
		if (this.egoStatus?.state === 'cancelled') { const cancelled = capture.appendChild($('.project-dashboard__flow-status')); cancelled.setAttribute('role', 'status'); cancelled.textContent = 'Ego 가져오기를 취소했습니다.'; }
		const website = panel.appendChild($('.project-dashboard__flow-card'));
		const websiteTitle = website.appendChild($('h3')); websiteTitle.textContent = '웹페이지 가져오기';
		const websiteNote = website.appendChild($('p')); websiteNote.textContent = '공개 웹페이지의 텍스트를 미리 확인한 뒤 저장하세요. 로그인이 필요한 페이지는 Ego에서 선택한 부분만 가져오세요.';
		const websiteForm = website.appendChild(createElement('form', 'project-dashboard__knowledge-form'));
		const websiteLabel = websiteForm.appendChild(createElement('label')); websiteLabel.htmlFor = 'knowledge-website-url'; websiteLabel.textContent = '페이지 URL';
		const websiteUrl = websiteForm.appendChild(createElement('input')); websiteUrl.id = 'knowledge-website-url'; websiteUrl.type = 'url'; websiteUrl.required = true; websiteUrl.placeholder = 'https://example.com/article'; websiteUrl.value = this.websiteUrlDraft; websiteUrl.disabled = this.websiteBusy; websiteUrl.dataset.focusKey = 'knowledge-website-url';
		const websitePreviewRegion = website.appendChild($('.project-dashboard__connector-preview-region'));
		websiteUrl.addEventListener('input', () => { this.websiteUrlDraft = websiteUrl.value; this.clearWebsitePreview(); this.websiteMessage = undefined; websitePreviewRegion.replaceChildren(); });
		const websiteActions = websiteForm.appendChild($('.project-dashboard__form-actions'));
		const websiteSubmit = websiteActions.appendChild(createElement('button', 'project-dashboard__secondary')); websiteSubmit.type = 'submit'; websiteSubmit.disabled = this.websiteBusy; websiteSubmit.textContent = this.websiteBusy ? '처리 중…' : '페이지 미리보기';
		websiteForm.addEventListener('submit', event => { event.preventDefault(); void this.previewWebsite(websiteUrl.value.trim()); });
		if (this.websiteError) { const error = website.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert'); error.textContent = this.websiteError; }
		if (this.websiteMessage) { const status = website.appendChild($('.project-dashboard__knowledge-success')); status.setAttribute('role', 'status'); status.textContent = this.websiteMessage; }
		if (this.websitePreview) {
			const websitePreview = this.websitePreview;
			const expiresAt = Date.parse(websitePreview.expiresAt);
			const expired = !Number.isFinite(expiresAt) || expiresAt <= Date.now();
			const preview = websitePreviewRegion.appendChild($('.project-dashboard__connector-preview'));
			const heading = preview.appendChild($('h4')); heading.textContent = websitePreview.title;
			const source = preview.appendChild($('p')); source.className = 'project-dashboard__connector-preview-disclosure';
			source.textContent = websitePreview.requestedUri === websitePreview.sourceUri
				? `요청 URL: ${websitePreview.requestedUri}`
				: `요청 URL: ${websitePreview.requestedUri} · 최종 URL: ${websitePreview.sourceUri}`;
			const expiry = preview.appendChild($('p')); expiry.className = 'project-dashboard__connector-preview-disclosure';
			expiry.textContent = expired ? '미리보기가 만료됐습니다. 페이지를 다시 미리보세요.' : `미리보기 저장 기한: ${new Date(expiresAt).toLocaleString()}`;
			const content = preview.appendChild(createElement('pre', 'project-dashboard__connector-preview-content')); content.textContent = websitePreview.derivedText;
			if (websitePreview.omissions.length) {
				const omissionLabels: Readonly<Record<string, string>> = {
					'Scripts': '스크립트',
					'Styles': '스타일',
					'Templates': '템플릿',
					'No-script content': '스크립트 없이 표시되는 내용',
					'SVG graphics': 'SVG 그림',
					'Navigation and page chrome': '탐색 메뉴 및 페이지 장식',
					'Page title truncated to 500 characters': '페이지 제목이 500자로 잘렸습니다',
				};
				const omissions = preview.appendChild($('p'));
				omissions.className = 'project-dashboard__connector-preview-disclosure';
				omissions.textContent = `텍스트 미리보기에서 제외됨: ${websitePreview.omissions.map(item => omissionLabels[item] ?? item).join(' · ')}`;
			}
			const disclosure = preview.appendChild($('p')); disclosure.className = 'project-dashboard__connector-preview-disclosure';
			disclosure.textContent = websitePreview.contentType.startsWith('text/plain')
				? '저장하면 원본 텍스트 전체가 참고자료로 보관됩니다.'
				: '저장하면 원본 HTML 전체가 참고자료로 보관됩니다. 페이지의 스크립트는 실행하지 않습니다.';
			const previewActions = preview.appendChild($('.project-dashboard__form-actions'));
			const save = previewActions.appendChild(createElement('button', 'project-dashboard__primary')); save.type = 'button'; save.disabled = this.websiteBusy || expired; save.textContent = this.selectedTaskId ? '저장하고 작업에 연결' : '프로젝트에 저장'; save.addEventListener('click', () => void this.importWebsitePreview());
			if (expired) { const retry = previewActions.appendChild(createElement('button', 'project-dashboard__secondary')); retry.type = 'button'; retry.disabled = this.websiteBusy; retry.textContent = '다시 미리보기'; retry.addEventListener('click', () => void this.previewWebsite(this.websiteUrlDraft.trim())); }
		}
		const heading = panel.appendChild($('.project-dashboard__knowledge-section-heading'));
		const title = heading.appendChild($('h3')); title.textContent = '참고자료';
		const count = heading.appendChild($('span')); count.textContent = `자료 ${knowledge.references.length}개`;
		if (!knowledge.references.length) { const empty = panel.appendChild($('.project-dashboard__knowledge-empty')); empty.textContent = '참고자료가 없습니다. 메모를 작성하거나 자료를 붙여넣어 프로젝트에 보관하세요.'; }
		else {
			const list = panel.appendChild($('.project-dashboard__knowledge-list'));
			for (const reference of knowledge.references) {
				const row = list.appendChild($('.project-dashboard__knowledge-card'));
				if (this.referenceViewerId === reference.id) row.classList.add('project-dashboard__knowledge-card--expanded');
				const main = row.appendChild($('.project-dashboard__knowledge-card-main'));
				const name = main.appendChild($('h4')); name.textContent = reference.title;
				const sourceName = this.referenceSourceLabel(reference.connectorId);
				const meta = main.appendChild($('p')); meta.textContent = `${sourceName} · ${reference.version}번째 버전 · 추가일 ${new Date(reference.retrievedAt).toLocaleDateString()}`;
				const linked = Object.entries(knowledge.taskReferences).filter(([, refs]) => refs.some(item => item.id === reference.id)).map(([taskId]) => this.dashboard?.tasks.find(task => task.id === taskId)?.title).filter((value): value is string => !!value);
				const linkedTo = main.appendChild($('p')); linkedTo.className = 'project-dashboard__knowledge-linked'; linkedTo.textContent = linked.length ? `연결된 작업: ${linked.join(', ')}` : '작업에 연결되지 않음';
				const view = row.appendChild(createElement('button', 'project-dashboard__secondary')); view.type = 'button'; view.textContent = this.referenceViewerId === reference.id ? '내용 닫기' : '내용 보기';
				view.dataset.focusKey = `reference-view:${reference.id}`;
				if (this.referenceViewerId === reference.id) view.setAttribute('aria-controls', `reference-viewer-${reference.id}`);
				view.setAttribute('aria-expanded', String(this.referenceViewerId === reference.id));
				view.setAttribute('aria-label', `${reference.title} ${reference.version}번째 버전의 저장된 내용 ${this.referenceViewerId === reference.id ? '닫기' : '보기'}`);
				view.addEventListener('click', () => this.referenceViewerId === reference.id ? this.closeReferenceViewer() : void this.openReferenceViewer(reference));
				if (this.referenceViewerId === reference.id) this.renderReferenceViewer(row);
				if (reference.sourceUri) { const uri = main.appendChild($('a') as HTMLAnchorElement); uri.href = reference.sourceUri; uri.target = '_blank'; uri.rel = 'noreferrer'; uri.textContent = reference.connectorId === 'public-website' ? `요청 URL: ${reference.sourceUri}` : reference.sourceUri; uri.className = 'project-dashboard__knowledge-uri'; }
				if (reference.connectorId === 'public-website' && reference.externalId && reference.externalId !== reference.sourceUri) { const finalUri = main.appendChild($('a') as HTMLAnchorElement); finalUri.href = reference.externalId; finalUri.target = '_blank'; finalUri.rel = 'noreferrer'; finalUri.textContent = `최종 URL: ${reference.externalId}`; finalUri.className = 'project-dashboard__knowledge-uri'; }
				if (reference.connectorId === 'public-website' && reference.sourceUri) {
					const refresh = row.appendChild(createElement('button', 'project-dashboard__secondary')); refresh.type = 'button'; refresh.disabled = this.websiteBusy; refresh.textContent = '페이지 새로고침'; refresh.setAttribute('aria-label', `${reference.title}의 새 버전 미리보기`);
					refresh.addEventListener('click', () => { this.websiteUrlDraft = reference.sourceUri!; void this.previewWebsite(reference.sourceUri!); });
				}
				if (this.selectedTaskId && !knowledge.taskReferences[this.selectedTaskId]?.some(item => item.id === reference.id)) {
					const attach = row.appendChild(createElement('button', 'project-dashboard__secondary')); attach.type = 'button'; attach.textContent = '선택한 작업에 연결'; attach.disabled = this.knowledgeBusy;
					const task = this.dashboard?.tasks.find(item => item.id === this.selectedTaskId);
					attach.setAttribute('aria-label', `${reference.title}을(를) ${task?.title ?? '선택한 작업'}에 연결`);
					attach.addEventListener('click', () => { if (this.projectId && this.selectedTaskId) void this.mutateKnowledge(() => ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'attachTaskReference', { projectId: this.projectId, taskId: this.selectedTaskId, snapshotId: reference.id }), '참고자료를 작업에 연결했습니다.'); });
				}
			}
		}
		const form = panel.appendChild(createElement('form', 'project-dashboard__knowledge-form'));
		const formTitle = form.appendChild($('h3')); formTitle.textContent = '텍스트 자료 추가';
		const titleLabel = form.appendChild(createElement('label')); titleLabel.htmlFor = 'knowledge-reference-title'; titleLabel.textContent = '제목';
		const titleInput = form.appendChild(createElement('input')); titleInput.id = 'knowledge-reference-title'; titleInput.required = true; titleInput.value = this.referenceTitleDraft; titleInput.disabled = this.knowledgeBusy; titleInput.dataset.focusKey = 'knowledge-reference-title';
		titleInput.addEventListener('input', () => { this.referenceTitleDraft = titleInput.value; });
		const contentLabel = form.appendChild(createElement('label')); contentLabel.htmlFor = 'knowledge-reference-content'; contentLabel.textContent = '내용';
		const content = form.appendChild(createElement('textarea')); content.id = 'knowledge-reference-content'; content.rows = 5; content.required = true; content.value = this.referenceContentDraft; content.disabled = this.knowledgeBusy; content.dataset.focusKey = 'knowledge-reference-content';
		content.addEventListener('input', () => { this.referenceContentDraft = content.value; });
		const actions = form.appendChild($('.project-dashboard__form-actions'));
		const submit = actions.appendChild(createElement('button', 'project-dashboard__primary')); submit.type = 'submit'; submit.disabled = this.knowledgeBusy; submit.textContent = this.knowledgeBusy ? '저장 중…' : '자료 추가';
		form.addEventListener('submit', event => {
			event.preventDefault(); const projectId = this.projectId; const referenceTitle = titleInput.value.trim(); const referenceContent = content.value;
			if (!projectId || !referenceTitle || !referenceContent.trim()) return;
			void this.mutateKnowledge(async () => {
				await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'importTextReference', { projectId, title: referenceTitle, content: referenceContent });
				this.referenceTitleDraft = ''; this.referenceContentDraft = '';
			}, '텍스트 자료를 추가했습니다.');
		});
	}

	private renderProjectConventions(panel: HTMLElement): void {
		const knowledge = this.knowledge!;
		const active = knowledge.conventions.find(item => item.id === knowledge.activeConventionId);
		const selectedCheckConvention = knowledge.conventions.find(item => item.id === this.conventionCheckVersionId) ?? active ?? knowledge.conventions[0];
		if (this.conventionAgentOperation === 'check' && selectedCheckConvention) this.conventionCheckVersionId = selectedCheckConvention.id;
		const activeCard = panel.appendChild($('.project-dashboard__active-convention'));
		const activeTitle = activeCard.appendChild($('h3')); activeTitle.textContent = active ? `적용된 작업 규칙 · v${active.version}` : '적용된 작업 규칙이 없습니다';
		const activeNeedsCheck = !!active && active.authoredBy !== 'person' && active.latestCheckVerdict !== 'pass';
		const activeDescription = activeCard.appendChild($('p'));
		activeDescription.textContent = active
			? `적용 시각: ${active.lastAppliedAt ? new Date(active.lastAppliedAt).toLocaleString() : '날짜 정보 없음'}.${active.authoredBy !== 'person' ? ` 최근 검사: ${active.latestCheckVerdict === 'pass' ? '통과' : active.latestCheckVerdict === 'fail' ? '실패' : '확인하지 않음'}.` : ''} ${activeNeedsCheck ? '새 검사를 통과할 때까지 에이전트 실행이 차단됩니다.' : '이 버전이 이후 프로젝트 실행에 적용됩니다.'}`
			: '작업 규칙 초안을 작성하고 준비가 끝나면 적용하세요.';
		if (active) { const preview = activeCard.appendChild(createElement('pre', 'project-dashboard__convention-preview')); preview.textContent = active.markdown; }
		if (activeNeedsCheck && active) {
			const recheck = activeCard.appendChild(createElement('button', 'project-dashboard__secondary')); recheck.type = 'button'; recheck.textContent = '현재 버전 검사'; recheck.disabled = this.conventionAgentBusy;
			recheck.addEventListener('click', () => this.selectConventionForCheck(active));
		}
		const heading = panel.appendChild($('.project-dashboard__knowledge-section-heading'));
		const title = heading.appendChild($('h3')); title.textContent = '작업 규칙 초안 작성';
		const draftForm = panel.appendChild(createElement('form', 'project-dashboard__knowledge-form'));
		const draftLabel = draftForm.appendChild(createElement('label')); draftLabel.htmlFor = 'knowledge-convention-draft'; draftLabel.textContent = '프로젝트 작업 규칙';
		const draft = draftForm.appendChild(createElement('textarea')); draft.id = 'knowledge-convention-draft'; draft.rows = 7; draft.required = true; draft.value = this.conventionDraft; draft.disabled = this.knowledgeBusy; draft.dataset.focusKey = 'knowledge-convention-draft';
		draft.placeholder = '프로젝트에서 지킬 작업 규칙을 작성하세요…'; draft.addEventListener('input', () => { this.conventionDraft = draft.value; });
		if (knowledge.references.length) {
			const sources = draftForm.appendChild($('.project-dashboard__knowledge-source-list'));
			const sourceHeading = sources.appendChild($('span')); sourceHeading.textContent = '참고자료 기반 (선택)';
			for (const reference of knowledge.references) {
				const label = sources.appendChild(createElement('label', 'project-dashboard__knowledge-source'));
				const checkbox = label.appendChild(createElement('input')); checkbox.type = 'checkbox'; checkbox.value = reference.id; checkbox.checked = this.conventionSourceIdsDraft.has(reference.id); checkbox.disabled = this.knowledgeBusy;
				checkbox.addEventListener('change', () => checkbox.checked ? this.conventionSourceIdsDraft.add(reference.id) : this.conventionSourceIdsDraft.delete(reference.id));
				const labelText = label.appendChild($('span')); labelText.textContent = reference.title;
			}
		}
		const actions = draftForm.appendChild($('.project-dashboard__form-actions'));
		const create = actions.appendChild(createElement('button', 'project-dashboard__primary')); create.type = 'submit'; create.disabled = this.knowledgeBusy; create.textContent = this.knowledgeBusy ? '저장 중…' : '초안 저장';
		draftForm.addEventListener('submit', event => {
			event.preventDefault(); const projectId = this.projectId; const markdown = draft.value;
			if (!projectId || !markdown.trim()) return;
			void this.mutateKnowledge(async () => {
				await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'createConventionDraft', { projectId, markdown, sourceSnapshotIds: [...this.conventionSourceIdsDraft] });
				this.conventionDraft = '';
				this.conventionSourceIdsDraft.clear();
			}, '작업 규칙 초안을 저장했습니다.');
		});
		const agent = panel.appendChild($('.project-dashboard__flow-card'));
		const agentTitle = agent.appendChild($('h3')); agentTitle.textContent = '에이전트에게 초안 작성 또는 검사 요청';
		const agentForm = agent.appendChild(createElement('form', 'project-dashboard__knowledge-form'));
		const providerLabel = agentForm.appendChild(createElement('label')); providerLabel.htmlFor = 'convention-agent-provider'; providerLabel.textContent = '제공자';
		const provider = agentForm.appendChild(document.createElement('select')); provider.id = 'convention-agent-provider'; provider.disabled = this.conventionAgentBusy;
		for (const id of ['claude', 'codex'] as const) { const option = provider.appendChild(document.createElement('option')); option.value = id; option.textContent = id === 'claude' ? 'Claude' : 'Codex'; option.selected = this.conventionAgentProvider === id; }
		provider.addEventListener('change', () => { this.conventionAgentProvider = provider.value as ProviderId; this.conventionAgentPreview = undefined; this.conventionAgentResult = undefined; this.render(); });
		const operationLabel = agentForm.appendChild(createElement('label')); operationLabel.htmlFor = 'convention-agent-operation'; operationLabel.textContent = '작업';
		const operation = agentForm.appendChild(document.createElement('select')); operation.id = 'convention-agent-operation'; operation.disabled = this.conventionAgentBusy;
		for (const [value, label] of [['draft','새 작업 규칙 초안 작성'],['check','작업 규칙 버전 검사']] as const) { const option = operation.appendChild(document.createElement('option')); option.value = value; option.textContent = label; option.selected = this.conventionAgentOperation === value; }
		operation.addEventListener('change', () => { this.conventionAgentOperation = operation.value as 'draft' | 'check'; this.conventionAgentPreview = undefined; this.conventionAgentResult = undefined; this.render(); });
		if (this.conventionAgentOperation === 'check' && knowledge.conventions.length) {
			const versionLabel = agentForm.appendChild(createElement('label')); versionLabel.htmlFor = 'convention-check-version'; versionLabel.textContent = '검사할 버전';
			const versionSelect = agentForm.appendChild(document.createElement('select')); versionSelect.id = 'convention-check-version'; versionSelect.disabled = this.conventionAgentBusy;
			for (const convention of knowledge.conventions) {
				const option = versionSelect.appendChild(document.createElement('option')); option.value = convention.id;
				option.textContent = `v${convention.version}${convention.active ? ' · 적용 중' : ' · 초안'} · ${convention.authoredBy === 'person' ? '직접 작성' : convention.authoredBy}`;
				option.selected = convention.id === this.conventionCheckVersionId;
			}
			versionSelect.addEventListener('change', () => { this.conventionCheckVersionId = versionSelect.value; this.conventionAgentPreview = undefined; this.conventionAgentResult = undefined; this.conventionAgentError = undefined; this.conventionAgentNotice = undefined; this.render(); });
		}
		if (this.conventionAgentOperation === 'draft') {
			const sourceBox = agentForm.appendChild($('.project-dashboard__knowledge-source-list'));
			const sourceHeading = sourceBox.appendChild($('span')); sourceHeading.textContent = '참고자료 스냅샷';
			for (const reference of knowledge.references) { const label = sourceBox.appendChild(createElement('label','project-dashboard__knowledge-source')); const checkbox = label.appendChild(createElement('input')); checkbox.type='checkbox'; checkbox.value=reference.id; checkbox.checked=this.conventionAgentSourceIds.has(reference.id); checkbox.disabled=this.conventionAgentBusy; checkbox.addEventListener('change',()=>{checkbox.checked?this.conventionAgentSourceIds.add(reference.id):this.conventionAgentSourceIds.delete(reference.id);this.conventionAgentPreview=undefined;this.conventionAgentResult=undefined;this.render();}); const text=label.appendChild($('span')); text.textContent=`${reference.title} · v${reference.version}`; }
		}
		const agentActions = agentForm.appendChild($('.project-dashboard__form-actions'));
		const previewButton = agentActions.appendChild(createElement('button','project-dashboard__secondary')); previewButton.type='button'; previewButton.textContent='요청 미리보기'; previewButton.disabled=this.conventionAgentBusy || !this.selectedTaskId || (this.conventionAgentOperation === 'check' && !selectedCheckConvention); previewButton.addEventListener('click',()=>void this.previewConventionAgent());
		agentForm.addEventListener('submit',event=>event.preventDefault());
		if (!this.selectedTaskId) { const hint=agent.appendChild($('.project-dashboard__flow-status')); hint.textContent='에이전트 요청을 준비하려면 작업을 선택하세요.'; }
		if (this.conventionAgentOperation === 'check' && !selectedCheckConvention) { const hint=agent.appendChild($('.project-dashboard__flow-status')); hint.textContent='검사를 실행하기 전에 작업 규칙 버전을 저장하세요.'; }
		if (this.conventionAgentPreview) {
			const preview = agent.appendChild($('.project-dashboard__agent-preview'));
			const summary = preview.appendChild($('p')); summary.textContent=`${this.conventionAgentPreview.operation === 'draft' ? '초안' : '검사'} · ${this.conventionAgentPreview.providerId} (${this.conventionAgentPreview.accountLabel}) · 작업 리비전 ${this.conventionAgentPreview.task.revision}`;
			const permission=preview.appendChild($('p')); permission.textContent=`권한: ${this.conventionAgentPreview.permissionSummary}${this.conventionAgentPreview.blockedReason ? ` · 차단 사유: ${this.errorMessage(new Error(this.conventionAgentPreview.blockedReason), '현재 권한 설정으로는 실행할 수 없습니다.')}` : ''}`;
			for (const reference of this.conventionAgentPreview.references) { const meta=preview.appendChild($('p')); meta.textContent=`스냅샷: ${reference.title} · v${reference.version} · SHA-256 ${reference.contentSha256}`; const body=preview.appendChild(createElement('pre','project-dashboard__convention-preview')); body.textContent=reference.content; }
			if (this.conventionAgentPreview.convention) { const existing=preview.appendChild(createElement('pre','project-dashboard__convention-preview')); existing.textContent=`선택한 작업 규칙 v${this.conventionAgentPreview.convention.version} · SHA-256 ${this.conventionAgentPreview.convention.contentSha256}\n\n${this.conventionAgentPreview.convention.markdown}`; }
			const prompt=preview.appendChild(createElement('pre','project-dashboard__convention-preview')); prompt.textContent=this.conventionAgentPreview.prompt;
			const run=agent.appendChild(createElement('button','project-dashboard__primary')); run.type='button'; run.textContent=this.conventionAgentBusy?'실행 중…':this.conventionAgentOperation==='draft'?'초안 작성 실행':'검사 실행'; run.disabled=this.conventionAgentBusy || !this.conventionAgentPreview.allowed; run.addEventListener('click',()=>void this.runConventionAgent());
		}
		if (this.conventionAgentError) { const error=agent.appendChild($('.project-dashboard__error')); error.setAttribute('role','alert'); error.textContent=this.conventionAgentError; }
		if (this.conventionAgentNotice) { const notice=agent.appendChild($('.project-dashboard__flow-status')); notice.setAttribute('role','status'); notice.textContent=this.conventionAgentNotice; }
		if (this.conventionAgentResult) {
			const outcome = this.conventionAgentResult;
			const result = agent.appendChild($('.project-dashboard__agent-preview'));
			const heading = result.appendChild($('h4'));
			if (this.conventionAgentOperation === 'draft') {
				heading.textContent = outcome.versionNumber ? `초안을 v${outcome.versionNumber}으로 저장했습니다` : `초안 · ${this.stateLabel(outcome.attempt.state)}`;
			} else {
				heading.textContent = `검사 결과 · ${outcome.verdict ? this.conventionVerdictLabel(outcome.verdict) : this.stateLabel(outcome.attempt.state)}`;
			}
			const report = result.appendChild(createElement('pre', 'project-dashboard__convention-preview'));
			const generated = outcome.versionId ? knowledge.conventions.find(item => item.id === outcome.versionId)?.markdown : undefined;
			report.textContent = generated ?? outcome.report ?? outcome.attempt.errorSummary ?? `실행 ${outcome.attempt.id}: ${this.stateLabel(outcome.attempt.state)}`;
			const refresh = result.appendChild(createElement('button', 'project-dashboard__secondary'));
			refresh.type = 'button';
			refresh.textContent = '자료와 버전 새로고침';
			refresh.addEventListener('click', () => void this.loadKnowledge());
		}
		const historyHeading = panel.appendChild($('.project-dashboard__knowledge-section-heading'));
		const historyTitle = historyHeading.appendChild($('h3')); historyTitle.textContent = '버전 기록';
		if (!knowledge.conventions.length) { const empty = panel.appendChild($('.project-dashboard__knowledge-empty')); empty.textContent = '아직 작업 규칙 초안이 없습니다.'; return; }
		const history = panel.appendChild($('.project-dashboard__knowledge-list'));
		for (const convention of knowledge.conventions) {
			const row = history.appendChild($('.project-dashboard__knowledge-card'));
			const main = row.appendChild($('.project-dashboard__knowledge-card-main'));
			const name = main.appendChild($('h4')); name.textContent = `버전 ${convention.version}${convention.active ? ' · 적용 중' : ''}`;
			const verdict = convention.latestCheckVerdict ? `최근 검사: ${this.conventionVerdictLabel(convention.latestCheckVerdict)}` : '최근 검사: 확인 전';
			const meta = main.appendChild($('p')); meta.textContent = `저장일 ${new Date(convention.createdAt).toLocaleDateString()} · ${convention.authoredBy === 'person' ? '직접 작성' : convention.authoredBy} · ${verdict}`;
			const preview = main.appendChild(createElement('pre', 'project-dashboard__convention-preview')); preview.textContent = convention.markdown;
			if (convention.authoredBy !== 'person') {
				const check = row.appendChild(createElement('button', 'project-dashboard__secondary')); check.type = 'button'; check.textContent = '이 버전 검사'; check.disabled = this.conventionAgentBusy;
				check.addEventListener('click', () => this.selectConventionForCheck(convention));
			}
			if (!convention.active) {
				const requiresPass = convention.authoredBy !== 'person' && convention.latestCheckVerdict !== 'pass';
				const apply = row.appendChild(createElement('button', 'project-dashboard__secondary')); apply.type = 'button'; apply.textContent = requiresPass ? '검사 통과 필요' : '적용하기'; apply.disabled = this.knowledgeBusy || requiresPass;
				apply.addEventListener('click', () => { if (this.projectId) void this.mutateKnowledge(() => ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'applyConvention', { projectId: this.projectId, versionId: convention.id }), `작업 규칙 v${convention.version}을 적용했습니다.`); });
			}
		}
	}

	private async openReferenceViewer(reference: WorkspaceReferenceDTO): Promise<void> {
		const projectId = this.projectId;
		if (!projectId) return;
		const generation = ++this.referenceViewerGeneration;
		this.preservedReferenceViewerElement = undefined;
		this.referenceViewerId = reference.id;
		this.referenceViewer = undefined;
		this.referenceViewerLoading = true;
		this.referenceViewerError = undefined;
		this.referenceViewerPage = 0;
		this.referenceViewerPageStarts = [0];
		this.promotionExcerptDraft = '';
		this.taskPromotionError = undefined;
		this.render();
		this.root?.querySelector<HTMLElement>('.project-dashboard__reference-viewer')?.scrollIntoView({ block: 'nearest' });
		this.root?.querySelector<HTMLElement>('[data-focus-key="reference-viewer-close"]')?.focus({ preventScroll: true });
		try {
			const result = await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'getReference', { projectId, snapshotId: reference.id }) as WorkspaceReferenceContentDTO;
			if (generation !== this.referenceViewerGeneration || this.projectId !== projectId || this.referenceViewerId !== reference.id) return;
			if (result.id !== reference.id || result.projectId !== projectId) throw new Error('불러온 자료 버전이 요청한 프로젝트와 일치하지 않습니다.');
			this.referenceViewer = result;
			this.referenceViewerPageStarts = this.referencePageStarts(result.content);
		} catch (error) {
			if (generation !== this.referenceViewerGeneration || this.projectId !== projectId || this.referenceViewerId !== reference.id) return;
			this.referenceViewerError = this.errorMessage(error, '저장된 자료를 불러오지 못했습니다.');
		} finally {
			if (generation === this.referenceViewerGeneration && this.projectId === projectId && this.referenceViewerId === reference.id) {
				this.referenceViewerLoading = false;
				this.render();
			}
		}
	}

	private closeReferenceViewer(returnFocus = true): void {
		if (!this.referenceViewerId) return;
		const snapshotId = this.referenceViewerId;
		++this.referenceViewerGeneration;
		this.referenceViewerId = undefined;
		this.referenceViewer = undefined;
		this.referenceViewerLoading = false;
		this.referenceViewerError = undefined;
		this.referenceViewerPage = 0;
		this.referenceViewerPageStarts = [0];
		if (returnFocus && this.inputActive) {
			this.render();
			this.root?.querySelector<HTMLElement>(`[data-focus-key="reference-view:${CSS.escape(snapshotId)}"]`)?.focus({ preventScroll: true });
		}
	}

	private renderReferenceViewer(panel: HTMLElement): void {
		const preserved = this.preservedReferenceViewerElement;
		if (preserved?.dataset.referenceLoaded === 'true' && preserved.dataset.referenceId === this.referenceViewerId && Number(preserved.dataset.referencePage) === this.referenceViewerPage) {
			panel.appendChild(preserved);
			this.preservedReferenceViewerElement = undefined;
			return;
		}
		this.preservedReferenceViewerElement = undefined;
		const dialog = panel.appendChild(createElement('section', 'project-dashboard__reference-viewer'));
		dialog.dataset.referenceId = this.referenceViewerId ?? '';
		dialog.dataset.referencePage = String(this.referenceViewerPage);
		dialog.id = `reference-viewer-${this.referenceViewerId}`;
		dialog.setAttribute('role', 'region');
		dialog.setAttribute('aria-labelledby', 'reference-viewer-title');
		dialog.addEventListener('keydown', event => {
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeReferenceViewer(); }
		});
		const headingRow = dialog.appendChild(createElement('div', 'project-dashboard__reference-viewer-heading'));
		const title = headingRow.appendChild($('h3')); title.id = 'reference-viewer-title'; title.textContent = this.referenceViewer ? `${this.referenceViewer.title} · v${this.referenceViewer.version}` : '저장된 자료';
		const close = headingRow.appendChild(createElement('button', 'project-dashboard__secondary')); close.type = 'button'; close.textContent = '닫기'; close.dataset.focusKey = 'reference-viewer-close';
		close.setAttribute('aria-label', '저장된 자료 보기 닫기'); close.addEventListener('click', () => this.closeReferenceViewer());
		if (this.referenceViewerLoading) { const status = dialog.appendChild($('p')); status.setAttribute('role', 'status'); status.textContent = '저장된 자료를 불러오는 중…'; return; }
		if (this.referenceViewerError) { const error = dialog.appendChild($('p')); error.className = 'project-dashboard__reference-viewer-error'; error.setAttribute('role', 'alert'); error.textContent = this.referenceViewerError; return; }
		const reference = this.referenceViewer;
		if (!reference) return;
		const metadata = dialog.appendChild(createElement('dl', 'project-dashboard__reference-viewer-meta'));
		const addMetadata = (label: string, value: string) => { const term = metadata.appendChild($('dt')); term.textContent = label; const detail = metadata.appendChild($('dd')); detail.textContent = value; return detail; };
		addMetadata('출처', reference.sourceUri ?? this.referenceSourceLabel(reference.connectorId));
		addMetadata('가져온 시각', new Date(reference.retrievedAt).toLocaleString());
		addMetadata('SHA-256', reference.contentSha256).className = 'project-dashboard__reference-viewer-hash';
		if (reference.omissions.length) addMetadata('텍스트에서 제외된 항목', reference.omissions.join(' · '));
		const pageStart = this.referenceViewerPageStarts[this.referenceViewerPage] ?? 0;
		const pageEnd = this.referenceViewerPageStarts[this.referenceViewerPage + 1] ?? reference.content.length;
		const content = dialog.appendChild(createElement('pre', 'project-dashboard__reference-viewer-content')); content.tabIndex = 0; content.dataset.focusKey = 'reference-viewer-content'; content.textContent = reference.content.slice(pageStart, pageEnd);
		const pagination = dialog.appendChild(createElement('div', 'project-dashboard__reference-viewer-pagination'));
		const previous = pagination.appendChild(createElement('button', 'project-dashboard__secondary')); previous.type = 'button'; previous.textContent = '이전'; previous.disabled = this.referenceViewerPage === 0; previous.dataset.focusKey = 'reference-viewer-page-prev';
		previous.addEventListener('click', () => this.changeReferenceViewerPage(this.referenceViewerPage - 1));
		const pageCount = Math.max(1, this.referenceViewerPageStarts.length - 1);
		const pageStatus = pagination.appendChild($('p')); pageStatus.setAttribute('aria-live', 'polite'); pageStatus.textContent = `${this.referenceViewerPage + 1} / ${pageCount}쪽`;
		const next = pagination.appendChild(createElement('button', 'project-dashboard__secondary')); next.type = 'button'; next.textContent = '다음'; next.disabled = this.referenceViewerPage >= pageCount - 1; next.dataset.focusKey = 'reference-viewer-page-next';
		next.addEventListener('click', () => this.changeReferenceViewerPage(this.referenceViewerPage + 1));
		this.renderReferencePromotion(dialog, content, reference);
		dialog.dataset.referenceLoaded = 'true';
	}

	private renderReferencePromotion(dialog: HTMLElement, content: HTMLElement, reference: WorkspaceReferenceContentDTO): void {
		const taskId = this.selectedTaskId;
		const task = this.dashboard?.tasks.find(candidate => candidate.id === taskId);
		if (!taskId || !task) return;
		const section = dialog.appendChild(createElement('section', 'project-dashboard__reference-promotion'));
		const title = section.appendChild($('h4')); title.textContent = `${task.title} · 작업 지시`;
		const linked = this.knowledge?.taskReferences[taskId]?.some(candidate => candidate.id === reference.id);
		if (!linked) {
			const note = section.appendChild($('p')); note.textContent = '이 자료를 작업에 연결하면 필요한 문장만 지시로 승인할 수 있습니다.';
			const attach = section.appendChild(createElement('button', 'project-dashboard__secondary')); attach.type = 'button'; attach.textContent = '이 작업에 자료 연결'; attach.disabled = this.knowledgeBusy;
			attach.addEventListener('click', () => { if (this.projectId) void this.mutateKnowledge(() => ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'attachTaskReference', { projectId: this.projectId, taskId, snapshotId: reference.id }), '참고자료를 작업에 연결했습니다.'); });
			return;
		}
		const intro = section.appendChild($('p')); intro.textContent = '원문에서 필요한 문장을 선택해 승인하세요. 승인한 문장만 에이전트의 작업 지시로 전달되며, 나머지 자료는 참고용입니다.';
		const form = section.appendChild(createElement('form', 'project-dashboard__reference-promotion-form'));
		const selectionButton = form.appendChild(createElement('button', 'project-dashboard__secondary')); selectionButton.type = 'button'; selectionButton.textContent = '선택한 문장 넣기'; selectionButton.disabled = this.taskPromotionBusy;
		const label = form.appendChild(createElement('label')); label.htmlFor = 'reference-promotion-excerpt'; label.textContent = '승인할 원문';
		const excerpt = form.appendChild(createElement('textarea')); excerpt.id = 'reference-promotion-excerpt'; excerpt.rows = 4; excerpt.maxLength = 4000; excerpt.required = true; excerpt.value = this.promotionExcerptDraft; excerpt.disabled = this.taskPromotionBusy; excerpt.dataset.focusKey = 'reference-promotion-excerpt';
		excerpt.addEventListener('input', () => { this.promotionExcerptDraft = excerpt.value; });
		const guide = form.appendChild($('p')); guide.textContent = '저장된 자료에 그대로 들어 있는 문장만 승인할 수 있습니다. 최대 4,000자입니다.';
		const error = form.appendChild($('.project-dashboard__reference-viewer-error'));
		if (this.taskPromotionError) { error.setAttribute('role', 'alert'); error.textContent = this.taskPromotionError; }
		selectionButton.addEventListener('click', () => {
			const selection = window.getSelection();
			const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : undefined;
			const selected = selection?.toString() ?? '';
			if (!range || !selected || !content.contains(range.startContainer) || !content.contains(range.endContainer)) {
				error.setAttribute('role', 'alert'); error.textContent = '위 자료에서 사용할 문장을 먼저 선택해 주세요.'; return;
			}
			if (selected.length > excerpt.maxLength) {
				error.setAttribute('role', 'alert'); error.textContent = '선택한 문장이 너무 깁니다. 4,000자 이하로 다시 선택해 주세요.'; return;
			}
			this.promotionExcerptDraft = selected;
			excerpt.value = selected;
			error.textContent = '';
			excerpt.focus({ preventScroll: true });
		});
		const submit = form.appendChild(createElement('button', 'project-dashboard__primary')); submit.type = 'submit'; submit.disabled = this.taskPromotionBusy; submit.textContent = this.taskPromotionBusy ? '승인 중…' : '이 문장을 작업 지시로 승인'; submit.dataset.focusKey = 'reference-promotion-submit';
		form.addEventListener('submit', event => { event.preventDefault(); if (!form.reportValidity()) return; this.promotionExcerptDraft = excerpt.value; void this.promoteReferenceExcerpt(reference); });
	}

	private referenceSourceLabel(connectorId: string): string {
		switch (connectorId) {
			case 'public-website': return '웹페이지';
			case 'manual-text': return '직접 입력';
			case 'slack': return 'Slack';
			case 'notion': return 'Notion';
			default: return connectorId;
		}
	}

	private referencePageStarts(content: string): number[] {
		const starts = [0];
		let start = 0;
		while (start < content.length) {
			let end = Math.min(content.length, start + 65_536);
			const lastCodeUnit = content.charCodeAt(end - 1);
			if (end < content.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
			starts.push(end);
			start = end;
		}
		return starts;
	}

	private changeReferenceViewerPage(page: number): void {
		if (page < 0 || page >= this.referenceViewerPageStarts.length - 1 || page === this.referenceViewerPage) return;
		this.referenceViewerPage = page;
		this.preservedReferenceViewerElement = undefined;
		this.render();
		this.root?.querySelector<HTMLElement>('[data-focus-key="reference-viewer-content"]')?.focus({ preventScroll: true });
	}

	private selectConventionForCheck(convention: WorkspaceKnowledgeDTO['conventions'][number]): void {
		this.conventionCheckVersionId = convention.id;
		this.conventionAgentOperation = 'check';
		this.conventionAgentPreview = undefined;
		this.conventionAgentResult = undefined;
		this.conventionAgentError = undefined;
		this.conventionAgentNotice = undefined;
		this.render();
	}

	private async startEgoCapture(url: string): Promise<void> {
		if (!this.projectId || !this.selectedTaskId || this.egoCaptureId || this.egoBusy) return;
		this.egoBusy=true; this.egoError=undefined; this.egoStatus=undefined; this.egoCleanupPending=false; this.render();
		const projectId = this.projectId; const taskId = this.selectedTaskId;
		try { const status=await ipcRenderer.invoke(WORKSPACE_EGO_CAPTURE_CHANNEL,'startCapture',{projectId,taskId,url}) as WorkspaceEgoCaptureStatus; this.egoStatus=status; this.egoUrlDraft=url; if (status.state === 'handoff') { this.egoCaptureId=status.captureId; this.egoTaskId=taskId; this.egoProjectId=projectId; this.egoCleanupPending=false; } else if (status.state === 'failed') { this.egoError=this.errorMessage(new Error(status.message), 'Ego에서 텍스트를 가져오지 못했습니다.'); await this.recoverEgoCapture(projectId); } }
		catch(error) { this.egoError=this.errorMessage(error,'가져올 내용을 선택하도록 Ego를 열지 못했습니다.'); await this.recoverEgoCapture(projectId); }
		finally { this.egoBusy=false; this.render(); this.runRequestedEgoClose(); }
	}
	private async finishEgoCapture(cancel: boolean): Promise<void> {
		if (!this.egoProjectId || !this.egoTaskId || !this.egoCaptureId || this.egoBusy) return;
		this.egoBusy=true; this.egoError=undefined; this.render();
		const projectId = this.egoProjectId; const taskId = this.egoTaskId; const captureId = this.egoCaptureId;
		try { const status=await ipcRenderer.invoke(WORKSPACE_EGO_CAPTURE_CHANNEL,cancel?'cancelCapture':'captureSelection',{projectId,taskId,captureId}) as WorkspaceEgoCaptureStatus; this.egoStatus=status; if (status.state==='captured') { this.egoCapturedTaskTitle=this.dashboard?.tasks.find(task=>task.id===taskId)?.title; this.clearEgoCaptureOwnership(); if (this.projectId === projectId) await this.loadKnowledge(); } else if (status.state==='cancelled') this.clearEgoCaptureOwnership(); else if (status.state==='failed') { this.egoError=this.errorMessage(new Error(status.message), 'Ego에서 텍스트를 가져오지 못했습니다.'); await this.recoverEgoCapture(projectId); } }
		catch(error) { this.egoError=this.errorMessage(error,'Ego에서 텍스트를 가져오지 못했습니다.'); await this.recoverEgoCapture(projectId); }
		finally { this.egoBusy=false; this.render(); this.runRequestedEgoClose(); }
	}
	private clearEgoCaptureOwnership(): void { this.egoCaptureId=undefined; this.egoTaskId=undefined; this.egoProjectId=undefined; this.egoCleanupPending=false; }
	private async recoverEgoCapture(projectId: string): Promise<void> {
		try {
			const status=await ipcRenderer.invoke(WORKSPACE_EGO_CAPTURE_CHANNEL,'getActiveCapture',{projectId}) as WorkspaceEgoCaptureRecoveryStatus;
			if (status.state==='handoff') { this.egoCaptureId=status.captureId; this.egoTaskId=status.taskId; this.egoProjectId=projectId; this.egoCleanupPending=status.cleanupPending; this.egoStatus={state:'handoff',captureId:status.captureId}; }
			else if (this.egoProjectId === projectId) this.clearEgoCaptureOwnership();
		} catch(error) { this.egoError=this.errorMessage(error,'진행 중인 Ego 가져오기 세션을 복구하지 못했습니다.'); }
	}
	private runRequestedEgoClose(): void { const requested=this.egoCloseRequested; this.egoCloseRequested=false; if (requested && this.egoCaptureId) void this.closeEgoCapture(); }
	private async closeEgoCapture(): Promise<void> {
		if (this.egoBusy) { this.egoCloseRequested=true; return; }
		if (!this.egoCaptureId || !this.egoTaskId || !this.egoProjectId) return;
		this.egoBusy=true; this.egoError=undefined;
		try {
			const status=await ipcRenderer.invoke(WORKSPACE_EGO_CAPTURE_CHANNEL,'cancelCapture',{projectId:this.egoProjectId,taskId:this.egoTaskId,captureId:this.egoCaptureId}) as WorkspaceEgoCaptureStatus;
			this.egoStatus=status;
			if (status.state==='cancelled') this.clearEgoCaptureOwnership();
			else this.egoError=status.state==='failed' ? this.errorMessage(new Error(status.message), 'Ego 세션을 닫지 못했습니다.') : 'Ego가 가져오기 세션 종료를 확인하지 못했습니다.';
		} catch(error) { this.egoError=this.errorMessage(error,'Ego 가져오기 세션을 닫지 못했습니다.'); if (this.egoProjectId) await this.recoverEgoCapture(this.egoProjectId); }
		finally { this.egoBusy=false; this.render(); this.runRequestedEgoClose(); }
	}
	private async previewConventionAgent(): Promise<void> {
		if (!this.projectId || !this.selectedTaskId) return;
		this.conventionAgentBusy=true; this.conventionAgentError=undefined; this.conventionAgentNotice=undefined; this.conventionAgentResult=undefined; this.render();
		try { const scope={projectId:this.projectId,taskId:this.selectedTaskId,providerId:this.conventionAgentProvider}; const command=this.conventionAgentOperation==='draft'?'previewDraft':'previewCheck'; const request=this.conventionAgentOperation==='draft'?{...scope,sourceSnapshotIds:[...this.conventionAgentSourceIds]}:{...scope,versionId:this.conventionCheckVersionId ?? this.knowledge?.activeConventionId ?? ''}; this.conventionAgentPreview=await ipcRenderer.invoke(WORKSPACE_CONVENTION_AGENT_CHANNEL,command,request) as ConventionAgentPreviewDTO; }
		catch(error) { this.conventionAgentError=this.errorMessage(error,'작업 규칙 에이전트 요청 미리보기를 준비하지 못했습니다.'); }
		finally { this.conventionAgentBusy=false; this.render(); }
	}
	private async runConventionAgent(): Promise<void> {
		const preview=this.conventionAgentPreview; if (!preview || !preview.allowed || !this.projectId || !this.selectedTaskId) return;
		this.conventionAgentBusy=true; this.conventionAgentError=undefined; this.render();
		try { const scope={projectId:this.projectId,taskId:preview.task.id,providerId:this.conventionAgentProvider,digest:preview.digest}; const request=this.conventionAgentOperation==='draft'?{...scope,sourceSnapshotIds:preview.references.map(reference=>reference.id)}:{...scope,versionId:preview.convention?.id ?? ''}; this.conventionAgentResult=await ipcRenderer.invoke(WORKSPACE_CONVENTION_AGENT_CHANNEL,this.conventionAgentOperation,request) as ConventionAgentResultDTO; if(this.conventionAgentResult.attempt.state==='running') void this.pollConventionResult(this.projectId,this.conventionAgentResult.attempt.id); this.conventionAgentNotice=this.conventionAgentResult.attempt.state==='running'?'에이전트 실행을 시작했습니다. 완료되면 이 대시보드에서 결과를 불러옵니다.':this.conventionAgentOperation==='draft'?'작업 규칙 초안을 저장했습니다. 아직 적용되지 않았습니다.':'검사가 끝났습니다. 작업 규칙을 바꾸기 전에 결과를 확인하세요.'; await this.loadKnowledge(); }
		catch(error) { this.conventionAgentError=this.errorMessage(error,'작업 규칙 에이전트 요청이 실패했습니다.'); }
		finally { this.conventionAgentBusy=false; this.render(); }
	}
	private async pollConventionResult(projectId: string, attemptId: string): Promise<void> {
		while (this.inputActive && this.projectId === projectId && this.conventionAgentResult?.attempt.id === attemptId && this.conventionAgentResult.attempt.state === 'running') {
			await new Promise(resolve => setTimeout(resolve, 1500));
			if (!this.inputActive || this.projectId !== projectId) return;
			try {
				const result=await ipcRenderer.invoke(WORKSPACE_CONVENTION_AGENT_CHANNEL,'getResult',{projectId,attemptId}) as ConventionAgentResultDTO;
				if (this.conventionAgentResult?.attempt.id !== attemptId) return;
				this.conventionAgentResult=result;
				if (result.attempt.state !== 'running') { this.conventionAgentNotice=result.attempt.state==='succeeded'?'에이전트 실행이 끝났습니다. 아래 결과를 확인하세요. 초안은 자동 적용되지 않습니다.':`에이전트 상태: ${this.stateLabel(result.attempt.state)}${result.attempt.errorSummary ? ` · ${this.errorMessage(new Error(result.attempt.errorSummary), '자세한 내용은 오류 로그를 확인해 주세요.')}` : ''}`; await this.loadKnowledge(); }
				this.render();
			} catch(error) { this.conventionAgentError=this.errorMessage(error,'작업 규칙 에이전트 결과를 새로고침하지 못했습니다.'); this.render(); return; }
		}
	}
	private async loadTaskReviews(): Promise<void> {
		if (!this.projectId || !this.selectedTaskId) return;
		const taskId=this.selectedTaskId;
		if (this.reviewLinksTaskId !== taskId) {
			this.reviewLinks = []; this.reviewPendingCreates = []; this.reviewAvailability = 'unavailable'; this.reviewAvailabilityError = undefined;
		}
		this.reviewLinksTaskId=taskId;
		try { const result=await ipcRenderer.invoke(WORKSPACE_REVIEW_BRIDGE_CHANNEL,'listTaskReviews',{projectId:this.projectId,taskId}) as TaskReviewAvailability; if(this.selectedTaskId!==taskId)return; this.reviewLinks=result.reviews; this.reviewPendingCreates=result.pendingCreates; this.reviewAvailability=result.state; this.reviewAvailabilityError=result.error ? this.errorMessage(new Error(result.error), '리뷰 연결 정보를 불러오지 못했습니다.') : undefined; this.reviewLinksTaskId=this.selectedTaskId; }
		catch(error) { this.reviewBridgeError=this.errorMessage(error,'작업 리뷰를 불러오지 못했습니다.'); }
		this.render();
	}
	private async mutateTaskReview(command: 'createTaskReview'|'choosePrimaryReview', reviewId?: string, retryCommandId?: string): Promise<void> {
		if (!this.projectId || !this.selectedTaskId) return;
		const projectId = this.projectId;
		const taskId = this.selectedTaskId;
		const expectedRevision = this.dashboard?.tasks.find(task => task.id === taskId)?.revision;
		if (command === 'choosePrimaryReview' && !reviewId) return;
		if (command === 'choosePrimaryReview' && expectedRevision === undefined) {
			this.reviewBridgeError = '대표 리뷰를 선택하기 전에 작업을 다시 불러오세요.';
			this.render();
			return;
		}
		this.reviewBridgeBusy=true; this.reviewBridgeError=undefined; this.reviewBridgeNotice=undefined; this.render();
		try {
			if (command==='createTaskReview') await ipcRenderer.invoke(WORKSPACE_REVIEW_BRIDGE_CHANNEL,command,{projectId,taskId,commandId:retryCommandId ?? globalThis.crypto.randomUUID()});
			else if (reviewId) await ipcRenderer.invoke(WORKSPACE_REVIEW_BRIDGE_CHANNEL,command,{projectId,taskId,reviewId,expectedRevision});
			const taskRefreshed = command !== 'choosePrimaryReview' || await this.refreshDashboard(false);
			const listing=await ipcRenderer.invoke(WORKSPACE_REVIEW_BRIDGE_CHANNEL,'listTaskReviews',{projectId,taskId}) as TaskReviewAvailability;
			if (this.projectId===projectId && this.selectedTaskId===taskId) {
				this.reviewLinks=listing.reviews; this.reviewPendingCreates=listing.pendingCreates; this.reviewAvailability=listing.state; this.reviewAvailabilityError=listing.error ? this.errorMessage(new Error(listing.error), '리뷰 연결 정보를 불러오지 못했습니다.') : undefined; this.reviewLinksTaskId=taskId;
				if (taskRefreshed) this.reviewBridgeNotice=command==='createTaskReview'?'리뷰를 연결했습니다.':'대표 리뷰를 변경했습니다.';
				else this.reviewBridgeError='대표 리뷰를 변경했지만 작업을 다시 불러오지 못했습니다. 다시 변경하기 전에 프로젝트를 다시 여세요.';
			}
		}
		catch(error) {
			if (this.projectId===projectId && this.selectedTaskId===taskId) {
				const rawMessage = this.rawErrorMessage(error);
				if (rawMessage.includes('changed since revision')) {
					this.reviewBridgeError=await this.refreshDashboard(false)
						? '다른 창에서 작업이 변경되었습니다. 최신 버전을 불러왔습니다. 대표 리뷰를 다시 선택하세요.'
						: `다른 창에서 작업이 변경되었지만 최신 내용을 불러오지 못했습니다: ${this.providerError ?? '새로고침 실패'}`;
				} else this.reviewBridgeError=this.errorMessage(error,'작업 리뷰를 업데이트하지 못했습니다.');
				await this.loadTaskReviews();
			}
		}
		finally { this.reviewBridgeBusy=false; this.render(); }
	}

	private async openTaskReview(taskId: string, reviewId: string): Promise<void> {
		const projectId = this.projectId;
		if (!projectId || this.selectedTaskId !== taskId || this.reviewBridgeBusy) return;
		this.reviewBridgeBusy = true;
		this.reviewBridgeError = undefined;
		this.render();
		try {
			const verified = await ipcRenderer.invoke(WORKSPACE_REVIEW_BRIDGE_CHANNEL, 'openTaskReview', { projectId, taskId, reviewId }) as TaskReviewOpenResult;
			if (this.projectId !== projectId || this.selectedTaskId !== taskId) return;
			await this.reviewTabs.openTaskApiReview(taskId, verified.reviewId, verified.version, verified.title);
		} catch (error) {
			if (this.projectId === projectId && this.selectedTaskId === taskId) {
				this.reviewBridgeError = this.errorMessage(error, '검증된 작업 리뷰를 열지 못했습니다.');
				await this.loadTaskReviews();
			}
		} finally {
			this.reviewBridgeBusy = false;
			this.render();
		}
	}

	private async openPrimaryTaskReview(taskId: string): Promise<void> {
		const projectId = this.projectId;
		if (!projectId || this.reviewBridgeBusy) return;
		this.reviewBridgeBusy = true;
		this.taskMutationError = undefined;
		this.render();
		try {
			const listing = await ipcRenderer.invoke(WORKSPACE_REVIEW_BRIDGE_CHANNEL, 'listTaskReviews', { projectId, taskId }) as TaskReviewAvailability;
			if (this.projectId !== projectId) return;
			const primary = listing.reviews.find(link => link.isPrimary);
			if (!primary || primary.state !== 'available' || listing.state !== 'available') {
				throw new Error(listing.error || (primary ? '이 프로젝트에서 대표 리뷰를 사용할 수 없습니다.' : '이 작업에 대표 리뷰가 없습니다.'));
			}
			const verified = await ipcRenderer.invoke(WORKSPACE_REVIEW_BRIDGE_CHANNEL, 'openTaskReview', { projectId, taskId, reviewId: primary.reviewId }) as TaskReviewOpenResult;
			if (this.projectId !== projectId) return;
			await this.reviewTabs.openTaskApiReview(taskId, verified.reviewId, verified.version, verified.title);
		} catch (error) {
			if (this.projectId === projectId) this.taskMutationError = this.errorMessage(error, '작업의 대표 리뷰를 열지 못했습니다.');
		} finally {
			this.reviewBridgeBusy = false;
			this.render();
		}
	}
	private scheduleDashboardStateSave(debounce = false): void {
		if (!this.projectId) return;
		if (this.stateSaveTimer) clearTimeout(this.stateSaveTimer);
		if (this.activeSection === 'dashboard' && this.taskView === 'board') {
			this.boardScrollPosition = Math.min(10_000_000, Math.max(0, Math.floor(this.root?.scrollTop ?? 0)));
		}
		const position = this.boardScrollPosition.toString();
		const generation = ++this.stateSaveGeneration;
		this.pendingDashboardState = { generation, request: {
			projectId: this.projectId,
			selectedTaskId: this.selectedTaskId ?? null,
			dashboardPosition: position,
		} };
		if (debounce) this.stateSaveTimer = setTimeout(() => { this.stateSaveTimer = undefined; void this.flushDashboardState(); }, 300);
		else void this.flushDashboardState();
	}

	private async flushDashboardState(): Promise<void> {
		if (this.stateSaveTimer) { clearTimeout(this.stateSaveTimer); this.stateSaveTimer = undefined; }
		if (this.stateSaveRunning) { await this.stateSavePromise; return; }
		if (!this.pendingDashboardState) return;
		this.stateSaveRunning = true;
		this.stateSavePromise = (async () => {
			while (this.pendingDashboardState) {
				const pending = this.pendingDashboardState;
				this.pendingDashboardState = undefined;
				try {
					const view = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'updateDashboardState', pending.request) as WorkspaceDashboardDTO['view'];
					if (this.projectId === pending.request.projectId) {
						if (this.dashboard) this.dashboard = { ...this.dashboard, view };
						this.lastSavedDashboardPosition = view.dashboardPosition;
						if (pending.generation === this.stateSaveGeneration && this.dashboardStateError) { this.dashboardStateError = undefined; if (this.inputActive) this.render(); }
					}
				} catch (error) {
					if (pending.generation === this.stateSaveGeneration && this.projectId === pending.request.projectId) {
						this.dashboardStateError = `대시보드 보기를 저장하지 못했습니다: ${this.errorMessage(error, '요청 실패')}`;
						await this.restoreSavedDashboardState(pending.request.projectId, pending.generation);
					}
				}
			}
		})().finally(() => {
			this.stateSaveRunning = false;
			this.stateSavePromise = undefined;
		});
		await this.stateSavePromise;
		if (this.pendingDashboardState) await this.flushDashboardState();
	}

	private async restoreSavedDashboardState(projectId: string, generation: number): Promise<void> {
		try {
			const dashboard = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'getDashboard', projectId) as WorkspaceDashboardDTO;
			if (!this.inputActive || this.projectId !== projectId || generation !== this.stateSaveGeneration) return;
			this.dashboard = dashboard;
			this.selectedTaskId = dashboard.view.selectedTaskId && dashboard.tasks.some(task => task.id === dashboard.view.selectedTaskId) ? dashboard.view.selectedTaskId : undefined;
			this.preview = undefined;
			this.attempts = [];
			this.lastSavedDashboardPosition = dashboard.view.dashboardPosition;
			this.boardScrollPosition = dashboard.view.dashboardPosition === null ? 0 : Math.min(10_000_000, Number(dashboard.view.dashboardPosition));
			this.pendingDashboardPosition = this.activeSection === 'dashboard' && this.taskView === 'board' && !this.pendingCreateTaskFocus
				? this.boardScrollPosition : undefined;
			this.dashboardStateError = `${this.dashboardStateError ?? '대시보드 상태를 저장하지 못했습니다.'} 마지막으로 저장한 보기를 표시합니다. 작업을 선택하거나 스크롤해 다시 시도하세요.`;
			this.render();
			if (this.selectedTaskId) void this.loadAttempts();
		} catch (error) {
			if (this.inputActive && this.projectId === projectId && generation === this.stateSaveGeneration) {
				this.dashboardStateError = `${this.dashboardStateError ?? '대시보드 상태를 저장하지 못했습니다.'} 마지막으로 저장한 보기를 다시 불러오지 못했습니다.`;
				this.render();
			}
		}
	}

	private restoreDashboardPosition(position: number): void {
		if (!this.root) return;
		if (this.programmaticScrollTimer) clearTimeout(this.programmaticScrollTimer);
		this.programmaticScrollTarget = position;
		this.programmaticScrollTimer = setTimeout(() => {
			this.programmaticScrollTarget = undefined;
			this.programmaticScrollTimer = undefined;
		}, 100);
		this.root.scrollTop = position;
	}

	private async createTask(titleInput: HTMLInputElement, descriptionInput: HTMLTextAreaElement, submit: HTMLButtonElement): Promise<void> {
		this.createTaskTitleDraft = titleInput.value;
		this.createTaskDescriptionDraft = descriptionInput.value;
		const title = titleInput.value.trim();
		const submittedTitle = titleInput.value;
		const submittedDescription = descriptionInput.value;
		if (!title || !this.projectId || this.creating) {
			titleInput.setAttribute('aria-invalid', String(!title));
			titleInput.focus();
			return;
		}
		this.creating = true;
		submit.disabled = true;
		submit.textContent = '만드는 중…';
		try {
			const response = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'createTask', {
				projectId: this.projectId, title, ...(descriptionInput.value.trim() ? { description: descriptionInput.value.trim() } : {}),
			}) as WorkspaceDashboardTaskDTO;
			this.stopPolling();
			this.selectedTaskId = response.task.id;
			this.preview = undefined;
			this.providerError = undefined;
			this.providerErrorKind = undefined;
			this.attempts = [];
			if (this.createTaskTitleDraft === submittedTitle && this.createTaskDescriptionDraft === submittedDescription) {
				this.createTaskTitleDraft = '';
				this.createTaskDescriptionDraft = '';
			}
			this.createFormOpen = !!(this.createTaskTitleDraft || this.createTaskDescriptionDraft);
			this.error = undefined;
			this.dashboard = { project: response.project, folder: response.folder, view: response.view, nextAction: this.dashboard?.nextAction ?? null,
				tasks: [...(this.dashboard?.tasks ?? []), response.task] };
			await this.refreshDashboard(false);
			this.scheduleDashboardStateSave();
			void this.loadAttempts();
		} catch (error) {
			this.error = this.errorMessage(error, '작업을 만들지 못했습니다. 다시 시도해 주세요.');
		} finally {
			this.creating = false;
			this.render();
		}
	}

	private updateDashboardTask(task: WorkspaceDashboardTaskItemDTO): void {
		if (!this.dashboard) return;
		const stateOrder = new Map(columns.map((column, index) => [column.state, index]));
		this.dashboard = {
			...this.dashboard,
			tasks: this.dashboard.tasks.map(current => current.id === task.id ? task : current)
				.sort((left, right) => (stateOrder.get(left.state)! - stateOrder.get(right.state)!) || left.order - right.order || left.createdAt.localeCompare(right.createdAt)),
		};
	}

	private async saveTaskDetails(task: WorkspaceDashboardTaskItemDTO): Promise<void> {
		const title = this.editTitleDraft.trim();
		if (!title) { this.taskEditError = '저장하기 전에 작업 제목을 입력하세요.'; this.render(); return; }
		if (!this.projectId || this.taskEditBusy || this.taskMutationBusy) return;
		this.taskEditBusy = true; this.taskEditError = undefined; this.taskMutationError = undefined; this.taskMutationBusy = '작업 정보 저장 중…'; this.render();
		try {
			const updated = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'updateTask', {
				projectId: this.projectId, taskId: task.id, expectedRevision: task.revision,
				title, description: this.editDescriptionDraft.trim() || null,
			} satisfies UpdateWorkspaceDashboardTaskRequest) as WorkspaceDashboardTaskItemDTO;
			this.updateDashboardTask(updated);
			this.editingTaskId = undefined; this.editTitleDraft = ''; this.editDescriptionDraft = '';
		} catch (error) {
			const rawMessage = this.rawErrorMessage(error);
			const conflict = rawMessage.includes('changed since revision');
			this.taskEditError = conflict ? '작업이 열린 뒤 변경되었습니다. 최신 버전을 불러왔고 작성 중인 내용은 보존했습니다. 내용을 확인한 뒤 다시 저장하세요.' : this.errorMessage(error, '작업 정보를 저장하지 못했습니다.');
			if (conflict && !await this.refreshDashboard(false)) this.taskEditError = `작업이 열린 뒤 변경되었습니다. 작성 중인 내용은 보존했지만 최신 버전을 불러오지 못했습니다: ${this.providerError ?? '새로고침 실패'}`;
		} finally {
			this.taskEditBusy = false; this.taskMutationBusy = undefined;
			this.render();
			if (!this.editingTaskId) this.root?.querySelector<HTMLElement>('[data-focus-key="task-edit"]')?.focus({ preventScroll: true });
		}
	}

	private async updateTaskState(task: WorkspaceDashboardTaskItemDTO, state: DashboardTaskState): Promise<void> {
		if (!this.projectId || this.taskMutationBusy || task.state === state) return;
		this.taskMutationError = undefined;
		this.taskMutationBusy = `작업을 ${columns.find(column => column.state === state)?.label}(으)로 이동 중…`;
		this.render();
		try {
			const updated = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'updateTask', {
				projectId: this.projectId, taskId: task.id, expectedRevision: task.revision, state,
			} satisfies UpdateWorkspaceDashboardTaskRequest) as WorkspaceDashboardTaskItemDTO;
			this.updateDashboardTask(updated);
			await this.refreshDashboard(false);
		} catch (error) {
			const rawMessage = this.rawErrorMessage(error);
			if (rawMessage.includes('changed since revision')) {
				this.taskMutationError = await this.refreshDashboard(false)
					? '상태를 바꾸기 전에 작업이 변경되었습니다. 최신 내용을 불러왔습니다. 상태를 다시 선택하세요.'
					: `상태 변경 전에 작업이 수정되었고 최신 내용을 불러오지 못했습니다: ${this.providerError ?? '새로고침 실패'}`;
			} else this.taskMutationError = this.errorMessage(error, '작업 상태를 바꾸지 못했습니다.');
		} finally {
			this.taskMutationBusy = undefined;
			this.render();
		}
	}

	private async reorderTask(state: DashboardTaskState, taskId: string, direction: -1 | 1, targetIndex?: number): Promise<void> {
		if (!this.projectId || this.taskMutationBusy || !this.dashboard) return;
		const orderedTasks = this.dashboard.tasks.filter(task => task.state === state).sort((left, right) => left.order - right.order || left.createdAt.localeCompare(right.createdAt));
		const index = orderedTasks.findIndex(task => task.id === taskId);
		const destination = targetIndex ?? index + direction;
		if (index < 0 || destination < 0 || destination >= orderedTasks.length || index === destination) return;
		const [movedTask] = orderedTasks.splice(index, 1);
		orderedTasks.splice(destination, 0, movedTask);
		this.taskMutationError = undefined; this.taskMutationBusy = `${columns.find(column => column.state === state)?.label} 작업 순서 변경 중…`; this.render();
		try {
			const reordered = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'reorderTasks', {
				projectId: this.projectId, state,
				orderedTaskRevisions: orderedTasks.map(task => ({ taskId: task.id, revision: task.revision })),
			} satisfies ReorderWorkspaceDashboardTasksRequest) as readonly WorkspaceDashboardTaskItemDTO[];
			if (this.dashboard) {
				const updatedById = new Map(reordered.map(task => [task.id, task]));
				const stateOrder = new Map(columns.map((column, order) => [column.state, order]));
				this.dashboard = { ...this.dashboard, tasks: this.dashboard.tasks.map(task => updatedById.get(task.id) ?? task)
					.sort((left, right) => (stateOrder.get(left.state)! - stateOrder.get(right.state)!) || left.order - right.order || left.createdAt.localeCompare(right.createdAt)) };
			}
		} catch (error) {
			const rawMessage = this.rawErrorMessage(error);
			if (rawMessage.includes('task set') || rawMessage.includes('changed before reorder')) {
				this.taskMutationError = await this.refreshDashboard(false)
					? '작업 순서를 바꾸기 전에 열이 변경되었습니다. 최신 순서를 불러왔습니다.'
					: `순서 변경 전에 작업 열이 수정되었고 최신 순서를 불러오지 못했습니다: ${this.providerError ?? '새로고침 실패'}`;
			} else this.taskMutationError = this.errorMessage(error, '작업 순서를 바꾸지 못했습니다.');
		} finally {
			this.taskMutationBusy = undefined;
			this.render();
		}
	}

	private setTaskView(view: DashboardTaskView): void {
		this.taskView = view;
		if (view !== 'board') this.pendingCreateTaskFocus = false;
		this.lifecycleError = undefined;
		this.trashConfirmationTaskId = undefined;
		if (view === 'board') { this.lifecycleLoading = false; this.render(); void this.load(); }
		else { void this.loadLifecycleTasks(view); }
	}

	private async loadLifecycleTasks(view: 'archived' | 'trash'): Promise<void> {
		if (!this.projectId) return;
		const projectId = this.projectId;
		this.lifecycleLoading = true;
		this.lifecycleError = undefined;
		this.render();
		try {
			const tasks = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, view === 'archived' ? 'listArchivedTasks' : 'listTrashedTasks', projectId) as readonly WorkspaceDashboardTaskItemDTO[];
			if (this.projectId === projectId && this.taskView === view) {
				if (view === 'archived') this.archivedTasks = tasks;
				else this.trashedTasks = tasks;
			}
		} catch (error) {
			if (this.projectId === projectId && this.taskView === view) this.lifecycleError = this.errorMessage(error, `${view === 'archived' ? '보관된 작업' : '휴지통'}을 불러오지 못했습니다.`);
		} finally {
			if (this.projectId === projectId && this.taskView === view) { this.lifecycleLoading = false; this.render(); }
		}
	}

	private async performTaskLifecycleAction(command: 'archiveTask' | 'restoreArchivedTask' | 'restoreTrashedTask' | 'trashTask', task: WorkspaceDashboardTaskItemDTO): Promise<void> {
		if (!this.projectId || this.taskMutationBusy) return;
		if (command === 'archiveTask' && this.attempts.some(attempt => this.isActive(attempt.state))) {
			this.taskMutationError = '보관을 시작하지 않았습니다. 이 작업의 실행을 취소하고 정리가 끝날 때까지 기다리세요.';
			this.render();
			return;
		}
		if (command === 'trashTask' && task.deletionPendingAt && !task.deletionRequestId && !this.trashRequestIds.has(task.id)) {
			this.taskMutationError = '휴지통 이동 요청이 대기 중이지만 저장된 요청 ID가 없습니다. 작업은 보드에 남아 있습니다. 다시 시도하기 전에 프로젝트를 새로고침하거나 지원팀에 문의하세요.';
			this.render();
			return;
		}
		if (command === 'trashTask') {
			const requestId = task.deletionRequestId ?? this.trashRequestIds.get(task.id) ?? crypto.randomUUID();
			this.trashRequestIds.set(task.id, requestId);
		}
		const request: WorkspaceDashboardTaskLifecycleRequest = { projectId: this.projectId, taskId: task.id, expectedRevision: task.revision };
		this.taskMutationError = undefined;
		this.taskMutationBusy = command === 'archiveTask' ? '작업 보관 중…'
			: command === 'trashTask' ? '실행 취소 및 정리 확인 중…'
				: '작업 복원 중…';
		this.render();
		try {
			const updated = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, command,
				command === 'trashTask' ? { ...request, requestId: this.trashRequestIds.get(task.id)! } satisfies TrashWorkspaceDashboardTaskRequest : request) as WorkspaceDashboardTaskItemDTO;
			this.lifecycleError = undefined;
			if (command === 'archiveTask' || command === 'trashTask') {
				if (this.dashboard) this.dashboard = { ...this.dashboard, tasks: this.dashboard.tasks.filter(candidate => candidate.id !== task.id) };
				this.archivedTasks = command === 'archiveTask' ? [...this.archivedTasks.filter(candidate => candidate.id !== task.id), updated] : this.archivedTasks;
				this.trashedTasks = command === 'trashTask' ? [...this.trashedTasks.filter(candidate => candidate.id !== task.id), updated] : this.trashedTasks;
				if (this.selectedTaskId === task.id) { this.selectedTaskId = undefined; this.scheduleDashboardStateSave(); }
				if (command === 'trashTask') this.trashRequestIds.delete(task.id);
				this.trashConfirmationTaskId = undefined;
			} else {
				if (this.dashboard) {
					const stateOrder = new Map(columns.map((column, index) => [column.state, index]));
					this.dashboard = { ...this.dashboard, tasks: [...this.dashboard.tasks.filter(candidate => candidate.id !== task.id), updated]
						.sort((left, right) => (stateOrder.get(left.state)! - stateOrder.get(right.state)!) || left.order - right.order || left.createdAt.localeCompare(right.createdAt)) };
				}
				if (command === 'restoreArchivedTask') this.archivedTasks = this.archivedTasks.filter(candidate => candidate.id !== task.id);
				else this.trashedTasks = this.trashedTasks.filter(candidate => candidate.id !== task.id);
				if (this.taskView === 'board') this.selectedTaskId = updated.id;
			}
			await this.refreshDashboard(false);
			this.taskMutationError = undefined;
		} catch (error) {
			const rawMessage = this.rawErrorMessage(error);
			const conflict = rawMessage.includes('changed since revision');
			const message = this.errorMessage(error, '작업을 완료하지 못했습니다.');
			if (conflict) {
				const refreshed = await this.refreshDashboard(false);
				if (this.taskView === 'archived' || this.taskView === 'trash') await this.loadLifecycleTasks(this.taskView);
				this.taskMutationError = refreshed ? '작업을 처리하기 전에 내용이 변경되어 최신 목록을 불러왔습니다.' : `${message} 최신 작업 정보를 불러오지 못했습니다.`;
			} else if (command === 'trashTask') {
				const refreshed = await this.refreshDashboard(false);
				const latest = this.dashboard?.tasks.find(candidate => candidate.id === task.id);
				if (latest?.deletionRequestId) this.trashRequestIds.set(task.id, latest.deletionRequestId);
				this.taskMutationError = latest?.deletionError
					? `휴지통으로 옮기지 못했습니다: ${this.errorMessage(new Error(latest.deletionError), '실행 정리를 완료하지 못했습니다.')} 작업은 보드에 남아 있습니다.`
					: `${message}${refreshed ? ' 작업은 보드에 남아 있습니다.' : ' 작업은 화면에 남아 있지만 최신 상태를 불러오지 못했습니다.'}`;
			} else this.taskMutationError = message;
		}
		finally {
			this.taskMutationBusy = undefined;
			this.render();
		}
	}

	private renderTaskViewNavigation(container: HTMLElement): void {
		const navigation = container.appendChild($('.project-dashboard__task-views'));
		navigation.setAttribute('role', 'group'); navigation.setAttribute('aria-label', '작업 보기');
		for (const [view, label] of [['board', '보드'], ['archived', '보관됨'], ['trash', '휴지통']] as const) {
			const button = navigation.appendChild(createElement('button', 'project-dashboard__task-view'));
			button.type = 'button'; button.textContent = label; button.setAttribute('aria-pressed', String(this.taskView === view));
			button.disabled = !!this.taskMutationBusy || (this.lifecycleLoading && view !== 'board');
			button.dataset.focusKey = `task-view:${view}`;
			button.addEventListener('click', () => { if (this.taskView !== view) this.setTaskView(view); });
		}
	}

	private renderLifecycleTasks(shell: HTMLElement): void {
		const tasks = this.taskView === 'archived' ? this.archivedTasks : this.trashedTasks;
		const section = shell.appendChild($('.project-dashboard__lifecycle-view'));
		const heading = section.appendChild($('.project-dashboard__section-heading'));
		const title = heading.appendChild($('h2')); title.textContent = this.taskView === 'archived' ? '보관된 작업' : '휴지통';
		const count = heading.appendChild($('span')); count.textContent = `작업 ${tasks.length}개`;
		this.renderTaskViewNavigation(heading);
		if (this.lifecycleLoading) {
			const status = section.appendChild($('.project-dashboard__status')); status.setAttribute('role', 'status'); status.textContent = `${this.taskView === 'archived' ? '보관된 작업' : '휴지통'} 불러오는 중…`;
			return;
		}
		if (!tasks.length) {
			const empty = section.appendChild($('.project-dashboard__empty-view'));
			empty.textContent = this.taskView === 'archived' ? '보관된 작업이 없어요.' : '휴지통이 비어 있어요.';
			return;
		}
		const list = section.appendChild($('.project-dashboard__lifecycle-list'));
		for (const task of tasks) {
			const row = list.appendChild($('.project-dashboard__lifecycle-item'));
			const copy = row.appendChild($('.project-dashboard__lifecycle-copy'));
			const name = copy.appendChild($('h3')); name.textContent = task.title;
			const state = copy.appendChild($('p')); state.className = 'project-dashboard__lifecycle-meta';
			state.textContent = `${columns.find(column => column.state === task.state)?.label} · 수정일 ${new Date(task.updatedAt).toLocaleDateString()}`;
			if (task.description) { const description = copy.appendChild($('p')); description.textContent = task.description; }
			if (task.deletionError) { const error = copy.appendChild($('.project-dashboard__task-edit-error')); error.textContent = this.errorMessage(new Error(task.deletionError), '휴지통 이동을 완료하지 못했습니다.'); }
			const restore = row.appendChild(createElement('button', 'project-dashboard__secondary'));
			restore.classList.add('project-dashboard__restore');
			restore.type = 'button'; restore.textContent = '보드로 복원'; restore.disabled = !!this.taskMutationBusy;
			restore.setAttribute('aria-label', `${task.title} 작업을 ${columns.find(column => column.state === task.state)?.label}로 복원`);
			restore.dataset.focusKey = `restore:${task.id}`;
			restore.addEventListener('click', () => void this.performTaskLifecycleAction(this.taskView === 'archived' ? 'restoreArchivedTask' : 'restoreTrashedTask', task));
		}
	}

	private renderTaskManagementControls(container: HTMLElement, task: WorkspaceDashboardTaskItemDTO): void {
		if (this.trashConfirmationTaskId === task.id) {
			const confirmation = container.appendChild($('.project-dashboard__trash-confirmation'));
			confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-labelledby', 'task-trash-confirm-title');
			const title = confirmation.appendChild($('h4')); title.id = 'task-trash-confirm-title'; title.textContent = '이 작업을 휴지통으로 옮길까요?';
			const explanation = confirmation.appendChild($('p'));
			explanation.textContent = '휴지통으로 옮기기 전에 이 작업의 실행을 취소하고 정리가 끝날 때까지 기다립니다. 취소나 정리에 실패하면 작업은 보드에 남고 오류가 표시됩니다.';
			const actions = confirmation.appendChild($('.project-dashboard__edit-actions'));
			const confirm = actions.appendChild(createElement('button', 'project-dashboard__danger'));
			confirm.type = 'button'; confirm.textContent = this.taskMutationBusy ? '실행 취소 중…' : '휴지통으로 이동'; confirm.disabled = !!this.taskMutationBusy;
			confirm.dataset.focusKey = 'trash-confirm'; confirm.addEventListener('click', () => void this.performTaskLifecycleAction('trashTask', task));
			const cancel = actions.appendChild(createElement('button', 'project-dashboard__secondary'));
			cancel.type = 'button'; cancel.textContent = '작업 유지'; cancel.disabled = !!this.taskMutationBusy; cancel.dataset.focusKey = 'trash-cancel';
			cancel.addEventListener('click', () => { this.trashConfirmationTaskId = undefined; this.render(); this.root?.querySelector<HTMLElement>('[data-focus-key="task-trash"]')?.focus({ preventScroll: true }); });
			return;
		}
		if (task.deletionPendingAt) {
			const pending = container.appendChild($('.project-dashboard__task-edit-error')); pending.setAttribute('role', 'alert');
			pending.textContent = task.deletionError
				? `휴지통 이동 대기 중: ${this.errorMessage(new Error(task.deletionError), '실행 정리가 끝날 때까지 기다려 주세요.')} 작업은 보드에 남아 있습니다.`
				: '실행 정리를 확인하는 동안 휴지통 이동이 대기 중입니다. 작업은 보드에 남아 있습니다.';
			if (task.deletionRequestId || this.trashRequestIds.has(task.id)) {
				const retryTrash = container.appendChild(createElement('button', 'project-dashboard__danger'));
				retryTrash.type = 'button'; retryTrash.textContent = '휴지통 이동 다시 시도'; retryTrash.dataset.focusKey = 'task-trash'; retryTrash.disabled = !!this.taskMutationBusy;
				retryTrash.addEventListener('click', () => { this.trashConfirmationTaskId = task.id; this.render(); this.root?.querySelector<HTMLElement>('[data-focus-key="trash-confirm"]')?.focus({ preventScroll: true }); });
			} else {
				const unavailable = container.appendChild($('.project-dashboard__lifecycle-meta'));
				unavailable.textContent = '대기 중인 휴지통 요청의 ID가 저장되지 않아 안전하게 다시 시도할 수 없습니다. 작업은 보드에 남아 있습니다.';
			}
			return;
		}
		const actions = container.appendChild($('.project-dashboard__task-management-actions'));
		const archive = actions.appendChild(createElement('button', 'project-dashboard__secondary'));
		archive.type = 'button'; archive.textContent = '작업 보관'; archive.disabled = !!this.taskMutationBusy; archive.dataset.focusKey = 'task-archive';
		archive.addEventListener('click', () => void this.performTaskLifecycleAction('archiveTask', task));
		const trash = actions.appendChild(createElement('button', 'project-dashboard__danger'));
		trash.type = 'button'; trash.textContent = '휴지통으로 이동'; trash.disabled = !!this.taskMutationBusy; trash.dataset.focusKey = 'task-trash';
		trash.addEventListener('click', () => { this.trashConfirmationTaskId = task.id; this.render(); this.root?.querySelector<HTMLElement>('[data-focus-key="trash-confirm"]')?.focus({ preventScroll: true }); });
	}

	private focusSignature(element: HTMLElement): string | undefined {
		if (!element.matches('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')) return undefined;
		const context: string[] = [];
		for (let ancestor = element.parentElement; ancestor && ancestor !== this.root; ancestor = ancestor.parentElement) {
			const heading = ancestor.querySelector<HTMLElement>('h1, h2, h3, h4');
			if (heading?.textContent?.trim()) context.push(heading.textContent.trim());
			const label = ancestor.getAttribute('aria-label');
			if (label) context.push(label);
			if (context.length >= 2) break;
		}
		return JSON.stringify({
			tag: element.tagName,
			type: element instanceof HTMLInputElement || element instanceof HTMLButtonElement ? element.type : '',
			name: element.getAttribute('name') ?? '',
			role: element.getAttribute('role') ?? '',
			label: element.getAttribute('aria-label') ?? '',
			title: element.getAttribute('title') ?? '',
			text: element.textContent?.trim().replace(/\s+/g, ' ') ?? '',
			context
		});
	}

	private findFocusTarget(signature: string): HTMLElement | undefined {
		if (!this.root) return undefined;
		const matches = [...this.root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
			.filter(element => this.focusSignature(element) === signature);
		return matches.length === 1 ? matches[0] : undefined;
	}

	private render(): void {
		if (!this.root) return;
		if (this.referenceViewerId && this.referenceViewer && !this.referenceViewerLoading && !this.referenceViewerError) {
			const existingViewer = this.root.querySelector<HTMLElement>('.project-dashboard__reference-viewer');
			if (existingViewer?.dataset.referenceLoaded === 'true' && existingViewer.dataset.referenceId === this.referenceViewerId && Number(existingViewer.dataset.referencePage) === this.referenceViewerPage) this.preservedReferenceViewerElement = existingViewer;
		}
		const activeElement = this.root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
		const focusId = activeElement?.id;
		const focusKey = activeElement?.dataset.focusKey ?? (document.activeElement === document.body ? this.lastFocusKey : undefined);
		const focusSignature = activeElement && !focusId && !activeElement.dataset.focusKey ? this.focusSignature(activeElement) :
			(document.activeElement === document.body ? this.lastFocusSignature : undefined);
		const closedCreateSummary = activeElement?.tagName === 'SUMMARY' && !!activeElement.closest('.project-dashboard__form') &&
			!this.createFormOpen && !this.createTaskTitleDraft && !this.createTaskDescriptionDraft;
		if (activeElement?.dataset.focusKey) this.lastFocusKey = activeElement.dataset.focusKey;
		else if (activeElement) this.lastFocusKey = undefined;
		if (focusSignature) this.lastFocusSignature = focusSignature;
		const scrollTop = this.root.scrollTop;
		const restorePosition = () => {
			if (!this.root) return;
			const createTaskTitle = this.pendingCreateTaskFocus ? this.root.querySelector<HTMLInputElement>('#project-task-title') : undefined;
			if (createTaskTitle) {
				this.pendingCreateTaskFocus = false;
				this.pendingDashboardPosition = undefined;
				this.root.querySelector<HTMLDetailsElement>('.project-dashboard__form')?.scrollIntoView({ block: 'start' });
				createTaskTitle.focus({ preventScroll: true });
				return;
			}
			if (this.pendingDashboardPosition !== undefined) {
				const position = this.pendingDashboardPosition;
				this.pendingDashboardPosition = undefined;
				this.restoreDashboardPosition(position);
			} else this.root.scrollTop = scrollTop;
			const section = this.pendingSectionNavigation;
			if (section) {
				const target = section === 'dashboard' ?
					this.root.querySelector<HTMLElement>('#project-dashboard-title') :
					this.root.querySelector<HTMLElement>(`#knowledge-tab-${section}`);
				if (target) {
					this.pendingSectionNavigation = undefined;
					if (section !== 'dashboard') this.root.querySelector<HTMLElement>('.project-dashboard__knowledge')?.scrollIntoView({ block: 'start' });
					target.focus({ preventScroll: true });
					return;
				}
			}
			const target = closedCreateSummary ? this.root.querySelector<HTMLElement>('[data-focus-key="quick-create"]') :
				focusId ? this.root.querySelector<HTMLElement>(`#${CSS.escape(focusId)}`) :
				focusKey ? [...this.root.querySelectorAll<HTMLElement>('[data-focus-key]')].find(element => element.dataset.focusKey === focusKey) :
				focusSignature ? this.findFocusTarget(focusSignature) : undefined;
			if (this.focusTaskDetailOnRender) {
				this.focusTaskDetailOnRender = false;
				const detail = this.root.querySelector<HTMLElement>('.project-dashboard__detail');
				const detailTitle = detail?.querySelector<HTMLHeadingElement>('h2');
				if (detail && detailTitle) { detailTitle.focus({ preventScroll: true }); detail.scrollIntoView({ block: 'start' }); return; }
			}
			if (target && !('disabled' in target && target.disabled)) target.focus({ preventScroll: true });
		};
		clearNode(this.root);
		this.preservedReferenceViewerElement?.remove();
		const shell = this.root.appendChild($('.project-dashboard__shell'));
		const heading = shell.appendChild($('.project-dashboard__heading'));
		const headingCopy = heading.appendChild($('.project-dashboard__heading-copy'));
		const eyebrow = headingCopy.appendChild($('.project-dashboard__eyebrow'));
		eyebrow.textContent = '프로젝트 작업 공간';
		const title = headingCopy.appendChild($('h1'));
		title.id = 'project-dashboard-title';
		title.tabIndex = -1;
		title.textContent = this.dashboard?.project.name ?? '프로젝트';
		const location = headingCopy.appendChild($('.project-dashboard__location'));
		if (this.dashboard) {
			const tasks = this.dashboard.tasks;
			location.textContent = `작업 ${tasks.length}개 · 리뷰 대기 ${tasks.filter(task => task.state === 'review').length}개 · 실행 중 ${tasks.filter(task => task.state === 'inProgress').length}개`;
			location.title = this.dashboard.folder.path;
		} else location.textContent = '프로젝트 정보 불러오는 중';
		const headingActions = heading.appendChild($('.project-dashboard__heading-actions'));
		const navigation = headingActions.appendChild(createElement('button', 'project-dashboard__secondary project-dashboard__navigation'));
		navigation.type = 'button'; navigation.textContent = '프로젝트 메뉴';
		navigation.hidden = this.layoutService.isVisible(Parts.SIDEBAR_PART);
		navigation.dataset.focusKey = 'project-navigation';
		navigation.addEventListener('click', () => void this.openProjectNavigation());
		if (this.dashboard?.tasks.length) {
			const create = headingActions.appendChild(createElement('button', 'project-dashboard__primary project-dashboard__header-create'));
			create.type = 'button'; create.textContent = '새 작업'; create.disabled = !!this.taskMutationBusy;
			create.dataset.focusKey = 'header-create';
			create.addEventListener('click', () => this.openCreateTaskForm());
		}
		if (this.error) {
			const banner = shell.appendChild($('.project-dashboard__error'));
			banner.setAttribute('role', 'alert');
			banner.textContent = this.error;
			const retry = banner.appendChild(createElement('button', 'project-dashboard__retry'));
			retry.dataset.focusKey = 'dashboard-retry';
			retry.type = 'button'; retry.textContent = '다시 시도'; retry.addEventListener('click', () => void this.load());
		}
		if (this.navigationError) {
			const banner = shell.appendChild(createElement('div', 'project-dashboard__error project-dashboard__navigation-error'));
			banner.setAttribute('role', 'alert');
			const message = banner.appendChild($('span')); message.textContent = this.navigationError;
			const retry = banner.appendChild(createElement('button', 'project-dashboard__retry'));
			retry.type = 'button'; retry.textContent = '프로젝트 메뉴 다시 열기';
			retry.addEventListener('click', () => void this.openProjectNavigation());
		}
		if (this.dashboardStateError) {
			const banner = shell.appendChild($('.project-dashboard__error'));
			banner.setAttribute('role', 'alert');
			banner.textContent = this.dashboardStateError;
		}
		if (this.loading) {
			const status = shell.appendChild($('.project-dashboard__status'));
			status.setAttribute('role', 'status'); status.textContent = '프로젝트 작업 불러오는 중…';
			restorePosition();
			return;
		}
		if (!this.dashboard) { restorePosition(); return; }
		if (this.activeSection !== 'dashboard') {
			this.renderKnowledge(shell);
			restorePosition();
			return;
		}
		if (this.taskMutationError) {
			const error = shell.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert'); error.textContent = this.taskMutationError;
		}
		if (this.taskMutationBusy) {
			const status = shell.appendChild($('.project-dashboard__task-status')); status.setAttribute('role', 'status'); status.textContent = this.taskMutationBusy;
		}
		if (this.lifecycleError) {
			const error = shell.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert'); error.textContent = this.lifecycleError;
		}
		if (this.taskView !== 'board') {
			this.renderLifecycleTasks(shell);
			restorePosition();
			return;
		}

		const next = shell.appendChild($('.project-dashboard__next'));
		const emptyProject = this.dashboard.tasks.length === 0;
		if (emptyProject) next.classList.add('project-dashboard__next--empty');
		const nextCopy = next.appendChild($('.project-dashboard__next-copy'));
		const nextAction = this.dashboard.nextAction;
		const recommended = nextAction && this.dashboard.tasks.find(task => task.id === nextAction.taskId &&
			(nextAction.kind === 'review' || nextAction.kind === 'inspectChanges' ? task.state === 'review' : nextAction.kind === 'ready' ? task.state === 'ready' : task.state === 'inProgress'));
		const nextTask = recommended ?? (['review', 'inProgress', 'ready'] as const)
			.flatMap(state => this.dashboard!.tasks.filter(task => task.state === state).sort((left, right) => left.createdAt.localeCompare(right.createdAt)))[0];
		const kicker = nextCopy.appendChild($('.project-dashboard__kicker')); kicker.textContent = nextTask ? '다음 작업' : '프로젝트 작업';
		const allTasksDone = this.dashboard.tasks.length > 0 && this.dashboard.tasks.every(task => task.state === 'done');
		const nextTitle = nextCopy.appendChild($('h2')); nextTitle.textContent = nextTask?.title ?? (allTasksDone ? '모든 작업 완료' : '작업이 없습니다');
		const nextDescription = nextCopy.appendChild($('p'));
		const nextReason = nextAction && recommended?.id === nextAction.taskId
			? { attention: '실행 확인 필요', inspectChanges: '변경 내용 확인 필요', review: nextAction.hasPassedE2eEvidence ? '브라우저 확인 결과와 함께 검토' : '결과 검토 필요', running: '작업 진행 중', ready: '시작 준비 완료' }[nextAction.kind]
			: nextTask ? columns.find(column => column.state === nextTask.state)?.label : undefined;
		nextDescription.textContent = nextTask ? `${nextReason} · 상세에서 진행 상태를 확인하세요.` : allTasksDone
			? '새 작업을 추가해 계속 진행하세요.'
			: '작업을 만들면 보드에서 진행 상태를 관리할 수 있습니다.';
		const nextActions = next.appendChild(createElement('div', 'project-dashboard__next-actions'));
		const taskDetailLabel = !nextTask ? '작업 만들기'
			: nextAction?.taskId === nextTask.id && nextAction.kind === 'attention' ? '확인할 작업 보기'
			: nextAction?.taskId === nextTask.id && nextAction.kind === 'inspectChanges' ? '변경 내용 살펴보기'
			: nextTask.state === 'review' ? '검토할 작업 보기'
			: nextTask.state === 'inProgress' ? '진행 중 작업 보기'
			: '대기 작업 보기';
		const quickButton = nextActions.appendChild(createElement('button', 'project-dashboard__primary')); quickButton.type = 'button'; quickButton.textContent = taskDetailLabel;
		quickButton.disabled = !!this.taskMutationBusy;
		quickButton.dataset.focusKey = 'quick-create';
		quickButton.addEventListener('click', () => {
			if (nextTask) {
				this.stopPolling(); this.selectedTaskId = nextTask.id; this.focusTaskDetailOnRender = true; this.e2eDraftAttemptId = ''; this.e2eAttemptChosenByUser = false; this.e2eFormOpen = false; this.preview = undefined; this.providerError = undefined; this.providerErrorKind = undefined; this.attempts = [];
				this.scheduleDashboardStateSave(); this.render(); void this.loadAttempts();
			} else {
				this.openCreateTaskForm();
			}
		});
		if (nextTask && nextAction?.taskId === nextTask.id && nextAction.primaryReviewId) {
			const openReview = nextActions.appendChild(createElement('button', 'project-dashboard__secondary'));
			openReview.type = 'button'; openReview.textContent = '대표 리뷰 열기'; openReview.disabled = !!this.taskMutationBusy || this.reviewBridgeBusy;
			openReview.setAttribute('aria-label', `${nextTask.title} 작업의 대표 리뷰 열기`);
			openReview.addEventListener('click', () => void this.openPrimaryTaskReview(nextTask.id));
		}

		const boardHeader = shell.appendChild($('.project-dashboard__section-heading'));
		const boardTitle = boardHeader.appendChild($('h2')); boardTitle.textContent = '작업 보드';
		const count = boardHeader.appendChild($('span')); count.textContent = `작업 ${this.dashboard.tasks.length}개`;
		this.renderTaskViewNavigation(boardHeader);
		const detail = this.dashboard.tasks.find(task => task.id === this.selectedTaskId);
		const workArea = shell.appendChild($('.project-dashboard__work-area'));
		if (detail) workArea.classList.add('project-dashboard__work-area--with-detail');
		const board = workArea.appendChild($('.project-dashboard__board'));
		for (const column of columns) {
			const lane = board.appendChild($('.project-dashboard__lane'));
			lane.dataset.state = column.state;
			const laneHeader = lane.appendChild($('.project-dashboard__lane-heading'));
			const laneTitle = laneHeader.appendChild($('h3')); laneTitle.textContent = column.label;
			const tasks = this.dashboard.tasks.filter(task => task.state === column.state);
			const laneCount = laneHeader.appendChild($('.project-dashboard__count')); laneCount.textContent = String(tasks.length);
			for (const task of tasks) this.renderTask(lane, task);
		}

		if (detail) {
			const panel = workArea.appendChild($('.project-dashboard__detail'));
			const detailHeader = panel.appendChild($('.project-dashboard__detail-header'));
			const detailTitle = detailHeader.appendChild($('h2')); detailTitle.textContent = detail.title;
			detailTitle.tabIndex = -1; detailTitle.dataset.focusKey = 'selected-task-detail';
			if (this.editingTaskId !== detail.id) {
				const edit = detailHeader.appendChild(createElement('button', 'project-dashboard__secondary'));
				edit.type = 'button'; edit.textContent = '작업 수정'; edit.disabled = !!this.taskMutationBusy; edit.dataset.focusKey = 'task-edit';
				edit.addEventListener('click', () => {
					this.editingTaskId = detail.id; this.editTitleDraft = detail.title; this.editDescriptionDraft = detail.description ?? ''; this.taskEditError = undefined;
					this.render(); this.root?.querySelector<HTMLInputElement>('#task-edit-title')?.focus({ preventScroll: true });
				});
			}
			const close = detailHeader.appendChild(createElement('button', 'project-dashboard__close')); close.type = 'button'; close.textContent = '닫기'; close.addEventListener('click', () => {
				this.stopPolling(); this.selectedTaskId = undefined; this.scheduleDashboardStateSave(); this.render();
				const taskButton = [...(this.root?.querySelectorAll<HTMLElement>('.project-dashboard__task') ?? [])]
					.find(button => button.dataset.focusKey === `task:${detail.id}`);
				taskButton?.focus();
			});
			close.disabled = !!this.taskMutationBusy;
			close.dataset.focusKey = 'detail-close';
			if (this.editingTaskId === detail.id) {
				const editForm = panel.appendChild(createElement('form', 'project-dashboard__edit-form'));
				const titleLabel = editForm.appendChild(createElement('label')); titleLabel.htmlFor = 'task-edit-title'; titleLabel.textContent = '작업 제목';
				const titleInput = editForm.appendChild(createElement('input')); titleInput.id = 'task-edit-title'; titleInput.required = true; titleInput.maxLength = 160; titleInput.value = this.editTitleDraft; titleInput.disabled = this.taskEditBusy; titleInput.dataset.focusKey = 'task-edit-title';
				titleInput.addEventListener('input', () => { this.editTitleDraft = titleInput.value; });
				const descriptionLabel = editForm.appendChild(createElement('label')); descriptionLabel.htmlFor = 'task-edit-description'; descriptionLabel.textContent = '설명';
				const descriptionInput = editForm.appendChild(createElement('textarea')); descriptionInput.id = 'task-edit-description'; descriptionInput.rows = 4; descriptionInput.maxLength = 2000; descriptionInput.value = this.editDescriptionDraft; descriptionInput.disabled = this.taskEditBusy; descriptionInput.dataset.focusKey = 'task-edit-description';
				descriptionInput.addEventListener('input', () => { this.editDescriptionDraft = descriptionInput.value; });
				if (this.taskEditError) { const error = editForm.appendChild($('.project-dashboard__task-edit-error')); error.setAttribute('role', 'alert'); error.textContent = this.taskEditError; }
				const actions = editForm.appendChild($('.project-dashboard__edit-actions'));
				const save = actions.appendChild(createElement('button', 'project-dashboard__primary')); save.type = 'submit'; save.textContent = this.taskEditBusy ? '저장 중…' : '저장'; save.disabled = this.taskEditBusy || !!this.taskMutationBusy; save.dataset.focusKey = 'task-save';
				const cancel = actions.appendChild(createElement('button', 'project-dashboard__secondary')); cancel.type = 'button'; cancel.textContent = '취소'; cancel.disabled = this.taskEditBusy; cancel.dataset.focusKey = 'task-cancel';
				cancel.addEventListener('click', () => { this.editingTaskId = undefined; this.editTitleDraft = ''; this.editDescriptionDraft = ''; this.taskEditError = undefined; this.render(); this.root?.querySelector<HTMLElement>('[data-focus-key="task-edit"]')?.focus({ preventScroll: true }); });
				editForm.addEventListener('submit', event => { event.preventDefault(); void this.saveTaskDetails(detail); });
			} else {
				const description = panel.appendChild($('p')); description.className = 'project-dashboard__detail-description'; description.textContent = detail.description || '설명이 없습니다.';
			}
			const meta = panel.appendChild($('.project-dashboard__detail-meta')); meta.textContent = `수정일 ${new Date(detail.updatedAt).toLocaleDateString()}`;
			if (detail.state === 'ready' || detail.state === 'inProgress') this.renderProviderRuns(panel, detail);
			const reviews = panel.appendChild($('.project-dashboard__flow-card'));
			const reviewsTitle = reviews.appendChild($('h3')); reviewsTitle.textContent = '작업 리뷰';
			const reviewsLoaded = this.reviewLinksTaskId === detail.id;
			const taskReviewLinks = reviewsLoaded ? this.reviewLinks : [];
			const taskPendingCreates = reviewsLoaded ? this.reviewPendingCreates : [];
			const reviewActions=reviews.appendChild($('.project-dashboard__flow-actions'));
			const createReview=reviewActions.appendChild(createElement('button','project-dashboard__secondary')); createReview.type='button'; createReview.textContent=taskReviewLinks.length?'리뷰 추가':'리뷰 만들기'; createReview.dataset.focusKey = 'task-review-create'; createReview.disabled=this.reviewBridgeBusy || taskPendingCreates.length > 0 || !reviewsLoaded || this.reviewAvailability !== 'available'; createReview.addEventListener('click',()=>void this.mutateTaskReview('createTaskReview'));
			const refreshReviews=reviewActions.appendChild(createElement('button','project-dashboard__secondary')); refreshReviews.type='button'; refreshReviews.textContent='연결 다시 확인'; refreshReviews.dataset.focusKey = 'task-review-recheck'; refreshReviews.disabled=this.reviewBridgeBusy; refreshReviews.addEventListener('click',()=>{this.reviewBridgeError=undefined;this.reviewLinksTaskId=undefined;void this.loadTaskReviews();});
			for (const pending of taskPendingCreates) {
				const row=reviews.appendChild($('.project-dashboard__review-link'));
				const info=row.appendChild($('span')); info.textContent=`리뷰 생성 상태: ${pending.status === 'pending' ? '대기 중' : '실패'} · 요청 시각 ${new Date(pending.createdAt).toLocaleString()}${pending.lastError ? ` · ${this.errorMessage(new Error(pending.lastError), '요청 처리 중 오류가 발생했습니다.')}` : ''}`;
				const retry=row.appendChild(createElement('button','project-dashboard__secondary')); retry.type='button'; retry.textContent='같은 요청 다시 시도'; retry.disabled=this.reviewBridgeBusy || this.reviewAvailability !== 'available'; retry.addEventListener('click',()=>void this.mutateTaskReview('createTaskReview',undefined,pending.commandId));
			}
			if (!taskReviewLinks.length) { const empty=reviews.appendChild($('.project-dashboard__flow-status')); empty.textContent=!reviewsLoaded?'작업 리뷰 불러오는 중…':this.reviewAvailability==='unavailable'?'리뷰를 사용할 수 없어요. 시작된 뒤 연결을 다시 확인해 주세요.':'아직 연결된 리뷰가 없어요.'; }
			if (taskReviewLinks.some(link => link.isPrimary && link.state === 'unavailable')) {
				const repair = reviews.appendChild($('.project-dashboard__flow-status'));
				repair.setAttribute('role', 'status');
				repair.textContent = '대표 리뷰가 없거나 다른 저장소를 가리켜요. 사용할 수 있는 다른 리뷰를 선택하거나 연결을 수정한 뒤 다시 확인해 주세요.';
			}
			for (const link of taskReviewLinks) {
				const row = reviews.appendChild($('.project-dashboard__review-link'));
				const info = row.appendChild($('span'));
				info.textContent = `${link.reviewId}${link.isPrimary ? ' · 대표' : ''} · ${link.state === 'available' ? '사용 가능' : '이 프로젝트에서 사용할 수 없음'}`;
				const actions = row.appendChild($('.project-dashboard__flow-actions'));
				if (link.state !== 'available' || this.reviewAvailability !== 'available') continue;
				const open = actions.appendChild(createElement('button', 'project-dashboard__secondary'));
				open.type = 'button'; open.textContent = '검증된 스냅샷 열기'; open.disabled = this.reviewBridgeBusy;
				open.addEventListener('click', () => void this.openTaskReview(detail.id, link.reviewId));
				if (!link.isPrimary) {
					const primary = actions.appendChild(createElement('button', 'project-dashboard__secondary'));
					primary.type = 'button'; primary.textContent = '대표로 지정'; primary.disabled = this.reviewBridgeBusy;
					primary.addEventListener('click', () => void this.mutateTaskReview('choosePrimaryReview', link.reviewId));
				}
			}
			if(this.reviewAvailabilityError){const error=reviews.appendChild($('.project-dashboard__error'));error.setAttribute('role','alert');error.textContent=this.reviewAvailabilityError;}
			if(this.reviewBridgeError){const error=reviews.appendChild($('.project-dashboard__error'));error.setAttribute('role','alert');error.textContent=this.reviewBridgeError;}
			if(this.reviewBridgeNotice){const notice=reviews.appendChild($('.project-dashboard__flow-status'));notice.setAttribute('role','status');notice.textContent=this.reviewBridgeNotice;}
			if(this.selectedTaskId && this.reviewLinksTaskId !== this.selectedTaskId) void this.loadTaskReviews();
			const stateControl = panel.appendChild($('.project-dashboard__task-state'));
			const stateLabel = stateControl.appendChild($('h3')); stateLabel.textContent = '작업 상태';
			const states = stateControl.appendChild($('.project-dashboard__state-options')); states.setAttribute('role', 'group'); states.setAttribute('aria-label', '작업 상태');
			for (const column of columns) {
				const option = states.appendChild(createElement('button', 'project-dashboard__state-option'));
				option.type = 'button'; option.textContent = column.label; option.setAttribute('aria-pressed', String(detail.state === column.state));
				option.disabled = detail.state === column.state || !!this.taskMutationBusy;
				option.dataset.focusKey = `task-state:${column.state}`;
				option.addEventListener('click', () => void this.updateTaskState(detail, column.state));
			}
			this.renderWorkspaceE2e(panel, detail);
			if (detail.state === 'review' || detail.state === 'done') this.renderProviderRuns(panel, detail);
			const management = panel.appendChild($('.project-dashboard__task-management'));
			const managementTitle = management.appendChild($('h3')); managementTitle.textContent = '작업 관리';
			this.renderTaskManagementControls(management, detail);
		}
		this.renderCreateForm(shell);
		restorePosition();
	}

	private renderTask(lane: HTMLElement, task: WorkspaceDashboardTaskItemDTO): void {
		const card = lane.appendChild(createElement('div', 'project-dashboard__task-card'));
		card.draggable = !this.taskMutationBusy;
		card.setAttribute('aria-label', `${task.title}. ${columns.find(column => column.state === task.state)?.label} 단계 안에서 드래그해 순서를 바꾸세요. 키보드 사용자는 위로 이동 또는 아래로 이동을 선택할 수 있습니다.`);
		card.addEventListener('dragstart', event => {
			if (this.taskMutationBusy) { event.preventDefault(); return; }
			this.draggingTaskId = task.id;
			card.classList.add('project-dashboard__task-card--dragging');
			event.dataTransfer?.setData('text/plain', task.id);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
		});
		card.addEventListener('dragend', () => {
			this.draggingTaskId = undefined;
			this.root?.querySelectorAll('.project-dashboard__task-card--dragging, .project-dashboard__task-card--drop-target').forEach(node => node.classList.remove('project-dashboard__task-card--dragging', 'project-dashboard__task-card--drop-target'));
		});
		card.addEventListener('dragover', event => {
			if (!this.draggingTaskId || this.draggingTaskId === task.id || this.taskMutationBusy) return;
			const source = this.dashboard?.tasks.find(candidate => candidate.id === this.draggingTaskId);
			if (!source || source.state !== task.state) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
			card.classList.add('project-dashboard__task-card--drop-target');
		});
		card.addEventListener('dragleave', event => { if (!card.contains(event.relatedTarget as Node | null)) card.classList.remove('project-dashboard__task-card--drop-target'); });
		card.addEventListener('drop', event => {
			event.preventDefault();
			card.classList.remove('project-dashboard__task-card--drop-target');
			const sourceId = this.draggingTaskId ?? event.dataTransfer?.getData('text/plain');
			this.draggingTaskId = undefined;
			if (!sourceId || sourceId === task.id || !this.dashboard) return;
			const laneTasks = this.dashboard.tasks.filter(candidate => candidate.state === task.state).sort((left, right) => left.order - right.order || left.createdAt.localeCompare(right.createdAt));
			const sourceIndex = laneTasks.findIndex(candidate => candidate.id === sourceId);
			const targetIndex = laneTasks.findIndex(candidate => candidate.id === task.id);
			if (sourceIndex < 0 || targetIndex < 0) return;
			void this.reorderTask(task.state, sourceId, targetIndex < sourceIndex ? -1 : 1, targetIndex);
		});
		const open = card.appendChild(createElement('button', 'project-dashboard__task'));
		open.type = 'button'; open.setAttribute('aria-pressed', String(this.selectedTaskId === task.id)); open.disabled = !!this.taskMutationBusy;
		open.dataset.focusKey = `task:${task.id}`;
		const title = open.appendChild($('span.project-dashboard__task-title')); title.textContent = task.title;
		if (task.description) { const desc = open.appendChild($('span.project-dashboard__task-description')); desc.textContent = task.description; }
		open.addEventListener('click', () => {
			if (this.selectedTaskId !== task.id) {
				this.stopPolling(); this.selectedTaskId = task.id; this.focusTaskDetailOnRender = true; this.e2eDraftAttemptId = ''; this.e2eAttemptChosenByUser = false; this.e2eFormOpen = false; this.preview = undefined; this.providerError = undefined; this.providerErrorKind = undefined; this.attempts = [];
				this.scheduleDashboardStateSave(); this.render(); void this.loadAttempts();
			}
		});
		const laneTasks = this.dashboard?.tasks.filter(candidate => candidate.state === task.state).sort((left, right) => left.order - right.order || left.createdAt.localeCompare(right.createdAt)) ?? [];
		const index = laneTasks.findIndex(candidate => candidate.id === task.id);
		const order = card.appendChild($('.project-dashboard__task-order'));
		const moveUp = order.appendChild(createElement('button', 'project-dashboard__order-button'));
		moveUp.type = 'button'; moveUp.textContent = '↑'; moveUp.title = '위로 이동'; moveUp.disabled = index <= 0 || !!this.taskMutationBusy;
		moveUp.setAttribute('aria-label', `${task.title} 작업을 ${columns.find(column => column.state === task.state)?.label}에서 위로 이동`);
		moveUp.dataset.focusKey = `order:${task.id}:up`; moveUp.addEventListener('click', () => void this.reorderTask(task.state, task.id, -1));
		const moveDown = order.appendChild(createElement('button', 'project-dashboard__order-button'));
		moveDown.type = 'button'; moveDown.textContent = '↓'; moveDown.title = '아래로 이동'; moveDown.disabled = index < 0 || index >= laneTasks.length - 1 || !!this.taskMutationBusy;
		moveDown.setAttribute('aria-label', `${task.title} 작업을 ${columns.find(column => column.state === task.state)?.label}에서 아래로 이동`);
		moveDown.dataset.focusKey = `order:${task.id}:down`; moveDown.addEventListener('click', () => void this.reorderTask(task.state, task.id, 1));
	}


	private renderWorkspaceE2e(panel: HTMLElement, task: WorkspaceDashboardTaskItemDTO): void {
		const section = panel.appendChild($('.project-dashboard__flow-card'));
		const heading = section.appendChild($('h3')); heading.textContent = '브라우저 확인';
		const intro = section.appendChild($('p')); intro.textContent = '완료된 에이전트 실행 결과를 대상으로 브라우저 시나리오를 실행합니다.';
		if (this.e2eError) { const error = section.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert'); error.textContent = this.e2eError; }
		const visibleEvidence = this.e2eLoadedTaskId === task.id ? this.e2eEvidence : [];
		const latestEvidence = [...visibleEvidence].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
		const latestSummary = section.appendChild($('.project-dashboard__e2e-summary')); latestSummary.setAttribute('role', 'status');
		if (this.e2eLoading && this.e2eLoadedTaskId !== task.id) latestSummary.textContent = '최근 확인 결과 불러오는 중…';
		else if (latestEvidence) {
			const result = latestEvidence.state === 'passed' ? '통과' : latestEvidence.state === 'failed' ? '실패' : latestEvidence.state === 'running' ? '확인 중' : latestEvidence.state === 'cleanupFailed' ? '정리 확인 필요' : '취소됨';
			latestSummary.textContent = `최근 결과: ${result} · ${new Date(latestEvidence.createdAt).toLocaleString()} · ${e2eEnvironmentLabel(latestEvidence.environmentIdentity)}`;
		} else latestSummary.textContent = this.e2eLoadedTaskId === task.id ? '아직 확인 결과가 없습니다.' : '최근 확인 상태가 여기에 표시됩니다.';
		const formDisclosure = section.appendChild(createElement('details', 'project-dashboard__e2e-disclosure'));
		formDisclosure.open = this.e2eFormOpen;
		formDisclosure.addEventListener('toggle', () => { this.e2eFormOpen = formDisclosure.open; });
		const formSummary = formDisclosure.appendChild(createElement('summary')); formSummary.textContent = '확인 설정 및 실행';
		const form = formDisclosure.appendChild(createElement('form', 'project-dashboard__e2e-form'));
		const eligible = this.attempts.filter(attempt => attempt.taskId === task.id && attempt.purpose === 'task' && !!attempt.finishedAt).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		const attemptLabel = form.appendChild(createElement('label')); attemptLabel.htmlFor = 'e2e-attempt'; attemptLabel.textContent = '완료된 에이전트 실행';
		const attemptSelect = form.appendChild(createElement('select')); attemptSelect.id = 'e2e-attempt'; attemptSelect.required = true; attemptSelect.disabled = this.e2eBusy;
		const attemptPlaceholder = attemptSelect.appendChild(createElement('option')); attemptPlaceholder.value = ''; attemptPlaceholder.textContent = eligible.length ? '실행 선택' : '완료된 작업 실행이 없습니다';
		for (const attempt of eligible) { const option = attemptSelect.appendChild(createElement('option')); option.value = attempt.id; option.textContent = `${attempt.providerId === 'codex' ? 'Codex' : 'Claude'} · ${this.stateLabel(attempt.state)} · ${new Date(attempt.updatedAt).toLocaleString()}`; }
		const latestSuccessful = eligible.find(attempt => attempt.state === 'succeeded');
		if (this.e2eAttemptChosenByUser && eligible.some(attempt => attempt.id === this.e2eDraftAttemptId)) attemptSelect.value = this.e2eDraftAttemptId;
		else if (latestSuccessful) { this.e2eDraftAttemptId = latestSuccessful.id; attemptSelect.value = latestSuccessful.id; }
		else { this.e2eDraftAttemptId = ''; this.e2eAttemptChosenByUser = false; }
		attemptSelect.addEventListener('change', () => {
			this.e2eDraftAttemptId = attemptSelect.value;
			this.e2eAttemptChosenByUser = true;
			const start = form.querySelector<HTMLButtonElement>('button[type="submit"]');
			if (start) start.disabled = this.e2eBusy || this.e2eLoading || !attemptSelect.value;
		});
		const urlLabel = form.appendChild(createElement('label')); urlLabel.htmlFor = 'e2e-url'; urlLabel.textContent = '대상 URL';
		const url = form.appendChild(createElement('input')); url.id = 'e2e-url'; url.type = 'url'; url.required = true; url.placeholder = 'http://localhost:3000'; url.value = this.e2eUrlDraft; url.disabled = this.e2eBusy; url.addEventListener('input', () => { this.e2eUrlDraft = url.value; });
		const envLabel = form.appendChild(createElement('label')); envLabel.htmlFor = 'e2e-environment'; envLabel.textContent = '환경 식별 정보';
		const env = form.appendChild(createElement('input')); env.id = 'e2e-environment'; env.type = 'text'; env.required = true; env.maxLength = 120; env.value = this.e2eEnvironmentDraft; env.disabled = this.e2eBusy; env.addEventListener('input', () => { this.e2eEnvironmentDraft = env.value; });
		const scenarioHeading = form.appendChild($('h4')); scenarioHeading.textContent = '시나리오 단계';
		const steps = form.appendChild(createElement('ol', 'project-dashboard__e2e-steps'));
		this.e2eScenarioDraft.forEach((draft, index) => {
			const row = steps.appendChild(createElement('li', 'project-dashboard__e2e-step'));
			const typeLabel = row.appendChild(createElement('label')); typeLabel.htmlFor = `e2e-step-${index}-type`; typeLabel.textContent = `${index + 1}단계 동작`;
			const type = row.appendChild(createElement('select')); type.id = `e2e-step-${index}-type`; type.disabled = this.e2eBusy;
			for (const [value, label] of [['click', '클릭'], ['fill', '입력'], ['assertText', '텍스트 확인']] as const) { const option = type.appendChild(createElement('option')); option.value = value; option.textContent = label; }
			type.value = draft.type;
			type.addEventListener('change', () => { draft.type = type.value as WorkspaceE2eStep['type']; this.render(); });
			const selectorLabel = row.appendChild(createElement('label')); selectorLabel.htmlFor = `e2e-step-${index}-selector`; selectorLabel.textContent = 'CSS 선택자';
			const selector = row.appendChild(createElement('input')); selector.id = `e2e-step-${index}-selector`; selector.type = 'text'; selector.required = true; selector.maxLength = 500; selector.placeholder = 'button[type="submit"]'; selector.value = draft.selector; selector.disabled = this.e2eBusy; selector.addEventListener('input', () => { draft.selector = selector.value; });
			if (draft.type !== 'click') { const valueLabel = row.appendChild(createElement('label')); valueLabel.htmlFor = `e2e-step-${index}-value`; valueLabel.textContent = draft.type === 'fill' ? '입력할 텍스트' : '기대하는 텍스트'; const value = row.appendChild(createElement('input')); value.id = `e2e-step-${index}-value`; value.type = 'text'; value.required = true; value.maxLength = 2000; value.value = draft.value; value.disabled = this.e2eBusy; value.addEventListener('input', () => { draft.value = value.value; }); }
			const remove = row.appendChild(createElement('button', 'project-dashboard__secondary')); remove.type = 'button'; remove.textContent = '단계 제거'; remove.disabled = this.e2eBusy || this.e2eScenarioDraft.length <= 1; remove.addEventListener('click', () => { this.e2eScenarioDraft.splice(index, 1); this.render(); });
		});
		const actions = form.appendChild($('.project-dashboard__flow-actions'));
		const add = actions.appendChild(createElement('button', 'project-dashboard__secondary')); add.type = 'button'; add.textContent = '단계 추가'; add.disabled = this.e2eBusy || this.e2eScenarioDraft.length >= 12; add.addEventListener('click', () => { this.e2eScenarioDraft.push({ type: 'click', selector: '', value: '' }); this.render(); });
		const start = actions.appendChild(createElement('button', 'project-dashboard__primary')); start.type = 'submit'; start.textContent = this.e2eBusy ? '시작 중…' : '브라우저 확인 시작'; start.disabled = this.e2eBusy || this.e2eLoading || !attemptSelect.value;
		form.addEventListener('submit', event => { event.preventDefault(); if (!form.reportValidity()) return; this.e2eDraftAttemptId = attemptSelect.value; this.e2eUrlDraft = url.value; this.e2eEnvironmentDraft = env.value; void this.startWorkspaceE2e(task); });
		const listHeader = section.appendChild($('.project-dashboard__flow-actions'));
		const refresh = listHeader.appendChild(createElement('button', 'project-dashboard__secondary')); refresh.type = 'button'; refresh.textContent = this.e2eLoading ? '새로고침 중…' : '증거 새로고침'; refresh.disabled = this.e2eBusy || this.e2eLoading; refresh.addEventListener('click', () => void this.loadWorkspaceE2e(task.id, true));
		for (const evidence of [...visibleEvidence].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))) {
			const row = section.appendChild($('.project-dashboard__review-link'));
			const result = evidence.state === 'passed' ? '통과' : evidence.state === 'failed' ? '실패' : evidence.state === 'running' ? '실행 중' : evidence.state === 'cleanupFailed' ? '정리 확인 필요' : '취소됨';
			const screenshotSaved = !!(evidence.screenshotSha256 && evidence.screenshotPath);
			const logSaved = !!(evidence.logSha256 && evidence.logPath);
			const info = row.appendChild($('span')); info.textContent = `${result} · ${new Date(evidence.createdAt).toLocaleString()} · ${e2eEnvironmentLabel(evidence.environmentIdentity)} · ${evidence.targetUrl}`;
			const artifactStatus = row.appendChild(createElement('span', 'project-dashboard__e2e-artifacts'));
			artifactStatus.textContent = evidence.state === 'running' ? '확인이 끝나면 스크린샷과 로그를 볼 수 있습니다.' : `스크린샷 ${screenshotSaved ? '저장됨' : '저장되지 않음'} · 로그 ${logSaved ? '저장됨' : '저장되지 않음'}`;
			const audit = row.appendChild(createElement('details', 'project-dashboard__e2e-audit'));
			const auditSummary = audit.appendChild(createElement('summary')); auditSummary.textContent = '증거 파일 정보';
			const auditList = audit.appendChild($('dl'));
			for (const [label, value] of [
				['확인 시작 시 커밋 (전체 리비전)', e2eRevisionLabel(evidence)],
				['스크린샷 SHA-256', evidence.screenshotSha256 ?? '정보 없음'], ['스크린샷 경로', evidence.screenshotPath ?? '정보 없음'],
				['로그 SHA-256', evidence.logSha256 ?? '정보 없음'], ['로그 경로', evidence.logPath ?? '정보 없음'],
			] as const) { const term = auditList.appendChild($('dt')); term.textContent = label; const detail = auditList.appendChild($('dd')); detail.textContent = value; }
			if (evidence.failure) {
				const term = auditList.appendChild($('dt')); term.textContent = '기술 오류';
				const detail = auditList.appendChild($('dd')); detail.textContent = evidence.failure;
				const failure = row.appendChild($('.project-dashboard__provider-error')); failure.setAttribute('role', 'status'); failure.textContent = e2eFailureLabel(evidence.failure);
			}
			if (evidence.cleanupError) { const cleanup = row.appendChild($('.project-dashboard__error')); cleanup.setAttribute('role', 'alert'); cleanup.textContent = `정리를 확인해 주세요: ${this.errorMessage(new Error(evidence.cleanupError), '정리를 완료하지 못했습니다.', false)}`; }
			const rowActions = row.appendChild($('.project-dashboard__flow-actions'));
			if (evidence.state === 'running') { const cancel = rowActions.appendChild(createElement('button', 'project-dashboard__secondary')); cancel.type = 'button'; cancel.textContent = '취소'; cancel.disabled = this.e2eBusy; cancel.addEventListener('click', () => void this.mutateWorkspaceE2e(task, evidence, 'cancel')); }
			if (evidence.state === 'cleanupFailed') { const retry = rowActions.appendChild(createElement('button', 'project-dashboard__secondary')); retry.type = 'button'; retry.textContent = '정리 다시 시도'; retry.disabled = this.e2eBusy; retry.addEventListener('click', () => void this.mutateWorkspaceE2e(task, evidence, 'retryCleanup')); }
		}
	}

	private async loadWorkspaceE2e(taskId: string, force = false): Promise<void> {
		if (!this.projectId || !taskId || (!force && this.e2eLoadedTaskId === taskId)) return;
		if (this.e2eLoading) {
			if (this.e2eRequestTaskId !== taskId) this.e2ePendingRequest = { taskId, force };
			return;
		}
		const projectId = this.projectId;
		const requestGeneration = ++this.e2eRequestGeneration;
		this.e2eRequestTaskId = taskId;
		if (this.e2eLoadedTaskId !== taskId) this.e2eEvidence = [];
		this.e2eLoading = true; this.e2eError = undefined; this.render();
		try {
			const result = await ipcRenderer.invoke(WORKSPACE_E2E_CHANNEL, 'list', { projectId, taskId }) as { evidence: readonly WorkspaceE2eEvidenceDTO[] };
			if (this.e2eRequestGeneration === requestGeneration && this.projectId === projectId && this.selectedTaskId === taskId) { this.e2eEvidence = result.evidence; this.e2eLoadedTaskId = taskId; this.updatePolling(); }
		} catch (error) {
			if (this.e2eRequestGeneration === requestGeneration && this.projectId === projectId && this.selectedTaskId === taskId) this.e2eError = this.errorMessage(error, '브라우저 확인 기록을 불러오지 못했습니다.');
		} finally {
			if (this.e2eRequestGeneration === requestGeneration) {
				this.e2eLoading = false; this.e2eRequestTaskId = undefined;
				if (this.projectId === projectId && this.selectedTaskId === taskId) this.render();
				const pending = this.e2ePendingRequest;
				this.e2ePendingRequest = undefined;
				if (pending && this.projectId === projectId && this.selectedTaskId === pending.taskId) void this.loadWorkspaceE2e(pending.taskId, pending.force);
			}
		}
	}

	private async startWorkspaceE2e(task: WorkspaceDashboardTaskItemDTO): Promise<void> {
		if (!this.projectId || !this.e2eDraftAttemptId || this.e2eBusy) return;
		const scenario: WorkspaceE2eStep[] = this.e2eScenarioDraft.map(step => step.type === 'click' ? { type: 'click', selector: step.selector.trim() } : { type: step.type, selector: step.selector.trim(), value: step.value });
		this.e2eBusy = true; this.e2eError = undefined; this.render();
		try { await ipcRenderer.invoke(WORKSPACE_E2E_CHANNEL, 'start', { projectId: this.projectId, taskId: task.id, attemptId: this.e2eDraftAttemptId, targetUrl: this.e2eUrlDraft.trim(), environmentIdentity: this.e2eEnvironmentDraft.trim(), scenario }); this.e2eLoadedTaskId = undefined; await this.loadWorkspaceE2e(task.id, true); }
		catch (error) { this.e2eError = this.errorMessage(error, '브라우저 확인을 시작하지 못했습니다.'); }
		finally { this.e2eBusy = false; this.render(); }
	}

	private async mutateWorkspaceE2e(task: WorkspaceDashboardTaskItemDTO, evidence: WorkspaceE2eEvidenceDTO, command: 'cancel' | 'retryCleanup'): Promise<void> {
		if (!this.projectId || this.e2eBusy) return;
		this.e2eBusy = true; this.e2eError = undefined; this.render();
		try { await ipcRenderer.invoke(WORKSPACE_E2E_CHANNEL, command, { projectId: this.projectId, taskId: task.id, evidenceId: evidence.id }); this.e2eLoadedTaskId = undefined; await this.loadWorkspaceE2e(task.id, true); }
		catch (error) { this.e2eError = this.errorMessage(error, command === 'cancel' ? '브라우저 확인을 취소하지 못했습니다.' : '브라우저 확인 정리를 다시 시도하지 못했습니다.'); }
		finally { this.e2eBusy = false; this.render(); }
	}

	private renderTaskInstructions(parent: HTMLElement, task: WorkspaceDashboardTaskItemDTO): void {
		const section = parent.appendChild(createElement('section', 'project-dashboard__task-instructions'));
		const header = section.appendChild(createElement('div', 'project-dashboard__task-instructions-heading'));
		const title = header.appendChild($('h4')); title.textContent = '자료에서 승인한 지시'; title.tabIndex = -1; title.dataset.focusKey = 'task-instructions-title';
		const unavailable = this.taskPromotionLoadFailed && this.taskPromotionsTaskId === task.id;
		const current = !unavailable && this.taskPromotionsTaskId === task.id ? this.taskPromotions : [];
		const active = current.filter(item => item.active);
		const count = header.appendChild($('span')); count.textContent = unavailable ? '확인할 수 없음' : this.taskPromotionLoading && this.taskPromotionRequestTaskId === task.id ? '불러오는 중' : `${active.length}개 승인`;
		if (this.taskPromotionLoading && this.taskPromotionRequestTaskId === task.id) {
			const loading = section.appendChild($('p')); loading.className = 'project-dashboard__task-instructions-note'; loading.setAttribute('role', 'status'); loading.textContent = '승인 기록을 불러오는 중…';
		} else if (!active.length && !unavailable) {
			const empty = section.appendChild($('p')); empty.className = 'project-dashboard__task-instructions-note'; empty.textContent = '승인한 지시가 없습니다. 연결한 자료는 실행할 때 참고용으로만 전달됩니다.';
		}
		for (const item of active) {
			const row = section.appendChild(createElement('div', 'project-dashboard__task-instruction'));
			const source = this.knowledge?.references.find(reference => reference.id === item.sourceSnapshotId);
			const sourceLabel = row.appendChild($('strong')); sourceLabel.textContent = `${source?.title ?? '자료 스냅샷'} · v${item.sourceVersion}`;
			const exact = row.appendChild(createElement('p')); exact.textContent = item.excerpt;
			const meta = row.appendChild(createElement('small')); meta.textContent = `승인 ${new Date(item.approvedAt).toLocaleString()} · SHA-256 ${item.sourceContentSha256}`;
			const withdraw = row.appendChild(createElement('button', 'project-dashboard__secondary')); withdraw.type = 'button'; withdraw.textContent = '승인 취소'; withdraw.disabled = this.taskPromotionBusy;
			withdraw.setAttribute('aria-label', `${source?.title ?? '자료'}에서 승인한 작업 지시 취소`);
			withdraw.addEventListener('click', () => void this.withdrawReferenceExcerpt(item.id));
		}
		const withdrawn = current.filter(item => !item.active);
		if (withdrawn.length) {
			const history = section.appendChild(createElement('details', 'project-dashboard__task-instruction-history'));
			const summary = history.appendChild(createElement('summary')); summary.textContent = `취소한 지시 ${withdrawn.length}개`;
			for (const item of withdrawn) {
				const row = history.appendChild($('p'));
				const source = this.knowledge?.references.find(reference => reference.id === item.sourceSnapshotId);
				row.textContent = `${source?.title ?? '자료 스냅샷'} · v${item.sourceVersion} · ${item.excerpt} · 취소 ${item.withdrawnAt ? new Date(item.withdrawnAt).toLocaleString() : '기록 확인 필요'}`;
			}
		}
		if (this.taskPromotionError) {
			const error = section.appendChild($('.project-dashboard__provider-error')); error.setAttribute('role', 'alert'); error.textContent = this.taskPromotionError;
			if (this.taskPromotionLoadFailed) { const retry = section.appendChild(createElement('button', 'project-dashboard__secondary')); retry.type = 'button'; retry.textContent = '승인 기록 다시 불러오기'; retry.addEventListener('click', () => void this.loadTaskPromotions(task.id, true)); }
		}
		const sourceAction = section.appendChild(createElement('button', 'project-dashboard__secondary')); sourceAction.type = 'button'; sourceAction.textContent = this.knowledge?.taskReferences[task.id]?.length ? '자료에서 문장 선택' : '참고자료 연결하기';
		sourceAction.addEventListener('click', () => this.navigateToSection('references'));
	}

	private renderProviderRuns(panel: HTMLElement, task: WorkspaceDashboardTaskItemDTO): void {
		const section = panel.appendChild($('.project-dashboard__provider'));
		const heading = section.appendChild($('h3')); heading.textContent = 'AI로 작업하기';
		const caption = section.appendChild($('p')); caption.className = 'project-dashboard__provider-note'; caption.textContent = '작업 실행은 프로젝트 폴더의 파일을 수정할 수 있습니다. 시작 전에 프롬프트, 포함된 프로젝트 정보, 권한 요약을 확인하세요.';
		this.renderTaskInstructions(section, task);
		const taskStatus = section.appendChild($('.project-dashboard__run-state'));
		taskStatus.setAttribute('role', 'status');
		taskStatus.textContent = `작업 상태: ${columns.find(column => column.state === task.state)?.label ?? task.state}. ${task.state === 'done' ? '완료한 작업은 자동으로 실행되지 않습니다.' : task.state === 'ready' ? '실행 전에 작업 미리보기를 확인하세요.' : task.state === 'inProgress' ? '상위 실행이 진행 중이면 범위를 지정해 하위 에이전트를 실행할 수 있습니다.' : '완료 처리하기 전에 실행 결과를 검토하세요.'}`;
		if (task.state === 'ready') {
			const choiceRow = section.appendChild($('.project-dashboard__provider-controls'));
			const label = choiceRow.appendChild(createElement('label')); label.htmlFor = 'provider-run-provider'; label.textContent = '제공자';
			const choices = choiceRow.appendChild($('.project-dashboard__provider-segmented')); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', '제공자');
			for (const [value, text] of [['codex', 'Codex'], ['claude', 'Claude']] as const) {
				const option = choices.appendChild(createElement('button', 'project-dashboard__provider-option')); option.type = 'button'; option.textContent = text;
				option.setAttribute('aria-pressed', String(this.providerId === value)); option.dataset.focusKey = `provider:${value}`; option.disabled = this.providerBusy;
				option.addEventListener('click', () => {
					if (this.providerId === value || this.providerBusy) return;
					this.providerId = value; this.preview = undefined; this.providerError = undefined; this.providerErrorKind = undefined; this.render();
				});
			}
			const previewButton = choiceRow.appendChild(createElement('button', 'project-dashboard__secondary'));
			previewButton.type = 'button'; previewButton.textContent = this.providerBusy ? '준비 중…' : '작업 실행 미리보기'; previewButton.disabled = this.providerBusy;
			previewButton.dataset.focusKey = 'provider-preview';
			previewButton.addEventListener('click', () => void this.previewRun(task));
		}
		if (this.preview) {
			const preview = section.appendChild($('.project-dashboard__run-preview'));
			const previewHeading = preview.appendChild($('h4')); previewHeading.textContent = '파일을 수정하는 작업 실행 미리보기';
			const scope = preview.appendChild($('dl'));
			this.appendDefinition(scope, '모드', '파일 수정 · 실행 전 미리보기 필수');
			this.appendDefinition(scope, '로컬 CLI 프로필', this.preview.accountLabel);
			this.appendDefinition(scope, '작업 폴더', this.preview.cwd);
			this.appendDefinition(scope, '권한 요약', this.preview.permission.summary);
			if (this.preview.permission.ordinaryFolderGrantRequired) {
				const warning = preview.appendChild($('.project-dashboard__run-warning'));
				warning.setAttribute('role', 'note');
				warning.textContent = `Git/JJ 식별 정보가 없는 일반 폴더입니다. 편집을 허용하면 이 폴더에만 수정 권한을 부여합니다. 권한은 경로와 파일 시스템 식별 정보에 연결되며 폴더를 바꾸거나 이동하면 실행이 차단됩니다. 실제 작업 폴더를 확인하세요: ${this.preview.cwd}`;
				if (this.preview.permission.ordinaryFolderGrantEnabled) {
					const enabled = preview.appendChild($('.project-dashboard__run-grant-state')); enabled.setAttribute('role', 'status');
					enabled.textContent = this.folderMutationGrant
						? `${this.folderMutationGrant.canonicalPath} 폴더에만 편집 권한이 적용되어 있습니다 (장치 ${this.folderMutationGrant.dev}, inode ${this.folderMutationGrant.ino}).`
						: '위에 표시된 폴더에만 편집 권한이 적용되어 있습니다.';
				}
				const permissionActions = preview.appendChild($('.project-dashboard__provider-actions'));
				const grant = permissionActions.appendChild(createElement('button', 'project-dashboard__secondary'));
				grant.type = 'button'; grant.disabled = this.providerBusy || this.preview.permission.ordinaryFolderGrantEnabled;
				grant.textContent = this.providerBusy ? '권한 변경 중…' : '이 폴더의 편집 허용';
				grant.addEventListener('click', () => void this.mutateFolderGrant(task, 'enableFolderMutation'));
				const revoke = permissionActions.appendChild(createElement('button', 'project-dashboard__secondary'));
				revoke.type = 'button'; revoke.disabled = this.providerBusy || !this.preview.permission.ordinaryFolderGrantEnabled;
				revoke.textContent = '폴더 편집 권한 해제';
				revoke.addEventListener('click', () => void this.mutateFolderGrant(task, 'revokeFolderMutation'));
			}
			if (this.preview.conventionSnapshot) {
				const conventionHeading = preview.appendChild($('h4')); conventionHeading.textContent = `적용된 작업 규칙 · v${this.preview.conventionSnapshot.version}`;
				const conventionMeta = preview.appendChild($('.project-dashboard__run-snapshot-meta')); conventionMeta.textContent = `SHA-256 ${this.preview.conventionSnapshot.contentSha256}`;
				const conventionContent = preview.appendChild(createElement('pre', 'project-dashboard__run-context')); conventionContent.textContent = this.preview.conventionSnapshot.markdown;
			} else {
				const noConvention = preview.appendChild($('.project-dashboard__run-snapshot-meta')); noConvention.textContent = '적용된 프로젝트 작업 규칙이 없습니다.';
			}
			const referencesHeading = preview.appendChild($('h4')); referencesHeading.textContent = `연결된 자료 스냅샷 · ${this.preview.references.length}개`;
			if (!this.preview.references.length) { const empty = preview.appendChild($('.project-dashboard__run-snapshot-meta')); empty.textContent = '이 작업에 연결된 자료 스냅샷이 없습니다.'; }
			for (const reference of this.preview.references) {
				const snapshot = preview.appendChild($('.project-dashboard__run-reference'));
				const referenceTitle = snapshot.appendChild($('strong')); referenceTitle.textContent = `${reference.title} · v${reference.version}`;
				const referenceHash = snapshot.appendChild($('.project-dashboard__run-snapshot-meta')); referenceHash.textContent = `${reference.contentType} · SHA-256 ${reference.contentSha256}`;
				const referenceContent = snapshot.appendChild(createElement('pre', 'project-dashboard__run-context')); referenceContent.textContent = reference.content;
			}
			const instructionsHeading = preview.appendChild($('h4')); instructionsHeading.textContent = `승인한 작업 지시 · ${this.preview.approvedInstructions.length}개`;
			if (!this.preview.approvedInstructions.length) { const none = preview.appendChild($('.project-dashboard__run-snapshot-meta')); none.textContent = '자료에서 작업 지시로 승인한 문장이 없습니다.'; }
			for (const instruction of this.preview.approvedInstructions) {
				const row = preview.appendChild($('.project-dashboard__run-reference'));
				const source = this.preview.references.find(reference => reference.id === instruction.sourceSnapshotId);
				const label = row.appendChild($('strong')); label.textContent = `${source?.title ?? '자료 스냅샷'} · v${instruction.sourceVersion}`;
				const meta = row.appendChild($('.project-dashboard__run-snapshot-meta')); meta.textContent = `사람이 승인 · ${new Date(instruction.approvedAt).toLocaleString()} · 원본 SHA-256 ${instruction.sourceContentSha256}`;
				const exact = row.appendChild(createElement('pre', 'project-dashboard__run-context')); exact.textContent = instruction.excerpt;
			}
			if (this.preview.permission.blockedReason) {
				const blocked = preview.appendChild($('.project-dashboard__run-blocked')); blocked.setAttribute('role', 'alert'); blocked.textContent = this.errorMessage(new Error(this.preview.permission.blockedReason), '현재 권한 설정으로는 실행할 수 없습니다. 폴더 권한을 확인하세요.', false);
			}
			const promptLabel = preview.appendChild(createElement('h4')); promptLabel.textContent = '프롬프트';
			const prompt = preview.appendChild(createElement('pre', 'project-dashboard__prompt')); prompt.textContent = this.preview.prompt;
			const actions = preview.appendChild($('.project-dashboard__provider-actions'));
			const start = actions.appendChild(createElement('button', 'project-dashboard__primary')); start.type = 'button'; start.textContent = this.providerBusy ? '시작 중…' : '작업 실행'; start.disabled = this.providerBusy || task.state !== 'ready' || !this.preview.permission.allowed;
			start.dataset.focusKey = 'provider-start';
			start.addEventListener('click', () => void this.startRun(task));
		}
		this.renderSubagentControls(section, task);
		if (this.providerError) {
			const error = section.appendChild($('.project-dashboard__provider-error')); error.setAttribute('role', 'alert'); error.textContent = this.providerError;
		}
		const history = section.appendChild($('.project-dashboard__attempts'));
		const historyTitle = history.appendChild($('h4')); historyTitle.textContent = '실행 기록';
		if (!this.attempts.length) {
			const empty = history.appendChild($('p')); empty.className = 'project-dashboard__provider-note'; empty.textContent = '이 작업의 실행 기록이 없습니다.';
		} else {
			const list = history.appendChild(createElement('ul'));
			for (const attempt of this.attempts.filter(candidate => !candidate.parentAttemptId)) {
				const item = list.appendChild(createElement('li', 'project-dashboard__attempt'));
				const main = item.appendChild($('.project-dashboard__attempt-main'));
				const name = main.appendChild($('strong')); name.textContent = `${attempt.providerId === 'codex' ? 'Codex' : 'Claude'} · ${this.stateLabel(attempt.state)}`;
				const time = main.appendChild(createElement('time')); time.dateTime = attempt.updatedAt; time.textContent = new Date(attempt.updatedAt).toLocaleString();
				const detail = item.appendChild($('.project-dashboard__attempt-detail')); detail.textContent = `${attempt.mode === 'mutating' ? '파일 수정 실행' : '읽기 전용 연결 확인'} · ${attempt.accountLabel} · ${attempt.cwd}`;
				if (attempt.orchestrationPhase === 'waiting') { const waiting = item.appendChild($('.project-dashboard__attempt-detail')); waiting.textContent = this.attempts.some(child => child.parentAttemptId === attempt.id) ? '하위 에이전트와 정리가 끝날 때까지 리뷰를 기다리는 중입니다.' : '실행 정리가 끝날 때까지 리뷰를 기다리는 중입니다.'; }
				if (attempt.sessionId) { const session = item.appendChild($('.project-dashboard__attempt-detail')); session.textContent = `세션 ${attempt.sessionId}`; }
				if (attempt.errorSummary) { const failure = item.appendChild($('.project-dashboard__attempt-error')); failure.textContent = this.errorMessage(new Error(attempt.errorSummary), '실행이 완료되지 않았습니다. 자세한 내용은 오류 로그를 확인해 주세요.', false); }
				if (attempt.resultText) { const result = item.appendChild(createElement('pre', 'project-dashboard__subagent-result')); result.textContent = attempt.resultText; }
				if (attempt.ordinaryFolderChanges) {
					const report = attempt.ordinaryFolderChanges;
					const changes = item.appendChild(createElement('div', 'project-dashboard__attempt-folder-changes'));
					changes.setAttribute('role', 'status');
					const count = report.changes.length;
					changes.textContent = report.status === 'unverified'
						? '일반 폴더의 변경 사항을 확인하지 못했습니다. 실행 기록을 확인해 주세요.'
						: `일반 폴더 변경 ${count}건을 확인했습니다${report.truncated ? ' (보고서 일부 생략)' : ''}.`;
					if (task.state === 'review' && attempt.parentAttemptId === null && attempt.purpose === 'task' && attempt.mode === 'mutating'
						&& attempt.state === 'succeeded' && attempt.cleanupVerified && report.status === 'observed') {
						const fileList = item.appendChild(createElement('ul', 'project-dashboard__ordinary-change-files'));
						fileList.tabIndex = -1;
						for (const change of report.changes) {
							const nonRegularAfter = ['directory', 'symlink', 'special'].includes(change.after ?? '') || change.after?.startsWith('link:') === true;
							const unavailable = change.change === 'deleted' || change.change === 'symlink changed' || nonRegularAfter || !change.after;
							const row = fileList.appendChild(createElement('li', `project-dashboard__ordinary-change-file${unavailable ? ' project-dashboard__ordinary-change-file--inactive' : ''}`));
							const label = row.appendChild(createElement('span'));
								label.textContent = `${change.change === 'created' ? '추가' : change.change === 'modified' ? '수정' : change.change === 'deleted' ? '삭제됨' : change.change === 'symlink changed' ? '심볼릭 링크 변경 · 대상 확인 안 됨' : '파일 종류 변경'} · ${change.path}`;
							if (unavailable) {
								label.setAttribute('aria-disabled', 'true');
								if (nonRegularAfter) { label.textContent = `일반 파일이 아님 · ${change.path}`; }
								continue;
							}
							const open = row.appendChild(createElement('button', 'project-dashboard__secondary'));
							open.type = 'button'; open.textContent = '파일 열기'; open.setAttribute('aria-label', `${change.path} 파일 열기`);
							open.addEventListener('click', () => void this.openOrdinaryFolderChange(task, attempt, change.path));
						}
					}
					if (report.truncated) { const note = item.appendChild(createElement('p', 'project-dashboard__provider-note')); note.textContent = '보고서에 포함된 경로만 열 수 있습니다. 생략된 변경 내용은 확인되지 않았습니다.'; }
				}
				this.renderSubagentHistory(item, task, attempt);
				const hasActiveChildren = this.attempts.some(child => child.parentAttemptId === attempt.id && this.isActive(child.state));
				if (this.isActive(attempt.state) || (attempt.orchestrationPhase === 'waiting' && hasActiveChildren)) {
					const cancel = item.appendChild(createElement('button', 'project-dashboard__secondary')); cancel.type = 'button'; cancel.textContent = this.isActive(attempt.state) ? '실행 취소' : '하위 에이전트 취소'; cancel.disabled = this.providerBusy;
					cancel.dataset.focusKey = `cancel:${attempt.id}`;
					cancel.addEventListener('click', () => void this.cancelRun(attempt));
				}
			}
		}
	}

	private async openOrdinaryFolderChange(task: WorkspaceDashboardTaskItemDTO, attempt: ProviderAttemptDTO, relativePath: string): Promise<void> {
		if (!this.projectId || task.state !== 'review' || attempt.state !== 'succeeded') { return; }
		try {
			await this.inspectSnapshots.openSnapshot(this.projectId, task.id, attempt.id, relativePath, this.group);
			if (this.providerErrorKind === 'inspect') {
				this.providerError = undefined;
				this.providerErrorKind = undefined;
				this.render();
			}
		} catch (error) {
			this.providerError = this.errorMessage(error, '변경 파일을 열지 못했습니다. 폴더 또는 파일 상태를 다시 확인해 주세요.');
			this.providerErrorKind = 'inspect';
			this.render();
		}
	}

	private renderSubagentControls(section: HTMLElement, task: WorkspaceDashboardTaskItemDTO): void {
		if (task.state !== 'inProgress') return;
		const root = [...this.attempts].reverse().find(attempt => !attempt.parentAttemptId && attempt.purpose === 'task' && this.isActive(attempt.state));
		if (!root) return;
		if (this.subagentParentAttemptId !== root.id) {
			this.subagentParentAttemptId = root.id;
			this.subagentPreview = undefined;
			this.subagentScopeDraft = '';
			this.subagentFormOpen = false;
			this.subagentError = undefined;
		}
		const form = section.appendChild(createElement('details', 'project-dashboard__subagent-form'));
		form.open = this.subagentFormOpen;
		form.addEventListener('toggle', () => { this.subagentFormOpen = form.open; });
		const summary = form.appendChild(createElement('summary')); summary.textContent = '작업을 나눠 다른 AI에게 맡기기';
		const note = form.appendChild($('p')); note.className = 'project-dashboard__provider-note'; note.textContent = 'Codex 또는 Claude에게 이 프로젝트 안에서 수행할 작업 하나를 맡기세요. 하위 에이전트의 실행, 결과, 정리 상태는 별도로 기록됩니다.';
		const fields = form.appendChild($('.project-dashboard__subagent-fields'));
		const providerLabel = fields.appendChild(createElement('label')); providerLabel.htmlFor = 'subagent-provider'; providerLabel.textContent = '제공자';
		const provider = fields.appendChild(createElement('select')); provider.id = 'subagent-provider'; provider.disabled = this.providerBusy;
		for (const [value, label] of [['codex', 'Codex'], ['claude', 'Claude']] as const) {
			const option = provider.appendChild(createElement('option')); option.value = value; option.textContent = label;
		}
		provider.value = this.subagentProviderId;
		provider.addEventListener('change', () => { this.subagentProviderId = provider.value as ProviderId; this.subagentPreview = undefined; this.subagentError = undefined; this.render(); });
		const scopeLabel = fields.appendChild(createElement('label')); scopeLabel.htmlFor = 'subagent-scope'; scopeLabel.textContent = '맡길 작업';
		const scope = fields.appendChild(createElement('textarea')); scope.id = 'subagent-scope'; scope.rows = 3; scope.value = this.subagentScopeDraft; scope.disabled = this.providerBusy;
		scope.placeholder = '예: 파서 변경을 살펴보고 예외 상황을 파일 경로와 함께 정리하세요.';
		const count = fields.appendChild($('.project-dashboard__subagent-count'));
		const scopeBytes = () => this.subagentScopeDraft.trim() ? new TextEncoder().encode(JSON.stringify({ scope: this.subagentScopeDraft.trim() })).length : 0;
		const updateCount = () => { count.textContent = `${scopeBytes()} / 8192바이트 사용`; count.classList.toggle('project-dashboard__subagent-count--over', scopeBytes() > 8192); };
		updateCount();
		const actions = form.appendChild($('.project-dashboard__provider-actions'));
		const previewButton = actions.appendChild(createElement('button', 'project-dashboard__secondary')); previewButton.type = 'button'; previewButton.textContent = this.providerBusy ? '준비 중…' : '하위 에이전트 미리보기';
		previewButton.disabled = this.providerBusy || scopeBytes() === 0 || scopeBytes() > 8192;
		previewButton.addEventListener('click', () => void this.previewSubagent(task, root));
		scope.addEventListener('input', () => {
			this.subagentScopeDraft = scope.value;
			this.subagentPreview = undefined;
			this.subagentError = undefined;
			form.querySelector('.project-dashboard__subagent-preview')?.remove();
			form.querySelector('.project-dashboard__provider-error')?.remove();
			updateCount();
			previewButton.disabled = this.providerBusy || scopeBytes() === 0 || scopeBytes() > 8192;
		});
		if (this.subagentPreview) {
			const preview = form.appendChild($('.project-dashboard__run-preview.project-dashboard__subagent-preview'));
			const previewHeading = preview.appendChild($('h4')); previewHeading.textContent = '하위 에이전트 실행 미리보기';
			const facts = preview.appendChild($('dl'));
			this.appendDefinition(facts, '로컬 CLI 프로필', this.subagentPreview.accountLabel);
			this.appendDefinition(facts, '작업 폴더', this.subagentPreview.cwd);
			this.appendDefinition(facts, '권한', this.subagentPreview.permission.summary);
			this.appendDefinition(facts, '프로젝트 작업 규칙', this.subagentPreview.conventionSnapshot ? `${this.subagentPreview.conventionSnapshot.version}번째 버전` : '적용 안 됨');
			this.appendDefinition(facts, '참고자료', `${this.subagentPreview.references.length}개 연결됨`);
			if (this.subagentPreview.permission.ordinaryFolderGrantRequired) {
				const grantState = preview.appendChild($('.project-dashboard__run-grant-state'));
				grantState.textContent = this.subagentPreview.permission.ordinaryFolderGrantEnabled
					? '이 일반 폴더에만 편집이 허용되어 있습니다.'
					: '하위 에이전트를 시작하려면 이 일반 폴더의 편집을 허용해야 합니다.';
				if (!this.subagentPreview.permission.ordinaryFolderGrantEnabled) {
					const grant = preview.appendChild(createElement('button', 'project-dashboard__secondary')); grant.type = 'button'; grant.textContent = '이 폴더의 편집 허용'; grant.disabled = this.providerBusy;
					grant.addEventListener('click', () => void this.enableSubagentFolderGrant(task, root));
				}
			}
			const prompt = preview.appendChild(createElement('pre', 'project-dashboard__run-context')); prompt.textContent = this.subagentPreview.prompt;
			if (this.subagentPreview.permission.blockedReason) {
				const blocked = preview.appendChild($('.project-dashboard__run-blocked')); blocked.setAttribute('role', 'alert'); blocked.textContent = this.errorMessage(new Error(this.subagentPreview.permission.blockedReason), '현재 권한 설정으로는 하위 에이전트를 실행할 수 없습니다. 폴더 권한을 확인하세요.', false);
			}
			const start = preview.appendChild(createElement('button', 'project-dashboard__primary')); start.type = 'button'; start.textContent = this.providerBusy ? '시작 중…' : '하위 에이전트 시작';
			start.disabled = this.providerBusy || !this.subagentPreview.permission.allowed;
			start.addEventListener('click', () => void this.startSubagent(task, root));
		}
		if (this.subagentError) { const error = form.appendChild($('.project-dashboard__provider-error')); error.setAttribute('role', 'alert'); error.textContent = this.subagentError; }
	}

	private renderSubagentHistory(item: HTMLElement, task: WorkspaceDashboardTaskItemDTO, root: ProviderAttemptDTO): void {
		const children = this.attempts.filter(attempt => attempt.parentAttemptId === root.id);
		if (!children.length) return;
		const details = item.appendChild(createElement('details', 'project-dashboard__subagent-history'));
		details.open = this.expandedSubagentRootId === root.id;
		const activeCount = children.filter(child => this.isActive(child.state)).length;
		const failedCount = children.filter(child => child.state === 'failed' || child.state === 'interrupted' || child.state === 'cancelled').length;
		const summary = details.appendChild(createElement('summary'));
		summary.textContent = `하위 에이전트 ${children.length}개 · ${failedCount ? `${failedCount}개 확인 필요` : activeCount ? `${activeCount}개 실행 중` : '완료'}`;
		summary.addEventListener('click', event => {
			event.preventDefault();
			const opening = this.expandedSubagentRootId !== root.id;
			this.expandedSubagentRootId = opening ? root.id : undefined;
			this.subagentEventsError = undefined;
			this.render();
			if (opening) void this.loadSubagentEvents(task.id, root.id);
		});
		if (details.open && this.subagentEventsError) {
			const error = details.appendChild($('.project-dashboard__provider-error')); error.setAttribute('role', 'alert'); error.textContent = this.subagentEventsError;
			const retry = details.appendChild(createElement('button', 'project-dashboard__secondary')); retry.type = 'button'; retry.textContent = '이벤트 다시 불러오기'; retry.addEventListener('click', () => void this.loadSubagentEvents(task.id, root.id));
		}
		const list = details.appendChild(createElement('ul', 'project-dashboard__subagent-list'));
		for (const child of children) {
			const row = list.appendChild(createElement('li', 'project-dashboard__subagent'));
			const title = row.appendChild($('strong')); title.textContent = `${child.providerId === 'codex' ? 'Codex' : 'Claude'} · ${this.stateLabel(child.state)}`;
			const when = row.appendChild(createElement('time')); when.dateTime = child.updatedAt; when.textContent = new Date(child.updatedAt).toLocaleString();
			const scope = row.appendChild($('p')); scope.textContent = this.subagentScopeText(child.childScope ?? null);
			if (child.errorSummary) { const error = row.appendChild($('.project-dashboard__attempt-error')); error.textContent = this.errorMessage(new Error(child.errorSummary), '하위 에이전트 실행이 완료되지 않았습니다. 자세한 내용은 오류 로그를 확인해 주세요.', false); }
			if (child.resultText !== null && child.resultText !== undefined) {
				const result = row.appendChild(createElement('pre', 'project-dashboard__subagent-result')); result.textContent = child.resultText || '하위 에이전트가 완료되었지만 작성된 결과가 없습니다.';
			}
			const events = this.subagentEvents[child.id];
			if (events?.length) {
				const eventDetails = row.appendChild(createElement('details', 'project-dashboard__subagent-events'));
				const eventSummary = eventDetails.appendChild(createElement('summary')); eventSummary.textContent = `최근 이벤트 ${events.length}개`;
				const eventList = eventDetails.appendChild(createElement('ol'));
				for (const event of events) {
					const eventRow = eventList.appendChild(createElement('li'));
					eventRow.textContent = `${subagentEventLabel(event)} · ${new Date(event.createdAt).toLocaleTimeString()}`;
				}
			}
			if (this.isActive(child.state)) {
				const cancel = row.appendChild(createElement('button', 'project-dashboard__secondary')); cancel.type = 'button'; cancel.textContent = '하위 에이전트 취소'; cancel.disabled = this.providerBusy;
				cancel.addEventListener('click', () => void this.cancelRun(child));
			}
		}
	}

	private subagentScopeText(encoded: string | null): string {
		if (!encoded) return '지정된 작업이 없습니다.';
		try {
			const value: unknown = JSON.parse(encoded);
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				if (typeof (value as { scope?: unknown }).scope === 'string') return (value as { scope: string }).scope;
				const files = (value as { files?: unknown }).files;
				if (Array.isArray(files) && files.every(file => typeof file === 'string')) return files.length ? `Files: ${files.join(', ')}` : '지정된 파일이 없습니다.';
				return JSON.stringify(value);
			}
		} catch { return '저장된 작업 내용을 읽을 수 없습니다.'; }
		return '저장된 작업 형식을 지원하지 않습니다.';
	}

	private async mutateFolderGrant(task: WorkspaceDashboardTaskItemDTO, operation: 'enableFolderMutation' | 'revokeFolderMutation'): Promise<void> {
		if (!this.projectId || !this.dashboard || this.providerBusy) return;
		const projectId = this.projectId;
		const bindingId = this.dashboard.folder.id;
		const priorPreview = this.preview;
		let succeeded = false;
		this.providerBusy = true; this.providerError = undefined; this.providerErrorKind = undefined; this.preview = undefined; this.render();
		try {
			if (operation === 'enableFolderMutation') {
				this.folderMutationGrant = await ipcRenderer.invoke(WORKSPACE_PROVIDER_RUNS_CHANNEL, operation, { projectId, bindingId }) as OrdinaryFolderMutationGrantDTO;
			} else {
				await ipcRenderer.invoke(WORKSPACE_PROVIDER_RUNS_CHANNEL, operation, { projectId, bindingId });
				this.folderMutationGrant = undefined;
			}
			succeeded = true;
		} catch (error) {
			this.preview = priorPreview;
			this.providerError = this.errorMessage(error, '이 폴더의 편집 권한을 변경하지 못했습니다.'); this.providerErrorKind = 'operation';
		} finally {
			this.providerBusy = false; this.render();
		}
		if (succeeded) await this.previewRun(task);
	}

	private appendDefinition(list: HTMLElement, term: string, value: string): void {
		const dt = list.appendChild($('dt')); dt.textContent = term;
		const dd = list.appendChild($('dd')); dd.textContent = value;
	}

	private async previewRun(task: WorkspaceDashboardTaskItemDTO): Promise<void> {
		if (!this.projectId || this.providerBusy) return;
		const projectId = this.projectId;
		const providerId = this.providerId;
		this.providerBusy = true; this.providerError = undefined; this.providerErrorKind = undefined; this.preview = undefined; this.render();
		try {
			const preview = await ipcRenderer.invoke(WORKSPACE_PROVIDER_RUNS_CHANNEL, 'preview', { projectId, taskId: task.id, providerId }) as ProviderRunPreviewDTO;
			if (this.selectedTaskId === task.id && this.providerId === providerId) this.preview = preview;
		} catch (error) { if (this.selectedTaskId === task.id && this.providerId === providerId) { this.providerError = this.errorMessage(error, '실행 미리보기를 준비하지 못했습니다.'); this.providerErrorKind = 'operation'; } }
		finally { this.providerBusy = false; this.render(); }
	}

	private async previewSubagent(task: WorkspaceDashboardTaskItemDTO, root: ProviderAttemptDTO): Promise<void> {
		if (!this.projectId || this.providerBusy || !this.subagentScopeDraft.trim()) return;
		const projectId = this.projectId;
		const providerId = this.subagentProviderId;
		const scope = this.subagentScopeDraft.trim();
		this.providerBusy = true; this.subagentError = undefined; this.subagentPreview = undefined; this.render();
		try {
			const preview = await ipcRenderer.invoke(WORKSPACE_PROVIDER_RUNS_CHANNEL, 'previewSubagent', {
				projectId, taskId: task.id, parentAttemptId: root.id, providerId, scope,
			}) as ProviderRunPreviewDTO;
			if (this.projectId === projectId && this.selectedTaskId === task.id && this.subagentParentAttemptId === root.id && this.subagentProviderId === providerId && this.subagentScopeDraft.trim() === scope) this.subagentPreview = preview;
		} catch (error) {
			if (this.projectId === projectId && this.selectedTaskId === task.id) this.subagentError = this.errorMessage(error, '하위 에이전트 미리보기를 준비하지 못했습니다.');
		} finally { this.providerBusy = false; this.render(); }
	}

	private async enableSubagentFolderGrant(task: WorkspaceDashboardTaskItemDTO, root: ProviderAttemptDTO): Promise<void> {
		if (!this.projectId || !this.dashboard || this.providerBusy) return;
		const projectId = this.projectId;
		const bindingId = this.dashboard.folder.id;
		this.providerBusy = true; this.subagentError = undefined; this.render();
		try {
			this.folderMutationGrant = await ipcRenderer.invoke(WORKSPACE_PROVIDER_RUNS_CHANNEL, 'enableFolderMutation', { projectId, bindingId }) as OrdinaryFolderMutationGrantDTO;
		} catch (error) {
			if (this.projectId === projectId && this.selectedTaskId === task.id) this.subagentError = this.errorMessage(error, '이 폴더의 편집을 허용하지 못했습니다.');
			this.providerBusy = false; this.render(); return;
		}
		this.providerBusy = false;
		if (this.projectId === projectId && this.selectedTaskId === task.id && this.subagentParentAttemptId === root.id) await this.previewSubagent(task, root);
	}

	private async startSubagent(task: WorkspaceDashboardTaskItemDTO, root: ProviderAttemptDTO): Promise<void> {
		if (!this.projectId || this.providerBusy || !this.subagentPreview?.permission.allowed || this.subagentParentAttemptId !== root.id) return;
		const projectId = this.projectId;
		const preview = this.subagentPreview;
		this.providerBusy = true; this.subagentError = undefined; this.render();
		try {
			await ipcRenderer.invoke(WORKSPACE_PROVIDER_RUNS_CHANNEL, 'startSubagent', {
				projectId, taskId: task.id, parentAttemptId: root.id, providerId: this.subagentProviderId,
				scope: this.subagentScopeDraft.trim(), digest: preview.digest,
			});
			this.subagentPreview = undefined;
			this.subagentScopeDraft = '';
			this.subagentFormOpen = false;
			this.expandedSubagentRootId = root.id;
			this.subagentEventsError = undefined;
			await this.loadAttempts(false);
			await this.loadSubagentEvents(task.id, root.id);
		} catch (error) { if (this.projectId === projectId && this.selectedTaskId === task.id) this.subagentError = this.errorMessage(error, '하위 에이전트를 시작하지 못했습니다.'); }
		finally { this.providerBusy = false; this.render(); this.updatePolling(); }
	}

	private async loadSubagentEvents(taskId: string, parentAttemptId: string): Promise<void> {
		if (!this.projectId || this.selectedTaskId !== taskId) return;
		const projectId = this.projectId;
		try {
			const result = await ipcRenderer.invoke(WORKSPACE_PROVIDER_RUNS_CHANNEL, 'listSubagents', { projectId, taskId, parentAttemptId }) as {
				attempts: readonly ProviderAttemptDTO[]; events: Readonly<Record<string, readonly ProviderAttemptEventDTO[]>>;
			};
			if (this.projectId === projectId && this.selectedTaskId === taskId && this.expandedSubagentRootId === parentAttemptId) {
				this.subagentEvents = { ...this.subagentEvents, ...result.events };
				this.subagentEventsError = undefined;
				this.render();
			}
		} catch (error) {
			if (this.projectId === projectId && this.selectedTaskId === taskId && this.expandedSubagentRootId === parentAttemptId) {
				this.subagentEventsError = this.errorMessage(error, '하위 에이전트 이벤트를 불러오지 못했습니다.'); this.render();
			}
		}
	}

	private async startRun(task: WorkspaceDashboardTaskItemDTO): Promise<void> {
		if (!this.projectId || task.state !== 'ready' || !this.preview?.permission.allowed || this.providerBusy) return;
		const preview = this.preview;
		this.providerBusy = true; this.providerError = undefined; this.providerErrorKind = undefined; this.render();
		try {
			await ipcRenderer.invoke(WORKSPACE_PROVIDER_RUNS_CHANNEL, 'start', { projectId: this.projectId, taskId: task.id, providerId: this.providerId, digest: preview.digest });
			this.preview = undefined;
			await this.loadAttempts(false);
			await this.refreshDashboard();
		} catch (error) { this.providerError = this.errorMessage(error, '실행을 시작하지 못했습니다.'); this.providerErrorKind = 'operation'; }
		finally { this.providerBusy = false; this.render(); this.updatePolling(); }
	}

	private async cancelRun(attempt: ProviderAttemptDTO): Promise<void> {
		if (!this.projectId || this.providerBusy) return;
		this.providerBusy = true; this.providerError = undefined; this.providerErrorKind = undefined; this.render();
		try {
			await ipcRenderer.invoke(WORKSPACE_PROVIDER_RUNS_CHANNEL, 'cancel', { projectId: this.projectId, attemptId: attempt.id });
			await this.loadAttempts();
		} catch (error) { this.providerError = this.errorMessage(error, '실행을 취소하지 못했습니다.'); this.providerErrorKind = 'operation'; }
		finally { this.providerBusy = false; this.render(); this.updatePolling(); }
	}

	private async loadAttempts(refreshDashboardOnStateChange = true): Promise<void> {
		if (!this.projectId || !this.selectedTaskId) return;
		void this.loadTaskPromotions(this.selectedTaskId);
		if (this.polling) {
			this.attemptRefreshPending = true;
			this.refreshDashboardAfterPendingAttemptRefresh = this.refreshDashboardAfterPendingAttemptRefresh && refreshDashboardOnStateChange;
			return;
		}
		const projectId = this.projectId;
		const taskId = this.selectedTaskId;
		if (this.subagentTaskId !== taskId) {
			this.subagentTaskId = taskId;
			this.subagentParentAttemptId = undefined;
			this.subagentPreview = undefined;
			this.subagentScopeDraft = '';
			this.subagentFormOpen = false;
			this.expandedSubagentRootId = undefined;
			this.subagentEvents = {};
			this.subagentError = undefined;
			this.subagentEventsError = undefined;
		}
		void this.loadWorkspaceE2e(taskId, this.e2eEvidence.some(evidence => evidence.state === 'running'));
		this.polling = true;
		try {
			const result = await ipcRenderer.invoke(WORKSPACE_PROVIDER_RUNS_CHANNEL, 'list', { projectId, taskId }) as { attempts: readonly ProviderAttemptDTO[] };
			if (this.projectId === projectId && this.selectedTaskId === taskId) {
				const priorStates = new Map(this.attempts.map(attempt => [attempt.id, attempt.state]));
				const stateChanged = this.attempts.length !== result.attempts.length || result.attempts.some(attempt => priorStates.get(attempt.id) !== attempt.state);
				const attemptsChanged = JSON.stringify(this.attempts) !== JSON.stringify(result.attempts);
				this.attempts = result.attempts;
				if (this.expandedSubagentRootId) void this.loadSubagentEvents(taskId, this.expandedSubagentRootId);
				const clearedHistoryError = this.providerErrorKind === 'history';
				if (clearedHistoryError) { this.providerError = undefined; this.providerErrorKind = undefined; }
				if (stateChanged && refreshDashboardOnStateChange) await this.refreshDashboard(false);
				this.updatePolling();
				if (attemptsChanged || clearedHistoryError) this.render();
			}
		} catch (error) { if (this.projectId === projectId && this.selectedTaskId === taskId) { this.providerError = this.errorMessage(error, '실행 기록을 불러오지 못했습니다.'); this.providerErrorKind = 'history'; this.render(); } }
		finally {
			this.polling = false;
			if (this.attemptRefreshPending) {
				const refreshDashboard = this.refreshDashboardAfterPendingAttemptRefresh;
				this.attemptRefreshPending = false;
				this.refreshDashboardAfterPendingAttemptRefresh = true;
				void this.loadAttempts(refreshDashboard);
			} else if (this.selectedTaskId && this.selectedTaskId !== taskId) void this.loadAttempts();
		}
	}

	private async refreshDashboard(renderAfterRefresh = true): Promise<boolean> {
		if (!this.projectId) return false;
		const projectId = this.projectId;
		try {
			const dashboard = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'getDashboard', projectId) as WorkspaceDashboardDTO;
			if (this.projectId !== projectId) return false;
			this.dashboard = dashboard;
			this.lastSavedDashboardPosition = dashboard.view.dashboardPosition;
			if (this.selectedTaskId && !dashboard.tasks.some(task => task.id === this.selectedTaskId)) this.selectedTaskId = undefined;
			if (renderAfterRefresh) this.render();
			return true;
		} catch (error) {
			if (this.projectId === projectId) {
				this.providerError = this.errorMessage(error, '실행 상태가 바뀐 뒤 작업을 새로고침하지 못했습니다.');
				this.providerErrorKind = 'operation';
				if (renderAfterRefresh) this.render();
			}
			return false;
		}
	}

	private updatePolling(): void {
		const active = (this.attempts.some(attempt => this.isActive(attempt.state)) || this.e2eEvidence.some(evidence => evidence.state === 'running')) && !!this.selectedTaskId;
		if (active && !this.pollTimer) this.pollTimer = setInterval(() => void this.loadAttempts(), 3000);
		else if (!active) this.stopPolling();
	}

	private stopPolling(): void { if (this.pollTimer) clearInterval(this.pollTimer); this.pollTimer = undefined; }
	private isActive(state: ProviderAttemptDTO['state']): boolean { return state === 'queued' || state === 'preflight' || state === 'running'; }
	private stateLabel(state: ProviderAttemptDTO['state']): string { return ({ queued: '대기 중', preflight: '접근 확인 중', running: '실행 중', succeeded: '성공', failed: '실패', cancelled: '취소됨', interrupted: '중단됨' })[state]; }
	private conventionVerdictLabel(verdict: NonNullable<ConventionAgentResultDTO['verdict']>): string { return ({ pass: '통과', concerns: '확인 필요', fail: '실패' })[verdict]; }
	private rawErrorMessage(error: unknown): string { return error instanceof Error ? error.message : ''; }
	private errorMessage(error: unknown, fallback: string, log = true): string {
		const raw = this.rawErrorMessage(error).trim();
		if (!raw) return fallback;
		if (log) console.error('Project dashboard operation failed:', error);
		if (/[가-힣]/.test(raw)) return raw;
		const normalized = raw.toLowerCase();
		if (normalized.includes('changed since revision')) return '다른 곳에서 작업이 변경되었습니다. 최신 내용을 불러왔으니 다시 확인해 주세요.';
		if (normalized.includes('task set') || normalized.includes('changed before reorder')) return '작업 목록이 변경되었습니다. 최신 순서를 불러와 다시 시도해 주세요.';
		if (/source preview .*expired|preview .*expired|no longer available/.test(normalized)) return '미리보기가 만료되었거나 더 이상 사용할 수 없습니다. 다시 미리보기해 주세요.';
		if (/invalid (?:or expired )?preview/.test(normalized)) return '미리보기 정보가 올바르지 않습니다. 다시 미리보기해 주세요.';
		if (normalized.includes('does not belong to this project')) return '요청한 항목이 현재 프로젝트에 속하지 않습니다. 프로젝트를 확인해 주세요.';
		if (normalized.includes('not installed in this project')) return '이 프로젝트에 설치되지 않은 패키지입니다. 패키지 목록을 새로고침해 주세요.';
		if (normalized.includes('selected sources or convention changed')) return '미리보기 이후 참고자료나 작업 규칙이 변경되었습니다. 요청을 다시 미리보기해 주세요.';
		if (normalized.includes('selected reference does not belong')) return '선택한 자료가 이 패키지 출처에 속하지 않습니다. 자료를 다시 선택해 주세요.';
		if (normalized.includes('refresh the latest version')) return '새로고침하려면 해당 자료의 가장 최근 버전을 선택해 주세요.';
		if (normalized.includes('already active') && normalized.includes('capture')) return 'Ego 가져오기 세션이 이미 열려 있습니다. 현재 세션을 닫은 뒤 다시 시도해 주세요.';
		if (normalized.includes('being completed') && normalized.includes('capture')) return 'Ego 가져오기가 진행 중입니다. 잠시 기다린 뒤 다시 시도해 주세요.';
		if (normalized.includes('native bound-checkout helper') || normalized.includes('trusted node runtime')) return '안전한 에이전트 실행에 필요한 로컬 도구를 사용할 수 없습니다. 설치 상태를 확인해 주세요.';
		if (normalized.includes('provider did not return') || normalized.includes('provider returned an empty')) return '에이전트가 결과를 반환하지 않았습니다. 실행 기록을 확인하고 다시 시도해 주세요.';
		if (normalized.includes('this notion token was rejected') || normalized.includes('reconnect with a new personal access token')) return 'Notion 토큰이 거부되었습니다. 만료되었거나 폐기되었을 수 있으니 새 개인 액세스 토큰으로 다시 연결해 주세요.';
		if (normalized.includes('review and approve the exact connector package')) return '설치 전에 검토한 패키지의 설치를 승인해 주세요.';
		if (normalized.includes('connector source and selected resource id are required')) return '자료 출처와 원격 자료 ID를 입력해 주세요.';
		if (normalized.includes('valid project id is required')) return '프로젝트 정보가 유효하지 않습니다. 프로젝트를 다시 열어 주세요.';
		if (/permission denied|not authorized|access denied/.test(normalized)) return '접근 권한이 없습니다. 계정과 폴더 권한을 확인해 주세요.';
		if (/not found|does not exist|no longer exists/.test(normalized)) return '요청한 항목을 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.';
		if (/keychain/.test(normalized)) return 'macOS 키체인 작업을 완료하지 못했습니다. 계정 연결 상태를 확인해 주세요.';
		if (/network|fetch failed|timed? out|econn/.test(normalized)) return '연결이 원활하지 않습니다. 네트워크를 확인하고 다시 시도해 주세요.';
		return `${fallback} 자세한 내용은 오류 로그를 확인해 주세요.`;
	}

	private renderCreateForm(shell: HTMLElement): void {
		if (!this.createFormOpen && !this.createTaskTitleDraft && !this.createTaskDescriptionDraft) return;
		const details = shell.appendChild(createElement('details', 'project-dashboard__form'));
		details.open = this.createFormOpen;
		details.addEventListener('toggle', () => {
			this.createFormOpen = details.open;
			if (!details.open && !this.createTaskTitleDraft && !this.createTaskDescriptionDraft) this.render();
		});
		const summary = details.appendChild(createElement('summary')); summary.textContent = '작업 만들기';
		const form = details.appendChild(createElement('form', 'project-dashboard__form-content'));
		const heading = form.appendChild($('h2')); heading.textContent = '새 작업';
		const titleLabel = form.appendChild(createElement('label')); titleLabel.htmlFor = 'project-task-title'; titleLabel.textContent = '작업 제목';
		const title = form.appendChild(createElement('input')); title.id = 'project-task-title'; title.type = 'text'; title.maxLength = 160; title.required = true; title.placeholder = '무엇을 해야 하나요?'; title.value = this.createTaskTitleDraft;
		title.dataset.focusKey = 'create-task-title';
		title.addEventListener('input', () => { this.createTaskTitleDraft = title.value; if (title.value.trim()) title.removeAttribute('aria-invalid'); });
		const descriptionLabel = form.appendChild(createElement('label')); descriptionLabel.htmlFor = 'project-task-description'; descriptionLabel.textContent = '설명 (선택)';
		const description = form.appendChild(createElement('textarea')); description.id = 'project-task-description'; description.rows = 3; description.maxLength = 2000; description.placeholder = '작업에 필요한 내용을 덧붙이세요'; description.value = this.createTaskDescriptionDraft;
		description.dataset.focusKey = 'create-task-description';
		description.addEventListener('input', () => { this.createTaskDescriptionDraft = description.value; });
		const actions = form.appendChild($('.project-dashboard__form-actions'));
		const submit = actions.appendChild(createElement('button', 'project-dashboard__primary')); submit.type = 'submit'; submit.textContent = '작업 만들기'; submit.disabled = this.creating;
		submit.dataset.focusKey = 'create-task-submit';
		form.addEventListener('submit', event => { event.preventDefault(); void this.createTask(title, description, submit); });
	}

	layout(dimension: Dimension): void {
		if (this.root) { this.root.style.width = `${dimension.width}px`; this.root.style.height = `${dimension.height}px`; }
	}
	override clearInput(): void { this.inputActive = false; this.closeReferenceViewer(false); void this.flushDashboardState(); this.stopPolling(); this.clearWebsitePreview(); this.clearPackagePreview(); this.selectedTaskId = undefined; this.preview = undefined; this.attempts = []; this.subagentTaskId = undefined; this.subagentParentAttemptId = undefined; this.subagentPreview = undefined; this.subagentScopeDraft = ''; this.subagentFormOpen = false; this.expandedSubagentRootId = undefined; this.subagentEvents = {}; this.subagentError = undefined; this.subagentEventsError = undefined; if (this.root) clearNode(this.root); super.clearInput(); }
	override dispose(): void {
		this.inputActive = false;
		void this.closeEgoCapture();
		this.clearWebsitePreview();
		this.clearPackagePreview();
		if (this.stateSaveTimer) clearTimeout(this.stateSaveTimer);
		this.stateSaveTimer = undefined;
		void this.flushDashboardState();
		this.root?.removeEventListener('scroll', this.persistScrollPosition);
		this.stopPolling(); document.removeEventListener('visibilitychange', this.refreshOnReturn); window.removeEventListener('focus', this.refreshOnReturn); super.dispose();
	}
}
