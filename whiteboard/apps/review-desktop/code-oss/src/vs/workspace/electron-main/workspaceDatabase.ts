/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'module';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { WorkspaceKnowledgeStore } from './workspaceKnowledgeStore.js';
import { validateDeclarativePackage } from './connectors/declarativePackage.js';
import type { WorkspaceE2eStep } from '../common/workspaceE2eProtocol.js';

const nodeRequire = createRequire(import.meta.url);

function loadSqlite(): typeof import('node:sqlite') {
	return nodeRequire('node:sqlite') as typeof import('node:sqlite');
}

export type TaskState = 'ready' | 'inProgress' | 'review' | 'done';
export type VcsKind = 'git' | 'jj';
export type ReviewOutboxStatus = 'pending' | 'complete' | 'failed';
export type ProviderKind = 'codex' | 'claude';
export type ProviderAttemptPurpose = 'connectionTest' | 'task';
export type ProviderAttemptState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface ProviderAttempt {
	readonly attemptId: string;
	readonly taskId: string;
	readonly provider: ProviderKind;
	readonly purpose: ProviderAttemptPurpose;
	readonly profileRef: string | null;
	readonly folderIdentity: string;
	readonly cwd: string;
	readonly mode: string;
	readonly prompt: string;
	readonly promptHash: string;
	readonly conventionSnapshotId: string | null;
	readonly refSnapshotId: string | null;
	readonly refSnapshotIds: readonly string[];
	readonly state: ProviderAttemptState;
	readonly providerSessionId: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
	readonly errorSummary: string | null;
	readonly cleanupVerified: boolean;
	readonly ownedPgid: number | null;
	readonly launchGateVersion: 1 | null;
	readonly parentAttemptId: string | null;
	readonly childScope: string | null;
	readonly resultText: string | null;
	readonly resultSha256: string | null;
	readonly orchestrationPhase: 'preflight' | 'waiting' | null;
	readonly runningTaskRevision: number | null;
}

export interface ProviderAttemptEvent {
	readonly eventId: number;
	readonly attemptId: string;
	readonly type: string;
	readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
	readonly createdAt: string;
}

export interface WorkspaceProject {
	readonly id: string;
	readonly name: string;
	readonly createdAt: string;
}

export interface WorkspaceFolderBinding {
	readonly id: string;
	readonly projectId: string;
	readonly path: string;
	readonly vcsKind: VcsKind | null;
	readonly vcsRoot: string | null;
	readonly reviewRepositoryId: string | null;
	readonly createdAt: string;
}

export interface FolderMutationGrant {
	readonly bindingId: string;
	readonly projectId: string;
	readonly canonicalPath: string;
	readonly dev: string;
	readonly ino: string;
	readonly grantedAt: string;
}

export interface ConnectorAccount {
	readonly id: string;
	readonly projectId: string;
	readonly provider: 'slack' | 'notion';
	readonly label: string;
	readonly remoteIdentity: string;
	readonly state: 'pending' | 'active' | 'disconnecting' | 'disconnected';
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface InstalledConnectorPackage {
	readonly projectId: string;
	readonly packageId: string;
	readonly version: string;
	readonly name: string;
	readonly fingerprint: string;
	readonly manifestDigest: string;
	readonly manifestBytesBase64: string;
	readonly signatureBase64: string;
	readonly publicKeyBase64: string;
	readonly installedAt: string;
	readonly updatedAt: string;
}

export interface WorkspaceTask {
	readonly id: string;
	readonly projectId: string;
	readonly bindingId: string;
	readonly title: string;
	readonly description: string | null;
	readonly state: TaskState;
	readonly order: number;
	readonly revision: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly archivedAt: string | null;
	readonly trashedAt: string | null;
	readonly deletionPendingAt: string | null;
	readonly deletionError: string | null;
	readonly deletionRequestId: string | null;
}

export interface TaskDeletionRequest {
	readonly requestId: string;
	readonly taskId: string;
	readonly priorState: TaskState;
	readonly status: 'pending' | 'complete';
	readonly cleanupError: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly completedAt: string | null;
}

export interface ReviewOutboxCommand {
	readonly commandId: string;
	readonly taskId: string;
	readonly body: string;
	readonly status: ReviewOutboxStatus;
	readonly lastError: string | null;
	readonly reviewId: string | null;
	readonly createdAt: string;
	readonly completedAt: string | null;
}

export interface TaskReviewLink {
	readonly taskId: string;
	readonly reviewId: string;
	readonly state: 'available' | 'unavailable';
	readonly isPrimary: boolean;
	readonly createdAt: string;
}

export interface ReferenceSnapshot {
	readonly id: string;
	readonly sourceId: string;
	readonly projectId: string;
	readonly connectorId: string;
	readonly connectorVersion: string;
	readonly externalId: string;
	readonly sourceUri: string | null;
	readonly accountRef: string | null;
	readonly version: number;
	readonly previousId: string | null;
	readonly title: string;
	readonly retrievedAt: string;
	readonly contentType: string;
	readonly contentSha256: string;
	readonly content: Uint8Array;
	readonly derivedText: string;
	readonly omissions: readonly string[];
}

export interface ConventionVersion {
	readonly id: string;
	readonly projectId: string;
	readonly version: number;
	readonly markdown: string;
	readonly sourceSnapshotIds: readonly string[];
	readonly authoredBy: 'person' | 'codex' | 'claude';
	readonly authorAttemptId: string | null;
	readonly createdAt: string;
	readonly active: boolean;
	readonly lastAppliedAt: string | null;
}

export interface ConventionCheck {
	readonly id: string;
	readonly versionId: string;
	readonly provider: ProviderKind;
	readonly attemptId: string;
	readonly verdict: 'pass' | 'concerns' | 'fail';
	readonly report: string;
	readonly checkedAt: string;
}

export interface ProjectView {
	readonly projectId: string;
	readonly descriptorUri: string;
	readonly openAtQuit: boolean;
	readonly selectedTaskId: string | null;
	readonly dashboardPosition: string | null;
}

export interface WorkspaceE2eEvidence {
	readonly id: string; readonly projectId: string; readonly taskId: string; readonly attemptId: string;
	readonly targetUrl: string; readonly environmentIdentity: string; readonly scenario: readonly WorkspaceE2eStep[];
	readonly checkoutSnapshot: string; readonly requesterSnapshot: string; readonly taskSpaceId: number;
	readonly state: 'running' | 'passed' | 'failed' | 'cancelled' | 'cleanupFailed';
	readonly screenshotSha256: string | null; readonly screenshotPath: string | null;
	readonly logSha256: string | null; readonly logPath: string | null;
	readonly failure: string | null; readonly cleanupError: string | null; readonly createdAt: string; readonly completedAt: string | null;
}

const maximumDashboardPositionPixels = 10_000_000;

export class TaskRevisionConflictError extends Error {
	constructor(readonly taskId: string, readonly expectedRevision: number) {
		super(`Task ${taskId} changed since revision ${expectedRevision}.`);
		this.name = 'TaskRevisionConflictError';
	}
}

export class TaskSetRevisionConflictError extends Error {
	constructor(readonly projectId: string, readonly state: TaskState) {
		super(`The ${state} task set for project ${projectId} changed before reorder.`);
		this.name = 'TaskSetRevisionConflictError';
	}
}

export class TaskHasActiveRunsError extends Error {
	constructor(readonly taskId: string, action: 'archive' | 'trash') {
		super(action === 'trash'
			? `Task ${taskId} cannot enter Trash while it has queued or running attempts.`
			: `Task ${taskId} cannot be archived while it has queued or running attempts.`);
		this.name = 'TaskHasActiveRunsError';
	}
}

export class TaskCleanupNotVerifiedError extends Error {
	constructor(readonly taskId: string, readonly attemptId: string, action: 'archive' | 'trash') {
		super(`Task ${taskId} cannot be ${action === 'trash' ? 'moved to Trash' : 'archived'} until cleanup is verified for attempt ${attemptId}.`);
		this.name = 'TaskCleanupNotVerifiedError';
	}
}

export class TaskLifecycleConflictError extends Error {
	constructor(readonly taskId: string, readonly expectedRevision: number) {
		super(`Task ${taskId} changed since revision ${expectedRevision}.`);
		this.name = 'TaskLifecycleConflictError';
	}
}

export class ReviewCommandConflictError extends Error {
	constructor(readonly commandId: string) {
		super(`Review command ${commandId} already exists with different content.`);
		this.name = 'ReviewCommandConflictError';
	}
}

export class ReviewCompletionConflictError extends Error {
	constructor(readonly commandId: string) {
		super(`Review command ${commandId} was already completed with a different review ID.`);
		this.name = 'ReviewCompletionConflictError';
	}
}

const schemaVersion = 16;
const providerEventTypes = new Set([
	'session.started', 'turn.started', 'item.started', 'item.updated', 'item.completed',
	'turn.completed', 'turn.failed', 'error', 'ordinaryFolderInventoryStarted', 'ordinaryFolderChanges',
]);

/** Main-process-only durable storage for one app profile's project workspace data. */
export class WorkspaceDatabase {
	private closed = false;
	readonly knowledge: WorkspaceKnowledgeStore;

	private constructor(private readonly db: DatabaseSync) {
		this.knowledge = new WorkspaceKnowledgeStore(db, () => this.assertOpen());
	}

	static open(path: string): WorkspaceDatabase {
		const { DatabaseSync: DatabaseSyncConstructor } = loadSqlite();
		const db = new DatabaseSyncConstructor(path);
		try {
			db.exec('PRAGMA foreign_keys = ON;');
			db.exec('PRAGMA busy_timeout = 5000;');
			if (path !== ':memory:') {
				db.exec('PRAGMA journal_mode = WAL;');
				db.exec('PRAGMA synchronous = FULL;');
			}
			db.exec('BEGIN EXCLUSIVE;');
			try {
				const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
				if (version > schemaVersion) {
					throw new Error(`workspace.db schema version ${version} is newer than supported version ${schemaVersion}.`);
				}
				if (version < 1) {
					WorkspaceDatabase.migrateV1(db);
				}
				if (version < 2) {
					WorkspaceDatabase.migrateV2(db);
				}
				if (version < 3) {
					WorkspaceDatabase.migrateV3(db);
				}
				if (version < 4) {
					WorkspaceDatabase.migrateV4(db);
				}
				if (version < 5) { WorkspaceDatabase.migrateV5(db); }
				if (version < 6) { WorkspaceDatabase.migrateV6(db); }
				if (version < 7) { WorkspaceDatabase.migrateV7(db); }
				if (version < 8) { WorkspaceDatabase.migrateV8(db); }
				if (version < 9) { WorkspaceDatabase.migrateV9(db); }
				if (version < 10) { WorkspaceDatabase.migrateV10(db); }
				if (version < 11) { WorkspaceDatabase.migrateV11(db); }
				if (version < 12) { WorkspaceDatabase.migrateV12(db); }
				if (version < 13) { WorkspaceDatabase.migrateV13(db); }
				if (version < 14) { WorkspaceDatabase.migrateV14(db); }
				if (version < 15) { WorkspaceDatabase.migrateV15(db); }
				if (version < 16) { WorkspaceDatabase.migrateV16(db); }
				db.exec('COMMIT;');
			} catch (error) {
				db.exec('ROLLBACK;');
				throw error;
			}
			const workspaceDatabase = new WorkspaceDatabase(db);
			workspaceDatabase.interruptLiveProviderAttempts();
			workspaceDatabase.reconcilePendingSubagentAttempts();
			return workspaceDatabase;
		} catch (error) {
			db.close();
			throw error;
		}
	}

	private static migrateV5(db: DatabaseSync): void {
		db.exec(`
			ALTER TABLE tasks ADD COLUMN delete_pending_at TEXT;
			ALTER TABLE tasks ADD COLUMN deletion_error TEXT;
			ALTER TABLE tasks ADD COLUMN delete_request_id TEXT;
			ALTER TABLE provider_attempts ADD COLUMN cleanup_verified INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_verified IN (0, 1));
			ALTER TABLE provider_attempts ADD COLUMN cleanup_verified_at TEXT;
			ALTER TABLE provider_attempts ADD COLUMN owned_pgid INTEGER;
			ALTER TABLE task_trash_requests RENAME TO task_trash_requests_v4;
			CREATE TABLE task_trash_requests (
				request_id TEXT PRIMARY KEY NOT NULL,
				task_id TEXT NOT NULL,
				prior_state TEXT NOT NULL CHECK (prior_state IN ('ready', 'inProgress', 'review', 'done')),
				status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
				cleanup_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				completed_at TEXT,
				FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
			) STRICT;
			INSERT INTO task_trash_requests (request_id, task_id, prior_state, status, cleanup_error, created_at, updated_at, completed_at)
				SELECT request_id, task_id, prior_state, 'complete', NULL, created_at, completed_at, completed_at FROM task_trash_requests_v4;
			DROP TABLE task_trash_requests_v4;
			UPDATE project_views SET selected_task_id = NULL WHERE selected_task_id IN (SELECT id FROM tasks WHERE archived_at IS NOT NULL OR trashed_at IS NOT NULL);
			CREATE TABLE task_delete_audit (
				audit_id INTEGER PRIMARY KEY,
				request_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				action TEXT NOT NULL CHECK (action IN ('pending', 'cleanupFailed', 'trashed')),
				from_revision INTEGER NOT NULL,
				to_revision INTEGER NOT NULL,
				cleanup_error TEXT,
				changed_at TEXT NOT NULL,
				FOREIGN KEY (request_id) REFERENCES task_trash_requests(request_id) ON DELETE RESTRICT,
				FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
			) STRICT;
			PRAGMA user_version = 5;
		`);
	}

	private static migrateV6(db: DatabaseSync): void {
		db.exec(`
			ALTER TABLE provider_attempts ADD COLUMN launch_gate_version INTEGER CHECK (launch_gate_version = 1 OR launch_gate_version IS NULL);
			PRAGMA user_version = 6;
		`);
	}

