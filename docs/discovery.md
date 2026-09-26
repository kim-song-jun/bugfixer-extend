# Discovery: unified agent workspace

Status: source inventory and user decisions as of 2026-09-26. This document records what exists and what the new product needs; it does not describe implemented features in this repository.

## Confirmed direction

- Use the Whiteboard/Code OSS desktop shell and its review capability as the foundation. Build generic project, task, and agent workflow features inside it using Bugfixer's concepts. Do not copy files, operational data, or credentials from the private Bugfixer repository.
- Keep project, task, run, and reference data in an app-owned SQLite `workspace.db`; retain Whiteboard reviews in `review-api.db` and link them through the Review API's returned `reviewId`. This is the user's selected data-boundary option A.
- Use a native Code OSS project window with the dashboard, editable project files, and Whiteboard review canvas in its editor tabs. Preserve the existing read-only source navigator for pinned review material. This is the user's selected project-window option A.
- Use posco-mds as the visual theme reference: a simple project dashboard, clear tabs and navigation, restrained accents, and first-class light and dark modes. Reuse the visual principles and suitable generic interaction patterns, not laboratory-specific product content.
- Build for macOS first and support Windows x86 in a later phase. Keep Docker-based project execution and test environments in scope for portability; the exact desktop/container boundary remains to be designed.
- Allow conventions to be supplied per project and attached to agent work.
- Provide Slack, Notion, and website import as first-party connectors plus a contract for user-installable connectors. This is the user's selected option B; it does not imply enabling all general VS Code extensions.
- Bring Claude, Codex, and Antigravity account use, subagent orchestration, and Ego Lite frontend E2E into one task flow.

## Source capabilities and gaps

| Source | Present in the source product | Work required for this product |
| --- | --- | --- |
| Whiteboard | Code OSS desktop workbench, review views, and an app-supervised local review service. The current review profile uses SQLite `review-api.db`, with old JSON reviews imported at startup. Its Home opens without a repository and its packaged macOS release channel is arm64. The existing Review source navigator opens a separate native workspace window configured read-only. | Build an editable project mode and connect it to the dashboard and reviews; the existing source navigator alone does not meet the task-to-edit flow. Then design multi-repository work, a task board, agent-run lifecycle, connector API, and installation path for task-data connectors. Its `product.json` currently sets `extensionsGallery` to `null`. Windows `win32-x64` installers exist but have no update feed; that does not establish the new product's Windows support. |
| Bugfixer | Bug-oriented board, agent jobs, Notion and Slack collection, conventions, and E2E job flows. | A project-neutral task model and integrations. Current job state includes in-memory maps; conventions and collectors carry source-project assumptions. The implementation will be newly written. |
| Mobius | macOS account management and switching for Claude and Codex CLI subscription logins. | Per-run account isolation for concurrent jobs and Antigravity support. Existing switching changes the live CLI credential state, so it is not a per-job credential boundary. |
| Ego Lite | An open-source automation harness and skill for the separate macOS ego lite browser app, including agent task spaces. | An explicit app-to-E2E bridge that records evidence against tasks and runs and closes task spaces; Windows support needs separate validation later. |
| posco-mds theme reference | Semantic light/dark color tokens, Pretendard typography, a dashboard shell, quick actions, and document/page tabs. | Apply the general visual system to project tasks and agent runs without importing laboratory-specific screens, data, or behavior. |

## Product requirements to preserve

1. Open multiple code projects in one desktop workspace and give each project its own task board and conventions. The app must expose editable project files and agent-produced changes; Whiteboard's review mode does not currently promise that workflow.
2. Create, organize, and dispatch tasks to agents directly from the board, with an explicit target repository/worktree, visible progress, logs, cancellation, and durable run history.
3. Coordinate subagents under a parent task/run and retain each subagent's status, result, and produced artifacts.
4. Select Claude, Codex, or Antigravity and an account for each run; support concurrent runs without one run changing another run's credentials.
5. Import references from Slack, Notion, and websites, and allow installation of additional connectors. Preserve source identity, retrieval time, and the material used for a task.
6. Keep imported content as reference material unless the user explicitly makes it a task instruction or project convention.
7. Attach Whiteboard reviews and Ego Lite frontend E2E evidence to the originating task/run, including the tested target and task-space cleanup outcome.
8. Support project execution and tests through Docker where configured, with explicit ownership and teardown of containers started for a run, while delivering the macOS desktop experience first and Windows x86 afterward.
9. Follow the frontend layer direction `app → pages → widgets → features → entities → shared` for new UI code, with slice public APIs and no reverse or cross-slice imports.
10. Show a dashboard first. Keep project navigation and tabs understandable at a glance, with task state and the next useful action visible, and make editor/review detail available when needed.

