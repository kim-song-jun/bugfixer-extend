# Source attribution and notice review

Reviewed on 2026-10-23. This records finite checks of committed source, public
upstream objects and notice metadata. It is not proof of the contents of a signed
release, a complete dependency-license inventory, or absence of every possible
private snippet or credential.

## Source pins and review scope

| Item | Verified object or count |
| --- | --- |
| Public Whiteboard commit | `4ecc5704cb19d1dc04304ae6956200227d483e27` |
| Public upstream tree, independently read through GitHub API | `300cc9004c2a5b6cf43386d551c8dcfa68705a22` |
| Local nested import commit | `c65db19361212d474c62ef3b75fda74f66028b2d` |
| Local imported `whiteboard/` tree | `300cc9004c2a5b6cf43386d551c8dcfa68705a22` |
| Reviewed source commit after the notice correction | `8119cb58be2b8a9bac65790434b354430bcd52b7` |
| Reviewed `whiteboard/` tree | `5de3cac05cb0a83a7e520ecd3a6ee63ae7dc70e7` |
| Imported / reviewed tracked paths under `whiteboard/` | 7,449 / 7,774 |
| Post-import path changes | 463: 325 added, 138 modified, none deleted |

The review boundary is `git diff --no-renames c65db193 8119cb5 -- whiteboard/`.
The [import record](upstream-base.md) contains the original complete path, blob
and executable-mode comparison. The public tree object still matches that local
import. The current fork intentionally differs from it. Its nested pnpm workspace,
manifests, build scripts and attribution files remain present; the outer README
and project documents remain separate.

## Retained source notices

These are Git blob IDs at the reviewed commit, not hashes of a packaged app.

| Source file | Git blob |
| --- | --- |
| `whiteboard/LICENSE` | `5a204b27e2a7baad236023db2939251474f3cdf1` |
| `whiteboard/apps/review-desktop/LICENSE` | `3bb75840234357caac7576398d88f8c5dfc0e185` |
| `whiteboard/apps/review-desktop/code-oss/LICENSE.txt` | `7d58428a01c2086c98b81e50e3ec49d89bee52ef` |
| `whiteboard/apps/review-desktop/code-oss/ThirdPartyNotices.txt` | `431e5c606e5e6e6828b09a749063129f7db6ba02` |
| `whiteboard/packages/review/LICENSE` | `5a204b27e2a7baad236023db2939251474f3cdf1` |
| `whiteboard/packages/review/THIRD_PARTY_NOTICES.md` | `ff643d373ee51a1d563cf4987a591ee7c6a51621` |

The Code OSS `licenses/` tree is
`47025496a90b5580903f060ca295da142863a9c4`. It retains the additional notices for
eventsource-parser, libavoid-js, zod, vscode-codicons, elkjs and katex.

### Public font attribution

The only path reported as binary by Git in the post-import delta is
`whiteboard/apps/review-desktop/code-oss/src/vs/review/browser/media/PretendardVariable.woff2`.
Its Git blob `49c54b5152a184a243e85f7281ed338b6569987e` and size 2,057,688 bytes
match the [official Pretendard v1.3.9 file](https://github.com/orioncactus/pretendard/blob/v1.3.9/packages/pretendard/dist/web/variable/woff2/PretendardVariable.woff2)
returned by GitHub's contents API. Its local SHA-256 is
`9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4`.

Code OSS notices name the same tag, source URL and SHA-256. The
[official license](https://github.com/orioncactus/pretendard/blob/v1.3.9/LICENSE)
is included there in full after whitespace normalization, including copyright
and reserved font names. The font and attribution entered together in `5d7a19e`.
The desktop entry points import `pretendard.css`, and Code OSS packaging includes
`ThirdPartyNotices.txt`. This establishes source attribution for this asset.

## Notice correction

The Review notice previously identified `lightningcss` 1.32.0 while the current
lockfile resolved 1.33.0. Commit `8119cb5` corrects that observed version and pins
its source and [MPL-2.0 license](https://github.com/parcel-bundler/lightningcss/blob/v1.33.0/LICENSE)
to the official `v1.33.0` tag. It changes no license text or runtime code.

All three explicitly observed versions in that notice now match the lockfile:

| Package | Notice and lockfile version |
| --- | --- |
| libavoid-js | `0.5.0-beta.5` |
| elkjs | `0.11.1` |
| lightningcss | `1.33.0` |

`stage-review-runtime.mjs` deploys the production Review runtime and copies the
static notice. Release validation checks required legal files are present and
nonempty; it does not prove that every resolved dependency has a current notice.
The general instruction to refresh the full inventory before distribution still
applies. The last native CI predates this metadata correction and is not evidence
that a newly packaged app contains it.

## Finite private-material and credential-pattern checks

- The post-import source scan at `b9eee8f` covered 462 paths. It found no
  case-insensitive `molcube` or `posco-mds` matches and no import/require specifier
  containing those names or `bugfixer`. The additional path reviewed at `8119cb5`
  is the public dependency notice correction above.
- `bugfixer` occurrences are intended product, theme and test references. The
  candidate in `agentPublicationGithub.ts` is the public `Bugfixer-Extend`
  User-Agent, not a credential.
- The two case-insensitive `/Users/` candidates in added connector tests are
  `/v1/users/me` HTTP paths, not filesystem home paths. The targeted exact private
  home/project markers had no matches in the fork scope.
- A finite scan of the 463 changed paths found AWS-ID patterns in one test file,
  Slack-token patterns in two, GitHub-token patterns in four, and private-key
  headers in one. Every matched input is an explicit synthetic redaction,
  connector-transport or publication fixture. No credential value is reproduced
  here. Boundary-qualified OpenAI and Notion token-prefix patterns had no matches.
- The same selected credential patterns found no candidates in the 19 tracked
  outer files at `8119cb5`. Untracked local files, application profiles, Keychain,
  credentials and Git author metadata were not inspected or changed.

These checks identify no private product import or production credential for the
specified names and patterns. They are not an exhaustive secret-format scan or
proof of account validity. No provider authentication, account request or project
runtime was executed.

## Remaining acceptance

The source pin, retained notice files, public font identity and the three observed
dependency versions have evidence above. Signed release contents, the complete
resolved dependency notice inventory, all distributed extension/runtime notices
and release rights review remain unverified. Product acceptance row 1 and the
overall implementation goal remain open.
