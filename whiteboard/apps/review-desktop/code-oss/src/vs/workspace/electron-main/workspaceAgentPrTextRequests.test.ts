/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentSessionTurnSnapshot } from '../common/workspaceAgentSessionProtocol.js';
import type { AgentPrTextScope } from '../common/workspaceAgentPrTextProtocol.js';
import type { ProviderPrTextRunRequest, ProviderPrTextRunResult } from './providerRuns/providerPrTextRun.js';
import { AgentSessionPrTextApplication, type AgentSessionPrTextResolver, type AgentSessionPrTextRunner } from './agentSessions/agentSessionPrTextApplication.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import { dispatchWorkspaceAgentPrTextRequest } from './workspaceAgentPrTextRequests.js';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function fixture(runner: AgentSessionPrTextRunner) {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-pr-text-router-'));
	const repository = join(directory, 'repository');
	mkdirSync(repository);
	let database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	const project = database.createProject('PR text routing');
	const binding = database.createFolderBinding({ projectId: project.id, path: repository, vcsKind: 'git', vcsRoot: repository });
	const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'Text session', provider: 'claude', model: 'claude-test', profileRef: 'profile-a', workspaceMode: 'gitWorktree' });
	const canonical = realpathSync(repository);
	const identity = statSync(canonical, { bigint: true });
	const folderIdentity = { canonicalPath: canonical, dev: identity.dev.toString(), ino: identity.ino.toString() };
	const snapshot: AgentSessionTurnSnapshot = {
		schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: null,
		provider: session.provider, model: session.model, profileRef: session.profileRef, cwd: canonical, folderIdentity,
		managedWorktreeOwnerId: session.id, permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [],
	};
	let turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
	const scope: AgentPrTextScope = { projectId: project.id, sessionId: session.id, targetTurnId: turn.id };
	const capture = (content: string, capturedAt: string) => ({
		schemaVersion: 1 as const, folderIdentity, capturedAt, inventoryCoverage: 'complete' as const, contentCoverage: 'complete' as const,
		entryCount: 1, fileBytes: Buffer.byteLength(content), retainedTextBytes: Buffer.byteLength(content), contentReadCount: 1,
		entries: [{ path: 'src/change.ts', kind: 'file' as const, size: Buffer.byteLength(content), sha256: digest(content), content }],
	});
	database.agentSessionContents.recordBaseline({ scope: { projectId: scope.projectId, sessionId: scope.sessionId, turnId: scope.targetTurnId }, snapshot: capture('before\n', '2026-10-19T00:00:00.000Z'), revision: '1'.repeat(40) });
	const running = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, database.agentSessions.getSession(project.id, session.id)!.revision, { state: 'running' });
	database.agentSessionContents.recordAfter({ scope: { projectId: scope.projectId, sessionId: scope.sessionId, turnId: scope.targetTurnId }, snapshot: capture('after\n', '2026-10-19T00:01:00.000Z'), expectedLatestVersion: 0, revision: '2'.repeat(40), cleanupVerified: true });
	turn = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, running.turn.revision, database.agentSessions.getSession(project.id, session.id)!.revision, { state: 'exited', exitCode: 0, cleanupVerified: true }).turn;
	const evidence = database.agentSessionChangeEvidence.getLatest(project.id, session.id, turn.id)!;
	database.agentSessionReviews.recordHumanExplanation({
		target: { projectId: project.id, sessionId: session.id, turnId: turn.id, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'src/change.ts', hunkId: null },
		expectedLatestRevision: 0, what: 'Keep the source change.', why: 'The user requested this behavior.', citations: [], checkClaims: [], status: 'confirmed',
	});
	database.agentSessionPrTexts.appendGeneratedRevision({ scope, expectedRevision: 0, idempotencyKey: `initial-ai:${turn.id}`, source: { kind: 'liveAgentTurn', turnId: turn.id },
		sanitizedCompleteAgentText: { title: 'Initial AI title', body: 'Initial AI body' }, knownSecrets: [] });
	const resolver: AgentSessionPrTextResolver = {
		async resolve(actualSession, targetTurn) {
			return {
				providerId: actualSession.provider, model: actualSession.model, profileRef: actualSession.profileRef, sourceCwd: targetTurn.snapshot.cwd,
				profileDirectory: '/profiles/profile-a', executable: '/bin/claude',
				processControl: { nodeExecutable: process.execPath, helperScript: fileURLToPath(new URL('../../../../../../scripts/provider-group-control.mjs', import.meta.url)) },
				preflight: async () => ({ allowed: true, cwdIdentity: 'router-test-cwd', policyProof: 'router-test-policy-proof' }), knownSecrets: ['router-fixture-secret'],
			};
		},
	};
	return {
		database,
		scope,
		application: new AgentSessionPrTextApplication(database, resolver, runner),
		close() { database.close(); rmSync(directory, { recursive: true, force: true }); },
	};
}

