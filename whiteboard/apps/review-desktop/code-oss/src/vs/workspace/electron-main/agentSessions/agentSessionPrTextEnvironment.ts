/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { accessSync, constants, lstatSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { AgentSessionDTO, AgentSessionTurnDTO } from '../../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';
import type { AgentSessionPrTextEnvironment, AgentSessionPrTextResolver } from './agentSessionPrTextApplication.js';
import type { AgentSessionRuntimePaths } from './agentSessionApplication.js';

export interface AgentSessionPrTextEnvironmentOptions {
	readonly database: WorkspaceDatabase;
	readonly resourcesPath: string;
	readonly homeDirectory: () => string;
	readonly runtimePaths: () => AgentSessionRuntimePaths;
	readonly normalizeProfileRef: (provider: AgentSessionDTO['provider'], profileRef: string | undefined) => string;
	readonly resolveExecutable: (provider: AgentSessionDTO['provider'], home: string) => string;
	readonly buildLaunchEnvironment: (provider: AgentSessionDTO['provider'], profileDirectory: string, nodeDirectory: string, cliDirectory: string) => Record<string, string>;
	readonly verifyWorkspace: (session: AgentSessionDTO, turn: AgentSessionTurnDTO) => Promise<void>;
}

/** Binds a PR text run to one stored, completed turn and the host's selected local CLI profile. */
export function createAgentSessionPrTextResolver(options: AgentSessionPrTextEnvironmentOptions): AgentSessionPrTextResolver {
	return {
		async resolve(session, targetTurn): Promise<AgentSessionPrTextEnvironment> {
			const currentSession = options.database.agentSessions.getSession(session.projectId, session.id);
			const currentTurn = options.database.agentSessionTurns.getTurn(session.projectId, session.id, targetTurn.id);
			if (!currentSession || !sameSession(currentSession, session) || !currentTurn || !sameTurn(currentTurn, targetTurn)
				|| currentTurn.state !== 'exited' || currentTurn.cleanupVerified !== true) {
				throw new Error('The selected completed turn or its session changed.');
			}
			if (session.taskId !== targetTurn.snapshot.taskId
				|| targetTurn.snapshot.projectId !== session.projectId || targetTurn.snapshot.sessionId !== session.id
				|| targetTurn.snapshot.bindingId !== session.bindingId) {
				throw new Error('The selected session does not match the completed turn settings.');
			}
			await options.verifyWorkspace(currentSession, currentTurn);
			const home = options.homeDirectory();
			const profileRef = options.normalizeProfileRef(session.provider, session.profileRef ?? undefined);
			if (profileRef !== session.profileRef) { throw new Error('The saved provider profile is not normalized.'); }
			const profileDirectory = join(home, session.provider === 'codex' ? '.codex' : '.claude');
			assertCanonicalDirectory(profileDirectory, 'The selected provider profile');
			const selectedProfileIdentity = statSync(profileDirectory, { bigint: true });
			const executable = options.resolveExecutable(session.provider, home);
			assertCanonicalExecutable(executable, 'The selected provider CLI');
			const paths = options.runtimePaths();
			assertCanonicalExecutable(paths.standaloneNode, 'The packaged Node runtime');
			const helperScript = join(options.resourcesPath, 'app', 'review-runtime', 'bin', 'provider-group-control.mjs');
			assertCanonicalReadableFile(helperScript, 'The packaged provider process helper');
			const cwd = targetTurn.snapshot.cwd;
			assertSelectedFolder(targetTurn);
			options.buildLaunchEnvironment(session.provider, profileDirectory, dirname(paths.standaloneNode), dirname(executable));
			const providerId = session.provider;
			const model = session.model;
			const expectedTurn = currentTurn;
			const preflight: AgentSessionPrTextEnvironment['preflight'] = async request => {
				try {
					const latestSession = options.database.agentSessions.getSession(session.projectId, session.id);
					const latestTurn = options.database.agentSessionTurns.getTurn(session.projectId, session.id, targetTurn.id);
					if (!latestSession || !sameSession(latestSession, currentSession) || !latestTurn || !sameTurn(latestTurn, expectedTurn)
						|| latestTurn.state !== 'exited' || latestTurn.cleanupVerified !== true) {
						return { allowed: false, reason: 'The selected session or completed turn changed before launch.' };
					}
					if (request.providerId !== providerId || request.model !== model || request.profileDirectory !== profileDirectory) {
						return { allowed: false, reason: 'The selected provider, model, or local profile changed before launch.' };
					}
					if (request.permissionPolicy.mode !== 'read-only' || request.permissionPolicy.approval !== 'never') {
						return { allowed: false, reason: 'The provider run permission mode changed before launch.' };
					}
					assertPrivateExecutionDirectory(request.cwd);
					await options.verifyWorkspace(latestSession, latestTurn);
					assertSelectedFolder(latestTurn);
					assertCanonicalDirectory(profileDirectory, 'The selected provider profile');
					const latestProfileIdentity = statSync(profileDirectory, { bigint: true });
					if (latestProfileIdentity.dev !== selectedProfileIdentity.dev || latestProfileIdentity.ino !== selectedProfileIdentity.ino) {
						return { allowed: false, reason: 'The selected local provider profile folder changed before launch.' };
					}
					if (options.normalizeProfileRef(providerId, latestSession.profileRef ?? undefined) !== profileRef
						|| options.resolveExecutable(providerId, home) !== executable) {
						return { allowed: false, reason: 'The selected provider profile or executable changed before launch.' };
					}
					const latestPaths = options.runtimePaths();
					const latestHelperScript = join(options.resourcesPath, 'app', 'review-runtime', 'bin', 'provider-group-control.mjs');
					if (latestPaths.standaloneNode !== paths.standaloneNode || latestHelperScript !== helperScript) {
						return { allowed: false, reason: 'The trusted provider runtime changed before launch.' };
					}
					assertCanonicalExecutable(executable, 'The selected provider CLI');
					assertCanonicalExecutable(latestPaths.standaloneNode, 'The packaged Node runtime');
					assertCanonicalReadableFile(latestHelperScript, 'The packaged provider process helper');
					options.buildLaunchEnvironment(providerId, profileDirectory, dirname(latestPaths.standaloneNode), dirname(executable));
					return { allowed: true, cwdIdentity: `${request.cwd}:${latestTurn.snapshot.folderIdentity.canonicalPath}:${latestTurn.snapshot.folderIdentity.dev}:${latestTurn.snapshot.folderIdentity.ino}`, policyProof: 'read-only provider run from private control cwd; selected source root may be read and existing CLI policy and local profile apply' };
				} catch (error) {
					return { allowed: false, reason: `The selected turn scope could not be revalidated: ${error instanceof Error ? error.message : String(error)}` };
				}
			};
			return {
				providerId, model, profileRef, sourceCwd: cwd, profileDirectory, executable,
				processControl: { nodeExecutable: paths.standaloneNode, helperScript },
				knownSecrets: [], preflight,
			};
		},
	};
}

/** Removes only the recorded socket and an empty, private runner directory. */
export function removePrTextControlDirectoryIfPresent(socketPath: string): void {
	const directory = validatePrTextControlPath(socketPath);
	removePrTextControlSocketIfPresent(socketPath, directory);
	try { rmdirSync(directory); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
}

/** Removes the exact recorded socket after the supervisor has proved its process group is gone. */
export function removePrTextControlSocketIfPresent(socketPath: string): void {
	removePrTextControlSocketIfPresent(socketPath, validatePrTextControlPath(socketPath));
}

function validatePrTextControlPath(socketPath: string): string {
	const directory = dirname(socketPath);
	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
	const temporaryRoot = realpathSync('/tmp');
	if (uid === undefined || !isAbsolute(socketPath) || !socketPath.startsWith('/tmp/bfx-prt-') || basename(socketPath) !== 'c.sock') {
		throw new Error('The recorded PR text control path is outside the private runner namespace.');
	}
	try {
		const directoryInfo = lstatSync(directory);
		const canonicalDirectory = realpathSync(directory);
		if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid !== uid
			|| (directoryInfo.mode & 0o777) !== 0o700 || dirname(canonicalDirectory) !== temporaryRoot
			|| basename(canonicalDirectory) !== basename(directory) || !basename(directory).startsWith('bfx-prt-')) {
			throw new Error('The recorded PR text control directory is not private and canonical.');
		}
		return directory;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return directory; }
		throw error;
	}
}

