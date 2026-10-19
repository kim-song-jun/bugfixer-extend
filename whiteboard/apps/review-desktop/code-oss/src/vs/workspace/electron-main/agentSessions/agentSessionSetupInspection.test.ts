/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectWorkspaceAgentSetup } from './agentSessionSetupInspection.js';

describe('workspace agent setup inspection', () => {
	it('checks Codex auth status with the selected profile in an empty cwd and never returns CLI output', async () => {
		const fixture = makeFixture('codex', { statusOutput: 'private-token-codex' });
		try {
			const dto = await inspectWorkspaceAgentSetup(fixture.input);
			const invocations = readInvocations(fixture.invocationFile);
			for (const invocation of invocations) {
				assert.notEqual(invocation.cwd, process.cwd(), 'No CLI inspection inherits the project working directory');
				assert.deepEqual(invocation.cwdEntries, [], 'Every inspection starts in a private empty working directory');
				if (invocation.args.includes('--help') || invocation.args.includes('--version')) { assert.notEqual(invocation.profile, fixture.profileDirectory, 'Help and version never load the real profile'); }
			}
			const status = invocations.find(invocation => invocation.args.join(' ') === 'login status');
			assert.ok(status);
			assert.equal(status.profile, fixture.profileDirectory);
			assert.notEqual(status.cwd, fixture.profileDirectory);
			assert.deepEqual(status.cwdEntries, []);
			assert.equal(dto.authentication.state, 'credentialPresent');
			assert.equal(dto.authentication.validForExecution, false);
			assert.equal(dto.installation.state, 'available');
			assert.equal(dto.capabilities?.provider, 'codex');
			assert.equal(JSON.stringify(dto).includes('private-token-codex'), false);
			assert.equal(JSON.stringify(dto).includes(fixture.profileDirectory), false);
		} finally {
			fixture.dispose();
		}
	});

	it('checks Claude auth status and maps its verified nonzero signed-out receipt', async () => {
		const fixture = makeFixture('claude', { statusCode: 1, statusOutput: 'private-token-claude' });
		try {
			const dto = await inspectWorkspaceAgentSetup(fixture.input);
			const invocations = readInvocations(fixture.invocationFile);
			const status = invocations.find(invocation => invocation.args.join(' ') === 'auth status');
			assert.ok(status);
			assert.equal(status.profile, fixture.profileDirectory);
			assert.notEqual(status.cwd, fixture.profileDirectory);
			assert.deepEqual(status.cwdEntries, []);
			assert.equal(dto.authentication.state, 'signedOut');
			assert.equal(dto.authentication.validForExecution, false);
			assert.equal(JSON.stringify(dto).includes('private-token-claude'), false);
		} finally {
			fixture.dispose();
		}
	});

	it('reports failed auth help as unavailable without inventing unsupported status', async () => {
		const fixture = makeFixture('codex', { authHelpCode: 2, statusOutput: 'private-help-token' });
		try {
			const dto = await inspectWorkspaceAgentSetup(fixture.input);
			assert.equal(dto.installation.state, 'unavailable');
			assert.equal(dto.authentication.state, 'unavailable');
			assert.equal(JSON.stringify(dto).includes('private-help-token'), false);
		} finally {
			fixture.dispose();
		}
	});

	it('reports a missing local profile as signed out without creating it', async () => {
		const fixture = makeFixture('codex', {});
		try {
			rmSync(fixture.profileDirectory, { recursive: true, force: true });
			const dto = await inspectWorkspaceAgentSetup(fixture.input);
			assert.equal(dto.authentication.state, 'signedOut');
			assert.equal(existsSync(fixture.profileDirectory), false);
			assert.equal(dto.capabilities?.provider, 'codex');
		} finally {
			fixture.dispose();
		}
	});

	it('reports a timed out auth inspection as unavailable only after its owned process is gone', async () => {
		const fixture = makeFixture('codex', { hangOnStatus: true });
		try {
			const dto = await inspectWorkspaceAgentSetup({ ...fixture.input, probeTimeoutMs: 2_000 });
			assert.equal(dto.installation.state, 'unavailable');
			assert.equal(dto.authentication.state, 'unavailable');
			assert.equal(dto.cleanupVerified, true);
			const status = readInvocations(fixture.invocationFile).find(invocation => invocation.args.join(' ') === 'login status');
			assert.ok(status && Number.isInteger(status.pid));
			assert.throws(() => process.kill(status.pid, 0), { code: 'ESRCH' });
		} finally {
			fixture.dispose();
		}
	});
});

