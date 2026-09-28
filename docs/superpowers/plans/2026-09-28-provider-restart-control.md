# Provider Restart Control Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` task by task. Write a focused failing test before each production change. The user has already authorized implementation; this plan is an execution record, not an approval request.

**Goal:** A restarted macOS app can safely cancel a surviving Codex or Claude provider run, verify that its process group exited, and unblock later task runs.

**Architecture:** The existing detached shell remains the process group leader and keeps the durable fd3 launch gate. After GO, it starts the packaged standalone Node control helper in the same group. That helper binds a private Unix socket before spawning the provider, remains alive, and signals only its own group when it receives an authenticated cancellation command. The new app writes to the socket; it never signals a group using a saved numeric PGID.

**Tech Stack:** Code OSS Electron main process, packaged standalone Node runtime, SQLite, macOS Unix sockets, existing Review runtime packaging.

**Spec:** [product acceptance rows 5 and 10](../../product-acceptance.md) and [provider adapter contract](../../provider-adapters.md).

## Global Constraints

- macOS is the first execution target; Windows execution stays disabled until separately implemented.
- Keep the existing fd3 gate closed until the attempt's PGID and control nonce are durably stored.
- A missing or unauthenticated helper leaves cleanup unverified and the restart barrier active.
- Never send `kill(-savedPgid, …)` from a new app process. Only a live member of that group may signal it.
- The socket directory is private, owned by the current UID, mode `0700`, and short enough for macOS `sun_path`; each attempt has a unique socket path.
- Do not place the control nonce in renderer DTOs, argv, environment variables, screenshots, logs, or error text.
- Tests use only fixtures and test-owned processes, track exact PIDs, and clean them by identity. User-controlled native windows remain untouched during implementation.

## Review Focus

1. The app exits before GO: the provider must never start, and restart must clear the recorded group after it disappears. Task 3 covers this.
2. The shell leader exits while the control helper survives: cancellation must target the helper's own group without a new-app numeric signal. Task 4 covers this.
3. A socket is missing, stale, or given the wrong nonce: cancellation must fail closed and keep the barrier. Task 4 covers this.
4. The app's fd4/stdout/stderr close during a crash: the helper must remain available for cancellation despite EPIPE. Task 2 covers this.
5. A provider ignores TERM: the in-group helper must escalate after a bounded grace interval and verify group disappearance. Task 2 covers this.
6. The helper exits unexpectedly while a provider descendant survives: the shell leader must terminate its own still-pinned group before it exits. Task 3 covers this.

---

### Task 1: Durable control identity

**Files:** `whiteboard/apps/review-desktop/code-oss/src/vs/workspace/electron-main/workspaceDatabase.ts` and its focused test.

**Interface:** Extend `ProviderAttempt` with backend-only `controlVersion: 1 | null` and `controlNonce: string | null`. Extend `setProviderAttemptRunning(attemptId, expectedTaskRevision, ownedPgid, controlNonce?)` to persist version 1 and a 64-character lowercase hex nonce atomically with the PGID. Existing rows retain null control fields. Never add the nonce to `ProviderAttemptDTO`.

- [x] Add a database test that stores a nonce with PGID, closes/reopens the database, and checks the exact nonce and version; verify a legacy row reads null fields and renderer DTOs contain no nonce.
- [x] Run only the new database test and observe the expected missing-column or missing-field failure.
- [x] Add one SQLite migration with `control_version INTEGER` and `control_nonce TEXT`, validation, row mapping, and atomic write. Keep old launch-gate behavior for legacy rows.
- [x] Rerun the focused database test and its directly related migration test. Record the command and result.
- [x] Commit only the files owned by this task with explicit pathspecs (`4872403`).

### Task 2: In-group Node control helper

**Files:** create `whiteboard/apps/review-desktop/scripts/provider-group-control.mjs` and `native/provider-group-control/provider-group-control.test.mjs`.

**Interface:** The helper receives socket path, attempt ID, shell PGID, and provider executable/args as argv; it reads the nonce from fd5, closes fd5, binds the socket, installs TERM handling, then spawns the provider with inherited fd0/1/2 and no fd4/fd5. It writes the provider exit code to fd4 when available and stays alive. The socket accepts a bounded `{attemptId, nonce, command:"cancel"}` line and replies `accepted` before calling `process.kill(-pgid, "SIGTERM")`; after a bounded grace period the still-live helper calls `process.kill(-pgid, "SIGKILL")`. A live helper pins the PGID during both calls.

Before binding or accepting cancellation, the helper must prove that the supplied PGID is **its own current process group**. A live self-PID query through the absolute macOS `/bin/ps` path is sufficient; a mismatch fails closed. This prevents malformed launch wiring from turning a saved numeric identifier into an unrelated-group signal.

