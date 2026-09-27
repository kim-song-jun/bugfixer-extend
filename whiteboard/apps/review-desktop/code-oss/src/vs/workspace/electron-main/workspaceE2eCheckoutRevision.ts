/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceFolderBinding } from './workspaceDatabase.js';

const execFileAsync = promisify(execFile);
const commitIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface WorkspaceE2eCheckoutRevision {
	readonly revision: string | null;
	readonly unavailableReason: string | null;
}

/** Reads the full commit currently checked out before an E2E TaskSpace is opened. */
export async function readWorkspaceE2eCheckoutRevision(binding: Pick<WorkspaceFolderBinding, 'vcsKind' | 'vcsRoot'>): Promise<WorkspaceE2eCheckoutRevision> {
	if (binding.vcsKind === null && binding.vcsRoot === null) {
		return { revision: null, unavailableReason: '이 작업은 Git 또는 jj 버전 이력이 없는 일반 폴더에서 진행됩니다.' };
	}
	if (!binding.vcsRoot?.trim()) {
		throw new Error('The task checkout has incomplete version control metadata; E2E checks cannot capture its revision.');
	}
	let args: string[];
	switch (binding.vcsKind) {
		case 'git':
			args = ['-C', binding.vcsRoot, 'rev-parse', '--verify', 'HEAD^{commit}'];
			break;
		case 'jj':
			args = ['--repository', binding.vcsRoot, 'log', '--no-graph', '-r', '@', '-T', 'commit_id'];
			break;
		default:
			throw new Error('The task checkout has an unsupported version control kind; E2E checks cannot capture its revision.');
	}
	let output: string;
	// Git and jj must resolve the repository from the verified binding, not
	// from GIT_DIR, GIT_WORK_TREE, or another inherited VCS override.
	const env: NodeJS.ProcessEnv = {};
	for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL']) {
		if (process.env[key] !== undefined) { env[key] = process.env[key]; }
	}
	try {
		({ stdout: output } = await execFileAsync(binding.vcsKind, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true, env }));
	} catch {
		throw new Error(`Could not read the checked-out ${binding.vcsKind} revision; the E2E check was not started.`);
	}
	const revision = output.trim();
	if (!commitIdPattern.test(revision)) {
		throw new Error(`The checked-out ${binding.vcsKind} revision was not returned as a full commit ID; the E2E check was not started.`);
	}
	return { revision, unavailableReason: null };
}