function removePrTextControlSocketIfPresent(socketPath: string, directory: string): void {
	try {
		const socketInfo = lstatSync(socketPath);
		const uid = process.getuid!();
		if (!socketInfo.isSocket() || socketInfo.isSymbolicLink() || socketInfo.uid !== uid || (socketInfo.mode & 0o777) !== 0o600) {
			throw new Error('The recorded PR text control socket has unsafe ownership or permissions.');
		}
		unlinkSync(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
	}
	if (dirname(socketPath) !== directory) { throw new Error('The recorded PR text control socket changed paths.'); }
}

function assertPrivateExecutionDirectory(path: string): void {
	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
	if (uid === undefined || !path.startsWith('/tmp/bfx-prt-')) { throw new Error('The provider execution cwd is not a private runner directory.'); }
	const info = lstatSync(path);
	const canonicalTemporaryRoot = realpathSync('/tmp');
	const canonicalPath = realpathSync(path);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o700
		|| basename(path) !== basename(canonicalPath) || !basename(path).startsWith('bfx-prt-') || dirname(canonicalPath) !== canonicalTemporaryRoot) {
		throw new Error('The provider execution cwd is not canonical and private.');
	}
}

function assertSelectedFolder(turn: AgentSessionTurnDTO): void {
	const snapshot = turn.snapshot;
	if (realpathSync(snapshot.cwd) !== snapshot.cwd) { throw new Error('The selected turn working folder is not canonical.'); }
	const cwdInfo = lstatSync(snapshot.cwd);
	const rootInfo = lstatSync(snapshot.folderIdentity.canonicalPath, { bigint: true });
	const cwdStats = statSync(snapshot.cwd, { bigint: true });
	if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink() || !cwdStats.isDirectory()
		|| realpathSync(snapshot.folderIdentity.canonicalPath) !== snapshot.folderIdentity.canonicalPath
		|| !rootInfo.isDirectory() || rootInfo.isSymbolicLink()
		|| rootInfo.dev.toString() !== snapshot.folderIdentity.dev || rootInfo.ino.toString() !== snapshot.folderIdentity.ino) {
		throw new Error('The selected turn folder no longer matches its stored device and inode identity.');
	}
	const cwdRelativeToRoot = relative(snapshot.folderIdentity.canonicalPath, snapshot.cwd);
	if (snapshot.managedWorktreeOwnerId !== null ? snapshot.cwd !== snapshot.folderIdentity.canonicalPath
		: cwdRelativeToRoot === '..' || cwdRelativeToRoot.startsWith(`..${sep}`) || isAbsolute(cwdRelativeToRoot)) {
		throw new Error('The selected turn working folder is outside its stored folder identity.');
	}
}

