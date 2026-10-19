/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Central database migration fragment for schema v31. Registration belongs to WorkspaceDatabase. */
export const AGENT_SESSION_PUBLICATION_MIGRATION_SQL = `
CREATE TABLE agent_session_publication_proposals (
	id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
	project_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	source_merge_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision > 0),
	semantic_fingerprint TEXT NOT NULL CHECK (length(semantic_fingerprint) = 64 AND semantic_fingerprint NOT GLOB '*[^0-9a-f]*'),
	proposal_fingerprint TEXT NOT NULL CHECK (length(proposal_fingerprint) = 64 AND proposal_fingerprint NOT GLOB '*[^0-9a-f]*'),
	payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 5242880),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	PRIMARY KEY (project_id, session_id, turn_id, revision)
) STRICT;
CREATE INDEX agent_session_publication_proposals_page ON agent_session_publication_proposals(project_id, session_id, turn_id, revision DESC);
CREATE INDEX agent_session_publication_proposals_semantic ON agent_session_publication_proposals(project_id, session_id, turn_id, semantic_fingerprint, revision DESC);
CREATE TRIGGER agent_session_publication_proposals_history_limit BEFORE INSERT ON agent_session_publication_proposals
WHEN (SELECT COUNT(*) FROM agent_session_publication_proposals WHERE project_id = NEW.project_id AND session_id = NEW.session_id AND turn_id = NEW.turn_id) >= 5
BEGIN SELECT RAISE(ABORT, 'agent session publication proposal history limit reached'); END;
CREATE TABLE agent_session_publication_approvals (
	proposal_id TEXT NOT NULL PRIMARY KEY,
	proposal_fingerprint TEXT NOT NULL CHECK (length(proposal_fingerprint) = 64 AND proposal_fingerprint NOT GLOB '*[^0-9a-f]*'),
	actor TEXT NOT NULL CHECK (actor = 'human'),
	approved_at TEXT NOT NULL,
	FOREIGN KEY (proposal_id) REFERENCES agent_session_publication_proposals(id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE agent_session_publication_operations (
	id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
	proposal_id TEXT NOT NULL UNIQUE,
	proposal_fingerprint TEXT NOT NULL CHECK (length(proposal_fingerprint) = 64 AND proposal_fingerprint NOT GLOB '*[^0-9a-f]*'),
	account_stable_id TEXT NOT NULL,
	repository_id TEXT NOT NULL,
	publication_ref TEXT NOT NULL,
	expected_old_remote_oid TEXT CHECK (expected_old_remote_oid IS NULL),
	head_oid TEXT NOT NULL CHECK (length(head_oid) IN (40, 64) AND head_oid NOT GLOB '*[^0-9a-f]*'),
	state TEXT NOT NULL CHECK (state IN ('started', 'published', 'recoveryRequired', 'notPublished', 'failed')),
	revision INTEGER NOT NULL CHECK (revision >= 0),
	started_at TEXT NOT NULL,
	FOREIGN KEY (proposal_id) REFERENCES agent_session_publication_proposals(id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE agent_session_publication_events (
	operation_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision > 0),
	event_type TEXT NOT NULL CHECK (event_type IN ('branchWriteStarted', 'branchObserved', 'branchReobserved', 'pullRequestWriteStarted', 'pullRequestObserved', 'pullRequestReobserved', 'published', 'recoveryRequired', 'notPublished', 'failed')),
	event_json TEXT NOT NULL CHECK (json_valid(event_json) AND length(CAST(event_json AS BLOB)) <= 32768),
	recorded_at TEXT NOT NULL,
	PRIMARY KEY (operation_id, revision),
	FOREIGN KEY (operation_id) REFERENCES agent_session_publication_operations(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_session_publication_events_page ON agent_session_publication_events(operation_id, revision);
CREATE TRIGGER agent_session_publication_operations_require_approval BEFORE INSERT ON agent_session_publication_operations
WHEN NOT EXISTS (
	SELECT 1 FROM agent_session_publication_proposals proposal
	JOIN agent_session_publication_approvals approval ON approval.proposal_id = proposal.id
	WHERE proposal.id = NEW.proposal_id AND proposal.proposal_fingerprint = NEW.proposal_fingerprint
	AND approval.actor = 'human' AND approval.proposal_fingerprint = proposal.proposal_fingerprint
	AND NEW.account_stable_id = json_extract(proposal.payload_json, '$.account.stableId')
	AND NEW.repository_id = json_extract(proposal.payload_json, '$.remote.repositoryId')
	AND NEW.publication_ref = json_extract(proposal.payload_json, '$.publicationRef')
	AND NEW.expected_old_remote_oid IS NULL AND NEW.head_oid = json_extract(proposal.payload_json, '$.resultCommit')
)
BEGIN SELECT RAISE(ABORT, 'publication operation requires the exact human-approved proposal'); END;
CREATE TRIGGER agent_session_publication_proposals_immutable_update BEFORE UPDATE ON agent_session_publication_proposals
BEGIN SELECT RAISE(ABORT, 'agent session publication proposals are immutable'); END;
CREATE TRIGGER agent_session_publication_proposals_delete_guard BEFORE DELETE ON agent_session_publication_proposals
WHEN EXISTS (SELECT 1 FROM agent_session_publication_approvals WHERE proposal_id = OLD.id)
	OR EXISTS (SELECT 1 FROM agent_session_publication_operations WHERE proposal_id = OLD.id)
	OR OLD.revision > COALESCE((SELECT MAX(revision) - 4 FROM agent_session_publication_proposals WHERE project_id = OLD.project_id AND session_id = OLD.session_id AND turn_id = OLD.turn_id), 0)
BEGIN SELECT RAISE(ABORT, 'approved or started publication proposals are retained'); END;
CREATE TRIGGER agent_session_publication_approvals_immutable_update BEFORE UPDATE ON agent_session_publication_approvals
BEGIN SELECT RAISE(ABORT, 'agent session publication approvals are immutable'); END;
CREATE TRIGGER agent_session_publication_approvals_immutable_delete BEFORE DELETE ON agent_session_publication_approvals
BEGIN SELECT RAISE(ABORT, 'agent session publication approvals are immutable'); END;
CREATE TRIGGER agent_session_publication_operations_immutable_delete BEFORE DELETE ON agent_session_publication_operations
BEGIN SELECT RAISE(ABORT, 'agent session publication operations are retained'); END;
CREATE TRIGGER agent_session_publication_operations_cas BEFORE UPDATE ON agent_session_publication_operations
WHEN NEW.id != OLD.id OR NEW.proposal_id != OLD.proposal_id OR NEW.proposal_fingerprint != OLD.proposal_fingerprint
	OR NEW.account_stable_id != OLD.account_stable_id OR NEW.repository_id != OLD.repository_id OR NEW.publication_ref != OLD.publication_ref
	OR NEW.expected_old_remote_oid IS NOT OLD.expected_old_remote_oid OR NEW.head_oid != OLD.head_oid OR NEW.started_at != OLD.started_at
	OR NEW.revision != OLD.revision + 1 OR OLD.state NOT IN ('started', 'recoveryRequired')
	OR NOT EXISTS (SELECT 1 FROM agent_session_publication_events event WHERE event.operation_id = OLD.id AND event.revision = NEW.revision)
	OR (NEW.state = 'started' AND ((OLD.state = 'recoveryRequired') OR NOT EXISTS (SELECT 1 FROM agent_session_publication_events event WHERE event.operation_id = OLD.id AND event.revision = NEW.revision AND event.event_type IN ('branchWriteStarted', 'branchObserved', 'pullRequestWriteStarted', 'pullRequestObserved'))))
	OR (NEW.state = 'recoveryRequired' AND NOT EXISTS (SELECT 1 FROM agent_session_publication_events event WHERE event.operation_id = OLD.id AND event.revision = NEW.revision AND event.event_type IN ('recoveryRequired', 'branchReobserved', 'pullRequestReobserved')))
	OR (NEW.state IN ('published', 'notPublished', 'failed') AND NOT EXISTS (SELECT 1 FROM agent_session_publication_events event WHERE event.operation_id = OLD.id AND event.revision = NEW.revision AND event.event_type = NEW.state))
	OR (NEW.state = 'notPublished' AND NOT EXISTS (
		SELECT 1 FROM agent_session_publication_events outcome
		JOIN agent_session_publication_events branch ON branch.operation_id = OLD.id AND branch.revision = (SELECT MAX(revision) FROM agent_session_publication_events WHERE operation_id = OLD.id AND event_type IN ('branchObserved', 'branchReobserved'))
		WHERE outcome.operation_id = OLD.id AND outcome.revision = NEW.revision
		AND json_extract(outcome.event_json, '$.branchOid') IS NULL
		AND branch.event_type IN ('branchObserved', 'branchReobserved') AND json_extract(branch.event_json, '$.outcome') = 'absent' AND json_extract(branch.event_json, '$.oid') IS NULL
		AND (NOT EXISTS (SELECT 1 FROM agent_session_publication_events WHERE operation_id = OLD.id AND event_type = 'pullRequestWriteStarted')
			OR (OLD.state = 'recoveryRequired'
				AND branch.event_type = 'branchReobserved'
				AND branch.revision > (SELECT MAX(revision) FROM agent_session_publication_events WHERE operation_id = OLD.id AND event_type = 'recoveryRequired')
				AND EXISTS (SELECT 1 FROM agent_session_publication_events pr WHERE pr.operation_id = OLD.id AND pr.revision = (SELECT MAX(revision) FROM agent_session_publication_events WHERE operation_id = OLD.id AND event_type IN ('pullRequestObserved', 'pullRequestReobserved'))
					AND pr.event_type = 'pullRequestReobserved' AND json_extract(pr.event_json, '$.outcome') = 'absent'
					AND pr.revision > (SELECT MAX(revision) FROM agent_session_publication_events WHERE operation_id = OLD.id AND event_type = 'recoveryRequired'))))
		AND json_extract(outcome.event_json, '$.pullRequestId') IS (SELECT json_extract(event_json, '$.id') FROM agent_session_publication_events WHERE operation_id = OLD.id AND event_type IN ('pullRequestObserved', 'pullRequestReobserved') ORDER BY revision DESC LIMIT 1)
		AND NOT EXISTS (SELECT 1 FROM agent_session_publication_events known WHERE known.operation_id = OLD.id AND known.event_type IN ('pullRequestObserved', 'pullRequestReobserved')
			AND json_extract(known.event_json, '$.id') IS NOT NULL)
	))
BEGIN SELECT RAISE(ABORT, 'agent session publication operation update violates immutable CAS'); END;
CREATE TRIGGER agent_session_publication_events_append BEFORE INSERT ON agent_session_publication_events
WHEN NEW.revision != (SELECT revision + 1 FROM agent_session_publication_operations WHERE id = NEW.operation_id)
	OR NEW.revision > 32
	OR ((SELECT state FROM agent_session_publication_operations WHERE id = NEW.operation_id) = 'started' AND (
		(NEW.revision = 1 AND NEW.event_type != 'branchWriteStarted')
		OR (NEW.revision = 2 AND NEW.event_type != 'branchObserved')
		OR (NEW.revision = 3 AND NEW.event_type NOT IN ('pullRequestWriteStarted', 'recoveryRequired', 'notPublished', 'failed'))
		OR (NEW.revision = 3 AND NEW.event_type = 'pullRequestWriteStarted' AND NOT EXISTS (
		SELECT 1 FROM agent_session_publication_events branch
		JOIN agent_session_publication_operations operation ON operation.id = branch.operation_id
		WHERE branch.operation_id = NEW.operation_id AND branch.revision = 2 AND branch.event_type = 'branchObserved'
		AND json_extract(branch.event_json, '$.outcome') = 'created' AND json_extract(branch.event_json, '$.oid') = operation.head_oid
		AND json_extract(NEW.event_json, '$.headOid') = operation.head_oid))
		OR (NEW.revision = 4 AND NEW.event_type != 'pullRequestObserved')
		OR (NEW.revision = 5 AND NEW.event_type NOT IN ('published', 'recoveryRequired', 'notPublished', 'failed'))
		OR NEW.revision > 5))
	OR ((SELECT state FROM agent_session_publication_operations WHERE id = NEW.operation_id) = 'recoveryRequired' AND (
		NEW.event_type NOT IN ('branchReobserved', 'pullRequestReobserved', 'recoveryRequired', 'published', 'notPublished', 'failed')
		OR NOT EXISTS (SELECT 1 FROM agent_session_publication_events recovery WHERE recovery.operation_id = NEW.operation_id AND recovery.event_type = 'recoveryRequired')
		OR (NEW.event_type = 'branchReobserved' AND NOT EXISTS (SELECT 1 FROM agent_session_publication_events branch WHERE branch.operation_id = NEW.operation_id AND branch.event_type IN ('branchObserved', 'branchReobserved')))
		OR (NEW.event_type = 'pullRequestReobserved' AND (NOT EXISTS (SELECT 1 FROM agent_session_publication_events pr WHERE pr.operation_id = NEW.operation_id AND pr.event_type IN ('pullRequestObserved', 'pullRequestReobserved'))
			OR EXISTS (SELECT 1 FROM agent_session_publication_events known WHERE known.operation_id = NEW.operation_id AND known.event_type IN ('pullRequestObserved', 'pullRequestReobserved')
				AND json_extract(known.event_json, '$.id') IS NOT NULL AND json_extract(known.event_json, '$.id') IS NOT json_extract(NEW.event_json, '$.id'))))))
BEGIN SELECT RAISE(ABORT, 'agent session publication event is out of sequence or terminal'); END;
CREATE TRIGGER agent_session_publication_published_chain BEFORE UPDATE ON agent_session_publication_operations
WHEN NEW.state = 'published' AND NOT EXISTS (
	SELECT 1 FROM agent_session_publication_events result
	JOIN agent_session_publication_proposals proposal ON proposal.id = NEW.proposal_id
	JOIN agent_session_publication_events branchStart ON branchStart.operation_id = NEW.id AND branchStart.revision = 1
	JOIN agent_session_publication_events branchSeen ON branchSeen.operation_id = NEW.id AND branchSeen.revision = (SELECT MAX(revision) FROM agent_session_publication_events WHERE operation_id = NEW.id AND event_type IN ('branchObserved', 'branchReobserved'))
	JOIN agent_session_publication_events prSeen ON prSeen.operation_id = NEW.id AND prSeen.revision = (SELECT MAX(revision) FROM agent_session_publication_events WHERE operation_id = NEW.id AND event_type IN ('pullRequestObserved', 'pullRequestReobserved'))
	WHERE result.operation_id = NEW.id AND result.revision = NEW.revision AND result.event_type = 'published'
	AND branchStart.event_type = 'branchWriteStarted' AND json_extract(branchStart.event_json, '$.expectedOldRemoteOid') IS NULL
	AND branchSeen.event_type IN ('branchObserved', 'branchReobserved') AND json_extract(branchSeen.event_json, '$.outcome') = 'created' AND json_extract(branchSeen.event_json, '$.oid') = NEW.head_oid
	AND prSeen.event_type IN ('pullRequestObserved', 'pullRequestReobserved') AND json_extract(prSeen.event_json, '$.outcome') = 'created'
	AND json_extract(prSeen.event_json, '$.id') IS NOT NULL AND json_extract(prSeen.event_json, '$.url') = ('https://' || json_extract(proposal.payload_json, '$.remote.host') || '/' || json_extract(proposal.payload_json, '$.remote.owner') || '/' || json_extract(proposal.payload_json, '$.remote.repository') || '/pull/' || json_extract(prSeen.event_json, '$.id'))
	AND json_extract(prSeen.event_json, '$.repositoryId') = json_extract(proposal.payload_json, '$.remote.repositoryId')
	AND json_extract(prSeen.event_json, '$.headRef') = json_extract(proposal.payload_json, '$.publicationRef')
	AND json_extract(prSeen.event_json, '$.headOid') = NEW.head_oid
	AND json_extract(prSeen.event_json, '$.baseRef') = json_extract(proposal.payload_json, '$.baseRef')
	AND json_extract(prSeen.event_json, '$.baseOid') = json_extract(proposal.payload_json, '$.baseOid')
	AND json_extract(prSeen.event_json, '$.title') = json_extract(proposal.payload_json, '$.title')
	AND json_extract(prSeen.event_json, '$.body') = json_extract(proposal.payload_json, '$.body')
	AND json_extract(prSeen.event_json, '$.draft') = 1
	AND NOT EXISTS (SELECT 1 FROM agent_session_publication_events known WHERE known.operation_id = NEW.id AND known.event_type IN ('pullRequestObserved', 'pullRequestReobserved')
		AND json_extract(known.event_json, '$.id') IS NOT NULL AND json_extract(known.event_json, '$.id') IS NOT json_extract(prSeen.event_json, '$.id'))
	AND (NOT EXISTS (SELECT 1 FROM agent_session_publication_events recovery WHERE recovery.operation_id = NEW.id AND recovery.event_type = 'recoveryRequired') OR
		(branchSeen.event_type = 'branchReobserved' AND branchSeen.revision > (SELECT MAX(revision) FROM agent_session_publication_events WHERE operation_id = NEW.id AND event_type = 'recoveryRequired')
		AND prSeen.event_type = 'pullRequestReobserved' AND prSeen.revision > (SELECT MAX(revision) FROM agent_session_publication_events WHERE operation_id = NEW.id AND event_type = 'recoveryRequired')))
	AND json_extract(result.event_json, '$.pullRequestId') = json_extract(prSeen.event_json, '$.id')
	AND json_extract(result.event_json, '$.url') = json_extract(prSeen.event_json, '$.url')
	AND json_extract(result.event_json, '$.branchOid') = NEW.head_oid AND json_extract(result.event_json, '$.headOid') = NEW.head_oid
	AND json_extract(result.event_json, '$.baseRef') = json_extract(proposal.payload_json, '$.baseRef')
	AND json_extract(result.event_json, '$.title') = json_extract(proposal.payload_json, '$.title')
	AND json_extract(result.event_json, '$.body') = json_extract(proposal.payload_json, '$.body')
	AND json_extract(result.event_json, '$.draft') = 1)
BEGIN SELECT RAISE(ABORT, 'published publication requires the exact complete observed chain'); END;
CREATE TRIGGER agent_session_publication_events_immutable_update BEFORE UPDATE ON agent_session_publication_events
BEGIN SELECT RAISE(ABORT, 'agent session publication events are immutable'); END;
CREATE TRIGGER agent_session_publication_events_immutable_delete BEFORE DELETE ON agent_session_publication_events
BEGIN SELECT RAISE(ABORT, 'agent session publication events are immutable'); END;
PRAGMA user_version = 31;
`;
