# Handoff backend — BFFless proxy rule sets

Handoff has no app server. Its `/api/*` endpoints are **BFFless proxy rule sets** (handler chains:
presigned uploads, node tree, content serving, signed URLs, per-folder grants, share links). To run
Handoff against your own BFFless project you push those rule sets and attach them to the alias serving
the app.

The rules are **authored as code** under [`../.bffless/proxy-rules/`](../.bffless/proxy-rules/) —
`ruleset.yaml` per set, one manifest per route, and every handler body a real `.fn.js` file you can
read, lint, and test. Handoff ships **two** sets:

| Set | Rules | What it serves |
| --- | --- | --- |
| `handoff` | 23 | The app API — `/api/*` plus the `/r/*` raw-file redirect |
| `handoff-rss-feed` | 2 | The public folder feeds — `/feed/*` and `/feed.xml` |

They're separate because the feeds are independently attachable (a project can serve the app without
exposing feeds), but both must be attached for a complete install. Neither contains **secrets** —
credentials are referenced by name or use the project's configured auth relay. The view pipelines
carry the live per-folder ACL gate (see **ACL enforcement** below); the signed-cookie HMAC uses CE's
server-side `utils.sign` key, which the sandbox never sees.

> Handoff used to ship a single 3,500-line `handoff.proxy-rules.json` export, edited by hand and via
> one-off `patch-*.mjs` scripts. That's gone (bffless/apps#231) — the authored files are now the source
> of truth, and this repo's CI syncs them to the live project on every merge.

## Push

**CLI (recommended).** Pushes straight to your project, creating the sets and rules:

```bash
npx bffless rules push apps/handoff/.bffless/proxy-rules/handoff --api-url <your-instance> --project <owner/name>
npx bffless rules push apps/handoff/.bffless/proxy-rules/handoff-rss-feed --api-url <your-instance> --project <owner/name>
```

with your `BFFLESS_API_KEY` in the environment. (The repo's committed `.bffless/config.json` targets
the upstream demo instance, hence the explicit `--api-url` / `--project`.) Push is **idempotent** — run
it again after any rule change.

**Dashboard.** Build the export JSON first, then upload it under Proxy Rules → **Import**:

```bash
npx bffless rules build apps/handoff/.bffless/proxy-rules/handoff -o /tmp/handoff.proxy-rules.json
```

Prefer the CLI: `push` resolves data tables **by name** against your project, while a dashboard import
carries the source project's table ids (see **Data tables** below).

**Claude / MCP:** ask Claude (with the BFFless MCP connected) to install Handoff — the repo-local
`install-app` skill does the build + import + attach for you.

After pushing, **attach both rule sets to the alias** your deploy uploads to (e.g. the `handoff` alias
/ `handoff.<your-domain>`). `/api/*` only serves on aliases the rule set is attached to.

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
- **Response-header rules — none on a clean project.** Handoff needs no extra headers by itself.
  **Exception — iframed content:** Handoff renders user-uploaded **Sites** (served with no `COEP`)
  in an iframe, and exposes a chromeless **`?embed=1`** viewer mode that other apps (e.g. the reader)
  iframe to show a post inline. If your project applies a cross-origin-isolation policy
  (`COOP`/`COEP`) — e.g. another app on the same project uses `SharedArrayBuffer` (ffmpeg, etc.) —
  the browser blocks those iframes with `COEP-framed resource needs COEP header`. Fix: add a
  response-header rule matching Handoff's files (`apps/handoff/**`) with
  `Cross-Origin-Opener-Policy: unsafe-none` + `Cross-Origin-Embedder-Policy: unsafe-none` and a
  priority **below** the isolating rule. (Handoff itself doesn't use `SharedArrayBuffer`.) For a
  cross-domain embedder, also allow that origin in Handoff's frame-ancestors (framePolicy `allow` +
  `allowedOrigins`); same-registrable-domain subdomains are allowed automatically. A fresh project
  with no isolation policy needs nothing here.
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

## Data-table ids are resolved by name (no more remapping)

The authored rules reference data tables **by name** (`handoff_nodes`, `handoff_share_links`), not by
UUID — the names live in [`schemas/`](../.bffless/proxy-rules/handoff/schemas/) alongside the field
definitions. `bffless rules push` resolves each name against **your** project on the way in: it reuses
a table you already have, or creates one from the schema file if you don't, and rewires every rule's
`schemaId` to your table's id.

So the old chore — importing, then hand-editing the `schemaId` on all thirteen rules that touch a
table because the export carried the *source* project's UUIDs — is gone. Create the two tables as
described in [Manual setup → §2](#2-data-tables) (so `handoff_nodes` gets its upload columns and the
Uploads tab works), then push: it will match them by name.

⚠️ **This only applies to `rules push`.** A **dashboard import** of a built JSON still carries the ids
baked into the export at build time, so it needs the manual remap. Push instead.

## ACL enforcement (LIVE)

The per-folder access control model is fully built into the data layer (the `mode`, `grantsJson`,
`ownerId` columns on `handoff_nodes`), and the grant-management pipelines (`/api/grants`,
`/api/grants/revoke`, `/api/grants` GET) are live and enforced. Owner/admin baseline access is
active: only the node's `ownerId` or a project admin can add, revoke, or list grants.

**Share links** (`/api/share-links/*`) are live — owners/admins can mint folder-scoped view
tokens that self-expire and can be revoked.

