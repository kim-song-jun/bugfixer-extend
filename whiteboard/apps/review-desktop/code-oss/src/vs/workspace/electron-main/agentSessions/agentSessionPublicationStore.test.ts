/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WorkspaceDatabase } from '../workspaceDatabase.js';
import { createMergedPublicationFixture } from './agentSessionPublicationFixture.testHelpers.js';

test('publication journal binds a real merged result, is idempotent, strict, bounded, and readable after reopen', () => {
	const fixture = createMergedPublicationFixture();
	let database: WorkspaceDatabase | undefined;
	let sqlite: DatabaseSync | undefined;
	try {
		database = WorkspaceDatabase.open(fixture.sourcePath);
		sqlite = Reflect.get(database, 'db') as DatabaseSync;
		let store = database.agentSessionPublications;
		const input = fixture.input;
		assert.throws(() => store.createProposal({ ...input, sourceMerge: { ...input.sourceMerge, mergeFingerprint: '0'.repeat(64) } }), /actual persisted merge store/);
		const proposal = store.createProposal(input);
		assert.ok(database.agentSessions.listNotifications(input.projectId, { limit: 100 }).some(item => item.eventId === `publicationProposal:${proposal.id}:review`
			&& item.kind === 'prReady' && item.target.kind === 'publicationProposal' && item.target.id === proposal.id && item.target.turnId === input.turnId));
		assert.throws(() => sqlite!.prepare(`INSERT INTO agent_session_publication_operations
			(id, proposal_id, proposal_fingerprint, account_stable_id, repository_id, publication_ref, expected_old_remote_oid, head_oid, state, revision, started_at)
			VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'started', 0, ?)`)
			.run(randomUUID(), proposal.id, proposal.fingerprint, proposal.account.stableId, proposal.remote.repositoryId, proposal.publicationRef, proposal.resultCommit, new Date().toISOString()), /exact human-approved proposal/);
		assert.equal(Number((sqlite!.prepare('SELECT COUNT(*) AS count FROM agent_session_publication_operations WHERE proposal_id = ?').get(proposal.id) as { count: number }).count), 0);
		database.close(); database = WorkspaceDatabase.open(fixture.sourcePath); sqlite = Reflect.get(database, 'db') as DatabaseSync;
		store = database.agentSessionPublications;
		assert.equal(store.getProposal(proposal.id)?.approval, null);
		assert.equal(Number((sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_publication_operations WHERE proposal_id = ?').get(proposal.id) as { count: number }).count), 0);
		assert.equal(proposal.publicationRef, `refs/heads/bugfixer/pr/${proposal.id}`);
		assert.equal(proposal.expectedOldRemoteOid, null);
		assert.equal(proposal.draft, true);
		assert.deepEqual(store.createProposal(input), proposal);
		assert.equal(database.agentSessions.listNotifications(input.projectId, { limit: 100 }).filter(item => item.eventId === `publicationProposal:${proposal.id}:review`).length, 1);
		assert.equal(store.listProposals(input.projectId, input.sessionId, input.turnId).proposals.length, 1);
		assert.throws(() => store.createProposal({ ...input, projectId: randomUUID() }), /Source merge scope/);
		assert.throws(() => store.createProposal({ ...input, account: { ...input.account, host: 'github.example' } }), /account identity is invalid/);
		assert.throws(() => store.createProposal({ ...input, remote: { ...input.remote, canonicalUrl: 'https://github.com/acme/other.git' } }), /Canonical GitHub remote URL/);
		assert.throws(() => store.createProposal({ ...input, diff: { ...input.diff, fingerprint: '0'.repeat(64) } }), /wrong fingerprint/);
		assert.throws(() => store.recordTrustedHumanApproval(proposal.id, proposal.revision, 'f'.repeat(64)), /stale/);
		assert.throws(() => store.startOperation(proposal.id, proposal.fingerprint), /trusted human approval/);
		const approval = store.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint);
		assert.equal(approval.actor, 'human');
		const operation = store.startOperation(proposal.id, proposal.fingerprint);
		assert.deepEqual(store.startOperation(proposal.id, proposal.fingerprint), operation);
		assert.throws(() => store.appendEvent(operation.id, 0, { type: 'pullRequestWriteStarted', headOid: proposal.resultCommit }), /requires the exact observed proposal branch/);
		assert.throws(() => store.appendEvent(operation.id, 0, { type: 'pullRequestObserved', id: '17', url: 'https://evil.example/acme/widget/pull/17', repositoryId: proposal.remote.repositoryId,
			headRef: proposal.publicationRef, headOid: proposal.resultCommit, baseRef: proposal.baseRef, baseOid: proposal.baseOid, title: proposal.title, body: proposal.body,
			draft: true, outcome: 'created', errorCode: 'none' }), /out of sequence or invalid/);
		assert.throws(() => store.appendEvent(operation.id, 0, { type: 'published', pullRequestId: '17', url: 'https://github.com/acme/widget/pull/17', branchOid: proposal.resultCommit,
			headOid: proposal.resultCommit, baseRef: proposal.baseRef, title: proposal.title, body: proposal.body, draft: true }), { code: 'invalidStep' });
		let current = store.appendEvent(operation.id, 0, { type: 'branchWriteStarted', expectedOldRemoteOid: null });
		assert.throws(() => store.appendEvent(operation.id, 0, { type: 'branchObserved', oid: proposal.resultCommit, outcome: 'created', errorCode: 'none' }), /already recorded with different content/);
		current = store.appendEvent(operation.id, current.revision, { type: 'branchObserved', oid: proposal.resultCommit, outcome: 'created', errorCode: 'none' });
		current = store.appendEvent(operation.id, current.revision, { type: 'pullRequestWriteStarted', headOid: proposal.resultCommit });
		current = store.appendEvent(operation.id, current.revision, { type: 'pullRequestObserved', id: '17', url: 'https://github.com/acme/widget/pull/17', repositoryId: proposal.remote.repositoryId,
			headRef: proposal.publicationRef, headOid: proposal.resultCommit, baseRef: proposal.baseRef, baseOid: proposal.baseOid, title: proposal.title, body: proposal.body,
			draft: true, outcome: 'created', errorCode: 'none' });
		current = store.appendEvent(operation.id, current.revision, { type: 'published', pullRequestId: '17', url: 'https://github.com/acme/widget/pull/17', branchOid: proposal.resultCommit,
			headOid: proposal.resultCommit, baseRef: proposal.baseRef, title: proposal.title, body: proposal.body, draft: true });
		assert.equal(current.state, 'published');
		assert.throws(() => store.appendEvent(operation.id, current.revision, { type: 'failed', errorCode: 'providerFailed', pullRequestId: '17', branchOid: proposal.resultCommit }), /already terminal/);
		assert.throws(() => sqlite!.prepare('UPDATE agent_session_publication_proposals SET payload_json = ? WHERE id = ?').run('{}', proposal.id), /immutable/);
		assert.throws(() => sqlite!.prepare('UPDATE agent_session_publication_approvals SET actor = ? WHERE proposal_id = ?').run('renderer', proposal.id), /immutable|human/);
		assert.throws(() => sqlite!.prepare('UPDATE agent_session_publication_events SET event_json = ? WHERE operation_id = ? AND revision = 1').run('{}', operation.id), /immutable/);
		database.close(); database = WorkspaceDatabase.open(fixture.sourcePath); store = database.agentSessionPublications;
		assert.equal(store.getProposal(proposal.id)?.fingerprint, proposal.fingerprint);
		assert.deepEqual(store.readOperation(operation.id), current);
	} finally {
		database?.close();
		fixture.dispose();
	}
});

test('publication history retains at most five full proposals and never prunes approved or started authority', () => {
	const fixture = createMergedPublicationFixture(); let database: WorkspaceDatabase | undefined;
	try {
		database = WorkspaceDatabase.open(fixture.sourcePath);
		const store = database.agentSessionPublications;
		const ids: string[] = [];
		for (let revision = 0; revision < 6; revision++) {
			const proposal = store.createProposal({ ...fixture.input, expectedRevision: revision, title: `Change ${revision}` });
			ids.push(proposal.id);
			if (revision > 0) { store.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint); }
		}
		const first = store.listProposals(fixture.input.projectId, fixture.input.sessionId, fixture.input.turnId);
		assert.deepEqual(first.proposals.map(proposal => proposal.id), ids.slice(1));
		assert.equal(first.hasMore, false);
		assert.equal(store.getProposal(ids[0]), undefined, 'The original unstarted proposal is pruned by the existing retention policy.');
		const prunedProposalAlert = database.agentSessions.listNotifications(fixture.input.projectId, { limit: 100 }).find(item => item.eventId === `publicationProposal:${ids[0]}:review`);
		assert.deepEqual(prunedProposalAlert?.target, { kind: 'publicationProposal', id: ids[0], turnId: fixture.input.turnId }, 'The durable alert keeps its exact pruned target.');
		const sqlite = Reflect.get(database, 'db') as DatabaseSync;
		sqlite.exec('BEGIN IMMEDIATE;');
		assert.deepEqual(database.agentSessions.recordNotificationWithinTransaction({ eventId: `publicationProposal:${ids[0]}:review`, projectId: fixture.input.projectId,
			sessionId: fixture.input.sessionId, kind: 'prReady', target: { kind: 'publicationProposal', id: ids[0], turnId: fixture.input.turnId } }), prunedProposalAlert,
		'An idempotent event retry remains valid after its proposal is pruned.');
		sqlite.exec('COMMIT;');
		const latest = first.proposals.at(-1)!;
		const started = store.startOperation(latest.id, latest.fingerprint);
		assert.throws(() => store.createProposal({ ...fixture.input, expectedRevision: 6, title: 'Change 6' }), /history is full/);
		assert.deepEqual(store.readOperation(started.id), started);
		assert.equal(store.getProposal(latest.id)?.approval?.proposalFingerprint, latest.fingerprint);
	} finally { database?.close(); fixture.dispose(); }
});

test('publication recovery preserves a partially created PR ID after a base SHA race and superseding proposal', () => {
	const fixture = createMergedPublicationFixture(); let database: WorkspaceDatabase | undefined;
	try {
		database = WorkspaceDatabase.open(fixture.sourcePath);
		let store = database.agentSessionPublications;
		const proposal = store.createProposal(fixture.input); store.recordTrustedHumanApproval(proposal.id, proposal.revision, proposal.fingerprint);
		let operation = store.startOperation(proposal.id, proposal.fingerprint);
		operation = store.appendEvent(operation.id, 0, { type: 'branchWriteStarted', expectedOldRemoteOid: null });
		operation = store.appendEvent(operation.id, 1, { type: 'branchObserved', oid: proposal.resultCommit, outcome: 'created', errorCode: 'none' });
		operation = store.appendEvent(operation.id, 2, { type: 'pullRequestWriteStarted', headOid: proposal.resultCommit });
		operation = store.appendEvent(operation.id, 3, { type: 'pullRequestObserved', id: '23', url: 'https://github.com/acme/widget/pull/23', repositoryId: 'R_kgDOChanged',
			headRef: proposal.publicationRef, headOid: proposal.resultCommit, baseRef: proposal.baseRef, baseOid: '9'.repeat(40), title: proposal.title, body: proposal.body,
			draft: true, outcome: 'mismatch', errorCode: 'remoteChanged' });
		operation = store.appendEvent(operation.id, 4, { type: 'recoveryRequired', reason: 'baseChanged', pullRequestId: '23', branchOid: proposal.resultCommit });
		assert.equal(operation.state, 'recoveryRequired');
		assert.throws(() => store.appendEvent(operation.id, 5, { type: 'branchWriteStarted', expectedOldRemoteOid: null }), /Recovery permits read-only/);
		operation = store.appendEvent(operation.id, 5, { type: 'branchReobserved', oid: proposal.resultCommit, outcome: 'created', errorCode: 'none' });
		assert.throws(() => store.appendEvent(operation.id, 6, { type: 'pullRequestReobserved', id: '24', url: 'https://github.com/acme/widget/pull/24', repositoryId: proposal.remote.repositoryId,
			headRef: proposal.publicationRef, headOid: proposal.resultCommit, baseRef: proposal.baseRef, baseOid: '9'.repeat(40), title: proposal.title, body: proposal.body,
			draft: true, outcome: 'created', errorCode: 'none' }), /same or newly discovered canonical/);
		operation = store.appendEvent(operation.id, 6, { type: 'pullRequestReobserved', id: '23', url: 'https://github.com/acme/widget/pull/23', repositoryId: proposal.remote.repositoryId,
			headRef: proposal.publicationRef, headOid: proposal.resultCommit, baseRef: proposal.baseRef, baseOid: '9'.repeat(40), title: proposal.title, body: proposal.body,
			draft: true, outcome: 'created', errorCode: 'baseChanged' });
		operation = store.appendEvent(operation.id, 7, { type: 'recoveryRequired', reason: 'baseChanged', pullRequestId: '23', branchOid: proposal.resultCommit });
		assert.equal(operation.state, 'recoveryRequired');
		operation = store.appendEvent(operation.id, 8, { type: 'branchReobserved', oid: null, outcome: 'absent', errorCode: 'none' });
		operation = store.appendEvent(operation.id, 9, { type: 'recoveryRequired', reason: 'uncertainWrite', pullRequestId: '23', branchOid: null });
		assert.equal(operation.state, 'recoveryRequired');
		assert.throws(() => store.appendEvent(operation.id, 10, { type: 'notPublished', reason: 'branchAbsent', pullRequestId: '23', branchOid: null }), { code: 'invalidStep' });
		assert.equal(store.readOperation(operation.id).state, 'recoveryRequired');
		operation = store.appendEvent(operation.id, 10, { type: 'branchReobserved', oid: null, outcome: 'absent', errorCode: 'none' });
		operation = store.appendEvent(operation.id, 11, { type: 'pullRequestReobserved', id: '23', url: 'https://github.com/acme/widget/pull/23', repositoryId: proposal.remote.repositoryId,
			headRef: proposal.publicationRef, headOid: proposal.resultCommit, baseRef: proposal.baseRef, baseOid: '9'.repeat(40), title: proposal.title, body: proposal.body,
			draft: true, outcome: 'absent', errorCode: 'none' });
		assert.throws(() => store.appendEvent(operation.id, 12, { type: 'notPublished', reason: 'branchAbsent', pullRequestId: '23', branchOid: null }), { code: 'invalidStep' });
		assert.equal(store.readOperation(operation.id).state, 'recoveryRequired');
		const recovery = operation.events.filter(record => record.event.type === 'recoveryRequired').at(-1)?.event;
		assert.equal(recovery?.type === 'recoveryRequired' ? recovery.pullRequestId : null, '23');
		store.createProposal({ ...fixture.input, expectedRevision: 1, title: 'Superseding reviewed draft' });
		database.close(); database = WorkspaceDatabase.open(fixture.sourcePath); store = database.agentSessionPublications;
		const reopenedJournal = store.readOperation(operation.id);
		const recordedPullRequest = reopenedJournal.events[3]?.event;
		assert.equal(recordedPullRequest?.type === 'pullRequestObserved' ? recordedPullRequest.id : null, '23');
		assert.equal(reopenedJournal.state, 'recoveryRequired');
		assert.equal(reopenedJournal.events.at(-1)?.event.type, 'pullRequestReobserved');
		const retainedIdObservation = reopenedJournal.events.at(-1)?.event;
		assert.equal(retainedIdObservation?.type === 'pullRequestReobserved' ? retainedIdObservation.id : null, '23');
	} finally { database?.close(); fixture.dispose(); }
});

