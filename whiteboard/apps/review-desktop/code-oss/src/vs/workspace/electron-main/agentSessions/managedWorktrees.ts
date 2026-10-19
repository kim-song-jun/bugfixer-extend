/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_REVIEWED_FILES = 300;
const MAX_REVIEWED_FILE_BYTES = 1024 * 1024;
const MAX_REVIEWED_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_REVIEWED_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_COMMIT_MESSAGE_BYTES = 4096;
const MAX_ACTIVE_COMMIT_PREVIEWS = 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const FILE_MODES = new Set(['100644', '100755', '120000']);

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

export type ReviewedFileMode = '100644' | '100755' | '120000';
export type ReviewedFileBefore = { readonly absent: true } | { readonly mode: ReviewedFileMode; readonly sha256: string };
export type ReviewedFileAfter = { readonly absent: true } | { readonly mode: ReviewedFileMode; readonly sha256: string; readonly bytes: Uint8Array };
export interface ReviewedCommitFileInput { readonly path: string; readonly before: ReviewedFileBefore; readonly after: ReviewedFileAfter; }
export interface ReviewedCommitIdentity { readonly name: string; readonly email: string; readonly date: string; }
export interface ReviewedCommitInput {
	readonly ownerId: string;
	readonly sourceHead: string;
	readonly commitMessage: string;
	readonly files: readonly ReviewedCommitFileInput[];
	/** Host-only resume capability: use the exact identities retained by an approved proposal. */
	readonly frozenIdentity?: { readonly author: ReviewedCommitIdentity; readonly committer: ReviewedCommitIdentity };
}
export interface ReviewedCommitPreview {
	readonly previewId: string;
	readonly ownerId: string;
	readonly sourceHead: string;
	readonly commitMessage: string;
	readonly proposedTreeOid: string;
	readonly rawDiffFingerprint: string;
	readonly files: readonly { readonly path: string; readonly before: ReviewedFileBefore; readonly after: ReviewedFileBefore }[];
	readonly author: ReviewedCommitIdentity;
	readonly committer: ReviewedCommitIdentity;
	readonly expiresAt: number;
}
export interface ReviewedCommitCandidate {
	readonly state: 'candidate';
	readonly candidateCommitOid: string;
	readonly sourceHead: string;
	readonly proposedTreeOid: string;
	readonly rawDiffFingerprint: string;
	readonly selectedPaths: readonly string[];
}

/** Durable exact proposal binding required by host approval and apply receipts. */
export interface ReviewedCommitBinding extends ReviewedCommitCandidate {
	readonly ownerId: string;
	readonly commitMessage: string;
	readonly author: ReviewedCommitIdentity;
	readonly committer: ReviewedCommitIdentity;
	readonly files: readonly { readonly path: string; readonly before: ReviewedFileBefore; readonly after: ReviewedFileBefore }[];
}

export interface ReviewedCommitApplyingRecord {
	readonly operationId: string;
	readonly binding: ReviewedCommitBinding;
}

export interface ReviewedCommitApplyInput {
	readonly operationId: string;
	readonly binding: ReviewedCommitBinding;
	/** Required host journal capability; this persists the exact attempt, never grants approval. */
	readonly recordApplying: (record: ReviewedCommitApplyingRecord) => Promise<void>;
	/** Required readback to prove the same operation and immutable proposal were durably journaled. */
	readonly readApplying: (operationId: string) => Promise<ReviewedCommitApplyingRecord | undefined>;
}

export interface ReviewedCommitRecoveryInput extends Omit<ReviewedCommitApplyInput, 'recordApplying'> {}

export type ReviewedCommitApplyResult =
	| { readonly state: 'applied' | 'alreadyApplied'; readonly operationId: string; readonly candidateCommitOid: string; readonly sourceHead: string; readonly currentRef: string; readonly indexState: 'reconciled' }
	| { readonly state: 'recoveryRequired'; readonly operationId: string; readonly candidateCommitOid: string; readonly sourceHead: string; readonly currentRef?: string; readonly indexState: 'unchanged' | 'reconciled' | 'unknown'; readonly reason: string };

interface RealIndexSnapshot {
	readonly path: string;
	readonly bytes: Buffer;
	readonly dev: number;
	readonly ino: number;
	readonly mode: number;
	readonly size: number;
	readonly mtimeMs: number;
}

interface IndexEntry { readonly mode: string; readonly oid: string; readonly stage: number; readonly path: string; }
interface OwnedIndexLock { readonly path: string; readonly fd: number; readonly dev: number; readonly ino: number; }

interface StoredReviewedCommitPreview {
	readonly preview: ReviewedCommitPreview;
	readonly files: readonly { readonly path: string; readonly before: ReviewedFileBefore; readonly after: ReviewedFileBefore; readonly bytes?: Buffer }[];
}
interface PreparedReviewedTree { readonly treeOid: string; readonly rawDiffFingerprint: string; }

interface LeaseManifest extends ManagedWorktreeLease { readonly version: 1; readonly signature: string; }
interface LeaseManifestPayload extends ManagedWorktreeLease { readonly version: 1; }
interface OperationLock { readonly ownerId: string; readonly operation: 'merge' | 'remove' | 'prepareCommit' | 'applyReviewedCommit'; readonly operationId: string; readonly pid: number; readonly processStart: string; readonly signature: string; }

/** App-profile-owned Git worktrees. A merge preview is an exact, expiring snapshot, not approval. */
export class ManagedWorktreeService {
	private readonly root: string;
	private readonly previews = new Map<string, MergePreview>();
	private readonly commitPreviews = new Map<string, StoredReviewedCommitPreview>();
	private activeCommitPreparations = 0;
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

	/** Builds an expiring proposed tree solely from host-retained bytes; no ref, checkout, or user index is changed. */
	async prepareReviewedCommit(input: ReviewedCommitInput): Promise<ReviewedCommitPreview> {
		this.validateOwnerId(input.ownerId);
		this.validateReviewedCommitInput(input);
		if (Object.hasOwn(input, 'frozenIdentity') && input.frozenIdentity === undefined) { throw new Error('Frozen Git identities are malformed or incomplete.'); }
		const frozenIdentity = input.frozenIdentity === undefined ? undefined : this.validateFrozenIdentity(input.frozenIdentity);
		this.expireCommitPreviews();
		if (this.activeCommitPreparations + this.commitPreviews.size >= MAX_ACTIVE_COMMIT_PREVIEWS) { throw new Error('Too many reviewed commit preparations are active.'); }
		this.activeCommitPreparations++;
		try {
			const retainedFiles = this.retainReviewedFiles(input.files);
			this.validateRetainedFileBytes(retainedFiles);
			this.expireCommitPreviews();
			if (this.commitPreviews.size >= MAX_ACTIVE_COMMIT_PREVIEWS) { throw new Error('Too many reviewed commit preparations are active.'); }
			return await this.withIntegrationLock(input.ownerId, 'prepareCommit', async () => {
				const lease = await this.readAndValidate(input.ownerId);
				this.assertReviewedSource(lease, input.sourceHead);
				const author = frozenIdentity?.author ?? await this.readCommitIdentity(lease.worktreePath, 'GIT_AUTHOR_IDENT');
				const committer = frozenIdentity?.committer ?? await this.readCommitIdentity(lease.worktreePath, 'GIT_COMMITTER_IDENT');
				const prepared = await this.prepareReviewedTree(lease, input.sourceHead, retainedFiles);
				await this.assertReviewedSourceStillCurrent(input.ownerId, input.sourceHead);
				this.expireCommitPreviews();
				if (this.commitPreviews.size >= MAX_ACTIVE_COMMIT_PREVIEWS) { throw new Error('Too many reviewed commit preparations are active.'); }
				const previewId = randomUUID();
				const previewFiles = Object.freeze(retainedFiles.map(file => Object.freeze({
					path: file.path,
					before: Object.freeze({ ...file.before }),
					after: Object.freeze({ ...file.after })
				})));
				const preview: ReviewedCommitPreview = Object.freeze({
					previewId, ownerId: input.ownerId, sourceHead: input.sourceHead, commitMessage: input.commitMessage,
					proposedTreeOid: prepared.treeOid, rawDiffFingerprint: prepared.rawDiffFingerprint,
					files: previewFiles,
					author: Object.freeze({ ...author }), committer: Object.freeze({ ...committer }), expiresAt: Date.now() + PREVIEW_TTL_MS
				});
				this.commitPreviews.set(previewId, { preview, files: retainedFiles });
				return preview;
			});
		} finally {
			this.activeCommitPreparations--;
		}
	}

