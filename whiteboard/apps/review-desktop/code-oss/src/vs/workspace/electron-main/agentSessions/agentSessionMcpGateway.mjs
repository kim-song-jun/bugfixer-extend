/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { connect } from 'node:net';

const MAX_FRAME_BYTES = 65_536;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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
		process.stdin.pause();
		process.stdin.destroy();
		activeSocket?.destroy();
		process.exitCode = 1;
	});
}

async function run() {
	const socket = connect({ host: '127.0.0.1', port });
	activeSocket = socket;
	socket.setNoDelay(true);
	let socketBuffer = Buffer.alloc(0);
	let authenticated = false;
	let disconnected = false;
	let nextId = 0;
	const pendingBridge = new Map();
	const pendingMcp = new Map();

	const socketReady = new Promise((resolve, reject) => {
		socket.once('connect', resolve);
		socket.once('error', reject);
	});
	await socketReady;
	await writeSocketFrame(socket, `${JSON.stringify({ type: 'auth', token })}\n`);
	await new Promise((resolve, reject) => {
		let settled = false;
		const finish = error => {
			if (settled) { return; }
			settled = true;
			socket.off('data', onData);
			socket.off('error', onError);
			socket.off('end', onEnd);
			socket.off('close', onClose);
			if (error) { reject(error); } else { resolve(); }
		};
		const onData = chunk => {
			socketBuffer = Buffer.concat([socketBuffer, chunk]);
			const newline = socketBuffer.indexOf(0x0a);
			if (newline < 0) { if (socketBuffer.length > MAX_FRAME_BYTES) { finish(new Error('Oversized bridge frame.')); } return; }
			const frame = parseBridgeFrame(socketBuffer.subarray(0, newline));
			socketBuffer = socketBuffer.subarray(newline + 1);
			if (frame?.type !== 'auth' || frame.ok !== true) { finish(new Error('Bridge authentication was denied.')); }
			else { authenticated = true; finish(); }
		};
		const onError = error => finish(error);
		const onEnd = () => finish(new Error('The trusted app bridge disconnected during authentication.'));
		const onClose = () => finish(new Error('The trusted app bridge disconnected during authentication.'));
		socket.on('data', onData);
		socket.once('error', onError);
		socket.once('end', onEnd);
		socket.once('close', onClose);
	});
	const disconnect = () => {
		if (disconnected) { return; }
		disconnected = true;
		process.stdin.pause();
		process.stdin.destroy();
		const error = new Error('The trusted app bridge disconnected.');
		for (const [id, pending] of pendingBridge) {
			pendingBridge.delete(id);
			pending.reject(error);
		}
	};

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
	socket.on('error', disconnect);
	socket.on('end', disconnect);
	socket.on('close', disconnect);

	let stdioBuffer = Buffer.alloc(0);
	const failInput = message => {
		writeJsonRpcError(null, -32700, message);
		process.stdin.destroy();
		socket.destroy();
	};
	process.stdin.on('data', chunk => {
		if (disconnected) { return; }
		let offset = 0;
		while (offset < chunk.length && !stdoutFailed && !disconnected) {
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
			void handleMcp(message, socket, pendingBridge, () => `${++nextId}`, marker, () => disconnected).then(
				result => { if (!marker.cancelled) { writeJsonRpcResponse(message.id, result); } },
				error => { if (!marker.cancelled) { writeJsonRpcError(message.id, Number.isInteger(error?.code) ? error.code : -32603, safeMessage(error)); } },
			).finally(() => { if (pendingMcp.get(key) === marker) { pendingMcp.delete(key); } });
		}
	});
	process.stdin.on('end', () => {
		if (stdioBuffer.length) { writeJsonRpcError(null, -32700, 'Input ended with an incomplete request frame.'); }
		socket.end();
	});
	process.on('SIGTERM', () => { process.stdin.pause(); process.stdin.destroy(); socket.destroy(); process.exitCode = 0; });
}

async function handleMcp(message, socket, pendingBridge, allocateBridgeId, marker, isDisconnected) {
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
		case 'tools/call': return callTool(params, socket, pendingBridge, allocateBridgeId, marker, isDisconnected);
		default: throw Object.assign(new Error(`Unsupported MCP method: ${message.method}`), { code: -32601 });
	}
}

