/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebContents } from 'electron';
import { URI } from '../../base/common/uri.js';
import type { ICodeWindow } from '../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type { WorkspaceReferenceDTO } from '../common/workspaceKnowledgeProtocol.js';
import type { WorkspaceInstalledPackageDTO, WorkspacePackageReviewDTO, WorkspaceSignedPackageEnvelope } from '../common/workspacePackageConnectorProtocol.js';
import type { DeclarativePackageTransport } from './connectors/declarativePackageTransport.js';
import { WorkspaceDashboardChannel } from './workspaceDashboardChannel.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import { WorkspacePackageConnectorChannel } from './workspacePackageConnectorChannel.js';

test('signed package install requires native consent, pins updates, and imports only into the authorized project', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'workspace-package-channel-'));
	const database = WorkspaceDatabase.open(join(directory, 'workspace.db'));
	try {
		const descriptor = URI.file(join(directory, 'one.code-workspace')).toString();
		const one = database.createProjectWorkspace('One', directory, descriptor);
		const two = database.createProjectWorkspace('Two', directory, URI.file(join(directory, 'two.code-workspace')).toString());
		const sender = {} as WebContents;
		const projectWindow = {
			config: { reviewWindowLaunch: { kind: 'project', projectId: one.project.id } },
			openedWorkspace: { configPath: URI.parse(descriptor) },
		} as unknown as ICodeWindow;
		const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender ? projectWindow : undefined } as IWindowsMainService;
		const key = generateKeyPairSync('ed25519');
		const envelopeFor = (version: string): WorkspaceSignedPackageEnvelope => {
			const manifest = {
				schemaVersion: 1, packageId: 'example-issues', version, name: 'Example issues', description: 'Selected public issue records.',
				domains: ['api.example.org'], accountAccess: 'none',
				sources: [{ sourceId: 'issues', label: 'Issues', domain: 'api.example.org', path: '/issues/{sourceKey}', textPaths: ['title'] }],
			};
			const bytes = Buffer.from(JSON.stringify(manifest));
			const publicDer = Buffer.from(key.publicKey.export({ type: 'spki', format: 'der' }));
			return {
				manifestBytesBase64: bytes.toString('base64'),
				signatureBase64: sign(null, bytes, key.privateKey).toString('base64'),
				publicKeyBase64: publicDer.subarray(-32).toString('base64'),
			};
		};
		let allowNativeInstall = false;
		const reviews: WorkspacePackageReviewDTO[] = [];
		const transport: DeclarativePackageTransport = {
			get: async (url, domain) => {
				assert.equal(domain, 'api.example.org');
				assert.equal(url.href, 'https://api.example.org/issues/selected_1');
				return { title: 'Imported issue text' };
			},
		};
		const channel = new WorkspacePackageConnectorChannel(database, new WorkspaceDashboardChannel(database, windows),
			async (_sender, review) => { reviews.push(review); return allowNativeInstall; }, () => transport);
		const first = envelopeFor('1.0.0');
		const firstReview = await channel.call<WorkspacePackageReviewDTO>(sender, 'reviewPackage', { projectId: one.project.id, envelope: first });
		assert.equal(firstReview.trustStatus, 'first-install');
		assert.deepEqual(firstReview.domains, ['api.example.org']);
		assert.deepEqual(firstReview.sourceRules[0].fields, ['title']);
		const firstApproval = {
			packageId: firstReview.packageId, version: firstReview.version,
			fingerprint: firstReview.fingerprint, manifestDigest: firstReview.manifestDigest,
		};
		await assert.rejects(channel.call(sender, 'installPackage', {
			projectId: one.project.id, envelope: first, approval: firstApproval,
		}), /cancelled/);
		assert.equal(database.getInstalledConnectorPackage(one.project.id, firstReview.packageId), undefined);
		assert.equal(reviews.length, 1);
		allowNativeInstall = true;
		const installed = await channel.call<WorkspaceInstalledPackageDTO>(sender, 'installPackage', {
			projectId: one.project.id, envelope: first, approval: firstApproval,
		});
		assert.equal(installed.trustStatus, 'installed');
		assert.equal(database.listInstalledConnectorPackages(two.project.id).length, 0);
		await assert.rejects(channel.call(sender, 'listPackages', two.project.id), /does not match this window/);
		const imported = await channel.call<WorkspaceReferenceDTO>(sender, 'importPackageSource', {
			projectId: one.project.id, packageId: installed.packageId, sourceId: 'issues', sourceKey: 'selected_1',
		});
		assert.equal(imported.connectorId, 'local:example-issues');
		assert.match(Buffer.from(database.knowledge.readReference(imported.id)!.content).toString('utf8'), /Imported issue text/);
		const next = envelopeFor('2.0.0');
		const nextReview = await channel.call<WorkspacePackageReviewDTO>(sender, 'reviewPackage', { projectId: one.project.id, envelope: next });
		assert.equal(nextReview.trustStatus, 'same-key-update');
		await channel.call(sender, 'installPackage', {
			projectId: one.project.id, envelope: next,
			approval: { packageId: nextReview.packageId, version: nextReview.version, fingerprint: nextReview.fingerprint, manifestDigest: nextReview.manifestDigest },
		});
		assert.throws(() => database.saveInstalledConnectorPackage({
			projectId: one.project.id, packageId: firstReview.packageId, version: firstReview.version, name: firstReview.name,
			fingerprint: firstReview.fingerprint, manifestDigest: firstReview.manifestDigest,
			...first,
		}), /roll back/);
		await channel.call(sender, 'uninstallPackage', { projectId: one.project.id, packageId: firstReview.packageId });
		assert.equal(database.getInstalledConnectorPackage(one.project.id, firstReview.packageId), undefined);
		assert.ok(database.knowledge.readReference(imported.id));
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
