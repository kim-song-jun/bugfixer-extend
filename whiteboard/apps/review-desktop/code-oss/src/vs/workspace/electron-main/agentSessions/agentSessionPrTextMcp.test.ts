/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import test from 'node:test';
import type { AgentSessionPermissionPolicy, AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { AgentSessionCollaborationService } from './agentSessionCollaborationService.js';
import { AGENT_SESSION_MCP_TOKEN_ENV, AgentSessionMcpBridge } from './agentSessionMcpBridge.js';

const POLICY: AgentSessionPermissionPolicy = { mode: 'mutating', approval: 'on-request' };
const GATEWAY_PATH = new URL('./agentSessionMcpGateway.mjs', import.meta.url).pathname;

function createFixture(directory: string) {
	const root = join(directory, 'workspace'); mkdirSync(root, { recursive: true });
	const database = WorkspaceDatabase.open(':memory:');
	const project = database.createProject('PR text MCP contract');
	const binding = database.createFolderBinding({ projectId: project.id, path: realpathSync(root) });
	const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Prepare PR text' });
	return { database, project, binding, task, root: realpathSync(root) };
}

function createSession(fixture: ReturnType<typeof createFixture>) {
	return fixture.database.agentSessions.createSession({ projectId: fixture.project.id, bindingId: fixture.binding.id, taskId: fixture.task.id,
		name: 'PR text author', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder' });
}

function createTurn(fixture: ReturnType<typeof createFixture>, session: ReturnType<typeof createSession>) {
	const stats = statSync(fixture.root, { bigint: true });
	const snapshot: AgentSessionTurnSnapshot = { schemaVersion: 1, projectId: fixture.project.id, sessionId: session.id, sessionRevision: session.revision,
		bindingId: fixture.binding.id, taskId: fixture.task.id, provider: session.provider, model: session.model, profileRef: session.profileRef,
		cwd: fixture.root, folderIdentity: { canonicalPath: fixture.root, dev: stats.dev.toString(), ino: stats.ino.toString() }, managedWorktreeOwnerId: null,
		permissionPolicy: POLICY, convention: null, references: [] };
	return fixture.database.agentSessionTurns.createTurn({ projectId: fixture.project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
}

async function openMcpClient(access: Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>>) {
	const transport = new StdioClientTransport({ command: process.execPath, args: [GATEWAY_PATH, String(access.port)],
		env: { PATH: process.env.PATH ?? '', [AGENT_SESSION_MCP_TOKEN_ENV]: access.gatewayEnvironment[AGENT_SESSION_MCP_TOKEN_ENV] }, stderr: 'pipe' });
	const client = new Client({ name: 'bugfixer-pr-text-mcp-contract', version: '1.0.0' });
	await client.connect(transport);
	return { client, close: () => client.close() };
}

function payload(result: unknown, name: string): Record<string, unknown> {
	const envelope = result as { isError?: boolean; structuredContent?: unknown; content?: unknown };
	assert.notEqual(envelope.isError, true, `${name} returned a tool error: ${JSON.stringify(envelope)}`);
	assert.ok(Array.isArray(envelope.content));
	const text = (envelope.content as Array<{ type?: unknown; text?: unknown }>).find(item => item.type === 'text' && typeof item.text === 'string');
	assert.ok(text && typeof text.text === 'string');
	const parsed = JSON.parse(text.text) as unknown;
	if (envelope.structuredContent !== undefined) { assert.deepEqual(envelope.structuredContent, parsed); }
	assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
	return parsed as Record<string, unknown>;
}

test('real MCP PR text tools bind later-turn authorship, idempotency, Unicode pages, scope, and live grant', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-pr-text-mcp-'));
	const fixture = createFixture(directory);
	let access: Awaited<ReturnType<AgentSessionMcpBridge['issueAccess']>> | undefined;
	let client: Awaited<ReturnType<typeof openMcpClient>> | undefined;
	try {
		const session = createSession(fixture);
		const target = createTurn(fixture, session);
		const targetSession = fixture.database.agentSessions.getSession(fixture.project.id, session.id)!;
		const firstRunning = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, session.id, target.id, target.revision, targetSession.revision, { state: 'running' });
		fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, session.id, target.id, firstRunning.turn.revision, firstRunning.session.revision,
			{ state: 'exited', exitCode: 0, cleanupVerified: true });
		const idleSession = fixture.database.agentSessions.getSession(fixture.project.id, session.id)!;
		const laterStarting = createTurn(fixture, idleSession);
		const laterSession = fixture.database.agentSessions.getSession(fixture.project.id, session.id)!;
		const laterRunning = fixture.database.agentSessionTurns.transitionTurn(fixture.project.id, session.id, laterStarting.id, laterStarting.revision, laterSession.revision, { state: 'running' });
		const otherSession = createSession(fixture);
		const otherTurn = createTurn(fixture, otherSession);
		const bridge = new AgentSessionMcpBridge(new AgentSessionCollaborationService(fixture.database), undefined, fixture.database);
		const boundarySecret = 'retainedBoundarySecret_7931';
		access = await bridge.issueAccess({ projectId: fixture.project.id, sessionId: session.id, turnId: laterRunning.turn.id, permissionPolicy: POLICY, knownSecrets: [boundarySecret] });
		client = await openMcpClient(access);
		const tools = (await client.client.listTools()).tools.map(tool => tool.name);
		assert.ok(tools.includes('pr_prepare')); assert.ok(tools.includes('pr_get')); assert.ok(tools.includes('pr_list'));
		const body = '한😀'.repeat(700);
		const prepare = { name: 'pr_prepare', arguments: { targetTurnId: target.id, expectedRevision: 0, idempotencyKey: 'unicode-draft-1', title: '초안 제목', body } };
		const first = payload(await client.client.callTool(prepare), 'pr_prepare');
		const retry = payload(await client.client.callTool(prepare), 'pr_prepare');
		const firstRevision = first.revision as { id: string; revision: number; author: string; source: { kind: string; turnId: string } };
		const retryRevision = retry.revision as { id: string; revision: number };
		assert.equal(firstRevision.revision, 1); assert.equal(firstRevision.author, 'liveAgentTurn');
		assert.deepEqual(firstRevision.source, { kind: 'liveAgentTurn', turnId: laterRunning.turn.id });
		assert.equal(retryRevision.id, firstRevision.id);

		const firstPage = payload(await client.client.callTool({ name: 'pr_get', arguments: { targetTurnId: target.id, revision: 1, maxCharacters: 1000 } }), 'pr_get') as {
			bodyFragment: string; afterCharacter: number; nextCharacter: number; totalCharacters: number;
			revision: { id: string; author: string };
		};
		assert.equal(firstPage.revision.id, firstRevision.id); assert.equal(firstPage.revision.author, 'liveAgentTurn');
		assert.equal(firstPage.afterCharacter, 0); assert.equal(firstPage.nextCharacter, 1000);
		assert.equal(firstPage.totalCharacters, [...body].length);
		const secondPage = payload(await client.client.callTool({ name: 'pr_get', arguments: { targetTurnId: target.id, revision: 1, afterCharacter: firstPage.nextCharacter, maxCharacters: 1000 } }), 'pr_get') as { bodyFragment: string; nextCharacter: number; hasMore: boolean };
		assert.equal(secondPage.hasMore, false);
		assert.equal(firstPage.bodyFragment + secondPage.bodyFragment, body);

		const history = payload(await client.client.callTool({ name: 'pr_list', arguments: { targetTurnId: target.id, afterRevision: 0, limit: 1 } }), 'pr_list') as {
			revisions: readonly { id: string; author: string }[]; nextRevision: number; hasMore: boolean;
		};
		assert.equal(history.revisions.length, 1); assert.equal(history.revisions[0]?.id, firstRevision.id); assert.equal(history.nextRevision, 1); assert.equal(history.hasMore, false);
		const emptyHistory = payload(await client.client.callTool({ name: 'pr_list', arguments: { targetTurnId: target.id, afterRevision: history.nextRevision, limit: 1 } }), 'pr_list') as { revisions: readonly unknown[]; hasMore: boolean };
		assert.equal(emptyHistory.revisions.length, 0); assert.equal(emptyHistory.hasMore, false);

		for (const forged of [
			{ accountId: 'forged-account' },
			{ source: { kind: 'liveAgentTurn', turnId: otherTurn.id } },
			{ author: 'human' },
		]) {
			const result = await client.client.callTool({ name: 'pr_prepare', arguments: { ...prepare.arguments, ...forged } });
			assert.equal((result as { isError?: boolean }).isError, true);
		}
		const wrongScope = await client.client.callTool({ name: 'pr_get', arguments: { targetTurnId: otherTurn.id } });
		assert.equal((wrongScope as { isError?: boolean }).isError, true);
		assert.equal(fixture.database.agentSessionPrTexts.listRevisions({ projectId: fixture.project.id, sessionId: session.id, targetTurnId: target.id }, { afterRevision: 0, limit: 5 }).revisions.length, 1);

		const humanBody = `${'x'.repeat(999)}${boundarySecret}끝`;
		fixture.database.agentSessionPrTexts.appendHumanRevision({ scope: { projectId: fixture.project.id, sessionId: session.id, targetTurnId: target.id },
			expectedRevision: 1, idempotencyKey: 'human-boundary-secret', content: { title: '수동 수정', body: humanBody } });
		let cursor = 0; let reconstructed = '';
		while (true) {
			const page = payload(await client.client.callTool({ name: 'pr_get', arguments: { targetTurnId: target.id, revision: 2, afterCharacter: cursor, maxCharacters: 1000 } }), 'pr_get') as {
				bodyFragment: string; nextCharacter: number; totalCharacters: number; hasMore: boolean; redactionApplied: boolean;
			};
			assert.equal(page.redactionApplied, true);
			reconstructed += page.bodyFragment;
			assert.equal(page.totalCharacters, [...`${'x'.repeat(999)}***끝`].length);
			if (!page.hasMore) { break; }
			assert.ok(page.nextCharacter > cursor); cursor = page.nextCharacter;
		}
		assert.equal(reconstructed, `${'x'.repeat(999)}***끝`, 'known secrets must be removed before the body is divided into MCP pages');

		access.revokeAccess();
		await assert.rejects(client.client.callTool({ name: 'pr_get', arguments: { targetTurnId: target.id } }), /revoked|closed|disconnected|transport/i);
	} finally {
		const cleanupErrors: unknown[] = [];
		try { access?.revokeAccess(); } catch (error) { cleanupErrors.push(error); }
		if (client) {
			try { await client.close(); } catch (error) { cleanupErrors.push(error); }
		}
		if (access) {
			try { await access.releasePrivateConfig(); } catch (error) { cleanupErrors.push(error); }
		}
		try { fixture.database.close(); } catch (error) { cleanupErrors.push(error); }
		try { rmSync(directory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
		if (cleanupErrors.length) { throw new AggregateError(cleanupErrors, 'PR text MCP test resources did not close cleanly.'); }
	}
});
