/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WebContents } from 'electron';
import { SequencerByKey } from '../../base/common/async.js';
import { isUUID } from '../../base/common/uuid.js';
import type { WorkspaceDashboardDTO } from '../common/workspaceDashboardProtocol.js';
import type {
	WorkspaceInstalledPackageDTO, WorkspacePackageApproval, WorkspacePackageImportRequest, WorkspacePackageInstallRequest,
	WorkspacePackageRequest, WorkspacePackageReviewDTO, WorkspacePackageReviewRequest, WorkspaceSignedPackageEnvelope,
} from '../common/workspacePackageConnectorProtocol.js';
import {
	approveDeclarativePackage, validateDeclarativePackage, type DeclarativePackageTrustContext, type ValidatedDeclarativePackage,
} from './connectors/declarativePackage.js';
import { importDeclarativePackageSource } from './connectors/declarativePackageRuntime.js';
import { PinnedDeclarativePackageTransport, type DeclarativePackageTransport } from './connectors/declarativePackageTransport.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase, type InstalledConnectorPackage } from './workspaceDatabase.js';

/** Signed, credential-free package broker. Only the project window may review, install, and import. */
export class WorkspacePackageConnectorChannel {
	private readonly sequencer = new SequencerByKey<string>();

	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly dashboardChannel: WorkspaceDashboardChannel,
		private readonly confirmInstall: (sender: WebContents, review: WorkspacePackageReviewDTO) => Promise<boolean>,
		private readonly transportFactory: () => DeclarativePackageTransport = () => new PinnedDeclarativePackageTransport(),
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
					return this.installedDTO(saved);
				}) as T;
			}
			case 'uninstallPackage': {
				const request = this.packageRequest(arg);
				await this.sequencer.queue(this.key(projectId, request.packageId), async () => this.database.uninstallConnectorPackage(projectId, request.packageId));
				return undefined as T;
			}
			case 'importPackageSource': {
				const request = this.importRequest(arg);
				return await this.sequencer.queue(this.key(projectId, request.packageId), async () => {
					const installed = this.database.getInstalledConnectorPackage(projectId, request.packageId);
					if (!installed) { throw new Error('The connector package is not installed in this project.'); }
					const validated = this.validateInstalled(installed);
					const approved = approveDeclarativePackage(validated, this.approval(installed));
					const source = await importDeclarativePackageSource(approved, request, this.transportFactory());
					const { content: _content, derivedText: _derivedText, ...metadata } = this.database.knowledge.importReference({ projectId, ...source });
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

	private record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('A connector package request is required.'); }
		return value as Record<string, unknown>;
	}

	private key(projectId: string, packageId: string): string { return `${projectId}:${packageId}`; }
}
