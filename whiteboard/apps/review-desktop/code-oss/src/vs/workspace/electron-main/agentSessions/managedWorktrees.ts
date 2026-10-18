/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ManagedWorktreeLease {
	readonly ownerId: string;
	readonly kind: 'session' | 'integration';
	readonly repositoryPath: string;
	readonly commonDirectory: string;
	readonly branch: string;
	readonly worktreePath: string;
	readonly baseCommit: string;
	readonly head: string;
	readonly state: 'active' | 'conflict' | 'recoveryRequired' | 'removed';
	readonly pendingOperation?: PendingOperation;
	readonly lastOperation?: OperationReceipt;
}

interface PendingOperation {
	readonly id: string;
	readonly kind: 'merge' | 'remove';
	readonly startedAt: number;
	readonly sourceOwnerId?: string;
	readonly sourceHead?: string;
	readonly targetHead?: string;
	readonly expectedHead?: string;
	readonly retainedIntegrationOwnerId?: string;
}

interface OperationReceipt {
	readonly id: string;
	readonly kind: 'merge' | 'remove';
	readonly outcome: 'merged' | 'conflict' | 'notApplied' | 'removed';
	readonly commit?: string;
	readonly reconciled?: boolean;
}

export interface MergePreview {
	readonly previewId: string;
	readonly integrationOwnerId: string;
	readonly sessionOwnerId: string;
	readonly sourceHead: string;
	readonly targetHead: string;
	readonly diffHash: string;
	readonly expiresAt: number;
}

export type ReviewedMergeResult =
	| { readonly state: 'merged'; readonly commit: string; readonly integration: ManagedWorktreeLease }
	| { readonly state: 'conflict'; readonly integration: ManagedWorktreeLease; readonly conflictedPaths: readonly string[] };

interface LeaseManifest extends ManagedWorktreeLease { readonly version: 1; readonly signature: string; }
interface LeaseManifestPayload extends ManagedWorktreeLease { readonly version: 1; }
interface OperationLock { readonly ownerId: string; readonly operation: 'merge' | 'remove'; readonly operationId: string; readonly pid: number; readonly processStart: string; readonly signature: string; }

/** App-profile-owned Git worktrees. A merge preview is an exact, expiring snapshot, not approval. */
export class ManagedWorktreeService {
	private readonly root: string;
	private readonly previews = new Map<string, MergePreview>();
	private readonly keyPath: string;
	private readonly manifestKey: Buffer;

	constructor(profileDirectory: string) {
		mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
		this.root = join(realpathSync(profileDirectory), 'managed-worktrees');
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		this.keyPath = join(this.root, '.manifest-key');
		if (!existsSync(this.keyPath)) {
			const fd = openSync(this.keyPath, 'wx', 0o600);
			try { writeFileSync(fd, randomUUID() + randomUUID()); fsyncSync(fd); } finally { closeSync(fd); }
			const rootFd = openSync(this.root, 'r');
			try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
		}
		this.manifestKey = readFileSync(this.keyPath);
		if (this.manifestKey.length < 64 || (statSync(this.keyPath).mode & 0o077) !== 0) {
			throw new Error('Managed worktree manifest key is unavailable or has unsafe permissions.');
		}
	}

