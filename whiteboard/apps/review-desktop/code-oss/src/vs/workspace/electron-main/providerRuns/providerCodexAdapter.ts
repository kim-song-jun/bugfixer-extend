/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { PROVIDER_MAX_EVENT_LINE_BYTES, type ProviderCommandSpec, type ProviderRunEvent, type ProviderRunRequest, type ProviderTerminalState } from './providerRunTypes.js';

const CODEX_ITEM_TYPES = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'image_view', 'entered_review_mode', 'exited_review_mode', 'plan', 'todo_list', 'error']);

/** Commands whose nonzero result means the requested validation itself failed. */
const CODEX_VALIDATION_COMMAND = /(?:^|[\s;&|()])(?:npm\s+(?:run\s+)?(?:test|check|lint|build|typecheck)|pnpm\s+(?:run\s+)?(?:test|check|lint|build|typecheck)|yarn\s+(?:run\s+)?(?:test|check|lint|build|typecheck)|bun\s+(?:run\s+)?(?:test|check|lint|build|typecheck)|(?:tsc|eslint|stylelint|vitest|jest|mocha|pytest|mypy|ruff|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|vet|build)|make\s+(?:test|check|lint|build)|prettier\s+[^;&|]*--check|git\s+diff\s+--check)(?=\s|$))/i;

type CodexJsonEvent = {
	type?: unknown;
	thread_id?: unknown;
	item?: { type?: unknown; text?: unknown; status?: unknown; exit_code?: unknown; command?: unknown };
};

/** Builds an argv-only Codex invocation; CODEX_HOME isolates credentials and config to this profile. */
export function createCodexCommandSpec(request: ProviderRunRequest, executable = 'codex'): ProviderCommandSpec {
	if (request.providerId !== 'codex') {
		throw new Error('Codex adapter received a request for another provider');
	}
	if (!isValidProfileDirectory(request.profileDirectory)) {
		throw new Error('Codex requires an explicit absolute profile directory.');
	}
	if (request.permissionPolicy.approval === 'always') {
		throw new Error('Codex CLI does not support the required always-approve policy');
	}
	if (request.permissionPolicy.mode === 'mutating' && request.permissionPolicy.approval !== 'on-request') {
		throw new Error('Codex mutating runs require the supported on-request automatic-review policy.');
	}
	if (request.permissionPolicy.mode === 'read-only' && request.permissionPolicy.approval !== 'never') {
		throw new Error('Codex read-only runs require the read-only sandbox without automatic review.');
	}
	const args = [
		'exec', '--json',
		...(request.permissionPolicy.mode === 'mutating' ? ['--approve-for-me'] : ['--sandbox', 'read-only']),
		'--skip-git-repo-check',
		'--ephemeral',
		'-',
	];
	const parseEvent = createCodexJsonlEventParser();
	return {
		executable,
		args,
		stdin: request.prompt,
		env: { CODEX_HOME: request.profileDirectory },
		parseEvent: (line, stream) => {
			const parsed = parseEvent(line, stream);
			return {
				...(parsed.event ? { event: parsed.event } : {}),
				...(parsed.terminalState ? { terminalState: parsed.terminalState } : {}),
				...(parsed.finalText !== undefined ? { finalText: parsed.finalText } : {}),
			};
		},
	};
}

function isValidProfileDirectory(directory: string): boolean {
	return directory.trim().length > 0 && isAbsolute(directory) && !/[\u0000-\u001f\u007f]/.test(directory);
}

/** Parses only lifecycle metadata. Prompt text, model output, tool I/O and error messages are discarded. */
export function parseCodexJsonlEvent(line: string, stream: 'stdout' | 'stderr'): {
	event?: Omit<ProviderRunEvent, 'providerId' | 'attemptId' | 'timestamp'>;
	terminalState?: ProviderTerminalState;
	finalText?: string;
} {
	return parseCodexJsonlEventWithState(line, stream, { failedValidationHashes: new Set<string>(), hardFailure: false });
}

function createCodexJsonlEventParser(): (line: string, stream: 'stdout' | 'stderr') => ReturnType<typeof parseCodexJsonlEvent> {
	const state = { failedValidationHashes: new Set<string>(), hardFailure: false };
	return (line, stream) => parseCodexJsonlEventWithState(line, stream, state);
}

