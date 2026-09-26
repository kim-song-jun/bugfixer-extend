/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	boundedOmissions, connectorRequestTimeoutMs, defaultConnectorTransport, encodeReferenceText, encodeSourceArtifact, requireAccountRef,
	readJsonResponseWithBytes, requireCredential, safeTitle, SourceArtifactLimitError, wouldExceedSourceArtifactLimit,
	type ConnectorCredentialResolver, type ConnectorTransport, type ImportedReferenceInput,
} from './types.js';

const slackApiOrigin = 'https://slack.com/api/';
const maxPages = 20;
const maxMessages = 500;
const historyPageSize = 100;
const threadPageSize = 100;
const maxThreadPages = 20;

export interface SlackConversationImportRequest {
	readonly channelId: string;
	readonly accountRef: string;
	readonly title?: string;
	/** Import one selected message and its replies instead of channel history. */
	readonly messageTs?: string;
}

export async function importSlackConversation(
	request: SlackConversationImportRequest,
	credentials: ConnectorCredentialResolver,
	transport: ConnectorTransport = defaultConnectorTransport,
): Promise<ImportedReferenceInput> {
	if (typeof request.channelId !== 'string' || !/^[CGD][A-Z0-9]{2,79}$/.test(request.channelId)) {
		throw new Error('A valid Slack conversation ID is required.');
	}
	if (request.messageTs !== undefined && !/^\d{1,20}\.\d{1,10}$/.test(request.messageTs)) {
		throw new Error('A valid Slack message timestamp is required.');
	}
	const accountRef = requireAccountRef(request.accountRef);
	const token = requireCredential(await credentials.resolve('slack', accountRef), 'slack');
	const artifacts: Array<{ request: string; bytes: Uint8Array }> = [];
	const messages: Record<string, unknown>[] = [];
	const omissions: string[] = [];
	let truncated = false;
	let historyTruncated = false;
	let threadPagesFetched = 0;
	let hardStop = false;
	let limited = false;
	let artifactLimitReached = false;
	const fetchPage = async (method: 'conversations.history' | 'conversations.replies', params: Record<string, string>): Promise<Record<string, unknown>> => {
		const url = new URL(method, slackApiOrigin);
		for (const [key, value] of Object.entries(params)) { url.searchParams.set(key, value); }
		const response = await transport.fetch(url, {
			method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
			signal: AbortSignal.timeout(connectorRequestTimeoutMs),
		});
		if (response.status === 429) {
			const retryAfter = response.headers.get('retry-after');
			await response.body?.cancel();
			throw new Error(`Slack rate limit reached${retryAfter && /^\d+$/.test(retryAfter) ? `; retry after ${retryAfter} seconds` : ''}. Retry the import later.`);
		}
		const { payload, bytes: raw } = await readJsonResponseWithBytes(response);
		if (payload.ok !== true) { throw new Error('Slack rejected the import. Check the selected account and conversation access.'); }
		const artifact = { request: `${method}?${new URLSearchParams(params).toString()}`, bytes: raw };
		if (wouldExceedSourceArtifactLimit(artifacts, artifact)) { throw new SourceArtifactLimitError(); }
		artifacts.push(artifact);
		return payload;
	};
	const collect = async (method: 'conversations.history' | 'conversations.replies', initial: Record<string, string>): Promise<void> => {
		let cursor: string | undefined;
		const pageLimit = method === 'conversations.history' ? maxPages : maxThreadPages;
		for (let page = 0; page < pageLimit; page++) {
			if (method === 'conversations.replies' && threadPagesFetched >= maxThreadPages) { truncated = true; hardStop = true; return; }
			const params = { ...initial };
			if (cursor) { params.cursor = cursor; }
			let payload: Record<string, unknown>;
			try { payload = await fetchPage(method, params); }
			catch (error) {
				if (!(error instanceof SourceArtifactLimitError)) { throw error; }
				truncated = true;
				hardStop = true;
				artifactLimitReached = true;
				return;
			}
			if (payload.is_limited === true) { limited = true; }
			if (!Array.isArray(payload.messages)) { throw new Error('Slack returned an invalid conversation response.'); }
			if (method === 'conversations.replies') { threadPagesFetched++; }
			for (const item of payload.messages) {
				if (!item || typeof item !== 'object' || Array.isArray(item)) { continue; }
				if (messages.length >= maxMessages) { truncated = true; hardStop = true; return; }
				messages.push(item as Record<string, unknown>);
			}
			const metadata = payload.response_metadata as Record<string, unknown> | undefined;
			cursor = typeof metadata?.next_cursor === 'string' && metadata.next_cursor ? metadata.next_cursor : undefined;
			if (cursor && cursor.length > 2048) { throw new Error('Slack returned an invalid pagination cursor.'); }
			if (payload.has_more !== true || !cursor) {
				if (payload.has_more === true) {
					if (method === 'conversations.history') { historyTruncated = true; }
					else { truncated = true; hardStop = true; }
				}
				return;
			}
		}
		if (method === 'conversations.history') { historyTruncated = true; }
		else { truncated = true; hardStop = true; }
	};
	if (request.messageTs) {
		await collect('conversations.replies', { channel: request.channelId, ts: request.messageTs, limit: String(threadPageSize) });
		if (!messages.some(message => message.ts === request.messageTs)) {
			throw new Error('Slack did not return the selected message. Check that the message is still available to this account.');
		}
	} else {
		await collect('conversations.history', { channel: request.channelId, limit: String(historyPageSize) });
		// Fetch every thread represented in the bounded history. The selected history remains complete
		// as a source artifact even if the API limit prevents collecting all replies.
		const threads = [...new Set(messages.filter(message => typeof message.ts === 'string' && Number(message.reply_count) > 0)
			.map(message => String(message.thread_ts ?? message.ts)))];
		for (const ts of threads) {
			if (messages.length >= maxMessages || artifactLimitReached || threadPagesFetched >= maxThreadPages) { truncated = true; hardStop = true; break; }
			await collect('conversations.replies', { channel: request.channelId, ts, limit: String(threadPageSize) });
			if (hardStop) { break; }
		}
	}
	if (historyTruncated) { omissions.push('Slack history reached the 20 page limit; older messages may be unavailable.'); }
	if (limited) { omissions.push('Slack marked part of this conversation history as limited; older messages may be unavailable.'); }
	if (truncated) { omissions.push(artifactLimitReached
		? 'Import stopped before the next response exceeded the 15 MiB source artifact limit; remaining messages or replies were omitted.'
		: `Import stopped at the 500 message or ${maxThreadPages} thread page limit; remaining messages or replies were omitted.`); }
	const plainText = (value: unknown): string => {
		if (typeof value === 'string') { return value; }
		if (!value || typeof value !== 'object') { return ''; }
		if (Array.isArray(value)) { return value.map(plainText).filter(Boolean).join(' '); }
		const record = value as Record<string, unknown>;
		const ownText = ['plain_text', 'text', 'title'].filter(key => typeof record[key] === 'string').map(key => String(record[key]));
		const nestedKeys = ['blocks', 'elements', 'fields', 'attachments', 'rich_text'];
		if (typeof record.text === 'object') { nestedKeys.push('text'); }
		const nested = nestedKeys.filter(key => record[key] !== undefined).map(key => plainText(record[key]));
		return [...ownText, ...nested].filter(Boolean).join(' ');
	};
	if (messages.some(message => message.blocks || message.attachments || message.files)) {
		omissions.push('Rich Slack blocks, attachments, and file contents are preserved in the source artifact; derived text includes readable snippets only.');
	}
	const byTs = new Map<string, Record<string, unknown>>();
	for (const message of messages) { if (typeof message.ts === 'string') { byTs.set(message.ts, message); } }
	const body = [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts)).map(message => {
		const ts = String(message.ts);
		const parent = typeof message.thread_ts === 'string' ? message.thread_ts : undefined;
		const threadContext = parent && parent !== ts ? ` (reply to ${parent})` : '';
		const text = plainText(message.text) || plainText(message.blocks) || plainText(message.attachments);
		const files = Array.isArray(message.files) ? message.files.map(file => {
			if (!file || typeof file !== 'object') { return ''; }
			const entry = file as Record<string, unknown>;
			return typeof entry.name === 'string' ? `[file: ${entry.name}]` : '[file attached; metadata in source artifact]';
		}).filter(Boolean).join(' ') : '';
		return `[${ts}${threadContext}]${typeof message.user === 'string' ? ` ${message.user}:` : ''} ${text || '[message has no readable text]'}${files ? ` ${files}` : ''}`;
	}).join('\n');
	const displayedOmissions = boundedOmissions(omissions);
	return {
		connectorId: 'slack', connectorVersion: '1', externalId: request.messageTs ? `${request.channelId}:${request.messageTs}` : request.channelId,
		sourceUri: `https://app.slack.com/archives/${encodeURIComponent(request.channelId)}${request.messageTs ? `/p${request.messageTs.replace('.', '')}` : ''}`,
		accountRef, title: safeTitle(request.title ?? '', request.messageTs ? `Slack message ${request.messageTs}` : `Slack conversation ${request.channelId}`),
		contentType: 'application/vnd.bugfixer.slack-source+json', content: encodeSourceArtifact(artifacts),
		derivedText: new TextDecoder().decode(encodeReferenceText(`${body}${displayedOmissions.length ? `\n\nImport notes: ${displayedOmissions.join(' ')}` : ''}`, omissions)),
		omissions: boundedOmissions(omissions),
	};
}
