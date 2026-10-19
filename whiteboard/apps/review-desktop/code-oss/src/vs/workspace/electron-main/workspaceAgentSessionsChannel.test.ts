/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import type { WebContents } from 'electron';
import { URI } from '../../base/common/uri.js';
import type { ICodeWindow } from '../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { AgentSessionTranscriptPageDTO, AgentSessionTurnSnapshot, SessionNotificationDTO } from '../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceAgentSessionMailboxPage, WorkspaceAgentSessionNotificationStatus } from '../common/workspaceAgentCommunicationProtocol.js';
import type { AgentWorkflowApprovalResult, AgentWorkflowPageDTO, AgentWorkflowPlanInput, AgentWorkflowStatusDTO } from '../common/workspaceAgentWorkflowProtocol.js';
import type { AgentSessionIntegrationProposalDTO } from '../common/workspaceAgentIntegrationProtocol.js';
import type { AgentPtyHandle, AgentPtyHost, AgentPtyOutputPage, AgentPtySnapshot, AgentPtyStopResult } from './agentSessions/agentPtyHost.js';
import { AgentSessionService, type AgentSessionRuntimeFactory, type AgentSessionRuntimeHandle } from './agentSessions/agentSessionService.js';
import { AgentSessionWorkspaceResolver } from './agentSessions/agentSessionWorkspace.js';
import { ManagedWorktreeService } from './agentSessions/managedWorktrees.js';
import { TaskFolderWriterLock } from './providerRuns/taskFolderWriterLock.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import { WorkspaceAgentSessionsChannel, type WorkspaceAgentCommitHost, type WorkspaceAgentWorkflowHost } from './workspaceAgentSessionsChannel.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(accept => { resolve = accept; });
	let entered!: () => void;
	const reached = new Promise<void>(accept => { entered = accept; });
	return { promise, resolve, reached, entered };
}

function wait(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

const nativePtyNode = process.env['BUGFIXER_NATIVE_PTY_NODE'];
const nativePtyGuardian = process.env['BUGFIXER_NATIVE_PTY_GUARDIAN'];
const nativePtyTestEnabled = Boolean(process.versions.electron && nativePtyNode && nativePtyGuardian
	&& isAbsolute(nativePtyNode) && isAbsolute(nativePtyGuardian) && existsSync(nativePtyNode) && existsSync(nativePtyGuardian));
if (process.env['BUGFIXER_NATIVE_PTY_REQUIRED'] === '1' && !nativePtyTestEnabled) {
	throw new Error('Required native IPC contracts need Electron and the packaged Node/guardian resources.');
}

function createRuntimeFixture(root: string, nodeExecutable: string, guardianScriptPath: string) {
	type Handle = AgentSessionRuntimeHandle;
	const records = new Map<Handle, { readonly host: AgentPtyHost; readonly handle: AgentPtyHandle }>();
	let latestRuntimeHandle: Handle | undefined;
	let nextStartGate: ReturnType<typeof deferred> | undefined;
	let nextAttachGate: ReturnType<typeof deferred> | undefined;
	const runtimeFactory: AgentSessionRuntimeFactory = {
		async start(snapshot: AgentSessionTurnSnapshot, _turnId: string, signal: AbortSignal): Promise<Handle> {
			const { AgentPtyHost } = await import('./agentSessions/agentPtyHost.js');
			const host = new AgentPtyHost({
				guardianNodeExecutable: nodeExecutable,
				guardianScriptPath,
				maxOutputChunks: 4096,
				maxOutputBytes: 8 * 1024 * 1024,
				createSanitizer: () => ({ push: text => text, flush: () => '' }),
				revokeAccess() { },
			});
			const handle = await host.start({
				executable: nodeExecutable,
				args: ['-e', 'process.stdin.setRawMode(true);process.stdin.on("data",chunk=>{for(const byte of chunk)if(byte===110)process.stdout.write("x".repeat(3000)+"\\n")});setTimeout(()=>{},30000)'],
				cwd: snapshot.cwd,
				env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root },
				cols: 100,
				rows: 30,
			}, signal);
			const runtimeHandle = Object.freeze({}) as Handle;
			records.set(runtimeHandle, { host, handle });
			latestRuntimeHandle = runtimeHandle;
			const gate = nextStartGate;
			if (gate) { nextStartGate = undefined; gate.entered(); await gate.promise; }
			return runtimeHandle;
		},
		watchExit(handle, listener) { const record = records.get(handle); if (!record) { throw new Error('Unknown PTY fixture handle.'); } return record.host.watchExit(record.handle, listener); },
		getSnapshot(handle) { const record = records.get(handle); if (!record) { throw new Error('Unknown PTY fixture handle.'); } return record.host.getSnapshot(record.handle); },
		async write(handle, text) { const record = records.get(handle); if (!record) { throw new Error('Unknown PTY fixture handle.'); } await record.host.write(record.handle, text); },
		async resize(handle, cols, rows) { const record = records.get(handle); if (!record) { throw new Error('Unknown PTY fixture handle.'); } await record.host.resize(record.handle, cols, rows); },
		async attach(handle, listener, afterSequence): Promise<IDisposable & { readonly snapshot: AgentPtySnapshot; readonly initialPage: AgentPtyOutputPage; read(afterSequence: number, limit?: number): AgentPtyOutputPage }> {
			const record = records.get(handle);
			if (!record) { throw new Error('Unknown PTY fixture handle.'); }
			const attachment = await record.host.attach(record.handle, listener, afterSequence);
			const gate = nextAttachGate;
			if (gate) { nextAttachGate = undefined; gate.entered(); await gate.promise; }
			return attachment;
		},
		async stop(handle): Promise<AgentPtyStopResult> { const record = records.get(handle); if (!record) { throw new Error('Unknown PTY fixture handle.'); } return record.host.stop(record.handle); },
		async release(handle): Promise<void> { const record = records.get(handle); if (!record) { throw new Error('Unknown PTY fixture handle.'); } await record.host.release(record.handle); records.delete(handle); },
	};
	return {
		runtimeFactory,
		async emitOutput(count: number): Promise<void> {
			const runtimeHandle = latestRuntimeHandle;
			const record = runtimeHandle && records.get(runtimeHandle);
			if (!record) { throw new Error('No active PTY fixture handle.'); }
			for (let index = 0; index < count; index++) {
				const before = record.host.getSnapshot(record.handle).latestSequence;
				await record.host.write(record.handle, 'n');
				const deadline = Date.now() + 2_000;
				const outputReached = () => record.host.read(record.handle, before, 500).chunks.some(chunk => chunk.text.includes('x'));
				while (!outputReached() && Date.now() < deadline) {
					await new Promise(resolve => setTimeout(resolve, 2));
				}
				if (!outputReached()) {
					throw new Error(`PTY fixture output ${index + 1} did not reach the host.`);
				}
			}
		},
		holdNextStart() { const gate = deferred(); nextStartGate = gate; return { entered: gate.reached, release: gate.resolve }; },
		holdNextAttach() { const gate = deferred(); nextAttachGate = gate; return { entered: gate.reached, release: gate.resolve }; },
	};
}

