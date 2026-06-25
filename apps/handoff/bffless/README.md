# Handoff backend — BFFless proxy rule set

Handoff has no app server. Its `/api/*` endpoints are a **BFFless proxy rule set** (handler chains:
presigned uploads, node tree, content serving, signed URLs, per-folder grants, share links). To run
Handoff against your own BFFless project you import that rule set and attach it to the alias serving
the app.

[`handoff.proxy-rules.json`](handoff.proxy-rules.json) is the exported rule set (16 rules, format
`bffless-proxy-rule-set` v2). It contains **no secrets** — credentials are referenced by name or use
the project's configured auth relay.

## Import

**Dashboard:** BFFless project → Proxy Rules → **Import** → upload `handoff.proxy-rules.json`.

**Claude / MCP:** ask Claude (with the BFFless MCP connected) to import
`apps/handoff/bffless/handoff.proxy-rules.json` into your project. It creates the `handoff` rule set
and all 16 rules (IDs are remapped on import).

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

### 3. Auth relay

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

## ACL enforcement activation note

The per-folder access control model is fully built into the data layer (the `mode`, `grantsJson`,
`ownerId` columns on `handoff_nodes`), and the grant-management pipelines (`/api/grants`,
`/api/grants/revoke`, `/api/grants` GET) are live and enforced. Owner/admin baseline access is
active: only the node's `ownerId` or a project admin can add, revoke, or list grants.

**Share links** (`/api/share-links/*`) are also live — owners/admins can mint folder-scoped view
tokens that self-expire and can be revoked.

**Full view-path enforcement** — the gate that checks a visitor's session against the ancestor
folder's `grantsJson` before serving content, sets a bounded short-lived signed folder-scoped cookie
(using the CE `utils` crypto HMAC `sign`/`verify` helpers), and rejects unauthorised requests with
a 403 — is the one remaining activation step. The complete design (auth flow, ancestor-walk
algorithm, cookie scoping) is documented in
[`stories/00-architecture-and-design.md`](../stories/00-architecture-and-design.md) under ADR-0002.
Enable it by adding the view-path pipeline rule and wiring the cookie check to the serve handler.
Until then, content URLs are accessible to anyone who holds the URL.

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
