# Handoff Raw-File Link (`/r/{fileId}?token=`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GET /r/{fileId}?token=` handoff proxy rule that validates a folder-scoped share token and **302-redirects to a presigned raw-file URL**, so any dumb client gets the bytes in one request; switch the app's "Copy link" to produce that URL.

**Architecture:** Pure proxy-rule change in `apps/handoff/bffless/handoff.proxy-rules.json` (no CE/backend/schema/acl code), reusing existing handler types (`function_handler`, `data_query`, `signed_url`, `response_handler`) and the `folderChain` ancestor-walk verbatim. Plus a one-line frontend change to `shareLinkCopyUrl`. Going live (importing the rule set to j5s.dev) is a separate, approval-gated step.

**Tech Stack:** BFFless proxy-rule pipelines (JSON + embedded JS), React 19 + TS, Vitest. The proxy-rule *logic* runs only in CE's live pipeline runner, so it's validated structurally in-repo (a JSON guard test) and behaviorally against the live project after apply.

## Global Constraints

- **No CE/backend, schema, or `acl.ts` changes.** Only `handoff.proxy-rules.json` + `src/lib/share.ts` (+ tests).
- **Endpoint:** `GET /r/{fileId}?token={t}` → `302` `Location: <presigned url>` on success; **`404`** (no body hint) for any denial (bad/expired/revoked token, file not under the token's folder, non-file node, missing storage path).
- **The one security check:** the node for `fileId` must have the token's `folderId` in its `folderChain(folders, node.parentId)` ancestor chain. Token stays folder-scoped — no per-file ACL.
- **Presign TTL = `"300"`** (string, seconds). Token re-validated every request.
- **Frontend:** `shareLinkCopyUrl(origin, link, nodeId)` file-mode output becomes `${origin}/r/${nodeId}?token=${link.token}` (was `/view/...`). `/view/{id}?token=` viewer stays functional.
- **App dir (run pnpm here):** `/home/rico/bffless/repos/apps/apps/handoff`. Proxy-rules file: `apps/handoff/bffless/handoff.proxy-rules.json`. Git root `/home/rico/bffless/repos/apps`; already on branch `feat/handoff-raw-file-link` (do NOT create a branch). Commit per task (pre-approved).
- **JSON formatting:** the file round-trips exactly with Python `json.dump(d, indent=2, ensure_ascii=False)` + a trailing newline — use that to keep the diff to just the new rule.
- **Reused IDs (verbatim):** `handoff_nodes` schemaId `1c5d4802-596e-4f50-a08f-c41fb8f9fab0`; `handoff_share_links` schemaId `ace1febf-4b3d-4a11-a5f8-22a056dd9afa`. Node record fields: `parentId`, `nodeType`, `storage_path`, `grantsJson`, `ownerId`, `mode`.

---

### Task 1: Add the `/r/{fileId}` proxy rule

**Files:**
- Modify: `apps/handoff/bffless/handoff.proxy-rules.json` (append one rule to `rules`)
- Test: `apps/handoff/src/lib/rawFileRule.test.ts` (new — structural guard)

**Interfaces:**
- Produces: a `GET /r/*` pipeline rule with steps `parse, link, node, folders, check, sign, ok, bad`. Consumed behaviorally by clients; structurally by the guard test.
- The embedded-JS logic can't run in-repo (needs CE's runner); this task's automated gate is JSON validity + the structural test. Behavior is validated in Task 3 (live).

- [ ] **Step 1: Write the failing structural test** — create `apps/handoff/src/lib/rawFileRule.test.ts`:

