import { $, clearNode, type Dimension } from '../../../base/browser/dom.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { ipcRenderer } from '../../../base/parts/sandbox/electron-browser/globals.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../workbench/browser/parts/editor/editorPane.js';
import type { IEditorGroup } from '../../../workbench/services/editor/common/editorGroupsService.js';
import type { IEditorOpenContext } from '../../../workbench/common/editor.js';
import { INativeWorkbenchEnvironmentService } from '../../../workbench/services/environment/electron-browser/environmentService.js';
import type { ReorderWorkspaceDashboardTasksRequest, TrashWorkspaceDashboardTaskRequest, UpdateWorkspaceDashboardStateRequest, UpdateWorkspaceDashboardTaskRequest, WorkspaceDashboardDTO, WorkspaceDashboardTaskDTO, WorkspaceDashboardTaskItemDTO, WorkspaceDashboardTaskLifecycleRequest } from '../../../workspace/common/workspaceDashboardProtocol.js';
import { WORKSPACE_DASHBOARD_CHANNEL } from '../../../workspace/common/workspaceDashboardProtocol.js';
import type { OrdinaryFolderMutationGrantDTO, ProviderAttemptDTO, ProviderAttemptEventDTO, ProviderId, ProviderRunPreviewDTO } from '../../../workspace/common/workspaceProviderRunProtocol.js';
import { WORKSPACE_PROVIDER_RUNS_CHANNEL } from '../../../workspace/common/workspaceProviderRunProtocol.js';
import type { WorkspaceKnowledgeDTO } from '../../../workspace/common/workspaceKnowledgeProtocol.js';
import { WORKSPACE_KNOWLEDGE_CHANNEL } from '../../../workspace/common/workspaceKnowledgeProtocol.js';
import type { WorkspaceConnectorAccountDTO, WorkspaceConnectorId } from '../../../workspace/common/workspaceConnectorProtocol.js';
import { WORKSPACE_CONNECTOR_CHANNEL } from '../../../workspace/common/workspaceConnectorProtocol.js';
import type { WorkspaceInstalledPackageDTO, WorkspacePackageReviewDTO, WorkspaceSignedPackageEnvelope } from '../../../workspace/common/workspacePackageConnectorProtocol.js';
import { WORKSPACE_PACKAGE_CONNECTOR_CHANNEL } from '../../../workspace/common/workspacePackageConnectorProtocol.js';
import { WORKSPACE_EGO_CAPTURE_CHANNEL, type WorkspaceEgoCaptureRecoveryStatus, type WorkspaceEgoCaptureStatus } from '../../../workspace/common/workspaceBrowserCaptureProtocol.js';
import { WORKSPACE_E2E_CHANNEL, type WorkspaceE2eEvidenceDTO, type WorkspaceE2eStep } from '../../../workspace/common/workspaceE2eProtocol.js';
import { WORKSPACE_CONVENTION_AGENT_CHANNEL, type ConventionAgentPreviewDTO, type ConventionAgentResultDTO } from '../../../workspace/common/workspaceConventionAgentProtocol.js';
import { WORKSPACE_REVIEW_BRIDGE_CHANNEL, type WorkspaceTaskReviewLink, type TaskReviewAvailability, type TaskReviewOpenResult } from '../../../workspace/common/workspaceReviewBridgeProtocol.js';
import { IReviewCanvasEditorTabsService } from '../../services/reviewCanvasEditorTabsService.js';
import { ProjectDashboardEditorInput } from './projectDashboardEditorInput.js';

import './projectDashboard.css';

