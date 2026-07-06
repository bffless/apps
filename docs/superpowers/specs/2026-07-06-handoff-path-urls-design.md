# Handoff — GitHub-style path URLs (/tree, /blob)

- **Date:** 2026-07-06
- **App:** `repos/apps/apps/handoff`, backed by the live `handoff` BFFless proxy rule set (`5d59f6d8-f492-4e18-9edc-6a9d96677b44`, project `c3b71936-c5f0-4d20-bd3c-d5887289f9d0`)
- **Depends on:** structural content storage (#155, merged) and PR #177 (URL-decode + key-mode serve fix — this branch is based on it)
- **Status:** design approved (owner signed off 2026-07-06); ready for implementation plan

## Problem

Handoff's browse/view URLs are UUID-based — `/folder/a2b92d7d-…` and
`/view/45134f5b-…`. They are opaque, unreadable, and say nothing about where in
the Folder tree the content lives. Since #155, the bucket mirrors the logical
Folder tree and every File's storage sub-path *is* its human path
(`Test/Screenshot 2026-07-05 at 2.07.28 PM.png`), so the app's own URLs are now
the only place UUIDs still leak into the user experience.

GitHub solved this shape of problem with `/tree/<path>` (directory listing) and
`/blob/<path>` (file view). Handoff adopts the same scheme.

## Goals

- Browse a Folder at `/tree/<folder path>` and view a File or Site at
  `/blob/<file path>` — the URL path segments are exactly the node names
  (percent-encoded per segment), byte-identical to the storage sub-path.
- Deep links resolve for **every** viewer class the app supports: owner, admin,
  grantee (including a grant on a *nested* folder), and share-link visitor.
- Old `/folder/:id` and `/view/:id` links keep working (redirect to the
  canonical path URL).
- The root is `/` and is labelled `~/` in the UI (breadcrumb + folder tree
  header) instead of "Home".

## Non-goals

- **No `Home` (or any root) segment in URLs.** `/tree/Test`, not
  `/tree/Home/Test`; the root itself is `/`, and `/tree` (empty path) redirects
  to `/`.
- No rename/move (still out of scope app-wide; paths remain immutable, which is
  what makes path URLs stable).
- No change to the ACL model (ADR-0002 Grant/inheritance semantics are reused
  exactly, never reimplemented differently).
- No change to the share-link flow (`/s/:token` claim → `hf_s` cookie) or to
  the `/r/` raw-link rule.
- No server-driven pagination or listing changes.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| URL shape | `/tree/<path>`, `/blob/<path>`, no root segment | Mirrors storage exactly; no reserved-name collision with a real top-level folder |
| Path → node resolution | **New `GET /api/resolve?path=…` proxy rule** (server-side) | The `GET /api/nodes` `shape` step hides ancestors the viewer can't access, so a client-side root walk cannot resolve deep links for nested grantees or share visitors — exactly the app's core audience |
| Node paths for link building | **Server-computed `path` on every node** returned by `GET /api/nodes` and `GET /api/node` (folders included) | Files already carry it via `storage_path`; folders get it from the ancestor-name walk the pipelines already do. Makes all link generation trivial and lets share visitors emit canonical URLs |
| Ancestor-name disclosure | **Accepted** by owner | A nested grantee / share visitor sees ancestor folder *names* in the URL and breadcrumb. GitHub-equivalent; consistent with "the path you see is the storage key". Names only — never contents or listings |
| Legacy URLs | `/folder/:id` and `/view/:id` become redirects | Fetch by id (existing endpoint), then `Navigate replace` to the canonical URL. Old links in the wild keep working |
| Root label | `~/` | Owner preference; "Home" is not a folder and never appears in URLs |
| Sites | Leaves at `/blob/<site path>` | Same as files; a Site's internal assets are not app routes (they serve via `/api/uploads/content/*`) |
| Encoding | Per-segment `encodeURIComponent` when building URLs; per-segment `decodeURIComponent` when parsing | Same contract the serve rules now follow (PR #177). Names cannot contain `/` (upload-time validation), so segment joins are unambiguous |

## Architecture

Three layers change; the ACL gate logic is reused verbatim in the one new rule.

```
URL /tree/A/B ──► SPA route /tree/* ──► useResolvePath('A/B')
                                             │ GET /api/resolve?path=A%2FB
                                             ▼
                    ┌─ resolve rule: decode → file/site by storage_path,
                    │    else folder by name-walk over allFolders
                    │  → evalAccess(chain, viewer)   (same gate as serve rule)
                    │  → { node } | 401 | 403 | 404
                    ▼
              Folder page lists children via existing GET /api/nodes?parentId=<node.id>
              Viewer renders node exactly as today
```

### 1. Proxy rules (repo JSON + live set)

**New rule: `GET /api/resolve` (pipeline).** Steps, mirroring the serve rule's
proven structure:

- `parse` (`function_handler`): read `path` from the query string, decode per
  segment (malformed escape → keep raw segment, never throw), reject empty /
  `.` / `..` segments. Output `{ path, segments, hasPath }`.
- `nodeByKey` (`data_query`): file/site lookup by exact
  `storage_path == <owner>/<repo>/uploads/content/<path>` (existing pattern).
- `allFolders` (`data_query`, pageSize 500): the same folder universe every
  other gated rule loads.
- `gate` (`function_handler`): if `nodeByKey` hit → that node. Else walk
  `allFolders` by `displayName` from `root` along `segments` → folder node, or
  unresolved. Then run the **verbatim** `evalAccess`/`folderChain` logic from
  the serve rule (copy, not variant). Output
  `{ allow, deny401, deny403, deny404, node }` where `node` is shaped exactly
  like `GET /api/node`'s response node (including `path`).
- `respond` / `deny401` / `deny403` / `deny404` (`response_handler`): `{ node }`
  on allow; the standard JSON errors otherwise.

**Changed rules: `GET /api/nodes` and `GET /api/node`.** In their shaping
steps, add `path` to every emitted node: files/sites derive it from
`storage_path` (strip the `<owner>/<repo>/uploads/content/` prefix); folders
join ancestor `displayName`s from the already-loaded `allFolders` map. No
gating change.

Both land in `apps/handoff/bffless/handoff.proxy-rules.json` (repo source of
truth) and are applied to the live set via MCP after merge (human-gated, per
workspace practice).

### 2. Client data layer

- `HandoffNode.path` becomes non-optional in practice: `toNode()` already
  derives `path` from the content `url` for files; it now also trusts an
  explicit `path` field for folders (it already prefers `obj['path']` — the
  server starts supplying it).
- New RTK Query endpoint `resolvePath(path)` → `GET /api/resolve?path=…` →
  `{ node: HandoffNode }`, with the same 401-refresh-retry behavior as the
  other queries, cache-keyed by path.
- MSW mocks implement `/api/resolve` and add `path` to node payloads with the
  same semantics (mock == real at the `/api` boundary, per app convention).

### 3. Routes, pages, links

- `App.tsx` routes: `tree/*` → `HandoffFolder`, `blob/*` → `HandoffViewer`
  (both now take their subject from the splat via `useResolvePath` instead of
  `:id`); `folder/:id` and `view/:id` → small `LegacyRedirect` components
  (fetch node by id → `Navigate replace` to `treeUrl(node.path)` /
  `blobUrl(node.path)`; while loading, render the existing page skeleton; on
  error, the existing invalid-link treatment). `tree` with an empty splat →
  `Navigate replace` to `/`.
- New pure helper module `src/lib/pathUrl.ts`:
  `splitPath(splat) → segments` (decode), `joinPath(segments)`,
  `treeUrl(path)`, `blobUrl(path)` (encode per segment), plus the
  `parentPath(path)` used by the viewer's Back target. Unit-tested with
  spaces, U+202F, unicode, `%`-literals, and empty edge cases.
- Link emission switches to `node.path`: `FolderTree` items, `FolderView`
  rows, breadcrumbs, viewer Back/breadcrumb, and the shell's `showTree` route
  check (`/tree` prefix instead of `/folder`).
- Route/type mismatch is self-healing: if `/tree/<p>` resolves to a file (or
  `/blob/<p>` to a folder), the page issues `Navigate replace` to the correct
  route for the node's actual type. (In-folder name uniqueness should prevent
  a file and folder sharing a path, but the redirect makes the behavior
  well-defined regardless.)
- Breadcrumbs come straight from the current path's segments (each crumb links
  to its `/tree/` prefix); the root crumb renders `~/` and links to `/`. The
  folder tree's root label likewise becomes `~/`.
