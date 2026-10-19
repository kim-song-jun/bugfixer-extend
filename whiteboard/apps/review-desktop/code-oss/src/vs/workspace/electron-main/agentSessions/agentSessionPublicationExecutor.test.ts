/* CI-only: actual SQLite + Git/native guard, controlled HTTP/CLI. Not real GitHub account proof. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { PublicationGithubSession, type PublicationHttpTransport } from './agentPublicationGithub.js';
import { PublicationGitContext } from './agentPublicationGit.js';
import { PublicationFailure, type PublicationExecutable } from './agentPublicationProcess.js';
import { AgentSessionPublicationExecutor, type PublicationHostAuthority } from './agentSessionPublicationExecutor.js';
import { createMergedPublicationFixture } from './agentSessionPublicationFixture.testHelpers.js';
import type { AgentSessionPublicationStore } from './agentSessionPublicationStore.js';

for (const scenario of ['lostResponse', 'accountChanged', 'staleApproval', 'baseRace', 'lateRecovery', 'foreignPr', 'differentBasePr', 'laggingBranch',
	'baseDuringLookup', 'accountDuringLookup', 'approvalDuringLookup', 'sourceDuringLookup', 'repositoryDuringLookup', 'approvalDuringBranchLookup'] as const) {
	test(`publication executor ${scenario}: durable intent, exact remote receipts, no duplicate writes`, async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'publication-executor-ci-')));
		let fixture: ReturnType<typeof createMergedPublicationFixture> | undefined; let sourceDb: WorkspaceDatabase | undefined; let publicationDb: DatabaseSync | undefined;
		const environment = { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'CI', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'CI', GIT_COMMITTER_EMAIL: 'ci@example.invalid' };
		const run = (executable: string, args: readonly string[], input?: Buffer) => spawnSync(executable, [...args], { cwd: root, env: environment, input, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
		const ok = (result: ReturnType<typeof run>) => { assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr.toString()); return result.stdout; };
		const git = (...args: string[]) => run('/usr/bin/git', args);
		let posts = 0; let userId = 11; let repositoryId = 91; let stale = false; let sourceChanged = false; let invisible = false;
		let lookupChanged = false; let laggedBranchReads = 0; let storedPr: Record<string, unknown> | undefined;
		let store: AgentSessionPublicationStore; let head = ''; let base = ''; let remote = ''; let publicationRef = '';
		const server = createServer((req, res) => {
			assert.equal(req.headers.authorization, 'Bearer ghp_PROTOCOL_FIXTURE_SECRET_1234567890');
			const url = new URL(req.url!, 'http://fixture.invalid'); res.setHeader('Content-Type', 'application/json');
			if (url.pathname === '/user') { res.end(JSON.stringify({ id: userId, login: 'reviewer' })); return; }
			if (url.pathname === '/repos/acme/widget') { res.end(JSON.stringify({ id: repositoryId, owner: { login: 'acme' }, name: 'widget', html_url: 'https://github.com/acme/widget', permissions: { push: true }, visibility: 'private', archived: false, disabled: false })); return; }
			if (url.pathname.startsWith('/repos/acme/widget/git/ref/heads/')) {
				const ref = `refs/heads/${decodeURIComponent(url.pathname.slice('/repos/acme/widget/git/ref/heads/'.length))}`;
				const found = git('--git-dir', remote, 'rev-parse', '--verify', ref);
				if (found.status !== 0) {
					if (scenario === 'approvalDuringBranchLookup' && ref === publicationRef) { stale = true; }
					res.writeHead(404); res.end('{}'); return;
				}
				if (scenario === 'laggingBranch' && ref === publicationRef && laggedBranchReads < 3) {
					laggedBranchReads++; res.writeHead(404); res.end('{}'); return;
				}
				res.end(JSON.stringify({ ref, object: { type: 'commit', sha: found.stdout.toString().trim() } })); return;
			}
			if (url.pathname === '/repos/acme/widget/pulls' && req.method === 'GET') {
				if (!lookupChanged) {
					lookupChanged = true;
					if (scenario === 'baseDuringLookup') { ok(git('--git-dir', remote, 'update-ref', 'refs/heads/main', head)); }
					if (scenario === 'accountDuringLookup') { userId = 22; }
					if (scenario === 'approvalDuringLookup') { stale = true; }
					if (scenario === 'sourceDuringLookup') { sourceChanged = true; }
					if (scenario === 'repositoryDuringLookup') { repositoryId = 92; }
					if (scenario === 'differentBasePr') {
						storedPr = { number: 17, html_url: 'https://github.com/acme/widget/pull/17', state: 'open', user: { id: 11 },
							head: { ref: publicationRef.slice(11), sha: head, repo: { id: 91 } }, base: { ref: 'other-base', sha: base, repo: { id: 91 } },
							title: 'Exact reviewed change', body: 'Exact reviewed draft body', draft: true };
					}
				}
				// Model GitHub's filters: the old base filter hid this same-head different-base PR.
				const matchesBase = !url.searchParams.has('base') || (storedPr?.base as { ref: string } | undefined)?.ref === url.searchParams.get('base');
				res.end(JSON.stringify(storedPr && !invisible && matchesBase ? [storedPr] : [])); return;
			}
			if (url.pathname === '/repos/acme/widget/pulls' && req.method === 'POST') {
				posts++;
				// The HTTP server sees the real SQLite intent committed before receiving this write.
				const row = publicationDb!.prepare('SELECT id FROM agent_session_publication_operations').get() as { id: string };
				assert.equal(store.readOperation(row.id).events.at(-1)?.event.type, 'pullRequestWriteStarted');
				let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; }); req.on('end', () => {
					const value = JSON.parse(body) as { head: string; base: string; title: string; body: string; draft: boolean };
					assert.equal(value.head, publicationRef.slice(11)); assert.equal(value.base, 'main'); assert.equal(value.draft, true);
					if (scenario === 'baseRace') { ok(git('--git-dir', remote, 'update-ref', 'refs/heads/main', head)); }
					storedPr = { number: 17, html_url: 'https://github.com/acme/widget/pull/17', state: 'open', user: { id: scenario === 'foreignPr' ? 99 : 11 },
						head: { ref: value.head, sha: head, repo: { id: 91 } }, base: { ref: value.base, sha: scenario === 'baseRace' ? head : base, repo: { id: 91 } },
						title: value.title, body: value.body, draft: value.draft };
					if (scenario === 'lostResponse' || scenario === 'lateRecovery') { invisible = scenario === 'lateRecovery'; req.socket.destroy(); return; }
					res.writeHead(201); res.end(JSON.stringify(storedPr));
				}); return;
			}
			res.writeHead(404); res.end('{}');
		});
		try {
			const source = join(root, 'source'); remote = join(root, 'remote.git'); const privateRoot = join(root, 'private'); const profile = join(root, 'profile');
			mkdirSync(privateRoot, { mode: 0o700 }); mkdirSync(profile, { mode: 0o700 });
			ok(git('init', source)); ok(git('init', '--bare', remote)); writeFileSync(join(source, 'file.txt'), 'before\n'); ok(git('-C', source, 'add', 'file.txt')); ok(git('-C', source, 'commit', '-m', 'base'));
			base = ok(git('-C', source, 'rev-parse', 'HEAD')).toString().trim();
			writeFileSync(join(source, 'file.txt'), 'after\n'); writeFileSync(join(source, 'binary.bin'), Buffer.from([0, 1, 2, 255])); ok(git('-C', source, 'add', 'file.txt', 'binary.bin')); ok(git('-C', source, 'commit', '-m', 'result'));
			head = ok(git('-C', source, 'rev-parse', 'HEAD')).toString().trim(); ok(git('-C', source, 'push', remote, `${base}:refs/heads/main`));
			const pack = ok(run('/usr/bin/git', ['-C', source, 'pack-objects', '--revs', '--stdout'], Buffer.from(`${head}\n`)));
			writeFileSync(join(source, 'file.txt'), 'uncommitted user edit\n'); writeFileSync(join(source, 'untracked.txt'), 'preserve\n');
			const snapshot = () => JSON.stringify({ head: ok(git('-C', source, 'rev-parse', 'HEAD')).toString(), index: digest(readFileSync(join(source, '.git', 'index'))),
				file: readFileSync(join(source, 'file.txt'), 'utf8'), untracked: readFileSync(join(source, 'untracked.txt'), 'utf8'), refs: ok(git('-C', source, 'show-ref')).toString() });
			const before = snapshot();
			const guard = join(root, 'guard'); ok(run('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', process.env['BUGFIXER_PR_GUARD_SOURCE'] ?? fileURLToPath(new URL('../../../../../../native/pr-ref-guard/pr-ref-guard.c', import.meta.url)), '-o', guard]));
			// Trusted fixture remote-helper protocol routes the canonical URL to a disposable bare repo.
			// The production implementation still runs its real Git, private config, pack/diff and native hook.
			const transportHelper = join(root, 'git-remote-https-fixture'); const pushLog = join(root, 'push-attempts'); writeFileSync(pushLog, '');
			const intentCheck = join(root, 'verify-branch-intent.cjs'); const intentProof = join(root, 'branch-intent-proof'); writeFileSync(intentProof, '');
			writeFileSync(transportHelper, `#!/bin/sh\nwhile IFS= read -r line; do\ncase "$line" in\ncapabilities) printf 'connect\\n\\n';;\n'connect git-upload-pack') printf '\\n'; exec /usr/bin/git-upload-pack '${remote}';;\n'connect git-receive-pack') ${shellQuote(process.execPath)} ${shellQuote(intentCheck)} || exit 94; printf 'push\\n' >> '${pushLog}'; printf '\\n'; exec /usr/bin/git-receive-pack '${remote}';;\n'') exit 0;;\n*) exit 93;;\nesac\ndone\n`, { mode: 0o700 });
			const pushCount = () => readFileSync(pushLog, 'utf8').split('\n').filter(Boolean).length;
			const gh = join(root, 'gh-fixture'); writeFileSync(gh, "#!/bin/sh\n[ \"$1 $2 $3 $4 $5 $6\" = 'auth token --hostname github.com --user reviewer' ] || exit 91\nprintf '%s\\n' 'ghp_PROTOCOL_FIXTURE_SECRET_1234567890'\n", { mode: 0o700 });
			fixture = createMergedPublicationFixture({ baseOid: base, resultOid: head });
			sourceDb = WorkspaceDatabase.open(fixture.sourcePath); publicationDb = new DatabaseSync(fixture.sourcePath, { readOnly: true });
			store = sourceDb.agentSessionPublications;
			let leased = false;
			const authority: PublicationHostAuthority = {
				exportSource: async () => ({ source: sourceChanged ? { ...fixture!.input.sourceMerge, resultCommit: base } : fixture!.input.sourceMerge,
					remote: { name: 'origin', canonicalUrl: 'https://github.com/acme/widget.git' }, pack: Buffer.from(pack) }),
				resolveSelectedAccount: async () => ({ accountRef: fixture!.input.accountRef, login: 'reviewer', configDirectory: profile }),
				assertCurrentApproval: async proposal => { if (stale || !store.getProposal(proposal.id)?.approval) { throw new PublicationFailure('invalidObservation'); } },
				acquireOperation: async () => { assert.equal(leased, false); leased = true; return { release: async () => { leased = false; } }; },
			};
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
			const transport = ((options: RequestOptions, callback?: (response: IncomingMessage) => void) => httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: address.port }, callback)) as PublicationHttpTransport;
			const executor = new AgentSessionPublicationExecutor(store, authority, { privateRoot, gh: descriptor(gh), git: { git: descriptor(realpathSync('/usr/bin/git')), httpsTransport: descriptor(transportHelper), prePushGuard: descriptor(guard) } },
				{ createGit: PublicationGitContext.create, openGithub: (binary, account, home) => PublicationGithubSession.open(binary, account, home, transport) });
			const proposal = await executor.prepare({ projectId: fixture.input.projectId, sessionId: fixture.input.sessionId, turnId: fixture.input.turnId,
				sourceMergeId: fixture.input.sourceMergeId, remoteName: 'origin', accountRef: fixture.input.accountRef, baseRef: 'refs/heads/main', title: 'Exact reviewed change', body: 'Exact reviewed draft body', expectedRevision: 0 });
			publicationRef = proposal.publicationRef; assert.match(proposal.diff.text, /GIT binary patch/); assert.equal(proposal.remote.repositoryId, '91');
			// A separate process opens the actual database read-only before git-receive-pack starts.
			// Missing/uncommitted/wrong intent aborts the real transport, rather than merely checking a mock.
			writeFileSync(intentCheck, `const assert = require('node:assert/strict');\nconst { DatabaseSync } = require('node:sqlite');\nconst { appendFileSync } = require('node:fs');\nconst expected = ${JSON.stringify({ databasePath: fixture.sourcePath, proposalId: proposal.id, fingerprint: proposal.fingerprint, ref: publicationRef, head, proofPath: intentProof })};\nconst db = new DatabaseSync(expected.databasePath, { readOnly: true });\ntry {\nconst operation = db.prepare('SELECT * FROM agent_session_publication_operations WHERE proposal_id = ?').get(expected.proposalId);\nassert.ok(operation);\nassert.equal(operation.proposal_fingerprint, expected.fingerprint);\nassert.equal(operation.publication_ref, expected.ref);\nassert.equal(operation.head_oid, expected.head);\nassert.equal(operation.expected_old_remote_oid, null);\nassert.equal(operation.account_stable_id, '11');\nassert.equal(operation.repository_id, '91');\nassert.equal(operation.state, 'started');\nassert.equal(operation.revision, 1);\nconst event = db.prepare('SELECT event_type, event_json FROM agent_session_publication_events WHERE operation_id = ? AND revision = 1').get(operation.id);\nassert.ok(event);\nassert.equal(event.event_type, 'branchWriteStarted');\nassert.deepEqual(JSON.parse(event.event_json), { type: 'branchWriteStarted', expectedOldRemoteOid: null });\nconst approval = db.prepare('SELECT proposal_fingerprint FROM agent_session_publication_approvals WHERE proposal_id = ?').get(expected.proposalId);\nassert.equal(approval.proposal_fingerprint, expected.fingerprint);\nappendFileSync(expected.proofPath, operation.id + '\\n');\n} finally { db.close(); }\n`);
			store.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint);
			if (scenario === 'accountChanged' || scenario === 'staleApproval' || scenario === 'approvalDuringBranchLookup') {
				userId = scenario === 'accountChanged' ? 22 : 11; stale = scenario === 'staleApproval';
				await assert.rejects(executor.publishApproved(proposal.id, proposal.fingerprint), scenario === 'accountChanged' ? /accountChanged/ : /invalidObservation/);
				assert.equal(posts, 0); assert.equal(pushCount(), 0); assert.notEqual(git('--git-dir', remote, 'rev-parse', '--verify', publicationRef).status, 0);
			} else if (scenario === 'baseDuringLookup' || scenario === 'accountDuringLookup' || scenario === 'approvalDuringLookup' || scenario === 'sourceDuringLookup' || scenario === 'repositoryDuringLookup') {
				const error = scenario === 'baseDuringLookup' ? /baseChanged/ : scenario === 'accountDuringLookup' ? /accountChanged/ : scenario === 'repositoryDuringLookup' ? /remoteChanged/ : /invalidObservation/;
				await assert.rejects(executor.publishApproved(proposal.id, proposal.fingerprint), error);
				assert.equal(lookupChanged, true); assert.equal(posts, 0); assert.equal(pushCount(), 1);
				assert.equal(ok(git('--git-dir', remote, 'rev-parse', publicationRef)).toString().trim(), head, 'retain the already-created branch');
			} else if (scenario === 'laggingBranch') {
				let operation = await executor.publishApproved(proposal.id, proposal.fingerprint);
				assert.equal(laggedBranchReads, 1); assert.equal(operation.state, 'recoveryRequired'); assert.equal(posts, 0); assert.equal(pushCount(), 1);
				assert.equal(ok(git('--git-dir', remote, 'rev-parse', publicationRef)).toString().trim(), head, 'the real Git push succeeded despite lagging HTTP 404s');
				for (let expectedReads = 2; expectedReads <= 3; expectedReads++) {
					operation = await executor.reconcile(proposal.id, proposal.fingerprint, operation.id);
					assert.equal(laggedBranchReads, expectedReads); assert.equal(operation.state, 'recoveryRequired'); assert.equal(posts, 0); assert.equal(pushCount(), 1);
					const uncertain = [...operation.events].reverse().find(record => record.event.type === 'branchReobserved')?.event;
					assert.ok(uncertain?.type === 'branchReobserved'); assert.equal(uncertain.outcome, 'unknown'); assert.equal(uncertain.errorCode, 'networkUncertain');
					assert.equal(operation.events.some(record => record.event.type === 'notPublished'), false);
				}
				operation = await executor.reconcile(proposal.id, proposal.fingerprint, operation.id);
				const branch = operation.events.at(-1)?.event;
				assert.ok(branch?.type === 'branchReobserved'); assert.equal(branch.outcome, 'created'); assert.equal(branch.oid, head);
				assert.equal(operation.state, 'recoveryRequired'); assert.equal(posts, 0); assert.equal(pushCount(), 1, 'read-only reconciliation does not resend a push');
			} else if (scenario === 'differentBasePr') {
				const operation = await executor.publishApproved(proposal.id, proposal.fingerprint);
				assert.equal(operation.state, 'recoveryRequired'); assert.equal(posts, 0); assert.equal(pushCount(), 1);
				const observed = operation.events.find(record => record.event.type === 'pullRequestObserved')?.event;
				assert.ok(observed?.type === 'pullRequestObserved'); assert.equal(observed.id, '17'); assert.equal(observed.baseRef, 'refs/heads/other-base'); assert.equal(observed.outcome, 'mismatch');
			} else {
				let operation = await executor.publishApproved(proposal.id, proposal.fingerprint);
				assert.equal(posts, 1); assert.equal(ok(git('--git-dir', remote, 'rev-parse', publicationRef)).toString().trim(), head);
				if (scenario === 'lateRecovery') { assert.equal(operation.state, 'recoveryRequired'); invisible = false; operation = await executor.reconcile(proposal.id, proposal.fingerprint, operation.id); assert.equal(operation.state, 'published'); }
				else { assert.equal(operation.state, scenario === 'baseRace' || scenario === 'foreignPr' ? 'recoveryRequired' : 'published'); }
				const observed = [...operation.events].reverse().find(record => record.event.type === 'pullRequestObserved' || record.event.type === 'pullRequestReobserved')?.event;
				assert.ok(observed && 'id' in observed); assert.equal(observed.id, '17');
				await executor.publishApproved(proposal.id, proposal.fingerprint); assert.equal(posts, 1, 'repeat/recovery must never duplicate the POST'); assert.equal(pushCount(), 1);
				assert.equal(JSON.stringify(operation).includes('ghp_PROTOCOL_FIXTURE'), false);
			}
			assert.equal(readFileSync(intentProof, 'utf8').split('\n').filter(Boolean).length, pushCount(), 'every actual receive-pack was preceded by its independently read durable branch intent');
			assert.equal(snapshot(), before); assert.deepEqual(readdirSync(privateRoot), []); assert.equal(leased, false);
		} finally { await new Promise<void>(resolve => server.close(() => resolve())); publicationDb?.close(); sourceDb?.close(); fixture?.dispose(); rmSync(root, { recursive: true, force: true }); }
	});
}

function digest(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function descriptor(path: string): PublicationExecutable { return { path, sha256: digest(readFileSync(path)) }; }
function shellQuote(value: string): string { return `'${value.replace(/'/gu, `'"'"'`)}'`; }
