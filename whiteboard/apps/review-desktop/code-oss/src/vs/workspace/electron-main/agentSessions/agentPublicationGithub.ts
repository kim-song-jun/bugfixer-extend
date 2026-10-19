/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { request } from 'node:https';
import { lstat, realpath, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentSessionPublicationAccount, AgentSessionPublicationRemote, AgentSessionPublicationProposalDTO, AgentSessionPublicationEvent } from '../../common/workspaceAgentPublicationProtocol.js';
import { createPublicationDirectory, PublicationFailure, publicationEnvironment, runPublicationProcess, type PublicationExecutable } from './agentPublicationProcess.js';

type JsonObject = Record<string, unknown>;
export type PublicationPrObservation = Extract<AgentSessionPublicationEvent, { type: 'pullRequestObserved' | 'pullRequestReobserved' }>;
export interface PublicationSelectedAccount {
	readonly accountRef: string;
	readonly login: string;
	/** Explicit host-selected existing gh profile. Never derived from a project or renderer path. */
	readonly configDirectory: string;
}
export interface PublicationBoundRemote { readonly name: string; readonly canonicalUrl: string }
/** Main-process transport injection is used by controlled protocol CI; production uses node:https. */
export type PublicationHttpTransport = typeof request;
export interface PublicationAccountChoice {
	readonly host: 'github.com';
	readonly login: string;
	readonly active: boolean;
	readonly state: 'success' | 'timeout' | 'error';
}

async function verifyProfile(configDirectory: string): Promise<void> {
	if (!isAbsolute(configDirectory)) { throw new PublicationFailure('accountChanged'); }
	const stat = await lstat(configDirectory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || await realpath(configDirectory) !== configDirectory) { throw new PublicationFailure('accountChanged'); }
}

/** Read-only discovery. Host constructs opaque accountRefs; renderer never receives a profile path. */
export async function discoverPublicationAccounts(gh: PublicationExecutable, configDirectory: string, privateRoot: string): Promise<readonly PublicationAccountChoice[]> {
	await verifyProfile(configDirectory);
	const directory = await createPublicationDirectory(privateRoot);
	try {
		const bytes = await runPublicationProcess({ executable: gh, args: ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], cwd: directory,
			env: { ...publicationEnvironment(directory), GH_CONFIG_DIR: configDirectory }, maxOutputBytes: 256 * 1024 });
		try {
			const json = object(JSON.parse(bytes.toString('utf8')) as unknown); const hosts = object(json.hosts); const entries = hosts['github.com'] ?? [];
			if (!Array.isArray(entries) || entries.length > 100) { throw new PublicationFailure('invalidObservation'); }
			const seen = new Set<string>();
			return entries.map((value): PublicationAccountChoice => {
				const entry = object(value); const login = string(entry.login); const state = string(entry.state);
				if (entry.host !== 'github.com' || !/^[A-Za-z0-9-]{1,39}$/u.test(login) || typeof entry.active !== 'boolean'
					|| !['success', 'timeout', 'error'].includes(state) || seen.has(login.toLowerCase())) { throw new PublicationFailure('invalidObservation'); }
				seen.add(login.toLowerCase());
				return { host: 'github.com', login, active: entry.active, state: state as PublicationAccountChoice['state'] };
			});
		} catch (error) { if (error instanceof PublicationFailure) { throw error; } throw new PublicationFailure('invalidObservation'); }
		finally { bytes.fill(0); }
	} finally { await rm(directory, { recursive: true, force: true }); }
}

function object(value: unknown): JsonObject {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new PublicationFailure('invalidObservation'); }
	return value as JsonObject;
}
function string(value: unknown): string {
	if (typeof value !== 'string') { throw new PublicationFailure('invalidObservation'); } return value;
}
function id(value: unknown): string {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) { throw new PublicationFailure('invalidObservation'); } return String(value);
}
function oid(value: unknown): string {
	const text = string(value); if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(text)) { throw new PublicationFailure('invalidObservation'); } return text;
}
export function publicationRepository(remote: PublicationBoundRemote): { owner: string; repository: string; path: string } {
	// This implementation supports github.com. Enterprise requires a separately trusted API-origin binding.
	const match = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\.git$/u.exec(remote.canonicalUrl);
	if (!match || match[2] === '.' || match[2] === '..' || !/^[A-Za-z0-9._-]{1,64}$/u.test(remote.name)) { throw new PublicationFailure('remoteChanged'); }
	return { owner: match[1], repository: match[2], path: `/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}` };
}

