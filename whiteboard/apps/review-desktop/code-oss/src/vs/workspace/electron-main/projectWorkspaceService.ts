/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WorkspaceDatabase, type ProjectView, type VcsKind, type WorkspaceFolderBinding, type WorkspaceProject } from './workspaceDatabase.js';

export interface ProjectWorkspace {
	readonly project: WorkspaceProject;
	readonly binding: WorkspaceFolderBinding;
	readonly view: ProjectView;
	readonly descriptorPath: string;
}

export interface ProjectWorkspaceFileOperations {
	writeFileSync(fd: number, data: string, encoding: 'utf8'): void;
	fsyncSync(fd: number): void;
	renameSync(oldPath: string, newPath: string): void;
}

const defaultFileOperations: ProjectWorkspaceFileOperations = { writeFileSync, fsyncSync, renameSync };

export class ProjectWorkspaceRecoveryRequiredError extends Error {
	constructor(readonly projectId: string, readonly descriptorPath: string, cause: unknown, readonly recoveryCause: unknown) {
		super(`Project ${projectId} was rebound in workspace.db, but its descriptor could not be repaired. Workspace recovery is required before opening it.`, { cause: new AggregateError([cause, recoveryCause]) });
		this.name = 'ProjectWorkspaceRecoveryRequiredError';
	}
}

/** Owns the stable Code OSS workspace descriptor for each app project. */
export class ProjectWorkspaceService {
	private readonly descriptorDirectory: string;

	constructor(private readonly database: WorkspaceDatabase, profileDirectory: string, private readonly fileOperations: ProjectWorkspaceFileOperations = defaultFileOperations) {
		this.descriptorDirectory = join(realpathSync(profileDirectory), 'projects');
	}

	findProjectByFolder(folderPath: string): ProjectWorkspace | undefined {
		const canonicalPath = this.requireDirectory(folderPath);
		for (const project of this.database.listProjects()) {
			if (this.database.listFolderBindings(project.id).some(binding => binding.path === canonicalPath)) {
				return this.ensureDescriptor(project.id);
			}
		}
		return undefined;
	}

	createProject(name: string, folderPath: string): ProjectWorkspace {
		const projectName = name.trim();
		if (!projectName) { throw new Error('A project name is required.'); }
		const canonicalPath = this.requireDirectory(folderPath);
		mkdirSync(this.descriptorDirectory, { recursive: true });
		const projectId = randomUUID();
		const descriptorPath = join(this.descriptorDirectory, `${projectId}.code-workspace`);
		const descriptorUri = pathToFileURL(descriptorPath).toString();
		try { this.writeDescriptor(descriptorPath, canonicalPath); }
		catch (error) {
			if (existsSync(descriptorPath)) {
				try { this.removeDescriptor(descriptorPath); }
				catch (cleanupError) { throw new AggregateError([error, cleanupError], `Project descriptor staging failed and cleanup also failed: ${descriptorPath}`); }
			}
			throw error;
		}
		let created: ReturnType<WorkspaceDatabase['createProjectWorkspace']>;
		try { created = this.database.createProjectWorkspace(projectName, canonicalPath, descriptorUri, projectId, this.detectVcs(canonicalPath)); }
		catch (error) {
			try { this.removeDescriptor(descriptorPath); }
			catch (cleanupError) { throw new AggregateError([error, cleanupError], `Project creation failed and its staged descriptor could not be removed: ${descriptorPath}`); }
			throw error;
		}
		return { ...created, descriptorPath };
	}

	ensureDescriptor(projectId: string): ProjectWorkspace {
		const project = this.database.getProject(projectId);
		if (!project) { throw new Error(`Project ${projectId} does not exist.`); }
		let binding = this.currentBinding(projectId);
		// Keep the descriptor repairable when a removable or renamed project folder
		// is temporarily absent; the user can then rebind it from the app.
		if (existsSync(binding.path)) {
			const canonicalBindingPath = this.requireDirectory(binding.path);
			if (canonicalBindingPath !== binding.path) { throw new Error(`Project ${projectId} folder identity changed before reopening.`); }
			const detectedVcs = this.detectVcs(canonicalBindingPath);
			if (binding.vcsKind !== detectedVcs.vcsKind || binding.vcsRoot !== detectedVcs.vcsRoot) {
				binding = this.database.updateFolderBinding(binding.id, {
					expectedPath: binding.path, ...detectedVcs, reviewRepositoryId: null,
				})!;
			}
		}
		const view = this.database.getProjectView(projectId);
		if (!view) { throw new Error(`Project ${projectId} has no workspace descriptor identity.`); }
		const descriptorPath = this.requireOwnedDescriptor(projectId, view.descriptorUri);
		const folderPath = binding.path;
		if (!folderPath) { throw new Error(`Project ${projectId} has an empty folder binding.`); }
		const expected = this.serializeDescriptor(folderPath);
		let actual: string | undefined;
		try { actual = readFileSync(descriptorPath, 'utf8'); }
		catch (error) {
			if (!isMissingFile(error)) { throw error; }
		}
		if (actual !== expected) { this.writeDescriptor(descriptorPath, folderPath); }
		return { project, binding, view, descriptorPath };
	}

