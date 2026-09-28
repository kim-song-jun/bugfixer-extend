/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WebContents } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { SequencerByKey } from '../../base/common/async.js';
import { isUUID } from '../../base/common/uuid.js';
import type { WorkspaceDashboardDTO } from '../common/workspaceDashboardProtocol.js';
import type { WorkspaceReferenceDTO } from '../common/workspaceKnowledgeProtocol.js';
import type {
	WorkspaceInstalledPackageDTO, WorkspacePackageApproval, WorkspacePackageImportRequest, WorkspacePackageInstallRequest,
	WorkspacePackagePreviewDTO, WorkspacePackagePreviewImportRequest, WorkspacePackageRefreshRequest, WorkspacePackageRequest,
	WorkspacePackageReviewDTO, WorkspacePackageReviewRequest, WorkspaceSignedPackageEnvelope,
	WorkspacePackageConnectionDTO, WorkspacePackageConnectionRequest, WorkspacePackageConnectionActionRequest,
} from '../common/workspacePackageConnectorProtocol.js';
import {
	approveDeclarativePackage, validateDeclarativePackage, type DeclarativePackageTrustContext, type ValidatedDeclarativePackage,
} from './connectors/declarativePackage.js';
import { importDeclarativePackageSource, type DeclarativeImportedReferenceInput } from './connectors/declarativePackageRuntime.js';
import {
	minimumDeclarativePackageCredentialLength, PinnedDeclarativePackageTransport, type DeclarativePackageTransport,
} from './connectors/declarativePackageTransport.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase, type DeclarativePackageConnection, type InstalledConnectorPackage } from './workspaceDatabase.js';
import type { KeychainVault } from './keychainVault.js';

const packagePreviewTtlMs = 5 * 60_000;
const maxPendingPackagePreviews = 32;

interface PendingPackagePreview {
	readonly previewId: string;
	readonly senderId: number;
	readonly projectId: string;
	readonly packageId: string;
	readonly packageVersion: string;
	readonly packageFingerprint: string;
	readonly packageManifestDigest: string;
	readonly connectionId: string;
	readonly accountRef: string;
	readonly sourceId: string;
	readonly sourceKey: string;
	readonly source: DeclarativeImportedReferenceInput;
	readonly contentSha256: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	committedTaskId?: string;
	receipt?: WorkspaceReferenceDTO;
}

