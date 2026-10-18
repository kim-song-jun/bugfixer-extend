-- Frozen v22 SQLite schema fixture; not production migration code.
-- Source commit: 58035ecf59522621827f0cd10ce37178f1182455
-- Source file: whiteboard/apps/review-desktop/code-oss/src/vs/workspace/electron-main/workspaceDatabase.ts
-- DDL below was statically extracted from migrateV1 through migrateV21 in source order.
PRAGMA foreign_keys = ON;

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

ALTER TABLE provider_attempts ADD COLUMN launch_gate_version INTEGER CHECK (launch_gate_version = 1 OR launch_gate_version IS NULL);
			PRAGMA user_version = 6;

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

ALTER TABLE provider_attempts ADD COLUMN ref_snapshot_ids_json TEXT NOT NULL DEFAULT '[]';
			UPDATE provider_attempts SET ref_snapshot_ids_json = json_array(ref_snapshot_id) WHERE ref_snapshot_id IS NOT NULL;
			PRAGMA user_version = 11;

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

ALTER TABLE reference_snapshots ADD COLUMN derived_text TEXT NOT NULL DEFAULT '';
			DROP TRIGGER reference_snapshot_immutable;
			UPDATE reference_snapshots SET derived_text = CAST(content AS TEXT)
				WHERE content_type = 'text/plain; charset=utf-8';
			CREATE TRIGGER reference_snapshot_immutable BEFORE UPDATE ON reference_snapshots
			BEGIN SELECT RAISE(ABORT, 'reference snapshots are immutable'); END;
			PRAGMA user_version = 15;

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

ALTER TABLE frontend_e2e_evidence ADD COLUMN checkout_revision TEXT;
			ALTER TABLE frontend_e2e_evidence ADD COLUMN checkout_revision_unavailable_reason TEXT DEFAULT 'Revision capture was not available when this evidence was recorded.';
			PRAGMA user_version = 17;

ALTER TABLE project_views ADD COLUMN last_opened_at TEXT;
			PRAGMA user_version = 18;

CREATE TABLE package_connections (
				account_ref TEXT PRIMARY KEY NOT NULL,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
				package_id TEXT NOT NULL,
				manifest_digest TEXT NOT NULL,
				host TEXT NOT NULL,
				granted_scopes_json TEXT NOT NULL CHECK (json_valid(granted_scopes_json)),
				label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 200),
				auth_kind TEXT NOT NULL CHECK (auth_kind IN ('none', 'bearer-token')),
				state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'disconnecting', 'disconnected')),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				FOREIGN KEY (project_id, package_id) REFERENCES connector_packages(project_id, package_id) ON DELETE CASCADE
			) STRICT;
			CREATE INDEX package_connections_scope ON package_connections(project_id, package_id, state, created_at);
			PRAGMA user_version = 19;

CREATE TABLE task_reference_instruction_promotions (
				id TEXT PRIMARY KEY NOT NULL,
				task_id TEXT NOT NULL,
				snapshot_id TEXT NOT NULL,
				excerpt TEXT NOT NULL CHECK (length(trim(excerpt)) > 0 AND length(excerpt) <= 4000 AND length(CAST(excerpt AS BLOB)) <= 16384),
				excerpt_sha256 TEXT NOT NULL CHECK (length(excerpt_sha256) = 64),
				approved_at TEXT NOT NULL,
				FOREIGN KEY (task_id, snapshot_id) REFERENCES task_reference_links(task_id, snapshot_id) ON DELETE RESTRICT
			) STRICT;
			CREATE TABLE task_reference_instruction_withdrawals (
				action_id TEXT PRIMARY KEY NOT NULL,
				promotion_id TEXT NOT NULL UNIQUE REFERENCES task_reference_instruction_promotions(id) ON DELETE RESTRICT,
				withdrawn_at TEXT NOT NULL
			) STRICT;
			CREATE TRIGGER task_instruction_promotion_immutable_update BEFORE UPDATE ON task_reference_instruction_promotions
			BEGIN SELECT RAISE(ABORT, 'task instruction promotions are immutable'); END;
			CREATE TRIGGER task_instruction_promotion_immutable_delete BEFORE DELETE ON task_reference_instruction_promotions
			BEGIN SELECT RAISE(ABORT, 'task instruction promotions are immutable'); END;
			CREATE TRIGGER task_instruction_withdrawal_immutable_update BEFORE UPDATE ON task_reference_instruction_withdrawals
			BEGIN SELECT RAISE(ABORT, 'task instruction withdrawals are immutable'); END;
			CREATE TRIGGER task_instruction_withdrawal_immutable_delete BEFORE DELETE ON task_reference_instruction_withdrawals
			BEGIN SELECT RAISE(ABORT, 'task instruction withdrawals are immutable'); END;
			ALTER TABLE provider_attempts ADD COLUMN approved_instructions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(approved_instructions_json));
			PRAGMA user_version = 20;

ALTER TABLE provider_attempts ADD COLUMN control_version INTEGER CHECK (control_version = 1 OR control_version IS NULL);
			ALTER TABLE provider_attempts ADD COLUMN control_nonce TEXT CHECK (
				(control_nonce IS NULL AND control_version IS NULL)
				OR (control_version IS 1 AND control_nonce IS NOT NULL AND length(control_nonce) = 64 AND control_nonce NOT GLOB '*[^0-9a-f]*')
			);
			PRAGMA user_version = 21;