/** Token never leaves this main-process object, except a scoped in-memory Git child environment. */
export class PublicationGithubSession {
	private constructor(private readonly token: string, readonly account: AgentSessionPublicationAccount, private readonly transport: PublicationHttpTransport) { }

	static async open(gh: PublicationExecutable, selected: PublicationSelectedAccount, privateHome: string, transport: PublicationHttpTransport = request): Promise<PublicationGithubSession> {
		if (!/^[A-Za-z0-9-]{1,39}$/u.test(selected.login) || !selected.accountRef) { throw new PublicationFailure('accountChanged'); }
		await verifyProfile(selected.configDirectory);
		const bytes = await runPublicationProcess({ executable: gh, args: ['auth', 'token', '--hostname', 'github.com', '--user', selected.login], cwd: privateHome,
			env: { ...publicationEnvironment(privateHome), GH_CONFIG_DIR: selected.configDirectory }, maxOutputBytes: 4096 });
		const token = bytes.toString('utf8').trim(); bytes.fill(0);
		if (!/^[A-Za-z0-9_]{20,1024}$/u.test(token)) { throw new PublicationFailure('accountChanged'); }
		const initial = new PublicationGithubSession(token, { accountRef: selected.accountRef, login: selected.login, stableId: '', host: 'github.com' }, transport);
		const user = object(await initial.api('GET', '/user'));
		if (string(user.login).toLowerCase() !== selected.login.toLowerCase()) { throw new PublicationFailure('accountChanged'); }
		return new PublicationGithubSession(token, { accountRef: selected.accountRef, login: string(user.login), stableId: id(user.id), host: 'github.com' }, transport);
	}

	async resolveRemote(bound: PublicationBoundRemote): Promise<AgentSessionPublicationRemote> {
		const parsed = publicationRepository(bound); const result = object(await this.api('GET', parsed.path));
		const owner = string(object(result.owner).login); const repository = string(result.name);
		if (owner !== parsed.owner || repository !== parsed.repository || string(result.html_url) !== `https://github.com/${owner}/${repository}`
			|| object(result.permissions).push !== true || result.archived !== false || result.disabled !== false) { throw new PublicationFailure('permissionDenied'); }
		const visibility = string(result.visibility);
		if (!['public', 'private', 'internal'].includes(visibility)) { throw new PublicationFailure('invalidObservation'); }
		return { ...bound, host: 'github.com', repositoryId: id(result.id), owner, repository, visibility: visibility as AgentSessionPublicationRemote['visibility'], writable: true };
	}

	/** Recovery can still identify a repository after write permission has been revoked. */
	async assertRepositoryIdentity(remote: AgentSessionPublicationRemote): Promise<void> {
		const parsed = publicationRepository(remote); const result = object(await this.api('GET', parsed.path));
		if (id(result.id) !== remote.repositoryId || string(object(result.owner).login) !== remote.owner || string(result.name) !== remote.repository
			|| string(result.visibility) !== remote.visibility || string(result.html_url) !== `https://github.com/${remote.owner}/${remote.repository}`) { throw new PublicationFailure('remoteChanged'); }
	}