The current Review source navigator is not the editable project surface required above: the Review tab service asks the native host to open a separate workspace window, while workspace creation sets `files.readonlyInclude` to all files by default. The workspace window loads a native Code OSS workbench, so it is a useful shell seam, but the selected editable project/dashboard/review tab flow still needs implementation and runtime verification. The current HTTP review-open command relays to the attached desktop control; project-aware review tab routing is additional work.

## Whiteboard review data boundary: verified facts

- The live Review API opens `DEV_REVIEW_HOME/review-api.db`. Startup runs the legacy JSON cutover first; remaining `reviews/<uuid>/review.json` directories are not a second runtime catalog. The desktop server mounts the authenticated Review API under `/reviews-api`.
- A normal new review gets a UUID from the review store; the scratchpad has a fixed ID. A create request may return an existing review for the same pull request, so integrations must save the returned `reviewId`, not assume every request created a new review. The catalog lists review IDs, and `POST /:id/open` opens a known review in Desktop.
- Review commands require a `commandId`. The store commits a receipt with each command and returns the same response for an identical retry. A separate workspace store can save the exact create command before calling the Review API, then retry the same command after a lost response. This is a design opportunity, not an implemented integration here.
- The current registered `repositoryId` is an ID stored against a unique local checkout path in the review profile. The older JSON `repoKey` was derived from a path hash. Neither is a suitable canonical project identity across machines or profiles; the project model needs its own stable ID and a mapping to the current review checkout.

## Decisions still open

- How project convention sources are selected, ordered, snapshotted, and shown to the user before an agent run.
- The connector package, permission, and credential contracts, including how logged-in website content is captured.
- The provider-specific account isolation mechanism, run recovery contract, Docker boundary, and Windows equivalents.
- Whether “Windows x86” means 32-bit x86 or x86-64. Whiteboard currently packages `win32-x64`; the target architecture must not assume that settles the user's requested platform.
- The exact project bootstrap and multi-project switching behavior within the selected native project-window design. The dashboard/editor/review tab integration and project-aware review-open routing still need implementation and runtime verification.
- Public distribution must retain applicable Whiteboard/Code OSS license and third-party notices.

## Evidence checked

- Whiteboard: `apps/review-desktop/code-oss/src/vs/review/electron-main/reviewDesktopHost.ts` supervises a utility process; `packages/review/src/server/desktop-server.ts` hosts the local service and mounts `/reviews-api`; `apps/review-desktop/code-oss/product.json` has `extensionsGallery: null`. `packages/review/src/review-api/profile.ts`, `store.ts`, `local-data.ts`, and `README.md` establish the SQLite profile, command receipts, current repository registration, and API routes. `packages/review/src/review-import/json-cutover.ts` handles legacy JSON import; `packages/review/src/repository-identity.ts` describes the older path-hash identity. `apps/review-desktop/code-oss/src/vs/code/electron-browser/workbench/workbench.ts` switches entries for workspace windows, `src/vs/review/navigator.desktop.main.ts` loads the native workbench, `src/vs/review/services/reviewCanvasEditorTabsService.ts` opens that workspace in a new window, and `packages/review/src/review-api/local-data.ts` gives the navigator workspace a read-only default. `src/vs/review/browser/parts/canvas/reviewCanvasEditor.contribution.ts` registers the review editor pane; `packages/review/src/review-api/http.ts` and `src/server/desktop-server.ts` show the current open route's desktop relay. Root `README.md` lists no file editing and limited multi-repo browsing; `apps/review-desktop/README.md` describes review-first Home, curated extensions, and platform packaging.
- Bugfixer: `src/jobs/runner.ts` tracks jobs in maps and offers `agy`/Claude engines; `src/conventions/load.ts`, `src/collect/collect.ts`, and `src/jobs/refreshJob.ts` show source-project-specific conventions and collectors.
- Mobius: `README.md` documents Claude/Codex support, live CLI credential writes during switching, and a Codex session reverting a switch when it refreshes its token.
- Ego Lite: `AGENTS.md` distinguishes the harness from the closed-source browser app; `README.md` documents macOS availability and agent spaces; `skills/ego-browser/SKILL.md` documents `taskSpace` and browser automation.
- posco-mds: `frontend/.impeccable.md` describes its design principles and semantic token hierarchy; `frontend/src/styles/app.css` and `dark.css` contain the current light/dark values; `frontend/src/components/DocumentTabStrip.tsx` and `frontend/src/pages/Dashboard.tsx` show tab and dashboard patterns.

The approved workspace/review ownership and first-slice proof are detailed in [architecture.md](architecture.md).
