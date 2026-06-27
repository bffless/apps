# Pipeline-to-Skill Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable "pipeline-to-skill" generator (published in `repos/skills/`) that turns a BFFless proxy rule set into a project-scoped Claude Code skill, and produce its first output — a `handoff-api` skill that lets an agent drive Handoff's API using the existing MCP credential.

**Architecture:** Two coupled artifacts. (1) A hand-authored `handoff-api` skill in the Handoff app repo — the *golden example* defining the target output shape, verified by a live API round-trip. (2) A `pipeline-to-skill` generator skill in the published `bffless/skills` plugin that reproduces (1) from `handoff.proxy-rules.json` and generalizes to any BFFless app. Build the golden example first, then the generator, using regeneration of the golden as the generator's acceptance test.

**Tech Stack:** Markdown `SKILL.md` files (frontmatter: `name`, `description`). BFFless proxy-rule pipelines reached over HTTPS with an `X-API-Key`. Verification via `curl` + the `j5s-dev` MCP key. No code, no CE changes.

## Global Constraints

- **SKILL.md frontmatter is exactly `name` + `description`** (mirror `repos/skills/plugins/bffless/skills/pipelines/SKILL.md`). `name` = kebab-case dir name.
- **Reuse the existing credential — never store a new one.** The key is read at call time from `~/.claude.json` → `mcpServers.j5s-dev.headers.X-API-Key`. **Never write the key value into any committed file.**
- **Handoff base URL:** `https://handoff.j5s.dev`. Endpoints are under `/api/*`.
- **Identity:** the MCP key authenticates as user `8ffcde87` (owner of `bffless/apps`); uploads are owned by that identity ("act-as-you").
- **No CE changes, no new MCP server, no separate user.** Proxy-rule `inputSchema` metadata is explicitly future work.
- **Git:** `repos/apps` and `repos/skills` are independent git repos — `cd` into the correct one before any git command. **Per workspace rules, pause and ask the user before every commit; never push without approval; work on a branch, not the default branch.**
- **Key-extraction snippet** (used in verification steps):
  ```bash
  KEY=$(python3 -c "import json;d=json.load(open('/home/rico/.claude.json'));print([s['headers']['X-API-Key'] for p in d['projects'].values() for n,s in (p.get('mcpServers') or {}).items() if n=='j5s-dev'][0])")
  ```

---

### Task 1: Hand-author the `handoff-api` generated skill (golden example)

**Files:**
- Create: `repos/apps/apps/handoff/.claude/skills/handoff-api/SKILL.md`
- Read for accuracy: `repos/apps/apps/handoff/src/store/handoffApi.ts`, `repos/apps/apps/handoff/src/lib/nodes.ts`, `repos/apps/apps/handoff/bffless/handoff.proxy-rules.json`, `repos/apps/apps/handoff/CONTEXT.md`

**Interfaces:**
- Produces: the canonical skill structure (frontmatter + the 6 sections below) that Task 2's generator must be able to reproduce. The verified endpoint recipes are the contract.

**Verified endpoint reference** (source: `handoffApi.ts` / `nodes.ts` — use these exact shapes):
- `POST /api/uploads/prepare` `{filename, contentType}` → `{uploadUrl, storageKey, originalName, publicPath, storedFilename, expiresIn, expiresAt, maxFileSize, allowedMimeTypes}`
- `PUT <uploadUrl>` header `Content-Type: <type>`, body = raw bytes (direct to bucket, **no X-API-Key**)
- `POST /api/nodes` `{storageKey, originalName, parentId:"root"|<folderId>, displayName, createdMs}` → `{node}`
- `GET /api/nodes?parentId=<id>` → `{nodes:[…]}` (omit param for root)
- `POST /api/folders` `{parentId, name, createdMs}` → `{node}`
- `POST /api/sign` `{path:<storageKey>}` → `{signed:{url,…}}` (presigned GET to read a file back)
- `POST /api/share-links` `{folderId, expiresMs?}` → ShareLink
- `DELETE /api/node?id=<uuid>` → `{id}` (refuses non-empty folder with 409)

- [ ] **Step 1: Write the verification round-trip and confirm it currently has nothing (the "failing" baseline)**

Confirm the live API is reachable as us and the test fixture does not yet exist:
```bash
cd /home/rico/bffless/repos/apps/apps/handoff
KEY=$(python3 -c "import json;d=json.load(open('/home/rico/.claude.json'));print([s['headers']['X-API-Key'] for p in d['projects'].values() for n,s in (p.get('mcpServers') or {}).items() if n=='j5s-dev'][0])")
curl -s -w "\nHTTP %{http_code}\n" "https://handoff.j5s.dev/api/nodes" -H "X-API-Key: $KEY"
```
Expected: `HTTP 200` and a JSON `{"nodes":[…]}` with no folder named `handoff-agent-test`.

