/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import type { WebContents } from 'electron';
import { URI } from '../../base/common/uri.js';
import type { ICodeWindow } from '../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { AgentSessionTurnSnapshot } from '../common/workspaceAgentSessionProtocol.js';
import type { AgentPtyHandle, AgentPtyHost, AgentPtyOutputPage, AgentPtySnapshot, AgentPtyStopResult } from './agentSessions/agentPtyHost.js';
import { AgentSessionService, type AgentSessionRuntimeFactory, type AgentSessionRuntimeHandle } from './agentSessions/agentSessionService.js';
import { AgentSessionWorkspaceResolver } from './agentSessions/agentSessionWorkspace.js';
import { ManagedWorktreeService } from './agentSessions/managedWorktrees.js';
import { TaskFolderWriterLock } from './providerRuns/taskFolderWriterLock.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import { WorkspaceAgentSessionsChannel } from './workspaceAgentSessionsChannel.js';

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

		database.agentSessions.createSession({
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
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('pending PTY attach is revoked on navigation, catches up output, and pending start stops its exact turn on destruction', { skip: !nativePtyTestEnabled }, async () => {
	const root = mkdtempSync(join(tmpdir(), 'workspace-agent-session-pty-channel-'));
	const projectFolder = join(root, 'project');
	const profileFolder = join(root, 'profile');
	mkdirSync(projectFolder);
	mkdirSync(profileFolder);
	const database = WorkspaceDatabase.open(join(root, 'workspace.db'));
	const descriptor = URI.file(join(root, 'project.code-workspace')).toString();
	const secondDescriptor = URI.file(join(root, 'second.code-workspace')).toString();
	const project = database.createProjectWorkspace('PTY project', projectFolder, descriptor);
	const secondProject = database.createProjectWorkspace('Second project', projectFolder, secondDescriptor);
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