-- Representative historical data retained by the v21 to v22 migration.
INSERT INTO projects (id, name, created_at)
VALUES ('00000000-0000-4000-8000-000000000021', 'Frozen v21 project', '2026-10-18T00:00:00.000Z');
INSERT INTO folder_bindings (id, project_id, path, vcs_kind, vcs_root, review_repository_id, created_at)
VALUES ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000021', '/fixture/v21', NULL, NULL, NULL, '2026-10-18T00:00:00.000Z');
INSERT INTO tasks (id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000022', 'Preserved v21 task', 'Existing task data must survive schema v22.', 'ready', 0, 4, '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z');


-- Frozen v22 schema fixture; v22 DDL statically extracted from source commit 5275063.
CREATE TABLE agent_sessions (
	id TEXT PRIMARY KEY NOT NULL,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	binding_id TEXT NOT NULL,
	task_id TEXT,
	parent_session_id TEXT,
	name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
	provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
	model TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 200),
	profile_ref TEXT CHECK (profile_ref IS NULL OR length(trim(profile_ref)) <= 512),
	workspace_mode TEXT NOT NULL CHECK (workspace_mode IN ('gitWorktree', 'sharedFolder')),
	state TEXT NOT NULL CHECK (state IN ('created', 'starting', 'running', 'waitingForInput', 'waitingForApproval', 'idle', 'stopping', 'stopped', 'interrupted', 'failed')),
	revision INTEGER NOT NULL CHECK (revision > 0),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (id, project_id),
	FOREIGN KEY (binding_id, project_id) REFERENCES folder_bindings(id, project_id) ON DELETE RESTRICT,
	FOREIGN KEY (task_id, project_id) REFERENCES tasks(id, project_id) ON DELETE RESTRICT,
	FOREIGN KEY (parent_session_id, project_id) REFERENCES agent_sessions(id, project_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_sessions_project_created ON agent_sessions(project_id, created_at, id);
CREATE INDEX agent_sessions_parent ON agent_sessions(parent_session_id, created_at, id);
CREATE TRIGGER agent_session_task_owner_insert BEFORE INSERT ON agent_sessions WHEN NEW.task_id IS NOT NULL
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM tasks task WHERE task.id = NEW.task_id AND task.project_id = NEW.project_id AND task.binding_id = NEW.binding_id
	) THEN RAISE(ABORT, 'agent session task must match project and binding ownership') END;
END;
CREATE TRIGGER agent_session_task_owner_update BEFORE UPDATE OF project_id, binding_id, task_id ON agent_sessions WHEN NEW.task_id IS NOT NULL
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM tasks task WHERE task.id = NEW.task_id AND task.project_id = NEW.project_id AND task.binding_id = NEW.binding_id
	) THEN RAISE(ABORT, 'agent session task must match project and binding ownership') END;
END;
CREATE TRIGGER agent_session_parent_owner_insert BEFORE INSERT ON agent_sessions WHEN NEW.parent_session_id IS NOT NULL
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM agent_sessions parent WHERE parent.id = NEW.parent_session_id
		AND parent.project_id = NEW.project_id AND parent.binding_id = NEW.binding_id
		AND parent.task_id IS NEW.task_id
	) THEN RAISE(ABORT, 'agent session parent must match project, binding, and task ownership') END;
END;
CREATE TRIGGER agent_session_parent_owner_update BEFORE UPDATE OF project_id, binding_id, task_id, parent_session_id ON agent_sessions WHEN NEW.parent_session_id IS NOT NULL
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM agent_sessions parent WHERE parent.id = NEW.parent_session_id
		AND parent.project_id = NEW.project_id AND parent.binding_id = NEW.binding_id
		AND parent.task_id IS NEW.task_id
	) THEN RAISE(ABORT, 'agent session parent must match project, binding, and task ownership') END;
END;

CREATE TABLE agent_session_messages (
	id TEXT PRIMARY KEY NOT NULL,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	sender_session_id TEXT NOT NULL,
	recipient_session_id TEXT NOT NULL,
	sequence INTEGER NOT NULL CHECK (sequence > 0),
	idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
	body TEXT NOT NULL CHECK (length(body) <= 16384 AND length(CAST(body AS BLOB)) <= 65536),
	created_at TEXT NOT NULL,
	read_at TEXT,
	UNIQUE (project_id, sender_session_id, idempotency_key),
	UNIQUE (project_id, recipient_session_id, sequence),
	UNIQUE (id, project_id),
	FOREIGN KEY (sender_session_id, project_id) REFERENCES agent_sessions(id, project_id) ON DELETE RESTRICT,
	FOREIGN KEY (recipient_session_id, project_id) REFERENCES agent_sessions(id, project_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_messages_inbox ON agent_session_messages(project_id, recipient_session_id, sequence);

CREATE TABLE agent_session_notifications (
	id TEXT PRIMARY KEY NOT NULL,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	session_id TEXT NOT NULL,
	sequence INTEGER NOT NULL CHECK (sequence > 0),
	kind TEXT NOT NULL CHECK (kind = 'message'),
	message_id TEXT NOT NULL UNIQUE REFERENCES agent_session_messages(id) ON DELETE RESTRICT,
	created_at TEXT NOT NULL,
	read_at TEXT,
	UNIQUE (project_id, sequence),
	FOREIGN KEY (session_id, project_id) REFERENCES agent_sessions(id, project_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_notifications_page ON agent_session_notifications(project_id, sequence);
PRAGMA user_version = 22;
