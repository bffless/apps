---
name: handoff-api
description: Upload, organize, and share content in this project's Handoff app by calling its BFFless pipeline API directly, reusing the j5s-dev MCP X-API-Key
---

# Handoff API

Handoff (`https://handoff.j5s.dev`) has no app server — its `/api/*` endpoints are a
BFFless proxy rule set. This skill drives them directly as an agent.

## Auth (reuse the MCP key — nothing new to store)

Read the key the j5s-dev MCP already uses, from `~/.claude.json`:

    KEY=$(python3 -c "import json;d=json.load(open('/home/rico/.claude.json'));print([s['headers']['X-API-Key'] for p in d['projects'].values() for n,s in (p.get('mcpServers') or {}).items() if n=='j5s-dev'][0])")

Send it as `X-API-Key` to every `/api/*` call. It authenticates as the project owner, so
content you create is owned by you (the same as uploading in the browser). The PUT-to-bucket
step (below) is the one exception — it is presigned and takes no key.

## Discovery

Endpoint source of truth: the committed `bffless/handoff.proxy-rules.json`. For live state,
`get_proxy_rule_set` via the j5s-dev MCP.

## Upload a file (prepare → PUT → register)

1. `POST /api/uploads/prepare` `{filename, contentType}` → `{uploadUrl, storageKey, originalName, …}`
2. `PUT <uploadUrl>` with `Content-Type: <type>` and the raw file bytes (direct to bucket, no key)
3. `POST /api/nodes` `{storageKey, originalName, parentId:"root"|<folderId>, displayName, createdMs}` → `{node}`

(`createdMs` is client-supplied epoch ms, e.g. `date +%s%3N`.)

## Other operations

- List a folder: `GET /api/nodes?parentId=<id>` → `{nodes:[…]}` (omit param for root)
- Create folder: `POST /api/folders` `{parentId, name, createdMs}` → `{node}`
- Read a file back: `POST /api/sign` `{path:<storageKey>}` → `{signed:{url,…}}`
- Share a folder: `POST /api/share-links` `{folderId, expiresMs?}` → share link
- Delete: `DELETE /api/node?id=<uuid>` → `{id}` (refuses a non-empty folder with 409)

## Gotchas

- An empty root listing is normal: content is private-by-default; you only see what you own
  or were granted.
- The PUT step is unauthenticated and goes straight to the bucket — do not add the key.
- Delete is write-gated and single-node; delete children before parents.
