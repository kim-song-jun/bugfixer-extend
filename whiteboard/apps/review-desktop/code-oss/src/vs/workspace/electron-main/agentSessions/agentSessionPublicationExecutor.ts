/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { AgentSessionPublicationEvent, AgentSessionPublicationOperationDTO, AgentSessionPublicationPrepareInput, AgentSessionPublicationProposalDTO, AgentSessionPublicationProviderErrorCode } from '../../common/workspaceAgentPublicationProtocol.js';
import { PublicationGithubSession, type PublicationPrObservation, type PublicationSelectedAccount } from './agentPublicationGithub.js';
import { PublicationGitContext, type PublicationGitBinaries, type PublicationSourceExport } from './agentPublicationGit.js';
import { createPublicationDirectory, PublicationFailure, type PublicationExecutable } from './agentPublicationProcess.js';
import type { AgentSessionPublicationStore } from './agentSessionPublicationStore.js';

/** Native main-process authority: the adapter verifies signed manager registrations, not paths. */
export interface PublicationHostAuthority {
	exportSource(sourceMergeId: string, remoteName: string): Promise<PublicationSourceExport>;
	resolveSelectedAccount(accountRef: string): Promise<PublicationSelectedAccount>;
	/** Recheck owning project/window, successful merge, latest proposal and trusted human approval. */
	assertCurrentApproval(proposal: AgentSessionPublicationProposalDTO): Promise<void>;
	/** Exclusive across application processes; held through all remote observations and journal CAS. */
	acquireOperation(proposalId: string): Promise<{ release(): Promise<void> }>;
}

export interface PublicationRuntime {
	readonly privateRoot: string;
	readonly gh: PublicationExecutable;
	readonly git: PublicationGitBinaries;
}

export interface PublicationExecutionServices {
	readonly openGithub: typeof PublicationGithubSession.open;
	readonly createGit: typeof PublicationGitContext.create;
}

/** Production executor. It never stages, commits, checks out, or modifies the user's Git context. */
export class AgentSessionPublicationExecutor {
	constructor(private readonly store: AgentSessionPublicationStore, private readonly authority: PublicationHostAuthority, private readonly runtime: PublicationRuntime,
		private readonly services: PublicationExecutionServices = { openGithub: PublicationGithubSession.open, createGit: PublicationGitContext.create }) { }

	async prepare(input: AgentSessionPublicationPrepareInput): Promise<AgentSessionPublicationProposalDTO> {
		const exported = await this.authority.exportSource(input.sourceMergeId, input.remoteName);
		let git: PublicationGitContext | undefined;
		try {
			if (input.projectId !== exported.source.projectId || input.sessionId !== exported.source.sessionId || input.turnId !== exported.source.turnId
				|| input.sourceMergeId !== exported.source.mergeProposalId || input.remoteName !== exported.remote.name) { throw new PublicationFailure('invalidObservation'); }
			git = await this.services.createGit(this.runtime.privateRoot, this.runtime.git, exported);
			const github = await this.openAccount(input.accountRef, git);
			const remote = await github.resolveRemote(exported.remote);
			const baseOid = await github.readBranch(remote, input.baseRef);
			if (!baseOid) { throw new PublicationFailure('baseChanged'); }
			const diff = await git.diff(baseOid, exported.source.resultCommit, remote, github);
			return this.store.createProposal({ ...input, projectId: exported.source.projectId, sessionId: exported.source.sessionId, turnId: exported.source.turnId,
				sourceMerge: exported.source, remote, account: github.account, base: { ref: input.baseRef, oid: baseOid }, diff });
		} finally { exported.pack.fill(0); await git?.dispose(); }
	}