	private static migrateV7(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE reference_sources (
				id TEXT PRIMARY KEY NOT NULL,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				connector_id TEXT NOT NULL,
				external_id TEXT NOT NULL,
				account_ref TEXT NOT NULL,
				source_key TEXT NOT NULL,
				created_at TEXT NOT NULL,
				UNIQUE(project_id, source_key)
			) STRICT;
			CREATE TABLE reference_snapshots (
				id TEXT PRIMARY KEY NOT NULL,
				source_id TEXT NOT NULL REFERENCES reference_sources(id) ON DELETE RESTRICT,
				version INTEGER NOT NULL CHECK (version > 0),
				previous_id TEXT REFERENCES reference_snapshots(id) ON DELETE RESTRICT,
				connector_version TEXT NOT NULL,
				source_uri TEXT,
				title TEXT NOT NULL,
				retrieved_at TEXT NOT NULL,
				content_type TEXT NOT NULL,
				content_sha256 TEXT NOT NULL,
				content BLOB NOT NULL,
				omissions_json TEXT NOT NULL,
				UNIQUE(source_id, version)
			) STRICT;
			CREATE TRIGGER reference_snapshot_immutable BEFORE UPDATE ON reference_snapshots
			BEGIN SELECT RAISE(ABORT, 'reference snapshots are immutable'); END;
			CREATE TABLE task_reference_links (
				task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
				snapshot_id TEXT NOT NULL REFERENCES reference_snapshots(id) ON DELETE RESTRICT,
				attached_at TEXT NOT NULL,
				PRIMARY KEY(task_id, snapshot_id)
			) STRICT;
			PRAGMA user_version = 7;
		`);
	}

	private static migrateV8(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE convention_versions (
				id TEXT PRIMARY KEY NOT NULL,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				version INTEGER NOT NULL CHECK (version > 0),
				markdown TEXT NOT NULL,
				source_snapshot_ids_json TEXT NOT NULL,
				authored_by TEXT NOT NULL CHECK (authored_by IN ('person', 'codex', 'claude')),
				author_attempt_id TEXT REFERENCES provider_attempts(attempt_id) ON DELETE RESTRICT,
				created_at TEXT NOT NULL,
				UNIQUE(project_id, version)
			) STRICT;
			CREATE TRIGGER convention_version_immutable BEFORE UPDATE ON convention_versions
			BEGIN SELECT RAISE(ABORT, 'convention versions are immutable'); END;
			CREATE TABLE convention_checks (
				id TEXT PRIMARY KEY NOT NULL,
				version_id TEXT NOT NULL REFERENCES convention_versions(id) ON DELETE RESTRICT,
				provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
				attempt_id TEXT NOT NULL REFERENCES provider_attempts(attempt_id) ON DELETE RESTRICT,
				verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'concerns', 'fail')),
				report TEXT NOT NULL,
				checked_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE project_active_conventions (
				project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				version_id TEXT NOT NULL REFERENCES convention_versions(id) ON DELETE RESTRICT,
				applied_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE convention_apply_audit (
				id INTEGER PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				from_version_id TEXT REFERENCES convention_versions(id) ON DELETE RESTRICT,
				to_version_id TEXT NOT NULL REFERENCES convention_versions(id) ON DELETE RESTRICT,
				applied_at TEXT NOT NULL
			) STRICT;
			PRAGMA user_version = 8;
		`);
	}

	private static migrateV9(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE folder_mutation_grants (
				binding_id TEXT PRIMARY KEY NOT NULL REFERENCES folder_bindings(id) ON DELETE RESTRICT,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				canonical_path TEXT NOT NULL,
				dev TEXT NOT NULL,
				ino TEXT NOT NULL,
				granted_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE folder_mutation_grant_audit (
				id INTEGER PRIMARY KEY,
				binding_id TEXT NOT NULL REFERENCES folder_bindings(id) ON DELETE RESTRICT,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				action TEXT NOT NULL CHECK (action IN ('enabled', 'revoked', 'invalidated')),
				canonical_path TEXT NOT NULL,
				dev TEXT NOT NULL,
				ino TEXT NOT NULL,
				changed_at TEXT NOT NULL
			) STRICT;
			PRAGMA user_version = 9;
		`);
	}

	private static migrateV10(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE connector_accounts (
				id TEXT PRIMARY KEY NOT NULL,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				provider TEXT NOT NULL CHECK (provider IN ('slack', 'notion')),
				label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 200),
				remote_identity TEXT NOT NULL CHECK (length(remote_identity) BETWEEN 1 AND 512),
				state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'disconnecting', 'disconnected')),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT;
			CREATE INDEX connector_accounts_project_state ON connector_accounts(project_id, state, provider);
			PRAGMA user_version = 10;
		`);
	}

	private static migrateV11(db: DatabaseSync): void {
		db.exec(`
			ALTER TABLE provider_attempts ADD COLUMN ref_snapshot_ids_json TEXT NOT NULL DEFAULT '[]';
			UPDATE provider_attempts SET ref_snapshot_ids_json = json_array(ref_snapshot_id) WHERE ref_snapshot_id IS NOT NULL;
			PRAGMA user_version = 11;
		`);
	}

