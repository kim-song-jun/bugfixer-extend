# Curated extension distribution inventory

Status: pinned-source and package evidence as of 2026-09-26. This is a release-preparation inventory, not a claim that Bugfixer Extend has imported, packaged, or cleared these extensions for distribution.

## Actual upstream boundary

Whiteboard's [pinned manifest](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/scripts/curated-extensions.manifest.mjs) lists 11 checksum-pinned Open VSX packages. Its [default group selection](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/scripts/curated-extensions.manifest.mjs#L383-L407) and [macOS packaging command](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/scripts/package-macos.sh#L71-L74) stage five curated bundled packages; six are optional after user consent. Code OSS also [packages its built-in extensions](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/code-oss/build/lib/extensions.ts#L416-L439), which are outside this curated Open VSX inventory. The [product configuration](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/code-oss/product.json#L182) has no extension marketplace. The source build downloads VSIX files; it does not commit their binaries to Git.

On macOS arm64, all five downloaded bundled VSIX files matched the manifest's SHA-256 on 2026-09-26. Each contained a root extension license file. These checks establish exact package identity and license-file presence, not complete third-party notice coverage or final packaged-app contents. The temporary VSIX files were deleted after inspection.

## Five release-bundled packages

| Exact Open VSX package | Declared package license and observed payload | Release check still required |
| --- | --- | --- |
| [Vim 1.32.4](https://open-vsx.org/api/vscodevim/vim/1.32.4) | MIT; root `LICENSE.txt` plus bundled JavaScript license files. [Publisher source](https://github.com/VSCodeVim/Vim). | Preserve the MIT notice and bundled file notices in the staged app. |
| [Emacs MCX 0.111.1](https://open-vsx.org/api/tuttieee/emacs-mcx/0.111.1) | MIT; root `LICENSE.txt`. [Publisher source](https://github.com/whitphx/vscode-emacs-mcx). | Preserve its license and copyright in the staged app. |
| [Python 2026.4.0](https://open-vsx.org/api/ms-python/python/2026.4.0) | MIT; root `LICENSE.txt`, `ThirdPartyNotices-Repository.txt`, and multiple bundled-library license files. Its original VSIX declares an `extensionPack`; Whiteboard's [sanitizer](https://github.com/devdotfast/whiteboard/blob/4ecc5704cb19d1dc04304ae6956200227d483e27/apps/review-desktop/scripts/curated-extensions.mjs#L243-L260) removes that field because the pack references extensions it does not ship. [Publisher source](https://github.com/microsoft/vscode-python). | Preserve the third-party notice and inventory all embedded library notices, verify the staged manifest has no `extensionPack`, and verify proprietary Pylance is absent. `ty` and `ruff` declare this extension as a dependency, so removing Python changes the bundle contract. |
| [ty 2026.64.0, darwin-arm64](https://open-vsx.org/api/astral-sh/ty/darwin-arm64/2026.64.0) | MIT; root `LICENSE.txt`, bundled `ty` executable and its license. [Publisher source](https://github.com/astral-sh/ty-vscode). | Preserve notices for the executable and embedded libraries. |
| [Ruff 2026.66.0, darwin-arm64](https://open-vsx.org/api/charliermarsh/ruff/darwin-arm64/2026.66.0) | MIT package declaration; root `LICENSE.txt`, bundled Ruff executable, and library license files that include BSD and Apache texts. [Publisher source](https://github.com/astral-sh/ruff-vscode). | Preserve the full embedded notice set and check the staged executable/license closure. |

## Six consent-installed packages

These packages are not in the default macOS bundle. Consent to download does not replace package attribution or review of tools installed later.

| Exact Open VSX package | Package evidence | Release check if offered |
| --- | --- | --- |
| [rust-analyzer 0.4.2990, darwin-arm64](https://open-vsx.org/api/rust-lang/rust-analyzer/darwin-arm64/0.4.2990) | MIT OR Apache-2.0; [publisher source](https://github.com/rust-lang/rust-analyzer). | Retain the selected license terms, copyright, and applicable Apache notices. |
| [Swift 2.17.20260702](https://open-vsx.org/api/swiftlang/swift-vscode/2.17.20260702) | API license field is empty; the exact VSIX license identifies Apache-2.0 and [publisher source](https://github.com/swiftlang/vscode-swift) includes a NOTICE file. | Inspect and carry the exact VSIX license, NOTICE, and bundled third-party notices. |
| [LLDB DAP 0.7.20260804](https://open-vsx.org/api/llvm-vs-code-extensions/lldb-dap/0.7.20260804) | Package declares Apache 2.0 with LLVM exceptions; [publisher source](https://github.com/llvm/llvm-project). | Carry the exception text and applicable license/notice files. |
| [C# 2.145.21-g154a82fd27, darwin-arm64](https://open-vsx.org/api/muhammad-sammy/csharp/darwin-arm64/2.145.21-g154a82fd27) | Its package points to `RuntimeLicenses/license.txt`; it is a [maintainer fork](https://github.com/muhammadsammy/free-vscode-csharp) with embedded OmniSharp/NetCoreDbg components. The upstream Microsoft C# source license alone does not cover this exact VSIX. | Audit every bundled component and the full runtime-license file before enabling distribution. |
| [.NET runtime support 3.1.0](https://open-vsx.org/api/ms-dotnettools/vscode-dotnet-runtime/3.1.0) | MIT extension; [publisher source](https://github.com/dotnet/vscode-dotnet-runtime). | Preserve its license and third-party notices. Any .NET runtime fetched later is a separate payload to assess. |
| [Go 0.56.0](https://open-vsx.org/api/golang/Go/0.56.0) | MIT extension; [publisher source](https://github.com/golang/vscode-go). | Its activation can run `go install` for language tools against the user's Go toolchain. Show that follow-on installation in consent and assess those tools separately. |

## Distribution proof before release

1. Re-fetch the exact pinned VSIX files, verify the manifest hashes, and inventory license/notice files plus bundled executables and libraries from the bytes actually staged in the Bugfixer Extend macOS package. Preserve required files in that package and publish an app-level notice index.
2. Inspect the final packaged extension manifests: exactly the five curated bundled IDs, no curated optional ID or payload before consent, Python's pack reference removed, and no Pylance binary. Inventory the separately packaged Code OSS built-in extensions and their notices. Exercise optional install/revoke from a disposable profile with visible consent and source attribution.
3. Audit later downloads separately, including any .NET runtime and Go language tools. Do not treat an extension's MIT field or this inventory as proof of the terms of every binary it can fetch.

The original Whiteboard development build and launch proof is in [upstream-base.md](upstream-base.md#isolated-upstream-macos-baseline-rehearsal). No Bugfixer Extend packaged build or staged-extension notice check exists yet.
