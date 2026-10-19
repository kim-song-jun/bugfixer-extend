/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import type { AgentSessionPublicationOperationDTO, AgentSessionPublicationPageDTO, AgentSessionPublicationPrepareInput, AgentSessionPublicationProposalDTO, WorkspaceAgentPublicationAccountsDTO, WorkspaceAgentPublicationExecutionDTO, WorkspaceAgentPublicationMutationInput, WorkspaceAgentPublicationPageInput, WorkspaceAgentPublicationRecoveryInput, WorkspaceAgentPublicationScope } from '../../common/workspaceAgentPublicationProtocol.js';
import type { WorkspaceDatabase } from '../workspaceDatabase.js';
import { discoverPublicationAccounts, type PublicationAccountChoice, type PublicationSelectedAccount } from './agentPublicationGithub.js';
import { PublicationFailure } from './agentPublicationProcess.js';
import { resolvePublicationEnvironment } from './agentPublicationRuntime.js';
import { AgentSessionPublicationAuthority } from './agentSessionPublicationAuthority.js';
import { AgentSessionPublicationExecutor } from './agentSessionPublicationExecutor.js';
import type { ManagedWorktreeService } from './managedWorktrees.js';

/** Per-request native guards remain live through account discovery and every external write. */
export class AgentSessionPublicationApplication {
	private closing = false;
	private activeRequests = 0;
	private readonly drained: Array<() => void> = [];

	constructor(private readonly database: WorkspaceDatabase, private readonly worktrees: ManagedWorktreeService,
		private readonly profileDirectory: string, private readonly resourcesPath: string) { }

	listAccounts(scope: WorkspaceAgentPublicationScope, assertCurrent: () => void): Promise<WorkspaceAgentPublicationAccountsDTO> {
		return this.track(() => this.listAccountsCore(scope, this.guard(assertCurrent)));
	}
	private async listAccountsCore(scope: WorkspaceAgentPublicationScope, assertCurrent: () => void): Promise<WorkspaceAgentPublicationAccountsDTO> {
		this.requireScope(scope); assertCurrent();
		try {
			const environment = await resolvePublicationEnvironment({ profileDirectory: this.profileDirectory, resourcesPath: this.resourcesPath });
			assertCurrent();
			const choices = await discoverPublicationAccounts(environment.runtime.gh, environment.configDirectory, environment.runtime.privateRoot);
			assertCurrent();
			return { available: true, reason: null, accounts: choices.map(choice => ({ ...choice, accountRef: this.accountRef(environment.configDirectory, choice) })) };
		} catch (error) {
			assertCurrent();
			const code = error instanceof PublicationFailure ? error.code : 'unavailable';
			return { available: false, accounts: [], reason: `GitHub 연결을 확인하지 못했습니다. Git과 gh 로그인 상태를 확인해 주세요. (${code})` };
		}
	}

	listProposals(input: WorkspaceAgentPublicationPageInput): AgentSessionPublicationPageDTO {
		if (this.closing) { throw new Error('Publication host is closing.'); }
		this.requireScope(input);
		return this.database.agentSessionPublications.listProposals(input.projectId, input.sessionId, input.turnId,
			{ afterRevision: input.afterRevision, limit: input.limit });
	}

	prepareProposal(input: AgentSessionPublicationPrepareInput, assertCurrent: () => void): Promise<AgentSessionPublicationProposalDTO> {
		return this.track(() => this.prepareProposalCore(input, this.guard(assertCurrent)));
	}
	private async prepareProposalCore(input: AgentSessionPublicationPrepareInput, assertCurrent: () => void): Promise<AgentSessionPublicationProposalDTO> {
		this.requireScope(input);
		const merge = this.database.agentSessionMerges.getProposal(input.sourceMergeId);
		if (!merge || !this.sameScope(merge, input)) { throw new Error('PR source merge does not match the native request scope.'); }
		const executor = await this.executor(input, assertCurrent);
		const proposal = await executor.prepare(input);
		assertCurrent();
		return proposal;
	}

