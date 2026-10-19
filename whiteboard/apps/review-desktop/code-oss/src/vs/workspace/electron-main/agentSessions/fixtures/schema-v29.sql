-- Frozen v29 delta copied from workspaceDatabase.ts. This fixture must not follow later migrations.
CREATE TABLE agent_session_integration_proposals (
	id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
	project_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision > 0),
	evidence_version INTEGER NOT NULL CHECK (evidence_version > 0),
	evidence_fingerprint TEXT NOT NULL CHECK (length(evidence_fingerprint) = 64 AND evidence_fingerprint NOT GLOB '*[^0-9a-f]*'),
	turn_snapshot_sha256 TEXT NOT NULL CHECK (length(turn_snapshot_sha256) = 64 AND turn_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
	proposal_fingerprint TEXT NOT NULL CHECK (length(proposal_fingerprint) = 64 AND proposal_fingerprint NOT GLOB '*[^0-9a-f]*'),
	payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 262144),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	PRIMARY KEY (turn_id, revision),
	FOREIGN KEY (turn_id, project_id, session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT,
	FOREIGN KEY (turn_id, evidence_version) REFERENCES agent_session_change_evidence(turn_id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_integration_proposals_page ON agent_session_integration_proposals(project_id, session_id, turn_id, revision);
CREATE TABLE agent_session_integration_approvals (
	id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
	proposal_id TEXT NOT NULL PRIMARY KEY,
	proposal_fingerprint TEXT NOT NULL CHECK (length(proposal_fingerprint) = 64 AND proposal_fingerprint NOT GLOB '*[^0-9a-f]*'),
	actor TEXT NOT NULL CHECK (actor = 'human'),
	approved_at TEXT NOT NULL,
	FOREIGN KEY (proposal_id) REFERENCES agent_session_integration_proposals(id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE agent_session_integration_outcomes (
	id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
	proposal_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision > 0),
	state TEXT NOT NULL CHECK (state IN ('applying', 'succeeded', 'failed', 'recoveryRequired')),
	action TEXT NOT NULL CHECK (action = 'commit'),
	receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 32768),
	retry_of_outcome_id TEXT,
	recorded_at TEXT NOT NULL,
	PRIMARY KEY (proposal_id, revision),
	FOREIGN KEY (proposal_id) REFERENCES agent_session_integration_proposals(id) ON DELETE RESTRICT,
	FOREIGN KEY (retry_of_outcome_id) REFERENCES agent_session_integration_outcomes(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_integration_outcomes_latest ON agent_session_integration_outcomes(proposal_id, revision DESC);
CREATE TRIGGER agent_session_integration_proposals_immutable_update BEFORE UPDATE ON agent_session_integration_proposals
BEGIN SELECT RAISE(ABORT, 'agent session integration proposals are immutable'); END;
CREATE TRIGGER agent_session_integration_proposals_immutable_delete BEFORE DELETE ON agent_session_integration_proposals
BEGIN SELECT RAISE(ABORT, 'agent session integration proposals are immutable'); END;
CREATE TRIGGER agent_session_integration_approvals_immutable_update BEFORE UPDATE ON agent_session_integration_approvals
BEGIN SELECT RAISE(ABORT, 'agent session integration approvals are immutable'); END;
CREATE TRIGGER agent_session_integration_approvals_immutable_delete BEFORE DELETE ON agent_session_integration_approvals
BEGIN SELECT RAISE(ABORT, 'agent session integration approvals are immutable'); END;
CREATE TRIGGER agent_session_integration_outcomes_immutable_update BEFORE UPDATE ON agent_session_integration_outcomes
BEGIN SELECT RAISE(ABORT, 'agent session integration outcomes are immutable'); END;
CREATE TRIGGER agent_session_integration_outcomes_immutable_delete BEFORE DELETE ON agent_session_integration_outcomes
BEGIN SELECT RAISE(ABORT, 'agent session integration outcomes are immutable'); END;
PRAGMA user_version = 29;
