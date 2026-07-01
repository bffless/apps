# Handoff backend — BFFless proxy rule set

Handoff has no app server. Its `/api/*` endpoints are a **BFFless proxy rule set** (handler chains:
presigned uploads, node tree, content serving, signed URLs, per-folder grants, share links). To run
Handoff against your own BFFless project you import that rule set and attach it to the alias serving
the app.

[`handoff.proxy-rules.json`](handoff.proxy-rules.json) is the exported rule set (23 rules, format
`bffless-proxy-rule-set` v2). It contains **no secrets** — credentials are referenced by name or use
the project's configured auth relay. The view pipelines carry the live per-folder ACL gate (see
**ACL enforcement** below); the signed-cookie HMAC uses CE's server-side `utils.sign` key, which the
sandbox never sees.

## Import

**Dashboard:** BFFless project → Proxy Rules → **Import** → upload `handoff.proxy-rules.json`.

**Claude / MCP:** ask Claude (with the BFFless MCP connected) to import
`apps/handoff/bffless/handoff.proxy-rules.json` into your project. It creates the `handoff` rule set
and all 23 rules (IDs are remapped on import).

After import, **attach the `handoff` rule set to the alias** your deploy uploads to (e.g. the
`handoff` alias / `handoff.<your-domain>`). `/api/*` only serves on aliases the rule set is attached
to.

## Manual setup (admin panel)

Everything the human must configure in the BFFless admin panel that the `install-app` skill
**cannot** do. The repo-root [`GETTING-STARTED.md`](../../../GETTING-STARTED.md) spine points here for
Handoff's app-specifics; do them once in the target project.

- **External connections / AI provider tokens — none.** Handoff has no AI handlers, so it needs **no**
  Replicate / Anthropic / other provider tokens. (Unlike Studio, there is nothing to enter under
  Settings → AI → AI Services.)
- **Secrets — none app-specific.** Handoff's pipelines reference no named `secrets.*`. The signed
  view-cookie HMAC uses CE's built-in server-side `utils.sign` key, which is managed by the platform,
  not entered by you.
- **Storage backend — a real bucket is REQUIRED (see §1 below).** ⚠️ **Handoff will not work on local
  file storage.** This is Handoff's key manual prerequisite.
- **Response-header rules — none.** Handoff needs no extra response headers (nothing like Studio's
  COOP/COEP), so the `install-app` skill has no header rule to add for Handoff.
- **Data tables + auth relay + people-picker directory** — the platform-level pieces the pipelines
  depend on; see §2–§4 below.

### 1. Storage backend (bucket) — REQUIRED, not local file storage

> ⚠️ **Handoff requires a real bucket storage backend (S3, GCS, Spaces/MinIO, or Azure Blob). It will
> not work on the local file-storage adapter.** This is the one manual prerequisite that will silently
> break Handoff if skipped.

Handoff uses the **presigned upload** flow — the browser PUTs files directly to the bucket, bypassing
the 1 MB proxy cap. The **local-storage adapter does not support presigned URLs** and will return
`PRESIGNED_NOT_SUPPORTED`, so uploads fail on local FS. Point the project's default storage at a
bucket backend before installing Handoff.

Bucket **CORS** must allow `PUT` from the site origin. Add a rule that permits:

- Method: `PUT`
- Origin: `https://<your-handoff-alias>` (or `*` during development)
- Headers: `Content-Type`

Uploaded files are written under `<owner>/<repo>/uploads/content/…`, created on demand.