	/** Drops a host-owned prepared preview when no candidate will consume it. */
	discardReviewedCommitPreview(previewId: string): void {
		if (!UUID_PATTERN.test(previewId)) { throw new Error('Reviewed commit preview ID must be a UUID.'); }
		this.commitPreviews.delete(previewId);
	}

	/** Writes an unreferenced commit object from the exact prepared tree. It never advances a branch/ref. */
	async createReviewedCommitCandidate(previewId: string): Promise<ReviewedCommitCandidate> {
		if (!UUID_PATTERN.test(previewId)) { throw new Error('Reviewed commit preview ID must be a UUID.'); }
		this.expireCommitPreviews();
		const stored = this.commitPreviews.get(previewId);
		if (!stored) { throw new Error('Reviewed commit preparation is missing or expired.'); }
		return this.withIntegrationLock(stored.preview.ownerId, 'prepareCommit', async () => {
			const current = this.commitPreviews.get(previewId);
			if (current !== stored || stored.preview.expiresAt <= Date.now()) { throw new Error('Reviewed commit preparation is missing, expired, or already consumed.'); }
			const lease = await this.readAndValidate(stored.preview.ownerId);
			this.assertReviewedSource(lease, stored.preview.sourceHead);
			const prepared = await this.prepareReviewedTree(lease, stored.preview.sourceHead, stored.files);
			if (prepared.treeOid !== stored.preview.proposedTreeOid || prepared.rawDiffFingerprint !== stored.preview.rawDiffFingerprint) {
				throw new Error('Reviewed commit preparation changed; create a new preview.');
			}
			await this.assertReviewedSourceStillCurrent(stored.preview.ownerId, stored.preview.sourceHead);
			const env = this.commitIdentityEnvironment(stored.preview.author, stored.preview.committer);
			const candidateCommitOid = (await this.runGit(lease.worktreePath, ['-c', 'commit.gpgsign=false', 'commit-tree', prepared.treeOid, '-p', stored.preview.sourceHead, '-m', stored.preview.commitMessage], { env })).stdout.toString('utf8').trim();
			if (!OBJECT_ID_PATTERN.test(candidateCommitOid)) { throw new Error('Git returned an invalid candidate commit ID.'); }
			const actual = (await this.git(lease.worktreePath, ['rev-list', '--parents', '-n', '1', candidateCommitOid])).split(/\s+/);
			const actualTree = await this.git(lease.worktreePath, ['rev-parse', `${candidateCommitOid}^{tree}`]);
			if (actual.length !== 2 || actual[1] !== stored.preview.sourceHead || actualTree !== prepared.treeOid) { throw new Error('Candidate commit does not match the reviewed tree and source parent.'); }
			await this.assertCandidateCommitMetadata(lease.worktreePath, candidateCommitOid, stored.preview);
			await this.assertReviewedSourceStillCurrent(stored.preview.ownerId, stored.preview.sourceHead);
			this.commitPreviews.delete(previewId);
			return { state: 'candidate', candidateCommitOid, sourceHead: stored.preview.sourceHead, proposedTreeOid: prepared.treeOid, rawDiffFingerprint: prepared.rawDiffFingerprint, selectedPaths: stored.files.map(file => file.path) };
		});
	}

