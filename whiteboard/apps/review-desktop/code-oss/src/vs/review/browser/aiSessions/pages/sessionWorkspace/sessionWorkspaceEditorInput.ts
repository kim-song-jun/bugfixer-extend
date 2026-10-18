import { Codicon } from '../../../../../base/common/codicons.js';
import type { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { EditorInputCapabilities, type IUntypedEditorInput } from '../../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';

export class AgentSessionWorkspaceEditorInput extends EditorInput {
	static readonly ID = 'workbench.editors.devfast.aiSessionWorkspace';
	static readonly EDITOR_ID = 'workbench.editor.devfast.aiSessionWorkspace';
	readonly resource: URI;

	constructor(readonly projectId: string) {
		super();
		this.resource = URI.from({ scheme: 'devfast-ai-sessions', path: `/${projectId}` });
	}
	override get typeId(): string { return AgentSessionWorkspaceEditorInput.ID; }
	override get editorId(): string { return AgentSessionWorkspaceEditorInput.EDITOR_ID; }
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.ForceReveal; }
	override getName(): string { return 'AI 세션'; }
	override getIcon(): ThemeIcon { return Codicon.terminal; }
	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof AgentSessionWorkspaceEditorInput && other.projectId === this.projectId;
	}
}
