/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { importNotionPage } from './notion.js';
import { importSlackConversation } from './slack.js';
import type { ConnectorCredentialResolver, ConnectorTransport } from './types.js';
import { validateNotionToken, validateSlackToken } from './validation.js';

test('every token-bearing Slack and Notion request rejects HTTP redirects', async () => {
	let requests = 0;
	const transport: ConnectorTransport = {
		fetch: async (_input, init) => {
			requests++;
			assert.equal(init?.redirect, 'error');
			throw new TypeError('redirect blocked by the fetch transport');
		},
	};
	const credentials: ConnectorCredentialResolver = { resolve: async () => 'fixture-token' };
	const notionPageId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
	await assert.rejects(importSlackConversation({ channelId: 'C1234', accountRef: 'slack_account' }, credentials, transport), /redirect blocked/);
	await assert.rejects(importNotionPage({ pageId: notionPageId, accountRef: 'notion_account' }, credentials, transport), /redirect blocked/);
	await assert.rejects(validateSlackToken('fixture-token', transport), /redirect blocked/);
	await assert.rejects(validateNotionToken('fixture-token', transport), /redirect blocked/);
	assert.equal(requests, 4);
});
