/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import type { AgentSessionContentSnapshot } from './agentSessionContentCapture.js';
import { computeAgentSessionChangeHunks } from './agentSessionChangeHunks.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';

test('explanations append immutable exact-evidence revisions and survive database reopen', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bugfixer-agent-session-review-'));
	const folder = join(directory, 'project');
	mkdirSync(folder);
	const filePath = join(folder, 'note.txt');
	let database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const project = database.createProject('Review evidence');
		const binding = database.createFolderBinding({ projectId: project.id, path: folder });
		const task = database.createTask({ projectId: project.id, bindingId: binding.id, title: 'Review without completing task' });
		const convention = database.knowledge.createConventionVersion({ projectId: project.id, markdown: '# Review rules', sourceSnapshotIds: [], authoredBy: 'person' });
		const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, taskId: task.id, name: 'Review turn', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder' });
		const canonicalFolder = realpathSync(folder);
		const stat = statSync(canonicalFolder, { bigint: true });
		const folderIdentity = { canonicalPath: canonicalFolder, dev: stat.dev.toString(), ino: stat.ino.toString() };
		const snapshot: AgentSessionTurnSnapshot = {
			schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: task.id,
			provider: session.provider, model: session.model, profileRef: null, cwd: canonicalFolder, folderIdentity,
			managedWorktreeOwnerId: null, permissionPolicy: { mode: 'read-only', approval: 'on-request' },
			convention: { id: convention.id, version: convention.version, sha256: createHash('sha256').update(convention.markdown, 'utf8').digest('hex') }, references: [],
		};
		const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
		const scope = { projectId: project.id, sessionId: session.id, turnId: turn.id };
		const capture = (capturedAt: string): AgentSessionContentSnapshot => {
			const content = readFileSync(filePath, 'utf8');
			const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
			return {
				schemaVersion: 1, folderIdentity, capturedAt, inventoryCoverage: 'complete', contentCoverage: 'complete', entryCount: 1,
				fileBytes: Buffer.byteLength(content, 'utf8'), retainedTextBytes: Buffer.byteLength(content, 'utf8'), contentReadCount: 1,
				entries: [{ path: 'note.txt', kind: 'file', size: Buffer.byteLength(content, 'utf8'), sha256, content }],
			};
		};
		writeFileSync(filePath, 'before line\n');
		database.agentSessionContents.recordBaseline({ scope, snapshot: capture('2026-10-19T00:00:00.000Z'), revision: null });
		const currentSession = database.agentSessions.getSession(project.id, session.id)!;
		const running = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, currentSession.revision, { state: 'running' });
		writeFileSync(filePath, 'after line\n');
		database.agentSessionContents.recordAfter({ scope, snapshot: capture('2026-10-19T00:01:00.000Z'), expectedLatestVersion: 0, revision: null, cleanupVerified: true });
		const evidence = database.agentSessionChangeEvidence.getLatest(project.id, session.id, turn.id)!;
		const content = database.agentSessionContents.getFile({ scope, evidenceVersion: evidence.version, path: 'note.txt' })!;
		const hunk = computeAgentSessionChangeHunks(content).hunks[0];
		assert.ok(hunk);
		const target = { ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'note.txt', hunkId: hunk.id };
		const agentInput = { target, authorTurnId: turn.id, expectedLatestRevision: 0, what: 'Updated the note.', why: 'The requested content changed.', citations: [{ kind: 'convention' as const, id: convention.id, version: convention.version, sha256: createHash('sha256').update(convention.markdown, 'utf8').digest('hex') }], checkClaims: [{ label: 'Build', outcome: 'notRun' as const }] };
		const first = database.agentSessionReviews.recordAgentExplanation(agentInput);
		assert.equal(first.actor, 'agent');
		assert.equal(first.grounding, 'linked');
		assert.equal(first.checkClaims[0]?.detail, '');
		assert.equal(first.verification, 'unverified');
		assert.equal(database.agentSessionReviews.recordAgentExplanation(agentInput).id, first.id);
		const human = database.agentSessionReviews.recordHumanExplanation({ target, expectedLatestRevision: 1, what: 'Reviewed the change.', why: 'The retained diff matches the request.', citations: [], checkClaims: [], status: 'confirmed' });
		assert.equal(human.status, 'confirmed');
		assert.equal(human.grounding, 'unlinked');
		const third = database.agentSessionReviews.recordAgentExplanation({ ...agentInput, expectedLatestRevision: 2 });
		assert.equal(third.revision, 3);
		assert.equal(database.agentSessionReviews.getLatest(target)?.id, third.id);
		assert.deepEqual(database.agentSessionReviews.listRevisions({ target, limit: 2 }), {
			revisions: [first, human], nextRevision: 2, hasMore: true,
		});
		assert.throws(() => database.agentSessionReviews.recordAgentExplanation(agentInput), /stale/);
		assert.throws(() => database.agentSessionReviews.getLatest({ ...target, projectId: '00000000-0000-4000-8000-000000000032' }), /durable turn/);
		assert.equal(database.getTask(task.id)?.state, 'ready');
		assert.throws(() => database.agentSessionReviews.recordHumanExplanation({ target: { ...target, hunkId: 'a'.repeat(64) }, expectedLatestRevision: 3, what: 'x', why: 'y', citations: [], checkClaims: [], status: 'draft' }), /not present/);
		assert.throws(() => database.agentSessionReviews.recordHumanExplanation({ target, expectedLatestRevision: 3, what: 'x', why: 'y', citations: [], checkClaims: [], status: 'draft', verification: 'verified' } as never), /unknown fields/);
		for (const citation of [
			{ ...agentInput.citations[0], sha256: '0'.repeat(64) },
			{ ...agentInput.citations[0], version: convention.version + 1 },
		]) {
			assert.throws(() => database.agentSessionReviews.recordAgentExplanation({ ...agentInput, expectedLatestRevision: 3, citations: [citation] }), /target turn knowledge snapshot/);
		}
		const otherSession = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Other review session', provider: 'codex', model: 'gpt-5-codex', workspaceMode: 'sharedFolder' });
		const otherTurn = database.agentSessionTurns.createTurn({
			projectId: project.id, sessionId: otherSession.id, expectedSessionRevision: otherSession.revision,
			snapshot: { ...snapshot, sessionId: otherSession.id, sessionRevision: otherSession.revision, taskId: null },
		});
		assert.throws(() => database.agentSessionReviews.recordAgentExplanation({ ...agentInput, expectedLatestRevision: 3, authorTurnId: otherTurn.id }), /author turn/);
		assert.equal(database.agentSessionReviews.getLatest(target)?.revision, 3);
		const rawDatabase = new DatabaseSync(join(directory, 'workspace.db'));
		try {
			const storedPayload = JSON.parse(String(rawDatabase.prepare('SELECT payload_json FROM agent_session_explanations WHERE id = ?').get(first.id)?.payload_json));
			assert.deepEqual(Object.keys(storedPayload).sort(), ['actor', 'authorTurnId', 'checkClaims', 'citations', 'status', 'what', 'why']);
			assert.throws(() => rawDatabase.prepare('UPDATE agent_session_explanations SET payload_json = ? WHERE id = ?').run('{}', first.id), /immutable/);
			assert.throws(() => rawDatabase.prepare('DELETE FROM agent_session_explanations WHERE id = ?').run(first.id), /immutable/);
		} finally {
			rawDatabase.close();
		}
		assert.equal(running.turn.state, 'running');
		database.close();
		database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
		assert.deepEqual(database.agentSessionReviews.listRevisions({ target }), {
			revisions: [first, human, third], nextRevision: 3, hasMore: false,
		});
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
