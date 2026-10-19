/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSessionProvider } from './workspaceAgentSessionProtocol.js';

/** Safe CLI capability metadata; this never includes command output or profile contents. */
export interface WorkspaceAgentSetupCapabilitiesDTO {
	readonly provider: AgentSessionProvider;
	readonly commandSpecVersion: 1;
	readonly version: string;
	readonly interactive: boolean;
	readonly model: boolean;
	readonly resumeById: boolean;
	readonly newSessionId: boolean;
	readonly workingDirectory: boolean;
	readonly readOnlyPolicy: boolean;
	readonly mutatingPolicy: boolean;
	readonly invocationMcpConfig: boolean;
	readonly exclusiveMcpRoster: boolean;
	readonly profileSelector: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR';
	readonly requiredPermissionModes: readonly string[];
}

export interface WorkspaceAgentSetupInspectionDTO {
	readonly projectId: string;
	readonly provider: AgentSessionProvider;
	readonly checkedAt: string;
	readonly installation: {
		readonly state: 'available' | 'missing' | 'unsupported' | 'unavailable';
		readonly executablePath: string | null;
		readonly version: string | null;
		readonly reason: string | null;
	};
	readonly authentication: {
		readonly state: 'credentialPresent' | 'signedOut' | 'unavailable';
		readonly profileRef: 'local-default-codex' | 'local-default-claude';
		/** A local credential record does not verify execution, account access, or entitlement. */
		readonly validForExecution: false;
		readonly reason: string | null;
	};
	readonly capabilities: WorkspaceAgentSetupCapabilitiesDTO | null;
	readonly cleanupVerified: boolean;
}
