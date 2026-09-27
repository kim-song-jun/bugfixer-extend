/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNotionPageInput } from './notionPageInput.js';

const pageId = '01234567-89ab-cdef-0123-456789abcdef';

test('copied Notion page links and UUIDs resolve to the same page', () => {
	for (const input of [
		pageId,
		pageId.replace(/-/g, ''),
		`https://www.notion.so/Project-Notes-${pageId.replace(/-/g, '')}?pvs=4#section`,
		`https://team.notion.site/Project-Notes-${pageId.replace(/-/g, '')}`,
		`https://app.notion.com/p/${pageId}`,
	]) {
		assert.equal(parseNotionPageInput(input), pageId, input);
	}
});

test('untrusted or ambiguous links cannot silently select a Notion page', () => {
	for (const input of [
		`https://notion.so.evil.example/Notes-${pageId.replace(/-/g, '')}`,
		`https://notion.so@evil.example/Notes-${pageId.replace(/-/g, '')}`,
		`https://user@notion.so/Notes-${pageId.replace(/-/g, '')}`,
		`https://notion.so:444/Notes-${pageId.replace(/-/g, '')}`,
		`http://www.notion.so/${pageId}`,
		`https://www.notion.so/Notes-${pageId.replace(/-/g, '')}/unrelated`,
		'https://www.notion.so/TASK-123',
		'not a Notion page',
		'https://notion.so/' + 'a'.repeat(4096),
	]) {
		assert.equal(parseNotionPageInput(input), undefined, input);
	}
});
