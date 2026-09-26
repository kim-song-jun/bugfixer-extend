/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ProjectWorkspaceRecoveryRequiredError, ProjectWorkspaceService } from './projectWorkspaceService.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';

function withWorkspace(run: (root: string, database: WorkspaceDatabase, service: ProjectWorkspaceService) => void): void {
	const root = mkdtempSync(join(tmpdir(), 'bugfixer-project-workspace-'));
	const profile = join(root, 'profile');
	const folder = join(root, 'checkout');
	const reboundFolder = join(root, 'rebound');
	mkdirSync(profile);
	mkdirSync(folder);
	mkdirSync(reboundFolder);
	const databasePath = join(profile, 'workspace.db');
	const database = WorkspaceDatabase.open(databasePath);
	const service = new ProjectWorkspaceService(database, profile);
	try { run(root, database, service); }
	finally {
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
}

test('projects on the same folder receive distinct durable descriptor URIs', () => {
	withWorkspace((root, database, service) => {
		const folder = realpathSync(join(root, 'checkout'));
		const first = service.createProject('First', folder);
		const second = service.createProject('Second', folder);
		assert.notEqual(first.view.descriptorUri, second.view.descriptorUri);
		assert.equal(first.binding.path, folder);
		assert.deepEqual(JSON.parse(readFileSync(first.descriptorPath, 'utf8')), { folders: [{ path: folder }] });
		assert.deepEqual(JSON.parse(readFileSync(second.descriptorPath, 'utf8')), { folders: [{ path: folder }] });
		database.close();
		const reopened = WorkspaceDatabase.open(join(root, 'profile', 'workspace.db'));
		try {
			const restored = new ProjectWorkspaceService(reopened, join(root, 'profile')).ensureDescriptor(first.project.id);
			assert.equal(restored.view.descriptorUri, first.view.descriptorUri);
			assert.equal(restored.binding.path, folder);
		} finally { reopened.close(); }
	});
});

test('project creation and reopen bind a real Git checkout and clear stale repository identity when it disappears', () => {
	withWorkspace((root, database, service) => {
		const folder = realpathSync(join(root, 'checkout'));
		execFileSync('git', ['init', '-q', folder]);
		const nested = join(folder, 'src');
		mkdirSync(nested);
		const created = service.createProject('Git project', nested);
		assert.equal(created.binding.vcsKind, 'git');
		assert.equal(created.binding.vcsRoot, folder);
		database.updateFolderBinding(created.binding.id, { expectedPath: nested, reviewRepositoryId: 'old-review-repository' });
		rmSync(join(folder, '.git'), { recursive: true });
		const reopened = service.ensureDescriptor(created.project.id);
		assert.equal(reopened.binding.vcsKind, null);
		assert.equal(reopened.binding.vcsRoot, null);
		assert.equal(reopened.binding.reviewRepositoryId, null);
	});
});

test('rebind preserves descriptor identity, clears checkout identity and retries file repair from durable DB state', () => {
	withWorkspace((root, database, service) => {
		const folder = realpathSync(join(root, 'checkout'));
		const created = service.createProject('Rebind', folder);
		const project = created.project;
		const binding = database.updateFolderBinding(created.binding.id, { expectedPath: folder, vcsKind: 'git', vcsRoot: folder, reviewRepositoryId: 'repo-old' })!;
		const descriptorPath = created.descriptorPath;
		const descriptorUri = created.view.descriptorUri;
		writeFileSync(descriptorPath, '{ broken');
		assert.throws(() => service.rebindFolder(project.id, join(root, 'absent'), binding.path), /unavailable/);
		assert.equal(database.getProject(project.id)?.id, project.id);
		const reboundFolder = realpathSync(join(root, 'rebound'));
		const rebound = service.rebindFolder(project.id, reboundFolder, binding.path);
		assert.equal(rebound.view.descriptorUri, descriptorUri);
		assert.deepEqual(rebound.binding, { ...binding, path: reboundFolder, vcsKind: null, vcsRoot: null, reviewRepositoryId: null });
		assert.deepEqual(JSON.parse(readFileSync(descriptorPath, 'utf8')), { folders: [{ path: reboundFolder }] });
		writeFileSync(descriptorPath, '{ interrupted write');
		assert.deepEqual(JSON.parse(readFileSync(service.ensureDescriptor(project.id).descriptorPath, 'utf8')), { folders: [{ path: reboundFolder }] });
	});
});

test('creation rejects missing or non-directory folders without creating a project', () => {
	withWorkspace((root, database, service) => {
		const filePath = join(root, 'plain-file');
		writeFileSync(filePath, 'file');
		assert.throws(() => service.createProject('Missing', join(root, 'missing')), /unavailable/);
		assert.throws(() => service.createProject('File', filePath), /not a directory/);
		assert.deepEqual(database.listProjects(), []);
	});
});

test('creation writes and syncs the descriptor before DB commit, leaving no project or file after write failures', () => {
	withWorkspace((root, database) => {
		const profile = join(root, 'profile');
		const folder = realpathSync(join(root, 'checkout'));
		const failures = [
			{ writeFileSync: () => { throw new Error('injected write failure'); }, fsyncSync, renameSync },
			{ writeFileSync, fsyncSync: () => { throw new Error('injected fsync failure'); }, renameSync },
			{ writeFileSync, fsyncSync, renameSync: () => { throw new Error('injected rename failure'); } },
		];
		for (const operations of failures) {
			const service = new ProjectWorkspaceService(database, profile, operations);
			assert.throws(() => service.createProject('Must not persist', folder), /injected/);
			assert.deepEqual(database.listProjects(), []);
			assert.deepEqual(readdirSync(join(profile, 'projects')), []);
		}
	});
});

test('creation removes its durable staged descriptor when the DB transaction fails', () => {
	withWorkspace((root, database) => {
		const profile = join(root, 'profile');
		const folder = realpathSync(join(root, 'checkout'));
		const db = new DatabaseSync(join(profile, 'workspace.db'));
		db.exec("CREATE TRIGGER reject_projects BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'injected DB failure'); END;");
		db.close();
		const service = new ProjectWorkspaceService(database, profile);
		assert.throws(() => service.createProject('Rejected', folder), /injected DB failure/);
		assert.deepEqual(readdirSync(join(profile, 'projects')), []);
		assert.deepEqual(database.listProjects(), []);
	});
});

test('rebind retries a descriptor rename failure and reports recovery-required if both writes fail', () => {
	withWorkspace((root, database) => {
		const profile = join(root, 'profile');
		const oldFolder = realpathSync(join(root, 'checkout'));
		const newFolder = realpathSync(join(root, 'rebound'));
		let renameFailures = 0;
		const retrying = new ProjectWorkspaceService(database, profile, {
			writeFileSync, fsyncSync,
			renameSync: (oldPath, newPath) => {
				if (renameFailures-- > 0) { throw new Error('injected one-shot rename failure'); }
				renameSync(oldPath, newPath);
			},
		});
		const created = retrying.createProject('Rebind retry', oldFolder);
		renameFailures = 1;
		const rebound = retrying.rebindFolder(created.project.id, newFolder, oldFolder);
		assert.equal(rebound.binding.path, newFolder);
		assert.deepEqual(JSON.parse(readFileSync(created.descriptorPath, 'utf8')), { folders: [{ path: newFolder }] });

		let persistentFailure = true;
		const failing = new ProjectWorkspaceService(database, profile, {
			writeFileSync, fsyncSync,
			renameSync: (oldPath, targetPath) => {
				if (persistentFailure) { throw new Error('injected persistent rename failure'); }
				renameSync(oldPath, targetPath);
			},
		});
		const finalFolder = realpathSync(join(root, 'checkout'));
		assert.throws(() => failing.rebindFolder(created.project.id, finalFolder, newFolder), ProjectWorkspaceRecoveryRequiredError);
		assert.equal(database.listFolderBindings(created.project.id)[0]?.path, finalFolder);
		persistentFailure = false;
		assert.deepEqual(JSON.parse(readFileSync(failing.ensureDescriptor(created.project.id).descriptorPath, 'utf8')), { folders: [{ path: finalFolder }] });
	});
});

test('ensureDescriptor repairs content for a missing folder so the project remains available for rebind', () => {
	withWorkspace((root, _database, service) => {
		const folder = realpathSync(join(root, 'checkout'));
		const created = service.createProject('Moved folder', folder);
		writeFileSync(created.descriptorPath, JSON.stringify({ folders: [{ path: '/stale/location' }] }));
		rmSync(folder, { recursive: true, force: true });
		const restored = service.ensureDescriptor(created.project.id);
		assert.equal(restored.binding.path, folder);
		assert.deepEqual(JSON.parse(readFileSync(restored.descriptorPath, 'utf8')), { folders: [{ path: folder }] });
	});
});

test('descriptor identity cannot be rebound across project records', () => {
	withWorkspace((root, database, service) => {
		const folder = realpathSync(join(root, 'checkout'));
		const first = service.createProject('First', folder);
		const second = service.createProject('Second', folder);
		assert.notEqual(service.ensureDescriptor(first.project.id).view.descriptorUri, service.ensureDescriptor(second.project.id).view.descriptorUri);
		assert.throws(() => database.setProjectView({ ...second.view, descriptorUri: first.view.descriptorUri }), /UNIQUE constraint failed/);
	});
});
