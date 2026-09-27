import { Codicon } from '../../../base/common/codicons.js';
import type { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { EditorInputCapabilities, type IUntypedEditorInput } from '../../../workbench/common/editor.js';
import { EditorInput } from '../../../workbench/common/editor/editorInput.js';

export class ProjectDashboardEditorInput extends EditorInput {
	static readonly ID = 'workbench.editors.devfast.projectDashboard';
	static readonly EDITOR_ID = 'workbench.editor.devfast.projectDashboard';
	readonly resource: URI;

	constructor(readonly projectId: string) {
		super();
		this.resource = URI.from({ scheme: 'devfast-project-dashboard', path: `/${projectId}` });
	}

	override get typeId(): string { return ProjectDashboardEditorInput.ID; }
	override get editorId(): string { return ProjectDashboardEditorInput.EDITOR_ID; }
	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.ForceReveal;
	}
	override getName(): string { return '대시보드'; }
	override getIcon(): ThemeIcon { return Codicon.dashboard; }
	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof ProjectDashboardEditorInput && other.projectId === this.projectId;
	}
}
