/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { AGENT_CLI_COMMAND_SPEC_VERSION } from './agentCliCapabilities.js';
import { AgentSessionJournal } from './agentSessionJournal.js';
import { AgentSessionPtyRuntimeFactory } from './agentSessionPtyRuntime.js';
import { AgentSessionRuntimeStartError, type AgentSessionRuntimeHandle } from './agentSessionService.js';

const nativePtyNode = process.env.BUGFIXER_NATIVE_PTY_NODE;
const nativePtyGuardian = process.env.BUGFIXER_NATIVE_PTY_GUARDIAN;
if (!nativePtyNode || !nativePtyGuardian) { throw new Error('Native PTY runtime contracts require the packaged Node executable and guardian.'); }

function createFixture(releasePrivateConfig: () => Promise<void>, revokeAccess: () => void = () => { }) {
	const directory = mkdtempSync(join(tmpdir(), 'agent-session-pty-runtime-'));
	const projectPath = join(directory, 'project');
	const profileDirectory = join(directory, 'profile');
	mkdirSync(projectPath);
	mkdirSync(profileDirectory);
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	const project = database.createProject('PTY runtime cleanup');
	const binding = database.createFolderBinding({ projectId: project.id, path: projectPath });
	const session = database.agentSessions.createSession({ projectId: project.id, bindingId: binding.id, name: 'PTY runtime', provider: 'codex', model: 'fixture', profileRef: 'fixture-profile', workspaceMode: 'sharedFolder' });
	const cwd = realpathSync(projectPath);
	const stat = statSync(cwd, { bigint: true });
	const snapshot: AgentSessionTurnSnapshot = {
		schemaVersion: 1, projectId: project.id, sessionId: session.id, sessionRevision: session.revision, bindingId: binding.id, taskId: null,
		provider: session.provider, model: session.model, profileRef: session.profileRef, cwd,
		folderIdentity: { canonicalPath: cwd, dev: stat.dev.toString(), ino: stat.ino.toString() }, managedWorktreeOwnerId: null,
		permissionPolicy: { mode: 'read-only', approval: 'never' }, convention: null, references: [],
	};
	const turn = database.agentSessionTurns.createTurn({ projectId: project.id, sessionId: session.id, expectedSessionRevision: session.revision, snapshot });
	const args = ['-e', 'setInterval(() => {}, 1000)'];
	const profileDirectoryReal = realpathSync(profileDirectory);
	const commandEnv = { CODEX_HOME: profileDirectoryReal };
	const launchEnv = {
		...commandEnv,
		PATH: process.env.PATH ?? '/usr/bin',
		HOME: process.env.HOME ?? directory,
		TMPDIR: tmpdir(),
		LANG: process.env.LANG ?? 'C.UTF-8',
		LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
		USER: process.env.USER ?? 'fixture',
		LOGNAME: process.env.LOGNAME ?? 'fixture',
	};
	const runtime = new AgentSessionPtyRuntimeFactory({
		guardianNodeExecutable: nativePtyNode,
		guardianScriptPath: nativePtyGuardian,
		createJournal: (turnSnapshot, turnId, knownSecrets) => new AgentSessionJournal(database.agentSessionTranscripts, turnSnapshot, turnId, knownSecrets),
		prepareLaunch: async () => ({
			command: {
				commandSpecVersion: AGENT_CLI_COMMAND_SPEC_VERSION, provider: 'codex', cliVersion: 'fixture', model: snapshot.model,
				profileRef: snapshot.profileRef!, cwd, executable: nativePtyNode, args, env: commandEnv, forwardedMcpEnvironmentVariableNames: [],
			},
			permissionPolicy: snapshot.permissionPolicy, profileDirectory: profileDirectoryReal,
			launch: { executable: nativePtyNode, args, cwd, env: launchEnv, cols: 80, rows: 24 },
			knownSecrets: [], revokeAccess, releasePrivateConfig,
		}),
	});
	return { directory, database, project, session, snapshot, turn, runtime };
}

