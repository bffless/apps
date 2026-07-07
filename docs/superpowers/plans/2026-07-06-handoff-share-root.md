# Handoff — Share the Root Folder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the root folder ("My Files") fully shareable — public share link *and* per-person grants — by materializing one singleton root node and resolving the `'root'` sentinel to it in the mint/grants pipelines and the ACL chain-building gates.

**Architecture:** Root is a synthetic sentinel (`'root'`) with no `handoff_nodes` record, so every share/grant/ACL path that keys off a node id breaks or excludes it. We add one singleton record `R` (`nodeType:'root'`), lazily created on the first share, and resolve `'root'`→`R` in exactly three backend concerns (mint, grants, chain-building) plus the frontend Share dialog + ACL chain. No tree migration; normal navigation keeps using `'root'`.

**Tech Stack:** BFFless proxy-rule pipelines (embedded JS handlers in `handoff.proxy-rules.json`, applied to the live set via the `j5s-dev` MCP), React + RTK Query frontend, Vitest + MSW tests.

## Global Constraints

- **Rule set:** live `handoff` set `5d59f6d8-f492-4e18-9edc-6a9d96677b44`, project `c3b71936-c5f0-4d20-bd3c-d5887289f9d0`. Repo JSON is source of truth; live is updated via MCP post-merge (Sandcastle does not deploy proxy rules).
- **Schemas:** `handoff_nodes` = `1c5d4802-596e-4f50-a08f-c41fb8f9fab0`; `handoff_share_links` = `ace1febf-4b3d-4a11-a5f8-22a056dd9afa`.
- **Root record `R`:** exactly one row, `nodeType:'root'`, `displayName:'My Files'`, `parentId:''`, `grantsJson:[]`, `mode:'inheriting'`, `ownerId` = the owner/admin who first shares. Created only on write paths (mint POST, grants POST).
- **Sentinel invariant:** the string `'root'` never reaches validate/claim/serve — mint stores `R`'s UUID as the share link's `folderId`.
- **Handler sandbox:** pipeline `function_handler` code runs in a restricted VM — no `crypto`/`Buffer`/`require`/`fetch`; use `var`, `for` loops (query results may be frozen), `Math.random()` for randomness.
- **Pipeline expression rule:** all config values are strings; reference prior steps by **name** (`steps.<name>.field`).
- **Working branch:** `feat/handoff-share-root` (worktree `repos/apps-handoff-share-root`). Run all commands from `apps/handoff` unless noted. Tests: `pnpm --filter handoff test`.

The affected gates (rules embedding `folderChain`, verified by grep): `GET /api/uploads/content/*`, `GET /api/nodes` (steps `gate` **and** `shape`), `GET /api/node`, `DELETE /api/node`, `POST /api/sign`, `/r/*` (step `check`), `GET /api/resolve/*`.

---

## File structure

- `apps/handoff/bffless/handoff.proxy-rules.json` — mint, grants (POST+GET), share-links list, and the 7 gate rules.
- `apps/handoff/src/lib/tree.ts` — `buildAncestorFolderChain` gains a real root link.
- `apps/handoff/src/lib/rootNode.ts` *(new)* — pure helper: pick `R` from a node set, build the root `FolderLink`.
- `apps/handoff/src/store/handoffApi.ts` — `getNode` resolves `'root'`; grants/links queries key off resolved id.
- `apps/handoff/src/pages/FolderView.tsx` — unskip root node fetch; pass real root link into the chain.
- `apps/handoff/src/components/ManageAccessPanel.tsx` — PeopleAccess uses resolved root id.
- Tests: `src/lib/rootNode.test.ts`, `src/lib/tree.test.ts`, `src/lib/shareRootRules.test.ts` *(new structural guards)*, `src/mocks/shareRoot.test.ts` *(new MSW integration)*, plus additions to `src/lib/acl.test.ts`.

---

## Task 1: Root `FolderLink` helper (pure, frontend)

**Files:**
- Create: `apps/handoff/src/lib/rootNode.ts`
- Test: `apps/handoff/src/lib/rootNode.test.ts`

