import type { ReviewWindowLaunch } from '../../window/common/window.js';

export interface IReviewProjectIdentity {
	readonly projectId: string;
	readonly projectName: string;
}

export function reviewWindowLaunchForWorkspace(
	explicitLaunch: ReviewWindowLaunch | undefined,
	isWorkspaceDescriptor: boolean,
	explicitProjectDescriptorMatches: boolean,
	resolvedProject: IReviewProjectIdentity | undefined
): ReviewWindowLaunch {
	if (explicitLaunch?.kind === 'sourceNavigator') {
		return explicitLaunch;
	}

	if (explicitLaunch?.kind === 'project') {
		if (!isWorkspaceDescriptor || !explicitProjectDescriptorMatches) {
			throw new Error('Explicit project launches must match their workspace descriptor.');
		}
		return explicitLaunch;
	}

	if (isWorkspaceDescriptor && resolvedProject?.projectId.trim() && resolvedProject.projectName.trim()) {
		return { kind: 'project', ...resolvedProject };
	}

	return { kind: 'sourceNavigator' };
}
