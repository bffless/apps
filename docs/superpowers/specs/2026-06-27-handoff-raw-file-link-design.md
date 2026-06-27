# Handoff raw-file link (`/r/{fileId}?token=`) — design

**Date:** 2026-06-27
**Builds on:** the frictionless-file-sharing work (PR #28, merged) and the share-link system (#23/#27).
**Origin:** A `/view/{id}?token=` link is "one URL" for a human, but a *cold* agent (or a plain `WebFetch`/`curl`) hitting it gets the React SPA shell and must reverse-engineer the claim→resolve→fetch dance — expensive and brittle. A simple **302 to the raw file** lets any dumb client get the bytes in one request with zero domain knowledge.

## Goal

A single GET URL that returns the file bytes to *any* client, no context required:

```
GET https://handoff.j5s.dev/r/{fileId}?token={shareToken}
→ 302 Location: <short-lived presigned storage URL>
```

`curl -L "…/r/{fileId}?token={t}" -o file` → bytes, one request. Browsers render images/PDFs inline.

## Key facts (confirmed feasible — pure proxy-rule change)

All building blocks already exist in `apps/handoff/bffless/handoff.proxy-rules.json` and the CE pipeline runner — **no CE/backend code, no schema, no `acl.ts` change**:

- `response_handler` can return `status: 302` with a templated `Location` header (the `/api/share-links/claim` rule already sets a custom `Set-Cookie` header; status 100–599 is allowed).
- The `signed_url` handler presigns any node's storage path mid-pipeline (`config.path` → `{ url }`); it is reusable in a new rule, not exclusive to `/api/sign`.
- Token validation (`handoff_share_links` lookup + `revoked`/`expiresMs` checks), node lookup (`handoff_nodes` by id), the all-folders query, and the `folderChain(folders, parentId)` ancestor walk are all reused verbatim from existing `validate`/`claim`/`gate` rules.
- Param access: `request.query.token`; the `{fileId}` path segment is extracted by regex on `request.path` (same pattern the `/api/sites/` rule uses).

## Design

### The endpoint

New rule `GET /r/{fileId}?token={t}`. Pipeline:

1. **parse** (`function_handler`) — `fileId` from `request.path` (regex on `/r/`), `token` from `request.query.token`.
2. **link** (`data_query`) — `handoff_share_links` by `steps.parse.token` → `{ folderId, revoked, expiresMs }`.
3. **node** (`data_query`) — `handoff_nodes` by `steps.parse.fileId` → `{ parentId, storage_path, type }`.
4. **folders** (`data_query`) — all folder records (for the chain).
5. **check** (`function_handler`) — compute `allow`:
   - token exists, `revoked !== true`, not past `expiresMs`, has a `folderId`;
   - node exists, is `type === 'file'`, has a non-empty `storage_path`;
   - `folderChain(folders, node.parentId)` contains the token's `folderId`.
   Outputs `{ allow, storagePath }`.
6. **sign** (`signed_url`) — presign `storagePath` with a short TTL (**300s**). (Runs only when `allow`; see Implementation notes for how the rule guards/conditionalizes so a denied/empty path never signs.)
7. **response** (`response_handler`) — if `allow`: `status 302`, `Location: {{steps.sign.url}}`. Else: `status 404`, tiny text body.

### Security / scope

- **The one check that matters:** the requested `fileId` must resolve to a node whose ancestor chain contains the **token's** `folderId`. This keeps the folder-scoped model intact — a valid token can only fetch files actually under its folder, not arbitrary ids.
- **404 for everything denied** (bad/expired/revoked token, foreign file, non-file node, missing storage path) — no `302`, no body hint, to avoid leaking what exists.
- **Revocation is instant** — the token is re-validated on every `/r` request (no cookie-TTL lag).
- **Presigned TTL ≈300s** — the redirect target is momentary; the durable grant is the share token, re-checked each hit. Each request mints a fresh URL.
- Token stays **folder-scoped** (no per-file ACL, no model change). The presigned URL is a direct, time-limited storage URL (same mechanism as `create_signed_url` / ADR-0001 media).

### Frontend (one line)

`shareLinkCopyUrl(origin, link, nodeId)` in `apps/handoff/src/lib/share.ts` changes its file-mode output from `/view/{nodeId}?token=` to `/r/{nodeId}?token=`. This flows automatically to every copy surface (per-file row, post-upload prompt, viewer popover) and the listed-link display. Update its unit test accordingly.

The token-aware `/view/{id}?token=` viewer (shipped in #28) **remains functional** — it's still a valid human link; it's just no longer what the button copies.

## Non-goals

- No content negotiation / User-Agent sniffing (fragile; `WebFetch` can look like a browser). `/r` is deterministic: always 302→bytes.
- No per-file ACL; no change to the token model or the existing gate.
- No CE/backend, schema, or `acl.ts` changes.
- Sites/folders are out of scope for `/r` (no single storage path) → 404.

## Implementation notes / risks

- **Conditional signing:** the `signed_url` step must not run (or must no-op safely) when `allow` is false or `storagePath` is empty, or it could error the pipeline. Confirm the rule expresses this — either via a conditional step, or by having `check` emit a safe sentinel and the response branch to 404 before the URL is used. Verify during implementation against the live pipeline runner.
- **Path-param extraction:** `/r/{fileId}` is matched as a prefix rule and `fileId` is parsed from `request.path` (the named-param accessor may not be available; the regex approach is proven). Confirm the route registration form the proxy-rule system expects.
- **storage_path field name:** confirm the node record's storage field key (`storage_path` vs `storageKey`) as used by the `signed_url` config and the existing `/api/sign` rule, and reuse exactly that.

## Deployment (ask-first)

Proxy rules live in BFFless, not in the app bundle. Editing `handoff.proxy-rules.json` is the **source of truth**, but the change only takes effect once the updated rule set is **imported/attached to the live handoff project on j5s.dev** (via the `j5s-dev` MCP `create_proxy_rule` / proxy-rule-set tools, or the admin UI). That is a **live-tenant change** → it must be approved before applying. The PR carries the JSON + frontend change; going live is a separate, gated step.

## Testing & validation

- **Unit:** the `shareLinkCopyUrl` format change (`/r/{id}?token=`), in `lib/share.test.ts`.
- **Integration (after applying the rule to the live project or a test alias):**
  - `curl -sL -o out "…/r/{fileId}?token={validToken}"` → file bytes; `curl -sI "…/r/{fileId}?token={validToken}"` → `302` + `Location`.
  - revoked/expired token → `404`; a `fileId` not under the token's folder → `404`; a folder/site id → `404`.
  - dogfood: fetch a real shared screenshot via `/r/…` in one `curl -L` (the same file accessed earlier the multi-step way).

## Acceptance criteria

- [ ] `GET /r/{fileId}?token={t}` returns `302`→presigned URL for a file under the token's folder; `curl -L` yields the bytes in one request.
- [ ] Token's folder must contain the file (ancestor-chain check); foreign `fileId` → `404`.
- [ ] Revoked / expired / malformed token → `404`; non-file node → `404`. No info leak (no `302`, no descriptive body).
- [ ] Presigned redirect target is short-lived (≈300s); token re-validated per request.
- [ ] App "Copy link" now copies `/r/{id}?token=`; `/view/{id}?token=` viewer still works.
- [ ] No CE/backend/schema/`acl.ts` changes. Going live is a separate, approved step.
