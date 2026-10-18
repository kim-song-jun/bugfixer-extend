CREATE TABLE agent_session_content_baselines (
	project_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	turn_snapshot_sha256 TEXT NOT NULL CHECK (length(turn_snapshot_sha256) = 64 AND turn_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
	source TEXT NOT NULL CHECK (source IN ('ordinaryFolder', 'managedWorktree')),
	managed_worktree_owner_id TEXT,
	canonical_path TEXT NOT NULL,
	folder_dev TEXT NOT NULL,
	folder_ino TEXT NOT NULL,
	captured_at TEXT NOT NULL,
	revision TEXT CHECK (revision IS NULL OR length(revision) IN (40, 64)),
	fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
	snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB)) <= 67108864),
	PRIMARY KEY (turn_id),
	FOREIGN KEY (turn_id, project_id, session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE agent_session_content_finals (
	project_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	evidence_version INTEGER NOT NULL CHECK (evidence_version > 0),
	turn_snapshot_sha256 TEXT NOT NULL CHECK (length(turn_snapshot_sha256) = 64 AND turn_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
	source TEXT NOT NULL CHECK (source IN ('ordinaryFolder', 'managedWorktree')),
	managed_worktree_owner_id TEXT,
	canonical_path TEXT NOT NULL,
	folder_dev TEXT NOT NULL,
	folder_ino TEXT NOT NULL,
	captured_at TEXT NOT NULL,
	revision TEXT CHECK (revision IS NULL OR length(revision) IN (40, 64)),
	fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
	status TEXT NOT NULL CHECK (status IN ('observed', 'unverified')),
	coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial')),
	missing_reason TEXT,
	before_fingerprint TEXT,
	after_fingerprint TEXT,
	snapshot_json TEXT CHECK (snapshot_json IS NULL OR (json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB)) <= 67108864)),
	PRIMARY KEY (turn_id, evidence_version),
	CHECK ((status = 'observed' AND snapshot_json IS NOT NULL AND after_fingerprint IS NOT NULL)
		OR (status = 'unverified' AND coverage = 'partial' AND snapshot_json IS NULL AND after_fingerprint IS NULL)),
	FOREIGN KEY (turn_id, project_id, session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT,
	FOREIGN KEY (turn_id, evidence_version) REFERENCES agent_session_change_evidence(turn_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_content_finals_page ON agent_session_content_finals(project_id, session_id, turn_id, evidence_version);
CREATE TRIGGER agent_session_content_baseline_immutable_update BEFORE UPDATE ON agent_session_content_baselines
BEGIN SELECT RAISE(ABORT, 'agent session content baselines are immutable'); END;
CREATE TRIGGER agent_session_content_baseline_immutable_delete BEFORE DELETE ON agent_session_content_baselines
BEGIN SELECT RAISE(ABORT, 'agent session content baselines are immutable'); END;
CREATE TRIGGER agent_session_content_final_immutable_update BEFORE UPDATE ON agent_session_content_finals
BEGIN SELECT RAISE(ABORT, 'agent session content final versions are immutable'); END;
CREATE TRIGGER agent_session_content_final_immutable_delete BEFORE DELETE ON agent_session_content_finals
BEGIN SELECT RAISE(ABORT, 'agent session content final versions are immutable'); END;
PRAGMA user_version = 27;