test('session IPC persists SQLite sessions and rejects project spoofing and untrusted senders', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-agent-session-channel-'));
	const database = WorkspaceDatabase.open(':memory:');
	try {
		const descriptorUri = URI.file(join(directory, 'project.code-workspace')).toString();
		const project = database.createProjectWorkspace('Authorized project', directory, descriptorUri);
		const otherProject = database.createProjectWorkspace('Other project', directory, URI.file(join(directory, 'other.code-workspace')).toString());
		const codeWindow = {
			config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } },
			openedWorkspace: { id: 'workspace-id', configPath: URI.parse(descriptorUri) },
		} as unknown as ICodeWindow;
		const sender = Object.assign(new EventEmitter(), { id: 31, isDestroyed: () => false }) as unknown as WebContents;
		const forgedSender = { id: 32, isDestroyed: () => false } as WebContents;
		const windows = {
			getWindowByWebContents: (candidate: WebContents) => candidate === sender ? codeWindow : undefined,
		} as IWindowsMainService;
		const channel = new WorkspaceAgentSessionsChannel(database, windows);

		const created = await channel.call<{ id: string; projectId: string; bindingId: string }>(sender, 'createSession', {
			projectId: project.project.id, bindingId: project.binding.id, name: 'Implementation', provider: 'codex',
			model: 'gpt-5-codex', workspaceMode: 'gitWorktree',
		});
		assert.equal(created.projectId, project.project.id);
		assert.equal(created.bindingId, project.binding.id);
		assert.deepEqual(await channel.call(sender, 'listSessions', { projectId: project.project.id }), [created]);

		const otherSession = database.agentSessions.createSession({
			projectId: otherProject.project.id, bindingId: otherProject.binding.id, name: 'Private', provider: 'claude',
			model: 'sonnet', workspaceMode: 'sharedFolder',
		});
		await assert.rejects(channel.call(sender, 'listSessions', { projectId: otherProject.project.id }), /does not match this window/u);
		await assert.rejects(channel.call(forgedSender, 'listSessions', { projectId: project.project.id }), /open project window/u);
		const validTurnId = randomUUID();
		await assert.rejects(channel.call(sender, 'write', { projectId: project.project.id, sessionId: created.id, turnId: validTurnId, text: '\r\n \t' }), /no trusted PTY backend/u);
		await channel.call(sender, 'write', { projectId: project.project.id, sessionId: created.id, turnId: validTurnId, text: '' });
		await assert.rejects(channel.call(sender, 'write', { projectId: project.project.id, sessionId: created.id, turnId: validTurnId, text: 'x'.repeat(65_537) }), /64 KiB limit/u);
		await assert.rejects(channel.call(sender, 'write', { projectId: project.project.id, sessionId: created.id, turnId: validTurnId, text: { value: 'invalid' } }), /64 KiB limit/u);
		await assert.rejects(channel.call(sender, 'preview', {
			projectId: project.project.id, sessionId: created.id, permissionPolicy: { mode: 'read-only', approval: 'never' },
		}), /no trusted PTY backend/u);

		const session = database.agentSessions.getSession(project.project.id, created.id)!;
		const cwd = realpathSync(directory);
		const identity = statSync(cwd, { bigint: true });
		const snapshot: AgentSessionTurnSnapshot = {
			schemaVersion: 1, projectId: project.project.id, sessionId: session.id, sessionRevision: session.revision,
			bindingId: session.bindingId, taskId: session.taskId, provider: session.provider, model: session.model, profileRef: session.profileRef,
			cwd, folderIdentity: { canonicalPath: cwd, dev: identity.dev.toString(), ino: identity.ino.toString() },
			managedWorktreeOwnerId: session.id, permissionPolicy: { mode: 'read-only', approval: 'never' }, convention: null, references: [],
		};
		const turn = database.agentSessionTurns.createTurn({ projectId: project.project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
		database.agentSessionTranscripts.appendSanitizedTerminalChunk({ projectId: project.project.id, sessionId: session.id, turnId: turn.id, sequence: 1, sanitizedTextFromTrustedPtyHost: 'sanitized terminal history\n' });
		database.agentSessionTranscripts.appendStructuredLog({ projectId: project.project.id, sessionId: session.id, turnId: turn.id, sequence: 2, text: 'token=private-fixture-value', severity: 'info', source: 'host', trustedKnownSecrets: ['private-fixture-value'] });
		const transcriptRequest = { projectId: project.project.id, sessionId: session.id, turnId: turn.id };
		const page = await channel.call<AgentSessionTranscriptPageDTO>(sender, 'readTranscript', { ...transcriptRequest, options: { limit: 1 } });
		assert.equal(page.entries[0].text, 'sanitized terminal history\n');
		assert.equal(page.nextSequence, 1);
		assert.equal(page.hasMore, true);
		const logs = await channel.call<AgentSessionTranscriptPageDTO>(sender, 'readTranscript', { ...transcriptRequest, options: { kind: 'log', afterSequence: page.nextSequence } });
		assert.equal(logs.entries.length, 1);
		assert.equal(logs.entries[0].text, 'token=***');
		await assert.rejects(channel.call(forgedSender, 'readTranscript', transcriptRequest), /open project window/u);
		await assert.rejects(channel.call(sender, 'readTranscript', { ...transcriptRequest, projectId: otherProject.project.id }), /does not match this window/u);
		await assert.rejects(channel.call(sender, 'readTranscript', { ...transcriptRequest, sessionId: otherSession.id }), /does not belong/u);
		await assert.rejects(channel.call(sender, 'readTranscript', { ...transcriptRequest, options: { kind: 'raw' } }), /kind is invalid/u);
		await assert.rejects(channel.call(sender, 'readTranscript', { ...transcriptRequest, options: { maxOutputBytes: 8 * 1024 * 1024 } }), /byte budget/u);

		const recipient = database.agentSessions.createSession({ projectId: project.project.id, bindingId: project.binding.id, name: 'Review', provider: 'claude', model: 'sonnet', workspaceMode: 'sharedFolder' });
		const recipientTurn = database.agentSessionTurns.createTurn({
			projectId: project.project.id, sessionId: recipient.id, expectedSessionRevision: recipient.revision,
			snapshot: { ...snapshot, sessionId: recipient.id, sessionRevision: recipient.revision, provider: recipient.provider, model: recipient.model, profileRef: recipient.profileRef, managedWorktreeOwnerId: null },
		});
		const contentScope = { projectId: project.project.id, sessionId: recipient.id, turnId: recipientTurn.id };
		const fileHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
		const contentSnapshot = (content: string, capturedAt: string) => ({
			schemaVersion: 1 as const,
			folderIdentity: snapshot.folderIdentity,
			capturedAt,
			inventoryCoverage: 'complete' as const,
			contentCoverage: 'complete' as const,
			entryCount: 1,
			fileBytes: Buffer.byteLength(content, 'utf8'),
			retainedTextBytes: Buffer.byteLength(content, 'utf8'),
			contentReadCount: 1,
			entries: [{ path: 'src/review.ts', kind: 'file' as const, size: Buffer.byteLength(content, 'utf8'), sha256: fileHash(content), content }],
		});
		const beforeCapture = contentSnapshot('const answer = 1;\n', new Date().toISOString());
		database.agentSessionContents.recordBaseline({ scope: contentScope, snapshot: beforeCapture, revision: null });
		const afterCapture = contentSnapshot('const answer = 2;\n', new Date(Date.now() + 1).toISOString());
		database.agentSessionContents.recordAfter({ scope: contentScope, snapshot: afterCapture, expectedLatestVersion: 0, revision: null, cleanupVerified: true });
		const nextCapture = contentSnapshot('const answer = 3;\n', new Date(Date.now() + 2).toISOString());
		database.agentSessionContents.recordAfter({ scope: contentScope, snapshot: nextCapture, expectedLatestVersion: 1, revision: null, cleanupVerified: true });
		const newestCapture = contentSnapshot('const answer = 4;\n', new Date(Date.now() + 3).toISOString());
		database.agentSessionContents.recordAfter({ scope: contentScope, snapshot: newestCapture, expectedLatestVersion: 2, revision: null, cleanupVerified: true });
		const latestChanges = await channel.call<import('../common/workspaceAgentChangesProtocol.js').WorkspaceAgentChangeEvidenceDTO>(sender, 'getLatestChangeEvidence', contentScope);
		assert.equal(latestChanges.turnId, recipientTurn.id);
		const changePage = await channel.call<import('../common/workspaceAgentChangesProtocol.js').WorkspaceAgentChangeEvidencePageDTO>(sender, 'listChangeEvidence', { ...contentScope, limit: 1 });
		assert.equal(changePage.snapshots.length, 1);
		const recentHistory = await channel.call<import('../common/workspaceAgentChangesProtocol.js').WorkspaceAgentChangeEvidencePageDTO>(sender, 'listChangeEvidence', { ...contentScope, beforeVersion: latestChanges.version, limit: 1 });
		assert.deepEqual(recentHistory.snapshots.map(item => item.version), [2]);
		assert.equal(recentHistory.hasMore, true);
		const olderHistory = await channel.call<import('../common/workspaceAgentChangesProtocol.js').WorkspaceAgentChangeEvidencePageDTO>(sender, 'listChangeEvidence', { ...contentScope, beforeVersion: recentHistory.nextVersion, limit: 1 });
		assert.deepEqual(olderHistory.snapshots.map(item => item.version), [1]);
		assert.equal(olderHistory.hasMore, false);
		const retainedFile = await channel.call<import('../common/workspaceAgentChangesProtocol.js').WorkspaceAgentChangeFileDTO>(sender, 'getChangeFile', {
			...contentScope, evidenceVersion: latestChanges.version, fingerprint: latestChanges.fingerprint, path: 'src/review.ts',
		});
		assert.equal(retainedFile.before.state, 'text');
		assert.equal(retainedFile.after.state, 'text');
		if (retainedFile.before.state === 'text' && retainedFile.after.state === 'text') {
			assert.equal(retainedFile.before.file.content, 'const answer = 1;\n');
			assert.equal(retainedFile.after.file.content, 'const answer = 4;\n');
		}
		const hunkEvidence = await channel.call<import('../common/workspaceAgentChangesProtocol.js').WorkspaceAgentChangeHunksDTO>(sender, 'getChangeHunks', {
			...contentScope, evidenceVersion: latestChanges.version, fingerprint: latestChanges.fingerprint, path: 'src/review.ts',
		});
		assert.equal(hunkEvidence.status, 'hunks');
		const selectedHunk = hunkEvidence.hunks[0];
		assert.ok(selectedHunk);
		const explanationTarget = {
			...contentScope, evidenceVersion: latestChanges.version, evidenceFingerprint: latestChanges.fingerprint,
			path: 'src/review.ts', hunkId: selectedHunk.id,
		};
		assert.equal(await channel.call(sender, 'getLatestChangeExplanation', explanationTarget), null);
		const humanDraft = await channel.call<import('../common/workspaceAgentChangesProtocol.js').WorkspaceAgentExplanationDTO>(sender, 'recordHumanChangeExplanation', {
			...explanationTarget, expectedLatestRevision: 0, what: '수정 내용을 확인했습니다.', why: '보관된 비교에서 요청된 값 변경을 확인했습니다.',
			citations: [], checkClaims: [{ label: '빌드', outcome: 'notRun' }], status: 'draft',
		});
		assert.equal(humanDraft.actor, 'human');
		assert.equal(humanDraft.authorTurnId, null);
		assert.equal(humanDraft.status, 'draft');
		assert.equal(humanDraft.verification, 'unverified');
		assert.equal(humanDraft.checkClaims[0].outcome, 'notRun');
		const confirmedExplanation = await channel.call<import('../common/workspaceAgentChangesProtocol.js').WorkspaceAgentExplanationDTO>(sender, 'recordHumanChangeExplanation', {
			...explanationTarget, expectedLatestRevision: humanDraft.revision, what: '수정 내용을 확인했습니다.', why: '보관된 비교에서 요청된 값 변경을 확인했습니다.',
			citations: [], checkClaims: [], status: 'confirmed',
		});
		assert.equal(confirmedExplanation.actor, 'human');
		assert.equal(confirmedExplanation.status, 'confirmed', 'Confirmation is scoped to explanation text only.');
		assert.equal(confirmedExplanation.verification, 'unverified');
		const explanationHistory = await channel.call<import('../common/workspaceAgentChangesProtocol.js').WorkspaceAgentExplanationPageDTO>(sender, 'listChangeExplanationRevisions', { ...explanationTarget, afterRevision: 1, limit: 1 });
		assert.deepEqual(explanationHistory.revisions.map(item => item.revision), [2]);
		assert.equal(explanationHistory.hasMore, false);
		const latestExplanation = await channel.call<import('../common/workspaceAgentChangesProtocol.js').WorkspaceAgentExplanationDTO>(sender, 'getLatestChangeExplanation', explanationTarget);
		assert.equal(latestExplanation.revision, 2);
		assert.equal(latestExplanation.status, 'confirmed');
		await assert.rejects(channel.call(sender, 'recordHumanChangeExplanation', {
			...explanationTarget, expectedLatestRevision: 1, what: '다른 설명을 입력했습니다.', why: '낡은 편집 내용입니다.', citations: [], checkClaims: [], status: 'draft',
		}), /stale/u);
		await assert.rejects(channel.call(sender, 'getChangeHunks', { ...contentScope, evidenceVersion: latestChanges.version, fingerprint: latestChanges.fingerprint, path: 'src/review.ts', extra: true }), /documented scope/u);
		await assert.rejects(channel.call(sender, 'getLatestChangeExplanation', { ...explanationTarget, actor: 'human' }), /documented scope/u);
		await assert.rejects(channel.call(sender, 'recordHumanChangeExplanation', { ...explanationTarget, actor: 'human', expectedLatestRevision: 2, what: 'x', why: 'y', citations: [], checkClaims: [], status: 'confirmed' }), /documented scope/u);
		await assert.rejects(channel.call(sender, 'getLatestChangeExplanation', { ...explanationTarget, projectId: otherProject.project.id }), /does not match this window/u);
		await assert.rejects(channel.call(sender, 'recordHumanChangeExplanation', { ...explanationTarget, hunkId: '0'.repeat(64), expectedLatestRevision: 2, what: 'x', why: 'y', citations: [], checkClaims: [], status: 'draft' }), /not present/u);
		await assert.rejects(channel.call(forgedSender, 'getChangeHunks', { ...contentScope, evidenceVersion: latestChanges.version, fingerprint: latestChanges.fingerprint, path: 'src/review.ts' }), /open project window/u);
		await assert.rejects(channel.call(sender, 'getLatestChangeExplanation', { ...explanationTarget, sessionId: session.id }), /does not belong/u);
		await assert.rejects(channel.call(sender, 'getLatestChangeEvidence', { ...contentScope, extra: true }), /only their documented scope/u);
		await assert.rejects(channel.call(forgedSender, 'getLatestChangeEvidence', contentScope), /open project window/u);
		await assert.rejects(channel.call(sender, 'getLatestChangeEvidence', { ...contentScope, projectId: otherProject.project.id }), /does not match this window/u);
		await assert.rejects(channel.call(sender, 'getLatestChangeEvidence', { ...contentScope, sessionId: otherSession.id }), /turn does not belong/u);
		await assert.rejects(channel.call(sender, 'getChangeFile', { ...contentScope, evidenceVersion: latestChanges.version, fingerprint: latestChanges.fingerprint, path: '../secret' }), /safe root-relative/u);
		await assert.rejects(channel.call(sender, 'getChangeFile', { ...contentScope, evidenceVersion: latestChanges.version, fingerprint: '0'.repeat(64), path: 'src/review.ts' }), /changed/u);
		await assert.rejects(channel.call(sender, 'readTranscript', { ...transcriptRequest, turnId: recipientTurn.id }), /does not belong/u);
		database.agentSessions.sendMessage(project.project.id, session.id, { recipientSessionId: recipient.id, idempotencyKey: 'channel-alert', body: 'Review ready.' });
		const mailboxRequest = { projectId: project.project.id, sessionId: recipient.id };
		const mailbox = await channel.call<WorkspaceAgentSessionMailboxPage>(sender, 'listMessages', mailboxRequest);
		assert.equal(mailbox.messages.length, 1);
		assert.equal(mailbox.messages[0].body, 'Review ready.');
		assert.equal(mailbox.messages[0].readAt, null, 'Human inspection must not acknowledge AI receipt.');
		assert.equal('idempotencyKey' in mailbox.messages[0], false, 'The renderer does not receive the internal retry key.');
		assert.equal(mailbox.nextCursor, mailbox.messages[0].sequence);
		assert.equal((await channel.call<WorkspaceAgentSessionMailboxPage>(sender, 'listMessages', { ...mailboxRequest, afterSequence: mailbox.nextCursor })).messages.length, 0);
		await assert.rejects(channel.call(forgedSender, 'listMessages', mailboxRequest), /open project window/u);
		await assert.rejects(channel.call(sender, 'listMessages', { ...mailboxRequest, sessionId: otherSession.id }), /does not belong/u);
		await assert.rejects(channel.call(sender, 'listMessages', { ...mailboxRequest, projectId: otherProject.project.id }), /does not match this window/u);
		const notifications = await channel.call<SessionNotificationDTO[]>(sender, 'listNotifications', { projectId: project.project.id });
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].sessionId, recipient.id);
		assert.equal(notifications[0].readAt, null);
		assert.deepEqual(await channel.call(sender, 'notificationStatus', { projectId: project.project.id }), { unreadCount: 1, latestSequence: notifications[0].sequence });
		await channel.call(sender, 'markNotificationRead', { projectId: project.project.id, notificationId: notifications[0].id });
		await channel.call(sender, 'markNotificationRead', { projectId: project.project.id, notificationId: notifications[0].id });
		assert.ok((await channel.call<SessionNotificationDTO[]>(sender, 'listNotifications', { projectId: project.project.id }))[0].readAt);
		assert.deepEqual(await channel.call(sender, 'notificationStatus', { projectId: project.project.id }), { unreadCount: 0, latestSequence: notifications[0].sequence });
		await assert.rejects(channel.call(forgedSender, 'markNotificationRead', { projectId: project.project.id, notificationId: notifications[0].id }), /open project window/u);
		await assert.rejects(channel.call(sender, 'listNotifications', { projectId: otherProject.project.id }), /does not match this window/u);
		await assert.rejects(channel.call(sender, 'markNotificationRead', { projectId: project.project.id, notificationId: randomUUID() }), /does not belong/u);

		const escapedBody = String.fromCharCode(34, 92).repeat(7_000);
		const largeMessages = Array.from({ length: 20 }, (_, index) => database.agentSessions.sendMessage(project.project.id, session.id, {
			recipientSessionId: recipient.id, idempotencyKey: `byte-page-${index}`, body: `${index}:${escapedBody}`,
		}));
		let largePage = await channel.call<WorkspaceAgentSessionMailboxPage>(sender, 'listMessages', { ...mailboxRequest, afterSequence: mailbox.nextCursor, limit: 100 });
		assert.ok(largePage.messages.length > 0 && largePage.messages.length < largeMessages.length, 'Escaped bodies must be paged by bytes before the count limit.');
		assert.equal(largePage.hasMore, true);
		const received = [...largePage.messages];
		while (largePage.hasMore) {
			assert.ok(Buffer.byteLength(JSON.stringify(largePage), 'utf8') <= 512 * 1024, 'The complete response envelope must fit the mailbox byte limit.');
			assert.equal(largePage.nextCursor, largePage.messages.at(-1)!.sequence, 'A page cursor must stop at the last delivered message.');
			largePage = await channel.call<WorkspaceAgentSessionMailboxPage>(sender, 'listMessages', { ...mailboxRequest, afterSequence: largePage.nextCursor, limit: 100 });
			received.push(...largePage.messages);
		}
		assert.ok(Buffer.byteLength(JSON.stringify(largePage), 'utf8') <= 512 * 1024);
		assert.deepEqual(received.map(message => message.id), largeMessages.map(message => message.id));
		assert.deepEqual(received.map(message => message.body), largeMessages.map(message => message.body));
		assert.equal((await channel.call<WorkspaceAgentSessionNotificationStatus>(sender, 'notificationStatus', { projectId: project.project.id })).unreadCount, 20, 'The project unread count includes records beyond the loaded page.');
		const targetRequest = { ...mailboxRequest, messageId: mailbox.messages[0].id };
		assert.deepEqual(await channel.call(sender, 'getMessage', targetRequest), mailbox.messages[0], 'An older notification target is available without scanning newer pages.');
		assert.equal(await channel.call(sender, 'getMessage', { ...targetRequest, sessionId: session.id }), null, 'A message is never returned to a different recipient.');
		assert.equal(await channel.call(sender, 'getMessage', { ...targetRequest, messageId: randomUUID() }), null);
		await assert.rejects(channel.call(forgedSender, 'getMessage', targetRequest), /open project window/u);
		await assert.rejects(channel.call(sender, 'getMessage', { ...targetRequest, projectId: otherProject.project.id }), /does not match this window/u);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('commit approval IPC requires the exact scoped proposal and native confirmation, then leaves apply separate', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-agent-commit-channel-'));
	const database = WorkspaceDatabase.open(':memory:');
	try {
		const descriptorUri = URI.file(join(directory, 'project.code-workspace')).toString();
		const foreignUri = URI.file(join(directory, 'foreign.code-workspace')).toString();
		const project = database.createProjectWorkspace('Commit project', directory, descriptorUri);
		const foreignProject = database.createProjectWorkspace('Foreign commit project', directory, foreignUri);
		const openedWorkspace = { id: 'commit-workspace', configPath: URI.parse(descriptorUri) };
		const codeWindow = { config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } }, openedWorkspace } as unknown as ICodeWindow;
		const sender = Object.assign(new EventEmitter(), { id: 66, isDestroyed: () => false }) as unknown as WebContents;
		const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender ? codeWindow : undefined } as IWindowsMainService;
		const session = database.agentSessions.createSession({ projectId: project.project.id, bindingId: project.binding.id, name: 'Commit session', provider: 'codex', model: 'fixture-model', workspaceMode: 'gitWorktree' });
		const cwd = realpathSync(directory);
		const stat = statSync(cwd, { bigint: true });
		const folderIdentity = { canonicalPath: cwd, dev: stat.dev.toString(), ino: stat.ino.toString() };
		const turnSnapshot: AgentSessionTurnSnapshot = {
			schemaVersion: 1, projectId: project.project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: session.bindingId, taskId: null,
			provider: session.provider, model: session.model, profileRef: session.profileRef, cwd, folderIdentity,
			managedWorktreeOwnerId: session.id, permissionPolicy: { mode: 'read-only', approval: 'never' }, convention: null, references: [],
		};
		const turn = database.agentSessionTurns.createTurn({ projectId: project.project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot: turnSnapshot });
		const sourceHead = 'a'.repeat(40);
		const contents = (value: string, capturedAt: string) => {
			const bytes = Buffer.from(value, 'utf8');
			return {
				schemaVersion: 2 as const, folderIdentity, capturedAt, inventoryCoverage: 'complete' as const, contentCoverage: 'complete' as const,
				entryCount: 1, fileBytes: bytes.byteLength, retainedTextBytes: bytes.byteLength, retainedBinaryBytes: 0, contentReadCount: 1,
				entries: [{ path: 'src/change.ts', kind: 'file' as const, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), content: value, executable: false }],
			};
		};
		const scope = { projectId: project.project.id, sessionId: session.id, turnId: turn.id };
		database.agentSessionContents.recordBaseline({ scope, snapshot: contents('before\n', '2026-10-19T00:00:00.000Z'), revision: sourceHead });
		const runningSession = database.agentSessions.getSession(project.project.id, session.id)!;
		const running = database.agentSessionTurns.transitionTurn(project.project.id, session.id, turn.id, turn.revision, runningSession.revision, { state: 'running' });
		database.agentSessionContents.recordAfter({ scope, snapshot: contents('after\n', '2026-10-19T00:00:01.000Z'), expectedLatestVersion: 0, revision: sourceHead, cleanupVerified: true });
		const currentSession = database.agentSessions.getSession(project.project.id, session.id)!;
		database.agentSessionTurns.transitionTurn(project.project.id, session.id, turn.id, running.turn.revision, currentSession.revision, { state: 'exited', exitCode: 0, cleanupVerified: true });
		const evidence = database.agentSessionChangeEvidence.getLatest(project.project.id, session.id, turn.id)!;
		const target = { ...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, path: 'src/change.ts', hunkId: null };
		const explanation = database.agentSessionReviews.recordHumanExplanation({ target, expectedLatestRevision: 0, what: 'Changed the retained file.', why: 'The reviewed update is needed.', citations: [], checkClaims: [], status: 'confirmed' });
		const proposal = database.agentSessionIntegrations.createProposal({
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, sourceHead, proposedGitTreeHash: 'b'.repeat(40), diffFingerprint: 'c'.repeat(64),
			commitMessage: 'Reviewed source update', author: { name: 'Fixture Author', email: 'author@example.invalid', date: '1700000000 +0000' },
			committer: { name: 'Fixture Committer', email: 'committer@example.invalid', date: '1700000000 +0000' },
			paths: [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }], expectedLatestRevision: 0,
		});
		const proposalInput = { ...scope, proposalId: proposal.id, expectedRevision: proposal.revision, expectedFingerprint: proposal.fingerprint };
		let accept = false;
		let applyCalls = 0;
		let prepareCalls = 0;
		let gate: ReturnType<typeof deferred> | undefined;
		const host: WorkspaceAgentCommitHost = {
			prepare: async input => {
				prepareCalls++;
				assert.equal(input.projectId, project.project.id);
				assert.equal(input.sessionId, session.id);
				assert.equal(input.turnId, turn.id);
				return proposal;
			},
			approve: input => database.agentSessionIntegrations.recordTrustedHumanApproval(input.proposalId, input.expectedRevision),
			apply: async input => { applyCalls++; return database.agentSessionIntegrations.getProposal(input.proposalId)!; },
			recover: async input => database.agentSessionIntegrations.getProposal(input.proposalId)!,
			confirmProposal: async dialogSender => {
				assert.equal(dialogSender, sender);
				if (gate) { const current = gate; gate = undefined; current.entered(); await current.promise; }
				return accept;
			},
		};
		const channel = new WorkspaceAgentSessionsChannel(database, windows, undefined, undefined, undefined, undefined, undefined, undefined, host);
		const proposalPage = await channel.call<{ proposals: readonly AgentSessionIntegrationProposalDTO[] }>(sender, 'listCommitProposals', scope);
		assert.deepEqual(proposalPage.proposals.map(item => item.id), [proposal.id]);
		const prepared = await channel.call<AgentSessionIntegrationProposalDTO>(sender, 'prepareCommitProposal', {
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint,
			paths: [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }],
			commitMessage: 'Reviewed source update', expectedLatestRevision: 0,
		});
		assert.equal(prepared.id, proposal.id);
		assert.equal(prepareCalls, 1);
		await assert.rejects(channel.call(sender, 'prepareCommitProposal', {
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, paths: [], commitMessage: 'forged', expectedLatestRevision: 0, approved: true,
		}), /unknown fields/u);
		await assert.rejects(channel.call(sender, 'approveCommitProposal', { ...proposalInput, approved: true }), /unknown fields/u);
		await assert.rejects(channel.call(sender, 'approveCommitProposal', { ...proposalInput, projectId: foreignProject.project.id }), /does not match this window/u);
		await assert.rejects(channel.call(sender, 'approveCommitProposal', { ...proposalInput, expectedFingerprint: '0'.repeat(64) }), /changed/u);
		const cancelled = await channel.call<{ approved: boolean; proposal: AgentSessionIntegrationProposalDTO }>(sender, 'approveCommitProposal', proposalInput);
		assert.equal(cancelled.approved, false);
		assert.equal(cancelled.proposal.approval, null);
		assert.equal(applyCalls, 0);

		accept = true;
		const navigationGate = gate = deferred();
		const pendingApproval = channel.call(sender, 'approveCommitProposal', proposalInput);
		await navigationGate.reached;
		openedWorkspace.configPath = URI.parse(foreignUri);
		navigationGate.resolve();
		await assert.rejects(pendingApproval, /project window changed/u);
		openedWorkspace.configPath = URI.parse(descriptorUri);
		assert.equal(database.agentSessionIntegrations.getProposal(proposal.id)!.approval, null);

		const staleGate = gate = deferred();
		const staleApproval = channel.call(sender, 'approveCommitProposal', proposalInput);
		await staleGate.reached;
		const newerProposal = database.agentSessionIntegrations.createProposal({
			...scope, evidenceVersion: evidence.version, evidenceFingerprint: evidence.fingerprint, sourceHead,
			proposedGitTreeHash: 'd'.repeat(40), diffFingerprint: 'e'.repeat(64), commitMessage: 'New exact proposal',
			author: proposal.author, committer: proposal.committer,
			paths: [{ path: 'src/change.ts', explanationTargets: [{ path: 'src/change.ts', hunkId: null, revision: explanation.revision }] }],
			expectedLatestRevision: proposal.revision,
		});
		staleGate.resolve();
		await assert.rejects(staleApproval, /newer commit proposal/u);
		assert.equal(database.agentSessionIntegrations.getProposal(proposal.id)!.approval, null);
		const newerInput = { ...scope, proposalId: newerProposal.id, expectedRevision: newerProposal.revision, expectedFingerprint: newerProposal.fingerprint };
		const approved = await channel.call<{ approved: boolean; proposal: AgentSessionIntegrationProposalDTO }>(sender, 'approveCommitProposal', newerInput);
		assert.equal(approved.approved, true);
		assert.equal(approved.proposal.approval?.actor, 'human');
		assert.equal(applyCalls, 0, 'approval records authority but never applies the commit');
		await channel.call(sender, 'applyCommitProposal', newerInput);
		assert.equal(applyCalls, 1, 'apply requires its separate explicit command');
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('workflow IPC scopes plans, requires native confirmation, and rejects stale dialog approval', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-workflow-channel-'));
	const database = WorkspaceDatabase.open(':memory:');
	try {
		const descriptorUri = URI.file(join(directory, 'workflow.code-workspace')).toString();
		const otherUri = URI.file(join(directory, 'other.code-workspace')).toString();
		const project = database.createProjectWorkspace('Workflow project', directory, descriptorUri);
		const other = database.createProjectWorkspace('Foreign project', directory, otherUri);
		const windowData = {
			config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } },
			openedWorkspace: { id: 'workflow-workspace', configPath: URI.parse(descriptorUri) },
		};
		const codeWindow = windowData as unknown as ICodeWindow;
		const sender = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false }) as unknown as WebContents;
		const forgedSender = { id: 42, isDestroyed: () => false } as WebContents;
		const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender ? codeWindow : undefined } as IWindowsMainService;
		let accept = false;
		let dialogCalls = 0;
		let gate: ReturnType<typeof deferred> | undefined;
		let startGate: ReturnType<typeof deferred> | undefined;
		const host: WorkspaceAgentWorkflowHost = {
			start: async (projectId, workflowId, revision, key) => {
				const run = database.agentWorkflows.startWorkflow(projectId, workflowId, revision, key);
				if (startGate) { const current = startGate; startGate = undefined; current.entered(); await current.promise; }
				return run;
			},
			cancel: (projectId, workflowId, revision, key) => database.agentWorkflows.requestWorkflowCancellation(projectId, workflowId, revision, key),
			getHostError: () => null,
			confirmPlan: async (dialogSender, plan) => {
				assert.equal(dialogSender, sender);
				assert.equal(plan.projectId, project.project.id);
				dialogCalls++;
				if (gate) { const current = gate; gate = undefined; current.entered(); await current.promise; }
				return accept;
			},
		};
		const channel = new WorkspaceAgentSessionsChannel(database, windows, undefined, undefined, undefined, undefined, undefined, host);
		const session = database.agentSessions.createSession({ projectId: project.project.id, bindingId: project.binding.id, name: 'Implementation', provider: 'codex', model: 'fixture-model', workspaceMode: 'sharedFolder' });
		const input: AgentWorkflowPlanInput = {
			projectId: project.project.id, bindingId: project.binding.id, taskId: null, maxConcurrentNodes: 1, maxTotalTurns: 1, maxDurationMs: 60_000,
			nodes: [{ nodeId: 'implement', sessionId: session.id, role: 'implementer', provider: session.provider, model: session.model, bindingId: session.bindingId, taskId: null, referenceIds: [], dependsOn: [], permissionPolicy: { mode: 'read-only', approval: 'never' } }],
		};
		const created = await channel.call<AgentWorkflowStatusDTO>(sender, 'createWorkflow', { ...input, idempotencyKey: 'create-first', approved: true });
		const identity = { projectId: project.project.id, workflowId: created.workflow.id };
		const approval = { ...identity, expectedRevision: created.workflow.revision, planVersion: created.plan.version, fingerprint: created.plan.fingerprint, idempotencyKey: 'approve-first' };
		await assert.rejects(channel.call(sender, 'startWorkflow', { ...identity, expectedRevision: created.workflow.revision, idempotencyKey: 'unapproved-start', approved: true }), /must be approved/i);
		const denied = await channel.call<AgentWorkflowApprovalResult>(sender, 'approveWorkflow', approval);
		assert.equal(denied.approved, false);
		assert.equal(denied.status.workflow.state, 'waiting');
		accept = true;
		const approved = await channel.call<AgentWorkflowApprovalResult>(sender, 'approveWorkflow', approval);
		assert.equal(approved.approved, true);
		assert.equal(approved.status.workflow.state, 'ready');
		assert.equal(dialogCalls, 2);
		const started = await channel.call<AgentWorkflowStatusDTO>(sender, 'startWorkflow', { ...identity, expectedRevision: approved.status.workflow.revision, idempotencyKey: 'start-first' });
		assert.equal(started.run?.state, 'ready');
		const cancelled = await channel.call<AgentWorkflowStatusDTO>(sender, 'cancelWorkflow', { ...identity, expectedRevision: started.workflow.revision, idempotencyKey: 'cancel-first' });
		assert.equal(cancelled.run?.state, 'cancelled');
		assert.equal(database.agentSessionTurns.listTurns(project.project.id, session.id).length, 0);

		const second = await channel.call<AgentWorkflowStatusDTO>(sender, 'createWorkflow', { ...input, idempotencyKey: 'create-second' });
		const page = await channel.call<AgentWorkflowPageDTO>(sender, 'listWorkflows', { projectId: project.project.id, limit: 1 });
		assert.equal(page.workflows.length, 1);
		assert.equal(page.hasMore, true);
		const next = await channel.call<AgentWorkflowPageDTO>(sender, 'listWorkflows', { projectId: project.project.id, afterId: page.nextCursor, limit: 1 });
		assert.equal(next.hasMore, false);
		assert.deepEqual(new Set([...page.workflows, ...next.workflows].map(workflow => workflow.id)), new Set([created.workflow.id, second.workflow.id]));
		await assert.rejects(channel.call(forgedSender, 'getWorkflow', identity), /open project window/i);
		await assert.rejects(channel.call(sender, 'getWorkflow', { ...identity, projectId: other.project.id }), /does not match this window/i);
		await assert.rejects(channel.call(sender, 'createWorkflow', { ...input, idempotencyKey: 'unsupported-policy', nodes: [{ ...input.nodes[0], permissionPolicy: { mode: 'read-only', approval: 'always' } }] }), /launch policy/i);

		const staleGate = gate = deferred();
		const pendingApproval = channel.call(sender, 'approveWorkflow', { projectId: project.project.id, workflowId: second.workflow.id, expectedRevision: second.workflow.revision, planVersion: second.plan.version, fingerprint: second.plan.fingerprint, idempotencyKey: 'stale-approval' });
		await staleGate.reached;
		const revised = await channel.call<AgentWorkflowStatusDTO>(sender, 'reviseWorkflow', { projectId: project.project.id, workflowId: second.workflow.id, expectedRevision: second.workflow.revision, plan: { ...input, maxDurationMs: 120_000 } });
		staleGate.resolve();
		await assert.rejects(pendingApproval, /changed while its approval dialog/i);
		assert.equal(revised.workflow.state, 'waiting');
		assert.equal((await channel.call<AgentWorkflowStatusDTO>(sender, 'getWorkflow', { projectId: project.project.id, workflowId: second.workflow.id })).run, null);
		await assert.rejects(channel.call(sender, 'startWorkflow', { projectId: project.project.id, workflowId: second.workflow.id, expectedRevision: revised.workflow.revision, idempotencyKey: 'changed-plan-start' }), /must be approved/i);

		const navigationGate = gate = deferred();
		const navigationApproval = channel.call(sender, 'approveWorkflow', { projectId: project.project.id, workflowId: second.workflow.id, expectedRevision: revised.workflow.revision, planVersion: revised.plan.version, fingerprint: revised.plan.fingerprint, idempotencyKey: 'navigation-approval' });
		await navigationGate.reached;
		windowData.config.reviewWindowLaunch.projectId = other.project.id;
		windowData.openedWorkspace.configPath = URI.parse(otherUri);
		navigationGate.resolve();
		await assert.rejects(navigationApproval, /changed|project|scope/i);
		assert.equal(database.agentWorkflows.getWorkflow(project.project.id, second.workflow.id)?.state, 'waiting');

		windowData.config.reviewWindowLaunch.projectId = project.project.id;
		windowData.openedWorkspace.configPath = URI.parse(descriptorUri);
		const secondIdentity = { projectId: project.project.id, workflowId: second.workflow.id };
		const approveCurrent = await channel.call<AgentWorkflowApprovalResult>(sender, 'approveWorkflow', { ...secondIdentity, expectedRevision: revised.workflow.revision, planVersion: revised.plan.version, fingerprint: revised.plan.fingerprint, idempotencyKey: 'approve-current' });
		const ownStartGate = startGate = deferred();
		const ownStart = channel.call(sender, 'startWorkflow', { ...secondIdentity, expectedRevision: approveCurrent.status.workflow.revision, idempotencyKey: 'start-with-navigation' });
		await ownStartGate.reached;
		const ownRun = database.agentWorkflows.getLatestRun(project.project.id, second.workflow.id)!;
		windowData.config.reviewWindowLaunch.projectId = other.project.id;
		windowData.openedWorkspace.configPath = URI.parse(otherUri);
		ownStartGate.resolve();
		await assert.rejects(ownStart, /changed|project|scope/i);
		assert.equal(database.agentWorkflows.getRun(project.project.id, second.workflow.id, ownRun.id)?.state, 'cancelled', 'Navigation compensates the exact run started by this request.');

		windowData.config.reviewWindowLaunch.projectId = project.project.id;
		windowData.openedWorkspace.configPath = URI.parse(descriptorUri);
		const oldWorkflow = database.agentWorkflows.getWorkflow(project.project.id, second.workflow.id)!;
		const nextPlan = database.agentWorkflows.reviseWorkflowPlan(project.project.id, second.workflow.id, oldWorkflow.revision, { ...input, maxDurationMs: 180_000 });
		const nextStatus = await channel.call<AgentWorkflowStatusDTO>(sender, 'getWorkflow', secondIdentity);
		assert.equal(nextStatus.run, null, 'An older plan run cannot appear as the revised plan execution.');
		const nextApproval = await channel.call<AgentWorkflowApprovalResult>(sender, 'approveWorkflow', { ...secondIdentity, expectedRevision: nextPlan.revision, planVersion: nextStatus.plan.version, fingerprint: nextStatus.plan.fingerprint, idempotencyKey: 'approve-next' });
		const interleavingGate = startGate = deferred();
		const delayedStart = channel.call(sender, 'startWorkflow', { ...secondIdentity, expectedRevision: nextApproval.status.workflow.revision, idempotencyKey: 'old-delayed-start' });
		await interleavingGate.reached;
		const inFlight = database.agentWorkflows.getWorkflow(project.project.id, second.workflow.id)!;
		const stoppedOld = database.agentWorkflows.requestWorkflowCancellation(project.project.id, second.workflow.id, inFlight.revision, 'controlled-old-cancel');
		const newer = database.agentWorkflows.reviseWorkflowPlan(project.project.id, second.workflow.id, stoppedOld.revision, { ...input, maxDurationMs: 240_000 });
		const newerPlan = database.agentWorkflows.getPlan(project.project.id, second.workflow.id)!;
		database.agentWorkflows.recordTrustedUiApproval(project.project.id, second.workflow.id, newerPlan.version, newerPlan.fingerprint, 'controlled-newer-approval');
		const newerReady = database.agentWorkflows.getWorkflow(project.project.id, second.workflow.id)!;
		const newerRun = database.agentWorkflows.startWorkflow(project.project.id, second.workflow.id, newerReady.revision, 'controlled-newer-start');
		assert.equal(newer.planVersion, newerPlan.version);
		windowData.config.reviewWindowLaunch.projectId = other.project.id;
		windowData.openedWorkspace.configPath = URI.parse(otherUri);
		interleavingGate.resolve();
		await assert.rejects(delayedStart, /changed|project|scope/i);
		assert.equal(database.agentWorkflows.getRun(project.project.id, second.workflow.id, newerRun.id)?.state, 'ready', 'Stale start compensation cannot cancel a later plan/run.');
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('pending PTY attach is revoked on navigation, catches up output, and pending start stops its exact turn on destruction', { skip: !nativePtyTestEnabled }, async () => {
	const root = mkdtempSync(join(tmpdir(), 'workspace-agent-session-pty-channel-'));
	const projectFolder = join(root, 'project');
	const secondProjectFolder = join(root, 'second-project');
	const profileFolder = join(root, 'profile');
	mkdirSync(projectFolder);
	mkdirSync(secondProjectFolder);
	mkdirSync(profileFolder);
	const database = WorkspaceDatabase.open(join(root, 'workspace.db'));
	const descriptor = URI.file(join(root, 'project.code-workspace')).toString();
	const secondDescriptor = URI.file(join(root, 'second.code-workspace')).toString();
	const project = database.createProjectWorkspace('PTY project', projectFolder, descriptor);
	const secondProject = database.createProjectWorkspace('Second project', secondProjectFolder, secondDescriptor);
	const session = database.agentSessions.createSession({
		projectId: project.project.id, bindingId: project.binding.id, name: 'Output fixture', provider: 'codex', model: 'fixture', workspaceMode: 'sharedFolder',
	});
	const secondSession = database.agentSessions.createSession({
		projectId: secondProject.project.id, bindingId: secondProject.binding.id, name: 'Start fixture', provider: 'claude', model: 'fixture', workspaceMode: 'sharedFolder',
	});
	const worktrees = new ManagedWorktreeService(profileFolder);
	const resolver = new AgentSessionWorkspaceResolver(database, worktrees, new TaskFolderWriterLock(), () => true);
	const runtime = createRuntimeFixture(root, nativePtyNode!, nativePtyGuardian!);
	const service = new AgentSessionService(database, resolver, runtime.runtimeFactory);
	let activeWindow = {
		config: { reviewWindowLaunch: { kind: 'project', projectId: project.project.id } },
		openedWorkspace: { id: 'first', configPath: URI.parse(descriptor) },
	} as unknown as ICodeWindow;
	const surface = new EventEmitter();
	let destroyed = false;
	const sent: Array<{ channel: string; payload: unknown }> = [];
	const sender = Object.assign(surface, {
		id: 53,
		isDestroyed: () => destroyed,
		send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
	}) as unknown as WebContents;
	const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender ? activeWindow : undefined } as IWindowsMainService;
	const channel = new WorkspaceAgentSessionsChannel(database, windows, service);
	try {
		const preview = await channel.call<{ ticketId: string }>(sender, 'preview', {
			projectId: project.project.id, sessionId: session.id, permissionPolicy: { mode: 'read-only', approval: 'never' },
		});
		const turn = await channel.call<{ id: string }>(sender, 'start', { projectId: project.project.id, sessionId: session.id, ticketId: preview.ticketId });
		const attachGate = runtime.holdNextAttach();
		const attach = channel.call(sender, 'attach', { projectId: project.project.id, sessionId: session.id, turnId: turn.id });
		await attachGate.entered;
		await runtime.emitOutput(220);
		const secondAttachment = await channel.call<{ attachmentId: string }>(sender, 'attach', { projectId: project.project.id, sessionId: session.id, turnId: turn.id });
		await assert.rejects(channel.call(sender, 'attach', { projectId: project.project.id, sessionId: session.id, turnId: turn.id }), /maximum number of live output attachments/u);
		attachGate.release();
		const attached = await attach as { attachmentId: string; initialPage: AgentPtyOutputPage };
		const streamed = sent.filter(event => event.channel === 'workspaceAgentSessions/output')
			.map(event => event.payload as { attachmentId: string; chunk: { sequence: number; gap: boolean } })
			.filter(event => event.attachmentId === attached.attachmentId);
		assert.ok(streamed.length > 200, `expected three bounded catch-up pages of PTY output, received ${streamed.length}`);
		assert.equal(streamed.some(event => event.chunk.gap), false);
		assert.equal(streamed[0].chunk.sequence, attached.initialPage.cursor + 1);
		for (let index = 1; index < streamed.length; index++) {
			assert.equal(streamed[index].chunk.sequence, streamed[index - 1].chunk.sequence + 1, 'catch-up output cursors must not silently skip chunks');
		}
		await channel.call(sender, 'write', { projectId: project.project.id, sessionId: session.id, turnId: turn.id, text: '\r\n \t' });
		await channel.call(sender, 'write', { projectId: project.project.id, sessionId: session.id, turnId: turn.id, text: '' });
		await assert.rejects(channel.call(sender, 'write', { projectId: project.project.id, sessionId: session.id, turnId: turn.id, text: 'x'.repeat(65_537) }), /64 KiB limit/u);
		await assert.rejects(channel.call(sender, 'write', { projectId: project.project.id, sessionId: session.id, turnId: turn.id, text: { value: 'invalid' } }), /64 KiB limit/u);
		await channel.call(sender, 'disconnect', { projectId: project.project.id, sessionId: session.id, turnId: turn.id, attachmentId: attached.attachmentId });
		await channel.call(sender, 'disconnect', { projectId: project.project.id, sessionId: session.id, turnId: turn.id, attachmentId: secondAttachment.attachmentId });

		const pendingAttachGate = runtime.holdNextAttach();
		const pendingAttach = channel.call(sender, 'attach', { projectId: project.project.id, sessionId: session.id, turnId: turn.id });
		await pendingAttachGate.entered;
		activeWindow = {
			config: { reviewWindowLaunch: { kind: 'project', projectId: secondProject.project.id } },
			openedWorkspace: { id: 'second', configPath: URI.parse(secondDescriptor) },
		} as unknown as ICodeWindow;
		surface.emit('did-start-loading');
		const eventsBeforeRelease = sent.length;
		pendingAttachGate.release();
		await assert.rejects(pendingAttach, /window changed while the output attachment/u);
		await wait(25);
		assert.equal(sent.length, eventsBeforeRelease, 'a stale pending attachment must not send into the newly navigated renderer');

		const secondPreview = await channel.call<{ ticketId: string }>(sender, 'preview', {
			projectId: secondProject.project.id, sessionId: secondSession.id, permissionPolicy: { mode: 'read-only', approval: 'never' },
		});
		const startGate = runtime.holdNextStart();
		const pendingStart = channel.call(sender, 'start', { projectId: secondProject.project.id, sessionId: secondSession.id, ticketId: secondPreview.ticketId });
		await startGate.entered;
		destroyed = true;
		surface.emit('destroyed');
		startGate.release();
		await assert.rejects(pendingStart, /window changed after turn .* was stopped/u);
		const turns = database.agentSessionTurns.listTurns(secondProject.project.id, secondSession.id);
		assert.equal(turns.length, 1);
		assert.equal(turns[0].state, 'exited');
		assert.equal(turns[0].cleanupVerified, true);
	} finally {
		await service.shutdown();
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
});