function successfulResult(request: ProviderPrTextRunRequest): ProviderPrTextRunResult {
	const content = { title: 'Generated PR title', body: 'Generated PR body.' };
	return {
		state: 'succeeded', content, cleanupVerified: true,
		receipt: {
			requestId: request.requestId, attemptId: request.attemptId, providerId: request.providerId, model: request.model,
			snapshotId: request.snapshot.snapshotId, snapshotSha256: request.snapshot.sha256, contentSha256: digest(JSON.stringify(content)),
		},
	};
}

test('PR text IPC router binds all nine commands to real workspace SQLite rows and live scope guards', async () => {
	let holdNextRun = false;
	let releaseRun!: () => void;
	const runner: AgentSessionPrTextRunner = async request => {
		if (!holdNextRun) { return successfulResult(request); }
		holdNextRun = false;
		return new Promise(resolve => {
			releaseRun = () => resolve(successfulResult(request));
			request.signal?.addEventListener('abort', () => resolve({ state: 'interrupted', cleanupVerified: true }), { once: true });
		});
	};
	const value = fixture(runner);
	try {
		const { database, scope, application } = value;
		const dispatch = (command: string, arg: unknown, assertCurrent: () => void = () => undefined) =>
			dispatchWorkspaceAgentPrTextRequest(application, database, command, arg, scope.projectId, assertCurrent);

		const draft = await dispatch('getPrTextDraft', scope) as Awaited<ReturnType<typeof application.getPrTextDraft>>;
		assert.equal(draft.head?.author, 'liveAgentTurn');
		assert.equal((await dispatch('listPrTextRevisions', { scope, after: 0, limit: 5 }) as { revisions: readonly unknown[] }).revisions.length, 1);
		assert.equal((await dispatch('listPrTextRequests', { scope, after: 0, limit: 5 }) as { requests: readonly unknown[] }).requests.length, 0);
		await assert.rejects(dispatch('getPrTextDraft', { ...scope, projectId: randomUUID() }), /unavailable in this project window/u);
		await assert.rejects(dispatch('getPrTextDraft', { ...scope, sessionId: randomUUID() }), /unavailable in this project window/u);
		await assert.rejects(dispatch('getPrTextDraft', { ...scope, targetTurnId: randomUUID() }), /unavailable in this project window/u);
		await assert.rejects(dispatch('getPrTextDraft', { ...scope, forged: true }), /missing or unknown fields/u);
		let guardCalls = 0;
		await assert.rejects(dispatch('previewPrTextRequest', { scope, baseRevision: 1, idempotencyKey: 'revoked-preview', instruction: 'This preview must not persist.' }, () => {
			guardCalls++;
			if (guardCalls > 2) { throw new Error('native request authority revoked during resolver.'); }
		}), /authority revoked/u);
		assert.equal(guardCalls, 3, 'the native scope is rechecked when the asynchronous provider resolver returns');
		assert.equal(database.agentSessionPrTexts.listRequests(scope, { afterSequence: 0, limit: 5 }).requests.length, 0, 'a revoked preview is not persisted');

		const firstSave = await dispatch('savePrTextRevision', { scope, expectedRevision: 1, idempotencyKey: 'router-human-save', title: 'Saved title', body: 'Saved body.' }) as Awaited<ReturnType<typeof application.savePrTextRevision>>;
		assert.equal(firstSave.author, 'human');
		await assert.rejects(dispatch('savePrTextRevision', { scope, expectedRevision: 2, idempotencyKey: 'forged-source', title: 'x', body: '', author: 'providerAttempt', source: { kind: 'providerAttempt' } }), /missing or unknown fields/u);

		const preview = await dispatch('previewPrTextRequest', { scope, baseRevision: 2, idempotencyKey: 'router-preview-success', instruction: 'Draft this reviewed change.' }) as Awaited<ReturnType<typeof application.previewPrTextRequest>>;
		const running = await dispatch('startPrTextRequest', { scope, requestId: preview.request.id, expectedStateRevision: preview.request.stateRevision, expectedDigest: preview.digest }) as Awaited<ReturnType<typeof application.startPrTextRequest>>;
		assert.equal(running.state, 'running');
		await new Promise<void>(resolve => setImmediate(resolve));
		const succeeded = await dispatch('getPrTextRequest', { scope, requestId: preview.request.id }) as Awaited<ReturnType<typeof application.getPrTextRequest>>;
		assert.equal(succeeded.state, 'succeeded');
		assert.equal(database.agentSessionPrTexts.getHead(scope)?.author, 'providerAttempt');

		const conflictPreview = await dispatch('previewPrTextRequest', { scope, baseRevision: 3, idempotencyKey: 'router-preview-conflict', instruction: 'Prepare another candidate.' }) as Awaited<ReturnType<typeof application.previewPrTextRequest>>;
		holdNextRun = true;
		const conflictRunning = await dispatch('startPrTextRequest', { scope, requestId: conflictPreview.request.id, expectedStateRevision: conflictPreview.request.stateRevision, expectedDigest: conflictPreview.digest }) as Awaited<ReturnType<typeof application.startPrTextRequest>>;
		database.agentSessionPrTexts.appendHumanRevision({ scope, expectedRevision: 3, idempotencyKey: 'move-head-during-run', content: { title: 'Human moved head', body: 'Saved while generation was running.' } });
		releaseRun();
		await new Promise<void>(resolve => setImmediate(resolve));
		const conflicted = await dispatch('getPrTextRequest', { scope, requestId: conflictRunning.id }) as Awaited<ReturnType<typeof application.getPrTextRequest>>;
		assert.equal(conflicted.state, 'conflicted');
		const applied = await dispatch('applyPrTextCandidate', { scope, requestId: conflicted.id, expectedStateRevision: conflicted.stateRevision,
			expectedHeadRevision: 4, idempotencyKey: 'apply-router-candidate' }) as Awaited<ReturnType<typeof application.applyPrTextCandidate>>;
		assert.equal(applied.author, 'providerAttempt');
		assert.equal(database.agentSessionPrTexts.getHead(scope)?.revision, 5);

		const cancelPreview = await dispatch('previewPrTextRequest', { scope, baseRevision: 5, idempotencyKey: 'router-preview-cancel', instruction: 'This request will be cancelled.' }) as Awaited<ReturnType<typeof application.previewPrTextRequest>>;
		const cancelled = await dispatch('cancelPrTextRequest', { scope, requestId: cancelPreview.request.id, expectedStateRevision: cancelPreview.request.stateRevision }) as Awaited<ReturnType<typeof application.cancelPrTextRequest>>;
		assert.equal(cancelled.state, 'cancelled');
		assert.equal((await dispatch('listPrTextRequests', { scope, after: 0, limit: 5 }) as { requests: readonly unknown[] }).requests.length, 3);
	} finally {
		await value.application.shutdown();
		value.close();
	}
});
