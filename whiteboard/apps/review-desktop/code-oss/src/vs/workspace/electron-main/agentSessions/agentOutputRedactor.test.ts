/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentPtyOutputSanitizer, sanitizeCompleteAgentText } from './agentOutputRedactor.js';

function drain(sanitizer: ReturnType<typeof createAgentPtyOutputSanitizer>, chunks: readonly string[]): string {
	return chunks.map(chunk => sanitizer.push(chunk)).join('') + sanitizer.flush();
}

test('masks a trusted secret split across stream chunks and repeated values', () => {
	const sanitizer = createAgentPtyOutputSanitizer({ knownSecrets: ['session-capability-123', 'session-capability-123'] });
	assert.equal(sanitizer.push('ready\nsession-cap'), 'ready\n');
	assert.equal(sanitizer.push('ability-123 and session-capability-123\n'), '*** and ***\n');
	assert.equal(sanitizer.flush(), '');
});

test('redacts the full trusted secret after a labelled credential, including at stream flush', () => {
	const input = 'access_token=fixture-secret visible-secret';
	const expected = 'access_token=*** ***';
	const options = { knownSecrets: ['visible-secret'] };
	assert.equal(sanitizeCompleteAgentText(input, options), expected);

	for (let split = 1; split < input.length; split++) {
		const sanitizer = createAgentPtyOutputSanitizer(options);
		const output = sanitizer.push(input.slice(0, split)) + sanitizer.push(input.slice(split)) + sanitizer.flush();
		assert.equal(output, expected, `unexpected output at split ${split}`);
	}
});

test('matches through SGR and Unicode chunk boundaries while preserving safe styling', () => {
	const sanitizer = createAgentPtyOutputSanitizer({ knownSecrets: ['秘密-token'] });
	const output = drain(sanitizer, ['\u001b[32m로그 😀 ', '秘密-', '\u001b[31mtoken\u001b[0m\n']);
	assert.equal(output, '\u001b[32m로그 😀 ***\u001b[0m\n');
});

test('redacts credentials whose characters are interrupted by cursor and erase controls', () => {
	const sanitizer = createAgentPtyOutputSanitizer({ knownSecrets: ['secret-value'] });
	assert.equal(drain(sanitizer, ['sec\u001b[2Kret-value\n']), '***\n');
});

test('preserves carriage return and backspace while excluding them from secret matching', () => {
	const sanitizer = createAgentPtyOutputSanitizer({ knownSecrets: ['secret-value'] });
	assert.equal(drain(sanitizer, ['progress 1\rprogress 2\b3\n', 'sec\rret-\bvalue\n']), 'progress 1\rprogress 2\b3\n***\n');
});

test('preserves interactive CSI navigation and hides secrets split across CSI controls', () => {
	const sanitizer = createAgentPtyOutputSanitizer({ knownSecrets: ['secret-value'] });
	const output = drain(sanitizer, [
		'\u001b[2J\u001b[Hprompt> \u001b[?25l',
		'secret-\u001b[2Kvalue\u001b[?25h\n'
	]);
	assert.equal(output, '\u001b[2J\u001b[Hprompt> \u001b[?25l***\u001b[?25h\n');
});

test('redacts credential patterns and private key account-file contents across boundaries', () => {
	const sanitizer = createAgentPtyOutputSanitizer();
	const output = drain(sanitizer, [
		'Authorization: Bearer ghp_12345678901234567890\npassword=',
		'open-sesame\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n'
	]);
	assert.equal(output, 'Authorization: ***\npassword=***\n***\n');
});

test('does not redact ordinary labels and still masks short labelled values', () => {
	const sanitizer = createAgentPtyOutputSanitizer();
	assert.equal(drain(sanitizer, ['monkey=banana\npassword=ok\napi_key=x\n']), 'monkey=banana\npassword=***\napi_key=***\n');
});

test('shows recognized credential prompts immediately, then masks later echoed values', () => {
	const password = createAgentPtyOutputSanitizer();
	assert.equal(password.push('Password: '), 'Password: ');
	assert.equal(password.push('typed-password'), '***');
	assert.equal(password.push('\n'), '\n');
	assert.equal(password.flush(), '');

	const key = createAgentPtyOutputSanitizer();
	assert.equal(key.push('api_key='), 'api_key=');
	assert.equal(key.push('compact'), '***');
	assert.equal(key.push('secret\n'), '\n');
	assert.equal(key.flush(), '');
});

