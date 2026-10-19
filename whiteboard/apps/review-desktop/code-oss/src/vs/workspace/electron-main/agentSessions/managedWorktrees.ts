/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
	AgentSessionMergeConflictArtifact,
	AgentSessionMergeResolutionDTO,
	AgentSessionMergeArtifactEvent,
	AgentSessionMergeArtifactRecord,
	AgentSessionMergeProposalDTO,
} from '../../common/workspaceAgentMergeProtocol.js';
import type { AgentSessionIntegrationGitIdentity } from '../../common/workspaceAgentIntegrationProtocol.js';
import { publicationEnvironment, runPublicationProcess, verifyPublicationExecutable, type PublicationExecutable } from './agentPublicationProcess.js';

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
const MAX_ACTIVE_MERGE_PREVIEWS = 16;
const MAX_MERGE_CHANGED_PATHS = 300;
const MAX_MERGE_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_INTEGRATION_GENERATIONS = 32;
const MAX_GENERATION_TREE_ENTRIES = 25_000;
const MAX_GENERATION_TREE_BYTES = 256 * 1024 * 1024;
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
	readonly generationId?: string;
	readonly registrationId?: string;
	readonly generations?: readonly ManagedWorktreeGeneration[];
}

interface ManagedWorktreeGeneration {
	readonly generationId: string;
	readonly worktreePath: string;
	readonly registrationId: string;
	readonly head: string;
	readonly treeOid: string;
	readonly indexDigest: string;
	readonly treeDigest: string;
}

interface PendingOperation {
	readonly id: string;
	readonly kind: 'merge' | 'remove';
	readonly startedAt: number;
	readonly proposalId?: string;
	readonly proposalFingerprint?: string;
	readonly sourceOwnerId?: string;
	readonly sourceHead?: string;
	readonly targetHead?: string;
	readonly mergeBase?: string;
	readonly diffFingerprint?: string;
	readonly expectedHead?: string;
	readonly retainedIntegrationOwnerId?: string;
	readonly generationId?: string;
	readonly generationPath?: string;
	readonly registrationId?: string;
}

interface OperationReceipt {
	readonly id: string;
	readonly kind: 'merge' | 'remove';
	readonly outcome: 'merged' | 'conflict' | 'notApplied' | 'removed';
	readonly commit?: string;
	readonly reconciled?: boolean;
	readonly proposalId?: string;
	readonly proposalFingerprint?: string;
	readonly sourceOwnerId?: string;
	readonly sourceHead?: string;
	readonly targetHead?: string;
	readonly mergeBase?: string;
	readonly diffFingerprint?: string;
	readonly conflictedPaths?: readonly string[];
}

export interface MergePreview {
	readonly resolution?: AgentSessionMergeResolutionDTO;
	readonly previewId: string;
	readonly integrationOwnerId: string;
	readonly sessionOwnerId: string;
	readonly sourceHead: string;
	readonly targetHead: string;
	readonly mergeBase: string;
	readonly diffHash: string;
	readonly diffText: string;
	readonly changedPaths: readonly string[];
	readonly commitMessage: string;
	readonly author: AgentSessionIntegrationGitIdentity;
	readonly committer: AgentSessionIntegrationGitIdentity;
	readonly expiresAt: number;
}

export interface ReviewedMergeApplyingRecord {
	readonly operationId: string;
	readonly proposalId: string;
	readonly proposalFingerprint: string;
	readonly integrationOwnerId: string;
	readonly sessionOwnerId: string;
	readonly sourceHead: string;
	readonly targetHead: string;
	readonly mergeBase: string;
	readonly diffFingerprint: string;
	readonly commitMessage: string;
	readonly author: AgentSessionIntegrationGitIdentity;
	readonly committer: AgentSessionIntegrationGitIdentity;
}

export interface ReviewedMergeJournal {
	readonly recordApplying: (record: ReviewedMergeApplyingRecord) => Promise<void>;
	readonly readApplying: (operationId: string) => Promise<ReviewedMergeApplyingRecord | undefined>;
	readonly recordArtifact: (operationId: string, expectedRevision: number, event: AgentSessionMergeArtifactEvent) => Promise<AgentSessionMergeArtifactRecord>;
	readonly readArtifacts: (operationId: string) => Promise<readonly AgentSessionMergeArtifactRecord[]>;
}

function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function decodeGitUtf8(bytes: Buffer): string {
	try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
	catch { throw new Error('Git output contains invalid UTF-8 paths; materialization is unavailable.'); }
}

function sameMergeApplyingRecord(left: ReviewedMergeApplyingRecord, right: ReviewedMergeApplyingRecord): boolean {
	const expectedKeys = ['author', 'committer', 'commitMessage', 'diffFingerprint', 'integrationOwnerId', 'mergeBase', 'operationId', 'proposalFingerprint', 'proposalId', 'sessionOwnerId', 'sourceHead', 'targetHead'].sort(compareCodeUnits);
	if (Object.keys(left).sort(compareCodeUnits).some((key, index) => key !== expectedKeys[index]) || Object.keys(left).length !== expectedKeys.length) { return false; }
	return left.operationId === right.operationId && left.proposalId === right.proposalId && left.proposalFingerprint === right.proposalFingerprint
		&& left.integrationOwnerId === right.integrationOwnerId && left.sessionOwnerId === right.sessionOwnerId
		&& left.sourceHead === right.sourceHead && left.targetHead === right.targetHead && left.mergeBase === right.mergeBase
		&& left.diffFingerprint === right.diffFingerprint && left.commitMessage === right.commitMessage
		&& JSON.stringify(left.author) === JSON.stringify(right.author) && JSON.stringify(left.committer) === JSON.stringify(right.committer);
}

function mergeReceipt(pending: PendingOperation, outcome: 'merged' | 'conflict' | 'notApplied', commit?: string, conflictedPaths?: readonly string[], reconciled?: boolean): OperationReceipt {
	return {
		id: pending.id, kind: 'merge', outcome,
		...(commit !== undefined ? { commit } : {}), ...(reconciled !== undefined ? { reconciled } : {}),
		...(pending.proposalId !== undefined ? { proposalId: pending.proposalId } : {}),
		...(pending.proposalFingerprint !== undefined ? { proposalFingerprint: pending.proposalFingerprint } : {}),
		...(pending.sourceOwnerId !== undefined ? { sourceOwnerId: pending.sourceOwnerId } : {}),
		...(pending.sourceHead !== undefined ? { sourceHead: pending.sourceHead } : {}),
		...(pending.targetHead !== undefined ? { targetHead: pending.targetHead } : {}),
		...(pending.mergeBase !== undefined ? { mergeBase: pending.mergeBase } : {}),
		...(pending.diffFingerprint !== undefined ? { diffFingerprint: pending.diffFingerprint } : {}),
		...(conflictedPaths !== undefined ? { conflictedPaths: [...conflictedPaths].sort(compareCodeUnits) } : {})
	};
}

export type ReviewedMergeResult =
	| { readonly state: 'merged'; readonly commit: string; readonly integration: ManagedWorktreeLease }
	| { readonly state: 'conflict'; readonly integration: ManagedWorktreeLease; readonly conflictedPaths: readonly string[] }
	| { readonly state: 'notApplied'; readonly operationId: string; readonly integration: ManagedWorktreeLease }
	| { readonly state: 'recoveryRequired'; readonly operationId: string; readonly reason: string };

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
interface SafeMergeContext { readonly root: string; readonly gitDirectory: string; readonly objectDirectory: string; readonly environment: NodeJS.ProcessEnv; }
interface MergeTreeResult { readonly treeOid: string; readonly clean: boolean; readonly conflicts: readonly AgentSessionMergeConflictArtifact[]; }
export interface MergeResolutionSource {
	readonly proposalId: string;
	readonly operationId: string;
	readonly sourceHead: string;
	readonly targetHead: string;
	readonly mergeBase: string;
	readonly generationId: string;
	readonly registrationId: string;
}
interface RegisteredGeneration { readonly generationId: string; readonly registrationId: string; readonly worktreePath: string; readonly indexPath: string; readonly head: string; }

interface StoredReviewedCommitPreview {
	readonly preview: ReviewedCommitPreview;
	readonly files: readonly { readonly path: string; readonly before: ReviewedFileBefore; readonly after: ReviewedFileBefore; readonly bytes?: Buffer }[];
}
interface PreparedReviewedTree { readonly treeOid: string; readonly rawDiffFingerprint: string; }

interface LeaseManifest extends ManagedWorktreeLease { readonly version: 1 | 2; readonly signature: string; }
interface LeaseManifestPayload extends ManagedWorktreeLease { readonly version: 1 | 2; }
interface OperationLock { readonly ownerId: string; readonly operation: 'merge' | 'remove' | 'ensureIntegration' | 'prepareCommit' | 'applyReviewedCommit' | 'publication'; readonly operationId: string; readonly pid: number; readonly processStart: string; readonly signature: string; }

/** Host-only capability. No source path, lock token, or private Git context is exposed. */
export interface ManagedPublicationInput { readonly repositoryPath: string; readonly remoteName: string; readonly merge: AgentSessionMergeProposalDTO; }
export interface ManagedPublicationLease {
	exportPinned(input: ManagedPublicationInput): Promise<{ readonly pack: Buffer; readonly canonicalUrl: string }>;
	assertPinned(input: ManagedPublicationInput): Promise<{ readonly canonicalUrl: string }>;
	release(): Promise<void>;
}

/** App-profile-owned Git worktrees. A merge preview is an exact, expiring snapshot, not approval. */
export class ManagedWorktreeService {
	private readonly root: string;
	private readonly previews = new Map<string, MergePreview>();
	private readonly commitPreviews = new Map<string, StoredReviewedCommitPreview>();
	private activeCommitPreparations = 0;
	private readonly keyPath: string;
	private readonly manifestKey: Buffer;
	// Async-local routing prevents a concurrent ordinary manager call from inheriting
	// publication's executable/config authority, or vice versa.
	private readonly publicationReads = new AsyncLocalStorage<{ readonly git: PublicationExecutable; readonly home: string }>();

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