- Share-visitor sessions work unchanged: their sidebar roots at the shared
  folder, whose server-supplied `path` yields canonical URLs; deep links
  resolve via `/api/resolve` under their `hf_s` cookie.

## Error handling

- `/api/resolve` misses (404) or denials (401/403) render the existing
  invalid-link / sign-in treatments the id-based pages already have; a 401
  first passes through the established session-refresh retry.
- A malformed percent-escape in the URL resolves against the raw segment (same
  contract as the serve rule) and naturally 404s if no such name exists.
- Legacy redirect for a node the viewer can't access behaves exactly like
  today's id URL (the id fetch itself is gated).

## Testing

- **Seam A — `pathUrl` helpers (pure):** encode/decode round-trips incl.
  spaces, U+202F, unicode, literal `%`; `treeUrl`/`blobUrl`/`parentPath`
  outputs.
- **Seam B — resolve rule structural guard + behavioral eval:** assert the
  rule's wiring (pipeline, step order, schema id, response conditions) and
  execute the embedded `parse` and `gate` handler code with `new Function`
  (the pattern from `verbatimUploadRule.test.ts` that caught the decode bug):
  file hit, nested-folder walk, nested-grantee allow, share-visitor allow,
  anon deny401, wrong-path deny404.
- **Seam C — node `path` shaping:** behavioral eval of the changed `shape`
  step: folder paths join ancestor names; file paths strip the uploads prefix.
- **Seam D — app behavior via MSW:** `/tree//blob` pages resolve and render;
  legacy `/folder/:id` / `/view/:id` redirect to canonical URLs; breadcrumb
  hrefs; `~/` labels.
- **Live validation (post-deploy, via MCP + curl):** resolve a spaced/U+202F
  path; nested-grant deep link; share-visitor deep link (claim token → cookie
  → resolve + fetch bytes); anon 401; garbage 404.

## Rollout

1. All code + re-exported rule-set JSON merge in one PR (branch
   `feat/handoff-path-urls`, based on PR #177's branch).
2. After merge: create `GET /api/resolve` and update `GET /api/nodes` +
   `GET /api/node` on the live `handoff` set via MCP (owner-gated), then run
   the live validation list above.
3. No data migration; no legacy-URL cutoff (redirects stay).

## Out of scope

- Rename/move (would need subtree re-keying — unchanged future cost).
- Anything about `/api/public/content/*`, `/api/public`, `/api/directory`
  (still absent from the live set — pre-existing drift, tracked separately).
- CE changes (the `file_serve_handler` subDir decode enhancement is a separate
  CE candidate).
