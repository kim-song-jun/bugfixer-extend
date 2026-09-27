/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWorkspaceIdentifier, type IWorkspaceIdentifier, type ISingleFolderWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import type { ReviewWindowLaunch } from '../../platform/window/common/window.js';

export interface ProjectWindowIdentity {
	readonly config?: { readonly reviewWindowLaunch?: ReviewWindowLaunch };
	readonly openedWorkspace?: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier;
}

export function projectIdForWindow(window: ProjectWindowIdentity): string | undefined {
	const launch = window.config?.reviewWindowLaunch;
	return launch?.kind === 'project' ? launch.projectId : undefined;
}

export function hasProjectWindow(projectId: string, descriptorUri: string, windows: readonly ProjectWindowIdentity[]): boolean {
	return windows.some(window => {
		if (projectIdForWindow(window) === projectId) { return true; }
		const workspace = window.openedWorkspace;
		return !!workspace && isWorkspaceIdentifier(workspace) && workspace.configPath.toString() === descriptorUri;
	});
}

/** Share one window creation while menu, Home, and startup restoration race for a project. */
export class ProjectWindowOpenCoordinator<T> {
	private readonly inFlight = new Map<string, Promise<T>>();

	get(projectId: string): Promise<T> | undefined {
		return this.inFlight.get(projectId);
	}

	open(projectId: string, start: () => Promise<T>): Promise<T> {
		const pending = this.inFlight.get(projectId);
		if (pending) { return pending; }
		const opening = Promise.resolve().then(start);
		const tracked = opening.finally(() => { this.inFlight.delete(projectId); });
		this.inFlight.set(projectId, tracked);
		return tracked;
	}
}

export async function restoreProjectWindows(
	projectIds: readonly string[],
	alreadyOpenProjectIds: readonly string[],
	openProject: (projectId: string) => Promise<void>,
	onFailure: (projectId: string, error: unknown) => void,
): Promise<void> {
	const opened = new Set(alreadyOpenProjectIds);
	for (const projectId of projectIds) {
		if (opened.has(projectId)) { continue; }
		// Reserve before awaiting so duplicate IDs in the saved list cannot open twice.
		opened.add(projectId);
		try {
			await openProject(projectId);
		} catch (error) {
			onFailure(projectId, error);
		}
	}
}
