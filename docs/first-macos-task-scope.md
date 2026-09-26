# First macOS task experience: selected C scope

Status: **task scope C, state policy A, and deletion policy B selected by the user on 2026-09-26; remaining behavior and implementation plan under review.** The first macOS task experience includes task create/edit/state controls, archive/restore, manual order, multiple visible reviews, recoverable deletion, and real agent-driven state changes. Under state policy A, a real run start moves Ready to In progress, verified success moves In progress to Review, and only a person moves a task to Done. Under deletion policy B, deleting an active task cancels and cleans up its owned runs before moving it to Trash. This is a selected target, not a claim that source has been imported or product code exists.

The [foundation checkpoint](foundation-checkpoint.md) is an internal build step for projects, editable files, tasks, and linked reviews. Passing it does not fulfill this selected C scope. The dashboard placement choice remains open; its visual layout does not change the task/run IDs or the capabilities below.

## Required user-visible capabilities

| Capability | First macOS task experience | Evidence before acceptance |
| --- | --- | --- |
| Task management | Create/edit tasks, move among Ready, In progress, Review, Done, and show the saved state after restart | A failed write leaves the previous visible state; a second project window cannot mutate the wrong project's task |
| Archive and manual order | Archive and restore a task without losing its links; reorder cards within a state with mouse and keyboard | Order survives restart and concurrent windows return a conflict instead of overwriting a newer revision |
| Several reviews | Show all linked reviews on a task and let the user open the intended one in that project's native tab | Repeated open uses the stored `reviewId`; each create has its own durable command; a review linked to multiple tasks routes externally through an explicit destination choice |
| Delete | Stop all owned nonterminal parent/child attempts, clean up live resources, then move the task to recoverable Trash; archive remains a separate view | A queued attempt cannot start during deletion; failed cancellation leaves the task visible with an error; delete/restore retains run history and review links without cascade-deleting shared Review or evidence |
| Real agent runs | Dispatch a task to a supported provider/account, show queue/preflight/live events/result, allow cancellation, and recover after restart | The immutable launch snapshot and redacted event/audit records match the actual process; permission denial, interruption, and cleanup are visible; credentials do not enter `workspace.db` |
| App-owned subagents | Show child runs under their parent task/run with their own scope, provider/account, state, and result | A real child run's parent link, output, cancellation, and cleanup survive restart; provider-internal helpers are not mislabeled as independently managed children |
| Agent-driven board state | Perform Ready → In progress on a real run start and In progress → Review on verified success; leave Done to a person's action | Both automatic moves have atomic audit receipts with rule, run ID, event, and prior/new task revision; failed/cancelled runs and stale task revisions cannot produce a false move |

Run status and board state are separate. Queue/preflight do not move a task; Ready → In progress occurs only after the provider process actually starts and the running event is recorded. In progress → Review requires a parsed terminal success with no unmet required-tool operation and completed owned-resource cleanup; an exit code alone is insufficient. Failure, cancellation, interruption, missing terminal event, or cleanup failure leave the board state unchanged and show the run outcome. A person's concurrent state move wins: a stale automatic transition returns a revision conflict and becomes a visible suggestion instead of overwriting the person. Each accepted move and its audit receipt commit atomically in `workspace.db`. Done is always a person's explicit, recorded action under selected policy A.

## Data and execution boundaries

