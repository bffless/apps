---
name: handoff-api
description: Upload, organize, and share content in this project's Handoff app by calling its BFFless pipeline API directly, authenticating with a BFFless API key (X-API-Key)
---

# Handoff API

Handoff (`https://handoff.j5s.dev`) has no app server — its `/api/*` endpoints are a
BFFless proxy rule set. This skill drives them directly as an agent.

## Auth (send a BFFless API key as X-API-Key)

Every `/api/*` call needs a BFFless API key for this project, sent as the `X-API-Key` header.
Source it whichever way fits your agent runtime (this skill is not Claude-specific):

1. **`BFFLESS_API_KEY` env var** (works in any runtime — Claude Code, Copilot, Gemini CLI, Codex):

       curl -H "X-API-Key: $BFFLESS_API_KEY" https://handoff.j5s.dev/api/nodes

2. **Reuse an already-configured BFFless MCP key** (nothing new to store). Read it from your
   runtime's MCP config. On **Claude Code** that's `~/.claude.json`; the MCP entry *name* is
   arbitrary, so match it by its `url` (this project's admin endpoint `https://admin.j5s.dev/mcp`):

       KEY=$(python3 -c "import os,json;d=json.load(open(os.path.expanduser('~/.claude.json')));print(next(s['headers']['X-API-Key'] for p in d.get('projects',{}).values() for s in (p.get('mcpServers') or {}).values() if s.get('url','').rstrip('/').endswith('admin.j5s.dev/mcp')))")

   Other runtimes (Copilot, Gemini CLI, Codex) keep MCP config elsewhere — read the key from
   wherever yours stores it, or just set `BFFLESS_API_KEY`.

The key authenticates as the project owner, so content you create is owned by you (the same as
uploading in the browser). The PUT-to-bucket
step (below) is the one exception — it is presigned and takes no key.

## Discovery

Endpoint source of truth: the committed `bffless/handoff.proxy-rules.json`. For live state,
`get_proxy_rule_set` via the BFFless MCP.

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
