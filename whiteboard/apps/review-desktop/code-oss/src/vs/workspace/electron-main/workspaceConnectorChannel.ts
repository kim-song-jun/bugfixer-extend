/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WebContents } from 'electron';
import { SequencerByKey } from '../../base/common/async.js';
import { isUUID } from '../../base/common/uuid.js';
import type { ILogService } from '../../platform/log/common/log.js';
import type { WorkspaceDashboardDTO } from '../common/workspaceDashboardProtocol.js';
import type { ConnectWorkspaceConnectorRequest, ImportNotionPageRequest, ImportSlackConversationRequest, WorkspaceConnectorAccountDTO, WorkspaceConnectorAccountRequest } from '../common/workspaceConnectorProtocol.js';
import { defaultConnectorTransport, importNotionPage, importSlackConversation, validateNotionToken, validateSlackToken, type ConnectorCredentialResolver, type ConnectorTransport } from './connectors/index.js';
import { KeychainVault } from './keychainVault.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase, type ConnectorAccount } from './workspaceDatabase.js';

/** Project-window-only connector broker. The vault owns tokens; workspace.db owns metadata and reference snapshots. */
export class WorkspaceConnectorChannel {
	private readonly sequencer = new SequencerByKey<string>();
	private readonly initialRecovery: Promise<void>;
	private vault: Pick<KeychainVault, 'put' | 'get' | 'delete'> | undefined;

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly dashboardChannel: WorkspaceDashboardChannel,
		private readonly vaultFactory: () => Pick<KeychainVault, 'put' | 'get' | 'delete'>,
		private readonly logService: ILogService,
		private readonly transport: ConnectorTransport = defaultConnectorTransport,
	) {
		this.initialRecovery = this.recoverPendingVaultOperations();
	}

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		const projectId = this.projectId(command, arg);
		await this.dashboardChannel.call<WorkspaceDashboardDTO>(sender, 'getDashboard', projectId);
		await this.initialRecovery;
		switch (command) {
			case 'listAccounts':
				return this.database.listVisibleConnectorAccounts(projectId).map(account => this.toDTO(account)) as T;
			case 'connectAccount':
				return await this.connect(projectId, this.connectRequest(arg)) as T;
			case 'disconnectAccount':
			case 'retryAccountCleanup': {
				const { accountId } = this.accountRequest(arg);
				await this.sequencer.queue(accountId, async () => this.disconnect(projectId, accountId, command === 'retryAccountCleanup'));
				return undefined as T;
			}
			case 'importSlackConversation': {
				const request = this.slackRequest(arg);
				return await this.sequencer.queue(request.accountId, async () => {
					const account = this.requireActiveAccount(projectId, request.accountId, 'slack');
					const source = await importSlackConversation({ channelId: request.channelId, title: request.title, messageTs: request.messageTs, accountRef: account.id }, this.resolver(account), this.transport);
					const { content: _content, derivedText: _derivedText, ...metadata } = this.database.knowledge.importReference({ projectId, ...source });
					return metadata;
				}) as T;
			}
			case 'importNotionPage': {
				const request = this.notionRequest(arg);
				return await this.sequencer.queue(request.accountId, async () => {
					const account = this.requireActiveAccount(projectId, request.accountId, 'notion');
					const source = await importNotionPage({ pageId: request.pageId, accountRef: account.id }, this.resolver(account), this.transport);
					const { content: _content, derivedText: _derivedText, ...metadata } = this.database.knowledge.importReference({ projectId, ...source });
					return metadata;
				}) as T;
			}
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	private async connect(projectId: string, request: ConnectWorkspaceConnectorRequest): Promise<WorkspaceConnectorAccountDTO> {
		const identity = request.provider === 'slack'
			? await validateSlackToken(request.token, this.transport)
			: await validateNotionToken(request.token, this.transport);
		const account = this.database.createPendingConnectorAccount({
			projectId, provider: request.provider, label: identity.label, remoteIdentity: identity.remoteId,
		});
		try {
			await this.getVault().put(account.provider, account.id, request.token);
			return this.toDTO(this.database.activateConnectorAccount(account.id));
		} catch (error) {
			this.database.beginConnectorDisconnect(account.id);
			try {
				await this.getVault().delete(account.provider, account.id);
				this.database.completeConnectorDisconnect(account.id);
			} catch {
				this.logService.error(`Keychain cleanup is pending for connector account ${account.id}.`);
			}
			throw error;
		}
	}

	private async disconnect(projectId: string, accountId: string, retryOnly: boolean): Promise<void> {
		const account = this.requireAccount(projectId, accountId);
		if (retryOnly && account.state !== 'pending' && account.state !== 'disconnecting') {
			throw new Error('This connector account has no cleanup pending.');
		}
		this.database.beginConnectorDisconnect(accountId);
		await this.getVault().delete(account.provider, account.id);
		this.database.completeConnectorDisconnect(accountId);
	}

	private async recoverPendingVaultOperations(): Promise<void> {
		for (const account of this.database.listConnectorAccountsNeedingVaultRecovery()) {
			try {
				await this.sequencer.queue(account.id, async () => this.disconnect(account.projectId, account.id, true));
			} catch {
				this.logService.error(`Keychain cleanup is pending for connector account ${account.id}.`);
			}
		}
	}

	private resolver(account: ConnectorAccount): ConnectorCredentialResolver {
		return {
			resolve: async (provider, accountRef) => {
				if (provider !== account.provider || accountRef !== account.id) { return undefined; }
				this.requireActiveAccount(account.projectId, account.id, provider);
				return this.getVault().get(provider, account.id);
			},
		};
	}

	private getVault(): Pick<KeychainVault, 'put' | 'get' | 'delete'> {
		this.vault ??= this.vaultFactory();
		return this.vault;
	}

	private requireAccount(projectId: string, id: string): ConnectorAccount {
		const account = this.database.getConnectorAccount(id);
		if (!account || account.projectId !== projectId || account.state === 'disconnected') {
			throw new Error('The connector account is unavailable in this project.');
		}
		return account;
	}

	private requireActiveAccount(projectId: string, id: string, provider: ConnectorAccount['provider']): ConnectorAccount {
		const account = this.requireAccount(projectId, id);
		if (account.provider !== provider || account.state !== 'active') { throw new Error('Connect an active matching account before importing.'); }
		return account;
	}

	private toDTO(account: ConnectorAccount): WorkspaceConnectorAccountDTO {
		if (account.state === 'disconnected') { throw new Error('Disconnected accounts are not shown.'); }
		return account as WorkspaceConnectorAccountDTO;
	}

	private projectId(command: string, value: unknown): string {
		const projectId = command === 'listAccounts' && typeof value === 'string' ? value : this.record(value).projectId;
		if (typeof projectId !== 'string' || !isUUID(projectId)) { throw new Error('A valid project ID is required.'); }
		return projectId;
	}

	private connectRequest(value: unknown): ConnectWorkspaceConnectorRequest {
		const record = this.record(value);
		if ((record.provider !== 'slack' && record.provider !== 'notion') || typeof record.token !== 'string'
			|| !record.token || Buffer.byteLength(record.token, 'utf8') > 16_384 || !/^[\x21-\x7e]+$/.test(record.token)) {
			throw new Error('A supported connector and valid token are required.');
		}
		return record as unknown as ConnectWorkspaceConnectorRequest;
	}

	private accountRequest(value: unknown): WorkspaceConnectorAccountRequest {
		const record = this.record(value);
		if (typeof record.accountId !== 'string' || !isUUID(record.accountId)) { throw new Error('A valid connector account ID is required.'); }
		return record as unknown as WorkspaceConnectorAccountRequest;
	}

	private slackRequest(value: unknown): ImportSlackConversationRequest {
		const record = this.accountRequest(value) as unknown as Record<string, unknown>;
		if (typeof record.channelId !== 'string' || !/^[CGD][A-Z0-9]{2,79}$/.test(record.channelId)
			|| (record.title !== undefined && (typeof record.title !== 'string' || record.title.length > 500))
			|| (record.messageTs !== undefined && (typeof record.messageTs !== 'string' || !/^\d{1,20}\.\d{1,10}$/.test(record.messageTs)))) {
			throw new Error('A valid Slack conversation ID and optional short title are required.');
		}
		return record as unknown as ImportSlackConversationRequest;
	}

	private notionRequest(value: unknown): ImportNotionPageRequest {
		const record = this.accountRequest(value) as unknown as Record<string, unknown>;
		if (typeof record.pageId !== 'string' || !/^[0-9a-fA-F-]{32,36}$/.test(record.pageId)) { throw new Error('A valid Notion page ID is required.'); }
		return record as unknown as ImportNotionPageRequest;
	}

	private record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('A connector request is required.'); }
		return value as Record<string, unknown>;
	}
}