	/** Applies a host-approved immutable candidate after a durable applying receipt is written and read back. */
	async applyReviewedCommit(input: ReviewedCommitApplyInput): Promise<ReviewedCommitApplyResult> {
		this.validateReviewedCommitBinding(input.binding);
		this.validateOwnerId(input.binding.ownerId);
		if (!UUID_PATTERN.test(input.operationId) || typeof input.recordApplying !== 'function' || typeof input.readApplying !== 'function') { throw new Error('Reviewed commit apply requires an operation ID and durable host journal capabilities.'); }
		return this.withIntegrationLock(input.binding.ownerId, 'applyReviewedCommit', async () => {
			const lease = await this.readAndValidate(input.binding.ownerId);
			await this.assertReviewedCommitBinding(lease, input.binding);
			const sourceRef = await this.readSessionRef(lease);
			if (lease.kind !== 'session' || lease.state !== 'active' || lease.pendingOperation || lease.head !== input.binding.sourceHead
				|| sourceRef !== input.binding.sourceHead || await this.git(lease.worktreePath, ['rev-parse', 'HEAD']) !== input.binding.sourceHead) {
				throw new Error('Reviewed commit source ref changed; obtain a fresh exact-head approval.');
			}
			const initialIndex = await this.readRealIndex(lease.worktreePath);
			if (existsSync(`${initialIndex.path}.lock`)) { throw new Error('Managed worktree index already has a lock; refusing to journal or apply.'); }
			const indexLock = this.acquireOwnedIndexLock(initialIndex);
			let lockRenamed = false;
			let journalComplete = false;
			try {
				if (!this.realIndexStillMatches(initialIndex)) { throw new Error('Real index changed while reserving its lock; no journal or ref update was made.'); }
				await this.assertSelectedIndexEntriesSafe(lease.worktreePath, input.binding, initialIndex);
				const updatedIndex = await this.prepareReviewedCommitIndex(lease, input.binding, initialIndex);
				this.writeOwnedIndexLock(indexLock, updatedIndex, initialIndex.mode);
				if (!this.ownedIndexLockMatches(indexLock, updatedIndex) || !this.realIndexStillMatches(initialIndex)) {
					throw new Error('Index changed or the reserved lock changed before journaling; no ref update was made.');
				}
				const journalRecord = this.freezeApplyingRecord(input.operationId, input.binding);
				await input.recordApplying(journalRecord);
				if (!this.applyingRecordsEqual(await input.readApplying(input.operationId), journalRecord)) {
					throw new Error('The durable applying receipt could not be read back exactly; no Git ref or index was changed.');
				}
				journalComplete = true;
				if (!this.realIndexStillMatches(initialIndex) || !this.ownedIndexLockMatches(indexLock, updatedIndex)) {
					const currentRef = await this.readSessionRef(lease);
					return this.reviewedCommitRecoveryResult(input, currentRef, 'unknown', 'Real index identity/content changed while journaling; ref update was withheld.');
				}
				await this.assertSelectedIndexEntriesSafe(lease.worktreePath, input.binding, initialIndex);
				if (!this.realIndexStillMatches(initialIndex) || !this.ownedIndexLockMatches(indexLock, updatedIndex)) {
					const currentRef = await this.readSessionRef(lease);
					return this.reviewedCommitRecoveryResult(input, currentRef, 'unknown', 'Real index changed while rechecking selected entries; ref update was withheld.');
				}
				const latestLease = await this.readAndValidate(input.binding.ownerId);
				const latestRef = await this.readSessionRef(latestLease);
				if (latestLease.commonDirectory !== lease.commonDirectory || latestLease.branch !== lease.branch || latestRef !== input.binding.sourceHead) {
					return this.reviewedCommitRecoveryResult(input, latestRef, 'unchanged', 'The session ref changed after journaling; no ref update was applied.');
				}
				if (!this.realIndexStillMatches(initialIndex) || !this.ownedIndexLockMatches(indexLock, updatedIndex)) {
					return this.reviewedCommitRecoveryResult(input, latestRef, 'unknown', 'Real index identity/content changed before compare-and-swap; ref update was withheld.');
				}
				await this.assertSelectedIndexEntriesSafe(latestLease.worktreePath, input.binding, initialIndex);
				if (!this.realIndexStillMatches(initialIndex) || !this.ownedIndexLockMatches(indexLock, updatedIndex)) {
					return this.reviewedCommitRecoveryResult(input, latestRef, 'unknown', 'Real index changed during selected-entry recheck; ref update was withheld.');
				}
				await this.git(latestLease.repositoryPath, ['update-ref', `refs/heads/${latestLease.branch}`, input.binding.candidateCommitOid, input.binding.sourceHead], true);
				const currentRef = await this.readSessionRef(latestLease);
				if (currentRef !== input.binding.candidateCommitOid) {
					return this.reviewedCommitRecoveryResult(input, currentRef, 'unknown', 'The session ref did not reach the exact candidate after compare-and-swap.');
				}
				if (!this.realIndexStillMatches(initialIndex) || !this.ownedIndexLockMatches(indexLock, updatedIndex)) {
					return this.reviewedCommitRecoveryResult(input, currentRef, 'unknown', 'Real index identity/content changed after compare-and-swap; recovery is required.');
				}
				renameSync(indexLock.path, initialIndex.path);
				lockRenamed = true;
				const indexDirectoryFd = openSync(dirname(initialIndex.path), 'r');
				try { fsyncSync(indexDirectoryFd); } finally { closeSync(indexDirectoryFd); }
				await this.assertIndexMatchesReviewedCommit(latestLease, input.binding, updatedIndex);
				const verifiedRef = await this.readSessionRef(latestLease);
				if (verifiedRef !== input.binding.candidateCommitOid || await this.git(latestLease.worktreePath, ['rev-parse', 'HEAD']) !== input.binding.candidateCommitOid) {
					return this.reviewedCommitRecoveryResult(input, verifiedRef, 'reconciled', 'Post-apply ref or worktree HEAD verification failed.');
				}
				this.writeLease({ ...latestLease, head: input.binding.candidateCommitOid, state: 'active', pendingOperation: undefined });
				return { state: 'applied', operationId: input.operationId, candidateCommitOid: input.binding.candidateCommitOid, sourceHead: input.binding.sourceHead, currentRef: verifiedRef, indexState: 'reconciled' };
			} catch (error) {
				if (!journalComplete) { throw error; }
				let currentRef: string | undefined;
				try { currentRef = await this.readSessionRef(lease); } catch { /* Report unknown ref state below. */ }
				let indexState: 'unchanged' | 'reconciled' | 'unknown' = 'unknown';
				try {
					const currentIndex = await this.readRealIndex(lease.worktreePath);
					indexState = currentIndex.bytes.equals(initialIndex.bytes) ? 'unchanged' : 'unknown';
				} catch { indexState = 'unknown'; }
				return this.reviewedCommitRecoveryResult(input, currentRef, indexState, this.errorMessage(error));
			} finally {
				this.releaseOwnedIndexLock(indexLock, lockRenamed);
			}
		});
	}