	/** Called only after trusted native confirmation. Existing write intents are reconciled, not resent. */
	async publishApproved(proposalId: string, fingerprint: string): Promise<AgentSessionPublicationOperationDTO> {
		return this.withLease(proposalId, async () => {
			const proposal = this.proposal(proposalId, fingerprint);
			let operation = this.store.startOperation(proposal.id, proposal.fingerprint);
			operation = this.readExact(operation, proposal);
			if (operation.events.length || operation.state !== 'started') { return this.reconcileLocked(proposal, operation); }
			const fresh = await this.fresh(proposal);
			try {
				if (await fresh.github.readBranch(proposal.remote, proposal.publicationRef) !== null) { throw new PublicationFailure('remoteChanged'); }
				const writeGithub = await this.revalidateBeforeWrite(proposal, fresh.git, null);
				operation = this.append(operation, proposal, { type: 'branchWriteStarted', expectedOldRemoteOid: null });
				let failure: AgentSessionPublicationProviderErrorCode = 'none';
				try { await fresh.git.pushAbsentBranch(proposal, writeGithub); } catch (error) { failure = this.errorCode(error); }
				operation = await this.observeBranch(proposal, operation, writeGithub, failure);
			} finally { await fresh.git.dispose(); }
			return this.continueLocked(proposal, operation);
		});
	}

	/** Separate explicit native retry; only an already observed exact branch can reach a new POST. */
	async continueApprovedOperation(proposalId: string, fingerprint: string, operationId: string): Promise<AgentSessionPublicationOperationDTO> {
		return this.withLease(proposalId, async () => {
			const proposal = this.proposal(proposalId, fingerprint); const operation = this.readExact(this.store.readOperation(operationId), proposal);
			if (operation.state !== 'started' || operation.events.at(-1)?.event.type !== 'branchObserved') { return this.reconcileLocked(proposal, operation); }
			return this.continueLocked(proposal, operation);
		});
	}

	/** Reads remote state only. Expiry does not prevent recovery of an already persisted write intent. */
	async reconcile(proposalId: string, fingerprint: string, operationId: string): Promise<AgentSessionPublicationOperationDTO> {
		return this.withLease(proposalId, async () => {
			const proposal = this.proposal(proposalId, fingerprint);
			return this.reconcileLocked(proposal, this.readExact(this.store.readOperation(operationId), proposal));
		});
	}

	private async continueLocked(proposal: AgentSessionPublicationProposalDTO, operation: AgentSessionPublicationOperationDTO): Promise<AgentSessionPublicationOperationDTO> {
		if (operation.state !== 'started') { return operation; }
		const branch = operation.events.at(-1)?.event;
		if (branch?.type !== 'branchObserved' || branch.outcome !== 'created' || branch.oid !== proposal.resultCommit) { return this.finishObservation(proposal, operation); }
		const fresh = await this.fresh(proposal);
		try {
			if (await fresh.github.readBranch(proposal.remote, proposal.publicationRef) !== proposal.resultCommit) { throw new PublicationFailure('remoteChanged'); }
			// No POST if an earlier result already exists, even if another client opened/closed it.
			const existing = await fresh.github.findPullRequest(proposal);
			const writeGithub = existing ? fresh.github : await this.revalidateBeforeWrite(proposal, fresh.git, proposal.resultCommit);
			operation = this.append(operation, proposal, { type: 'pullRequestWriteStarted', headOid: proposal.resultCommit });
			let observation = existing;
			if (!observation) {
				try { observation = await writeGithub.createPullRequest(proposal); }
				catch (error) {
					try { observation = await writeGithub.findPullRequest(proposal); }
					catch { observation = this.unknownPr(proposal, this.errorCode(error)); }
					// A missing immediate result after POST is uncertain, not permission to send another POST.
					observation ??= this.unknownPr(proposal, this.errorCode(error));
				}
			}
			if (observation.id && observation.outcome === 'created') {
				try {
					const currentBase = await writeGithub.readBranch(proposal.remote, proposal.baseRef);
					if (!currentBase) { observation = { ...observation, outcome: 'unknown', errorCode: 'baseChanged' }; }
					else if (currentBase !== proposal.baseOid) { observation = { ...observation, baseOid: currentBase, errorCode: 'baseChanged' }; }
				} catch { observation = { ...observation, outcome: 'unknown', errorCode: 'networkUncertain' }; }
			}
			operation = this.append(operation, proposal, observation);
			return this.finishObservation(proposal, operation);
		} finally { await fresh.git.dispose(); }
	}