const columns = [
	{ state: 'ready', label: 'Ready' },
	{ state: 'inProgress', label: 'In progress' },
	{ state: 'review', label: 'Review' },
	{ state: 'done', label: 'Done' },
] as const;
type DashboardTaskState = WorkspaceDashboardTaskItemDTO['state'];
type DashboardTaskView = 'board' | 'archived' | 'trash';
type KnowledgeView = 'references' | 'conventions';

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className) element.className = className;
	return element;
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
	private creating = false;
	private createFormOpen = false;
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
	private e2eEnvironmentDraft = 'local macOS';
	private e2eScenarioDraft: { type: WorkspaceE2eStep['type']; selector: string; value: string }[] = [{ type: 'assertText', selector: 'h1', value: '' }];
	private providerError: string | undefined;
	private providerErrorKind: 'operation' | 'history' | undefined;
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
	private knowledgeView: KnowledgeView = 'references';
	private connectorManagementOpen = false;
	private focusTaskDetailOnRender = false;
	private knowledgeBusy = false;
	private referenceTitleDraft = '';
	private referenceContentDraft = '';
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
	private connectorImportAccountId = '';
	private connectorImportIdDraft = '';
	private connectorImportTitleDraft = '';
	private connectorImportMessageTsDraft = '';
	private installedPackages: readonly WorkspaceInstalledPackageDTO[] = [];
	private packageReview: WorkspacePackageReviewDTO | undefined;
	private packageEnvelope: WorkspaceSignedPackageEnvelope | undefined;
	private packageBusy = false;
	private packageLoading = false;
	private packageError: string | undefined;
	private packageMessage: string | undefined;
	private packageFileName = '';
	private readonly packageSourceIds = new Map<string, string>();
	private packageSourceKey = '';
	private readonly refreshOnReturn = () => {
		if (document.visibilityState === 'visible' && this.selectedTaskId) void this.loadAttempts();
	};
	private readonly persistScrollPosition = () => {
		if (!this.inputActive) return;
		if (this.programmaticScrollTarget !== undefined) {
			this.programmaticScrollTarget = undefined;
			if (this.programmaticScrollTimer) clearTimeout(this.programmaticScrollTimer);
			this.programmaticScrollTimer = undefined;
			return;
		}
		const position = Math.min(10_000_000, Math.max(0, Math.floor(this.root?.scrollTop ?? 0))).toString();
		if (position === this.lastSavedDashboardPosition && (!this.pendingDashboardState || this.pendingDashboardState.request.dashboardPosition === position)) return;
		this.scheduleDashboardStateSave(true);
	};

	constructor(group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@INativeWorkbenchEnvironmentService private readonly environment: INativeWorkbenchEnvironmentService,
		@IReviewCanvasEditorTabsService private readonly reviewTabs: IReviewCanvasEditorTabsService) {
		super(ProjectDashboardEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = $('.project-dashboard');
		this.root.tabIndex = 0;
		parent.appendChild(this.root);
		this.root.addEventListener('scroll', this.persistScrollPosition, { passive: true });
		document.addEventListener('visibilitychange', this.refreshOnReturn);
		window.addEventListener('focus', this.refreshOnReturn);
	}

	override async setInput(input: ProjectDashboardEditorInput, options: unknown, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await this.closeEgoCapture();
		await this.flushDashboardState();
		await super.setInput(input, options as never, context, token);
		this.inputActive = true;
		this.stopPolling();
		this.taskView = 'board';
		this.dashboard = undefined;
		this.error = undefined;
		this.knowledge = undefined;
		this.knowledgeLoading = false;
		this.knowledgeError = undefined;
		this.knowledgeMessage = undefined;
		this.connectorAccounts = [];
		this.connectorLoading = false;
		this.connectorError = undefined;
		this.connectorMessage = undefined;
		this.connectorTokenDraft = '';
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
		this.conventionSourceIdsDraft.clear();
		this.egoStatus = undefined;
		if (!this.egoCaptureId) { this.egoTaskId = undefined; this.egoProjectId = undefined; this.egoError = undefined; }
		this.conventionAgentPreview = undefined; this.conventionAgentResult = undefined; this.conventionAgentError = undefined; this.conventionAgentNotice = undefined;
		this.reviewLinks = []; this.reviewPendingCreates = []; this.reviewLinksTaskId = undefined; this.reviewAvailabilityError = undefined; this.reviewBridgeError = undefined; this.reviewBridgeNotice = undefined;
		this.trashConfirmationTaskId = undefined;
		this.selectedTaskId = undefined;
		this.preview = undefined;
		this.folderMutationGrant = undefined;
		this.attempts = [];
		this.e2eEvidence = []; this.e2eLoadedTaskId = undefined; this.e2eError = undefined; this.e2eScenarioDraft = [{ type: 'assertText', selector: 'h1', value: '' }];
		this.providerError = undefined;
		this.providerErrorKind = undefined;
		if (token.isCancellationRequested) return;
		if (this.environment.reviewWindowLaunch.kind !== 'project' || this.environment.reviewWindowLaunch.projectId !== input.projectId) {
			this.error = 'This dashboard does not belong to the current project window.';
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
			this.pendingDashboardPosition = savedPosition === null ? undefined : Math.min(10_000_000, Number(savedPosition));
		} catch (error) {
			this.error = error instanceof Error ? error.message : 'Could not load this project.';
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
				if (!accounts.some(account => account.id === this.connectorImportAccountId && account.state === 'active')) this.connectorImportAccountId = accounts.find(account => account.provider === this.connectorProvider && account.state === 'active')?.id ?? accounts.find(account => account.state === 'active')?.id ?? '';
			}
		} catch (error) {
			if (this.projectId === projectId) this.connectorError = this.errorMessage(error, 'Could not load connected accounts.');
		} finally {
			if (this.projectId === projectId) { this.connectorLoading = false; this.render(); }
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
			if (this.projectId === projectId) this.connectorError = this.errorMessage(error, 'The connector action could not be completed.');
		} finally {
			this.connectorBusy = false;
			this.render();
		}
	}

	private renderConnectors(panel: HTMLElement): void {
		const projectId = this.projectId;
		const section = panel.appendChild($('.project-dashboard__connectors'));
		const heading = section.appendChild($('.project-dashboard__knowledge-section-heading'));
		const title = heading.appendChild($('h3')); title.textContent = 'Connected sources';
		const intro = section.appendChild($('p')); intro.className = 'project-dashboard__connector-note'; intro.textContent = 'Connect accounts for this project window. Credentials are stored in macOS Keychain; this screen only shows account metadata.';
		if (this.connectorError) { const error = section.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert'); const text = error.appendChild($('span')); text.textContent = this.connectorError; const retry = error.appendChild(createElement('button', 'project-dashboard__retry')); retry.type = 'button'; retry.textContent = 'Retry'; retry.addEventListener('click', () => void this.loadConnectorAccounts()); }
		if (this.connectorMessage) { const status = section.appendChild($('.project-dashboard__knowledge-success')); status.setAttribute('role', 'status'); status.textContent = this.connectorMessage; }
		if (this.connectorLoading) { const status = section.appendChild($('.project-dashboard__status')); status.setAttribute('role', 'status'); status.textContent = 'Loading connected accounts…'; }
		const accounts = section.appendChild($('.project-dashboard__connector-accounts'));
		for (const account of this.connectorAccounts) {
			const row = accounts.appendChild($('.project-dashboard__connector-account'));
			const details = row.appendChild($('.project-dashboard__connector-account-main'));
			const label = details.appendChild($('strong')); label.textContent = `${account.provider === 'slack' ? 'Slack' : 'Notion'} · ${account.label}`;
			const meta = details.appendChild($('span')); meta.textContent = `${account.remoteIdentity} · ${account.state === 'active' ? 'Connected' : 'Keychain cleanup pending'}`;
			const action = row.appendChild(createElement('button', 'project-dashboard__secondary')); action.type = 'button'; action.disabled = this.connectorBusy;
			action.textContent = account.state === 'active' ? 'Disconnect' : 'Retry cleanup';
			action.addEventListener('click', () => { if (!projectId) return; void this.runConnectorAction(() => ipcRenderer.invoke(WORKSPACE_CONNECTOR_CHANNEL, account.state === 'active' ? 'disconnectAccount' : 'retryAccountCleanup', { projectId, accountId: account.id }), account.state === 'active' ? 'Account disconnected.' : 'Keychain cleanup completed.'); });
		}
		const form = section.appendChild(createElement('form', 'project-dashboard__connector-connect'));
		const formTitle = form.appendChild($('h4')); formTitle.textContent = 'Connect an account';
		const providerLabel = form.appendChild(createElement('label')); providerLabel.htmlFor = 'connector-provider'; providerLabel.textContent = 'Service';
		const provider = form.appendChild(createElement('select')); provider.id = 'connector-provider'; provider.disabled = this.connectorBusy;
		for (const [value, text] of [['slack', 'Slack'], ['notion', 'Notion']] as const) { const option = provider.appendChild($('option') as HTMLOptionElement); option.value = value; option.textContent = text; }
		provider.value = this.connectorProvider; provider.addEventListener('change', () => { this.connectorProvider = provider.value as WorkspaceConnectorId; });
		const tokenLabel = form.appendChild(createElement('label')); tokenLabel.htmlFor = 'connector-token'; tokenLabel.textContent = 'Access token';
		const token = form.appendChild(createElement('input')); token.id = 'connector-token'; token.type = 'password'; token.autocomplete = 'off'; token.spellcheck = false; token.required = true; token.value = this.connectorTokenDraft; token.disabled = this.connectorBusy; token.dataset.focusKey = 'connector-token';
		token.addEventListener('input', () => { this.connectorTokenDraft = token.value; });
		const tokenHelp = form.appendChild($('p')); tokenHelp.className = 'project-dashboard__connector-note'; tokenHelp.textContent = 'Paste a Slack user token (xoxp-) or a Notion integration token. The field is cleared after submission.';
		const connectActions = form.appendChild($('.project-dashboard__form-actions'));
		const connect = connectActions.appendChild(createElement('button', 'project-dashboard__primary')); connect.type = 'submit'; connect.disabled = this.connectorBusy; connect.textContent = this.connectorBusy ? 'Connecting…' : 'Connect';
		form.addEventListener('submit', event => { event.preventDefault(); const tokenValue = token.value; if (!projectId || !tokenValue) return; token.value = ''; this.connectorTokenDraft = ''; void this.runConnectorAction(() => ipcRenderer.invoke(WORKSPACE_CONNECTOR_CHANNEL, 'connectAccount', { projectId, provider: this.connectorProvider, token: tokenValue }), 'Account connected.'); });
		const importForm = section.appendChild(createElement('form', 'project-dashboard__connector-import'));
		const importTitle = importForm.appendChild($('h4')); importTitle.textContent = 'Import a conversation or page';
		const accountLabel = importForm.appendChild(createElement('label')); accountLabel.htmlFor = 'connector-account'; accountLabel.textContent = 'Connected account';
		const accountSelect = importForm.appendChild(createElement('select')); accountSelect.id = 'connector-account'; accountSelect.disabled = this.connectorBusy;
		for (const account of this.connectorAccounts.filter(item => item.state === 'active')) { const option = accountSelect.appendChild($('option') as HTMLOptionElement); option.value = account.id; option.textContent = `${account.provider === 'slack' ? 'Slack' : 'Notion'} · ${account.label}`; }
		accountSelect.value = this.connectorImportAccountId;
		const selectedAccount = () => this.connectorAccounts.find(item => item.id === accountSelect.value && item.state === 'active');
		accountSelect.addEventListener('change', () => { this.connectorImportAccountId = accountSelect.value; messageTsField.hidden = selectedAccount()?.provider !== 'slack'; });
		const idLabel = importForm.appendChild(createElement('label')); idLabel.htmlFor = 'connector-remote-id'; idLabel.textContent = 'Slack channel ID or Notion page ID';
		const remoteId = importForm.appendChild(createElement('input')); remoteId.id = 'connector-remote-id'; remoteId.required = true; remoteId.autocomplete = 'off'; remoteId.placeholder = 'Slack: C… · Notion: page UUID'; remoteId.value = this.connectorImportIdDraft; remoteId.disabled = this.connectorBusy || !this.connectorAccounts.some(account => account.state === 'active'); remoteId.dataset.focusKey = 'connector-remote-id'; remoteId.addEventListener('input', () => { this.connectorImportIdDraft = remoteId.value; });
		const messageTsField = importForm.appendChild(createElement('div')); messageTsField.hidden = selectedAccount()?.provider !== 'slack';
		const messageTsLabel = messageTsField.appendChild(createElement('label')); messageTsLabel.htmlFor = 'connector-slack-message-ts'; messageTsLabel.textContent = 'Slack message timestamp (optional)';
		const messageTs = messageTsField.appendChild(createElement('input')); messageTs.id = 'connector-slack-message-ts'; messageTs.type = 'text'; messageTs.autocomplete = 'off'; messageTs.placeholder = '1712345678.123456'; messageTs.value = this.connectorImportMessageTsDraft; messageTs.disabled = this.connectorBusy; messageTs.dataset.focusKey = 'connector-slack-message-ts'; messageTs.addEventListener('input', () => { this.connectorImportMessageTsDraft = messageTs.value; });
		const messageTsHelp = messageTsField.appendChild($('p')); messageTsHelp.className = 'project-dashboard__connector-note'; messageTsHelp.textContent = 'Leave blank to import the channel conversation. Add a message timestamp to import that message and its thread replies.';
		const titleLabel = importForm.appendChild(createElement('label')); titleLabel.htmlFor = 'connector-import-title'; titleLabel.textContent = 'Title (optional for Slack)';
		const remoteTitle = importForm.appendChild(createElement('input')); remoteTitle.id = 'connector-import-title'; remoteTitle.value = this.connectorImportTitleDraft; remoteTitle.disabled = this.connectorBusy; remoteTitle.dataset.focusKey = 'connector-import-title'; remoteTitle.addEventListener('input', () => { this.connectorImportTitleDraft = remoteTitle.value; });
		const importActions = importForm.appendChild($('.project-dashboard__form-actions'));
		const doImport = importActions.appendChild(createElement('button', 'project-dashboard__primary')); doImport.type = 'submit'; doImport.disabled = this.connectorBusy || !this.connectorImportAccountId || !this.connectorAccounts.some(account => account.id === this.connectorImportAccountId && account.state === 'active'); doImport.textContent = this.connectorBusy ? 'Importing…' : 'Import source';
		importForm.addEventListener('submit', event => {
			event.preventDefault();
			const account = selectedAccount(); const externalId = remoteId.value.trim();
			if (!projectId || !account || !externalId) return;
			const taskId = this.selectedTaskId;
			const command = account.provider === 'slack' ? 'importSlackConversation' : 'importNotionPage';
			const messageTimestamp = messageTs.value.trim();
			const payload = account.provider === 'slack'
				? { projectId, accountId: account.id, channelId: externalId, title: remoteTitle.value.trim() || undefined, ...(messageTimestamp ? { messageTs: messageTimestamp } : {}) }
				: { projectId, accountId: account.id, pageId: externalId };
			void this.runConnectorAction(async () => {
				const reference = await ipcRenderer.invoke(WORKSPACE_CONNECTOR_CHANNEL, command, payload) as { id: string };
				if (taskId) await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'attachTaskReference', { projectId, taskId, snapshotId: reference.id });
				if (this.projectId === projectId) {
					this.connectorImportIdDraft = ''; this.connectorImportTitleDraft = ''; this.connectorImportMessageTsDraft = '';
					this.knowledgeMessage = taskId ? 'Source imported and linked to the original task.' : 'Source imported. Select a task to link it.';
					await this.loadKnowledge();
				}
			}, 'Source imported.');
		});
		this.renderPackageConnectors(panel);
	}

	private async loadInstalledPackages(): Promise<void> {
		const projectId = this.projectId;
		if (!projectId) return;
		this.packageLoading = true;
		this.packageError = undefined;
		this.render();
		try {
			const packages = await ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'listPackages', projectId) as readonly WorkspaceInstalledPackageDTO[];
			if (this.projectId === projectId) this.installedPackages = packages;
		} catch (error) {
			if (this.projectId === projectId) this.packageError = this.errorMessage(error, 'Could not load installed connector packages.');
		} finally {
			if (this.projectId === projectId) { this.packageLoading = false; this.render(); }
		}
	}

	private async runPackageAction(action: () => Promise<unknown>, successMessage: string, reload = true): Promise<void> {
		if (this.packageBusy) return;
		const projectId = this.projectId;
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
			if (this.projectId === projectId) this.packageError = this.errorMessage(error, 'The connector package action could not be completed.');
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
			this.packageError = 'Choose a non-empty JSON envelope file no larger than 192 KiB.';
			this.render();
			return;
		}
		this.packageBusy = true;
		this.render();
		try {
			const parsed: unknown = JSON.parse(await file.text());
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The file must contain a signed package envelope object.');
			const envelope = parsed as Partial<WorkspaceSignedPackageEnvelope>;
			if (typeof envelope.manifestBytesBase64 !== 'string' || typeof envelope.signatureBase64 !== 'string' || typeof envelope.publicKeyBase64 !== 'string'
				|| Object.keys(parsed).length !== 3 || !Object.keys(parsed).every(key => ['manifestBytesBase64', 'signatureBase64', 'publicKeyBase64'].includes(key))) {
				throw new Error('The JSON must contain only manifestBytesBase64, signatureBase64, and publicKeyBase64.');
			}
			const review = await ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'reviewPackage', { projectId, envelope }) as WorkspacePackageReviewDTO;
			if (this.projectId === projectId) { this.packageEnvelope = envelope as WorkspaceSignedPackageEnvelope; this.packageReview = review; }
		} catch (error) {
			if (this.projectId === projectId) this.packageError = this.errorMessage(error, 'Could not review this signed package.');
		} finally {
			if (this.projectId === projectId) { this.packageBusy = false; this.render(); }
		}
	}

	private renderPackageConnectors(panel: HTMLElement): void {
		const projectId = this.projectId;
		const section = panel.appendChild($('.project-dashboard__package-connectors'));
		const heading = section.appendChild($('.project-dashboard__knowledge-section-heading'));
		const title = heading.appendChild($('h3')); title.textContent = 'Signed local connector packages';
		const note = section.appendChild($('p')); note.className = 'project-dashboard__connector-note'; note.textContent = 'Packages contain declarative HTTPS source rules only. They cannot run code or access account credentials. Review domains and signing details before installing.';
		if (this.packageError) { const error = section.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert'); const text = error.appendChild($('span')); text.textContent = this.packageError; const retry = error.appendChild(createElement('button', 'project-dashboard__retry')); retry.type = 'button'; retry.textContent = 'Retry list'; retry.addEventListener('click', () => void this.loadInstalledPackages()); }
		if (this.packageMessage) { const message = section.appendChild($('.project-dashboard__knowledge-success')); message.setAttribute('role', 'status'); message.textContent = this.packageMessage; }
		if (this.packageLoading) { const status = section.appendChild($('.project-dashboard__status')); status.setAttribute('role', 'status'); status.textContent = 'Loading installed packages…'; }
		const upload = section.appendChild(createElement('div', 'project-dashboard__package-upload'));
		const uploadLabel = upload.appendChild(createElement('label')); uploadLabel.htmlFor = 'connector-package-file'; uploadLabel.textContent = 'Choose signed package JSON envelope';
		const fileInput = upload.appendChild(createElement('input')); fileInput.id = 'connector-package-file'; fileInput.type = 'file'; fileInput.accept = '.json,application/json'; fileInput.disabled = this.packageBusy; fileInput.dataset.focusKey = 'connector-package-file';
		const fileHint = upload.appendChild($('p')); fileHint.className = 'project-dashboard__connector-note'; fileHint.textContent = this.packageFileName ? `Selected: ${this.packageFileName} · Maximum 192 KiB` : 'Select a local .json envelope · Maximum 192 KiB';
		fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void this.reviewPackageFile(file); });
		if (this.packageBusy) { const status = section.appendChild($('.project-dashboard__status')); status.setAttribute('role', 'status'); status.textContent = this.packageReview ? 'Waiting for package confirmation…' : 'Reviewing package signature…'; }
		if (this.packageReview) {
			const review = section.appendChild($('.project-dashboard__package-review'));
			const title = review.appendChild($('h4')); title.textContent = `${this.packageReview.name} · v${this.packageReview.version}`;
			const description = review.appendChild($('p')); description.textContent = this.packageReview.description;
			const metadata = review.appendChild($('dl'));
			for (const [label, value] of [
				['Package ID', this.packageReview.packageId], ['Trust', this.packageReview.trustStatus],
				['Signing fingerprint', this.packageReview.fingerprint], ['Manifest digest (SHA-256)', this.packageReview.manifestDigest],
				['Account access', 'None'],
			] as const) { const term = metadata.appendChild($('dt')); term.textContent = label; const detail = metadata.appendChild($('dd')); detail.textContent = value; }
			const domainsTitle = review.appendChild($('h5')); domainsTitle.textContent = 'All network domains';
			const domains = review.appendChild($('ul')); for (const domain of this.packageReview.domains) { const item = domains.appendChild($('li')); item.textContent = domain; }
			const sourcesTitle = review.appendChild($('h5')); sourcesTitle.textContent = 'Sources included';
			const sources = review.appendChild($('ul')); for (const source of this.packageReview.sources) { const item = sources.appendChild($('li')); item.textContent = source.label; }
			const rulesTitle = review.appendChild($('h5')); rulesTitle.textContent = 'Exact collection rules';
			const rules = review.appendChild($('.project-dashboard__package-rules'));
			for (const rule of this.packageReview.sourceRules) {
				const ruleCard = rules.appendChild($('.project-dashboard__package-rule'));
				const ruleTitle = ruleCard.appendChild($('strong')); ruleTitle.textContent = rule.label;
				const ruleRoute = ruleCard.appendChild($('code')); ruleRoute.textContent = `${rule.domain} · ${rule.method} ${rule.path}`;
				const ruleFields = ruleCard.appendChild($('p')); ruleFields.textContent = `Fields: ${rule.fields.join(', ')}`;
				const rulePagination = ruleCard.appendChild($('p')); rulePagination.textContent = `Pagination: ${rule.paginated ? 'enabled using the signed rule' : 'disabled'}`;
			}
			const existing = this.installedPackages.find(item => item.packageId === this.packageReview!.packageId);
			const consent = section.appendChild(createElement('button', 'project-dashboard__primary')); consent.type = 'button'; consent.disabled = this.packageBusy || !this.packageEnvelope;
			consent.textContent = this.packageBusy ? 'Awaiting confirmation…' : existing ? 'Approve update and install' : 'Approve and install';
			consent.addEventListener('click', () => {
				const currentReview = this.packageReview; const envelope = this.packageEnvelope;
				if (!projectId || !currentReview || !envelope) return;
				const approval = { packageId: currentReview.packageId, version: currentReview.version, fingerprint: currentReview.fingerprint, manifestDigest: currentReview.manifestDigest };
				void this.runPackageAction(async () => {
					await ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'installPackage', { projectId, envelope, approval });
					if (this.projectId === projectId && this.packageEnvelope === envelope) {
						this.packageReview = undefined; this.packageEnvelope = undefined; this.packageFileName = '';
					}
				}, 'Package installation confirmed and completed.');
			});
		}
		const installedHeading = section.appendChild($('.project-dashboard__knowledge-section-heading'));
		const installedTitle = installedHeading.appendChild($('h4')); installedTitle.textContent = 'Installed packages';
		if (!this.installedPackages.length && !this.packageLoading) { const empty = section.appendChild($('.project-dashboard__knowledge-empty')); empty.textContent = 'No local connector packages are installed in this project.'; }
		for (const installed of this.installedPackages) {
			const card = section.appendChild($('.project-dashboard__package-card'));
			const packageTitle = card.appendChild($('h4')); packageTitle.textContent = `${installed.name} · v${installed.version}`;
			const packageMeta = card.appendChild($('p')); packageMeta.textContent = `${installed.packageId} · Key ${installed.fingerprint} · Updated ${new Date(installed.updatedAt).toLocaleDateString()}`;
			const sourceForm = card.appendChild(createElement('form', 'project-dashboard__package-import'));
			const sourceLabel = sourceForm.appendChild(createElement('label')); sourceLabel.htmlFor = `package-source-${installed.packageId}`; sourceLabel.textContent = 'Source';
			const sourceSelect = sourceForm.appendChild(createElement('select')); sourceSelect.id = `package-source-${installed.packageId}`; sourceSelect.required = true; sourceSelect.disabled = this.packageBusy;
			for (const source of installed.sources) { const option = sourceSelect.appendChild($('option') as HTMLOptionElement); option.value = source.sourceId; option.textContent = source.label; }
			if (!installed.sources.some(source => source.sourceId === this.packageSourceIds.get(installed.packageId))) this.packageSourceIds.set(installed.packageId, installed.sources[0]?.sourceId ?? '');
			sourceSelect.value = this.packageSourceIds.get(installed.packageId) ?? ''; sourceSelect.addEventListener('change', () => { this.packageSourceIds.set(installed.packageId, sourceSelect.value); });
			const keyLabel = sourceForm.appendChild(createElement('label')); keyLabel.htmlFor = `package-source-key-${installed.packageId}`; keyLabel.textContent = 'Remote resource ID';
			const sourceKey = sourceForm.appendChild(createElement('input')); sourceKey.id = `package-source-key-${installed.packageId}`; sourceKey.required = true; sourceKey.autocomplete = 'off'; sourceKey.placeholder = 'Enter the resource identifier'; sourceKey.value = this.packageSourceKey; sourceKey.disabled = this.packageBusy; sourceKey.dataset.focusKey = 'package-source-key'; sourceKey.addEventListener('input', () => { this.packageSourceKey = sourceKey.value; });
			const importButton = sourceForm.appendChild(createElement('button', 'project-dashboard__secondary')); importButton.type = 'submit'; importButton.disabled = this.packageBusy || !installed.sources.length; importButton.textContent = this.packageBusy ? 'Importing…' : 'Import source';
			sourceForm.addEventListener('submit', event => {
				event.preventDefault();
				const sourceKeyValue = sourceKey.value.trim(); const sourceId = sourceSelect.value;
				if (!projectId || !sourceKeyValue || !sourceId) return;
				const taskId = this.selectedTaskId;
				void this.runPackageAction(async () => {
					const reference = await ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'importPackageSource', { projectId, packageId: installed.packageId, sourceId, sourceKey: sourceKeyValue }) as { id: string };
					if (taskId) await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'attachTaskReference', { projectId, taskId, snapshotId: reference.id });
					if (this.projectId === projectId) { this.packageSourceKey = ''; await this.loadKnowledge(); }
				}, taskId ? 'Source imported and linked to the original task.' : 'Source imported. Select a task to link it.');
			});
			const uninstall = card.appendChild(createElement('button', 'project-dashboard__danger')); uninstall.type = 'button'; uninstall.disabled = this.packageBusy; uninstall.textContent = 'Uninstall package'; uninstall.addEventListener('click', () => { if (!projectId) return; void this.runPackageAction(() => ipcRenderer.invoke(WORKSPACE_PACKAGE_CONNECTOR_CHANNEL, 'uninstallPackage', { projectId, packageId: installed.packageId }), 'Package uninstalled.'); });
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
			if (this.projectId === projectId) this.knowledgeError = this.errorMessage(error, 'Could not load project references and conventions.');
		} finally {
			if (this.projectId === projectId) { this.knowledgeLoading = false; this.render(); }
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
			await this.loadKnowledge();
		} catch (error) {
			this.knowledgeError = this.errorMessage(error, 'Could not save this project knowledge.');
		} finally {
			this.knowledgeBusy = false;
			this.render();
		}
	}

	private renderKnowledge(shell: HTMLElement): void {
		const section = shell.appendChild($('.project-dashboard__knowledge'));
		const heading = section.appendChild($('.project-dashboard__knowledge-heading'));
		const copy = heading.appendChild($('.project-dashboard__knowledge-copy'));
		const eyebrow = copy.appendChild($('.project-dashboard__eyebrow')); eyebrow.textContent = 'PROJECT KNOWLEDGE';
		const title = copy.appendChild($('h2')); title.textContent = 'References and conventions';
		const description = copy.appendChild($('p')); description.textContent = 'Keep source notes and project guidance together, and bring in material from connected work tools.';
		const tabs = section.appendChild($('.project-dashboard__knowledge-tabs'));
		tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Project knowledge');
		for (const [view, label] of [['references', 'References'], ['conventions', 'Conventions']] as const) {
			const tab = tabs.appendChild(createElement('button', 'project-dashboard__knowledge-tab'));
			tab.type = 'button'; tab.id = `knowledge-tab-${view}`; tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', String(this.knowledgeView === view)); tab.setAttribute('aria-controls', 'project-knowledge-panel');
			tab.tabIndex = this.knowledgeView === view ? 0 : -1; tab.textContent = label; tab.dataset.focusKey = `knowledge-tab:${view}`;
			tab.addEventListener('click', () => { this.knowledgeView = view; this.render(); this.root?.querySelector<HTMLElement>(`#knowledge-tab-${view}`)?.focus({ preventScroll: true }); });
			tab.addEventListener('keydown', event => {
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
				event.preventDefault(); this.knowledgeView = this.knowledgeView === 'references' ? 'conventions' : 'references';
				this.render(); this.root?.querySelector<HTMLElement>(`#knowledge-tab-${this.knowledgeView}`)?.focus({ preventScroll: true });
			});
		}
		const panel = section.appendChild($('.project-dashboard__knowledge-panel'));
		panel.id = 'project-knowledge-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `knowledge-tab-${this.knowledgeView}`); panel.tabIndex = 0;
		if (this.knowledgeLoading) { const status = panel.appendChild($('.project-dashboard__status')); status.setAttribute('role', 'status'); status.textContent = 'Loading project knowledge…'; return; }
		if (this.knowledgeError) {
			const error = panel.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert');
			const text = error.appendChild($('span')); text.textContent = this.knowledgeError;
			const retry = error.appendChild(createElement('button', 'project-dashboard__retry')); retry.type = 'button'; retry.textContent = 'Retry'; retry.addEventListener('click', () => void this.loadKnowledge());
		}
		if (this.knowledgeMessage) { const message = panel.appendChild($('.project-dashboard__knowledge-success')); message.setAttribute('role', 'status'); message.textContent = this.knowledgeMessage; }
		if (!this.knowledge) {
			const status = panel.appendChild($('.project-dashboard__status')); status.textContent = 'Project knowledge is not available yet.';
			this.renderConnectorManagement(panel);
			return;
		}
		if (this.knowledgeView === 'references') this.renderProjectReferences(panel);
		else this.renderProjectConventions(panel);
		this.renderConnectorManagement(panel);
	}

	private renderConnectorManagement(panel: HTMLElement): void {
		const details = panel.appendChild(createElement('details', 'project-dashboard__connector-management'));
		details.open = this.connectorManagementOpen;
		details.addEventListener('toggle', () => { this.connectorManagementOpen = details.open; });
		const summary = details.appendChild(createElement('summary'));
		summary.textContent = 'Connected accounts and packages';
		const content = details.appendChild(createElement('div'));
		this.renderConnectors(content);
	}

	private renderProjectReferences(panel: HTMLElement): void {
		const knowledge = this.knowledge!;
		const capture = panel.appendChild($('.project-dashboard__flow-card'));
		const captureTitle = capture.appendChild($('h3')); captureTitle.textContent = 'Capture selected text from Ego';
		const captureNote = capture.appendChild($('p')); captureNote.textContent = 'Open a URL in Ego, select the text you want, then explicitly capture it. No page content is collected automatically.';
		const captureForm = capture.appendChild(createElement('form', 'project-dashboard__knowledge-form'));
		const urlLabel = captureForm.appendChild(createElement('label')); urlLabel.htmlFor = 'ego-capture-url'; urlLabel.textContent = 'Start URL';
		const url = captureForm.appendChild(createElement('input')); url.id = 'ego-capture-url'; url.type = 'url'; url.required = true; url.placeholder = 'https://…'; url.value = this.egoUrlDraft; url.disabled = this.egoBusy;
		url.addEventListener('input', () => this.egoUrlDraft = url.value);
		const captureActions = captureForm.appendChild($('.project-dashboard__form-actions'));
		const start = captureActions.appendChild(createElement('button', 'project-dashboard__primary')); start.type = 'submit'; start.textContent = this.egoBusy ? 'Working…' : 'Open in Ego'; start.disabled = this.egoBusy || !!this.egoCaptureId || !this.selectedTaskId;
		captureForm.addEventListener('submit', event => { event.preventDefault(); if (this.selectedTaskId && this.projectId) void this.startEgoCapture(url.value.trim()); });
		if (!this.selectedTaskId) { const hint = capture.appendChild($('.project-dashboard__flow-status')); hint.textContent = 'Select a task on the board to link a captured reference.'; }
		if (this.egoCaptureId) {
			const instructions = capture.appendChild($('.project-dashboard__flow-status')); instructions.setAttribute('role', 'status'); instructions.textContent = this.egoCleanupPending ? 'Ego did not confirm startup cleanup. Close this session before starting another capture.' : this.egoStatus?.state === 'handoff' ? 'Ego is open. Select text there, then return here and choose Capture selection. You can cancel at any time.' : 'An Ego capture session is still owned by this dashboard. Close it before starting another session.';
			const actions = capture.appendChild($('.project-dashboard__flow-actions'));
			if (this.egoStatus?.state === 'handoff' && !this.egoCleanupPending) { const confirm = actions.appendChild(createElement('button', 'project-dashboard__primary')); confirm.type = 'button'; confirm.textContent = 'Capture selection'; confirm.disabled = this.egoBusy; confirm.addEventListener('click', () => void this.finishEgoCapture(false)); }
			const cancel = actions.appendChild(createElement('button', 'project-dashboard__secondary')); cancel.type = 'button'; cancel.textContent = this.egoCleanupPending || this.egoStatus?.state === 'failed' ? 'Retry close Ego' : 'Cancel'; cancel.disabled = this.egoBusy; cancel.addEventListener('click', () => void this.closeEgoCapture());
		}
		if (this.egoError || this.egoStatus?.state === 'failed') { const error = capture.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert'); error.textContent = this.egoError ?? (this.egoStatus?.state === 'failed' ? this.egoStatus.message : 'Ego capture failed.'); }
		if (this.egoStatus?.state === 'captured') { const done = capture.appendChild($('.project-dashboard__flow-status')); done.setAttribute('role', 'status'); done.textContent = `Captured “${this.egoStatus.reference.title}” and linked it to ${this.egoCapturedTaskTitle ?? 'the original task'}.`; }
		if (this.egoStatus?.state === 'cancelled') { const cancelled = capture.appendChild($('.project-dashboard__flow-status')); cancelled.setAttribute('role', 'status'); cancelled.textContent = 'Ego capture cancelled.'; }
		const heading = panel.appendChild($('.project-dashboard__knowledge-section-heading'));
		const title = heading.appendChild($('h3')); title.textContent = 'Source references';
		const count = heading.appendChild($('span')); count.textContent = `${knowledge.references.length} ${knowledge.references.length === 1 ? 'reference' : 'references'}`;
		if (!knowledge.references.length) { const empty = panel.appendChild($('.project-dashboard__knowledge-empty')); empty.textContent = 'No references yet. Add a text note or paste source material to keep it with this project.'; }
		else {
			const list = panel.appendChild($('.project-dashboard__knowledge-list'));
			for (const reference of knowledge.references) {
				const row = list.appendChild($('.project-dashboard__knowledge-card'));
				const main = row.appendChild($('.project-dashboard__knowledge-card-main'));
				const name = main.appendChild($('h4')); name.textContent = reference.title;
				const meta = main.appendChild($('p')); meta.textContent = `${reference.connectorId} · Version ${reference.version} · Added ${new Date(reference.retrievedAt).toLocaleDateString()}`;
				const linked = Object.entries(knowledge.taskReferences).filter(([, refs]) => refs.some(item => item.id === reference.id)).map(([taskId]) => this.dashboard?.tasks.find(task => task.id === taskId)?.title).filter((value): value is string => !!value);
				const linkedTo = main.appendChild($('p')); linkedTo.className = 'project-dashboard__knowledge-linked'; linkedTo.textContent = linked.length ? `Linked to: ${linked.join(', ')}` : 'Not linked to a task';
				if (reference.sourceUri) { const uri = main.appendChild($('a') as HTMLAnchorElement); uri.href = reference.sourceUri; uri.target = '_blank'; uri.rel = 'noreferrer'; uri.textContent = reference.sourceUri; uri.className = 'project-dashboard__knowledge-uri'; }
				if (this.selectedTaskId && !knowledge.taskReferences[this.selectedTaskId]?.some(item => item.id === reference.id)) {
					const attach = row.appendChild(createElement('button', 'project-dashboard__secondary')); attach.type = 'button'; attach.textContent = 'Link to selected task'; attach.disabled = this.knowledgeBusy;
					const task = this.dashboard?.tasks.find(item => item.id === this.selectedTaskId);
					attach.setAttribute('aria-label', `Link ${reference.title} to ${task?.title ?? 'selected task'}`);
					attach.addEventListener('click', () => { if (this.projectId && this.selectedTaskId) void this.mutateKnowledge(() => ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'attachTaskReference', { projectId: this.projectId, taskId: this.selectedTaskId, snapshotId: reference.id }), 'Reference linked to task.'); });
				}
			}
		}
		const form = panel.appendChild(createElement('form', 'project-dashboard__knowledge-form'));
		const formTitle = form.appendChild($('h3')); formTitle.textContent = 'Add a text reference';
		const titleLabel = form.appendChild(createElement('label')); titleLabel.htmlFor = 'knowledge-reference-title'; titleLabel.textContent = 'Title';
		const titleInput = form.appendChild(createElement('input')); titleInput.id = 'knowledge-reference-title'; titleInput.required = true; titleInput.value = this.referenceTitleDraft; titleInput.disabled = this.knowledgeBusy; titleInput.dataset.focusKey = 'knowledge-reference-title';
		titleInput.addEventListener('input', () => { this.referenceTitleDraft = titleInput.value; });
		const contentLabel = form.appendChild(createElement('label')); contentLabel.htmlFor = 'knowledge-reference-content'; contentLabel.textContent = 'Content';
		const content = form.appendChild(createElement('textarea')); content.id = 'knowledge-reference-content'; content.rows = 5; content.required = true; content.value = this.referenceContentDraft; content.disabled = this.knowledgeBusy; content.dataset.focusKey = 'knowledge-reference-content';
		content.addEventListener('input', () => { this.referenceContentDraft = content.value; });
		const actions = form.appendChild($('.project-dashboard__form-actions'));
		const submit = actions.appendChild(createElement('button', 'project-dashboard__primary')); submit.type = 'submit'; submit.disabled = this.knowledgeBusy; submit.textContent = this.knowledgeBusy ? 'Saving…' : 'Add reference';
		form.addEventListener('submit', event => {
			event.preventDefault(); const projectId = this.projectId; const referenceTitle = titleInput.value.trim(); const referenceContent = content.value;
			if (!projectId || !referenceTitle || !referenceContent.trim()) return;
			void this.mutateKnowledge(async () => {
				await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'importTextReference', { projectId, title: referenceTitle, content: referenceContent });
				this.referenceTitleDraft = ''; this.referenceContentDraft = '';
			}, 'Text reference added.');
		});
	}

	private renderProjectConventions(panel: HTMLElement): void {
		const knowledge = this.knowledge!;
		const active = knowledge.conventions.find(item => item.id === knowledge.activeConventionId);
		const activeCard = panel.appendChild($('.project-dashboard__active-convention'));
		const activeTitle = activeCard.appendChild($('h3')); activeTitle.textContent = active ? `Active convention · v${active.version}` : 'No active convention';
		const activeDescription = activeCard.appendChild($('p')); activeDescription.textContent = active ? `Applied ${active.lastAppliedAt ? new Date(active.lastAppliedAt).toLocaleString() : 'date unavailable'}. This version guides future project runs.` : 'Create a draft and apply it when the project guidance is ready.';
		if (active) { const preview = activeCard.appendChild(createElement('pre', 'project-dashboard__convention-preview')); preview.textContent = active.markdown; }
		const heading = panel.appendChild($('.project-dashboard__knowledge-section-heading'));
		const title = heading.appendChild($('h3')); title.textContent = 'Draft a convention';
		const draftForm = panel.appendChild(createElement('form', 'project-dashboard__knowledge-form'));
		const draftLabel = draftForm.appendChild(createElement('label')); draftLabel.htmlFor = 'knowledge-convention-draft'; draftLabel.textContent = 'Project guidance';
		const draft = draftForm.appendChild(createElement('textarea')); draft.id = 'knowledge-convention-draft'; draft.rows = 7; draft.required = true; draft.value = this.conventionDraft; draft.disabled = this.knowledgeBusy; draft.dataset.focusKey = 'knowledge-convention-draft';
		draft.placeholder = 'Write the conventions this project should follow…'; draft.addEventListener('input', () => { this.conventionDraft = draft.value; });
		if (knowledge.references.length) {
			const sources = draftForm.appendChild($('.project-dashboard__knowledge-source-list'));
			const sourceHeading = sources.appendChild($('span')); sourceHeading.textContent = 'Based on references (optional)';
			for (const reference of knowledge.references) {
				const label = sources.appendChild(createElement('label', 'project-dashboard__knowledge-source'));
				const checkbox = label.appendChild(createElement('input')); checkbox.type = 'checkbox'; checkbox.value = reference.id; checkbox.checked = this.conventionSourceIdsDraft.has(reference.id); checkbox.disabled = this.knowledgeBusy;
				checkbox.addEventListener('change', () => checkbox.checked ? this.conventionSourceIdsDraft.add(reference.id) : this.conventionSourceIdsDraft.delete(reference.id));
				const labelText = label.appendChild($('span')); labelText.textContent = reference.title;
			}
		}
		const actions = draftForm.appendChild($('.project-dashboard__form-actions'));
		const create = actions.appendChild(createElement('button', 'project-dashboard__primary')); create.type = 'submit'; create.disabled = this.knowledgeBusy; create.textContent = this.knowledgeBusy ? 'Saving…' : 'Save draft';
		draftForm.addEventListener('submit', event => {
			event.preventDefault(); const projectId = this.projectId; const markdown = draft.value;
			if (!projectId || !markdown.trim()) return;
			void this.mutateKnowledge(async () => {
				await ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'createConventionDraft', { projectId, markdown, sourceSnapshotIds: [...this.conventionSourceIdsDraft] });
				this.conventionDraft = '';
				this.conventionSourceIdsDraft.clear();
			}, 'Convention draft saved.');
		});
		const agent = panel.appendChild($('.project-dashboard__flow-card'));
		const agentTitle = agent.appendChild($('h3')); agentTitle.textContent = 'Ask an agent to draft or check';
		const agentForm = agent.appendChild(createElement('form', 'project-dashboard__knowledge-form'));
		const providerLabel = agentForm.appendChild(createElement('label')); providerLabel.htmlFor = 'convention-agent-provider'; providerLabel.textContent = 'Provider';
		const provider = agentForm.appendChild(document.createElement('select')); provider.id = 'convention-agent-provider'; provider.disabled = this.conventionAgentBusy;
		for (const id of ['claude', 'codex'] as const) { const option = provider.appendChild(document.createElement('option')); option.value = id; option.textContent = id === 'claude' ? 'Claude' : 'Codex'; option.selected = this.conventionAgentProvider === id; }
		provider.addEventListener('change', () => { this.conventionAgentProvider = provider.value as ProviderId; this.conventionAgentPreview = undefined; this.conventionAgentResult = undefined; this.render(); });
		const operationLabel = agentForm.appendChild(createElement('label')); operationLabel.htmlFor = 'convention-agent-operation'; operationLabel.textContent = 'Action';
		const operation = agentForm.appendChild(document.createElement('select')); operation.id = 'convention-agent-operation'; operation.disabled = this.conventionAgentBusy;
		for (const [value, label] of [['draft','Draft a new convention'],['check','Check the active convention']] as const) { const option = operation.appendChild(document.createElement('option')); option.value = value; option.textContent = label; option.selected = this.conventionAgentOperation === value; }
		operation.addEventListener('change', () => { this.conventionAgentOperation = operation.value as 'draft' | 'check'; this.conventionAgentPreview = undefined; this.conventionAgentResult = undefined; this.render(); });
		if (this.conventionAgentOperation === 'draft') {
			const sourceBox = agentForm.appendChild($('.project-dashboard__knowledge-source-list'));
			const sourceHeading = sourceBox.appendChild($('span')); sourceHeading.textContent = 'Reference snapshots';
			for (const reference of knowledge.references) { const label = sourceBox.appendChild(createElement('label','project-dashboard__knowledge-source')); const checkbox = label.appendChild(createElement('input')); checkbox.type='checkbox'; checkbox.value=reference.id; checkbox.checked=this.conventionAgentSourceIds.has(reference.id); checkbox.disabled=this.conventionAgentBusy; checkbox.addEventListener('change',()=>{checkbox.checked?this.conventionAgentSourceIds.add(reference.id):this.conventionAgentSourceIds.delete(reference.id);this.conventionAgentPreview=undefined;this.conventionAgentResult=undefined;this.render();}); const text=label.appendChild($('span')); text.textContent=`${reference.title} · v${reference.version}`; }
		}
		const agentActions = agentForm.appendChild($('.project-dashboard__form-actions'));
		const previewButton = agentActions.appendChild(createElement('button','project-dashboard__secondary')); previewButton.type='button'; previewButton.textContent='Preview request'; previewButton.disabled=this.conventionAgentBusy || !this.selectedTaskId || (this.conventionAgentOperation === 'check' && !active); previewButton.addEventListener('click',()=>void this.previewConventionAgent());
		agentForm.addEventListener('submit',event=>event.preventDefault());
		if (!this.selectedTaskId) { const hint=agent.appendChild($('.project-dashboard__flow-status')); hint.textContent='Select a task before preparing an agent request.'; }
		if (this.conventionAgentOperation === 'check' && !active) { const hint=agent.appendChild($('.project-dashboard__flow-status')); hint.textContent='Create or activate a convention version before running a check.'; }
		if (this.conventionAgentPreview) {
			const preview = agent.appendChild($('.project-dashboard__agent-preview'));
			const summary = preview.appendChild($('p')); summary.textContent=`${this.conventionAgentPreview.operation === 'draft' ? 'Draft' : 'Check'} · ${this.conventionAgentPreview.providerId} (${this.conventionAgentPreview.accountLabel}) · task revision ${this.conventionAgentPreview.task.revision}`;
			const permission=preview.appendChild($('p')); permission.textContent=`Permission: ${this.conventionAgentPreview.permissionSummary}${this.conventionAgentPreview.blockedReason ? ` · Blocked: ${this.conventionAgentPreview.blockedReason}` : ''}`;
			for (const reference of this.conventionAgentPreview.references) { const meta=preview.appendChild($('p')); meta.textContent=`Snapshot: ${reference.title} · v${reference.version} · SHA-256 ${reference.contentSha256}`; const body=preview.appendChild(createElement('pre','project-dashboard__convention-preview')); body.textContent=reference.content; }
			if (this.conventionAgentPreview.convention) { const existing=preview.appendChild(createElement('pre','project-dashboard__convention-preview')); existing.textContent=`Active convention v${this.conventionAgentPreview.convention.version} · SHA-256 ${this.conventionAgentPreview.convention.contentSha256}\n\n${this.conventionAgentPreview.convention.markdown}`; }
			const prompt=preview.appendChild(createElement('pre','project-dashboard__convention-preview')); prompt.textContent=this.conventionAgentPreview.prompt;
			const run=agent.appendChild(createElement('button','project-dashboard__primary')); run.type='button'; run.textContent=this.conventionAgentBusy?'Running…':this.conventionAgentOperation==='draft'?'Run draft':'Run check'; run.disabled=this.conventionAgentBusy || !this.conventionAgentPreview.allowed; run.addEventListener('click',()=>void this.runConventionAgent());
		}
		if (this.conventionAgentError) { const error=agent.appendChild($('.project-dashboard__error')); error.setAttribute('role','alert'); error.textContent=this.conventionAgentError; }
		if (this.conventionAgentNotice) { const notice=agent.appendChild($('.project-dashboard__flow-status')); notice.setAttribute('role','status'); notice.textContent=this.conventionAgentNotice; }
		if (this.conventionAgentResult) { const result=agent.appendChild($('.project-dashboard__agent-preview')); const heading=result.appendChild($('h4')); heading.textContent=this.conventionAgentResult.versionNumber ? `Draft saved as version ${this.conventionAgentResult.versionNumber}` : `Check report · ${this.conventionAgentResult.verdict ?? this.conventionAgentResult.attempt.state}`; const report=result.appendChild(createElement('pre','project-dashboard__convention-preview')); const generated=this.conventionAgentResult.versionId ? this.knowledge?.conventions.find(item=>item.id===this.conventionAgentResult!.versionId)?.markdown : undefined; report.textContent=generated ?? this.conventionAgentResult.report ?? this.conventionAgentResult.attempt.errorSummary ?? `Attempt ${this.conventionAgentResult.attempt.id}: ${this.conventionAgentResult.attempt.state}`; const refresh=result.appendChild(createElement('button','project-dashboard__secondary')); refresh.type='button'; refresh.textContent='Refresh knowledge and versions'; refresh.addEventListener('click',()=>void this.loadKnowledge()); }
		const historyHeading = panel.appendChild($('.project-dashboard__knowledge-section-heading'));
		const historyTitle = historyHeading.appendChild($('h3')); historyTitle.textContent = 'Version history';
		if (!knowledge.conventions.length) { const empty = panel.appendChild($('.project-dashboard__knowledge-empty')); empty.textContent = 'No convention drafts yet.'; return; }
		const history = panel.appendChild($('.project-dashboard__knowledge-list'));
		for (const convention of knowledge.conventions) {
			const row = history.appendChild($('.project-dashboard__knowledge-card'));
			const main = row.appendChild($('.project-dashboard__knowledge-card-main'));
			const name = main.appendChild($('h4')); name.textContent = `Version ${convention.version}${convention.active ? ' · Active' : ''}`;
			const meta = main.appendChild($('p')); meta.textContent = `Saved ${new Date(convention.createdAt).toLocaleDateString()} · ${convention.authoredBy === 'person' ? 'You' : convention.authoredBy}`;
			const preview = main.appendChild(createElement('pre', 'project-dashboard__convention-preview')); preview.textContent = convention.markdown;
			if (!convention.active) {
				const apply = row.appendChild(createElement('button', 'project-dashboard__secondary')); apply.type = 'button'; apply.textContent = 'Make active'; apply.disabled = this.knowledgeBusy;
				apply.addEventListener('click', () => { if (this.projectId) void this.mutateKnowledge(() => ipcRenderer.invoke(WORKSPACE_KNOWLEDGE_CHANNEL, 'applyConvention', { projectId: this.projectId, versionId: convention.id }), `Convention v${convention.version} is now active.`); });
			}
		}
	}

	private async startEgoCapture(url: string): Promise<void> {
		if (!this.projectId || !this.selectedTaskId || this.egoCaptureId || this.egoBusy) return;
		this.egoBusy=true; this.egoError=undefined; this.egoStatus=undefined; this.egoCleanupPending=false; this.render();
		const projectId = this.projectId; const taskId = this.selectedTaskId;
		try { const status=await ipcRenderer.invoke(WORKSPACE_EGO_CAPTURE_CHANNEL,'startCapture',{projectId,taskId,url}) as WorkspaceEgoCaptureStatus; this.egoStatus=status; this.egoUrlDraft=url; if (status.state === 'handoff') { this.egoCaptureId=status.captureId; this.egoTaskId=taskId; this.egoProjectId=projectId; this.egoCleanupPending=false; } else if (status.state === 'failed') { this.egoError=status.message; await this.recoverEgoCapture(projectId); } }
		catch(error) { this.egoError=this.errorMessage(error,'Could not open Ego for capture.'); await this.recoverEgoCapture(projectId); }
		finally { this.egoBusy=false; this.render(); this.runRequestedEgoClose(); }
	}
	private async finishEgoCapture(cancel: boolean): Promise<void> {
		if (!this.egoProjectId || !this.egoTaskId || !this.egoCaptureId || this.egoBusy) return;
		this.egoBusy=true; this.egoError=undefined; this.render();
		const projectId = this.egoProjectId; const taskId = this.egoTaskId; const captureId = this.egoCaptureId;
		try { const status=await ipcRenderer.invoke(WORKSPACE_EGO_CAPTURE_CHANNEL,cancel?'cancelCapture':'captureSelection',{projectId,taskId,captureId}) as WorkspaceEgoCaptureStatus; this.egoStatus=status; if (status.state==='captured') { this.egoCapturedTaskTitle=this.dashboard?.tasks.find(task=>task.id===taskId)?.title; this.clearEgoCaptureOwnership(); if (this.projectId === projectId) await this.loadKnowledge(); } else if (status.state==='cancelled') this.clearEgoCaptureOwnership(); else if (status.state==='failed') { this.egoError=status.message; await this.recoverEgoCapture(projectId); } }
		catch(error) { this.egoError=this.errorMessage(error,'Could not complete Ego capture.'); await this.recoverEgoCapture(projectId); }
		finally { this.egoBusy=false; this.render(); this.runRequestedEgoClose(); }
	}
	private clearEgoCaptureOwnership(): void { this.egoCaptureId=undefined; this.egoTaskId=undefined; this.egoProjectId=undefined; this.egoCleanupPending=false; }
	private async recoverEgoCapture(projectId: string): Promise<void> {
		try {
			const status=await ipcRenderer.invoke(WORKSPACE_EGO_CAPTURE_CHANNEL,'getActiveCapture',{projectId}) as WorkspaceEgoCaptureRecoveryStatus;
			if (status.state==='handoff') { this.egoCaptureId=status.captureId; this.egoTaskId=status.taskId; this.egoProjectId=projectId; this.egoCleanupPending=status.cleanupPending; this.egoStatus={state:'handoff',captureId:status.captureId}; }
			else if (this.egoProjectId === projectId) this.clearEgoCaptureOwnership();
		} catch(error) { this.egoError=this.errorMessage(error,'Could not recover the active Ego capture session.'); }
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
			else this.egoError=status.state==='failed' ? status.message : 'Ego did not confirm that the capture session closed.';
		} catch(error) { this.egoError=this.errorMessage(error,'Could not close the Ego capture session.'); if (this.egoProjectId) await this.recoverEgoCapture(this.egoProjectId); }
		finally { this.egoBusy=false; this.render(); this.runRequestedEgoClose(); }
	}
	private async previewConventionAgent(): Promise<void> {
		if (!this.projectId || !this.selectedTaskId) return;
		this.conventionAgentBusy=true; this.conventionAgentError=undefined; this.conventionAgentNotice=undefined; this.conventionAgentResult=undefined; this.render();
		try { const scope={projectId:this.projectId,taskId:this.selectedTaskId,providerId:this.conventionAgentProvider}; const command=this.conventionAgentOperation==='draft'?'previewDraft':'previewCheck'; const request=this.conventionAgentOperation==='draft'?{...scope,sourceSnapshotIds:[...this.conventionAgentSourceIds]}:{...scope,versionId:this.knowledge?.activeConventionId ?? ''}; this.conventionAgentPreview=await ipcRenderer.invoke(WORKSPACE_CONVENTION_AGENT_CHANNEL,command,request) as ConventionAgentPreviewDTO; }
		catch(error) { this.conventionAgentError=this.errorMessage(error,'Could not prepare the convention agent preview.'); }
		finally { this.conventionAgentBusy=false; this.render(); }
	}
	private async runConventionAgent(): Promise<void> {
		const preview=this.conventionAgentPreview; if (!preview || !preview.allowed || !this.projectId || !this.selectedTaskId) return;
		this.conventionAgentBusy=true; this.conventionAgentError=undefined; this.render();
		try { const scope={projectId:this.projectId,taskId:preview.task.id,providerId:this.conventionAgentProvider,digest:preview.digest}; const request=this.conventionAgentOperation==='draft'?{...scope,sourceSnapshotIds:preview.references.map(reference=>reference.id)}:{...scope,versionId:preview.convention?.id ?? ''}; this.conventionAgentResult=await ipcRenderer.invoke(WORKSPACE_CONVENTION_AGENT_CHANNEL,this.conventionAgentOperation,request) as ConventionAgentResultDTO; if(this.conventionAgentResult.attempt.state==='running') void this.pollConventionResult(this.projectId,this.conventionAgentResult.attempt.id); this.conventionAgentNotice=this.conventionAgentResult.attempt.state==='running'?'Agent started. This dashboard will refresh the result when it finishes.':this.conventionAgentOperation==='draft'?'Generated convention is saved as a draft. It has not been applied.':'Check finished. Review the report before deciding whether to change guidance.'; await this.loadKnowledge(); }
		catch(error) { this.conventionAgentError=this.errorMessage(error,'Convention agent request failed.'); }
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
				if (result.attempt.state !== 'running') { this.conventionAgentNotice=result.attempt.state==='succeeded'?'Agent finished. Inspect the output below; drafts remain unapplied.':`Agent ${result.attempt.state}${result.attempt.errorSummary ? `: ${result.attempt.errorSummary}` : '.'}`; await this.loadKnowledge(); }
				this.render();
			} catch(error) { this.conventionAgentError=this.errorMessage(error,'Could not refresh the convention agent result.'); this.render(); return; }
		}
	}
	private async loadTaskReviews(): Promise<void> {
		if (!this.projectId || !this.selectedTaskId) return;
		const taskId=this.selectedTaskId;
		if (this.reviewLinksTaskId !== taskId) {
			this.reviewLinks = []; this.reviewPendingCreates = []; this.reviewAvailability = 'unavailable'; this.reviewAvailabilityError = undefined;
		}
		this.reviewLinksTaskId=taskId;
		try { const result=await ipcRenderer.invoke(WORKSPACE_REVIEW_BRIDGE_CHANNEL,'listTaskReviews',{projectId:this.projectId,taskId}) as TaskReviewAvailability; if(this.selectedTaskId!==taskId)return; this.reviewLinks=result.reviews; this.reviewPendingCreates=result.pendingCreates; this.reviewAvailability=result.state; this.reviewAvailabilityError=result.error; this.reviewLinksTaskId=this.selectedTaskId; }
		catch(error) { this.reviewBridgeError=this.errorMessage(error,'Could not load task reviews.'); }
		this.render();
	}
	private async mutateTaskReview(command: 'createTaskReview'|'choosePrimaryReview', reviewId?: string, retryCommandId?: string): Promise<void> {
		if (!this.projectId || !this.selectedTaskId) return;
		const projectId = this.projectId;
		const taskId = this.selectedTaskId;
		const expectedRevision = this.dashboard?.tasks.find(task => task.id === taskId)?.revision;
		if (command === 'choosePrimaryReview' && !reviewId) return;
		if (command === 'choosePrimaryReview' && expectedRevision === undefined) {
			this.reviewBridgeError = 'Reload the task before choosing its primary Review.';
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
				this.reviewLinks=listing.reviews; this.reviewPendingCreates=listing.pendingCreates; this.reviewAvailability=listing.state; this.reviewAvailabilityError=listing.error; this.reviewLinksTaskId=taskId;
				if (taskRefreshed) this.reviewBridgeNotice=command==='createTaskReview'?'Review link created.':'Primary review updated.';
				else this.reviewBridgeError='Primary Review updated, but the task could not be reloaded. Reopen the project before changing it again.';
			}
		}
		catch(error) {
			if (this.projectId===projectId && this.selectedTaskId===taskId) {
				const message=this.errorMessage(error,'Could not update task reviews.');
				if (message.includes('changed since revision')) {
					this.reviewBridgeError=await this.refreshDashboard(false)
						? 'This task changed in another window. The latest version is loaded; choose its primary Review again.'
						: `This task changed in another window and could not be reloaded: ${this.providerError ?? 'refresh failed'}`;
				} else this.reviewBridgeError=message;
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
				this.reviewBridgeError = this.errorMessage(error, 'Could not open the verified task Review.');
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
				throw new Error(listing.error || (primary ? 'The primary Review is unavailable for this project.' : 'This task has no primary Review.'));
			}
			const verified = await ipcRenderer.invoke(WORKSPACE_REVIEW_BRIDGE_CHANNEL, 'openTaskReview', { projectId, taskId, reviewId: primary.reviewId }) as TaskReviewOpenResult;
			if (this.projectId !== projectId) return;
			await this.reviewTabs.openTaskApiReview(taskId, verified.reviewId, verified.version, verified.title);
		} catch (error) {
			if (this.projectId === projectId) this.taskMutationError = this.errorMessage(error, 'Could not open the primary task Review.');
		} finally {
			this.reviewBridgeBusy = false;
			this.render();
		}
	}
	private scheduleDashboardStateSave(debounce = false): void {
		if (!this.projectId) return;
		if (this.stateSaveTimer) clearTimeout(this.stateSaveTimer);
		const position = Math.min(10_000_000, Math.max(0, Math.floor(this.root?.scrollTop ?? 0))).toString();
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
						this.dashboardStateError = `Could not save the dashboard view: ${this.errorMessage(error, 'the request failed')}.`;
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
			this.pendingDashboardPosition = dashboard.view.dashboardPosition === null ? undefined : Math.min(10_000_000, Number(dashboard.view.dashboardPosition));
			this.dashboardStateError = `${this.dashboardStateError ?? 'Could not save dashboard state.'} The last saved view is shown. Select a task or scroll to try again.`;
			this.render();
			if (this.selectedTaskId) void this.loadAttempts();
		} catch (error) {
			if (this.inputActive && this.projectId === projectId && generation === this.stateSaveGeneration) {
				this.dashboardStateError = `${this.dashboardStateError ?? 'Could not save dashboard state.'} Could not reload the last saved view: ${this.errorMessage(error, 'the request failed')}.`;
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
		submit.textContent = 'Creating…';
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
			this.error = error instanceof Error ? error.message : 'Could not create the task. Try again.';
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
		if (!title) { this.taskEditError = 'Enter a task title before saving.'; this.render(); return; }
		if (!this.projectId || this.taskEditBusy || this.taskMutationBusy) return;
		this.taskEditBusy = true; this.taskEditError = undefined; this.taskMutationError = undefined; this.taskMutationBusy = 'Saving task details…'; this.render();
		try {
			const updated = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'updateTask', {
				projectId: this.projectId, taskId: task.id, expectedRevision: task.revision,
				title, description: this.editDescriptionDraft.trim() || null,
			} satisfies UpdateWorkspaceDashboardTaskRequest) as WorkspaceDashboardTaskItemDTO;
			this.updateDashboardTask(updated);
			this.editingTaskId = undefined; this.editTitleDraft = ''; this.editDescriptionDraft = '';
		} catch (error) {
			const message = this.errorMessage(error, 'Could not save task details.');
			const conflict = message.includes('changed since revision');
			this.taskEditError = conflict ? 'This task changed since you opened it. The latest version is loaded and your draft is preserved. Review the draft, then save again.' : message;
			if (conflict && !await this.refreshDashboard(false)) this.taskEditError = `This task changed since you opened it. Your draft is preserved, but the latest version could not be reloaded: ${this.providerError ?? 'refresh failed'}`;
		} finally {
			this.taskEditBusy = false; this.taskMutationBusy = undefined;
			this.render();
			if (!this.editingTaskId) this.root?.querySelector<HTMLElement>('[data-focus-key="task-edit"]')?.focus({ preventScroll: true });
		}
	}

	private async updateTaskState(task: WorkspaceDashboardTaskItemDTO, state: DashboardTaskState): Promise<void> {
		if (!this.projectId || this.taskMutationBusy || task.state === state) return;
		this.taskMutationError = undefined;
		this.taskMutationBusy = `Moving task to ${columns.find(column => column.state === state)?.label}…`;
		this.render();
		try {
			const updated = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'updateTask', {
				projectId: this.projectId, taskId: task.id, expectedRevision: task.revision, state,
			} satisfies UpdateWorkspaceDashboardTaskRequest) as WorkspaceDashboardTaskItemDTO;
			this.updateDashboardTask(updated);
			await this.refreshDashboard(false);
		} catch (error) {
			const message = this.errorMessage(error, 'Could not change the task state.');
			if (message.includes('changed since revision')) {
				this.taskMutationError = await this.refreshDashboard(false)
					? 'This task changed before the state update. The latest task was reloaded; choose the state again.'
					: `This task changed before the state update, and the latest task could not be reloaded: ${this.providerError ?? 'refresh failed'}`;
			} else this.taskMutationError = message;
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
		this.taskMutationError = undefined; this.taskMutationBusy = `Updating ${columns.find(column => column.state === state)?.label} order…`; this.render();
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
			const message = this.errorMessage(error, 'Could not reorder tasks.');
			if (message.includes('task set') || message.includes('changed before reorder')) {
				this.taskMutationError = await this.refreshDashboard(false)
					? 'This task column changed before it could be reordered. The latest order was reloaded.'
					: `This task column changed before reorder, and the latest order could not be reloaded: ${this.providerError ?? 'refresh failed'}`;
			} else this.taskMutationError = message;
		} finally {
			this.taskMutationBusy = undefined;
			this.render();
		}
	}

	private setTaskView(view: DashboardTaskView): void {
		this.taskView = view;
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
			if (this.projectId === projectId && this.taskView === view) this.lifecycleError = this.errorMessage(error, `Could not load ${view} tasks.`);
		} finally {
			if (this.projectId === projectId && this.taskView === view) { this.lifecycleLoading = false; this.render(); }
		}
	}

	private async performTaskLifecycleAction(command: 'archiveTask' | 'restoreArchivedTask' | 'restoreTrashedTask' | 'trashTask', task: WorkspaceDashboardTaskItemDTO): Promise<void> {
		if (!this.projectId || this.taskMutationBusy) return;
		if (command === 'archiveTask' && this.attempts.some(attempt => this.isActive(attempt.state))) {
			this.taskMutationError = 'Archiving was not started. Cancel this task’s active run and wait for cleanup first.';
			this.render();
			return;
		}
		if (command === 'trashTask' && task.deletionPendingAt && !task.deletionRequestId && !this.trashRequestIds.has(task.id)) {
			this.taskMutationError = 'This Trash request is pending, but the saved request ID is unavailable. The task remains on the board; reload the project or contact support before retrying.';
			this.render();
			return;
		}
		if (command === 'trashTask') {
			const requestId = task.deletionRequestId ?? this.trashRequestIds.get(task.id) ?? crypto.randomUUID();
			this.trashRequestIds.set(task.id, requestId);
		}
		const request: WorkspaceDashboardTaskLifecycleRequest = { projectId: this.projectId, taskId: task.id, expectedRevision: task.revision };
		this.taskMutationError = undefined;
		this.taskMutationBusy = command === 'archiveTask' ? 'Archiving task…'
			: command === 'trashTask' ? 'Cancelling owned runs and verifying cleanup…'
				: 'Restoring task…';
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
			const message = this.errorMessage(error, `Could not ${command}.`);
			const conflict = message.includes('changed since revision');
			if (conflict) {
				const refreshed = await this.refreshDashboard(false);
				if (this.taskView === 'archived' || this.taskView === 'trash') await this.loadLifecycleTasks(this.taskView);
				this.taskMutationError = refreshed ? 'This task changed before the action. The latest task list was reloaded.' : `${message} Latest task data could not be loaded.`;
			} else if (command === 'trashTask') {
				const refreshed = await this.refreshDashboard(false);
				const latest = this.dashboard?.tasks.find(candidate => candidate.id === task.id);
				if (latest?.deletionRequestId) this.trashRequestIds.set(task.id, latest.deletionRequestId);
				this.taskMutationError = latest?.deletionError
					? `Trash did not complete: ${latest.deletionError} The task remains on the board.`
					: `${message}${refreshed ? ' The task remains on the board.' : ' The task remains visible, but its latest state could not be loaded.'}`;
			} else this.taskMutationError = message;
		}
		finally {
			this.taskMutationBusy = undefined;
			this.render();
		}
	}

	private renderTaskViewNavigation(shell: HTMLElement): void {
		const navigation = shell.appendChild($('.project-dashboard__task-views'));
		navigation.setAttribute('role', 'group'); navigation.setAttribute('aria-label', 'Task views');
		for (const [view, label] of [['board', 'Board'], ['archived', 'Archived'], ['trash', 'Trash']] as const) {
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
		const title = heading.appendChild($('h2')); title.textContent = this.taskView === 'archived' ? 'Archived tasks' : 'Trash';
		const count = heading.appendChild($('span')); count.textContent = `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`;
		if (this.lifecycleLoading) {
			const status = section.appendChild($('.project-dashboard__status')); status.setAttribute('role', 'status'); status.textContent = `Loading ${this.taskView === 'archived' ? 'archived tasks' : 'Trash'}…`;
			return;
		}
		if (!tasks.length) {
			const empty = section.appendChild($('.project-dashboard__empty-view'));
			empty.textContent = this.taskView === 'archived' ? 'No archived tasks.' : 'Trash is empty.';
			return;
		}
		const list = section.appendChild($('.project-dashboard__lifecycle-list'));
		for (const task of tasks) {
			const row = list.appendChild($('.project-dashboard__lifecycle-item'));
			const copy = row.appendChild($('.project-dashboard__lifecycle-copy'));
			const name = copy.appendChild($('h3')); name.textContent = task.title;
			const state = copy.appendChild($('p')); state.className = 'project-dashboard__lifecycle-meta';
			state.textContent = `${columns.find(column => column.state === task.state)?.label} · Updated ${new Date(task.updatedAt).toLocaleDateString()}`;
			if (task.description) { const description = copy.appendChild($('p')); description.textContent = task.description; }
			if (task.deletionError) { const error = copy.appendChild($('.project-dashboard__task-edit-error')); error.textContent = task.deletionError; }
			const restore = row.appendChild(createElement('button', 'project-dashboard__secondary'));
			restore.classList.add('project-dashboard__restore');
			restore.type = 'button'; restore.textContent = 'Restore to board'; restore.disabled = !!this.taskMutationBusy;
			restore.setAttribute('aria-label', `Restore ${task.title} to ${columns.find(column => column.state === task.state)?.label}`);
			restore.dataset.focusKey = `restore:${task.id}`;
			restore.addEventListener('click', () => void this.performTaskLifecycleAction(this.taskView === 'archived' ? 'restoreArchivedTask' : 'restoreTrashedTask', task));
		}
	}

	private renderTaskManagementControls(container: HTMLElement, task: WorkspaceDashboardTaskItemDTO): void {
		if (this.trashConfirmationTaskId === task.id) {
			const confirmation = container.appendChild($('.project-dashboard__trash-confirmation'));
			confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-labelledby', 'task-trash-confirm-title');
			const title = confirmation.appendChild($('h4')); title.id = 'task-trash-confirm-title'; title.textContent = 'Move this task to Trash?';
			const explanation = confirmation.appendChild($('p'));
			explanation.textContent = 'The app will cancel this task’s owned runs and wait for cleanup before moving it to Trash. If cancellation or cleanup fails, the task stays on the board and the error is shown here.';
			const actions = confirmation.appendChild($('.project-dashboard__edit-actions'));
			const confirm = actions.appendChild(createElement('button', 'project-dashboard__danger'));
			confirm.type = 'button'; confirm.textContent = this.taskMutationBusy ? 'Cancelling runs…' : 'Confirm Trash'; confirm.disabled = !!this.taskMutationBusy;
			confirm.dataset.focusKey = 'trash-confirm'; confirm.addEventListener('click', () => void this.performTaskLifecycleAction('trashTask', task));
			const cancel = actions.appendChild(createElement('button', 'project-dashboard__secondary'));
			cancel.type = 'button'; cancel.textContent = 'Keep task'; cancel.disabled = !!this.taskMutationBusy; cancel.dataset.focusKey = 'trash-cancel';
			cancel.addEventListener('click', () => { this.trashConfirmationTaskId = undefined; this.render(); this.root?.querySelector<HTMLElement>('[data-focus-key="task-trash"]')?.focus({ preventScroll: true }); });
			return;
		}
		if (task.deletionPendingAt) {
			const pending = container.appendChild($('.project-dashboard__task-edit-error')); pending.setAttribute('role', 'alert');
			pending.textContent = task.deletionError
				? `Trash is pending: ${task.deletionError} The task remains on the board.`
				: 'Trash is pending while owned run cleanup is checked. The task remains on the board.';
			if (task.deletionRequestId || this.trashRequestIds.has(task.id)) {
				const retryTrash = container.appendChild(createElement('button', 'project-dashboard__danger'));
				retryTrash.type = 'button'; retryTrash.textContent = 'Retry Trash'; retryTrash.dataset.focusKey = 'task-trash'; retryTrash.disabled = !!this.taskMutationBusy;
				retryTrash.addEventListener('click', () => { this.trashConfirmationTaskId = task.id; this.render(); this.root?.querySelector<HTMLElement>('[data-focus-key="trash-confirm"]')?.focus({ preventScroll: true }); });
			} else {
				const unavailable = container.appendChild($('.project-dashboard__lifecycle-meta'));
				unavailable.textContent = 'This pending Trash request has no saved request ID, so it cannot be retried safely. The task remains on the board.';
			}
			return;
		}
		const actions = container.appendChild($('.project-dashboard__task-management-actions'));
		const archive = actions.appendChild(createElement('button', 'project-dashboard__secondary'));
		archive.type = 'button'; archive.textContent = 'Archive task'; archive.disabled = !!this.taskMutationBusy; archive.dataset.focusKey = 'task-archive';
		archive.addEventListener('click', () => void this.performTaskLifecycleAction('archiveTask', task));
		const trash = actions.appendChild(createElement('button', 'project-dashboard__danger'));
		trash.type = 'button'; trash.textContent = 'Move to Trash'; trash.disabled = !!this.taskMutationBusy; trash.dataset.focusKey = 'task-trash';
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
		const activeElement = this.root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
		const focusId = activeElement?.id;
		const focusKey = activeElement?.dataset.focusKey ?? (document.activeElement === document.body ? this.lastFocusKey : undefined);
		const focusSignature = activeElement && !focusId && !activeElement.dataset.focusKey ? this.focusSignature(activeElement) :
			(document.activeElement === document.body ? this.lastFocusSignature : undefined);
		if (activeElement?.dataset.focusKey) this.lastFocusKey = activeElement.dataset.focusKey;
		else if (activeElement) this.lastFocusKey = undefined;
		if (focusSignature) this.lastFocusSignature = focusSignature;
		const scrollTop = this.root.scrollTop;
		const restorePosition = () => {
			if (!this.root) return;
			if (this.pendingDashboardPosition !== undefined) {
				const position = this.pendingDashboardPosition;
				this.pendingDashboardPosition = undefined;
				this.restoreDashboardPosition(position);
			} else this.root.scrollTop = scrollTop;
			const target = focusId ? this.root.querySelector<HTMLElement>(`#${CSS.escape(focusId)}`) :
				focusKey ? [...this.root.querySelectorAll<HTMLElement>('[data-focus-key]')].find(element => element.dataset.focusKey === focusKey) :
				focusSignature ? this.findFocusTarget(focusSignature) : undefined;
			if (this.focusTaskDetailOnRender) {
				const shouldFocusTaskDetail = this.root.clientWidth <= 1100;
				this.focusTaskDetailOnRender = false;
				if (!shouldFocusTaskDetail) {
					if (target && !('disabled' in target && target.disabled)) target.focus({ preventScroll: true });
					return;
				}
				const detail = this.root.querySelector<HTMLElement>('.project-dashboard__detail');
				if (detail) { detail.focus({ preventScroll: true }); detail.scrollIntoView({ block: 'start' }); return; }
			}
			if (target && !('disabled' in target && target.disabled)) target.focus({ preventScroll: true });
		};
		clearNode(this.root);
		const shell = this.root.appendChild($('.project-dashboard__shell'));
		const heading = shell.appendChild($('.project-dashboard__heading'));
		const eyebrow = heading.appendChild($('.project-dashboard__eyebrow'));
		eyebrow.textContent = 'PROJECT WORKSPACE';
		const title = heading.appendChild($('h1'));
		title.textContent = this.dashboard?.project.name ?? 'Project';
		const location = heading.appendChild($('.project-dashboard__location'));
		location.textContent = this.dashboard?.folder.path ?? 'Loading project details';

		if (this.error) {
			const banner = shell.appendChild($('.project-dashboard__error'));
			banner.setAttribute('role', 'alert');
			banner.textContent = this.error;
			const retry = banner.appendChild(createElement('button', 'project-dashboard__retry'));
			retry.dataset.focusKey = 'dashboard-retry';
			retry.type = 'button'; retry.textContent = 'Retry'; retry.addEventListener('click', () => void this.load());
		}
		if (this.dashboardStateError) {
			const banner = shell.appendChild($('.project-dashboard__error'));
			banner.setAttribute('role', 'alert');
			banner.textContent = this.dashboardStateError;
		}
		if (this.loading) {
			const status = shell.appendChild($('.project-dashboard__status'));
			status.setAttribute('role', 'status'); status.textContent = 'Loading project tasks…';
			restorePosition();
			return;
		}
		if (!this.dashboard) { restorePosition(); return; }
		this.renderTaskViewNavigation(shell);
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
			this.renderKnowledge(shell);
			restorePosition();
			return;
		}

		const next = shell.appendChild($('.project-dashboard__next'));
		const nextCopy = next.appendChild($('.project-dashboard__next-copy'));
		const nextAction = this.dashboard.nextAction;
		const recommended = nextAction && this.dashboard.tasks.find(task => task.id === nextAction.taskId &&
			(nextAction.kind === 'review' ? task.state === 'review' : nextAction.kind === 'ready' ? task.state === 'ready' : task.state === 'inProgress'));
		const nextTask = recommended ?? (['review', 'inProgress', 'ready'] as const)
			.flatMap(state => this.dashboard!.tasks.filter(task => task.state === state).sort((left, right) => left.createdAt.localeCompare(right.createdAt)))[0];
		const kicker = nextCopy.appendChild($('.project-dashboard__kicker')); kicker.textContent = nextTask ? 'Next task' : 'Project tasks';
		const allTasksDone = this.dashboard.tasks.length > 0 && this.dashboard.tasks.every(task => task.state === 'done');
		const nextTitle = nextCopy.appendChild($('h2')); nextTitle.textContent = nextTask?.title ?? (allTasksDone ? 'All tasks done' : 'No tasks yet');
		const nextDescription = nextCopy.appendChild($('p'));
		const nextReason = nextAction && recommended?.id === nextAction.taskId
			? { attention: 'A run needs attention', review: nextAction.hasPassedE2eEvidence ? 'Review with E2E evidence' : 'Review the result', running: 'Work in progress', ready: 'Ready to start' }[nextAction.kind]
			: nextTask ? columns.find(column => column.state === nextTask.state)?.label : undefined;
		nextDescription.textContent = nextTask ? `${nextReason} · Select to open task details.` : allTasksDone
			? 'Every task on this board is complete. Create another task when you’re ready.'
			: 'Create a task to start tracking work in this project.';
		const nextActions = next.appendChild(createElement('div', 'project-dashboard__next-actions'));
		const quickButton = nextActions.appendChild(createElement('button', 'project-dashboard__primary')); quickButton.type = 'button'; quickButton.textContent = nextTask ? 'Open task' : 'Create task';
		quickButton.disabled = !!this.taskMutationBusy;
		quickButton.dataset.focusKey = 'quick-create';
		quickButton.addEventListener('click', () => {
			if (nextTask) {
				this.stopPolling(); this.selectedTaskId = nextTask.id; this.focusTaskDetailOnRender = true; this.e2eDraftAttemptId = ''; this.e2eAttemptChosenByUser = false; this.e2eFormOpen = false; this.preview = undefined; this.providerError = undefined; this.providerErrorKind = undefined; this.attempts = [];
				this.scheduleDashboardStateSave(); this.render(); void this.loadAttempts();
			} else {
				const form = this.root?.querySelector<HTMLDetailsElement>('.project-dashboard__form');
				if (form) { this.createFormOpen = true; form.open = true; }
				this.root?.querySelector<HTMLInputElement>('#project-task-title')?.focus();
			}
		});
		if (nextTask && nextAction?.taskId === nextTask.id && nextAction.primaryReviewId) {
			const openReview = nextActions.appendChild(createElement('button', 'project-dashboard__secondary'));
			openReview.type = 'button'; openReview.textContent = 'Open primary review'; openReview.disabled = !!this.taskMutationBusy || this.reviewBridgeBusy;
			openReview.setAttribute('aria-label', `Open primary Review for ${nextTask.title}`);
			openReview.addEventListener('click', () => void this.openPrimaryTaskReview(nextTask.id));
		}

		const emptyProject = this.dashboard.tasks.length === 0;
		if (emptyProject) this.renderCreateForm(shell);
		const boardHeader = shell.appendChild($('.project-dashboard__section-heading'));
		const boardTitle = boardHeader.appendChild($('h2')); boardTitle.textContent = 'Task board';
		const count = boardHeader.appendChild($('span')); count.textContent = `${this.dashboard.tasks.length} ${this.dashboard.tasks.length === 1 ? 'task' : 'tasks'}`;
		const detail = this.dashboard.tasks.find(task => task.id === this.selectedTaskId);
		const workArea = shell.appendChild($('.project-dashboard__work-area'));
		if (detail) workArea.classList.add('project-dashboard__work-area--with-detail');
		const board = workArea.appendChild($('.project-dashboard__board'));
		if (emptyProject) board.classList.add('project-dashboard__board--empty');
		for (const column of columns) {
			const lane = board.appendChild($('.project-dashboard__lane'));
			const laneHeader = lane.appendChild($('.project-dashboard__lane-heading'));
			const laneTitle = laneHeader.appendChild($('h3')); laneTitle.textContent = column.label;
			const tasks = this.dashboard.tasks.filter(task => task.state === column.state);
			const laneCount = laneHeader.appendChild($('.project-dashboard__count')); laneCount.textContent = String(tasks.length);
			if (!tasks.length && !emptyProject) {
				const empty = lane.appendChild($('.project-dashboard__empty')); empty.textContent = 'No tasks in this stage';
			}
			for (const task of tasks) this.renderTask(lane, task);
		}

		if (detail) {
			const panel = workArea.appendChild($('.project-dashboard__detail'));
			panel.tabIndex = -1;
			const detailHeader = panel.appendChild($('.project-dashboard__detail-header'));
			const detailTitle = detailHeader.appendChild($('h2')); detailTitle.textContent = detail.title;
			if (this.editingTaskId !== detail.id) {
				const edit = detailHeader.appendChild(createElement('button', 'project-dashboard__secondary'));
				edit.type = 'button'; edit.textContent = 'Edit task'; edit.disabled = !!this.taskMutationBusy; edit.dataset.focusKey = 'task-edit';
				edit.addEventListener('click', () => {
					this.editingTaskId = detail.id; this.editTitleDraft = detail.title; this.editDescriptionDraft = detail.description ?? ''; this.taskEditError = undefined;
					this.render(); this.root?.querySelector<HTMLInputElement>('#task-edit-title')?.focus({ preventScroll: true });
				});
			}
			const close = detailHeader.appendChild(createElement('button', 'project-dashboard__close')); close.type = 'button'; close.textContent = 'Close'; close.addEventListener('click', () => { this.stopPolling(); this.selectedTaskId = undefined; this.scheduleDashboardStateSave(); this.render(); });
			close.disabled = !!this.taskMutationBusy;
			close.dataset.focusKey = 'detail-close';
			const reviews = panel.appendChild($('.project-dashboard__flow-card'));
			const reviewsTitle = reviews.appendChild($('h3')); reviewsTitle.textContent = 'Task reviews';
			const reviewsLoaded = this.reviewLinksTaskId === detail.id;
			const taskReviewLinks = reviewsLoaded ? this.reviewLinks : [];
			const taskPendingCreates = reviewsLoaded ? this.reviewPendingCreates : [];
			const reviewActions=reviews.appendChild($('.project-dashboard__flow-actions'));
			const createReview=reviewActions.appendChild(createElement('button','project-dashboard__secondary')); createReview.type='button'; createReview.textContent=taskReviewLinks.length?'Create another review':'Create review'; createReview.dataset.focusKey = 'task-review-create'; createReview.disabled=this.reviewBridgeBusy || taskPendingCreates.length > 0 || !reviewsLoaded || this.reviewAvailability !== 'available'; createReview.addEventListener('click',()=>void this.mutateTaskReview('createTaskReview'));
			const refreshReviews=reviewActions.appendChild(createElement('button','project-dashboard__secondary')); refreshReviews.type='button'; refreshReviews.textContent='Recheck links'; refreshReviews.dataset.focusKey = 'task-review-recheck'; refreshReviews.disabled=this.reviewBridgeBusy; refreshReviews.addEventListener('click',()=>{this.reviewBridgeError=undefined;this.reviewLinksTaskId=undefined;void this.loadTaskReviews();});
			for (const pending of taskPendingCreates) {
				const row=reviews.appendChild($('.project-dashboard__review-link'));
				const info=row.appendChild($('span')); info.textContent=`Review creation ${pending.status} · requested ${new Date(pending.createdAt).toLocaleString()}${pending.lastError ? ` · ${pending.lastError}` : ''}`;
				const retry=row.appendChild(createElement('button','project-dashboard__secondary')); retry.type='button'; retry.textContent='Retry same request'; retry.disabled=this.reviewBridgeBusy || this.reviewAvailability !== 'available'; retry.addEventListener('click',()=>void this.mutateTaskReview('createTaskReview',undefined,pending.commandId));
			}
			if (!taskReviewLinks.length) { const empty=reviews.appendChild($('.project-dashboard__flow-status')); empty.textContent=!reviewsLoaded?'Loading task reviews…':this.reviewAvailability==='unavailable'?'Review is unavailable. Recheck links after it starts.':'No review links for this task yet.'; }
			if (taskReviewLinks.some(link => link.isPrimary && link.state === 'unavailable')) {
				const repair = reviews.appendChild($('.project-dashboard__flow-status'));
				repair.setAttribute('role', 'status');
				repair.textContent = 'The primary Review is missing or points to another repository. Choose another available Review, or recheck links after repairing it.';
			}
			for (const link of taskReviewLinks) {
				const row = reviews.appendChild($('.project-dashboard__review-link'));
				const info = row.appendChild($('span'));
				info.textContent = `${link.reviewId}${link.isPrimary ? ' · Primary' : ''} · ${link.state === 'available' ? 'Available' : 'Unavailable for this project'}`;
				const actions = row.appendChild($('.project-dashboard__flow-actions'));
				if (link.state !== 'available' || this.reviewAvailability !== 'available') continue;
				const open = actions.appendChild(createElement('button', 'project-dashboard__secondary'));
				open.type = 'button'; open.textContent = 'Open verified snapshot'; open.disabled = this.reviewBridgeBusy;
				open.addEventListener('click', () => void this.openTaskReview(detail.id, link.reviewId));
				if (!link.isPrimary) {
					const primary = actions.appendChild(createElement('button', 'project-dashboard__secondary'));
					primary.type = 'button'; primary.textContent = 'Make primary'; primary.disabled = this.reviewBridgeBusy;
					primary.addEventListener('click', () => void this.mutateTaskReview('choosePrimaryReview', link.reviewId));
				}
			}
			if(this.reviewAvailabilityError){const error=reviews.appendChild($('.project-dashboard__error'));error.setAttribute('role','alert');error.textContent=this.reviewAvailabilityError;}
			if(this.reviewBridgeError){const error=reviews.appendChild($('.project-dashboard__error'));error.setAttribute('role','alert');error.textContent=this.reviewBridgeError;}
			if(this.reviewBridgeNotice){const notice=reviews.appendChild($('.project-dashboard__flow-status'));notice.setAttribute('role','status');notice.textContent=this.reviewBridgeNotice;}
			if(this.selectedTaskId && this.reviewLinksTaskId !== this.selectedTaskId) void this.loadTaskReviews();
			const stateControl = panel.appendChild($('.project-dashboard__task-state'));
			const stateLabel = stateControl.appendChild($('h3')); stateLabel.textContent = 'Task state';
			const states = stateControl.appendChild($('.project-dashboard__state-options')); states.setAttribute('role', 'group'); states.setAttribute('aria-label', 'Task state');
			for (const column of columns) {
				const option = states.appendChild(createElement('button', 'project-dashboard__state-option'));
				option.type = 'button'; option.textContent = column.label; option.setAttribute('aria-pressed', String(detail.state === column.state));
				option.disabled = detail.state === column.state || !!this.taskMutationBusy;
				option.dataset.focusKey = `task-state:${column.state}`;
				option.addEventListener('click', () => void this.updateTaskState(detail, column.state));
			}
			if (this.editingTaskId === detail.id) {
				const editForm = panel.appendChild(createElement('form', 'project-dashboard__edit-form'));
				const titleLabel = editForm.appendChild(createElement('label')); titleLabel.htmlFor = 'task-edit-title'; titleLabel.textContent = 'Task title';
				const titleInput = editForm.appendChild(createElement('input')); titleInput.id = 'task-edit-title'; titleInput.required = true; titleInput.maxLength = 160; titleInput.value = this.editTitleDraft; titleInput.disabled = this.taskEditBusy; titleInput.dataset.focusKey = 'task-edit-title';
				titleInput.addEventListener('input', () => { this.editTitleDraft = titleInput.value; });
				const descriptionLabel = editForm.appendChild(createElement('label')); descriptionLabel.htmlFor = 'task-edit-description'; descriptionLabel.textContent = 'Description';
				const descriptionInput = editForm.appendChild(createElement('textarea')); descriptionInput.id = 'task-edit-description'; descriptionInput.rows = 4; descriptionInput.maxLength = 2000; descriptionInput.value = this.editDescriptionDraft; descriptionInput.disabled = this.taskEditBusy; descriptionInput.dataset.focusKey = 'task-edit-description';
				descriptionInput.addEventListener('input', () => { this.editDescriptionDraft = descriptionInput.value; });
				if (this.taskEditError) { const error = editForm.appendChild($('.project-dashboard__task-edit-error')); error.setAttribute('role', 'alert'); error.textContent = this.taskEditError; }
				const actions = editForm.appendChild($('.project-dashboard__edit-actions'));
				const save = actions.appendChild(createElement('button', 'project-dashboard__primary')); save.type = 'submit'; save.textContent = this.taskEditBusy ? 'Saving…' : 'Save'; save.disabled = this.taskEditBusy || !!this.taskMutationBusy; save.dataset.focusKey = 'task-save';
				const cancel = actions.appendChild(createElement('button', 'project-dashboard__secondary')); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.disabled = this.taskEditBusy; cancel.dataset.focusKey = 'task-cancel';
				cancel.addEventListener('click', () => { this.editingTaskId = undefined; this.editTitleDraft = ''; this.editDescriptionDraft = ''; this.taskEditError = undefined; this.render(); this.root?.querySelector<HTMLElement>('[data-focus-key="task-edit"]')?.focus({ preventScroll: true }); });
				editForm.addEventListener('submit', event => { event.preventDefault(); void this.saveTaskDetails(detail); });
			} else {
				const description = panel.appendChild($('p')); description.textContent = detail.description || 'No description provided.';
			}
			const meta = panel.appendChild($('.project-dashboard__detail-meta')); meta.textContent = `Updated ${new Date(detail.updatedAt).toLocaleDateString()}`;
			const management = panel.appendChild($('.project-dashboard__task-management'));
			const managementTitle = management.appendChild($('h3')); managementTitle.textContent = 'Task management';
			this.renderTaskManagementControls(management, detail);
			this.renderProviderRuns(panel, detail);
			this.renderWorkspaceE2e(panel, detail);
		}
		if (!emptyProject) this.renderCreateForm(shell);
		this.renderKnowledge(shell);
		restorePosition();
	}

	private renderTask(lane: HTMLElement, task: WorkspaceDashboardTaskItemDTO): void {
		const card = lane.appendChild(createElement('div', 'project-dashboard__task-card'));
		card.draggable = !this.taskMutationBusy;
		card.setAttribute('aria-label', `${task.title}. Drag to reorder within ${columns.find(column => column.state === task.state)?.label}; keyboard users can use Move up and Move down.`);
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
		moveUp.type = 'button'; moveUp.textContent = '↑'; moveUp.title = 'Move up'; moveUp.disabled = index <= 0 || !!this.taskMutationBusy;
		moveUp.setAttribute('aria-label', `Move ${task.title} up in ${columns.find(column => column.state === task.state)?.label}`);
		moveUp.dataset.focusKey = `order:${task.id}:up`; moveUp.addEventListener('click', () => void this.reorderTask(task.state, task.id, -1));
		const moveDown = order.appendChild(createElement('button', 'project-dashboard__order-button'));
		moveDown.type = 'button'; moveDown.textContent = '↓'; moveDown.title = 'Move down'; moveDown.disabled = index < 0 || index >= laneTasks.length - 1 || !!this.taskMutationBusy;
		moveDown.setAttribute('aria-label', `Move ${task.title} down in ${columns.find(column => column.state === task.state)?.label}`);
		moveDown.dataset.focusKey = `order:${task.id}:down`; moveDown.addEventListener('click', () => void this.reorderTask(task.state, task.id, 1));
	}


	private renderWorkspaceE2e(panel: HTMLElement, task: WorkspaceDashboardTaskItemDTO): void {
		const section = panel.appendChild($('.project-dashboard__flow-card'));
		const heading = section.appendChild($('h3')); heading.textContent = 'Frontend E2E check';
		const intro = section.appendChild($('p')); intro.textContent = 'Run a browser scenario against a completed provider attempt.';
		if (this.e2eError) { const error = section.appendChild($('.project-dashboard__error')); error.setAttribute('role', 'alert'); error.textContent = this.e2eError; }
		const visibleEvidence = this.e2eLoadedTaskId === task.id ? this.e2eEvidence : [];
		const latestEvidence = [...visibleEvidence].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
		const latestSummary = section.appendChild($('.project-dashboard__e2e-summary')); latestSummary.setAttribute('role', 'status');
		if (this.e2eLoading && this.e2eLoadedTaskId !== task.id) latestSummary.textContent = 'Loading recent checks…';
		else if (latestEvidence) {
			const result = latestEvidence.state === 'passed' ? 'Passed' : latestEvidence.state === 'failed' ? 'Failed' : latestEvidence.state === 'running' ? 'Check running' : latestEvidence.state === 'cleanupFailed' ? 'Cleanup needs attention' : 'Cancelled';
			latestSummary.textContent = `Latest: ${result} · ${new Date(latestEvidence.createdAt).toLocaleString()} · ${latestEvidence.environmentIdentity}`;
		} else latestSummary.textContent = this.e2eLoadedTaskId === task.id ? 'No checks yet.' : 'Recent check status will appear here.';
		const formDisclosure = section.appendChild(createElement('details', 'project-dashboard__e2e-disclosure'));
		formDisclosure.open = this.e2eFormOpen;
		formDisclosure.addEventListener('toggle', () => { this.e2eFormOpen = formDisclosure.open; });
		const formSummary = formDisclosure.appendChild(createElement('summary')); formSummary.textContent = 'Configure and run a check';
		const form = formDisclosure.appendChild(createElement('form', 'project-dashboard__e2e-form'));
		const eligible = this.attempts.filter(attempt => attempt.taskId === task.id && attempt.purpose === 'task' && !!attempt.finishedAt).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		const attemptLabel = form.appendChild(createElement('label')); attemptLabel.htmlFor = 'e2e-attempt'; attemptLabel.textContent = 'Completed provider attempt';
		const attemptSelect = form.appendChild(createElement('select')); attemptSelect.id = 'e2e-attempt'; attemptSelect.required = true; attemptSelect.disabled = this.e2eBusy;
		const attemptPlaceholder = attemptSelect.appendChild(createElement('option')); attemptPlaceholder.value = ''; attemptPlaceholder.textContent = eligible.length ? 'Choose an attempt' : 'No completed task attempts';
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
		const urlLabel = form.appendChild(createElement('label')); urlLabel.htmlFor = 'e2e-url'; urlLabel.textContent = 'Target URL';
		const url = form.appendChild(createElement('input')); url.id = 'e2e-url'; url.type = 'url'; url.required = true; url.placeholder = 'http://localhost:3000'; url.value = this.e2eUrlDraft; url.disabled = this.e2eBusy; url.addEventListener('input', () => { this.e2eUrlDraft = url.value; });
		const envLabel = form.appendChild(createElement('label')); envLabel.htmlFor = 'e2e-environment'; envLabel.textContent = 'Environment identity';
		const env = form.appendChild(createElement('input')); env.id = 'e2e-environment'; env.type = 'text'; env.required = true; env.maxLength = 120; env.value = this.e2eEnvironmentDraft; env.disabled = this.e2eBusy; env.addEventListener('input', () => { this.e2eEnvironmentDraft = env.value; });
		const scenarioHeading = form.appendChild($('h4')); scenarioHeading.textContent = 'Scenario steps';
		const steps = form.appendChild(createElement('ol', 'project-dashboard__e2e-steps'));
		this.e2eScenarioDraft.forEach((draft, index) => {
			const row = steps.appendChild(createElement('li', 'project-dashboard__e2e-step'));
			const typeLabel = row.appendChild(createElement('label')); typeLabel.htmlFor = `e2e-step-${index}-type`; typeLabel.textContent = `Step ${index + 1} action`;
			const type = row.appendChild(createElement('select')); type.id = `e2e-step-${index}-type`; type.disabled = this.e2eBusy;
			for (const [value, label] of [['click', 'Click'], ['fill', 'Fill'], ['assertText', 'Assert text']] as const) { const option = type.appendChild(createElement('option')); option.value = value; option.textContent = label; }
			type.value = draft.type;
			type.addEventListener('change', () => { draft.type = type.value as WorkspaceE2eStep['type']; this.render(); });
			const selectorLabel = row.appendChild(createElement('label')); selectorLabel.htmlFor = `e2e-step-${index}-selector`; selectorLabel.textContent = 'CSS selector';
			const selector = row.appendChild(createElement('input')); selector.id = `e2e-step-${index}-selector`; selector.type = 'text'; selector.required = true; selector.maxLength = 500; selector.placeholder = 'button[type="submit"]'; selector.value = draft.selector; selector.disabled = this.e2eBusy; selector.addEventListener('input', () => { draft.selector = selector.value; });
			if (draft.type !== 'click') { const valueLabel = row.appendChild(createElement('label')); valueLabel.htmlFor = `e2e-step-${index}-value`; valueLabel.textContent = draft.type === 'fill' ? 'Text to fill' : 'Expected text'; const value = row.appendChild(createElement('input')); value.id = `e2e-step-${index}-value`; value.type = 'text'; value.required = true; value.maxLength = 2000; value.value = draft.value; value.disabled = this.e2eBusy; value.addEventListener('input', () => { draft.value = value.value; }); }
			const remove = row.appendChild(createElement('button', 'project-dashboard__secondary')); remove.type = 'button'; remove.textContent = 'Remove step'; remove.disabled = this.e2eBusy || this.e2eScenarioDraft.length <= 1; remove.addEventListener('click', () => { this.e2eScenarioDraft.splice(index, 1); this.render(); });
		});
		const actions = form.appendChild($('.project-dashboard__flow-actions'));
		const add = actions.appendChild(createElement('button', 'project-dashboard__secondary')); add.type = 'button'; add.textContent = 'Add step'; add.disabled = this.e2eBusy || this.e2eScenarioDraft.length >= 12; add.addEventListener('click', () => { this.e2eScenarioDraft.push({ type: 'click', selector: '', value: '' }); this.render(); });
		const start = actions.appendChild(createElement('button', 'project-dashboard__primary')); start.type = 'submit'; start.textContent = this.e2eBusy ? 'Starting…' : 'Start E2E check'; start.disabled = this.e2eBusy || this.e2eLoading || !attemptSelect.value;
		form.addEventListener('submit', event => { event.preventDefault(); if (!form.reportValidity()) return; this.e2eDraftAttemptId = attemptSelect.value; this.e2eUrlDraft = url.value; this.e2eEnvironmentDraft = env.value; void this.startWorkspaceE2e(task); });
		const listHeader = section.appendChild($('.project-dashboard__flow-actions'));
		const refresh = listHeader.appendChild(createElement('button', 'project-dashboard__secondary')); refresh.type = 'button'; refresh.textContent = this.e2eLoading ? 'Refreshing…' : 'Refresh evidence'; refresh.disabled = this.e2eBusy || this.e2eLoading; refresh.addEventListener('click', () => void this.loadWorkspaceE2e(task.id, true));
		for (const evidence of visibleEvidence) {
			const row = section.appendChild($('.project-dashboard__review-link'));
			const result = evidence.state === 'passed' ? 'Passed' : evidence.state === 'failed' ? 'Failed' : evidence.state === 'running' ? 'Running' : evidence.state === 'cleanupFailed' ? 'Cleanup needs attention' : 'Cancelled';
			const screenshotSaved = !!(evidence.screenshotSha256 && evidence.screenshotPath);
			const logSaved = !!(evidence.logSha256 && evidence.logPath);
			const info = row.appendChild($('span')); info.textContent = `${result} · ${new Date(evidence.createdAt).toLocaleString()} · ${evidence.environmentIdentity} · ${evidence.targetUrl}`;
			const artifactStatus = row.appendChild(createElement('span', 'project-dashboard__e2e-artifacts'));
			artifactStatus.textContent = evidence.state === 'running' ? 'Screenshot and log will be available when the check finishes.' : `Screenshot ${screenshotSaved ? 'saved' : 'not saved'} · Log ${logSaved ? 'saved' : 'not saved'}`;
			const audit = row.appendChild(createElement('details', 'project-dashboard__e2e-audit'));
			const auditSummary = audit.appendChild(createElement('summary')); auditSummary.textContent = 'Evidence file details';
			const auditList = audit.appendChild($('dl'));
			for (const [label, value] of [
				['Screenshot SHA-256', evidence.screenshotSha256 ?? 'Not available'], ['Screenshot path', evidence.screenshotPath ?? 'Not available'],
				['Log SHA-256', evidence.logSha256 ?? 'Not available'], ['Log path', evidence.logPath ?? 'Not available'],
			] as const) { const term = auditList.appendChild($('dt')); term.textContent = label; const detail = auditList.appendChild($('dd')); detail.textContent = value; }
			if (evidence.failure) { const failure = row.appendChild($('.project-dashboard__provider-error')); failure.setAttribute('role', 'status'); failure.textContent = evidence.failure; }
			if (evidence.cleanupError) { const cleanup = row.appendChild($('.project-dashboard__error')); cleanup.setAttribute('role', 'alert'); cleanup.textContent = `Cleanup needs attention: ${evidence.cleanupError}`; }
			const rowActions = row.appendChild($('.project-dashboard__flow-actions'));
			if (evidence.state === 'running') { const cancel = rowActions.appendChild(createElement('button', 'project-dashboard__secondary')); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.disabled = this.e2eBusy; cancel.addEventListener('click', () => void this.mutateWorkspaceE2e(task, evidence, 'cancel')); }
			if (evidence.state === 'cleanupFailed') { const retry = rowActions.appendChild(createElement('button', 'project-dashboard__secondary')); retry.type = 'button'; retry.textContent = 'Retry cleanup'; retry.disabled = this.e2eBusy; retry.addEventListener('click', () => void this.mutateWorkspaceE2e(task, evidence, 'retryCleanup')); }
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
			if (this.e2eRequestGeneration === requestGeneration && this.projectId === projectId && this.selectedTaskId === taskId) this.e2eError = this.errorMessage(error, 'Could not load E2E evidence.');
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
		catch (error) { this.e2eError = this.errorMessage(error, 'Could not start the E2E check.'); }
		finally { this.e2eBusy = false; this.render(); }
	}

	private async mutateWorkspaceE2e(task: WorkspaceDashboardTaskItemDTO, evidence: WorkspaceE2eEvidenceDTO, command: 'cancel' | 'retryCleanup'): Promise<void> {
		if (!this.projectId || this.e2eBusy) return;
		this.e2eBusy = true; this.e2eError = undefined; this.render();
		try { await ipcRenderer.invoke(WORKSPACE_E2E_CHANNEL, command, { projectId: this.projectId, taskId: task.id, evidenceId: evidence.id }); this.e2eLoadedTaskId = undefined; await this.loadWorkspaceE2e(task.id, true); }
		catch (error) { this.e2eError = this.errorMessage(error, command === 'cancel' ? 'Could not cancel the E2E check.' : 'Could not retry E2E cleanup.'); }
		finally { this.e2eBusy = false; this.render(); }
	}

	private renderProviderRuns(panel: HTMLElement, task: WorkspaceDashboardTaskItemDTO): void {
		const section = panel.appendChild($('.project-dashboard__provider'));
		const heading = section.appendChild($('h3')); heading.textContent = 'Local AI runs';
		const caption = section.appendChild($('p')); caption.className = 'project-dashboard__provider-note'; caption.textContent = 'Task runs can edit files in the project folder. Review the prompt, included project context, and permission summary before starting.';
		const taskStatus = section.appendChild($('.project-dashboard__run-state'));
		taskStatus.setAttribute('role', 'status');
		taskStatus.textContent = `Task state: ${columns.find(column => column.state === task.state)?.label ?? task.state}. ${task.state === 'done' ? 'Done tasks are not run automatically.' : task.state === 'ready' ? 'Preview the task run before starting.' : task.state === 'inProgress' ? 'Focused subagents are available while the parent run is active.' : 'Review the run results before marking Done.'}`;
		if (task.state === 'ready') {
			const choiceRow = section.appendChild($('.project-dashboard__provider-controls'));
			const label = choiceRow.appendChild(createElement('label')); label.htmlFor = 'provider-run-provider'; label.textContent = 'Provider';
			const choices = choiceRow.appendChild($('.project-dashboard__provider-segmented')); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', 'Provider');
			for (const [value, text] of [['codex', 'Codex'], ['claude', 'Claude']] as const) {
				const option = choices.appendChild(createElement('button', 'project-dashboard__provider-option')); option.type = 'button'; option.textContent = text;
				option.setAttribute('aria-pressed', String(this.providerId === value)); option.dataset.focusKey = `provider:${value}`; option.disabled = this.providerBusy;
				option.addEventListener('click', () => {
					if (this.providerId === value || this.providerBusy) return;
					this.providerId = value; this.preview = undefined; this.providerError = undefined; this.providerErrorKind = undefined; this.render();
				});
			}
			const previewButton = choiceRow.appendChild(createElement('button', 'project-dashboard__secondary'));
			previewButton.type = 'button'; previewButton.textContent = this.providerBusy ? 'Preparing…' : 'Preview task run'; previewButton.disabled = this.providerBusy;
			previewButton.dataset.focusKey = 'provider-preview';
			previewButton.addEventListener('click', () => void this.previewRun(task));
		}
		if (this.preview) {
			const preview = section.appendChild($('.project-dashboard__run-preview'));
			const previewHeading = preview.appendChild($('h4')); previewHeading.textContent = 'Mutating task run preview';
			const scope = preview.appendChild($('dl'));
			this.appendDefinition(scope, 'Mode', 'Mutating · explicit preview required');
			this.appendDefinition(scope, 'Local CLI profile', this.preview.accountLabel);
			this.appendDefinition(scope, 'Working folder', this.preview.cwd);
			this.appendDefinition(scope, 'Permission summary', this.preview.permission.summary);
			if (this.preview.permission.ordinaryFolderGrantRequired) {
				const warning = preview.appendChild($('.project-dashboard__run-warning'));
				warning.setAttribute('role', 'note');
				warning.textContent = `This is an ordinary folder without Git/JJ identity. Enabling edits grants mutation only to this exact folder identity. The grant is bound to its path and filesystem identity; replacing or moving the folder blocks the run. Review the canonical working folder: ${this.preview.cwd}`;
				if (this.preview.permission.ordinaryFolderGrantEnabled) {
					const enabled = preview.appendChild($('.project-dashboard__run-grant-state')); enabled.setAttribute('role', 'status');
					enabled.textContent = this.folderMutationGrant
						? `Edit grant active for ${this.folderMutationGrant.canonicalPath} (device ${this.folderMutationGrant.dev}, inode ${this.folderMutationGrant.ino}).`
						: 'Edit grant active for the exact folder identity shown above.';
				}
				const permissionActions = preview.appendChild($('.project-dashboard__provider-actions'));
				const grant = permissionActions.appendChild(createElement('button', 'project-dashboard__secondary'));
				grant.type = 'button'; grant.disabled = this.providerBusy || this.preview.permission.ordinaryFolderGrantEnabled;
				grant.textContent = this.providerBusy ? 'Updating permission…' : 'Enable edits for this folder';
				grant.addEventListener('click', () => void this.mutateFolderGrant(task, 'enableFolderMutation'));
				const revoke = permissionActions.appendChild(createElement('button', 'project-dashboard__secondary'));
				revoke.type = 'button'; revoke.disabled = this.providerBusy || !this.preview.permission.ordinaryFolderGrantEnabled;
				revoke.textContent = 'Revoke folder edit grant';
				revoke.addEventListener('click', () => void this.mutateFolderGrant(task, 'revokeFolderMutation'));
			}
			if (this.preview.conventionSnapshot) {
				const conventionHeading = preview.appendChild($('h4')); conventionHeading.textContent = `Active convention · v${this.preview.conventionSnapshot.version}`;
				const conventionMeta = preview.appendChild($('.project-dashboard__run-snapshot-meta')); conventionMeta.textContent = `SHA-256 ${this.preview.conventionSnapshot.contentSha256}`;
				const conventionContent = preview.appendChild(createElement('pre', 'project-dashboard__run-context')); conventionContent.textContent = this.preview.conventionSnapshot.markdown;
			} else {
				const noConvention = preview.appendChild($('.project-dashboard__run-snapshot-meta')); noConvention.textContent = 'No active project convention is attached.';
			}
			const referencesHeading = preview.appendChild($('h4')); referencesHeading.textContent = `Linked reference snapshots · ${this.preview.references.length}`;
			if (!this.preview.references.length) { const empty = preview.appendChild($('.project-dashboard__run-snapshot-meta')); empty.textContent = 'No reference snapshots are linked to this task.'; }
			for (const reference of this.preview.references) {
				const snapshot = preview.appendChild($('.project-dashboard__run-reference'));
				const referenceTitle = snapshot.appendChild($('strong')); referenceTitle.textContent = `${reference.title} · v${reference.version}`;
				const referenceHash = snapshot.appendChild($('.project-dashboard__run-snapshot-meta')); referenceHash.textContent = `${reference.contentType} · SHA-256 ${reference.contentSha256}`;
				const referenceContent = snapshot.appendChild(createElement('pre', 'project-dashboard__run-context')); referenceContent.textContent = reference.content;
			}
			if (this.preview.permission.blockedReason) {
				const blocked = preview.appendChild($('.project-dashboard__run-blocked')); blocked.setAttribute('role', 'alert'); blocked.textContent = this.preview.permission.blockedReason;
			}
			const promptLabel = preview.appendChild(createElement('h4')); promptLabel.textContent = 'Prompt';
			const prompt = preview.appendChild(createElement('pre', 'project-dashboard__prompt')); prompt.textContent = this.preview.prompt;
			const actions = preview.appendChild($('.project-dashboard__provider-actions'));
			const start = actions.appendChild(createElement('button', 'project-dashboard__primary')); start.type = 'button'; start.textContent = this.providerBusy ? 'Starting…' : 'Run task'; start.disabled = this.providerBusy || task.state !== 'ready' || !this.preview.permission.allowed;
			start.dataset.focusKey = 'provider-start';
			start.addEventListener('click', () => void this.startRun(task));
		}
		this.renderSubagentControls(section, task);
		if (this.providerError) {
			const error = section.appendChild($('.project-dashboard__provider-error')); error.setAttribute('role', 'alert'); error.textContent = this.providerError;
		}
		const history = section.appendChild($('.project-dashboard__attempts'));
		const historyTitle = history.appendChild($('h4')); historyTitle.textContent = 'Run history';
		if (!this.attempts.length) {
			const empty = history.appendChild($('p')); empty.className = 'project-dashboard__provider-note'; empty.textContent = 'No runs for this task yet.';
		} else {
			const list = history.appendChild(createElement('ul'));
			for (const attempt of this.attempts.filter(candidate => !candidate.parentAttemptId)) {
				const item = list.appendChild(createElement('li', 'project-dashboard__attempt'));
				const main = item.appendChild($('.project-dashboard__attempt-main'));
				const name = main.appendChild($('strong')); name.textContent = `${attempt.providerId === 'codex' ? 'Codex' : 'Claude'} · ${this.stateLabel(attempt.state)}`;
				const time = main.appendChild(createElement('time')); time.dateTime = attempt.updatedAt; time.textContent = new Date(attempt.updatedAt).toLocaleString();
				const detail = item.appendChild($('.project-dashboard__attempt-detail')); detail.textContent = `${attempt.mode === 'mutating' ? 'Mutating task run' : 'Read-only connection check'} · ${attempt.accountLabel} · ${attempt.cwd}`;
				if (attempt.orchestrationPhase === 'waiting') { const waiting = item.appendChild($('.project-dashboard__attempt-detail')); waiting.textContent = this.attempts.some(child => child.parentAttemptId === attempt.id) ? 'Waiting for subagents and cleanup before Review.' : 'Waiting for run cleanup before Review.'; }
				if (attempt.sessionId) { const session = item.appendChild($('.project-dashboard__attempt-detail')); session.textContent = `Session ${attempt.sessionId}`; }
				if (attempt.errorSummary) { const failure = item.appendChild($('.project-dashboard__attempt-error')); failure.textContent = attempt.errorSummary; }
				if (attempt.resultText) { const result = item.appendChild(createElement('pre', 'project-dashboard__subagent-result')); result.textContent = attempt.resultText; }
				if (attempt.ordinaryFolderChanges) {
					const report = attempt.ordinaryFolderChanges;
					const changes = item.appendChild(createElement('div', 'project-dashboard__attempt-folder-changes'));
					changes.setAttribute('role', 'status');
					const count = report.changes.length;
					changes.textContent = report.status === 'unverified'
						? `Ordinary folder changes could not be verified. ${report.summary}`
						: `${count} ordinary folder ${count === 1 ? 'change' : 'changes'} observed${report.truncated ? ' (report truncated)' : ''}. ${report.summary}${count ? ` ${report.changes.map(change => `${change.change}: ${change.path}`).join('; ')}` : ''}`;
				}
				this.renderSubagentHistory(item, task, attempt);
				const hasActiveChildren = this.attempts.some(child => child.parentAttemptId === attempt.id && this.isActive(child.state));
				if (this.isActive(attempt.state) || (attempt.orchestrationPhase === 'waiting' && hasActiveChildren)) {
					const cancel = item.appendChild(createElement('button', 'project-dashboard__secondary')); cancel.type = 'button'; cancel.textContent = this.isActive(attempt.state) ? 'Cancel run' : 'Cancel subagents'; cancel.disabled = this.providerBusy;
					cancel.dataset.focusKey = `cancel:${attempt.id}`;
					cancel.addEventListener('click', () => void this.cancelRun(attempt));
				}
			}
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
		const summary = form.appendChild(createElement('summary')); summary.textContent = 'Delegate a focused subagent';
		const note = form.appendChild($('p')); note.className = 'project-dashboard__provider-note'; note.textContent = 'Give Codex or Claude one clear task within this project. The app records its own run, result, and cleanup separately.';
		const fields = form.appendChild($('.project-dashboard__subagent-fields'));
		const providerLabel = fields.appendChild(createElement('label')); providerLabel.htmlFor = 'subagent-provider'; providerLabel.textContent = 'Provider';
		const provider = fields.appendChild(createElement('select')); provider.id = 'subagent-provider'; provider.disabled = this.providerBusy;
		for (const [value, label] of [['codex', 'Codex'], ['claude', 'Claude']] as const) {
			const option = provider.appendChild(createElement('option')); option.value = value; option.textContent = label;
		}
		provider.value = this.subagentProviderId;
		provider.addEventListener('change', () => { this.subagentProviderId = provider.value as ProviderId; this.subagentPreview = undefined; this.subagentError = undefined; this.render(); });
		const scopeLabel = fields.appendChild(createElement('label')); scopeLabel.htmlFor = 'subagent-scope'; scopeLabel.textContent = 'Focused assignment';
		const scope = fields.appendChild(createElement('textarea')); scope.id = 'subagent-scope'; scope.rows = 3; scope.value = this.subagentScopeDraft; scope.disabled = this.providerBusy;
		scope.placeholder = 'Example: inspect the parser change and report edge cases with file references.';
		const count = fields.appendChild($('.project-dashboard__subagent-count'));
		const scopeBytes = () => this.subagentScopeDraft.trim() ? new TextEncoder().encode(JSON.stringify({ scope: this.subagentScopeDraft.trim() })).length : 0;
		const updateCount = () => { count.textContent = `${scopeBytes()} / 8192 saved bytes`; count.classList.toggle('project-dashboard__subagent-count--over', scopeBytes() > 8192); };
		updateCount();
		const actions = form.appendChild($('.project-dashboard__provider-actions'));
		const previewButton = actions.appendChild(createElement('button', 'project-dashboard__secondary')); previewButton.type = 'button'; previewButton.textContent = this.providerBusy ? 'Preparing…' : 'Preview subagent';
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
			const previewHeading = preview.appendChild($('h4')); previewHeading.textContent = 'Subagent run preview';
			const facts = preview.appendChild($('dl'));
			this.appendDefinition(facts, 'Local CLI profile', this.subagentPreview.accountLabel);
			this.appendDefinition(facts, 'Working folder', this.subagentPreview.cwd);
			this.appendDefinition(facts, 'Permission', this.subagentPreview.permission.summary);
			this.appendDefinition(facts, 'Project convention', this.subagentPreview.conventionSnapshot ? `Version ${this.subagentPreview.conventionSnapshot.version}` : 'None active');
			this.appendDefinition(facts, 'References', `${this.subagentPreview.references.length} linked snapshots`);
			if (this.subagentPreview.permission.ordinaryFolderGrantRequired) {
				const grantState = preview.appendChild($('.project-dashboard__run-grant-state'));
				grantState.textContent = this.subagentPreview.permission.ordinaryFolderGrantEnabled
					? 'Edits are enabled for this exact ordinary folder.'
					: 'This ordinary folder needs an edit grant before the subagent can start.';
				if (!this.subagentPreview.permission.ordinaryFolderGrantEnabled) {
					const grant = preview.appendChild(createElement('button', 'project-dashboard__secondary')); grant.type = 'button'; grant.textContent = 'Enable edits for this folder'; grant.disabled = this.providerBusy;
					grant.addEventListener('click', () => void this.enableSubagentFolderGrant(task, root));
				}
			}
			const prompt = preview.appendChild(createElement('pre', 'project-dashboard__run-context')); prompt.textContent = this.subagentPreview.prompt;
			if (this.subagentPreview.permission.blockedReason) {
				const blocked = preview.appendChild($('.project-dashboard__run-blocked')); blocked.setAttribute('role', 'alert'); blocked.textContent = this.subagentPreview.permission.blockedReason;
			}
			const start = preview.appendChild(createElement('button', 'project-dashboard__primary')); start.type = 'button'; start.textContent = this.providerBusy ? 'Starting…' : 'Start subagent';
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
		summary.textContent = `${children.length} ${children.length === 1 ? 'subagent' : 'subagents'} · ${failedCount ? `${failedCount} need attention` : activeCount ? `${activeCount} active` : 'finished'}`;
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
			const retry = details.appendChild(createElement('button', 'project-dashboard__secondary')); retry.type = 'button'; retry.textContent = 'Retry loading events'; retry.addEventListener('click', () => void this.loadSubagentEvents(task.id, root.id));
		}
		const list = details.appendChild(createElement('ul', 'project-dashboard__subagent-list'));
		for (const child of children) {
			const row = list.appendChild(createElement('li', 'project-dashboard__subagent'));
			const title = row.appendChild($('strong')); title.textContent = `${child.providerId === 'codex' ? 'Codex' : 'Claude'} · ${this.stateLabel(child.state)}`;
			const when = row.appendChild(createElement('time')); when.dateTime = child.updatedAt; when.textContent = new Date(child.updatedAt).toLocaleString();
			const scope = row.appendChild($('p')); scope.textContent = this.subagentScopeText(child.childScope ?? null);
			if (child.errorSummary) { const error = row.appendChild($('.project-dashboard__attempt-error')); error.textContent = child.errorSummary; }
			if (child.resultText !== null && child.resultText !== undefined) {
				const result = row.appendChild(createElement('pre', 'project-dashboard__subagent-result')); result.textContent = child.resultText || 'The subagent completed without a written result.';
			}
			const events = this.subagentEvents[child.id];
			if (events?.length) {
				const eventDetails = row.appendChild(createElement('details', 'project-dashboard__subagent-events'));
				const eventSummary = eventDetails.appendChild(createElement('summary')); eventSummary.textContent = `${events.length} recent events`;
				const eventList = eventDetails.appendChild(createElement('ol'));
				for (const event of events) { const eventRow = eventList.appendChild(createElement('li')); eventRow.textContent = `${event.type} · ${new Date(event.createdAt).toLocaleTimeString()}`; }
			}
			if (this.isActive(child.state)) {
				const cancel = row.appendChild(createElement('button', 'project-dashboard__secondary')); cancel.type = 'button'; cancel.textContent = 'Cancel subagent'; cancel.disabled = this.providerBusy;
				cancel.addEventListener('click', () => void this.cancelRun(child));
			}
		}
	}

	private subagentScopeText(encoded: string | null): string {
		if (!encoded) return 'No focused assignment recorded.';
		try {
			const value: unknown = JSON.parse(encoded);
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				if (typeof (value as { scope?: unknown }).scope === 'string') return (value as { scope: string }).scope;
				const files = (value as { files?: unknown }).files;
				if (Array.isArray(files) && files.every(file => typeof file === 'string')) return files.length ? `Files: ${files.join(', ')}` : 'No files were specified.';
				return JSON.stringify(value);
			}
		} catch { return 'The saved assignment could not be read.'; }
		return 'The saved assignment has an unsupported format.';
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
			this.providerError = this.errorMessage(error, 'Could not update this folder’s edit permission.'); this.providerErrorKind = 'operation';
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
		} catch (error) { if (this.selectedTaskId === task.id && this.providerId === providerId) { this.providerError = this.errorMessage(error, 'Could not prepare the run preview.'); this.providerErrorKind = 'operation'; } }
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
			if (this.projectId === projectId && this.selectedTaskId === task.id) this.subagentError = this.errorMessage(error, 'Could not prepare the subagent preview.');
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
			if (this.projectId === projectId && this.selectedTaskId === task.id) this.subagentError = this.errorMessage(error, 'Could not enable edits for this folder.');
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
		} catch (error) { if (this.projectId === projectId && this.selectedTaskId === task.id) this.subagentError = this.errorMessage(error, 'Could not start the subagent.'); }
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
				this.subagentEventsError = this.errorMessage(error, 'Could not load subagent events.'); this.render();
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
		} catch (error) { this.providerError = this.errorMessage(error, 'Could not start the run.'); this.providerErrorKind = 'operation'; }
		finally { this.providerBusy = false; this.render(); this.updatePolling(); }
	}

	private async cancelRun(attempt: ProviderAttemptDTO): Promise<void> {
		if (!this.projectId || this.providerBusy) return;
		this.providerBusy = true; this.providerError = undefined; this.providerErrorKind = undefined; this.render();
		try {
			await ipcRenderer.invoke(WORKSPACE_PROVIDER_RUNS_CHANNEL, 'cancel', { projectId: this.projectId, attemptId: attempt.id });
			await this.loadAttempts();
		} catch (error) { this.providerError = this.errorMessage(error, 'Could not cancel the run.'); this.providerErrorKind = 'operation'; }
		finally { this.providerBusy = false; this.render(); this.updatePolling(); }
	}

	private async loadAttempts(refreshDashboardOnStateChange = true): Promise<void> {
		if (!this.projectId || !this.selectedTaskId) return;
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
		} catch (error) { if (this.projectId === projectId && this.selectedTaskId === taskId) { this.providerError = this.errorMessage(error, 'Could not load run history.'); this.providerErrorKind = 'history'; this.render(); } }
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
				this.providerError = this.errorMessage(error, 'Could not refresh the task after the run state changed.');
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
	private stateLabel(state: ProviderAttemptDTO['state']): string { return ({ queued: 'Queued', preflight: 'Checking access', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' })[state]; }
	private errorMessage(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }

	private renderCreateForm(shell: HTMLElement): void {
		const details = shell.appendChild(createElement('details', 'project-dashboard__form'));
		details.open = this.dashboard?.tasks.length === 0 || this.createFormOpen;
		details.addEventListener('toggle', () => { this.createFormOpen = details.open; });
		const summary = details.appendChild(createElement('summary')); summary.textContent = 'Create task';
		const form = details.appendChild(createElement('form', 'project-dashboard__form-content'));
		const heading = form.appendChild($('h2')); heading.textContent = 'New task';
		const titleLabel = form.appendChild(createElement('label')); titleLabel.htmlFor = 'project-task-title'; titleLabel.textContent = 'Task title';
		const title = form.appendChild(createElement('input')); title.id = 'project-task-title'; title.type = 'text'; title.maxLength = 160; title.required = true; title.placeholder = 'What needs to get done?'; title.value = this.createTaskTitleDraft;
		title.dataset.focusKey = 'create-task-title';
		title.addEventListener('input', () => { this.createTaskTitleDraft = title.value; if (title.value.trim()) title.removeAttribute('aria-invalid'); });
		const descriptionLabel = form.appendChild(createElement('label')); descriptionLabel.htmlFor = 'project-task-description'; descriptionLabel.textContent = 'Description (optional)';
		const description = form.appendChild(createElement('textarea')); description.id = 'project-task-description'; description.rows = 3; description.maxLength = 2000; description.placeholder = 'Add a little context'; description.value = this.createTaskDescriptionDraft;
		description.dataset.focusKey = 'create-task-description';
		description.addEventListener('input', () => { this.createTaskDescriptionDraft = description.value; });
		const actions = form.appendChild($('.project-dashboard__form-actions'));
		const submit = actions.appendChild(createElement('button', 'project-dashboard__primary')); submit.type = 'submit'; submit.textContent = 'Create task'; submit.disabled = this.creating;
		submit.dataset.focusKey = 'create-task-submit';
		form.addEventListener('submit', event => { event.preventDefault(); void this.createTask(title, description, submit); });
	}

	layout(dimension: Dimension): void {
		if (this.root) { this.root.style.width = `${dimension.width}px`; this.root.style.height = `${dimension.height}px`; }
	}
	override clearInput(): void { this.inputActive = false; void this.flushDashboardState(); this.stopPolling(); this.selectedTaskId = undefined; this.preview = undefined; this.attempts = []; this.subagentTaskId = undefined; this.subagentParentAttemptId = undefined; this.subagentPreview = undefined; this.subagentScopeDraft = ''; this.subagentFormOpen = false; this.expandedSubagentRootId = undefined; this.subagentEvents = {}; this.subagentError = undefined; this.subagentEventsError = undefined; if (this.root) clearNode(this.root); super.clearInput(); }
	override dispose(): void {
		this.inputActive = false;
		void this.closeEgoCapture();
		if (this.stateSaveTimer) clearTimeout(this.stateSaveTimer);
		this.stateSaveTimer = undefined;
		void this.flushDashboardState();
		this.root?.removeEventListener('scroll', this.persistScrollPosition);
		this.stopPolling(); document.removeEventListener('visibilitychange', this.refreshOnReturn); window.removeEventListener('focus', this.refreshOnReturn); super.dispose();
	}
}
