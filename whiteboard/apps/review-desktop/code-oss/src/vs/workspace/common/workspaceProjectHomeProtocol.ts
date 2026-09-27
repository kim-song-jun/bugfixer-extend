/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export const WORKSPACE_PROJECT_HOME_CHANNEL = 'vscode:workspaceProjectHome';

export interface WorkspaceProjectDTO {
	readonly id: string;
	readonly name: string;
	readonly folderPath: string;
	readonly createdAt: string;
	readonly lastOpenedAt: string | null;
}
