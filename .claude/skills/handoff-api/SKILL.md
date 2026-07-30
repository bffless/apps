---
name: handoff-api
description: Upload, organize, and share content in a Handoff deployment by calling its BFFless pipeline API directly, authenticating with a BFFless API key (X-API-Key)
---

# Handoff API

Handoff is a give-away file-sharing app that runs on BFFless: it has no app
server — its `/api/*` endpoints are a BFFless proxy rule set attached to the
deployment's alias. This skill drives them directly as an agent, against any
Handoff deployment.

## Base URL

Resolve the deployment's base URL, in order:

1. `HANDOFF_BASE_URL` env var, if set.
2. Ask the user, or take it from context (e.g. "my handoff is at
   handoff.example.com").

Examples below use `$HANDOFF_BASE_URL` (e.g. `https://handoff.example.com`).
If the base URL came from the user rather than an already-set env var, export
it (`export HANDOFF_BASE_URL=https://handoff.example.com`) so the examples
below run verbatim.

## Auth (send a BFFless API key as X-API-Key)

Every `/api/*` call needs an API key for the BFFless project serving the
deployment, sent as the `X-API-Key` header. Source it in order:

1. **`BFFLESS_API_KEY` env var** (CI, sandboxes, any runtime):

       curl -H "X-API-Key: $BFFLESS_API_KEY" "$HANDOFF_BASE_URL/api/nodes"

2. **The `bffless` CLI credential store** (requires `bffless` >= 0.3.1; filled
   by a one-time human `bffless login` per machine + instance):

       npx bffless auth token   # run standalone first — see below before embedding it in curl

   Inside a cloned Handoff repo, `auth token` resolves the instance from
   `.bffless/config.json` automatically; elsewhere pass
   `--api-url https://admin.example.com` (the BFFless admin URL, not the
   Handoff URL). A fresh fork's committed `.bffless/config.json` still points
   at the upstream demo instance — check that its `apiUrl` is *your* instance
   before trusting the auto-resolve, and pass `--api-url` explicitly if not.

`$(npx bffless auth token)` substitutes to an **empty string** on failure (the
error goes to stderr, not stdout), so a failed lookup silently becomes
`X-API-Key: ` rather than a visible error. Run `npx bffless auth token` on its
own first; only once it exits 0 and prints a key, embed it:
`curl -H "X-API-Key: $(npx bffless auth token)" "$HANDOFF_BASE_URL/api/nodes"`.
If it exits non-zero, or neither this nor `BFFLESS_API_KEY` yields a key, stop
and tell the user to run `npx bffless login` (or export `BFFLESS_API_KEY`). Do
not hunt for keys in agent-runtime config files.

The key authenticates as its owner, so content you create is owned by that
user (the same as uploading in the browser). The PUT-to-bucket step (below) is
the one exception — it is presigned and takes no key.

## Discovery

In a Handoff repo clone, the endpoint source of truth is the authored rules
under `.bffless/proxy-rules/` — `handoff/` (the `/api/*` app backend) and
`handoff-rss-feed/` (the public `/feed/*` feeds). Each route is a
`rules/**/rule.yaml` whose path mirrors the URL. Outside a clone (or for live
state), `get_proxy_rule_set` via a BFFless MCP connection to the instance
works too, but is optional.

## Upload a file (prepare → PUT → register)

1. `POST /api/uploads/prepare` `{filename, contentType, path, parentId}` → `{uploadUrl, storageKey, originalName, …}`
2. `PUT <uploadUrl>` with `Content-Type: <type>` and the raw file bytes (direct to bucket, no key)
3. `POST /api/nodes` `{storageKey, originalName, parentId:"root"|<folderId>, displayName, createdMs}` → `{node}`

- **`path` is required** — Handoff uses a *verbatim* key strategy (structural
  storage), so prepare needs the file's **verbatim content sub-path**: the
  owning folder's path + the filename. At root that is just the filename
  (`report.md`); in a folder it is `<folder path>/<filename>`
  (`Design Docs/Q3/report.md`). In a repo clone this is what
  `contentSubPath(folderPath, filename)` computes in
  `apps/handoff/src/lib/contentPath.ts`. Omitting `path` fails with
  `400 MISSING_KEY` ("expected a path string for verbatim keyStrategy").
- **`parentId`** (`"root"` or a folder id) should match `path`'s folder.
  Sending it to *prepare* lets an in-folder name collision be rejected
  **before** any bytes are minted/PUT, so an existing file is never
  overwritten.
- Pass the `storageKey` prepare returns to register **unchanged** (it is the
  full bucket key).
- `createdMs` is client-supplied epoch ms, e.g. `date +%s%3N`.

Verified root upload (`report.md`): prepare
`{filename:"report.md", contentType:"text/markdown", path:"report.md", parentId:"root"}`
→ PUT bytes to `uploadUrl` → register with the returned `storageKey`.

## Upload renderable HTML (a Site, not a File)

**Registering HTML through `POST /api/nodes` gives a node that never renders.**
The viewer picks its preview from the node *type*, not the mime: `previewFor()`
(`apps/handoff/src/lib/preview.ts`) returns `'site'` only for `type: 'site'`,
and a `text/html` File falls through every branch to `'download'` — the
"Preview unavailable" card. HTML has to be registered as a **Site**:

1. Choose the Site's `name`. It is both the display name and a **path
   segment**, so keep it URL-clean (`ce-v0.2.18-release-review`, not
   `report`). Its content prefix is `contentSubPath(<owning folder path>,
   <name>)` — at root just `<name>`, in a folder `<folder path>/<name>`.
2. For every asset: `POST /api/uploads/prepare`
   `{filename, contentType, path: "<prefix>/<relPath>"}` → `PUT` the bytes.
   Send **no `parentId`** — a Site's assets are bucket objects, not nodes, so
   there is nothing to collide with.
3. `POST /api/sites` `{parentId, name, entry, path: "<prefix>", createdMs}` →
   `{node}` with `type: "site"` and `url` =
   `/api/uploads/content/<path>/<entry>`.

- `entry` is the index document, default `index.html`. The UI's
  `planSiteUpload()` (`apps/handoff/src/lib/site.ts`) picks it the same way:
  root `index.html` if present, else the single `*.html`, else it asks.
- **A lone HTML file can be a Site** — no folder drop needed. Upload it as
  `<prefix>/index.html` and register the Site. This is the API equivalent of
  the UI's "Import as Site" prompt.
- Keep the pretty name out of the path: set a human title with
  `PATCH /api/node/meta` (below) and let `name` stay URL-safe.
- **There is no rename**: `name` and `path` are fixed at creation. To rename,
  re-upload under the new prefix, register a new Site, then delete the old
  node.
- Assets referenced relatively (`assets/app.css`, `../img/x.png`) resolve
  because the whole bundle is stored verbatim under the prefix on the same
  `/api/uploads/content/*` origin (ADR-0001).
- **The entry document must declare `<meta charset="utf-8">`.** Content is
  served as bare `content-type: text/html` — the charset param is dropped even
  if the object was stored with one — so a document without the meta tag falls
  back to windows-1252 and any non-ASCII byte turns to mojibake (`·` → `Â·`).
  Inside the viewer it looks *fine*, because an iframe with no declared charset
  inherits the parent page's UTF-8; the corruption only appears when the
  content URL is opened directly. Check the file (a fragment saved without a
  `<head>` usually lacks it) and prepend
  `<!DOCTYPE html>\n<meta charset="utf-8">` before uploading.

Verified in-folder Site (`reports/ce-v0.2.18-release-review`, single file):
prepare `{filename:"index.html", contentType:"text/html",
path:"reports/ce-v0.2.18-release-review/index.html"}` → PUT → `POST /api/sites`
`{parentId:<reports id>, name:"ce-v0.2.18-release-review", entry:"index.html",
path:"reports/ce-v0.2.18-release-review"}` → renders at
`/blob/reports/ce-v0.2.18-release-review`.

## Other operations

- List a folder: `GET /api/nodes?parentId=<id>` → `{nodes:[…]}` (omit param for root)
- Create folder: `POST /api/folders` `{parentId, name, createdMs}` → `{node}`
- Read a file back: `POST /api/sign` `{path:<storageKey>}` → `{signed:{url,…}}`
- Share a folder: `POST /api/share-links` `{folderId, expiresMs?}` → share link
- Delete: `DELETE /api/node?id=<uuid>` → `{id}` (refuses a non-empty folder with 409)
- Set a File/Site's display title + description (feed-surfaced metadata):
  `PATCH /api/node/meta` `{id, title?, description?}` → `{id, title, description}`
  (needs edit on the parent folder; at least one field required, empty string
  clears it)
- Set a folder's sharing mode or feed exclusion: `PATCH /api/node`
  `{id, mode?: "inheriting"|"restricted", feedExcluded?: boolean}` → `{id, mode}`
  (owner/admin only; at least one field required; 400 invalid, 403 forbidden).
  `inheriting` folders take their ancestors' grants; `restricted` cuts off
  inheritance so access is re-derived from the folder's own grants.

## Permissions (grants)

Per-folder access control — the mechanism behind "content is private-by-default".
In all three calls `folderId` is a folder UUID or the literal `root` (the
caller's "My Files" root).

- List: `GET /api/grants?folderId=<id|root>` → `{grants:[{principalId, principalEmail?, principalType?, principalName?, level}]}`
- Add/update: `POST /api/grants` `{folderId, principalId, principalEmail?, principalType?, principalName?, level: "view"|"edit"}`
  → `{grants:[…]}` — upserts by `principalId`; folder owner or admin only (403 otherwise)
- Revoke: `POST /api/grants/revoke` `{folderId, principalId}` → `{grants:[…]}`
  (owner/admin only)

**User grants**: a traditional per-user grant with `principalId` and
`principalEmail`. The email identifies the user.

**Group grants**: set `principalType: "group"` and `principalName` (the group's
display name, a snapshot at grant time). A group grant matches any *member* of
that CE User Group. The `principalName` is informational; membership is
authoritative and evaluated live per request — removing a user from the group
revokes their access on the next request. Requires the CE release that ships
member-accessible group endpoints; on older CE, group endpoints 404 and group
features degrade gracefully.

The reserved principal `anyone` is what "Public" means: granting it makes the
folder world-viewable. It is always capped at `level: "view"` (the server
silently downgrades `edit`), carries no email, and never has a `principalType`
or `principalName` — publicness can never escalate to edit.

**Group management**:
- Discover groups: `GET /api/groups?search=<query>&limit=<n>` → `{groups:[{id, name, memberCount}]}` (member-accessible picker; blank search lists all up to limit). Used to build a group-selector UI.
- Own memberships: `GET /api/me/groups` → `{groups:[{id, name}]}` (the groups this user belongs to). Both endpoints require the CE release shipping member-accessible group endpoints; 404 on older CE versions.

## Gotchas

- An empty root listing is normal: content is private-by-default; you only see
  what you own or were granted.
- The PUT step is unauthenticated and goes straight to the bucket — do not add
  the key.
- Delete is write-gated and single-node; delete children before parents.
- A `text/html` upload registered via `POST /api/nodes` shows "Preview
  unavailable" — that is the type, not a broken file. Use `POST /api/sites`
  (above).