The storage backend is set via server env (`STORAGE_TYPE` + backend vars), not the admin panel or
MCP — see the BFFless storage docs for exact variables, IAM/permissions, and CORS per backend:
[overview](https://docs.bffless.app/category/storage/) ·
[AWS S3](https://docs.bffless.app/storage/aws-s3/) ·
[Google Cloud Storage](https://docs.bffless.app/storage/google-cloud-storage/) ·
[Azure Blob](https://docs.bffless.app/storage/azure-blob-storage/).

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
| `public` | boolean | opt-in public flag — when `true`, a small file node is servable at the stable, anonymous `/api/public/content/<key>` URL (default/unset = private). See **Public serve** below. |

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
admin login relay. The `/_bffless/auth/*` endpoints are **built into BFFless nginx** — when Handoff
is served at `handoff.<your-primary-domain>` (a subdomain of the primary domain), the SuperTokens
session cookie is shared on `.<your-primary-domain>` and this works with **no extra configuration**.

The app derives the admin host it redirects to from its own hostname (`handoff.<primary>` →
`admin.<primary>`), so **no code edit is needed on a fork**. If you serve Handoff somewhere that
isn't `<app>.<primary-domain>` (or for local dev), set **`VITE_ADMIN_URL`** (e.g.
`https://admin.example.com`) at build time to point at your admin host explicitly.

### 5. Serve URL — domain mapping (public + SPA) + reachability

The `handoff` alias must be served at a URL, and three settings on that domain mapping matter:

- **Route the subdomain to the BFFless origin.** `handoff.<your-domain>` must reach BFFless — not a
  wildcard catch-all or a different app. If you front the instance with Cloudflare (tunnel/Pages),
  add the same route/public-hostname the `admin` host uses, or the request never reaches BFFless
  (symptom: `/api/*` 404s and the wrong app loads).
- **`isPublic: true`.** Handoff serves its **static bundle to everyone** and gates access in-app and
  at `/api/*` — logged-out share-link visitors (`/s/:token`, `/r/*`) must be able to load the SPA.
  A private deployment would 404 them before the app runs.
- **`isSpa: true`.** Handoff is a `BrowserRouter` SPA (`/view/:id`, `/folder/:id`, `/s/:token`), so
  deep links and hard refreshes need index.html fallback.
- **Build path.** The deploy uploads `apps/handoff/dist`, so set the mapping's `path` to
  `/apps/handoff/dist` (or rely on the auto-alias base-path) so index.html resolves at the root.

## First-success checkpoint

Once the rule set is imported and attached to the `handoff` alias, the **bucket** storage backend is
configured, the two data tables exist, and Handoff is deployed (see the repo-root
[`GETTING-STARTED.md`](../../../GETTING-STARTED.md)), confirm the install with one end-to-end action:

**Upload a file → see it served back.**

Open your deployed Handoff (`handoff.<your-domain>`), sign in, and **upload a file**; then open it and
confirm it **downloads / renders**. That round-trip exercises the presigned direct-to-bucket upload,
the `handoff_nodes` registration, and the ACL-gated serve path (`GET /api/uploads/content/*`) end to
end. If the file serves back, Handoff's backend is live.

- A **404 on `/api/*`** means the `handoff` rule set isn't attached to the `handoff` alias.
- A **`PRESIGNED_NOT_SUPPORTED`** on upload means the project is still on local file storage — switch
  to a real bucket backend (see [Manual setup → §1](#1-storage-backend-bucket--required-not-local-file-storage)).

## schemaId portability caveat

The exported rule set references `schemaId` values tied to the **source project's** data tables:

- `1c5d4802-596e-4f50-a08f-c41fb8f9fab0` — `handoff_nodes`
- `ace1febf-4b3d-4a11-a5f8-22a056dd9afa` — `handoff_share_links`

When you import the rule set into a **different BFFless project**, these IDs will not match your new
tables. You have two options:

1. **Update the rule set after import:** In the BFFless dashboard open each rule that references a
   `schemaId` (register node, list nodes, get node, create folder, register site, serve site, add
   grant, revoke grant, list grants, mint share link, validate share link, revoke share link, list
   share links, serve public content, toggle node public) and replace the `schemaId` with the id of your own `handoff_nodes` or
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

## Public serve (opt-in, no-auth) — issue #57

Two rules add a **stable, anonymous URL** for an explicitly-public file (e.g. a PR screenshot a
Sandcastle agent embeds inline — GitHub's image proxy fetches server-side with no cookies, so the URL
must be public and stable). **Private stays the default** — only nodes explicitly flagged `public` are
anonymously servable.

- **`POST /api/public`** — owner/admin (API-key allowed, so CI/agents can publish) sets a file node's
  `public` flag. Body `{ id, public }`. Returns `{ public, url }`, where `url` is the stable
  `/api/public/content/<key>` reverse-proxy path (null when flipping back to private).
- **`GET /api/public/content/*`** — resolves the file node by `storage_path` and **streams its bytes
  through the file server** (`file_serve_handler`) only when the node is `public === true` **and** its
  size is within the **10 MB** ceiling; otherwise **404** (existence is not leaked). Anything else →
  404.

**The bucket is never exposed.** Unlike `/api/sign` and `/r/*` (which 302 to a *short-lived* presigned
bucket URL — acceptable *because they expire*), the public path is effectively unlimited-lifetime, so it
must **not** hand out a bucket URL. It reverse-proxies the bytes from the **private** bucket through the
file server; the client only ever sees the app origin. That's also why it's **size-scoped to small
images** — proxying large/video assets through the app is too costly, and those stay on the existing
direct/authenticated path.

`file_serve_handler` emits `Cache-Control: public` here (correct — the content is genuinely public),
with a short `max-age` (300s) so flipping a node back to private bounds cache/CDN revocation lag to the
TTL. The `public` gate is the cache key's safety net: a private node 404s, so an aggressive shared cache
can't serve private bytes from the public path.

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
- **Numeric config values must be JSON numbers, not strings.** The `presigned_upload` / `signed_url`
  / `register_upload` steps carry `expiresIn` and `maxFileSize`. On the **AWS S3** backend these are
  passed straight to the SDK signer, which rejects a string with
  `expires should be of type "number"` (`PRESIGNED_URL_FAILED`). MinIO happens to tolerate strings,
  so an export from a MinIO project can look fine yet break on S3. This file uses numbers
  (`"expiresIn": 3600`, not `"3600"`); keep it that way after any re-export so the rule set works on
  every bucket backend.
