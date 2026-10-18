import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IEditorSerializer } from '../../../../../workbench/common/editor.js';
import type { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { INativeWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/electron-browser/environmentService.js';
import { AgentSessionWorkspaceEditorInput } from './sessionWorkspaceEditorInput.js';

export class AgentSessionWorkspaceEditorSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean { return editor instanceof AgentSessionWorkspaceEditorInput; }
	serialize(editor: AgentSessionWorkspaceEditorInput): string | undefined { return this.canSerialize(editor) ? JSON.stringify({ projectId: editor.projectId }) : undefined; }
	deserialize(instantiationService: IInstantiationService, value: string): EditorInput | undefined {
		let saved: unknown;
		try { saved = JSON.parse(value); } catch { return undefined; }
		if (!saved || typeof saved !== 'object' || !('projectId' in saved) || typeof saved.projectId !== 'string') return undefined;
		const launch = instantiationService.invokeFunction(accessor => accessor.get(INativeWorkbenchEnvironmentService).reviewWindowLaunch);
		return launch.kind === 'project' && launch.projectId === saved.projectId
			? instantiationService.createInstance(AgentSessionWorkspaceEditorInput, saved.projectId)
			: undefined;
	}
}