- [ ] **Step 2: Write `SKILL.md`**

Create `repos/apps/apps/handoff/.claude/skills/handoff-api/SKILL.md` with frontmatter and these sections (use the verified endpoint reference above verbatim for the recipes):

```markdown
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
```

- [ ] **Step 3: Verify every documented recipe with a live round-trip**

Run the full sequence as us and confirm each call succeeds (use the `KEY` from Step 1):
```bash
cd /home/rico/bffless/repos/apps/apps/handoff
NOW=$(date +%s%3N)
# create folder
curl -s -w "\nHTTP %{http_code}\n" -X POST "https://handoff.j5s.dev/api/folders" -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d "{\"parentId\":\"root\",\"name\":\"handoff-agent-test\",\"createdMs\":$NOW}"
```
Capture the returned folder `id` into `FID`, then:
```bash
echo "hello from the handoff-api skill" > /tmp/claude-1000/-home-rico-bffless/10b54b82-e774-4ec0-8e82-2f74def4164a/scratchpad/hello.txt
# prepare
PREP=$(curl -s -X POST "https://handoff.j5s.dev/api/uploads/prepare" -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"filename":"hello.txt","contentType":"text/plain"}')
echo "$PREP"
UURL=$(echo "$PREP" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadUrl'])")
SKEY=$(echo "$PREP" | python3 -c "import sys,json;print(json.load(sys.stdin)['storageKey'])")
# PUT bytes to bucket (no key)
curl -s -w "\nPUT HTTP %{http_code}\n" -X PUT "$UURL" -H "Content-Type: text/plain" --data-binary @/tmp/claude-1000/-home-rico-bffless/10b54b82-e774-4ec0-8e82-2f74def4164a/scratchpad/hello.txt
# register under the test folder
curl -s -w "\nHTTP %{http_code}\n" -X POST "https://handoff.j5s.dev/api/nodes" -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d "{\"storageKey\":\"$SKEY\",\"originalName\":\"hello.txt\",\"parentId\":\"$FID\",\"displayName\":\"hello.txt\",\"createdMs\":$NOW}"
# list the folder — expect the file present
curl -s -w "\nHTTP %{http_code}\n" "https://handoff.j5s.dev/api/nodes?parentId=$FID" -H "X-API-Key: $KEY"
```
Expected: folder create `HTTP 200` with an `id`; prepare returns `uploadUrl`+`storageKey`; PUT `HTTP 200`/`204`; register `HTTP 200` with a `node`; list shows the `hello.txt` node. If any recipe in `SKILL.md` does not match what actually works, fix `SKILL.md` and re-run.

- [ ] **Step 4: Clean up the test fixture (delete child then folder)**

```bash
# delete the file node (capture its id from the register/list output into NID), then the folder
curl -s -w "\nHTTP %{http_code}\n" -X DELETE "https://handoff.j5s.dev/api/node?id=$NID" -H "X-API-Key: $KEY"
curl -s -w "\nHTTP %{http_code}\n" -X DELETE "https://handoff.j5s.dev/api/node?id=$FID" -H "X-API-Key: $KEY"
```
Expected: both `HTTP 200` with `{"id":…}`. Re-list root and confirm `handoff-agent-test` is gone.

- [ ] **Step 5: Commit (ask the user first)**

```bash
cd /home/rico/bffless/repos/apps
# branch if on default; then:
git add apps/handoff/.claude/skills/handoff-api/SKILL.md
git commit -m "feat(handoff): add handoff-api agent skill (golden example)"
```

---

### Task 2: Write the `pipeline-to-skill` generator skill

**Files:**
- Create: `repos/skills/plugins/bffless/skills/pipeline-to-skill/SKILL.md`
- Modify: `repos/skills/README.md` (add a row to the skills table)
- Reference (acceptance test input/target): `repos/apps/apps/handoff/bffless/handoff.proxy-rules.json` and the Task 1 `handoff-api/SKILL.md`

**Interfaces:**
- Consumes: the Task 1 `handoff-api/SKILL.md` as the regeneration target.
- Produces: a generator skill whose instructions, when followed against `handoff.proxy-rules.json`, yield a skill equivalent to Task 1's (same auth section, same endpoints, same upload recipe).

- [ ] **Step 1: Write `SKILL.md`**

Create `repos/skills/plugins/bffless/skills/pipeline-to-skill/SKILL.md`:

