/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { AGENT_SESSION_PUBLICATION_DIFF_MAX_BYTES, type AgentSessionPublicationDiff, type AgentSessionPublicationDiffPath, type AgentSessionPublicationMergedSource, type AgentSessionPublicationProposalDTO } from '../../common/workspaceAgentPublicationProtocol.js';
import { publicationRepository, type PublicationBoundRemote, type PublicationGithubSession } from './agentPublicationGithub.js';
import { createPublicationDirectory, PublicationFailure, publicationEnvironment, runPublicationProcess, verifyPublicationExecutable, type PublicationExecutable } from './agentPublicationProcess.js';

/** A signed integration-manager export, verified by the host authority before returning bytes. */
export interface PublicationSourceExport {
	readonly source: AgentSessionPublicationMergedSource;
	readonly remote: PublicationBoundRemote;
	/** Complete object closure for the pinned result commit, without repository/config paths. */
	readonly pack: Buffer;
}
export interface PublicationGitBinaries {
	readonly git: PublicationExecutable;
	readonly httpsTransport: PublicationExecutable;
	readonly prePushGuard: PublicationExecutable;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
export class PublicationGitContext {
	private constructor(readonly directory: string, private readonly binaries: PublicationGitBinaries) { }

	static async create(privateRoot: string, binaries: PublicationGitBinaries, exported: PublicationSourceExport): Promise<PublicationGitContext> {
		if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(exported.source.resultCommit) || exported.pack.length > 128 * 1024 * 1024 || exported.pack.length < 12) { throw new PublicationFailure('invalidObservation'); }
		publicationRepository(exported.remote);
		const directory = await createPublicationDirectory(privateRoot);
		const context = new PublicationGitContext(directory, binaries);
		try {
			for (const child of ['home', 'hooks', 'exec', 'template']) { await mkdir(join(directory, child), { mode: 0o700 }); }
			await context.install(binaries.prePushGuard, join(directory, 'hooks', 'pre-push'));
			await context.install(binaries.httpsTransport, join(directory, 'exec', 'git-remote-https'));
			await context.git(['init', '--bare', `--template=${join(directory, 'template')}`, `--object-format=${exported.source.resultCommit.length === 40 ? 'sha1' : 'sha256'}`, join(directory, 'repo')]);
			await context.git(['index-pack', '--stdin', '--strict'], undefined, exported.pack);
			await context.git(['cat-file', '-e', `${exported.source.resultCommit}^{commit}`]);
			return context;
		} catch (error) { await context.dispose(); throw error; }
	}

	async diff(baseOid: string, headOid: string, remote: PublicationBoundRemote, github: PublicationGithubSession): Promise<AgentSessionPublicationDiff> {
		if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(baseOid) || baseOid.length !== headOid.length) { throw new PublicationFailure('baseChanged'); }
		// Fetch only into this context. No FETCH_HEAD, original refs, index or worktree can be changed.
		await this.git(['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', remote.canonicalUrl, baseOid], github);
		await this.git(['cat-file', '-e', `${baseOid}^{commit}`]);
		const bytes = await this.git(['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', baseOid, headOid, '--'], undefined, undefined, AGENT_SESSION_PUBLICATION_DIFF_MAX_BYTES);
		const names = await this.git(['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', baseOid, headOid, '--'], undefined, undefined, 1024 * 1024);
		let text: string; let fields: string[];
		try { text = decoder.decode(bytes); fields = decoder.decode(names).split('\0'); } catch { throw new PublicationFailure('invalidObservation'); }
		if (text.includes('\0') || fields.pop() !== '') { throw new PublicationFailure('invalidObservation'); }
		const paths: AgentSessionPublicationDiffPath[] = [];
		for (let index = 0; index < fields.length; index += 2) {
			const status = fields[index]; const path = fields[index + 1];
			if (!path || !['A', 'M', 'D', 'T'].includes(status) || path.startsWith('/') || path.split('/').includes('..') || paths.length >= 300) { throw new PublicationFailure('invalidObservation'); }
			paths.push({ path, status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified', previousPath: null,
				explanationReferences: [], checkReferences: [], unknowns: ['No file-specific explanation or verification evidence was supplied for this publication.'] });
		}
		return { baseCommit: baseOid, headCommit: headOid, text, fingerprint: createHash('sha256').update(bytes).digest('hex'), paths };
	}

	async pushAbsentBranch(proposal: AgentSessionPublicationProposalDTO, github: PublicationGithubSession): Promise<void> {
		if (proposal.publicationRef !== `refs/heads/bugfixer/pr/${proposal.id}` || proposal.expectedOldRemoteOid !== null) { throw new PublicationFailure('invalidObservation'); }
		await verifyPublicationExecutable({ path: join(this.directory, 'hooks', 'pre-push'), sha256: this.binaries.prePushGuard.sha256 });
		await this.git(['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', proposal.remote.canonicalUrl, `${proposal.resultCommit}:${proposal.publicationRef}`], github, undefined, 65536, {
			BUGFIXER_PR_LOCAL_REF: proposal.resultCommit, BUGFIXER_PR_HEAD: proposal.resultCommit,
			BUGFIXER_PR_REMOTE_REF: proposal.publicationRef, BUGFIXER_PR_DESTINATION: proposal.remote.canonicalUrl,
		});
	}

	async dispose(): Promise<void> { await rm(this.directory, { recursive: true, force: true }); }

	private async install(executable: PublicationExecutable, destination: string): Promise<void> {
		await verifyPublicationExecutable(executable);
		await copyFile(executable.path, destination, constants.COPYFILE_EXCL); await chmod(destination, 0o700);
		await verifyPublicationExecutable({ path: destination, sha256: executable.sha256 });
	}

	private async git(args: readonly string[], github?: PublicationGithubSession, input?: Buffer, maxOutputBytes?: number, additional?: Record<string, string>): Promise<Buffer> {
		await verifyPublicationExecutable({ path: join(this.directory, 'exec', 'git-remote-https'), sha256: this.binaries.httpsTransport.sha256 });
		const env = { ...publicationEnvironment(join(this.directory, 'home')), ...(github?.gitAuthenticationEnvironment() ?? {}), ...additional };
		return runPublicationProcess({ executable: this.binaries.git, cwd: this.directory, input, maxOutputBytes, timeoutMs: 60_000, env,
			args: [`--exec-path=${join(this.directory, 'exec')}`, ...(args[0] === 'init' ? [] : [`--git-dir=${join(this.directory, 'repo')}`]),
				'-c', `core.hooksPath=${join(this.directory, 'hooks')}`, '-c', 'credential.helper=', '-c', 'credential.interactive=false',
				'-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
				'-c', 'fetch.recurseSubmodules=false', '-c', 'submodule.recurse=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
				'-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', '-c', 'core.attributesFile=/dev/null', ...args] });
	}
}
