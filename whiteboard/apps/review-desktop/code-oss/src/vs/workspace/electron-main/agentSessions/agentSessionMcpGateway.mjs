/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { connect } from 'node:net';

const MAX_FRAME_BYTES = 65_536;
const MAX_IN_FLIGHT = 8;
const MAX_STDOUT_QUEUE_BYTES = 1_048_576;
const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const portArgument = process.argv[2];
const port = typeof portArgument === 'string' && /^[1-9][0-9]{0,4}$/.test(portArgument) ? Number(portArgument) : NaN;
const token = process.env.BUGFIXER_SESSION_MCP_TOKEN;
let activeSocket;

if (process.argv.length !== 3 || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || !token || token.length > 256) {
	process.stderr.write('Session MCP gateway launch configuration is invalid.\n');
	process.exitCode = 1;
} else {
	void run().catch(() => {
		process.stderr.write('Session MCP gateway could not connect to the trusted app bridge.\n');
		process.exitCode = 1;
	});
}

async function run() {
	const socket = connect({ host: '127.0.0.1', port });
	activeSocket = socket;
	socket.setNoDelay(true);
	let socketBuffer = Buffer.alloc(0);
	let authenticated = false;
	let nextId = 0;
	const pendingBridge = new Map();
	const pendingMcp = new Map();

	const socketReady = new Promise((resolve, reject) => {
		socket.once('connect', resolve);
		socket.once('error', reject);
	});
	await socketReady;
	socket.write(`${JSON.stringify({ type: 'auth', token })}\n`);
	await new Promise((resolve, reject) => {
		const onData = chunk => {
			socketBuffer = Buffer.concat([socketBuffer, chunk]);
			const newline = socketBuffer.indexOf(0x0a);
			if (newline < 0) { if (socketBuffer.length > MAX_FRAME_BYTES) { reject(new Error('Oversized bridge frame.')); } return; }
			const frame = parseBridgeFrame(socketBuffer.subarray(0, newline));
			socketBuffer = socketBuffer.subarray(newline + 1);
			socket.off('data', onData);
			if (frame?.type !== 'auth' || frame.ok !== true) { reject(new Error('Bridge authentication was denied.')); }
			else { authenticated = true; resolve(); }
		};
		socket.on('data', onData);
		socket.once('error', reject);
	});

	socket.on('data', chunk => {
		socketBuffer = Buffer.concat([socketBuffer, chunk]);
		if (socketBuffer.length > MAX_FRAME_BYTES && socketBuffer.indexOf(0x0a) < 0) { socket.destroy(); return; }
		let newline;
		while ((newline = socketBuffer.indexOf(0x0a)) >= 0) {
			const bytes = socketBuffer.subarray(0, newline);
			socketBuffer = socketBuffer.subarray(newline + 1);
			if (bytes.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
			const frame = parseBridgeFrame(bytes);
			if (!frame || frame.type !== 'response' || typeof frame.id !== 'string') { socket.destroy(); return; }
			const pending = pendingBridge.get(frame.id);
			if (!pending) { continue; }
			pendingBridge.delete(frame.id);
			pending.resolve(frame);
		}
	});
	socket.on('error', () => {
		for (const pending of pendingBridge.values()) { pending.reject(new Error('The trusted app bridge disconnected.')); }
		pendingBridge.clear();
	});
	socket.on('close', () => {
		for (const pending of pendingBridge.values()) { pending.reject(new Error('The trusted app bridge disconnected.')); }
		pendingBridge.clear();
	});

	let stdioBuffer = Buffer.alloc(0);
	const failInput = message => {
		writeJsonRpcError(null, -32700, message);
		process.stdin.destroy();
		socket.destroy();
	};
	process.stdin.on('data', chunk => {
		let offset = 0;
		while (offset < chunk.length && !stdoutFailed) {
			const newline = chunk.indexOf(0x0a, offset);
			if (newline < 0) {
				const remainder = chunk.length - offset;
				if (stdioBuffer.length + remainder > MAX_FRAME_BYTES) { failInput('Request frame exceeds the size limit.'); return; }
				stdioBuffer = stdioBuffer.length ? Buffer.concat([stdioBuffer, chunk.subarray(offset)]) : chunk.subarray(offset);
				return;
			}
			const frameLength = stdioBuffer.length + newline - offset;
			if (frameLength > MAX_FRAME_BYTES) { failInput('Request frame exceeds the size limit.'); return; }
			const bytes = stdioBuffer.length ? Buffer.concat([stdioBuffer, chunk.subarray(offset, newline)]) : chunk.subarray(offset, newline);
			stdioBuffer = Buffer.alloc(0);
			offset = newline + 1;
			if (!bytes.length) { writeJsonRpcError(null, -32700, 'Invalid request frame.'); continue; }
			let message;
			try { message = JSON.parse(bytes.toString('utf8')); }
			catch { writeJsonRpcError(null, -32700, 'Invalid JSON.'); continue; }
			if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
				writeJsonRpcError(isValidRequestId(message?.id) ? message.id : null, -32600, 'Invalid JSON-RPC request.');
				continue;
			}
			if (message.id === undefined) {
				if (message.method === 'notifications/cancelled' && paramsHaveRequestId(message.params)) {
					const marker = pendingMcp.get(idKey(message.params.requestId));
					if (marker) { marker.cancelled = true; marker.controller.abort(); }
				}
				continue;
			}
			if (!isValidRequestId(message.id)) { writeJsonRpcError(null, -32600, 'Invalid JSON-RPC request ID.'); continue; }
			const key = idKey(message.id);
			if (pendingMcp.has(key)) { writeJsonRpcError(message.id, -32600, 'A request with this ID is already in flight.'); continue; }
			if (pendingMcp.size >= MAX_IN_FLIGHT) { writeJsonRpcError(message.id, -32000, 'Too many requests are in flight.'); continue; }
			const marker = { cancelled: false, controller: new AbortController(), bridgeId: undefined };
			pendingMcp.set(key, marker);
			void handleMcp(message, socket, pendingBridge, () => `${++nextId}`, marker).then(
				result => { if (!marker.cancelled) { writeJsonRpcResponse(message.id, result); } },
				error => { if (!marker.cancelled) { writeJsonRpcError(message.id, Number.isInteger(error?.code) ? error.code : -32603, safeMessage(error)); } },
			).finally(() => { if (pendingMcp.get(key) === marker) { pendingMcp.delete(key); } });
		}
	});
	process.stdin.on('end', () => {
		if (stdioBuffer.length) { writeJsonRpcError(null, -32700, 'Input ended with an incomplete request frame.'); }
		socket.end();
	});
	process.on('SIGTERM', () => { socket.destroy(); process.exit(0); });
}

