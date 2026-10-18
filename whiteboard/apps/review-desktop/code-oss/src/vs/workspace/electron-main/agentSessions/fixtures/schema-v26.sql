CREATE TABLE agent_session_change_evidence (
	id TEXT NOT NULL UNIQUE,
	project_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	version INTEGER NOT NULL CHECK (version > 0),
	fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
	status TEXT NOT NULL CHECK (status IN ('observed', 'unverified')),
	coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial')),
	attribution TEXT NOT NULL CHECK (attribution IN ('unknown', 'mixed')),
	evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB)) <= 65536
		AND json_type(evidence_json, '$.files') = 'array' AND json_array_length(evidence_json, '$.files') <= 300),
	created_at TEXT NOT NULL,
	PRIMARY KEY (turn_id, version),
	FOREIGN KEY (turn_id, project_id, session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_change_evidence_page ON agent_session_change_evidence(project_id, session_id, turn_id, version);
CREATE TRIGGER agent_session_change_evidence_immutable_update BEFORE UPDATE ON agent_session_change_evidence
BEGIN SELECT RAISE(ABORT, 'agent session change evidence versions are immutable'); END;
CREATE TRIGGER agent_session_change_evidence_immutable_delete BEFORE DELETE ON agent_session_change_evidence
BEGIN SELECT RAISE(ABORT, 'agent session change evidence versions are immutable'); END;
PRAGMA user_version = 26;