**Interfaces:**
- Consumes: `FolderLink`, `Grant` from `./acl`; `HandoffNode` from `../store/handoffApi` (fields: `id`, `ownerId`, `grants`, `mode`, `type`).
- Produces:
  - `ROOT_SENTINEL = 'root'`
  - `pickRootNode(nodes: HandoffNode[]): HandoffNode | null` — the node with `type === 'root'`, else `null`.
  - `rootFolderLink(root: HandoffNode | null, shareLinkFolderId?: string): FolderLink` — real `R` link when `root` present; else a synthetic fallback whose `id` is `shareLinkFolderId ?? ROOT_SENTINEL`, `ownerId:null`, `grants:[]`, `mode:'inheriting'`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/handoff/src/lib/rootNode.test.ts
import { describe, it, expect } from 'vitest'
import { pickRootNode, rootFolderLink, ROOT_SENTINEL } from './rootNode'
import type { HandoffNode } from '../store/handoffApi'

const R = (over: Partial<HandoffNode> = {}): HandoffNode =>
  ({ id: 'R-uuid', name: 'My Files', type: 'root', parentId: '', ownerId: 'owner-1',
     grants: [{ principalId: 'u2', level: 'view' }], mode: 'inheriting',
     size: null, mime: null, createdAt: '', url: null, ...over }) as HandoffNode

describe('pickRootNode', () => {
  it('returns the root-type node', () => {
    expect(pickRootNode([R(), { id: 'x', type: 'folder' } as HandoffNode])?.id).toBe('R-uuid')
  })
  it('returns null when absent', () => {
    expect(pickRootNode([{ id: 'x', type: 'folder' } as HandoffNode])).toBeNull()
  })
})

