/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebContents } from 'electron';
import { URI } from '../../base/common/uri.js';
import type { ICodeWindow } from '../../platform/window/electron-main/window.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type { WorkspaceReferenceDTO } from '../common/workspaceKnowledgeProtocol.js';
import type { WorkspaceInstalledPackageDTO, WorkspacePackagePreviewDTO, WorkspacePackageReviewDTO, WorkspaceSignedPackageEnvelope } from '../common/workspacePackageConnectorProtocol.js';
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
		const sender = { id: 1 } as WebContents;
		const secondSender = { id: 2 } as WebContents;
		const projectWindow = {
			config: { reviewWindowLaunch: { kind: 'project', projectId: one.project.id } },
			openedWorkspace: { configPath: URI.parse(descriptor) },
		} as unknown as ICodeWindow;
		const windows = { getWindowByWebContents: (candidate: WebContents) => candidate === sender || candidate === secondSender ? projectWindow : undefined } as IWindowsMainService;
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
		let remoteText = 'Previewed issue text';
		let currentTime = 1_000_000;
		let fetchCount = 0;
		const transport: DeclarativePackageTransport = {
			get: async (url, domain) => {
				assert.equal(domain, 'api.example.org');
				assert.equal(url.href, 'https://api.example.org/issues/selected_1');
				fetchCount++;
				return { title: remoteText };
			},
		};
		const channel = new WorkspacePackageConnectorChannel(database, new WorkspaceDashboardChannel(database, windows),
			async (_sender, review) => { reviews.push(review); return allowNativeInstall; }, () => transport, () => currentTime);
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
		const expiredPreview = await channel.call<WorkspacePackagePreviewDTO>(sender, 'previewPackageSource', {
			projectId: one.project.id, packageId: installed.packageId, sourceId: 'issues', sourceKey: 'selected_1',
		});
		assert.equal(expiredPreview.content, 'Record 1\ntitle: Previewed issue text\n');
		assert.equal(database.knowledge.listProjectReferences(one.project.id).length, 0, 'preview must not persist a snapshot');
		await assert.rejects(channel.call(secondSender, 'importPackagePreview', {
			projectId: one.project.id, packageId: installed.packageId, previewId: expiredPreview.previewId,
		}), /unavailable in this project window/i);
		currentTime = Date.parse(expiredPreview.expiresAt) + 1;
		await assert.rejects(channel.call(sender, 'importPackagePreview', {
			projectId: one.project.id, packageId: installed.packageId, previewId: expiredPreview.previewId,
		}), /expired/i);
		currentTime = 1_000_000;
		const preview = await channel.call<WorkspacePackagePreviewDTO>(sender, 'previewPackageSource', {
			projectId: one.project.id, packageId: installed.packageId, sourceId: 'issues', sourceKey: 'selected_1',
		});
		remoteText = 'Changed upstream after preview';
		const binding = database.listFolderBindings(one.project.id)[0];
		const task = database.createTask({ projectId: one.project.id, bindingId: binding.id, title: 'Import reviewed issue' });
		const otherTask = database.createTask({ projectId: one.project.id, bindingId: binding.id, title: 'Different task' });
		await assert.rejects(channel.call(sender, 'importPackagePreview', {
			projectId: one.project.id, packageId: installed.packageId, previewId: preview.previewId, taskId: randomUUID(),
		}), /active task/i);
		assert.equal(database.knowledge.listProjectReferences(one.project.id).length, 0, 'invalid task must roll back snapshot creation');
		const imported = await channel.call<WorkspaceReferenceDTO>(sender, 'importPackagePreview', {
			projectId: one.project.id, packageId: installed.packageId, previewId: preview.previewId, taskId: task.id,
		});
		assert.equal(imported.connectorId, 'local:example-issues');
		assert.equal(imported.contentSha256, preview.contentSha256);
		assert.match(Buffer.from(database.knowledge.readReference(imported.id)!.content).toString('utf8'), /Previewed issue text/);
		assert.doesNotMatch(Buffer.from(database.knowledge.readReference(imported.id)!.content).toString('utf8'), /Changed upstream/);
		assert.deepEqual(database.knowledge.listTaskReferences(task.id).map(reference => reference.id), [imported.id]);
		const retry = await channel.call<WorkspaceReferenceDTO>(sender, 'importPackagePreview', {
			projectId: one.project.id, packageId: installed.packageId, previewId: preview.previewId, taskId: task.id,
		});
		assert.equal(retry.id, imported.id, 'retry after a lost IPC response must return the committed snapshot');
		assert.equal(retry.version, imported.version);
		assert.equal(fetchCount, 2, 'commit and retry must not refetch the remote source');
		assert.equal(database.knowledge.listProjectReferences(one.project.id).length, 1);
		await assert.rejects(channel.call(sender, 'importPackagePreview', {
			projectId: one.project.id, packageId: installed.packageId, previewId: preview.previewId, taskId: otherTask.id,
		}), /different task/i, 'a committed preview cannot be rebound to another task');
		const refreshed = await channel.call<WorkspaceReferenceDTO>(sender, 'refreshPackageSource', {
			projectId: one.project.id, packageId: installed.packageId, sourceId: 'issues', sourceKey: 'selected_1', previousReferenceId: imported.id,
		});
		assert.equal(refreshed.previousId, imported.id);
		assert.equal(refreshed.version, imported.version + 1);
		assert.equal(refreshed.connectorVersion, installed.version);
		assert.match(Buffer.from(database.knowledge.readReference(refreshed.id)!.content).toString('utf8'), /Changed upstream after preview/);
		await assert.rejects(channel.call(sender, 'refreshPackageSource', {
			projectId: one.project.id, packageId: installed.packageId, sourceId: 'issues', sourceKey: 'selected_1', previousReferenceId: imported.id,
		}), /latest version/i);
		await assert.rejects(channel.call(sender, 'refreshPackageSource', {
			projectId: one.project.id, packageId: installed.packageId, sourceId: 'issues', sourceKey: 'selected_2', previousReferenceId: refreshed.id,
		}), /does not belong/i);
		const next = envelopeFor('2.0.0');
		const nextReview = await channel.call<WorkspacePackageReviewDTO>(sender, 'reviewPackage', { projectId: one.project.id, envelope: next });
		assert.equal(nextReview.trustStatus, 'same-key-update');
		const staleOnUpdate = await channel.call<WorkspacePackagePreviewDTO>(sender, 'previewPackageSource', {
			projectId: one.project.id, packageId: installed.packageId, sourceId: 'issues', sourceKey: 'selected_1',
		});
		await channel.call(sender, 'installPackage', {
			projectId: one.project.id, envelope: next,
			approval: { packageId: nextReview.packageId, version: nextReview.version, fingerprint: nextReview.fingerprint, manifestDigest: nextReview.manifestDigest },
		});
		await assert.rejects(channel.call(sender, 'importPackagePreview', {
			projectId: one.project.id, packageId: installed.packageId, previewId: staleOnUpdate.previewId,
		}), /unavailable in this project window/i);
		const staleOnUninstall = await channel.call<WorkspacePackagePreviewDTO>(sender, 'previewPackageSource', {
			projectId: one.project.id, packageId: installed.packageId, sourceId: 'issues', sourceKey: 'selected_1',
		});
		assert.throws(() => database.saveInstalledConnectorPackage({
			projectId: one.project.id, packageId: firstReview.packageId, version: firstReview.version, name: firstReview.name,
			fingerprint: firstReview.fingerprint, manifestDigest: firstReview.manifestDigest,
			...first,
		}), /roll back/);
		await channel.call(sender, 'uninstallPackage', { projectId: one.project.id, packageId: firstReview.packageId });
		assert.equal(database.getInstalledConnectorPackage(one.project.id, firstReview.packageId), undefined);
		await assert.rejects(channel.call(sender, 'importPackagePreview', {
			projectId: one.project.id, packageId: installed.packageId, previewId: staleOnUninstall.previewId,
		}), /unavailable in this project window/i);
		assert.ok(database.knowledge.readReference(imported.id));
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
