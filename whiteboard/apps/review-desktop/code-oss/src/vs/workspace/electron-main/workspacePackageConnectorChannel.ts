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
} from '../common/workspacePackageConnectorProtocol.js';
import {
	approveDeclarativePackage, validateDeclarativePackage, type DeclarativePackageTrustContext, type ValidatedDeclarativePackage,
} from './connectors/declarativePackage.js';
import { importDeclarativePackageSource, type DeclarativeImportedReferenceInput } from './connectors/declarativePackageRuntime.js';
import { PinnedDeclarativePackageTransport, type DeclarativePackageTransport } from './connectors/declarativePackageTransport.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase, type InstalledConnectorPackage } from './workspaceDatabase.js';

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

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly dashboardChannel: WorkspaceDashboardChannel,
		private readonly confirmInstall: (sender: WebContents, review: WorkspacePackageReviewDTO) => Promise<boolean>,
		private readonly transportFactory: () => DeclarativePackageTransport = () => new PinnedDeclarativePackageTransport(),
		private readonly clock: () => number = Date.now,
	) { }

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		const projectId = this.projectId(command, arg);
		await this.dashboardChannel.call<WorkspaceDashboardDTO>(sender, 'getDashboard', projectId);
		switch (command) {
			case 'listPackages':
				return this.database.listInstalledConnectorPackages(projectId).map(record => this.installedDTO(record)) as T;
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
					const saved = this.database.saveInstalledConnectorPackage({
						projectId, packageId: validated.manifest.packageId, version: validated.manifest.version, name: validated.manifest.name,
						fingerprint: validated.fingerprint, manifestDigest: validated.manifestDigest,
						manifestBytesBase64: request.envelope.manifestBytesBase64,
						signatureBase64: request.envelope.signatureBase64, publicKeyBase64: request.envelope.publicKeyBase64,
					});
					this.invalidatePreviews(projectId, saved.packageId);
					return this.installedDTO(saved);
				}) as T;
			}
			case 'uninstallPackage': {
				const request = this.packageRequest(arg);
				await this.sequencer.queue(this.key(projectId, request.packageId), async () => {
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
					const source = await importDeclarativePackageSource(approved, request, this.transportFactory());
					await this.dashboardChannel.call<WorkspaceDashboardDTO>(sender, 'getDashboard', projectId);
					return this.createPreview(sender, projectId, installed, request, source) as T;
				}) as T;
			}
			case 'importPackagePreview': {
				const request = this.previewImportRequest(arg);
				return await this.sequencer.queue(this.key(projectId, request.packageId), async () => {
					const preview = this.requirePreview(request.previewId, sender.id, projectId, request.packageId);
					if (preview.receipt) {
						if (request.taskId !== preview.committedTaskId) {
							throw new Error('This connector preview was already imported for a different task.');
						}
						return preview.receipt as T;
					}
					const installed = this.database.getInstalledConnectorPackage(projectId, request.packageId);
					if (!installed || installed.version !== preview.packageVersion || installed.fingerprint !== preview.packageFingerprint
						|| installed.manifestDigest !== preview.packageManifestDigest) {
						this.previews.delete(preview.previewId);
						throw new Error('The connector package changed after preview. Preview the source again before importing.');
					}
					if (preview.source.connectorId !== `local:${preview.packageId}` || preview.source.connectorVersion !== preview.packageVersion
						|| preview.source.accountRef !== null || preview.source.externalId !== `${preview.packageId}:${preview.sourceId}:${preview.sourceKey}`) {
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
					const expectedExternalId = `${request.packageId}:${request.sourceId}:${request.sourceKey}`;
					if (!previous || previous.projectId !== projectId || previous.connectorId !== `local:${request.packageId}`
						|| previous.accountRef !== null || previous.externalId !== expectedExternalId) {
						throw new Error('The selected reference does not belong to this connector source in this project.');
					}
					const validated = this.validateInstalled(installed);
					const approved = approveDeclarativePackage(validated, this.approval(installed));
					const source = await importDeclarativePackageSource(approved, request, this.transportFactory());
					// Recheck after network I/O, immediately before the synchronous store transaction.
					const latest = this.database.knowledge.listProjectReferences(projectId)
						.filter(reference => reference.sourceId === previous.sourceId)
						.sort((left, right) => right.version - left.version)[0];
					if (latest?.id !== previous.id) { throw new Error('Refresh the latest version of this connector source.'); }
					const imported = this.database.knowledge.importReference({ projectId, ...source });
					const { content: _content, derivedText: _derivedText, ...metadata } = imported;
					return metadata;
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
			sourceId: request.sourceId, sourceKey: request.sourceKey, source: storedSource, contentSha256, createdAt: now, expiresAt,
		});
		return {
			previewId, packageId: installed.packageId, sourceId: request.sourceId, sourceKey: request.sourceKey,
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
		if (typeof record.sourceId !== 'string' || typeof record.sourceKey !== 'string') {
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
		if (typeof record.previewId !== 'string' || !isUUID(record.previewId)) {
			throw new Error('A valid connector source preview is required before importing.');
		}
		if (record.taskId !== undefined && (typeof record.taskId !== 'string' || !isUUID(record.taskId))) {
			throw new Error('A valid task ID is required to attach this connector source.');
		}
		return record as unknown as WorkspacePackagePreviewImportRequest;
	}

	private record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('A connector package request is required.'); }
		return value as Record<string, unknown>;
	}

	private key(projectId: string, packageId: string): string { return `${projectId}:${packageId}`; }
}
