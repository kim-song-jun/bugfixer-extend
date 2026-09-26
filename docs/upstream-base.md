# Whiteboard source boundary

Status: source inventory for the selected desktop foundation. No Whiteboard code has been imported into this repository yet.

## Pinned source and notices

- Public source: [`devdotfast/whiteboard` at `4ecc5704cb19d1dc04304ae6956200227d483e27`](https://github.com/devdotfast/whiteboard/tree/4ecc5704cb19d1dc04304ae6956200227d483e27). The local source checkout was clean when inspected on 2026-09-26.
- The [root license](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/LICENSE) and [desktop license](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/LICENSE) are MIT. The desktop license identifies its embedded Code OSS fork and points to `apps/review-desktop/code-oss/LICENSE.txt` and `ThirdPartyNotices.txt`; additional fork notices are in `code-oss/licenses/`. The packaged Review runtime also requires `packages/review/THIRD_PARTY_NOTICES.md`. An imported source snapshot and packaged app must retain the applicable notices and preserve the Whiteboard copyright attribution.
- [`apps/review-desktop/UPSTREAM`](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/UPSTREAM) records the Code OSS upstream pin and fork changes. Bugfixer Extend needs its own source pin and change record alongside this existing history.

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

## Integration checks

1. Bring the public Whiteboard source as a pinned, attributable desktop base with its workspace paths and notices intact. Keep the existing Bugfixer Extend discovery and architecture decisions visible. Do not import private Bugfixer files, rules, data, or credentials.
2. Prove the imported baseline can build and launch the existing Review desktop before adding the new project window. Record the exact source pin, toolchain versions, fetched artifact versions/checksums, and files changed from it. A local check against uncommitted files does not prove the pushed commit builds.
3. Add the editable project mode and dashboard through explicit workbench entry and service seams. Preserve Whiteboard's read-only Review source navigator. Confirm the editor, dashboard, and review canvas use the same native project window.
4. Reassess the [fork's security-backport applicability notes](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/UPSTREAM) before enabling any Code OSS chat, browser, extension, or agent path that Review currently leaves inert. In particular, three agent-network-filter fixes were deliberately omitted because their enforcement paths are inactive in Review; if the new app enables agent network requests through those paths, resync that module from its patched upstream and verify the relevant denial behavior first.
5. Before distributing a renamed product, audit licenses/notices of the bundled Open VSX extensions and replace Whiteboard's product identity, bundle IDs, URL protocol, data folder, and `update.dev.fast` endpoint. The imported MIT source status does not establish rights for every downloaded VSIX or make the inherited update configuration suitable for Bugfixer Extend.

This inventory establishes what must travel together. It does not claim the new product builds or that a copied source tree is already present.
