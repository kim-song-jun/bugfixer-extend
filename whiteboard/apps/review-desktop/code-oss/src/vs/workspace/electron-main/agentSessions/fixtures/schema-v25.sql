-- Frozen v25 schema delta fixture, appended to schema-v24.sql by the migration test.
-- Source commit: 557add5b31c7bc98678008d940bf4209ecee4406
-- Source file: whiteboard/apps/review-desktop/code-oss/src/vs/workspace/electron-main/workspaceDatabase.ts
-- Source method: migrateV25; this is frozen DDL, independent of the live migration implementation.
CREATE TABLE agent_workflows (
	id TEXT PRIMARY KEY NOT NULL,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	binding_id TEXT NOT NULL,
	task_id TEXT,
	create_idempotency_key TEXT NOT NULL CHECK (length(trim(create_idempotency_key)) BETWEEN 1 AND 128),
	plan_version INTEGER NOT NULL CHECK (plan_version > 0),
	revision INTEGER NOT NULL CHECK (revision > 0),
	state TEXT NOT NULL CHECK (state IN ('waiting', 'ready', 'running', 'cancelRequested', 'succeeded', 'failed', 'cancelled', 'blocked', 'interrupted', 'recoveryRequired')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (id, project_id),
	UNIQUE (project_id, create_idempotency_key),
	FOREIGN KEY (binding_id, project_id) REFERENCES folder_bindings(id, project_id) ON DELETE RESTRICT,
	FOREIGN KEY (task_id, project_id) REFERENCES tasks(id, project_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_workflows_project_updated ON agent_workflows(project_id, updated_at DESC, id);
CREATE TRIGGER agent_workflow_scope_immutable BEFORE UPDATE OF id, project_id, binding_id, task_id, create_idempotency_key, created_at ON agent_workflows
BEGIN SELECT RAISE(ABORT, 'agent workflow ownership is immutable'); END;
CREATE TABLE agent_workflow_plans (
	workflow_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	version INTEGER NOT NULL CHECK (version > 0),
	plan_json TEXT NOT NULL CHECK (json_valid(plan_json) AND length(CAST(plan_json AS BLOB)) <= 65536),
	fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
	created_at TEXT NOT NULL,
	PRIMARY KEY (workflow_id, version),
	UNIQUE (workflow_id, project_id, version),
	FOREIGN KEY (workflow_id, project_id) REFERENCES agent_workflows(id, project_id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER agent_workflow_plan_immutable_update BEFORE UPDATE ON agent_workflow_plans
BEGIN SELECT RAISE(ABORT, 'agent workflow plan versions are immutable'); END;
CREATE TRIGGER agent_workflow_plan_immutable_delete BEFORE DELETE ON agent_workflow_plans
BEGIN SELECT RAISE(ABORT, 'agent workflow plan versions are immutable'); END;
CREATE TABLE agent_workflow_approvals (
	id TEXT PRIMARY KEY NOT NULL,
	workflow_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	plan_version INTEGER NOT NULL,
	fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
	idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 128),
	approved_at TEXT NOT NULL,
	UNIQUE (workflow_id, idempotency_key),
	UNIQUE (workflow_id, project_id, plan_version, fingerprint),
	FOREIGN KEY (workflow_id, project_id, plan_version) REFERENCES agent_workflow_plans(workflow_id, project_id, version) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER agent_workflow_approval_immutable_update BEFORE UPDATE ON agent_workflow_approvals
BEGIN SELECT RAISE(ABORT, 'agent workflow approvals are immutable'); END;
CREATE TRIGGER agent_workflow_approval_immutable_delete BEFORE DELETE ON agent_workflow_approvals
BEGIN SELECT RAISE(ABORT, 'agent workflow approvals are immutable'); END;
CREATE TABLE agent_workflow_runs (
	id TEXT PRIMARY KEY NOT NULL,
	workflow_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	plan_version INTEGER NOT NULL,
	fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
	idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 128),
	revision INTEGER NOT NULL CHECK (revision > 0),
	state TEXT NOT NULL CHECK (state IN ('ready', 'running', 'cancelRequested', 'succeeded', 'failed', 'cancelled', 'blocked', 'interrupted', 'recoveryRequired')),
	deadline_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (id, workflow_id, project_id),
	UNIQUE (workflow_id, idempotency_key),
	FOREIGN KEY (workflow_id, project_id, plan_version) REFERENCES agent_workflow_plans(workflow_id, project_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_workflow_runs_project ON agent_workflow_runs(project_id, workflow_id, created_at, id);
CREATE TRIGGER agent_workflow_run_identity_immutable BEFORE UPDATE OF id, workflow_id, project_id, plan_version, fingerprint, idempotency_key, deadline_at, created_at ON agent_workflow_runs
BEGIN SELECT RAISE(ABORT, 'agent workflow run identity is immutable'); END;
CREATE TABLE agent_workflow_run_nodes (
	workflow_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	node_id TEXT NOT NULL CHECK (length(trim(node_id)) BETWEEN 1 AND 80),
	session_id TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('waiting', 'ready', 'launching', 'running', 'cancelRequested', 'succeeded', 'failed', 'cancelled', 'blocked', 'interrupted', 'recoveryRequired')),
	revision INTEGER NOT NULL CHECK (revision > 0),
	cancel_requested_at TEXT,
	session_turn_id TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (run_id, node_id),
	UNIQUE (run_id, session_id),
	UNIQUE (session_turn_id),
	FOREIGN KEY (run_id, workflow_id, project_id) REFERENCES agent_workflow_runs(id, workflow_id, project_id) ON DELETE RESTRICT,
	FOREIGN KEY (session_id, project_id) REFERENCES agent_sessions(id, project_id) ON DELETE RESTRICT,
	FOREIGN KEY (session_turn_id, project_id, session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE agent_workflow_turn_reservations (
	id TEXT PRIMARY KEY NOT NULL,
	workflow_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	node_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	approval_fingerprint TEXT NOT NULL CHECK (length(approval_fingerprint) = 64 AND approval_fingerprint NOT GLOB '*[^0-9a-f]*'),
	session_revision INTEGER NOT NULL CHECK (session_revision > 0),
	reserved_turn_id TEXT NOT NULL UNIQUE,
	expires_at TEXT NOT NULL,
	consumed_at TEXT,
	consumed_turn_id TEXT UNIQUE,
	revoked_at TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (run_id, workflow_id, project_id) REFERENCES agent_workflow_runs(id, workflow_id, project_id) ON DELETE RESTRICT,
	FOREIGN KEY (run_id, node_id) REFERENCES agent_workflow_run_nodes(run_id, node_id) ON DELETE RESTRICT,
	FOREIGN KEY (session_id, project_id) REFERENCES agent_sessions(id, project_id) ON DELETE RESTRICT,
	CHECK ((consumed_at IS NULL AND consumed_turn_id IS NULL) OR (consumed_at IS NOT NULL AND consumed_turn_id = reserved_turn_id))
) STRICT;
CREATE TRIGGER agent_workflow_turn_reservation_identity_immutable BEFORE UPDATE OF
	id, workflow_id, project_id, run_id, node_id, session_id, approval_fingerprint, session_revision, reserved_turn_id, expires_at, created_at
	ON agent_workflow_turn_reservations
BEGIN SELECT RAISE(ABORT, 'agent workflow launch reservation identity is immutable'); END;
CREATE TRIGGER agent_workflow_turn_reservation_consumption_once BEFORE UPDATE OF consumed_at, consumed_turn_id, revoked_at
	ON agent_workflow_turn_reservations
WHEN (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
	OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
	OR (OLD.consumed_at IS NOT NULL AND NEW.revoked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'agent workflow launch reservation is already consumed or revoked'); END;
CREATE TRIGGER agent_workflow_turn_reservation_immutable_delete BEFORE DELETE ON agent_workflow_turn_reservations
BEGIN SELECT RAISE(ABORT, 'agent workflow launch reservation history is immutable'); END;
CREATE INDEX agent_workflow_run_nodes_state ON agent_workflow_run_nodes(run_id, state, node_id);
CREATE TRIGGER agent_workflow_run_node_identity_immutable BEFORE UPDATE OF workflow_id, project_id, run_id, node_id, session_id ON agent_workflow_run_nodes
BEGIN SELECT RAISE(ABORT, 'agent workflow run node identity is immutable'); END;
CREATE TRIGGER agent_workflow_run_node_turn_immutable BEFORE UPDATE OF session_turn_id ON agent_workflow_run_nodes
WHEN OLD.session_turn_id IS NOT NULL AND NEW.session_turn_id IS NOT OLD.session_turn_id
BEGIN SELECT RAISE(ABORT, 'agent workflow node session turn is immutable once linked'); END;
CREATE TABLE agent_workflow_receipts (
	id TEXT PRIMARY KEY NOT NULL,
	workflow_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	operation TEXT NOT NULL CHECK (operation IN ('start', 'cancel')),
	idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 128),
	request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
	result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 8192),
	created_at TEXT NOT NULL,
	UNIQUE (workflow_id, operation, idempotency_key),
	FOREIGN KEY (workflow_id, project_id) REFERENCES agent_workflows(id, project_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE agent_workflow_source_events (
	workflow_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	source_event_key TEXT NOT NULL CHECK (length(trim(source_event_key)) BETWEEN 1 AND 256),
	event_fingerprint TEXT NOT NULL CHECK (length(event_fingerprint) = 64 AND event_fingerprint NOT GLOB '*[^0-9a-f]*'),
	created_at TEXT NOT NULL,
	PRIMARY KEY (workflow_id, source_event_key),
	FOREIGN KEY (workflow_id, project_id) REFERENCES agent_workflows(id, project_id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER agent_workflow_receipt_immutable_update BEFORE UPDATE ON agent_workflow_receipts
BEGIN SELECT RAISE(ABORT, 'agent workflow operation receipts are immutable'); END;
CREATE TRIGGER agent_workflow_receipt_immutable_delete BEFORE DELETE ON agent_workflow_receipts
BEGIN SELECT RAISE(ABORT, 'agent workflow operation receipts are immutable'); END;
CREATE TRIGGER agent_workflow_source_event_immutable_update BEFORE UPDATE ON agent_workflow_source_events
BEGIN SELECT RAISE(ABORT, 'agent workflow source events are immutable'); END;
CREATE TRIGGER agent_workflow_source_event_immutable_delete BEFORE DELETE ON agent_workflow_source_events
BEGIN SELECT RAISE(ABORT, 'agent workflow source events are immutable'); END;
CREATE INDEX agent_session_notifications_unread ON agent_session_notifications(project_id, read_at);
PRAGMA user_version = 25;