- Extend `workspace.db` with immutable run launch snapshots, run attempts/events/artifact references, app-owned parent/child run links, account references, task order/revision, archive/delete markers or retention records, review-link roles, and task-state transition receipts. The main process remains the sole writer. Whiteboard keeps review documents and command receipts in `review-api.db`; `workspace.db` stores returned IDs and does not treat the two stores as one transaction.
- A provider adapter starts only after project/folder, account, permission, instruction snapshot, and execution-environment preflight. The run supervisor owns the process tree and any Docker resources it starts. Cancellation and restart reconciliation follow the [provider adapter contract](provider-adapters.md#one-run-launch-contract). The selected provider/account modes and the local-versus-Docker execution boundary remain explicit user decisions.
- A folder may be a Git/jj checkout subfolder or an ordinary local folder. Review creation requires supported VCS. Agent-run eligibility for ordinary folders remains a separate decision; the app must never silently assume every folder is a worktree. Any mutating run must lock the canonical on-disk target so two project bindings for the same directory cannot write concurrently.
- Archiving hides a task from the active board but preserves its identity and links. Deletion policy B moves a task to recoverable Trash only after owned runs and subagents are cancelled and their process/resources are cleaned up; neither action implicitly deletes a Whiteboard review that other tasks may share. Automatic permanent purge is outside this selected policy.
- Multiple task-review links need a defined primary/active selection rule. A second **Create review** command must be separate from **Open review** and must not accidentally retry a prior create with a changed body. Exact review-cardinality and repair behavior is a design gate.

## Selected deletion policy B

1. Record a stable delete request ID and a task-level delete-pending flag in one `workspace.db` transaction. The scheduler rejects new attempts and queue-to-running dispatch for that task, including child runs, while this flag is set. Enumerate every owned nonterminal parent/child attempt (queued, preflight, running, or waiting for input) and its owned resources; never cancel another task's run merely because it shares a checkout or provider account.
2. Mark queued and preflight attempts cancelled before dispatch, and ask the run supervisor to cancel running or waiting attempts and verify process/resource cleanup. The scheduler rechecks delete-pending atomically at dispatch; startup reconciliation resumes an unfinished delete request before starting that task's work. A cancel or cleanup failure leaves the task on the active board with its links and an actionable error; retry uses the same request ID and reconciles attempts already stopped. No UI claims Trash while any owned nonterminal attempt or live resource remains.
3. After all owned attempts are terminal and cleanup succeeds, one `workspace.db` transaction records the delete receipt, prior board state, and Trash marker while keeping task ID, run history, evidence references, and all review links. A Review API document is not deleted or edited. Restore clears the Trash marker and keeps cancelled attempts visible; the restored board state must be explicit in the UI rather than inferred from a still-running badge.

The task's files are ordinary project files and are not removed by deleting its board card. Archive remains distinct from Trash. Permanent content purge and archiving during an active run require separate contracts before those controls are offered.

## Staged implementation, one selected outcome

1. Import and build the pinned public Whiteboard source from a committed tree, then pass the internal [foundation checkpoint](foundation-checkpoint.md) for project windows, editable files, task persistence, and review links.
2. Add archive/restore, persisted manual ordering, several review links, and the Trash/restore data flow for tasks without active runs. Prove two-window conflicts, retained links, and restart recovery.
3. Add the approved real provider/account adapters and execution environment, run records and app-owned child runs, permission preflight, canonical-target writer lock, cancellation, process cleanup, and restart reconciliation. Complete selected deletion policy B against queued, preflight, running, waiting, and child attempts, including a queue-to-running race and cleanup failure. Do not expose an agent button or active-run delete action until its service works.
4. Add selected state policy A with durable receipts. Verify both automatic moves against real start and terminal events, denied operations, failed runs, races with manual moves, and person-only Done. Complete the native UI and flow checks for the whole C scope before calling this first macOS task experience complete.

These stages are internal checkpoints, not separate claims that option C has been delivered. Full-product conventions, Slack/Notion/website and installed declarative connectors, Ego Lite evidence, and Windows x86 remain in their own contracts and are not erased by this task-scope choice.

## Decisions required before the C design is approved

1. Which provider and account modes must pass the first real-run proof, including the pending Antigravity subscription-account choice. Claimed multi-account modes require concurrent identity-isolation proof.
2. Where agent processes and project commands run on macOS, including the pending Docker boundary choice and ownership/cleanup of any containers.
3. What restored board state to offer after a cancelled run and whether archive is allowed during an active run. A separate permanent-purge feature is outside the selected C scope and can be decided later.
4. Whether mutating agents can run in ordinary non-VCS folders and how the canonical directory lock and warning work.
5. How a task displays/selects several reviews, what counts as primary, and when the user can create another review.

No default shown in a local comparison page is treated as an answer to these pending choices.
