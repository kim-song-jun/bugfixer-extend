/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type {
	AgentSessionDTO,
	AgentSessionFolderIdentity,
	AgentSessionKnowledgeRef,
	AgentSessionPermissionPolicy,
	AgentSessionTurnDTO,
	AgentSessionTurnSnapshot,
} from '../../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceDatabase, WorkspaceFolderBinding } from '../workspaceDatabase.js';
import { TaskFolderWriterLease, TaskFolderWriterLock, writerLockRootForFolder } from '../providerRuns/taskFolderWriterLock.js';
import type { ManagedWorktreeLease, ManagedWorktreeService } from './managedWorktrees.js';

export interface AcquireAgentSessionWorkspaceInput {
	readonly projectId: string;
	readonly sessionId: string;
	readonly permissionPolicy: AgentSessionPermissionPolicy;
	readonly signal?: AbortSignal;
	/** Host launch admission is held through startup; previews do not reserve it. */
	readonly launch?: true;
}

interface WorkspaceIdentity {
	readonly projectId: string;
	readonly sessionId: string;
	readonly bindingId: string;
	readonly workspaceMode: AgentSessionDTO['workspaceMode'];
	readonly cwd: string;
	readonly folderIdentity: AgentSessionFolderIdentity;
	readonly managedWorktreeOwnerId: string | null;
	readonly permissionPolicy: AgentSessionPermissionPolicy;
	readonly convention: AgentSessionKnowledgeRef | null;
	readonly references: readonly AgentSessionKnowledgeRef[];
}

interface AcquiredState {
	readonly resolver: AgentSessionWorkspaceResolver;
	readonly snapshot: AgentSessionTurnSnapshot;
	readonly identity: WorkspaceIdentity;
	readonly writerLease?: TaskFolderWriterLease;
	readonly onLostListeners: Set<() => void>;
	launchAdmissionRelease?: () => void;
	leaseLossSubscription?: { dispose(): void };
	invalidated: boolean;
	released: boolean;
}

const acquiredStates = new WeakMap<AcquiredAgentSessionWorkspace, AcquiredState>();
const leaseConstructorToken = Symbol('AgentSessionWorkspaceResolver');

function createAcquiredLease(state: AcquiredState): AcquiredAgentSessionWorkspace {
	const lease = new AcquiredAgentSessionWorkspace(leaseConstructorToken);
	acquiredStates.set(lease, state);
	return lease;
}

/** Opaque process-local capability returned only by AgentSessionWorkspaceResolver.acquire. */
export class AcquiredAgentSessionWorkspace {
	constructor(token: symbol) {
		if (token !== leaseConstructorToken) { throw new Error('Session workspace leases can only be issued by the trusted resolver.'); }
	}

	get snapshot(): AgentSessionTurnSnapshot {
		const state = acquiredStates.get(this);
		if (!state || state.released || state.invalidated) { throw new Error('The session workspace lease is unavailable or its writer lock was lost.'); }
		return state.snapshot;
	}

	get identity(): WorkspaceIdentity {
		const state = acquiredStates.get(this);
		if (!state || state.released || state.invalidated) { throw new Error('The session workspace lease is unavailable or its writer lock was lost.'); }
		return state.identity;
	}

	onLost(callback: () => void): { dispose(): void } {
		const state = acquiredStates.get(this);
		if (!state || state.released) { throw new Error('The session workspace lease is unavailable.'); }
		if (state.invalidated) {
			callback();
			return { dispose() { } };
		}
		state.onLostListeners.add(callback);
		return { dispose: () => state.onLostListeners.delete(callback) };
	}
}