```ts
/**
 * Structural guard for the /r raw-file proxy rule. The embedded-JS logic runs
 * only in CE's pipeline runner (validated live in Task 3); this asserts the
 * rule is present and wired the way the spec requires.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

const rule = proxy.rules.find((r) => r.pathPattern === '/r/*' && r.method === 'GET')

describe('handoff /r raw-file proxy rule', () => {
  it('exists as an enabled pipeline rule', () => {
    expect(rule).toBeTruthy()
    expect(rule!.proxyType).toBe('pipeline')
    expect(rule!.isEnabled).toBe(true)
  })

  it('has the expected pipeline steps in order', () => {
    const ids = rule!.pipelineConfig.steps.map((s: any) => s.id)
    expect(ids).toEqual(['parse', 'link', 'node', 'folders', 'check', 'sign', 'ok', 'bad'])
  })

  it('looks up the share link and node with the known schema ids', () => {
    const link = rule!.pipelineConfig.steps.find((s: any) => s.id === 'link')
    const node = rule!.pipelineConfig.steps.find((s: any) => s.id === 'node')
    expect(link.config.schemaId).toBe('ace1febf-4b3d-4a11-a5f8-22a056dd9afa')
    expect(link.config.recordId).toBe('steps.parse.token')
    expect(node.config.schemaId).toBe('1c5d4802-596e-4f50-a08f-c41fb8f9fab0')
    expect(node.config.recordId).toBe('steps.parse.fileId')
  })

  it('signs only when allowed, with a 300s TTL on the check storagePath', () => {
    const sign = rule!.pipelineConfig.steps.find((s: any) => s.id === 'sign')
    expect(sign.handlerType).toBe('signed_url')
    expect(sign.config.condition).toBe('steps.check.allow')
    expect(sign.config.path).toBe('steps.check.storagePath')
    expect(sign.config.expiresIn).toBe('300')
  })

  it('302s to the presigned Location on allow, 404 on deny', () => {
    const ok = rule!.pipelineConfig.steps.find((s: any) => s.id === 'ok')
    const bad = rule!.pipelineConfig.steps.find((s: any) => s.id === 'bad')
    expect(ok.config.status).toBe(302)
    expect(ok.config.headers.Location).toBe('{{steps.sign.url}}')
    expect(ok.config.condition).toBe('steps.check.allow')
    expect(bad.config.status).toBe(404)
    expect(bad.config.condition).toBe('steps.check.deny')
  })

  it('the check step enforces the folder-chain membership (folderChain present)', () => {
    const check = rule!.pipelineConfig.steps.find((s: any) => s.id === 'check')
    expect(check.handlerType).toBe('function_handler')
    expect(check.config.code).toContain('function folderChain')
    expect(check.config.code).toContain('inFolder')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/lib/rawFileRule.test.ts`
Expected: FAIL — `rule` is `undefined` (no `/r/*` rule yet).

- [ ] **Step 3: Append the rule with an insertion script.** Create `/tmp/add_r_rule.py` with exactly this content and run it (`python3 /tmp/add_r_rule.py`). Using a script avoids hand-escaping the embedded JS into JSON:

```python
import json, io

PATH = "apps/handoff/bffless/handoff.proxy-rules.json"  # run from repo root /home/rico/bffless/repos/apps

PARSE = (
  "function handler({ request }) { "
  "var p = (request && request.path) || ''; var marker = '/r/'; "
  "var i = p.indexOf(marker); var rest = (i >= 0) ? p.slice(i + marker.length) : ''; "
  "var qm = rest.indexOf('?'); if (qm >= 0) rest = rest.slice(0, qm); "
  "var slash = rest.indexOf('/'); var fileId = (slash >= 0) ? rest.slice(0, slash) : rest; "
  "try { fileId = decodeURIComponent(fileId); } catch (e) {} "
  "var query = (request && request.query) || {}; var token = String(query.token || ''); "
  "var UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/; "
  "var hasBoth = UUID.test(fileId) && UUID.test(token); "
  "return { fileId: fileId, token: token, hasBoth: hasBoth }; }"
)

CHECK = (
  "function handler({ steps }) { "
  "var UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/; "
  "function folderChain(folders,startId){ var byId={};for(var a=0;a<folders.length;a++){var f=folders[a]||{};var id=f.id||f.recordId||f.record_id;if(id)byId[id]=f;} "
  "var rev=[];var cur=String(startId||'');var g=0; "
  "while(cur&&UUID.test(cur)&&byId[cur]&&g<64){var n=byId[cur];var gr=n.grantsJson;if(typeof gr==='string'){try{gr=JSON.parse(gr);}catch(e){gr=[];}}if(!gr||Object.prototype.toString.call(gr)!=='[object Array]')gr=[];rev.push({id:cur,ownerId:n.ownerId||null,grants:gr,mode:n.mode==='restricted'?'restricted':'inheriting'});cur=n.parentId||'';g++;} "
  "var ch=[];for(var b=rev.length-1;b>=0;b--)ch.push(rev[b]);return ch; } "
  "var link=(steps&&steps.link)||{}; if(link==null||typeof link!=='object')link={}; "
  "var folderId=link.folderId||null; var revoked=link.revoked===true||link.revoked==='true'; "
  "var exp=(link.expiresMs!=null)?Number(link.expiresMs):null; var expired=(exp!=null&&!isNaN(exp))?(Date.now()>exp):false; "
  "var tokenOk=!!folderId&&!revoked&&!expired; "
  "var node=(steps&&steps.node)||{}; if(node==null||typeof node!=='object')node={}; "
  "var storagePath=node.storage_path||''; var isFile=node.nodeType==='file'; var nodeOk=isFile&&!!storagePath; "
  "var inFolder=false; if(tokenOk&&nodeOk){var folders=(steps&&steps.folders)||[];if(Object.prototype.toString.call(folders)!=='[object Array]')folders=[];var ch=folderChain(folders,node.parentId);for(var i=0;i<ch.length;i++){if(ch[i].id===folderId){inFolder=true;break;}}} "
  "var allow=tokenOk&&nodeOk&&inFolder; "
  "return { allow: allow, deny: !allow, storagePath: allow?storagePath:'' }; }"
)

rule = {
  "pathPattern": "/r/*",
  "method": "GET",
  "targetUrl": "pipeline",
  "stripPrefix": False,
  "order": 19,
  "timeout": 30000,
  "proxyType": "pipeline",
  "pipelineConfig": {
    "name": "Handoff raw file redirect",
    "steps": [
      {"id": "parse", "name": "parse", "config": {"code": PARSE}, "handlerType": "function_handler"},
      {"id": "link", "name": "link", "config": {"recordId": "steps.parse.token", "schemaId": "ace1febf-4b3d-4a11-a5f8-22a056dd9afa", "condition": "steps.parse.hasBoth"}, "handlerType": "data_query"},
      {"id": "node", "name": "node", "config": {"recordId": "steps.parse.fileId", "schemaId": "1c5d4802-596e-4f50-a08f-c41fb8f9fab0", "condition": "steps.parse.hasBoth"}, "handlerType": "data_query"},
      {"id": "folders", "name": "folders", "config": {"filters": {"nodeType": {"op": "eq", "value": "folder"}}, "pageSize": 500, "schemaId": "1c5d4802-596e-4f50-a08f-c41fb8f9fab0", "condition": "steps.parse.hasBoth"}, "handlerType": "data_query"},
      {"id": "check", "name": "check", "config": {"code": CHECK}, "handlerType": "function_handler"},
      {"id": "sign", "name": "sign", "config": {"path": "steps.check.storagePath", "condition": "steps.check.allow", "expiresIn": "300"}, "handlerType": "signed_url"},
      {"id": "ok", "name": "ok", "config": {"body": "", "status": 302, "headers": {"Location": "{{steps.sign.url}}"}, "condition": "steps.check.allow", "contentType": "text/plain"}, "handlerType": "response_handler"},
      {"id": "bad", "name": "bad", "config": {"body": "Not found", "status": 404, "condition": "steps.check.deny", "contentType": "text/plain"}, "handlerType": "response_handler"},
    ],
  },
  "isEnabled": True,
  "description": "Validate a folder-scoped share token and 302-redirect to a presigned raw file URL (one-request access).",
}

d = json.load(open(PATH))
if any(r.get("pathPattern") == "/r/*" and r.get("method") == "GET" for r in d["rules"]):
    raise SystemExit("rule already present")
d["rules"].append(rule)
with io.open(PATH, "w", encoding="utf-8") as f:
    f.write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
print("appended /r/* rule; rules now:", len(d["rules"]))
```

Run: `cd /home/rico/bffless/repos/apps && python3 /tmp/add_r_rule.py`
Expected: `appended /r/* rule; rules now: 18`

- [ ] **Step 4: Verify JSON is valid + only the rule was added + the test passes**

Run: `cd /home/rico/bffless/repos/apps && python3 -c "import json; json.load(open('apps/handoff/bffless/handoff.proxy-rules.json')); print('json ok')" && git -C . diff --stat apps/handoff/bffless/handoff.proxy-rules.json`
Expected: `json ok`, and the diff touches only that file.

Run: `cd /home/rico/bffless/repos/apps/apps/handoff && pnpm exec vitest run src/lib/rawFileRule.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/bffless/handoff.proxy-rules.json apps/handoff/src/lib/rawFileRule.test.ts
git commit -m "feat(handoff): add /r/{fileId}?token= raw-file 302 proxy rule"
```

---

### Task 2: Point "Copy link" at `/r/`

**Files:**
- Modify: `apps/handoff/src/lib/share.ts` (`shareLinkCopyUrl`)
- Modify: `apps/handoff/src/lib/share.test.ts` (the file-mode case)

**Interfaces:**
- `shareLinkCopyUrl(origin, link, nodeId)` — file-mode (nodeId present) now returns `${origin}/r/${nodeId}?token=${link.token}`. All copy surfaces (per-file row, post-upload prompt, viewer popover, listed-link display) consume this unchanged.

