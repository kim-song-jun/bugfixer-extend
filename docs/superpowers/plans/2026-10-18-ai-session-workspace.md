# AI Session Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver real concurrent Codex/Claude terminal sessions with local worktree integration, MCP collaboration, inspectable evidence/logs/alerts, human PR confirmation, and Korean onboarding.

**Architecture:** The main process owns durable sessions, turns, messages, worktree leases, approvals and orchestration in the existing app profile. Real Code OSS terminals attach to these session identities. IPC and a scoped stdio MCP gateway call the same services; only trusted UI actions may approve a merge or PR.

**Tech Stack:** Code OSS/Electron, TypeScript, node:sqlite, Git worktrees, native PTY/xterm, existing MCP SDK and CLI adapters.

**Spec:** [Approved AI session workspace design](../specs/2026-10-18-ai-session-workspace-design.md).

## Global Constraints

- macOS first; Codex and Claude existing local profiles first; agy and Windows follow the existing later-phase decisions.
- Actual interactive terminals, not a one-shot JSON run presented as a terminal.
- B: separate app-owned Git worktrees/session branches, reviewed merges into a separate integration worktree/branch; ordinary folders retain one writer.
- Preserve Korean flat POSCO-MLIP-derived theme, native per-project windows, workspace.db/Review DB separation and explicit human Done.
- New UI uses `app → pages → widgets → features → entities → shared`, no cross-slice imports, and slice public APIs.
- CLI commands use argument arrays, scoped credentials, versioned capability checks and no automatic provider/model/account fallback.
- Build, tests, lint, typecheck and scripts run in GitHub CI only; use focused serial tests for each new contract.
- Shared development main: exact owned-file commits, no development worktree/branch switches or stash. The product's managed-worktree implementation is exercised only in isolated CI Git fixtures.

## Review Focus

1. Two sessions/projects attempt to read or acknowledge one another's private mailbox; reject mismatched ownership in storage and channel tests.
2. A branch advances or gains untracked files after merge review; invalidate the snapshot and preserve every file in Git fixture tests.
3. A provider exits or app restarts during PTY/MCP/output writes; mark interrupted and prove cursor recovery and owned-resource cleanup.
4. Secrets split across terminal chunks or encoded control sequences reach logs/notifications; test streaming redaction before both display and persistence.
5. Files/HEAD change or remote publication partly succeeds after PR approval; require renewed approval and idempotent receipts in publication tests.

---

### Task 1: Durable session identities, mailboxes and alert records

**Files:**
- Create `whiteboard/apps/review-desktop/code-oss/src/vs/workspace/common/workspaceAgentSessionProtocol.ts`.
- Create `whiteboard/apps/review-desktop/code-oss/src/vs/workspace/electron-main/agentSessions/agentSessionStore.ts` and `.test.ts`.
- Modify `whiteboard/apps/review-desktop/code-oss/src/vs/workspace/electron-main/workspaceDatabase.ts` (schema v22 and `readonly agentSessions`).

**Interfaces:** `WorkspaceDatabase.agentSessions: AgentSessionStore`. Store methods `createSession(input)`, `getSession(projectId, sessionId)`, `listSessions(projectId)`, `transitionSession(projectId, sessionId, expectedRevision, nextState)`, `sendMessage(projectId, senderSessionId, {recipientSessionId, idempotencyKey, body})`, `listInbox(projectId, recipientSessionId, {afterSequence, limit})`, `acknowledgeMessage(projectId, recipientSessionId, messageId)`, `listNotifications(projectId, {afterSequence, limit})`, `markNotificationRead(projectId, notificationId)`. IDs are UUIDs; session revisions and per-recipient message sequences are monotonic. Session snapshots retain provider/model/profileRef, folder binding, parent/task ownership and workspace mode. Message bodies are bounded, sanitized by the content layer before externally exposed writes; duplicate keys with changed content reject.

`CreateAgentSessionInput` has `projectId`, `bindingId`, optional `taskId`/`parentSessionId`, `name`, `provider: 'codex'|'claude'`, `model`, optional `profileRef`, and `workspaceMode: 'gitWorktree'|'sharedFolder'`. `AgentSessionDTO` adds generated `id`, null-normalized optional fields, `state`, `revision`, `createdAt`, `updatedAt`. States are `created | starting | running | waitingForInput | waitingForApproval | idle | stopping | stopped | interrupted | failed`; invalid state transitions and stale revisions reject. Optional folder/branch assignment is a later service operation, not an unverified caller-supplied launch path. `SessionMessageDTO` contains `id, projectId, senderSessionId, recipientSessionId, sequence, idempotencyKey, body, createdAt, readAt`. `SessionNotificationDTO` contains `id, projectId, sessionId, sequence, kind:'message', messageId, createdAt, readAt`. Message max is 16,384 Unicode code units and 64 KiB UTF-8; idempotency key max is 128; page limit is 1–100 with default 50. Boundary errors never echo message bodies.