interface Invocation {
	readonly pid: number;
	readonly args: string[];
	readonly cwd: string;
	readonly cwdEntries: string[];
	readonly profile: string | undefined;
}

function makeFixture(provider: 'codex' | 'claude', options: { statusCode?: number; authHelpCode?: number; statusOutput?: string; hangOnStatus?: boolean }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-agent-inspection-test-')));
	const profileDirectory = join(root, 'profile');
	mkdirSync(profileDirectory, { mode: 0o700 });
	const invocationFile = join(root, 'invocations.jsonl');
	const executable = join(root, provider);
	const profileKey = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
	const config = {
		provider,
		invocationFile,
		profileKey,
		statusCode: options.statusCode ?? 0,
		authHelpCode: options.authHelpCode ?? 0,
		statusOutput: options.statusOutput ?? '',
		hangOnStatus: options.hangOnStatus ?? false,
	};
	const script = `#!${process.execPath}\n` +
		`const fs=require('node:fs');const c=${JSON.stringify(config)};const a=process.argv.slice(2);` +
		`fs.appendFileSync(c.invocationFile,JSON.stringify({pid:process.pid,args:a,cwd:process.cwd(),cwdEntries:fs.readdirSync(process.cwd()),profile:process.env[c.profileKey]})+'\\n');` +
		`const out=(s)=>process.stdout.write(s);const err=(s)=>process.stderr.write(s);` +
		`if(a.length===1&&a[0]==='--version'){out('${provider} 1.2.3');process.exit(0);}` +
		(provider === 'codex'
			? `if(a.length===1&&a[0]==='--help'){out('--no-daemon --model --cd -C --sandbox --ask-for-approval --approve-for-me -c --config');process.exit(0);}` +
				`if(a.length===2&&a[0]==='resume'&&a[1]==='--help'){out('SESSION_ID');process.exit(0);}`
			: `if(a.length===1&&a[0]==='--help'){out('--resume --model --session-id --restricted --tools --permission-mode --mcp-config --strict-mcp-config');process.exit(0);}`) +
		`if(a.length===2&&((c.provider==='codex'&&a[0]==='login'&&a[1]==='--help')||(c.provider==='claude'&&a[0]==='auth'&&a[1]==='--help'))){out('status reports authentication');process.exit(c.authHelpCode);}` +
		`if(a.length===2&&a[1]==='status'&&((c.provider==='codex'&&a[0]==='login')||(c.provider==='claude'&&a[0]==='auth'))){` +
		`out(c.statusOutput);err(c.statusOutput);if(c.hangOnStatus){setInterval(()=>{},1000);}else{process.exit(c.statusCode);}}` +
		`out('unsupported');process.exit(2);`;
	writeFileSync(executable, script, { mode: 0o700 });
	chmodSync(executable, 0o700);
	return {
		invocationFile,
		profileDirectory,
		input: {
			projectId: 'inspection-test-project',
			provider,
			executable,
			profileDirectory,
			environment: {
				PATH: process.env.PATH ?? '',
				HOME: process.env.HOME ?? root,
				LANG: 'C.UTF-8',
				[profileKey]: profileDirectory,
			},
			guardianNodeExecutable: process.execPath,
			guardianScriptPath: fileURLToPath(new URL('./agentCliProbeGuardian.mjs', import.meta.url)),
		},
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

function readInvocations(path: string): Invocation[] {
	return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Invocation);
}
