import net from 'node:net';

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 4096;
const IO_TIMEOUT_MS = 3000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail() {
	process.exitCode = 2;
}

function readInput() {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		const finish = (error, value) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			if (error) { reject(error); } else { resolve(value); }
		};
		const timer = setTimeout(() => {
			process.stdin.destroy();
			finish(new Error('timeout'));
		}, IO_TIMEOUT_MS);
		process.stdin.on('data', chunk => {
			if (settled) { return; }
			size += chunk.length;
			if (size > MAX_STDIN_BYTES) {
				process.stdin.destroy();
				finish(new Error('input-too-large'));
				return;
			}
			chunks.push(chunk);
		});
		process.stdin.once('end', () => finish(undefined, Buffer.concat(chunks, size)));
		process.stdin.once('error', error => finish(error));
	});
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sendIdentity(port, nonce, sessionId) {
	const frame = Buffer.from(`${JSON.stringify({ nonce, sessionId })}\n`, 'utf8');
	if (frame.byteLength > MAX_FRAME_BYTES) { throw new Error('frame-too-large'); }
	await new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: '127.0.0.1', port });
		let buffer = Buffer.alloc(0);
		let settled = false;
		const finish = error => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) { reject(error); } else { resolve(); }
		};
		const timer = setTimeout(() => finish(new Error('timeout')), IO_TIMEOUT_MS);
		socket.once('connect', () => socket.write(frame));
		socket.on('data', chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.byteLength > MAX_FRAME_BYTES) { finish(new Error('response-too-large')); return; }
			const newline = buffer.indexOf(0x0a);
			if (newline < 0) { return; }
			try {
				const response = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
				if (isRecord(response) && response.ok === true) { finish(); }
				else { finish(new Error('not-accepted')); }
			} catch (error) { finish(error); }
		});
		socket.once('error', error => finish(error));
		socket.once('close', () => { if (!settled) { finish(new Error('closed-before-ack')); } });
	});
}

async function main() {
	const inputBytes = await readInput();
	if (inputBytes.byteLength > MAX_STDIN_BYTES) { fail(); return; }
	let input;
	try { input = JSON.parse(inputBytes.toString('utf8')); }
	catch { fail(); return; }
	if (!isRecord(input)) { fail(); return; }
	if (input.hook_event_name !== 'UserPromptSubmit') { fail(); return; }
	let hasAgentContext = false;
	for (const field of ['agent_id', 'agent_type']) {
		if (Object.hasOwn(input, field) && input[field] !== null) {
			if (typeof input[field] !== 'string' || input[field].length === 0) { fail(); return; }
			hasAgentContext = true;
		}
	}
	if (typeof input.session_id !== 'string' || !UUID_PATTERN.test(input.session_id)) { fail(); return; }
	if (hasAgentContext) { return; }
	const portValue = process.env.BUGFIXER_PROVIDER_IDENTITY_PORT;
	const nonce = process.env.BUGFIXER_PROVIDER_IDENTITY_NONCE;
	if (typeof portValue !== 'string' || !/^[1-9][0-9]{0,4}$/.test(portValue) || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) { fail(); return; }
	const port = Number(portValue);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) { fail(); return; }
	await sendIdentity(port, nonce, input.session_id);
}

main().catch(error => {
	if (!(error instanceof Error)) { process.stderr.write('Provider identity hook failed.\n'); }
	else if (error.message === 'timeout' || error.message === 'input-too-large' || error.message === 'frame-too-large' || error.message === 'response-too-large' || error.message === 'not-accepted' || error.message === 'closed-before-ack') {
		process.stderr.write(`Provider identity hook failed: ${error.message}.\n`);
	} else {
		process.stderr.write('Provider identity hook could not reach its host receiver.\n');
	}
	fail();
});
