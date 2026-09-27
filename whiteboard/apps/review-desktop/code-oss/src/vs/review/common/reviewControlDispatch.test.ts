/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { ReviewControlReceipt, reviewControlDestination, runReviewControlOpen } from './reviewControlDispatch.js';

suite('Review control receipt', () => {
	test('routes a single owner directly and requires selection for zero or multiple owners', () => {
		assert.deepEqual(reviewControlDestination(['project-a']), { kind: 'project', projectId: 'project-a' });
		assert.deepEqual(reviewControlDestination([]), { kind: 'choose', projectIds: [] });
		assert.deepEqual(reviewControlDestination(['project-a', 'project-b']), { kind: 'choose', projectIds: ['project-a', 'project-b'] });
	});
	test('accepts only the selected live sender and request generation', async () => {
		const receipts = new ReviewControlReceipt<object>();
		const selected = {};
		const unrelated = {};
		const waiting = receipts.wait('request-1', selected, 4);
		assert.equal(receipts.ack(unrelated, { id: 'request-1', generation: 4, response: { ok: true } }), false);
		assert.equal(receipts.ack(selected, { id: 'request-1', generation: 3, response: { ok: true } }), false);
		assert.equal(receipts.ack(selected, { id: 'request-1', generation: 4, response: { ok: false } }), false);
		assert.equal(receipts.ack(selected, { id: 'request-1', generation: 4, response: { ok: true } }), true);
		assert.deepEqual(await waiting, { ok: true });
		assert.equal(receipts.ack(selected, { id: 'request-1', generation: 4, response: { ok: true } }), false);
		receipts.dispose();
	});

	test('cancels on window reload or deadline and rejects late receipts', async () => {
		const receipts = new ReviewControlReceipt<object>();
		const selected = {};
		const reloaded = receipts.wait('request-2', selected, 5);
		receipts.cancelTarget(selected, 'window reloaded');
		await assert.rejects(reloaded, /window reloaded/);
		assert.equal(receipts.ack(selected, { id: 'request-2', generation: 5, response: { ok: true } }), false);
		const timedOut = receipts.wait('request-3', selected, 6, 1);
		await assert.rejects(timedOut, /did not acknowledge/);
		assert.equal(receipts.ack(selected, { id: 'request-3', generation: 6, response: { ok: true } }), false);
		receipts.dispose();
	});

	test('closes a tab after a cancelled editor open settles and clears request ownership', async () => {
		const latest = new Map<string, string>();
		let finishOpen!: () => void;
		let cancelled = false;
		let closed = 0;
		const opened = runReviewControlOpen('request-4', 'api:review-a', latest, () => cancelled,
			() => new Promise<void>(resolve => { finishOpen = resolve; }),
			async () => { closed++; },
			() => true);
		cancelled = true;
		finishOpen();
		assert.equal(await opened, false);
		assert.equal(closed, 1);
		assert.equal(latest.size, 0);
	});

	test('an older cancelled request does not close the tab owned by a newer request', async () => {
		const latest = new Map<string, string>();
		let finishOpen!: () => void;
		let closed = 0;
		const opened = runReviewControlOpen('old', 'api:review-a', latest, () => true,
			() => new Promise<void>(resolve => { finishOpen = resolve; }),
			async () => { closed++; },
			() => true);
		latest.set('api:review-a', 'new');
		finishOpen();
		assert.equal(await opened, false);
		assert.equal(closed, 0);
		assert.equal(latest.get('api:review-a'), 'new');
	});

	test('keeps a cancelled tab that was opened again by the user', async () => {
		const latest = new Map<string, string>();
		let finishOpen!: () => void;
		let closed = 0;
		let matchingOpens = 1;
		const opened = runReviewControlOpen('request-5', 'api:review-a', latest, () => true,
			() => new Promise<void>(resolve => { finishOpen = resolve; }),
			async () => { closed++; },
			() => matchingOpens === 1);
		matchingOpens = 2;
		finishOpen();
		assert.equal(await opened, false);
		assert.equal(closed, 0);
		assert.equal(latest.size, 0);
	});
});
