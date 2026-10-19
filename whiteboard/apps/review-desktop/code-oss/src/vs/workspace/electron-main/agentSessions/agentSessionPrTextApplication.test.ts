/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runProviderPrText, type ProviderPrTextRunRequest, type ProviderPrTextRunResult } from '../providerRuns/providerPrTextRun.js';
import { ProviderProcessSupervisor } from '../providerRuns/providerProcessSupervisor.js';
import type { ProviderCommandSpec, ProviderRunRequest } from '../providerRuns/providerRunTypes.js';
import type { AgentSessionPrTextResolver, AgentSessionPrTextRunner } from './agentSessionPrTextApplication.js';
import { AgentSessionPrTextApplication } from './agentSessionPrTextApplication.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function fixture(runner: AgentSessionPrTextRunner = async () => ({ state: 'failed', cleanupVerified: true, reason: 'controlled provider failure' })) {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-pr-text-app-'));
	const repository = join(directory, 'repository'); mkdirSync(repository);
	let database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	const project = database.createProject('PR text application');
	const binding = database.createFolderBinding({ projectId: project.id, path: repository, vcsKind: 'git', vcsRoot: repository });
	const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'PR text session', provider: 'claude', model: 'claude-test-model', profileRef: 'claude-profile-a', workspaceMode: 'gitWorktree' });
	const canonicalFolder = realpathSync(repository); const identity = statSync(canonicalFolder, { bigint: true });
	const snapshot: AgentSessionTurnSnapshot = { schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id,
		taskId: null, provider: session.provider, model: 'historical-model', profileRef: 'historical-profile', cwd: canonicalFolder,
		folderIdentity: { canonicalPath: canonicalFolder, dev: identity.dev.toString(), ino: identity.ino.toString() }, managedWorktreeOwnerId: session.id,
		permissionPolicy: { mode: 'mutating', approval: 'on-request' }, convention: null, references: [] };
	let turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
	const scope = { projectId: project.id, sessionId: session.id, targetTurnId: turn.id };
	const capture = (content: string, capturedAt: string) => ({ schemaVersion: 1 as const, folderIdentity: snapshot.folderIdentity, capturedAt, inventoryCoverage: 'complete' as const, contentCoverage: 'complete' as const,
		entryCount: 1, fileBytes: Buffer.byteLength(content), retainedTextBytes: Buffer.byteLength(content), contentReadCount: 1,
		entries: [{ path: 'src/selected.ts', kind: 'file' as const, size: Buffer.byteLength(content), sha256: digest(content), content }] });
	database.agentSessionContents.recordBaseline({ scope: { projectId: scope.projectId, sessionId: scope.sessionId, turnId: scope.targetTurnId }, snapshot: capture('before\n', '2026-10-19T00:00:00.000Z'), revision: '1'.repeat(40) });
	const running = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, turn.revision, database.agentSessions.getSession(project.id, session.id)!.revision, { state: 'running' });
	database.agentSessionContents.recordAfter({ scope: { projectId: scope.projectId, sessionId: scope.sessionId, turnId: scope.targetTurnId }, snapshot: capture('after\n', '2026-10-19T00:01:00.000Z'), expectedLatestVersion: 0, revision: '2'.repeat(40), cleanupVerified: true });
	turn = database.agentSessionTurns.transitionTurn(project.id, session.id, turn.id, running.turn.revision, database.agentSessions.getSession(project.id, session.id)!.revision, { state: 'exited', exitCode: 0, cleanupVerified: true }).turn;
	const evidence = database.agentSessionChangeEvidence.getLatest(project.id, session.id, turn.id)!;
	database.agentSessionReviews.recordHumanExplanation({ target: { projectId: scope.projectId, sessionId: scope.sessionId, turnId: scope.targetTurnId, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'src/selected.ts', hunkId: null },
		expectedLatestRevision: 0, what: 'Keep the selected behavior.', why: 'The user requested this change.', citations: [], checkClaims: [], status: 'confirmed' });
	database.agentSessionPrTexts.appendGeneratedRevision({ scope, expectedRevision: 0, idempotencyKey: `live-turn:${turn.id}`, source: { kind: 'liveAgentTurn', turnId: turn.id },
		sanitizedCompleteAgentText: { title: 'Initial AI title', body: 'Initial AI body' }, knownSecrets: [] });
	const resolver: AgentSessionPrTextResolver = {
		async resolve(actualSession, targetTurn) {
			return { providerId: actualSession.provider, model: actualSession.model, profileRef: actualSession.profileRef, sourceCwd: targetTurn.snapshot.cwd, profileDirectory: '/profiles/claude-profile-a', executable: '/bin/claude',
				processControl: { nodeExecutable: process.execPath, helperScript: fileURLToPath(new URL('../../../../../../scripts/provider-group-control.mjs', import.meta.url)) },
				preflight: async () => ({ allowed: true, cwdIdentity: 'fixture-cwd', policyProof: 'fixture-policy-proof' }), knownSecrets: ['fixture-secret'] };
		},
	};
	return {
		database,
		directory,
		scope,
		application: new AgentSessionPrTextApplication(database, resolver, runner),
		store: () => database.agentSessionPrTexts,
		reopen() { database.close(); database = WorkspaceDatabase.open(join(directory, 'workspace.db')); return database; },
		dispose() { database.close(); rmSync(directory, { recursive: true, force: true }); },
	};
}

