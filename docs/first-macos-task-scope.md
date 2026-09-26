# First macOS task experience: selected C scope

Status: **scope selected by the user on 2026-09-26; detailed behavior and implementation plan remain under review.** The user chose option C in the task-controls comparison. The first macOS task experience therefore includes option A's task create/edit/state controls, option B's archive/restore, manual order, and multiple visible reviews, and option C's deletion plus real agent-result suggestions/automatic state changes. This is a selected target, not a claim that source has been imported or product code exists.

The [foundation checkpoint](foundation-checkpoint.md) is an internal build step for projects, editable files, tasks, and linked reviews. Passing it does not fulfill this selected C scope. The dashboard placement choice remains open; its visual layout does not change the task/run IDs or the capabilities below.

## Required user-visible capabilities

| Capability | First macOS task experience | Evidence before acceptance |
| --- | --- | --- |
| Task management | Create/edit tasks, move among Ready, In progress, Review, Done, and show the saved state after restart | A failed write leaves the previous visible state; a second project window cannot mutate the wrong project's task |
| Archive and manual order | Archive and restore a task without losing its links; reorder cards within a state with mouse and keyboard | Order survives restart and concurrent windows return a conflict instead of overwriting a newer revision |
| Several reviews | Show all linked reviews on a task and let the user open the intended one in that project's native tab | Repeated open uses the stored `reviewId`; each create has its own durable command; a review linked to multiple tasks routes externally through an explicit destination choice |
| Delete | Provide a real delete flow distinct from archive, with clear effects on linked runs, reviews, and evidence | Delete/restore or final purge follows the approved retention rule; no accidental cascade deletes a shared Whiteboard review or immutable run evidence |
| Real agent runs | Dispatch a task to a supported provider/account, show queue/preflight/live events/result, allow cancellation, and recover after restart | The immutable launch snapshot and redacted event/audit records match the actual process; permission denial, interruption, and cleanup are visible; credentials do not enter `workspace.db` |
| App-owned subagents | Show child runs under their parent task/run with their own scope, provider/account, state, and result | A real child run's parent link, output, cancellation, and cleanup survive restart; provider-internal helpers are not mislabeled as independently managed children |
| Agent-driven board state | Show suggestions and perform at least one approved automatic transition based on a verified run event; record the rule, prior/new task revision, run ID, and reason | A real automatic move has an atomic audit receipt; a missing terminal event, soft-denied tool, failed/cancelled run, or stale task revision cannot produce a false success transition |

Run status and board state are separate. A provider exit code alone is not an agent result, and a successful run alone does not prove a task is Done. The exact automatic transition policy still needs the user's choice; until it is fixed, this document does not authorize an automatic Done rule. An automatic transition must be atomic with its audit receipt in `workspace.db`, and a person must be able to see why it happened.

## Data and execution boundaries

- Extend `workspace.db` with immutable run launch snapshots, run attempts/events/artifact references, app-owned parent/child run links, account references, task order/revision, archive/delete markers or retention records, review-link roles, and task-state transition receipts. The main process remains the sole writer. Whiteboard keeps review documents and command receipts in `review-api.db`; `workspace.db` stores returned IDs and does not treat the two stores as one transaction.
- A provider adapter starts only after project/folder, account, permission, instruction snapshot, and execution-environment preflight. The run supervisor owns the process tree and any Docker resources it starts. Cancellation and restart reconciliation follow the [provider adapter contract](provider-adapters.md#one-run-launch-contract). The selected provider/account modes and the local-versus-Docker execution boundary remain explicit user decisions.
- A folder may be a Git/jj checkout subfolder or an ordinary local folder. Review creation requires supported VCS. Agent-run eligibility for ordinary folders remains a separate decision; the app must never silently assume every folder is a worktree. Any mutating run must lock the canonical on-disk target so two project bindings for the same directory cannot write concurrently.
- Archiving hides a task from the active board but preserves its identity and links. Deletion must have an explicit retention and active-run policy before implementation. Neither action implicitly deletes a Whiteboard review that other tasks may share.
- Multiple task-review links need a defined primary/active selection rule. A second **Create review** command must be separate from **Open review** and must not accidentally retry a prior create with a changed body. Exact review-cardinality and repair behavior is a design gate.

## Staged implementation, one selected outcome

1. Import and build the pinned public Whiteboard source from a committed tree, then pass the internal [foundation checkpoint](foundation-checkpoint.md) for project windows, editable files, task persistence, and review links.
2. Add archive/restore, persisted manual ordering, several review links, and the approved delete/retention flow. Prove two-window conflicts and restart recovery.
3. Add the approved real provider/account adapters and execution environment, run records and app-owned child runs, permission preflight, canonical-target writer lock, cancellation, process cleanup, and restart reconciliation. Do not expose an agent button until its adapter works.
4. Add the approved suggestion/automatic transition policy with durable receipts. Verify real terminal events, denied operations, failed runs, races with manual moves, and the Done rule. Complete the native UI and flow checks for the whole C scope before calling this first macOS task experience complete.

These stages are internal checkpoints, not separate claims that option C has been delivered. Full-product conventions, Slack/Notion/website and installed declarative connectors, Ego Lite evidence, and Windows x86 remain in their own contracts and are not erased by this task-scope choice.

## Decisions required before the C design is approved

1. Which provider and account modes must pass the first real-run proof, including the pending Antigravity subscription-account choice. Claimed multi-account modes require concurrent identity-isolation proof.
2. Where agent processes and project commands run on macOS, including the pending Docker boundary choice and ownership/cleanup of any containers.
3. Which verified run events suggest or automatically move Ready, In progress, Review, or Done; whether and under what evidence Done may be automatic.
4. How archive, delete, restore, and permanent purge affect active runs, shared review links, and immutable evidence.
5. Whether mutating agents can run in ordinary non-VCS folders and how the canonical directory lock and warning work.
6. How a task displays/selects several reviews, what counts as primary, and when the user can create another review.

No default shown in a local comparison page is treated as an answer to these pending choices.
