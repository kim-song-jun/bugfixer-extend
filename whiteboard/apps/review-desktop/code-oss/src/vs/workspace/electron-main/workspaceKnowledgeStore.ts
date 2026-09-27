/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { ConventionCheck, ConventionVersion, ProviderKind, ReferenceSnapshot } from './workspaceDatabase.js';

const maximumReferenceContentBytes = 16 * 1024 * 1024;
const maximumConventionBytes = 256 * 1024;

export type ReferenceSnapshotSummary = Omit<ReferenceSnapshot, 'content' | 'derivedText'>;

export interface ImportReferenceInput {
	readonly projectId: string;
	readonly connectorId: string;
	readonly connectorVersion: string;
	readonly externalId: string;
	readonly sourceUri?: string | null;
	readonly accountRef?: string | null;
	readonly title: string;
	readonly contentType: string;
	readonly content: Uint8Array;
	readonly derivedText?: string;
	readonly omissions?: readonly string[];
}

/** The app's immutable reference and convention records share workspace.db's writer. */
export class WorkspaceKnowledgeStore {
	constructor(private readonly db: DatabaseSync, private readonly assertOpen: () => void) { }

	importReference(input: ImportReferenceInput): ReferenceSnapshot {
		this.assertOpen();
		const connectorId = requiredText(input.connectorId, 'Connector ID', 120);
		const connectorVersion = requiredText(input.connectorVersion, 'Connector version', 120);
		const externalId = requiredText(input.externalId, 'External source ID', 2048);
		const title = requiredText(input.title, 'Reference title', 500);
		const contentType = requiredText(input.contentType, 'Content type', 160);
		const sourceUri = input.sourceUri === undefined || input.sourceUri === null ? null : requiredText(input.sourceUri, 'Source URI', 4096);
		const accountRef = input.accountRef === undefined || input.accountRef === null ? null : requiredText(input.accountRef, 'Source account reference', 300);
		if (!(input.content instanceof Uint8Array) || input.content.byteLength > maximumReferenceContentBytes) {
			throw new Error('Reference content must be bytes of at most 16 MiB.');
		}
		const content = Buffer.from(input.content);
		const derivedText = input.derivedText ?? (contentType.toLowerCase() === 'text/plain; charset=utf-8' ? new TextDecoder('utf-8', { fatal: true }).decode(content) : '');
		if (typeof derivedText !== 'string' || Buffer.byteLength(derivedText, 'utf8') > maximumReferenceContentBytes) {
			throw new Error('Derived reference text must be at most 16 MiB of UTF-8 text.');
		}
		const omissions = input.omissions ?? [];
		if (!Array.isArray(omissions) || omissions.length > 50 || omissions.some(item => typeof item !== 'string' || item.length > 500)) {
			throw new Error('Reference omissions must be a short list of labels.');
		}
		const sourceKey = digest(`${connectorId}\0${accountRef ?? ''}\0${externalId}`);
		const retrievedAt = new Date().toISOString();
		return this.transaction(() => {
			this.requireProject(input.projectId);
			let source = this.db.prepare('SELECT id FROM reference_sources WHERE project_id = ? AND source_key = ?')
				.get(input.projectId, sourceKey) as { id: string } | undefined;
			if (!source) {
				source = { id: randomUUID() };
				this.db.prepare(`INSERT INTO reference_sources (id, project_id, connector_id, external_id, account_ref, source_key, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)`).run(source.id, input.projectId, connectorId, externalId, accountRef ?? '', sourceKey, retrievedAt);
			}
			const previous = this.db.prepare('SELECT id, version FROM reference_snapshots WHERE source_id = ? ORDER BY version DESC LIMIT 1')
				.get(source.id) as { id: string; version: number } | undefined;
			const id = randomUUID();
			this.db.prepare(`INSERT INTO reference_snapshots
				(id, source_id, version, previous_id, connector_version, source_uri, title, retrieved_at, content_type, content_sha256, content, omissions_json, derived_text)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				id, source.id, (previous?.version ?? 0) + 1, previous?.id ?? null, connectorVersion, sourceUri,
				title, retrievedAt, contentType, digest(content), content, JSON.stringify(omissions), derivedText,
			);
			return this.readReference(id)!;
		});
	}

	/** Saves a reference and its optional task link as one transaction. Failed links leave no snapshot version. */
	importReferenceWithTask(input: ImportReferenceInput, taskId?: string): ReferenceSnapshot {
		this.assertOpen();
		return this.transaction(() => {
			const snapshot = this.importReference(input);
			if (taskId !== undefined) { this.attachReferenceToTask(taskId, snapshot.id); }
			return snapshot;
		});
	}

	readReference(id: string): ReferenceSnapshot | undefined {
		this.assertOpen();
		const row = this.db.prepare(`SELECT s.id, s.source_id, r.project_id, r.connector_id, r.external_id, r.account_ref,
			s.version, s.previous_id, s.connector_version, s.source_uri, s.title, s.retrieved_at,
			s.content_type, s.content_sha256, s.content, s.omissions_json, s.derived_text
			FROM reference_snapshots s JOIN reference_sources r ON r.id = s.source_id WHERE s.id = ?`).get(id);
		return row ? this.referenceFromRow(row, true) as ReferenceSnapshot : undefined;
	}

	listProjectReferences(projectId: string): ReferenceSnapshotSummary[] {
		this.assertOpen();
		this.requireProject(projectId);
		return this.db.prepare(`SELECT s.id, s.source_id, r.project_id, r.connector_id, r.external_id, r.account_ref,
			s.version, s.previous_id, s.connector_version, s.source_uri, s.title, s.retrieved_at,
			s.content_type, s.content_sha256, s.omissions_json
			FROM reference_snapshots s JOIN reference_sources r ON r.id = s.source_id
			WHERE r.project_id = ? ORDER BY s.retrieved_at DESC, s.version DESC, s.id`).all(projectId)
			.map(row => this.referenceFromRow(row, false) as ReferenceSnapshotSummary);
	}

	attachReferenceToTask(taskId: string, snapshotId: string): void {
		this.assertOpen();
		this.transaction(() => {
			const match = this.db.prepare(`SELECT 1 FROM tasks t JOIN reference_snapshots s ON s.id = ?
				JOIN reference_sources r ON r.id = s.source_id AND r.project_id = t.project_id
				WHERE t.id = ? AND t.archived_at IS NULL AND t.trashed_at IS NULL`).get(snapshotId, taskId);
			if (!match) { throw new Error('The reference and active task must belong to the same project.'); }
			this.db.prepare('INSERT OR IGNORE INTO task_reference_links (task_id, snapshot_id, attached_at) VALUES (?, ?, ?)')
				.run(taskId, snapshotId, new Date().toISOString());
		});
	}

	listTaskReferences(taskId: string): ReferenceSnapshotSummary[] {
		this.assertOpen();
		return this.db.prepare(`SELECT s.id, s.source_id, r.project_id, r.connector_id, r.external_id, r.account_ref,
			s.version, s.previous_id, s.connector_version, s.source_uri, s.title, s.retrieved_at,
			s.content_type, s.content_sha256, s.omissions_json
			FROM task_reference_links l JOIN reference_snapshots s ON s.id = l.snapshot_id
			JOIN reference_sources r ON r.id = s.source_id WHERE l.task_id = ? ORDER BY l.attached_at, s.id`).all(taskId)
			.map(row => this.referenceFromRow(row, false) as ReferenceSnapshotSummary);
	}

	createConventionVersion(input: {
		projectId: string;
		markdown: string;
		sourceSnapshotIds: readonly string[];
		authoredBy: ConventionVersion['authoredBy'];
		authorAttemptId?: string | null;
	}): ConventionVersion {
		this.assertOpen();
		if (typeof input.markdown !== 'string' || !input.markdown.trim() || Buffer.byteLength(input.markdown, 'utf8') > maximumConventionBytes) {
			throw new Error('Convention document must contain 1–262144 UTF-8 bytes.');
		}
		const markdown = input.markdown;
		const sourceIds = this.validateSourceIds(input.sourceSnapshotIds);
		if (!['person', 'codex', 'claude'].includes(input.authoredBy)) { throw new Error('Invalid convention author.'); }
		const authorAttemptId = input.authorAttemptId ?? null;
		if ((input.authoredBy === 'person') !== (authorAttemptId === null)) {
			throw new Error('Agent-authored conventions need a recorded run; person-authored conventions do not.');
		}
		return this.transaction(() => {
			this.requireProject(input.projectId);
			this.requireProjectSources(input.projectId, sourceIds);
			if (authorAttemptId) { this.requireSuccessfulAttempt(authorAttemptId, input.authoredBy as ProviderKind, input.projectId, 'convention-draft'); }
			const version = Number(this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM convention_versions WHERE project_id = ?')
				.get(input.projectId)!.version) + 1;
			const id = randomUUID();
			this.db.prepare(`INSERT INTO convention_versions
				(id, project_id, version, markdown, source_snapshot_ids_json, authored_by, author_attempt_id, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
				id, input.projectId, version, markdown, JSON.stringify(sourceIds), input.authoredBy, authorAttemptId, new Date().toISOString(),
			);
			return this.readConvention(id)!;
		});
	}

	readConvention(id: string): ConventionVersion | undefined {
		this.assertOpen();
		const row = this.db.prepare(`SELECT v.*, a.applied_at, (SELECT MAX(applied_at) FROM convention_apply_audit WHERE to_version_id = v.id) AS last_applied_at
			FROM convention_versions v LEFT JOIN project_active_conventions a ON a.version_id = v.id WHERE v.id = ?`).get(id);
		return row ? this.conventionFromRow(row) : undefined;
	}

	listConventions(projectId: string): ConventionVersion[] {
		this.assertOpen();
		this.requireProject(projectId);
		return this.db.prepare(`SELECT v.*, a.applied_at, (SELECT MAX(applied_at) FROM convention_apply_audit WHERE to_version_id = v.id) AS last_applied_at
			FROM convention_versions v LEFT JOIN project_active_conventions a ON a.version_id = v.id
			WHERE v.project_id = ? ORDER BY v.version DESC`).all(projectId).map(row => this.conventionFromRow(row));
	}

	activeConvention(projectId: string): ConventionVersion | undefined {
		this.assertOpen();
		const row = this.db.prepare('SELECT version_id FROM project_active_conventions WHERE project_id = ?').get(projectId);
		if (!row) { return undefined; }
		const version = this.readConvention(String(row.version_id));
		if (version?.authorAttemptId && this.latestConventionCheckVerdict(version.id) !== 'pass') {
			throw new Error('The active agent-authored convention no longer has a passing latest check. Review this version before running an agent.');
		}
		return version;
	}

	applyConventionVersion(projectId: string, versionId: string): ConventionVersion {
		this.assertOpen();
		return this.transaction(() => {
			const version = this.readConvention(versionId);
			if (!version || version.projectId !== projectId) { throw new Error('Convention version does not belong to this project.'); }
			this.requireProjectSources(projectId, version.sourceSnapshotIds);
			if (version.authorAttemptId) {
				if (this.latestConventionCheckVerdict(versionId) !== 'pass') {
					throw new Error('An agent-authored convention requires a passing check for this version before it can be applied.');
				}
			}
			const previous = this.db.prepare('SELECT version_id FROM project_active_conventions WHERE project_id = ?').get(projectId);
			if (previous?.version_id === versionId) { return version; }
			const appliedAt = new Date().toISOString();
			this.db.prepare(`INSERT INTO project_active_conventions (project_id, version_id, applied_at) VALUES (?, ?, ?)
				ON CONFLICT(project_id) DO UPDATE SET version_id = excluded.version_id, applied_at = excluded.applied_at`)
				.run(projectId, versionId, appliedAt);
			this.db.prepare('INSERT INTO convention_apply_audit (project_id, from_version_id, to_version_id, applied_at) VALUES (?, ?, ?, ?)')
				.run(projectId, previous ? String(previous.version_id) : null, versionId, appliedAt);
			return this.readConvention(versionId)!;
		});
	}

	recordConventionCheck(input: { versionId: string; provider: ProviderKind; attemptId: string; verdict: ConventionCheck['verdict']; report: string }): ConventionCheck {
		this.assertOpen();
		const report = requiredText(input.report, 'Convention check report', 100_000);
		if (!['pass', 'concerns', 'fail'].includes(input.verdict)) { throw new Error('Invalid convention check verdict.'); }
		return this.transaction(() => {
			const version = this.readConvention(input.versionId);
			if (!version) { throw new Error('Convention version is unavailable.'); }
			if (version.authorAttemptId === input.attemptId) { throw new Error('A convention draft cannot check itself.'); }
			this.requireSuccessfulAttempt(input.attemptId, input.provider, version.projectId, 'convention-check', version.id);
			const check: ConventionCheck = {
				id: randomUUID(), versionId: version.id, provider: input.provider,
				attemptId: input.attemptId, verdict: input.verdict, report, checkedAt: new Date().toISOString(),
			};
			this.db.prepare(`INSERT INTO convention_checks (id, version_id, provider, attempt_id, verdict, report, checked_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
				check.id, check.versionId, check.provider, check.attemptId, check.verdict, check.report, check.checkedAt,
			);
			return check;
		});
	}

	listConventionChecks(versionId: string): ConventionCheck[] {
		this.assertOpen();
		return this.db.prepare('SELECT * FROM convention_checks WHERE version_id = ? ORDER BY rowid').all(versionId)
			.map(row => ({
				id: String(row.id), versionId: String(row.version_id), provider: row.provider as ProviderKind,
				attemptId: String(row.attempt_id), verdict: row.verdict as ConventionCheck['verdict'],
				report: String(row.report), checkedAt: String(row.checked_at),
			}));
	}

	latestConventionCheckVerdict(versionId: string): ConventionCheck['verdict'] | null {
		this.assertOpen();
		const row = this.db.prepare('SELECT verdict FROM convention_checks WHERE version_id = ? ORDER BY rowid DESC LIMIT 1').get(versionId);
		return row ? row.verdict as ConventionCheck['verdict'] : null;
	}

	private requireSuccessfulAttempt(attemptId: string, provider: ProviderKind, projectId: string, mode: 'convention-draft' | 'convention-check', conventionId: string | null = null): void {
		const row = this.db.prepare(`SELECT 1 FROM provider_attempts a JOIN tasks t ON t.id = a.task_id
			WHERE a.attempt_id = ? AND a.provider = ? AND t.project_id = ? AND a.mode = ?
				AND a.convention_snapshot_id IS ? AND a.state = 'succeeded' AND a.cleanup_verified = 1`)
			.get(attemptId, provider, projectId, mode, conventionId);
		if (!row) { throw new Error(`A successful, cleaned-up ${mode} agent run from this project is required.`); }
	}

	private requireProject(projectId: string): void {
		if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) { throw new Error('Project is unavailable.'); }
	}

	private validateSourceIds(ids: readonly string[]): readonly string[] {
		if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) || new Set(ids).size !== ids.length) {
			throw new Error('Convention sources must be unique reference snapshot IDs.');
		}
		return [...ids];
	}

	private requireProjectSources(projectId: string, ids: readonly string[]): void {
		for (const id of ids) {
			const match = this.db.prepare(`SELECT 1 FROM reference_snapshots s JOIN reference_sources r ON r.id = s.source_id
				WHERE s.id = ? AND r.project_id = ?`).get(id, projectId);
			if (!match) { throw new Error('Convention source is unavailable in this project.'); }
		}
	}

	private referenceFromRow(row: Record<string, SQLOutputValue>, includeContent: boolean): ReferenceSnapshot | ReferenceSnapshotSummary {
		const value: ReferenceSnapshotSummary = {
			id: String(row.id), sourceId: String(row.source_id), projectId: String(row.project_id),
			connectorId: String(row.connector_id), connectorVersion: String(row.connector_version),
			externalId: String(row.external_id), sourceUri: row.source_uri as string | null,
			accountRef: row.account_ref === '' ? null : String(row.account_ref),
			version: Number(row.version), previousId: row.previous_id as string | null, title: String(row.title),
			retrievedAt: String(row.retrieved_at), contentType: String(row.content_type), contentSha256: String(row.content_sha256),
			omissions: JSON.parse(String(row.omissions_json)) as string[],
		};
		return includeContent ? {
			...value, content: new Uint8Array(row.content as Uint8Array), derivedText: String(row.derived_text ?? ''),
		} : value;
	}

	private conventionFromRow(row: Record<string, SQLOutputValue>): ConventionVersion {
		return {
			id: String(row.id), projectId: String(row.project_id), version: Number(row.version), markdown: String(row.markdown),
			sourceSnapshotIds: JSON.parse(String(row.source_snapshot_ids_json)) as string[],
			authoredBy: row.authored_by as ConventionVersion['authoredBy'],
			authorAttemptId: row.author_attempt_id as string | null, createdAt: String(row.created_at),
			active: row.applied_at !== null, lastAppliedAt: row.last_applied_at as string | null,
		};
	}

	private transaction<T>(operation: () => T): T {
		const nested = this.db.isTransaction;
		this.db.exec(nested ? 'SAVEPOINT workspace_knowledge_store;' : 'BEGIN IMMEDIATE;');
		try {
			const result = operation();
			this.db.exec(nested ? 'RELEASE SAVEPOINT workspace_knowledge_store;' : 'COMMIT;');
			return result;
		} catch (error) {
			this.db.exec(nested ? 'ROLLBACK TO SAVEPOINT workspace_knowledge_store; RELEASE SAVEPOINT workspace_knowledge_store;' : 'ROLLBACK;');
			throw error;
		}
	}
}

function requiredText(value: string, label: string, maximumLength: number): string {
	if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
		throw new Error(`${label} must contain 1–${maximumLength} characters.`);
	}
	return value.trim();
}

function digest(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}