	rebindFolder(projectId: string, newPath: string, expectedPath: string): ProjectWorkspace {
		const project = this.database.getProject(projectId);
		if (!project) { throw new Error(`Project ${projectId} does not exist.`); }
		const binding = this.currentBinding(projectId);
		if (binding.path !== expectedPath) { throw new Error(`Project ${projectId} folder changed before rebind.`); }
		const canonicalPath = this.requireDirectory(newPath);
		const updatedBinding = this.database.rebindProjectFolder(projectId, canonicalPath, expectedPath, this.detectVcs(canonicalPath));
		const view = this.database.getProjectView(projectId);
		if (!view) { throw new Error(`Project ${projectId} has no workspace descriptor identity.`); }
		const descriptorPath = this.requireOwnedDescriptor(projectId, view.descriptorUri);
		try { this.writeDescriptor(descriptorPath, canonicalPath); }
		catch (writeError) {
			try { this.writeDescriptor(descriptorPath, updatedBinding.path); }
			catch (recoveryError) { throw new ProjectWorkspaceRecoveryRequiredError(projectId, descriptorPath, writeError, recoveryError); }
		}
		return { project, binding: updatedBinding, view, descriptorPath };
	}

	private currentBinding(projectId: string): WorkspaceFolderBinding {
		const binding = this.database.listFolderBindings(projectId)[0];
		if (!binding) { throw new Error(`Project ${projectId} has no folder binding.`); }
		return binding;
	}

	private requireDirectory(path: string): string {
		let canonicalPath: string;
		try {
			canonicalPath = realpathSync(path);
			if (!statSync(canonicalPath).isDirectory()) { throw new Error(`Project folder is not a directory: ${path}`); }
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('Project folder is not a directory:')) { throw error; }
			throw new Error(`Project folder is unavailable: ${path}`, { cause: error });
		}
		return canonicalPath;
	}

	private detectVcs(folderPath: string): { vcsKind: VcsKind | null; vcsRoot: string | null } {
		let current = folderPath;
		while (true) {
			for (const [marker, vcsKind] of [['.jj', 'jj'], ['.git', 'git']] as const) {
				try {
					const stat = lstatSync(join(current, marker));
					if (stat.isDirectory() || (vcsKind === 'git' && stat.isFile())) {
						return { vcsKind, vcsRoot: current };
					}
				} catch (error) {
					if (!isMissingFile(error)) { throw new Error(`Could not inspect the project repository marker: ${current}`, { cause: error }); }
				}
			}
			const parent = dirname(current);
			if (parent === current) { return { vcsKind: null, vcsRoot: null }; }
			current = parent;
		}
	}

	private requireOwnedDescriptor(projectId: string, descriptorUri: string): string {
		const expectedPath = join(this.descriptorDirectory, `${projectId}.code-workspace`);
		const expectedUri = pathToFileURL(expectedPath).toString();
		if (expectedUri !== descriptorUri) { throw new Error(`Project ${projectId} has an invalid workspace descriptor URI: expected ${expectedUri}, received ${descriptorUri}.`); }
		return expectedPath;
	}

	private serializeDescriptor(folderPath: string): string {
		return `${JSON.stringify({ folders: [{ path: folderPath }] }, null, 2)}\n`;
	}

	private removeDescriptor(descriptorPath: string): void {
		unlinkSync(descriptorPath);
		const directoryFd = openSync(dirname(descriptorPath), 'r');
		try { this.fileOperations.fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
	}

	private writeDescriptor(descriptorPath: string, folderPath: string): void {
		mkdirSync(dirname(descriptorPath), { recursive: true });
		const temporaryPath = `${descriptorPath}.${randomUUID()}.tmp`;
		let descriptorFd: number | undefined;
		try {
			descriptorFd = openSync(temporaryPath, 'wx', 0o600);
			this.fileOperations.writeFileSync(descriptorFd, this.serializeDescriptor(folderPath), 'utf8');
			this.fileOperations.fsyncSync(descriptorFd);
			closeSync(descriptorFd);
			descriptorFd = undefined;
			this.fileOperations.renameSync(temporaryPath, descriptorPath);
			const directoryFd = openSync(dirname(descriptorPath), 'r');
			try { this.fileOperations.fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
		} catch (error) {
			if (descriptorFd !== undefined) { closeSync(descriptorFd); }
			if (existsSync(temporaryPath)) { unlinkSync(temporaryPath); }
			throw error;
		}
	}
}

function isMissingFile(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
