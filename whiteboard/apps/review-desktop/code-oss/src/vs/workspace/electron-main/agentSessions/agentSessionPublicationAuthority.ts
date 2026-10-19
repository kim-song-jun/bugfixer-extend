/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { AgentSessionMergeProposalDTO } from '../../common/workspaceAgentMergeProtocol.js';
import type { AgentSessionPublicationMergedSource, AgentSessionPublicationProposalDTO, AgentSessionPublicationPublishedArtifactDTO } from '../../common/workspaceAgentPublicationProtocol.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';
import type { PublicationSourceExport } from './agentPublicationGit.js';
import type { PublicationSelectedAccount } from './agentPublicationGithub.js';
import type { PublicationExecutable } from './agentPublicationProcess.js';
import type { PublicationHostAuthority } from './agentSessionPublicationExecutor.js';
import type { ManagedPublicationLease, ManagedWorktreeService } from './managedWorktrees.js';

export interface PublicationAuthorityScope {
	readonly projectId: string;
	readonly bindingId: string;
	readonly sessionId: string;
	readonly turnId: string;
}

export interface PublicationAuthorityPorts {
	readonly git: PublicationExecutable;
	/** Native host roster lookup only; no renderer-supplied profile path or token. */
	readonly resolveSelectedAccount: (accountRef: string) => Promise<PublicationSelectedAccount>;
	/** Must inspect the live sender/window/scope on every call, not a captured boolean. */
	readonly assertScopeCurrent: (scope: PublicationAuthorityScope) => void;
}

interface PublicationSource {
	readonly merge: AgentSessionMergeProposalDTO;
	readonly source: AgentSessionPublicationMergedSource;
	readonly artifact: AgentSessionPublicationPublishedArtifactDTO;
	readonly repositoryPath: string;
}

/** One instance per native invocation. Only signed manager capabilities authorize source reads. */
export class AgentSessionPublicationAuthority implements PublicationHostAuthority {
	private active: { readonly proposal: AgentSessionPublicationProposalDTO; readonly lease: ManagedPublicationLease } | undefined;
	private acquiring = false;
	private scope: PublicationAuthorityScope | undefined;

	constructor(private readonly database: WorkspaceDatabase, private readonly worktrees: ManagedWorktreeService, private readonly ports: PublicationAuthorityPorts) { }

	async acquireOperation(proposalId: string): Promise<{ release(): Promise<void> }> {
		if (this.active || this.acquiring) { throw new Error('This native publication request already owns an operation.'); }
		this.acquiring = true;
		let lease: ManagedPublicationLease | undefined;
		try {
			const proposal = this.requireProposal(proposalId);
			this.assertScope(proposal);
			// No approval, expiry, current source, or remote check here: a persisted
			// external write must remain readable after those write authorities change.
			lease = await this.worktrees.acquirePublicationLease(proposal.integrationOwnerId, this.ports.git);
			this.assertScope(proposal);
			const current = this.requireProposal(proposalId);
			if (current.fingerprint !== proposal.fingerprint || current.integrationOwnerId !== proposal.integrationOwnerId) { throw new Error('Publication operation authority changed during acquisition.'); }
			const active = { proposal, lease }; this.active = active;
			return { release: async () => {
				if (this.active !== active) { return; }
				await active.lease.release(); this.active = undefined;
			} };
		} catch (error) { await lease?.release(); throw error; }
		finally { this.acquiring = false; }
	}

	async exportSource(sourceMergeId: string, remoteName: string): Promise<PublicationSourceExport> {
		const source = this.readSource(sourceMergeId);
		if (this.active && this.active.proposal.sourceMergeId !== sourceMergeId) { throw new Error('The operation lease does not own this source merge.'); }
		let pack: Buffer | undefined;
		try { return await this.withSourceLease(source, async lease => {
			const exported = await lease.exportPinned({ repositoryPath: source.repositoryPath, remoteName, merge: source.merge });
			pack = exported.pack;
			this.assertUnchangedSource(source);
			return { source: source.source, remote: { name: remoteName, canonicalUrl: exported.canonicalUrl }, pack };
		}); } catch (error) { pack?.fill(0); throw error; }
	}

	async assertCurrentApproval(proposal: AgentSessionPublicationProposalDTO): Promise<void> {
		const current = this.requireCurrentApproval(proposal);
		const source = this.readSource(current.sourceMergeId);
		this.assertProposalSource(current, source);
		await this.withSourceLease(source, async lease => {
			const remote = await lease.assertPinned({ repositoryPath: source.repositoryPath, remoteName: current.remote.name, merge: source.merge });
			if (remote.canonicalUrl !== current.remote.canonicalUrl) { throw new Error('Publication remote no longer matches the reviewed destination.'); }
			this.assertUnchangedSource(source);
			this.requireCurrentApproval(proposal);
		});
	}

	async resolveSelectedAccount(accountRef: string): Promise<PublicationSelectedAccount> {
		if (!this.scope) { throw new Error('A publication source scope must be established before account resolution.'); }
		this.assertScope(this.scope);
		const account = await this.ports.resolveSelectedAccount(accountRef);
		this.assertScope(this.scope);
		if (account.accountRef !== accountRef) { throw new Error('The selected existing GitHub account changed.'); }
		return account;
	}

	private async withSourceLease<T>(source: PublicationSource, run: (lease: ManagedPublicationLease) => Promise<T>): Promise<T> {
		if (this.active) {
			if (this.active.proposal.integrationOwnerId !== source.source.integrationOwnerId || this.active.proposal.sourceMergeId !== source.merge.id) { throw new Error('Publication source is outside the held operation lease.'); }
			return run(this.active.lease);
		}
		if (this.acquiring) { throw new Error('A publication operation lease is still being acquired.'); }
		const lease = await this.worktrees.acquirePublicationLease(source.source.integrationOwnerId, this.ports.git);
		try { this.assertUnchangedSource(source); return await run(lease); }
		finally { await lease.release(); }
	}

