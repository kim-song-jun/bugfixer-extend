/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { createRequire } from 'module';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);

function loadSqlite(): typeof import('node:sqlite') {
	return nodeRequire('node:sqlite') as typeof import('node:sqlite');
}

export type TaskState = 'ready' | 'inProgress' | 'review' | 'done';
export type VcsKind = 'git' | 'jj';
export type ReviewOutboxStatus = 'pending' | 'complete' | 'failed';

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

export interface ProjectView {
	readonly projectId: string;
	readonly descriptorUri: string;
	readonly openAtQuit: boolean;
	readonly selectedTaskId: string | null;
	readonly dashboardPosition: string | null;
}

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

const schemaVersion = 1;

/** Main-process-only durable storage for one app profile's project workspace data. */
export class WorkspaceDatabase {
	private closed = false;

	private constructor(private readonly db: DatabaseSync) { }

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
				db.exec('COMMIT;');
			} catch (error) {
				db.exec('ROLLBACK;');
				throw error;
			}
			return new WorkspaceDatabase(db);
		} catch (error) {
			db.close();
			throw error;
		}
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
			this.db.prepare('UPDATE folder_bindings SET path = ?, vcs_kind = ?, vcs_root = ?, review_repository_id = ? WHERE id = ?')
				.run(path, vcsKind, vcsRoot, repositoryId, bindingId);
			return { id: String(current.id), projectId: String(current.project_id), path, vcsKind: vcsKind as VcsKind | null, vcsRoot: vcsRoot as string | null, reviewRepositoryId: repositoryId as string | null, createdAt: String(current.created_at) };
		});
	}

	createTask(input: { projectId: string; bindingId: string; title: string; description?: string | null; state?: TaskState; id?: string }): WorkspaceTask {
		this.assertOpen();
		const id = input.id ?? randomUUID();
		const now = new Date().toISOString();
		const state = input.state ?? 'ready';
		return this.transaction(() => {
			const order = Number(this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM tasks WHERE project_id = ? AND state = ?').get(input.projectId, state)?.next_position ?? 0);
			this.db.prepare(`INSERT INTO tasks (id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, input.projectId, input.bindingId, input.title.trim(), input.description ?? null, state, order, now, now);
			return { id, projectId: input.projectId, bindingId: input.bindingId, title: input.title.trim(), description: input.description ?? null, state, order, revision: 1, createdAt: now, updatedAt: now };
		});
	}

	getTask(taskId: string): WorkspaceTask | undefined {
		this.assertOpen();
		const row = this.db.prepare(`SELECT id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at
			FROM tasks WHERE id = ?`).get(taskId);
		return row ? this.taskFromRow(row) : undefined;
	}

	listTasks(projectId: string, state?: TaskState): WorkspaceTask[] {
		this.assertOpen();
		const rows = state === undefined
			? this.db.prepare(`SELECT id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at
				FROM tasks WHERE project_id = ? ORDER BY state, position, created_at, id`).all(projectId)
			: this.db.prepare(`SELECT id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at
				FROM tasks WHERE project_id = ? AND state = ? ORDER BY position, created_at, id`).all(projectId, state);
		return rows.map(row => this.taskFromRow(row));
	}

	updateTask(taskId: string, expectedRevision: number, patch: { title?: string; description?: string | null; state?: TaskState }): WorkspaceTask {
		this.assertOpen();
		return this.transaction(() => {
			const current = this.getTask(taskId);
			if (!current || current.revision !== expectedRevision) {
				throw new TaskRevisionConflictError(taskId, expectedRevision);
			}
			const title = patch.title === undefined ? current.title : patch.title.trim();
			const description = patch.description === undefined ? current.description : patch.description;
			const state = patch.state ?? current.state;
			const order = state === current.state
				? current.order
				: Number(this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM tasks WHERE project_id = ? AND state = ?').get(current.projectId, state)?.next_position ?? 0);
			const updatedAt = new Date().toISOString();
			const result = this.db.prepare(`UPDATE tasks SET title = ?, description = ?, state = ?, position = ?, revision = revision + 1, updated_at = ?
				WHERE id = ? AND revision = ?`).run(title, description, state, order, updatedAt, taskId, expectedRevision);
			if (Number(result.changes) !== 1) { throw new TaskRevisionConflictError(taskId, expectedRevision); }
			return { ...current, title, description, state, order, revision: expectedRevision + 1, updatedAt };
		});
	}

	reorderTasks(projectId: string, state: TaskState, orderedTaskRevisions: ReadonlyArray<{ taskId: string; revision: number }>): WorkspaceTask[] {
		this.assertOpen();
		return this.transaction(() => {
			const current = this.db.prepare(`SELECT id, project_id, binding_id, title, description, state, position, revision, created_at, updated_at
				FROM tasks WHERE project_id = ? AND state = ? ORDER BY position, created_at, id`).all(projectId, state).map(row => this.taskFromRow(row));
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

	choosePrimaryReview(taskId: string, reviewId: string): TaskReviewLink {
		this.assertOpen();
		return this.transaction(() => {
			const selected = this.db.prepare('SELECT 1 FROM task_review_links WHERE task_id = ? AND review_id = ?').get(taskId, reviewId);
			if (!selected) { throw new Error(`Review ${reviewId} is not linked to task ${taskId}.`); }
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

	setProjectView(view: ProjectView): ProjectView {
		this.assertOpen();
		this.db.prepare(`INSERT INTO project_views (project_id, descriptor_uri, open_at_quit, selected_task_id, dashboard_position)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(project_id) DO UPDATE SET descriptor_uri = excluded.descriptor_uri, open_at_quit = excluded.open_at_quit,
				selected_task_id = excluded.selected_task_id, dashboard_position = excluded.dashboard_position`)
			.run(view.projectId, view.descriptorUri, view.openAtQuit ? 1 : 0, view.selectedTaskId, view.dashboardPosition);
		return view;
	}

	close(): void {
		if (!this.closed) {
			this.db.close();
			this.closed = true;
		}
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec('BEGIN IMMEDIATE;');
		try {
			const value = operation();
			this.db.exec('COMMIT;');
			return value;
		} catch (error) {
			this.db.exec('ROLLBACK;');
			throw error;
		}
	}

	private assertOpen(): void {
		if (this.closed) { throw new Error('workspace.db is closed.'); }
	}

	private projectFromRow(row: Record<string, SQLOutputValue>): WorkspaceProject {
		return { id: String(row.id), name: String(row.name), createdAt: String(row.created_at) };
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
}