function assertCanonicalDirectory(path: string, label: string): void {
	try {
		const info = lstatSync(path);
		if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) { throw new Error(); }
		accessSync(path, constants.R_OK | constants.X_OK);
	} catch { throw new Error(`${label} is unavailable at its expected canonical directory.`); }
}

function assertCanonicalExecutable(path: string, label: string): void {
	try {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile() || realpathSync(path) !== path) { throw new Error(); }
		accessSync(path, constants.X_OK);
	} catch { throw new Error(`${label} is unavailable at its expected canonical executable path.`); }
}

function assertCanonicalReadableFile(path: string, label: string): void {
	try {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile() || realpathSync(path) !== path) { throw new Error(); }
		accessSync(path, constants.R_OK);
	} catch { throw new Error(`${label} is unavailable at its expected canonical path.`); }
}

function sameSession(left: AgentSessionDTO, right: AgentSessionDTO): boolean {
	return left.projectId === right.projectId && left.id === right.id && left.bindingId === right.bindingId
		&& left.taskId === right.taskId && left.provider === right.provider && left.model === right.model && left.profileRef === right.profileRef
		&& left.workspaceMode === right.workspaceMode;
}

function sameTurn(left: AgentSessionTurnDTO, right: AgentSessionTurnDTO): boolean {
	return left.id === right.id && left.projectId === right.projectId && left.sessionId === right.sessionId
		&& left.snapshotSha256 === right.snapshotSha256 && left.snapshot.sessionRevision === right.snapshot.sessionRevision
		&& left.snapshot.bindingId === right.snapshot.bindingId && left.snapshot.taskId === right.snapshot.taskId
		&& left.snapshot.managedWorktreeOwnerId === right.snapshot.managedWorktreeOwnerId && left.snapshot.cwd === right.snapshot.cwd
		&& left.snapshot.folderIdentity.canonicalPath === right.snapshot.folderIdentity.canonicalPath
		&& left.snapshot.folderIdentity.dev === right.snapshot.folderIdentity.dev && left.snapshot.folderIdentity.ino === right.snapshot.folderIdentity.ino
		&& left.snapshot.provider === right.snapshot.provider && left.snapshot.model === right.snapshot.model && left.snapshot.profileRef === right.snapshot.profileRef;
}