- [x] Write real-process tests for READY-before-provider, wrong nonce, closed fd4, surviving helper after shell loss, TERM-ignoring provider escalation, wrong PGID, and client reset. Assert the child process identities and group state, not mock invocations.
- [x] Run one smallest helper test to observe the missing-helper failure, then implement the helper with private socket ownership/mode checks and bounded input.
- [x] Rerun only the helper tests; eight passed, and test-owned process groups were confirmed gone before tracking was cleared.
- [x] Commit only the new helper and test files with explicit pathspecs (`b70238d`).

### Task 3: Durable launch-gate integration

**Files:** `providerRuns/providerProcessSupervisor.ts`, `providerRuns/providerRunTypes.ts`, and `providerRuns/providerProcessSupervisor.test.ts`.

**Interface:** Add an optional macOS `recoveryControl` request containing packaged Node executable, helper script, socket path, and nonce. Extend the persistence callback to `onOwnedProcessSpawned(pgid: number, controlNonce?: string)`. `run()` starts the current detached shell, persists `(PGID, nonce)` through that callback, writes the nonce to fd5, and only then sends GO on fd3. The shell starts the control helper as the provider parent. Linux tests retain the current direct shell path until a Linux runtime is packaged.

- [x] Add a test proving a failed durable callback or closed fd3 never starts the provider or helper; add a successful launch test asserting the helper socket exists before provider output.
- [x] Add a real test proving a helper failure with a surviving descendant makes the shell leader terminate its own group before exiting.
- [x] Run the smallest new test to observe a launch-order failure.
- [x] Implement the controlled shell branch and fd5 error handling without changing the ordinary direct branch's safety behavior.
- [x] Rerun focused launch-gate, guardian-loss, and cancellation tests. Confirm no test-owned process remains.
- [x] Commit only this task's owned files with explicit pathspecs (`1a5cb28`).

### Task 4: Restart cancellation and user control

**Files:** create `providerRuns/providerGroupControlClient.ts`; modify `workspaceProviderRunsChannel.ts`, its focused test, and `projectDashboardEditorPane.ts`.

**Interface:** `cancelProviderProcessGroup` connects to the derived private socket and sends the bounded command. An ACK means request accepted, not cleanup verified. The channel polls `isOwnedProcessGroupGone(ownedPgid)` with a bounded deadline, confirms cleanup only after ESRCH, and refreshes the writer barrier. An unavailable helper or timeout returns a specific error and retains the barrier. The dashboard shows every terminal, unverified attempt with a `정리 다시 시도` control and Korean status; the existing active-run `실행 취소` remains distinct.

User-selected Trash must use the same recovery path. Both a direct `deleteTask` request and `recoverPendingTaskDeletions` replay should request authenticated cancellation of a prior interrupted live group, wait for verified exit within a bound, then finalize Trash. Failed recovery leaves the durable deletion pending with a specific retryable error; shutdown abort still stops replay promptly.

- [x] Add a real detached-group channel test: restart recovery reaches its helper, group exit is verified, and the new-run barrier is released.
- [x] Add negative tests for wrong nonce and absent socket that assert the group stays alive and the barrier stays reserved.
- [x] Add direct and pending Trash tests where a surviving controlled group is cancelled and deletion finishes; cover failed recovery staying pending.
- [x] Run the first new channel test and observe its expected failure before implementation; prove the unverified cancellation regression red before the fix.
- [x] Add the client/channel behavior and renderer retry control. The renderer still needs a real packaged native flow because this pane has no DOM test harness and an element-presence test would not prove usability.
- [ ] After the user completes the native installer check, capture packaged before/after screenshots at desktop and 760 px, including the scroll end and console/network observations.
- [x] Commit code only by explicit pathspecs (`cd3c6e6` backend, `857d11b` renderer); the final focused barrier assertion accompanies this plan update.

### Task 5: Package and acceptance proof

**Files:** `whiteboard/apps/review-desktop/scripts/stage-review-runtime.mjs`, `scripts/package-macos.sh`, `scripts/runtime-bundler.test.mjs`, and `docs/product-acceptance.md`.

**Interface:** Stage the helper JS beside the already packaged standalone `bin/node`, require it in packaged artifact validation, and use its absolute packaged path for controlled provider runs. No unsigned package may silently use a developer checkout helper.

- [x] Add a runtime closure test that fails when the packaged control script is missing.
- [x] Stage and assert the script in the runtime and macOS package path; focused closure test passed, committed as `dae3d01`.
- [ ] Check host load/swap/process baseline; build one unsigned macOS package from the committed tree, then run one isolated real-provider restart/cancel flow and inspect DB cleanup, barrier release, no process/port leak, and native UI evidence.
- [ ] Update the acceptance row with exactly the observed packaged proof and remaining limits. Push committed changes, then confirm the remote CI for that head is green.

## Self-review

- Rows 5 and 10 need the Task 4 and Task 5 packaged proof; unit tests or an ACK alone do not close them.
- The helper design keeps the launcher gate, process-group membership, and cleanup proof as separate contracts. Missing helper, bad auth, and guardian loss all fail closed.
- The UI step remains pending while the user controls the installer window; backend and packaging work can proceed independently.
