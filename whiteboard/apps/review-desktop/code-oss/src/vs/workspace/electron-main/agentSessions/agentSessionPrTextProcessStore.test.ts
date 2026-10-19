/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
// eslint-disable-next-line local/code-import-patterns
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentSessionPrTextProcessStore } from './agentSessionPrTextProcessStore.js';

const requestId = 'c9c9a637-0470-48b6-a347-b335bf44e9f6';
const attemptId = '18c78a79-a42a-4c59-a9d1-8354e4d6e3cd';
const nonce = 'd'.repeat(64);

function createDatabase(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec(`PRAGMA foreign_keys = ON;
	CREATE TABLE agent_session_pr_text_requests (id TEXT PRIMARY KEY NOT NULL) STRICT;
	INSERT INTO agent_session_pr_text_requests (id) VALUES ('${requestId}');
	CREATE TABLE agent_session_pr_text_owned_processes (
		request_id TEXT NOT NULL REFERENCES agent_session_pr_text_requests(id) ON DELETE RESTRICT,
		attempt_id TEXT NOT NULL,
		pgid INTEGER NOT NULL CHECK (pgid > 0),
		node_executable TEXT NOT NULL CHECK (length(CAST(node_executable AS BLOB)) BETWEEN 1 AND 4096),
		helper_script TEXT NOT NULL CHECK (length(CAST(helper_script AS BLOB)) BETWEEN 1 AND 4096),
		socket_path TEXT NOT NULL CHECK (length(CAST(socket_path AS BLOB)) BETWEEN 1 AND 103),
		nonce TEXT NOT NULL CHECK (length(nonce) = 64 AND nonce NOT GLOB '*[^0-9a-f]*'),
		recorded_at TEXT NOT NULL,
		PRIMARY KEY (request_id, attempt_id),
		UNIQUE (request_id, attempt_id, pgid, nonce)
	) STRICT;
	CREATE TRIGGER agent_session_pr_text_owned_process_immutable_update BEFORE UPDATE ON agent_session_pr_text_owned_processes
	BEGIN SELECT RAISE(ABORT, 'owned PR text process identity is immutable'); END;
	CREATE TRIGGER agent_session_pr_text_owned_process_immutable_delete BEFORE DELETE ON agent_session_pr_text_owned_processes
	BEGIN SELECT RAISE(ABORT, 'owned PR text process identity is immutable'); END;
	CREATE TABLE agent_session_pr_text_process_cleanup_receipts (
		request_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		pgid INTEGER NOT NULL CHECK (pgid > 0),
		nonce TEXT NOT NULL CHECK (length(nonce) = 64 AND nonce NOT GLOB '*[^0-9a-f]*'),
		verified_at TEXT NOT NULL,
		PRIMARY KEY (request_id, attempt_id),
		FOREIGN KEY (request_id, attempt_id, pgid, nonce) REFERENCES agent_session_pr_text_owned_processes(request_id, attempt_id, pgid, nonce) ON DELETE RESTRICT
	) STRICT;
	CREATE TRIGGER agent_session_pr_text_process_cleanup_immutable_update BEFORE UPDATE ON agent_session_pr_text_process_cleanup_receipts
	BEGIN SELECT RAISE(ABORT, 'PR text process cleanup receipts are immutable'); END;
	CREATE TRIGGER agent_session_pr_text_process_cleanup_immutable_delete BEFORE DELETE ON agent_session_pr_text_process_cleanup_receipts
	BEGIN SELECT RAISE(ABORT, 'PR text process cleanup receipts are immutable'); END;`);
	return db;
}

test('owned process recovery identity and verified cleanup survive a real SQLite reopen', () => {
	const directory = mkdtempSync(join(tmpdir(), 'pr-text-process-store-'));
	const path = join(directory, 'workspace.db');
	let db = createDatabase(path);
	try {
		const store = new AgentSessionPrTextProcessStore(db);
		const receipt = { requestId, attemptId, pgid: 41231, nodeExecutable: '/trusted/runtime/node', helperScript: '/trusted/runtime/provider-group-control.mjs',
			socketPath: join(directory, 'c.sock'), nonce, recordedAt: '2026-10-19T00:00:00.000Z' };
		assert.deepEqual(store.recordOwnedProcess(receipt), receipt);
		assert.deepEqual(store.recordOwnedProcess(receipt), receipt, 'identical retries are idempotent');
		assert.throws(() => store.recordOwnedProcess({ ...receipt, pgid: receipt.pgid + 1 }), /conflicting/u);
		db.close();
		db = new DatabaseSync(path);
		db.exec('PRAGMA foreign_keys = ON;');
		const reopened = new AgentSessionPrTextProcessStore(db);
		assert.deepEqual(reopened.listUnverified(), [receipt], 'restart can recover exact owner identity without the original process object');
		assert.deepEqual(reopened.listCleanupVerified(), [], 'unverified processes must never enter the leftover-directory cleanup page');
		assert.throws(() => reopened.markCleanupVerified({ requestId, attemptId, pgid: receipt.pgid, nonce: 'e'.repeat(64) }), /identity/u);
		const cleanup = reopened.markCleanupVerified({ requestId, attemptId, pgid: receipt.pgid, nonce });
		assert.equal(cleanup.pgid, receipt.pgid);
		assert.deepEqual(reopened.markCleanupVerified({ requestId, attemptId, pgid: receipt.pgid, nonce }), cleanup);
		assert.deepEqual(reopened.listUnverified(), []);
		assert.deepEqual(reopened.listCleanupVerified(undefined, 1), [receipt], 'verified receipts retain their exact private directory identity after restart');
		assert.deepEqual(reopened.listCleanupVerified(receipt), [], 'a cleanup cursor must not repeat a previous receipt');
		assert.throws(() => reopened.listCleanupVerified(undefined, 101), /page/u);
		assert.throws(() => db.prepare('UPDATE agent_session_pr_text_owned_processes SET pgid = 1 WHERE request_id = ?').run(requestId), /immutable/u);
	} finally {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