- [ ] Add tests against actual SQLite for reopen, v21 migration without losing tasks, all three provider pairings, idempotent retry, changed-key-content rejection, wrong-project/wrong-recipient ack, cursor order and durable notification read state.
- [ ] Implement v22 in the same migration transaction and shared SQLite connection; store methods assert database open and enforce project/task/binding/parent ownership.
- [ ] Add focused serial CI entrypoint in Task 2's main-owned workflow patch; no local tests.
- [ ] Independent source review, CI proof, exact-path commit.

### Task 2: App-owned worktrees and reviewed local merge core

**Files:** Create `.../electron-main/agentSessions/managedWorktrees.ts` and `managedWorktrees.test.ts`. Main owns `.github/workflows/review-desktop-ci.yml` focused test entrypoint.

**Interfaces:** `ManagedWorktreeService(profileDirectory)`. `create({repositoryPath, ownerId, kind:'session'|'integration', baseRef})` returns an owned lease with canonical common-dir/repository identity, generated branch, worktree path, base commit and state. `inspect(ownerId)` validates manifest/worktree/ref identity. `previewMerge({integrationOwnerId, sessionOwnerId})` returns an opaque preview ID with exact source/target HEAD, diff/hash and expiry. `mergeReviewed(previewId)` is called only by the later trusted human-approval channel, rechecks the exact snapshot, and returns merged commit or explicit conflict/recovery state. No MCP approval method. `remove(ownerId, {retainedIntegrationOwnerId?})` rejects dirty/untracked/unmerged data and never uses force. A lease manifest, not arbitrary caller path/branch, controls every mutation.

- [ ] Write actual disposable-Git fixtures for independent session branches, unchanged user checkout/branch, clean local integration merge, source/target advance after preview, conflict state, mismatched repositories, forged/retargeted ownership, dirty/untracked cleanup rejection, and safe merged cleanup.
- [ ] All I/O methods return `Promise` (`create/inspect → Promise<ManagedWorktreeLease>`, `previewMerge → Promise<MergePreview>`, `mergeReviewed → Promise<ReviewedMergeResult>`, `remove → Promise<void>`). Git and process-identity subprocesses must be asynchronous and bounded so an operation cannot freeze Electron's main process.
- [ ] Use subprocess argument arrays, no shell interpolation; pin commands to verified app-owned worktree/common-dir identity, disable automatic repo hooks explicitly, bound git processes and preserve partial failures for recovery.
- [ ] Gate same integration mutations with a lease; never abort/reset conflict state automatically or delete unique commits. Preserve recovery metadata after partial filesystem/Git failure.
- [ ] Add workflow step running only `agentSessions/*.test.ts` serially via existing tsx/preload; CI is the first runtime execution.
- [ ] Independent review, CI proof, exact-path commit.

### Task 3: Session host service, project IPC and real PTY lifecycle

**Files:** Create `.../electron-main/agentSessions/agentSessionService.ts`, `workspaceAgentSessionsChannel.ts`, their tests; modify `src/vs/code/electron-main/app.ts`, shared protocol, and terminal host integration file named after source inspection.

**Interfaces:** Main service owns create/start/stop/attach lifecycle and working copy lease. UI IPC requires project window authorization matching existing dashboard channels. Launch snapshots and opaque launch tickets precede PTY creation. Only host-created PTY identity may attach and update lifecycle. `start` persists the model/profile/cwd/permission/convention/reference snapshot and creates a turn. Stop/exit records terminal outcome and resource cleanup separately. Startup marks unverifiable live state interrupted and reconciles leases.

- [ ] Test forged launch/attach, wrong project, overlapping shared-folder writer, process crash and restart before enabling live launch.
- [ ] Integrate `ITerminalService.createTerminal`/native PTY, terminal events and ownership; changing UI tabs must not relaunch the CLI.
- [ ] Add versioned interactive Codex/Claude argv/MCP configuration builders, selected model, provider conversation IDs and explicit resume; inspect official installed-version support in CI without authenticated calls.
- [ ] CI actual PTY fixture exercises input/output/resize, two concurrent terminals, cancellation/descendant cleanup, disconnect/reopen, unknown lifecycle and startup failure.
- [ ] Authenticated real CLI proof remains a separate acceptance gate; fixture success must not claim account/model proof.

### Task 4: Korean session workspace UI

**Files:** New `src/vs/review/browser/aiSessions` layer/slice directories with public `index.ts`; session editor input/pane/contribution registration; focused changes to project navigation and task deep links.

**Interfaces:** Page consumes project-scoped session IPC and a terminal widget controller; main service remains execution authority. Session list and active pane retain selection/focus; Terminal/Changes/Logs are separate views of the same session, not separate launches.