/** Resolves trusted launch workspace state from persisted session and folder records. */
export class AgentSessionWorkspaceResolver {
	private readonly readOnlyLaunchAdmissions = new Map<string, Promise<void>>();

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly worktrees: ManagedWorktreeService,
		private readonly writerLock: TaskFolderWriterLock,
		private readonly recoveryReady: () => boolean,
		private readonly ownsRunningReadOnlyTurn?: (turn: AgentSessionTurnDTO) => boolean,
	) { }

	async acquire(input: AcquireAgentSessionWorkspaceInput): Promise<AcquiredAgentSessionWorkspace> {
		this.assertRecoveryReady();
		const permissionPolicy = this.validatePermissionPolicy(input.permissionPolicy);
		const session = this.requireSession(input.projectId, input.sessionId);
		const binding = this.requireBinding(session);
		let writerLease: TaskFolderWriterLease | undefined;
		let launchAdmissionRelease: (() => void) | undefined;
		let launchSession = session;
		try {
			let identity = await this.resolveIdentity(session, binding, permissionPolicy);
			if (input.launch && permissionPolicy.mode === 'read-only') {
				launchAdmissionRelease = await this.acquireReadOnlyLaunch(identity.folderIdentity, input.signal);
				this.assertRecoveryReady();
			}
			if (session.workspaceMode === 'sharedFolder' && permissionPolicy.mode === 'mutating') {
				const identityBeforeWaiting = identity;
				writerLease = await this.writerLock.acquire(writerLockRootForFolder(binding, identity.folderIdentity.canonicalPath), input.signal);
				const currentSession = this.requireSession(input.projectId, input.sessionId);
				if (currentSession.bindingId !== session.bindingId || currentSession.workspaceMode !== session.workspaceMode
					|| currentSession.provider !== session.provider || currentSession.model !== session.model || currentSession.profileRef !== session.profileRef
					|| currentSession.taskId !== session.taskId || currentSession.revision !== session.revision) {
					throw new Error('The persisted session assignment changed while waiting for the shared-folder writer lock.');
				}
				const currentBinding = this.requireBinding(currentSession);
				identity = await this.resolveIdentity(currentSession, currentBinding, permissionPolicy);
				if (!this.sameIdentity(identityBeforeWaiting, identity)) {
					throw new Error('The shared workspace identity changed while waiting for the writer lock.');
				}
				this.assertMutationGrant(currentSession, currentBinding, identity.folderIdentity);
				launchSession = currentSession;
			}
			if (!writerLease) {
				const currentSession = this.requireSession(input.projectId, input.sessionId);
				if (currentSession.revision !== session.revision || currentSession.bindingId !== session.bindingId
					|| currentSession.workspaceMode !== session.workspaceMode || currentSession.provider !== session.provider
					|| currentSession.model !== session.model || currentSession.profileRef !== session.profileRef || currentSession.taskId !== session.taskId) {
					throw new Error('The persisted session assignment changed while resolving its workspace.');
				}
				const currentBinding = this.requireBinding(currentSession);
				const currentIdentity = await this.resolveIdentity(currentSession, currentBinding, permissionPolicy);
				if (!this.sameIdentity(identity, currentIdentity)) { throw new Error('The workspace identity changed while resolving the session.'); }
				launchSession = currentSession;
				identity = currentIdentity;
			}
			this.assertNoUnresolvedCleanup(launchSession, identity, permissionPolicy);
			const snapshot = this.snapshot(launchSession, identity);
			const state: AcquiredState = { resolver: this, snapshot, identity, writerLease, launchAdmissionRelease, onLostListeners: new Set(), invalidated: false, released: false };
			const lease = createAcquiredLease(state);
			if (writerLease) {
				state.leaseLossSubscription = writerLease.onLost(() => {
					if (state.released || state.invalidated) { return; }
					state.invalidated = true;
					for (const listener of [...state.onLostListeners]) { listener(); }
				});
			}
			if (state.invalidated) {
				state.leaseLossSubscription?.dispose();
				throw new Error('The shared-folder writer lock was lost during workspace acquisition.');
			}
			return lease;
		} catch (error) {
			writerLease?.release();
			launchAdmissionRelease?.();
			throw error;
		}
	}

	async revalidate(lease: AcquiredAgentSessionWorkspace, expectedStartingTurnId?: string): Promise<AgentSessionTurnSnapshot> {
		this.assertRecoveryReady();
		const state = acquiredStates.get(lease);
		if (!state || state.resolver !== this || state.released || state.invalidated) { throw new Error('The session workspace lease is unavailable or its writer lock was lost.'); }
		const { snapshot, identity } = state;
		const session = this.requireSession(identity.projectId, identity.sessionId);
		if (session.bindingId !== identity.bindingId || session.workspaceMode !== identity.workspaceMode
			|| session.provider !== snapshot.provider || session.model !== snapshot.model || session.profileRef !== snapshot.profileRef
			|| session.taskId !== snapshot.taskId) {
			throw new Error('The persisted session workspace assignment changed after acquisition.');
		}
		if (expectedStartingTurnId) {
			const turn = this.database.agentSessionTurns.getTurn(session.projectId, session.id, expectedStartingTurnId);
			if (!turn || turn.state !== 'starting' || session.state !== 'starting'
				|| session.revision !== snapshot.sessionRevision + 1 || JSON.stringify(turn.snapshot) !== JSON.stringify(snapshot)) {
				throw new Error('Only the exact host-created starting turn may revalidate this workspace lease.');
			}
		} else if (session.revision !== snapshot.sessionRevision) {
			throw new Error('The persisted session revision changed after workspace acquisition.');
		}
		const binding = this.requireBinding(session);
		const current = await this.resolveIdentity(session, binding, snapshot.permissionPolicy);
		if (state.invalidated) { throw new Error('The shared-folder writer lock was lost during workspace revalidation.'); }
		if (!this.sameIdentity(identity, current)) { throw new Error('The acquired workspace folder identity changed.'); }
		if (snapshot.permissionPolicy.mode === 'mutating' && session.workspaceMode === 'sharedFolder') {
			this.assertMutationGrant(session, binding, current.folderIdentity);
		}
		this.assertNoUnresolvedCleanup(session, current, snapshot.permissionPolicy, expectedStartingTurnId ? { id: expectedStartingTurnId, snapshot } : undefined);
		return snapshot;
	}

	/** Ends startup admission without releasing the turn's workspace or writer ownership. */
	finishLaunch(lease: AcquiredAgentSessionWorkspace): void {
		const state = acquiredStates.get(lease);
		if (!state || state.resolver !== this) { return; }
		const release = state.launchAdmissionRelease;
		state.launchAdmissionRelease = undefined;
		release?.();
	}

	release(lease: AcquiredAgentSessionWorkspace): void {
		const state = acquiredStates.get(lease);
		if (!state || state.resolver !== this || state.released) { return; }
		state.released = true;
		state.leaseLossSubscription?.dispose();
		state.leaseLossSubscription = undefined;
		state.onLostListeners.clear();
		state.writerLease?.release();
		this.finishLaunch(lease);
	}

	private async acquireReadOnlyLaunch(identity: AgentSessionFolderIdentity, signal?: AbortSignal): Promise<() => void> {
		const key = JSON.stringify([identity.dev, identity.ino]);
		for (;;) {
			if (signal?.aborted) { throw new Error('The read-only session launch admission was cancelled.'); }
			const active = this.readOnlyLaunchAdmissions.get(key);
			if (!active) { break; }
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					signal?.removeEventListener('abort', onAbort);
					reject(new Error('The read-only session launch admission was cancelled.'));
				};
				signal?.addEventListener('abort', onAbort, { once: true });
				active.then(() => {
					signal?.removeEventListener('abort', onAbort);
					resolve();
				});
			});
		}
		let finish!: () => void;
		const active = new Promise<void>(resolve => { finish = resolve; });
		this.readOnlyLaunchAdmissions.set(key, active);
		let released = false;
		return () => {
			if (released) { return; }
			released = true;
			this.readOnlyLaunchAdmissions.delete(key);
			finish();
		};
	}

	private requireSession(projectId: string, sessionId: string): AgentSessionDTO {
		const session = this.database.agentSessions.getSession(projectId, sessionId);
		if (!session) { throw new Error('The agent session does not belong to the requested project.'); }
		return session;
	}

	private requireBinding(session: AgentSessionDTO): WorkspaceFolderBinding {
		const binding = this.database.listFolderBindings(session.projectId).find(candidate => candidate.id === session.bindingId);
		if (!binding || binding.projectId !== session.projectId) { throw new Error('The persisted session folder binding is unavailable.'); }
		if (session.taskId) {
			const task = this.database.getTask(session.taskId);
			if (!task || task.projectId !== session.projectId || task.bindingId !== binding.id) {
				throw new Error('The persisted session task does not match its project folder binding.');
			}
			if (task.archivedAt || task.trashedAt || task.deletionPendingAt) {
				throw new Error('Archived, trashed, or deletion-pending tasks cannot launch agent sessions.');
			}
		}
		return binding;
	}

	private async resolveIdentity(
		session: AgentSessionDTO,
		binding: WorkspaceFolderBinding,
		permissionPolicy: AgentSessionPermissionPolicy,
	): Promise<WorkspaceIdentity> {
		if (session.workspaceMode === 'gitWorktree') {
			if (binding.vcsKind !== 'git' || !binding.vcsRoot) { throw new Error('A Git session worktree requires a persisted Git repository binding.'); }
			const repositoryPath = canonicalDirectory(binding.vcsRoot, 'The bound Git repository');
			const worktree = await this.worktrees.inspect(session.id);
			this.assertWorktree(session, repositoryPath, worktree);
			const cwd = canonicalDirectory(worktree.worktreePath, 'The session worktree');
			if (cwd !== worktree.worktreePath) { throw new Error('The inspected session worktree path changed during resolution.'); }
			return this.createIdentity(session, cwd, session.id, permissionPolicy, directoryIdentity(cwd));
		}

		if (binding.vcsKind !== null) { throw new Error('A shared-folder session requires an ordinary folder binding.'); }
		const cwd = canonicalDirectory(binding.path, 'The bound shared folder');
		const folderIdentity = directoryIdentity(cwd);
		if (permissionPolicy.mode === 'mutating') { this.assertMutationGrant(session, binding, folderIdentity); }
		return this.createIdentity(session, cwd, null, permissionPolicy, folderIdentity);
	}

	private createIdentity(
		session: AgentSessionDTO,
		cwd: string,
		managedWorktreeOwnerId: string | null,
		permissionPolicy: AgentSessionPermissionPolicy,
		folderIdentity: AgentSessionFolderIdentity,
	): WorkspaceIdentity {
		const convention = this.database.knowledge.activeConvention(session.projectId);
		const references = session.taskId
			? this.database.knowledge.listTaskReferences(session.taskId)
			: this.database.knowledge.listProjectReferences(session.projectId);
		if (references.length > 100) { throw new Error('The session workspace has more reference snapshots than a turn can safely record.'); }
		return Object.freeze({
			projectId: session.projectId, sessionId: session.id, bindingId: session.bindingId,
			workspaceMode: session.workspaceMode, cwd, folderIdentity, managedWorktreeOwnerId,
			permissionPolicy: Object.freeze({ mode: permissionPolicy.mode, approval: permissionPolicy.approval }),
			convention: convention ? Object.freeze({ id: convention.id, version: convention.version, sha256: createHash('sha256').update(convention.markdown).digest('hex') }) : null,
			references: Object.freeze(references.map(reference => Object.freeze({ id: reference.id, version: reference.version, sha256: reference.contentSha256 }))),
		});
	}

	private snapshot(session: AgentSessionDTO, identity: WorkspaceIdentity): AgentSessionTurnSnapshot {
		return Object.freeze({
			schemaVersion: 1, projectId: session.projectId, sessionId: session.id, sessionRevision: session.revision,
			bindingId: session.bindingId, taskId: session.taskId, provider: session.provider, model: session.model,
			profileRef: session.profileRef, cwd: identity.cwd, folderIdentity: identity.folderIdentity,
			managedWorktreeOwnerId: identity.managedWorktreeOwnerId, permissionPolicy: identity.permissionPolicy,
			convention: identity.convention, references: identity.references,
		});
	}

	private assertWorktree(session: AgentSessionDTO, repositoryPath: string, lease: ManagedWorktreeLease): void {
		if (lease.ownerId !== session.id || lease.kind !== 'session' || lease.state !== 'active') {
			throw new Error('The inspected managed worktree must be active and owned by this session.');
		}
		const leaseRepository = canonicalDirectory(lease.repositoryPath, 'The inspected worktree repository');
		if (leaseRepository !== repositoryPath) { throw new Error('The inspected session worktree repository does not match its persisted project binding.'); }
		const expectedWorktree = canonicalDirectory(lease.worktreePath, 'The inspected session worktree');
		if (expectedWorktree !== lease.worktreePath) { throw new Error('The inspected session worktree is not at its canonical owned path.'); }
	}

	private assertMutationGrant(session: AgentSessionDTO, binding: WorkspaceFolderBinding, identity: AgentSessionFolderIdentity): void {
		if (binding.vcsKind !== null || !this.database.isOrdinaryFolderMutationEnabled(
			session.projectId, binding.id, identity.canonicalPath, identity.dev, identity.ino,
		)) {
			throw new Error('Mutating a shared project folder requires its current ordinary-folder permission grant.');
		}
	}

	private assertNoUnresolvedCleanup(
		session: AgentSessionDTO,
		identity: WorkspaceIdentity,
		permissionPolicy: AgentSessionPermissionPolicy,
		allowedStartingTurn?: { readonly id: string; readonly snapshot: AgentSessionTurnSnapshot },
	): void {
		for (const project of this.database.listProjects()) {
			for (const candidate of this.database.agentSessions.listSessions(project.id)) {
				for (const turn of this.database.agentSessionTurns.listTurns(candidate.projectId, candidate.id)) {
					if (candidate.id === session.id && turn.id === allowedStartingTurn?.id && turn.state === 'starting'
						&& turn.cleanupVerified === false && JSON.stringify(turn.snapshot) === JSON.stringify(allowedStartingTurn.snapshot)) { continue; }
					const unresolved = turn.state === 'starting' || turn.state === 'running' || turn.state === 'stopping' || !turn.cleanupVerified;
					if (unresolved && (candidate.id === session.id || this.samePhysicalFolder(identity.folderIdentity, turn.snapshot.folderIdentity))) {
						if (permissionPolicy.mode === 'read-only' && turn.state === 'running' && turn.snapshot.permissionPolicy.mode === 'read-only'
							&& candidate.projectId === session.projectId && candidate.id !== session.id && this.ownsRunningReadOnlyTurn?.(turn) === true) { continue; }
						throw new Error('A session or matching launch folder has unresolved host-owned process cleanup; recovery is required before launch.');
					}
				}
			}
		}
	}

	private assertRecoveryReady(): void {
		if (!this.recoveryReady()) { throw new Error('Agent session startup recovery has not completed; launch is blocked.'); }
	}

	private sameIdentity(expected: WorkspaceIdentity, current: WorkspaceIdentity): boolean {
		return expected.projectId === current.projectId && expected.sessionId === current.sessionId
			&& expected.bindingId === current.bindingId && expected.workspaceMode === current.workspaceMode
			&& expected.cwd === current.cwd && expected.managedWorktreeOwnerId === current.managedWorktreeOwnerId
			&& expected.folderIdentity.canonicalPath === current.folderIdentity.canonicalPath
			&& expected.folderIdentity.dev === current.folderIdentity.dev && expected.folderIdentity.ino === current.folderIdentity.ino
			&& expected.permissionPolicy.mode === current.permissionPolicy.mode && expected.permissionPolicy.approval === current.permissionPolicy.approval
			&& JSON.stringify(expected.convention) === JSON.stringify(current.convention)
			&& JSON.stringify(expected.references) === JSON.stringify(current.references);
	}

	private samePhysicalFolder(left: AgentSessionFolderIdentity, right: AgentSessionFolderIdentity): boolean {
		return left.dev === right.dev && left.ino === right.ino;
	}

	private validatePermissionPolicy(policy: AgentSessionPermissionPolicy): AgentSessionPermissionPolicy {
		if (!policy || !(policy.mode === 'read-only' && policy.approval === 'never')
			&& !(policy.mode === 'mutating' && policy.approval === 'on-request')) {
			throw new Error('The trusted host permission policy is invalid.');
		}
		return Object.freeze({ mode: policy.mode, approval: policy.approval });
	}
}

function canonicalDirectory(path: string, label: string): string {
	const canonical = realpathSync(path);
	if (!isAbsolute(canonical) || !statSync(canonical).isDirectory()) {
		throw new Error(`${label} is not a canonical directory.`);
	}
	return canonical;
}

function directoryIdentity(canonicalPath: string): AgentSessionFolderIdentity {
	const stats = statSync(canonicalPath, { bigint: true });
	if (!stats.isDirectory()) { throw new Error('The session workspace is not a directory.'); }
	return Object.freeze({ canonicalPath, dev: stats.dev.toString(), ino: stats.ino.toString() });
}
