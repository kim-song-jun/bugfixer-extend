import { Codicon } from '../../../base/common/codicons.js';
import type { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { EditorInputCapabilities, type IUntypedEditorInput } from '../../../workbench/common/editor.js';
import { EditorInput } from '../../../workbench/common/editor/editorInput.js';

export class ProjectHomeEditorInput extends EditorInput {
	static readonly ID = 'workbench.editors.devfast.projectHome';
	static readonly EDITOR_ID = 'workbench.editor.devfast.projectHome';
	readonly resource = URI.from({ scheme: 'devfast-project-home', path: '/projects' });

	override get typeId(): string { return ProjectHomeEditorInput.ID; }
	override get editorId(): string { return ProjectHomeEditorInput.EDITOR_ID; }
	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.ForceReveal | EditorInputCapabilities.CannotClose;
	}
	override getName(): string { return '프로젝트'; }
	override getIcon(): ThemeIcon { return Codicon.folder; }
	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof ProjectHomeEditorInput;
	}
}
