# Discovery: unified agent workspace

Status: source inventory and user decisions as of 2026-09-26. This document records what exists and what the new product needs; it does not describe implemented features in this repository.

## Confirmed direction

- Use the Whiteboard/Code OSS desktop shell and its review capability as the foundation. Build generic project, task, and agent workflow features inside it using Bugfixer's concepts. Do not copy files, operational data, or credentials from the private Bugfixer repository.
- Use posco-mds as the visual theme reference: a simple project dashboard, clear tabs and navigation, restrained accents, and first-class light and dark modes. Reuse the visual principles and suitable generic interaction patterns, not laboratory-specific product content.
- Build for macOS first and support Windows x86 in a later phase. Keep Docker-based project execution and test environments in scope for portability; the exact desktop/container boundary remains to be designed.
- Allow conventions to be supplied per project and attached to agent work.
- Provide Slack, Notion, and website import as first-party connectors plus a contract for user-installable connectors. This is the user's selected option B; it does not imply enabling all general VS Code extensions.
- Bring Claude, Codex, and Antigravity account use, subagent orchestration, and Ego Lite frontend E2E into one task flow.

## Source capabilities and gaps

| Source | Present in the source product | Work required for this product |
| --- | --- | --- |
| Whiteboard | Code OSS desktop workbench, review views, and an app-supervised local review service. Its Home opens without a repository and its packaged macOS release channel is arm64. The public README says the review product cannot edit files, while the fork also contains a native workspace-window navigator path. | Verify editing in the actual workspace mode, then design project navigation, multi-repository work, a task board, agent-run lifecycle, connector API, and installation path for task-data connectors. Its `product.json` currently sets `extensionsGallery` to `null`. Windows `win32-x64` installers exist but have no update feed; that does not establish the new product's Windows support. |
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

## Decisions still open

- The exact ownership and placement of project/task data relative to Whiteboard review data. A separate workspace database with ID references was proposed and awaits confirmation.
- How project convention sources are selected, ordered, snapshotted, and shown to the user before an agent run.
- The connector package, permission, and credential contracts, including how logged-in website content is captured.
- The provider-specific account isolation mechanism, run recovery contract, Docker boundary, and Windows equivalents.
- Whether “Windows x86” means 32-bit x86 or x86-64. Whiteboard currently packages `win32-x64`; the target architecture must not assume that settles the user's requested platform.
- How editing, agent change review, and project switching will work in Whiteboard's currently review-first, single-window app. Verify the fork's workspace-window path before treating it as a finished editing surface.
- Public distribution must retain applicable Whiteboard/Code OSS license and third-party notices.

## Evidence checked

- Whiteboard: `apps/review-desktop/code-oss/src/vs/review/electron-main/reviewDesktopHost.ts` supervises a utility process; `packages/review/src/server/desktop-server.ts` hosts the local service; `apps/review-desktop/code-oss/product.json` has `extensionsGallery: null`. Root `README.md` lists no file editing and limited multi-repo browsing; `apps/review-desktop/README.md` describes review-first Home, curated extensions, and platform packaging. `apps/review-desktop/UPSTREAM` records the workspace-window navigator entry.
- Bugfixer: `src/jobs/runner.ts` tracks jobs in maps and offers `agy`/Claude engines; `src/conventions/load.ts`, `src/collect/collect.ts`, and `src/jobs/refreshJob.ts` show source-project-specific conventions and collectors.
- Mobius: `README.md` documents Claude/Codex support, live CLI credential writes during switching, and a Codex session reverting a switch when it refreshes its token.
- Ego Lite: `AGENTS.md` distinguishes the harness from the closed-source browser app; `README.md` documents macOS availability and agent spaces; `skills/ego-browser/SKILL.md` documents `taskSpace` and browser automation.
- posco-mds: `frontend/.impeccable.md` describes its design principles and semantic token hierarchy; `frontend/src/styles/app.css` and `dark.css` contain the current light/dark values; `frontend/src/components/DocumentTabStrip.tsx` and `frontend/src/pages/Dashboard.tsx` show tab and dashboard patterns.
