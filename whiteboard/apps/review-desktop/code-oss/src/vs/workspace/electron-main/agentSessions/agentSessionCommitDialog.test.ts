/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCommitDialogValue } from './agentSessionCommitDialog.js';

test('commit dialog formatting distinguishes controls, backslashes, and bidirectional text', () => {
	assert.notEqual(formatCommitDialogValue('line\nbreak'), formatCommitDialogValue('line break'));
	assert.notEqual(formatCommitDialogValue('literal\\n'), formatCommitDialogValue('literal\n'));
	assert.match(formatCommitDialogValue('tab\tvalue'), /\\t/u);
	assert.match(formatCommitDialogValue('C1\u0085value'), /\\u0085/u);
	assert.match(formatCommitDialogValue('bidi\u202evalue'), /\\u202e/u);
	assert.match(formatCommitDialogValue('bidi\u061c\u200e\u200fvalue'), /\\u061c\\u200e\\u200f/u);
	assert.match(formatCommitDialogValue('line\u2028separator'), /\\u2028/u);
});