async function callTool(params, socket, pendingBridge, allocateBridgeId, marker, isDisconnected) {
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
		const rejectPending = error => {
			const pending = pendingBridge.get(id);
			if (!pending) { return; }
			pendingBridge.delete(id);
			pending.reject(error);
		};
		const onAbort = () => {
			if (!pendingBridge.has(id)) { return; }
			if (isSocketWritable(socket, isDisconnected)) {
				void writeSocketFrame(socket, `${JSON.stringify({ type: 'cancel', id })}\n`, isDisconnected).catch(error => socket.destroy(error));
			}
			rejectPending(new Error('The mailbox request was cancelled.'));
		};
		pendingBridge.set(id, { resolve: frame => { marker.controller.signal.removeEventListener('abort', onAbort); resolve(frame); }, reject: error => { marker.controller.signal.removeEventListener('abort', onAbort); reject(error); } });
		marker.controller.signal.addEventListener('abort', onAbort, { once: true });
		if (marker.controller.signal.aborted) { onAbort(); return; }
		if (isDisconnected() || !isSocketWritable(socket, isDisconnected)) { rejectPending(new Error('The trusted app bridge is disconnected.')); return; }
		const frame = Buffer.from(`${JSON.stringify({ type: 'request', id, method: tool.method, params: validated.value })}\n`, 'utf8');
		if (frame.length > MAX_FRAME_BYTES) { rejectPending(new Error('The session MCP request exceeds the size limit.')); return; }
		void writeSocketFrame(socket, frame, isDisconnected).catch(rejectPending);
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

function isSocketWritable(socket, isDisconnected) {
	return !isDisconnected() && !socket.destroyed && socket.writable && !socket.writableEnded;
}

function writeSocketFrame(socket, frame, isDisconnected = () => false) {
	if (!isSocketWritable(socket, isDisconnected)) { return Promise.reject(new Error('The trusted app bridge is disconnected.')); }
	return new Promise((resolve, reject) => {
		try {
			socket.write(frame, error => error ? reject(error) : resolve());
		} catch (error) {
			reject(error);
		}
	});
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
		name: 'sessions_requestStart', description: 'Save a proposed start for human review in the native app. This never launches a provider or grants permissions. The human must review the target, model, folder, rules, permissions and possible usage cost.',
		inputSchema: { type: 'object', required: ['targetSessionId', 'expectedSessionRevision', 'permissionMode', 'approval', 'reason', 'idempotencyKey'], properties: {
			targetSessionId: { type: 'string', format: 'uuid' }, expectedSessionRevision: { type: 'integer', minimum: 1 },
			permissionMode: { type: 'string', enum: ['read-only', 'mutating'] }, approval: { type: 'string', enum: ['never', 'on-request', 'always'] },
			reason: { type: 'string', minLength: 1, maxLength: 8192 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
		}, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['targetSessionId', 'expectedSessionRevision', 'permissionMode', 'approval', 'reason', 'idempotencyKey'])) { return { error: 'Unexpected tool arguments.' }; }
			const targetSessionId = stringField(args, 'targetSessionId', 64);
			const revision = integerField(args, 'expectedSessionRevision', 1, Number.MAX_SAFE_INTEGER, undefined);
			const reason = stringField(args, 'reason', 8192);
			const key = stringField(args, 'idempotencyKey', 128);
			const bad = [targetSessionId, revision, reason, key].find(field => field.error);
			if (bad) { return bad; }
			if (!UUID_RE.test(targetSessionId.value) || revision.value === undefined || !reason.value.trim() || !key.value.trim()) { return { error: 'A target UUID, exact session revision, reason and retry key are required.' }; }
			if (!['read-only', 'mutating'].includes(args.permissionMode) || !['never', 'on-request', 'always'].includes(args.approval)) { return { error: 'Invalid proposed permission policy.' }; }
			return { value: { targetSessionId: targetSessionId.value, expectedSessionRevision: revision.value, permissionMode: args.permissionMode, approval: args.approval, reason: reason.value, idempotencyKey: key.value } };
		},
		method: 'sessions.requestStart',
	},
	{
		name: 'sessions_stop', description: 'Queue an exact-turn stop for this turn or a designated target in its captured current human-approved workflow. A durable accepted receipt is not verified cleanup; self-stop may close this MCP connection. Inspect the native app for the final result.',
		inputSchema: { type: 'object', required: ['targetSessionId', 'targetTurnId', 'idempotencyKey'], properties: {
			targetSessionId: { type: 'string', format: 'uuid' }, targetTurnId: { type: 'string', format: 'uuid' }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
		}, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['targetSessionId', 'targetTurnId', 'idempotencyKey'])) { return { error: 'Unexpected tool arguments.' }; }
			const session = stringField(args, 'targetSessionId', 64);
			const turn = stringField(args, 'targetTurnId', 64);
			const key = stringField(args, 'idempotencyKey', 128);
			const bad = [session, turn, key].find(field => field.error);
			if (bad) { return bad; }
			if (!UUID_RE.test(session.value) || !UUID_RE.test(turn.value) || !key.value.trim()) { return { error: 'Exact target session/turn UUIDs and a retry key are required.' }; }
			return { value: { targetSessionId: session.value, targetTurnId: turn.value, idempotencyKey: key.value } };
		},
		method: 'sessions.stop',
	},
	{
		name: 'sessionRequests_get', description: 'Read a durable control receipt created by this exact caller turn. Queued/accepted does not mean provider cleanup completed. Ended turns lose this capability.',
		inputSchema: { type: 'object', required: ['requestId'], properties: { requestId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['requestId'])) { return { error: 'Unexpected tool arguments.' }; }
			const id = stringField(args, 'requestId', 64);
			if (id.error) { return id; }
			return UUID_RE.test(id.value) ? { value: { requestId: id.value } } : { error: 'requestId must be a UUID.' };
		},
		method: 'sessionRequests.get',
	},
	{
		name: 'sessions_list', description: 'List sessions in this launch project, current revisions and registered parent links. callerTurnId identifies this caller; workflowTurnId identifies an exact turn in its current captured approved run. These IDs do not bypass stop validation.',
		inputSchema: { type: 'object', properties: { afterSessionId: { type: 'string', format: 'uuid' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['afterSessionId', 'limit'])) { return { error: 'Unexpected tool arguments.' }; }
			const limit = integerField(args, 'limit', 1, 100, 50);
			if (limit.error) { return limit; }
			if (args.afterSessionId === undefined) { return { value: { limit: limit.value } }; }
			const afterSessionId = stringField(args, 'afterSessionId', 64);
			return afterSessionId.error ? afterSessionId : UUID_RE.test(afterSessionId.value) ? { value: { afterSessionId: afterSessionId.value, limit: limit.value } } : { error: 'afterSessionId must be a UUID.' };
		},
		method: 'sessions.list',
	},
	{
		name: 'logs_read', description: 'Read retained logs from this session or an earlier turn in the same session.',
		inputSchema: { type: 'object', required: ['targetTurnId'], properties: {
			targetTurnId: { type: 'string', format: 'uuid' }, afterSequence: { type: 'integer', minimum: 0 },
			limit: { type: 'integer', minimum: 1, maximum: 20 }, maxCharacters: { type: 'integer', minimum: 1, maximum: 1000 },
			kind: { type: 'string', enum: ['terminal', 'log'] }, severity: { type: 'string', enum: ['debug', 'info', 'warning', 'error'] },
			source: { type: 'string', enum: ['pty', 'provider', 'host', 'workspace'] }, cursor: { type: 'string', maxLength: 2048 },
		}, additionalProperties: false },
		validate(args) {
			const fields = ['targetTurnId', 'afterSequence', 'limit', 'maxCharacters', 'kind', 'severity', 'source', 'cursor'];
			if (!allowedFields(args, fields) || typeof args.targetTurnId !== 'string' || !UUID_RE.test(args.targetTurnId)) { return { error: 'Invalid targetTurnId or unexpected tool arguments.' }; }
			if (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 2048 || args.afterSequence !== undefined)) { return { error: 'Invalid transcript cursor.' }; }
			const afterSequence = integerField(args, 'afterSequence', 0, Number.MAX_SAFE_INTEGER, undefined);
			const limit = integerField(args, 'limit', 1, 20, 20);
			const maxCharacters = integerField(args, 'maxCharacters', 1, 1000, 1000);
			const bad = [afterSequence, limit, maxCharacters].find(field => field.error);
			if (bad) { return bad; }
			if (args.kind !== undefined && !['terminal', 'log'].includes(args.kind)) { return { error: 'Invalid transcript kind.' }; }
			if (args.severity !== undefined && !['debug', 'info', 'warning', 'error'].includes(args.severity)) { return { error: 'Invalid transcript severity.' }; }
			if (args.source !== undefined && !['pty', 'provider', 'host', 'workspace'].includes(args.source)) { return { error: 'Invalid transcript source.' }; }
			return { value: { targetTurnId: args.targetTurnId, ...(afterSequence.value === undefined ? {} : { afterSequence: afterSequence.value }), limit: limit.value,
				maxCharacters: maxCharacters.value, ...(args.kind === undefined ? {} : { kind: args.kind }), ...(args.severity === undefined ? {} : { severity: args.severity }),
				...(args.source === undefined ? {} : { source: args.source }), ...(args.cursor === undefined ? {} : { cursor: args.cursor }) } };
		},
		method: 'logs.read',
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
	{
		name: 'pr_get', description: 'Read metadata and a bounded Unicode body fragment of the current or an exact saved PR text revision. Pin the returned revision for subsequent body pages. This grants no GitHub account or publication authority.',
		inputSchema: { type: 'object', required: ['targetTurnId'], properties: {
			targetTurnId: { type: 'string', format: 'uuid' }, revision: { type: 'integer', minimum: 1 },
			afterCharacter: { type: 'integer', minimum: 0 }, maxCharacters: { type: 'integer', minimum: 1, maximum: 1000 },
		}, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['targetTurnId', 'revision', 'afterCharacter', 'maxCharacters'])) { return { error: 'Unexpected tool arguments.' }; }
			const targetTurnId = stringField(args, 'targetTurnId', 64);
			const afterCharacter = integerField(args, 'afterCharacter', 0, Number.MAX_SAFE_INTEGER, 0);
			const maxCharacters = integerField(args, 'maxCharacters', 1, 1000, 1000);
			const bad = [targetTurnId, afterCharacter, maxCharacters].find(field => field.error);
			if (bad) { return bad; }
			const value = { targetTurnId: targetTurnId.value, afterCharacter: afterCharacter.value, maxCharacters: maxCharacters.value };
			if (args.revision === undefined) { return { value }; }
			const revision = integerField(args, 'revision', 1, Number.MAX_SAFE_INTEGER, 0, true);
			return revision.error ? revision : { value: { ...value, revision: revision.value } };
		},
		method: 'pr.get',
	},
	{
		name: 'pr_list', description: 'Read bounded immutable PR text history metadata for this or an earlier turn of this session. Use pr_get to read the exact saved body in bounded pages.',
		inputSchema: { type: 'object', required: ['targetTurnId'], properties: {
			targetTurnId: { type: 'string', format: 'uuid' }, afterRevision: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 5 },
		}, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['targetTurnId', 'afterRevision', 'limit'])) { return { error: 'Unexpected tool arguments.' }; }
			const targetTurnId = stringField(args, 'targetTurnId', 64);
			const afterRevision = integerField(args, 'afterRevision', 0, Number.MAX_SAFE_INTEGER, 0);
			const limit = integerField(args, 'limit', 1, 5, 1);
			const bad = [targetTurnId, afterRevision, limit].find(field => field.error);
			return bad ?? { value: { targetTurnId: targetTurnId.value, afterRevision: afterRevision.value, limit: limit.value } };
		},
		method: 'pr.list',
	},
	{
		name: 'pr_prepare', description: 'Author or revise PR title/body text only. Read its revision first, use a stable idempotency key, and summarize actual changes, retained reasons, tests and limits. This cannot select a GitHub account, approve, push or create a PR. The user can revise this text by chat or direct editing before native review.',
		inputSchema: { type: 'object', required: ['targetTurnId', 'expectedRevision', 'idempotencyKey', 'title', 'body'], properties: {
			targetTurnId: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 0 },
			idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 }, title: { type: 'string', minLength: 1, maxLength: 256 }, body: { type: 'string', maxLength: 32768 },
		}, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['targetTurnId', 'expectedRevision', 'idempotencyKey', 'title', 'body'])) { return { error: 'Unexpected tool arguments.' }; }
			const targetTurnId = stringField(args, 'targetTurnId', 64);
			const expectedRevision = integerField(args, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER, 0, true);
			const idempotencyKey = stringField(args, 'idempotencyKey', 128);
			const title = stringField(args, 'title', 256);
			const body = stringField(args, 'body', 32768);
			const bad = [targetTurnId, expectedRevision, idempotencyKey, title, body].find(field => field.error);
			if (bad) { return bad; }
			if (!idempotencyKey.value.length || !title.value.trim().length) { return { error: 'idempotencyKey and title must not be empty.' }; }
			return { value: { targetTurnId: targetTurnId.value, expectedRevision: expectedRevision.value, idempotencyKey: idempotencyKey.value, title: title.value, body: body.value } };
		},
		method: 'pr.prepare',
	},
	{
		name: 'getChangeHunks', description: 'Read one changed file from an exact retained evidence version and its bounded hunk identities. redactionApplied means response text was redacted; hashes and hunk identities still describe the original retained bytes.',
		inputSchema: { type: 'object', required: ['turnId', 'evidenceVersion', 'path'], properties: {
			turnId: { type: 'string', format: 'uuid' }, evidenceVersion: { type: 'integer', minimum: 1 }, path: { type: 'string', minLength: 1, maxLength: 4096 },
		}, additionalProperties: false },
		validate(args) {
			if (!allowedFields(args, ['turnId', 'evidenceVersion', 'path'])) { return { error: 'Unexpected tool arguments.' }; }
			const turnId = stringField(args, 'turnId', 64);
			const evidenceVersion = integerField(args, 'evidenceVersion', 1, Number.MAX_SAFE_INTEGER, 0, true);
			const path = stringField(args, 'path', 4096);
			return turnId.error ? turnId : evidenceVersion.error ? evidenceVersion : path.error || !path.value.length ? { error: 'path must be a non-empty relative file path.' } : { value: { turnId: turnId.value, evidenceVersion: evidenceVersion.value, path: path.value } };
		},
		method: 'changes.get',
	},
	{
		name: 'getLatestChangeExplanation', description: 'Read the latest explanation for one exact retained evidence file or hunk.',
		inputSchema: changeExplanationTargetSchema(),
		validate(args) { return validateChangeExplanationTarget(args, ['turnId', 'evidenceVersion', 'evidenceFingerprint', 'path', 'hunkId']); },
		method: 'change_explanations.latest',
	},
	{
		name: 'listChangeExplanationRevisions', description: 'Read bounded immutable explanation history for one exact retained evidence file or hunk.',
		inputSchema: { ...changeExplanationTargetSchema(), properties: {
			...changeExplanationTargetSchema().properties,
			afterRevision: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 30 },
		} },
		validate(args) {
			const target = validateChangeExplanationTarget(args, ['turnId', 'evidenceVersion', 'evidenceFingerprint', 'path', 'hunkId', 'afterRevision', 'limit']);
			if (target.error) { return target; }
			const afterRevision = integerField(args, 'afterRevision', 0, Number.MAX_SAFE_INTEGER, 0);
			const limit = integerField(args, 'limit', 1, 30, 20);
			return afterRevision.error ? afterRevision : limit.error ? limit : { value: { ...target.value, afterRevision: afterRevision.value, limit: limit.value } };
		},
		method: 'change_explanations.list',
	},
	{
		name: 'recordAgentChangeExplanation', description: 'Append an agent-authored draft explanation for exact retained evidence. Reported checks remain unverified claims.',
		inputSchema: { ...changeExplanationTargetSchema(), required: ['turnId', 'evidenceVersion', 'evidenceFingerprint', 'path', 'hunkId', 'expectedLatestRevision', 'what', 'why', 'citations', 'checkClaims'], properties: {
			...changeExplanationTargetSchema().properties,
			expectedLatestRevision: { type: 'integer', minimum: 0 }, what: { type: 'string', minLength: 1, maxLength: 4096 }, why: { type: 'string', minLength: 1, maxLength: 8192 },
			citations: { type: 'array', maxItems: 20, items: { type: 'object', required: ['kind', 'id', 'version', 'sha256'], properties: {
				kind: { type: 'string', enum: ['reference', 'convention'] }, id: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 1 }, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
			}, additionalProperties: false } },
			checkClaims: { type: 'array', maxItems: 10, items: { type: 'object', required: ['label', 'outcome'], properties: {
				label: { type: 'string', minLength: 1, maxLength: 256 }, outcome: { type: 'string', enum: ['reportedPass', 'reportedFail', 'notRun'] }, detail: { type: 'string', maxLength: 1024 },
			}, additionalProperties: false } },
		} },
		validate(args) {
			const allowed = ['turnId', 'evidenceVersion', 'evidenceFingerprint', 'path', 'hunkId', 'expectedLatestRevision', 'what', 'why', 'citations', 'checkClaims'];
			const target = validateChangeExplanationTarget(args, allowed);
			if (target.error) { return target; }
			const expectedLatestRevision = integerField(args, 'expectedLatestRevision', 0, Number.MAX_SAFE_INTEGER, 0, true);
			const what = stringField(args, 'what', 4096);
			const why = stringField(args, 'why', 8192);
			if (expectedLatestRevision.error || what.error || why.error) { return expectedLatestRevision.error ? expectedLatestRevision : what.error ? what : why; }
			if (!what.value.trim() || !why.value.trim() || !Array.isArray(args.citations) || !Array.isArray(args.checkClaims)) { return { error: 'Explanation text, citations, and checkClaims are invalid.' }; }
			return { value: { ...target.value, expectedLatestRevision: expectedLatestRevision.value, what: what.value, why: why.value, citations: args.citations, checkClaims: args.checkClaims } };
		},
		method: 'change_explanations.draft',
	},
];
const TOOLS_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));

