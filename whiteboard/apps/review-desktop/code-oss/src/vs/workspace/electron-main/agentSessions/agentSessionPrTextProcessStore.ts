/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { isAbsolute } from 'node:path';

export interface AgentSessionPrTextOwnedProcessReceipt {
	readonly requestId: string;
	readonly attemptId: string;
	readonly pgid: number;
	readonly nodeExecutable: string;
	readonly helperScript: string;
	readonly socketPath: string;
	readonly nonce: string;
	readonly recordedAt: string;
}

export interface AgentSessionPrTextCleanupReceipt {
	readonly requestId: string;
	readonly attemptId: string;
	readonly pgid: number;
	readonly nonce: string;
	readonly verifiedAt: string;
}

interface OwnedProcessRow extends Readonly<Record<string, SQLOutputValue>> {
	request_id: SQLOutputValue; attempt_id: SQLOutputValue; pgid: SQLOutputValue;
	node_executable: SQLOutputValue; helper_script: SQLOutputValue; socket_path: SQLOutputValue;
	nonce: SQLOutputValue; recorded_at: SQLOutputValue;
}

interface CleanupRow extends Readonly<Record<string, SQLOutputValue>> {
	request_id: SQLOutputValue; attempt_id: SQLOutputValue; pgid: SQLOutputValue;
	nonce: SQLOutputValue; verified_at: SQLOutputValue;
}

/** Durable owner-process identity for PR text runs. The central workspace migration owns its SQL. */
export class AgentSessionPrTextProcessStore {
	constructor(private readonly db: DatabaseSync) { }

