-- Frozen v32 notification table contract, used to build realistic v31/v32 upgrade inputs.
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
CREATE INDEX agent_session_notifications_unread ON agent_session_notifications(project_id, read_at);