function parseCodexJsonlEventWithState(line: string, stream: 'stdout' | 'stderr', state: { failedValidationHashes: Set<string>; hardFailure: boolean }): ReturnType<typeof parseCodexJsonlEvent> {
	if (stream !== 'stdout' || line.length === 0 || Buffer.byteLength(line, 'utf8') > PROVIDER_MAX_EVENT_LINE_BYTES) {
		return {};
	}
	let parsed: CodexJsonEvent;
	try {
		parsed = JSON.parse(line) as CodexJsonEvent;
	} catch {
		return {};
	}
	if (typeof parsed.type !== 'string') {
		return {};
	}
	if (parsed.type === 'thread.started') {
		return {
			event: {
				type: 'session.started',
				...(typeof parsed.thread_id === 'string' && /^[a-f0-9-]{1,64}$/i.test(parsed.thread_id) ? { providerSessionId: parsed.thread_id } : {}),
			},
		};
	}
	if (parsed.type === 'turn.started') {
		return { event: { type: 'turn.started' } };
	}
	if (parsed.type === 'item.started' || parsed.type === 'item.completed' || parsed.type === 'item.updated') {
		const itemType = typeof parsed.item?.type === 'string' && CODEX_ITEM_TYPES.has(parsed.item.type) ? parsed.item.type : undefined;
		const itemStatus = typeof parsed.item?.status === 'string' ? parsed.item.status.toLowerCase() : undefined;
		const isCommand = itemType === 'command_execution';
		const command = typeof parsed.item?.command === 'string' && parsed.item.command.length > 0 ? parsed.item.command : undefined;
		const commandHash = command ? createHash('sha256').update(command, 'utf8').digest('hex') : undefined;
		const exitCode = typeof parsed.item?.exit_code === 'number' && Number.isInteger(parsed.item.exit_code) ? parsed.item.exit_code : undefined;
		const denied = itemStatus === 'denied' || itemStatus === 'declined' || itemStatus === 'approval_denied';
		const failedValidationHashes = state.failedValidationHashes;
		let itemOutcome: string | undefined;
		let terminalState: ProviderTerminalState | undefined;
		if (denied) {
			itemOutcome = 'denied';
			terminalState = 'failed';
		} else if (isCommand && itemStatus === 'completed' && exitCode === 0 && commandHash) {
			failedValidationHashes.delete(commandHash);
		} else if (isCommand && exitCode !== undefined && exitCode !== 0 && commandHash) {
			if (isFailedValidationCommand(command)) {
				failedValidationHashes.add(commandHash);
				itemOutcome = 'failed';
			} else {
				itemOutcome = 'unresolved';
			}
		} else if (isCommand && ((exitCode !== undefined && exitCode !== 0) || itemStatus === 'failed')) {
			itemOutcome = 'failed';
			terminalState = 'failed';
		} else if (itemStatus === 'failed') {
			itemOutcome = 'failed';
			terminalState = 'failed';
		}
		if (terminalState === 'failed') state.hardFailure = true;
		return {
			event: {
				type: parsed.type,
				...(typeof itemType === 'string' || itemOutcome ? { metadata: {
					...(typeof itemType === 'string' ? { itemType } : {}),
					...(itemOutcome ? { itemOutcome } : {}),
				} } : {}),
			},
			...(terminalState ? { terminalState } : {}),
			...(parsed.type === 'item.completed' && itemType === 'agent_message' && typeof parsed.item?.text === 'string'
				? { finalText: parsed.item.text } : {}),
		};
	}
	if (parsed.type === 'turn.completed') {
		return state.hardFailure
			? { event: { type: 'turn.completed' }, terminalState: 'failed' }
			: state.failedValidationHashes.size > 0
			? { event: { type: 'turn.completed', metadata: { itemOutcome: 'failed' } }, terminalState: 'failed' }
			: { event: { type: 'turn.completed' }, terminalState: 'succeeded' };
	}
	if (parsed.type === 'turn.failed' || parsed.type === 'error') {
		return { event: { type: parsed.type }, terminalState: 'failed' };
	}
	return {};
}

function isFailedValidationCommand(command: string | undefined): boolean {
	return command !== undefined && CODEX_VALIDATION_COMMAND.test(command);
}
