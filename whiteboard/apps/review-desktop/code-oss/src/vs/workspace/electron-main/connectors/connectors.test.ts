/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { importNotionPage } from './notion.js';
import { importSlackConversation } from './slack.js';
import { retryAfterGuidance } from './types.js';
import type { ConnectorCredentialResolver, ConnectorTransport } from './types.js';

const resolver: ConnectorCredentialResolver = { resolve: async () => 'test-secret-token' };

test('Slack import uses the official GET endpoint, keeps credentials out of the URL, and labels truncated history', async () => {
	const requests: Array<{ url: URL; init?: RequestInit }> = [];
	const transport: ConnectorTransport = {
		fetch: async (input, init) => {
			const url = new URL(String(input));
			requests.push({ url, init });
			return Response.json({
				ok: true,
				messages: [{ ts: '123.2', user: 'U123', text: 'latest' }],
				has_more: true,
				response_metadata: { next_cursor: 'next-page' },
			});
		},
	};
	const result = await importSlackConversation({ channelId: 'C1234', accountRef: 'workspace_1' }, resolver, transport);
	assert.equal(requests.length, 20);
	assert.equal(requests[0].url.origin, 'https://slack.com');
	assert.equal(requests[0].url.pathname, '/api/conversations.history');
	assert.equal(requests[0].init?.method, 'GET');
	assert.equal(requests[0].url.searchParams.has('token'), false);
	assert.equal((requests[0].init?.headers as Record<string, string>).Authorization, 'Bearer test-secret-token');
	assert.equal(result.externalId, 'C1234');
	assert.deepEqual(result.omissions, ['Slack history reached the 20 page limit; older messages may be unavailable.']);
	assert.match(result.derivedText, /latest/);
	assert.equal(result.contentType, 'application/vnd.bugfixer.slack-source+json');
	const artifact = JSON.parse(new TextDecoder().decode(result.content)) as Array<{ responseBase64: string }>;
	assert.equal(Buffer.from(artifact[0].responseBase64, 'base64').toString(), JSON.stringify({ ok: true, messages: [{ ts: '123.2', user: 'U123', text: 'latest' }], has_more: true, response_metadata: { next_cursor: 'next-page' } }));
	assert.equal(requests.some(request => request.url.toString().includes('test-secret-token')), false);
});

test('Notion import walks page blocks with the pinned API version and caps pagination', async () => {
	const requests: Array<{ url: URL; init?: RequestInit }> = [];
	const transport: ConnectorTransport = {
		fetch: async (input, init) => {
			const url = new URL(String(input));
			requests.push({ url, init });
			if (url.pathname.endsWith('/children')) {
				return Response.json({
					results: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type: 'paragraph', has_children: false, paragraph: { rich_text: [{ plain_text: 'A useful note' }] } }],
					has_more: true, next_cursor: 'next',
				});
			}
			return Response.json({ object: 'page', properties: { Name: { type: 'title', title: [{ plain_text: 'Project notes' }] } } });
		},
	};
	const result = await importNotionPage({ pageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', accountRef: 'notion_account' }, resolver, transport);
	assert.equal(requests.length, 21);
	assert.ok(requests.every(({ url }) => url.origin === 'https://api.notion.com'));
	assert.ok(requests.every(({ init }) => (init?.headers as Record<string, string>)['Notion-Version'] === '2026-03-11'));
	assert.equal(requests.some(({ url }) => url.toString().includes('test-secret-token')), false);
	assert.equal(result.title, 'Project notes');
	assert.match(result.derivedText, /A useful note/);
	assert.equal(result.contentType, 'application/vnd.bugfixer.notion-source+json');
	assert.deepEqual(result.omissions, ['Page content was truncated at the 400 block, 20 page, or nesting-depth limit.']);
});

