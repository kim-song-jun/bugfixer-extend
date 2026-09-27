import type { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import type { IEditorSerializer } from '../../../workbench/common/editor.js';
import type { EditorInput } from '../../../workbench/common/editor/editorInput.js';
import { INativeWorkbenchEnvironmentService } from '../../../workbench/services/environment/electron-browser/environmentService.js';
import { ProjectHomeEditorInput } from './projectHomeEditorInput.js';

export class ProjectHomeEditorSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean { return editor instanceof ProjectHomeEditorInput; }
	serialize(editor: ProjectHomeEditorInput): string | undefined { return this.canSerialize(editor) ? '{}' : undefined; }
	deserialize(instantiationService: IInstantiationService, value: string): EditorInput | undefined {
		if (value !== '{}') return undefined;
		const launch = instantiationService.invokeFunction(accessor => accessor.get(INativeWorkbenchEnvironmentService).reviewWindowLaunch);
		return launch.kind === 'home' ? instantiationService.createInstance(ProjectHomeEditorInput) : undefined;
	}
}