async function handleMcp(message, socket, pendingBridge, allocateBridgeId, marker) {
	const params = message.params && typeof message.params === 'object' ? message.params : {};
	switch (message.method) {
		case 'initialize': {
			const requested = params.protocolVersion;
			if (typeof requested !== 'string' || !PROTOCOL_VERSIONS.has(requested)) {
				throw new Error('No supported MCP protocol version was requested.');
			}
			return {
				protocolVersion: requested,
				capabilities: { tools: {} },
				serverInfo: { name: 'bugfixer-session-collaboration', version: '1.0.0' },
			};
		}
		case 'ping': return {};
		case 'tools/list': return { tools: TOOLS };
		case 'tools/call': return callTool(params, socket, pendingBridge, allocateBridgeId, marker);
		default: throw Object.assign(new Error(`Unsupported MCP method: ${message.method}`), { code: -32601 });
	}
}

async function callTool(params, socket, pendingBridge, allocateBridgeId, marker) {
	if (typeof params.name !== 'string' || !TOOLS_BY_NAME.has(params.name)) {
		return toolError('The requested session collaboration tool is not supported.');
	}
	const tool = TOOLS_BY_NAME.get(params.name);
	const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
	const validated = tool.validate(args);
	if (validated.error) { return toolError(validated.error); }
	const id = allocateBridgeId();
	marker.bridgeId = id;
	const result = await new Promise((resolve, reject) => {
		const onAbort = () => {
			pendingBridge.delete(id);
			socket.write(`${JSON.stringify({ type: 'cancel', id })}\n`);
			reject(new Error('The mailbox request was cancelled.'));
		};
		pendingBridge.set(id, { resolve: frame => { marker.controller.signal.removeEventListener('abort', onAbort); resolve(frame); }, reject: error => { marker.controller.signal.removeEventListener('abort', onAbort); reject(error); } });
		marker.controller.signal.addEventListener('abort', onAbort, { once: true });
		if (marker.controller.signal.aborted) { onAbort(); return; }
		const frame = Buffer.from(`${JSON.stringify({ type: 'request', id, method: tool.method, params: validated.value })}\n`, 'utf8');
		if (frame.length > MAX_FRAME_BYTES) { pendingBridge.delete(id); reject(new Error('The session MCP request exceeds the size limit.')); return; }
		socket.write(frame);
	});
	if (result.error) { return toolError(result.error); }
	return { content: [{ type: 'text', text: JSON.stringify(result.result) }], structuredContent: result.result };
}