	approveProposal(input: WorkspaceAgentPublicationMutationInput): AgentSessionPublicationProposalDTO {
		if (this.closing) { throw new Error('Publication host is closing.'); }
		const proposal = this.requireProposal(input);
		this.database.agentSessionPublications.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint);
		return this.database.agentSessionPublications.getProposal(proposal.id)!;
	}

	publishApprovedProposal(input: WorkspaceAgentPublicationMutationInput, assertCurrent: () => void): Promise<WorkspaceAgentPublicationExecutionDTO> {
		return this.track(() => this.publishApprovedProposalCore(input, this.guard(assertCurrent)));
	}
	private async publishApprovedProposalCore(input: WorkspaceAgentPublicationMutationInput, assertCurrent: () => void): Promise<WorkspaceAgentPublicationExecutionDTO> {
		const proposal = this.requireProposal(input);
		const executor = await this.executor(input, assertCurrent);
		const operation = await executor.publishApproved(proposal.id, proposal.fingerprint);
		assertCurrent();
		return { proposal: this.requireProposal(input), operation };
	}

	continueApprovedOperation(input: WorkspaceAgentPublicationRecoveryInput, assertCurrent: () => void): Promise<WorkspaceAgentPublicationExecutionDTO> {
		return this.track(() => this.continueApprovedOperationCore(input, this.guard(assertCurrent)));
	}
	private async continueApprovedOperationCore(input: WorkspaceAgentPublicationRecoveryInput, assertCurrent: () => void): Promise<WorkspaceAgentPublicationExecutionDTO> {
		const proposal = this.requireProposal(input);
		const executor = await this.executor(input, assertCurrent);
		const operation = await executor.continueApprovedOperation(proposal.id, proposal.fingerprint, input.operationId);
		assertCurrent();
		return { proposal: this.requireProposal(input), operation };
	}

	reconcileOperation(input: WorkspaceAgentPublicationRecoveryInput, assertCurrent: () => void): Promise<WorkspaceAgentPublicationExecutionDTO> {
		return this.track(() => this.reconcileOperationCore(input, this.guard(assertCurrent)));
	}
	private async reconcileOperationCore(input: WorkspaceAgentPublicationRecoveryInput, assertCurrent: () => void): Promise<WorkspaceAgentPublicationExecutionDTO> {
		const proposal = this.requireProposal(input);
		const executor = await this.executor(input, assertCurrent);
		const operation = await executor.reconcile(proposal.id, proposal.fingerprint, input.operationId);
		assertCurrent();
		return { proposal: this.requireProposal(input), operation };
	}

	readOperation(input: WorkspaceAgentPublicationMutationInput): AgentSessionPublicationOperationDTO | null {
		if (this.closing) { throw new Error('Publication host is closing.'); }
		const proposal = this.requireProposal(input);
		const operation = this.database.agentSessionPublications.getOperationForProposal(proposal.id);
		if (!operation) { return null; }
		if (operation.proposalId !== proposal.id || operation.proposalFingerprint !== proposal.fingerprint) { throw new Error('PR operation does not match the exact proposal.'); }
		return operation;
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		if (this.activeRequests === 0) { return; }
		await new Promise<void>(resolve => this.drained.push(resolve));
	}

	private guard(assertCurrent: () => void): () => void {
		return () => { if (this.closing) { throw new Error('Publication host is shutting down.'); } assertCurrent(); };
	}

	private track<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing) { return Promise.reject(new Error('Publication host is shutting down.')); }
		this.activeRequests++;
		return Promise.resolve().then(operation).finally(() => {
			this.activeRequests--;
			if (this.closing && this.activeRequests === 0) { for (const resolve of this.drained.splice(0)) { resolve(); } }
		});
	}

	private async executor(scope: WorkspaceAgentPublicationScope, assertCurrent: () => void): Promise<AgentSessionPublicationExecutor> {
		assertCurrent();
		const environment = await resolvePublicationEnvironment({ profileDirectory: this.profileDirectory, resourcesPath: this.resourcesPath });
		assertCurrent();
		const authority = new AgentSessionPublicationAuthority(this.database, this.worktrees, {
			git: environment.runtime.git.git,
			assertScopeCurrent: actual => {
				assertCurrent();
				if (!this.sameScope(actual, scope)) { throw new Error('PR authority changed its native request scope.'); }
			},
			resolveSelectedAccount: async accountRef => {
				assertCurrent();
				const choices = await discoverPublicationAccounts(environment.runtime.gh, environment.configDirectory, environment.runtime.privateRoot);
				assertCurrent();
				const choice = choices.find(candidate => this.accountRef(environment.configDirectory, candidate) === accountRef);
				if (!choice || choice.state !== 'success') { throw new PublicationFailure('accountChanged'); }
				const selected: PublicationSelectedAccount = { accountRef, login: choice.login, configDirectory: environment.configDirectory };
				return selected;
			},
		});
		return new AgentSessionPublicationExecutor(this.database.agentSessionPublications, authority, environment.runtime);
	}

	private accountRef(configDirectory: string, choice: PublicationAccountChoice): string {
		return `gh:${createHash('sha256').update(JSON.stringify([configDirectory, choice.host, choice.login.toLowerCase()])).digest('hex')}`;
	}

	private requireScope(scope: WorkspaceAgentPublicationScope): void {
		const session = this.database.agentSessions.getSession(scope.projectId, scope.sessionId);
		const turn = this.database.agentSessionTurns.getTurn(scope.projectId, scope.sessionId, scope.turnId);
		if (!session || !turn) { throw new Error('PR session or turn is unavailable in this project.'); }
	}

	private requireProposal(input: WorkspaceAgentPublicationMutationInput): AgentSessionPublicationProposalDTO {
		this.requireScope(input);
		const proposal = this.database.agentSessionPublications.getProposal(input.proposalId);
		if (!proposal || !this.sameScope(proposal, input) || proposal.revision !== input.expectedRevision || proposal.fingerprint !== input.expectedFingerprint) {
			throw new Error('PR proposal is unavailable or changed; review its latest exact revision.');
		}
		return proposal;
	}

	private sameScope(left: WorkspaceAgentPublicationScope, right: WorkspaceAgentPublicationScope): boolean {
		return left.projectId === right.projectId && left.sessionId === right.sessionId && left.turnId === right.turnId;
	}
}