	/** Acquisition deliberately does not require a current generation: recovery is read-only. */
	async acquirePublicationLease(integrationOwnerId: string, git: PublicationExecutable): Promise<ManagedPublicationLease> {
		const pinnedGit = { ...git };
		const root = lstatSync(this.root);
		if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(this.root) !== this.root || (root.mode & 0o077) !== 0
			|| (process.getuid && root.uid !== process.getuid())) { throw new Error('Publication manager directory ownership is invalid.'); }
		await verifyPublicationExecutable(pinnedGit);
		const lock = await this.acquireIntegrationLock(integrationOwnerId, 'publication');
		let exporting = false;
		const inspectPinned = async (input: ManagedPublicationInput, includePack: boolean): Promise<{ readonly pack?: Buffer; readonly canonicalUrl: string }> => {
			lock.assertOwned();
			if (exporting) { throw new Error('A publication export is already using this lease.'); }
			exporting = true;
			let home: string | undefined;
			let pack: Buffer | undefined;
			try {
				home = mkdtempSync(join(this.root, '.publication-read-'));
				const result = await this.publicationReads.run({ git: pinnedGit, home }, async () => {
					const merge = structuredClone(input.merge);
					const lease = await this.readAndValidate(integrationOwnerId);
					this.assertPublicationSource(lease, input.repositoryPath, merge);
					const canonicalUrl = await this.publicationRemote(lease.repositoryPath, input.remoteName);
					if (!includePack) { lock.assertOwned(); return { canonicalUrl }; }
					const context = await this.createSafeMergeContext(lease, false);
					try {
						// No thin pack, replacement refs, lazy fetching, mutable checkout staging,
						// or user-configured transport is involved. Include the complete closure.
						pack = (await this.safeMergeGit(context, lease.worktreePath,
							['pack-objects', '--stdout', '--revs', '--no-reuse-delta', '--no-reuse-object', '--threads=1'],
							{ input: Buffer.from(`${lease.head}\n`, 'ascii'), maxOutputBytes: 128 * 1024 * 1024 })).stdout;
						lock.assertOwned();
						this.assertPublicationSource(await this.readAndValidate(integrationOwnerId), input.repositoryPath, merge);
						if (canonicalUrl !== await this.publicationRemote(lease.repositoryPath, input.remoteName)) { throw new Error('Publication remote changed during source export.'); }
						return { pack, canonicalUrl };
					} finally { this.removeSafeMergeContext(context); }
				});
				return result;
			} catch (error) { pack?.fill(0); throw error; }
			finally {
				try { if (home) { this.removeSafeMergeContext({ root: home, gitDirectory: '', objectDirectory: '', environment: {} }); } }
				catch (error) { pack?.fill(0); throw error; }
				finally { exporting = false; }
			}
		};
		return {
			exportPinned: async input => {
				const result = await inspectPinned(input, true);
				if (!result.pack) { throw new Error('Publication pack export returned no pack.'); }
				return { pack: result.pack, canonicalUrl: result.canonicalUrl };
			},
			assertPinned: async input => ({ canonicalUrl: (await inspectPinned(input, false)).canonicalUrl }),
			release: async () => {
				if (exporting) { throw new Error('A publication export must finish before releasing its lease.'); }
				lock.release();
			},
		};
	}

	private assertPublicationSource(lease: ManagedWorktreeLease, repositoryPath: string, merge: AgentSessionMergeProposalDTO): void {
		const receipt = merge.outcomes.at(-1)?.receipt;
		const published = merge.artifacts.at(-1)?.event;
		const intent = merge.artifacts.find(record => record.event.phase === 'intent')?.event;
		const registered = merge.artifacts.find(record => record.event.phase === 'generationRegistered')?.event;
		const materialized = merge.artifacts.find(record => record.event.phase === 'generationMaterialized')?.event;
		const candidate = merge.artifacts.find(record => record.event.phase === 'candidatePrepared')?.event;
		const generation = lease.generations?.find(item => item.generationId === lease.generationId);
		const last = lease.lastOperation;
		if (merge.kind !== 'merge' || merge.state !== 'merged' || merge.outcomes.at(-1)?.state !== 'merged'
			|| merge.artifacts.length !== 5 || merge.artifacts.some((record, index) => record.revision !== index + 1)
			|| !receipt || !last || !generation || !merge.approval || merge.approval.proposalFingerprint !== merge.fingerprint
			|| lease.kind !== 'integration' || lease.state !== 'active' || lease.pendingOperation
			|| lease.repositoryPath !== repositoryPath || realpathSync(repositoryPath) !== repositoryPath
			|| merge.integrationOwnerId !== lease.ownerId || receipt.integrationOwnerId !== lease.ownerId
			|| receipt.proposalId !== merge.id || receipt.proposalFingerprint !== merge.fingerprint
			|| receipt.resultingHead !== lease.head || last.kind !== 'merge' || last.outcome !== 'merged'
			|| last.id !== receipt.operationId || last.commit !== lease.head || last.proposalId !== merge.id || last.proposalFingerprint !== merge.fingerprint
			|| last.sourceOwnerId !== merge.sessionOwnerId || last.sourceHead !== merge.sourceHead || last.targetHead !== merge.targetHead
			|| last.mergeBase !== merge.mergeBase || last.diffFingerprint !== merge.diffFingerprint
			|| published?.phase !== 'published' || published.targetRef !== `refs/heads/${lease.branch}` || published.resultingHead !== lease.head
			|| published.currentGenerationId !== lease.generationId || intent?.phase !== 'intent' || intent.generationId !== lease.generationId
			|| intent.priorGeneration?.generationId !== (published.priorGenerationId ?? undefined)
			|| registered?.phase !== 'generationRegistered' || registered.registrationId !== lease.registrationId || registered.generationPath !== this.generationArtifactPathFromLease(lease.ownerId, generation)
			|| intent.registrationId !== registered.registrationId || intent.generationPath !== registered.generationPath
			|| candidate?.phase !== 'candidatePrepared' || candidate.outcome !== 'clean' || candidate.candidateCommitOid !== lease.head || candidate.candidateTreeOid !== generation.treeOid
			|| materialized?.phase !== 'generationMaterialized' || materialized.head !== lease.head || materialized.conflictDigest !== null
			|| materialized.indexDigest !== generation.indexDigest || materialized.treeDigest !== generation.treeDigest) {
			throw new Error('Publication source no longer matches its signed generation and successful merge artifact.');
		}
	}

	private async publicationRemote(repositoryPath: string, remoteName: string): Promise<string> {
		if (!/^[A-Za-z0-9._-]{1,64}$/u.test(remoteName)) { throw new Error('Publication remote name is invalid.'); }
		// Read literal local config without includes. Never ask Git to expand a URL,
		// honor a rewrite, select a push default, or execute a remote helper.
		const bytes = await this.gitBuffer(repositoryPath, ['config', '--local', '--no-includes', '--null', '--list']);
		const values = new Map<string, string[]>();
		for (const record of decodeGitUtf8(bytes).split('\0').filter(Boolean)) {
			const separator = record.indexOf('\n');
			const key = (separator < 0 ? record : record.slice(0, separator));
			const lower = key.toLowerCase();
			if (lower.startsWith('include.') || lower.startsWith('includeif.') || /^url\..*\.(insteadof|pushinsteadof)$/u.test(lower)
				|| lower === 'extensions.worktreeconfig' || lower === 'remote.pushdefault') { throw new Error('Publication does not support included, rewritten, or worktree-specific remote configuration.'); }
			values.set(key, [...(values.get(key) ?? []), separator < 0 ? '' : record.slice(separator + 1)]);
		}
		const urls = values.get(`remote.${remoteName}.url`) ?? [];
		const pushUrls = values.get(`remote.${remoteName}.pushurl`) ?? [];
		if (urls.length !== 1 || pushUrls.length > 1 || (pushUrls.length === 1 && pushUrls[0] !== urls[0])
			|| values.has(`remote.${remoteName}.vcs`) || values.has(`remote.${remoteName}.receivepack`) || values.has(`remote.${remoteName}.uploadpack`)) {
			throw new Error('Publication requires one exact canonical GitHub remote without helper overrides.');
		}
		const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/u.exec(urls[0]);
		if (!match || match[2] === '.' || match[2] === '..') { throw new Error('Publication remote is unsupported; an exact github.com HTTPS or Git SSH remote is required.'); }
		return `https://github.com/${match[1]}/${match[2]}.git`;
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
		if (lease.pendingOperation?.kind === 'merge') { return { ...lease, state: 'recoveryRequired' }; }
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

	async ensureIntegrationTarget(input: { readonly ownerId: string; readonly sessionOwnerId: string }): Promise<ManagedWorktreeLease> {
		this.validateOwnerId(input.ownerId);
		this.validateOwnerId(input.sessionOwnerId);
		const initialSource = await this.readAndValidate(input.sessionOwnerId);
		this.assertMergeSourceReady(initialSource);
		return this.withIntegrationLock(input.ownerId, 'ensureIntegration', async () => {
			const source = await this.readAndValidate(input.sessionOwnerId);
			this.assertMergeSourceReady(source);
			if (existsSync(this.manifestPath(input.ownerId))) {
				const integration = await this.readAndValidate(input.ownerId);
				if (integration.kind !== 'integration' || integration.commonDirectory !== source.commonDirectory || integration.repositoryPath !== source.repositoryPath) {
					throw new Error('The owned integration target does not belong to the source session repository.');
				}
				if (integration.pendingOperation) { return { ...integration, state: 'recoveryRequired' }; }
				return integration;
			}
			const worktreePath = join(this.root, 'integration', input.ownerId);
			const branch = `bugfixer/integration/${input.ownerId}`;
			if (existsSync(worktreePath) || await this.git(source.repositoryPath, ['branch', '--list', branch])) {
				throw new Error('An unmanifested integration path or branch is retained; explicit recovery is required.');
			}
			return this.createInitialIntegrationGeneration(source, input.ownerId);
		});
	}

	private async createInitialIntegrationGeneration(source: ManagedWorktreeLease, ownerId: string): Promise<ManagedWorktreeLease> {
		const context = await this.createSafeMergeContext(source);
		try {
			const entries = await this.listTreeEntries(context, source.worktreePath, source.baseCommit);
			await this.assertGenerationBudget(context, source.worktreePath, entries);
			await this.assertMergeAttributesSafe(context, source.worktreePath, source.baseCommit, entries.map(entry => entry.path));
			const branch = `bugfixer/integration/${ownerId}`;
			const update = Buffer.from(`start\noption no-deref\ncreate refs/heads/${branch} ${source.baseCommit}\nprepare\ncommit\n`, 'utf8');
			await this.runGit(source.repositoryPath, ['-c', `core.hooksPath=${join(context.root, 'hooks')}`, '-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false', 'update-ref', '--stdin'], {
				env: { GIT_CONFIG_GLOBAL: context.environment.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }, input: update, maxOutputBytes: 64 * 1024
			});
			const generation = await this.registerDetachedGeneration(source.repositoryPath, source.commonDirectory, ownerId, source.baseCommit, context);
			const digests = await this.materializeGeneration(context, generation, source.baseCommit, []);
			const treeOid = (await this.safeMergeGit(context, generation.worktreePath, ['rev-parse', `${source.baseCommit}^{tree}`])).stdout.toString('ascii').trim();
			const generationRecord: ManagedWorktreeGeneration = {
				generationId: generation.generationId, worktreePath: generation.worktreePath, registrationId: generation.registrationId,
				head: source.baseCommit, treeOid, indexDigest: digests.indexDigest, treeDigest: digests.treeDigest
			};
			return this.writeLease({
				ownerId, kind: 'integration', repositoryPath: source.repositoryPath, commonDirectory: source.commonDirectory,
				branch, worktreePath: generation.worktreePath, baseCommit: source.baseCommit, head: source.baseCommit,
				state: 'active', generationId: generation.generationId, registrationId: generation.registrationId, generations: [generationRecord]
			});
		} finally { this.removeSafeMergeContext(context); }
	}

	discardMergePreview(previewId: string): void {
		if (!UUID_PATTERN.test(previewId)) { throw new Error('Merge preview ID must be a UUID.'); }
		this.previews.delete(previewId);
	}

	async getMergeGenerationDirectory(ownerId: string, generationId: string, registrationId: string): Promise<string> {
		const lease = await this.readAndValidate(ownerId);
		const generation = lease.generations?.find(value => value.generationId === generationId && value.registrationId === registrationId);
		if (lease.kind !== 'integration') { throw new Error('Merge generation directory requires an integration owner.'); }
		if (generation) { return generation.worktreePath; }
		const pending = lease.pendingOperation;
		if (pending?.kind !== 'merge' || pending.generationId !== generationId || pending.registrationId !== registrationId || pending.generationPath !== this.generationPath(ownerId, generationId)) { throw new Error('Merge generation directory is not a registered signed integration generation.'); }
		const path = pending.generationPath;
		if (!existsSync(path) || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path
			|| realpathSync(await this.git(path, ['rev-parse', '--show-toplevel'])) !== path || await this.git(path, ['branch', '--show-current']) !== '') { throw new Error('Pending merge generation directory registration is unavailable or changed.'); }
		const common = await this.git(path, ['rev-parse', '--git-common-dir']);
		if (realpathSync(isAbsolute(common) ? common : resolve(path, common)) !== lease.commonDirectory) { throw new Error('Pending merge generation belongs to a different repository.'); }
		return path;
	}

	async previewMerge(input: { integrationOwnerId: string; sessionOwnerId: string; resolutionOf?: MergeResolutionSource }): Promise<MergePreview> {
		return this.withIntegrationLock(input.integrationOwnerId, 'merge', () => this.prepareMergePreview(input));
	}

	private async prepareMergePreview(input: { integrationOwnerId: string; sessionOwnerId: string; resolutionOf?: MergeResolutionSource }): Promise<MergePreview> {
		const integration = await this.readAndValidate(input.integrationOwnerId);
		const session = await this.readAndValidate(input.sessionOwnerId);
		if (integration.kind !== 'integration' || session.kind !== 'session') { throw new Error('Merge requires an integration worktree and a session worktree.'); }
		if (integration.commonDirectory !== session.commonDirectory) { throw new Error('Managed worktrees must belong to the same repository.'); }
		const context = await this.createSafeMergeContext(integration);
		try {
		if (!input.resolutionOf) { await this.assertMergeReady(integration, context); }
		this.assertMergeSourceReady(session);
		const targetHead = await this.git(integration.worktreePath, ['rev-parse', 'HEAD']);
		const sourceHead = await this.git(session.worktreePath, ['rev-parse', 'HEAD']);
		const targetRef = await this.git(integration.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${integration.branch}`]);
		const sourceRef = await this.git(session.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${session.branch}`]);
		if (targetRef !== targetHead || sourceRef !== sourceHead) { throw new Error('A managed worktree branch ref does not match its checked-out HEAD.'); }
		const mergeBase = await this.resolveUniqueMergeBase(context, integration.worktreePath, targetHead, sourceHead);
		const resolution = input.resolutionOf ? await this.captureResolution(context, integration, input.resolutionOf) : undefined;
		if (input.resolutionOf && (sourceHead !== input.resolutionOf.sourceHead || targetHead !== input.resolutionOf.targetHead || mergeBase !== input.resolutionOf.mergeBase)) { throw new Error('Conflict resolution source or target changed; the prior conflict cannot be reused.'); }
		const diffBase = resolution ? targetHead : mergeBase;
		const diffTarget = resolution?.treeOid ?? sourceHead;
		const patch = (await this.safeMergeGit(context, integration.worktreePath, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', diffBase, diffTarget], { maxOutputBytes: MAX_BUFFER_BYTES })).stdout;
		if (patch.byteLength === 0 && !resolution) { throw new Error('There are no committed source changes to merge.'); }
		let diffText: string;
		try { diffText = new TextDecoder('utf-8', { fatal: true }).decode(patch); }
		catch { throw new Error('The complete merge diff cannot be displayed as UTF-8; review is unavailable.'); }
		if (Buffer.byteLength(diffText, 'utf8') !== patch.byteLength || patch.byteLength > MAX_BUFFER_BYTES) { throw new Error('The complete merge diff exceeds the review display limit.'); }
		const pathBytes = (await this.safeMergeGit(context, integration.worktreePath, ['diff', '--name-only', '-z', '--no-renames', diffBase, diffTarget])).stdout;
		if ((!pathBytes.byteLength && !resolution) || (pathBytes.byteLength && pathBytes[pathBytes.byteLength - 1] !== 0)) { throw new Error('The complete changed-path list is unavailable.'); }
		let changedPaths: string[];
		try { changedPaths = new TextDecoder('utf-8', { fatal: true }).decode(pathBytes).split('\0').filter(Boolean).sort(compareCodeUnits); }
		catch { throw new Error('Changed paths cannot be displayed as valid UTF-8.'); }
		if ((!changedPaths.length && !resolution) || changedPaths.length > MAX_MERGE_CHANGED_PATHS
			|| changedPaths.some(path => path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === ''))) {
			throw new Error('The merge diff has too many paths or contains an invalid changed path.');
		}
		for (const tree of [mergeBase, targetHead, sourceHead]) { await this.assertMergeAttributesSafe(context, integration.worktreePath, tree, changedPaths); }
		const author = await this.readCommitIdentity(integration.worktreePath, 'GIT_AUTHOR_IDENT');
		const committer = await this.readCommitIdentity(integration.worktreePath, 'GIT_COMMITTER_IDENT');
		const commitMessage = `Merge reviewed session ${session.ownerId}`;
		const preview: MergePreview = {
			previewId: randomUUID(), integrationOwnerId: integration.ownerId, sessionOwnerId: session.ownerId,
			sourceHead, targetHead, mergeBase, diffHash: createHash('sha256').update(patch).digest('hex'), diffText, changedPaths,
			commitMessage, author, committer, ...(resolution ? { resolution } : {}),
			expiresAt: Date.now() + PREVIEW_TTL_MS
		};
		this.expireMergePreviews();
		if (this.previews.size >= MAX_ACTIVE_MERGE_PREVIEWS) { throw new Error('Too many merge reviews are already open; close or expire one before preparing another.'); }
		this.previews.set(preview.previewId, preview);
		return preview;
		} finally { this.removeSafeMergeContext(context); }
	}

	private async captureResolution(context: SafeMergeContext, lease: ManagedWorktreeLease, prior: MergeResolutionSource): Promise<AgentSessionMergeResolutionDTO> {
		const operation = lease.lastOperation;
		if (lease.state !== 'conflict' || lease.pendingOperation || lease.generationId !== prior.generationId || lease.registrationId !== prior.registrationId
			|| !operation || operation.kind !== 'merge' || operation.outcome !== 'conflict' || operation.id !== prior.operationId || operation.proposalId !== prior.proposalId
			|| operation.sourceHead !== prior.sourceHead || operation.targetHead !== prior.targetHead || operation.mergeBase !== prior.mergeBase) {
			throw new Error('Resolution requires the exact current signed conflict operation and generation.');
		}
		const indexPath = await this.generationIndexPath(lease.worktreePath);
		const snapshot = this.readIndexAtPath(indexPath);
		const copiedIndex = join(context.root, `resolution-index-${randomUUID()}`);
		writeFileSync(copiedIndex, snapshot.bytes, { flag: 'wx', mode: 0o600 });
		const unmerged = await this.safeMergeGit(context, lease.worktreePath, ['ls-files', '--unmerged', '-z'], { indexPath: copiedIndex });
		if (unmerged.stdout.length) { throw new Error('Stage every resolved conflict before requesting a new resolution review.'); }
		const treeOid = (await this.safeMergeGit(context, lease.worktreePath, ['write-tree'], { indexPath: copiedIndex })).stdout.toString('ascii').trim();
		if (!OBJECT_ID_PATTERN.test(treeOid)) { throw new Error('The staged resolution did not produce a complete Git tree.'); }
		const entries = await this.listTreeEntries(context, lease.worktreePath, treeOid);
		await this.assertGenerationBudget(context, lease.worktreePath, entries);
		await this.assertMergeAttributesSafe(context, lease.worktreePath, treeOid, entries.map(entry => entry.path));
		await this.assertGenerationWorktreeMatches(context, lease.worktreePath, treeOid);
		const digests = await this.generationDigests(context, lease.worktreePath, copiedIndex, treeOid);
		if (!this.realIndexStillMatches(snapshot)) { throw new Error('The staged resolution index changed during review capture.'); }
		return { proposalId: prior.proposalId, operationId: prior.operationId, generationId: prior.generationId, registrationId: prior.registrationId, treeOid, ...digests, indexFileDigest: createHash('sha256').update(snapshot.bytes).digest('hex') };
	}

	async mergeReviewed(input: { readonly previewId: string; readonly operationId: string; readonly proposalId: string; readonly proposalFingerprint: string; readonly commitMessage: string; readonly author: AgentSessionIntegrationGitIdentity; readonly committer: AgentSessionIntegrationGitIdentity } & ReviewedMergeJournal): Promise<ReviewedMergeResult> {
		if (!UUID_PATTERN.test(input.operationId) || !UUID_PATTERN.test(input.proposalId) || !SHA256_PATTERN.test(input.proposalFingerprint)
			|| typeof input.recordApplying !== 'function' || typeof input.readApplying !== 'function'
			|| typeof input.recordArtifact !== 'function' || typeof input.readArtifacts !== 'function') {
			throw new Error('Reviewed merge requires an exact operation and durable proposal journal.');
		}
		const preview = this.previews.get(input.previewId);
		if (!preview) { throw new Error('Merge preview is unknown, expired, or already consumed.'); }
		if (preview.expiresAt < Date.now()) { this.previews.delete(input.previewId); throw new Error('Merge preview has expired; review the current changes again.'); }
		if (input.commitMessage !== preview.commitMessage) { throw new Error('Reviewed merge message differs from the exact prepared proposal.'); }
		const approvedIdentity = this.validateFrozenIdentity({ author: input.author, committer: input.committer });
		return this.withIntegrationLock<ReviewedMergeResult>(preview.integrationOwnerId, 'merge', async () => {
			let initial = await this.readAndValidate(preview.integrationOwnerId);
			const initialSource = await this.readAndValidate(preview.sessionOwnerId);
			if (initial.kind !== 'integration' || initialSource.kind !== 'session' || initial.commonDirectory !== initialSource.commonDirectory) { throw new Error('Reviewed merge owner bindings are invalid.'); }
			const context = await this.createSafeMergeContext(initial);
			try {
				if (!preview.resolution) { await this.assertMergeReady(initial, context); }
				this.assertMergeSourceReady(initialSource);
				const applying: ReviewedMergeApplyingRecord = {
					operationId: input.operationId, proposalId: input.proposalId, proposalFingerprint: input.proposalFingerprint,
					integrationOwnerId: preview.integrationOwnerId, sessionOwnerId: preview.sessionOwnerId,
					sourceHead: preview.sourceHead, targetHead: preview.targetHead, mergeBase: preview.mergeBase, diffFingerprint: preview.diffHash,
					commitMessage: input.commitMessage, author: approvedIdentity.author, committer: approvedIdentity.committer
				};
				await this.assertMergePreviewFresh(preview, initial, initialSource, context);
				await input.recordApplying(applying);
				const readback = await input.readApplying(input.operationId);
				if (!readback || !sameMergeApplyingRecord(readback, applying)) { throw new Error('The durable merge journal did not read back the exact applying operation; Git was not changed.'); }
				await this.assertMergePreviewFresh(preview, initial, initialSource, context);
				const retainedCount = initial.generations?.length ?? 1;
				if (retainedCount >= MAX_INTEGRATION_GENERATIONS) { throw new Error('Integration generation retention is full; no generation was removed.'); }
				const priorGeneration = preview.resolution ? {
					generationId: preview.resolution.generationId, registrationId: preview.resolution.registrationId,
					worktreePath: initial.worktreePath, head: preview.targetHead, treeOid: preview.resolution.treeOid,
					indexDigest: preview.resolution.indexDigest, treeDigest: preview.resolution.treeDigest
				} : await this.capturePriorGeneration(context, initial);
				const nextGenerationId = randomUUID();
				const nextRegistrationId = randomUUID();
				const nextPath = this.generationPath(initial.ownerId, nextGenerationId);
				const nextArtifactPath = this.generationArtifactPath(initial.ownerId, nextGenerationId);
				const priorArtifact = priorGeneration ? {
					generationId: priorGeneration.generationId, generationPath: this.generationArtifactPathFromLease(initial.ownerId, priorGeneration),
					registrationId: priorGeneration.registrationId, head: priorGeneration.head,
					indexDigest: priorGeneration.indexDigest, treeDigest: priorGeneration.treeDigest
				} : null;
				const intent = { phase: 'intent', generationId: nextGenerationId, generationPath: nextArtifactPath, registrationId: nextRegistrationId, priorGeneration: priorArtifact } as const;
				let artifacts: readonly AgentSessionMergeArtifactRecord[] = [];
				artifacts = await this.recordMergeArtifact(input, input.operationId, artifacts, intent);
				if (preview.resolution) {
					// The old generation stays in place. Record the newly reviewed human snapshot
					// in the signed intent only after its exact applying journal is durable.
					initial = { ...initial, generations: initial.generations!.map(value => value.generationId === priorGeneration.generationId ? priorGeneration : value) };
				}
				const pendingOperation: PendingOperation = {
					id: input.operationId, kind: 'merge', startedAt: Date.now(), proposalId: input.proposalId, proposalFingerprint: input.proposalFingerprint,
					sourceOwnerId: initialSource.ownerId, sourceHead: preview.sourceHead, targetHead: preview.targetHead,
					mergeBase: preview.mergeBase, diffFingerprint: preview.diffHash, generationId: nextGenerationId, generationPath: nextPath, registrationId: nextRegistrationId
				};
				this.writeLease({ ...initial, state: 'recoveryRequired', pendingOperation });
				try {
					await this.assertMergePreviewFresh(preview, initial, initialSource, context);
					await this.detachLegacyIntegration(initial, preview.targetHead);
					const merge: MergeTreeResult = preview.resolution ? { treeOid: preview.resolution.treeOid, clean: true, conflicts: [] }
						: await this.mergeTree(context, initial.worktreePath, preview.targetHead, preview.sourceHead, preview.mergeBase);
					const treeEntries = await this.listTreeEntries(context, initial.worktreePath, merge.treeOid);
					await this.assertGenerationBudget(context, initial.worktreePath, treeEntries);
					await this.assertMergeAttributesSafe(context, initial.worktreePath, merge.treeOid, treeEntries.map(entry => entry.path));
					if (merge.conflicts.some(conflict => conflict.stages.some(stage => stage.mode === '160000'))) { throw new Error('Submodule conflicts are unsupported for integration generations.'); }
					const commit = merge.clean ? await this.createReviewedMergeCommit(context, initial.worktreePath, merge.treeOid, preview, approvedIdentity) : null;
					artifacts = await this.recordMergeArtifact(input, input.operationId, artifacts, {
						phase: 'candidatePrepared', candidateTreeOid: merge.treeOid, candidateCommitOid: commit, outcome: merge.clean ? 'clean' : 'conflict', conflicts: merge.conflicts
					});
					const generation = await this.registerDetachedGeneration(initial.repositoryPath, initial.commonDirectory, initial.ownerId, preview.targetHead, context, nextGenerationId, nextRegistrationId);
					artifacts = await this.recordMergeArtifact(input, input.operationId, artifacts, { phase: 'generationRegistered', generationPath: nextArtifactPath, registrationId: generation.registrationId });
					const digests = await this.materializeGeneration(context, generation, merge.treeOid, merge.conflicts);
					const generationHead = merge.clean ? commit! : preview.targetHead;
					if (generationHead !== preview.targetHead) {
						await this.updateDetachedGenerationHead(generation.worktreePath, preview.targetHead, generationHead);
					}
					const publishedGeneration: RegisteredGeneration = { ...generation, head: generationHead };
					await this.assertMaterializedGeneration(context, publishedGeneration, merge.treeOid, digests);
					artifacts = await this.recordMergeArtifact(input, input.operationId, artifacts, {
						phase: 'generationMaterialized', head: generationHead, indexDigest: digests.indexDigest, treeDigest: digests.treeDigest,
						conflictDigest: merge.clean ? null : createHash('sha256').update(JSON.stringify(merge.conflicts)).digest('hex')
					});
					let nextHead = preview.targetHead;
					await this.assertMergePreviewFresh(preview, initial, initialSource, context);
					await this.assertPriorGenerationUnchanged(initial, priorGeneration);
					await this.assertMaterializedGeneration(context, publishedGeneration, merge.treeOid, digests);
					if (merge.clean) {
						await this.publishIntegrationRef(initial, initialSource, preview.sourceHead, preview.targetHead, commit!, context);
						nextHead = commit!;
					}
					if (merge.clean) {
						artifacts = await this.recordMergeArtifact(input, input.operationId, artifacts, {
							phase: 'published', targetRef: `refs/heads/${initial.branch}`, resultingHead: nextHead,
							currentGenerationId: nextGenerationId, priorGenerationId: priorGeneration?.generationId ?? null
						});
					}
					const finalSourceRef = await this.git(initialSource.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${initialSource.branch}`]);
					const finalTargetRef = await this.git(initial.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${initial.branch}`]);
					if (finalSourceRef !== preview.sourceHead || finalTargetRef !== nextHead) { throw new Error('Managed refs changed before the generation pointer was finalized.'); }
					return await this.finalizeMergeGeneration(initial, pendingOperation, publishedGeneration, nextHead, digests, merge, priorGeneration);
				} catch {
					return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Merge state is retained for exact journal-backed recovery; no references or generations were discarded.' };
				}
			} finally { this.removeSafeMergeContext(context); }
		}).finally(() => this.previews.delete(input.previewId));
	}

	/** Reconciles only from an exact durable apply journal. Ambiguous operations remain retained for manual recovery. */
	async reconcileReviewedMerge(input: Pick<ReviewedMergeJournal, 'readApplying' | 'readArtifacts' | 'recordArtifact'> & { readonly integrationOwnerId: string; readonly operationId: string }): Promise<ReviewedMergeResult> {
		this.validateOwnerId(input.integrationOwnerId);
		if (!UUID_PATTERN.test(input.operationId) || typeof input.readApplying !== 'function' || typeof input.readArtifacts !== 'function' || typeof input.recordArtifact !== 'function') {
			throw new Error('Merge recovery requires an exact operation and durable journal capabilities.');
		}
		const applying = await input.readApplying(input.operationId);
		if (!applying || !sameMergeApplyingRecord(applying, applying) || applying.operationId !== input.operationId || applying.integrationOwnerId !== input.integrationOwnerId
			|| !UUID_PATTERN.test(applying.proposalId) || !SHA256_PATTERN.test(applying.proposalFingerprint)
			|| !UUID_PATTERN.test(applying.sessionOwnerId) || !OBJECT_ID_PATTERN.test(applying.sourceHead)
			|| !OBJECT_ID_PATTERN.test(applying.targetHead) || !OBJECT_ID_PATTERN.test(applying.mergeBase)
			|| !SHA256_PATTERN.test(applying.diffFingerprint) || applying.commitMessage !== `Merge reviewed session ${applying.sessionOwnerId}`) {
			throw new Error('Merge recovery journal does not contain the exact applying operation.');
		}
		this.validateFrozenIdentity({ author: applying.author, committer: applying.committer });
		let artifacts = await input.readArtifacts(input.operationId);
		if (!Array.isArray(artifacts) || artifacts.length > 5) { throw new Error('Merge recovery artifacts are malformed or exceed their phase limit.'); }
		const expectedPhases = ['intent', 'candidatePrepared', 'generationRegistered', 'generationMaterialized', 'published'];
		for (let index = 0; index < artifacts.length; index++) {
			const record = artifacts[index];
			if (!record || record.revision !== index + 1 || !record.event || record.event.phase !== expectedPhases[index]) {
				throw new Error('Merge recovery artifact history is not a contiguous exact phase sequence.');
			}
		}
		return this.withIntegrationLock(input.integrationOwnerId, 'merge', async () => {
			const integration = await this.readAndValidate(input.integrationOwnerId);
			if (integration.kind !== 'integration' || integration.commonDirectory !== realpathSync(integration.commonDirectory)) {
				throw new Error('Merge recovery target does not match its signed managed integration lease.');
			}
			const source = await this.readAndValidate(applying.sessionOwnerId);
			if (source.kind !== 'session' || source.commonDirectory !== integration.commonDirectory) {
				throw new Error('Merge recovery source and target do not share the exact managed repository.');
			}
			const targetRef = await this.git(integration.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${integration.branch}`]);
			const sourceRef = await this.git(source.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${source.branch}`]);
			if (artifacts.length === 0 && !integration.pendingOperation && targetRef === applying.targetHead && sourceRef === applying.sourceHead) {
				return { state: 'notApplied', operationId: input.operationId, integration };
			}
			if (artifacts.length === 1 && artifacts[0].event.phase === 'intent' && targetRef === applying.targetHead && sourceRef === applying.sourceHead) {
				const intent = artifacts[0].event;
				const newPath = this.generationPath(integration.ownerId, intent.generationId);
				const registrations = await this.git(integration.repositoryPath, ['worktree', 'list', '--porcelain']);
				const currentBranch = (await this.git(integration.worktreePath, ['branch', '--show-current'])).trim();
				const branchIsStillOwned = integration.generationId ? currentBranch === '' : currentBranch === integration.branch;
				if (intent.generationPath !== this.generationArtifactPath(integration.ownerId, intent.generationId) || existsSync(newPath)
					|| registrations.includes(`worktree ${newPath}\n`) || !branchIsStillOwned
					|| integration.pendingOperation && (integration.pendingOperation.kind !== 'merge' || integration.pendingOperation.id !== input.operationId || integration.pendingOperation.generationId !== intent.generationId)
					|| !intent.priorGeneration || !this.priorGenerationMatchesLease(integration, intent.priorGeneration)) {
					return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Merge intent may have crossed a repository mutation boundary; retained for manual recovery.' };
				}
				if (intent.priorGeneration) {
					if (!this.priorGenerationMatchesLease(integration, intent.priorGeneration)) {
						return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Prior generation identity does not match the signed current generation pointer.' };
					}
					const priorPath = this.resolvePriorGenerationPath(integration.ownerId, intent.priorGeneration);
					const priorTree = (await this.git(priorPath, ['rev-parse', `${intent.priorGeneration.head}^{tree}`])).trim();
					await this.assertPriorGenerationUnchanged(integration, { ...intent.priorGeneration, worktreePath: priorPath, treeOid: priorTree });
				}
				const pending: PendingOperation = {
					id: applying.operationId, kind: 'merge', startedAt: Date.now(), proposalId: applying.proposalId,
					proposalFingerprint: applying.proposalFingerprint, sourceOwnerId: source.ownerId, sourceHead: applying.sourceHead,
					targetHead: applying.targetHead, mergeBase: applying.mergeBase, diffFingerprint: applying.diffFingerprint,
					generationId: intent.generationId, generationPath: newPath, registrationId: intent.registrationId
				};
				const updated = this.writeLease({ ...integration, state: 'active', pendingOperation: undefined, lastOperation: mergeReceipt(pending, 'notApplied', undefined, undefined, true) });
				return { state: 'notApplied', operationId: input.operationId, integration: updated };
			}
			if (artifacts.length < 4) { return { state: 'recoveryRequired', operationId: input.operationId, reason: 'The durable merge journal is incomplete; refs and managed generations were retained.' }; }
			const [intentRecord, candidateRecord, registeredRecord, materializedRecord] = artifacts;
			const intent = intentRecord.event;
			const candidate = candidateRecord.event;
			const registered = registeredRecord.event;
			const materialized = materializedRecord.event;
			if (intent.phase !== 'intent' || candidate.phase !== 'candidatePrepared' || registered.phase !== 'generationRegistered'
				|| materialized.phase !== 'generationMaterialized'
				|| !UUID_PATTERN.test(intent.generationId) || !UUID_PATTERN.test(intent.registrationId)
				|| intent.generationPath !== this.generationArtifactPath(integration.ownerId, intent.generationId)
				|| !intent.priorGeneration || !this.priorGenerationMatchesLease(integration, intent.priorGeneration)
				|| registered.generationPath !== intent.generationPath || registered.registrationId !== intent.registrationId
				|| !OBJECT_ID_PATTERN.test(candidate.candidateTreeOid)
				|| !SHA256_PATTERN.test(materialized.indexDigest) || !SHA256_PATTERN.test(materialized.treeDigest)
				|| !OBJECT_ID_PATTERN.test(materialized.head)) {
				return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Merge journal artifacts do not match their exact operation binding; retained for review.' };
			}
			if (sourceRef !== applying.sourceHead) { return { state: 'recoveryRequired', operationId: input.operationId, reason: 'The source reference changed after approval; no merge reference was retried.' }; }
			const isConflict = candidate.outcome === 'conflict' && candidate.candidateCommitOid === null;
			const isClean = candidate.outcome === 'clean' && candidate.candidateCommitOid !== null;
			if ((!isClean && !isConflict) || (isConflict && artifacts.length !== 4) || (isClean && materialized.head !== candidate.candidateCommitOid)
				|| (isConflict && materialized.head !== applying.targetHead)
				|| (isClean && targetRef !== candidate.candidateCommitOid && targetRef !== applying.targetHead)
				|| (isConflict && targetRef !== applying.targetHead)) {
				return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Reference state does not match the recorded merge outcome; automatic reference updates are forbidden.' };
			}
			let published: Extract<AgentSessionMergeArtifactEvent, { phase: 'published' }> | undefined;
			if (isConflict && artifacts.length === 4) {
				published = undefined;
			} else if (artifacts.length === 5) {
				const record = artifacts[4];
				if (record.event.phase !== 'published') { return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Published artifact is malformed.' }; }
				published = record.event;
			} else if (isClean && targetRef === candidate.candidateCommitOid) {
				const resultingHead = candidate.candidateCommitOid!;
				artifacts = await this.recordMergeArtifact(input, input.operationId, artifacts, {
					phase: 'published', targetRef: `refs/heads/${integration.branch}`, resultingHead,
					currentGenerationId: intent.generationId, priorGenerationId: intent.priorGeneration?.generationId ?? null
				});
				published = artifacts[4].event.phase === 'published' ? artifacts[4].event : undefined;
			} else if (!isConflict) { return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Candidate was prepared but its conditional ref update did not publish; no retry was attempted.' }; }
			if (isClean && (!published || published.currentGenerationId !== intent.generationId || published.priorGenerationId !== (intent.priorGeneration?.generationId ?? null)
				|| published.targetRef !== `refs/heads/${integration.branch}` || published.resultingHead !== candidate.candidateCommitOid)) {
				return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Published artifact is not bound to the observed exact reference state.' };
			}
			const generationPath = this.generationPath(integration.ownerId, intent.generationId);
			if (!existsSync(generationPath) || lstatSync(generationPath).isSymbolicLink() || realpathSync(generationPath) !== generationPath
				|| realpathSync((await this.git(generationPath, ['rev-parse', '--show-toplevel'])).trim()) !== generationPath
				|| (await this.git(generationPath, ['branch', '--show-current'])).trim() !== '') {
				return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Recorded detached generation registration is missing or changed; retained for manual recovery.' };
			}
			const generationHead = (await this.git(generationPath, ['rev-parse', 'HEAD'])).trim();
			if (generationHead !== materialized.head) { return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Recorded generation HEAD differs from its durable materialization receipt.' }; }
			const generation: RegisteredGeneration = {
				generationId: intent.generationId, registrationId: intent.registrationId, worktreePath: generationPath,
				indexPath: await this.generationIndexPath(generationPath), head: generationHead
			};
			const context = await this.createSafeMergeContext(integration, false);
			try {
				const actualDigests = await this.generationDigests(context, generationPath, generation.indexPath, candidate.candidateTreeOid);
				await this.assertGenerationWorktreeMatches(context, generationPath, candidate.candidateTreeOid);
				if (actualDigests.indexDigest !== materialized.indexDigest || actualDigests.treeDigest !== materialized.treeDigest) {
					return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Generation bytes or index no longer match durable merge artifacts.' };
				}
				const conflicts = candidate.conflicts;
				if (!Array.isArray(conflicts) || conflicts.length > MAX_MERGE_CHANGED_PATHS
					|| (isConflict && createHash('sha256').update(JSON.stringify(conflicts)).digest('hex') !== materialized.conflictDigest)
					|| (isClean && (conflicts.length !== 0 || materialized.conflictDigest !== null))) {
					return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Recorded conflict details do not match the materialized generation.' };
				}
				if (isClean) { await this.assertMergeCommitMetadata(context, integration.worktreePath, candidate.candidateCommitOid!, candidate.candidateTreeOid, applying); }
				const priorGeneration: ManagedWorktreeGeneration | null = intent.priorGeneration
					? { ...intent.priorGeneration, worktreePath: this.resolvePriorGenerationPath(integration.ownerId, intent.priorGeneration),
						treeOid: integration.generations?.find(value => value.generationId === intent.priorGeneration!.generationId)?.treeOid
							?? (await this.git(this.resolvePriorGenerationPath(integration.ownerId, intent.priorGeneration), ['rev-parse', `${intent.priorGeneration.head}^{tree}`])).trim() }
					: null;
				if (priorGeneration) { await this.assertPriorGenerationUnchanged(integration, priorGeneration); }
				const finalSourceRef = await this.git(source.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${source.branch}`]);
				const finalTargetRef = await this.git(integration.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${integration.branch}`]);
				if (finalSourceRef !== applying.sourceHead || finalTargetRef !== (isClean ? candidate.candidateCommitOid : applying.targetHead)) {
					return { state: 'recoveryRequired', operationId: input.operationId, reason: 'Managed refs changed while recovery verified; the operation remains retained.' };
				}
				if (integration.generationId === intent.generationId && integration.lastOperation?.id === applying.operationId) {
					if (isClean && integration.lastOperation.outcome === 'merged' && integration.head === candidate.candidateCommitOid) {
						return { state: 'merged', commit: candidate.candidateCommitOid!, integration };
					}
					if (isConflict && integration.lastOperation.outcome === 'conflict' && integration.head === applying.targetHead) {
						return { state: 'conflict', integration, conflictedPaths: conflicts.map(item => item.path) };
					}
				}
				const pending: PendingOperation = {
					id: applying.operationId, kind: 'merge', startedAt: Date.now(), proposalId: applying.proposalId,
					proposalFingerprint: applying.proposalFingerprint, sourceOwnerId: source.ownerId, sourceHead: applying.sourceHead,
					targetHead: applying.targetHead, mergeBase: applying.mergeBase, diffFingerprint: applying.diffFingerprint,
					generationId: intent.generationId, generationPath, registrationId: intent.registrationId
				};
				return this.finalizeMergeGeneration(integration, pending, generation, isClean ? candidate.candidateCommitOid! : applying.targetHead,
					actualDigests, { treeOid: candidate.candidateTreeOid, clean: isClean, conflicts }, priorGeneration);
			} finally { this.removeSafeMergeContext(context); }
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

	private async assertMergeReady(lease: ManagedWorktreeLease, context: SafeMergeContext): Promise<void> {
		if (lease.state !== 'active') { throw new Error(`Worktree requires conflict recovery before another merge (${lease.state}).`); }
		await this.assertMergeWorktreeClean(context, lease);
	}

	private async assertMergeWorktreeClean(context: SafeMergeContext, lease: ManagedWorktreeLease): Promise<void> {
		const indexPath = await this.generationIndexPath(lease.worktreePath);
		const head = (await this.git(lease.worktreePath, ['rev-parse', 'HEAD'])).trim();
		if (!OBJECT_ID_PATTERN.test(head)) { throw new Error('Managed merge worktree HEAD is malformed.'); }
		writeFileSync(join(context.gitDirectory, 'HEAD'), `${head}\n`, { mode: 0o600 });
		const status = await this.safeMergeGit(context, lease.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'], { indexPath, maxOutputBytes: MAX_BUFFER_BYTES });
		if (status.stdout.length !== 0) { throw new Error('Managed integration generation contains dirty, untracked, or unmerged files.'); }
	}

	private async resolveUniqueMergeBase(context: SafeMergeContext, worktreePath: string, targetHead: string, sourceHead: string): Promise<string> {
		const bytes = (await this.safeMergeGit(context, worktreePath, ['merge-base', '--all', targetHead, sourceHead], { maxOutputBytes: 16 * 1024 })).stdout;
		const values = bytes.toString('ascii').trim().split(/\r?\n/u).filter(Boolean);
		if (values.length !== 1 || !OBJECT_ID_PATTERN.test(values[0]) || values[0] !== values[0].toLowerCase()) {
			throw new Error('Reviewed merge requires exactly one unambiguous merge base.');
		}
		return values[0];
	}

	private async assertMergeConfigurationSafe(repositoryPath: string): Promise<void> {
		const config = (await this.runGit(repositoryPath, ['config', '--null', '--list', '--show-origin', '--show-scope'], { env: this.discoveryGitEnvironment(), maxOutputBytes: MAX_BUFFER_BYTES })).stdout;
		if (config.length && config[config.length - 1] !== 0) { throw new Error('Effective Git configuration could not be parsed safely.'); }
		const configFields = decodeGitUtf8(config).split('\0');
		configFields.pop();
		if (configFields.length % 3 !== 0) { throw new Error('Effective Git configuration contains incomplete scope/origin records.'); }
		for (let configIndex = 2; configIndex < configFields.length; configIndex += 3) {
			const raw = configFields[configIndex];
			const newline = raw.indexOf('\n');
			if (newline < 0) { throw new Error('Effective Git configuration contains a malformed record.'); }
			const header = raw.slice(0, newline);
			const key = header.split('\t').at(-1)?.toLowerCase();
			const value = raw.slice(newline + 1).trim().toLowerCase();
			if (!key) { throw new Error('Effective Git configuration contains an unnamed key.'); }
			if (/^(?:merge\..*\.driver|filter\..*\.(?:clean|smudge|process)|diff\.(?:external|.*\.command|.*\.textconv)|gpg\.program|gpg\.format|core\.attributesfile|extensions\.partialclone|remote\..*\.promisor)$/.test(key)
				|| key === 'core.fsmonitor' && !['false', 'no', 'off', '0', ''].includes(value)
				|| key === 'commit.gpgsign' && !['false', 'no', 'off', '0'].includes(value)
				|| key === 'merge.default' && value !== '') {
				throw new Error(`Git configuration ${key} is unsupported for reviewed merges; no external Git command was started.`);
			}
		}
		const replacements = await this.runGit(repositoryPath, ['for-each-ref', '--format=%(refname)', 'refs/replace'], { maxOutputBytes: 64 * 1024 });
		const shallow = (await this.runGit(repositoryPath, ['rev-parse', '--is-shallow-repository'])).stdout.toString('ascii').trim();
		const graftPathValue = (await this.runGit(repositoryPath, ['rev-parse', '--git-path', 'info/grafts'])).stdout.toString('utf8').trim();
		const graftPath = isAbsolute(graftPathValue) ? graftPathValue : resolve(repositoryPath, graftPathValue);
		const graftInfo = existsSync(graftPath) ? lstatSync(graftPath) : undefined;
		if (replacements.stdout.length !== 0 || shallow !== 'false' || graftInfo && (graftInfo.isSymbolicLink() || !graftInfo.isFile() || graftInfo.size > 0)) {
			throw new Error('Reviewed merge does not support replacement refs, grafts, or shallow history.');
		}
	}

	private async createSafeMergeContext(lease: ManagedWorktreeLease, preflightRepositoryConfig = true): Promise<SafeMergeContext> {
		if (preflightRepositoryConfig) { await this.assertMergeConfigurationSafe(lease.repositoryPath); }
		const objectFormat = (await this.git(lease.repositoryPath, ['rev-parse', '--show-object-format'])).trim();
		if (!['sha1', 'sha256'].includes(objectFormat)) { throw new Error('Repository object format is unsupported for reviewed merges.'); }
		const root = mkdtempSync(join(this.root, '.merge-context-'));
		try {
			const gitDirectory = join(root, 'git');
			const hooksDirectory = join(root, 'hooks');
			mkdirSync(join(gitDirectory, 'objects'), { recursive: true, mode: 0o700 });
			mkdirSync(join(gitDirectory, 'refs'), { recursive: true, mode: 0o700 });
			mkdirSync(hooksDirectory, { mode: 0o700 });
			const emptyGlobal = join(root, 'empty-global-config');
			const attributes = join(root, 'empty-attributes');
			writeFileSync(emptyGlobal, '', { mode: 0o600 });
			writeFileSync(attributes, '', { mode: 0o600 });
			writeFileSync(join(gitDirectory, 'HEAD'), 'ref: refs/heads/bugfixer-private\n', { mode: 0o600 });
			writeFileSync(join(gitDirectory, 'config'), `[core]\n\trepositoryformatversion = ${objectFormat === 'sha256' ? 1 : 0}\n\tbare = true\n\tfilemode = true\n\tautocrlf = false\n\tattributesfile = ${attributes}\n\thooksPath = ${hooksDirectory}\n${objectFormat === 'sha256' ? '[extensions]\n\tobjectformat = sha256\n' : ''}[commit]\n\tgpgsign = false\n[maintenance]\n\tauto = false\n[submodule]\n\trecurse = false\n`, { mode: 0o600 });
			const objectPath = (await this.git(lease.repositoryPath, ['rev-parse', '--git-path', 'objects'])).trim();
			const objectDirectory = realpathSync(isAbsolute(objectPath) ? objectPath : resolve(lease.repositoryPath, objectPath));
			const environment: NodeJS.ProcessEnv = {
				GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1',
				GIT_OBJECT_DIRECTORY: objectDirectory, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1'
			};
			return { root, gitDirectory, objectDirectory, environment };
		} catch (error) {
			this.removeSafeMergeContext({ root, gitDirectory: join(root, 'git'), objectDirectory: '', environment: {} });
			throw error;
		}
	}

	private async safeMergeGit(context: SafeMergeContext, worktreePath: string, args: readonly string[], options: { readonly input?: Buffer; readonly maxOutputBytes?: number; readonly allowExitCodes?: readonly number[]; readonly indexPath?: string; readonly author?: ReviewedCommitIdentity; readonly committer?: ReviewedCommitIdentity } = {}): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer; readonly exitCode: number }> {
		const env: NodeJS.ProcessEnv = { ...context.environment, GIT_WORK_TREE: worktreePath, ...(options.indexPath ? { GIT_INDEX_FILE: options.indexPath } : {}),
			...(options.author && options.committer ? this.commitIdentityEnvironment(options.author, options.committer) : {}) };
		return this.runCommand('git', ['--git-dir', context.gitDirectory, '--work-tree', worktreePath, ...args], COMMAND_TIMEOUT_MS, {
			env, isolated: true, ...(options.input ? { input: options.input } : {}), ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
			...(options.allowExitCodes ? { allowExitCodes: options.allowExitCodes } : {})
		});
	}

	private removeSafeMergeContext(context: SafeMergeContext): void {
		if (!existsSync(context.root)) { return; }
		if (lstatSync(context.root).isSymbolicLink() || realpathSync(context.root) !== context.root || !context.root.startsWith(`${this.root}${process.platform === 'win32' ? '\\' : '/'}`)) {
			throw new Error('Private merge context ownership changed; it was retained for recovery.');
		}
		rmSync(context.root, { recursive: true, force: false });
		if (existsSync(context.root)) { throw new Error('Private merge context cleanup could not be verified.'); }
	}

	private async mergeTree(context: SafeMergeContext, worktreePath: string, targetHead: string, sourceHead: string, mergeBase: string): Promise<MergeTreeResult> {
		const output = await this.safeMergeGit(context, worktreePath, ['merge-tree', '--write-tree', '-z', '--messages', `--merge-base=${mergeBase}`, targetHead, sourceHead], {
			maxOutputBytes: MAX_BUFFER_BYTES, allowExitCodes: [1]
		});
		if (output.exitCode !== 0 && output.exitCode !== 1) { throw new Error('Git could not prepare a deterministic merge tree.'); }
		const fields = decodeGitUtf8(output.stdout).split('\0');
		if (fields.length < 2 || fields.at(-1) !== '') { throw new Error('Git merge-tree returned malformed bounded output.'); }
		const treeOid = fields[0].trim();
		if (!OBJECT_ID_PATTERN.test(treeOid) || treeOid !== treeOid.toLowerCase()) { throw new Error('Git merge-tree returned an invalid result tree.'); }
		const stages: Array<{ path: string; stage: 1 | 2 | 3; mode: '100644' | '100755' | '120000' | '160000'; oid: string }> = [];
		let cursor = 1;
		while (cursor < fields.length - 1 && fields[cursor] !== '') {
			const entry = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([123])[\t ]([\s\S]+)$/.exec(fields[cursor]);
			if (!entry || !['100644', '100755', '120000', '160000'].includes(entry[1])) { throw new Error('Git merge-tree returned an unsupported conflict stage.'); }
			this.validateGitPath(entry[4]);
			stages.push({ path: entry[4], mode: entry[1] as '100644' | '100755' | '120000' | '160000', oid: entry[2], stage: Number(entry[3]) as 1 | 2 | 3 });
			cursor++;
		}
		const conflictsByPath = new Map<string, { message: string; stages: Array<{ stage: 1 | 2 | 3; mode: '100644' | '100755' | '120000' | '160000'; oid: string }> }>();
		for (const stage of stages) {
			const current = conflictsByPath.get(stage.path) ?? { message: '', stages: [] };
			current.stages.push({ stage: stage.stage, mode: stage.mode, oid: stage.oid });
			conflictsByPath.set(stage.path, current);
		}
		if (fields[cursor] === '') { cursor++; }
		while (cursor < fields.length - 1) {
			const pathCount = Number(fields[cursor++]);
			if (!Number.isSafeInteger(pathCount) || pathCount < 0 || pathCount > MAX_MERGE_CHANGED_PATHS || cursor + pathCount + 1 >= fields.length) {
				throw new Error('Git merge-tree returned malformed conflict messages.');
			}
			const paths = fields.slice(cursor, cursor + pathCount);
			cursor += pathCount;
			const conflictType = fields[cursor++];
			const message = fields[cursor++];
			if (typeof conflictType !== 'string' || typeof message !== 'string' || Buffer.byteLength(message, 'utf8') > 4096) {
				throw new Error('Git merge-tree returned an invalid conflict message.');
			}
			for (const path of paths) {
				this.validateGitPath(path);
				// Informational auto-merging messages do not imply an unmerged index entry.
				if (!conflictType.startsWith('CONFLICT') && !conflictsByPath.has(path)) { continue; }
				const current = conflictsByPath.get(path) ?? { message: '', stages: [] };
				current.message = [current.message, `${conflictType}: ${message}`].filter(Boolean).join('\n');
				if (Buffer.byteLength(current.message, 'utf8') > 16 * 1024) { throw new Error('Git conflict explanation exceeds the durable artifact limit.'); }
				conflictsByPath.set(path, current);
			}
		}
		if (output.exitCode === 0) {
			if (conflictsByPath.size !== 0) { throw new Error('Git reported a clean merge with conflict data.'); }
			return { treeOid, clean: true, conflicts: [] };
		}
		if (conflictsByPath.size === 0 || conflictsByPath.size > MAX_MERGE_CHANGED_PATHS) { throw new Error('Git reported conflicts without a bounded path-bound conflict record; recovery is required.'); }
		const conflicts = [...conflictsByPath].sort(([left], [right]) => compareCodeUnits(left, right)).map(([path, conflict]) => ({
			path, message: conflict.message || 'Git reported a non-stage conflict for this path.',
			stages: conflict.stages.sort((left, right) => left.stage - right.stage)
		}));
		const foldedPaths = new Set<string>();
		for (const conflict of conflicts) {
			const folded = conflict.path.normalize('NFD').toLowerCase();
			if (foldedPaths.has(folded)) { throw new Error('Merge conflicts contain case-colliding paths unsupported by this filesystem.'); }
			foldedPaths.add(folded);
		}
		return { treeOid, clean: false, conflicts };
	}

	private async listTreeEntries(context: SafeMergeContext, worktreePath: string, treeOid: string): Promise<readonly { path: string; mode: string; oid: string }[]> {
		const output = (await this.safeMergeGit(context, worktreePath, ['ls-tree', '-r', '-z', '--full-tree', treeOid], { maxOutputBytes: MAX_BUFFER_BYTES })).stdout;
		if (output.length && output[output.length - 1] !== 0) { throw new Error('Git returned a malformed tree listing.'); }
		const entries: Array<{ path: string; mode: string; oid: string }> = [];
		const seenFolded = new Set<string>();
		for (const record of decodeGitUtf8(output).split('\0').filter(Boolean)) {
			const tab = record.indexOf('\t');
			const header = tab < 0 ? '' : record.slice(0, tab);
			const match = /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(header);
			if (!match) { throw new Error('Git returned an unsupported or malformed tree entry.'); }
			const path = record.slice(tab + 1);
			this.validateGitPath(path);
			if (match[1] === '160000') { throw new Error('Submodule entries cannot be materialized in an app-owned merge generation.'); }
			const folded = path.normalize('NFD').toLowerCase();
			if (seenFolded.has(folded)) { throw new Error('The merge result has case-colliding paths unsupported by this filesystem.'); }
			seenFolded.add(folded);
			entries.push({ path, mode: match[1], oid: match[2] });
			if (entries.length > MAX_GENERATION_TREE_ENTRIES) { throw new Error('The merge result exceeds the bounded file-count limit.'); }
		}
		return entries;
	}

	private validateGitPath(path: string): void {
		if (typeof path !== 'string' || !path || Buffer.byteLength(path, 'utf8') > 4096 || path.startsWith('/') || path.includes('\0') || path.includes('\\')
			|| path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || /^[A-Za-z]:/.test(path)) {
			throw new Error('Git returned a path outside the supported relative path contract.');
		}
	}

	private async assertMergeAttributesSafe(context: SafeMergeContext, worktreePath: string, treeOid: string, changedPaths: readonly string[]): Promise<void> {
		const indexPath = join(context.root, 'attribute-check-index');
		await this.safeMergeGit(context, worktreePath, ['read-tree', treeOid], { indexPath });
		if (!changedPaths.length) { return; }
		const input = Buffer.from(`${changedPaths.join('\0')}\0`, 'utf8');
		const result = await this.safeMergeGit(context, worktreePath, ['check-attr', '--cached', '-z', '--stdin', 'filter', 'merge', 'working-tree-encoding', 'ident'], { indexPath, input, maxOutputBytes: MAX_BUFFER_BYTES });
		const fields = decodeGitUtf8(result.stdout).split('\0');
		if (fields.at(-1) !== '' || (fields.length - 1) % 3 !== 0) { throw new Error('Committed Git attributes could not be parsed safely.'); }
		for (let index = 2; index < fields.length - 1; index += 3) {
			if (fields[index] !== 'unspecified' && fields[index] !== 'unset') {
				throw new Error(`Committed ${fields[index - 1]} attributes are unsupported for reviewed merges.`);
			}
		}
	}

	private async generationIndexPath(worktreePath: string): Promise<string> {
		const gitDirectory = (await this.git(worktreePath, ['rev-parse', '--absolute-git-dir'])).trim();
		const canonicalGitDirectory = realpathSync(gitDirectory);
		const indexPath = join(canonicalGitDirectory, 'index');
		if (existsSync(indexPath) && (lstatSync(indexPath).isSymbolicLink() || !lstatSync(indexPath).isFile())) { throw new Error('Generation index must be a regular owned file.'); }
		return indexPath;
	}

	private async generationDigests(context: SafeMergeContext, worktreePath: string, indexPath: string, treeOid: string): Promise<{ indexDigest: string; treeDigest: string }> {
		const index = await this.safeMergeGit(context, worktreePath, ['ls-files', '--stage', '-z'], { indexPath, maxOutputBytes: MAX_BUFFER_BYTES });
		const tree = await this.safeMergeGit(context, worktreePath, ['ls-tree', '-r', '-z', '--full-tree', treeOid], { maxOutputBytes: MAX_BUFFER_BYTES });
		return {
			indexDigest: createHash('sha256').update(index.stdout).digest('hex'),
			treeDigest: createHash('sha256').update(tree.stdout).digest('hex')
		};
	}

	private async assertGenerationWorktreeMatches(context: SafeMergeContext, worktreePath: string, treeOid: string): Promise<void> {
		const exactIndex = join(context.root, `worktree-check-${randomUUID()}`);
		try {
			await this.safeMergeGit(context, worktreePath, ['read-tree', treeOid], { indexPath: exactIndex });
			// read-tree creates an index without worktree stat information. Refresh only
			// this private index before diff-files so equal bytes are not falsely dirty.
			await this.safeMergeGit(context, worktreePath, ['update-index', '--refresh'], { indexPath: exactIndex, allowExitCodes: [1], maxOutputBytes: MAX_BUFFER_BYTES });
			const changed = await this.safeMergeGit(context, worktreePath, ['diff-files', '--raw', '-z', '--no-ext-diff', '--no-textconv'], { indexPath: exactIndex, maxOutputBytes: MAX_BUFFER_BYTES });
			const untracked = await this.safeMergeGit(context, worktreePath, ['ls-files', '--others', '--directory', '-z'], { indexPath: exactIndex, maxOutputBytes: MAX_BUFFER_BYTES });
			if (changed.stdout.length !== 0 || untracked.stdout.length !== 0) { throw new Error('Managed generation files differ from the recorded materialized tree.'); }
		} finally { if (existsSync(exactIndex)) { unlinkSync(exactIndex); } }
	}

	private async assertMaterializedGeneration(context: SafeMergeContext, generation: RegisteredGeneration, treeOid: string, expected: { readonly indexDigest: string; readonly treeDigest: string }): Promise<void> {
		const actualHead = (await this.git(generation.worktreePath, ['rev-parse', 'HEAD'])).trim();
		const digests = await this.generationDigests(context, generation.worktreePath, generation.indexPath, treeOid);
		await this.assertGenerationWorktreeMatches(context, generation.worktreePath, treeOid);
		if (actualHead !== generation.head || digests.indexDigest !== expected.indexDigest || digests.treeDigest !== expected.treeDigest) {
			throw new Error('Detached generation changed after materialization; publication is blocked.');
		}
	}

	private async assertGenerationBudget(context: SafeMergeContext, worktreePath: string, entries: readonly { path: string; mode: string; oid: string }[]): Promise<void> {
		if (entries.length > MAX_GENERATION_TREE_ENTRIES) { throw new Error('Merge generation exceeds its bounded file-count limit.'); }
		const objectIds = entries.map(entry => entry.oid);
		if (objectIds.length === 0) { return; }
		const input = Buffer.from(`${objectIds.join('\n')}\n`, 'ascii');
		const result = await this.safeMergeGit(context, worktreePath, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input, maxOutputBytes: MAX_BUFFER_BYTES });
		const lines = result.stdout.toString('ascii').trimEnd().split('\n');
		if (lines.length !== objectIds.length) { throw new Error('Merge generation object sizes are incomplete.'); }
		let totalBytes = 0;
		for (let index = 0; index < lines.length; index++) {
			const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/.exec(lines[index]);
			if (!match || match[1] !== objectIds[index]) { throw new Error('Merge generation contains an unsupported tree object.'); }
			const size = Number(match[2]);
			if (!Number.isSafeInteger(size) || size < 0 || size > MAX_GENERATION_TREE_BYTES || (totalBytes += size) > MAX_GENERATION_TREE_BYTES) {
				throw new Error('Merge generation exceeds its bounded materialized-byte limit.');
			}
		}
	}

	private async registerDetachedGeneration(repositoryPath: string, commonDirectory: string, ownerId: string, head: string, safeContext: SafeMergeContext, generationId = randomUUID(), registrationId = randomUUID()): Promise<RegisteredGeneration> {
		const worktreePath = this.generationPath(ownerId, generationId);
		this.ensureGenerationParent(ownerId);
		if (existsSync(worktreePath)) { throw new Error('The unpredictable integration generation path is already occupied.'); }
		const env = { GIT_CONFIG_GLOBAL: safeContext.environment.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
		await this.runGit(repositoryPath, [
			'-c', `core.hooksPath=${join(safeContext.root, 'hooks')}`, '-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false',
			'worktree', 'add', '--detach', '--no-checkout', '--lock', worktreePath, head
		], { env, maxOutputBytes: 64 * 1024 });
		if (realpathSync(worktreePath) !== worktreePath
			|| realpathSync((await this.git(worktreePath, ['rev-parse', '--show-toplevel'])).trim()) !== worktreePath
			|| realpathSync(isAbsolute((await this.git(worktreePath, ['rev-parse', '--git-common-dir'])).trim())
				? (await this.git(worktreePath, ['rev-parse', '--git-common-dir'])).trim()
				: resolve(worktreePath, (await this.git(worktreePath, ['rev-parse', '--git-common-dir'])).trim())) !== commonDirectory
			|| (await this.git(worktreePath, ['branch', '--show-current'])).trim() !== ''
			|| (await this.git(worktreePath, ['rev-parse', 'HEAD'])).trim() !== head) {
			throw new Error('Registered detached generation failed exact repository, HEAD, or branch verification.');
		}
		const indexPath = await this.generationIndexPath(worktreePath);
		return { generationId, registrationId, worktreePath, indexPath, head };
	}

	private async capturePriorGeneration(context: SafeMergeContext, lease: ManagedWorktreeLease): Promise<ManagedWorktreeGeneration> {
		const indexPath = await this.generationIndexPath(lease.worktreePath);
		const tree = (await this.safeMergeGit(context, lease.worktreePath, ['rev-parse', `${lease.head}^{tree}`])).stdout.toString('ascii').trim();
		if (!OBJECT_ID_PATTERN.test(tree)) { throw new Error('Prior integration generation tree is unavailable.'); }
		const digests = await this.generationDigests(context, lease.worktreePath, indexPath, tree);
		if (lease.generationId) {
			const recorded = lease.generations?.find(value => value.generationId === lease.generationId);
			if (!recorded || recorded.head !== lease.head || recorded.treeOid !== tree || recorded.indexDigest !== digests.indexDigest || recorded.treeDigest !== digests.treeDigest) {
				throw new Error('Current generation differs from its signed retained-generation record.');
			}
			return recorded;
		}
		return { generationId: randomUUID(), worktreePath: lease.worktreePath, registrationId: randomUUID(), head: lease.head, treeOid: tree, ...digests };
	}

	private async assertPriorGenerationUnchanged(lease: ManagedWorktreeLease, prior: ManagedWorktreeGeneration): Promise<void> {
		if (!existsSync(prior.worktreePath) || lstatSync(prior.worktreePath).isSymbolicLink() || realpathSync(prior.worktreePath) !== prior.worktreePath) {
			throw new Error('Prior integration generation path changed; publication is blocked.');
		}
		const head = (await this.git(prior.worktreePath, ['rev-parse', 'HEAD'])).trim();
		const indexPath = await this.generationIndexPath(prior.worktreePath);
		const context = await this.createSafeMergeContext(lease, false);
		try {
			const tree = prior.treeOid;
			const digests = await this.generationDigests(context, prior.worktreePath, indexPath, tree);
			if (head !== prior.head || tree !== prior.treeOid || digests.indexDigest !== prior.indexDigest || digests.treeDigest !== prior.treeDigest) {
				throw new Error('Prior integration generation changed during merge; publication is blocked.');
			}
			await this.assertGenerationWorktreeMatches(context, prior.worktreePath, prior.treeOid);
		} finally { this.removeSafeMergeContext(context); }
	}

	private async createReviewedMergeCommit(context: SafeMergeContext, worktreePath: string, treeOid: string, preview: MergePreview, identity: { readonly author: ReviewedCommitIdentity; readonly committer: ReviewedCommitIdentity }): Promise<string> {
		const output = await this.safeMergeGit(context, worktreePath, ['-c', 'commit.gpgsign=false', 'commit-tree', treeOid, '-p', preview.targetHead, '-p', preview.sourceHead, '-m', preview.commitMessage], {
			maxOutputBytes: 4096, author: identity.author, committer: identity.committer
		});
		const oid = output.stdout.toString('ascii').trim();
		if (!OBJECT_ID_PATTERN.test(oid) || oid !== oid.toLowerCase()) { throw new Error('Git returned an invalid merge candidate commit.'); }
		const bytes = (await this.safeMergeGit(context, worktreePath, ['cat-file', 'commit', oid], { maxOutputBytes: 16 * 1024 })).stdout;
		const split = bytes.indexOf(Buffer.from('\n\n'));
		if (split < 0) { throw new Error('Candidate merge commit headers are malformed.'); }
		const headers = bytes.subarray(0, split).toString('utf8').split('\n');
		const expected = [
			`tree ${treeOid}`, `parent ${preview.targetHead}`, `parent ${preview.sourceHead}`,
			`author ${identity.author.name} <${identity.author.email}> ${identity.author.date}`,
			`committer ${identity.committer.name} <${identity.committer.email}> ${identity.committer.date}`
		];
		if (headers.length !== expected.length || headers.some((value, index) => value !== expected[index])
			|| !bytes.subarray(split + 2).equals(Buffer.from(`${preview.commitMessage}\n`, 'utf8'))) {
			throw new Error('Candidate merge commit differs from its exact approved tree, parents, identity, or message.');
		}
		return oid;
	}

	private async finalizeMergeGeneration(lease: ManagedWorktreeLease, pending: PendingOperation, generation: RegisteredGeneration, head: string, digests: { readonly indexDigest: string; readonly treeDigest: string }, merge: MergeTreeResult, prior: ManagedWorktreeGeneration | null): Promise<ReviewedMergeResult> {
		const operation = mergeReceipt(pending, merge.clean ? 'merged' : 'conflict', merge.clean ? head : undefined, merge.clean ? undefined : merge.conflicts.map(item => item.path));
		const next: ManagedWorktreeGeneration = { generationId: generation.generationId, worktreePath: generation.worktreePath, registrationId: generation.registrationId, head: generation.head, treeOid: merge.treeOid, ...digests };
		const generations = [...(lease.generations ?? []), ...(prior && !lease.generationId ? [prior] : []), next];
		const updated = this.writeLease({
			...lease, worktreePath: generation.worktreePath, head, state: merge.clean ? 'active' : 'conflict',
			generationId: generation.generationId, registrationId: generation.registrationId, generations,
			pendingOperation: undefined, lastOperation: operation
		});
		return merge.clean ? { state: 'merged', commit: head, integration: updated } : { state: 'conflict', integration: updated, conflictedPaths: merge.conflicts.map(item => item.path) };
	}

	private async materializeGeneration(context: SafeMergeContext, generation: RegisteredGeneration, treeOid: string, conflicts: readonly AgentSessionMergeConflictArtifact[]): Promise<{ readonly indexDigest: string; readonly treeDigest: string }> {
		if (existsSync(join(generation.worktreePath, 'MERGE_HEAD')) || existsSync(join(generation.worktreePath, 'index.lock'))) { throw new Error('New detached generation unexpectedly contains merge state.'); }
		await this.safeMergeGit(context, generation.worktreePath, ['read-tree', treeOid], { indexPath: generation.indexPath });
		await this.safeMergeGit(context, generation.worktreePath, ['checkout-index', '--all', '--force'], { indexPath: generation.indexPath, maxOutputBytes: MAX_BUFFER_BYTES });
		if (conflicts.length) {
			const zeroOid = '0'.repeat(treeOid.length);
			const entries: Buffer[] = [];
			for (const conflict of conflicts) {
				if (!conflict.stages.length) { continue; }
				entries.push(Buffer.from(`0 ${zeroOid}\t${conflict.path}\0`, 'utf8'));
				for (const stage of conflict.stages) { entries.push(Buffer.from(`${stage.mode} ${stage.oid} ${stage.stage}\t${conflict.path}\0`, 'utf8')); }
			}
			if (entries.length) { await this.safeMergeGit(context, generation.worktreePath, ['update-index', '-z', '--index-info'], { indexPath: generation.indexPath, input: Buffer.concat(entries) }); }
		}
		const digests = await this.generationDigests(context, generation.worktreePath, generation.indexPath, treeOid);
		const actualHead = (await this.git(generation.worktreePath, ['rev-parse', 'HEAD'])).trim();
		if (actualHead !== generation.head) { throw new Error('Materializing a detached generation unexpectedly changed its HEAD.'); }
		return digests;
	}

	private async detachedHeadPath(worktreePath: string): Promise<string> {
		const gitDirectory = realpathSync((await this.git(worktreePath, ['rev-parse', '--absolute-git-dir'])).trim());
		const headPath = join(gitDirectory, 'HEAD');
		if (lstatSync(headPath).isSymbolicLink() || !lstatSync(headPath).isFile()) { throw new Error('Legacy integration HEAD is not a regular owned file.'); }
		return headPath;
	}

	private async detachLegacyIntegration(lease: ManagedWorktreeLease, expectedHead: string): Promise<void> {
		if (lease.generationId) { return; }
		const headPath = await this.detachedHeadPath(lease.worktreePath);
		const current = readFileSync(headPath, 'utf8');
		const expected = `ref: refs/heads/${lease.branch}\n`;
		if (current !== expected) { throw new Error('Legacy integration HEAD changed before journaled detachment.'); }
		const lockPath = `${headPath}.lock`;
		const fd = openSync(lockPath, 'wx', 0o600);
		try { writeFileSync(fd, `${expectedHead}\n`); fsyncSync(fd); } finally { closeSync(fd); }
		const latest = readFileSync(headPath, 'utf8');
		if (latest !== expected) { unlinkSync(lockPath); throw new Error('Legacy integration HEAD changed while acquiring its lock.'); }
		renameSync(lockPath, headPath);
		const directory = openSync(dirname(headPath), 'r');
		try { fsyncSync(directory); } finally { closeSync(directory); }
	}

	private async updateDetachedGenerationHead(worktreePath: string, expectedHead: string, resultingHead: string): Promise<void> {
		const headPath = await this.detachedHeadPath(worktreePath);
		const current = readFileSync(headPath, 'utf8');
		if (current !== `${expectedHead}\n`) { throw new Error('Detached generation HEAD changed before conditional advancement.'); }
		const lockPath = `${headPath}.lock`;
		const fd = openSync(lockPath, 'wx', 0o600);
		try { writeFileSync(fd, `${resultingHead}\n`); fsyncSync(fd); } finally { closeSync(fd); }
		if (readFileSync(headPath, 'utf8') !== `${expectedHead}\n`) {
			unlinkSync(lockPath);
			throw new Error('Detached generation HEAD changed while acquiring its lock.');
		}
		renameSync(lockPath, headPath);
		const directory = openSync(dirname(headPath), 'r');
		try { fsyncSync(directory); } finally { closeSync(directory); }
	}

	private async recordMergeArtifact(input: Pick<ReviewedMergeJournal, 'recordArtifact' | 'readArtifacts'>, operationId: string, current: readonly AgentSessionMergeArtifactRecord[], event: AgentSessionMergeArtifactEvent): Promise<readonly AgentSessionMergeArtifactRecord[]> {
		if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_MERGE_ARTIFACT_BYTES) { throw new Error('Merge artifact exceeds its bounded durable size.'); }
		const expectedRevision = current.length;
		const appended = await input.recordArtifact(operationId, expectedRevision, event);
		const reread = await input.readArtifacts(operationId);
		if (!Array.isArray(reread) || reread.length !== expectedRevision + 1 || appended.revision !== expectedRevision + 1
			|| reread.some((record, index) => index < current.length && (record.revision !== current[index].revision || JSON.stringify(record.event) !== JSON.stringify(current[index].event)))
			|| reread.at(-1)?.revision !== appended.revision || JSON.stringify(reread.at(-1)?.event) !== JSON.stringify(event)) {
			throw new Error('Merge artifact did not read back as the exact durable next phase.');
		}
		return reread;
	}

	private async publishIntegrationRef(lease: ManagedWorktreeLease, source: ManagedWorktreeLease, sourceHead: string, targetHead: string, resultingHead: string, context: SafeMergeContext): Promise<void> {
		const input = Buffer.from(`start\noption no-deref\nverify refs/heads/${source.branch} ${sourceHead}\nupdate refs/heads/${lease.branch} ${resultingHead} ${targetHead}\nprepare\ncommit\n`, 'utf8');
		await this.runGit(lease.repositoryPath, ['-c', `core.hooksPath=${join(context.root, 'hooks')}`, '-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false', 'update-ref', '--stdin'], {
			env: { GIT_CONFIG_GLOBAL: context.environment.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }, input, maxOutputBytes: 64 * 1024
		});
	}

	private assertMergeSourceReady(lease: ManagedWorktreeLease): void {
		if (lease.kind !== 'session' || lease.state !== 'active' || lease.pendingOperation) { throw new Error('The source session worktree is not an active committed source.'); }
	}

	private async assertMergePreviewFresh(preview: MergePreview, integration: ManagedWorktreeLease, session: ManagedWorktreeLease, context: SafeMergeContext): Promise<void> {
		if (integration.state !== (preview.resolution ? 'conflict' : 'active') || session.state !== 'active'
			|| integration.kind !== 'integration' || session.kind !== 'session'
			|| integration.ownerId !== preview.integrationOwnerId || session.ownerId !== preview.sessionOwnerId
			|| integration.commonDirectory !== session.commonDirectory) {
			throw new Error('Merge proposal worktree ownership or state changed; prepare a fresh review.');
		}
		if (preview.resolution) {
			const current = await this.captureResolution(context, integration, { ...preview.resolution, sourceHead: preview.sourceHead, targetHead: preview.targetHead, mergeBase: preview.mergeBase });
			if (JSON.stringify(current) !== JSON.stringify(preview.resolution)) { throw new Error('The staged resolution changed after review; prepare a new proposal and approval.'); }
		} else { await this.assertMergeWorktreeClean(context, integration); }
		const targetHead = await this.git(integration.worktreePath, ['rev-parse', 'HEAD']);
		const sourceHead = await this.git(session.worktreePath, ['rev-parse', 'HEAD']);
		const mergeBase = await this.resolveUniqueMergeBase(context, integration.worktreePath, targetHead, sourceHead);
		const targetRef = await this.git(integration.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${integration.branch}`]);
		const sourceRef = await this.git(session.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${session.branch}`]);
		const patch = (await this.safeMergeGit(context, integration.worktreePath, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', preview.resolution ? targetHead : mergeBase, preview.resolution?.treeOid ?? sourceHead], { maxOutputBytes: MAX_BUFFER_BYTES })).stdout;
		if (sourceRef !== sourceHead || targetRef !== targetHead || sourceHead !== preview.sourceHead || targetHead !== preview.targetHead || mergeBase !== preview.mergeBase
			|| createHash('sha256').update(patch).digest('hex') !== preview.diffHash) {
			throw new Error('Merge preview is stale because a source or target change occurred; review again.');
		}
	}

	private async assertMergeCommitMetadata(context: SafeMergeContext, worktreePath: string, commitOid: string, treeOid: string, applying: ReviewedMergeApplyingRecord): Promise<void> {
		const bytes = (await this.safeMergeGit(context, worktreePath, ['cat-file', 'commit', commitOid], { maxOutputBytes: 16 * 1024 })).stdout;
		const separator = bytes.indexOf(Buffer.from('\n\n'));
		if (separator < 0) { throw new Error('Recorded merge commit object has malformed headers.'); }
		const headers = bytes.subarray(0, separator).toString('utf8').split('\n');
		const expected = [
			`tree ${treeOid}`, `parent ${applying.targetHead}`, `parent ${applying.sourceHead}`,
			`author ${applying.author.name} <${applying.author.email}> ${applying.author.date}`,
			`committer ${applying.committer.name} <${applying.committer.email}> ${applying.committer.date}`
		];
		if (headers.length !== expected.length || headers.some((value, index) => value !== expected[index])
			|| !bytes.subarray(separator + 2).equals(Buffer.from(`${applying.commitMessage}\n`, 'utf8'))) {
			throw new Error('Recorded merge commit differs from the exact approved tree, parents, identity, or message.');
		}
	}

	private expireMergePreviews(): void {
		const now = Date.now();
		for (const [id, preview] of this.previews) { if (preview.expiresAt <= now) { this.previews.delete(id); } }
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
			await this.runGit(lease.worktreePath, ['update-index', '-z', '--index-info'], { env: { GIT_INDEX_FILE: privateIndex }, input: Buffer.concat(input) });
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
			const before = 'sha256' in file.before ? { mode: file.before.mode, sha256: file.before.sha256.toLowerCase() } : { absent: true as const };
			const after = 'absent' in file.after ? { absent: true as const } : { mode: file.after.mode, sha256: file.after.sha256.toLowerCase() };
			return { path: file.path, before, after, ...('bytes' in file.after ? { bytes: Buffer.from(file.after.bytes) } : {}) };
		});
	}

	private validateRetainedFileBytes(files: StoredReviewedCommitPreview['files']): void {
		let totalBytes = 0;
		for (const file of files) {
			if (!file.bytes) { continue; }
			if (!('sha256' in file.after)) { throw new Error('Absent reviewed file cannot contain retained bytes.'); }
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
		const env = this.discoveryGitEnvironment();
		for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE'] as const) {
			if (process.env[key] !== undefined) { env[key] = process.env[key]; }
		}
		const value = (await this.runGit(cwd, ['var', variable], { env })).stdout.toString('utf8').trimEnd();
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
			await this.runGit(lease.worktreePath, ['update-index', '-z', '--index-info'], { env: indexEnv, input: Buffer.concat(entries) });
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
		const allowedKeys = new Set(['version', 'ownerId', 'kind', 'repositoryPath', 'commonDirectory', 'branch', 'worktreePath', 'baseCommit', 'head', 'state', 'pendingOperation', 'lastOperation', 'generationId', 'registrationId', 'generations', 'signature']);
		if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).some(key => !allowedKeys.has(key))
			|| typeof parsed.signature !== 'string' || !/^[0-9a-f]{64}$/i.test(parsed.signature)) {
			throw new Error('Managed worktree manifest contains unsupported or malformed fields.');
		}
		if (parsed.pendingOperation && Object.keys(parsed.pendingOperation).some(key => !['id', 'kind', 'startedAt', 'proposalId', 'proposalFingerprint', 'sourceOwnerId', 'sourceHead', 'targetHead', 'mergeBase', 'diffFingerprint', 'expectedHead', 'retainedIntegrationOwnerId', 'generationId', 'generationPath', 'registrationId'].includes(key))) {
			throw new Error('Managed worktree pending operation contains unsupported fields.');
		}
		if (parsed.lastOperation && Object.keys(parsed.lastOperation).some(key => !['id', 'kind', 'outcome', 'commit', 'reconciled', 'proposalId', 'proposalFingerprint', 'sourceOwnerId', 'sourceHead', 'targetHead', 'mergeBase', 'diffFingerprint', 'conflictedPaths'].includes(key))) {
			throw new Error('Managed worktree operation receipt contains unsupported fields.');
		}
		const unsigned = this.manifestPayload(parsed);
		const expectedSignature = this.sign(unsigned);
		const actualSignature = Buffer.from(parsed.signature, 'hex');
		const expectedSignatureBytes = Buffer.from(expectedSignature, 'hex');
		if (actualSignature.length !== expectedSignatureBytes.length || !timingSafeEqual(actualSignature, expectedSignatureBytes)) { throw new Error('Managed worktree manifest signature is invalid.'); }
		if (![1, 2].includes(parsed.version) || parsed.ownerId !== ownerId || !['session', 'integration'].includes(parsed.kind)
			|| (parsed.version === 2 && (parsed.kind !== 'integration' || !UUID_PATTERN.test(parsed.generationId ?? '') || !UUID_PATTERN.test(parsed.registrationId ?? '') || !Array.isArray(parsed.generations)))) {
			throw new Error('Managed worktree manifest identity is invalid.');
		}
		const verifiedLease = this.publicLease(unsigned);
		const expectedWorktree = parsed.version === 2 ? parsed.worktreePath : join(this.root, parsed.kind, ownerId);
		const expectedBranch = `bugfixer/${parsed.kind}/${ownerId}`;
		if (parsed.worktreePath !== expectedWorktree || parsed.branch !== expectedBranch) { throw new Error('Managed worktree path or ref identity was retargeted.'); }
		if (parsed.version === 2) { this.assertGenerationManifest(parsed, expectedWorktree); }
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
		const worktreeBranch = await this.git(expectedWorktree, ['branch', '--show-current']);
		if (realpathSync(worktreeRoot) !== expectedWorktree
			|| realpathSync(isAbsolute(worktreeCommonValue) ? worktreeCommonValue : resolve(expectedWorktree, worktreeCommonValue)) !== commonDirectory
			|| (parsed.version === 2 ? worktreeBranch !== '' : worktreeBranch !== expectedBranch && !(parsed.kind === 'integration' && worktreeBranch === '' && parsed.pendingOperation?.kind === 'merge'))) {
			throw new Error('Managed worktree repository, common-dir, or branch identity does not match its manifest.');
		}
		const head = await this.git(expectedWorktree, ['rev-parse', 'HEAD']);
		const branchHead = await this.git(repositoryPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${expectedBranch}`]);
		if (branchHead !== head && parsed.pendingOperation?.kind !== 'merge') { throw new Error('Managed worktree branch ref does not match its checked-out HEAD; explicit recovery is required.'); }
		if (parsed.version === 2 && branchHead !== head && parsed.pendingOperation?.kind !== 'merge') { throw new Error('Integration generation HEAD does not match its logical branch ref.'); }
		if (parsed.version === 2) {
			const context = await this.createSafeMergeContext({ ...verifiedLease, ownerId, kind: parsed.kind, repositoryPath, commonDirectory, branch: expectedBranch, worktreePath: expectedWorktree, baseCommit: parsed.baseCommit, head }, false);
			try {
				for (const generation of parsed.generations!) {
					const registration = await this.git(generation.worktreePath, ['worktree', 'list', '--porcelain']);
					const registeredRoot = (await this.git(generation.worktreePath, ['rev-parse', '--show-toplevel'])).trim();
					const generationCommonValue = (await this.git(generation.worktreePath, ['rev-parse', '--git-common-dir'])).trim();
					const generationCommon = realpathSync(isAbsolute(generationCommonValue) ? generationCommonValue : resolve(generation.worktreePath, generationCommonValue));
					const worktreeHead = (await this.git(generation.worktreePath, ['rev-parse', 'HEAD'])).trim();
					const worktreeBranch = (await this.git(generation.worktreePath, ['branch', '--show-current'])).trim();
					const indexPath = await this.generationIndexPath(generation.worktreePath);
					// Retained and conflict generations are human-owned working files. Validate their
					// registration here; exact content is checked only by the operation using them.
					const verifyContent = generation.generationId === parsed.generationId && parsed.state === 'active' && !parsed.pendingOperation;
					if (verifyContent) {
						const digests = await this.generationDigests(context, generation.worktreePath, indexPath, generation.treeOid);
						await this.assertGenerationWorktreeMatches(context, generation.worktreePath, generation.treeOid);
						if (digests.indexDigest !== generation.indexDigest || digests.treeDigest !== generation.treeDigest) { throw new Error('Current integration generation differs from its signed content digests.'); }
					}
					if (realpathSync(registeredRoot) !== generation.worktreePath || generationCommon !== commonDirectory
						|| !registration.includes(`worktree ${generation.worktreePath}\n`) || worktreeHead !== generation.head || worktreeBranch !== '') {
						throw new Error('A retained integration generation no longer matches its signed registration and content digests.');
					}
				}
			} finally { this.removeSafeMergeContext(context); }
		}
		return { ...verifiedLease, ownerId, kind: parsed.kind, repositoryPath, commonDirectory, branch: expectedBranch, worktreePath: expectedWorktree, baseCommit: parsed.baseCommit, head };
	}

	private assertGenerationManifest(manifest: LeaseManifest, currentPath: string): void {
		if (manifest.kind !== 'integration' || manifest.version !== 2 || !UUID_PATTERN.test(manifest.generationId ?? '')
			|| !UUID_PATTERN.test(manifest.registrationId ?? '') || !Array.isArray(manifest.generations)
			|| manifest.generations.length === 0 || manifest.generations.length > MAX_INTEGRATION_GENERATIONS) {
			throw new Error('Integration generation manifest is malformed or exceeds its retention limit.');
		}
		const seen = new Set<string>();
		let currentFound = false;
		for (const generation of manifest.generations) {
			const legacyPath = join(this.root, 'integration', manifest.ownerId);
			if (!generation || Object.keys(generation).sort(compareCodeUnits).join(',') !== 'generationId,head,indexDigest,registrationId,treeDigest,treeOid,worktreePath'
				|| !UUID_PATTERN.test(generation.generationId) || !UUID_PATTERN.test(generation.registrationId)
				|| !OBJECT_ID_PATTERN.test(generation.head) || !OBJECT_ID_PATTERN.test(generation.treeOid) || !SHA256_PATTERN.test(generation.indexDigest) || !SHA256_PATTERN.test(generation.treeDigest)
				|| seen.has(generation.generationId) || (generation.worktreePath !== this.generationPath(manifest.ownerId, generation.generationId) && generation.worktreePath !== legacyPath)) {
				throw new Error('Integration generation history contains malformed or retargeted data.');
			}
			seen.add(generation.generationId);
			if (generation.generationId === manifest.generationId) {
				if (generation.registrationId !== manifest.registrationId || generation.worktreePath !== currentPath || generation.head !== manifest.head) {
					throw new Error('Current integration generation does not match its signed manifest pointer.');
				}
				currentFound = true;
			}
			if (existsSync(generation.worktreePath)) {
				if (lstatSync(generation.worktreePath).isSymbolicLink() || realpathSync(generation.worktreePath) !== generation.worktreePath) {
					throw new Error('Retained integration generation path was replaced by a symbolic link.');
				}
			} else {
				throw new Error('A retained integration generation is missing; explicit recovery is required.');
			}
		}
		if (!currentFound) { throw new Error('Current integration generation is absent from signed history.'); }
	}

	private async reconcilePendingOperation(lease: ManagedWorktreeLease): Promise<ManagedWorktreeLease> {
		const pending = lease.pendingOperation!;
		if (await this.operationLockIsLive(lease.kind === 'integration' ? lease.ownerId : pending.retainedIntegrationOwnerId ?? lease.ownerId)) {
			return { ...lease, state: 'recoveryRequired' };
		}
		if (pending.kind !== 'remove') { return { ...lease, state: 'recoveryRequired' }; }
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
			...(lease.pendingOperation.proposalId !== undefined ? { proposalId: lease.pendingOperation.proposalId } : {}),
			...(lease.pendingOperation.proposalFingerprint !== undefined ? { proposalFingerprint: lease.pendingOperation.proposalFingerprint } : {}),
			...(lease.pendingOperation.sourceOwnerId !== undefined ? { sourceOwnerId: lease.pendingOperation.sourceOwnerId } : {}),
			...(lease.pendingOperation.sourceHead !== undefined ? { sourceHead: lease.pendingOperation.sourceHead } : {}),
			...(lease.pendingOperation.targetHead !== undefined ? { targetHead: lease.pendingOperation.targetHead } : {}),
			...(lease.pendingOperation.mergeBase !== undefined ? { mergeBase: lease.pendingOperation.mergeBase } : {}),
			...(lease.pendingOperation.diffFingerprint !== undefined ? { diffFingerprint: lease.pendingOperation.diffFingerprint } : {}),
			...(lease.pendingOperation.expectedHead !== undefined ? { expectedHead: lease.pendingOperation.expectedHead } : {}),
			...(lease.pendingOperation.retainedIntegrationOwnerId !== undefined ? { retainedIntegrationOwnerId: lease.pendingOperation.retainedIntegrationOwnerId } : {}),
			...(lease.pendingOperation.generationId !== undefined ? { generationId: lease.pendingOperation.generationId } : {}),
			...(lease.pendingOperation.generationPath !== undefined ? { generationPath: lease.pendingOperation.generationPath } : {}),
			...(lease.pendingOperation.registrationId !== undefined ? { registrationId: lease.pendingOperation.registrationId } : {})
		} : undefined;
		const lastOperation = lease.lastOperation ? {
			id: lease.lastOperation.id, kind: lease.lastOperation.kind, outcome: lease.lastOperation.outcome,
			...(lease.lastOperation.proposalId !== undefined ? { proposalId: lease.lastOperation.proposalId } : {}),
			...(lease.lastOperation.proposalFingerprint !== undefined ? { proposalFingerprint: lease.lastOperation.proposalFingerprint } : {}),
			...(lease.lastOperation.commit !== undefined ? { commit: lease.lastOperation.commit } : {}),
			...(lease.lastOperation.reconciled !== undefined ? { reconciled: lease.lastOperation.reconciled } : {}),
			...(lease.lastOperation.sourceOwnerId !== undefined ? { sourceOwnerId: lease.lastOperation.sourceOwnerId } : {}),
			...(lease.lastOperation.sourceHead !== undefined ? { sourceHead: lease.lastOperation.sourceHead } : {}),
			...(lease.lastOperation.targetHead !== undefined ? { targetHead: lease.lastOperation.targetHead } : {}),
			...(lease.lastOperation.mergeBase !== undefined ? { mergeBase: lease.lastOperation.mergeBase } : {}),
			...(lease.lastOperation.diffFingerprint !== undefined ? { diffFingerprint: lease.lastOperation.diffFingerprint } : {}),
			...(lease.lastOperation.conflictedPaths !== undefined ? { conflictedPaths: lease.lastOperation.conflictedPaths } : {})
		} : undefined;
		const version: 1 | 2 = lease.kind === 'integration' && lease.generationId ? 2 : 1;
		return {
			version, ownerId: lease.ownerId, kind: lease.kind, repositoryPath: lease.repositoryPath,
			commonDirectory: lease.commonDirectory, branch: lease.branch, worktreePath: lease.worktreePath,
			baseCommit: lease.baseCommit, head: lease.head, state: lease.state, pendingOperation, lastOperation,
			...(version === 2 ? { generationId: lease.generationId, registrationId: lease.registrationId, generations: lease.generations } : {})
		};
	}

	private publicLease(payload: LeaseManifestPayload): ManagedWorktreeLease {
		return {
			ownerId: payload.ownerId, kind: payload.kind, repositoryPath: payload.repositoryPath,
			commonDirectory: payload.commonDirectory, branch: payload.branch, worktreePath: payload.worktreePath,
			baseCommit: payload.baseCommit, head: payload.head, state: payload.state,
			...(payload.pendingOperation ? { pendingOperation: payload.pendingOperation } : {}),
			...(payload.lastOperation ? { lastOperation: payload.lastOperation } : {}),
			...(payload.generationId ? { generationId: payload.generationId } : {}),
			...(payload.registrationId ? { registrationId: payload.registrationId } : {}),
			...(payload.generations ? { generations: payload.generations } : {})
		};
	}

	private async withIntegrationLock<T>(ownerId: string, operation: OperationLock['operation'], run: () => Promise<T>): Promise<T> {
		const lock = await this.acquireIntegrationLock(ownerId, operation);
		try { return await run(); } finally { lock.release(); }
	}

	private async acquireIntegrationLock(ownerId: string, operation: OperationLock['operation']): Promise<{ assertOwned(): void; release(): void }> {
		this.validateOwnerId(ownerId);
		const lockPath = join(this.root, `${ownerId}.operation-lock.json`);
		if (await this.operationLockIsLive(ownerId)) { throw new Error('Integration operation is owned by a live process; refusing concurrent mutation.'); }
		const unsigned = { ownerId, operation, operationId: randomUUID(), pid: process.pid, processStart: await this.processStartToken(process.pid) };
		const lock: OperationLock = { ...unsigned, signature: this.sign(unsigned) };
		let created: { readonly dev: number; readonly ino: number } | undefined;
		try {
			const lockFd = openSync(lockPath, 'wx', 0o600);
			try { created = fstatSync(lockFd); writeFileSync(lockFd, JSON.stringify(lock)); fsyncSync(lockFd); } finally { closeSync(lockFd); }
			const rootFd = openSync(this.root, 'r');
			try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
		}
		catch (error) {
			if (created && existsSync(lockPath)) {
				const current = lstatSync(lockPath);
				if (current.isSymbolicLink() || current.dev !== created.dev || current.ino !== created.ino) { throw new Error('Incomplete operation lock changed ownership; manual recovery is required.'); }
				unlinkSync(lockPath);
				const rootFd = openSync(this.root, 'r');
				try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
			}
			throw new Error(`Integration operation lock could not be acquired safely: ${this.errorMessage(error)}`);
		}
		let released = false;
		const assertOwned = (): void => {
			if (released) { throw new Error('Operation lease has already been released.'); }
			const current = this.readOperationLock(lockPath);
			if (current.operationId !== lock.operationId || current.ownerId !== ownerId || current.operation !== operation || !this.isValidSignature(current)) { throw new Error('Operation lock ownership changed; recovery is required.'); }
		};
		return { assertOwned, release: () => {
			if (released) { return; }
			assertOwned(); unlinkSync(lockPath); released = true;
			const rootFd = openSync(this.root, 'r');
			try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
		} };
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
		const metadata = lstatSync(lockPath);
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 || (metadata.mode & 0o077) !== 0
			|| (process.getuid && metadata.uid !== process.getuid())) { throw new Error('Operation lock file ownership is invalid; manual recovery is required.'); }
		try { lock = JSON.parse(readFileSync(lockPath, 'utf8')) as OperationLock; }
		catch (error) { throw new Error(`Operation lock metadata is malformed or ambiguous; manual recovery is required: ${this.errorMessage(error)}`); }
		if (!lock || !UUID_PATTERN.test(lock.ownerId) || !UUID_PATTERN.test(lock.operationId)
			|| !['merge', 'remove', 'ensureIntegration', 'prepareCommit', 'applyReviewedCommit', 'publication'].includes(lock.operation) || !Number.isSafeInteger(lock.pid) || lock.pid <= 0
			|| typeof lock.processStart !== 'string' || !lock.processStart || !this.isValidSignature(lock)) {
			throw new Error('Operation lock metadata is invalid or ambiguous; manual recovery is required.');
		}
		return lock;
	}

	private async processStartToken(pid: number): Promise<string> {
		const result = await this.runCommand('/bin/ps', ['-p', String(pid), '-o', 'lstart='], 2_000, { isolated: true });
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

	private async runGit(cwd: string, args: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly input?: Buffer; readonly maxOutputBytes?: number; readonly allowExitCodes?: readonly number[] } = {}): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
		return this.runCommand('git', ['-C', cwd, ...args], COMMAND_TIMEOUT_MS, options);
	}

	private runCommand(command: string, args: readonly string[], timeoutMs: number, options: { readonly env?: NodeJS.ProcessEnv; readonly isolated?: boolean; readonly input?: Buffer; readonly maxOutputBytes?: number; readonly allowExitCodes?: readonly number[] } = {}): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
		const publication = this.publicationReads.getStore();
		if (publication) {
			if (command !== 'git') { throw new Error('Publication source validation only permits the pinned Git executable.'); }
			const env = publicationEnvironment(publication.home);
			for (const [key, value] of Object.entries(options.env ?? {})) { if (value !== undefined) { env[key] = value; } }
			// Only the private copy of an index may be refreshed. A nonzero refresh
			// (ordinarily inspected by diff-files) is already a publication rejection.
			return runPublicationProcess({ executable: publication.git,
				args: ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args],
				cwd: publication.home, env, input: options.input, maxOutputBytes: options.maxOutputBytes ?? MAX_BUFFER_BYTES, timeoutMs,
			}).then(stdout => ({ stdout, stderr: Buffer.alloc(0), exitCode: 0 }));
		}
		return new Promise((resolvePromise, rejectPromise) => {
			const child = spawn(command, args, { detached: process.platform !== 'win32', env: this.gitEnvironment(options.env, options.isolated), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
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
			child.stdin.on('error', error => { spawnError ??= error; });
			child.stdin.end(options.input);
			child.on('close', async (code, signal) => {
				clearTimeout(timeout);
				if (terminationRequested) { await cleanupPromise; }
				const out = Buffer.concat(stdout);
				const err = Buffer.concat(stderr);
				if (spawnError) { rejectPromise(spawnError); }
				else if (timedOut) { rejectPromise(new Error(`${command} exceeded its ${timeoutMs}ms timeout and its owned process group was terminated.`)); }
				else if (outputExceeded) { rejectPromise(new Error(`${command} exceeded the ${options.maxOutputBytes ?? MAX_BUFFER_BYTES}-byte output limit and its owned process group was terminated.`)); }
				else if (code !== 0 && !options.allowExitCodes?.includes(code ?? -1)) { rejectPromise(new Error(`${command} exited with ${signal ?? code}: ${err.toString('utf8').trim()}`)); }
				else { resolvePromise({ stdout: out, stderr: err, exitCode: code ?? -1 }); }
			});
		});
	}

	private gitEnvironment(overrides: NodeJS.ProcessEnv = {}, isolated = false): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = isolated ? Object.fromEntries(['PATH', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) : { ...process.env };
		const allowedGitVariables = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ATTR_NOSYSTEM', 'GIT_NO_REPLACE_OBJECTS', 'GIT_NO_LAZY_FETCH', 'GIT_OBJECT_DIRECTORY', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE']);
		for (const key of Object.keys(env)) {
			if (key.startsWith('GIT_')) { delete env[key]; }
		}
		env.GIT_OPTIONAL_LOCKS = '0';
		for (const [key, value] of Object.entries(overrides)) {
			if (!allowedGitVariables.has(key)) { throw new Error('Internal Git environment override is invalid.'); }
			if (value === undefined) { delete env[key]; } else { env[key] = value; }
		}
		return env;
	}

	/** Identity/config discovery alone honors explicit global config and system-config opt-out. */
	private discoveryGitEnvironment(): NodeJS.ProcessEnv {
		return Object.fromEntries(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
	}

	private sign(value: object): string {
		return createHmac('sha256', this.manifestKey).update(JSON.stringify(value)).digest('hex');
	}

	private manifestPath(ownerId: string): string { return join(this.root, `${ownerId}.json`); }
	private generationPath(ownerId: string, generationId: string): string {
		this.validateOwnerId(ownerId);
		if (!UUID_PATTERN.test(generationId)) { throw new Error('Integration generation ID must be a UUID.'); }
		return join(this.root, 'integration-generations', ownerId, generationId);
	}
	private ensureGenerationParent(ownerId: string): void {
		this.validateOwnerId(ownerId);
		const generationsRoot = join(this.root, 'integration-generations');
		const ownerRoot = join(generationsRoot, ownerId);
		for (const directory of [generationsRoot, ownerRoot]) {
			if (!existsSync(directory)) { mkdirSync(directory, { mode: 0o700 }); }
			const info = lstatSync(directory);
			if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(directory) !== directory) {
				throw new Error('Integration generation parent directory is not an exact app-owned directory.');
			}
		}
	}
	private generationArtifactPath(ownerId: string, generationId: string): string {
		this.validateOwnerId(ownerId);
		if (!UUID_PATTERN.test(generationId)) { throw new Error('Integration generation ID must be a UUID.'); }
		return `integration-generations/${ownerId}/${generationId}`;
	}
	private generationArtifactPathFromLease(ownerId: string, generation: ManagedWorktreeGeneration): string {
		if (generation.worktreePath === join(this.root, 'integration', ownerId)) { return `integration/${ownerId}`; }
		if (generation.worktreePath !== this.generationPath(ownerId, generation.generationId)) { throw new Error('Prior generation path is outside its signed owner directory.'); }
		return this.generationArtifactPath(ownerId, generation.generationId);
	}
	private priorGenerationMatchesLease(lease: ManagedWorktreeLease, prior: { readonly generationId: string; readonly generationPath: string; readonly registrationId: string; readonly head: string; readonly indexDigest: string; readonly treeDigest: string }): boolean {
		if (prior.head !== lease.head) { return false; }
		if (!lease.generationId) { return prior.generationPath === `integration/${lease.ownerId}`; }
		const current = lease.generations?.find(generation => generation.generationId === lease.generationId);
		return !!current && prior.generationId === current.generationId && prior.registrationId === current.registrationId
			&& prior.generationPath === this.generationArtifactPathFromLease(lease.ownerId, current)
			&& prior.head === current.head && prior.indexDigest === current.indexDigest && prior.treeDigest === current.treeDigest;
	}
	private resolvePriorGenerationPath(ownerId: string, generation: { readonly generationId: string; readonly generationPath: string }): string {
		if (generation.generationPath === `integration/${ownerId}`) { return join(this.root, 'integration', ownerId); }
		if (generation.generationPath === this.generationArtifactPath(ownerId, generation.generationId)) { return this.generationPath(ownerId, generation.generationId); }
		throw new Error('Prior generation artifact path is not bound to its logical owner.');
	}
	private validateOwnerId(ownerId: string): void { if (!UUID_PATTERN.test(ownerId)) { throw new Error('Managed worktree owner ID must be a UUID.'); } }
	private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