test('preserves leading field whitespace while masking values across every split', () => {
	const cases = [
		['password=  secret-value\n', 'password=  ***\n'],
		['Password: secret-value\n', 'Password: ***\n'],
		['Password:  secret-value\n', 'Password:  ***\n'],
		['api_key=\t\t"quoted value"\n', 'api_key=\t\t***\n'],
		['api_key=  \t"quoted-value"\n', 'api_key=  \t***\n'],
	];
	for (const [input, expected] of cases) {
		assert.equal(drain(createAgentPtyOutputSanitizer(), [input]), expected, `unexpected output without splitting: ${input}`);
		for (let split = 1; split < input.length; split++) {
			const sanitizer = createAgentPtyOutputSanitizer();
			const output = sanitizer.push(input.slice(0, split)) + sanitizer.push(input.slice(split)) + sanitizer.flush();
			assert.equal(output, expected, `unexpected output at split ${split}: ${input}`);
		}
	}

	for (const [chunks, expected] of [
		[['password=', ' secret-value\n'], 'password= ***\n'],
		[['Password: ', ' secret-value\n'], 'Password:  ***\n'],
		[['api_key=', '  \t', '"quoted-value"\n'], 'api_key=  \t***\n'],
	] as const) {
		assert.equal(drain(createAgentPtyOutputSanitizer(), chunks), expected);
	}
});

test('bounds retained stream state during large output and flushes a final partial secret safely', () => {
	const sanitizer = createAgentPtyOutputSanitizer({ knownSecrets: ['final-secret'], maxPendingCodeUnits: 256 });
	const first = sanitizer.push(`${'x'.repeat(10000)}final-sec`);
	assert.ok(first.length > 9000);
	assert.equal(first.includes('final-sec'), false);
	assert.equal(sanitizer.push('ret'), '');
	assert.equal(sanitizer.flush(), '***');
});

test('raises the overlap for long trusted values so they cannot leak across chunks', () => {
	const secret = 's'.repeat(500);
	const sanitizer = createAgentPtyOutputSanitizer({ knownSecrets: [secret], maxPendingCodeUnits: 128 });
	assert.equal(sanitizer.push(`prefix ${secret.slice(0, 300)}`), 'prefix ');
	const completed = sanitizer.push(`${secret.slice(300)} suffix`);
	assert.equal(completed, '*** suffi');
	assert.equal(completed.includes(secret), false);
	assert.equal(sanitizer.flush(), 'x');
	assert.throws(() => createAgentPtyOutputSanitizer({ knownSecrets: ['x'.repeat(65536)] }), /exceeds/);
});

test('keeps labelled values, recognized token prefixes, and authorization values masked across every split', () => {
	const cases = [
		['password=abcDEF123\n', 'password=***\n'],
		['password="quoted-secret-value"\n', 'password=***\n'],
		["password='single-quoted-secret'\n", 'password=***\n'],
		['password=unquoted=value:with:delimiters\n', 'password=***\n'],
		['password="quoted=value:with:delimiters"\n', 'password=***\n'],
		['password="escaped \\" quote secret"\n', 'password=***\n'],
		['password=""\n', 'password=***\n'],
		["password=''\n", 'password=***\n'],
		['\u001b[32mpassword=\u001b[31m"styled-secret"\u001b[0m\n', '\u001b[32mpassword=\u001b[31m***\u001b[0m\n'],
		['Authorization: Bearer opaque-secret-value\n', 'Authorization: ***\n'],
		['Authorization: Bearer opaque:secret=value\n', 'Authorization: ***\n'],
		['ghp_12345SECRET67890\n', '***\n'],
		['gho_12345SECRET67890\n', '***\n'],
		['ghu_12345SECRET67890\n', '***\n'],
		['ghs_12345SECRET67890\n', '***\n'],
		['ghr_12345SECRET67890\n', '***\n'],
		['github_pat_12345SECRET67890\n', '***\n'],
		['sk-short-but-sensitive\n', '***\n'],
		['xoxb-short-secret-value\n', '***\n'],
		['AKIA1234567890ABCDEF\n', '***\n'],
		['eyJabcdefgh.abcdefgh.abcdefgh\n', '***\n'],
		['api_key = compactsecret\n', 'api_key = ***\n'],
		['access_token=compactsecret\n', 'access_token=***\n'],
		['refresh-token=compactsecret\n', 'refresh-token=***\n'],
		['auth_token=compactsecret\n', 'auth_token=***\n'],
		['client_secret=compactsecret\n', 'client_secret=***\n'],
		['passwd=compactsecret\n', 'passwd=***\n'],
		['secret=compactsecret\n', 'secret=***\n'],
		['credential=compactsecret\n', 'credential=***\n'],
		['-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----\n', '***\n'],
		['-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----', '***'],
	];
	for (const [input, expected] of cases) {
		for (let split = 1; split < input.length; split++) {
			const sanitizer = createAgentPtyOutputSanitizer({ maxPendingCodeUnits: 128 });
			const output = sanitizer.push(input.slice(0, split)) + sanitizer.push(input.slice(split)) + sanitizer.flush();
			assert.equal(output, expected, `unexpected output at split ${split}: ${input}`);
		}
	}
});

