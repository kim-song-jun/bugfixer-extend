import { $, type Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ipcRenderer } from '../../../../../base/parts/sandbox/electron-browser/globals.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../../workbench/browser/editor.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { INativeWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/electron-browser/environmentService.js';
import type { IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { EditorsOrder } from '../../../../../workbench/common/editor.js';
import type { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import type { IEditorOpenContext, IEditorPane, ITextDiffEditorPane } from '../../../../../workbench/common/editor.js';
import { EditorExtensions, type IEditorFactoryRegistry } from '../../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IWorkbenchLayoutService, Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { ViewContainerLocation } from '../../../../../workbench/common/views.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { localize2 } from '../../../../../nls.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import type { AgentSessionDTO, AgentSessionPermissionPolicy, AgentSessionTranscriptPageDTO, AgentSessionTranscriptPageOptions, AgentSessionTurnDTO, CreateAgentSessionInput, SessionNotificationDTO, SessionPageOptions, WorkspaceAgentSessionWorkspacePreparationDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import type { WorkspaceAgentSessionMailboxItemRequest, WorkspaceAgentSessionMailboxMessage, WorkspaceAgentSessionMailboxPage, WorkspaceAgentSessionNotificationStatus } from '../../../../../workspace/common/workspaceAgentCommunicationProtocol.js';
import type { WorkspaceAgentSetupInspectionDTO } from '../../../../../workspace/common/workspaceAgentSetupProtocol.js';
import type { AgentWorkflowApprovalResult, AgentWorkflowPageDTO, AgentWorkflowPlanInput, AgentWorkflowStatusDTO, CreateAgentWorkflowInput } from '../../../../../workspace/common/workspaceAgentWorkflowProtocol.js';
import type { WorkspaceAgentChangeEvidenceDTO, WorkspaceAgentChangeEvidencePageDTO, WorkspaceAgentChangeFileDTO, WorkspaceAgentChangeHunksDTO, WorkspaceAgentExplanationDTO, WorkspaceAgentExplanationPageDTO } from '../../../../../workspace/common/workspaceAgentChangesProtocol.js';
import type { AgentSessionIntegrationProposalDTO, WorkspaceAgentCommitPrepareInput, WorkspaceAgentCommitProposalInput, WorkspaceAgentCommitRecoveryInput } from '../../../../../workspace/common/workspaceAgentIntegrationProtocol.js';
import type { AgentSessionMergeProposalDTO, WorkspaceAgentMergePrepareInput, WorkspaceAgentMergeProposalMutationInput, WorkspaceAgentMergeProposalPageDTO, WorkspaceAgentMergeProposalRecoveryInput } from '../../../../../workspace/common/workspaceAgentMergeProtocol.js';
import type { AgentSessionPublicationOperationDTO, AgentSessionPublicationPageDTO, AgentSessionPublicationProposalDTO, WorkspaceAgentPublicationAccountsDTO, WorkspaceAgentPublicationExecutionDTO, WorkspaceAgentPublicationMutationInput, WorkspaceAgentPublicationPageInput, WorkspaceAgentPublicationRecoveryInput, WorkspaceAgentPublicationScope, WorkspaceAgentPublicationTextPrepareInput } from '../../../../../workspace/common/workspaceAgentPublicationProtocol.js';
import type { IWorkspaceAgentPrTextService } from '../../../../../workspace/common/workspaceAgentPrTextHostProtocol.js';
import { WORKSPACE_KNOWLEDGE_CHANNEL } from '../../../../../workspace/common/workspaceKnowledgeProtocol.js';
import type { WorkspaceKnowledgeDTO } from '../../../../../workspace/common/workspaceKnowledgeProtocol.js';
import { WORKSPACE_AGENT_SESSIONS_CHANNEL } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import type { WorkspaceDashboardDTO, WorkspaceDashboardTaskItemDTO } from '../../../../../workspace/common/workspaceDashboardProtocol.js';
import { WORKSPACE_DASHBOARD_CHANNEL } from '../../../../../workspace/common/workspaceDashboardProtocol.js';
import { restoreSessionSelection, persistSessionSelection } from '../../features/sessionSelection/index.js';
import { renderSessionList } from '../../widgets/sessionList/index.js';
import { renderSessionDetail } from '../../widgets/sessionDetail/index.js';
import { createSessionLogs, type SessionLogsController, type SessionLogsContext, type SessionLogsPageLoader } from '../../widgets/sessionLogs/index.js';
import { createSessionNotifications, type SessionNotificationsActions, type SessionNotificationsController } from '../../widgets/sessionNotifications/index.js';
import { createSessionOnboarding, type SessionOnboardingActions, type SessionOnboardingContext, type SessionOnboardingController, type SessionOnboardingPreview } from '../../widgets/sessionOnboarding/index.js';
import { createSessionMessages, type SessionMessagesActions, type SessionMessagesController } from '../../widgets/sessionMessages/index.js';
import { createSessionWorkflow, type SessionWorkflowActions, type SessionWorkflowController } from '../../widgets/sessionWorkflow/index.js';
import { createSessionChanges, type SessionChangesActions, type SessionChangesContext, type SessionChangesController } from '../../widgets/sessionChanges/index.js';
import { agentSessionTurnStateLabel } from '../../entities/agentSession/index.js';
import type { AgentSessionViewTab } from '../../features/sessionViewTabs/index.js';
import { SessionTerminalController } from '../../shared/sessionTerminal/index.js';
import { AgentSessionWorkspaceEditorInput } from './sessionWorkspaceEditorInput.js';
import { AgentSessionWorkspaceEditorSerializer } from './sessionWorkspaceEditorSerializer.js';
import './sessionWorkspace.css';

interface LaunchPreview {
	readonly ticketId: string;
	readonly expiresAt: string;
	readonly snapshot: AgentSessionTurnDTO['snapshot'];
}

interface CreateDraft {
	readonly name: string;
	readonly taskId: string;
	readonly provider: 'codex' | 'claude';
	readonly model: string;
	readonly permissionMode: AgentSessionPermissionPolicy['mode'];
}

const SESSION_STORAGE_TAB = 'devfast.aiSessions.view';
const SESSION_STORAGE_LOG_TURN = 'devfast.aiSessions.logTurn';

interface PendingNotificationMessage {
	readonly sessionId: string;
	readonly messageId: string;
}

interface OwnedSessionChangeDiff {
	readonly input: EditorInput;
	readonly original: import('../../../../../editor/common/model.js').ITextModel;
	readonly modified: import('../../../../../editor/common/model.js').ITextModel;
	dispose(): void;
}

const sessionChangeDiffOwners = new WeakMap<IEditorService, OwnedSessionChangeDiff>();
const sessionChangeDiffQueues = new WeakMap<IEditorService, Promise<void>>();

async function withSessionChangeDiffQueue<T>(service: IEditorService, operation: () => Promise<T>): Promise<T> {
	const previous = sessionChangeDiffQueues.get(service) ?? Promise.resolve();
	let release!: () => void;
	const reservation = new Promise<void>(resolve => { release = resolve; });
	const queued = previous.then(() => reservation);
	sessionChangeDiffQueues.set(service, queued);
	await previous;
	try { return await operation(); }
	finally {
		release();
		if (sessionChangeDiffQueues.get(service) === queued) { sessionChangeDiffQueues.delete(service); }
	}
}

export class AgentSessionWorkspaceEditorPane extends EditorPane {
	static readonly ID = AgentSessionWorkspaceEditorInput.EDITOR_ID;
	private root: HTMLElement | undefined;
	private projectId: string | undefined;
	private dashboard: WorkspaceDashboardDTO | undefined;
	private sessions: readonly AgentSessionDTO[] = [];
	private turns = new Map<string, readonly AgentSessionTurnDTO[]>();
	private readonly workspacePreparations = new Map<string, WorkspaceAgentSessionWorkspacePreparationDTO>();
	private selectedSessionId: string | undefined;
	private activeTab: AgentSessionViewTab = 'terminal';
	private loading = false;
	private error: string | undefined;
	private notice: string | undefined;
	private creating = false;
	private createFormFocusPending = false;
	private preview: LaunchPreview | undefined;
	private previewSessionId: string | undefined;
	private readonly sessionPermissionModes = new Map<string, AgentSessionPermissionPolicy['mode']>();
	private createPermissionMode: AgentSessionPermissionPolicy['mode'] = 'read-only';
	private operation = false;
	private editorVisible = true;
	private resizeListener: (() => void) | undefined;
	private lifecycleTimer: ReturnType<typeof setInterval> | undefined;
	private sessionListScrollTop = 0;
	private terminalController: SessionTerminalController | undefined;
	private readonly terminalService: ITerminalService;
	private logsPanel: HTMLElement | undefined;
	private logsTurnSelect: HTMLSelectElement | undefined;
	private logsTurnSelectSessionId: string | undefined;
	private logsTurnSelectOptionsKey = '';
	private logsLoadingMessage: HTMLElement | undefined;
	private logsWidgetMount: HTMLElement | undefined;
	private sessionLogs: SessionLogsController | undefined;
	private sessionLogsContextKey: string | undefined;
	private sessionMessagesPanel: HTMLElement | undefined;
	private sessionMessagesMount: HTMLElement | undefined;
	private sessionMessages: SessionMessagesController | undefined;
	private sessionWorkflowPanel: HTMLElement | undefined;
	private sessionWorkflowMount: HTMLElement | undefined;
	private sessionWorkflow: SessionWorkflowController | undefined;
	private sessionChangesPanel: HTMLElement | undefined;
	private sessionChangesMount: HTMLElement | undefined;
	private sessionChangesTurnSelectMount: HTMLElement | undefined;
	private sessionChangesWidgetMount: HTMLElement | undefined;
	private sessionChangesController: SessionChangesController | undefined;
	private sessionChangesContextKey: string | undefined;
	private readonly selectedChangeTurns = new Map<string, string>();
	private notificationsMount: HTMLElement | undefined;
	private sessionNotifications: SessionNotificationsController | undefined;
	private pendingNotificationMessage: PendingNotificationMessage | undefined;
	private notificationNavigationGeneration = 0;
	private onboardingMount: HTMLElement | undefined;
	private sessionOnboarding: SessionOnboardingController | undefined;
	private onboardingProjectId: string | undefined;
	private onboardingOpen: boolean | undefined;
	private onboardingFocusTogglePending = false;
	private setupInspection: WorkspaceAgentSetupInspectionDTO | undefined;
	private setupInspectionLoading = false;
	private setupInspectionError = false;
	private setupInspectionGeneration = 0;
	private setupInspectionDisposed = false;
	private onboardingCreateProvider: AgentSessionDTO['provider'] | undefined;
	private onboardingCreateTaskId: string | undefined;

	constructor(group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@ITerminalService terminalService: ITerminalService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
		@INativeWorkbenchEnvironmentService private readonly environment: INativeWorkbenchEnvironmentService) {
		super(AgentSessionWorkspaceEditorPane.ID, group, telemetryService, themeService, storageService);
		this.terminalService = terminalService;
		this._register(toDisposable(() => this.terminalController?.dispose()));
		this._register(toDisposable(() => this.sessionLogs?.dispose()));
		this._register(toDisposable(() => this.sessionMessages?.dispose()));
		this._register(toDisposable(() => this.sessionWorkflow?.dispose()));
		this._register(toDisposable(() => this.sessionChangesController?.dispose()));
		this._register(toDisposable(() => this.sessionNotifications?.dispose()));
		this._register(toDisposable(() => { this.setupInspectionDisposed = true; this.setupInspectionGeneration++; this.sessionOnboarding?.dispose(); }));
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = $('.ai-session-workspace');
		this.root.tabIndex = -1;
		parent.appendChild(this.root);
		this.resizeListener = () => this.terminalController?.layout();
		window.addEventListener('resize', this.resizeListener);
		this._register(toDisposable(() => { if (this.resizeListener) window.removeEventListener('resize', this.resizeListener); }));
	}

	protected override setEditorVisible(visible: boolean): void {
		this.editorVisible = visible;
		if (!visible) { this.terminalController?.hide(); this.sessionLogs?.setVisible(false); this.sessionMessages?.setVisible(false); this.sessionWorkflow?.setVisible(false); this.sessionChangesController?.setVisible(false); this.sessionNotifications?.setVisible(false); this.sessionOnboarding?.setVisible(false); }
		else this.render();
		this.updateLifecyclePolling();
	}

	override async setInput(input: AgentSessionWorkspaceEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this.notificationNavigationGeneration++;
		await super.setInput(input, options, context, token);
		if (this.environment.reviewWindowLaunch.kind !== 'project' || this.environment.reviewWindowLaunch.projectId !== input.projectId) {
			this.error = '현재 프로젝트 창과 세션 편집기의 프로젝트가 일치하지 않습니다.';
			this.render();
			return;
		}
		if (this.projectId !== input.projectId) {
			this.setupInspectionGeneration++;
			this.setupInspection = undefined;
			this.setupInspectionLoading = false;
			this.setupInspectionError = false;
			this.onboardingOpen = undefined;
			this.onboardingCreateProvider = undefined;
			this.onboardingCreateTaskId = undefined;
			this.terminalController?.dispose();
			this.sessionLogs?.invalidateContext();
			this.sessionMessages?.setVisible(false);
			this.sessionWorkflow?.setVisible(false);
			this.sessionChangesController?.setVisible(false);
			this.sessionNotifications?.setVisible(false);
			this.projectId = input.projectId;
			this.dashboard = undefined;
			this.sessions = [];
			this.pendingNotificationMessage = undefined;
			this.sessionPermissionModes.clear();
			this.createPermissionMode = 'read-only';
			this.sessionListScrollTop = 0;
			this.creating = false;
			this.preview = undefined;
			this.previewSessionId = undefined;
			this.error = undefined;
			this.notice = undefined;
			this.terminalController = new SessionTerminalController(input.projectId, this.terminalService, message => this.showError(message));
			this.selectedSessionId = undefined;
			this.turns.clear();
			this.workspacePreparations.clear();
			this.loadTabPreference();
		}
		await this.load();
	}

	private loadTabPreference(): void {
		const tab = localStorage.getItem(`${SESSION_STORAGE_TAB}.${this.projectId}`);
		if (tab === 'terminal' || tab === 'changes' || tab === 'logs' || tab === 'messages' || tab === 'workflow') this.activeTab = tab;
	}

	private async load(): Promise<void> {
		if (!this.projectId) return;
		this.loading = true; this.error = undefined; this.render();
		try {
			const [dashboard, sessions] = await Promise.all([
				ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'getDashboard', this.projectId) as Promise<WorkspaceDashboardDTO>,
				ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listSessions', { projectId: this.projectId }) as Promise<readonly AgentSessionDTO[]>,
			]);
			this.dashboard = dashboard;
			this.sessions = sessions;
			const available = new Set(sessions.map(session => session.id));
			if (!this.selectedSessionId || !available.has(this.selectedSessionId)) {
				this.selectedSessionId = restoreSessionSelection(this.projectId, available) ?? sessions[0]?.id;
			}
			if (this.selectedSessionId) {
				persistSessionSelection(this.projectId, this.selectedSessionId);
				await Promise.all([this.loadTurns(this.selectedSessionId), this.loadWorkspacePreparation(this.selectedSessionId)]);
			}
			this.notice = undefined;
		} catch (error) {
			this.error = this.errorMessage(error, 'AI 세션을 불러오지 못했습니다.');
		} finally { this.loading = false; this.render(); }
	}

	private async loadTurns(sessionId: string, isCurrent: () => boolean = () => true): Promise<void> {
		if (!this.projectId) return;
		const projectId = this.projectId;
		const turns = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listTurns', { projectId, sessionId }) as readonly AgentSessionTurnDTO[];
		if (isCurrent() && this.projectId === projectId && this.sessions.some(session => session.id === sessionId && session.projectId === projectId)) { this.turns.set(sessionId, turns); }
	}

	private async loadWorkspacePreparation(sessionId: string): Promise<void> {
		if (!this.projectId) return;
		const status = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'workspacePreparation', { projectId: this.projectId, sessionId }) as WorkspaceAgentSessionWorkspacePreparationDTO;
		if (status.projectId !== this.projectId || status.sessionId !== sessionId) { throw new Error('작업공간 상태가 현재 프로젝트 세션과 일치하지 않습니다.'); }
		this.workspacePreparations.set(sessionId, status);
	}

	private selectSession(sessionId: string): void {
		if (sessionId === this.selectedSessionId || !this.projectId) return;
		this.notificationNavigationGeneration++;
		if (this.pendingNotificationMessage?.sessionId !== sessionId) { this.pendingNotificationMessage = undefined; }
		if (this.previewSessionId !== sessionId) { this.preview = undefined; this.previewSessionId = undefined; }
		this.terminalController?.hide();
		this.sessionLogs?.invalidateContext();
		this.sessionMessages?.setVisible(false);
		this.sessionWorkflow?.setVisible(false);
		this.selectedSessionId = sessionId;
		persistSessionSelection(this.projectId, sessionId);
		this.notice = undefined;
		this.render();
		requestAnimationFrame(() => {
			const row = this.root?.querySelector<HTMLElement>('.ai-session__session-row[aria-current="true"]');
			const selected = row && row.getClientRects().length > 0
				? row
				: this.root?.querySelector<HTMLElement>('.ai-session__narrow-selector select');
			selected?.focus({ preventScroll: true });
		});
		void Promise.all([this.loadTurns(sessionId), this.loadWorkspacePreparation(sessionId)]).then(() => this.render()).catch(error => this.showError(this.errorMessage(error, '세션 정보를 불러오지 못했습니다.')));
	}

	private async createSession(draft: CreateDraft): Promise<void> {
		if (!this.projectId || !this.dashboard || this.operation) return;
		const task = this.dashboard.tasks.find(candidate => candidate.id === draft.taskId && !candidate.archivedAt && !candidate.trashedAt && !candidate.deletionPendingAt);
		if (!task) { this.showError('선택한 작업이 더 이상 사용할 수 없습니다.'); return; }
		this.operation = true; this.error = undefined; this.render();
		let createdSessionId: string | undefined;
		try {
			const input: CreateAgentSessionInput = {
				projectId: this.projectId, bindingId: task.bindingId, taskId: task.id,
				name: draft.name.trim(), provider: draft.provider, model: draft.model.trim(), profileRef: 'local-primary',
				workspaceMode: this.dashboard.folder.vcsKind === 'git' ? 'gitWorktree' : 'sharedFolder',
			};
			const session = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'createSession', input) as AgentSessionDTO;
			this.sessions = [session, ...this.sessions];
			this.selectedSessionId = session.id;
			createdSessionId = session.id;
			this.sessionPermissionModes.set(session.id, draft.permissionMode);
			persistSessionSelection(this.projectId, session.id);
			this.creating = false;
			this.onboardingCreateProvider = undefined;
			this.onboardingCreateTaskId = undefined;
		} catch (error) { this.error = this.errorMessage(error, '세션을 만들지 못했습니다.'); }
		finally { this.operation = false; this.render(); }
		if (createdSessionId) {
			try { await this.loadWorkspacePreparation(createdSessionId); }
			catch (error) { this.error = this.errorMessage(error, '작업공간 상태를 확인하지 못했습니다.'); this.render(); return; }
			if (this.workspacePreparations.get(createdSessionId)?.state === 'ready') { await this.prepareLaunch(createdSessionId); }
			else { this.notice = '세션은 저장했습니다. 작업공간 상태를 확인한 뒤 같은 세션에서 다시 준비할 수 있습니다.'; this.render(); }
		}
	}

	private async prepareLaunch(sessionId = this.selectedSessionId): Promise<void> {
		if (!this.projectId || !sessionId || this.operation) return;
		this.operation = true; this.error = undefined; this.preview = undefined; this.previewSessionId = undefined; this.render();
		try {
			await this.loadWorkspacePreparation(sessionId);
			const workspace = this.workspacePreparations.get(sessionId);
			if (workspace?.state !== 'ready') {
				this.error = workspace?.reason ?? '작업공간 준비가 완료되지 않았습니다. 상태를 확인하고 다시 준비해 주세요.';
				return;
			}
			const permissionMode = this.sessionPermissionModes.get(sessionId) ?? 'read-only';
			const permissionPolicy: AgentSessionPermissionPolicy = permissionMode === 'read-only'
				? { mode: 'read-only', approval: 'never' }
				: { mode: 'mutating', approval: 'on-request' };
			this.preview = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'preview', { projectId: this.projectId, sessionId, permissionPolicy }) as LaunchPreview;
			this.previewSessionId = sessionId;
			this.notice = '실행 전에 작업 폴더와 권한 범위를 확인해 주세요.';
			requestAnimationFrame(() => this.root?.querySelector<HTMLButtonElement>('#ai-session-preview-start')?.focus({ preventScroll: true }));
		} catch (error) { this.error = this.errorMessage(error, '실행 미리보기를 만들지 못했습니다.'); }
		finally { this.operation = false; this.render(); }
	}

	private async retryWorkspacePreparation(sessionId: string): Promise<void> {
		if (!this.projectId || sessionId !== this.selectedSessionId || this.operation) return;
		this.operation = true; this.error = undefined; this.notice = undefined; this.render();
		try {
			const status = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'prepareWorkspace', { projectId: this.projectId, sessionId }) as WorkspaceAgentSessionWorkspacePreparationDTO;
			if (status.projectId !== this.projectId || status.sessionId !== sessionId) { throw new Error('작업공간 준비 결과가 현재 프로젝트 세션과 일치하지 않습니다.'); }
			this.workspacePreparations.set(sessionId, status);
			if (status.state === 'ready') { this.notice = '기존 세션의 작업공간을 확인했습니다. 실행 범위를 검토해 주세요.'; }
			else { this.error = status.reason ?? (status.state === 'recoveryRequired' ? '보존된 작업공간에 복구가 필요합니다.' : '작업공간을 아직 준비하지 못했습니다.'); }
		} catch (error) { this.error = this.errorMessage(error, '작업공간을 준비하지 못했습니다.'); }
		finally { this.operation = false; this.render(); }
	}

	private async startPreviewedTurn(): Promise<void> {
		if (!this.projectId || !this.preview || !this.previewSessionId || this.operation) return;
		const projectId = this.projectId;
		const sessionId = this.previewSessionId;
		const preview = this.preview;
		this.operation = true; this.render();
		try {
			const turn = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'start', { projectId, sessionId, ticketId: preview.ticketId }) as AgentSessionTurnDTO;
			if (this.projectId !== projectId || this.previewSessionId !== sessionId) { return; }
			this.preview = undefined; this.previewSessionId = undefined;
			await this.loadTurns(turn.sessionId);
			this.sessions = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listSessions', { projectId: this.projectId }) as readonly AgentSessionDTO[];
			this.notice = turn.state === 'running' || turn.state === 'starting'
				? '새 실행을 시작했습니다.'
				: turn.state === 'exited' ? `실행이 종료되었습니다${turn.exitCode === null ? '.' : ` · 종료 코드 ${turn.exitCode}.`}`
				: `실행 상태 · ${turn.state}`;
		} catch (error) { this.error = this.errorMessage(error, '세션 실행을 시작하지 못했습니다.'); }
		finally { this.operation = false; this.render(); }
	}

	private async stopTurn(expectedSessionId?: string, expectedTurnId?: string): Promise<void> {
		const projectId = this.projectId;
		const sessionId = this.selectedSessionId;
		const turn = sessionId ? this.latestTurn(sessionId) : undefined;
		if (!projectId || !sessionId || !turn || this.operation) return;
		if (expectedSessionId !== undefined && (sessionId !== expectedSessionId || turn.id !== expectedTurnId || turn.projectId !== projectId || turn.sessionId !== sessionId || turn.snapshot.projectId !== projectId || turn.snapshot.sessionId !== sessionId)) { return; }
		this.operation = true; this.error = undefined; this.render();
		try {
			const stopped = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'stop', { projectId, sessionId, turnId: turn.id }) as AgentSessionTurnDTO;
			if (this.projectId !== projectId || stopped.projectId !== projectId || stopped.sessionId !== sessionId || stopped.id !== turn.id) { return; }
			await this.loadTurns(sessionId);
			if (this.projectId !== projectId) { return; }
			this.sessions = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listSessions', { projectId: this.projectId }) as readonly AgentSessionDTO[];
			this.terminalController?.finish(sessionId, stopped.id, stopped.exitCode ?? undefined);
			this.notice = '실행 중단을 요청했습니다.';
		} catch (error) { this.error = this.errorMessage(error, '실행을 중단하지 못했습니다.'); }
		finally { this.operation = false; this.render(); }
	}

	private latestTurn(sessionId: string): AgentSessionTurnDTO | undefined { return this.turns.get(sessionId)?.at(-1); }

	private async inspectSetup(provider: AgentSessionDTO['provider']): Promise<void> {
		const projectId = this.projectId;
		if (!projectId || this.setupInspectionLoading || this.setupInspectionDisposed) { return; }
		const generation = ++this.setupInspectionGeneration;
		this.setupInspection = undefined;
		this.setupInspectionLoading = true;
		this.setupInspectionError = false;
		this.render();
		try {
			const result = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'inspectSetup', { projectId, provider }) as WorkspaceAgentSetupInspectionDTO;
			if (this.setupInspectionDisposed || generation !== this.setupInspectionGeneration || this.projectId !== projectId) { return; }
			if (result.projectId !== projectId || result.provider !== provider) { throw new Error('setup scope mismatch'); }
			this.setupInspection = result;
		} catch {
			if (this.setupInspectionDisposed || generation !== this.setupInspectionGeneration || this.projectId !== projectId) { return; }
			this.setupInspectionError = true;
		} finally {
			if (!this.setupInspectionDisposed && generation === this.setupInspectionGeneration && this.projectId === projectId) {
				this.setupInspectionLoading = false;
				this.render();
			}
		}
	}

	private updateOnboardingMount(): HTMLElement {
		if (!this.projectId || !this.dashboard) { throw new Error('Onboarding requires a loaded project dashboard.'); }
		if (!this.onboardingMount) {
			this.onboardingMount = document.createElement('section');
			this.onboardingMount.className = 'ai-session__onboarding-mount';
		}
		const actions: SessionOnboardingActions = {
			inspect: provider => { void this.inspectSetup(provider); },
			openCreate: (provider, taskId) => {
				if (!this.availableTasks().some(task => task.id === taskId)) { return; }
				this.onboardingCreateProvider = provider;
				this.onboardingCreateTaskId = taskId;
				this.creating = true;
				this.createFormFocusPending = true;
				this.createPermissionMode = 'read-only';
				this.preview = undefined;
				this.render();
			},
			selectSession: sessionId => {
				if (!this.sessions.some(session => session.projectId === this.projectId && session.id === sessionId)) { return; }
				this.selectSession(sessionId);
			},
			openPreview: sessionId => {
				if (!this.sessions.some(session => session.projectId === this.projectId && session.id === sessionId)) { return; }
				if (this.selectedSessionId !== sessionId) { this.selectSession(sessionId); }
				void this.prepareLaunch(sessionId);
			},
			openTab: (sessionId, tab) => {
				if (!this.sessions.some(session => session.projectId === this.projectId && session.id === sessionId)) { return; }
				this.notificationNavigationGeneration++;
				this.activeTab = tab;
				localStorage.setItem(`${SESSION_STORAGE_TAB}.${this.projectId}`, tab);
				if (this.selectedSessionId !== sessionId) { this.selectSession(sessionId); }
				else { this.render(); }
				requestAnimationFrame(() => this.root?.querySelector<HTMLElement>(`#ai-session-tab-${tab}`)?.focus({ preventScroll: true }));
			},
			stopExact: (sessionId, turnId) => { void this.stopExactTurn(sessionId, turnId); },
			openProviderGuide: provider => {
				const url = provider === 'codex' ? 'https://developers.openai.com/codex/quickstart' : 'https://code.claude.com/docs/en/quickstart';
				void this.openerService.open(url, { openExternal: true }).then(opened => {
					if (!opened) { this.showError('공식 CLI 안내 페이지를 열지 못했습니다. 다시 시도해 주세요.'); }
				}).catch(() => this.showError('공식 CLI 안내 페이지를 열지 못했습니다. 다시 시도해 주세요.'));
			},
			copyText: text => this.clipboardService.writeText(text),
		};
		const selected = this.sessions.find(session => session.id === this.selectedSessionId && session.projectId === this.projectId);
		const selectedTurn = selected ? this.latestTurn(selected.id) : undefined;
		const exactTurn = selectedTurn?.projectId === this.projectId && selectedTurn.sessionId === selected?.id
			&& selectedTurn.snapshot.projectId === this.projectId && selectedTurn.snapshot.sessionId === selected?.id ? selectedTurn : undefined;
		const candidatePreview = this.preview && selected && this.previewSessionId === selected.id ? this.preview : undefined;
		const exactPreview = candidatePreview?.snapshot.projectId === this.projectId
			&& candidatePreview.snapshot.sessionId === selected?.id
			&& candidatePreview.snapshot.bindingId === selected?.bindingId
			? candidatePreview as SessionOnboardingPreview : undefined;
		const context: SessionOnboardingContext = {
			project: { id: this.projectId, name: this.dashboard.project.name, path: this.dashboard.folder.path, bindingLabel: this.dashboard.folder.path },
			tasks: this.availableTasks().map(task => ({ id: task.id, title: task.title })),
			sessions: this.sessions.filter(session => session.projectId === this.projectId),
			selectedSessionId: selected?.id,
			selectedTurn: exactTurn,
			preview: exactPreview,
			inspection: this.setupInspection?.projectId === this.projectId ? this.setupInspection : undefined,
			inspectionLoading: this.setupInspectionLoading,
			inspectionError: this.setupInspectionError ? 'failed' : undefined,
		};
		if (!this.sessionOnboarding) {
			this.sessionOnboarding = createSessionOnboarding(this.onboardingMount, context, actions, this.storageService, status => {
				if (status !== 'skipped' && status !== 'completed') { return; }
				this.onboardingOpen = false;
				this.onboardingFocusTogglePending = true;
				this.sessionOnboarding?.setVisible(false);
				this.render();
			});
			this.onboardingProjectId = this.projectId;
			this.onboardingOpen = this.onboardingOpen ?? this.sessionOnboarding.getState().status === 'active';
		} else {
			this.sessionOnboarding.setContext(context, actions);
			if (this.onboardingProjectId !== this.projectId || this.onboardingOpen === undefined) {
				this.onboardingProjectId = this.projectId;
				this.onboardingOpen = this.sessionOnboarding.getState().status === 'active';
			}
		}
		this.sessionOnboarding.setVisible(this.onboardingOpen === true);
		return this.onboardingMount;
	}

	private createOnboardingToggle(): HTMLButtonElement {
		const state = this.sessionOnboarding?.getState();
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'ai-session__secondary ai-session__onboarding-toggle';
		button.dataset.onboardingToggle = 'true';
		button.textContent = this.onboardingOpen ? '안내 닫기' : state?.status === 'completed' ? '안내 다시 열기' : state?.status === 'skipped' ? '이어서 안내 보기' : '시작 안내 보기';
		button.setAttribute('aria-expanded', String(this.onboardingOpen === true));
		button.addEventListener('click', () => {
			this.onboardingOpen = !this.onboardingOpen;
			if (this.onboardingOpen) { this.sessionOnboarding?.reopen(); }
			this.sessionOnboarding?.setVisible(this.onboardingOpen);
			this.render();
		});
		return button;
	}

	public openOnboardingGuide(): void {
		this.onboardingOpen = true;
		this.sessionOnboarding?.reopen();
		this.sessionOnboarding?.setVisible(true);
		this.render();
	}

	public matchesProject(projectId: string): boolean {
		return this.projectId === projectId && this.environment.reviewWindowLaunch.kind === 'project' && this.environment.reviewWindowLaunch.projectId === projectId;
	}

	cancelNotificationNavigation(): void {
		this.notificationNavigationGeneration++;
	}

	private async stopExactTurn(sessionId: string, turnId: string): Promise<void> {
		const session = this.sessions.find(item => item.id === sessionId && item.projectId === this.projectId);
		const turn = session ? this.latestTurn(sessionId) : undefined;
		if (!session || this.selectedSessionId !== sessionId || !turn || turn.id !== turnId || turn.projectId !== this.projectId || turn.sessionId !== session.id || turn.snapshot.projectId !== this.projectId || turn.snapshot.sessionId !== session.id) {
			this.error = '선택한 세션의 현재 실행과 일치하지 않아 중단 요청을 보내지 않았습니다.';
			this.render();
			return;
		}
		await this.stopTurn(sessionId, turnId);
	}

	private getLogsPanel(): HTMLElement {
		if (this.logsPanel) { return this.logsPanel; }
		const panel = document.createElement('div');
		panel.className = 'ai-session__logs-panel';
		const selectorLabel = document.createElement('label');
		selectorLabel.className = 'ai-session__logs-turn-label';
		selectorLabel.textContent = '실행 기록';
		const selector = document.createElement('select');
		selector.setAttribute('aria-label', '로그를 볼 실행 선택');
		selector.addEventListener('change', () => {
			const sessionId = this.logsTurnSelectSessionId;
			const turnId = selector.value;
			if (!sessionId || !this.projectId || !turnId) { return; }
			localStorage.setItem(this.logsTurnStorageKey(sessionId), turnId);
			this.updateLogsPanel(sessionId);
		});
		selectorLabel.appendChild(selector);
		const empty = document.createElement('p');
		empty.className = 'ai-session__logs-empty';
		empty.setAttribute('role', 'status');
		const mount = document.createElement('div');
		mount.className = 'ai-session__logs-mount';
		panel.append(selectorLabel, empty, mount);
		this.logsPanel = panel;
		this.logsTurnSelect = selector;
		this.logsLoadingMessage = empty;
		this.logsWidgetMount = mount;
		return panel;
	}

	private logsTurnStorageKey(sessionId: string): string { return `${SESSION_STORAGE_LOG_TURN}.${this.projectId}.${sessionId}`; }

	private selectedLogsTurn(sessionId: string, turns: readonly AgentSessionTurnDTO[]): AgentSessionTurnDTO | undefined {
		if (!turns.length) { return undefined; }
		const savedTurnId = localStorage.getItem(this.logsTurnStorageKey(sessionId));
		return turns.find(turn => turn.id === savedTurnId) ?? turns.at(-1);
	}

	private updateLogsPanel(sessionId: string): HTMLElement {
		const panel = this.getLogsPanel();
		const selector = this.logsTurnSelect!;
		const empty = this.logsLoadingMessage!;
		const mount = this.logsWidgetMount!;
		const turns = this.turns.get(sessionId);
		this.logsTurnSelectSessionId = sessionId;
		if (!turns) {
			selector.hidden = true;
			empty.hidden = false;
			empty.textContent = '실행 목록을 불러오는 중입니다.';
			mount.hidden = true;
			this.sessionLogs?.setVisible(false);
			return panel;
		}
		if (turns.length === 0) {
			selector.hidden = true;
			empty.hidden = false;
			empty.textContent = '이 세션에는 아직 실행 기록이 없습니다.';
			mount.hidden = true;
			this.sessionLogs?.setVisible(false);
			return panel;
		}
		const selectedTurn = this.selectedLogsTurn(sessionId, turns)!;
		const optionsKey = `${sessionId}:${turns.map(turn => turn.id).join(',')}`;
		if (this.logsTurnSelectOptionsKey !== optionsKey) {
			this.logsTurnSelectOptionsKey = optionsKey;
			selector.replaceChildren();
			for (const turn of [...turns].reverse()) {
				const option = document.createElement('option');
				option.value = turn.id;
				option.textContent = `실행 ${turn.ordinal} · ${turn.state} · ${new Date(turn.createdAt).toLocaleString('ko-KR')}`;
				selector.appendChild(option);
			}
		}
		selector.value = selectedTurn.id;
		selector.hidden = turns.length < 2;
		empty.hidden = true;
		mount.hidden = false;
		const context: SessionLogsContext = { projectId: this.projectId!, sessionId, turnId: selectedTurn.id };
		const contextKey = JSON.stringify([context.projectId, context.sessionId, context.turnId]);
		const loadPage: SessionLogsPageLoader = (options: AgentSessionTranscriptPageOptions) => ipcRenderer.invoke(
			WORKSPACE_AGENT_SESSIONS_CHANNEL,
			'readTranscript',
			{ ...context, options },
		) as Promise<AgentSessionTranscriptPageDTO>;
		if (!this.sessionLogs) {
			this.sessionLogsContextKey = contextKey;
			this.sessionLogs = createSessionLogs(mount, context, {
				loadPage,
				copyText: text => this.clipboardService.writeText(text),
				exportText: (text, fileName, isCurrent) => this.exportLoadedTranscript(text, fileName, isCurrent),
			});
		} else if (this.sessionLogsContextKey !== contextKey) {
			this.sessionLogsContextKey = contextKey;
			this.sessionLogs.setContext(context, loadPage);
		}
		this.sessionLogs.setVisible(this.editorVisible && this.activeTab === 'logs');
		return panel;
	}

	private getMessagesPanel(): HTMLElement {
		if (this.sessionMessagesPanel) { return this.sessionMessagesPanel; }
		const panel = document.createElement('div');
		panel.className = 'ai-session__messages-panel';
		const mount = document.createElement('div');
		mount.className = 'ai-session__messages-mount';
		panel.appendChild(mount);
		this.sessionMessagesPanel = panel;
		this.sessionMessagesMount = mount;
		return panel;
	}

	private updateMessagesPanel(sessionId: string): HTMLElement {
		const panel = this.getMessagesPanel();
		const mount = this.sessionMessagesMount!;
		const projectId = this.projectId!;
		const loadPage: SessionMessagesActions['loadPage'] = (afterSequence, limit) => ipcRenderer.invoke(
			WORKSPACE_AGENT_SESSIONS_CHANNEL,
			'listMessages',
			{ projectId, sessionId, afterSequence, limit },
		) as Promise<WorkspaceAgentSessionMailboxPage>;
		const loadMessage: SessionMessagesActions['loadMessage'] = messageId => {
			const request: WorkspaceAgentSessionMailboxItemRequest = { projectId, sessionId, messageId };
			return ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'getMessage', request) as Promise<WorkspaceAgentSessionMailboxMessage | null>;
		};
		const actions: SessionMessagesActions = { loadPage, loadMessage, sessions: this.sessions };
		const targetMessageId = this.pendingNotificationMessage?.sessionId === sessionId ? this.pendingNotificationMessage.messageId : undefined;
		if (!this.sessionMessages) {
			this.sessionMessages = createSessionMessages(mount, projectId, sessionId, actions, targetMessageId);
		} else {
			this.sessionMessages.setContext(projectId, sessionId, actions, targetMessageId);
		}
		this.sessionMessages.setVisible(this.editorVisible && this.activeTab === 'messages');
		return panel;
	}

	private updateWorkflowPanel(session: AgentSessionDTO): HTMLElement {
		if (!this.sessionWorkflowPanel) {
			this.sessionWorkflowPanel = document.createElement('div');
			this.sessionWorkflowPanel.className = 'ai-session__workflow-panel';
			this.sessionWorkflowMount = document.createElement('div');
			this.sessionWorkflowMount.className = 'ai-session__workflow-mount';
			this.sessionWorkflowPanel.appendChild(this.sessionWorkflowMount);
		}
		const projectId = this.projectId!;
		const actions: SessionWorkflowActions = {
			listWorkflows: (afterId, limit) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listWorkflows', { projectId, afterId, limit }) as Promise<AgentWorkflowPageDTO>,
			getWorkflow: workflowId => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'getWorkflow', { projectId, workflowId }) as Promise<AgentWorkflowStatusDTO>,
			createWorkflow: (input: CreateAgentWorkflowInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'createWorkflow', input) as Promise<AgentWorkflowStatusDTO>,
			reviseWorkflow: (workflowId, expectedRevision, plan: AgentWorkflowPlanInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'reviseWorkflow', { projectId, workflowId, expectedRevision, plan }) as Promise<AgentWorkflowStatusDTO>,
			approveWorkflow: (workflowId, expectedRevision, planVersion, fingerprint, idempotencyKey) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'approveWorkflow', { projectId, workflowId, expectedRevision, planVersion, fingerprint, idempotencyKey }) as Promise<AgentWorkflowApprovalResult>,
			startWorkflow: (workflowId, expectedRevision, idempotencyKey) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'startWorkflow', { projectId, workflowId, expectedRevision, idempotencyKey }) as Promise<AgentWorkflowStatusDTO>,
			cancelWorkflow: (workflowId, expectedRevision, idempotencyKey) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'cancelWorkflow', { projectId, workflowId, expectedRevision, idempotencyKey }) as Promise<AgentWorkflowStatusDTO>,
			loadKnowledge: (requestedProjectId: string) => ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'getProjectKnowledge', requestedProjectId) as Promise<WorkspaceKnowledgeDTO>,
			loadSessions: async (requestedProjectId: string) => {
				const sessions = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listSessions', { projectId: requestedProjectId }) as readonly AgentSessionDTO[];
				if (this.projectId === requestedProjectId) { this.sessions = sessions; }
				return sessions;
			},
		};
		if (!this.sessionWorkflow) {
			this.sessionWorkflow = createSessionWorkflow(this.sessionWorkflowMount!, { projectId, session, sessions: this.sessions }, actions);
		} else {
			this.sessionWorkflow.setContext({ projectId, session, sessions: this.sessions }, actions);
		}
		this.sessionWorkflow.setVisible(this.editorVisible && this.activeTab === 'workflow');
		return this.sessionWorkflowPanel;
	}

	private updateChangesPanel(sessionId: string): HTMLElement {
		if (!this.sessionChangesPanel) {
			this.sessionChangesPanel = document.createElement('div');
			this.sessionChangesPanel.className = 'ai-session__changes-panel';
			this.sessionChangesMount = document.createElement('div');
			this.sessionChangesMount.className = 'ai-session__changes-mount';
			this.sessionChangesTurnSelectMount = document.createElement('div');
			this.sessionChangesTurnSelectMount.className = 'ai-session-changes__turn-select-mount';
			this.sessionChangesWidgetMount = document.createElement('div');
			this.sessionChangesWidgetMount.className = 'ai-session-changes__widget';
			this.sessionChangesMount.append(this.sessionChangesTurnSelectMount, this.sessionChangesWidgetMount);
			this.sessionChangesPanel.appendChild(this.sessionChangesMount);
		}
		const loadedTurns = this.turns.get(sessionId);
		const selectMount = this.sessionChangesTurnSelectMount!;
		selectMount.replaceChildren();
		if (loadedTurns === undefined) {
			const loading = document.createElement('p'); loading.className = 'ai-session-changes__empty'; loading.setAttribute('role', 'status'); loading.textContent = '실행 기록을 불러오는 중입니다.'; selectMount.appendChild(loading);
			this.sessionChangesWidgetMount!.hidden = true;
			this.sessionChangesController?.setVisible(false);
			return this.sessionChangesPanel;
		}
		const turns = loadedTurns;
		let turnId = this.selectedChangeTurns.get(sessionId);
		if (!turns.some(turn => turn.id === turnId)) { turnId = turns.at(-1)?.id; if (turnId) { this.selectedChangeTurns.set(sessionId, turnId); } }
		if (!turnId || !this.projectId) {
			const empty = document.createElement('p'); empty.className = 'ai-session-changes__empty'; empty.textContent = '이 세션에는 확인할 실행 기록이 없습니다.'; selectMount.appendChild(empty);
			this.sessionChangesWidgetMount!.hidden = true;
			this.sessionChangesController?.setVisible(false);
			return this.sessionChangesPanel;
		}
		this.sessionChangesWidgetMount!.hidden = false;
		const selectorLabel = document.createElement('label'); selectorLabel.className = 'ai-session-changes__turn-label'; selectorLabel.textContent = '실행 기록';
		const selector = document.createElement('select'); selector.setAttribute('aria-label', '변경을 확인할 실행 기록');
		for (const turn of turns) { const option = document.createElement('option'); option.value = turn.id; option.textContent = `실행 ${turn.ordinal} · ${agentSessionTurnStateLabel[turn.state]} · ${new Date(turn.createdAt).toLocaleString('ko-KR')}`; selector.appendChild(option); }
		selector.value = turnId;
		selector.addEventListener('change', () => { this.selectedChangeTurns.set(sessionId, selector.value); this.render(); });
		selectorLabel.appendChild(selector); selectMount.appendChild(selectorLabel);
		const widget = this.sessionChangesWidgetMount!;
		const projectId = this.projectId;
		const selectedTurn = turns.find(turn => turn.id === turnId)!;
		const knowledgeReferences = [
			...(selectedTurn.snapshot.convention ? [{ kind: 'convention' as const, ...selectedTurn.snapshot.convention, label: selectedTurn.snapshot.convention.id }] : []),
			...selectedTurn.snapshot.references.map(reference => ({ kind: 'reference' as const, ...reference, label: reference.id })),
		];
		const ipcScope = { projectId, sessionId, turnId };
		const context: SessionChangesContext = { ...ipcScope, knowledgeReferences };
		const contextKey = JSON.stringify([projectId, sessionId, turnId]);
		const actions: SessionChangesActions = {
			latest: () => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'getLatestChangeEvidence', ipcScope) as Promise<WorkspaceAgentChangeEvidenceDTO | null>,
			list: (beforeVersion, limit) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listChangeEvidence', { ...ipcScope, beforeVersion, limit }) as Promise<WorkspaceAgentChangeEvidencePageDTO>,
			file: (evidence, path) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'getChangeFile', { ...ipcScope, evidenceVersion: evidence.version, fingerprint: evidence.fingerprint, path }) as Promise<WorkspaceAgentChangeFileDTO | null>,
			hunks: (evidence, path) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'getChangeHunks', { ...ipcScope, evidenceVersion: evidence.version, fingerprint: evidence.fingerprint, path }) as Promise<WorkspaceAgentChangeHunksDTO | null>,
			explanation: target => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'getLatestChangeExplanation', target) as Promise<WorkspaceAgentExplanationDTO | null>,
			explanationRevisions: (target, afterRevision, limit) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listChangeExplanationRevisions', { ...target, afterRevision, limit }) as Promise<WorkspaceAgentExplanationPageDTO>,
			saveExplanation: (target, expectedLatestRevision, what, why, citations, checkClaims, status) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'recordHumanChangeExplanation', { ...target, expectedLatestRevision, what, why, citations, checkClaims, status }) as Promise<WorkspaceAgentExplanationDTO>,
			listCommitProposals: (afterRevision, limit) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listCommitProposals', { ...ipcScope, afterRevision, limit }) as Promise<{ readonly proposals: readonly AgentSessionIntegrationProposalDTO[]; readonly nextRevision: number; readonly hasMore: boolean }>,
			prepareCommitProposal: (input: WorkspaceAgentCommitPrepareInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'prepareCommitProposal', input) as Promise<AgentSessionIntegrationProposalDTO>,
			approveCommitProposal: (input: WorkspaceAgentCommitProposalInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'approveCommitProposal', input) as Promise<{ readonly approved: boolean; readonly proposal: AgentSessionIntegrationProposalDTO }>,
			applyCommitProposal: (input: WorkspaceAgentCommitProposalInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'applyCommitProposal', input) as Promise<AgentSessionIntegrationProposalDTO>,
			recoverCommitProposal: (input: WorkspaceAgentCommitRecoveryInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'recoverCommitProposal', input) as Promise<AgentSessionIntegrationProposalDTO>,
			listMergeProposals: (afterRevision, limit) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listMergeProposals', { ...ipcScope, afterRevision, limit }) as Promise<WorkspaceAgentMergeProposalPageDTO>,
			prepareMergeProposal: (input: WorkspaceAgentMergePrepareInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'prepareMergeProposal', input) as Promise<AgentSessionMergeProposalDTO>,
			approveMergeProposal: (input: WorkspaceAgentMergeProposalMutationInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'approveMergeProposal', input) as Promise<{ readonly approved: boolean; readonly proposal: AgentSessionMergeProposalDTO }>,
			applyMergeProposal: (input: WorkspaceAgentMergeProposalMutationInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'applyMergeProposal', input) as Promise<AgentSessionMergeProposalDTO>,
			reconcileMergeProposal: (input: WorkspaceAgentMergeProposalRecoveryInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'reconcileMergeProposal', input) as Promise<AgentSessionMergeProposalDTO>,
			listPublicationAccounts: (scope: WorkspaceAgentPublicationScope) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listPublicationAccounts', scope) as Promise<WorkspaceAgentPublicationAccountsDTO>,
			listPublicationProposals: (input: WorkspaceAgentPublicationPageInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listPublicationProposals', input) as Promise<AgentSessionPublicationPageDTO>,
			preparePublicationProposal: (input: WorkspaceAgentPublicationTextPrepareInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'preparePublicationProposal', input) as Promise<AgentSessionPublicationProposalDTO>,
			getPrTextDraft: scope => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'getPrTextDraft', scope) as ReturnType<IWorkspaceAgentPrTextService['getPrTextDraft']>,
			listPrTextRevisions: input => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listPrTextRevisions', input) as ReturnType<IWorkspaceAgentPrTextService['listPrTextRevisions']>,
			listPrTextRequests: input => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listPrTextRequests', input) as ReturnType<IWorkspaceAgentPrTextService['listPrTextRequests']>,
			savePrTextRevision: input => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'savePrTextRevision', input) as ReturnType<IWorkspaceAgentPrTextService['savePrTextRevision']>,
			previewPrTextRequest: input => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'previewPrTextRequest', input) as ReturnType<IWorkspaceAgentPrTextService['previewPrTextRequest']>,
			startPrTextRequest: input => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'startPrTextRequest', input) as ReturnType<IWorkspaceAgentPrTextService['startPrTextRequest']>,
			getPrTextRequest: input => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'getPrTextRequest', input) as ReturnType<IWorkspaceAgentPrTextService['getPrTextRequest']>,
			cancelPrTextRequest: input => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'cancelPrTextRequest', input) as ReturnType<IWorkspaceAgentPrTextService['cancelPrTextRequest']>,
			applyPrTextCandidate: input => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'applyPrTextCandidate', input) as ReturnType<IWorkspaceAgentPrTextService['applyPrTextCandidate']>,
			approvePublicationProposal: (input: WorkspaceAgentPublicationMutationInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'approvePublicationProposal', input) as Promise<{ readonly approved: boolean; readonly proposal: AgentSessionPublicationProposalDTO }>,
			publishApprovedProposal: (input: WorkspaceAgentPublicationMutationInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'publishApprovedProposal', input) as Promise<WorkspaceAgentPublicationExecutionDTO>,
			continuePublicationOperation: (input: WorkspaceAgentPublicationRecoveryInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'continuePublicationOperation', input) as Promise<WorkspaceAgentPublicationExecutionDTO>,
			reconcilePublicationOperation: (input: WorkspaceAgentPublicationRecoveryInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'reconcilePublicationOperation', input) as Promise<WorkspaceAgentPublicationExecutionDTO>,
			getPublicationOperation: (input: WorkspaceAgentPublicationMutationInput) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'getPublicationOperation', input) as Promise<AgentSessionPublicationOperationDTO | null>,
			openDiff: (evidence, path, before, after, isCurrent) => this.openChangeDiff(context, evidence, path, before, after, isCurrent),
		};
		if (!this.sessionChangesController) {
			this.sessionChangesContextKey = contextKey;
			this.sessionChangesController = createSessionChanges(widget, context, actions);
		} else if (this.sessionChangesContextKey !== contextKey) {
			this.sessionChangesContextKey = contextKey;
			this.sessionChangesController.setContext(context, actions);
		}
		this.sessionChangesController.setVisible(this.editorVisible && this.activeTab === 'changes');
		return this.sessionChangesPanel;
	}

	private async openChangeDiff(context: SessionChangesContext, evidence: WorkspaceAgentChangeEvidenceDTO, path: string, before: string, after: string, isCurrent: () => boolean): Promise<void> {
		const editorService = this.editorService;
		await withSessionChangeDiffQueue(editorService, async () => {
			if (!isCurrent()) { return; }
			const owned = sessionChangeDiffOwners.get(editorService);
			if (owned) {
				const identifier = editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).find(item => item.editor === owned.input);
				if (identifier) { await editorService.closeEditor(identifier); }
				if (sessionChangeDiffOwners.get(editorService) === owned) { throw new Error('이전 파일 비교 편집기가 아직 열려 있습니다. 해당 비교를 닫은 뒤 다시 시도해 주세요.'); }
			}
			if (!isCurrent()) { return; }
			const token = `${encodeURIComponent(context.projectId)}/${encodeURIComponent(context.sessionId)}/${encodeURIComponent(context.turnId)}/${generateUuid()}`;
			const originalUri = URI.from({ scheme: Schemas.inMemory, path: `/agent-session-change/${token}/before/${encodeURIComponent(path)}` });
			const modifiedUri = URI.from({ scheme: Schemas.inMemory, path: `/agent-session-change/${token}/after/${encodeURIComponent(path)}` });
			let original: import('../../../../../editor/common/model.js').ITextModel | undefined;
			let modified: import('../../../../../editor/common/model.js').ITextModel | undefined;
			let openedInput: EditorInput | undefined;
			let pair: OwnedSessionChangeDiff | undefined;
			try {
				const originalModel = this.modelService.createModel(before, null, originalUri);
				original = originalModel;
				const modifiedModel = this.modelService.createModel(after, null, modifiedUri);
				modified = modifiedModel;
				const label = `v${evidence.version} · ${path} · 실행 ${evidence.turnId.slice(0, 8)}`;
				const pane = await editorService.openEditor({ original: { resource: originalUri }, modified: { resource: modifiedUri }, label, description: evidence.fingerprint.slice(0, 12) }) as ITextDiffEditorPane | undefined;
				openedInput = pane?.input;
				if (!pane || !openedInput) { throw new Error('코드 비교 편집기를 열지 못했습니다.'); }
				let disposed = false;
				let disposeListener: { dispose(): void } | undefined;
				const ownedPair: OwnedSessionChangeDiff = {
					input: openedInput, original: originalModel, modified: modifiedModel,
					dispose: () => {
						if (disposed) { return; }
						disposed = true; disposeListener?.dispose(); originalModel.dispose(); modifiedModel.dispose();
						if (sessionChangeDiffOwners.get(editorService) === ownedPair) { sessionChangeDiffOwners.delete(editorService); }
					},
				};
				pair = ownedPair;
				sessionChangeDiffOwners.set(editorService, ownedPair);
				disposeListener = openedInput.onWillDispose(() => ownedPair.dispose());
				if (!isCurrent()) {
					const identifier = editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).find(item => item.editor === openedInput);
					if (identifier) { await editorService.closeEditor(identifier); }
					return;
				}
				const control = pane.getControl();
				control?.updateOptions({ readOnly: true });
				control?.getOriginalEditor().updateOptions({ readOnly: true });
				control?.getModifiedEditor().updateOptions({ readOnly: true });
			} catch (error) {
				if (openedInput) {
					const identifier = editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).find(item => item.editor === openedInput);
					if (identifier) { await editorService.closeEditor(identifier); }
				}
				if (!pair || sessionChangeDiffOwners.get(editorService) !== pair) { original?.dispose(); modified?.dispose(); }
				throw error;
			}
		});
	}

	private updateNotificationsMount(): HTMLElement {
		if (!this.notificationsMount) {
			this.notificationsMount = document.createElement('div');
			this.notificationsMount.className = 'ai-session__notifications-mount';
		}
		const projectId = this.projectId!;
		const actions: SessionNotificationsActions = {
			loadStatus: () => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'notificationStatus', { projectId }) as Promise<WorkspaceAgentSessionNotificationStatus>,
			loadPage: (options: SessionPageOptions) => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listNotifications', {
				projectId,
				afterSequence: options.afterSequence,
				limit: options.limit,
			}) as Promise<readonly SessionNotificationDTO[]>,
			markRead: notificationId => ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'markNotificationRead', { projectId, notificationId }) as Promise<void>,
			onOpen: notification => this.openNotification(notification),
		};
		if (!this.sessionNotifications) {
			this.sessionNotifications = createSessionNotifications(this.notificationsMount, projectId, this.sessions, actions);
		} else {
			this.sessionNotifications.setContext(projectId, this.sessions, actions);
		}
		this.sessionNotifications.setVisible(this.editorVisible && !!this.dashboard);
		return this.notificationsMount;
	}

	async openNotification(notification: SessionNotificationDTO): Promise<boolean> {
		const generation = ++this.notificationNavigationGeneration;
		const isCurrent = (): boolean => generation === this.notificationNavigationGeneration && this.projectId === notification.projectId;
		if (!this.projectId || notification.projectId !== this.projectId) { this.showError('현재 프로젝트의 알림이 아닙니다.'); return false; }
		const recipient = this.sessions.find(session => session.id === notification.sessionId);
		if (!recipient) { this.showError(`받는 세션을 찾을 수 없습니다. 세션 ID ${notification.sessionId}`); return false; }
		const requestedProjectId = this.projectId;
		const targetTurnId = notification.target.kind === 'turn' ? notification.target.id
			: 'turnId' in notification.target ? notification.target.turnId : undefined;
		if (targetTurnId) {
			try { await this.loadTurns(recipient.id, isCurrent); }
			catch (error) { if (isCurrent()) { this.showError(`알림의 실행 기록을 불러오지 못했습니다: ${this.errorMessage(error, '세션 기록을 불러오지 못했습니다.')}`); } return false; }
			if (!isCurrent() || this.projectId !== requestedProjectId) { return false; }
			if (!this.turns.get(recipient.id)?.some(turn => turn.id === targetTurnId && turn.projectId === requestedProjectId && turn.sessionId === recipient.id)) {
				this.showError('알림이 가리키는 실행 기록을 찾을 수 없습니다. 알림은 보존되었으며 다른 실행을 대신 열지 않았습니다.');
				return false;
			}
		}

		const previousNavigation = {
			selectedSessionId: this.selectedSessionId,
			activeTab: this.activeTab,
			pendingMessage: this.pendingNotificationMessage,
			selectedChangeTurn: this.selectedChangeTurns.get(recipient.id),
			creating: this.creating,
			preview: this.preview,
			previewSessionId: this.previewSessionId,
		};
		const restoreNavigation = (): void => {
			if (!isCurrent()) { return; }
			this.selectedSessionId = previousNavigation.selectedSessionId;
			this.activeTab = previousNavigation.activeTab;
			this.pendingNotificationMessage = previousNavigation.pendingMessage;
			this.creating = previousNavigation.creating;
			this.preview = previousNavigation.preview;
			this.previewSessionId = previousNavigation.previewSessionId;
			if (previousNavigation.selectedChangeTurn) { this.selectedChangeTurns.set(recipient.id, previousNavigation.selectedChangeTurn); }
			else { this.selectedChangeTurns.delete(recipient.id); }
			if (previousNavigation.selectedSessionId) { persistSessionSelection(this.projectId!, previousNavigation.selectedSessionId); }
			localStorage.setItem(`${SESSION_STORAGE_TAB}.${this.projectId}`, previousNavigation.activeTab);
			this.render();
		};
		this.terminalController?.hide();
		this.sessionLogs?.invalidateContext();
		this.sessionMessages?.setVisible(false);
		this.sessionWorkflow?.setVisible(false);
		if (this.previewSessionId !== recipient.id) { this.preview = undefined; this.previewSessionId = undefined; }
		this.creating = false;
		this.selectedSessionId = recipient.id;
		persistSessionSelection(this.projectId, recipient.id);
		this.pendingNotificationMessage = notification.target.kind === 'message' ? { sessionId: recipient.id, messageId: notification.target.id } : undefined;
		if (notification.target.kind === 'message') {
			this.activeTab = 'messages';
		} else if ('turnId' in notification.target) {
			this.activeTab = 'changes';
			this.selectedChangeTurns.set(recipient.id, notification.target.turnId);
		} else if (notification.target.kind === 'turn') {
			this.activeTab = 'logs';
			localStorage.setItem(this.logsTurnStorageKey(recipient.id), notification.target.id);
		} else {
			this.activeTab = 'terminal';
		}
		localStorage.setItem(`${SESSION_STORAGE_TAB}.${this.projectId}`, this.activeTab);
		this.notice = undefined;
		this.error = undefined;
		this.render();
		requestAnimationFrame(() => { if (isCurrent()) { this.root?.querySelector<HTMLElement>(`#ai-session-tab-${this.activeTab}`)?.focus({ preventScroll: true }); } });
		if (notification.target.kind === 'message') {
			const revealed = await this.sessionMessages?.revealMessage(notification.target.id);
			if (!isCurrent()) { return false; }
			if (!revealed) {
				restoreNavigation();
				if (isCurrent()) { this.showError('알림 메시지를 실제 우편함 항목에서 찾아 포커스하지 못했습니다. 알림은 읽지 않은 상태로 보존했습니다.'); }
				return false;
			}
		}
		if (targetTurnId) { this.render(); }
		if (notification.target.kind === 'turn') {
			const logsShown = await this.sessionLogs?.confirmContext({ projectId: requestedProjectId, sessionId: recipient.id, turnId: notification.target.id });
			if (!isCurrent()) { return false; }
			if (!logsShown) {
				restoreNavigation();
				if (isCurrent()) { this.showError('알림의 정확한 실행 기록을 불러와 표시하지 못했습니다. 알림은 읽지 않은 상태로 보존했습니다.'); }
				return false;
			}
		}
		if ('turnId' in notification.target) {
			try {
				const selectedExactTarget = await this.sessionChangesController?.revealNotificationTarget(notification.target, isCurrent);
				if (!isCurrent()) { return false; }
				if (selectedExactTarget === false) { return false; }
				if (!selectedExactTarget) { restoreNavigation(); if (isCurrent()) { this.showError('알림의 정확한 제안과 보관된 변경 기록을 선택하지 못했습니다. 알림은 읽지 않은 상태로 보존했습니다.'); } return false; }
			} catch (error) {
				restoreNavigation();
				if (isCurrent()) { this.showError(`알림의 제안 기록을 열지 못했습니다: ${this.errorMessage(error, '제안을 확인할 수 없습니다.')}`); }
				return false;
			}
		}
		return isCurrent();
	}

	private async exportLoadedTranscript(text: string, fileName: string, isCurrent: () => boolean): Promise<boolean> {
		if (!isCurrent()) { return false; }
		const defaultPath = await this.fileDialogService.defaultFilePath();
		if (!isCurrent()) { return false; }
		const defaultUri = URI.joinPath(defaultPath, fileName);
		const target = await this.fileDialogService.showSaveDialog({
			title: '불러온 세션 로그 저장',
			defaultUri,
			filters: [{ name: '텍스트 파일', extensions: ['txt'] }],
		});
		if (!target) { return false; }
		if (!isCurrent()) { return false; }
		await this.fileService.writeFile(target, VSBuffer.fromString(text));
		return true;
	}

	private setTab(tab: AgentSessionViewTab): void {
		if (!this.projectId || tab === this.activeTab) return;
		this.notificationNavigationGeneration++;
		this.activeTab = tab;
		localStorage.setItem(`${SESSION_STORAGE_TAB}.${this.projectId}`, tab);
		if (tab !== 'terminal') this.terminalController?.hide();
		this.render();
		requestAnimationFrame(() => this.root?.querySelector<HTMLElement>(`#ai-session-tab-${tab}`)?.focus({ preventScroll: true }));
	}

	private showError(message: string): void { this.error = message; this.render(); }
	private errorMessage(error: unknown, fallback: string): string {
		const message = error instanceof Error ? error.message : String(error);
		if (/no trusted PTY backend|Interactive AI sessions are unavailable|No handler registered|Call not found/i.test(message)) return '신뢰할 수 있는 AI 터미널 서비스가 준비되지 않았습니다. 서비스를 연결한 뒤 다시 시도해 주세요.';
		if (!message) return fallback;
		return /[\uac00-\ud7a3]/.test(message) ? message : `요청을 처리하지 못했습니다. ${message}`;
	}

	private render(): void {
		if (!this.root) return;
		this.sessionListScrollTop = this.root.querySelector<HTMLElement>('.ai-session__list')?.scrollTop ?? this.sessionListScrollTop;
		const activeElement = document.activeElement;
		const onboardingFinished = this.onboardingFocusTogglePending;
		this.onboardingFocusTogglePending = false;
		const focusedOnboardingKey = !onboardingFinished && !this.createFormFocusPending && activeElement instanceof HTMLElement && this.onboardingMount?.contains(activeElement) ? activeElement.dataset.onboardingFocus : undefined;
		const onboardingToggleFocused = activeElement instanceof HTMLElement && this.root.contains(activeElement) && activeElement.dataset.onboardingToggle === 'true';
		const focusedLogsElement = activeElement instanceof HTMLElement && this.logsPanel?.contains(activeElement) ? activeElement : undefined;
		const focusedMessagesElement = activeElement instanceof HTMLElement && this.sessionMessagesPanel?.contains(activeElement) ? activeElement : undefined;
		const focusedWorkflowElement = activeElement instanceof HTMLElement && this.sessionWorkflowPanel?.contains(activeElement) ? activeElement : undefined;
		const focusedNotificationsElement = activeElement instanceof HTMLElement && this.notificationsMount?.contains(activeElement) ? activeElement : undefined;
		let logsShouldBeVisible = false;
		let messagesShouldBeVisible = false;
		let workflowShouldBeVisible = false;
		let changesShouldBeVisible = false;
		this.root.replaceChildren();
		if (!this.projectId) {
			this.sessionLogs?.setVisible(false);
			this.sessionMessages?.setVisible(false);
			this.sessionWorkflow?.setVisible(false);
			this.sessionChangesController?.setVisible(false);
			this.sessionNotifications?.setVisible(false);
			return;
		}
		this.root.setAttribute('aria-busy', String(this.loading || this.operation));
		const onboardingMount = this.dashboard ? this.updateOnboardingMount() : undefined;
		const shell = document.createElement('div'); shell.className = 'ai-session__shell';
		const projectHeader = document.createElement('header');
		projectHeader.className = 'ai-session__project-header';
		const projectName = document.createElement('strong');
		projectName.className = 'ai-session__project-name';
		projectName.textContent = this.dashboard?.project.name ?? '프로젝트';
		projectHeader.appendChild(projectName);
		if (this.dashboard) {
			const headerActions = document.createElement('div'); headerActions.className = 'ai-session__project-header-actions';
			headerActions.append(this.updateNotificationsMount(), this.createOnboardingToggle());
			projectHeader.appendChild(headerActions);
		}
		shell.appendChild(projectHeader);
		const main = document.createElement('main'); main.className = 'ai-session__main';
		if (this.loading && !this.dashboard) {
			const loading = document.createElement('p'); loading.className = 'ai-session__state'; loading.setAttribute('role', 'status'); loading.textContent = 'AI 세션을 불러오는 중입니다.'; main.appendChild(loading);
		} else if (this.error && !this.dashboard) {
			this.renderFailure(main);
		} else {
			const tasks = this.availableTasks();
			const taskNames = new Map(tasks.map(task => [task.id, task.title]));
			const startCreating = () => { this.creating = true; this.onboardingCreateProvider = undefined; this.onboardingCreateTaskId = undefined; this.createFormFocusPending = true; this.createPermissionMode = 'read-only'; this.preview = undefined; this.render(); };
			const compactToolbar = document.createElement('div'); compactToolbar.className = 'ai-session__narrow-toolbar';
			const selector = document.createElement('label'); selector.className = 'ai-session__narrow-selector'; selector.textContent = '세션 선택';
			const select = document.createElement('select'); select.setAttribute('aria-label', '현재 세션 선택');
			const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '세션 선택'; select.appendChild(placeholder);
			for (const session of this.sessions) { const option = document.createElement('option'); option.value = session.id; option.textContent = session.name; select.appendChild(option); }
			select.value = this.selectedSessionId ?? '';
			select.addEventListener('change', () => { if (select.value) this.selectSession(select.value); });
			selector.appendChild(select);
			const compactCreate = document.createElement('button'); compactCreate.type = 'button'; compactCreate.className = 'ai-session__secondary'; compactCreate.textContent = '새 세션'; compactCreate.setAttribute('aria-label', '새 AI 세션 만들기'); compactCreate.addEventListener('click', startCreating);
			compactToolbar.append(selector, compactCreate); shell.appendChild(compactToolbar);

			const list = document.createElement('aside'); list.className = 'ai-session__list'; list.setAttribute('aria-label', 'AI 세션 목록');
			renderSessionList(list, this.sessions, this.selectedSessionId, { onSelect: id => this.selectSession(id), onCreate: startCreating }, taskNames);
			shell.appendChild(list);

			if (this.creating || this.sessions.length === 0) {
				this.renderCreateForm(main, tasks);
			} else if (this.selectedSessionId) {
				const session = this.sessions.find(item => item.id === this.selectedSessionId);
				if (session) {
					const turn = this.latestTurn(session.id);
					const workspace = this.workspacePreparations.get(session.id);
					if (session.workspaceMode === 'gitWorktree' && workspace) { this.renderWorkspacePreparation(main, workspace); }
					logsShouldBeVisible = this.editorVisible && this.activeTab === 'logs' && !!this.turns.get(session.id)?.length;
					messagesShouldBeVisible = this.editorVisible && this.activeTab === 'messages';
					workflowShouldBeVisible = this.editorVisible && this.activeTab === 'workflow';
					changesShouldBeVisible = this.editorVisible && this.activeTab === 'changes';
					const logsPanel = this.updateLogsPanel(session.id);
					const messagesPanel = this.updateMessagesPanel(session.id);
					const workflowPanel = this.updateWorkflowPanel(session);
					const changesPanel = this.updateChangesPanel(session.id);
					const rendered = renderSessionDetail(main, session, turn, this.activeTab, {
						onStart: () => void this.prepareLaunch(session.id),
						onStop: () => void this.stopTurn(), onTab: tab => this.setTab(tab),
					}, taskNames.get(session.taskId ?? ''), logsPanel, messagesPanel, workflowPanel);
					if (this.activeTab === 'changes') { main.querySelector<HTMLElement>('.ai-session__panel')?.replaceChildren(changesPanel); }
					if (this.activeTab === 'terminal') this.renderTerminal(rendered.terminal, session, turn);
					if (this.preview && this.previewSessionId === session.id) {
						this.renderPreview(main, this.preview);
						const preview = main.querySelector('.ai-session__preview');
						const tabs = main.querySelector('.ai-session__tabs');
						if (preview && tabs) main.insertBefore(preview, tabs);
					}
				}
			} else {
				this.renderEmpty(main, tasks.length > 0);
			}
		}

		if (onboardingMount) { main.prepend(onboardingMount); }
		if (this.error) this.renderInlineMessage(main, this.error, true);
		if (this.notice) this.renderInlineMessage(main, this.notice, false);
		shell.appendChild(main); this.root.appendChild(shell);
		if (this.createFormFocusPending) {
			this.createFormFocusPending = false;
			this.root.scrollTop = 0;
			this.root.querySelector<HTMLElement>('.ai-session__create-form [name="name"], .ai-session__create-empty')?.focus({ preventScroll: true });
		}
		const sessionList = this.root.querySelector<HTMLElement>('.ai-session__list');
		if (sessionList) sessionList.scrollTop = this.sessionListScrollTop;
		if (focusedLogsElement?.isConnected) { focusedLogsElement.focus({ preventScroll: true }); }
		if (focusedMessagesElement?.isConnected) { focusedMessagesElement.focus({ preventScroll: true }); }
		if (focusedWorkflowElement?.isConnected) { focusedWorkflowElement.focus({ preventScroll: true }); }
		if (focusedNotificationsElement?.isConnected) { focusedNotificationsElement.focus({ preventScroll: true }); }
		if (focusedOnboardingKey) {
			const matching = [...this.root.querySelectorAll<HTMLElement>('[data-onboarding-focus]')].find(element => element.dataset.onboardingFocus === focusedOnboardingKey && !element.hasAttribute('disabled'));
			matching?.focus({ preventScroll: true });
		}
		if (onboardingFinished || onboardingToggleFocused) { this.root.querySelector<HTMLElement>('[data-onboarding-toggle="true"]')?.focus({ preventScroll: true }); }
		if (!logsShouldBeVisible) { this.sessionLogs?.setVisible(false); }
		if (!messagesShouldBeVisible) { this.sessionMessages?.setVisible(false); }
		if (!workflowShouldBeVisible) { this.sessionWorkflow?.setVisible(false); }
		if (!changesShouldBeVisible) { this.sessionChangesController?.setVisible(false); }
		if (this.dashboard) { this.sessionNotifications?.setVisible(this.editorVisible); }
		this.updateLifecyclePolling();
	}

	private updateLifecyclePolling(): void {
		const sessionId = this.selectedSessionId;
		const turn = sessionId ? this.latestTurn(sessionId) : undefined;
		const shouldPoll = this.editorVisible && !!sessionId && this.activeTab === 'terminal' && !!turn && ['starting', 'running', 'stopping'].includes(turn.state);
		if (!shouldPoll && this.lifecycleTimer) { clearInterval(this.lifecycleTimer); this.lifecycleTimer = undefined; }
		if (shouldPoll && !this.lifecycleTimer) {
			this.lifecycleTimer = setInterval(() => void this.refreshLifecycle(sessionId!), 2500);
		}
	}

	private async refreshLifecycle(sessionId: string): Promise<void> {
		if (!this.projectId || this.operation || this.selectedSessionId !== sessionId) return;
		try {
			const previousTurnState = this.latestTurn(sessionId)?.state;
			const previousSessionState = this.sessions.find(session => session.id === sessionId)?.state;
			await this.loadTurns(sessionId);
			this.sessions = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'listSessions', { projectId: this.projectId }) as readonly AgentSessionDTO[];
			const nextTurnState = this.latestTurn(sessionId)?.state;
			const nextSessionState = this.sessions.find(session => session.id === sessionId)?.state;
			if (previousTurnState !== nextTurnState || previousSessionState !== nextSessionState) {
				const completedTurn = this.latestTurn(sessionId);
				if (completedTurn && ['exited', 'interrupted', 'failed'].includes(completedTurn.state)) this.terminalController?.finish(sessionId, completedTurn.id, completedTurn.exitCode ?? undefined);
				this.render();
			}
		} catch (error) { this.showError(this.errorMessage(error, '실행 상태를 새로고침하지 못했습니다.')); }
	}

	private availableTasks(): readonly WorkspaceDashboardTaskItemDTO[] {
		return (this.dashboard?.tasks ?? []).filter(task => !task.archivedAt && !task.trashedAt && !task.deletionPendingAt && task.state !== 'done');
	}

	private renderTerminal(container: HTMLElement, session: AgentSessionDTO, turn: AgentSessionTurnDTO | undefined): void {
		if (!this.editorVisible) return;
		const terminalController = this.terminalController;
		if (turn && terminalController?.hasTerminal(session.id, turn.id)) {
			void terminalController.show(container, session.id, turn).catch(error => this.showError(this.errorMessage(error, '세션 터미널에 연결하지 못했습니다.')));
			return;
		}
		if (!turn || !['starting', 'running'].includes(turn.state)) {
			const state = document.createElement('p'); state.className = 'ai-session__state'; state.setAttribute('role', 'status');
			state.textContent = turn?.state === 'failed' ? `실행 실패 · ${turn.errorSummary ?? '세션 실행 상태를 확인해 주세요.'}`
				: turn?.state === 'interrupted' ? `연결 끊김 · 마지막 저장 ${new Date(turn.updatedAt).toLocaleString('ko-KR')}. 다시 실행하려면 새 실행을 준비해 주세요.`
				: '실행 중인 터미널이 없습니다. 실행 준비를 눌러 권한과 작업 폴더를 확인해 주세요.';
			container.appendChild(state); return;
		}
		if (terminalController) void terminalController.show(container, session.id, turn).catch(error => this.showError(this.errorMessage(error, '세션 터미널에 연결하지 못했습니다.')));
	}

	private renderWorkspacePreparation(parent: HTMLElement, status: WorkspaceAgentSessionWorkspacePreparationDTO): void {
		const section = document.createElement('section');
		section.className = 'ai-session__state';
		section.setAttribute('aria-labelledby', 'ai-session-workspace-preparation-title');
		const title = document.createElement('h2');
		title.id = 'ai-session-workspace-preparation-title';
		title.textContent = status.state === 'ready' ? '작업공간 준비 완료' : status.state === 'needsPreparation' ? '작업공간 준비가 필요합니다' : '작업공간 복구가 필요합니다';
		section.appendChild(title);
		if (status.state === 'ready') {
			const detail = document.createElement('p');
			detail.textContent = `경로 · ${status.worktreePath ?? '경로 확인 불가'}${status.branch ? ` · 브랜치 ${status.branch}` : ''}`;
			section.appendChild(detail);
		} else {
			const reason = document.createElement('p');
			reason.textContent = status.reason ?? (status.state === 'recoveryRequired' ? '보존된 경로와 브랜치를 확인하고 복구해야 합니다.' : '같은 세션에서 작업공간을 다시 준비할 수 있습니다.');
			section.appendChild(reason);
			if (status.worktreePath || status.branch) {
				const retained = document.createElement('p');
				retained.textContent = `보존된 위치 · ${status.worktreePath ?? '확인할 수 없음'}${status.branch ? ` · 브랜치 ${status.branch}` : ''}`;
				section.appendChild(retained);
			}
			if (status.state === 'needsPreparation') {
				const actions = document.createElement('div'); actions.className = 'ai-session__form-actions';
				const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'ai-session__secondary';
				retry.disabled = this.operation; retry.textContent = '같은 세션에서 작업공간 다시 준비';
				retry.addEventListener('click', () => void this.retryWorkspacePreparation(status.sessionId));
				actions.appendChild(retry); section.appendChild(actions);
			}
		}
		parent.prepend(section);
	}

	private renderCreateForm(parent: HTMLElement, tasks: readonly WorkspaceDashboardTaskItemDTO[]): void {
		const section = document.createElement('section'); section.className = 'ai-session__create';
		const title = document.createElement('h1'); title.textContent = this.sessions.length ? '새 AI 세션' : '프로젝트 첫 AI 세션';
		const intro = document.createElement('p'); intro.className = 'ai-session__muted'; intro.textContent = '기존 프로젝트 작업에 연결하고 공급자와 실제 모델 ID를 지정합니다.';
		section.append(title, intro);
		if (!tasks.length) {
			const empty = document.createElement('p'); empty.className = 'ai-session__state ai-session__create-empty'; empty.tabIndex = -1; empty.textContent = '연결할 진행 중 작업이 없습니다. 대시보드에서 작업을 만든 뒤 다시 시작해 주세요.';
			section.appendChild(empty); parent.appendChild(section); return;
		}
		const form = document.createElement('form'); form.className = 'ai-session__form';
		const name = this.field(form, '세션 이름', 'name', '예: 로그인 흐름 조사', 'text'); name.control.required = true;
		const task = this.field(form, '연결할 작업', 'task', '', 'select');
		const taskSelect = task.control as HTMLSelectElement;
		for (const item of tasks) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.title; taskSelect.appendChild(option); }
		if (this.dashboard?.view.selectedTaskId && tasks.some(item => item.id === this.dashboard?.view.selectedTaskId)) taskSelect.value = this.dashboard.view.selectedTaskId;
		if (this.onboardingCreateTaskId && tasks.some(item => item.id === this.onboardingCreateTaskId)) taskSelect.value = this.onboardingCreateTaskId;
		const provider = this.field(form, '공급자', 'provider', '', 'select').control as HTMLSelectElement;
		for (const [value, label] of [['codex', 'Codex'], ['claude', 'Claude']] as const) { const option = document.createElement('option'); option.value = value; option.textContent = label; provider.appendChild(option); }
		if (this.onboardingCreateProvider) { provider.value = this.onboardingCreateProvider; }
		const model = this.field(form, '모델 ID', 'model', '공급자가 지원하는 모델 ID', 'text'); model.control.required = true;
		const modelHelp = document.createElement('p'); modelHelp.className = 'ai-session__field-help'; modelHelp.textContent = '공급자가 지원하는 모델 ID를 그대로 입력합니다. 별칭이나 계정 선택은 제공하지 않습니다.'; model.wrapper.appendChild(modelHelp);
		const permission = this.field(form, '권한 범위', 'permission', '', 'select').control as HTMLSelectElement;
		for (const [value, label] of [['read-only', '읽기 전용'], ['mutating', '파일 수정 허용 · 요청 시 승인']] as const) { const option = document.createElement('option'); option.value = value; option.textContent = label; permission.appendChild(option); }
		permission.value = this.createPermissionMode;
		permission.addEventListener('change', () => { this.createPermissionMode = permission.value as AgentSessionPermissionPolicy['mode']; });
		const workspace = document.createElement('p'); workspace.className = 'ai-session__field-help';
		workspace.textContent = this.dashboard?.folder.vcsKind === 'git' ? '작업 위치 · 세션 전용 Git worktree' : '작업 위치 · 기존 폴더 (단일 수정자 정책 적용)';
		form.appendChild(workspace);
		const buttons = document.createElement('div'); buttons.className = 'ai-session__form-actions';
		const create = document.createElement('button'); create.type = 'submit'; create.className = 'ai-session__primary'; create.disabled = this.operation; create.textContent = '세션 만들고 실행 미리보기';
		const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ai-session__secondary'; cancel.textContent = '취소'; cancel.addEventListener('click', () => { this.creating = false; this.onboardingCreateProvider = undefined; this.onboardingCreateTaskId = undefined; this.render(); });
		buttons.append(create, cancel); form.appendChild(buttons);
		form.addEventListener('submit', event => { event.preventDefault(); void this.createSession({ name: name.control.value, taskId: taskSelect.value, provider: provider.value as CreateDraft['provider'], model: model.control.value, permissionMode: permission.value as AgentSessionPermissionPolicy['mode'] }); });
		form.classList.add('ai-session__create-form');
		section.appendChild(form); parent.appendChild(section);
	}

	private field(parent: HTMLElement, labelText: string, name: string, placeholder: string, kind: 'text' | 'select'): { wrapper: HTMLElement; control: HTMLInputElement | HTMLSelectElement } {
		const wrapper = document.createElement('label'); wrapper.className = 'ai-session__field';
		const label = document.createElement('span'); label.textContent = labelText;
		const control = document.createElement(kind === 'select' ? 'select' : 'input') as HTMLInputElement | HTMLSelectElement;
		control.name = name; control.setAttribute('aria-label', labelText);
		if (control instanceof HTMLInputElement) { control.type = 'text'; control.placeholder = placeholder; }
		wrapper.append(label, control); parent.appendChild(wrapper); return { wrapper, control };
	}

	private renderPreview(parent: HTMLElement, preview: LaunchPreview): void {
		const section = document.createElement('section'); section.className = 'ai-session__preview'; section.setAttribute('aria-labelledby', 'ai-session-preview-title');
		const title = document.createElement('h2'); title.id = 'ai-session-preview-title'; title.textContent = '실행 범위를 확인해 주세요';
		const snapshot = preview.snapshot;
		const list = document.createElement('dl'); list.className = 'ai-session__preview-list';
		for (const [label, value] of [
			['공급자와 모델', `${snapshot.provider === 'codex' ? 'Codex' : 'Claude'} · ${snapshot.model}`],
			['작업 폴더', snapshot.cwd], ['권한', snapshot.permissionPolicy.mode === 'read-only' ? '파일 도구 읽기 전용' : '파일 수정 · 요청 시 승인'],
			['규칙 스냅샷', snapshot.convention ? `연결됨 · ${snapshot.convention.sha256.slice(0, 12)}` : '연결 없음'],
			['참고 자료', snapshot.references.length ? `${snapshot.references.length}개 연결됨` : '연결 없음'],
			['계정 프로필', snapshot.profileRef ?? '기본 로컬 프로필'],
		] as const) { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); dd.textContent = value; list.append(dt, dd); }
		const expiry = new Date(preview.expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		const note = document.createElement('p'); note.className = 'ai-session__field-help'; note.textContent = `실행 후 비용이 발생할 수 있습니다. 위 스냅샷은 ${expiry}까지 유효합니다.`;
		const mcpScope = document.createElement('p'); mcpScope.className = 'ai-session__field-help';
		mcpScope.textContent = snapshot.provider === 'codex'
			? '앱의 MCP 권한은 이 프로젝트와 세션에 적용됩니다. Codex의 기존 MCP 도구는 프로필 설정을 따르며, 파일 및 외부 서비스 접근 범위는 별도로 적용됩니다.'
			: '앱의 MCP 권한은 이 프로젝트와 세션에 적용됩니다. 파일 도구의 읽기 전용 설정은 기존 프로필 도구와 외부 서비스 접근 범위를 제한하지 않습니다.';
		const identityNotice = document.createElement('p'); identityNotice.className = 'ai-session__field-help ai-session__provider-identity-notice';
		if (snapshot.provider === 'codex') {
			identityNotice.textContent = '처음에는 /hooks에서 UserPromptSubmit을 한 번 신뢰한 뒤 프롬프트를 입력해 주세요. 연결은 세션 식별 정보만 전달합니다. 새 대화는 앱에서 새 AI 세션을 만들어 시작하세요.';
		}
		const actions = document.createElement('div'); actions.className = 'ai-session__form-actions';
		const start = document.createElement('button'); start.id = 'ai-session-preview-start'; start.type = 'button'; start.className = 'ai-session__primary'; start.disabled = this.operation; start.textContent = '확인하고 실행'; start.addEventListener('click', () => void this.startPreviewedTurn());
		const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ai-session__secondary'; cancel.textContent = '취소'; cancel.addEventListener('click', () => { this.preview = undefined; this.previewSessionId = undefined; this.render(); });
		actions.append(start, cancel); section.append(title, list, note, mcpScope);
		if (snapshot.provider === 'codex') { section.appendChild(identityNotice); }
		section.appendChild(actions); parent.appendChild(section);
	}

	private renderEmpty(parent: HTMLElement, canCreate: boolean): void {
		const empty = document.createElement('div'); empty.className = 'ai-session__empty'; empty.setAttribute('role', 'status');
		const title = document.createElement('h1'); title.textContent = '세션을 선택해 주세요';
		const message = document.createElement('p'); message.textContent = canCreate ? '프로젝트 작업과 연결된 Codex 또는 Claude 세션을 만들 수 있습니다.' : '먼저 대시보드에서 작업을 만들어 주세요.';
		const button = document.createElement('button'); button.type = 'button'; button.className = 'ai-session__primary'; button.textContent = canCreate ? '새 세션 만들기' : '새로고침';
		button.addEventListener('click', () => canCreate ? (this.creating = true, this.createFormFocusPending = true, this.render()) : void this.load());
		empty.append(title, message, button); parent.appendChild(empty);
	}

	private renderFailure(parent: HTMLElement): void {
		const block = document.createElement('div'); block.className = 'ai-session__empty'; block.setAttribute('role', 'alert');
		const title = document.createElement('h1'); title.textContent = 'AI 세션을 연결할 수 없습니다.';
		const message = document.createElement('p'); message.textContent = this.error ?? '세션 서비스를 사용할 수 없습니다.';
		const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'ai-session__primary'; retry.textContent = '다시 시도'; retry.addEventListener('click', () => void this.load());
		block.append(title, message, retry); parent.appendChild(block);
	}

	private renderInlineMessage(parent: HTMLElement, message: string, isError: boolean): void {
		const status = document.createElement('p'); status.className = isError ? 'ai-session__message ai-session__message--error' : 'ai-session__message';
		status.setAttribute('role', isError ? 'alert' : 'status'); status.textContent = message; parent.appendChild(status);
	}

	layout(_dimension: Dimension): void { this.terminalController?.layout(); }

	override clearInput(): void {
		this.notificationNavigationGeneration++;
		this.terminalController?.dispose(); this.terminalController = undefined;
		if (this.lifecycleTimer) clearInterval(this.lifecycleTimer);
		this.lifecycleTimer = undefined; this.projectId = undefined; this.dashboard = undefined; this.sessions = []; this.turns.clear(); this.workspacePreparations.clear(); this.selectedSessionId = undefined; this.preview = undefined; this.previewSessionId = undefined; this.creating = false; this.sessionPermissionModes.clear(); this.createPermissionMode = 'read-only'; this.error = undefined; this.notice = undefined;
		if (this.root) this.root.replaceChildren();
		super.clearInput();
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AgentSessionWorkspaceEditorInput.ID, AgentSessionWorkspaceEditorSerializer);
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AgentSessionWorkspaceEditorPane, AgentSessionWorkspaceEditorPane.ID, 'AI 세션'),
	[new SyncDescriptor(AgentSessionWorkspaceEditorInput)],
);