describe('rootFolderLink', () => {
  it('uses the real root record when present (id + grants carried)', () => {
    const link = rootFolderLink(R())
    expect(link).toEqual({ id: 'R-uuid', ownerId: 'owner-1',
      grants: [{ principalId: 'u2', level: 'view' }], mode: 'inheriting' })
  })
  it('falls back to the share-link scope id when root record is absent', () => {
    expect(rootFolderLink(null, 'R-uuid')).toEqual({ id: 'R-uuid', ownerId: null, grants: [], mode: 'inheriting' })
  })
  it('falls back to the sentinel when nothing is known', () => {
    expect(rootFolderLink(null)).toEqual({ id: ROOT_SENTINEL, ownerId: null, grants: [], mode: 'inheriting' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter handoff test -- rootNode`
Expected: FAIL — `Cannot find module './rootNode'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/handoff/src/lib/rootNode.ts
import type { FolderLink } from './acl'
import type { HandoffNode } from '../store/handoffApi'

export const ROOT_SENTINEL = 'root'

export function pickRootNode(nodes: HandoffNode[]): HandoffNode | null {
  for (const n of nodes) if (n && n.type === 'root') return n
  return null
}

export function rootFolderLink(root: HandoffNode | null, shareLinkFolderId?: string): FolderLink {
  if (root) {
    return { id: root.id, ownerId: root.ownerId, grants: root.grants ?? [], mode: root.mode }
  }
  return { id: shareLinkFolderId ?? ROOT_SENTINEL, ownerId: null, grants: [], mode: 'inheriting' }
}
```

> If `HandoffNode['type']` does not yet include `'root'`, widen that union in `handoffApi.ts` as part of this step (it is a pure type change).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter handoff test -- rootNode`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/src/lib/rootNode.ts apps/handoff/src/lib/rootNode.test.ts apps/handoff/src/store/handoffApi.ts
git commit -m "feat(handoff): root FolderLink helper for share-root"
```

---

## Task 2: Inject the real root link into `buildAncestorFolderChain`

**Files:**
- Modify: `apps/handoff/src/lib/tree.ts:97-138`
- Test: `apps/handoff/src/lib/tree.test.ts`

**Interfaces:**
- Consumes: `rootFolderLink` (Task 1).
- Produces: `buildAncestorFolderChain(nodesById, folderId, rootNode?, shareLinkFolderId?)` — new optional 3rd/4th params; `chain[0]` is `rootFolderLink(rootNode ?? null, shareLinkFolderId)` instead of the hardcoded synthetic root.

- [ ] **Step 1: Write the failing test** (append to `tree.test.ts`)

```ts
import { buildAncestorFolderChain } from './tree'
import type { HandoffNode } from '../store/handoffApi'

const rootRec = { id: 'R-uuid', type: 'root', ownerId: 'owner-1',
  grants: [{ principalId: 'u2', level: 'view' as const }], mode: 'inheriting' as const } as HandoffNode

it('roots the chain at the real root record when provided', () => {
  const top = { id: 'f1', type: 'folder', parentId: 'root', ownerId: 'owner-1', grants: [], mode: 'inheriting' } as HandoffNode
  const { chain, complete } = buildAncestorFolderChain({ f1: top }, 'f1', rootRec)
  expect(complete).toBe(true)
  expect(chain[0]).toEqual({ id: 'R-uuid', ownerId: 'owner-1',
    grants: [{ principalId: 'u2', level: 'view' }], mode: 'inheriting' })
  expect(chain[1].id).toBe('f1')
})

it('falls back to the share-link scope id at the head when no root record', () => {
  const { chain } = buildAncestorFolderChain({}, 'root', null, 'R-uuid')
  expect(chain[0].id).toBe('R-uuid')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter handoff test -- tree`
Expected: FAIL — `chain[0]` is `{ id: 'root', … }` (arity too small / wrong head).

- [ ] **Step 3: Modify implementation**

Replace the `rootLink` construction and both return sites in `buildAncestorFolderChain`:

```ts
import { rootFolderLink } from './rootNode'
import type { HandoffNode } from '../store/handoffApi'

export function buildAncestorFolderChain(
  nodesById: Record<string, HandoffNode>,
  folderId: string,
  rootNode: HandoffNode | null = null,
  shareLinkFolderId?: string,
): { chain: FolderLink[]; complete: boolean } {
  const rootLink = rootFolderLink(rootNode, shareLinkFolderId)

  if (folderId === 'root') {
    return { chain: [rootLink], complete: true }
  }
  // ...unchanged walk...
  const chain: FolderLink[] = [
    rootLink,
    ...nodes.map((n) => ({ id: n.id, ownerId: n.ownerId, grants: n.grants, mode: n.mode })),
  ]
  return { chain, complete }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter handoff test -- tree`
Expected: PASS. Also run `pnpm --filter handoff test -- acl` to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/src/lib/tree.ts apps/handoff/src/lib/tree.test.ts
git commit -m "feat(handoff): root chain head carries real root record"
```

---

## Task 3: Backend — resolve-root step group JSON (shared fixture)

**Files:**
- Create: `apps/handoff/bffless/_fragments/resolve-root.json` *(reference fixture used by the patch script + guard test; not a rule on its own)*
- Test: `apps/handoff/src/lib/shareRootRules.test.ts`

**Interfaces:**
- Produces: a canonical 4-step group `[resolveRootPre, rootRecord, rootCreate, resolveRootShape]` that later tasks splice into mint/grants. Output field consumed downstream: `steps.resolveRootShape.effectiveFolderId` and `steps.resolveRootShape.rootOwnerId`.

- [ ] **Step 1: Write the fixture** (`apps/handoff/bffless/_fragments/resolve-root.json`)

```json
[
  { "id": "resolveRootPre", "name": "resolveRootPre", "handlerType": "function_handler",
    "config": { "code": "function handler({ request }) { var b=(request&&request.body)||{}; var q=(request&&request.query)||{}; var fid=String(b.folderId||q.folderId||''); var isRoot=fid==='root'; return { folderId: fid, isRoot: isRoot }; }" } },
  { "id": "rootRecord", "name": "rootRecord", "handlerType": "data_query",
    "config": { "schemaId": "1c5d4802-596e-4f50-a08f-c41fb8f9fab0", "filters": { "nodeType": { "op": "eq", "value": "root" } }, "pageSize": 1, "condition": "steps.resolveRootPre.isRoot" } },
  { "id": "rootCreate", "name": "rootCreate", "handlerType": "data_create",
    "config": { "schemaId": "1c5d4802-596e-4f50-a08f-c41fb8f9fab0", "condition": "steps.resolveRootPre.isRoot && !steps.rootRecord[0]",
      "fields": { "nodeType": "root", "displayName": "My Files", "parentId": "", "ownerId": "user.id", "mode": "inheriting", "grantsJson": "[]", "createdMs": "now()" } } },
  { "id": "resolveRootShape", "name": "resolveRootShape", "handlerType": "function_handler",
    "config": { "code": "function handler({ user, steps }) { var pre=steps.resolveRootPre||{}; if(!pre.isRoot){ return { effectiveFolderId: pre.folderId, rootOwnerId: null }; } var rows=steps.rootRecord||[]; var rec=rows.length?rows[0]:(steps.rootCreate||null); var id=rec?(rec.id||rec.recordId||rec.record_id):null; var owner=rec?(rec.ownerId||((user&&user.id)||null)):null; return { effectiveFolderId: id, rootOwnerId: owner }; }" } }
]
```

- [ ] **Step 2: Write the failing guard test**

```ts
// apps/handoff/src/lib/shareRootRules.test.ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const proxy = JSON.parse(readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'))
const rule = (path: string, method?: string) =>
  proxy.rules.find((r: any) => r.pathPattern === path && (!method || r.method === method))
const stepIds = (r: any) => (r.pipelineConfig?.steps ?? []).map((s: any) => s.id)

describe('mint POST /api/share-links resolves root', () => {
  const mint = rule('/api/share-links', 'POST')
  it('contains the resolve-root group before the folder query', () => {
    const ids = stepIds(mint)
    for (const id of ['resolveRootPre', 'rootRecord', 'rootCreate', 'resolveRootShape'])
      expect(ids).toContain(id)
    expect(ids.indexOf('resolveRootShape')).toBeLessThan(ids.indexOf('folder'))
  })
  it('stores the resolved (UUID) folderId, never the literal "root"', () => {
    const create = mint.pipelineConfig.steps.find((s: any) => s.id === 'create')
    expect(create.config.fields.folderId).toBe('steps.resolveRootShape.effectiveFolderId')
  })
  it('queries the folder node by the resolved id', () => {
    const folder = mint.pipelineConfig.steps.find((s: any) => s.id === 'folder')
    expect(folder.config.recordId).toBe('steps.resolveRootShape.effectiveFolderId')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter handoff test -- shareRootRules`
Expected: FAIL — resolve-root steps absent from mint.

- [ ] **Step 4: Splice the group into mint** (leave implementation to Task 4; this task just lands the fixture + failing test)

Skip — implemented in Task 4. Commit the fixture + test now (red is expected to persist until Task 4; mark this test `.skip` temporarily? No — keep red and let Task 4 turn it green). To keep the suite green between commits, gate this file with `describe.skip` and remove the skip in Task 4.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/bffless/_fragments/resolve-root.json apps/handoff/src/lib/shareRootRules.test.ts
git commit -m "chore(handoff): resolve-root fixture + guard tests (skipped until wired)"
```

---

## Task 4: Backend — wire resolve-root into mint & grants

**Files:**
- Modify: `apps/handoff/bffless/handoff.proxy-rules.json` (rules: `POST /api/share-links`, `POST /api/grants`, `GET /api/grants`, `GET /api/share-links`)
- Modify: `apps/handoff/src/lib/shareRootRules.test.ts` (un-skip; add grants assertions)
- Script: `apps/handoff/bffless/scripts/patch-resolve-root.mjs` *(new, repeatable)*

**Interfaces:**
- Consumes: the fixture from Task 3.
- Produces: mint/grants query & write by `steps.resolveRootShape.effectiveFolderId`; ownership checks accept `steps.resolveRootShape.rootOwnerId` when root.

- [ ] **Step 1: Un-skip + extend the guard test**

Remove `describe.skip` → `describe`. Add:

```ts
describe('grants resolve root', () => {
  it('POST /api/grants resolves root and writes by resolved id', () => {
    const g = rule('/api/grants', 'POST')
    const ids = (g.pipelineConfig.steps).map((s: any) => s.id)
    expect(ids).toContain('resolveRootShape')
    const save = g.pipelineConfig.steps.find((s: any) => s.id === 'save')
    expect(save.config.recordId).toBe('steps.resolveRootShape.effectiveFolderId')
  })
  it('GET /api/grants resolves root read-only (no rootCreate)', () => {
    const g = rule('/api/grants', 'GET')
    const ids = (g.pipelineConfig.steps).map((s: any) => s.id)
    expect(ids).toContain('resolveRootShape')
    expect(ids).not.toContain('rootCreate')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter handoff test -- shareRootRules`
Expected: FAIL — grants not yet wired.

- [ ] **Step 3: Write the patch script and run it**

```js
// apps/handoff/bffless/scripts/patch-resolve-root.mjs
import { readFileSync, writeFileSync } from 'node:fs'
const P = new URL('../handoff.proxy-rules.json', import.meta.url)
const doc = JSON.parse(readFileSync(P, 'utf8'))
const group = JSON.parse(readFileSync(new URL('../_fragments/resolve-root.json', import.meta.url), 'utf8'))
const readOnly = group.filter((s) => s.id !== 'rootCreate')  // GET paths never create

const rule = (path, method) => doc.rules.find((r) => r.pathPattern === path && r.method === method)
function spliceGroup(r, steps, before) {
  const s = r.pipelineConfig.steps
  if (s.some((x) => x.id === 'resolveRootShape')) return
  const at = s.findIndex((x) => x.id === before)
  s.splice(at, 0, ...JSON.parse(JSON.stringify(steps)))
}

// mint
const mint = rule('/api/share-links', 'POST')
spliceGroup(mint, group, 'folder')
mint.pipelineConfig.steps.find((s) => s.id === 'folder').config.recordId = 'steps.resolveRootShape.effectiveFolderId'
mint.pipelineConfig.steps.find((s) => s.id === 'create').config.fields.folderId = 'steps.resolveRootShape.effectiveFolderId'

// grants POST (query + save by resolved id)
const gp = rule('/api/grants', 'POST')
spliceGroup(gp, group, 'folder')
gp.pipelineConfig.steps.find((s) => s.id === 'folder').config.recordId = 'steps.resolveRootShape.effectiveFolderId'
gp.pipelineConfig.steps.find((s) => s.id === 'save').config.recordId = 'steps.resolveRootShape.effectiveFolderId'

// grants GET (read-only) + share-links list GET (read-only): filter by resolved id
for (const [path, filterStepId, filterKey] of [['/api/grants','folder',null],['/api/share-links','links','folderId']]) {
  const r = rule(path, 'GET'); if (!r) continue
  spliceGroup(r, readOnly, r.pipelineConfig.steps[0].id === 'parse' ? 'parse' : r.pipelineConfig.steps[0].id)
  const fs = r.pipelineConfig.steps.find((s) => s.id === filterStepId)
  if (fs && fs.config.recordId) fs.config.recordId = 'steps.resolveRootShape.effectiveFolderId'
  if (fs && filterKey && fs.config.filters?.[filterKey]) fs.config.filters[filterKey].value = 'steps.resolveRootShape.effectiveFolderId'
}

writeFileSync(P, JSON.stringify(doc, null, 2) + '\n')
console.log('patched resolve-root into mint + grants')
```

Run: `node apps/handoff/bffless/scripts/patch-resolve-root.mjs`

> Inspect the diff (`git diff apps/handoff/bffless/handoff.proxy-rules.json`) and confirm the grants/list read paths reference the correct step id (`folder`/`links`); adjust the tuple in the loop if the real step ids differ. Also confirm the ownership `check`/`merge` steps in mint/grants read `steps.resolveRootShape.rootOwnerId || <resolved node>.ownerId` for the root case; if they only read `steps.folder.ownerId`, update those functions so a root record found via `rootRecord` still authorizes (the resolved node is the root row, whose `ownerId` is set — so `steps.folder` returns it and existing logic already works; verify).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter handoff test -- shareRootRules`
Expected: PASS. Validate JSON: `node -e "JSON.parse(require('fs').readFileSync('apps/handoff/bffless/handoff.proxy-rules.json'))"`.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/bffless/handoff.proxy-rules.json apps/handoff/bffless/scripts/patch-resolve-root.mjs apps/handoff/src/lib/shareRootRules.test.ts
git commit -m "feat(handoff): resolve 'root' to a singleton root record in mint + grants"
```

---

## Task 5: Backend — inject root into the ACL chain gates

**Files:**
- Modify: `apps/handoff/bffless/handoff.proxy-rules.json` (7 gate rules + `/api/nodes` `shape`)
- Script: `apps/handoff/bffless/scripts/patch-chain-root.mjs` *(new)*
- Test: extend `apps/handoff/src/lib/shareRootRules.test.ts`

**Interfaces:**
- Produces: every embedded `folderChain` resolves `parentId==='root'` → the root record id; every chain-feeding query returns `nodeType in ('folder','root')`.

- [ ] **Step 1: Write the failing guard test** (append)

```ts
describe('ACL gates inject the root record', () => {
  const GATES = ['/api/uploads/content/*','/api/nodes','/api/node','/api/node','/api/sign','/r/*','/api/resolve/*']
  it('every folderChain resolves the root sentinel to the root record id', () => {
    let count = 0
    for (const r of proxy.rules) {
      for (const s of r.pipelineConfig?.steps ?? []) {
        const code = s.config?.code ?? ''
        if (code.includes('function folderChain')) {
          count++
          expect(code).toMatch(/nodeType\s*===\s*'root'/)          // captures rootId
          expect(code).toMatch(/===\s*'root'\s*&&\s*rootId/)        // resolves sentinel
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(8) // 7 gates + shape
  })
  it('chain-feeding queries include the root record (nodeType in folder,root)', () => {
    for (const r of proxy.rules) {
      for (const s of r.pipelineConfig?.steps ?? []) {
        const f = s.config?.filters?.nodeType
        if (f && f.value === 'folder' && ['allFolders','folders'].includes(s.id)) {
          expect(f.op).toBe('in')
          expect(f.value).toEqual(['folder', 'root'])
        }
      }
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter handoff test -- shareRootRules`
Expected: FAIL — chains stop at the sentinel; filters are `eq folder`.

- [ ] **Step 3: Write + run the patch script**

```js
// apps/handoff/bffless/scripts/patch-chain-root.mjs
import { readFileSync, writeFileSync } from 'node:fs'
const P = new URL('../handoff.proxy-rules.json', import.meta.url)
const doc = JSON.parse(readFileSync(P, 'utf8'))
let chains = 0, filters = 0
for (const r of doc.rules) {
  for (const s of r.pipelineConfig?.steps ?? []) {
    // (a) widen chain-feeding queries
    const nf = s.config?.filters?.nodeType
    if (nf && nf.op === 'eq' && nf.value === 'folder' && (s.id === 'allFolders' || s.id === 'folders')) {
      s.config.filters.nodeType = { op: 'in', value: ['folder', 'root'] }; filters++
    }
    // (b) patch every folderChain body
    let c = s.config?.code
    if (c && c.includes('function folderChain') && !c.includes("=== 'root' && rootId")) {
      // capture rootId while building byId
      c = c.replace(
        /if\(id\)byId\[id\]=f;\}/,
        "if(id){byId[id]=f;if(f.nodeType==='root')rootId=id;}}")
      c = c.replace(/var byId=\{\};/, "var byId={};var rootId='';")
      // resolve the sentinel one hop further
      c = c.replace(/cur=n\.parentId\|\|'';/,
        "cur=(n.parentId==='root'&&rootId)?rootId:(n.parentId||'');")
      s.config.code = c; chains++
    }
  }
}
writeFileSync(P, JSON.stringify(doc, null, 2) + '\n')
console.log('patched chains:', chains, 'filters:', filters)
```

Run: `node apps/handoff/bffless/scripts/patch-chain-root.mjs`
Expected stdout: `patched chains: 8 filters: 8` (7 gate `allFolders` + `/r/*` `folders`; `shape` shares the folderChain body so it is patched too — verify count; the `/api/uploads/content/*` `allSites` query is left as `eq site` intentionally).

> If `chains` ≠ 8 or `filters` ≠ 8, a body/variant didn't match the regex — inspect the unpatched copy and adjust the `replace` patterns (the two `folderChain` signatures may differ in whitespace). Do **not** hand-edit; fix the script and re-run on a clean `git checkout -- handoff.proxy-rules.json`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter handoff test -- shareRootRules` → PASS.
Validate JSON parses; run full app suite `pnpm --filter handoff test` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/bffless/handoff.proxy-rules.json apps/handoff/bffless/scripts/patch-chain-root.mjs apps/handoff/src/lib/shareRootRules.test.ts
git commit -m "feat(handoff): ACL gates include the root record in the folder chain"
```

---

## Task 6: Frontend — resolve `R` for the Share dialog + chain

**Files:**
- Modify: `apps/handoff/src/store/handoffApi.ts` (`getNode` resolves `'root'` → `R`; widen `HandoffNode.type` to include `'root'` if not done in Task 1)
- Modify: `apps/handoff/src/pages/FolderView.tsx:88,856,866` (unskip root fetch; pass `rootNode` + `shareLinkFolderId` into `buildAncestorFolderChain`)
- Modify: `apps/handoff/src/components/ManageAccessPanel.tsx:140` (PeopleAccess keys grants off the resolved root id)
- Test: `apps/handoff/src/mocks/handlers.ts` (add `GET /api/node?id=root` → root record) + assertions in `src/mocks/shareRoot.test.ts` (Task 7)

**Interfaces:**
- Consumes: `pickRootNode`, `rootFolderLink` (Task 1); `buildAncestorFolderChain` new params (Task 2).
- Produces: `useGetNodeQuery('root')` returns `R | null`; PeopleAccess/ShareLinks use `resolvedRootId = root?.id ?? 'root'`.

- [ ] **Step 1: Write the failing test** (component-level, in `shareRoot.test.ts` scaffold)

```ts
import { render, screen } from '@testing-library/react'
// Renders FolderView at root with an MSW-mocked GET /api/node?id=root returning R
// and GET /api/grants?folderId=R returning one grant; asserts the grant email shows.
it('root Share dialog lists a grant resolved via the root record', async () => {
  // ...mount with folderId='root', open Share dialog...
  expect(await screen.findByText('u2@example.com')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter handoff test -- shareRoot`
Expected: FAIL — root fetch is skipped; grant query keyed on `'root'` returns nothing.

- [ ] **Step 3: Implement**

`handoffApi.ts` — allow the root id through (server resolves the sentinel; Task 5 gates return `R` for `?id=root`):

```ts
getNode: builder.query<HandoffNode | null, string>({
  query: (id) => `api/node?id=${encodeURIComponent(id)}`,   // 'root' now allowed
  providesTags: (_r, _e, id) => [{ type: 'Node' as const, id }],
}),
```

`FolderView.tsx`:

```ts
const { data: rootNode } = useGetNodeQuery('root', { skip: folderId !== 'root' && !isShareMode })
const { data: node } = useGetNodeQuery(folderId, { skip: folderId === 'root' })
// ...
const { chain: folderChain } = buildAncestorFolderChain(
  ancestorNodesById, folderId, rootNode ?? null, shareLinkFolderId ?? undefined)
const resolvedRootId = rootNode?.id ?? 'root'
// pass resolvedRootId to <ShareDialog folderId={folderId === 'root' ? resolvedRootId : folderId} .../>
```

`ManageAccessPanel.tsx` PeopleAccess — receives the already-resolved id via its `folderId` prop, so no change beyond being handed `resolvedRootId`. Confirm `useGetGrantsQuery({ folderId })` now gets `R`.

> Also add a `GET /api/node` server resolver for `?id=root` in the rule (Task 5 covered chains, not this read). If `/api/node`'s gate does not already return the root record for `id=root`, add a small pre-step: when `request.query.id==='root'`, run the read-only resolve-root group and return `R` (or `null`). Fold this into Task 5's script or add here as a focused edit + guard test.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter handoff test -- shareRoot` → PASS. Full suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/src/store/handoffApi.ts apps/handoff/src/pages/FolderView.tsx apps/handoff/src/components/ManageAccessPanel.tsx apps/handoff/src/mocks/handlers.ts
git commit -m "feat(handoff): Share dialog + ACL chain resolve the root record"
```

---

## Task 7: MSW end-to-end integration tests

**Files:**
- Create: `apps/handoff/src/mocks/shareRoot.test.ts`
- Modify: `apps/handoff/src/mocks/handlers.ts` (root record `R`, root-scoped share cookie, nested file)

**Interfaces:** Consumes the full stack from Tasks 1–6.

- [ ] **Step 1: Write the tests**

```ts
// Three scenarios against the MSW-mocked API:
// 1. Owner mints a root share link → response folderId is R's UUID (not 'root').
// 2. Guest with hf_s scoped to R lists parentId='root' AND opens a nested file → 200.
// 3. Grant user u2 'view' on root → u2 (authenticated) lists a nested folder → allowed;
//    a user with no grant/scope → nested access denied (none).
it('mint on root stores a UUID folderId', async () => { /* ... */ })
it('root-scoped guest can view a nested file', async () => { /* ... */ })
it('no scope and no grant → nested access denied', async () => { /* ... */ })
```

- [ ] **Step 2: Run to verify they fail** (before wiring the mock handlers): `pnpm --filter handoff test -- shareRoot`

- [ ] **Step 3: Implement the mock handlers** — extend `handlers.ts` so the node set includes `R` (`type:'root'`) and a nested file, and the mocked gates mirror the folderChain-with-root logic.

- [ ] **Step 4: Run to verify they pass** → PASS. Full suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/src/mocks/shareRoot.test.ts apps/handoff/src/mocks/handlers.ts
git commit -m "test(handoff): end-to-end share-root scenarios"
```

---

## Task 8: Apply to the live rule set + verify (post-merge)

**Files:** none (operational). Requires the PR merged first.

- [ ] **Step 1:** For each changed rule (mint, grants POST/GET, share-links GET, and the 7 gates + `/api/node` resolver), update the live rule via `mcp__j5s-dev__update_proxy_rule` (or delete+recreate for step-array changes) so the live pipelineConfig equals the repo JSON.
- [ ] **Step 2:** Diff-verify: fetch the live set and assert the changed rules' `pipelineConfig` matches the repo JSON byte-for-byte (reuse the compare approach from the public-rules cleanup).
- [ ] **Step 3:** Smoke test on `handoff.j5s.dev`: (a) Share "My Files" → create link → open in a logged-out browser → a nested file loads; (b) grant a second user `view` on root → confirm inherited access; (c) confirm the root record `R` exists exactly once (`query_pipeline_data nodeType='root'`).
- [ ] **Step 4:** Update `apps/handoff/bffless/README.md` to document root-sharing (root record marker, resolve-root behavior). Commit.

---

## Self-review notes

- **Spec coverage:** root record (Task 3–4), resolve in mint/grants (Task 4), chain injection across all gates (Task 5, incl. the `shape` variant and the two extra gates the spec's "~5" estimate missed), read-only frontend resolver + real root chain head (Tasks 1–2, 6), tests (Tasks 1–2,6,7), rollout (Task 8). Out-of-scope "root listing open" is not touched.
- **Known follow-ups flagged inline:** the exact ownership-check step wording in mint/grants (Task 4 Step 3 note) and the `/api/node?id=root` server resolver (Task 6 Step 3 note) must be verified against the live pipeline bodies during implementation; both have guard tests to catch drift.
- **Concurrency:** duplicate `R` on simultaneous first-share is inert (empty orphan); Task 8 Step 3(c) checks the count and is the place to prune if needed.