async function startRetainingRecoveryHandle(
	runtime: AgentSessionPtyRuntimeFactory,
	snapshot: AgentSessionTurnSnapshot,
	turnId: string,
	retainHandle: (handle: AgentSessionRuntimeHandle) => void,
): Promise<AgentSessionRuntimeHandle> {
	try {
		const handle = await runtime.start(snapshot, turnId, new AbortController().signal);
		retainHandle(handle);
		return handle;
	} catch (error) {
		if (error instanceof AgentSessionRuntimeStartError && error.recoveryHandle) { retainHandle(error.recoveryHandle); }
		throw error;
	}
}

async function disposeFixture(fixture: ReturnType<typeof createFixture>, handle: AgentSessionRuntimeHandle | undefined): Promise<void> {
	if (handle) {
		const cleanup = await fixture.runtime.stop(handle);
		assert.equal(cleanup.cleanupVerified, true, 'the owned runtime must verify cleanup before the fixture files are removed');
		await fixture.runtime.release(handle);
	}
	fixture.database.close();
	rmSync(fixture.directory, { recursive: true, force: true });
}

test('PTY runtime journals distinct cleanup failures without claiming the turn stopped', { skip: process.platform === 'win32' && 'Verified PTY process-group cleanup is unavailable on Windows.' }, async () => {
	let rejectPrivateConfigRelease = true;
	let rejectAccessRevocation = true;
	const fixture = createFixture(
		async () => { if (rejectPrivateConfigRelease) { throw new Error('untrusted private path detail'); } },
		() => { if (rejectAccessRevocation) { rejectAccessRevocation = false; throw new Error('untrusted access detail'); } },
	);
	let handle: Awaited<ReturnType<typeof fixture.runtime.start>> | undefined;
	try {
		handle = await startRetainingRecoveryHandle(fixture.runtime, fixture.snapshot, fixture.turn.id, value => { handle = value; });
		const accessResult = await fixture.runtime.stop(handle);
		assert.equal(accessResult.cleanupVerified, false);
		assert.deepEqual(accessResult.failureReasons, ['accessRevocationFailed']);
		const privateConfigResult = await fixture.runtime.stop(handle);
		assert.equal(privateConfigResult.cleanupVerified, false);
		assert.deepEqual(privateConfigResult.failureReasons, ['privateConfigReleaseFailed']);
		const entries = fixture.database.agentSessionTranscripts.readPage(fixture.project.id, fixture.session.id, fixture.turn.id).entries;
		assert.ok(entries.some(entry => entry.kind === 'log' && entry.text === 'Session stop could not verify launch access revocation.'));
		assert.ok(entries.some(entry => entry.kind === 'log' && entry.text === 'Session stop could not release private launch configuration.'));
		assert.equal(entries.some(entry => entry.kind === 'log' && entry.text === 'Session turn stopped.'), false);
		assert.equal(entries.some(entry => entry.kind === 'log' && /untrusted (?:private path|access) detail/.test(entry.text)), false);
	} finally {
		rejectAccessRevocation = false;
		rejectPrivateConfigRelease = false;
		await disposeFixture(fixture, handle);
	}
});

test('PTY runtime records the stopped event only after verified host and private-config cleanup', { skip: process.platform === 'win32' && 'Verified PTY process-group cleanup is unavailable on Windows.' }, async () => {
	const fixture = createFixture(async () => { });
	let handle: Awaited<ReturnType<typeof fixture.runtime.start>> | undefined;
	try {
		handle = await startRetainingRecoveryHandle(fixture.runtime, fixture.snapshot, fixture.turn.id, value => { handle = value; });
		const result = await fixture.runtime.stop(handle);
		assert.equal(result.cleanupVerified, true);
		const entries = fixture.database.agentSessionTranscripts.readPage(fixture.project.id, fixture.session.id, fixture.turn.id).entries;
		assert.equal(entries.at(-1)?.text, 'Session turn stopped.');
		assert.equal(entries.some(entry => entry.kind === 'log' && entry.text.includes('Session stop could not')), false);
		await fixture.runtime.release(handle);
		handle = undefined;
	} finally {
		await disposeFixture(fixture, handle);
	}
});
