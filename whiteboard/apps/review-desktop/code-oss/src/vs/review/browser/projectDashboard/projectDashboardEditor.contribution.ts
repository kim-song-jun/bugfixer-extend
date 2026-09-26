import { Disposable } from '../../../base/common/lifecycle.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../workbench/browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import { EditorExtensions, type IEditorFactoryRegistry } from '../../../workbench/common/editor.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { INativeWorkbenchEnvironmentService } from '../../../workbench/services/environment/electron-browser/environmentService.js';
import { ProjectDashboardEditorInput } from './projectDashboardEditorInput.js';
import { ProjectDashboardEditorPane } from './projectDashboardEditorPane.js';
import { ProjectDashboardEditorSerializer } from './projectDashboardEditorSerializer.js';

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	ProjectDashboardEditorInput.ID, ProjectDashboardEditorSerializer,
);
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ProjectDashboardEditorPane, ProjectDashboardEditorPane.ID, 'Project Dashboard'),
	[new SyncDescriptor(ProjectDashboardEditorInput)],
);

class ProjectDashboardContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.devfast.projectDashboard';

	constructor(
		@INativeWorkbenchEnvironmentService private readonly environment: INativeWorkbenchEnvironmentService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		void this.openProjectDashboard();
	}

	private async openProjectDashboard(): Promise<void> {
		const launch = this.environment.reviewWindowLaunch;
		if (launch.kind !== 'project') return;

		await this.editorGroupsService.whenRestored;
		const existing = this.editorGroupsService.groups.flatMap(group => group.editors).find(editor =>
			editor instanceof ProjectDashboardEditorInput && editor.projectId === launch.projectId);
		const input = existing ?? this.instantiationService.createInstance(ProjectDashboardEditorInput, launch.projectId);
		await this.editorService.openEditor(input, { pinned: true, revealIfVisible: true });
	}
}

registerWorkbenchContribution2(
	ProjectDashboardContribution.ID,
	ProjectDashboardContribution,
	WorkbenchPhase.AfterRestored,
);
