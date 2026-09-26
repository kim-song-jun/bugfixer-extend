# Declarative connector package format

Status: **candidate contract for review**, not an approved schema or implemented feature. The user selected declarative installed connectors for the first public release. The chosen execution boundary is in [connector-runtime.md](connector-runtime.md#selected-a-contract-and-release-proof); the shared reference model is in [architecture.md](architecture.md#imported-reference-and-connector-contract).

## Purpose and proposed v1 surface

An installed connector describes how trusted app code reads one JSON REST source over HTTPS and maps a selected item into an immutable reference snapshot. Package data is never executed. The proposed install artifact is one UTF-8 JSON document, with no archive entries, scripts, styles, or assets. The extension, maximum sizes, and distribution channel remain open product details.

The candidate v1 supports `none` and app-managed `bearer-token` authentication. `none` creates an app-owned anonymous source-account reference. For `bearer-token`, the user creates a connector connection in the app; its secret stays in the OS credential store and the app stores an opaque credential reference. The package never contains a token or OAuth client secret. A bearer token's actual upstream permissions are **not** verified by a generic connector. Requested scope strings are package claims shown as such, and the broker enforces the user's app grant and connection binding. First-party providers can have stronger, provider-specific scope evidence.

The example describes a bearer-token issue source. The app inserts the token; no credential appears in the package:

```json
{
  "formatVersion": 1,
  "connectorApiVersion": 1,
  "id": "org.example.issues",
  "version": "1.0.0",
  "name": "Example Issues",
  "hosts": ["api.example.org"],
  "auth": {
    "kind": "bearer-token",
    "requestedScopes": ["issues:read"]
  },
  "source": {
    "kind": "json-rest",
    "type": "issue",
    "list": {
      "host": "api.example.org",
      "path": "/v1/issues",
      "requiredScope": "issues:read",
      "items": "/items",
      "itemId": "/id",
      "itemTitle": "/title",
      "nextCursor": "/next_cursor",
      "cursorQueryParam": "cursor"
    },
    "detail": {
      "host": "api.example.org",
      "path": "/v1/issues/{id}",
      "requiredScope": "issues:read",
      "fields": {
        "id": "/id",
        "title": "/title",
        "body": "/description",
        "url": "/html_url",
        "updatedAt": "/updated_at"
      }
    }
  }
}
```

`formatVersion` selects the package grammar; `connectorApiVersion` selects the app's discover/preview/import/refresh contract. Unsupported versions fail installation. One v1 package declares one source `type`, so the install screen can name exactly what it imports. A later multi-type package needs another reviewed format. The example is illustrative; it is not yet a published JSON Schema.

`items` and `nextCursor` are [RFC 6901 JSON Pointers](https://www.rfc-editor.org/rfc/rfc6901) evaluated against the **list response root**. `itemId` and `itemTitle` are evaluated against each object in that items array. `detail.fields` pointers are evaluated against the **detail response root**. Required `id` and `title` values are nonempty bounded strings; `body` is a string; `url` is an optional HTTP(S) display link; `updatedAt` is an optional timestamp. The app rejects missing or wrong-typed required values rather than coercing them. External IDs are case-sensitive strings compared exactly; neither case folding nor trimming changes their identity. Pointers select data only: no JavaScript, JSONPath filters, regular expressions, or package-supplied functions.

Each `list` and `detail` endpoint names its host. In v1, `hosts` contains exactly one host and both endpoints must name it; a multi-host flow needs another reviewed format. Only `{id}` is accepted in a detail path; the app percent-encodes that one path segment. The app adds a cursor only through the fixed `cursorQueryParam` on the declared list endpoint. A response value cannot replace the origin, path template, or query key. `requiredScope` must appear in `auth.requestedScopes` and in the user's grant for the bound connection. With `auth.kind: "none"`, `requestedScopes` is empty and endpoints omit `requiredScope`; the broker still binds requests to that package's anonymous source-account reference.

This first format covers straightforward JSON REST APIs. First-party Slack, Notion, and website importers can use source-specific trusted code behind the same reference contract. Sources needing custom OAuth code, browser cookies, file access, POST requests, JavaScript rendering, or custom pagination are visibly unsupported. Installation never moves such a package into the Code OSS extension host or an executable connector runtime.

## Install, connection, and consent

1. The user selects a package file. Before storing it, the app parses bounded JSON and validates both version fields, ID, version, exact allowed keys, value types, nesting, endpoint hosts, paths, pointer syntax, source type, credential mode, and scope references. Unknown keys and code-bearing fields are errors, not ignored extensions.
2. The install review shows the package name, content hash, one source type, exact hosts, credential mode, and package-declared scope labels. The app records a grant against that exact package hash and version, then copies the validated bytes into app-owned storage.
3. For `bearer-token`, the user selects or creates an app connection. The connection has a stable app-owned `sourceAccountRef` and an opaque OS credential reference; it is bound to the connector ID, approved package hash, permitted host, and granted scope labels. The user enters the token in the connection flow, never in package JSON. The UI does not imply that the provider confirmed the package's scope labels. An anonymous package also receives a stable app-owned `sourceAccountRef` for its installed lifetime.
4. The broker accepts a request only when its connector hash, endpoint, `sourceAccountRef`, auth mode, host, and required scope match a live grant. It inserts a bearer token only for the connection's approved endpoint host. It never accepts an arbitrary account ID or token from package data or a source response.
5. A changed package hash, host, credential mode, or requested scope requires a new review and grant. A compatible update may retain the app connection and source-account reference **only after** the new grant. Existing snapshots keep the producing connector ID, version, and hash. Disabling or revoking a connection stops discovery and refresh; removing a package does not delete snapshots already cited by tasks, conventions, or runs.

A package declaration is a request for app consent, not proof of upstream token scope. The app can enforce which token it uses and which GET endpoint it calls; it cannot infer what other permissions the token has at the provider.

## Trusted request and pagination interpreter

The interpreter makes bounded `GET` requests to the exact endpoint HTTPS host and fixed path template. It owns URL construction, credential insertion, timeouts, response size/depth limits, pagination budgets, and retry policy. Package data cannot specify another HTTP method, arbitrary header, port, IP address, full URL, redirect destination, or additional host discovered from a response. Any additional method or transport would require a later reviewed format version.

The network broker validates the origin and resolved destination for each request and redirect, and prevents a credential from following an unapproved redirect. Redirects cannot take a bearer credential to another host. The proposed first public format excludes loopback, link-local, and private destinations, including DNS answers and redirected destinations. A future internal-network mode would require a separate user grant and socket-level validation. [OWASP's SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) documents redirect and DNS-rebinding risks. The exact packaged-fork network API and DNS binding proof remain implementation gates.

The first list request has no cursor parameter. On every complete list response, `items` must resolve to an array of objects. `nextCursor` may be absent or `null` to finish, or a nonempty string to continue. Empty, non-string, or repeated cursors are errors; the interpreter never retries a cursor it has seen. It preserves first-seen item order and ignores a repeated external ID after flagging that duplication in the discovery result. Page, byte, time, and rate-limit budgets stop pagination with a visible **partial discovery** result and continuation cursor when one is valid. Invalid or cycling cursors produce a visible error and no continuation. A 429 honors `Retry-After` within a bounded retry policy; exhaustion is visible.

Discover shows bounded list entries with their IDs and titles; list response bodies are temporary discovery material, **not** a selected source's immutable artifact. Preview fetches the selected detail endpoint, maps the detail fields, and shows its source link and exact account. The detail `id` must equal the selected list ID. The app holds the bounded, complete detail response body and its identity in a short-lived preview record. Import commits **those same preview bytes**, not a silent refetch; if the preview is lost or stale, the user previews again. An item from a partial discovery can be imported only after a complete, valid detail preview. Incomplete or malformed detail responses cannot be attached as snapshots.

The stable source key is `(connector ID, sourceAccountRef, source type, external ID)`. Refresh resolves an existing snapshot by that key, uses its stored external ID in the declared detail path, binds the original source account, and requires the returned detail ID and connector-declared source type to match the stored key. It never substitutes an account chosen from response data or links a changed ID to the old source. A package update that changes what its external IDs mean must use a new connector ID. If the old connection is revoked, refresh is unavailable until an explicitly reauthorized connection preserves that account reference.

For each successful import or refresh, the immutable original artifact is the **exact complete detail response body bytes delivered by the HTTP stack after transport decoding and before JSON parsing**. The snapshot stores that artifact's SHA-256 hash, content type, retrieval time, connector ID/version/hash, source key, and a link to the previous snapshot when refreshing. List pages, mapped fields, extracted text, and summaries do not replace the raw detail artifact; mapped fields and text are separately derived with provenance. A successful refresh creates a new snapshot and retrieval event even when its raw-body hash is unchanged. Partial discovery and failed detail fetches produce visible events but no new source snapshot. A returned `url` is display data, validated before opening, and is never an automatic fetch target.

## Required implementation proof

- A real installed sample connector discovers two items, previews one, imports its exact preview bytes, and refreshes the same source key into a second immutable snapshot. Old task evidence still opens the original artifact after refresh or package removal; a second connection with the same external ID stays separate.
- Installation rejects unknown and executable fields, malformed pointers/paths, unsupported versions/auth modes, bad scope references, oversized/deep JSON, and changed package bytes without new consent. No package bytes execute.
- A controlled endpoint proves that undeclared hosts, redirects to another host, loopback/private destinations, non-HTTPS schemes, cross-account requests, and credential forwarding outside a live grant fail before reaching a destination. DNS changes between validation and connection are included in the network proof.
- Two-page discovery preserves order and first-seen identity. An empty, wrong-typed, or cycling cursor yields a visible error; a budget limit yields a visibly partial discovery. A selected item can become a snapshot only after a complete detail response. Rate limits follow bounded `Retry-After` behavior.
- The app never serializes its managed credential into a package, request log, `workspace.db`, or snapshot metadata. A controlled endpoint that echoes the injected token must be rejected before the raw body is stored. Arbitrary upstream content may itself be sensitive; the app cannot promise that every source body is secret-free. Installation, revocation, restart, and backup/restore preserve connector, connection, and snapshot links.

The exact schema limits, distribution channel, credential UX, and internal-network exception policy still need product review before this candidate becomes the written spec. The first-party Notion authorization route has its [own pending decision](reference-import-research.md#notion-first-party-import-and-authorization-seam); it does not determine generic installed-package authentication.