	private async reconcileLocked(proposal: AgentSessionPublicationProposalDTO, operation: AgentSessionPublicationOperationDTO): Promise<AgentSessionPublicationOperationDTO> {
		if (operation.state !== 'started' && operation.state !== 'recoveryRequired') { return operation; }
		const last = operation.events.at(-1)?.event;
		if (!last || (last.type === 'branchObserved' && operation.state === 'started')) { return operation; }
		if (last.type === 'pullRequestObserved') { return this.finishObservation(proposal, operation); }
		const directory = await createPublicationDirectory(this.runtime.privateRoot);
		try {
			const github = await this.services.openGithub(this.runtime.gh, await this.authority.resolveSelectedAccount(proposal.account.accountRef), directory);
			this.equal(github.account, proposal.account, 'accountChanged'); await github.assertRepositoryIdentity(proposal.remote);
			if (operation.state === 'recoveryRequired') {
				operation = await this.observeBranch(proposal, operation, github, 'none', true);
				if (!operation.events.some(record => record.event.type === 'pullRequestWriteStarted')) { return this.finishObservation(proposal, operation); }
				const previous = [...operation.events].reverse().find(record => record.event.type === 'pullRequestObserved' || record.event.type === 'pullRequestReobserved')?.event as PublicationPrObservation | undefined;
				let observation: PublicationPrObservation;
				try { observation = await github.findPullRequest(proposal) ?? this.unknownPr(proposal, 'networkUncertain', previous); }
				catch (error) { observation = this.unknownPr(proposal, this.errorCode(error), previous); }
				operation = this.append(operation, proposal, { ...observation, type: 'pullRequestReobserved' });
				return this.finishObservation(proposal, operation);
			}
			if (last.type === 'branchWriteStarted') { return this.finishObservation(proposal, await this.observeBranch(proposal, operation, github, 'networkUncertain')); }
			if (last.type === 'pullRequestWriteStarted') {
				let observation: PublicationPrObservation;
				try { observation = await github.findPullRequest(proposal) ?? this.unknownPr(proposal, 'networkUncertain'); }
				catch (error) { observation = this.unknownPr(proposal, this.errorCode(error)); }
				operation = this.append(operation, proposal, observation);
				return this.finishObservation(proposal, operation);
			}
			return operation;
		} finally { await rm(directory, { recursive: true, force: true }); }
	}

	private async observeBranch(proposal: AgentSessionPublicationProposalDTO, operation: AgentSessionPublicationOperationDTO, github: PublicationGithubSession, failure: AgentSessionPublicationProviderErrorCode, reobserve = false): Promise<AgentSessionPublicationOperationDTO> {
		let oid: string | null = null; let outcome: 'created' | 'mismatch' | 'unknown' = 'unknown';
		try {
			oid = await github.readBranch(proposal.remote, proposal.publicationRef);
			// Every call observes an existing durable write intent. Neither one 404 nor any finite
			// sequence of 404s proves that an accepted push did not happen; recovery stays read-only.
			if (oid === null && failure === 'none') { failure = 'networkUncertain'; }
			outcome = oid === null ? 'unknown' : oid === proposal.resultCommit ? 'created' : 'mismatch';
		}
		catch (error) { failure = this.errorCode(error); }
		return this.append(operation, proposal, { type: reobserve ? 'branchReobserved' : 'branchObserved', oid, outcome, errorCode: failure });
	}

