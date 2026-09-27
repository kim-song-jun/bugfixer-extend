import { Disposable } from '../../../base/common/lifecycle.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../workbench/browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import { EditorExtensions, type IEditorFactoryRegistry } from '../../../workbench/common/editor.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { INativeWorkbenchEnvironmentService } from '../../../workbench/services/environment/electron-browser/environmentService.js';
import { ProjectHomeEditorInput } from './projectHomeEditorInput.js';
import { ProjectHomeEditorPane } from './projectHomeEditorPane.js';
import { ProjectHomeEditorSerializer } from './projectHomeEditorSerializer.js';

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ProjectHomeEditorInput.ID, ProjectHomeEditorSerializer);
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ProjectHomeEditorPane, ProjectHomeEditorPane.ID, '프로젝트 선택'),
	[new SyncDescriptor(ProjectHomeEditorInput)],
);

class ProjectHomeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.devfast.projectHome';
	constructor(
		@INativeWorkbenchEnvironmentService private readonly environment: INativeWorkbenchEnvironmentService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		void this.initialize().catch(error => this.notificationService.error(error));
	}
	private async initialize(): Promise<void> {
		if (this.environment.reviewWindowLaunch.kind !== 'home') return;
		await this.groups.whenRestored;
		this.layout.setPartHidden(true, Parts.SIDEBAR_PART);
		const existing = this.groups.groups.flatMap(group => group.editors).find(editor => editor instanceof ProjectHomeEditorInput);
		const input = existing ?? this.instantiation.createInstance(ProjectHomeEditorInput);
		await this.editorService.openEditor(input, { pinned: true, revealIfVisible: true });
	}
}
registerWorkbenchContribution2(ProjectHomeContribution.ID, ProjectHomeContribution, WorkbenchPhase.AfterRestored);