	async create(input: { repositoryPath: string; ownerId: string; kind: 'session' | 'integration'; baseRef: string }): Promise<ManagedWorktreeLease> {
		this.validateOwnerId(input.ownerId);
		if (input.kind !== 'session' && input.kind !== 'integration') { throw new Error('Unsupported managed worktree kind.'); }
		const repositoryPath = realpathSync(input.repositoryPath);
		if (!statSync(repositoryPath).isDirectory()) { throw new Error('Repository path must be a directory.'); }
		const gitRoot = await this.git(repositoryPath, ['rev-parse', '--show-toplevel']);
		if (realpathSync(gitRoot) !== repositoryPath) { throw new Error('Repository path must identify the Git checkout root.'); }
		const commonValue = await this.git(repositoryPath, ['rev-parse', '--git-common-dir']);
		const commonDirectory = realpathSync(isAbsolute(commonValue) ? commonValue : resolve(repositoryPath, commonValue));
		const baseCommit = await this.git(repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${input.baseRef}^{commit}`]);
		const branch = `bugfixer/${input.kind}/${input.ownerId}`;
		const worktreePath = join(this.root, input.kind, input.ownerId);
		if (existsSync(this.manifestPath(input.ownerId)) || existsSync(worktreePath)) { throw new Error('Managed worktree owner ID is already in use.'); }
		if (await this.git(repositoryPath, ['branch', '--list', branch])) { throw new Error('Managed worktree branch already exists; refusing to claim it.'); }
		mkdirSync(dirname(worktreePath), { recursive: true, mode: 0o700 });
		this.writeLease({ ownerId: input.ownerId, kind: input.kind, repositoryPath, commonDirectory, branch, worktreePath, baseCommit, head: baseCommit, state: 'recoveryRequired' });
		try {
			await this.git(repositoryPath, ['worktree', 'add', '-b', branch, worktreePath, baseCommit], true);
			const actualRoot = realpathSync(await this.git(worktreePath, ['rev-parse', '--show-toplevel']));
			const actualCommonValue = await this.git(worktreePath, ['rev-parse', '--git-common-dir']);
			const actualCommon = realpathSync(isAbsolute(actualCommonValue) ? actualCommonValue : resolve(worktreePath, actualCommonValue));
			if (actualRoot !== worktreePath || actualCommon !== commonDirectory) { throw new Error('Git created a worktree with an unexpected identity.'); }
			return this.writeLease({ ownerId: input.ownerId, kind: input.kind, repositoryPath, commonDirectory, branch, worktreePath, baseCommit, head: baseCommit, state: 'active' });
		} catch (error) {
			// Keep any partially created worktree/ref for explicit recovery; never force-remove it.
			throw new Error(`Managed worktree creation requires recovery: ${this.errorMessage(error)}`);
		}
	}

	async inspect(ownerId: string): Promise<ManagedWorktreeLease> {
		const lease = await this.readAndValidate(ownerId);
		return lease.pendingOperation ? this.reconcilePendingOperation(lease) : lease;
	}

	/** Inspects an existing session lease without reconciling or repairing it. */
	async inspectOptional(ownerId: string, repositoryPath: string): Promise<ManagedWorktreeLease | undefined> {
		this.validateOwnerId(ownerId);
		if (existsSync(this.manifestPath(ownerId))) {
			const lease = await this.readAndValidate(ownerId);
			return lease.pendingOperation ? { ...lease, state: 'recoveryRequired' } : lease;
		}
		const canonicalRepository = realpathSync(repositoryPath);
		if (realpathSync(await this.git(canonicalRepository, ['rev-parse', '--show-toplevel'])) !== canonicalRepository) {
			throw new Error('The bound repository path is not its Git checkout root.');
		}
		const expectedPath = join(this.root, 'session', ownerId);
		const expectedBranch = `bugfixer/session/${ownerId}`;
		if (existsSync(expectedPath)) { throw new Error(`An unmanifested session worktree is retained at ${expectedPath}; explicit recovery is required.`); }
		if (await this.git(canonicalRepository, ['branch', '--list', expectedBranch])) {
			throw new Error(`The session branch ${expectedBranch} exists without its signed worktree manifest; explicit recovery is required.`);
		}
		const registrations = await this.git(canonicalRepository, ['worktree', 'list', '--porcelain']);
		if (registrations.includes(`worktree ${expectedPath}\n`)) {
			throw new Error(`Git still registers ${expectedPath} without its signed worktree manifest; explicit recovery is required.`);
		}
		return undefined;
	}

	expectedLocation(ownerId: string, kind: 'session' | 'integration'): { readonly worktreePath: string; readonly branch: string } {
		this.validateOwnerId(ownerId);
		return Object.freeze({ worktreePath: join(this.root, kind, ownerId), branch: `bugfixer/${kind}/${ownerId}` });
	}

	async previewMerge(input: { integrationOwnerId: string; sessionOwnerId: string }): Promise<MergePreview> {
		const integration = await this.readAndValidate(input.integrationOwnerId);
		const session = await this.readAndValidate(input.sessionOwnerId);
		if (integration.kind !== 'integration' || session.kind !== 'session') { throw new Error('Merge requires an integration worktree and a session worktree.'); }
		if (integration.commonDirectory !== session.commonDirectory) { throw new Error('Managed worktrees must belong to the same repository.'); }
		await this.assertMergeReady(integration);
		await this.assertMergeReady(session);
		const targetHead = await this.git(integration.worktreePath, ['rev-parse', 'HEAD']);
		const sourceHead = await this.git(session.worktreePath, ['rev-parse', 'HEAD']);
		const patch = await this.gitBuffer(integration.worktreePath, ['diff', '--binary', '--no-ext-diff', '--no-textconv', `${targetHead}...${sourceHead}`]);
		const preview: MergePreview = {
			previewId: randomUUID(), integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId,
			sourceHead, targetHead, diffHash: createHash('sha256').update(patch).digest('hex'), expiresAt: Date.now() + PREVIEW_TTL_MS
		};
		this.previews.set(preview.previewId, preview);
		return preview;
	}

	async mergeReviewed(previewId: string): Promise<ReviewedMergeResult> {
		const preview = this.previews.get(previewId);
		if (!preview) { throw new Error('Merge preview is unknown, expired, or already consumed.'); }
		this.previews.delete(previewId);
		if (preview.expiresAt < Date.now()) { throw new Error('Merge preview has expired; review the current changes again.'); }
		return this.withIntegrationLock(preview.integrationOwnerId, 'merge', async () => {
			const integration = await this.readAndValidate(preview.integrationOwnerId);
			const session = await this.readAndValidate(preview.sessionOwnerId);
			await this.assertMergeReady(integration);
			await this.assertMergeReady(session);
			const sourceHead = await this.git(session.worktreePath, ['rev-parse', 'HEAD']);
			const targetHead = await this.git(integration.worktreePath, ['rev-parse', 'HEAD']);
			const patch = await this.gitBuffer(integration.worktreePath, ['diff', '--binary', '--no-ext-diff', '--no-textconv', `${targetHead}...${sourceHead}`]);
			if (sourceHead !== preview.sourceHead || targetHead !== preview.targetHead || createHash('sha256').update(patch).digest('hex') !== preview.diffHash) {
				throw new Error('Merge preview is stale because a source or target change occurred; review again.');
			}
			const pendingOperation: PendingOperation = {
				id: randomUUID(), kind: 'merge', startedAt: Date.now(), sourceOwnerId: session.ownerId,
				sourceHead, targetHead
			};
			this.writeLease({ ...integration, state: 'recoveryRequired', pendingOperation });
			try {
				await this.git(integration.worktreePath, ['merge', '--no-ff', '--no-edit', sourceHead], true);
				const commit = await this.git(integration.worktreePath, ['rev-parse', 'HEAD']);
				const parents = (await this.git(integration.worktreePath, ['rev-list', '--parents', '-n', '1', commit])).split(/\s+/);
				if (parents.length !== 3 || parents[1] !== targetHead || parents[2] !== sourceHead) {
					throw new Error('Git produced a merge commit whose parents do not match the reviewed target and source; recovery is required.');
				}
				const updated = this.writeLease({ ...integration, head: commit, state: 'active', pendingOperation: undefined, lastOperation: { id: pendingOperation.id, kind: 'merge', outcome: 'merged', commit } });
				return { state: 'merged', commit, integration: updated };
			} catch (error) {
				const unmerged = await this.git(integration.worktreePath, ['ls-files', '--unmerged']);
				const mergeHeadPath = await this.git(integration.worktreePath, ['rev-parse', '--git-path', 'MERGE_HEAD']);
				const mergeHead = existsSync(isAbsolute(mergeHeadPath) ? mergeHeadPath : resolve(integration.worktreePath, mergeHeadPath))
					? readFileSync(isAbsolute(mergeHeadPath) ? mergeHeadPath : resolve(integration.worktreePath, mergeHeadPath), 'utf8').trim() : '';
				const currentHead = await this.git(integration.worktreePath, ['rev-parse', 'HEAD']);
				if (!unmerged || mergeHead !== sourceHead || currentHead !== targetHead) {
					throw new Error(`Merge did not complete as a conflict; durable recovery is required: ${this.errorMessage(error)}`);
				}
				const conflictedPaths = (await this.git(integration.worktreePath, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
				if (conflictedPaths.length === 0) { throw new Error(`Merge left an index state that is not a confirmed file conflict; durable recovery is required: ${this.errorMessage(error)}`); }
				const updated = this.writeLease({ ...integration, state: 'conflict', pendingOperation: undefined, lastOperation: { id: pendingOperation.id, kind: 'merge', outcome: 'conflict' } });
				return { state: 'conflict', integration: updated, conflictedPaths };
			}
		});
	}

	async remove(ownerId: string, options: { retainedIntegrationOwnerId?: string } = {}): Promise<void> {
		const lease = await this.inspect(ownerId);
		if (lease.state === 'removed') { return; }
		await this.withIntegrationLock(lease.kind === 'integration' ? ownerId : options.retainedIntegrationOwnerId ?? ownerId, 'remove', async () => {
			const current = await this.readAndValidate(ownerId);
			if (current.pendingOperation) { throw new Error('A pending operation requires inspect and recovery before another mutation.'); }
			await this.assertClean(current);
			const head = await this.git(current.worktreePath, ['rev-parse', 'HEAD']);
			if (current.kind === 'session') {
				if (!options.retainedIntegrationOwnerId) { throw new Error('Session cleanup requires a retained integration worktree to prove its commits are preserved.'); }
				const retained = await this.readAndValidate(options.retainedIntegrationOwnerId);
				if (retained.kind !== 'integration' || retained.commonDirectory !== current.commonDirectory) { throw new Error('Retained integration worktree must belong to the same repository.'); }
				await this.assertClean(retained);
				await this.git(retained.worktreePath, ['merge-base', '--is-ancestor', head, 'HEAD']);
			} else if (head !== current.baseCommit) {
				throw new Error('Integration worktree contains commits that are not retained elsewhere; refusing cleanup.');
			}
			const pendingOperation: PendingOperation = {
				id: randomUUID(), kind: 'remove', startedAt: Date.now(), expectedHead: head,
				retainedIntegrationOwnerId: options.retainedIntegrationOwnerId
			};
			this.writeLease({ ...current, state: 'recoveryRequired', pendingOperation });
			await this.git(current.repositoryPath, ['worktree', 'remove', current.worktreePath], true);
			const refAfterRemoval = await this.git(current.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${current.branch}`]);
			if (refAfterRemoval !== head) { throw new Error('Worktree HEAD changed during cleanup; the owned branch is retained for recovery.'); }
			if (current.kind === 'session') {
				const retained = await this.readAndValidate(options.retainedIntegrationOwnerId!);
				await this.git(retained.worktreePath, ['merge-base', '--is-ancestor', refAfterRemoval, 'HEAD']);
			} else if (refAfterRemoval !== current.baseCommit) {
				throw new Error('Integration branch changed during cleanup; the owned ref is retained for recovery.');
			}
			this.writeLease({ ...current, state: 'removed', pendingOperation: undefined, lastOperation: { id: pendingOperation.id, kind: 'remove', outcome: 'removed' } });
		});
	}

	private async assertMergeReady(lease: ManagedWorktreeLease): Promise<void> {
		if (lease.state !== 'active') { throw new Error(`Worktree requires conflict recovery before another merge (${lease.state}).`); }
		await this.assertClean(lease);
	}

	private async assertClean(lease: ManagedWorktreeLease): Promise<void> {
		const status = await this.git(lease.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
		if (status) { throw new Error('Managed worktree contains dirty, untracked, or unmerged files; refusing cleanup or merge.'); }
		const unmerged = await this.git(lease.worktreePath, ['diff', '--name-only', '--diff-filter=U']);
		if (unmerged) { throw new Error('Managed worktree contains unmerged paths; explicit recovery is required.'); }
	}

	private async readAndValidate(ownerId: string): Promise<ManagedWorktreeLease> {
		this.validateOwnerId(ownerId);
		const manifestPath = this.manifestPath(ownerId);
		const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as LeaseManifest;
		const allowedKeys = new Set(['version', 'ownerId', 'kind', 'repositoryPath', 'commonDirectory', 'branch', 'worktreePath', 'baseCommit', 'head', 'state', 'pendingOperation', 'lastOperation', 'signature']);
		if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).some(key => !allowedKeys.has(key))
			|| typeof parsed.signature !== 'string' || !/^[0-9a-f]{64}$/i.test(parsed.signature)) {
			throw new Error('Managed worktree manifest contains unsupported or malformed fields.');
		}
		if (parsed.pendingOperation && Object.keys(parsed.pendingOperation).some(key => !['id', 'kind', 'startedAt', 'sourceOwnerId', 'sourceHead', 'targetHead', 'expectedHead', 'retainedIntegrationOwnerId'].includes(key))) {
			throw new Error('Managed worktree pending operation contains unsupported fields.');
		}
		if (parsed.lastOperation && Object.keys(parsed.lastOperation).some(key => !['id', 'kind', 'outcome', 'commit', 'reconciled'].includes(key))) {
			throw new Error('Managed worktree operation receipt contains unsupported fields.');
		}
		const unsigned = this.manifestPayload(parsed);
		const expectedSignature = this.sign(unsigned);
		const actualSignature = Buffer.from(parsed.signature, 'hex');
		const expectedSignatureBytes = Buffer.from(expectedSignature, 'hex');
		if (actualSignature.length !== expectedSignatureBytes.length || !timingSafeEqual(actualSignature, expectedSignatureBytes)) { throw new Error('Managed worktree manifest signature is invalid.'); }
		if (parsed.version !== 1 || parsed.ownerId !== ownerId || !['session', 'integration'].includes(parsed.kind)) { throw new Error('Managed worktree manifest identity is invalid.'); }
		const verifiedLease = this.publicLease(unsigned);
		const expectedWorktree = join(this.root, parsed.kind, ownerId);
		const expectedBranch = `bugfixer/${parsed.kind}/${ownerId}`;
		if (parsed.worktreePath !== expectedWorktree || parsed.branch !== expectedBranch) { throw new Error('Managed worktree path or ref identity was retargeted.'); }
		const repositoryPath = realpathSync(parsed.repositoryPath);
		const commonDirectory = realpathSync(parsed.commonDirectory);
		const originCommonValue = await this.git(repositoryPath, ['rev-parse', '--git-common-dir']);
		const originCommon = realpathSync(isAbsolute(originCommonValue) ? originCommonValue : resolve(repositoryPath, originCommonValue));
		if (repositoryPath !== parsed.repositoryPath || commonDirectory !== parsed.commonDirectory
			|| realpathSync(await this.git(repositoryPath, ['rev-parse', '--show-toplevel'])) !== repositoryPath || originCommon !== commonDirectory) {
			throw new Error('Managed worktree repository, common-dir, or branch identity does not match its manifest.');
		}
		if (parsed.state === 'removed') {
			if (existsSync(expectedWorktree)) { throw new Error('Removed worktree path unexpectedly exists; recovery is required.'); }
			const retainedRef = await this.git(repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${expectedBranch}`]);
			if (retainedRef !== parsed.head) { throw new Error('Removed worktree ref changed unexpectedly; recovery is required.'); }
			return { ...verifiedLease, repositoryPath, commonDirectory, branch: expectedBranch, worktreePath: expectedWorktree };
		}
		if (!existsSync(expectedWorktree)) {
			if (parsed.pendingOperation?.kind !== 'remove') { throw new Error('Managed worktree is missing without a pending removal record.'); }
			return { ...verifiedLease, repositoryPath, commonDirectory, branch: expectedBranch, worktreePath: expectedWorktree };
		}
		const worktreeRoot = await this.git(expectedWorktree, ['rev-parse', '--show-toplevel']);
		const worktreeCommonValue = await this.git(expectedWorktree, ['rev-parse', '--git-common-dir']);
		if (realpathSync(worktreeRoot) !== expectedWorktree
			|| realpathSync(isAbsolute(worktreeCommonValue) ? worktreeCommonValue : resolve(expectedWorktree, worktreeCommonValue)) !== commonDirectory
			|| await this.git(expectedWorktree, ['branch', '--show-current']) !== expectedBranch) {
			throw new Error('Managed worktree repository, common-dir, or branch identity does not match its manifest.');
		}
		const head = await this.git(expectedWorktree, ['rev-parse', 'HEAD']);
		return { ...verifiedLease, ownerId, kind: parsed.kind, repositoryPath, commonDirectory, branch: expectedBranch, worktreePath: expectedWorktree, baseCommit: parsed.baseCommit, head };
	}

	private async reconcilePendingOperation(lease: ManagedWorktreeLease): Promise<ManagedWorktreeLease> {
		const pending = lease.pendingOperation!;
		if (await this.operationLockIsLive(lease.kind === 'integration' ? lease.ownerId : pending.retainedIntegrationOwnerId ?? lease.ownerId)) {
			return { ...lease, state: 'recoveryRequired' };
		}
		if (pending.kind === 'remove') {
			const branchRef = await this.git(lease.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${lease.branch}`]);
			if (!existsSync(lease.worktreePath)) {
				const registrations = await this.git(lease.repositoryPath, ['worktree', 'list', '--porcelain']);
				if (registrations.includes(`worktree ${lease.worktreePath}\n`) || branchRef !== pending.expectedHead) { return { ...lease, state: 'recoveryRequired' }; }
				if (lease.kind === 'session') {
					if (!pending.retainedIntegrationOwnerId) { return { ...lease, state: 'recoveryRequired' }; }
					const retained = await this.readAndValidate(pending.retainedIntegrationOwnerId);
					if (retained.commonDirectory !== lease.commonDirectory) { return { ...lease, state: 'recoveryRequired' }; }
					await this.git(retained.worktreePath, ['merge-base', '--is-ancestor', branchRef, 'HEAD']);
				} else if (branchRef !== lease.baseCommit) { return { ...lease, state: 'recoveryRequired' }; }
				return this.writeLease({ ...lease, head: branchRef, state: 'removed', pendingOperation: undefined, lastOperation: { id: pending.id, kind: 'remove', outcome: 'removed', reconciled: true } });
			}
			if (await this.git(lease.worktreePath, ['rev-parse', 'HEAD']) !== pending.expectedHead || await this.git(lease.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])) {
				return { ...lease, state: 'recoveryRequired' };
			}
			return this.writeLease({ ...lease, state: 'active', pendingOperation: undefined, lastOperation: { id: pending.id, kind: 'remove', outcome: 'notApplied', reconciled: true } });
		}
		const currentHead = await this.git(lease.worktreePath, ['rev-parse', 'HEAD']);
		const unmerged = await this.git(lease.worktreePath, ['ls-files', '--unmerged']);
		const mergeHeadPath = await this.git(lease.worktreePath, ['rev-parse', '--git-path', 'MERGE_HEAD']);
		const resolvedMergeHeadPath = isAbsolute(mergeHeadPath) ? mergeHeadPath : resolve(lease.worktreePath, mergeHeadPath);
		const mergeHead = existsSync(resolvedMergeHeadPath) ? readFileSync(resolvedMergeHeadPath, 'utf8').trim() : '';
		if (currentHead === pending.targetHead && unmerged && mergeHead === pending.sourceHead) {
			return this.writeLease({ ...lease, state: 'conflict', pendingOperation: undefined, lastOperation: { id: pending.id, kind: 'merge', outcome: 'conflict', reconciled: true } });
		}
		if (currentHead === pending.targetHead && !mergeHead && !await this.git(lease.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])) {
			return this.writeLease({ ...lease, state: 'active', pendingOperation: undefined, lastOperation: { id: pending.id, kind: 'merge', outcome: 'notApplied', reconciled: true } });
		}
		const parents = (await this.git(lease.worktreePath, ['rev-list', '--parents', '-n', '1', currentHead])).split(/\s+/);
		if (!unmerged && !mergeHead && parents.length === 3 && parents[1] === pending.targetHead && parents[2] === pending.sourceHead
			&& !await this.git(lease.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])) {
			return this.writeLease({ ...lease, head: currentHead, state: 'active', pendingOperation: undefined, lastOperation: { id: pending.id, kind: 'merge', outcome: 'merged', commit: currentHead, reconciled: true } });
		}
		return { ...lease, state: 'recoveryRequired' };
	}

	private writeLease(lease: ManagedWorktreeLease): ManagedWorktreeLease {
		const unsigned = this.manifestPayload(lease);
		const manifest: LeaseManifest = { ...unsigned, signature: this.sign(unsigned) };
		const path = this.manifestPath(lease.ownerId);
		const temporary = `${path}.${randomUUID()}.tmp`;
		const fd = openSync(temporary, 'wx', 0o600);
		try { writeFileSync(fd, JSON.stringify(manifest)); fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(temporary, path);
		const directoryFd = openSync(dirname(path), 'r');
		try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
		return lease;
	}

	private manifestPayload(lease: ManagedWorktreeLease): LeaseManifestPayload {
		const pendingOperation = lease.pendingOperation ? {
			id: lease.pendingOperation.id, kind: lease.pendingOperation.kind, startedAt: lease.pendingOperation.startedAt,
			...(lease.pendingOperation.sourceOwnerId !== undefined ? { sourceOwnerId: lease.pendingOperation.sourceOwnerId } : {}),
			...(lease.pendingOperation.sourceHead !== undefined ? { sourceHead: lease.pendingOperation.sourceHead } : {}),
			...(lease.pendingOperation.targetHead !== undefined ? { targetHead: lease.pendingOperation.targetHead } : {}),
			...(lease.pendingOperation.expectedHead !== undefined ? { expectedHead: lease.pendingOperation.expectedHead } : {}),
			...(lease.pendingOperation.retainedIntegrationOwnerId !== undefined ? { retainedIntegrationOwnerId: lease.pendingOperation.retainedIntegrationOwnerId } : {})
		} : undefined;
		const lastOperation = lease.lastOperation ? {
			id: lease.lastOperation.id, kind: lease.lastOperation.kind, outcome: lease.lastOperation.outcome,
			...(lease.lastOperation.commit !== undefined ? { commit: lease.lastOperation.commit } : {}),
			...(lease.lastOperation.reconciled !== undefined ? { reconciled: lease.lastOperation.reconciled } : {})
		} : undefined;
		return {
			version: 1, ownerId: lease.ownerId, kind: lease.kind, repositoryPath: lease.repositoryPath,
			commonDirectory: lease.commonDirectory, branch: lease.branch, worktreePath: lease.worktreePath,
			baseCommit: lease.baseCommit, head: lease.head, state: lease.state, pendingOperation, lastOperation
		};
	}

	private publicLease(payload: LeaseManifestPayload): ManagedWorktreeLease {
		return {
			ownerId: payload.ownerId, kind: payload.kind, repositoryPath: payload.repositoryPath,
			commonDirectory: payload.commonDirectory, branch: payload.branch, worktreePath: payload.worktreePath,
			baseCommit: payload.baseCommit, head: payload.head, state: payload.state,
			...(payload.pendingOperation ? { pendingOperation: payload.pendingOperation } : {}),
			...(payload.lastOperation ? { lastOperation: payload.lastOperation } : {})
		};
	}

	private async withIntegrationLock<T>(ownerId: string, operation: OperationLock['operation'], run: () => Promise<T>): Promise<T> {
		this.validateOwnerId(ownerId);
		const lockPath = join(this.root, `${ownerId}.operation-lock.json`);
		if (await this.operationLockIsLive(ownerId)) { throw new Error('Integration operation is owned by a live process; refusing concurrent mutation.'); }
		const unsigned = { ownerId, operation, operationId: randomUUID(), pid: process.pid, processStart: await this.processStartToken(process.pid) };
		const lock: OperationLock = { ...unsigned, signature: this.sign(unsigned) };
		try {
			const lockFd = openSync(lockPath, 'wx', 0o600);
			try { writeFileSync(lockFd, JSON.stringify(lock)); fsyncSync(lockFd); } finally { closeSync(lockFd); }
			const rootFd = openSync(this.root, 'r');
			try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
		}
		catch (error) { throw new Error(`Integration operation lock could not be acquired safely: ${this.errorMessage(error)}`); }
		try { return await run(); }
		finally {
			const current = this.readOperationLock(lockPath);
			if (current.operationId !== lock.operationId || !this.isValidSignature(current)) { throw new Error('Operation lock ownership changed; recovery is required.'); }
			unlinkSync(lockPath);
		}
	}

	private async operationLockIsLive(ownerId: string, verificationAttempt = 0): Promise<boolean> {
		const lockPath = join(this.root, `${ownerId}.operation-lock.json`);
		if (!existsSync(lockPath)) { return false; }
		const lock = this.readOperationLock(lockPath);
		if (lock.ownerId !== ownerId) { throw new Error('Operation lock owner is invalid or ambiguous; manual recovery is required.'); }
		let alive = true;
		try { process.kill(lock.pid, 0); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ESRCH') { alive = false; }
			else { throw new Error('Operation lock owner process cannot be verified; manual recovery is required.'); }
		}
		if (alive && await this.processStartToken(lock.pid) !== lock.processStart) { alive = false; }
		if (alive) { return true; }
		if (!existsSync(lockPath)) { return false; }
		const currentLock = this.readOperationLock(lockPath);
		if (currentLock.operationId !== lock.operationId || !this.isValidSignature(currentLock)) {
			if (verificationAttempt >= 2) { throw new Error('Operation lock changed repeatedly during owner verification; manual recovery is required.'); }
			return this.operationLockIsLive(ownerId, verificationAttempt + 1);
		}
		unlinkSync(lockPath);
		return false;
	}

	private readOperationLock(lockPath: string): OperationLock {
		let lock: OperationLock;
		try { lock = JSON.parse(readFileSync(lockPath, 'utf8')) as OperationLock; }
		catch (error) { throw new Error(`Operation lock metadata is malformed or ambiguous; manual recovery is required: ${this.errorMessage(error)}`); }
		if (!lock || !UUID_PATTERN.test(lock.ownerId) || !UUID_PATTERN.test(lock.operationId)
			|| !['merge', 'remove'].includes(lock.operation) || !Number.isSafeInteger(lock.pid) || lock.pid <= 0
			|| typeof lock.processStart !== 'string' || !lock.processStart || !this.isValidSignature(lock)) {
			throw new Error('Operation lock metadata is invalid or ambiguous; manual recovery is required.');
		}
		return lock;
	}

	private async processStartToken(pid: number): Promise<string> {
		const result = await this.runCommand('ps', ['-p', String(pid), '-o', 'lstart='], 2_000);
		return result.stdout.toString('utf8').trim();
	}

	private isValidSignature(value: OperationLock): boolean {
		const { signature, ...unsigned } = value;
		const expected = Buffer.from(this.sign(unsigned), 'hex');
		const actual = Buffer.from(typeof signature === 'string' ? signature : '', 'hex');
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	}

	private async git(cwd: string, args: readonly string[], mutation = false): Promise<string> {
		const commandArgs = mutation ? ['-c', 'core.hooksPath=/dev/null', ...args] : [...args];
		const result = await this.runCommand('git', ['-C', cwd, ...commandArgs], COMMAND_TIMEOUT_MS);
		return result.stdout.toString('utf8').trimEnd();
	}

	private async gitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
		const result = await this.runCommand('git', ['-C', cwd, ...args], COMMAND_TIMEOUT_MS);
		return result.stdout;
	}

	private runCommand(command: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: Buffer; stderr: Buffer }> {
		return new Promise((resolvePromise, rejectPromise) => {
			const child = spawn(command, args, { detached: process.platform !== 'win32', env: this.gitEnvironment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let buffered = 0;
			let spawnError: Error | undefined;
			let timedOut = false;
			let outputExceeded = false;
			let terminationRequested = false;
			let cleanupPromise: Promise<void> | undefined;
			const terminate = (): void => {
				if (child.pid === undefined || terminationRequested) { return; }
				terminationRequested = true;
				try {
					if (process.platform !== 'win32') { process.kill(-child.pid, 'SIGTERM'); }
					else { child.kill('SIGTERM'); }
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
						try { child.kill('SIGTERM'); } catch (childError) {
							if ((childError as NodeJS.ErrnoException).code !== 'ESRCH') { spawnError ??= childError as Error; }
						}
					}
				}
				cleanupPromise = new Promise(resolveCleanup => {
					setTimeout(() => {
						try {
							if (process.platform !== 'win32') { process.kill(-child.pid!, 'SIGKILL'); }
							else { child.kill('SIGKILL'); }
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
								try { child.kill('SIGKILL'); } catch (childError) {
									if ((childError as NodeJS.ErrnoException).code !== 'ESRCH') { spawnError ??= childError as Error; }
								}
							}
						}
						resolveCleanup();
					}, TERMINATION_GRACE_MS);
				});
			};
			const timeout = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
			const collect = (target: Buffer[], chunk: Buffer): void => {
				buffered += chunk.length;
				if (buffered > MAX_BUFFER_BYTES) {
					if (!outputExceeded) { outputExceeded = true; terminate(); }
					return;
				}
				target.push(chunk);
			};
			child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
			child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
			child.on('error', error => { spawnError = error; });
			child.on('close', async (code, signal) => {
				clearTimeout(timeout);
				if (terminationRequested) { await cleanupPromise; }
				const out = Buffer.concat(stdout);
				const err = Buffer.concat(stderr);
				if (spawnError) { rejectPromise(spawnError); }
				else if (timedOut) { rejectPromise(new Error(`${command} exceeded its ${timeoutMs}ms timeout and its owned process group was terminated.`)); }
				else if (outputExceeded) { rejectPromise(new Error(`${command} exceeded the ${MAX_BUFFER_BYTES}-byte output limit and its owned process group was terminated.`)); }
				else if (code !== 0) { rejectPromise(new Error(`${command} exited with ${signal ?? code}: ${err.toString('utf8').trim()}`)); }
				else { resolvePromise({ stdout: out, stderr: err }); }
			});
		});
	}

	private gitEnvironment(): NodeJS.ProcessEnv {
		const env = { ...process.env };
		const allowedGitVariables = new Set(['GIT_CONFIG_GLOBAL', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']);
		for (const key of Object.keys(env)) {
			if (key.startsWith('GIT_') && !allowedGitVariables.has(key)) { delete env[key]; }
		}
		env.GIT_OPTIONAL_LOCKS = '0';
		return env;
	}

	private sign(value: object): string {
		return createHmac('sha256', this.manifestKey).update(JSON.stringify(value)).digest('hex');
	}

	private manifestPath(ownerId: string): string { return join(this.root, `${ownerId}.json`); }
	private validateOwnerId(ownerId: string): void { if (!UUID_PATTERN.test(ownerId)) { throw new Error('Managed worktree owner ID must be a UUID.'); } }
	private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