/** Signed, credential-free package broker. Only the project window may review, install, and import. */
export class WorkspacePackageConnectorChannel {
	private readonly sequencer = new SequencerByKey<string>();
	private readonly previews = new Map<string, PendingPackagePreview>();
	private vault: Pick<KeychainVault, 'put' | 'get' | 'delete'> | undefined;

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly dashboardChannel: WorkspaceDashboardChannel,
		private readonly confirmInstall: (sender: WebContents, review: WorkspacePackageReviewDTO) => Promise<boolean>,
		private readonly transportFactory: () => DeclarativePackageTransport = () => new PinnedDeclarativePackageTransport(),
		private readonly clock: () => number = Date.now,
		private readonly vaultFactory: () => Pick<KeychainVault, 'put' | 'get' | 'delete'> = () => { throw new Error('Connector package credentials are unavailable.'); },
		private readonly confirmConnection: (sender: WebContents, packageReview: WorkspacePackageReviewDTO, label: string, host: string, scopes: readonly string[]) => Promise<boolean> = async () => false,
	) { }

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		const projectId = this.projectId(command, arg);
		await this.dashboardChannel.call<WorkspaceDashboardDTO>(sender, 'getDashboard', projectId);
		switch (command) {
			case 'listPackages':
				return this.database.listInstalledConnectorPackages(projectId).map(record => this.installedDTO(record)) as T;
			case 'listPackageConnections': {
				const request = this.packageRequest(arg);
				this.requireInstalled(projectId, request.packageId);
				return this.database.listPackageConnections(projectId, request.packageId).map(connection => this.connectionDTO(connection)) as T;
			}
			case 'reviewPackage': {
				const request = this.reviewRequest(arg);
				return this.review(projectId, request.envelope).review as T;
			}
			case 'installPackage': {
				const request = this.installRequest(arg);
				const initial = validateDeclarativePackage(request.envelope);
				return await this.sequencer.queue(this.key(projectId, initial.manifest.packageId), async () => {
					const { validated, review } = this.review(projectId, request.envelope);
					approveDeclarativePackage(validated, request.approval);
					if (!await this.confirmInstall(sender, review)) { throw new Error('Connector package installation was cancelled.'); }
					await this.dashboardChannel.call<WorkspaceDashboardDTO>(sender, 'getDashboard', projectId);
					const existing = this.database.getInstalledConnectorPackage(projectId, validated.manifest.packageId);
					if (existing && existing.manifestDigest !== validated.manifestDigest) {
						for (const connection of this.database.listPackageConnections(projectId, existing.packageId)) {
							if (connection.manifestDigest !== validated.manifestDigest && connection.state !== 'disconnected') {
								await this.cleanupConnection(connection);
							}
						}
					}
					const saved = this.database.saveInstalledConnectorPackage({
						projectId, packageId: validated.manifest.packageId, version: validated.manifest.version, name: validated.manifest.name,
						fingerprint: validated.fingerprint, manifestDigest: validated.manifestDigest,
						manifestBytesBase64: request.envelope.manifestBytesBase64,
						signatureBase64: request.envelope.signatureBase64, publicKeyBase64: request.envelope.publicKeyBase64,
					});
					this.ensureAnonymousConnection(projectId, saved, validated);
					this.invalidatePreviews(projectId, saved.packageId);
					return this.installedDTO(saved);
				}) as T;
			}
			case 'uninstallPackage': {
				const request = this.packageRequest(arg);
				await this.sequencer.queue(this.key(projectId, request.packageId), async () => {
					for (const connection of this.database.listPackageConnections(projectId, request.packageId)) {
						if (connection.state !== 'disconnected') { await this.cleanupConnection(connection); }
					}
					this.database.uninstallConnectorPackage(projectId, request.packageId);
					this.invalidatePreviews(projectId, request.packageId);
				});
				return undefined as T;
			}
			case 'previewPackageSource': {
				const request = this.importRequest(arg);
				return await this.sequencer.queue(this.key(projectId, request.packageId), async () => {
					const installed = this.database.getInstalledConnectorPackage(projectId, request.packageId);
					if (!installed) { throw new Error('The connector package is not installed in this project.'); }
					const validated = this.validateInstalled(installed);
					const approved = approveDeclarativePackage(validated, this.approval(installed));
					const connection = this.requireActiveConnection(projectId, installed, request.connectionId, request.sourceId);
					const source = await importDeclarativePackageSource(approved, request, this.transportFactory(), await this.connectionBinding(connection));
					this.requireActiveConnection(projectId, this.requireInstalled(projectId, request.packageId), request.connectionId, request.sourceId, connection.accountRef);
					await this.dashboardChannel.call<WorkspaceDashboardDTO>(sender, 'getDashboard', projectId);
					return this.createPreview(sender, projectId, installed, request, source) as T;
				}) as T;
			}
			case 'importPackagePreview': {
				const request = this.previewImportRequest(arg);
				return await this.sequencer.queue(this.key(projectId, request.packageId), async () => {
					const preview = this.requirePreview(request.previewId, sender.id, projectId, request.packageId);
					if (request.connectionId !== preview.connectionId) {
						throw new Error('This preview belongs to a different package account. Preview the source again before importing.');
					}
					if (preview.receipt) {
						if (request.taskId !== preview.committedTaskId) {
							throw new Error('This connector preview was already imported for a different task.');
						}
						return preview.receipt as T;
					}
					this.requireActiveConnection(projectId, this.requireInstalled(projectId, request.packageId), request.connectionId, preview.sourceId, preview.accountRef);
					const installed = this.database.getInstalledConnectorPackage(projectId, request.packageId);
					if (!installed || installed.version !== preview.packageVersion || installed.fingerprint !== preview.packageFingerprint
						|| installed.manifestDigest !== preview.packageManifestDigest) {
						this.previews.delete(preview.previewId);
						throw new Error('The connector package changed after preview. Preview the source again before importing.');
					}
					if (preview.source.connectorId !== `local:${preview.packageId}` || preview.source.connectorVersion !== preview.packageVersion
						|| preview.source.accountRef !== preview.accountRef || preview.source.externalId !== `${preview.packageId}:${preview.accountRef}:${preview.sourceId}:${preview.sourceKey}`) {
						this.previews.delete(preview.previewId);
						throw new Error('The reviewed source identity changed. Preview the source again before importing.');
					}
					if (this.sourceHash(preview.source) !== preview.contentSha256) {
						this.previews.delete(preview.previewId);
						throw new Error('The reviewed source changed in memory. Preview it again before importing.');
					}
					const imported = this.database.knowledge.importReferenceWithTask({ projectId, ...preview.source }, request.taskId);
					const { content: _content, derivedText: _derivedText, ...metadata } = imported;
					if (metadata.contentSha256 !== preview.contentSha256 || metadata.connectorId !== preview.source.connectorId
						|| metadata.externalId !== preview.source.externalId || metadata.sourceUri !== preview.source.sourceUri
						|| metadata.title !== preview.source.title) {
						throw new Error('The saved source did not match the reviewed preview.');
					}
					preview.committedTaskId = request.taskId;
					preview.receipt = metadata;
					return metadata;
				}) as T;
			}
			case 'refreshPackageSource': {
				const request = this.refreshRequest(arg);
				return await this.sequencer.queue(this.key(projectId, request.packageId), async () => {
					const installed = this.database.getInstalledConnectorPackage(projectId, request.packageId);
					if (!installed) { throw new Error('The connector package is not installed in this project.'); }
					const previous = this.database.knowledge.readReference(request.previousReferenceId);
					const connection = this.requireActiveConnection(projectId, installed, request.connectionId, request.sourceId);
					if (!previous || previous.projectId !== projectId || previous.connectorId !== `local:${request.packageId}`
						|| previous.accountRef !== connection.accountRef || previous.externalId !== `${request.packageId}:${connection.accountRef}:${request.sourceId}:${request.sourceKey}`) {
						throw new Error('The selected reference does not belong to this connector source in this project.');
					}
					const validated = this.validateInstalled(installed);
					const approved = approveDeclarativePackage(validated, this.approval(installed));
					const source = await importDeclarativePackageSource(approved, request, this.transportFactory(), await this.connectionBinding(connection));
					// Recheck after network I/O, immediately before the synchronous store transaction.
					const latest = this.database.knowledge.listProjectReferences(projectId)
						.filter(reference => reference.connectorId === previous.connectorId
							&& reference.accountRef === previous.accountRef
							&& reference.sourceId === previous.sourceId
							&& reference.externalId === previous.externalId)
						.sort((left, right) => right.version - left.version)[0];
					if (latest?.id !== previous.id) { throw new Error('Refresh the latest version of this connector source.'); }
					this.requireActiveConnection(projectId, this.requireInstalled(projectId, request.packageId), request.connectionId, request.sourceId, previous.accountRef);
					const imported = this.database.knowledge.importReference({ projectId, ...source });
					const { content: _content, derivedText: _derivedText, ...metadata } = imported;
					return metadata;
				}) as T;
			}
			case 'connectPackageConnection': {
				const request = this.connectionRequest(arg);
				return await this.sequencer.queue(this.key(projectId, request.packageId), async () => this.connect(sender, projectId, request)) as T;
			}
			case 'disconnectPackageConnection':
			case 'retryPackageConnectionCleanup': {
				const request = this.connectionActionRequest(arg);
				return await this.sequencer.queue(this.key(projectId, request.packageId), async () => {
					const connection = this.requireConnection(projectId, request.packageId, request.connectionId);
					if (command === 'retryPackageConnectionCleanup' && connection.state !== 'pending' && connection.state !== 'disconnecting') {
						throw new Error('This package account has no cleanup pending.');
					}
					return this.connectionDTO(await this.cleanupConnection(connection));
				}) as T;
			}
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	private review(projectId: string, envelope: WorkspaceSignedPackageEnvelope): { validated: ValidatedDeclarativePackage; review: WorkspacePackageReviewDTO } {
		const packageId = validateDeclarativePackage(envelope).manifest.packageId;
		const existing = this.database.getInstalledConnectorPackage(projectId, packageId);
		const validated = validateDeclarativePackage(envelope, existing ? this.trust(existing) : undefined);
		return { validated, review: this.reviewDTO(validated) };
	}

	private createPreview(
		sender: WebContents,
		projectId: string,
		installed: InstalledConnectorPackage,
		request: WorkspacePackageImportRequest,
		source: DeclarativeImportedReferenceInput,
	): WorkspacePackagePreviewDTO {
		const now = this.clock();
		this.pruneExpiredPreviews(now);
		while (this.previews.size >= maxPendingPackagePreviews) {
			const oldest = [...this.previews.values()].filter(preview => !preview.receipt)
				.sort((left, right) => left.createdAt - right.createdAt)[0];
			if (!oldest) { throw new Error('Too many connector previews are awaiting retry. Wait for one to expire before previewing another source.'); }
			this.previews.delete(oldest.previewId);
		}
		const previewId = randomUUID();
		const contentSha256 = this.sourceHash(source);
		const expiresAt = now + packagePreviewTtlMs;
		const storedSource = { ...source, content: Uint8Array.from(source.content), omissions: [...source.omissions] };
		this.previews.set(previewId, {
			previewId, senderId: sender.id, projectId, packageId: installed.packageId,
			packageVersion: installed.version, packageFingerprint: installed.fingerprint, packageManifestDigest: installed.manifestDigest,
			connectionId: request.connectionId, accountRef: source.accountRef,
			sourceId: request.sourceId, sourceKey: request.sourceKey, source: storedSource, contentSha256, createdAt: now, expiresAt,
		});
		return {
			previewId, packageId: installed.packageId, accountRef: source.accountRef, sourceId: request.sourceId, sourceKey: request.sourceKey,
			connectorVersion: source.connectorVersion, externalId: source.externalId, sourceUri: source.sourceUri,
			title: source.title, contentSha256, content: new TextDecoder('utf-8', { fatal: true }).decode(source.content),
			omissions: [...source.omissions], expiresAt: new Date(expiresAt).toISOString(),
		};
	}

	private requirePreview(previewId: string, senderId: number, projectId: string, packageId: string): PendingPackagePreview {
		const preview = this.previews.get(previewId);
		if (!preview || preview.senderId !== senderId || preview.projectId !== projectId || preview.packageId !== packageId) {
			throw new Error('This connector source preview is unavailable in this project window. Preview the source again before importing.');
		}
		if (preview.expiresAt <= this.clock()) {
			this.previews.delete(previewId);
			throw new Error('This connector source preview expired. Preview the source again before importing.');
		}
		return preview;
	}

	private pruneExpiredPreviews(now = this.clock()): void {
		for (const [id, preview] of this.previews) {
			if (preview.expiresAt <= now) { this.previews.delete(id); }
		}
	}

	private invalidatePreviews(projectId: string, packageId: string): void {
		for (const [id, preview] of this.previews) {
			if (preview.projectId === projectId && preview.packageId === packageId && !preview.receipt) { this.previews.delete(id); }
		}
	}

	private sourceHash(source: DeclarativeImportedReferenceInput): string {
		return createHash('sha256').update(source.content).digest('hex');
	}

	private ensureAnonymousConnection(projectId: string, installed: InstalledConnectorPackage, validated: ValidatedDeclarativePackage): void {
		if (validated.manifest.accountAccess !== 'none') { return; }
		for (const host of validated.manifest.domains) {
			const hostConnection = this.database.listPackageConnections(projectId, installed.packageId)
				.find(connection => connection.manifestDigest === installed.manifestDigest && connection.host === host && connection.authKind === 'none' && connection.state === 'active');
			if (hostConnection) { continue; }
			const connection = this.database.createPackageConnection({
				projectId, packageId: installed.packageId, manifestDigest: installed.manifestDigest,
				host, grantedScopes: [], label: installed.name, authKind: 'none',
			});
			this.database.activatePackageConnection(projectId, installed.packageId, connection.accountRef);
		}
	}

	private async connect(sender: WebContents, projectId: string, request: WorkspacePackageConnectionRequest): Promise<WorkspacePackageConnectionDTO> {
		const installed = this.requireInstalled(projectId, request.packageId);
		const validated = this.validateInstalled(installed);
		const manifest = validated.manifest;
		if (manifest.accountAccess !== 'bearer-token' || manifest.domains.length !== 1 || request.host !== manifest.domains[0]) {
			throw new Error('This signed package does not allow a bearer account for the selected host.');
		}
		if (typeof request.label !== 'string' || !request.label.trim() || request.label.trim().length > 200
			|| typeof request.credential !== 'string' || request.credential.length < minimumDeclarativePackageCredentialLength
			|| !/^[\x21-\x7e]{1,16384}$/.test(request.credential)
			|| !Array.isArray(request.grantedScopes) || request.grantedScopes.some(scope => !manifest.requestedScopes.includes(scope))
			|| new Set(request.grantedScopes).size !== request.grantedScopes.length) {
			throw new Error('The package account label, token, or requested scopes are invalid.');
		}
		if (!await this.confirmConnection(sender, this.reviewDTO(validated), request.label.trim(), request.host, request.grantedScopes)) {
			throw new Error('Connector package account connection was cancelled.');
		}
		const connection = this.database.createPackageConnection({
			projectId, packageId: request.packageId, manifestDigest: installed.manifestDigest, host: request.host,
			grantedScopes: request.grantedScopes, label: request.label, authKind: 'bearer-token',
		});
		try {
			await this.getVault().put('declarative-package', connection.accountRef, request.credential);
			return this.connectionDTO(this.database.activatePackageConnection(projectId, request.packageId, connection.accountRef));
		} catch (error) {
			try {
				await this.cleanupConnection(connection);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], 'Package account setup failed and Keychain cleanup is pending. Retry cleanup before reconnecting.');
			}
			throw error;
		}
	}

	private async cleanupConnection(connection: DeclarativePackageConnection): Promise<DeclarativePackageConnection> {
		this.database.beginPackageConnectionDisconnect(connection.projectId, connection.packageId, connection.accountRef);
		this.invalidatePreviewsForAccount(connection.accountRef);
		if (connection.authKind === 'bearer-token') { await this.getVault().delete('declarative-package', connection.accountRef); }
		return this.database.completePackageConnectionDisconnect(connection.projectId, connection.packageId, connection.accountRef);
	}

	private invalidatePreviewsForAccount(accountRef: string): void {
		for (const [id, preview] of this.previews) {
			if (preview.accountRef === accountRef && !preview.receipt) { this.previews.delete(id); }
		}
	}

	private async connectionBinding(connection: DeclarativePackageConnection): Promise<{ accountRef: string; packageId: string; manifestDigest: string; host: string; grantedScopes: readonly string[]; credential: string | null }> {
		return {
			accountRef: connection.accountRef, packageId: connection.packageId, manifestDigest: connection.manifestDigest,
			host: connection.host, grantedScopes: connection.grantedScopes,
			credential: connection.authKind === 'bearer-token' ? await this.getVault().get('declarative-package', connection.accountRef) ?? null : null,
		};
	}

	private getVault(): Pick<KeychainVault, 'put' | 'get' | 'delete'> {
		this.vault ??= this.vaultFactory();
		return this.vault;
	}

	private requireInstalled(projectId: string, packageId: string): InstalledConnectorPackage {
		const installed = this.database.getInstalledConnectorPackage(projectId, packageId);
		if (!installed) { throw new Error('The connector package is not installed in this project.'); }
		return installed;
	}

	private requireConnection(projectId: string, packageId: string, connectionId: string): DeclarativePackageConnection {
		const connection = this.database.getPackageConnection(projectId, packageId, connectionId);
		if (!connection || connection.accountRef !== connectionId) { throw new Error('The package account is unavailable in this project.'); }
		return connection;
	}

	private requireActiveConnection(
		projectId: string, installed: InstalledConnectorPackage, connectionId: string, sourceId: string, expectedAccountRef?: string | null,
	): DeclarativePackageConnection {
		const connection = this.requireConnection(projectId, installed.packageId, connectionId);
		const validated = this.validateInstalled(installed);
		const source = validated.manifest.sources.find(candidate => candidate.sourceId === sourceId);
		if (!source || connection.state !== 'active' || connection.manifestDigest !== installed.manifestDigest
			|| connection.host !== source.domain || connection.authKind !== validated.manifest.accountAccess
			|| (expectedAccountRef !== undefined && expectedAccountRef !== connection.accountRef)) {
			throw new Error('Connect an active matching account for this installed package source.');
		}
		return connection;
	}

	private connectionDTO(connection: DeclarativePackageConnection): WorkspacePackageConnectionDTO {
		return {
			connectionId: connection.accountRef, accountRef: connection.accountRef, projectId: connection.projectId,
			packageId: connection.packageId, manifestDigest: connection.manifestDigest, host: connection.host,
			grantedScopes: [...connection.grantedScopes], label: connection.label, authKind: connection.authKind, state: connection.state,
		};
	}

	private validateInstalled(installed: InstalledConnectorPackage): ValidatedDeclarativePackage {
		const validated = validateDeclarativePackage(this.envelope(installed), this.trust(installed));
		if (validated.manifest.packageId !== installed.packageId || validated.manifest.name !== installed.name) {
			throw new Error('The installed connector package metadata does not match its signed manifest.');
		}
		return validated;
	}

	private installedDTO(installed: InstalledConnectorPackage): WorkspaceInstalledPackageDTO {
		return { ...this.reviewDTO(this.validateInstalled(installed)), installedAt: installed.installedAt, updatedAt: installed.updatedAt };
	}

	private reviewDTO(validated: ValidatedDeclarativePackage): WorkspacePackageReviewDTO {
		return {
			...validated.review,
			sources: validated.manifest.sources.map(source => ({ sourceId: source.sourceId, label: source.label })),
		};
	}

	private trust(installed: InstalledConnectorPackage): DeclarativePackageTrustContext {
		return { fingerprint: installed.fingerprint, version: installed.version, manifestDigest: installed.manifestDigest };
	}

	private approval(installed: InstalledConnectorPackage): WorkspacePackageApproval {
		return { packageId: installed.packageId, version: installed.version, fingerprint: installed.fingerprint, manifestDigest: installed.manifestDigest };
	}

	private envelope(installed: InstalledConnectorPackage): WorkspaceSignedPackageEnvelope {
		return {
			manifestBytesBase64: installed.manifestBytesBase64,
			signatureBase64: installed.signatureBase64,
			publicKeyBase64: installed.publicKeyBase64,
		};
	}

	private projectId(command: string, value: unknown): string {
		const projectId = command === 'listPackages' && typeof value === 'string' ? value : this.record(value).projectId;
		if (typeof projectId !== 'string' || !isUUID(projectId)) { throw new Error('A valid project ID is required.'); }
		return projectId;
	}

	private reviewRequest(value: unknown): WorkspacePackageReviewRequest {
		const record = this.record(value);
		if (!record.envelope || typeof record.envelope !== 'object' || Array.isArray(record.envelope)) {
			throw new Error('A signed connector package is required.');
		}
		return record as unknown as WorkspacePackageReviewRequest;
	}

	private installRequest(value: unknown): WorkspacePackageInstallRequest {
		const record = this.reviewRequest(value) as unknown as Record<string, unknown>;
		if (!record.approval || typeof record.approval !== 'object' || Array.isArray(record.approval)) {
			throw new Error('Review and approve the exact connector package before installation.');
		}
		return record as unknown as WorkspacePackageInstallRequest;
	}

	private packageRequest(value: unknown): WorkspacePackageRequest {
		const record = this.record(value);
		if (typeof record.packageId !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]{0,78}[a-z0-9])?$/.test(record.packageId)) {
			throw new Error('A valid connector package ID is required.');
		}
		return record as unknown as WorkspacePackageRequest;
	}

	private importRequest(value: unknown): WorkspacePackageImportRequest {
		const record = this.packageRequest(value) as unknown as Record<string, unknown>;
		if (typeof record.sourceId !== 'string' || typeof record.sourceKey !== 'string' || typeof record.connectionId !== 'string' || !isUUID(record.connectionId)) {
			throw new Error('A connector source and selected resource ID are required.');
		}
		return record as unknown as WorkspacePackageImportRequest;
	}

	private refreshRequest(value: unknown): WorkspacePackageRefreshRequest {
		const record = this.importRequest(value) as unknown as Record<string, unknown>;
		if (typeof record.previousReferenceId !== 'string' || !isUUID(record.previousReferenceId)) {
			throw new Error('A valid previous reference ID is required to refresh a connector source.');
		}
		return record as unknown as WorkspacePackageRefreshRequest;
	}

	private previewImportRequest(value: unknown): WorkspacePackagePreviewImportRequest {
		const record = this.packageRequest(value) as unknown as Record<string, unknown>;
		if (typeof record.previewId !== 'string' || !isUUID(record.previewId) || typeof record.connectionId !== 'string' || !isUUID(record.connectionId)) {
			throw new Error('A valid connector source preview is required before importing.');
		}
		if (record.taskId !== undefined && (typeof record.taskId !== 'string' || !isUUID(record.taskId))) {
			throw new Error('A valid task ID is required to attach this connector source.');
		}
		return record as unknown as WorkspacePackagePreviewImportRequest;
	}

	private connectionRequest(value: unknown): WorkspacePackageConnectionRequest {
		const record = this.packageRequest(value) as unknown as Record<string, unknown>;
		if (typeof record.host !== 'string' || typeof record.label !== 'string' || typeof record.credential !== 'string'
			|| !Array.isArray(record.grantedScopes) || record.grantedScopes.some(scope => typeof scope !== 'string')) {
			throw new Error('A valid package host, account label, token, and granted scopes are required.');
		}
		return record as unknown as WorkspacePackageConnectionRequest;
	}

	private connectionActionRequest(value: unknown): WorkspacePackageConnectionActionRequest {
		const record = this.packageRequest(value) as unknown as Record<string, unknown>;
		if (typeof record.connectionId !== 'string' || !isUUID(record.connectionId)) { throw new Error('A valid package account ID is required.'); }
		return record as unknown as WorkspacePackageConnectionActionRequest;
	}

	private record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('A connector package request is required.'); }
		return value as Record<string, unknown>;
	}

	private key(projectId: string, packageId: string): string { return `${projectId}:${packageId}`; }
}