test('Notion renders non-title properties, caption links, and equations and reports hidden relation and media payloads', async () => {
	const transport: ConnectorTransport = { fetch: async input => {
		const url = new URL(String(input));
		if (url.pathname.endsWith('/children')) {
			return Response.json({ results: [
				{ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', type: 'image', has_children: false, image: { caption: [{ plain_text: 'Reference image', href: 'https://example.com/image-info' }], external: { url: 'https://cdn.example.com/private-image' } } },
				{ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', type: 'equation', has_children: false, equation: { expression: 'x + y = 2' } },
			], has_more: false });
		}
		return Response.json({ object: 'page', properties: {
			Name: { type: 'title', title: [{ plain_text: 'Research notes' }] },
			Source: { type: 'url', url: 'https://example.com/research' },
			Priority: { type: 'select', select: { name: 'High' } },
			Related: { type: 'relation', relation: [{ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }] },
		} });
	} };
	const result = await importNotionPage({ pageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', accountRef: 'notion_account' }, resolver, transport);
	assert.match(result.derivedText, /Source: https:\/\/example\.com\/research/);
	assert.match(result.derivedText, /Priority: High/);
	assert.match(result.derivedText, /https:\/\/example\.com\/image-info/);
	assert.match(result.derivedText, /x \+ y = 2/);
	assert.doesNotMatch(result.derivedText, /private-image/);
	assert.ok(result.omissions.some(item => /relation property.*full linked content/.test(item)));
	assert.ok(result.omissions.some(item => /image payload.*caption/.test(item)));
});

test('Slack selected message follows bounded thread cursors and retains reply context', async () => {
	const requests: URL[] = [];
	const transport: ConnectorTransport = { fetch: async input => {
		const url = new URL(String(input));
		requests.push(url);
		const value = url.searchParams.has('cursor')
			? { ok: true, messages: [{ ts: '170.2', thread_ts: '170.1', user: 'U2', text: 'reply' }], has_more: false }
			: { ok: true, messages: [{ ts: '170.1', user: 'U1', text: 'parent', reply_count: 2 }], has_more: true, response_metadata: { next_cursor: 'next' } };
		return Response.json(value);
	} };
	const result = await importSlackConversation({ channelId: 'C1234', accountRef: 'workspace_1', messageTs: '170.1' }, resolver, transport);
	assert.equal(requests.length, 2);
	assert.equal(requests[0].pathname, '/api/conversations.replies');
	assert.equal(requests[0].searchParams.get('ts'), '170.1');
	assert.equal(requests[1].searchParams.get('cursor'), 'next');
	assert.equal(result.externalId, 'C1234:170.1');
	assert.match(result.derivedText, /170\.2 \(reply to 170\.1\).*reply/);
	const [artifact] = JSON.parse(new TextDecoder().decode(result.content)) as Array<{ responseBase64: string }>;
	assert.equal(Buffer.from(artifact.responseBase64, 'base64').toString(), JSON.stringify({ ok: true, messages: [{ ts: '170.1', user: 'U1', text: 'parent', reply_count: 2 }], has_more: true, response_metadata: { next_cursor: 'next' } }));
});

test('Slack fetches available threads after history reaches its page cap', async () => {
	const requests: URL[] = [];
	let historyPages = 0;
	const transport: ConnectorTransport = { fetch: async input => {
		const url = new URL(String(input));
		requests.push(url);
		if (url.pathname.endsWith('/conversations.history')) {
			historyPages++;
			const messages = historyPages === 1 ? [
				{ ts: '10.1', user: 'U1', text: 'one', reply_count: 1 },
				{ ts: '20.1', user: 'U2', text: 'two', reply_count: 1 },
			] : [];
			return Response.json({ ok: true, messages, has_more: true, response_metadata: { next_cursor: `history-${historyPages}` } });
		}
		const ts = url.searchParams.get('ts');
		return Response.json({ ok: true, messages: [{ ts, user: 'U1', text: 'parent', reply_count: 1 }, { ts: `${ts}5`, thread_ts: ts, user: 'U3', text: `reply-${ts}` }], has_more: false });
	} };
	const result = await importSlackConversation({ channelId: 'C1234', accountRef: 'workspace_1' }, resolver, transport);
	assert.equal(historyPages, 20);
	assert.deepEqual(requests.filter(url => url.pathname.endsWith('/conversations.replies')).map(url => url.searchParams.get('ts')), ['10.1', '20.1']);
	assert.match(result.derivedText, /reply-10\.1/);
	assert.match(result.derivedText, /reply-20\.1/);
	assert.ok(result.omissions.some(omission => /history reached the 20 page limit/.test(omission)));
});

test('Slack derived text includes a visible marker when it is clipped at the display limit', async () => {
	const transport: ConnectorTransport = { fetch: async () => Response.json({ ok: true, messages: [{ ts: '1.1', text: 'x'.repeat(1_100_000) }], has_more: false }) };
	const result = await importSlackConversation({ channelId: 'C1234', accountRef: 'workspace_1' }, resolver, transport);
	assert.ok(Buffer.byteLength(result.derivedText, 'utf8') <= 1024 * 1024);
	assert.match(result.derivedText, /Extracted text clipped at the 1 MiB limit/);
	assert.ok(result.omissions.some(omission => /Content truncated at the 1 MiB/.test(omission)));
});

test('Retry-After guidance accepts seconds and HTTP dates and bounds invalid or excessive values', () => {
	const now = Date.UTC(2026, 8, 27, 12, 0, 0);
	assert.equal(retryAfterGuidance('60', now), 'Retry after 60 seconds.');
	assert.equal(retryAfterGuidance(new Date(now + 61_000).toUTCString(), now), 'Retry after 61 seconds.');
	assert.equal(retryAfterGuidance(new Date(now - 1_000).toUTCString(), now), 'Retry now.');
	assert.equal(retryAfterGuidance('not a date', now), 'Retry the import later.');
	assert.equal(retryAfterGuidance(null, now), 'Retry the import later.');
	assert.equal(retryAfterGuidance('86401', now), 'Retry after more than 24 hours.');
	assert.equal(retryAfterGuidance('999999999999999999999999', now), 'Retry after more than 24 hours.');
});

test('Slack rate limits expose Retry-After guidance in the import error', async () => {
	const transport: ConnectorTransport = { fetch: async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } }) };
	await assert.rejects(importSlackConversation({ channelId: 'C1234', accountRef: 'workspace_1' }, resolver, transport), /Slack rate limit reached\. Retry after 60 seconds\./);
});

test('Notion page and block rate limits expose Retry-After guidance in the import error', async () => {
	const pageRateLimit: ConnectorTransport = { fetch: async () => new Response('rate limited', {
		status: 429, headers: { 'retry-after': new Date(Date.now() + 90_000).toUTCString() },
	}) };
	await assert.rejects(importNotionPage({ pageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', accountRef: 'notion_account' }, resolver, pageRateLimit), /Notion rate limit reached\. Retry after (?:[89]\d|90) seconds\./);

	const blockRateLimit: ConnectorTransport = { fetch: async input => {
		const url = new URL(String(input));
		if (url.pathname.endsWith('/children')) {
			return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
		}
		return Response.json({ object: 'page', properties: { Name: { type: 'title', title: [{ plain_text: 'Page' }] } } });
	} };
	await assert.rejects(importNotionPage({ pageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', accountRef: 'notion_account' }, resolver, blockRateLimit), /Notion rate limit reached\. Retry after 120 seconds\./);
});

test('Notion reports rejected credentials as reconnectable and leaves page-specific 403 errors distinct', async () => {
	const resolver: ConnectorCredentialResolver = { resolve: async () => 'notion-pat' };
	const unauthorized: ConnectorTransport = { fetch: async () => new Response('{}', { status: 401 }) };
	const forbidden: ConnectorTransport = { fetch: async () => new Response('{}', { status: 403 }) };
	const request = { pageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', accountRef: 'notion_account' };
	await assert.rejects(importNotionPage(request, resolver, unauthorized), /token was rejected.*expired or been revoked.*reconnect with a new personal access token/i);
	await assert.rejects(importNotionPage(request, resolver, forbidden), /HTTP 403/);
});

test('connector source IDs and opaque account references are validated before network access', async () => {
	let called = false;
	const transport: ConnectorTransport = { fetch: async () => { called = true; return Response.json({}); } };
	await assert.rejects(importSlackConversation({ channelId: 'https://attacker.example', accountRef: 'workspace_1' }, resolver, transport), /conversation ID/);
	await assert.rejects(importNotionPage({ pageId: '../other', accountRef: 'notion_account' }, resolver, transport), /Notion page or block ID/);
	await assert.rejects(importSlackConversation({ channelId: 'C1234', accountRef: 'token value' }, resolver, transport), /opaque connector account reference/);
	assert.equal(called, false);
});

test('connector validation uses official fixed endpoints and returns only remote identity and display label', async () => {
	const requests: Array<{ url: URL; init?: RequestInit }> = [];
	const transport: ConnectorTransport = {
		fetch: async (input, init) => {
			const url = new URL(String(input));
			requests.push({ url, init });
			return url.pathname.endsWith('/auth.test')
				? Response.json({ ok: true, team_id: 'T123456', user_id: 'U123456', team: 'Example Workspace', user: 'Example User', token: 'should not escape' })
				: Response.json({ object: 'user', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type: 'bot', name: 'Local Notion Bot', person: { email: 'not-returned@example.com' } });
		},
	};
	const { validateNotionToken, validateSlackToken } = await import('./validation.js');
	const slack = await validateSlackToken('test-secret-token', transport);
	const notion = await validateNotionToken('test-secret-token', transport);
	assert.deepEqual(slack, { remoteId: 'slack:T123456:U123456', label: 'Example User · Example Workspace' });
	assert.deepEqual(notion, { remoteId: 'notion:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: 'Local Notion Bot' });
	assert.equal(requests[0].url.origin, 'https://slack.com');
	assert.equal(requests[0].url.pathname, '/api/auth.test');
	assert.equal(requests[0].init?.method, 'POST');
	assert.equal(requests[0].url.searchParams.has('token'), false);
	assert.equal(requests[1].url.origin, 'https://api.notion.com');
	assert.equal(requests[1].url.pathname, '/v1/users/me');
	assert.equal(requests[1].init?.method, 'GET');
	assert.equal((requests[1].init?.headers as Record<string, string>)['Notion-Version'], '2026-03-11');
	assert.equal(JSON.stringify([slack, notion]).includes('test-secret-token'), false);
	assert.equal(JSON.stringify([slack, notion]).includes('not-returned@example.com'), false);
});