test('keeps split OSC and CSI sequences stateful while overflow credentials remain masked', () => {
	const password = createAgentPtyOutputSanitizer({ maxPendingCodeUnits: 128 });
	const passwordOutputs = [
		password.push(`password=${'s'.repeat(160)}`),
		password.push('\u001b]0; password=not-a-delimiter '),
		password.push('still-title\u0007more-password\n'),
		password.flush(),
	];
	assert.deepEqual(passwordOutputs, ['password=***', '', '\n', '']);
	assert.equal(passwordOutputs.join(''), 'password=***\n');

	const csi = createAgentPtyOutputSanitizer({ maxPendingCodeUnits: 128 });
	const csiOutput = csi.push(`password=${'s'.repeat(160)}`)
		+ csi.push('\u001b[0; 1')
		+ csi.push('mcontinued-secret\n')
		+ csi.flush();
	assert.equal(csiOutput, 'password=***\n');

	const pem = createAgentPtyOutputSanitizer({ maxPendingCodeUnits: 128 });
	const pemOutput = pem.push(`-----BEGIN PRIVATE KEY-----\n${'private-'.repeat(40)}`)
		+ pem.push('\u001b]0; -----END PRIVATE KEY----- ')
		+ pem.push('footer-is-title\u0007more-private-material')
		+ pem.push('-----END PRIVATE KEY-----\n')
		+ pem.flush();
	assert.equal(pemOutput, '***\n');
});

test('keeps an oversized labelled value masked after the in-memory limit is crossed', () => {
	const sanitizer = createAgentPtyOutputSanitizer({ maxPendingCodeUnits: 128 });
	const secret = 'account-credential-'.repeat(24);
	const output = sanitizer.push('password=') + sanitizer.push(secret.slice(0, 240)) + sanitizer.push(`${secret.slice(240)}\n`) + sanitizer.flush();
	assert.equal(output.includes(secret), false);
	assert.ok(output.includes('***'));
	assert.ok(output.endsWith('\n'));
});

test('keeps an oversized recognized token masked after the in-memory limit is crossed', () => {
	const sanitizer = createAgentPtyOutputSanitizer({ maxPendingCodeUnits: 128 });
	const token = `ghp_${'credential'.repeat(80)}`;
	const output = sanitizer.push(token.slice(0, 400)) + sanitizer.push(`${token.slice(400)}\n`) + sanitizer.flush();
	assert.equal(output.includes(token), false);
	assert.equal(output.includes('credential'), false);
	assert.ok(output.endsWith('\n'));
});

test('keeps escaped quoted delimiters masked across an overflow chunk boundary', () => {
	const sanitizer = createAgentPtyOutputSanitizer({ maxPendingCodeUnits: 128 });
	const output = sanitizer.push('password="')
		+ sanitizer.push(`${'sensitive-'.repeat(15)}\\`)
		+ sanitizer.push('"still-sensitive" outside\n')
		+ sanitizer.flush();
	assert.equal(output.includes('sensitive-'), false);
	assert.ok(output.includes('outside\n'));
});

test('masks PEM bodies larger than the pending limit through a footer split over multiple chunks', () => {
	const sanitizer = createAgentPtyOutputSanitizer({ maxPendingCodeUnits: 128 });
	const header = '-----BEGIN PRIVATE KEY-----\n';
	const body = 'private-account-material-'.repeat(80);
	const footer = '-----END PRIVATE KEY-----';
	const output = [header, body.slice(0, 900), body.slice(900), footer.slice(0, 8), footer.slice(8), '\n']
		.map(chunk => sanitizer.push(chunk)).join('') + sanitizer.flush();
	assert.equal(output.includes(body), false);
	assert.equal(output.includes(footer), false);
	assert.ok(output.includes('***'));
});

test('masks an unterminated PEM through flush without releasing its partial footer', () => {
	const sanitizer = createAgentPtyOutputSanitizer();
	assert.equal(sanitizer.push('-----BEGIN RSA PRIVATE KEY-----\nprivate-material\n-----END RSA PRIVATE KEY--'), '');
	assert.equal(sanitizer.flush(), '***');
});

test('rejects non-finite and fractional pending limits before clamping', () => {
	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 12.5]) {
		assert.throws(() => createAgentPtyOutputSanitizer({ maxPendingCodeUnits: value }), /finite integer/);
	}
});

test('handles regex metacharacters in trusted known secrets literally', () => {
	const sanitizer = createAgentPtyOutputSanitizer({ knownSecrets: ['a+b[1].token'] });
	assert.equal(drain(sanitizer, ['literal a+b[1].token; near miss aaab1.token']), 'literal ***; near miss aaab1.token');
});

test('rejects writes after final flush and keeps TTY text usable', () => {
	const sanitizer = createAgentPtyOutputSanitizer();
	assert.equal(sanitizer.push('prompt> '), 'prompt> ');
	assert.equal(sanitizer.push('type here\n'), 'type here\n');
	assert.equal(sanitizer.flush(), '');
	assert.equal(sanitizer.flush(), '');
	assert.throws(() => sanitizer.push('late'), /after sanitizer flush/);
});