	private finishObservation(proposal: AgentSessionPublicationProposalDTO, operation: AgentSessionPublicationOperationDTO): AgentSessionPublicationOperationDTO {
		const branch = [...operation.events].reverse().find(record => record.event.type === 'branchObserved' || record.event.type === 'branchReobserved')?.event;
		const last = operation.events.at(-1)?.event; const branchOid = branch?.type === 'branchObserved' || branch?.type === 'branchReobserved' ? branch.oid : null;
		if (last?.type === 'branchObserved' || last?.type === 'branchReobserved') {
			if (last.outcome === 'created') { return operation; }
			if (last.outcome === 'mismatch') { return this.append(operation, proposal, { type: 'recoveryRequired', reason: 'branchMismatch', pullRequestId: null, branchOid }); }
			return this.append(operation, proposal, { type: 'recoveryRequired', reason: 'uncertainWrite', pullRequestId: null, branchOid });
		}
		if (last?.type !== 'pullRequestObserved' && last?.type !== 'pullRequestReobserved') { return operation; }
		if (branch?.type === 'branchObserved' || branch?.type === 'branchReobserved') {
			if (branch.outcome !== 'created' || branch.oid !== proposal.resultCommit) {
				return this.append(operation, proposal, { type: 'recoveryRequired', reason: branch.outcome === 'mismatch' ? 'branchMismatch' : 'uncertainWrite', pullRequestId: last.id, branchOid });
			}
		}
		if (last.baseOid !== proposal.baseOid) { return this.append(operation, proposal, { type: 'recoveryRequired', reason: 'baseChanged', pullRequestId: last.id, branchOid }); }
		if (last.outcome === 'mismatch') { return this.append(operation, proposal, { type: 'recoveryRequired', reason: 'prMismatch', pullRequestId: last.id, branchOid }); }
		if (last.outcome !== 'created' || !last.id || !last.url) { return this.append(operation, proposal, { type: 'recoveryRequired', reason: 'uncertainWrite', pullRequestId: last.id, branchOid }); }
		return this.append(operation, proposal, { type: 'published', pullRequestId: last.id, url: last.url, branchOid: proposal.resultCommit,
			headOid: proposal.resultCommit, baseRef: proposal.baseRef, title: proposal.title, body: proposal.body, draft: true });
	}

	private async fresh(proposal: AgentSessionPublicationProposalDTO): Promise<{ github: PublicationGithubSession; git: PublicationGitContext }> {
		if (Date.parse(proposal.expiresAt) <= Date.now() || proposal.approval?.actor !== 'human' || proposal.approval.proposalFingerprint !== proposal.fingerprint) { throw new PublicationFailure('invalidObservation'); }
		await this.authority.assertCurrentApproval(proposal);
		const exported = await this.authority.exportSource(proposal.sourceMergeId, proposal.remote.name);
		let git: PublicationGitContext | undefined;
		try {
			this.assertSourceMatches(proposal, exported);
			git = await this.services.createGit(this.runtime.privateRoot, this.runtime.git, exported);
			const github = await this.openAccount(proposal.account.accountRef, git);
			this.equal(github.account, proposal.account, 'accountChanged'); this.equal(await github.resolveRemote(exported.remote), proposal.remote, 'remoteChanged');
			if (await github.readBranch(proposal.remote, proposal.baseRef) !== proposal.baseOid) { throw new PublicationFailure('baseChanged'); }
			this.equal(await git.diff(proposal.baseOid, proposal.resultCommit, proposal.remote, github), proposal.diff, 'invalidObservation');
			// Diff/fetch can take time; repeat host approval/expiry and actual identity checks after it.
			await this.authority.assertCurrentApproval(proposal);
			if (Date.parse(proposal.expiresAt) <= Date.now()) { throw new PublicationFailure('invalidObservation'); }
			const finalAccount = await this.openAccount(proposal.account.accountRef, git);
			this.equal(finalAccount.account, proposal.account, 'accountChanged'); this.equal(await finalAccount.resolveRemote(proposal.remote), proposal.remote, 'remoteChanged');
			if (await finalAccount.readBranch(proposal.remote, proposal.baseRef) !== proposal.baseOid) { throw new PublicationFailure('baseChanged'); }
			return { github: finalAccount, git };
		} catch (error) { await git?.dispose(); throw error; }
		finally { exported.pack.fill(0); }
	}

	/** Called after the branch/PR lookups and immediately before the durable write intent. */
	private async revalidateBeforeWrite(proposal: AgentSessionPublicationProposalDTO, git: PublicationGitContext, expectedBranchOid: string | null): Promise<PublicationGithubSession> {
		await this.authority.assertCurrentApproval(proposal);
		const exported = await this.authority.exportSource(proposal.sourceMergeId, proposal.remote.name);
		try { this.assertSourceMatches(proposal, exported); } finally { exported.pack.fill(0); }
		// This context already contains the fully reviewed diff for these immutable object IDs.
		// Resolve selected credentials again so subsequent writes use the newly checked identity.
		const github = await this.openAccount(proposal.account.accountRef, git);
		this.equal(github.account, proposal.account, 'accountChanged');
		this.equal(await github.resolveRemote(proposal.remote), proposal.remote, 'remoteChanged');
		if (await github.readBranch(proposal.remote, proposal.publicationRef) !== expectedBranchOid) { throw new PublicationFailure('remoteChanged'); }
		if (await github.readBranch(proposal.remote, proposal.baseRef) !== proposal.baseOid) { throw new PublicationFailure('baseChanged'); }
		await this.authority.assertCurrentApproval(proposal);
		if (Date.parse(proposal.expiresAt) <= Date.now()) { throw new PublicationFailure('invalidObservation'); }
		return github;
	}