function stringField(args, name, maxBytes, required = true) {
	const value = args[name];
	if (value === undefined && !required) { return { value: undefined }; }
	if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) { return { error: `${name} must be a string of at most ${maxBytes} bytes.` }; }
	return { value };
}

function integerField(args, name, min, max, fallback, required = false) {
	const value = args[name];
	if (value === undefined && !required) { return { value: fallback }; }
	if (!Number.isSafeInteger(value) || value < min || value > max) { return { error: `${name} must be an integer between ${min} and ${max}.` }; }
	return { value };
}

function allowedFields(args, names) {
	return Object.keys(args).every(name => names.includes(name));
}

function toolError(message) { return { isError: true, content: [{ type: 'text', text: String(message).slice(0, 500) }] }; }

function parseBridgeFrame(bytes) {
	try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
}

function paramsHaveRequestId(params) {
	return !!params && typeof params === 'object' && (typeof params.requestId === 'string' || Number.isSafeInteger(params.requestId));
}

function isValidRequestId(value) { return (typeof value === 'string' && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 256) || Number.isSafeInteger(value); }

function idKey(value) { return `${typeof value}:${String(value)}`; }

function safeMessage(error) {
	return error instanceof Error ? error.message.slice(0, 500) : 'The session collaboration request failed.';
}

