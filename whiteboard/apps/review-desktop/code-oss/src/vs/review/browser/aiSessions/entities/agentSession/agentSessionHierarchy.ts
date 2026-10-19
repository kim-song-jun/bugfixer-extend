import type { AgentSessionDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';

export interface AgentSessionHierarchyNode {
	readonly session: AgentSessionDTO;
	readonly parentId: string | null;
	readonly depth: number;
	readonly hasChildren: boolean;
	readonly relationshipIssue?: 'missingParent' | 'ownershipMismatch' | 'cycle';
}

/** Use only registered ownership links. Invalid links remain visible as independent roots. */
export function buildAgentSessionHierarchy(sessions: readonly AgentSessionDTO[]): readonly AgentSessionHierarchyNode[] {
	const byId = new Map<string, AgentSessionDTO>();
	for (const session of sessions) {
		if (byId.has(session.id)) { throw new Error('Duplicate session ID in the project session list.'); }
		byId.set(session.id, session);
	}
	const children = new Map<string, AgentSessionDTO[]>();
	const roots: { session: AgentSessionDTO; relationshipIssue?: AgentSessionHierarchyNode['relationshipIssue'] }[] = [];
	for (const session of sessions) {
		const parent = session.parentSessionId ? byId.get(session.parentSessionId) : undefined;
		if (!session.parentSessionId) { roots.push({ session }); }
		else if (!parent) { roots.push({ session, relationshipIssue: 'missingParent' }); }
		else if (parent.projectId !== session.projectId || parent.bindingId !== session.bindingId || parent.taskId !== session.taskId) {
			roots.push({ session, relationshipIssue: 'ownershipMismatch' });
		} else {
			const siblings = children.get(parent.id) ?? [];
			siblings.push(session);
			children.set(parent.id, siblings);
		}
	}
	const result: AgentSessionHierarchyNode[] = [];
	const visited = new Set<string>();
	const visit = (session: AgentSessionDTO, relationshipIssue?: AgentSessionHierarchyNode['relationshipIssue']): void => {
		const pending = [{ session, parentId: null as string | null, depth: 0, relationshipIssue }];
		while (pending.length) {
			const node = pending.pop()!;
			if (visited.has(node.session.id)) { continue; }
			visited.add(node.session.id);
			result.push({ ...node, hasChildren: false });
			for (const child of [...(children.get(node.session.id) ?? [])].reverse()) {
				pending.push({ session: child, parentId: node.session.id, depth: node.depth + 1, relationshipIssue: undefined });
			}
		}
	};
	for (const root of roots) { visit(root.session, root.relationshipIssue); }
	for (const session of sessions) { if (!visited.has(session.id)) { visit(session, 'cycle'); } }
	const parents = new Set(result.map(node => node.parentId).filter(id => id !== null));
	return result.map(node => ({ ...node, hasChildren: parents.has(node.session.id) }));
}