- [ ] Add new AI 세션 native tab and flat session-list/detail layout using current theme tokens/Pretendard; expose selected provider/model and actual working folder.
- [ ] Implement empty/loading/error/permission-wait/disconnected/success states, keyboard actions, narrow selection control, durable selection and focus restoration.
- [ ] Wire real PTYs, live state, send/stop actions and task navigation; expose unimplemented operations as unavailable until their backing service exists.
- [ ] CI packaged native screenshots and flow assertions at 1440/760 in light/dark, inspect before/after including scroll end; Ego covers any separately reachable web routes and closes task spaces.

### Task 5: Transcript, structured logs and notifications

**Files:** Separate stream redactor/chunk store and notification service under `agentSessions`; shared protocol; Logs view and notification widget in UI layers.

**Interfaces:** Each log chunk has session/turn/stream/sequence/time; bounded pagination and cursors preserve order. Stream redaction occurs before renderer and disk. Notification IDs deduplicate source events and retain read state/deep links. Retention deletions create explicit gaps.

- [ ] Test multi-chunk secrets, ANSI/Unicode boundaries, large output/backpressure, reopen/duplicate cursor, export masking and explicit retention gaps.
- [ ] Implement follow/pause/search/filter/copy/export and bounded rendering; persist status and sanitized transcript separately.
- [ ] Implement input/approval/error/completion/message/PR-ready alerts, exact-session navigation and opt-in OS notifications, including denied permission behavior.
- [ ] Packaged UI evidence for hidden terminal history, unread persistence, log search and scroll/keyboard behavior.

### Task 6: Scoped MCP collaboration and bounded orchestration

**Files:** Main broker and capability grants under `agentSessions`; stdio gateway in packaged runtime; protocol schemas; workflow planner/scheduler; message and workflow UI features.

**Interfaces:** `sessions.list`, `sessions.requestStart`, `sessions.stop`, `messages.send/list/ack/wait`, `artifacts.list/read`, `logs.read`, `changes.read`, `workflows.status/cancel`, `pr.prepare`. Tools never expose user approval. Session/project capability token is injected per CLI launch through env and scoped config, never globally persisted or logged.

- [ ] Real MCP-client fixture tests all three provider pairings, duplicate requests, receiver shutdown, app restart, revoked/wrong-scope tokens, pagination and bounded waits.
- [ ] Implement durable mailbox receipts and same-service MCP handlers; only approved idle turns resume, never arbitrary live-terminal keystroke injection.
- [ ] Add finite role/model/dependency plan with max concurrency, turns and time; approval snapshots change on capability/target expansion; cancellation cascades exact owned resources.
- [ ] Show delegation/messages/results/limits in Korean; prove provider-native helper identity is not fabricated as app-owned child.

### Task 7: Diff provenance, local merge review and PR approval

**Files:** Change snapshot/evidence store, local merge approval service, PR draft/publication receipt service; Changes/review/PR UI features and trusted-only IPC commands.

**Interfaces:** Diff version fingerprint binds source/target HEAD and file content hashes to session/turn, selected references/rules/tool events, explanation and actual checks. A UI-only approval record binds exact fingerprint/remote/base/branch/title/body and commit/push steps. MCP may prepare/read, never approve/execute publication.

- [ ] Test unknown/mixed attribution, later file changes, untracked/deleted/renamed/binary paths and symlink targets; show missing reasons/evidence honestly.
- [ ] Connect per-file/hunk diff and explanation, exact local merge preview/approval, conflict files, repair and renewed review; preserve source branches until merged content is retained.
- [ ] Implement PR preparation and user confirmation, then fresh fingerprint checks before commit/push/publication; exact path staging only and no user branch switch/force push.
- [ ] Test stale approvals, injected out-of-scope file, commit/push/PR partial failures and idempotent retry receipts against controlled Git/HTTP fixtures in CI.
- [ ] Actual GitHub draft PR proof uses an explicitly authorized disposable repository and identity; no fixture claim substitutes for it.

### Task 8: First-use onboarding and full acceptance audit

**Files:** Onboarding page/features and settings reentry, CLI capability discovery service, acceptance documents and packaged CI journeys.

- [ ] Add project → CLI/account → model/session → scope/rules → first task; distinguish read-only detection from paid execution, support skip/resume/reopen and optional connectors.
- [ ] Explain session sharing/MCP, logs/alerts, merge/PR review and recovery in the first real task using actual state, no production demo records.
- [ ] CI keyboard/light/dark/narrow/desktop/error-state proof; then real authenticated concurrent Codex/Claude sessions, pairwise communication, selected models, cancellation/resume and exact cleanup.
- [ ] Audit product acceptance rows 1–18 individually using current evidence; keep Windows/agy and any unavailable mode explicit. Mark the overall goal complete only when its actual scope is proven.

## Exit proof for the first implementation wave

Tasks 1–2 are an internal foundation, not the finished session product. Exit requires source review plus a green GitHub CI run of real SQLite persistence/mailbox tests and disposable Git worktree/merge/cleanup tests, with the user's current development branch/folder unchanged. Later tasks remain open until their UI, actual provider and publication evidence exists.