**Full view-path enforcement is now LIVE** (ADR-0002). The view pipelines —
`GET /api/uploads/content/*` (serve-content), `POST /api/sign`, `GET /api/nodes` (list), and
`GET /api/node` (getNode) — run a per-request ACL gate before serving. (A Site is *served* through
`GET /api/uploads/content/*` like any other stored object, not by a separate serve-site pipeline;
`POST /api/sites` only builds one.) The gate:

1. **Authenticate** the BFFless session (optional auth — a session yields `user`; anonymous and
   share-link visitors pass through to the in-pipeline check).
2. **Resolve the target's owning folder chain.** A single `data_query` loads every folder node
   (`nodeType = folder`, capped at 500) and the gate walks `parentId` up to `root` in-process. The
   target node itself contributes its `ownerId` (so a root-level file's owner is recognised even with
   no parent folder).
3. **Evaluate** with a `function_handler` that ports `src/lib/acl.ts` `evaluateAccess` verbatim
   (admin/owner short-circuit, inherited grants, highest-wins, restricted boundary, share-link cap).
4. **Allow → serve; deny → 403** (authenticated or holding a valid `hf_s` share cookie) or **401**
   (no credential at all).
5. **Site assets are re-walked, not cookie-authorised.** A content key with no node record of its own
   lives inside a Site's storage prefix: the gate picks the Site whose `storage_path` is the longest
   prefix of the key and evaluates *that* Site's folder chain. This happens on **every** asset
   request — there is no fast-path cookie.

   > ADR-0002 originally proposed a short-lived signed `hf_f` folder cookie to skip the re-walk. **It
   > was never built** (bffless/apps #237) — nothing ever set it. The re-walk is stricter anyway: a
   > revoked grant takes effect on the next request rather than lagging by the cookie TTL.

**Share-link visitors:** `POST /api/share-links/claim` (public) validates a token and sets a signed,
folder-scoped `hf_s` view cookie (View-only, ~30 min TTL). The frontend `ShareLinkEntry` (`/s/:token`)
calls it so a logged-out visitor holds the cookie the gate accepts. `evaluateAccess` caps a share-link
viewer at `view`, scoped to the link's folder and its descendants.

**`list` is filtered, not just gated:** a non-root parent you can't view returns 403; otherwise the
returned children are filtered to those you can access — so root listing is private by default and
restricted siblings stay hidden.

**Public folders — the Anyone principal (ADR-0005, bffless/apps#183):** a folder is made public by
granting the reserved principal id **`anyone`** on it — there is no visibility field or global
setting. Every `evalAccess` copy in the gates matches an `anyone` grant for **all** viewers
(anonymous included) and caps it at `view` regardless of the stored level; anonymous requests flow
through the normal evaluation instead of being rejected up front (401 remains the deny for
credential-less requests). Publicness inherits through `inheriting` children and is cut off by a
`restricted` descendant, exactly like any other grant. Write-side, the `/api/grants` merge step
forces `level: "view"` and `principalEmail: null` for `anyone` on both its insert and replace
branches, so the grant can never escalate. Share links are unchanged and remain the tokened
mechanism for private folders. The root record (`nodeType: 'root'`, ADR root-sharing) makes
whole-site public just an `anyone` grant on root. The canonical semantics live in
`src/lib/acl.ts` (`ANYONE_PRINCIPAL`); `src/lib/anyoneGrantRule.test.ts` holds the structural
guards and the embedded↔TS port-equivalence matrix. The `evalAccess` copies are now plain `.fn.js`
files under `../.bffless/proxy-rules/handoff/rules/`, edited directly — the `patch-anyone-*.mjs`
scripts that used to rewrite them inside the JSON blob are retired (bffless/apps#231).

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

## CDN caching note for forkers

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

## Changing the rules

Edit the authored files under [`../.bffless/proxy-rules/<set>/`](../.bffless/proxy-rules/) — **not**
the live dashboard. A dashboard edit to a git-managed set is allowed but not sticky: the next CI sync
overwrites it, and the nightly `rules diff` drift check will flag it in the meantime.

```bash
npx bffless rules validate apps/handoff/.bffless/proxy-rules/handoff   # lint manifests + handlers
npx bffless rules test     apps/handoff/.bffless/proxy-rules/handoff   # run *.fn.test.yaml fixtures
pnpm --filter handoff test:run                                          # the rule guards in src/**
npx bffless rules diff     apps/handoff/.bffless/proxy-rules/handoff   # local vs live
```

Merging to `main` syncs both sets to the live project (`.github/workflows/deploy-handoff.yml`) — no
manual export/import step. Handoff's PR previews are **frontend-only** and run against the *current
live* rules; to try a rule change before merge, push it to a throwaway suffixed set:
`npx bffless rules dev apps/handoff/.bffless/proxy-rules/handoff --push --name-suffix pr-<N>`.

The rule guards in `src/lib/*Rule.test.ts` compile these files with the real `buildRuleSet` compiler
and execute the embedded handlers, so a broken handler fails `pnpm test` — not production.

## Notes

- The `POST /api/uploads/content` rule (direct `file_upload_handler`) is intentionally **absent** —
  Handoff uses the presigned prepare+register flow for all file uploads.
- **Numeric config values must be YAML numbers, not strings.** The `presigned_upload` / `signed_url`
  / `register_upload` steps carry `expiresIn` and `maxFileSize`. On the **AWS S3** backend these are
  passed straight to the SDK signer, which rejects a string with
  `expires should be of type "number"` (`PRESIGNED_URL_FAILED`). MinIO happens to tolerate strings, so
  a rule set that works on MinIO can still break on S3. Keep them unquoted (`expiresIn: 3600`, not
  `expiresIn: '3600'`) so the rule set works on every bucket backend.