interface OpenWorkspaceRequest {
	onboarding: boolean;
	notification?: SessionNotificationDTO;
	complete?: () => void;
	notificationComplete?: (opened: boolean) => void;
	fail?: (error: unknown) => void;
	cancel?: () => void;
	settled?: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

const openEmitter = new Emitter<OpenWorkspaceRequest>();
const pendingOpenRequests: OpenWorkspaceRequest[] = [];
const activeOpenRequests = new Set<OpenWorkspaceRequest>();
let openRequestsReady = false;
const OPEN_REQUEST_TIMEOUT_MS = 30_000;
const NATIVE_NOTIFICATION_REQUEST_TIMEOUT_MS = 15_000;
function settleOpenRequest(request: OpenWorkspaceRequest, opened: boolean, error?: unknown): void {
	if (request.settled) { return; }
	request.settled = true;
	if (request.timer) { clearTimeout(request.timer); request.timer = undefined; }
	activeOpenRequests.delete(request);
	const pendingIndex = pendingOpenRequests.indexOf(request);
	if (pendingIndex >= 0) { pendingOpenRequests.splice(pendingIndex, 1); }
	if (request.notification) {
		if (!opened || error !== undefined) { request.cancel?.(); }
		request.notificationComplete?.(opened && !error);
	}
	else if (error !== undefined) { request.fail?.(error); }
	else { request.complete?.(); }
}
function submitOpenRequest(request: OpenWorkspaceRequest): void {
	activeOpenRequests.add(request);
	request.timer = setTimeout(() => settleOpenRequest(request, false, new Error('AI 세션 작업 공간 요청이 제한 시간 안에 완료되지 않았습니다.')),
		request.notification ? NATIVE_NOTIFICATION_REQUEST_TIMEOUT_MS : OPEN_REQUEST_TIMEOUT_MS);
	if (openRequestsReady) { openEmitter.fire(request); return; }
	if (pendingOpenRequests.length >= 32) {
		const error = new Error('AI 세션 알림을 열 준비가 되지 않았습니다. 알림은 읽지 않은 상태로 보존했습니다.');
		settleOpenRequest(request, false, error);
		return;
	}
	pendingOpenRequests.push(request);
}
export function openAgentSessionWorkspace(): void { submitOpenRequest({ onboarding: false }); }
function openAgentSessionNotification(notification: SessionNotificationDTO): Promise<boolean> {
	return new Promise(resolve => submitOpenRequest({ onboarding: false, notification, notificationComplete: resolve }));
}
function openAgentSessionOnboarding(): Promise<void> {
	return new Promise((resolve, reject) => submitOpenRequest({ onboarding: true, complete: resolve, fail: reject }));
}

class AgentSessionWorkspaceContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.devfast.aiSessionWorkspace';
	constructor(
		@INativeWorkbenchEnvironmentService private readonly environment: INativeWorkbenchEnvironmentService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@INotificationService private readonly notificationService: INotificationService) {
		super();
		this._register(openEmitter.event(request => {
			if (request.settled) { return; }
			void this.open(true, request.onboarding, () => !request.settled).then(async pane => {
				if (request.settled) { return; }
				if (request.notification) {
					if (!(pane instanceof AgentSessionWorkspaceEditorPane) || !pane.matchesProject(request.notification.projectId)) {
						throw new Error('알림이 속한 프로젝트의 AI 세션 작업 공간을 열지 못했습니다.');
					}
					request.cancel = () => pane.cancelNotificationNavigation();
					if (request.settled) { request.cancel(); return; }
					settleOpenRequest(request, await pane.openNotification(request.notification));
					return;
				}
				settleOpenRequest(request, true);
			}).catch(error => {
				settleOpenRequest(request, false, error);
				this.notificationService.error('AI 세션 작업 공간을 열지 못했습니다. 다시 시도해 주세요.');
			});
		}));
		openRequestsReady = true;
		for (const request of [...pendingOpenRequests]) { if (!request.settled) { openEmitter.fire(request); } }
		this._register(toDisposable(() => {
			openRequestsReady = false;
			for (const request of [...activeOpenRequests]) {
				settleOpenRequest(request, false, new Error('AI 세션 작업 공간이 닫혀 알림 요청을 완료하지 못했습니다.'));
			}
			pendingOpenRequests.length = 0;
		}));
		window.addEventListener('resize', this.onResize);
		this._register(toDisposable(() => window.removeEventListener('resize', this.onResize)));
	}
	private readonly onResize = () => {
		if (window.innerWidth <= 980 && this.environment.reviewWindowLaunch.kind === 'project') {
			this.layoutService.setPartHidden(false, Parts.ACTIVITYBAR_PART);
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		}
	};
	private async open(activate: boolean, showOnboarding = false, isCurrent: () => boolean = () => true): Promise<IEditorPane | undefined> {
		const launch = this.environment.reviewWindowLaunch;
		if (launch.kind !== 'project') return undefined;
		await this.groups.whenRestored;
		if (!isCurrent()) { return undefined; }
		try {
			if (window.innerWidth > 980) {
				this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
				const sidebar = await this.paneCompositeService.openPaneComposite('workbench.view.devfast.projectSidebar', ViewContainerLocation.Sidebar);
				if (!isCurrent()) { return undefined; }
				if (!sidebar) throw new Error('프로젝트 메뉴를 열지 못했습니다.');
			}
		} catch (error) {
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			this.notificationService.error(error);
		}
		const existing = this.groups.groups.flatMap(group => group.editors.map(editor => ({ editor, group })))
			.find(({ editor }) => editor instanceof AgentSessionWorkspaceEditorInput && editor.projectId === launch.projectId);
		const editorInput = existing?.editor ?? this.instantiationService.createInstance(AgentSessionWorkspaceEditorInput, launch.projectId);
		const group = existing?.group ?? this.groups.activeGroup;
		if (!isCurrent()) { return undefined; }
		const pane = await this.editorService.openEditor(editorInput, { pinned: true, revealIfVisible: true, ...(activate ? {} : { inactive: true, preserveFocus: true }) }, group);
		if (!isCurrent()) { return undefined; }
		if (showOnboarding && pane instanceof AgentSessionWorkspaceEditorPane && pane.matchesProject(launch.projectId)) {
			pane.openOnboardingGuide();
		} else if (showOnboarding) {
			throw new Error('현재 프로젝트의 AI 세션 안내를 열지 못했습니다. 프로젝트 창에서 다시 시도해 주세요.');
		}
		return pane;
	}
}