	private static migrateV12(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE connector_packages (
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				package_id TEXT NOT NULL,
				version TEXT NOT NULL,
				name TEXT NOT NULL,
				fingerprint TEXT NOT NULL,
				manifest_digest TEXT NOT NULL,
				manifest_bytes_base64 TEXT NOT NULL,
				signature_base64 TEXT NOT NULL,
				public_key_base64 TEXT NOT NULL,
				installed_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY(project_id, package_id)
			) STRICT;
			CREATE TABLE connector_package_audit (
				id INTEGER PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				package_id TEXT NOT NULL,
				action TEXT NOT NULL CHECK (action IN ('installed', 'updated', 'uninstalled')),
				version TEXT NOT NULL,
				fingerprint TEXT NOT NULL,
				manifest_digest TEXT NOT NULL,
				changed_at TEXT NOT NULL
			) STRICT;
			PRAGMA user_version = 12;
		`);
	}

	private static migrateV13(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE frontend_e2e_evidence (
				id TEXT PRIMARY KEY NOT NULL,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
				attempt_id TEXT NOT NULL REFERENCES provider_attempts(attempt_id) ON DELETE RESTRICT,
				target_url TEXT NOT NULL,
				environment_identity TEXT NOT NULL,
				scenario_json TEXT NOT NULL,
				checkout_snapshot TEXT NOT NULL,
				requester_snapshot TEXT NOT NULL,
				task_space_id INTEGER NOT NULL CHECK (task_space_id > 0),
				state TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'cancelled', 'cleanupFailed')),
				screenshot_sha256 TEXT,
				screenshot_path TEXT,
				log_sha256 TEXT,
				log_path TEXT,
				failure TEXT,
				cleanup_error TEXT,
				created_at TEXT NOT NULL,
				completed_at TEXT,
				CHECK ((state = 'running' AND completed_at IS NULL) OR state != 'running'),
				CHECK (state NOT IN ('passed', 'failed', 'cancelled') OR (screenshot_sha256 IS NOT NULL AND screenshot_path IS NOT NULL AND log_sha256 IS NOT NULL AND log_path IS NOT NULL AND cleanup_error IS NULL))
			) STRICT;
			CREATE INDEX frontend_e2e_task_created ON frontend_e2e_evidence(task_id, created_at, id);
			PRAGMA user_version = 13;
		`);
	}

	private static migrateV14(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE frontend_e2e_evidence_v14 (
				id TEXT PRIMARY KEY NOT NULL,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
				attempt_id TEXT NOT NULL REFERENCES provider_attempts(attempt_id) ON DELETE RESTRICT,
				target_url TEXT NOT NULL,
				environment_identity TEXT NOT NULL,
				scenario_json TEXT NOT NULL,
				checkout_snapshot TEXT NOT NULL,
				requester_snapshot TEXT NOT NULL,
				task_space_id INTEGER NOT NULL CHECK (task_space_id > 0),
				state TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'cancelled', 'cleanupFailed')),
				screenshot_sha256 TEXT,
				screenshot_path TEXT,
				log_sha256 TEXT,
				log_path TEXT,
				failure TEXT,
				cleanup_error TEXT,
				created_at TEXT NOT NULL,
				completed_at TEXT,
				CHECK ((state = 'running' AND completed_at IS NULL) OR state != 'running'),
				CHECK (state NOT IN ('passed', 'failed', 'cancelled') OR (
					cleanup_error IS NULL AND (
						(screenshot_sha256 IS NOT NULL AND screenshot_path IS NOT NULL AND log_sha256 IS NOT NULL AND log_path IS NOT NULL)
						OR (state = 'failed' AND failure IS NOT NULL AND screenshot_sha256 IS NULL AND screenshot_path IS NULL AND log_sha256 IS NULL AND log_path IS NULL)
					)
				))
			) STRICT;
			INSERT INTO frontend_e2e_evidence_v14 SELECT * FROM frontend_e2e_evidence;
			DROP TABLE frontend_e2e_evidence;
			ALTER TABLE frontend_e2e_evidence_v14 RENAME TO frontend_e2e_evidence;
			CREATE INDEX frontend_e2e_task_created ON frontend_e2e_evidence(task_id, created_at, id);
			PRAGMA user_version = 14;
		`);
	}

	private static migrateV15(db: DatabaseSync): void {
		db.exec(`
			ALTER TABLE reference_snapshots ADD COLUMN derived_text TEXT NOT NULL DEFAULT '';
			DROP TRIGGER reference_snapshot_immutable;
			UPDATE reference_snapshots SET derived_text = CAST(content AS TEXT)
				WHERE content_type = 'text/plain; charset=utf-8';
			CREATE TRIGGER reference_snapshot_immutable BEFORE UPDATE ON reference_snapshots
			BEGIN SELECT RAISE(ABORT, 'reference snapshots are immutable'); END;
			PRAGMA user_version = 15;
		`);
	}

	private static migrateV16(db: DatabaseSync): void {
		db.exec(`
			ALTER TABLE provider_attempts ADD COLUMN parent_attempt_id TEXT REFERENCES provider_attempts(attempt_id) ON DELETE RESTRICT;
			ALTER TABLE provider_attempts ADD COLUMN child_scope_json TEXT CHECK (child_scope_json IS NULL OR (length(child_scope_json) <= 8192 AND json_valid(child_scope_json)));
			ALTER TABLE provider_attempts ADD COLUMN result_text TEXT CHECK (result_text IS NULL OR length(CAST(result_text AS BLOB)) <= 262144);
			ALTER TABLE provider_attempts ADD COLUMN result_sha256 TEXT CHECK (result_sha256 IS NULL OR length(result_sha256) = 64);
			ALTER TABLE provider_attempts ADD COLUMN orchestration_phase TEXT CHECK (orchestration_phase IN ('preflight', 'waiting') OR orchestration_phase IS NULL);
			ALTER TABLE provider_attempts ADD COLUMN running_task_revision INTEGER;
			CREATE INDEX provider_attempts_parent ON provider_attempts(parent_attempt_id, created_at, attempt_id);
			CREATE TRIGGER provider_attempt_parent_insert BEFORE INSERT ON provider_attempts WHEN NEW.parent_attempt_id IS NOT NULL
			BEGIN
				SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM provider_attempts p WHERE p.attempt_id = NEW.parent_attempt_id AND p.task_id = NEW.task_id AND p.parent_attempt_id IS NULL AND p.purpose = 'task')
					THEN RAISE(ABORT, 'subagent parent must be a root attempt for the same task') END;
				SELECT CASE WHEN (SELECT state FROM provider_attempts WHERE attempt_id = NEW.parent_attempt_id) NOT IN ('queued', 'running')
					THEN RAISE(ABORT, 'subagent parent is already terminal') END;
			END;
			CREATE TRIGGER provider_attempt_parent_update BEFORE UPDATE OF parent_attempt_id, task_id ON provider_attempts
			BEGIN SELECT RAISE(ABORT, 'provider attempt parent is immutable'); END;
			PRAGMA user_version = 16;
		`);
	}

	private static migrateV4(db: DatabaseSync): void {
		db.exec(`
			ALTER TABLE tasks ADD COLUMN archived_at TEXT;
			ALTER TABLE tasks ADD COLUMN trashed_at TEXT;
			ALTER TABLE tasks ADD COLUMN trash_restore_state TEXT CHECK (trash_restore_state IN ('ready', 'inProgress', 'review', 'done') OR trash_restore_state IS NULL);
			CREATE TABLE task_lifecycle_audit (
				audit_id INTEGER PRIMARY KEY,
				task_id TEXT NOT NULL,
				action TEXT NOT NULL CHECK (action IN ('archived', 'restored', 'trashed', 'trashRestored')),
				from_revision INTEGER NOT NULL,
				to_revision INTEGER NOT NULL,
				changed_at TEXT NOT NULL,
				FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
			) STRICT;
			CREATE TABLE task_trash_requests (
				request_id TEXT PRIMARY KEY NOT NULL,
				task_id TEXT NOT NULL,
				prior_state TEXT NOT NULL CHECK (prior_state IN ('ready', 'inProgress', 'review', 'done')),
				created_at TEXT NOT NULL,
				completed_at TEXT NOT NULL,
				FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
			) STRICT;
			PRAGMA user_version = 4;
		`);
	}

	private static migrateV3(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE task_state_audit (
				audit_id INTEGER PRIMARY KEY,
				task_id TEXT NOT NULL,
				from_state TEXT NOT NULL CHECK (from_state IN ('ready', 'inProgress', 'review', 'done')),
				to_state TEXT NOT NULL CHECK (to_state IN ('ready', 'inProgress', 'review', 'done')),
				from_revision INTEGER NOT NULL,
				to_revision INTEGER NOT NULL,
				changed_at TEXT NOT NULL,
				FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
			) STRICT;
			PRAGMA user_version = 3;
		`);
	}

	private static migrateV2(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE provider_attempts (
				attempt_id TEXT PRIMARY KEY NOT NULL,
				task_id TEXT NOT NULL,
				provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
				purpose TEXT NOT NULL CHECK (purpose IN ('connectionTest', 'task')),
				profile_ref TEXT,
				folder_identity TEXT NOT NULL CHECK (length(trim(folder_identity)) > 0),
				cwd TEXT NOT NULL CHECK (length(trim(cwd)) > 0),
				mode TEXT NOT NULL CHECK (length(trim(mode)) > 0),
				prompt TEXT NOT NULL,
				prompt_hash TEXT NOT NULL,
				convention_snapshot_id TEXT,
				ref_snapshot_id TEXT,
				state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
				provider_session_id TEXT,
				error_summary TEXT CHECK (error_summary IS NULL OR (length(error_summary) <= 256 AND instr(error_summary, char(10)) = 0 AND instr(error_summary, char(13)) = 0)),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				started_at TEXT,
				finished_at TEXT,
				FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
			) STRICT;
			CREATE INDEX provider_attempts_task_created ON provider_attempts(task_id, created_at, attempt_id);
			CREATE TABLE provider_attempt_events (
				event_id INTEGER PRIMARY KEY,
				attempt_id TEXT NOT NULL,
				type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
				metadata_json TEXT NOT NULL CHECK (length(metadata_json) <= 2048),
				created_at TEXT NOT NULL,
				FOREIGN KEY (attempt_id) REFERENCES provider_attempts(attempt_id) ON DELETE RESTRICT
			) STRICT;
			CREATE TABLE provider_attempt_state_audit (
				audit_id INTEGER PRIMARY KEY,
				attempt_id TEXT NOT NULL,
				from_state TEXT,
				to_state TEXT NOT NULL,
				changed_at TEXT NOT NULL,
				FOREIGN KEY (attempt_id) REFERENCES provider_attempts(attempt_id) ON DELETE RESTRICT
			) STRICT;
			CREATE TABLE provider_attempt_task_state_audit (
				audit_id INTEGER PRIMARY KEY,
				attempt_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				from_state TEXT NOT NULL CHECK (from_state IN ('ready', 'inProgress', 'review', 'done')),
				to_state TEXT NOT NULL CHECK (to_state IN ('ready', 'inProgress', 'review', 'done')),
				from_revision INTEGER NOT NULL,
				to_revision INTEGER NOT NULL,
				changed_at TEXT NOT NULL,
				FOREIGN KEY (attempt_id) REFERENCES provider_attempts(attempt_id) ON DELETE RESTRICT,
				FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
			) STRICT;
			CREATE TABLE provider_attempt_task_suggestions (
				attempt_id TEXT PRIMARY KEY NOT NULL,
				task_id TEXT NOT NULL,
				suggested_state TEXT NOT NULL CHECK (suggested_state IN ('review')),
				reason TEXT NOT NULL CHECK (reason IN ('stale_task_state')),
				created_at TEXT NOT NULL,
				FOREIGN KEY (attempt_id) REFERENCES provider_attempts(attempt_id) ON DELETE RESTRICT,
				FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
			) STRICT;
			PRAGMA user_version = 2;
		`);
	}

	private static migrateV1(db: DatabaseSync): void {
		db.exec(`
				CREATE TABLE projects (
					id TEXT PRIMARY KEY NOT NULL,
					name TEXT NOT NULL CHECK (length(trim(name)) > 0),
					created_at TEXT NOT NULL
				) STRICT;

				CREATE TABLE folder_bindings (
					id TEXT PRIMARY KEY NOT NULL,
					project_id TEXT NOT NULL,
					path TEXT NOT NULL CHECK (length(trim(path)) > 0),
					vcs_kind TEXT CHECK (vcs_kind IN ('git', 'jj') OR vcs_kind IS NULL),
					vcs_root TEXT,
					review_repository_id TEXT,
					created_at TEXT NOT NULL,
					UNIQUE (id, project_id),
					FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
				) STRICT;

				CREATE TABLE tasks (
					id TEXT PRIMARY KEY NOT NULL,
					project_id TEXT NOT NULL,
					binding_id TEXT NOT NULL,
					title TEXT NOT NULL CHECK (length(trim(title)) > 0),
					description TEXT,
					state TEXT NOT NULL CHECK (state IN ('ready', 'inProgress', 'review', 'done')),
					position INTEGER NOT NULL,
					revision INTEGER NOT NULL CHECK (revision > 0),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					UNIQUE (id, project_id),
					FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
					FOREIGN KEY (binding_id, project_id) REFERENCES folder_bindings(id, project_id) ON DELETE RESTRICT
				) STRICT;
				CREATE INDEX tasks_project_state_position ON tasks(project_id, state, position, created_at, id);

				CREATE TABLE review_outbox (
					command_id TEXT PRIMARY KEY NOT NULL,
					task_id TEXT NOT NULL,
					body TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
					last_error TEXT,
					review_id TEXT,
					created_at TEXT NOT NULL,
					completed_at TEXT,
					FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
				) STRICT;
				CREATE TRIGGER review_outbox_body_immutable
				BEFORE UPDATE OF body, command_id, task_id ON review_outbox
				BEGIN
					SELECT RAISE(ABORT, 'review outbox command identity and body are immutable');
				END;

				CREATE TABLE task_review_links (
					task_id TEXT NOT NULL,
					review_id TEXT NOT NULL,
					state TEXT NOT NULL CHECK (state IN ('available', 'unavailable')),
					is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
					created_at TEXT NOT NULL,
					PRIMARY KEY (task_id, review_id),
					FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
				) STRICT;
				CREATE UNIQUE INDEX task_review_one_primary ON task_review_links(task_id) WHERE is_primary = 1;

				CREATE TABLE project_views (
					project_id TEXT PRIMARY KEY NOT NULL,
					descriptor_uri TEXT NOT NULL UNIQUE,
					open_at_quit INTEGER NOT NULL CHECK (open_at_quit IN (0, 1)),
					selected_task_id TEXT,
					dashboard_position TEXT,
					FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
					FOREIGN KEY (selected_task_id, project_id) REFERENCES tasks(id, project_id) ON DELETE RESTRICT
				) STRICT;

				PRAGMA user_version = 1;
			`);
	}

	createProject(name: string, id = randomUUID()): WorkspaceProject {
		this.assertOpen();
		const createdAt = new Date().toISOString();
		this.db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(id, name.trim(), createdAt);
		return { id, name: name.trim(), createdAt };
	}

	createPendingConnectorAccount(input: { projectId: string; provider: ConnectorAccount['provider']; label: string; remoteIdentity: string }): ConnectorAccount {
		this.assertOpen();
		if (!['slack', 'notion'].includes(input.provider) || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 200
			|| typeof input.remoteIdentity !== 'string' || !input.remoteIdentity.trim() || input.remoteIdentity.length > 512) {
			throw new Error('A valid connector, account label, and remote identity are required.');
		}
		const now = new Date().toISOString();
		const id = randomUUID();
		this.db.prepare(`INSERT INTO connector_accounts (id, project_id, provider, label, remote_identity, state, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
			id, input.projectId, input.provider, input.label.trim(), input.remoteIdentity.trim(), now, now,
		);
		return this.getConnectorAccount(id)!;
	}

	getConnectorAccount(id: string): ConnectorAccount | undefined {
		this.assertOpen();
		const row = this.db.prepare('SELECT * FROM connector_accounts WHERE id = ?').get(id);
		return row ? this.connectorAccountFromRow(row) : undefined;
	}

	listConnectorAccounts(projectId: string): ConnectorAccount[] {
		this.assertOpen();
		return this.db.prepare("SELECT * FROM connector_accounts WHERE project_id = ? AND state = 'active' ORDER BY created_at, id")
			.all(projectId).map(row => this.connectorAccountFromRow(row));
	}

	listVisibleConnectorAccounts(projectId: string): ConnectorAccount[] {
		this.assertOpen();
		return this.db.prepare("SELECT * FROM connector_accounts WHERE project_id = ? AND state != 'disconnected' ORDER BY created_at, id")
			.all(projectId).map(row => this.connectorAccountFromRow(row));
	}

	listConnectorAccountsNeedingVaultRecovery(): ConnectorAccount[] {
		this.assertOpen();
		return this.db.prepare("SELECT * FROM connector_accounts WHERE state IN ('pending', 'disconnecting') ORDER BY created_at, id")
			.all().map(row => this.connectorAccountFromRow(row));
	}

	activateConnectorAccount(id: string): ConnectorAccount {
		this.assertOpen();
		const result = this.db.prepare("UPDATE connector_accounts SET state = 'active', updated_at = ? WHERE id = ? AND state = 'pending'")
			.run(new Date().toISOString(), id);
		if (Number(result.changes) !== 1) { throw new Error('The connector account is not pending activation.'); }
		return this.getConnectorAccount(id)!;
	}

	beginConnectorDisconnect(id: string): ConnectorAccount {
		this.assertOpen();
		const account = this.getConnectorAccount(id);
		if (!account || account.state === 'disconnected') { throw new Error('The connector account is unavailable.'); }
		if (account.state === 'disconnecting') { return account; }
		this.db.prepare("UPDATE connector_accounts SET state = 'disconnecting', updated_at = ? WHERE id = ?")
			.run(new Date().toISOString(), id);
		return this.getConnectorAccount(id)!;
	}

	completeConnectorDisconnect(id: string): ConnectorAccount {
		this.assertOpen();
		const result = this.db.prepare("UPDATE connector_accounts SET state = 'disconnected', updated_at = ? WHERE id = ? AND state = 'disconnecting'")
			.run(new Date().toISOString(), id);
		if (Number(result.changes) !== 1) { throw new Error('The connector account is not ready to disconnect.'); }
		return this.getConnectorAccount(id)!;
	}

	getInstalledConnectorPackage(projectId: string, packageId: string): InstalledConnectorPackage | undefined {
		this.assertOpen();
		const row = this.db.prepare('SELECT * FROM connector_packages WHERE project_id = ? AND package_id = ?').get(projectId, packageId);
		return row ? this.installedConnectorPackageFromRow(row) : undefined;
	}

	listInstalledConnectorPackages(projectId: string): InstalledConnectorPackage[] {
		this.assertOpen();
		return this.db.prepare('SELECT * FROM connector_packages WHERE project_id = ? ORDER BY name, package_id').all(projectId)
			.map(row => this.installedConnectorPackageFromRow(row));
	}

	saveInstalledConnectorPackage(input: Omit<InstalledConnectorPackage, 'installedAt' | 'updatedAt'>): InstalledConnectorPackage {
		this.assertOpen();
		return this.transaction(() => {
			const existing = this.getInstalledConnectorPackage(input.projectId, input.packageId);
			const validated = validateDeclarativePackage({
				manifestBytesBase64: input.manifestBytesBase64,
				signatureBase64: input.signatureBase64,
				publicKeyBase64: input.publicKeyBase64,
			}, existing ? {
				fingerprint: existing.fingerprint, version: existing.version, manifestDigest: existing.manifestDigest,
			} : undefined);
			if (validated.manifest.packageId !== input.packageId || validated.manifest.version !== input.version
				|| validated.manifest.name !== input.name || validated.fingerprint !== input.fingerprint
				|| validated.manifestDigest !== input.manifestDigest) {
				throw new Error('Connector package metadata does not match its signed manifest.');
			}
			const now = new Date().toISOString();
			if (existing) {
				this.db.prepare(`UPDATE connector_packages SET version = ?, name = ?, manifest_digest = ?, manifest_bytes_base64 = ?, signature_base64 = ?, public_key_base64 = ?, updated_at = ?
					WHERE project_id = ? AND package_id = ?`).run(input.version, input.name, input.manifestDigest, input.manifestBytesBase64,
						input.signatureBase64, input.publicKeyBase64, now, input.projectId, input.packageId);
			} else {
				this.db.prepare(`INSERT INTO connector_packages (project_id, package_id, version, name, fingerprint, manifest_digest,
					manifest_bytes_base64, signature_base64, public_key_base64, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
					input.projectId, input.packageId, input.version, input.name, input.fingerprint, input.manifestDigest,
					input.manifestBytesBase64, input.signatureBase64, input.publicKeyBase64, now, now,
				);
			}
			this.db.prepare(`INSERT INTO connector_package_audit (project_id, package_id, action, version, fingerprint, manifest_digest, changed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.projectId, input.packageId, existing ? 'updated' : 'installed', input.version,
				input.fingerprint, input.manifestDigest, now);
			return this.getInstalledConnectorPackage(input.projectId, input.packageId)!;
		});
	}

	uninstallConnectorPackage(projectId: string, packageId: string): void {
		this.assertOpen();
		this.transaction(() => {
			const existing = this.getInstalledConnectorPackage(projectId, packageId);
			if (!existing) { throw new Error('The connector package is not installed in this project.'); }
			this.db.prepare('DELETE FROM connector_packages WHERE project_id = ? AND package_id = ?').run(projectId, packageId);
			this.db.prepare(`INSERT INTO connector_package_audit (project_id, package_id, action, version, fingerprint, manifest_digest, changed_at)
					VALUES (?, ?, 'uninstalled', ?, ?, ?, ?)`).run(projectId, packageId, existing.version,
						existing.fingerprint, existing.manifestDigest, new Date().toISOString());
		});
	}

	createProviderAttempt(input: { attemptId?: string; taskId: string; provider: ProviderKind; purpose: ProviderAttemptPurpose; profileRef: string | null; folderIdentity: string; cwd: string; mode: string; prompt: string; conventionSnapshotId?: string | null; refSnapshotId?: string | null; refSnapshotIds?: readonly string[]; parentAttemptId?: string | null; childScope?: string | null }): ProviderAttempt {
		this.assertOpen();
		const attemptId = input.attemptId ?? randomUUID();
		const now = new Date().toISOString();
		const promptHash = createHash('sha256').update(input.prompt, 'utf8').digest('hex');
		const childScope = input.childScope ?? null;
		if (childScope !== null) {
			if (Buffer.byteLength(childScope, 'utf8') > 8192) { throw new Error('Subagent scope must be at most 8192 bytes.'); }
			let parsedScope: unknown;
			try { parsedScope = JSON.parse(childScope); } catch { throw new Error('Subagent scope must be valid JSON.'); }
			if (!parsedScope || typeof parsedScope !== 'object' || Array.isArray(parsedScope)) { throw new Error('Subagent scope must be a JSON object.'); }
		}
		return this.transaction(() => {
			const task = this.getTask(input.taskId);
			if (!task || task.archivedAt || task.trashedAt || task.deletionPendingAt) { throw new Error('Provider attempts require an active task with no deletion pending.'); }
			const referenceIds = input.refSnapshotIds ?? (input.refSnapshotId ? [input.refSnapshotId] : []);
			if (!Array.isArray(referenceIds) || referenceIds.length > 100 || new Set(referenceIds).size !== referenceIds.length) {
				throw new Error('A run may use at most 100 distinct reference snapshots.');
			}
			if (input.refSnapshotIds !== undefined) {
				const conventionRun = input.purpose === 'connectionTest' && (input.mode === 'convention-draft' || input.mode === 'convention-check');
				for (const id of referenceIds) {
					const available = conventionRun
						? this.db.prepare(`SELECT 1 FROM reference_snapshots s JOIN reference_sources r ON r.id = s.source_id
							WHERE s.id = ? AND r.project_id = ?`).get(id, task.projectId)
						: this.db.prepare('SELECT 1 FROM task_reference_links WHERE task_id = ? AND snapshot_id = ?').get(task.id, id);
					if (!available) { throw new Error(conventionRun ? 'A convention run reference snapshot must belong to its project.' : 'A run reference snapshot must be linked to its task.'); }
				}
			}
			this.db.prepare(`INSERT INTO provider_attempts
				(attempt_id, task_id, provider, purpose, profile_ref, folder_identity, cwd, mode, prompt, prompt_hash, convention_snapshot_id, ref_snapshot_id, ref_snapshot_ids_json, state, created_at, updated_at, launch_gate_version, parent_attempt_id, child_scope_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 1, ?, ?)`)
				.run(attemptId, input.taskId, input.provider, input.purpose, input.profileRef, input.folderIdentity, input.cwd, input.mode, input.prompt, promptHash, input.conventionSnapshotId ?? null, referenceIds[0] ?? input.refSnapshotId ?? null, JSON.stringify(referenceIds), now, now, input.parentAttemptId ?? null, childScope);
			this.db.prepare(`INSERT INTO provider_attempt_state_audit (attempt_id, from_state, to_state, changed_at) VALUES (?, NULL, 'queued', ?)`).run(attemptId, now);
			return this.getProviderAttempt(attemptId)!;
		});
	}

	getProviderAttempt(attemptId: string): ProviderAttempt | undefined {
		this.assertOpen();
		const row = this.db.prepare('SELECT * FROM provider_attempts WHERE attempt_id = ?').get(attemptId);
		return row ? this.providerAttemptFromRow(row) : undefined;
	}

	listProviderAttempts(taskId: string): ProviderAttempt[] {
		this.assertOpen();
		return this.db.prepare('SELECT * FROM provider_attempts WHERE task_id = ? ORDER BY created_at, attempt_id').all(taskId).map(row => this.providerAttemptFromRow(row));
	}

	listSubagentAttempts(rootAttemptId: string): ProviderAttempt[] {
		this.assertOpen();
		const root = this.getProviderAttempt(rootAttemptId);
		if (!root || root.parentAttemptId !== null) { throw new Error('Subagent attempts require a root provider attempt.'); }
		return this.db.prepare('SELECT * FROM provider_attempts WHERE parent_attempt_id = ? ORDER BY created_at, attempt_id').all(rootAttemptId).map(row => this.providerAttemptFromRow(row));
	}

	private reconcilePendingSubagentAttempts(): void {
		const roots = this.db.prepare("SELECT attempt_id FROM provider_attempts WHERE parent_attempt_id IS NULL AND orchestration_phase = 'waiting'").all();
		for (const row of roots) { this.reconcileSubagentAttempt(String(row.attempt_id)); }
	}

	setSubagentPhase(rootAttemptId: string, phase: 'preflight' | 'waiting' | null): ProviderAttempt {
		this.assertOpen();
		return this.transaction(() => {
			const root = this.getProviderAttempt(rootAttemptId);
			if (!root || root.parentAttemptId !== null || root.purpose !== 'task') { throw new Error('Subagent orchestration requires a root task attempt.'); }
			if (root.state !== 'queued' && root.state !== 'running') { throw new Error('Subagent phase cannot change after the root attempt is terminal.'); }
			this.db.prepare('UPDATE provider_attempts SET orchestration_phase = ?, updated_at = ? WHERE attempt_id = ?').run(phase, new Date().toISOString(), rootAttemptId);
			return this.getProviderAttempt(rootAttemptId)!;
		});
	}

	persistProviderAttemptResult(attemptId: string, text: string): ProviderAttempt {
		this.assertOpen();
		if (Buffer.byteLength(text, 'utf8') > 262144) { throw new Error('Provider result must be at most 262144 bytes.'); }
		return this.transaction(() => {
			const attempt = this.getProviderAttempt(attemptId);
			if (!attempt) { throw new Error(`Unknown provider attempt ${attemptId}.`); }
			if (attempt.resultText !== null) {
				if (attempt.resultText !== text) { throw new Error('A provider result cannot be changed after it is saved.'); }
				return attempt;
			}
			if (attempt.state !== 'queued' && attempt.state !== 'running') { throw new Error('A provider result must be saved before the attempt finishes.'); }
			const hash = createHash('sha256').update(text, 'utf8').digest('hex');
			this.db.prepare('UPDATE provider_attempts SET result_text = ?, result_sha256 = ?, updated_at = ? WHERE attempt_id = ?').run(text, hash, new Date().toISOString(), attemptId);
			return this.getProviderAttempt(attemptId)!;
		});
	}

	reconcileSubagentAttempt(rootAttemptId: string): { reconciled: boolean; taskRevision: number | null; suggestion: boolean } {
		this.assertOpen();
		return this.transaction(() => {
			const root = this.getProviderAttempt(rootAttemptId);
			if (!root || root.parentAttemptId !== null || root.purpose !== 'task') { throw new Error('Subagent reconciliation requires a root task attempt.'); }
			if (root.state !== 'succeeded' || !root.cleanupVerified || root.runningTaskRevision === null || root.orchestrationPhase !== 'waiting') { return { reconciled: false, taskRevision: null, suggestion: false }; }
			const children = this.listSubagentAttempts(rootAttemptId);
			if (children.some(child => child.state !== 'succeeded' || !child.cleanupVerified)) {
				this.db.prepare("UPDATE provider_attempts SET orchestration_phase = 'waiting' WHERE attempt_id = ?").run(rootAttemptId);
				return { reconciled: false, taskRevision: null, suggestion: false };
			}
			const task = this.getTask(root.taskId);
			if (!task || task.deletionPendingAt || task.archivedAt || task.trashedAt) { return { reconciled: false, taskRevision: null, suggestion: false }; }
			if (task.state === 'inProgress' && task.revision === root.runningTaskRevision) {
				const now = new Date().toISOString();
				const moved = this.db.prepare("UPDATE tasks SET state = 'review', position = (SELECT COALESCE(MAX(position), -1) + 1 FROM tasks WHERE project_id = ? AND state = 'review'), revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND state = 'inProgress'")
					.run(task.projectId, now, task.id, root.runningTaskRevision);
				if (Number(moved.changes) === 1) {
					this.db.prepare("INSERT INTO provider_attempt_task_state_audit (attempt_id, task_id, from_state, to_state, from_revision, to_revision, changed_at) VALUES (?, ?, 'inProgress', 'review', ?, ?, ?)")
						.run(rootAttemptId, task.id, task.revision, task.revision + 1, now);
					this.db.prepare('UPDATE provider_attempts SET orchestration_phase = NULL WHERE attempt_id = ?').run(rootAttemptId);
					return { reconciled: true, taskRevision: task.revision + 1, suggestion: false };
				}
			}
			this.db.prepare("INSERT INTO provider_attempt_task_suggestions (attempt_id, task_id, suggested_state, reason, created_at) VALUES (?, ?, 'review', 'stale_task_state', ?) ON CONFLICT(attempt_id) DO NOTHING")
				.run(rootAttemptId, task.id, new Date().toISOString());
			this.db.prepare('UPDATE provider_attempts SET orchestration_phase = NULL WHERE attempt_id = ?').run(rootAttemptId);
			return { reconciled: true, taskRevision: task.revision, suggestion: true };
		});
	}

	setProviderAttemptRunning(attemptId: string, expectedTaskRevision: number, ownedPgid?: number): ProviderAttempt {
		this.assertOpen();
		if (ownedPgid !== undefined && (!Number.isSafeInteger(ownedPgid) || ownedPgid < 2)) { throw new Error('An owned process group ID must be a positive integer.'); }
		return this.transaction(() => {
			const attempt = this.getProviderAttempt(attemptId);
			if (!attempt) { throw new Error(`Unknown provider attempt ${attemptId}.`); }
			const task = this.getTask(attempt.taskId);
			if (!task) { throw new Error(`Unknown task ${attempt.taskId} for provider attempt ${attemptId}.`); }
			if (task.archivedAt || task.trashedAt || task.deletionPendingAt) { throw new Error('Archived, trashed, or deletion-pending tasks cannot start provider attempts.'); }
			const isChild = attempt.parentAttemptId !== null;
			if (task.revision !== expectedTaskRevision || (attempt.purpose === 'task' && (isChild ? task.state !== 'inProgress' : task.state !== 'ready'))) {
				throw new TaskRevisionConflictError(attempt.taskId, expectedTaskRevision);
			}
			if (attempt.launchGateVersion === 1 && ownedPgid === undefined) { throw new Error('The launch gate process group must be persisted before an attempt can run.'); }
			const markRunning = (): ProviderAttempt => {
				this.transitionProviderAttempt(attemptId, 'running');
				if (ownedPgid !== undefined) { this.db.prepare('UPDATE provider_attempts SET owned_pgid = ? WHERE attempt_id = ?').run(ownedPgid, attemptId); }
				return this.getProviderAttempt(attemptId)!;
			};
			if (isChild) {
				const parent = this.getProviderAttempt(attempt.parentAttemptId!);
				if (!parent || !((parent.state === 'queued' || parent.state === 'running') ||
					(parent.state === 'succeeded' && parent.cleanupVerified && parent.orchestrationPhase === 'waiting'))) {
					throw new Error('Subagent parent is no longer active.');
				}
				if (attempt.state !== 'queued') { throw new Error(`Invalid provider attempt transition ${attempt.state} -> running.`); }
				return markRunning();
			}
			if (attempt.purpose === 'connectionTest') {
				if (attempt.state !== 'queued') { throw new Error(`Invalid provider attempt transition ${attempt.state} -> running.`); }
				return markRunning();
			}
			const now = new Date().toISOString();
			const changed = this.db.prepare("UPDATE tasks SET state = 'inProgress', position = (SELECT COALESCE(MAX(position), -1) + 1 FROM tasks WHERE project_id = ? AND state = 'inProgress'), revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND state = 'ready'")
				.run(task.projectId, now, task.id, expectedTaskRevision);
			if (Number(changed.changes) !== 1) { throw new TaskRevisionConflictError(task.id, expectedTaskRevision); }
			this.db.prepare(`INSERT INTO provider_attempt_task_state_audit (attempt_id, task_id, from_state, to_state, from_revision, to_revision, changed_at)
				VALUES (?, ?, ?, 'inProgress', ?, ?, ?)`).run(attemptId, task.id, task.state, task.revision, task.revision + 1, now);
			this.db.prepare('UPDATE provider_attempts SET running_task_revision = ? WHERE attempt_id = ?').run(task.revision + 1, attemptId);
			return markRunning();
		});
	}

	appendProviderAttemptEvent(attemptId: string, event: { type: string; metadata?: Readonly<Record<string, string | number | boolean | null>> }): ProviderAttemptEvent {
		this.assertOpen();
		if (!providerEventTypes.has(event.type)) { throw new Error('Unsupported provider event type.'); }
		const metadata = this.validateProviderEventMetadata(event.type, event.metadata ?? {});
		const createdAt = new Date().toISOString();
		const result = this.db.prepare('INSERT INTO provider_attempt_events (attempt_id, type, metadata_json, created_at) VALUES (?, ?, ?, ?)').run(attemptId, event.type, JSON.stringify(metadata), createdAt);
		return { eventId: Number(result.lastInsertRowid), attemptId, type: event.type, metadata, createdAt };
	}

	listProviderAttemptEvents(attemptId: string): ProviderAttemptEvent[] {
		this.assertOpen();
		return this.db.prepare('SELECT event_id, attempt_id, type, metadata_json, created_at FROM provider_attempt_events WHERE attempt_id = ? ORDER BY event_id').all(attemptId).map(row => ({
			eventId: Number(row.event_id), attemptId: String(row.attempt_id), type: String(row.type),
			metadata: JSON.parse(String(row.metadata_json)) as Record<string, string | number | boolean | null>, createdAt: String(row.created_at),
		}));
	}

	finishProviderAttempt(attemptId: string, state: Extract<ProviderAttemptState, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>, providerSessionId: string | null = null, expectedTaskRevision?: number, errorSummary: string | null = null, cleanupVerified = false): ProviderAttempt {
		this.assertOpen();
		if (typeof cleanupVerified !== 'boolean') { throw new Error('Cleanup verification must be explicit.'); }
		if (state === 'succeeded' && expectedTaskRevision === undefined) {
			const attempt = this.getProviderAttempt(attemptId);
			if (attempt?.purpose === 'task') { throw new Error('A task revision is required when completing a successful task provider attempt.'); }
		}
		if (state === 'succeeded' && errorSummary !== null) { throw new Error('A successful provider attempt cannot include an error summary.'); }
		if (errorSummary !== null && (errorSummary.length > 256 || /[\r\n\u0000-\u001f]/.test(errorSummary))) { throw new Error('Provider error summary must be a short, single-line app reason.'); }
		return this.transaction(() => {
			const current = this.getProviderAttempt(attemptId);
			if (!current) { throw new Error(`Unknown provider attempt ${attemptId}.`); }
			if (cleanupVerified && current.startedAt !== null && current.ownedPgid === null) { throw new Error('Cleanup cannot be verified because the owned process group was not recorded.'); }
			if (current.state === state) {
				if (current.providerSessionId !== providerSessionId) { throw new Error(`Provider attempt ${attemptId} already ended with a different session ID.`); }
				if (cleanupVerified && !current.cleanupVerified) {
					this.db.prepare('UPDATE provider_attempts SET cleanup_verified = 1, cleanup_verified_at = ? WHERE attempt_id = ?').run(new Date().toISOString(), attemptId);
					if (current.parentAttemptId !== null) { this.reconcileSubagentAttempt(current.parentAttemptId); }
					else if (state === 'succeeded' && current.orchestrationPhase === 'waiting') { this.reconcileSubagentAttempt(attemptId); }
					return this.getProviderAttempt(attemptId)!;
				}
				return current;
			}
			if (current.state !== 'queued' && current.state !== 'running') { throw new Error(`Provider attempt ${attemptId} is already terminal (${current.state}).`); }
			if (state === 'succeeded' && current.purpose === 'task' && current.mode === 'mutating') {
				const task = this.getTask(current.taskId);
				const binding = task ? this.listFolderBindings(task.projectId).find(item => item.id === task.bindingId) : undefined;
				if (binding?.vcsKind === null && !this.listProviderAttemptEvents(attemptId).some(event => event.type === 'ordinaryFolderChanges')) {
					throw new Error('An ordinary-folder provider attempt cannot succeed without a durable change report.');
				}
			}
			let finished = this.transitionProviderAttempt(attemptId, state, providerSessionId, errorSummary);
			if (cleanupVerified) {
				const now = new Date().toISOString();
				this.db.prepare('UPDATE provider_attempts SET cleanup_verified = 1, cleanup_verified_at = ? WHERE attempt_id = ?').run(now, attemptId);
				finished = this.getProviderAttempt(attemptId)!;
			}
			if (state === 'succeeded' && current.purpose === 'task' && current.parentAttemptId === null && expectedTaskRevision !== undefined) {
				const hasChildren = this.db.prepare('SELECT 1 FROM provider_attempts WHERE parent_attempt_id = ? LIMIT 1').get(attemptId) !== undefined;
				if (hasChildren || !finished.cleanupVerified) {
					this.db.prepare("UPDATE provider_attempts SET orchestration_phase = 'waiting' WHERE attempt_id = ?").run(attemptId);
					this.reconcileSubagentAttempt(attemptId);
				} else {
				const task = this.getTask(current.taskId);
				if (task?.state === 'inProgress' && !task.deletionPendingAt && task.revision === expectedTaskRevision) {
					const now = new Date().toISOString();
					const changed = this.db.prepare("UPDATE tasks SET state = 'review', position = (SELECT COALESCE(MAX(position), -1) + 1 FROM tasks WHERE project_id = ? AND state = 'review'), revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND state = 'inProgress'")
						.run(task.projectId, now, task.id, expectedTaskRevision);
					if (Number(changed.changes) === 1) {
						this.db.prepare(`INSERT INTO provider_attempt_task_state_audit (attempt_id, task_id, from_state, to_state, from_revision, to_revision, changed_at) VALUES (?, ?, 'inProgress', 'review', ?, ?, ?)`)
							.run(attemptId, task.id, task.revision, task.revision + 1, now);
					}
				} else if (task && !task.deletionPendingAt) {
					this.db.prepare(`INSERT INTO provider_attempt_task_suggestions (attempt_id, task_id, suggested_state, reason, created_at) VALUES (?, ?, 'review', 'stale_task_state', ?)
						ON CONFLICT(attempt_id) DO NOTHING`).run(attemptId, task.id, new Date().toISOString());
				}
				}
			}
			if (current.parentAttemptId !== null) { this.reconcileSubagentAttempt(current.parentAttemptId); }
			return finished;
		});
	}

	/** Finalize a cleaned convention run and its human-readable draft in one SQLite transaction. */
	finishConventionDraftAttempt(input: {
		attemptId: string; providerSessionId: string | null; projectId: string; provider: ProviderKind;
		markdown: string; sourceSnapshotIds: readonly string[];
	}): { attempt: ProviderAttempt; version: ConventionVersion } {
		this.assertOpen();
		return this.transaction(() => {
			const attempt = this.finishProviderAttempt(input.attemptId, 'succeeded', input.providerSessionId, undefined, null, true);
			const version = this.knowledge.createConventionVersion({
				projectId: input.projectId, markdown: input.markdown, sourceSnapshotIds: input.sourceSnapshotIds,
				authoredBy: input.provider, authorAttemptId: attempt.attemptId,
			});
			return { attempt, version };
		});
	}

	/** Finalize a cleaned convention check and its verdict in one SQLite transaction. */
	finishConventionCheckAttempt(input: {
		attemptId: string; providerSessionId: string | null; provider: ProviderKind;
		versionId: string; verdict: ConventionCheck['verdict']; report: string;
	}): { attempt: ProviderAttempt; check: ConventionCheck } {
		this.assertOpen();
		return this.transaction(() => {
			const attempt = this.finishProviderAttempt(input.attemptId, 'succeeded', input.providerSessionId, undefined, null, true);
			const check = this.knowledge.recordConventionCheck({
				versionId: input.versionId, provider: input.provider, attemptId: attempt.attemptId,
				verdict: input.verdict, report: input.report,
			});
			return { attempt, check };
		});
	}

	confirmProviderAttemptCleanup(attemptId: string): ProviderAttempt {
		this.assertOpen();
		return this.transaction(() => {
			const attempt = this.getProviderAttempt(attemptId);
			if (!attempt) { throw new Error(`Unknown provider attempt ${attemptId}.`); }
			if (attempt.state === 'queued' || attempt.state === 'running') { throw new Error('Cleanup cannot be verified before an attempt is terminal.'); }
			if (attempt.ownedPgid === null) { throw new Error('Cleanup cannot be verified because the owned process group was not recorded.'); }
			if (!attempt.cleanupVerified) {
				this.db.prepare('UPDATE provider_attempts SET cleanup_verified = 1, cleanup_verified_at = ? WHERE attempt_id = ?').run(new Date().toISOString(), attemptId);
			}
			if (attempt.parentAttemptId !== null) { this.reconcileSubagentAttempt(attempt.parentAttemptId); }
			else if (attempt.state === 'succeeded' && attempt.orchestrationPhase === 'waiting') { this.reconcileSubagentAttempt(attemptId); }
			return this.getProviderAttempt(attemptId)!;
		});
	}

	interruptLiveProviderAttempts(): ProviderAttempt[] {
		this.assertOpen();
		return this.transaction(() => {
			const rows = this.db.prepare("SELECT attempt_id FROM provider_attempts WHERE state IN ('queued', 'running') ORDER BY created_at, attempt_id").all();
			return rows.map(row => {
				const attemptId = String(row.attempt_id);
				const current = this.getProviderAttempt(attemptId)!;
				const safelyNeverLaunched = current.state === 'queued' && current.launchGateVersion === 1 && current.ownedPgid === null;
				const interrupted = this.transitionProviderAttempt(
					attemptId,
					'interrupted',
					undefined,
					safelyNeverLaunched ? 'Provider launch gate closed before execution.' : null,
				);
				if (safelyNeverLaunched) {
					this.db.prepare('UPDATE provider_attempts SET cleanup_verified = 1, cleanup_verified_at = ? WHERE attempt_id = ?')
						.run(new Date().toISOString(), attemptId);
					return this.getProviderAttempt(attemptId)!;
				}
				return interrupted;
			});
		});
	}

	private transitionProviderAttempt(attemptId: string, state: ProviderAttemptState, providerSessionId?: string | null, errorSummary: string | null = null): ProviderAttempt {
		const current = this.getProviderAttempt(attemptId);
		if (!current) { throw new Error(`Unknown provider attempt ${attemptId}.`); }
		const allowed = current.state === 'queued' ? ['running', 'succeeded', 'failed', 'cancelled', 'interrupted'] : current.state === 'running' ? ['succeeded', 'failed', 'cancelled', 'interrupted'] : [];
		if (!allowed.includes(state)) { throw new Error(`Invalid provider attempt transition ${current.state} -> ${state}.`); }
		const now = new Date().toISOString();
		const sessionId = providerSessionId === undefined ? current.providerSessionId : providerSessionId;
		const startedAt = state === 'running' ? now : current.startedAt;
		const finishedAt = state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'interrupted' ? now : current.finishedAt;
		const result = this.db.prepare('UPDATE provider_attempts SET state = ?, provider_session_id = ?, error_summary = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE attempt_id = ? AND state = ?')
			.run(state, sessionId, errorSummary, startedAt, finishedAt, now, attemptId, current.state);
		if (Number(result.changes) !== 1) { throw new Error(`Provider attempt ${attemptId} changed concurrently.`); }
		this.db.prepare('INSERT INTO provider_attempt_state_audit (attempt_id, from_state, to_state, changed_at) VALUES (?, ?, ?, ?)').run(attemptId, current.state, state, now);
		return this.getProviderAttempt(attemptId)!;
	}

	private validateProviderEventMetadata(type: string, metadata: Readonly<Record<string, string | number | boolean | null>>): Record<string, string | number | boolean | null> {
		if (type === 'ordinaryFolderInventoryStarted') {
			if (Object.keys(metadata).length) { throw new Error('Ordinary-folder inventory start events cannot include metadata.'); }
			return {};
		}
		if (type === 'ordinaryFolderChanges') {
			if (Object.keys(metadata).length !== 1 || typeof metadata.report !== 'string' || Buffer.byteLength(metadata.report, 'utf8') > 64 * 1024) {
				throw new Error('Ordinary-folder change report must be a bounded JSON document.');
			}
			let report: unknown;
			try { report = JSON.parse(metadata.report); } catch { throw new Error('Ordinary-folder change report must be valid JSON.'); }
			if (!report || typeof report !== 'object' || Array.isArray(report)) { throw new Error('Ordinary-folder change report has an invalid shape.'); }
			const value = report as Record<string, unknown>;
			if ((value.status !== 'observed' && value.status !== 'unverified') || typeof value.summary !== 'string' || value.summary.length > 400 ||
				!Array.isArray(value.changes) || value.changes.length > 300 || typeof value.truncated !== 'boolean' ||
				Object.keys(value).some(key => !['status', 'summary', 'changes', 'truncated'].includes(key))) {
				throw new Error('Ordinary-folder change report failed schema validation.');
			}
			if (value.status === 'unverified' && (value.changes.length !== 0 || value.truncated) ||
				value.status === 'observed' && !/^\d+ changed paths? observed\.$/u.test(value.summary)) {
				throw new Error('Ordinary-folder change report state does not match its contents.');
			}
			const seenPaths = new Set<string>();
			for (const entry of value.changes) {
				if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { throw new Error('Ordinary-folder change entry has an invalid shape.'); }
				const change = entry as Record<string, unknown>;
				if (typeof change.path !== 'string' || change.path.length < 1 || change.path.length > 1024 || change.path.startsWith('/') || change.path.split('/').some(part => part === '' || part === '.' || part === '..') || /[\u0000-\u001f\u007f]/u.test(change.path) ||
					!['created', 'modified', 'deleted', 'symlink changed', 'type changed'].includes(String(change.change)) ||
					(change.before !== undefined && (typeof change.before !== 'string' || change.before.length > 1100)) ||
					(change.after !== undefined && (typeof change.after !== 'string' || change.after.length > 1100)) ||
					Object.keys(change).some(key => !['path', 'change', 'before', 'after'].includes(key))) {
					throw new Error('Ordinary-folder change entry failed schema validation.');
				}
				if (seenPaths.has(change.path)) { throw new Error('Ordinary-folder change paths must be unique.'); }
				seenPaths.add(change.path);
			}
			return { report: metadata.report };
		}
		const allowed = new Set(['itemType', 'subtype', 'itemOutcome', 'numTurns', 'durationMs']);
		const entries = Object.entries(metadata);
		if (entries.length > 8) { throw new Error('Provider event metadata has too many fields.'); }
		for (const [key, value] of entries) {
			const numericKey = key === 'numTurns' || key === 'durationMs';
			const validItemOutcome = key === 'itemOutcome' && (value === 'failed' || value === 'denied' || value === 'unresolved');
			const safeString = typeof value === 'string' && value.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(value);
			if (!allowed.has(key) || (numericKey && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (key === 'numTurns' ? 100_000 : 86_400_000))) ||
				(key === 'itemOutcome' ? !validItemOutcome : !numericKey && !safeString)) {
				throw new Error(`Provider event metadata field is not allowed: ${key}.`);
			}
		}
		return Object.fromEntries(entries);
	}

	createProjectWorkspace(name: string, folderPath: string, descriptorUri: string, projectId = randomUUID(), vcs?: { vcsKind: VcsKind | null; vcsRoot: string | null }): { project: WorkspaceProject; binding: WorkspaceFolderBinding; view: ProjectView } {
		this.assertOpen();
		return this.transaction(() => {
			const project = this.createProject(name, projectId);
			const binding = this.createFolderBinding({ projectId: project.id, path: folderPath, ...vcs });
			const view = this.setProjectView({ projectId: project.id, descriptorUri, openAtQuit: false, selectedTaskId: null, dashboardPosition: null });
			return { project, binding, view };
		});
	}

	getProject(projectId: string): WorkspaceProject | undefined {
		this.assertOpen();
		const row = this.db.prepare('SELECT id, name, created_at FROM projects WHERE id = ?').get(projectId);
		return row ? this.projectFromRow(row) : undefined;
	}

	listProjects(): WorkspaceProject[] {
		this.assertOpen();
		return this.db.prepare('SELECT id, name, created_at FROM projects ORDER BY created_at, id').all().map(row => this.projectFromRow(row));
	}

	updateProject(projectId: string, name: string): WorkspaceProject | undefined {
		this.assertOpen();
		this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name.trim(), projectId);
		return this.getProject(projectId);
	}

	createFolderBinding(input: { projectId: string; path: string; vcsKind?: VcsKind | null; vcsRoot?: string | null; reviewRepositoryId?: string | null; id?: string }): WorkspaceFolderBinding {
		this.assertOpen();
		const id = input.id ?? randomUUID();
		const createdAt = new Date().toISOString();
		this.db.prepare(`INSERT INTO folder_bindings (id, project_id, path, vcs_kind, vcs_root, review_repository_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectId, input.path.trim(), input.vcsKind ?? null, input.vcsRoot ?? null, input.reviewRepositoryId ?? null, createdAt);
		return { id, projectId: input.projectId, path: input.path.trim(), vcsKind: input.vcsKind ?? null, vcsRoot: input.vcsRoot ?? null, reviewRepositoryId: input.reviewRepositoryId ?? null, createdAt };
	}

	listFolderBindings(projectId: string): WorkspaceFolderBinding[] {
		this.assertOpen();
		return this.db.prepare(`SELECT id, project_id, path, vcs_kind, vcs_root, review_repository_id, created_at
			FROM folder_bindings WHERE project_id = ? ORDER BY created_at, id`).all(projectId).map(row => this.bindingFromRow(row));
	}

	/** A person's explicit permission is pinned to one ordinary folder identity. */
	enableOrdinaryFolderMutation(projectId: string, bindingId: string): FolderMutationGrant {
		this.assertOpen();
		return this.transaction(() => {
			const binding = this.db.prepare('SELECT path, vcs_kind FROM folder_bindings WHERE id = ? AND project_id = ?').get(bindingId, projectId);
			if (!binding || binding.vcs_kind !== null) { throw new Error('An ordinary project folder is required to enable agent edits.'); }
			const canonicalPath = realpathSync(String(binding.path));
			const stats = statSync(canonicalPath, { bigint: true });
			if (!stats.isDirectory()) { throw new Error('The project folder is not a directory.'); }
			const previous = this.getOrdinaryFolderMutationGrant(projectId, bindingId);
			if (previous?.canonicalPath === canonicalPath && previous.dev === stats.dev.toString() && previous.ino === stats.ino.toString()) { return previous; }
			if (previous) { this.invalidateFolderMutationGrant(bindingId, 'invalidated'); }
			const grant: FolderMutationGrant = {
				bindingId, projectId, canonicalPath, dev: stats.dev.toString(), ino: stats.ino.toString(), grantedAt: new Date().toISOString(),
			};
			this.db.prepare(`INSERT INTO folder_mutation_grants (binding_id, project_id, canonical_path, dev, ino, granted_at) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(binding_id) DO UPDATE SET project_id = excluded.project_id, canonical_path = excluded.canonical_path,
					dev = excluded.dev, ino = excluded.ino, granted_at = excluded.granted_at`).run(
				grant.bindingId, grant.projectId, grant.canonicalPath, grant.dev, grant.ino, grant.grantedAt,
			);
			this.auditFolderMutationGrant(grant, 'enabled');
			return grant;
		});
	}

	revokeOrdinaryFolderMutation(projectId: string, bindingId: string): void {
		this.assertOpen();
		this.transaction(() => {
			if (!this.db.prepare('SELECT 1 FROM folder_bindings WHERE id = ? AND project_id = ?').get(bindingId, projectId)) {
				throw new Error('The folder does not belong to this project.');
			}
			this.invalidateFolderMutationGrant(bindingId, 'revoked');
		});
	}

	getOrdinaryFolderMutationGrant(projectId: string, bindingId: string): FolderMutationGrant | undefined {
		this.assertOpen();
		const row = this.db.prepare(`SELECT binding_id, project_id, canonical_path, dev, ino, granted_at FROM folder_mutation_grants
			WHERE binding_id = ? AND project_id = ?`).get(bindingId, projectId);
		return row ? {
			bindingId: String(row.binding_id), projectId: String(row.project_id), canonicalPath: String(row.canonical_path),
			dev: String(row.dev), ino: String(row.ino), grantedAt: String(row.granted_at),
		} : undefined;
	}

	isOrdinaryFolderMutationEnabled(projectId: string, bindingId: string, canonicalPath: string, dev: string, ino: string): boolean {
		const grant = this.getOrdinaryFolderMutationGrant(projectId, bindingId);
		return !!grant && grant.canonicalPath === canonicalPath && grant.dev === dev && grant.ino === ino;
	}

	hasCurrentOrdinaryFolderMutationGrant(projectId: string, bindingId: string): boolean {
		this.assertOpen();
		const binding = this.db.prepare('SELECT path, vcs_kind FROM folder_bindings WHERE id = ? AND project_id = ?').get(bindingId, projectId);
		if (!binding || binding.vcs_kind !== null) { return false; }
		try {
			const canonicalPath = realpathSync(String(binding.path));
			const stats = statSync(canonicalPath, { bigint: true });
			return stats.isDirectory() && this.isOrdinaryFolderMutationEnabled(projectId, bindingId, canonicalPath, stats.dev.toString(), stats.ino.toString());
		} catch {
			return false;
		}
	}

	updateFolderBinding(bindingId: string, patch: { path?: string; expectedPath?: string; vcsKind?: VcsKind | null; vcsRoot?: string | null; reviewRepositoryId?: string | null }): WorkspaceFolderBinding | undefined {
		this.assertOpen();
		return this.transaction(() => {
			const current = this.db.prepare(`SELECT id, project_id, path, vcs_kind, vcs_root, review_repository_id, created_at
				FROM folder_bindings WHERE id = ?`).get(bindingId);
			if (!current) { return undefined; }
			const currentPath = String(current.path);
			const path = patch.path === undefined ? currentPath : patch.path.trim();
			const pathChanged = path !== currentPath;
			const updatesIdentity = patch.vcsKind !== undefined || patch.vcsRoot !== undefined || patch.reviewRepositoryId !== undefined;
			if (pathChanged && updatesIdentity) {
				throw new Error('A folder path change must be verified before setting VCS or Review identity.');
			}
			if (updatesIdentity && patch.expectedPath !== currentPath) {
				throw new Error('Folder identity verification must match the current path.');
			}
			const vcsKind = pathChanged ? null : patch.vcsKind === undefined ? current.vcs_kind : patch.vcsKind;
			const vcsRoot = pathChanged ? null : patch.vcsRoot === undefined ? current.vcs_root : patch.vcsRoot;
			const repositoryId = pathChanged ? null : patch.reviewRepositoryId === undefined ? current.review_repository_id : patch.reviewRepositoryId;
			if (pathChanged || vcsKind !== current.vcs_kind) { this.invalidateFolderMutationGrant(bindingId, 'invalidated'); }
			this.db.prepare('UPDATE folder_bindings SET path = ?, vcs_kind = ?, vcs_root = ?, review_repository_id = ? WHERE id = ?')
				.run(path, vcsKind, vcsRoot, repositoryId, bindingId);
			return { id: String(current.id), projectId: String(current.project_id), path, vcsKind: vcsKind as VcsKind | null, vcsRoot: vcsRoot as string | null, reviewRepositoryId: repositoryId as string | null, createdAt: String(current.created_at) };
		});
	}

	rebindProjectFolder(projectId: string, newPath: string, expectedPath: string, vcs?: { vcsKind: VcsKind | null; vcsRoot: string | null }): WorkspaceFolderBinding {
		this.assertOpen();
		return this.transaction(() => {
			const current = this.db.prepare(`SELECT id, project_id, path, vcs_kind, vcs_root, review_repository_id, created_at
				FROM folder_bindings WHERE project_id = ? ORDER BY created_at, id LIMIT 1`).get(projectId);
			if (!current) { throw new Error(`Project ${projectId} has no folder binding.`); }
			if (String(current.path) !== expectedPath) { throw new Error(`Project ${projectId} folder changed before rebind.`); }
			const path = newPath.trim();
			if (!path) { throw new Error('A project folder path is required.'); }
			this.invalidateFolderMutationGrant(String(current.id), 'invalidated');
			const vcsKind = vcs?.vcsKind ?? null;
			const vcsRoot = vcs?.vcsRoot ?? null;
			this.db.prepare('UPDATE folder_bindings SET path = ?, vcs_kind = ?, vcs_root = ?, review_repository_id = NULL WHERE id = ?').run(path, vcsKind, vcsRoot, String(current.id));
			return { id: String(current.id), projectId, path, vcsKind, vcsRoot, reviewRepositoryId: null, createdAt: String(current.created_at) };
		});
	}

	createTask(input: { projectId: string; bindingId: string; title: string; description?: string | null; state?: TaskState; id?: string }): WorkspaceTask {
		this.assertOpen();
		const id = input.id ?? randomUUID();
		const now = new Date().toISOString();
		const state = input.state ?? 'ready';
		return this.transaction(() => {
			const order = Number(this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM tasks WHERE project_id = ? AND state = ? AND archived_at IS NULL AND trashed_at IS NULL').get(input.projectId, state)?.next_position ?? 0);
			this.db.prepare(`INSERT INTO tasks (id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, input.projectId, input.bindingId, input.title.trim(), input.description ?? null, state, order, now, now);
			return { id, projectId: input.projectId, bindingId: input.bindingId, title: input.title.trim(), description: input.description ?? null, state, order, revision: 1, createdAt: now, updatedAt: now, archivedAt: null, trashedAt: null, deletionPendingAt: null, deletionError: null, deletionRequestId: null };
		});
	}

	getTask(taskId: string): WorkspaceTask | undefined {
		this.assertOpen();
		const row = this.db.prepare(`SELECT id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at, archived_at, trashed_at, delete_pending_at, deletion_error, delete_request_id
			FROM tasks WHERE id = ?`).get(taskId);
		return row ? this.taskFromRow(row) : undefined;
	}

	listTasks(projectId: string, state?: TaskState): WorkspaceTask[] {
		this.assertOpen();
		const rows = state === undefined
			? this.db.prepare(`SELECT id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at, archived_at, trashed_at, delete_pending_at, deletion_error, delete_request_id
				FROM tasks WHERE project_id = ? AND archived_at IS NULL AND trashed_at IS NULL ORDER BY state, position, created_at, id`).all(projectId)
			: this.db.prepare(`SELECT id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at, archived_at, trashed_at, delete_pending_at, deletion_error, delete_request_id
				FROM tasks WHERE project_id = ? AND state = ? AND archived_at IS NULL AND trashed_at IS NULL ORDER BY position, created_at, id`).all(projectId, state);
		return rows.map(row => this.taskFromRow(row));
	}

	updateTask(taskId: string, expectedRevision: number, patch: { title?: string; description?: string | null; state?: TaskState }): WorkspaceTask {
		this.assertOpen();
		return this.transaction(() => {
			const current = this.getTask(taskId);
			if (!current || current.revision !== expectedRevision) {
				throw new TaskRevisionConflictError(taskId, expectedRevision);
			}
			if (current.archivedAt || current.trashedAt || current.deletionPendingAt) { throw new Error('Archived, trashed, or deletion-pending tasks must be restored or resolved before editing.'); }
			const title = patch.title === undefined ? current.title : patch.title.trim();
			const description = patch.description === undefined ? current.description : patch.description;
			const state = patch.state ?? current.state;
			const order = state === current.state
				? current.order
				: Number(this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM tasks WHERE project_id = ? AND state = ? AND archived_at IS NULL AND trashed_at IS NULL').get(current.projectId, state)?.next_position ?? 0);
			const updatedAt = new Date().toISOString();
			const result = this.db.prepare(`UPDATE tasks SET title = ?, description = ?, state = ?, position = ?, revision = revision + 1, updated_at = ?
				WHERE id = ? AND revision = ?`).run(title, description, state, order, updatedAt, taskId, expectedRevision);
			if (Number(result.changes) !== 1) { throw new TaskRevisionConflictError(taskId, expectedRevision); }
			if (state !== current.state) {
				this.db.prepare(`INSERT INTO task_state_audit (task_id, from_state, to_state, from_revision, to_revision, changed_at)
					VALUES (?, ?, ?, ?, ?, ?)`).run(taskId, current.state, state, current.revision, expectedRevision + 1, updatedAt);
			}
			return { ...current, title, description, state, order, revision: expectedRevision + 1, updatedAt };
		});
	}

	reorderTasks(projectId: string, state: TaskState, orderedTaskRevisions: ReadonlyArray<{ taskId: string; revision: number }>): WorkspaceTask[] {
		this.assertOpen();
		return this.transaction(() => {
			const current = this.db.prepare(`SELECT id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at, archived_at, trashed_at, delete_pending_at, deletion_error, delete_request_id
				FROM tasks WHERE project_id = ? AND state = ? AND archived_at IS NULL AND trashed_at IS NULL ORDER BY position, created_at, id`).all(projectId, state).map(row => this.taskFromRow(row));
			const expected = new Map(orderedTaskRevisions.map(item => [item.taskId, item.revision]));
			if (expected.size !== orderedTaskRevisions.length || expected.size !== current.length ||
				current.some(task => expected.get(task.id) !== task.revision)) {
				throw new TaskSetRevisionConflictError(projectId, state);
			}
			const byId = new Map(current.map(task => [task.id, task]));
			const reordered = orderedTaskRevisions.map(item => byId.get(item.taskId));
			if (reordered.some(task => task === undefined)) {
				throw new TaskSetRevisionConflictError(projectId, state);
			}
			const update = this.db.prepare(`UPDATE tasks SET position = ?, revision = revision + 1, updated_at = ?
				WHERE id = ? AND revision = ?`);
			const now = new Date().toISOString();
			for (const [position, task] of reordered.entries()) {
				const currentTask = task!;
				if (currentTask.order !== position) {
					const result = update.run(position, now, currentTask.id, currentTask.revision);
					if (Number(result.changes) !== 1) { throw new TaskSetRevisionConflictError(projectId, state); }
				}
			}
			return this.listTasks(projectId, state);
		});
	}

	listArchivedTasks(projectId: string): WorkspaceTask[] {
		this.assertOpen();
		return this.db.prepare(`SELECT id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at, archived_at, trashed_at, delete_pending_at, deletion_error, delete_request_id
			FROM tasks WHERE project_id = ? AND archived_at IS NOT NULL AND trashed_at IS NULL ORDER BY archived_at, id`).all(projectId).map(row => this.taskFromRow(row));
	}

	listTrashedTasks(projectId: string): WorkspaceTask[] {
		this.assertOpen();
		return this.db.prepare(`SELECT id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at, archived_at, trashed_at, delete_pending_at, deletion_error, delete_request_id
			FROM tasks WHERE project_id = ? AND trashed_at IS NOT NULL ORDER BY trashed_at, id`).all(projectId).map(row => this.taskFromRow(row));
	}

	archiveTask(taskId: string, expectedRevision: number): WorkspaceTask {
		this.assertOpen();
		return this.transaction(() => {
			const task = this.requireLifecycleRevision(taskId, expectedRevision);
			if (task.trashedAt) { throw new Error('Trashed tasks must be restored before they can be archived.'); }
			if (task.deletionPendingAt) { throw new Error('A pending deletion must be resolved before archiving.'); }
			if (task.archivedAt) { return task; }
			this.assertNoActiveAttempts(taskId, 'archive');
			this.assertAttemptsCleanupVerified(taskId, 'archive');
			const now = new Date().toISOString();
			this.db.prepare('UPDATE tasks SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(now, now, taskId, expectedRevision);
			this.clearSelectedTask(taskId);
			this.db.prepare(`INSERT INTO task_lifecycle_audit (task_id, action, from_revision, to_revision, changed_at) VALUES (?, 'archived', ?, ?, ?)`).run(taskId, expectedRevision, expectedRevision + 1, now);
			return this.getTask(taskId)!;
		});
	}

	restoreArchivedTask(taskId: string, expectedRevision: number): WorkspaceTask {
		this.assertOpen();
		return this.transaction(() => {
			const task = this.requireLifecycleRevision(taskId, expectedRevision);
			if (task.trashedAt) { throw new Error('Trashed tasks must be restored from Trash first.'); }
			if (!task.archivedAt) { return task; }
			const order = Number(this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM tasks WHERE project_id = ? AND state = ? AND archived_at IS NULL AND trashed_at IS NULL').get(task.projectId, task.state)?.next_position ?? 0);
			const now = new Date().toISOString();
			this.db.prepare('UPDATE tasks SET archived_at = NULL, position = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(order, now, taskId, expectedRevision);
			this.db.prepare(`INSERT INTO task_lifecycle_audit (task_id, action, from_revision, to_revision, changed_at) VALUES (?, 'restored', ?, ?, ?)`).run(taskId, expectedRevision, expectedRevision + 1, now);
			return this.getTask(taskId)!;
		});
	}

	beginTaskDeletion(taskId: string, expectedRevision: number, requestId: string): { task: WorkspaceTask; request: TaskDeletionRequest } {
		this.assertOpen();
		if (!requestId.trim()) { throw new Error('A stable Trash request ID is required.'); }
		return this.transaction(() => {
			const existing = this.getTaskDeletionRequest(requestId);
			if (existing) {
				if (existing.taskId !== taskId) { throw new Error('The Trash request ID is already bound to another task.'); }
				return { task: this.getTask(taskId)!, request: existing };
			}
			const task = this.requireLifecycleRevision(taskId, expectedRevision);
			if (task.trashedAt) { throw new Error('Task is already in Trash.'); }
			if (task.archivedAt) { throw new Error('Restore the archived task before moving it to Trash.'); }
			if (task.deletionPendingAt) { throw new Error('Task already has a pending deletion request.'); }
			const now = new Date().toISOString();
			this.db.prepare(`INSERT INTO task_trash_requests (request_id, task_id, prior_state, status, cleanup_error, created_at, updated_at, completed_at)
				VALUES (?, ?, ?, 'pending', NULL, ?, ?, NULL)`).run(requestId, taskId, task.state, now, now);
			this.db.prepare('UPDATE tasks SET delete_pending_at = ?, deletion_error = NULL, delete_request_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(now, requestId, now, taskId, expectedRevision);
			this.db.prepare(`INSERT INTO task_delete_audit (request_id, task_id, action, from_revision, to_revision, cleanup_error, changed_at)
				VALUES (?, ?, 'pending', ?, ?, NULL, ?)`).run(requestId, taskId, expectedRevision, expectedRevision + 1, now);
			return { task: this.getTask(taskId)!, request: this.getTaskDeletionRequest(requestId)! };
		});
	}

	finalizeTaskDeletion(taskId: string, requestId: string, cleanupSucceeded: boolean, cleanupError: string | null = null): WorkspaceTask {
		this.assertOpen();
		if (typeof cleanupSucceeded !== 'boolean') { throw new Error('An explicit cleanup result is required.'); }
		if (cleanupError !== null && (cleanupError.length > 512 || /[\r\n\u0000-\u001f]/.test(cleanupError))) { throw new Error('Cleanup failure must be a short, single-line message.'); }
		return this.transaction(() => {
			const request = this.getTaskDeletionRequest(requestId);
			if (!request || request.taskId !== taskId) { throw new Error('No matching pending deletion request exists.'); }
			const task = this.getTask(taskId);
			if (!task) { throw new Error(`Unknown task ${taskId}.`); }
			if (request.status === 'complete') { return task; }
			if (!task.deletionPendingAt) { throw new Error('The task deletion pending marker is missing.'); }
			const active = this.db.prepare("SELECT 1 FROM provider_attempts WHERE task_id = ? AND state NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted') LIMIT 1").get(taskId);
			const unverified = this.db.prepare("SELECT attempt_id FROM provider_attempts WHERE task_id = ? AND cleanup_verified = 0 ORDER BY created_at, attempt_id LIMIT 1").get(taskId);
			const failure = !cleanupSucceeded
				? cleanupError ?? 'Run and resource cleanup could not be verified.'
				: active ? 'Owned provider attempts are still active.'
					: unverified ? `Cleanup is not verified for attempt ${String(unverified.attempt_id)}.` : null;
			if (failure) {
				const now = new Date().toISOString();
				const revision = task.deletionError === failure ? task.revision : task.revision + 1;
				this.db.prepare('UPDATE tasks SET deletion_error = ?, revision = ?, updated_at = ? WHERE id = ?').run(failure, revision, now, taskId);
				this.db.prepare("UPDATE task_trash_requests SET cleanup_error = ?, updated_at = ? WHERE request_id = ? AND status = 'pending'").run(failure, now, requestId);
				if (revision !== task.revision) {
					this.db.prepare(`INSERT INTO task_delete_audit (request_id, task_id, action, from_revision, to_revision, cleanup_error, changed_at)
						VALUES (?, ?, 'cleanupFailed', ?, ?, ?, ?)`).run(requestId, taskId, task.revision, revision, failure, now);
				}
				return this.getTask(taskId)!;
			}
			const now = new Date().toISOString();
			const order = Number(this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM tasks WHERE project_id = ? AND state = ? AND archived_at IS NULL AND trashed_at IS NULL').get(task.projectId, request.priorState)?.next_position ?? 0);
			this.db.prepare('UPDATE tasks SET state = ?, position = ?, trashed_at = ?, trash_restore_state = ?, delete_pending_at = NULL, deletion_error = NULL, delete_request_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?')
				.run(request.priorState, order, now, request.priorState, now, taskId);
			this.db.prepare("UPDATE task_trash_requests SET status = 'complete', cleanup_error = NULL, updated_at = ?, completed_at = ? WHERE request_id = ?").run(now, now, requestId);
			this.db.prepare(`INSERT INTO task_lifecycle_audit (task_id, action, from_revision, to_revision, changed_at) VALUES (?, 'trashed', ?, ?, ?)`).run(taskId, task.revision, task.revision + 1, now);
			this.db.prepare(`INSERT INTO task_delete_audit (request_id, task_id, action, from_revision, to_revision, cleanup_error, changed_at)
				VALUES (?, ?, 'trashed', ?, ?, NULL, ?)`).run(requestId, taskId, task.revision, task.revision + 1, now);
			this.clearSelectedTask(taskId);
			return this.getTask(taskId)!;
		});
	}

	getTaskDeletionRequest(requestId: string): TaskDeletionRequest | undefined {
		this.assertOpen();
		const row = this.db.prepare('SELECT request_id, task_id, prior_state, status, cleanup_error, created_at, updated_at, completed_at FROM task_trash_requests WHERE request_id = ?').get(requestId);
		return row ? {
			requestId: String(row.request_id), taskId: String(row.task_id), priorState: row.prior_state as TaskState,
			status: row.status as TaskDeletionRequest['status'], cleanupError: row.cleanup_error as string | null,
			createdAt: String(row.created_at), updatedAt: String(row.updated_at), completedAt: row.completed_at as string | null,
		} : undefined;
	}

	listPendingTaskDeletions(projectId?: string): TaskDeletionRequest[] {
		this.assertOpen();
		const rows = projectId === undefined
			? this.db.prepare("SELECT request_id FROM task_trash_requests WHERE status = 'pending' ORDER BY created_at, request_id").all()
			: this.db.prepare("SELECT request_id FROM task_trash_requests r JOIN tasks t ON t.id = r.task_id WHERE r.status = 'pending' AND t.project_id = ? ORDER BY r.created_at, r.request_id").all(projectId);
		return rows.map(row => this.getTaskDeletionRequest(String(row.request_id))!);
	}

	hasAttemptsRequiringCleanup(taskId: string): boolean {
		this.assertOpen();
		return this.db.prepare("SELECT 1 FROM provider_attempts WHERE task_id = ? AND (state NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted') OR cleanup_verified = 0) LIMIT 1").get(taskId) !== undefined;
	}

	trashTask(taskId: string, expectedRevision: number, requestId: string): WorkspaceTask {
		const pending = this.beginTaskDeletion(taskId, expectedRevision, requestId);
		if (pending.request.status === 'complete' || pending.task.trashedAt) { return pending.task; }
		const trashed = this.finalizeTaskDeletion(taskId, requestId, true);
		if (!trashed.trashedAt) { throw new Error(trashed.deletionError ?? 'Task deletion remains pending cleanup.'); }
		return trashed;
	}

	restoreTrashedTask(taskId: string, expectedRevision: number): WorkspaceTask {
		this.assertOpen();
		return this.transaction(() => {
			const task = this.requireLifecycleRevision(taskId, expectedRevision);
			if (task.deletionPendingAt) { throw new Error('A pending deletion must be resolved before restoring from Trash.'); }
			if (!task.trashedAt) { return task; }
			const priorState = this.db.prepare('SELECT trash_restore_state FROM tasks WHERE id = ?').get(taskId)?.trash_restore_state;
			if (!priorState) { throw new Error('The task Trash record has no saved board state.'); }
			const state = priorState as TaskState;
			const order = Number(this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM tasks WHERE project_id = ? AND state = ? AND archived_at IS NULL AND trashed_at IS NULL').get(task.projectId, state)?.next_position ?? 0);
			const now = new Date().toISOString();
			this.db.prepare('UPDATE tasks SET state = ?, position = ?, trashed_at = NULL, trash_restore_state = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(state, order, now, taskId, expectedRevision);
			this.db.prepare(`INSERT INTO task_lifecycle_audit (task_id, action, from_revision, to_revision, changed_at) VALUES (?, 'trashRestored', ?, ?, ?)`).run(taskId, expectedRevision, expectedRevision + 1, now);
			return this.getTask(taskId)!;
		});
	}

	private requireLifecycleRevision(taskId: string, expectedRevision: number): WorkspaceTask {
		const task = this.getTask(taskId);
		if (!task || task.revision !== expectedRevision) { throw new TaskLifecycleConflictError(taskId, expectedRevision); }
		return task;
	}

	private assertNoActiveAttempts(taskId: string, action: 'archive' | 'trash'): void {
		const active = this.db.prepare("SELECT 1 FROM provider_attempts WHERE task_id = ? AND state NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted') LIMIT 1").get(taskId);
		if (active) { throw new TaskHasActiveRunsError(taskId, action); }
	}

	private assertAttemptsCleanupVerified(taskId: string, action: 'archive' | 'trash'): void {
		const attempt = this.db.prepare('SELECT attempt_id FROM provider_attempts WHERE task_id = ? AND cleanup_verified = 0 ORDER BY created_at, attempt_id LIMIT 1').get(taskId);
		if (attempt) { throw new TaskCleanupNotVerifiedError(taskId, String(attempt.attempt_id), action); }
	}

	private clearSelectedTask(taskId: string): void {
		this.db.prepare('UPDATE project_views SET selected_task_id = NULL WHERE selected_task_id = ?').run(taskId);
	}

	enqueueReviewRequest(input: { commandId?: string; taskId: string; body: string }): ReviewOutboxCommand {
		this.assertOpen();
		const commandId = input.commandId ?? randomUUID();
		const existing = this.getReviewCommand(commandId);
		if (existing) {
			if (existing.taskId !== input.taskId || existing.body !== input.body) { throw new ReviewCommandConflictError(commandId); }
			return existing;
		}
		const createdAt = new Date().toISOString();
		this.db.prepare(`INSERT INTO review_outbox (command_id, task_id, body, status, created_at)
			VALUES (?, ?, ?, 'pending', ?)`).run(commandId, input.taskId, input.body, createdAt);
		return { commandId, taskId: input.taskId, body: input.body, status: 'pending', lastError: null, reviewId: null, createdAt, completedAt: null };
	}

	getReviewCommand(commandId: string): ReviewOutboxCommand | undefined {
		this.assertOpen();
		const row = this.db.prepare(`SELECT command_id, task_id, body, status, last_error, review_id, created_at, completed_at
			FROM review_outbox WHERE command_id = ?`).get(commandId);
		return row ? this.outboxFromRow(row) : undefined;
	}

	listReviewCommands(taskId: string): ReviewOutboxCommand[] {
		this.assertOpen();
		return this.db.prepare(`SELECT command_id, task_id, body, status, last_error, review_id, created_at, completed_at
			FROM review_outbox WHERE task_id = ? ORDER BY created_at, command_id`).all(taskId).map(row => this.outboxFromRow(row));
	}

	markReviewRequestFailed(commandId: string, message: string): ReviewOutboxCommand {
		this.assertOpen();
		return this.transaction(() => {
			const result = this.db.prepare(`UPDATE review_outbox SET status = 'failed', last_error = ?
				WHERE command_id = ? AND status != 'complete'`).run(message, commandId);
			const command = this.getReviewCommand(commandId);
			if (!command) { throw new Error(`Unknown review command ${commandId}.`); }
			return Number(result.changes) === 0 ? command : this.getReviewCommand(commandId)!;
		});
	}

	completeReviewRequest(commandId: string, reviewId: string): ReviewOutboxCommand {
		this.assertOpen();
		return this.transaction(() => {
			const command = this.getReviewCommand(commandId);
			if (!command) { throw new Error(`Unknown review command ${commandId}.`); }
			if (command.status === 'complete') {
				if (command.reviewId !== reviewId) { throw new ReviewCompletionConflictError(commandId); }
				return command;
			}
			const now = new Date().toISOString();
			this.db.prepare(`UPDATE review_outbox SET status = 'complete', last_error = NULL, review_id = ?, completed_at = ? WHERE command_id = ?`)
				.run(reviewId, now, commandId);
			const hasPrimary = this.db.prepare('SELECT 1 FROM task_review_links WHERE task_id = ? AND is_primary = 1').get(command.taskId) !== undefined;
			this.db.prepare(`INSERT INTO task_review_links (task_id, review_id, state, is_primary, created_at) VALUES (?, ?, 'available', ?, ?)
				ON CONFLICT(task_id, review_id) DO NOTHING`).run(command.taskId, reviewId, hasPrimary ? 0 : 1, now);
			return this.getReviewCommand(commandId)!;
		});
	}

	listTaskReviews(taskId: string): TaskReviewLink[] {
		this.assertOpen();
		return this.db.prepare(`SELECT task_id, review_id, state, is_primary, created_at FROM task_review_links
			WHERE task_id = ? ORDER BY is_primary DESC, created_at, review_id`).all(taskId).map(row => ({
			taskId: String(row.task_id), reviewId: String(row.review_id), state: row.state as TaskReviewLink['state'],
			isPrimary: Number(row.is_primary) === 1, createdAt: String(row.created_at),
		}));
	}

	setTaskReviewAvailability(taskId: string, reviewId: string, state: TaskReviewLink['state']): TaskReviewLink | undefined {
		this.assertOpen();
		this.db.prepare('UPDATE task_review_links SET state = ? WHERE task_id = ? AND review_id = ?').run(state, taskId, reviewId);
		return this.listTaskReviews(taskId).find(link => link.reviewId === reviewId);
	}

	choosePrimaryReview(taskId: string, expectedRevision: number, reviewId: string): TaskReviewLink {
		this.assertOpen();
		return this.transaction(() => {
			const task = this.getTask(taskId);
			if (!task || task.revision !== expectedRevision) { throw new TaskRevisionConflictError(taskId, expectedRevision); }
			const selected = this.db.prepare('SELECT 1 FROM task_review_links WHERE task_id = ? AND review_id = ?').get(taskId, reviewId);
			if (!selected) { throw new Error(`Review ${reviewId} is not linked to task ${taskId}.`); }
			const revision = this.db.prepare('UPDATE tasks SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
				.run(new Date().toISOString(), taskId, expectedRevision);
			if (Number(revision.changes) !== 1) { throw new TaskRevisionConflictError(taskId, expectedRevision); }
			this.db.prepare('UPDATE task_review_links SET is_primary = 0 WHERE task_id = ?').run(taskId);
			this.db.prepare('UPDATE task_review_links SET is_primary = 1 WHERE task_id = ? AND review_id = ?').run(taskId, reviewId);
			return this.listTaskReviews(taskId).find(link => link.reviewId === reviewId)!;
		});
	}

	getProjectView(projectId: string): ProjectView | undefined {
		this.assertOpen();
		const row = this.db.prepare(`SELECT project_id, descriptor_uri, open_at_quit, selected_task_id, dashboard_position
			FROM project_views WHERE project_id = ?`).get(projectId);
		return row ? this.projectViewFromRow(row) : undefined;
	}

	createWorkspaceE2eEvidence(input: {
		id?: string; projectId: string; taskId: string; attemptId: string; targetUrl: string; environmentIdentity: string;
		scenario: readonly WorkspaceE2eStep[]; taskSpaceId: number;
	}): WorkspaceE2eEvidence {
		this.assertOpen();
		if (!Number.isSafeInteger(input.taskSpaceId) || input.taskSpaceId < 1) { throw new Error('A durable Ego TaskSpace ID is required.'); }
		return this.transaction(() => {
			const task = this.getTask(input.taskId);
			const attempt = this.getProviderAttempt(input.attemptId);
			if (!task || task.projectId !== input.projectId || task.archivedAt || task.trashedAt || task.deletionPendingAt) { throw new Error('E2E evidence requires an active task in this project.'); }
			if (!attempt || attempt.taskId !== task.id || attempt.purpose !== 'task') { throw new Error('E2E evidence requires a provider attempt linked to this task.'); }
			const binding = this.listFolderBindings(input.projectId).find(item => item.id === task.bindingId);
			if (!binding) { throw new Error('The task checkout binding is unavailable.'); }
			const id = input.id ?? randomUUID();
			const now = new Date().toISOString();
			const checkoutSnapshot = JSON.stringify({ bindingId: binding.id, path: binding.path, vcsKind: binding.vcsKind, vcsRoot: binding.vcsRoot, reviewRepositoryId: binding.reviewRepositoryId, folderIdentity: attempt.folderIdentity, cwd: attempt.cwd });
			const requesterSnapshot = JSON.stringify({ attemptId: attempt.attemptId, provider: attempt.provider, profileRef: attempt.profileRef, requestedAt: now });
			this.db.prepare(`INSERT INTO frontend_e2e_evidence (id, project_id, task_id, attempt_id, target_url, environment_identity, scenario_json, checkout_snapshot, requester_snapshot, task_space_id, state, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`).run(id, input.projectId, input.taskId, input.attemptId, input.targetUrl, input.environmentIdentity, JSON.stringify(input.scenario), checkoutSnapshot, requesterSnapshot, input.taskSpaceId, now);
			return this.getWorkspaceE2eEvidence(id)!;
		});
	}

	getWorkspaceE2eEvidence(id: string): WorkspaceE2eEvidence | undefined {
		this.assertOpen();
		const row = this.db.prepare('SELECT * FROM frontend_e2e_evidence WHERE id = ?').get(id);
		return row ? this.workspaceE2eEvidenceFromRow(row) : undefined;
	}

	listWorkspaceE2eEvidence(taskId: string): WorkspaceE2eEvidence[] {
		this.assertOpen();
		return this.db.prepare('SELECT * FROM frontend_e2e_evidence WHERE task_id = ? ORDER BY created_at, id').all(taskId).map(row => this.workspaceE2eEvidenceFromRow(row));
	}

	finishWorkspaceE2eEvidence(input: { id: string; state: 'passed' | 'failed' | 'cancelled' | 'cleanupFailed'; screenshotSha256: string | null; screenshotPath: string | null; logSha256: string | null; logPath: string | null; failure: string | null; cleanupError: string | null }): WorkspaceE2eEvidence {
		this.assertOpen();
		const hasArtifacts = !!(input.screenshotSha256 && input.screenshotPath && input.logSha256 && input.logPath);
		const artifactFields = [input.screenshotSha256, input.screenshotPath, input.logSha256, input.logPath];
		if (artifactFields.some(field => field !== null) && !hasArtifacts) { throw new Error('E2E artifacts must have both paths and hashes.'); }
		if (input.state !== 'cleanupFailed' && (input.cleanupError !== null || (!hasArtifacts && (input.state !== 'failed' || !input.failure)))) {
			throw new Error('Completed E2E evidence requires artifacts, or an explicit failed capture after confirmed cleanup.');
		}
		return this.transaction(() => {
			const current = this.getWorkspaceE2eEvidence(input.id);
			if (!current) { throw new Error(`Unknown E2E evidence ${input.id}.`); }
			if (current.state !== 'running' && current.state !== 'cleanupFailed') { return current; }
			const state = input.state;
			const now = new Date().toISOString();
			this.db.prepare(`UPDATE frontend_e2e_evidence SET state = ?, screenshot_sha256 = COALESCE(?, screenshot_sha256), screenshot_path = COALESCE(?, screenshot_path), log_sha256 = COALESCE(?, log_sha256), log_path = COALESCE(?, log_path), failure = COALESCE(?, failure), cleanup_error = ?, completed_at = ? WHERE id = ?`)
				.run(state, input.screenshotSha256, input.screenshotPath, input.logSha256, input.logPath, input.failure, input.cleanupError, state === 'cleanupFailed' ? null : now, input.id);
			return this.getWorkspaceE2eEvidence(input.id)!;
		});
	}

	findProjectViewByDescriptorUri(descriptorUri: string): ProjectView | undefined {
		this.assertOpen();
		const row = this.db.prepare(`SELECT project_id, descriptor_uri, open_at_quit, selected_task_id, dashboard_position
			FROM project_views WHERE descriptor_uri = ?`).get(descriptorUri);
		return row ? this.projectViewFromRow(row) : undefined;
	}

	setProjectView(view: ProjectView): ProjectView {
		this.assertOpen();
		if (view.selectedTaskId !== null && this.db.prepare('SELECT 1 FROM tasks WHERE id = ? AND project_id = ? AND archived_at IS NULL AND trashed_at IS NULL').get(view.selectedTaskId, view.projectId) === undefined) {
			throw new Error('The selected task must belong to this project and be visible on its board.');
		}
		this.db.prepare(`INSERT INTO project_views (project_id, descriptor_uri, open_at_quit, selected_task_id, dashboard_position)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(project_id) DO UPDATE SET descriptor_uri = excluded.descriptor_uri, open_at_quit = excluded.open_at_quit,
				selected_task_id = excluded.selected_task_id, dashboard_position = excluded.dashboard_position`)
			.run(view.projectId, view.descriptorUri, view.openAtQuit ? 1 : 0, view.selectedTaskId, view.dashboardPosition);
		return view;
	}

	updateProjectDashboardState(input: { projectId: string; expectedDescriptorUri: string; selectedTaskId: string | null; dashboardPosition: string | null }): ProjectView {
		this.assertOpen();
		if (input.dashboardPosition !== null && (!/^(0|[1-9][0-9]*)$/.test(input.dashboardPosition) || Number(input.dashboardPosition) > maximumDashboardPositionPixels)) {
			throw new Error('Dashboard position must be an integer pixel value from 0 to 10000000.');
		}
		return this.transaction(() => {
			const view = this.getProjectView(input.projectId);
			if (!view) { throw new Error(`Project view ${input.projectId} is unavailable.`); }
			if (view.descriptorUri !== input.expectedDescriptorUri) { throw new Error('The project workspace changed before dashboard state was saved.'); }
			if (input.selectedTaskId !== null) {
				const task = this.db.prepare('SELECT 1 FROM tasks WHERE id = ? AND project_id = ? AND archived_at IS NULL AND trashed_at IS NULL').get(input.selectedTaskId, input.projectId);
				if (!task) { throw new Error('The selected task does not belong to this project.'); }
			}
			this.db.prepare('UPDATE project_views SET selected_task_id = ?, dashboard_position = ? WHERE project_id = ?')
				.run(input.selectedTaskId, input.dashboardPosition, input.projectId);
			return this.getProjectView(input.projectId)!;
		});
	}

	close(): void {
		if (!this.closed) {
			this.db.close();
			this.closed = true;
		}
	}

	private invalidateFolderMutationGrant(bindingId: string, action: 'revoked' | 'invalidated'): void {
		const row = this.db.prepare(`SELECT binding_id, project_id, canonical_path, dev, ino, granted_at FROM folder_mutation_grants
			WHERE binding_id = ?`).get(bindingId);
		if (!row) { return; }
		const grant: FolderMutationGrant = {
			bindingId: String(row.binding_id), projectId: String(row.project_id), canonicalPath: String(row.canonical_path),
			dev: String(row.dev), ino: String(row.ino), grantedAt: String(row.granted_at),
		};
		this.db.prepare('DELETE FROM folder_mutation_grants WHERE binding_id = ?').run(bindingId);
		this.auditFolderMutationGrant(grant, action);
	}

	private auditFolderMutationGrant(grant: FolderMutationGrant, action: 'enabled' | 'revoked' | 'invalidated'): void {
		this.db.prepare(`INSERT INTO folder_mutation_grant_audit
			(binding_id, project_id, action, canonical_path, dev, ino, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
			grant.bindingId, grant.projectId, action, grant.canonicalPath, grant.dev, grant.ino, new Date().toISOString(),
		);
	}

	private transaction<T>(operation: () => T): T {
		const nested = this.db.isTransaction;
		this.db.exec(nested ? 'SAVEPOINT workspace_database;' : 'BEGIN IMMEDIATE;');
		try {
			const value = operation();
			this.db.exec(nested ? 'RELEASE SAVEPOINT workspace_database;' : 'COMMIT;');
			return value;
		} catch (error) {
			this.db.exec(nested ? 'ROLLBACK TO SAVEPOINT workspace_database; RELEASE SAVEPOINT workspace_database;' : 'ROLLBACK;');
			throw error;
		}
	}

	private assertOpen(): void {
		if (this.closed) { throw new Error('workspace.db is closed.'); }
	}

	private projectFromRow(row: Record<string, SQLOutputValue>): WorkspaceProject {
		return { id: String(row.id), name: String(row.name), createdAt: String(row.created_at) };
	}

	private connectorAccountFromRow(row: Record<string, SQLOutputValue>): ConnectorAccount {
		return {
			id: String(row.id), projectId: String(row.project_id), provider: row.provider as ConnectorAccount['provider'],
			label: String(row.label), remoteIdentity: String(row.remote_identity), state: row.state as ConnectorAccount['state'],
			createdAt: String(row.created_at), updatedAt: String(row.updated_at),
		};
	}

	private installedConnectorPackageFromRow(row: Record<string, SQLOutputValue>): InstalledConnectorPackage {
		return {
			projectId: String(row.project_id), packageId: String(row.package_id), version: String(row.version), name: String(row.name),
			fingerprint: String(row.fingerprint), manifestDigest: String(row.manifest_digest),
			manifestBytesBase64: String(row.manifest_bytes_base64), signatureBase64: String(row.signature_base64),
			publicKeyBase64: String(row.public_key_base64), installedAt: String(row.installed_at), updatedAt: String(row.updated_at),
		};
	}

	private bindingFromRow(row: Record<string, SQLOutputValue>): WorkspaceFolderBinding {
		return {
			id: String(row.id), projectId: String(row.project_id), path: String(row.path), vcsKind: row.vcs_kind as VcsKind | null,
			vcsRoot: row.vcs_root as string | null, reviewRepositoryId: row.review_repository_id as string | null, createdAt: String(row.created_at),
		};
	}

	private taskFromRow(row: Record<string, SQLOutputValue>): WorkspaceTask {
		return {
			id: String(row.id), projectId: String(row.project_id), bindingId: String(row.binding_id), title: String(row.title),
			description: row.description as string | null, state: row.state as TaskState, order: Number(row.position), revision: Number(row.revision),
			createdAt: String(row.created_at), updatedAt: String(row.updated_at),
			archivedAt: row.archived_at as string | null, trashedAt: row.trashed_at as string | null,
			deletionPendingAt: row.delete_pending_at as string | null, deletionError: row.deletion_error as string | null,
			deletionRequestId: row.delete_request_id as string | null,
		};
	}

	private outboxFromRow(row: Record<string, SQLOutputValue>): ReviewOutboxCommand {
		return {
			commandId: String(row.command_id), taskId: String(row.task_id), body: String(row.body), status: row.status as ReviewOutboxStatus,
			lastError: row.last_error as string | null, reviewId: row.review_id as string | null, createdAt: String(row.created_at), completedAt: row.completed_at as string | null,
		};
	}

	private projectViewFromRow(row: Record<string, SQLOutputValue>): ProjectView {
		return {
			projectId: String(row.project_id), descriptorUri: String(row.descriptor_uri), openAtQuit: Number(row.open_at_quit) === 1,
			selectedTaskId: row.selected_task_id as string | null, dashboardPosition: row.dashboard_position as string | null,
		};
	}

	private providerAttemptFromRow(row: Record<string, SQLOutputValue>): ProviderAttempt {
		return {
			attemptId: String(row.attempt_id), taskId: String(row.task_id), provider: row.provider as ProviderKind,
			purpose: row.purpose as ProviderAttemptPurpose,
			profileRef: row.profile_ref as string | null, folderIdentity: String(row.folder_identity), cwd: String(row.cwd), mode: String(row.mode),
			prompt: String(row.prompt), promptHash: String(row.prompt_hash), conventionSnapshotId: row.convention_snapshot_id as string | null,
			refSnapshotId: row.ref_snapshot_id as string | null, refSnapshotIds: JSON.parse(String(row.ref_snapshot_ids_json)) as string[], state: row.state as ProviderAttemptState,
			providerSessionId: row.provider_session_id as string | null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
			startedAt: row.started_at as string | null, finishedAt: row.finished_at as string | null, errorSummary: row.error_summary as string | null,
			cleanupVerified: Number(row.cleanup_verified) === 1, ownedPgid: row.owned_pgid === null ? null : Number(row.owned_pgid), launchGateVersion: row.launch_gate_version === null ? null : 1,
			parentAttemptId: row.parent_attempt_id as string | null, childScope: row.child_scope_json as string | null,
			resultText: row.result_text as string | null, resultSha256: row.result_sha256 as string | null,
			orchestrationPhase: row.orchestration_phase as ProviderAttempt['orchestrationPhase'],
			runningTaskRevision: row.running_task_revision === null ? null : Number(row.running_task_revision),
		};
	}

	private workspaceE2eEvidenceFromRow(row: Record<string, SQLOutputValue>): WorkspaceE2eEvidence {
		return {
			id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id), attemptId: String(row.attempt_id),
			targetUrl: String(row.target_url), environmentIdentity: String(row.environment_identity), scenario: JSON.parse(String(row.scenario_json)) as WorkspaceE2eStep[],
			checkoutSnapshot: String(row.checkout_snapshot), requesterSnapshot: String(row.requester_snapshot), taskSpaceId: Number(row.task_space_id),
			state: row.state as WorkspaceE2eEvidence['state'], screenshotSha256: row.screenshot_sha256 as string | null,
			screenshotPath: row.screenshot_path as string | null, logSha256: row.log_sha256 as string | null, logPath: row.log_path as string | null,
			failure: row.failure as string | null, cleanupError: row.cleanup_error as string | null, createdAt: String(row.created_at), completedAt: row.completed_at as string | null,
		};
	}
}