	/** Reconciles only an already journaled operation. It never advances a ref during recovery. */
	async reconcileReviewedCommit(input: ReviewedCommitRecoveryInput): Promise<ReviewedCommitApplyResult> {
		this.validateReviewedCommitBinding(input.binding);
		this.validateOwnerId(input.binding.ownerId);
		if (!UUID_PATTERN.test(input.operationId) || typeof input.readApplying !== 'function') { throw new Error('Reviewed commit recovery requires an operation ID and durable host journal reader.'); }
		const expected = this.freezeApplyingRecord(input.operationId, input.binding);
		if (!this.applyingRecordsEqual(await input.readApplying(input.operationId), expected)) { throw new Error('Reviewed commit recovery is allowed only for the exact durable applying receipt.'); }
		return this.withIntegrationLock(input.binding.ownerId, 'applyReviewedCommit', async () => {
			const lease = await this.readAndValidate(input.binding.ownerId);
			await this.assertReviewedCommitBinding(lease, input.binding);
			let currentRef: string;
			try { currentRef = await this.readSessionRef(lease); }
			catch (error) { return this.reviewedCommitRecoveryResult(input, undefined, 'unknown', this.errorMessage(error)); }
			if (currentRef !== input.binding.candidateCommitOid) {
				return this.reviewedCommitRecoveryResult(input, currentRef, 'unchanged', currentRef === input.binding.sourceHead
					? 'The ref remains at the source; recovery cannot move it without a fresh approved apply.'
					: 'The ref points to another commit; recovery will not move it.');
			}
			try {
				await this.reconcileReviewedCommitIndex(lease, input.binding);
				const verifiedRef = await this.readSessionRef(lease);
				if (verifiedRef !== input.binding.candidateCommitOid || await this.git(lease.worktreePath, ['rev-parse', 'HEAD']) !== input.binding.candidateCommitOid) {
					return this.reviewedCommitRecoveryResult(input, verifiedRef, 'reconciled', 'Post-recovery ref or worktree HEAD verification failed.');
				}
				this.writeLease({ ...lease, head: input.binding.candidateCommitOid, state: 'active', pendingOperation: undefined });
				return { state: 'alreadyApplied', operationId: input.operationId, candidateCommitOid: input.binding.candidateCommitOid, sourceHead: input.binding.sourceHead, currentRef: verifiedRef, indexState: 'reconciled' };
			} catch (error) {
				return this.reviewedCommitRecoveryResult(input, currentRef, 'unknown', this.errorMessage(error));
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

	private validateReviewedCommitInput(input: ReviewedCommitInput): void {
		if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['ownerId', 'sourceHead', 'commitMessage', 'files', 'frozenIdentity'].includes(key))) { throw new Error('Reviewed commit input contains unsupported fields.'); }
		if (typeof input.sourceHead !== 'string' || !OBJECT_ID_PATTERN.test(input.sourceHead) || input.sourceHead !== input.sourceHead.toLowerCase()) { throw new Error('Reviewed commit source HEAD must be a lowercase full Git object ID.'); }
		if (typeof input.commitMessage !== 'string' || !input.commitMessage.trim() || Buffer.byteLength(input.commitMessage, 'utf8') > MAX_COMMIT_MESSAGE_BYTES || input.commitMessage.includes('\0')) { throw new Error('Reviewed commit message is invalid or exceeds its limit.'); }
		if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > MAX_REVIEWED_FILES) { throw new Error('Reviewed commit must select between one and 300 files.'); }
		const paths = new Set<string>();
		let totalBytes = 0;
		for (const file of input.files) {
			if (!file || typeof file !== 'object' || Object.keys(file).some(key => !['path', 'before', 'after'].includes(key))) { throw new Error('Reviewed file input contains unsupported fields.'); }
			this.validateReviewedPath(file.path);
			if (paths.has(file.path)) { throw new Error('Reviewed commit contains a duplicate path.'); }
			paths.add(file.path);
			this.validateReviewedFileState(file.before, false);
			this.validateReviewedFileState(file.after, true);
			if ('absent' in file.before && 'absent' in file.after) { throw new Error('Reviewed commit cannot include an unchanged absent file.'); }
			if ('bytes' in file.after) {
				if (!(file.after.bytes instanceof Uint8Array) || file.after.bytes.byteLength > MAX_REVIEWED_FILE_BYTES) { throw new Error('Reviewed file bytes exceed the one MiB limit.'); }
				totalBytes += file.after.bytes.byteLength;
				if (totalBytes > MAX_REVIEWED_TOTAL_BYTES) { throw new Error('Reviewed file bytes exceed the eight MiB total limit.'); }
				const actualHash = createHash('sha256').update(file.after.bytes).digest('hex');
				if (actualHash !== file.after.sha256.toLowerCase()) { throw new Error('Reviewed file bytes do not match the supplied SHA-256.'); }
			}
		}
	}

	private validateReviewedCommitBinding(binding: ReviewedCommitBinding): void {
		if (!binding || typeof binding !== 'object' || binding.state !== 'candidate'
			|| Object.keys(binding).some(key => !['state', 'candidateCommitOid', 'sourceHead', 'proposedTreeOid', 'rawDiffFingerprint', 'selectedPaths', 'ownerId', 'commitMessage', 'author', 'committer', 'files'].includes(key))) {
			throw new Error('Reviewed commit binding contains unsupported or malformed fields.');
		}
		this.validateOwnerId(binding.ownerId);
		for (const oid of [binding.candidateCommitOid, binding.sourceHead, binding.proposedTreeOid]) {
			if (typeof oid !== 'string' || !OBJECT_ID_PATTERN.test(oid) || oid !== oid.toLowerCase()) { throw new Error('Reviewed commit binding contains an invalid Git object ID.'); }
		}
		if (typeof binding.rawDiffFingerprint !== 'string' || !SHA256_PATTERN.test(binding.rawDiffFingerprint)
			|| typeof binding.commitMessage !== 'string' || !binding.commitMessage.trim() || binding.commitMessage.includes('\0') || Buffer.byteLength(binding.commitMessage, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) {
			throw new Error('Reviewed commit binding message or diff fingerprint is invalid.');
		}
		if (!Array.isArray(binding.files) || !binding.files.length || binding.files.length > MAX_REVIEWED_FILES || !Array.isArray(binding.selectedPaths)
			|| binding.files.length !== binding.selectedPaths.length) { throw new Error('Reviewed commit binding selection is malformed.'); }
		const paths = new Set<string>();
		for (let index = 0; index < binding.files.length; index++) {
			const file = binding.files[index];
			if (!file || typeof file !== 'object' || Object.keys(file).some(key => !['path', 'before', 'after'].includes(key))) { throw new Error('Reviewed commit binding file contains unsupported fields.'); }
			this.validateReviewedPath(file.path);
			if (paths.has(file.path) || binding.selectedPaths[index] !== file.path) { throw new Error('Reviewed commit binding paths are duplicated or reordered.'); }
			paths.add(file.path);
			this.validateReviewedFileState(file.before, false);
			this.validateReviewedFileState(file.after, false);
			if ('absent' in file.before && 'absent' in file.after) { throw new Error('Reviewed commit binding contains an unchanged absent path.'); }
		}
		this.validateFrozenIdentity({ author: binding.author, committer: binding.committer });
	}

	private validateFrozenIdentity(value: unknown): { readonly author: ReviewedCommitIdentity; readonly committer: ReviewedCommitIdentity } {
		if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
			|| !Object.hasOwn(value, 'author') || !Object.hasOwn(value, 'committer')) {
			throw new Error('Frozen Git identities must include exactly one author and committer identity.');
		}
		const identities = value as { author?: unknown; committer?: unknown };
		const validate = (identity: unknown): ReviewedCommitIdentity => {
			if (!identity || typeof identity !== 'object' || Array.isArray(identity)) { throw new Error('Frozen Git identity is malformed.'); }
			const candidate = identity as Partial<ReviewedCommitIdentity>;
			if (Object.keys(identity).length !== 3 || Object.keys(identity).some(key => !['name', 'email', 'date'].includes(key))
				|| typeof candidate.name !== 'string' || !candidate.name.trim() || /[\r\n<>\0]/.test(candidate.name)
				|| typeof candidate.email !== 'string' || !candidate.email.trim() || /[\r\n<>\0]/.test(candidate.email)
				|| typeof candidate.date !== 'string' || !/^\d+ [+-]\d{4}$/.test(candidate.date)) {
				throw new Error('Frozen Git identity is malformed or incomplete.');
			}
			return Object.freeze({ name: candidate.name, email: candidate.email, date: candidate.date });
		};
		return Object.freeze({ author: validate(identities.author), committer: validate(identities.committer) });
	}

	private freezeApplyingRecord(operationId: string, binding: ReviewedCommitBinding): ReviewedCommitApplyingRecord {
		const frozenBinding: ReviewedCommitBinding = Object.freeze({
			state: 'candidate', ownerId: binding.ownerId, candidateCommitOid: binding.candidateCommitOid,
			sourceHead: binding.sourceHead, proposedTreeOid: binding.proposedTreeOid, rawDiffFingerprint: binding.rawDiffFingerprint,
			selectedPaths: Object.freeze([...binding.selectedPaths]), commitMessage: binding.commitMessage,
			author: Object.freeze({ ...binding.author }), committer: Object.freeze({ ...binding.committer }),
			files: Object.freeze(binding.files.map(file => Object.freeze({
				path: file.path, before: Object.freeze({ ...file.before }), after: Object.freeze({ ...file.after })
			})))
		});
		return Object.freeze({ operationId, binding: frozenBinding });
	}

	private applyingRecordsEqual(actual: ReviewedCommitApplyingRecord | undefined, expected: ReviewedCommitApplyingRecord): boolean {
		if (!actual || actual.operationId !== expected.operationId) { return false; }
		try { return JSON.stringify(this.freezeApplyingRecord(actual.operationId, actual.binding)) === JSON.stringify(expected); }
		catch { return false; }
	}

	private async assertReviewedCommitBinding(lease: ManagedWorktreeLease, binding: ReviewedCommitBinding): Promise<void> {
		if (lease.ownerId !== binding.ownerId || lease.kind !== 'session' || lease.state !== 'active' || lease.pendingOperation || lease.commonDirectory !== realpathSync(lease.commonDirectory)) {
			throw new Error('Reviewed commit binding does not identify the signed managed session lease.');
		}
		const commitData = await this.runGit(lease.worktreePath, ['cat-file', 'commit', binding.candidateCommitOid], { maxOutputBytes: 16 * 1024 });
		const separator = commitData.stdout.indexOf(Buffer.from('\n\n'));
		if (separator < 0) { throw new Error('Reviewed candidate commit has malformed headers.'); }
		const headers = commitData.stdout.subarray(0, separator).toString('utf8').split('\n');
		const expectedHeaders = [
			`tree ${binding.proposedTreeOid}`, `parent ${binding.sourceHead}`,
			`author ${binding.author.name} <${binding.author.email}> ${binding.author.date}`,
			`committer ${binding.committer.name} <${binding.committer.email}> ${binding.committer.date}`
		];
		if (headers.length !== expectedHeaders.length || headers.some((header, index) => header !== expectedHeaders[index])
			|| !commitData.stdout.subarray(separator + 2).equals(Buffer.from(`${binding.commitMessage}\n`, 'utf8'))) {
			throw new Error('Reviewed candidate commit differs from the durable message, tree, parent, or identity binding.');
		}
		if (await this.git(lease.worktreePath, ['rev-parse', `${binding.candidateCommitOid}^{tree}`]) !== binding.proposedTreeOid) { throw new Error('Reviewed candidate tree does not match its durable binding.'); }
		const changed = await this.runGit(lease.worktreePath, ['diff', '--name-only', '-z', '--no-renames', binding.sourceHead, binding.candidateCommitOid, '--']);
		const changedPaths = changed.stdout.toString('utf8').split('\0').filter(Boolean);
		if (changedPaths.length !== binding.selectedPaths.length || changedPaths.some(path => !binding.selectedPaths.includes(path))) {
			throw new Error('Reviewed candidate changes paths outside its durable selection.');
		}
		const rawDiff = await this.runGit(lease.worktreePath, ['diff', '--binary', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', binding.sourceHead, binding.candidateCommitOid, '--'], { maxOutputBytes: MAX_REVIEWED_DIFF_BYTES });
		if (createHash('sha256').update(rawDiff.stdout).digest('hex') !== binding.rawDiffFingerprint) { throw new Error('Reviewed candidate raw diff differs from its durable fingerprint.'); }
		for (const file of binding.files) {
			await this.assertBoundTreeEntry(lease.worktreePath, binding.sourceHead, file.path, file.before);
			await this.assertBoundTreeEntry(lease.worktreePath, binding.candidateCommitOid, file.path, file.after);
		}
	}

	private async assertBoundTreeEntry(cwd: string, treeish: string, path: string, expected: ReviewedFileBefore): Promise<void> {
		const entry = await this.lookupTreeEntry(cwd, treeish, path);
		if ('absent' in expected) {
			if (entry) { throw new Error(`Reviewed candidate path state differs from its binding: ${path}`); }
			return;
		}
		if (!entry || entry.type !== 'blob' || entry.mode !== expected.mode) { throw new Error(`Reviewed candidate path metadata differs from its binding: ${path}`); }
		const blob = await this.runGit(cwd, ['cat-file', 'blob', entry.oid], { maxOutputBytes: MAX_REVIEWED_FILE_BYTES });
		if (createHash('sha256').update(blob.stdout).digest('hex') !== expected.sha256.toLowerCase()) { throw new Error(`Reviewed candidate path content differs from its binding: ${path}`); }
	}

	private async readSessionRef(lease: ManagedWorktreeLease): Promise<string> {
		return this.git(lease.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${lease.branch}`]);
	}

	private reviewedCommitRecoveryResult(input: Pick<ReviewedCommitApplyInput, 'operationId' | 'binding'>, currentRef: string | undefined, indexState: 'unchanged' | 'reconciled' | 'unknown', reason: string): ReviewedCommitApplyResult {
		return {
			state: 'recoveryRequired', operationId: input.operationId, candidateCommitOid: input.binding.candidateCommitOid,
			sourceHead: input.binding.sourceHead, ...(currentRef ? { currentRef } : {}), indexState, reason
		};
	}

	private async readRealIndex(worktreePath: string): Promise<RealIndexSnapshot> {
		const indexOutput = (await this.git(worktreePath, ['rev-parse', '--git-path', 'index'])).trim();
		const indexPath = isAbsolute(indexOutput) ? indexOutput : resolve(worktreePath, indexOutput);
		const before = lstatSync(indexPath);
		if (!before.isFile() || before.isSymbolicLink()) { throw new Error('Managed worktree index must be a regular file, not a symlink.'); }
		const fd = openSync(indexPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) { throw new Error('Managed worktree index identity changed while opening.'); }
			const bytes = readFileSync(fd);
			return { path: indexPath, bytes, dev: opened.dev, ino: opened.ino, mode: opened.mode, size: opened.size, mtimeMs: opened.mtimeMs };
		} finally { closeSync(fd); }
	}

	private realIndexStillMatches(expected: RealIndexSnapshot): boolean {
		try {
			const current = this.readIndexAtPath(expected.path);
			return current.dev === expected.dev && current.ino === expected.ino && current.mode === expected.mode && current.size === expected.size
				&& current.mtimeMs === expected.mtimeMs && current.bytes.equals(expected.bytes);
		} catch { return false; }
	}

	private readIndexAtPath(indexPath: string): RealIndexSnapshot {
		const before = lstatSync(indexPath);
		if (!before.isFile() || before.isSymbolicLink()) { throw new Error('Managed worktree index changed to a non-regular file.'); }
		const fd = openSync(indexPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) { throw new Error('Managed worktree index identity changed while opening.'); }
			return { path: indexPath, bytes: readFileSync(fd), dev: opened.dev, ino: opened.ino, mode: opened.mode, size: opened.size, mtimeMs: opened.mtimeMs };
		} finally { closeSync(fd); }
	}

	private async indexEntries(worktreePath: string, indexPath: string, paths: readonly string[]): Promise<Map<string, readonly IndexEntry[]>> {
		const env = { GIT_INDEX_FILE: indexPath };
		const args = ['--literal-pathspecs', 'ls-files', '--stage', '-z', ...(paths.length ? ['--', ...paths] : [])];
		const output = await this.runGit(worktreePath, args, { env });
		const entries = new Map<string, IndexEntry[]>();
		for (const record of output.stdout.toString('utf8').split('\0').filter(Boolean)) {
			const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/.exec(record);
			if (!match) { throw new Error('Managed worktree index contains an unreadable entry.'); }
			const entry = { mode: match[1], oid: match[2], stage: Number(match[3]), path: match[4] };
			const list = entries.get(entry.path) ?? [];
			list.push(entry);
			entries.set(entry.path, list);
		}
		return entries;
	}

	private async indexEntryMatchesTree(worktreePath: string, entries: readonly IndexEntry[] | undefined, treeish: string, path: string): Promise<boolean> {
		const expected = await this.lookupTreeEntry(worktreePath, treeish, path);
		if (!expected) { return !entries?.length; }
		return entries?.length === 1 && entries[0].stage === 0 && entries[0].mode === expected.mode && entries[0].oid === expected.oid;
	}

	private async assertSelectedIndexEntriesSafe(worktreePath: string, binding: ReviewedCommitBinding, snapshot: RealIndexSnapshot): Promise<void> {
		const temporaryDirectory = join(this.root, `review-index-check-${randomUUID()}`);
		mkdirSync(temporaryDirectory, { mode: 0o700 });
		const privateIndex = join(temporaryDirectory, 'index');
		try {
			writeFileSync(privateIndex, snapshot.bytes, { flag: 'wx', mode: 0o600 });
			const entries = await this.indexEntries(worktreePath, privateIndex, binding.selectedPaths);
			for (const file of binding.files) {
				const actual = entries.get(file.path);
				if (!await this.indexEntryMatchesTree(worktreePath, actual, binding.sourceHead, file.path)
					&& !await this.indexEntryMatchesTree(worktreePath, actual, binding.candidateCommitOid, file.path)) {
					throw new Error(`Selected path has a unique staged version that cannot be safely replaced: ${file.path}`);
				}
			}
		} finally {
			for (const path of [privateIndex, `${privateIndex}.lock`]) { if (existsSync(path)) { unlinkSync(path); } }
			rmdirSync(temporaryDirectory);
		}
	}

	private acquireOwnedIndexLock(snapshot: RealIndexSnapshot): OwnedIndexLock {
		const path = `${snapshot.path}.lock`;
		const fd = openSync(path, 'wx', 0o600);
		const stat = fstatSync(fd);
		return { path, fd, dev: stat.dev, ino: stat.ino };
	}

	private writeOwnedIndexLock(lock: OwnedIndexLock, bytes: Buffer, indexMode: number): void {
		ftruncateSync(lock.fd, 0);
		fchmodSync(lock.fd, indexMode & 0o777);
		writeFileSync(lock.fd, bytes);
		fsyncSync(lock.fd);
	}

	private ownedIndexLockMatches(lock: OwnedIndexLock, expectedBytes: Buffer): boolean {
		let fd: number | undefined;
		try {
			const pathStat = lstatSync(lock.path);
			if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.dev !== lock.dev || pathStat.ino !== lock.ino) { return false; }
			fd = openSync(lock.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			const opened = fstatSync(fd);
			return opened.isFile() && opened.dev === lock.dev && opened.ino === lock.ino && readFileSync(fd).equals(expectedBytes);
		} catch { return false; }
		finally { if (fd !== undefined) { closeSync(fd); } }
	}

	private releaseOwnedIndexLock(lock: OwnedIndexLock, renamed: boolean): void {
		closeSync(lock.fd);
		if (renamed) { return; }
		try {
			const current = lstatSync(lock.path);
			if (current.dev === lock.dev && current.ino === lock.ino && current.isFile() && !current.isSymbolicLink()) { unlinkSync(lock.path); }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
		}
	}

	private async prepareReviewedCommitIndex(lease: ManagedWorktreeLease, binding: ReviewedCommitBinding, snapshot: RealIndexSnapshot): Promise<Buffer> {
		const temporaryDirectory = join(this.root, `review-index-update-${randomUUID()}`);
		mkdirSync(temporaryDirectory, { mode: 0o700 });
		const privateIndex = join(temporaryDirectory, 'index');
		try {
			await this.assertSelectedIndexEntriesSafe(lease.worktreePath, binding, snapshot);
			writeFileSync(privateIndex, snapshot.bytes, { flag: 'wx', mode: 0o600 });
			const selectedEntries = await this.indexEntries(lease.worktreePath, privateIndex, binding.selectedPaths);
			const allEntriesBefore = await this.indexEntries(lease.worktreePath, privateIndex, []);
			const input: Buffer[] = [];
			for (const file of binding.files) {
				const current = selectedEntries.get(file.path);
				if (await this.indexEntryMatchesTree(lease.worktreePath, current, binding.candidateCommitOid, file.path)) { continue; }
				if (!await this.indexEntryMatchesTree(lease.worktreePath, current, binding.sourceHead, file.path)) { throw new Error(`Selected path index state changed before safe reconciliation: ${file.path}`); }
				const entry = await this.lookupTreeEntry(lease.worktreePath, binding.candidateCommitOid, file.path);
				if (!entry) { input.push(Buffer.from(`0 ${'0'.repeat(binding.sourceHead.length)}\t${file.path}\0`, 'utf8')); }
				else { input.push(Buffer.from(`${entry.mode} ${entry.oid}\t${file.path}\0`, 'utf8')); }
			}
			if (!input.length) { return snapshot.bytes; }
			await this.runGit(lease.worktreePath, ['update-index', '--index-info', '-z'], { env: { GIT_INDEX_FILE: privateIndex }, input: Buffer.concat(input) });
			const allEntriesAfter = await this.indexEntries(lease.worktreePath, privateIndex, []);
			if (!this.unrelatedIndexEntriesMatch(allEntriesBefore, allEntriesAfter, new Set(binding.selectedPaths))) {
				throw new Error('Private index reconciliation changed an unrelated staged entry.');
			}
			return readFileSync(privateIndex);
		} finally {
			for (const path of [privateIndex, `${privateIndex}.lock`]) { if (existsSync(path)) { unlinkSync(path); } }
			rmdirSync(temporaryDirectory);
		}
	}

	private async assertIndexMatchesReviewedCommit(lease: ManagedWorktreeLease, binding: ReviewedCommitBinding, expectedBytes: Buffer): Promise<void> {
		const indexOutput = await this.git(lease.worktreePath, ['rev-parse', '--git-path', 'index']);
		const indexPath = isAbsolute(indexOutput) ? indexOutput : resolve(lease.worktreePath, indexOutput);
		const snapshot = this.readIndexAtPath(indexPath);
		if (!snapshot.bytes.equals(expectedBytes)) { throw new Error('Reconciled index content changed immediately after atomic replacement.'); }
		const entries = await this.indexEntries(lease.worktreePath, snapshot.path, binding.selectedPaths);
		for (const file of binding.files) {
			if (!await this.indexEntryMatchesTree(lease.worktreePath, entries.get(file.path), binding.candidateCommitOid, file.path)) {
				throw new Error(`Reconciled index does not contain the approved path state: ${file.path}`);
			}
		}
	}

	private async reconcileReviewedCommitIndex(lease: ManagedWorktreeLease, binding: ReviewedCommitBinding): Promise<void> {
		const snapshot = await this.readRealIndex(lease.worktreePath);
		const lock = this.acquireOwnedIndexLock(snapshot);
		let renamed = false;
		try {
			if (!this.realIndexStillMatches(snapshot)) { throw new Error('Real index changed while reserving its lock; recovery is required.'); }
			const updatedBytes = await this.prepareReviewedCommitIndex(lease, binding, snapshot);
			this.writeOwnedIndexLock(lock, updatedBytes, snapshot.mode);
			if (!this.realIndexStillMatches(snapshot) || !this.ownedIndexLockMatches(lock, updatedBytes)) { throw new Error('Real index or owned lock changed during recovery.'); }
			if (!updatedBytes.equals(snapshot.bytes)) {
				renameSync(lock.path, snapshot.path);
				renamed = true;
				const directoryFd = openSync(dirname(snapshot.path), 'r');
				try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
			}
			await this.assertIndexMatchesReviewedCommit(lease, binding, updatedBytes);
		} finally {
			this.releaseOwnedIndexLock(lock, renamed);
		}
	}

	private unrelatedIndexEntriesMatch(before: Map<string, readonly IndexEntry[]>, after: Map<string, readonly IndexEntry[]>, selectedPaths: ReadonlySet<string>): boolean {
		const normalize = (entries: Map<string, readonly IndexEntry[]>): string => [...entries.entries()]
			.filter(([path]) => !selectedPaths.has(path))
			.flatMap(([, values]) => values.map(entry => `${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}`))
			.sort().join('\0');
		return normalize(before) === normalize(after);
	}

	private validateReviewedPath(path: string): void {
		if (typeof path !== 'string' || !path || Buffer.byteLength(path, 'utf8') > 4096 || path.includes('\0') || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) { throw new Error('Reviewed file path must be a bounded relative path.'); }
		const segments = path.split('/');
		if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) { throw new Error('Reviewed file path contains a forbidden component.'); }
	}

	private validateReviewedFileState(value: ReviewedFileBefore | ReviewedFileAfter, allowBytes: boolean): void {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Reviewed file state is malformed.'); }
		if ('absent' in value) {
			if (Object.keys(value).length !== 1 || value.absent !== true) { throw new Error('Absent file state is malformed.'); }
			return;
		}
		const expectedKeys = allowBytes ? ['mode', 'sha256', 'bytes'] : ['mode', 'sha256'];
		if (Object.keys(value).some(key => !expectedKeys.includes(key)) || !FILE_MODES.has(value.mode) || typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) { throw new Error('Reviewed file metadata is malformed.'); }
		if (!allowBytes && 'bytes' in value) { throw new Error('Before-file metadata cannot include file bytes.'); }
		if (allowBytes && !('bytes' in value)) { throw new Error('Present after-file state requires retained bytes.'); }
	}

	private retainReviewedFiles(files: readonly ReviewedCommitFileInput[]): StoredReviewedCommitPreview['files'] {
		return files.map(file => {
			const before = 'absent' in file.before ? { absent: true as const } : { mode: file.before.mode, sha256: file.before.sha256.toLowerCase() };
			const after = 'absent' in file.after ? { absent: true as const } : { mode: file.after.mode, sha256: file.after.sha256.toLowerCase() };
			return { path: file.path, before, after, ...('bytes' in file.after ? { bytes: Buffer.from(file.after.bytes) } : {}) };
		});
	}

	private validateRetainedFileBytes(files: StoredReviewedCommitPreview['files']): void {
		let totalBytes = 0;
		for (const file of files) {
			if (!file.bytes) { continue; }
			totalBytes += file.bytes.byteLength;
			if (file.bytes.byteLength > MAX_REVIEWED_FILE_BYTES || totalBytes > MAX_REVIEWED_TOTAL_BYTES) { throw new Error('Reviewed retained bytes exceed configured file or total limits.'); }
			if (createHash('sha256').update(file.bytes).digest('hex') !== file.after.sha256) { throw new Error('Reviewed retained bytes changed while being captured.'); }
		}
	}

	private assertReviewedSource(lease: ManagedWorktreeLease, sourceHead: string): void {
		if (lease.kind !== 'session' || lease.state !== 'active' || lease.pendingOperation || lease.head !== sourceHead) { throw new Error('Reviewed commit source does not match an active managed session lease.'); }
	}

	private async assertReviewedSourceStillCurrent(ownerId: string, sourceHead: string): Promise<void> {
		const current = await this.readAndValidate(ownerId);
		this.assertReviewedSource(current, sourceHead);
		const head = await this.git(current.worktreePath, ['rev-parse', 'HEAD']);
		const branchHead = await this.git(current.worktreePath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${current.branch}`]);
		if (head !== sourceHead || branchHead !== sourceHead) { throw new Error('Reviewed commit source HEAD changed while preparing the candidate.'); }
	}

	private async readCommitIdentity(cwd: string, variable: 'GIT_AUTHOR_IDENT' | 'GIT_COMMITTER_IDENT'): Promise<ReviewedCommitIdentity> {
		const value = (await this.runGit(cwd, ['var', variable])).stdout.toString('utf8').trimEnd();
		const match = /^(.*) <([^<>]+)> ([0-9]+ [+-][0-9]{4})$/.exec(value);
		if (!match || !match[1].trim() || !match[2].trim() || /[\r\n<>]/.test(match[1]) || /[\r\n<>]/.test(match[2])) { throw new Error(`Effective ${variable === 'GIT_AUTHOR_IDENT' ? 'author' : 'committer'} identity is unavailable.`); }
		return { name: match[1], email: match[2], date: match[3] };
	}

	private commitIdentityEnvironment(author: ReviewedCommitIdentity, committer: ReviewedCommitIdentity): NodeJS.ProcessEnv {
		return {
			GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date,
			GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: committer.date
		};
	}

	private async assertCandidateCommitMetadata(cwd: string, commitOid: string, preview: ReviewedCommitPreview): Promise<void> {
		const commit = (await this.runGit(cwd, ['cat-file', 'commit', commitOid], { maxOutputBytes: 16 * 1024 })).stdout;
		const separator = commit.indexOf(Buffer.from('\n\n'));
		if (separator < 0) { throw new Error('Candidate commit object has malformed headers.'); }
		const headers = commit.subarray(0, separator).toString('utf8').split('\n');
		const expected = [
			`tree ${preview.proposedTreeOid}`,
			`parent ${preview.sourceHead}`,
			`author ${preview.author.name} <${preview.author.email}> ${preview.author.date}`,
			`committer ${preview.committer.name} <${preview.committer.email}> ${preview.committer.date}`,
		];
		if (headers.length !== expected.length || headers.some((value, index) => value !== expected[index])) { throw new Error('Candidate commit headers differ from the exact frozen preview.'); }
		const message = commit.subarray(separator + 2);
		if (!message.equals(Buffer.from(`${preview.commitMessage}\n`, 'utf8'))) { throw new Error('Candidate commit message differs from its frozen preview.'); }
	}

	private async prepareReviewedTree(lease: ManagedWorktreeLease, sourceHead: string, files: StoredReviewedCommitPreview['files']): Promise<PreparedReviewedTree> {
		const temporaryDirectory = join(this.root, `commit-index-${randomUUID()}`);
		mkdirSync(temporaryDirectory, { mode: 0o700 });
		const indexPath = join(temporaryDirectory, 'index');
		try {
			const indexEnv = { GIT_INDEX_FILE: indexPath };
			await this.runGit(lease.worktreePath, ['read-tree', sourceHead], { env: indexEnv });
			const entries: Buffer[] = [];
			for (const file of files) {
				const current = await this.lookupTreeEntry(lease.worktreePath, sourceHead, file.path);
				if ('absent' in file.before) {
					if (current) { throw new Error(`Reviewed source path was expected to be absent: ${file.path}`); }
				} else {
					if (!current || current.mode !== file.before.mode || current.type !== 'blob') { throw new Error(`Reviewed source path metadata changed: ${file.path}`); }
					const bytes = await this.runGit(lease.worktreePath, ['cat-file', 'blob', current.oid], { maxOutputBytes: MAX_REVIEWED_FILE_BYTES });
					if (createHash('sha256').update(bytes.stdout).digest('hex') !== file.before.sha256) { throw new Error(`Reviewed source path content changed: ${file.path}`); }
				}
				if ('absent' in file.after) {
					entries.push(Buffer.from(`0 ${'0'.repeat(sourceHead.length)}\t${file.path}\0`, 'utf8'));
				} else {
					if (!file.bytes) { throw new Error(`Retained after-file bytes are unavailable: ${file.path}`); }
					const blobOid = (await this.runGit(lease.worktreePath, ['hash-object', '-w', '--stdin', '--no-filters'], { input: file.bytes })).stdout.toString('utf8').trim();
					if (!OBJECT_ID_PATTERN.test(blobOid)) { throw new Error('Git returned an invalid file object ID.'); }
					entries.push(Buffer.from(`${file.after.mode} ${blobOid}\t${file.path}\0`, 'utf8'));
				}
			}
			await this.runGit(lease.worktreePath, ['update-index', '--index-info', '-z'], { env: indexEnv, input: Buffer.concat(entries) });
			const treeOid = (await this.runGit(lease.worktreePath, ['write-tree'], { env: indexEnv })).stdout.toString('utf8').trim();
			if (!OBJECT_ID_PATTERN.test(treeOid)) { throw new Error('Git returned an invalid proposed tree ID.'); }
			const changed = await this.runGit(lease.worktreePath, ['diff', '--cached', '--name-only', '-z', '--no-renames', sourceHead, '--'], { env: indexEnv });
			const changedPaths = changed.stdout.toString('utf8').split('\0').filter(Boolean).sort();
			const selectedPaths = files.map(file => file.path).sort();
			if (changedPaths.length === 0 || changedPaths.length !== selectedPaths.length || changedPaths.some((path, index) => path !== selectedPaths[index])) { throw new Error('Prepared Git tree changed paths outside the explicit review selection or contains no changes.'); }
			const diff = (await this.runGit(lease.worktreePath, ['diff', '--cached', '--binary', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', sourceHead, '--'], { env: indexEnv, maxOutputBytes: MAX_REVIEWED_DIFF_BYTES })).stdout;
			if (diff.length === 0) { throw new Error('Reviewed commit has no changes.'); }
			return { treeOid, rawDiffFingerprint: createHash('sha256').update(diff).digest('hex') };
		} finally {
			for (const path of [indexPath, `${indexPath}.lock`]) { if (existsSync(path)) { unlinkSync(path); } }
			rmdirSync(temporaryDirectory);
		}
	}

	private async lookupTreeEntry(cwd: string, sourceHead: string, path: string): Promise<{ mode: string; type: string; oid: string } | undefined> {
		const output = await this.runGit(cwd, ['--literal-pathspecs', 'ls-tree', '-z', sourceHead, '--', path]);
		if (output.stdout.length === 0) { return undefined; }
		const records = output.stdout.toString('utf8').split('\0').filter(Boolean);
		if (records.length !== 1) { throw new Error(`Reviewed source path is ambiguous: ${path}`); }
		const match = /^([0-7]{6}) (blob|tree) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(records[0]);
		if (!match || match[4] !== path) { throw new Error(`Reviewed source path did not resolve exactly: ${path}`); }
		return { mode: match[1], type: match[2], oid: match[3] };
	}

	private expireCommitPreviews(): void {
		const now = Date.now();
		for (const [id, stored] of this.commitPreviews) { if (stored.preview.expiresAt <= now) { this.commitPreviews.delete(id); } }
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
			|| !['merge', 'remove', 'prepareCommit', 'applyReviewedCommit'].includes(lock.operation) || !Number.isSafeInteger(lock.pid) || lock.pid <= 0
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

	private async runGit(cwd: string, args: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly input?: Buffer; readonly maxOutputBytes?: number } = {}): Promise<{ stdout: Buffer; stderr: Buffer }> {
		return this.runCommand('git', ['-C', cwd, ...args], COMMAND_TIMEOUT_MS, options);
	}

	private runCommand(command: string, args: readonly string[], timeoutMs: number, options: { readonly env?: NodeJS.ProcessEnv; readonly input?: Buffer; readonly maxOutputBytes?: number } = {}): Promise<{ stdout: Buffer; stderr: Buffer }> {
		return new Promise((resolvePromise, rejectPromise) => {
			const child = spawn(command, args, { detached: process.platform !== 'win32', env: this.gitEnvironment(options.env), shell: false, stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
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
				if (buffered > (options.maxOutputBytes ?? MAX_BUFFER_BYTES)) {
					if (!outputExceeded) { outputExceeded = true; terminate(); }
					return;
				}
				target.push(chunk);
			};
			child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
			child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
			child.on('error', error => { spawnError = error; });
			if (options.input) {
				child.stdin.on('error', error => { spawnError ??= error; });
				child.stdin.end(options.input);
			}
			child.on('close', async (code, signal) => {
				clearTimeout(timeout);
				if (terminationRequested) { await cleanupPromise; }
				const out = Buffer.concat(stdout);
				const err = Buffer.concat(stderr);
				if (spawnError) { rejectPromise(spawnError); }
				else if (timedOut) { rejectPromise(new Error(`${command} exceeded its ${timeoutMs}ms timeout and its owned process group was terminated.`)); }
				else if (outputExceeded) { rejectPromise(new Error(`${command} exceeded the ${options.maxOutputBytes ?? MAX_BUFFER_BYTES}-byte output limit and its owned process group was terminated.`)); }
				else if (code !== 0) { rejectPromise(new Error(`${command} exited with ${signal ?? code}: ${err.toString('utf8').trim()}`)); }
				else { resolvePromise({ stdout: out, stderr: err }); }
			});
		});
	}

	private gitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
		const env = { ...process.env };
		const allowedGitVariables = new Set(['GIT_CONFIG_GLOBAL', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']);
		for (const key of Object.keys(env)) {
			if (key.startsWith('GIT_') && !allowedGitVariables.has(key)) { delete env[key]; }
		}
		env.GIT_OPTIONAL_LOCKS = '0';
		for (const [key, value] of Object.entries(overrides)) {
			if (!key.startsWith('GIT_')) { throw new Error('Internal Git environment override is invalid.'); }
			if (value === undefined) { delete env[key]; } else { env[key] = value; }
		}
		return env;
	}

	private sign(value: object): string {
		return createHmac('sha256', this.manifestKey).update(JSON.stringify(value)).digest('hex');
	}

	private manifestPath(ownerId: string): string { return join(this.root, `${ownerId}.json`); }
	private validateOwnerId(ownerId: string): void { if (!UUID_PATTERN.test(ownerId)) { throw new Error('Managed worktree owner ID must be a UUID.'); } }
	private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