class OpenAgentSessionOnboardingAction extends Action2 {
	constructor() {
		super({
			id: 'review.openAgentSessionOnboarding',
			title: localize2('review.openAgentSessionOnboarding', 'Whiteboard: AI 세션 안내 다시 열기'),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const environment = accessor.get(INativeWorkbenchEnvironmentService);
		if (environment.reviewWindowLaunch.kind !== 'project') {
			return;
		}
		await openAgentSessionOnboarding();
	}
}

registerAction2(OpenAgentSessionOnboardingAction);

class OpenAgentSessionNotificationAction extends Action2 {
	constructor() {
		super({ id: 'review.openAgentSessionNotification', title: localize2('review.openAgentSessionNotification', 'Whiteboard: AI 세션 알림 열기'), f1: false });
	}

	override async run(accessor: ServicesAccessor, notificationId: string, requestId: string): Promise<void> {
		const environment = accessor.get(INativeWorkbenchEnvironmentService);
		const notificationService = accessor.get(INotificationService);
		const launch = environment.reviewWindowLaunch;
		if (launch.kind !== 'project') { notificationService.error('AI 세션 알림은 해당 프로젝트 창에서만 열 수 있습니다.'); return; }
		let notification: SessionNotificationDTO | null;
		try {
			notification = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'getNotification', {
				projectId: launch.projectId,
				notificationId,
			}) as SessionNotificationDTO | null;
		} catch {
			notificationService.error('저장된 AI 세션 알림을 확인하지 못했습니다. 읽지 않은 상태로 보존했습니다.');
			return;
		}
		if (!notification || notification.id !== notificationId || notification.projectId !== launch.projectId) {
			notificationService.error('저장된 AI 세션 알림을 찾지 못했습니다. 알림은 읽지 않은 상태로 보존했습니다.');
			return;
		}
		if (!await openAgentSessionNotification(notification)) {
			notificationService.error('알림의 정확한 항목을 열지 못했습니다. 알림은 읽지 않은 상태로 보존했습니다.');
			return;
		}
		try {
			const acknowledged = await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'acknowledgeNativeNotificationOpen', {
				projectId: launch.projectId,
				notificationId: notification.id,
				requestId,
			}) as boolean;
			if (!acknowledged) {
				notificationService.error('알림 열기 요청이 만료되었거나 프로젝트 창이 닫혀 읽음 상태를 저장하지 않았습니다.');
				return;
			}
			await ipcRenderer.invoke(WORKSPACE_AGENT_SESSIONS_CHANNEL, 'markNotificationRead', {
				projectId: launch.projectId,
				notificationId: notification.id,
			});
		} catch {
			notificationService.error('알림은 열었지만 읽음 상태를 저장하지 못했습니다.');
		}
	}
}

registerAction2(OpenAgentSessionNotificationAction);

registerWorkbenchContribution2(AgentSessionWorkspaceContribution.ID, AgentSessionWorkspaceContribution, WorkbenchPhase.AfterRestored);