- [ ] **Step 1: Update the failing test first.** In `apps/handoff/src/lib/share.test.ts`, change the file-mode expectation from `/view/` to `/r/`:

```ts
  it('builds a file-direct URL when nodeId is provided', () => {
    expect(shareLinkCopyUrl('https://h.dev', link({ token: 'abc' }), 'n9')).toBe('https://h.dev/r/n9?token=abc')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/rico/bffless/repos/apps/apps/handoff && pnpm exec vitest run src/lib/share.test.ts`
Expected: FAIL — still returns `/view/n9?token=abc`.

- [ ] **Step 3: Make the change.** In `apps/handoff/src/lib/share.ts`, change the file-mode branch of `shareLinkCopyUrl`:

```ts
export function shareLinkCopyUrl(
  origin: string,
  link: { token: string; url: string },
  nodeId?: string,
): string {
  return nodeId ? `${origin}/r/${nodeId}?token=${link.token}` : `${origin}${link.url}`
}
```

Also update the JSDoc above it so it says the file-mode URL is the raw one-request `/r/` redirect (not `/view/`).

- [ ] **Step 4: Run the full gate**

Run: `cd /home/rico/bffless/repos/apps/apps/handoff && pnpm exec tsc -b && pnpm lint && pnpm test:run`
Expected: tsc clean, lint clean, all tests pass (the `/r/` expectation now green; `rawFileRule` test green).

- [ ] **Step 5: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/lib/share.ts apps/handoff/src/lib/share.test.ts
git commit -m "feat(handoff): Copy link now produces the raw /r/{id}?token= URL"
```

---

### Task 3: Go-live validation (controller-run, approval-gated — NOT a subagent task)

**Files:** none (apply + integration). This task is run by the controller, not delegated, because it mutates the **live** handoff project on j5s.dev.

- [ ] **Step 1: Local sanity** — confirm the rule is valid and the structural test passes (already covered by Task 1; re-confirm): `cd /home/rico/bffless/repos/apps/apps/handoff && pnpm exec vitest run src/lib/rawFileRule.test.ts`.

- [ ] **Step 2: STOP — get explicit user approval to apply to the live project.** Applying changes live tenant behavior on j5s.dev. Present the diff summary and ask before proceeding.

- [ ] **Step 3: Apply the rule to the live handoff proxy-rule set.** Using the `j5s-dev` MCP: find the handoff alias's proxy-rule set, add the new `GET /r/*` pipeline rule (mirror the JSON from Task 1) — via `create_proxy_rule` into the existing set (or re-import the set). Confirm it's attached + enabled.

- [ ] **Step 4: Dogfood — integration tests via curl (one URL, cold client).** Using a real folder share token + a file id under it:
  - `curl -sI "https://handoff.j5s.dev/r/{fileId}?token={validToken}"` → `302` with a `Location:` header.
  - `curl -sL "https://handoff.j5s.dev/r/{fileId}?token={validToken}" -o /tmp/r.out` → the file bytes (verify size/type).
  - `curl -sI "https://handoff.j5s.dev/r/{fileId}?token=00000000-0000-0000-0000-000000000000"` → `404`.
  - `curl -sI "https://handoff.j5s.dev/r/{foreignFileId}?token={validToken}"` (a file NOT under the token's folder) → `404`.
  - Read the downloaded bytes to confirm it's the expected file.

- [ ] **Step 5: Report results.** Send the user the curl outcomes (and a screenshot if it's an image). No commit (validation only). If a behavior is wrong (field name, path parsing, conditional signing), fix `handoff.proxy-rules.json` (re-run Task 1's script logic / edit), re-apply, re-test.

---

## Notes for the executor

- **Why a JSON guard test, not logic tests:** the `function_handler` JS executes only in CE's pipeline runner. The repo test asserts the rule is present and correctly wired (schema ids, conditions, 302/404, folder-chain code present). Real behavior is proven live in Task 3.
- **Field names** (`storage_path`, `nodeType`, `parentId`, `grantsJson`) are copied from the existing `/api/sign`, `/api/node`, and gate rules — if Task 3 shows an empty `storagePath` or a wrong chain, re-check these against a live node record and the existing rules.
- **`stripPrefix: false`** so the pipeline sees the full `/r/{fileId}` path for the regex parse. If Task 3 shows `fileId` empty, log `request.path` in the `parse` step to confirm what the runner passes.
- **Do not** touch CE, schema, or `acl.ts`. The token stays folder-scoped.
