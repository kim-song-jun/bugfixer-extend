import type { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import type { IEditorSerializer } from '../../../workbench/common/editor.js';
import type { EditorInput } from '../../../workbench/common/editor/editorInput.js';
import { INativeWorkbenchEnvironmentService } from '../../../workbench/services/environment/electron-browser/environmentService.js';
import { ProjectDashboardEditorInput } from './projectDashboardEditorInput.js';

export class ProjectDashboardEditorSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ProjectDashboardEditorInput;
	}
	serialize(editor: ProjectDashboardEditorInput): string | undefined {
		return this.canSerialize(editor) ? JSON.stringify({ projectId: editor.projectId }) : undefined;
	}
	deserialize(instantiationService: IInstantiationService, value: string): EditorInput | undefined {
		let saved: unknown;
		try {
			saved = JSON.parse(value);
		} catch {
			// Corrupt persisted editor state is not restorable; let workbench restore other tabs.
			return undefined;
		}
		if (!saved || typeof saved !== 'object' || !('projectId' in saved) || typeof saved.projectId !== 'string') return;
		const launch = instantiationService.invokeFunction(accessor => accessor.get(INativeWorkbenchEnvironmentService).reviewWindowLaunch);
		return launch.kind === 'project' && launch.projectId === saved.projectId
			? instantiationService.createInstance(ProjectDashboardEditorInput, saved.projectId)
			: undefined;
	}
}