function changeExplanationTargetSchema() {
	return { type: 'object', required: ['turnId', 'evidenceVersion', 'evidenceFingerprint', 'path', 'hunkId'], properties: {
		turnId: { type: 'string', format: 'uuid' }, evidenceVersion: { type: 'integer', minimum: 1 }, evidenceFingerprint: { type: 'string', pattern: '^[0-9a-f]{64}$' },
		path: { type: 'string', minLength: 1, maxLength: 4096 }, hunkId: { anyOf: [{ type: 'string', pattern: '^[0-9a-f]{64}$' }, { type: 'null' }] },
	}, additionalProperties: false };
}

function validateChangeExplanationTarget(args, allowed) {
	if (!allowedFields(args, allowed)) { return { error: 'Unexpected tool arguments.' }; }
	const turnId = stringField(args, 'turnId', 64);
	const evidenceVersion = integerField(args, 'evidenceVersion', 1, Number.MAX_SAFE_INTEGER, 0, true);
	const evidenceFingerprint = stringField(args, 'evidenceFingerprint', 64);
	const path = stringField(args, 'path', 4096);
	const hunkId = args.hunkId;
	if (turnId.error || evidenceVersion.error || evidenceFingerprint.error || path.error) { return turnId.error ? turnId : evidenceVersion.error ? evidenceVersion : evidenceFingerprint.error ? evidenceFingerprint : path; }
	if (!/^[0-9a-f]{64}$/i.test(evidenceFingerprint.value) || !path.value.length
		|| (hunkId !== null && (typeof hunkId !== 'string' || !/^[0-9a-f]{64}$/i.test(hunkId)))) {
		return { error: 'The evidence fingerprint, path, or hunk ID is invalid.' };
	}
	return { value: { turnId: turnId.value, evidenceVersion: evidenceVersion.value, evidenceFingerprint: evidenceFingerprint.value, path: path.value, hunkId } };
}
