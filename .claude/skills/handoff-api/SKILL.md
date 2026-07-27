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

- List: `GET /api/grants?folderId=<id|root>` → `{grants:[{principalId, principalEmail, level}]}`
- Add/update: `POST /api/grants` `{folderId, principalId, principalEmail?, level: "view"|"edit"}`
  → `{grants:[…]}` — upserts by `principalId`; folder owner or admin only (403 otherwise)
- Revoke: `POST /api/grants/revoke` `{folderId, principalId}` → `{grants:[…]}`
  (owner/admin only)

The reserved principal `anyone` is what "Public" means: granting it makes the
folder world-viewable. It is always capped at `level: "view"` (the server
silently downgrades `edit`) and carries no email — publicness can never
escalate to edit.

## Gotchas

- An empty root listing is normal: content is private-by-default; you only see
  what you own or were granted.
- The PUT step is unauthenticated and goes straight to the bucket — do not add
  the key.
- Delete is write-gated and single-node; delete children before parents.
