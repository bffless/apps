# Handoff backend — BFFless proxy rule set

Handoff has no app server. Its `/api/*` endpoints are a **BFFless proxy rule set** (handler chains:
presigned uploads, node tree, content serving, signed URLs, per-folder grants, share links). To run
Handoff against your own BFFless project you import that rule set and attach it to the alias serving
the app.

[`handoff.proxy-rules.json`](handoff.proxy-rules.json) is the exported rule set (21 rules, format
`bffless-proxy-rule-set` v2). It contains **no secrets** — credentials are referenced by name or use
the project's configured auth relay. The view pipelines carry the live per-folder ACL gate (see
**ACL enforcement** below); the signed-cookie HMAC uses CE's server-side `utils.sign` key, which the
sandbox never sees.

## Import

**Dashboard:** BFFless project → Proxy Rules → **Import** → upload `handoff.proxy-rules.json`.

**Claude / MCP:** ask Claude (with the BFFless MCP connected) to import
`apps/handoff/bffless/handoff.proxy-rules.json` into your project. It creates the `handoff` rule set
and all 21 rules (IDs are remapped on import).

After import, **attach the `handoff` rule set to the alias** your deploy uploads to (e.g. the
`handoff` alias / `handoff.<your-domain>`). `/api/*` only serves on aliases the rule set is attached
to.

## Prerequisites (provision these in the target project first)

### 1. Storage backend (bucket)

Handoff uses the **presigned upload** flow — the browser PUTs files directly to the bucket, bypassing
the 1 MB proxy cap. This requires a **bucket storage backend** (S3, GCS, MinIO, or Azure Blob) — the
local-storage adapter does not support presigned URLs and will return `PRESIGNED_NOT_SUPPORTED`.

Bucket **CORS** must allow `PUT` from the site origin. Add a rule that permits:

- Method: `PUT`
- Origin: `https://<your-handoff-alias>` (or `*` during development)
- Headers: `Content-Type`

Uploaded files are written under `<owner>/<repo>/uploads/content/…`, created on demand.

### 2. Data tables

Two data tables are required. Create them in the BFFless dashboard → Data → New Table:

**`handoff_nodes`** — stores files, folders, and sites in the node tree.

Start by generating the upload schema for `content` files via **Data → Generate Upload Schema**
(this creates the base columns including `storage_path`, `content_type`, `size`, etc. and makes
files appear in the Uploads tab). Then add these extra columns:

| Column | Type | Notes |
| --- | --- | --- |
| `parentId` | text | parent folder id (or `"root"`) |
| `nodeType` | text | `"file"`, `"folder"`, or `"site"` |
| `displayName` | text | user-visible name |
| `ownerId` | text | BFFless user id of the uploader / creator |
| `mode` | text | ACL mode: `"inheriting"` or `"restricted"` |
| `grantsJson` | text | JSON array of `{ principalId, principalEmail, level }` |
| `manifest` | text | JSON object mapping `relPath → storageUrl` (site nodes only) |
| `siteEntry` | text | entry file (e.g. `index.html`) within the manifest |
| `createdMs` | integer | client-provided creation timestamp (ms) |

**`handoff_share_links`** — stores folder-scoped share link tokens.

Create a new table with these columns:

| Column | Type | Notes |
| --- | --- | --- |
| `folderId` | text | the folder this link grants access to |
| `expiresMs` | integer | Unix ms expiry (null = never expires) |
| `revoked` | boolean | set to `true` to invalidate |
| `createdBy` | text | BFFless user id of the creator |
| `createdMs` | integer | creation timestamp (ms) |

### 3. People-picker directory (CE version requirement)

