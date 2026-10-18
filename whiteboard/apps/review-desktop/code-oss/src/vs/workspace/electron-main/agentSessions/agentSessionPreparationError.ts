/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface AgentSessionPreparationRecovery {
	revokeAccess(): void;
	releasePrivateConfig(): Promise<void>;
}

/** A trusted preparation failure with an explicit receipt for resources created before PTY spawn. */
export class AgentSessionPreparationError extends Error {
	constructor(
		message: string,
		readonly cleanupVerified: boolean,
		readonly recovery?: AgentSessionPreparationRecovery,
	) {
		super(message);
		this.name = 'AgentSessionPreparationError';
		if (cleanupVerified && recovery) { throw new Error('Verified preparation cleanup cannot retain a recovery handle.'); }
	}
}