function previewInput(scope: ReturnType<typeof fixture>['scope']) {
	return { scope, baseRevision: 1, idempotencyKey: randomUUID(), instruction: 'Summarize the selected change in Korean.' };
}

test('preview binds retained SQLite evidence, approved rationale and current PR head; start refuses a moved snapshot', async () => {
	const value = fixture();
	try {
		const preview = await value.application.previewPrTextRequest(previewInput(value.scope));
		assert.equal(preview.request.baseRevision, 1);
		assert.match(preview.sourceSummary.join('\n'), /src\/selected\.ts/u);
		assert.match(preview.sourceSummary.join('\n'), /사람 작성 이유/u);
		assert.match(preview.sourceSummary.join('\n'), /claude \/ claude-test-model · 현재 claude-profile-a 프로필/u);
		assert.match(preview.sourceSummary.join('\n'), /비공개 임시 폴더/u);
		assert.match(preview.sourceSummary.join('\n'), /최대 200개 파일\/65536바이트/u);
		assert.match(preview.sourceSummary.join('\n'), /현재 계정과 제공자 과금/u);
		assert.equal('contextJSON' in preview.request, false);
		const stored = value.store().getRequestContext(value.scope, preview.request.id)!;
		assert.equal(stored.contextDigest, preview.digest);
		assert.match(stored.contextJSON, /The user requested this change\./u);
		assert.match(stored.contextJSON, /Initial AI title/u);
		value.store().appendHumanRevision({ scope: value.scope, expectedRevision: 1, idempotencyKey: 'move-head', content: { title: 'Moved title', body: 'Moved body' } });
		await assert.rejects(value.application.startPrTextRequest({ scope: value.scope, requestId: preview.request.id, expectedStateRevision: preview.request.stateRevision, expectedDigest: preview.digest }), /stale|changed|최신/u);
		assert.equal(value.store().getRequest(value.scope, preview.request.id)?.state, 'preview');
	} finally { await value.application.shutdown(); value.dispose(); }
});

test('start returns a durable running request, and cancellation is persisted before the owned runner aborts', async () => {
	let started!: () => void;
	let finishRunner!: (result: ProviderPrTextRunResult) => void;
	let observedRequest: ProviderPrTextRunRequest | undefined;
	let providerDirectory = '';
	let ownedRecoveryControl: { readonly nodeExecutable: string; readonly helperScript: string; readonly socketPath: string; readonly nonce: string } | undefined;
	const runner: AgentSessionPrTextRunner = async request => {
		observedRequest = request;
		providerDirectory = mkdtempSync(join('/tmp', 'bfx-prt-test-'));
		ownedRecoveryControl = {
			nodeExecutable: process.execPath,
			helperScript: fileURLToPath(new URL('../../../../../../scripts/provider-group-control.mjs', import.meta.url)),
			socketPath: join(providerDirectory, 'c.sock'), nonce: 'a'.repeat(64),
		};
		await request.onOwnedProcessSpawned(31337, 'a'.repeat(64), ownedRecoveryControl);
		started();
		return new Promise(resolve => { finishRunner = resolve; });
	};
	const value = fixture(runner);
	try {
		const runnerStarted = new Promise<void>(resolve => { started = resolve; });
		const preview = await value.application.previewPrTextRequest(previewInput(value.scope));
		const running = await value.application.startPrTextRequest({ scope: value.scope, requestId: preview.request.id, expectedStateRevision: preview.request.stateRevision, expectedDigest: preview.digest });
		assert.equal(running.state, 'running');
		await runnerStarted;
		assert.ok(value.database.agentSessionPrTextProcesses.getOwnedProcess(running.id, observedRequest!.attemptId), 'durable owner receipt exists before the runner advances');
		const cancelled = await value.application.cancelPrTextRequest({ scope: value.scope, requestId: running.id, expectedStateRevision: running.stateRevision });
		assert.equal(cancelled.state, 'cancelled');
		assert.equal(observedRequest?.signal?.aborted, true);
		await observedRequest!.onCleanupVerified({ requestId: running.id, attemptId: observedRequest!.attemptId, pgid: 31337,
			controlNonce: ownedRecoveryControl!.nonce, recoveryControl: ownedRecoveryControl! });
		finishRunner({ state: 'cancelled', cleanupVerified: true, reason: 'cancelled by owner' });
		await value.application.shutdown();
		assert.equal(value.store().getRequest(value.scope, running.id)?.state, 'cancelled');
		assert.equal(value.database.agentSessionPrTextProcesses.listUnverified().length, 0, 'verified runner cleanup is durably recorded');
	} finally { await value.application.shutdown(); value.dispose(); if (providerDirectory) { rmSync(providerDirectory, { recursive: true, force: true }); } }
});

