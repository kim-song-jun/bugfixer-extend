import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSessionDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import { buildAgentSessionHierarchy } from './agentSessionHierarchy.js';

function session(id: string, parentSessionId: string | null = null, overrides: Partial<AgentSessionDTO> = {}): AgentSessionDTO {
	return { id, parentSessionId, projectId: 'project', bindingId: 'folder', taskId: 'task', name: id, provider: 'codex', model: 'model', profileRef: null, workspaceMode: 'gitWorktree', state: 'created', revision: 1, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z', ...overrides };
}

test('registered children precede unrelated roots even when the database lists newest children first', () => {
	const nodes = buildAgentSessionHierarchy([session('grandchild', 'child'), session('peer'), session('child', 'root'), session('root')]);
	assert.deepEqual(nodes.map(node => [node.session.id, node.parentId, node.depth, node.hasChildren]), [
		['peer', null, 0, false], ['root', null, 0, true], ['child', 'root', 1, true], ['grandchild', 'child', 2, false],
	]);
});

test('missing and foreign ownership links are exposed without inventing parent sessions', () => {
	const nodes = buildAgentSessionHierarchy([session('orphan', 'unknown'), session('other', 'root', { bindingId: 'foreign' }), session('root')]);
	assert.deepEqual(nodes.map(node => [node.session.id, node.parentId, node.relationshipIssue]), [
		['orphan', null, 'missingParent'], ['other', null, 'ownershipMismatch'], ['root', null, undefined],
	]);
});

test('corrupt cycles remain finite and preserve every session exactly once', () => {
	const nodes = buildAgentSessionHierarchy([session('a', 'b'), session('b', 'a'), session('self', 'self')]);
	assert.deepEqual(nodes.map(node => [node.session.id, node.parentId, node.depth, node.hasChildren, node.relationshipIssue]), [
		['a', null, 0, true, 'cycle'], ['b', 'a', 1, false, undefined], ['self', null, 0, false, 'cycle'],
	]);
});