let stdoutQueue = [];
let stdoutQueueBytes = 0;
let stdoutBlocked = false;
let stdoutFailed = false;
let stdoutBlockedBytes = 0;
process.stdout.on('drain', () => {
	stdoutQueueBytes -= stdoutBlockedBytes;
	stdoutBlockedBytes = 0;
	stdoutBlocked = false;
	if (stdoutQueue.length) {
		const next = stdoutQueue.shift();
		const accepted = process.stdout.write(next);
		if (accepted) { stdoutQueueBytes -= Buffer.byteLength(next); }
		else { stdoutBlocked = true; stdoutBlockedBytes = Buffer.byteLength(next); }
	}
	if (!stdoutBlocked && stdoutQueueBytes < MAX_STDOUT_QUEUE_BYTES / 4) { process.stdin.resume(); }
	if (stdoutQueue.length) { flushStdoutQueue(); }
});
function flushStdoutQueue() {
	while (!stdoutBlocked && stdoutQueue.length) {
		const next = stdoutQueue.shift();
		const accepted = process.stdout.write(next);
		if (accepted) { stdoutQueueBytes -= Buffer.byteLength(next); }
		else { stdoutBlocked = true; stdoutBlockedBytes = Buffer.byteLength(next); process.stdin.pause(); }
	}
}
function queueStdout(line) {
	if (stdoutFailed) { return; }
	const bytes = Buffer.byteLength(line);
	if (bytes > MAX_FRAME_BYTES || stdoutQueueBytes + process.stdout.writableLength + bytes > MAX_STDOUT_QUEUE_BYTES) {
		stdoutFailed = true;
		process.stdin.pause();
		process.stdin.destroy();
		activeSocket?.destroy();
		process.stderr.write('Session MCP gateway output exceeded its bounded queue.\n');
		return;
	}
	stdoutQueue.push(line);
	stdoutQueueBytes += bytes;
	flushStdoutQueue();
}
function writeJsonRpcResponse(id, result) {
	const line = `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
	if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { writeJsonRpcError(id, -32603, 'The session collaboration response exceeds the protocol frame limit.'); return; }
	queueStdout(line);
}
function writeJsonRpcError(id, code, message) { queueStdout(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }

const TOOLS = [
	{
		name: 'sessions_list', description: 'List sessions in this launch project.',
		inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
		validate(args) { if (!allowedFields(args, ['limit'])) { return { error: 'Unexpected tool arguments.' }; } const limit = integerField(args, 'limit', 1, 100, 50); return limit.error ? limit : { value: { limit: limit.value } }; },
		method: 'sessions.list',
	},
	{
		name: 'messages_send', description: 'Send a durable mailbox message to a session in this project. Each recipient has a 100-unread-message queue capacity.',
		inputSchema: { type: 'object', required: ['recipientSessionId', 'idempotencyKey', 'body'], properties: {
			recipientSessionId: { type: 'string', format: 'uuid' }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 }, body: { type: 'string', maxLength: 16384 },
		}, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['recipientSessionId', 'idempotencyKey', 'body'])) { return { error: 'Unexpected tool arguments.' }; }
			const recipientSessionId = stringField(args, 'recipientSessionId', 64);
			const idempotencyKey = stringField(args, 'idempotencyKey', 128);
			const body = stringField(args, 'body', 32_768);
			const bad = [recipientSessionId, idempotencyKey, body].find(field => field.error);
			if (bad) { return bad; }
			if (!idempotencyKey.value.length) { return { error: 'idempotencyKey must not be empty.' }; }
			return { value: { recipientSessionId: recipientSessionId.value, idempotencyKey: idempotencyKey.value, body: body.value } };
		},
		method: 'messages.send',
	},
	{
		name: 'messages_list', description: 'Read durable messages addressed to this session.',
		inputSchema: { type: 'object', properties: { afterSequence: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['afterSequence', 'limit'])) { return { error: 'Unexpected tool arguments.' }; }
			const afterSequence = integerField(args, 'afterSequence', 0, Number.MAX_SAFE_INTEGER, 0);
			const limit = integerField(args, 'limit', 1, 100, 50);
			return afterSequence.error ? afterSequence : limit.error ? limit : { value: { afterSequence: afterSequence.value, limit: limit.value } };
		},
		method: 'messages.list',
	},
	{
		name: 'messages_ack', description: 'Acknowledge a message addressed to this session.',
		inputSchema: { type: 'object', required: ['messageId'], properties: { messageId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
		validate(args) { if (!allowedFields(args, ['messageId'])) { return { error: 'Unexpected tool arguments.' }; } const messageId = stringField(args, 'messageId', 64); return messageId.error ? messageId : { value: { messageId: messageId.value } }; },
		method: 'messages.ack',
	},
	{
		name: 'messages_wait', description: 'Wait a bounded time for new messages addressed to this session.',
		inputSchema: { type: 'object', properties: {
			afterSequence: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 },
		}, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['afterSequence', 'limit', 'timeoutMs'])) { return { error: 'Unexpected tool arguments.' }; }
			const afterSequence = integerField(args, 'afterSequence', 0, Number.MAX_SAFE_INTEGER, 0);
			const limit = integerField(args, 'limit', 1, 100, 50);
			const timeoutMs = integerField(args, 'timeoutMs', 0, 30_000, 20_000);
			const bad = [afterSequence, limit, timeoutMs].find(field => field.error);
			return bad ?? { value: { afterSequence: afterSequence.value, limit: limit.value, timeoutMs: timeoutMs.value } };
		},
		method: 'messages.wait',
	},
	{
		name: 'workflows_status', description: 'Read bounded status for a workflow that includes this session.',
		inputSchema: { type: 'object', required: ['workflowId'], properties: { workflowId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['workflowId'])) { return { error: 'Unexpected tool arguments.' }; }
			const workflowId = stringField(args, 'workflowId', 64);
			return workflowId.error ? workflowId : { value: { workflowId: workflowId.value } };
		},
		method: 'workflows.status',
	},
	{
		name: 'workflows_cancel', description: 'Request cancellation for a workflow that includes this session.',
		inputSchema: { type: 'object', required: ['workflowId', 'expectedRevision', 'idempotencyKey'], properties: {
			workflowId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
		}, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['workflowId', 'expectedRevision', 'idempotencyKey'])) { return { error: 'Unexpected tool arguments.' }; }
			const workflowId = stringField(args, 'workflowId', 64);
			const expectedRevision = integerField(args, 'expectedRevision', 1, Number.MAX_SAFE_INTEGER, 0, true);
			const idempotencyKey = stringField(args, 'idempotencyKey', 128);
			const bad = [workflowId, expectedRevision, idempotencyKey].find(field => field.error);
			return bad ?? (idempotencyKey.value.length ? { value: { workflowId: workflowId.value, expectedRevision: expectedRevision.value, idempotencyKey: idempotencyKey.value } } : { error: 'idempotencyKey must not be empty.' });
		},
		method: 'workflows.cancel',
	},
];
const TOOLS_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));