	private assertSourceMatches(proposal: AgentSessionPublicationProposalDTO, exported: PublicationSourceExport): void {
		this.equal(exported.source, { projectId: proposal.projectId, bindingId: proposal.bindingId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			mergeProposalId: proposal.sourceMergeId, mergeRevision: proposal.sourceMergeRevision, mergeFingerprint: proposal.sourceMergeFingerprint, mergeOperationId: proposal.sourceMergeOperationId,
			integrationOwnerId: proposal.integrationOwnerId, resultCommit: proposal.resultCommit }, 'invalidObservation');
		this.equal(exported.remote, { name: proposal.remote.name, canonicalUrl: proposal.remote.canonicalUrl }, 'remoteChanged');
	}

	private async openAccount(accountRef: string, git: PublicationGitContext): Promise<PublicationGithubSession> {
		return this.services.openGithub(this.runtime.gh, await this.authority.resolveSelectedAccount(accountRef), join(git.directory, 'home'));
	}
	private proposal(id: string, fingerprint: string): AgentSessionPublicationProposalDTO {
		const proposal = this.store.getProposal(id);
		if (!proposal || proposal.fingerprint !== fingerprint) { throw new PublicationFailure('invalidObservation'); } return proposal;
	}
	private readExact(operation: AgentSessionPublicationOperationDTO, proposal: AgentSessionPublicationProposalDTO): AgentSessionPublicationOperationDTO {
		const durable = this.store.readOperation(operation.id);
		if (durable.proposalId !== proposal.id || durable.proposalFingerprint !== proposal.fingerprint || durable.accountStableId !== proposal.account.stableId
			|| durable.repositoryId !== proposal.remote.repositoryId || durable.publicationRef !== proposal.publicationRef || durable.headOid !== proposal.resultCommit
			|| durable.expectedOldRemoteOid !== null || JSON.stringify(durable) !== JSON.stringify(operation)) { throw new PublicationFailure('invalidObservation'); }
		return durable;
	}
	private append(operation: AgentSessionPublicationOperationDTO, proposal: AgentSessionPublicationProposalDTO, event: AgentSessionPublicationEvent): AgentSessionPublicationOperationDTO {
		return this.readExact(this.store.appendEvent(operation.id, operation.revision, event), proposal);
	}
	private unknownPr(proposal: AgentSessionPublicationProposalDTO, code: AgentSessionPublicationProviderErrorCode, previous?: PublicationPrObservation): PublicationPrObservation {
		if (previous?.id) { return { ...previous, outcome: 'unknown', errorCode: code }; }
		return { type: 'pullRequestObserved', id: null, url: null, repositoryId: proposal.remote.repositoryId, headRef: proposal.publicationRef, headOid: proposal.resultCommit,
			baseRef: proposal.baseRef, baseOid: proposal.baseOid, title: proposal.title, body: proposal.body, draft: true, outcome: 'unknown', errorCode: code };
	}
	private equal(actual: object, expected: object, code: AgentSessionPublicationProviderErrorCode): void {
		if (!isDeepStrictEqual(actual, expected)) { throw new PublicationFailure(code); }
	}
	private errorCode(error: unknown): AgentSessionPublicationProviderErrorCode { return error instanceof PublicationFailure ? error.code : 'providerFailed'; }
	private async withLease<T>(proposalId: string, work: () => Promise<T>): Promise<T> {
		const lease = await this.authority.acquireOperation(proposalId); try { return await work(); } finally { await lease.release(); }
	}
}