```markdown
---
name: pipeline-to-skill
description: Generate a project-scoped Claude Code skill from a BFFless proxy rule set so an agent can call the app's dynamic API
---

# Pipeline to Skill

Turn a BFFless app's proxy rule set (its `/api/*` pipelines) into a `.claude/skills/<app>-api/SKILL.md`
that teaches an agent how to call it. The output lives in the *app's* repo; this generator is
platform knowledge.

## Inputs

1. **Rule set** — prefer the committed export `<app>.proxy-rules.json` in the app repo; else
   fetch live with `get_proxy_rule_set` via the BFFless MCP.
2. **App repo context** — the API client (e.g. `src/store/*Api.ts`) and any `CONTEXT.md`
   glossary, for accurate names, request bodies, and multi-step flows.

## Steps

1. **Enumerate endpoints** — for each rule read `method` + `pathPattern`.
2. **Recover params** — scrape `request.body.*` / `request.query.*` references from each rule's
   `function_handler`/handler config to list parameter names. (Names only — mark types unknown.)
3. **Match handler patterns → recipes:**
   - `presigned_upload` (+ `register_upload`): emit the upload recipe — `prepare` → `PUT <uploadUrl>`
     (direct to bucket, no key) → register node. Cross-reference the app client to confirm the
     register body, since this flow is not visible in any single rule.
   - `data_create` / `data_query`: CRUD recipe using the referenced schema's fields.
   - share-link / signed-url / auth-relay handlers: document their known request/response flow.
   - generic `function_handler` + `response_handler`: best-effort request/response shape, clearly
     marked as inferred.
4. **Write the standard auth section** (identical for every BFFless app):
   reuse the j5s-dev MCP `X-API-Key` from `~/.claude.json`
   (`mcpServers.j5s-dev.headers.X-API-Key`); send as `X-API-Key`; identity = project owner;
   base URL = the app's attached alias. Never store a new credential or write the key into the file.
5. **Assemble** sections: front-matter (`name: <app>-api`), intro, Auth, Discovery, one recipe
   per significant endpoint, Gotchas (note private-by-default ACL and presigned/no-key steps).
6. **Write** to `<app-repo>/.claude/skills/<app>-api/SKILL.md`.

## Self-check

Read back the generated skill and confirm: every endpoint in the rule set is represented or
intentionally omitted; multi-step flows (uploads) are whole recipes, not single calls; the auth
section is present and stores nothing new.
```

- [ ] **Step 2: Acceptance test — regenerate the golden skill from a clean context**

Dispatch a fresh subagent (general-purpose) with **only** the generator skill instructions and access to the Handoff repo, asking it to generate `handoff-api` from `repos/apps/apps/handoff/bffless/handoff.proxy-rules.json` into a scratch path:
```
/tmp/claude-1000/-home-rico-bffless/10b54b82-e774-4ec0-8e82-2f74def4164a/scratchpad/handoff-api-regenerated/SKILL.md
```

- [ ] **Step 3: Diff the regenerated skill against the golden and reconcile**

```bash
diff /tmp/claude-1000/-home-rico-bffless/10b54b82-e774-4ec0-8e82-2f74def4164a/scratchpad/handoff-api-regenerated/SKILL.md /home/rico/bffless/repos/apps/apps/handoff/.claude/skills/handoff-api/SKILL.md
```
Expected: equivalent content — same auth section, same endpoints, the upload recipe present as a 3-step flow. Wording may differ; substance must match. If the generator missed something (e.g. collapsed the upload into one call, or omitted the no-key PUT caveat), fix `pipeline-to-skill/SKILL.md` and repeat Steps 2-3 until it reproduces the golden.

- [ ] **Step 4: Add the generator to the skills README table**

Modify `repos/skills/README.md` — add a row to the skills table (match existing format):
```markdown
| pipeline-to-skill | Generate a project-scoped skill from a BFFless proxy rule set |
```
(Match the table's exact columns; do not bump version files — release-please manages versions.)

- [ ] **Step 5: Commit (ask the user first)**

```bash
cd /home/rico/bffless/repos/skills
# branch if on default; then:
git add plugins/bffless/skills/pipeline-to-skill/SKILL.md README.md
git commit -m "feat: add pipeline-to-skill generator"
```

---

## Self-Review

**Spec coverage:**
- Reused-MCP-credential auth → Task 1 Step 2 (Auth section) + Global Constraints. ✓
- Verified upload recipe (prepare→PUT→register) → Task 1 Steps 2-3. ✓
- Other ops (list/folder/sign/share/delete) → Task 1 Step 2 + verification Steps 3-4. ✓
- Generated skill location `.claude/skills/handoff-api/` → Task 1 Files. ✓
- Generator in `repos/skills/` with handler-pattern library + auth bake-in + repo context → Task 2 Step 1. ✓
- Golden-example-first sequencing → Task 1 before Task 2; regeneration acceptance test → Task 2 Steps 2-3. ✓
- CE `inputSchema` enhancement = out of scope → Global Constraints. ✓

**Placeholder scan:** Endpoint shapes, request bodies, curl commands, and SKILL.md bodies are all concrete. No TBD/TODO. ✓

**Type/name consistency:** `handoff-api` (generated skill name), `pipeline-to-skill` (generator name), `X-API-Key` header, `storageKey`/`parentId`/`createdMs` field names are used identically across both tasks. ✓
