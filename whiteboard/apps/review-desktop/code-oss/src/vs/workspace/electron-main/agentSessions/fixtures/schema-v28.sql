-- Frozen v28 delta copied from workspaceDatabase.ts at 53a580def6c7aba3cfc2663a4ddb0c9a48afd5cf.
-- This fixture is independent of the current v29 migration and seeds prior-version migration tests.
CREATE TABLE agent_session_explanations (
	id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
	project_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	evidence_version INTEGER NOT NULL CHECK (evidence_version > 0),
	evidence_fingerprint TEXT NOT NULL CHECK (length(evidence_fingerprint) = 64 AND evidence_fingerprint NOT GLOB '*[^0-9a-f]*'),
	target_path TEXT NOT NULL CHECK (length(CAST(target_path AS BLOB)) BETWEEN 1 AND 4096 AND instr(target_path, char(0)) = 0),
	hunk_id TEXT NOT NULL CHECK (hunk_id = '' OR (length(hunk_id) = 64 AND hunk_id NOT GLOB '*[^0-9a-f]*')),
	revision INTEGER NOT NULL CHECK (revision > 0),
	turn_snapshot_sha256 TEXT NOT NULL CHECK (length(turn_snapshot_sha256) = 64 AND turn_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
	payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 30720),
	created_at TEXT NOT NULL,
	PRIMARY KEY (turn_id, evidence_version, target_path, hunk_id, revision),
	FOREIGN KEY (turn_id, project_id, session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT,
	FOREIGN KEY (turn_id, evidence_version) REFERENCES agent_session_change_evidence(turn_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_explanations_latest ON agent_session_explanations(project_id, session_id, turn_id, evidence_version, target_path, hunk_id, revision DESC);
CREATE TRIGGER agent_session_explanations_immutable_update BEFORE UPDATE ON agent_session_explanations
BEGIN SELECT RAISE(ABORT, 'agent session explanations are immutable'); END;
CREATE TRIGGER agent_session_explanations_immutable_delete BEFORE DELETE ON agent_session_explanations
BEGIN SELECT RAISE(ABORT, 'agent session explanations are immutable'); END;
PRAGMA user_version = 28;