	async readBranch(remote: PublicationBoundRemote, ref: string): Promise<string | null> {
		if (!ref.startsWith('refs/heads/') || /[\0-\x20?*\[\\~^:]/u.test(ref)) { throw new PublicationFailure('invalidObservation'); }
		const response = await this.api('GET', `${publicationRepository(remote).path}/git/ref/heads/${ref.slice(11).split('/').map(encodeURIComponent).join('/')}`, undefined, true);
		if (response === null) { return null; }
		const result = object(response);
		if (result.ref !== ref || object(result.object).type !== 'commit') { throw new PublicationFailure('invalidObservation'); }
		return oid(object(result.object).sha);
	}

	/** All matching head refs are examined, including closed PRs; never duplicate a lost response. */
	async findPullRequest(proposal: AgentSessionPublicationProposalDTO): Promise<PublicationPrObservation | null> {
		// Base is deliberately not a search filter: an existing PR for this owned head with a
		// changed/different base must block creation, rather than disappear from the result set.
		const query = new URLSearchParams({ state: 'all', head: `${proposal.remote.owner}:${proposal.publicationRef.slice(11)}`, per_page: '100' });
		const values = await this.api('GET', `${publicationRepository(proposal.remote).path}/pulls?${query}`);
		if (!Array.isArray(values) || values.length >= 100) { throw new PublicationFailure('invalidObservation'); }
		if (!values.length) { return null; }
		const observations = values.map(value => this.parsePullRequest(proposal, value));
		const observation = observations.find(value => value.outcome === 'mismatch') ?? observations[0];
		return observations.length === 1 ? observation : { ...observation, outcome: 'mismatch', errorCode: 'invalidObservation' };
	}

	async createPullRequest(proposal: AgentSessionPublicationProposalDTO): Promise<PublicationPrObservation> {
		const result = await this.api('POST', `${publicationRepository(proposal.remote).path}/pulls`, {
			head: proposal.publicationRef.slice(11), base: proposal.baseRef.slice(11), title: proposal.title, body: proposal.body, draft: true, maintainer_can_modify: false,
		});
		return this.parsePullRequest(proposal, result);
	}

	/** Exact host-scoped header only; inherited credential helpers and redirects are disabled separately. */
	gitAuthenticationEnvironment(): Record<string, string> {
		return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
			GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.token}`, 'utf8').toString('base64')}` };
	}

	private parsePullRequest(proposal: AgentSessionPublicationProposalDTO, value: unknown): PublicationPrObservation {
		const pr = object(value); const head = object(pr.head); const base = object(pr.base);
		const repositoryId = id(object(base.repo).id); const headRepositoryId = id(object(head.repo).id);
		const number = id(pr.number); const url = string(pr.html_url);
		if (url !== `https://github.com/${proposal.remote.owner}/${proposal.remote.repository}/pull/${number}` || typeof pr.draft !== 'boolean') { throw new PublicationFailure('invalidObservation'); }
		const observation: PublicationPrObservation = {
			type: 'pullRequestObserved', id: number, url, repositoryId, headRef: `refs/heads/${string(head.ref)}`, headOid: oid(head.sha),
			baseRef: `refs/heads/${string(base.ref)}`, baseOid: oid(base.sha), title: string(pr.title), body: pr.body === null ? '' : string(pr.body), draft: pr.draft,
			outcome: 'created', errorCode: 'none',
		};
		const matches = repositoryId === proposal.remote.repositoryId && headRepositoryId === proposal.remote.repositoryId && id(object(pr.user).id) === proposal.account.stableId
			&& observation.headRef === proposal.publicationRef && observation.headOid === proposal.resultCommit && observation.baseRef === proposal.baseRef
			&& observation.title === proposal.title && observation.body === proposal.body && observation.draft === true && pr.state === 'open';
		return matches ? observation : { ...observation, outcome: 'mismatch', errorCode: 'invalidObservation' };
	}

	private api(method: 'GET' | 'POST', path: string, body?: unknown, allowNotFound = false): Promise<unknown> {
		if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/u.test(path)) { throw new PublicationFailure('invalidObservation'); }
		const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
		return new Promise((resolve, reject) => {
			let settled = false;
			const fail = (code: 'permissionDenied' | 'networkUncertain' | 'providerFailed' | 'invalidObservation') => { if (!settled) { settled = true; reject(new PublicationFailure(code)); } };
			const req = this.transport({ protocol: 'https:', hostname: 'api.github.com', port: 443, path, method, agent: false,
				headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Bugfixer-Extend',
					...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) } : {}) } }, res => {
				const status = res.statusCode ?? 0;
				if (status === 404 && allowNotFound) { res.resume(); settled = true; resolve(null); return; }
				if (status < 200 || status >= 300) { res.resume(); fail(status === 401 || status === 403 ? 'permissionDenied' : 'providerFailed'); return; }
				const chunks: Buffer[] = []; let size = 0;
				res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) { fail('invalidObservation'); req.destroy(); } else { chunks.push(chunk); } });
				res.on('error', () => fail('networkUncertain'));
				res.on('end', () => { if (settled) { return; } try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); settled = true; resolve(value); } catch { fail('invalidObservation'); } });
			});
			const deadline = setTimeout(() => { fail('networkUncertain'); req.destroy(); }, 30_000);
			req.on('error', () => fail('networkUncertain')); req.on('close', () => clearTimeout(deadline)); req.end(bytes);
		});
	}
}
