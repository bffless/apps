# Per-folder ACL enforced by a pipeline + folder-scoped access cookie

**Status: Implemented & live (2026-06-25).** All five view pipelines are gated; see the
"Implementation as shipped" section below for what differs from the original sketch. Tracked in
bffless/apps #16.

**Decision.** All Handoff state — the [[Folder]] tree, content metadata, [[Grant]]s, and
[[Share Link]]s — lives in BFFless data tables; the app has no server of its own (like Studio, its
`/api/*` is a BFFless proxy rule set / pipelines). The view path is fronted by a Handoff **pipeline**
that authenticates the BFFless session, resolves the object's owning Folder, evaluates the ACL
(grants + group membership + [[Inheriting / Restricted]] + share-link cookie), and only then serves.
On the **first** allowed request into a Folder the pipeline sets a **short-lived signed cookie scoped
to that Folder**; subsequent asset requests in the same Site/Folder validate against the cookie
instead of re-running the full evaluation.

**Why.** BFFless's built-in visibility is project/alias/domain-wide only — it cannot express
"only Alice and eng-team can see this folder," which is Handoff's headline feature. So the per-folder
ACL must be the app's own logic. A `Site` load fires many asset sub-requests; re-evaluating the ACL
(and re-reading data tables) on every one would be slow and heavy, so the scoped cookie amortizes the
check. The pattern mirrors BFFless's own `__bffless_share` cookie.

**Consequences.**
- Revocation is not instant: a grant removed mid-session stays effective until the folder cookie
  expires (keep the TTL short, e.g. minutes).
- The cookie must be signed and folder-scoped so it can't be replayed against other folders.
- Group membership is read from BFFless's directory during the full evaluation only (not per asset).

## Implementation as shipped

What the live pipelines do, and where it differs from the sketch above:

- **Ancestor resolution.** Rather than an unrolled chain of by-id `data_query` steps, the gate runs a
  single `data_query` for all folder nodes (`nodeType = folder`, `pageSize 500`) and walks `parentId`
  to `root` in-process. This sidesteps the "no `in` / non-uuid `recordId` 500s" sandbox traps and is
  one query regardless of depth. Limit: a project with > 500 folders would need the cap raised /
  paginated (fine for an internal tool; documented).
- **Target node in the chain.** The chain evaluated is `[…ancestor folders…] + the target node`. A
  file/site contributes its own `ownerId` (no grants), so a **root-level file's owner is recognised**
  even though it has no parent folder. Folders evaluate as themselves.
- **`evaluateAccess` is ported verbatim** into the gate `function_handler` (admin/owner short-circuit,
  inherited grants, highest-wins, restricted boundary, share-link cap) and kept equivalent to
  `src/lib/acl.ts` — covered by the same unit-test matrix plus an offline port-equivalence check.
- **Two cookies, both `base64url(JSON.stringify(payload)) + "." + utils.sign(payload)`** where
  `utils.sign` is CE's server-key HMAC-SHA256 (returns **hex**; verified with `utils.verify`, which is
  timing-safe). The signing key lives in CE and is never exposed to the sandbox.
  - `hf_f` — folder fast-path. Set by **serve-site** on the first allowed 302 (`{ f: folderId, v:
    viewerId, exp }`, ~5 min). Site asset sub-requests (`/api/uploads/content/*` keys that have **no
    node record**) are authorised by a valid `hf_f`/`hf_s` without re-walking — this is what lets a
    multi-file Site render. `Set-Cookie` rides on the existing 302 response (one `Set-Cookie` per
    response is a CE limitation, which is sufficient here).
  - `hf_s` — share-link credential. Set by **`POST /api/share-links/claim`** (`{ s: folderId, exp }`,
    ~30 min) after token validation. `evaluateAccess` treats it as a `{ shareLinkFolderId }` viewer
    (≤ `view`, scoped to that folder + descendants).
- **Deny semantics.** `none` → **401** when there is no session and no valid cookie, else **403**.
  Cookies are read from the raw `Cookie` header (the sandbox `request` exposes `headers`, not a parsed
  `cookies` object).
- **`list` is filtered.** It returns only children the viewer can access (per-child `evaluateAccess`),
  and 403s an inaccessible non-root parent — making root private by default and hiding restricted
  siblings, rather than leaking sibling metadata.
- **CDN caching.** `file_serve` defaults to `Cache-Control: public, max-age=3600`. The reference
  deployment's CDN treats `/api/*` as dynamic (verified: an authorised 200 is not served to an
  unauthenticated repeat — that returns 401), so no cross-user leak. Forkers behind a cache-everything
  CDN should add a `private`/`no-store` cache rule for the content + sites paths (see the bffless
  README).
