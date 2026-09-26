# Whiteboard source boundary

Status: source inventory for the selected desktop foundation. No Whiteboard code has been imported into this repository yet.

## Pinned source and notices

- Public source: [`devdotfast/whiteboard` at `4ecc5704cb19d1dc04304ae6956200227d483e27`](https://github.com/devdotfast/whiteboard/tree/4ecc5704cb19d1dc04304ae6956200227d483e27). The local source checkout was clean when inspected on 2026-09-26.
- The [root license](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/LICENSE) and [desktop license](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/LICENSE) are MIT. The desktop license identifies its embedded Code OSS fork and points to `apps/review-desktop/code-oss/LICENSE.txt` and `ThirdPartyNotices.txt`; additional fork notices are in `code-oss/licenses/`. The packaged Review runtime also requires `packages/review/THIRD_PARTY_NOTICES.md`. An imported source snapshot and packaged app must retain the applicable notices and preserve the Whiteboard copyright attribution.
- [`apps/review-desktop/UPSTREAM`](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/UPSTREAM) records the Code OSS upstream pin and fork changes. Bugfixer Extend needs its own source pin and change record alongside this existing history.

## Import integrity baseline

At the pinned commit, the source tree object is `300cc9004c2a5b6cf43386d551c8dcfa68705a22`. It has 7,449 tracked blobs: 7,409 regular files (`100644`) and 40 executable files (`100755`), with no tracked symlink or submodule. The tracked blob payload is 108,912,698 bytes (about 104 MiB); the local checkout occupies about 176 MB including roughly 55 MB of `.git` data. These are source-snapshot measurements, not an estimate of installed dependencies or a packaged app.

For a direct source import, preserve every tracked relative path, file content, and executable bit while excluding the source `.git` directory and local build products. Compare the imported tree against the pinned `git ls-tree` entries, not just the file count, and review tracked contents for credentials or private project material before the first public push. At the current Bugfixer Extend root, the only direct tracked-path collision is `README.md`; merging at the root would still require reconciling workspace and build behavior, while a nested import keeps the source's root contract together. The import layout is awaiting the user's choice.

A targeted pre-import scan of all 7,449 tracked files on 2026-09-26 found no case-insensitive `molcube`, `bugfixer`, or `posco-mds` content matches. Probes for common AWS, GitHub, Slack, OpenAI, and Notion key formats and private-key headers flagged only a GitHub-token-shaped value used by error-redaction tests and an OpenSSH key-header regex in the agent-host parser; both were reviewed in context. This finite pattern scan is not a complete credentials audit. Repeat content screening and review findings against the exact imported tree before a public push.

## Buildable source boundary

`apps/review-desktop/code-oss/` is a tracked fork, about 100 MB in the local checkout. Its review UI also depends on the surrounding pnpm workspace. The desktop's `scripts/run.sh` requires the built Review server at `packages/review/dist/server/desktop-host.js`; copying the Code OSS folder alone would leave that runtime missing.

Following the desktop package manifests and root pnpm workspace overrides yields this local package closure at the inspected commit. The root override resolves `@dev.fast/local-vcs` to the workspace package even though Review declares a registry range:

| Package | Source path |
| --- | --- |
| `@dev.fast/review-desktop` | `apps/review-desktop` |
| `@dev.fast/review` | `packages/review` |
| `@dev.fast/review-canvas` | `packages/review/app` |
| `@dev.fast/review-protocol` | `packages/review-protocol` |
| `@dev.fast/review-share-protocol` | `packages/review-share-protocol` |
| `@dev.fast/trace-core` | `packages/trace-core` |
| `@dev.fast/trace-protocol` | `packages/trace-protocol` |
| `@dev.fast/local-vcs` | `packages/local-vcs` |
| `@dev.fast/json` | `packages/json` |

Root `package.json`, `pnpm-workspace.yaml`, the lockfile, build scripts, and referenced resources are also needed. The root declares Node `>=24 <25` and pnpm `>=11 <12`; its `.nvmrc` is `24`, while the Code OSS fork pins Node `24.18.0` in its own `.nvmrc`. Desktop build scripts switch to the fork's exact Node version with `fnm` or `nvm` and run a separate `npm ci` against the fork lockfile. The documented macOS prerequisites include Python 3 and a C/C++ toolchain. A source snapshot is not a built app: scripts also obtain pinned extension VSIX files, Electron, and runtime binaries such as `diffr`. The closure above follows manifests; build and packaging scripts consume further tracked files and downloaded artifacts, so a source import needs a build and launch check against the committed tree.

## Isolated upstream macOS baseline rehearsal

On 2026-09-26, a disposable `git archive` of the pinned commit built and launched on macOS arm64 outside the Bugfixer Extend repository. Root Node `24.15.0` and pnpm `11.1.2` ran `pnpm install --frozen-lockfile --prefer-offline --child-concurrency=1` successfully. The desktop script installed its Code OSS pin, Node `24.18.0`, and `pnpm desktop:build` exited successfully. The resulting development tree contained an executable `Whiteboard.app`, `code-oss/out/main.js`, `packages/review/dist/server/desktop-host.js`, and the Review CLI.

An initial development launch failed before server startup because the temporary user-data path made Code OSS's IPC socket path 126 bytes long, above its 103-character warning threshold. With a short temporary state path, the same built app launched and `/health` returned HTTP 200 with `ok: true` and `desktopAttached: true`. The final isolated launch also set `DEV_REVIEW_IMPORT_FROM=none` and `DEV_FAST_REVIEW_SHARED_DATA_DIR` to a temporary directory so it neither imported the user's VS Code settings nor selected the default shared storage path. The app and its child processes exited after `TERM`, and its Review port closed. These environment controls should be retained in later disposable-profile checks; raw run logs include an ephemeral server token and must not be committed.

This rehearsal proves only the unmodified upstream development build and launch. It does not prove a build from Bugfixer Extend's future imported commit, a packaged app, or any new project-mode behavior.

## First-slice source seams

The selected first slice puts an editable project, dashboard, task board, and task-linked Review tabs in one native window. These are the concrete seams in the pinned source; they are implementation targets, not changes already made:

| Seam | Current behavior | Required integration |
| --- | --- | --- |
| [Workbench entry selection](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/code-oss/src/vs/code/electron-browser/workbench/workbench.ts#L398-L415) | Any workspace loads `navigator.desktop.main`; an empty window loads `review.desktop.main`. | Select the editable project mode explicitly and load its dashboard and Review contributions without turning historical source navigator windows into project windows. |
| [Navigator entry](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/code-oss/src/vs/review/navigator.desktop.main.ts) and [Review contribution bootstrap](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/code-oss/src/vs/review/review.common.main.ts) | The navigator has native editor/workspace services; the Review entry registers canvas services and Review-specific shell behavior. | Compose or split contributions by window mode so project files remain editable while Review tabs work in that same workbench. |
| [Canvas startup](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/code-oss/src/vs/review/browser/parts/canvas/reviewCanvasEditor.contribution.ts#L74-L95) | Restoring the Review canvas opens Home and initializes its desktop connection/catalog. | Gate that startup by mode; the project dashboard owns the initial tab, and Review initialization must not replace or close project tabs. |
| [Review tab service](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/code-oss/src/vs/review/services/reviewCanvasEditorTabsService.ts#L76-L106) and [serializer](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/code-oss/src/vs/review/browser/parts/canvas/reviewApiEditorSerializer.ts) | API reviews already open as native editor inputs keyed by `api:<reviewId>`; source navigation opens a separate read-only workspace window. | Reuse the review editor for the task's stored `reviewId` in the active project window. Give dashboard/task tabs their own editor identity and persistence contract; keep historical source navigation separate. |
| [Repository registration](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/packages/review/src/review-api/http.ts#L693-L699), [create validation](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/packages/review/src/review-api/store.ts#L1012-L1045), and [worktree target](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/packages/review/src/review-api/document.ts#L111-L125) | A normal review needs a target, legacy pins, or a PR URL; a title alone is rejected. A worktree target uses a registered `repositoryId`. | Register the task checkout, persist the returned profile-local ID, and create the task review against `{kind:"worktree",repositoryId}` with `open:false` before opening its tab in the right project window. |
| [Review API open route](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/packages/review/src/review-api/http.ts#L502-L558) | `/:id/open` delegates to the connected desktop without a project target in its route. | Route an app task's review to its owning project window and report when that window or review is unavailable. |
| [Read-only navigator workspace](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/packages/review/src/review-api/local-data.ts#L388-L420) | Generated source workspaces default `files.readonlyInclude` to `**/*`. | Preserve this Review source behavior while allowing normal edits in an explicitly opened project checkout. |

The app-owned `workspace.db` and typed main-process API described in [architecture.md](architecture.md#selected-data-boundary-app-owned-workspace-database) do not exist in this upstream snapshot. They must be added as project-mode services rather than written into Whiteboard's Review store.

## Integration checks

1. Bring the public Whiteboard source as a pinned, attributable desktop base with its workspace paths and notices intact. Keep the existing Bugfixer Extend discovery and architecture decisions visible. Do not import private Bugfixer files, rules, data, or credentials.
2. Prove the imported baseline can build and launch the existing Review desktop before adding the new project window. Record the exact source pin, toolchain versions, fetched artifact versions/checksums, and files changed from it. A local check against uncommitted files does not prove the pushed commit builds.
3. Add the editable project mode and dashboard through explicit workbench entry and service seams. Preserve Whiteboard's read-only Review source navigator. Confirm the editor, dashboard, and review canvas use the same native project window.
4. Reassess the [fork's security-backport applicability notes](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/UPSTREAM) before enabling any Code OSS chat, browser, extension, or agent path that Review currently leaves inert. In particular, three agent-network-filter fixes were deliberately omitted because their enforcement paths are inactive in Review; if the new app enables agent network requests through those paths, resync that module from its patched upstream and verify the relevant denial behavior first.
5. Before distributing a renamed product, audit licenses/notices of the bundled Open VSX extensions and replace Whiteboard's product identity, bundle IDs, URL protocol, data folder, and `update.dev.fast` endpoint. The imported MIT source status does not establish rights for every downloaded VSIX or make the inherited update configuration suitable for Bugfixer Extend.

This inventory establishes what must travel together. It does not claim the new product builds or that a copied source tree is already present.
