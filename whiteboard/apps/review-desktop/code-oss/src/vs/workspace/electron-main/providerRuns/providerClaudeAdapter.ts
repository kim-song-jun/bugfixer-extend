/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PROVIDER_MAX_EVENT_LINE_BYTES, type ProviderCommandSpec, type ProviderRunEvent, type ProviderRunRequest, type ProviderTerminalState } from './providerRunTypes.js';

const MAX_SESSION_ID_LENGTH = 128;

/**
 * Creates a Claude Code CLI invocation for policies this adapter can prove safe.
 * Claude's non-interactive CLI has no permission broker in this integration yet, so
 * plan mode is used for read-only runs; task runs use acceptEdits with prompts
 * disabled, so file edits are allowed while tools needing another permission are denied.
 */
export function createClaudeProviderCommand(request: ProviderRunRequest, executable = 'claude'): ProviderCommandSpec {
	if (request.providerId !== 'claude') {
		throw new Error('Claude adapter received a request for a different provider.');
	}
	if (request.permissionPolicy.mode === 'mutating' && request.permissionPolicy.approval !== 'on-request') {
		throw new Error('Claude mutating runs require the supported on-request accept-edits policy.');
	}
	if (request.permissionPolicy.mode === 'read-only' && request.permissionPolicy.approval !== 'never') {
		throw new Error('Claude read-only runs require no approval requirement.');
	}
	if (!isValidProfileDirectory(request.profileDirectory)) {
		throw new Error('Claude Code requires an explicit absolute profile directory.');
	}
	if (!executable.trim()) {
		throw new Error('Claude Code executable cannot be empty.');
	}

	const parseEvent = createClaudeProviderEventParser();
	return {
		executable,
		args: [
			'--print',
			'--input-format', 'stream-json',
			'--output-format', 'stream-json',
			'--verbose',
			'--restricted',
			...(request.captureFinalText && request.permissionPolicy.mode === 'read-only' ? ['--tools', ''] : []),
			'--permission-mode', request.permissionPolicy.mode === 'mutating' ? 'acceptEdits' : 'plan',
			'--permission-prompts', 'none'
		],
		stdin: JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: request.prompt }] } }) + '\n',
		...(request.profileDirectory === join(userInfo().homedir, '.claude') ? {} : { env: { CLAUDE_CONFIG_DIR: request.profileDirectory } }),
		parseEvent
	};
}

function isValidProfileDirectory(directory: string): boolean {
	return directory.trim().length > 0 && isAbsolute(directory) && !/[\u0000-\u001f\u007f]/.test(directory);
}

/** Parses only session identity, bounded status metadata, and the final result status. */
export function parseClaudeProviderEvent(line: string, stream: 'stdout' | 'stderr'): {
	readonly event?: Omit<ProviderRunEvent, 'providerId' | 'attemptId' | 'timestamp'>;
	readonly terminalState?: ProviderTerminalState;
	readonly finalText?: string;
} {
	return parseClaudeProviderEventWithState(line, stream, { permissionDenied: false });
}

function createClaudeProviderEventParser(): (line: string, stream: 'stdout' | 'stderr') => ReturnType<typeof parseClaudeProviderEvent> {
	const state = { permissionDenied: false };
	return (line, stream) => parseClaudeProviderEventWithState(line, stream, state);
}

function parseClaudeProviderEventWithState(line: string, stream: 'stdout' | 'stderr', state: { permissionDenied: boolean }): ReturnType<typeof parseClaudeProviderEvent> {
	if (stream !== 'stdout' || line.length === 0 || Buffer.byteLength(line, 'utf8') > PROVIDER_MAX_EVENT_LINE_BYTES) {
		return {};
	}

	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		return {};
	}
	if (!isRecord(message) || typeof message.type !== 'string') {
		return {};
	}

	if (message.type === 'system' && message.subtype === 'init') {
		const sessionId = safeSessionId(message.session_id);
		return {
			event: {
				type: 'session.started',
				...(sessionId ? { providerSessionId: sessionId } : {})
			}
		};
	}
	if (message.type === 'system' && message.subtype === 'permission_denied') {
		state.permissionDenied = true;
		return { event: { type: 'permission.denied' } };
	}

	if (message.type !== 'result') {
		return {};
	}

	const permissionDenials = (Array.isArray(message.permission_denials) && message.permission_denials.length > 0)
		|| (typeof message.permission_denials_count === 'number' && Number.isFinite(message.permission_denials_count) && message.permission_denials_count > 0);
	const denied = state.permissionDenied || permissionDenials;
	const succeeded = message.subtype === 'success' && message.is_error !== true && !denied;
	const metadata: Record<string, string | number | boolean | null> = {};
	if (denied) {
		metadata.itemOutcome = 'denied';
	}
	const subtype = typeof message.subtype === 'string' ? message.subtype : undefined;
	if (subtype && CLAUDE_RESULT_SUBTYPES.has(subtype)) {
		metadata.subtype = subtype;
	}
	if (typeof message.num_turns === 'number' && Number.isFinite(message.num_turns)) {
		metadata.numTurns = Math.max(0, Math.min(100_000, Math.trunc(message.num_turns)));
	}
	if (typeof message.duration_ms === 'number' && Number.isFinite(message.duration_ms)) {
		metadata.durationMs = Math.max(0, Math.min(86_400_000, Math.trunc(message.duration_ms)));
	}
	return {
		event: { type: 'turn.completed', metadata },
		terminalState: succeeded ? 'succeeded' : 'failed',
		...(succeeded && typeof message.result === 'string' ? { finalText: message.result } : {}),
	};
}

const CLAUDE_RESULT_SUBTYPES = new Set(['success', 'error_max_turns', 'error_during_execution', 'error_max_budget_usd', 'error_max_structured_output_retries']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeSessionId(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SESSION_ID_LENGTH || !/^[a-zA-Z0-9_-]+$/.test(value)) {
		return undefined;
	}
	return value;
}
