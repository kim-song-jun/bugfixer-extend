/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebContents } from 'electron';
import { ReviewDesktopChannel } from './reviewDesktopChannel.js';

test('renderer IPC cannot read control events or post control results', async () => {
	const sender = {} as WebContents;
	const channel = new ReviewDesktopChannel({
		whenConnected: () => { throw new Error('control attempt reached host'); },
	} as never, candidate => candidate === sender);
	await assert.rejects(channel.call(sender, 'streamStart', { path: '/control' }), /not allowed/);
	await assert.rejects(channel.call(sender, 'request', { path: '/control/result', method: 'POST', body: { id: 'fake', response: { ok: true } } }), /main-process-only/);
});