The "Manage access" people-picker autocompletes against your BFFless users via
`GET /api/directory`, a plain proxy rule that forwards (with the requester's session cookie) to the
CE backend's **member-accessible** `GET /api/users/directory` — it returns only `{ users: [{id,email}] }`,
requires a non-empty `search`, caps the result count, and excludes disabled users. No admin API key
is borrowed; the requester is authenticated as themselves.

This endpoint requires **CE ≥ the release that adds `/api/users/directory`** (the non-admin user
directory). On older CE builds, `/api/users/directory` does not exist and the picker will return no
results — grant management still works once you know a user id, but the autocomplete needs the
updated backend.

### 4. Auth relay

Handoff uses BFFless cookie-based sessions for access control. The app reads
`/_bffless/auth/session` to detect the current user and redirects unauthenticated visitors to the
admin login relay. Configure the built-in `/_bffless/auth/*` relay in the BFFless dashboard
(Settings → Auth) so that the session cookie is issued correctly for your alias domain.

## schemaId portability caveat

The exported rule set references `schemaId` values tied to the **source project's** data tables:

- `1c5d4802-596e-4f50-a08f-c41fb8f9fab0` — `handoff_nodes`
- `ace1febf-4b3d-4a11-a5f8-22a056dd9afa` — `handoff_share_links`

When you import the rule set into a **different BFFless project**, these IDs will not match your new
tables. You have two options:

1. **Update the rule set after import:** In the BFFless dashboard open each rule that references a
   `schemaId` (register node, list nodes, get node, create folder, register site, serve site, add
   grant, revoke grant, list grants, mint share link, validate share link, revoke share link, list
   share links) and replace the `schemaId` with the id of your own `handoff_nodes` or
   `handoff_share_links` table. The table id appears in the URL when you open the table in the
   dashboard.

2. **Re-create via Claude + MCP:** ask Claude to import the rule set and then update all
   `schemaId` references to match your tables. This is faster for a fresh project.

After updating `schemaId` values, re-export and commit the updated JSON so future forks of your
project get the correct ids.

## ACL enforcement (LIVE)

The per-folder access control model is fully built into the data layer (the `mode`, `grantsJson`,
`ownerId` columns on `handoff_nodes`), and the grant-management pipelines (`/api/grants`,
`/api/grants/revoke`, `/api/grants` GET) are live and enforced. Owner/admin baseline access is
active: only the node's `ownerId` or a project admin can add, revoke, or list grants.

**Share links** (`/api/share-links/*`) are live — owners/admins can mint folder-scoped view
tokens that self-expire and can be revoked.

**Full view-path enforcement is now LIVE** (ADR-0002). All five view pipelines —
`GET /api/uploads/content/*` (serve-content), `GET /api/sites/*` (serve-site), `POST /api/sign`,
`GET /api/nodes` (list), and `GET /api/node` (getNode) — run a per-request ACL gate before serving:

1. **Authenticate** the BFFless session (optional auth — a session yields `user`; anonymous and
   share-link visitors pass through to the in-pipeline check).
2. **Resolve the target's owning folder chain.** A single `data_query` loads every folder node
   (`nodeType = folder`, capped at 500) and the gate walks `parentId` up to `root` in-process. The
   target node itself contributes its `ownerId` (so a root-level file's owner is recognised even with
   no parent folder).
3. **Evaluate** with a `function_handler` that ports `src/lib/acl.ts` `evaluateAccess` verbatim
   (admin/owner short-circuit, inherited grants, highest-wins, restricted boundary, share-link cap).
4. **Allow → serve; deny → 403** (authenticated) or **401** (no session and no valid cookie).
5. **Signed folder cookie** (the ADR-0002 optimisation): on the first allowed **site** entry,
   serve-site sets a short-lived `hf_f` cookie — `base64url(payload).hmacSig` where the HMAC is CE's
   `utils.sign` (server-key HMAC-SHA256, hex) — scoped to the site's folder. Site asset sub-requests
   (which have no node record) are authorised by that cookie without re-walking. TTL is short
   (~5 min), so revocation lags by at most the TTL.

**Share-link visitors:** `POST /api/share-links/claim` (public) validates a token and sets a signed,
folder-scoped `hf_s` view cookie (View-only, ~30 min TTL). The frontend `ShareLinkEntry` (`/s/:token`)
calls it so a logged-out visitor holds the cookie the gate accepts. `evaluateAccess` caps a share-link
viewer at `view`, scoped to the link's folder and its descendants.

**`list` is filtered, not just gated:** a non-root parent you can't view returns 403; otherwise the
returned children are filtered to those you can access — so root listing is private by default and
restricted siblings stay hidden.

**Delete is WRITE-gated** (`DELETE /api/node?id=<uuid>`): the same ACL gate, but the allow test
requires **write** (`rank(level) >= 2` — `edit`/`owner`, admin bypass; view-only and share-link
viewers get `403`). It hard-deletes a single node — purging a file's stored object via `file_delete`
key-mode and the record via `data_delete` — and refuses a non-empty folder with `409`. Recursion lives
in the client (`deleteSubtree` in `src/store/handoffApi.ts`): `data_delete` has no bulk `in` and
`file_delete` key-mode is one object, so a static pipeline can't fan out over a subtree. The client
deletes depth-first (children before parents), and the `409` guard is the server-side backstop against
an out-of-order direct call orphaning a subtree.

**Sites purge their assets too** (bffless/apps#35): deleting a **Site** node also removes every object
its `manifest` references — many `content/<hash>` objects with no shared prefix and a variable count.
The `siteKeys` step parses the manifest into uploads-root-relative keys and hands them to `file_delete`
via its **keys-as-expression** mode (`keys: "steps.siteKeys.list"`, ce#364) — the dynamic, runtime list
a static `keys[]` array can't express. An empty manifest resolves to `[]` (a no-op), so nothing is
orphaned.

### CDN caching note for forkers

`file_serve_handler` emits `Cache-Control: public, max-age=3600` on served content by default. On a
single-origin deploy (or a CDN that treats `/api/*` as dynamic, like the reference `j5s.dev` Cloudflare
zone) this is harmless — the gate runs on every request. **If you front Handoff with a CDN configured
to "cache everything" by file extension, add a cache rule** for `*/uploads/content/*` and `*/api/sites/*`
that sets a `private` / `max-age=0, must-revalidate` policy (BFFless → Cache Rules), so a CDN never
serves one viewer's authorised content to another. Without it, an aggressive shared cache could bypass
the per-folder ACL.

## Portability: storage paths are deployment-relative

The presigned prepare handler derives the storage prefix from the deployment context rather than
hard-coding it:

```js
function handler({ request, deployment }) {
  var storagePath = deployment.owner + '/' + deployment.repo + '/uploads/content/' + key
}
```

An import into `you/your-app` writes to `you/your-app/uploads/content/…` automatically — no
per-project edits. `deployment.owner`/`deployment.repo` are listed in the step editor's *Available
Variables*; if a presigned upload 404s on a bucket path, confirm the function received `deployment`.

## Notes

- Re-export from the BFFless dashboard (Proxy Rules → Export) after changing rules, and commit the
  updated JSON here so the giveaway stays current.
- The `POST /api/uploads/content` rule (direct `file_upload_handler`) is intentionally **excluded**
  from this export — Handoff uses the presigned prepare+register flow for all file uploads.
