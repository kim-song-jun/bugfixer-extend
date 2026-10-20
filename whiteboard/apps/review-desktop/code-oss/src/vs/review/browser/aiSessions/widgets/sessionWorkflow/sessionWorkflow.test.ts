/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import type { AgentWorkflowStatusDTO, CreateAgentWorkflowInput } from '../../../../../workspace/common/workspaceAgentWorkflowProtocol.js';
import type { AgentSessionDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';
import type { WorkspaceKnowledgeDTO } from '../../../../../workspace/common/workspaceKnowledgeProtocol.js';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const dom = new JSDOM('<html><body></body></html>', { pretendToBeVisual: true });
const css = dom.window.CSS ?? {};
css.escape ??= (value: string) => value.replace(/[^a-zA-Z0-9_-]/gu, '\\$&');
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'navigator'] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.defineProperty(globalThis, 'CSS', { configurable: true, value: css });
registerHooks({ load(url, context, next) {
	return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { createSessionWorkflow } = await import('./sessionWorkflow.js');

const session: AgentSessionDTO = {
	id: 'session-exact', projectId: 'project-exact', bindingId: 'binding-exact', taskId: 'task-exact', parentSessionId: null,
	name: 'Fixture session', provider: 'codex', model: 'fixture-model', profileRef: null, workspaceMode: 'sharedFolder',
	state: 'created', revision: 1, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
};

const emptyKnowledge: WorkspaceKnowledgeDTO = { references: [], taskReferences: {}, conventions: [], activeConventionId: null };

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() >= deadline) { throw new Error('Timed out waiting for workflow UI state'); }
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

function waitingStatus(input: CreateAgentWorkflowInput): AgentWorkflowStatusDTO {
	const workflowId = 'workflow-exact';
	return {
		workflow: {
			id: workflowId, projectId: input.projectId, bindingId: input.bindingId, taskId: input.taskId,
			revision: 1, state: 'waiting', planVersion: 1,
			createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
		},
		plan: {
			schemaVersion: 1, workflowId, version: 1, fingerprint: 'a'.repeat(64),
			createdAt: '2026-10-21T00:00:00.000Z', projectId: input.projectId, bindingId: input.bindingId, taskId: input.taskId,
			maxConcurrentNodes: input.maxConcurrentNodes, maxTotalTurns: input.maxTotalTurns, maxDurationMs: input.maxDurationMs,
			nodes: input.nodes,
		},
		run: null,
		hostError: null,
	};
}

test('workflow save remains focused and non-reentrant while the host request is pending', async () => {
	const parent = document.createElement('div');
	document.body.append(parent);
	let resolveCreate!: (status: AgentWorkflowStatusDTO) => void;
	let createCalls = 0;
	let createInput: CreateAgentWorkflowInput | undefined;
	const createResult = new Promise<AgentWorkflowStatusDTO>(resolve => { resolveCreate = resolve; });
	const controller = createSessionWorkflow(parent, { projectId: session.projectId, session, sessions: [session] }, {
		listWorkflows: async () => ({ workflows: [], nextCursor: null, hasMore: false }),
		getWorkflow: async () => { throw new Error('Unexpected workflow status read'); },
		createWorkflow: async input => { createCalls++; createInput = input; return createResult; },
		reviseWorkflow: async () => { throw new Error('Unexpected workflow revision'); },
		approveWorkflow: async () => { throw new Error('Unexpected workflow approval'); },
		startWorkflow: async () => { throw new Error('Unexpected workflow start'); },
		cancelWorkflow: async () => { throw new Error('Unexpected workflow cancellation'); },
		loadKnowledge: async () => emptyKnowledge,
		loadSessions: async () => [session],
	});
	controller.setVisible(true);
	try {
		const include = parent.querySelector<HTMLInputElement>(`[data-control-key="include-${session.id}"]`);
		assert.ok(include);
		include.click();
		const save = parent.querySelector<HTMLButtonElement>('.ai-session-workflows__actions button:nth-child(2)');
		assert.ok(save);
		assert.equal(save.disabled, false, 'A valid one-node plan must enable saving before submission');
		save.focus();
		save.click();
		await waitFor(() => createCalls === 1);
		assert.equal(parent.querySelector('.ai-session-workflows__editor')?.getAttribute('aria-busy'), 'true');
		assert.equal(save.getAttribute('aria-disabled'), 'true', 'The in-flight save must be announced unavailable to assistive technology');
		assert.equal(save.disabled, false, 'The in-flight save must remain natively focusable');
		assert.equal(document.activeElement, save, 'Starting the save must retain keyboard focus on its stable control');
		save.click();
		assert.equal(createCalls, 1, 'Activating a pending save must not submit a duplicate workflow request');
		assert.equal(createInput?.nodes.length, 1, 'The pending save must retain its exact one-session plan');

		resolveCreate(waitingStatus(createInput!));
		await waitFor(() => parent.querySelector('.ai-session-workflows__state')?.textContent?.includes('승인 대기') === true);
		assert.equal(parent.querySelector('.ai-session-workflows__editor')?.getAttribute('aria-busy'), 'false');
		assert.equal(save.getAttribute('aria-disabled'), 'false');
		assert.equal(save.disabled, false);
		assert.equal(document.activeElement, save, 'Completing the save must leave focus on the stable save control');
	} finally {
		controller.dispose();
		parent.remove();
	}
});