	private requireCurrentApproval(expected: AgentSessionPublicationProposalDTO): AgentSessionPublicationProposalDTO {
		const current = this.requireProposal(expected.id); this.assertScope(current);
		if (this.active && this.active.proposal.id !== current.id) { throw new Error('Publication approval does not belong to the held operation.'); }
		if (current.revision !== expected.revision || current.fingerprint !== expected.fingerprint
			|| current.approval?.actor !== 'human' || current.approval.proposalFingerprint !== current.fingerprint
			|| Date.parse(current.expiresAt) <= Date.now()
			|| this.database.agentSessionPublications.listProposals(current.projectId, current.sessionId, current.turnId, { afterRevision: current.revision, limit: 1 }).proposals.length) {
			throw new Error('Publication requires the exact latest, unexpired human-approved proposal.');
		}
		return current;
	}

	private requireProposal(id: string): AgentSessionPublicationProposalDTO {
		const proposal = this.database.agentSessionPublications.getProposal(id);
		if (!proposal) { throw new Error('Publication proposal does not exist.'); }
		return proposal;
	}

	private assertScope(scope: PublicationAuthorityScope): void {
		this.ports.assertScopeCurrent(scope);
		const session = this.database.agentSessions.getSession(scope.projectId, scope.sessionId);
		const turn = this.database.agentSessionTurns.getTurn(scope.projectId, scope.sessionId, scope.turnId);
		if (!this.database.getProject(scope.projectId) || session?.bindingId !== scope.bindingId || turn?.snapshot.bindingId !== scope.bindingId
			|| !this.database.listFolderBindings(scope.projectId).some(binding => binding.id === scope.bindingId)) { throw new Error('Publication scope no longer belongs to the exact project, binding, session, and turn.'); }
		if (this.scope && !isDeepStrictEqual(this.scope, { projectId: scope.projectId, bindingId: scope.bindingId, sessionId: scope.sessionId, turnId: scope.turnId })) { throw new Error('A native publication request cannot change scope.'); }
		this.scope = { projectId: scope.projectId, bindingId: scope.bindingId, sessionId: scope.sessionId, turnId: scope.turnId };
	}

	private readSource(id: string): PublicationSource {
		const merge = this.database.agentSessionMerges.getProposal(id);
		if (!merge) { throw new Error('Publication source merge does not exist.'); }
		this.assertScope(merge);
		const outcome = merge.outcomes.at(-1);
		const published = merge.artifacts.at(-1);
		if (merge.state !== 'merged' || outcome?.state !== 'merged' || !outcome.receipt.resultingHead
			|| outcome.receipt.proposalFingerprint !== merge.fingerprint || published?.event.phase !== 'published'
			|| published.event.resultingHead !== outcome.receipt.resultingHead || !published.event.currentGenerationId
			|| published.event.targetRef !== `refs/heads/bugfixer/integration/${merge.integrationOwnerId}`) { throw new Error('Publication requires the exact successful merge and its published artifact.'); }
		const binding = this.database.listFolderBindings(merge.projectId).find(item => item.id === merge.bindingId);
		if (binding?.vcsKind !== 'git' || !binding.vcsRoot || realpathSync(binding.vcsRoot) !== binding.vcsRoot) { throw new Error('Publication requires the exact canonical Git project binding.'); }
		return {
			merge, repositoryPath: binding.vcsRoot,
			source: { projectId: merge.projectId, bindingId: merge.bindingId, sessionId: merge.sessionId, turnId: merge.turnId, mergeProposalId: merge.id,
				mergeRevision: merge.revision, mergeFingerprint: merge.fingerprint, mergeOperationId: outcome.receipt.operationId, integrationOwnerId: merge.integrationOwnerId, resultCommit: outcome.receipt.resultingHead },
			artifact: { mergeOperationId: outcome.receipt.operationId, artifactRevision: published.revision, targetRef: published.event.targetRef,
				resultingHead: published.event.resultingHead, currentGenerationId: published.event.currentGenerationId, priorGenerationId: published.event.priorGenerationId },
		};
	}

	private assertUnchangedSource(expected: PublicationSource): void {
		const current = this.readSource(expected.merge.id);
		if (current.repositoryPath !== expected.repositoryPath || !isDeepStrictEqual(current.source, expected.source)
			|| !isDeepStrictEqual(current.artifact, expected.artifact) || !isDeepStrictEqual(current.merge.artifacts, expected.merge.artifacts)) { throw new Error('Publication source authority changed during validation.'); }
	}

	private assertProposalSource(proposal: AgentSessionPublicationProposalDTO, source: PublicationSource): void {
		if (!isDeepStrictEqual(source.source, { projectId: proposal.projectId, bindingId: proposal.bindingId, sessionId: proposal.sessionId, turnId: proposal.turnId,
			mergeProposalId: proposal.sourceMergeId, mergeRevision: proposal.sourceMergeRevision, mergeFingerprint: proposal.sourceMergeFingerprint,
			mergeOperationId: proposal.sourceMergeOperationId, integrationOwnerId: proposal.integrationOwnerId, resultCommit: proposal.resultCommit })
			|| !isDeepStrictEqual(source.artifact, proposal.publishedArtifact)) { throw new Error('Publication proposal source does not match the current durable merge artifact.'); }
	}
}
