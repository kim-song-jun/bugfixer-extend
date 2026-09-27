import { Disposable } from '../../../base/common/lifecycle.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../workbench/browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import { EditorExtensions, type IEditorFactoryRegistry } from '../../../workbench/common/editor.js';
import { ViewContainerLocation } from '../../../workbench/common/views.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { INativeWorkbenchEnvironmentService } from '../../../workbench/services/environment/electron-browser/environmentService.js';
import { IPaneCompositePartService } from '../../../workbench/services/panecomposite/browser/panecomposite.js';
import { ProjectDashboardEditorInput } from './projectDashboardEditorInput.js';
import { ProjectDashboardEditorPane } from './projectDashboardEditorPane.js';
import { ProjectDashboardEditorSerializer } from './projectDashboardEditorSerializer.js';
import { onDidRequestNewTask, onDidRequestProjectSection, PROJECT_SIDEBAR_CONTAINER_ID, type ProjectSidebarSection } from './projectSidebar.contribution.js';

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	ProjectDashboardEditorInput.ID, ProjectDashboardEditorSerializer,
);
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ProjectDashboardEditorPane, ProjectDashboardEditorPane.ID, '프로젝트 대시보드'),
	[new SyncDescriptor(ProjectDashboardEditorInput)],
);

class ProjectDashboardContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.devfast.projectDashboard';

	constructor(
		@INativeWorkbenchEnvironmentService private readonly environment: INativeWorkbenchEnvironmentService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@INotificationService private readonly notificationService: INotificationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(onDidRequestProjectSection(section => {
			void this.openProjectDashboard(section, false, true).catch(error => this.notificationService.error(error));
		}));
		this._register(onDidRequestNewTask(() => {
			void this.openProjectDashboard(undefined, true, true).catch(error => this.notificationService.error(error));
		}));
		void this.openProjectDashboard().catch(error => this.notificationService.error(error));
	}

	private async openProjectDashboard(section?: ProjectSidebarSection, createTask = false, activate = false): Promise<void> {
		const launch = this.environment.reviewWindowLaunch;
		if (launch.kind !== 'project') return;

		await this.editorGroupsService.whenRestored;
		try {
			this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
			const sidebar = await this.paneCompositeService.openPaneComposite(PROJECT_SIDEBAR_CONTAINER_ID, ViewContainerLocation.Sidebar);
			if (!sidebar) throw new Error('프로젝트 탐색을 열지 못했습니다.');
		} catch (error) {
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			this.notificationService.error(error);
		}
		const existing = this.editorGroupsService.groups
			.flatMap(group => group.editors.map(editor => ({ editor, group })))
			.find(({ editor }) => editor instanceof ProjectDashboardEditorInput && editor.projectId === launch.projectId);
		const input = existing?.editor ?? this.instantiationService.createInstance(ProjectDashboardEditorInput, launch.projectId);
		const targetGroup = existing?.group ?? this.editorGroupsService.activeGroup;
		const activeEditor = this.editorGroupsService.activeGroup.activeEditor;
		const preserveActiveEditor = !activate && activeEditor !== null && !(activeEditor instanceof ProjectDashboardEditorInput);
		const pane = await this.editorService.openEditor(input, {
			pinned: true,
			revealIfVisible: true,
			index: 0,
			...(preserveActiveEditor ? { inactive: true, preserveFocus: true } : {})
		}, targetGroup);
		if (pane instanceof ProjectDashboardEditorPane) {
			if (createTask) pane.startTaskCreation();
			else if (section) pane.navigateToSection(section);
		}
	}
}

registerWorkbenchContribution2(
	ProjectDashboardContribution.ID,
	ProjectDashboardContribution,
	WorkbenchPhase.AfterRestored,
);
