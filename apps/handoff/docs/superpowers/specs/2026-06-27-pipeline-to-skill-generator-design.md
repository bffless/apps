# Pipeline-to-Skill generator + Handoff API skill — design

**Date:** 2026-06-27
**Status:** Approved (brainstorm), pending spec review

## Problem

We want to give an AI agent persistent, low-friction access to call a BFFless app's
dynamic API — for Handoff specifically, "upload a file the same way I can." Handoff has
no app server: its `/api/*` endpoints are a BFFless **proxy rule set** (handler-chain
pipelines). The agent therefore needs (a) a credential that authenticates against those
dynamic pipeline endpoints and (b) knowledge of how to drive them (multi-step flows,
field names, gotchas).

Rather than solve this once for Handoff, we want a **repeatable factory**: as a developer
builds a feature and creates its pipeline, they run a generator that reads the proxy rule
set and writes a project-scoped skill documenting how to call it.

## Key findings (verified)

- **CE authenticates an API key on the dynamic proxy-pipeline path.**
  `repos/ce/apps/backend/src/proxy-rules/proxy.middleware.ts` → `getOptionalUser()` →
  `tryApiKeyAuth()` resolves an `X-API-Key` header to `{ id: matchedKey.userId, role: 'user' }`.
- **Uploads are owned by the authenticated identity.** The Handoff register pipeline
  (`POST /api/nodes`) sets `ownerId` from `user.id` server-side.
- **The MCP key is reusable; no new credential needed.** The `j5s-dev` MCP is the CE MCP
  server (`https://admin.j5s.dev/mcp`), configured in `~/.claude.json` at
  `mcpServers.j5s-dev.headers.X-API-Key` (a `wsa_…` key, user `8ffcde87`, owner of
  `bffless/apps`). The same identity a browser login uses → "act-as-you" is automatic.
- **Proven end-to-end:** `GET https://handoff.j5s.dev/api/nodes` with that key returns
  `HTTP 200 {"nodes":[]}` (empty root = ACL private-by-default; nothing owned at root yet).
- **A pipeline definition is under-specified for a skill:** rules expose `method`+`path`
  but not input schemas (only `request.body.X` references in handler code), not
  cross-endpoint flows (presigned upload spans prepare → external bucket PUT → register),
  and not semantics/gotchas. So generation is **LLM synthesis over structured facts +
  handler-pattern recognition**, not deterministic codegen.

## Architecture

Two artifacts with a clean platform/project split:

| Artifact | Lives in | Scope |
| --- | --- | --- |
| **Generator skill** (`pipeline-to-skill`) | `repos/skills/plugins/bffless/skills/pipeline-to-skill/SKILL.md` | Platform (published `bffless/skills` plugin) |
| **Generated skill** (`handoff-api`) | `repos/apps/apps/handoff/.claude/skills/handoff-api/SKILL.md` | Project (travels with the giveaway app) |

The generated skill is a Claude Code repo-scoped skill (`.claude/skills/…`), distinct from
the `.bffless/skills/…` convention (those bundle into the deployed app's chat feature).

## Deliverable 1 — Generated skill: `handoff-api` (golden example)

Hand-authored first to lock the target shape. Sections:

1. **When to use** — upload/organize/share content in *this project's* Handoff
   (`https://handoff.j5s.dev`).
2. **Auth** — reuse the `j5s-dev` MCP key from `~/.claude.json`
   (`mcpServers.j5s-dev.headers.X-API-Key`); send as `X-API-Key` to `…/api/*`;
   authenticates as the project owner, so content is owned by the user. No new credential.
3. **Discovery** — endpoint source of truth is the committed
   `bffless/handoff.proxy-rules.json`; `get_proxy_rule_set` via MCP for live state.
4. **Upload recipe** (verified against `src/store/handoffApi.ts` + `src/lib/nodes.ts`):
   1. `POST /api/uploads/prepare` `{filename, contentType}` →
      `{uploadUrl, storageKey, originalName, …}`
   2. `PUT <uploadUrl>` with `Content-Type` + raw bytes — direct to bucket, unauthenticated
   3. `POST /api/nodes` `{storageKey, originalName, parentId:"root"|<folderId>, displayName,
      createdMs}` → `{node}`
5. **Other ops** — `GET /api/nodes?parentId=` (list), `POST /api/folders` (create folder),
   `POST /api/sign` (presigned GET to read back), `POST /api/share-links` (share),
   `DELETE /api/node?id=` (delete).
6. **Gotchas** — empty root listing is normal (private-by-default; you only see what you
   own/are granted); the PUT step is unauthenticated/direct-to-bucket; `createdMs` is
   client-supplied epoch ms.

**Verification:** one real round-trip as the user — create a `handoff-agent-test` folder,
upload a tiny file, list it, then delete both — confirming the skill's recipes are correct.

## Deliverable 2 — Generator skill: `pipeline-to-skill`

A platform skill instructing an agent to turn a proxy rule set into a project skill:

1. **Acquire the rule set** — primary: the committed `<app>.proxy-rules.json` export in the
   repo; fallback: `get_proxy_rule_set` via the BFFless MCP for live state.
2. **Extract** — endpoints (`method` + `pathPattern`); scrape `request.body.*` /
   `request.query.*` references from handler code to build per-endpoint param-name lists.
3. **Pattern-match a handler-type library** to emit correct recipes:
   - `presigned_upload` (+ `register_upload`) → the prepare → PUT → register upload recipe
   - `data_create` / `data_query` → CRUD recipes using the referenced schema's fields
   - share-link / signed-url / auth-relay handlers → their known flows
   - generic `function_handler` + `response_handler` → best-effort request/response shape
4. **Bake in the standard auth section** — reuse the `j5s-dev` MCP `X-API-Key`, identity =
   project owner, base URL = the app's attached alias.
5. **Pull repo context** — the app's API client (e.g. `src/store/*Api.ts`) and any
   `CONTEXT.md` glossary, for naming and semantics.
6. **Write** the result to `<project>/.claude/skills/<app>-api/SKILL.md`.

The generator must be able to regenerate the Deliverable-1 `handoff-api` skill from
`handoff.proxy-rules.json` — that round-trip is its acceptance test.

## Out of scope (future)

- **CE enhancement:** optional `inputSchema` / description metadata on proxy rules so the
  generator reads *declared* schemas instead of scraping handler code — makes generation
  precise and deterministic. Its own spec when pursued. (First-class CE enhancement per
  workspace rules.)
- A dedicated/expiring API key, a separate "agent" user, or a new Handoff-specific MCP
  server — all rejected in favor of reusing the existing MCP credential.

## Risks / caveats

- **Key-extraction coupling:** the auth section reads `~/.claude.json`'s Claude Code format.
  If the MCP key is rotated or the file restructured, the generated skill's "read the key
  here" step needs updating. Acceptable for a personal project skill.
- **Scrape fidelity:** param *names* are recoverable from handler code, but not types or
  required/optional. The handler-pattern library covers the high-value flows; the generic
  fallback is best-effort and should be clearly marked as such in generated output.
- **Discovery permission:** the `get_proxy_rule_set` fallback requires the key's owner to
  have project read access (true here). The committed-JSON primary path avoids this.