test('unverified provider cleanup never stores a candidate and shutdown retains the cleanup failure', async () => {
	const runner: AgentSessionPrTextRunner = async () => ({ state: 'interrupted', cleanupVerified: false, reason: 'Owned process group cleanup was not verified.' });
	const value = fixture(runner);
	try {
		const preview = await value.application.previewPrTextRequest(previewInput(value.scope));
		const running = await value.application.startPrTextRequest({ scope: value.scope, requestId: preview.request.id, expectedStateRevision: preview.request.stateRevision, expectedDigest: preview.digest });
		await assert.rejects(value.application.shutdown(), /cleanup|verified|Owned process group/u);
		const finished = value.store().getRequest(value.scope, running.id)!;
		assert.equal(finished.state, 'cancelled');
		assert.equal(finished.candidate, undefined);
	} finally { value.dispose(); }
});

test('the real app runner persists cleanup before deleting its private directory and saves the generated revision', { skip: process.platform !== 'darwin' }, async () => {
	const directory = mkdtempSync(join(tmpdir(), 'agent-pr-text-real-runner-'));
	const fakeExecutable = join(directory, 'fake-claude');
	const content = { title: 'App runner PR title', body: 'Generated by the local fixture executable.' };
	const streamResult = JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(content) });
	writeFileSync(fakeExecutable, `#!/bin/sh\nprintf '%s\\n' '${streamResult}'\n`, { mode: 0o700 });
	let controlDirectory = '';
	let cleanupCallbackSawDirectory = false;
	const runner: AgentSessionPrTextRunner = request => runProviderPrText({
		...request,
		executable: fakeExecutable,
		onOwnedProcessSpawned: async (pgid, nonce, recoveryControl) => {
			controlDirectory = dirname(recoveryControl!.socketPath);
			await request.onOwnedProcessSpawned(pgid, nonce, recoveryControl);
		},
		onCleanupVerified: async receipt => {
			await request.onCleanupVerified(receipt);
			cleanupCallbackSawDirectory = existsSync(dirname(receipt.recoveryControl.socketPath));
		},
	});
	const value = fixture(runner);
	try {
		const preview = await value.application.previewPrTextRequest(previewInput(value.scope));
		const running = await value.application.startPrTextRequest({ scope: value.scope, requestId: preview.request.id,
			expectedStateRevision: preview.request.stateRevision, expectedDigest: preview.digest });
		assert.equal(running.state, 'running');
		let completed = value.store().getRequest(value.scope, running.id)!;
		const deadline = Date.now() + 10_000;
		while (completed.state === 'running' && Date.now() < deadline) {
			await new Promise<void>(resolve => setTimeout(resolve, 10));
			completed = value.store().getRequest(value.scope, running.id)!;
		}
		assert.equal(completed.state, 'succeeded');
		assert.deepEqual(completed.candidate?.content && { title: completed.candidate.content.title, body: completed.candidate.content.body }, content);
		assert.equal(value.store().getHead(value.scope)?.author, 'providerAttempt');
		assert.equal(value.store().getHead(value.scope)?.content.title, content.title);
		const source = completed.candidate?.source;
		assert.ok(source?.kind === 'providerAttempt');
		assert.ok(value.database.agentSessionPrTextProcesses.getCleanupReceipt(running.id, source.attemptId), 'the exact process cleanup receipt was persisted');
		assert.equal(cleanupCallbackSawDirectory, true, 'the private directory exists while the durable callback runs');
		assert.ok(controlDirectory, 'the real runner exposed its owned private control directory through the process receipt');
		assert.equal(existsSync(controlDirectory), false, 'the real runner removed its private directory after the callback persisted cleanup');
		await value.application.shutdown();
	} finally {
		await value.application.shutdown();
		value.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a reopened workspace cancels only the durable process group before allowing another generation', { skip: process.platform !== 'darwin' }, async t => {
	let signalReady!: () => void;
	const ready = new Promise<void>(resolve => signalReady = resolve);
	let handle: Awaited<ReturnType<ProviderProcessSupervisor['run']>> | undefined;
	let handleFinished = false;
	let providerDirectory = '';
	let ownedPgid: number | undefined;
	const runner: AgentSessionPrTextRunner = async request => {
		providerDirectory = mkdtempSync(join('/tmp', 'bfx-prt-restart-control-'));
		const recoveryControl = { nodeExecutable: request.processControl.nodeExecutable, helperScript: request.processControl.helperScript,
			socketPath: join(providerDirectory, 'c.sock'), nonce: randomBytes(32).toString('hex') };
		const runRequest: ProviderRunRequest = { providerId: 'claude', attemptId: request.attemptId, cwd: providerDirectory, prompt: 'controlled fixture',
			profileDirectory: request.profileDirectory, model: request.model, permissionPolicy: { mode: 'read-only', approval: 'never' },
			captureFinalText: true, ownerLifetime: true, recoveryControl, preflight: request.preflight };
		const command: ProviderCommandSpec = { executable: process.execPath,
			args: ['-e', "process.stdout.write('READY\\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
			parseEvent: line => ({ event: { type: line } }) };
		handle = await new ProviderProcessSupervisor().run(runRequest, command, event => { if (event.type === 'READY') { signalReady(); } },
			(pgid, controlNonce) => { ownedPgid = pgid; return request.onOwnedProcessSpawned(pgid, controlNonce, recoveryControl); });
		await ready;
		const result = await handle.result;
		handleFinished = true;
		if (result.cleanupVerified) {
			await request.onCleanupVerified({ requestId: request.requestId, attemptId: request.attemptId, pgid: ownedPgid!, controlNonce: recoveryControl.nonce, recoveryControl });
		}
		return { state: result.cleanupVerified ? 'cancelled' : 'interrupted', cleanupVerified: result.cleanupVerified, reason: result.error };
	};
	const value = fixture(runner);
	t.after(async () => {
		if (handle && !handleFinished) { handle.cancel(); await handle.result; }
		value.dispose();
		if (providerDirectory) { rmSync(providerDirectory, { recursive: true, force: true }); }
	});
	const preview = await value.application.previewPrTextRequest(previewInput(value.scope));
	const running = await value.application.startPrTextRequest({ scope: value.scope, requestId: preview.request.id, expectedStateRevision: preview.request.stateRevision, expectedDigest: preview.digest });
	await ready;
	const storedProcess = value.database.agentSessionPrTextProcesses.listUnverified()[0];
	assert.ok(storedProcess, 'the launch gate was opened only after durable process identity was stored');
	const recoveredDatabase = value.reopen();
	const recoveredApplication = new AgentSessionPrTextApplication(recoveredDatabase, {
		async resolve(session, targetTurn) { return { providerId: session.provider, model: session.model, profileRef: session.profileRef, sourceCwd: targetTurn.snapshot.cwd, profileDirectory: '/profiles/claude-profile-a', executable: '/bin/claude',
			processControl: { nodeExecutable: process.execPath, helperScript: fileURLToPath(new URL('../../../../../../scripts/provider-group-control.mjs', import.meta.url)) },
			preflight: async () => ({ allowed: true, cwdIdentity: 'fixture-cwd', policyProof: 'fixture-policy-proof' }), knownSecrets: [] }; },
	});
	await recoveredApplication.initialize();
	assert.deepEqual(recoveredDatabase.agentSessionPrTextProcesses.listUnverified(), [], 'exact cancellation and socket cleanup were durably verified');
	assert.equal(running.state, 'running');
	await assert.rejects(recoveredApplication.startPrTextRequest({ scope: value.scope, requestId: running.id, expectedStateRevision: running.stateRevision, expectedDigest: preview.digest }), /stale|changed|running|미리보기/u);
	assert.equal(handle && (await handle.result).cleanupVerified, true);
	await recoveredApplication.shutdown();
});
