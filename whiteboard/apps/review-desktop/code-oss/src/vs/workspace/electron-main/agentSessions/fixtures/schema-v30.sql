CREATE TABLE agent_session_merge_workspaces (
	project_id TEXT NOT NULL,
	binding_id TEXT NOT NULL,
	integration_owner_id TEXT NOT NULL UNIQUE CHECK (length(integration_owner_id) = 36),
	repository_root TEXT NOT NULL CHECK (length(trim(repository_root)) > 0),
	created_at TEXT NOT NULL,
	PRIMARY KEY (project_id, binding_id),
	FOREIGN KEY (binding_id, project_id) REFERENCES folder_bindings(id, project_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE agent_session_merge_proposals (
	id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
	project_id TEXT NOT NULL,
	binding_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision > 0),
	commit_proposal_id TEXT NOT NULL,
	commit_proposal_revision INTEGER NOT NULL CHECK (commit_proposal_revision > 0),
	commit_proposal_fingerprint TEXT NOT NULL CHECK (length(commit_proposal_fingerprint) = 64 AND commit_proposal_fingerprint NOT GLOB '*[^0-9a-f]*'),
	integration_owner_id TEXT NOT NULL,
	source_head TEXT NOT NULL CHECK (length(source_head) IN (40, 64) AND source_head NOT GLOB '*[^0-9a-f]*'),
	target_head TEXT NOT NULL CHECK (length(target_head) IN (40, 64) AND target_head NOT GLOB '*[^0-9a-f]*'),
	merge_base TEXT NOT NULL CHECK (length(merge_base) IN (40, 64) AND merge_base NOT GLOB '*[^0-9a-f]*'),
	diff_fingerprint TEXT NOT NULL CHECK (length(diff_fingerprint) = 64 AND diff_fingerprint NOT GLOB '*[^0-9a-f]*'),
	proposal_fingerprint TEXT NOT NULL CHECK (length(proposal_fingerprint) = 64 AND proposal_fingerprint NOT GLOB '*[^0-9a-f]*'),
	payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 5242880),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	PRIMARY KEY (turn_id, revision),
	FOREIGN KEY (turn_id, project_id, session_id) REFERENCES agent_session_turns(id, project_id, session_id) ON DELETE RESTRICT,
	FOREIGN KEY (project_id, binding_id) REFERENCES agent_session_merge_workspaces(project_id, binding_id) ON DELETE RESTRICT,
	FOREIGN KEY (commit_proposal_id) REFERENCES agent_session_integration_proposals(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_merge_proposals_page ON agent_session_merge_proposals(project_id, session_id, turn_id, revision);
CREATE TABLE agent_session_merge_approvals (
	id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
	proposal_id TEXT NOT NULL PRIMARY KEY,
	proposal_fingerprint TEXT NOT NULL CHECK (length(proposal_fingerprint) = 64 AND proposal_fingerprint NOT GLOB '*[^0-9a-f]*'),
	actor TEXT NOT NULL CHECK (actor = 'human'),
	approved_at TEXT NOT NULL,
	FOREIGN KEY (proposal_id) REFERENCES agent_session_merge_proposals(id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE agent_session_merge_outcomes (
	id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
	proposal_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision > 0),
	state TEXT NOT NULL CHECK (state IN ('applying', 'merged', 'conflict', 'notApplied', 'recoveryRequired', 'failed')),
	receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 32768),
	retry_of_outcome_id TEXT,
	recorded_at TEXT NOT NULL,
	PRIMARY KEY (proposal_id, revision),
	FOREIGN KEY (proposal_id) REFERENCES agent_session_merge_proposals(id) ON DELETE RESTRICT,
	FOREIGN KEY (retry_of_outcome_id) REFERENCES agent_session_merge_outcomes(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_merge_outcomes_latest ON agent_session_merge_outcomes(proposal_id, revision DESC);
CREATE TABLE agent_session_merge_artifacts (
	operation_id TEXT NOT NULL CHECK (length(operation_id) = 36),
	proposal_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision > 0),
	phase TEXT NOT NULL CHECK (phase IN ('intent', 'candidatePrepared', 'generationRegistered', 'generationMaterialized', 'published')),
	event_json TEXT NOT NULL CHECK (json_valid(event_json) AND length(CAST(event_json AS BLOB)) <= 2097152),
	recorded_at TEXT NOT NULL,
	PRIMARY KEY (operation_id, revision),
	FOREIGN KEY (proposal_id) REFERENCES agent_session_merge_proposals(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_merge_artifacts_proposal ON agent_session_merge_artifacts(proposal_id, operation_id, revision);
CREATE TRIGGER agent_session_merge_artifacts_immutable_update BEFORE UPDATE ON agent_session_merge_artifacts
BEGIN SELECT RAISE(ABORT, 'agent session merge artifacts are immutable'); END;
CREATE TRIGGER agent_session_merge_artifacts_immutable_delete BEFORE DELETE ON agent_session_merge_artifacts
BEGIN SELECT RAISE(ABORT, 'agent session merge artifacts are immutable'); END;
CREATE TRIGGER agent_session_merge_workspaces_immutable_update BEFORE UPDATE ON agent_session_merge_workspaces
BEGIN SELECT RAISE(ABORT, 'agent session merge workspaces are immutable'); END;
CREATE TRIGGER agent_session_merge_workspaces_immutable_delete BEFORE DELETE ON agent_session_merge_workspaces
BEGIN SELECT RAISE(ABORT, 'agent session merge workspaces are immutable'); END;
CREATE TRIGGER agent_session_merge_proposals_immutable_update BEFORE UPDATE ON agent_session_merge_proposals
BEGIN SELECT RAISE(ABORT, 'agent session merge proposals are immutable'); END;
CREATE TRIGGER agent_session_merge_proposals_immutable_delete BEFORE DELETE ON agent_session_merge_proposals
BEGIN SELECT RAISE(ABORT, 'agent session merge proposals are immutable'); END;
CREATE TRIGGER agent_session_merge_approvals_immutable_update BEFORE UPDATE ON agent_session_merge_approvals
BEGIN SELECT RAISE(ABORT, 'agent session merge approvals are immutable'); END;
CREATE TRIGGER agent_session_merge_approvals_immutable_delete BEFORE DELETE ON agent_session_merge_approvals
BEGIN SELECT RAISE(ABORT, 'agent session merge approvals are immutable'); END;
CREATE TRIGGER agent_session_merge_outcomes_immutable_update BEFORE UPDATE ON agent_session_merge_outcomes
BEGIN SELECT RAISE(ABORT, 'agent session merge outcomes are immutable'); END;
CREATE TRIGGER agent_session_merge_outcomes_immutable_delete BEFORE DELETE ON agent_session_merge_outcomes
BEGIN SELECT RAISE(ABORT, 'agent session merge outcomes are immutable'); END;
PRAGMA user_version = 30;