	recordOwnedProcess(receipt: AgentSessionPrTextOwnedProcessReceipt): AgentSessionPrTextOwnedProcessReceipt {
		this.validateOwnedProcess(receipt);
		const existing = this.getOwnedProcess(receipt.requestId, receipt.attemptId);
		if (existing) {
			if (!sameOwnedProcess(existing, receipt)) { throw new Error('A conflicting PR text process receipt already exists for this attempt.'); }
			return existing;
		}
		this.db.prepare(`INSERT INTO agent_session_pr_text_owned_processes
			(request_id, attempt_id, pgid, node_executable, helper_script, socket_path, nonce, recorded_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(receipt.requestId, receipt.attemptId, receipt.pgid,
			receipt.nodeExecutable, receipt.helperScript, receipt.socketPath, receipt.nonce, receipt.recordedAt);
		const persisted = this.getOwnedProcess(receipt.requestId, receipt.attemptId);
		if (!persisted || !sameOwnedProcess(persisted, receipt)) { throw new Error('The PR text process receipt could not be verified after persistence.'); }
		return persisted;
	}

	getOwnedProcess(requestId: string, attemptId: string): AgentSessionPrTextOwnedProcessReceipt | undefined {
		const row = this.db.prepare(`SELECT request_id, attempt_id, pgid, node_executable, helper_script, socket_path, nonce, recorded_at
			FROM agent_session_pr_text_owned_processes WHERE request_id = ? AND attempt_id = ?`).get(requestId, attemptId) as OwnedProcessRow | undefined;
		return row ? this.ownedProcessFromRow(row) : undefined;
	}

	listUnverified(): readonly AgentSessionPrTextOwnedProcessReceipt[] {
		const rows = this.db.prepare(`SELECT p.request_id, p.attempt_id, p.pgid, p.node_executable, p.helper_script, p.socket_path, p.nonce, p.recorded_at
			FROM agent_session_pr_text_owned_processes p
			LEFT JOIN agent_session_pr_text_process_cleanup_receipts c ON c.request_id = p.request_id AND c.attempt_id = p.attempt_id
			WHERE c.request_id IS NULL ORDER BY p.recorded_at, p.request_id, p.attempt_id`).all() as OwnedProcessRow[];
		return rows.map(row => this.ownedProcessFromRow(row));
	}

	listCleanupVerified(after?: { readonly requestId: string; readonly attemptId: string }, limit = 100): readonly AgentSessionPrTextOwnedProcessReceipt[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (after && (!isUuid(after.requestId) || !isUuid(after.attemptId)))) {
			throw new Error('The PR text cleanup page is invalid.');
		}
		const rows = this.db.prepare(`SELECT p.request_id, p.attempt_id, p.pgid, p.node_executable, p.helper_script, p.socket_path, p.nonce, p.recorded_at
			FROM agent_session_pr_text_owned_processes p
			JOIN agent_session_pr_text_process_cleanup_receipts c ON c.request_id = p.request_id AND c.attempt_id = p.attempt_id
			WHERE p.request_id > ? OR (p.request_id = ? AND p.attempt_id > ?)
			ORDER BY p.request_id, p.attempt_id LIMIT ?`).all(after?.requestId ?? '', after?.requestId ?? '', after?.attemptId ?? '', limit) as OwnedProcessRow[];
		return rows.map(row => this.ownedProcessFromRow(row));
	}

	markCleanupVerified(input: { readonly requestId: string; readonly attemptId: string; readonly pgid: number; readonly nonce: string }): AgentSessionPrTextCleanupReceipt {
		this.validateIdentity(input);
		const process = this.getOwnedProcess(input.requestId, input.attemptId);
		if (!process || process.pgid !== input.pgid || process.nonce !== input.nonce) { throw new Error('The cleanup receipt does not match the durable PR text process identity.'); }
		const existing = this.getCleanupReceipt(input.requestId, input.attemptId);
		if (existing) {
			if (existing.pgid !== input.pgid || existing.nonce !== input.nonce) {
				throw new Error('A conflicting PR text cleanup receipt already exists for this attempt.');
			}
			return existing;
		}
		const receipt: AgentSessionPrTextCleanupReceipt = { requestId: input.requestId, attemptId: input.attemptId, pgid: input.pgid, nonce: input.nonce,
			verifiedAt: new Date().toISOString() };
		this.db.prepare(`INSERT INTO agent_session_pr_text_process_cleanup_receipts
			(request_id, attempt_id, pgid, nonce, verified_at) VALUES (?, ?, ?, ?, ?)`)
			.run(receipt.requestId, receipt.attemptId, receipt.pgid, receipt.nonce, receipt.verifiedAt);
		const persisted = this.getCleanupReceipt(input.requestId, input.attemptId);
		if (!persisted || persisted.pgid !== receipt.pgid || persisted.nonce !== receipt.nonce) {
			throw new Error('The PR text cleanup receipt could not be verified after persistence.');
		}
		return persisted;
	}

	getCleanupReceipt(requestId: string, attemptId: string): AgentSessionPrTextCleanupReceipt | undefined {
		const row = this.db.prepare(`SELECT request_id, attempt_id, pgid, nonce, verified_at
			FROM agent_session_pr_text_process_cleanup_receipts WHERE request_id = ? AND attempt_id = ?`).get(requestId, attemptId) as CleanupRow | undefined;
		return row ? this.cleanupFromRow(row) : undefined;
	}

	private validateOwnedProcess(receipt: AgentSessionPrTextOwnedProcessReceipt): void {
		this.validateIdentity(receipt);
		if (!isAbsolute(receipt.nodeExecutable) || Buffer.byteLength(receipt.nodeExecutable) > 4096
			|| !isAbsolute(receipt.helperScript) || Buffer.byteLength(receipt.helperScript) > 4096
			|| !isAbsolute(receipt.socketPath) || Buffer.byteLength(receipt.socketPath) > 103
			|| !Number.isFinite(Date.parse(receipt.recordedAt))) {
			throw new Error('The PR text owned-process receipt is invalid.');
		}
	}

	private validateIdentity(input: { readonly requestId: string; readonly attemptId: string; readonly pgid: number; readonly nonce: string }): void {
		if (!isUuid(input.requestId) || !isUuid(input.attemptId) || !Number.isSafeInteger(input.pgid) || input.pgid < 1 || !/^[a-f0-9]{64}$/u.test(input.nonce)) {
			throw new Error('The PR text process identity is invalid.');
		}
	}

	private ownedProcessFromRow(row: OwnedProcessRow): AgentSessionPrTextOwnedProcessReceipt {
		return { requestId: requiredString(row.request_id), attemptId: requiredString(row.attempt_id), pgid: requiredNumber(row.pgid),
			nodeExecutable: requiredString(row.node_executable), helperScript: requiredString(row.helper_script), socketPath: requiredString(row.socket_path),
			nonce: requiredString(row.nonce), recordedAt: requiredString(row.recorded_at) };
	}

	private cleanupFromRow(row: CleanupRow): AgentSessionPrTextCleanupReceipt {
		return { requestId: requiredString(row.request_id), attemptId: requiredString(row.attempt_id), pgid: requiredNumber(row.pgid), nonce: requiredString(row.nonce),
			verifiedAt: requiredString(row.verified_at) };
	}
}

function sameOwnedProcess(left: AgentSessionPrTextOwnedProcessReceipt, right: AgentSessionPrTextOwnedProcessReceipt): boolean {
	return left.requestId === right.requestId && left.attemptId === right.attemptId && left.pgid === right.pgid
		&& left.nodeExecutable === right.nodeExecutable && left.helperScript === right.helperScript && left.socketPath === right.socketPath
		&& left.nonce === right.nonce;
}

function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }
function requiredString(value: SQLOutputValue): string { if (typeof value !== 'string') { throw new Error('Invalid PR text process record in SQLite.'); } return value; }
function requiredNumber(value: SQLOutputValue): number { if (typeof value !== 'number' || !Number.isSafeInteger(value)) { throw new Error('Invalid PR text process record in SQLite.'); } return value; }
