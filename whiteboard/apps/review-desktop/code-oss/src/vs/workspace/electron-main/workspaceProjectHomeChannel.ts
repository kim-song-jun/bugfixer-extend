/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WebContents } from 'electron';
import { isUUID } from '../../base/common/uuid.js';
import type { IWindowsMainService } from '../../platform/windows/electron-main/windows.js';
import type { WorkspaceProjectDTO } from '../common/workspaceProjectHomeProtocol.js';
import { WorkspaceDatabase } from './workspaceDatabase.js';
import { ProjectWorkspaceService } from './projectWorkspaceService.js';

/** Main-process IPC boundary for the native project home. */
export class WorkspaceProjectHomeChannel {
	constructor(
		private readonly database: WorkspaceDatabase,
		private readonly projectWorkspaces: ProjectWorkspaceService,
		private readonly windowsMainService: IWindowsMainService,
		private readonly chooseFolderPath: (sender: WebContents) => Promise<string | null>,
		private readonly openProject: (projectId: string) => Promise<void>,
	) { }

	async call<T>(sender: WebContents, command: string, arg?: unknown): Promise<T> {
		const window = this.windowsMainService.getWindowByWebContents(sender);

		switch (command) {
			case 'listProjects': {
				if (arg !== undefined) { throw new Error('listProjects does not accept arguments.'); }
				if (window?.config?.reviewWindowLaunch.kind !== 'home') { this.requireAuthorizedProjectWindow(window); }
				return this.listProjects() as T;
			}
			case 'chooseFolder': {
				if (window?.config?.reviewWindowLaunch.kind !== 'home') {
					throw new Error('This operation requires the native project home window.');
				}
				if (arg !== undefined) { throw new Error('chooseFolder does not accept arguments.'); }
				const folderPath = await this.chooseFolderPath(sender);
				if (!folderPath) { return null as T; }
				const existing = this.projectWorkspaces.findProjectByFolder(folderPath);
				const project = existing ?? this.projectWorkspaces.createProject(folderPath.split(/[\\/]/).filter(Boolean).at(-1) || folderPath, folderPath);
				return this.toDTO(project.project, project.binding.path) as T;
			}
			case 'openProject': {
				if (window?.config?.reviewWindowLaunch.kind !== 'home') { this.requireAuthorizedProjectWindow(window); }
				if (typeof arg !== 'string' || !isUUID(arg)) { throw new Error('A valid project ID is required.'); }
				const project = this.database.getProject(arg);
				if (!project) { throw new Error('The requested project does not exist.'); }
				const view = this.database.getProjectView(arg);
				if (!view) { throw new Error('The requested project has no workspace view.'); }
				await this.openProject(arg);
				return undefined as T;
			}
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	private requireAuthorizedProjectWindow(window: ReturnType<IWindowsMainService['getWindowByWebContents']>): void {
		if (!window?.config || window.config.reviewWindowLaunch.kind !== 'project') {
			throw new Error('This operation requires the native project home or an open project window.');
		}
		const projectId = window.config.reviewWindowLaunch.projectId;
		if (!isUUID(projectId)) { throw new Error('The project window has an invalid project ID.'); }
		const project = this.database.getProject(projectId);
		const view = this.database.getProjectView(projectId);
		if (!project || !view) { throw new Error(`Project ${projectId} is unavailable.`); }
		const openedWorkspace = window.openedWorkspace;
		const openedDescriptorUri = openedWorkspace && 'configPath' in openedWorkspace ? openedWorkspace.configPath.toString() : undefined;
		if (!openedDescriptorUri || openedDescriptorUri !== view.descriptorUri) {
			throw new Error('The open workspace does not match this project.');
		}
	}

	private listProjects(): readonly WorkspaceProjectDTO[] {
		return this.database.listProjects().flatMap(project => {
			const binding = this.database.listFolderBindings(project.id)[0];
			return binding ? [{
				id: project.id,
				name: project.name,
				folderPath: binding.path,
				createdAt: project.createdAt,
				lastOpenedAt: this.database.getProjectLastOpenedAt(project.id),
			}] : [];
		}).sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	}

	private toDTO(project: { id: string; name: string; createdAt: string }, folderPath: string): WorkspaceProjectDTO {
		return { id: project.id, name: project.name, folderPath, createdAt: project.createdAt, lastOpenedAt: this.database.getProjectLastOpenedAt(project.id) };
	}
}
