/* CI-only real Git/native guard contract. Does not contact GitHub or prove account authentication. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const source = join(dirname(fileURLToPath(import.meta.url)), 'pr-ref-guard.c');

const ref = 'refs/heads/bugfixer/pr/019a0000-0000-7000-8000-000000000001';

const secondRef = 'refs/heads/bugfixer/pr/019a0000-0000-7000-8000-000000000002';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

for (const format of ['sha1', 'sha256']) {
	test(`native pre-push absence guard and server CAS (${format})`, t => {
		const root = mkdtempSync(join(tmpdir(), 'pr-ref-guard-ci-'));

		try {
			const environment = {
				PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'CI',
				GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'CI', GIT_COMMITTER_EMAIL: 'ci@example.invalid',
			};

			const run = (exe, args, options = {}) => spawnSync(exe, args, { cwd: root, env: environment, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, ...options });

			const ok = result => {
				assert.equal(result.error, undefined);
				assert.equal(result.status, 0, result.stderr);

				return result.stdout.trim();
			};

			const git = (...args) => run('/usr/bin/git', args);

			const guard = join(root, 'guard');
			ok(run('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', guard]));

			const repo = join(root, 'source');
			const remote = join(root, 'remote.git');
			const hooks = join(root, 'hooks');
			mkdirSync(hooks);

			const initialized = git('init', `--object-format=${format}`, repo);

			if (format === 'sha256' && initialized.status !== 0 && /unknown option|unknown hash algorithm|unsupported/i.test(initialized.stderr)) {
				t.skip('Installed Git lacks SHA-256 repositories');

				return;
			}

			ok(initialized);
			ok(git('init', '--bare', `--object-format=${format}`, remote));

			writeFileSync(join(repo, 'tracked.txt'), 'first\n');
			ok(git('-C', repo, 'add', 'tracked.txt'));
			ok(git('-C', repo, 'commit', '-m', 'base'));

			const base = ok(git('-C', repo, 'rev-parse', 'HEAD'));

			writeFileSync(join(repo, 'tracked.txt'), 'second\n');
			ok(git('-C', repo, 'commit', '-am', 'head'));

			const head = ok(git('-C', repo, 'rev-parse', 'HEAD'));

			ok(git('-C', repo, 'push', remote, `${base}:refs/heads/seed`));

			writeFileSync(join(repo, 'tracked.txt'), 'unstaged user edit\n');
			writeFileSync(join(repo, 'untracked.txt'), 'untracked user file\n');

			const snapshot = () => JSON.stringify({
				head: ok(git('-C', repo, 'rev-parse', 'HEAD')),
				branch: ok(git('-C', repo, 'symbolic-ref', 'HEAD')),
				index: hash(readFileSync(join(repo, '.git', 'index'))),
				file: readFileSync(join(repo, 'tracked.txt'), 'utf8'),
				untracked: readFileSync(join(repo, 'untracked.txt'), 'utf8'),
				status: ok(git('-C', repo, 'status', '--porcelain=v1', '-z')),
			});

			const before = snapshot();

			writeFileSync(join(hooks, 'pre-push'), readFileSync(guard));
			chmodSync(join(hooks, 'pre-push'), 0o700);

			const env = { ...environment, BUGFIXER_PR_LOCAL_REF: head, BUGFIXER_PR_HEAD: head, BUGFIXER_PR_REMOTE_REF: ref, BUGFIXER_PR_DESTINATION: remote };
			const push = (...specs) => run('/usr/bin/git', ['-C', repo, '-c', `core.hooksPath=${hooks}`, 'push', '--porcelain', remote, ...specs], { env });

			const zero = '0'.repeat(head.length);

			ok(run(guard, [remote, remote], { env, input: `${head} ${head} ${ref} ${zero}\n` }));

			for (const input of ['', `${head} ${head} ${ref} ${base}\n`, `${head} ${head} ${ref} ${zero}\n${head} ${head} ${secondRef} ${zero}\n`, `${head} ${head} ${ref} ${zero}\nextra`, `${head} ${head} ${ref} ${zero}\0\n`, 'x'.repeat(8192)]) {
				assert.notEqual(run(guard, [remote, remote], { env, input }).status, 0, 'malformed/changed/multiple tuple must fail');
			}

			assert.notEqual(run(guard, [remote, '/another-remote'], { env, input: `${head} ${head} ${ref} ${zero}\n` }).status, 0);
			assert.notEqual(push(`${head}:${ref}`, `${head}:${secondRef}`).status, 0);
			assert.notEqual(git('--git-dir', remote, 'rev-parse', '--verify', ref).status, 0);
			// Pre-existing fast-forwardable ref is still forbidden, even though ordinary push would accept it.
			ok(git('--git-dir', remote, 'update-ref', ref, base));
			assert.notEqual(push(`${head}:${ref}`).status, 0);
			assert.equal(ok(git('--git-dir', remote, 'rev-parse', ref)), base);
			ok(git('--git-dir', remote, 'update-ref', '-d', ref));
			// The server creates a competing ref AFTER the client guard saw old=zero; receive-pack CAS must reject.
			const serverHook = join(remote, 'hooks', 'pre-receive');
			writeFileSync(serverHook, `#!/bin/sh\nunset GIT_QUARANTINE_PATH\n/usr/bin/git --git-dir='${remote}' update-ref '${ref}' '${base}'\n`, { mode: 0o700 });

			assert.notEqual(push(`${head}:${ref}`).status, 0);
			assert.equal(ok(git('--git-dir', remote, 'rev-parse', ref)), base);
			rmSync(serverHook);
			ok(git('--git-dir', remote, 'update-ref', '-d', ref));
			// A malicious source hook must never run when the app's private hook directory is selected.
			const marker = join(root, 'malicious-hook-ran');
			writeFileSync(join(repo, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });

			ok(push(`${head}:${ref}`));
			assert.equal(ok(git('--git-dir', remote, 'rev-parse', ref)), head);
			assert.equal(existsSync(marker), false);
			assert.notEqual(push(`${head}:${ref}`).status, 0, 'even an already identical remote head must not satisfy an absent-ref approval');
			assert.equal(snapshot(), before, 'source HEAD/branch/index/worktree/untracked content are unchanged');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
