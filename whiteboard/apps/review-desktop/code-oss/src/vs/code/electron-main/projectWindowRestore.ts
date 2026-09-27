/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewWindowLaunch } from '../../platform/window/common/window.js';
import type { URI } from '../../base/common/uri.js';

export interface ProjectWindowIdentity {
	readonly config?: { readonly reviewWindowLaunch?: ReviewWindowLaunch };
	readonly openedWorkspace?: { readonly id: string; readonly configPath?: URI };
}

export function projectIdForWindow(window: ProjectWindowIdentity): string | undefined {
	const launch = window.config?.reviewWindowLaunch;
	return launch?.kind === 'project' ? launch.projectId : undefined;
}

export function hasProjectWindow(projectId: string, descriptorUri: string, windows: readonly ProjectWindowIdentity[]): boolean {
	return windows.some(window => projectIdForWindow(window) === projectId && window.openedWorkspace?.configPath?.toString() === descriptorUri);
}

export function releaseRecordedProjectWindow(
	recordedWindowIds: Set<number>,
	windowId: number,
	hasMatchingProjectWindow: boolean,
	clearOpenAtQuit: () => void,
): void {
	if (!recordedWindowIds.has(windowId)) { return; }
	if (!hasMatchingProjectWindow) { clearOpenAtQuit(); }
	recordedWindowIds.delete(windowId);
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
