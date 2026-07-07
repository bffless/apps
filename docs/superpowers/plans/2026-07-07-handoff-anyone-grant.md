# Handoff — Publicness as an "Anyone" Grant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a folder publicly viewable by granting the reserved **Anyone** principal `View` on it — per ADR-0005 (`apps/handoff/docs/adr/0005-public-as-anyone-grant.md`): no visibility field, no global setting; publicness inherits and is cut by `Restricted` exactly like any other grant.

**Architecture:** One reserved principal id (`'anyone'`) flows through the existing ACL machinery. Backend: the 7 identical embedded `evalAccess` copies in `handoff.proxy-rules.json` learn to match Anyone (capped at `view`) and stop short-circuiting anonymous viewers; the grants `merge` step caps Anyone at `view` write-side. Frontend: `src/lib/acl.ts` mirrors the port, the Share dialog gains a "General access" Public/Private section, and the root empty state gets a signed-out variant. Share links, writes, `/r/*`, and `/api/directory` are untouched.

**Tech Stack:** BFFless proxy-rule pipelines (embedded JS handlers patched via checked-in scripts), React + RTK Query, Vitest + MSW + Testing Library.

## Global Constraints

- **Reserved principal id:** the string `'anyone'`, exported as `ANYONE_PRINCIPAL` from `src/lib/acl.ts`. Anyone grants are ALWAYS level `view` — enforced write-side (grants `merge` cap) and read-side (`evalAccess` treats a matched Anyone grant as `view` regardless of stored level).
- **Semantics (ADR-0005):** Anyone inherits through `Inheriting` folders; a `Restricted` folder drops it like any inherited grant. Admin/owner short-circuits unchanged. Writes unchanged. Share links unchanged (still the tokened mechanism for private folders).
- **Rule set:** live `handoff` set `5d59f6d8-f492-4e18-9edc-6a9d96677b44`, project `c3b71936-c5f0-4d20-bd3c-d5887289f9d0`. Repo JSON (`apps/handoff/bffless/handoff.proxy-rules.json`) is source of truth; live is updated via the `j5s-dev` MCP post-merge (Sandcastle does not deploy proxy rules).
- **Never hand-edit code blobs in `handoff.proxy-rules.json`** — write a patch script under `apps/handoff/bffless/scripts/`, run it, and lock the result with a guard test (repo convention from #171/#181).
- **Handler sandbox:** `function_handler` code runs in a restricted VM — `var` + `for` loops only (query results may be frozen), no `crypto`/`Buffer`/`require`/`fetch`.
- **Pipeline step `condition`s must be simple truthy paths** (`steps.x.y`) — no `&&`/`!`/`===`/`[0]` (lesson of #182). This plan adds no new steps, only edits code blobs, but any deviation must respect this.
- **Untouched surfaces:** `/r/*` (token flow), `/api/directory` (stays session-gated — never expose the team roster publicly), all share-link rules, all write rules' gating levels.
- **Working branch:** `feat/handoff-anyone-grant` (worktree `repos/apps-handoff-anyone-grant`). Run all commands from the repo root. Tests: `pnpm --filter handoff test`.

The 7 embedded `evalAccess` copies (verified byte-identical, 615 chars): `GET /api/uploads/content/*` #gate, `GET /api/nodes` #gate **and** #shape, `GET /api/node` #gate, `DELETE /api/node` #gate, `POST /api/sign` #gate, `GET /api/resolve/*` #gate. (`DELETE /api/node` requires ≥`edit`, so Anyone=view changes nothing there, but all copies stay identical for port equivalence.)

---

## File structure

- `apps/handoff/src/lib/acl.ts` — canonical `evaluateAccess` gains Anyone matching; exports `ANYONE_PRINCIPAL`, `hasAnyoneGrant`.
- `apps/handoff/bffless/scripts/patch-anyone-eval.mjs` *(new)* — replaces the 7 `evalAccess` bodies.
- `apps/handoff/bffless/scripts/patch-anyone-cap.mjs` *(new)* — inserts the Anyone view-cap into the grants `merge` step.
- `apps/handoff/src/lib/anyoneGrantRule.test.ts` *(new)* — structural guards + embedded↔TS port-equivalence matrix.
- `apps/handoff/src/components/ManageAccessPanel.tsx` — `GeneralAccess` section; `PeopleAccess` hides the Anyone row.
- `apps/handoff/src/components/ShareDialog.tsx` — renders `GeneralAccess`; passes `isPublic` to the links section.
- `apps/handoff/src/components/ShareLinksSection.tsx` — informational note when the folder is public.
- `apps/handoff/src/components/EmptyState.tsx` *(new, extracted from FolderView)* — signed-out root variant.
- `apps/handoff/src/pages/FolderView.tsx` — uses the extracted `EmptyState`.
- `apps/handoff/src/mocks/handlers.ts` — mock gates mirror Anyone semantics (anonymous allowed through evaluation; root listing filtered per child for guests; grants POST cap).
- Tests: additions to `src/lib/acl.test.ts`; new `src/components/generalAccess.test.tsx`, `src/components/emptyState.test.tsx`, `src/mocks/anyoneGrant.test.ts`.

---

## Task 1: Canonical ACL — `evaluateAccess` learns Anyone

**Files:**
- Modify: `apps/handoff/src/lib/acl.ts`
- Test: `apps/handoff/src/lib/acl.test.ts` (append)

**Interfaces:**
- Produces: `ANYONE_PRINCIPAL = 'anyone'` (exported const), `hasAnyoneGrant(grants: Grant[]): boolean` (exported), and new `evaluateAccess` semantics:
  - The grant scan runs for **every** viewer (anonymous included). A grant with `principalId === ANYONE_PRINCIPAL` promotes to `'view'` (never its stored level). A grant matching `viewer.userId` promotes to its stored level, as before.
  - The anonymous short-circuits (`!userId && shareLinkFolderId → scoped view/none`, `!userId → 'none'`) are replaced: the share-link scope check becomes one more `promote('view')` source for guests, evaluated **after** the grant scan; nothing returns early.
  - Admin → `owner` and owner-in-chain → `owner` short-circuits unchanged. `Restricted` boundary (`startIdx`) applies to the whole grant scan, Anyone included. Share-link scope matching stays **full-chain** (not startIdx-bounded) — exactly as today.

- [ ] **Step 1: Write the failing tests** (append to `acl.test.ts`)

```ts
import { evaluateAccess, hasAnyoneGrant, ANYONE_PRINCIPAL } from './acl'
import type { FolderLink } from './acl'

const F = (over: Partial<FolderLink> = {}): FolderLink =>
  ({ id: 'f1', ownerId: 'owner-1', grants: [], mode: 'inheriting', ...over })

describe('Anyone principal', () => {
  const anyone = { principalId: ANYONE_PRINCIPAL, level: 'view' as const }

  it('anonymous viewer gets view from an Anyone grant on the target', () => {
    expect(evaluateAccess({ folderChain: [F({ grants: [anyone] })], viewer: {} })).toBe('view')
  })

  it('anonymous viewer inherits an ancestor Anyone grant', () => {
    const chain = [F({ id: 'p', grants: [anyone] }), F({ id: 'c' })]
    expect(evaluateAccess({ folderChain: chain, viewer: {} })).toBe('view')
  })

  it('a Restricted descendant drops an inherited Anyone grant', () => {
    const chain = [F({ id: 'p', grants: [anyone] }), F({ id: 'c', mode: 'restricted' })]
    expect(evaluateAccess({ folderChain: chain, viewer: {} })).toBe('none')
  })

  it('an Anyone grant is capped at view even if stored as edit (bad data)', () => {
    const bad = { principalId: ANYONE_PRINCIPAL, level: 'edit' as const }
    expect(evaluateAccess({ folderChain: [F({ grants: [bad] })], viewer: {} })).toBe('view')
  })

  it('a signed-in user with no personal grant gets view from Anyone', () => {
    expect(
      evaluateAccess({ folderChain: [F({ grants: [anyone] })], viewer: { userId: 'u9' } }),
    ).toBe('view')
  })

  it('a personal edit grant still wins over Anyone (highest wins)', () => {
    const chain = [F({ grants: [anyone, { principalId: 'u9', level: 'edit' as const }] })]
    expect(evaluateAccess({ folderChain: chain, viewer: { userId: 'u9' } })).toBe('edit')
  })

  it('a guest with an out-of-scope share link still gets view from Anyone', () => {
    const chain = [F({ id: 'other', grants: [anyone] })]
    expect(
      evaluateAccess({ folderChain: chain, viewer: { shareLinkFolderId: 'not-in-chain' } }),
    ).toBe('view')
  })

  it('share-link scoped view still works with no Anyone grant', () => {
    const chain = [F({ id: 'scope' })]
    expect(
      evaluateAccess({ folderChain: chain, viewer: { shareLinkFolderId: 'scope' } }),
    ).toBe('view')
  })

  it('anonymous with nothing stays none', () => {
    expect(evaluateAccess({ folderChain: [F()], viewer: {} })).toBe('none')
  })
})

describe('hasAnyoneGrant', () => {
  it('true when the anyone principal is present', () => {
    expect(hasAnyoneGrant([{ principalId: ANYONE_PRINCIPAL, level: 'view' }])).toBe(true)
  })
  it('false otherwise', () => {
    expect(hasAnyoneGrant([{ principalId: 'u1', level: 'view' }])).toBe(false)
    expect(hasAnyoneGrant([])).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter handoff test -- acl`
Expected: FAIL — `ANYONE_PRINCIPAL`/`hasAnyoneGrant` not exported; anonymous cases return `'none'`.

- [ ] **Step 3: Implement in `acl.ts`**

Add below the type declarations:

```ts
/** Reserved Principal id representing the anonymous public (ADR-0005). */
export const ANYONE_PRINCIPAL = 'anyone'

/** Whether a grants list makes its folder public (contains the Anyone principal). */
export function hasAnyoneGrant(grants: Grant[]): boolean {
  return grants.some((g) => g.principalId === ANYONE_PRINCIPAL)
}
```

Replace the body of `evaluateAccess` from the share-link short-circuit onward (keep the admin and owner-in-chain blocks exactly as they are) with:

```ts
  // Find the deepest restricted folder — grants from above that point are dropped.
  let startIdx = 0
  for (let i = folderChain.length - 1; i >= 0; i--) {
    if (folderChain[i].mode === 'restricted') {
      startIdx = i
      break
    }
  }

  const levelOrder: AccessLevel[] = ['none', 'view', 'edit', 'owner']
  let best: AccessLevel = 'none'

  function levelRank(l: AccessLevel): number {
    return levelOrder.indexOf(l)
  }

  function promote(candidate: AccessLevel): void {
    if (levelRank(candidate) > levelRank(best)) {
      best = candidate
    }
  }

  // Grant scan — runs for every viewer, anonymous included. An Anyone grant
  // yields at most 'view' regardless of its stored level (defense in depth;
  // the write path also caps it).
  for (let i = startIdx; i < folderChain.length; i++) {
    for (const grant of folderChain[i].grants) {
      if (grant.principalId === ANYONE_PRINCIPAL) {
        promote('view')
      } else if (viewer.userId && grant.principalId === viewer.userId) {
        promote(grant.level)
      }
    }
  }

  // Share-link viewers (guests only): scoped folder id in the FULL chain
  // yields view — one more promotion source, not an early return.
  if (!viewer.userId && viewer.shareLinkFolderId) {
    if (folderChain.some((f) => f.id === viewer.shareLinkFolderId)) {
      promote('view')
    }
  }

  return best
```

Delete the now-dead `if (!viewer.userId && viewer.shareLinkFolderId) {…}` early-return block, the `if (!viewer.userId) return 'none'` line, and the old scan loop they preceded. Update the file's doc comment to mention Anyone. `inShareMode` is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter handoff test -- acl`
Expected: PASS, including every pre-existing case (the old matrix must not regress — pay attention to the share-link cases).

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/src/lib/acl.ts apps/handoff/src/lib/acl.test.ts
git commit -m "feat(handoff): evaluateAccess matches the Anyone principal (ADR-0005)"
```

---

## Task 2: Backend — patch the 7 embedded `evalAccess` copies

**Files:**
- Create: `apps/handoff/bffless/scripts/patch-anyone-eval.mjs`
- Modify: `apps/handoff/bffless/handoff.proxy-rules.json` (via the script only)
- Test: `apps/handoff/src/lib/anyoneGrantRule.test.ts` *(new)*

**Interfaces:**
- Consumes: `evaluateAccess`, `ANYONE_PRINCIPAL` from Task 1 (for the equivalence matrix).
- Produces: all 7 embedded `evalAccess` bodies replaced by the Anyone-aware body below. Later tasks and the live rollout rely on the exact new body string.

The **old** canonical body (all 7 copies, byte-identical — verify with the grep in Step 3):

```
function evalAccess(ch,vw){ if(vw.isAdmin)return 'owner'; if(vw.userId){for(var i=0;i<ch.length;i++){if(ch[i].ownerId===vw.userId)return 'owner';}} if(!vw.userId&&vw.shareLinkFolderId){var inC=false;for(var j=0;j<ch.length;j++){if(ch[j].id===vw.shareLinkFolderId){inC=true;break;}}return inC?'view':'none';} if(!vw.userId)return 'none'; var s=0;for(var k=ch.length-1;k>=0;k--){if(ch[k].mode==='restricted'){s=k;break;}} var best='none';for(var d=s;d<ch.length;d++){var gs=ch[d].grants||[];for(var e=0;e<gs.length;e++){if(gs[e].principalId===vw.userId&&rank(gs[e].level)>rank(best))best=gs[e].level;}} return best; }
```

The **new** body (mirror of Task 1, sandbox-safe `var`/`for` only):

```
function evalAccess(ch,vw){ if(vw.isAdmin)return 'owner'; if(vw.userId){for(var i=0;i<ch.length;i++){if(ch[i].ownerId===vw.userId)return 'owner';}} var s=0;for(var k=ch.length-1;k>=0;k--){if(ch[k].mode==='restricted'){s=k;break;}} var best='none';for(var d=s;d<ch.length;d++){var gs=ch[d].grants||[];for(var e=0;e<gs.length;e++){var g=gs[e]||{};if(g.principalId==='anyone'){if(rank('view')>rank(best))best='view';}else if(vw.userId&&g.principalId===vw.userId&&rank(g.level)>rank(best))best=g.level;}} if(!vw.userId&&vw.shareLinkFolderId){var inC=false;for(var j=0;j<ch.length;j++){if(ch[j].id===vw.shareLinkFolderId){inC=true;break;}}if(inC&&rank('view')>rank(best))best='view';} return best; }
```

- [ ] **Step 1: Write the failing guard + equivalence test**

```ts
// apps/handoff/src/lib/anyoneGrantRule.test.ts
// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard + port-equivalence for the Anyone principal (ADR-0005).
 * Extracts the REAL embedded evalAccess from the proxy rules and runs it
 * against the same matrix as the canonical src/lib/acl.ts implementation.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { evaluateAccess, ANYONE_PRINCIPAL } from './acl'
import type { FolderLink, Viewer, AccessLevel } from './acl'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

function evalAccessCopies(): string[] {
  const out: string[] = []
  for (const r of proxy.rules) {
    for (const s of r.pipelineConfig?.steps ?? []) {
      const code: string = s.config?.code ?? ''
      const i = code.indexOf('function evalAccess')
      if (i < 0) continue
      let depth = 0
      let j = code.indexOf('{', i)
      for (; j < code.length; j++) {
        if (code[j] === '{') depth++
        else if (code[j] === '}') {
          depth--
          if (depth === 0) break
        }
      }
      out.push(code.slice(i, j + 1))
    }
  }
  return out
}

describe('embedded evalAccess copies (structural)', () => {
  const copies = evalAccessCopies()

  it('there are exactly 7 copies and they are identical', () => {
    expect(copies.length).toBe(7)
    expect(new Set(copies).size).toBe(1)
  })

  it('every copy matches the anyone principal and never short-circuits guests', () => {
    for (const c of copies) {
      expect(c).toContain("principalId==='anyone'")
      expect(c).not.toContain("if(!vw.userId)return 'none';")
    }
  })
})

describe('embedded evalAccess ≡ evaluateAccess (port equivalence)', () => {
  const body = evalAccessCopies()[0]
  const embedded = new Function(
    `var rank=function(l){return l==='owner'?3:l==='edit'?2:l==='view'?1:0;}; return (${body})`,
  )() as (ch: FolderLink[], vw: Viewer) => AccessLevel

  const anyone = { principalId: ANYONE_PRINCIPAL, level: 'view' as const }
  const F = (over: Partial<FolderLink> = {}): FolderLink =>
    ({ id: 'f1', ownerId: 'owner-1', grants: [], mode: 'inheriting', ...over })

  const MATRIX: Array<{ name: string; chain: FolderLink[]; viewer: Viewer; want: AccessLevel }> = [
    { name: 'admin', chain: [F()], viewer: { userId: 'x', isAdmin: true }, want: 'owner' },
    { name: 'owner in chain', chain: [F()], viewer: { userId: 'owner-1' }, want: 'owner' },
    { name: 'anon + anyone on target', chain: [F({ grants: [anyone] })], viewer: {}, want: 'view' },
    {
      name: 'anon inherits ancestor anyone',
      chain: [F({ id: 'p', grants: [anyone] }), F({ id: 'c', ownerId: 'o2' })],
      viewer: {},
      want: 'view',
    },
    {
      name: 'restricted cuts anyone',
      chain: [F({ id: 'p', grants: [anyone] }), F({ id: 'c', ownerId: 'o2', mode: 'restricted' })],
      viewer: {},
      want: 'none',
    },
    {
      name: 'anyone capped at view (bad edit data)',
      chain: [F({ grants: [{ principalId: ANYONE_PRINCIPAL, level: 'edit' as const }] })],
      viewer: {},
      want: 'view',
    },
    {
      name: 'signed-in ungranted gets view from anyone',
      chain: [F({ grants: [anyone] })],
      viewer: { userId: 'u9' },
      want: 'view',
    },
    {
      name: 'personal edit beats anyone',
      chain: [F({ grants: [anyone, { principalId: 'u9', level: 'edit' as const }] })],
      viewer: { userId: 'u9' },
      want: 'edit',
    },
    {
      name: 'guest link out of scope + anyone',
      chain: [F({ id: 'other', grants: [anyone] })],
      viewer: { shareLinkFolderId: 'nope' },
      want: 'view',
    },
    {
      name: 'guest link in scope, no anyone',
      chain: [F({ id: 'scope' })],
      viewer: { shareLinkFolderId: 'scope' },
      want: 'view',
    },
    { name: 'anon nothing', chain: [F()], viewer: {}, want: 'none' },
    {
      name: 'personal grant below restricted still counts',
      chain: [F({ id: 'p', grants: [anyone] }), F({ id: 'c', ownerId: 'o2', mode: 'restricted', grants: [{ principalId: 'u9', level: 'view' as const }] })],
      viewer: { userId: 'u9' },
      want: 'view',
    },
  ]

  for (const c of MATRIX) {
    it(c.name, () => {
      expect(embedded(c.chain, c.viewer)).toBe(c.want)
      expect(evaluateAccess({ folderChain: c.chain, viewer: c.viewer })).toBe(c.want)
    })
  }
})
```

> `Viewer` and `AccessLevel` are already exported from `acl.ts`; `FolderLink` too. If any is missing an `export`, add it (pure type change).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter handoff test -- anyoneGrantRule`
Expected: FAIL — copies still contain the guest short-circuit; the anon-anyone matrix rows return `'none'`.

- [ ] **Step 3: Write the patch script and run it**

```js
// apps/handoff/bffless/scripts/patch-anyone-eval.mjs
// Replaces the canonical embedded evalAccess body (7 copies) with the
// Anyone-aware body (ADR-0005). Idempotent; exits non-zero on count mismatch.
import { readFileSync, writeFileSync } from 'node:fs'

const P = new URL('../handoff.proxy-rules.json', import.meta.url)
const doc = JSON.parse(readFileSync(P, 'utf8'))

const OLD = `function evalAccess(ch,vw){ if(vw.isAdmin)return 'owner'; if(vw.userId){for(var i=0;i<ch.length;i++){if(ch[i].ownerId===vw.userId)return 'owner';}} if(!vw.userId&&vw.shareLinkFolderId){var inC=false;for(var j=0;j<ch.length;j++){if(ch[j].id===vw.shareLinkFolderId){inC=true;break;}}return inC?'view':'none';} if(!vw.userId)return 'none'; var s=0;for(var k=ch.length-1;k>=0;k--){if(ch[k].mode==='restricted'){s=k;break;}} var best='none';for(var d=s;d<ch.length;d++){var gs=ch[d].grants||[];for(var e=0;e<gs.length;e++){if(gs[e].principalId===vw.userId&&rank(gs[e].level)>rank(best))best=gs[e].level;}} return best; }`

const NEW = `function evalAccess(ch,vw){ if(vw.isAdmin)return 'owner'; if(vw.userId){for(var i=0;i<ch.length;i++){if(ch[i].ownerId===vw.userId)return 'owner';}} var s=0;for(var k=ch.length-1;k>=0;k--){if(ch[k].mode==='restricted'){s=k;break;}} var best='none';for(var d=s;d<ch.length;d++){var gs=ch[d].grants||[];for(var e=0;e<gs.length;e++){var g=gs[e]||{};if(g.principalId==='anyone'){if(rank('view')>rank(best))best='view';}else if(vw.userId&&g.principalId===vw.userId&&rank(g.level)>rank(best))best=g.level;}} if(!vw.userId&&vw.shareLinkFolderId){var inC=false;for(var j=0;j<ch.length;j++){if(ch[j].id===vw.shareLinkFolderId){inC=true;break;}}if(inC&&rank('view')>rank(best))best='view';} return best; }`

let patched = 0
let already = 0
for (const r of doc.rules) {
  for (const s of r.pipelineConfig?.steps ?? []) {
    const c = s.config?.code
    if (!c) continue
    if (c.includes(NEW)) { already++; continue }
    if (c.includes(OLD)) {
      s.config.code = c.split(OLD).join(NEW)
      patched++
    }
  }
}

if (patched + already !== 7) {
  console.error(`expected 7 evalAccess copies, found ${patched + already} (patched ${patched}, already ${already})`)
  process.exit(1)
}
writeFileSync(P, JSON.stringify(doc, null, 2) + '\n')
console.log(`patched ${patched} evalAccess copies (${already} already current)`)
```

Run: `node apps/handoff/bffless/scripts/patch-anyone-eval.mjs`
Expected stdout: `patched 7 evalAccess copies (0 already current)`

> If the count check fails, a body drifted from the canonical string — do NOT hand-edit; diff the actual body (`git diff` / the extraction helper from the test) against `OLD`, fix the script's `OLD` constant, `git checkout -- apps/handoff/bffless/handoff.proxy-rules.json`, and re-run.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter handoff test -- anyoneGrantRule`
Expected: PASS (structural + full matrix, both implementations).
Then the whole suite: `pnpm --filter handoff test` — the pre-existing rule tests (`resolveRule`, `shareRootRules`, `nodePathRule`, `deleteNodeRule`, `sitesUnifiedRule`, `rawFileRule`…) must stay green; several execute the real embedded handlers, so this is the regression net for the body swap.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/bffless/handoff.proxy-rules.json apps/handoff/bffless/scripts/patch-anyone-eval.mjs apps/handoff/src/lib/anyoneGrantRule.test.ts
git commit -m "feat(handoff): ACL gates match the Anyone principal (7 evalAccess copies)"
```

---

## Task 3: Backend — cap Anyone at `view` in the grants write path

**Files:**
- Create: `apps/handoff/bffless/scripts/patch-anyone-cap.mjs`
- Modify: `apps/handoff/bffless/handoff.proxy-rules.json` (via the script only)
- Test: `apps/handoff/src/lib/anyoneGrantRule.test.ts` (append)

**Interfaces:**
- Produces: the `POST /api/grants` `merge` step forces `level:'view'` and `principalEmail:null` whenever `principalId === 'anyone'`. (`POST /api/grants/revoke` already revokes by bare `principalId` — no change.)

- [ ] **Step 1: Write the failing guard + behavioral test** (append to `anyoneGrantRule.test.ts`)

```ts
describe('grants merge caps the Anyone principal at view', () => {
  const grantsPost = proxy.rules.find(
    (r) => r.pathPattern === '/api/grants' && r.method === 'POST',
  )!
  const mergeStep = grantsPost.pipelineConfig.steps.find((s: any) => s.id === 'merge')
  const mergeCode: string = mergeStep.config.code

  it('contains the cap', () => {
    expect(mergeCode).toContain("pid === 'anyone'")
  })

  it('behaviorally: an edit-level anyone request is stored as view', () => {
    const handler = new Function(`return (${mergeCode})`)() as (ctx: any) => any
    const out = handler({
      user: { id: 'owner-1', role: 'admin' },
      request: { body: { folderId: 'f1', principalId: 'anyone', level: 'edit' } },
      steps: {
        folder: { id: 'f1', ownerId: 'owner-1', grantsJson: '[]' },
        resolveRootShape: { effectiveFolderId: 'f1', rootOwnerId: null },
      },
    })
    expect(out.allowed).toBe(true)
    expect(out.grants).toEqual([{ principalId: 'anyone', principalEmail: null, level: 'view' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter handoff test -- anyoneGrantRule`
Expected: FAIL — cap absent; the behavioral case stores `level:'edit'`.

- [ ] **Step 3: Write the patch script and run it**

The `merge` step in `POST /api/grants` is multi-line (not minified). Anchor on its email line:

```js
// apps/handoff/bffless/scripts/patch-anyone-cap.mjs
// Inserts the Anyone view-cap into the POST /api/grants merge step (ADR-0005).
import { readFileSync, writeFileSync } from 'node:fs'

const P = new URL('../handoff.proxy-rules.json', import.meta.url)
const doc = JSON.parse(readFileSync(P, 'utf8'))

const rule = doc.rules.find((r) => r.pathPattern === '/api/grants' && r.method === 'POST')
const step = rule.pipelineConfig.steps.find((s) => s.id === 'merge')

const ANCHOR = 'var email = body.principalEmail ? String(body.principalEmail) : null;'
const CAP = "\n  if (pid === 'anyone') { level = 'view'; email = null; }"

if (step.config.code.includes("pid === 'anyone'")) {
  console.log('cap already present — nothing to do')
  process.exit(0)
}
if (!step.config.code.includes(ANCHOR)) {
  console.error('anchor line not found in merge step — inspect the step body')
  process.exit(1)
}
step.config.code = step.config.code.replace(ANCHOR, ANCHOR + CAP)
writeFileSync(P, JSON.stringify(doc, null, 2) + '\n')
console.log('anyone view-cap inserted into grants merge')
```

Run: `node apps/handoff/bffless/scripts/patch-anyone-cap.mjs`
Expected stdout: `anyone view-cap inserted into grants merge`

> Note the anchor expects `pid`/`level`/`email` to be declared in that order (`pid` → `level` → `email`) — that is the current shipped body; the behavioral test in Step 1 catches any drift.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter handoff test -- anyoneGrantRule` → PASS.
Validate JSON parses: `node -e "JSON.parse(require('fs').readFileSync('apps/handoff/bffless/handoff.proxy-rules.json'))"`.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/bffless/handoff.proxy-rules.json apps/handoff/bffless/scripts/patch-anyone-cap.mjs apps/handoff/src/lib/anyoneGrantRule.test.ts
git commit -m "feat(handoff): grants write path caps the Anyone principal at view"
```

---

## Task 4: UI — "General access" section in the Share dialog

**Files:**
- Modify: `apps/handoff/src/components/ManageAccessPanel.tsx` (add `GeneralAccess`; filter Anyone out of `PeopleAccess`)
- Modify: `apps/handoff/src/components/ShareDialog.tsx`
- Modify: `apps/handoff/src/components/ShareLinksSection.tsx`
- Test: `apps/handoff/src/components/generalAccess.test.tsx` *(new)*

**Interfaces:**
- Consumes: `ANYONE_PRINCIPAL`, `hasAnyoneGrant` (Task 1); existing `useGetGrantsQuery` / `useAddGrantMutation` / `useRevokeGrantMutation` (`src/store/handoffApi.ts:496-535`).
- Produces: `GeneralAccess({ folderId }: { folderId: string })` exported from `ManageAccessPanel.tsx`; `ShareLinksSectionProps` gains optional `isPublic?: boolean`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/handoff/src/components/generalAccess.test.tsx
/**
 * GeneralAccess: Public/Private state + toggle, driven by the Anyone grant.
 * Same store-construction + MSW pattern as src/pages/pathRoutes.test.tsx.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, setMockUser, seedFolder, setMockGrants } from '../mocks/handlers'
import { handoffApi } from '../store/handoffApi'
import handoffReducer from '../store/handoffSlice'
import { ANYONE_PRINCIPAL } from '../lib/acl'
import { GeneralAccess, PeopleAccess } from './ManageAccessPanel'

const server = setupServer(...handlers)

// MSW/node needs absolute URLs; RTK Query issues relative ones (same
// workaround as pathRoutes.test.tsx).
const ORIGIN = 'http://localhost:3000'
const RealRequest = globalThis.Request
class BasedRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/')) input = ORIGIN + input
    super(input, init)
  }
}

beforeAll(() => {
  globalThis.Request = BasedRequest as typeof Request
  server.listen({ onUnhandledRequest: 'error' })
})
afterAll(() => {
  globalThis.Request = RealRequest
  server.close()
})
beforeEach(() => resetMockState())
afterEach(() => server.resetHandlers())

function makeStore() {
  return configureStore({
    reducer: { [handoffApi.reducerPath]: handoffApi.reducer, handoff: handoffReducer },
    middleware: (gdm) => gdm().concat(handoffApi.middleware),
  })
}

const OWNER = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }

describe('GeneralAccess', () => {
  it('shows Private and toggles to Public (adds the Anyone grant)', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    render(
      <Provider store={makeStore()}>
        <GeneralAccess folderId={folder.id} />
      </Provider>,
    )
    expect(await screen.findByText('Private')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Make public' }))
    expect(await screen.findByText('Public')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make private' })).toBeInTheDocument()
  })

  it('shows Public for a folder that already has the Anyone grant, and reverts', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    render(
      <Provider store={makeStore()}>
        <GeneralAccess folderId={folder.id} />
      </Provider>,
    )
    expect(await screen.findByText('Public')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Make private' }))
    expect(await screen.findByText('Private')).toBeInTheDocument()
  })
})

describe('PeopleAccess hides the Anyone row', () => {
  it('does not list the anyone principal among people', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [
      { principalId: ANYONE_PRINCIPAL, level: 'view' },
      { principalId: 'u2', principalEmail: 'u2@example.com', level: 'view' },
    ])
    render(
      <Provider store={makeStore()}>
        <PeopleAccess folderId={folder.id} />
      </Provider>,
    )
    expect(await screen.findByText('u2@example.com')).toBeInTheDocument()
    expect(screen.queryByText(ANYONE_PRINCIPAL)).not.toBeInTheDocument()
  })
})
```

> If the MSW mock `POST /api/grants` rejects the synthetic principal or `seedFolder`'s owner doesn't match `OWNER`, align the seeds (owner id `'user-owner'` matches `handlers.ts`'s default). Do not weaken the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter handoff test -- generalAccess`
Expected: FAIL — `GeneralAccess` is not exported.

- [ ] **Step 3: Implement**

In `ManageAccessPanel.tsx`:

1. Add imports: `import { ANYONE_PRINCIPAL, hasAnyoneGrant } from '../lib/acl'`.
2. In `PeopleAccess`, change the grants line to filter the Anyone row:

```ts
  const grants = (data?.grants ?? []).filter((g) => g.principalId !== ANYONE_PRINCIPAL)
```

3. Add the new exported component (below `LevelBadge`, above `DirectorySearch`):

```tsx
function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a13.5 13.5 0 010 18M12 3a13.5 13.5 0 000 18" />
    </svg>
  )
}

/**
 * GeneralAccess — the folder's Public/Private switch (ADR-0005). "Public" is
 * the (Anyone, View) grant on this folder; making it private revokes it.
 * Renders nothing for viewers who can't manage access (grants GET 403s).
 */
export function GeneralAccess({ folderId }: { folderId: string }) {
  const { data, isLoading, isError } = useGetGrantsQuery({ folderId })
  const [addGrant, { isLoading: saving }] = useAddGrantMutation()
  const [revokeGrant, { isLoading: reverting }] = useRevokeGrantMutation()
  const [toggleError, setToggleError] = useState<string | null>(null)

  if (isLoading || isError) return null

  const isPublic = hasAnyoneGrant(data?.grants ?? [])
  const busy = saving || reverting

  async function handleToggle() {
    setToggleError(null)
    const result = isPublic
      ? await revokeGrant({ folderId, principalId: ANYONE_PRINCIPAL })
      : await addGrant({ folderId, principalId: ANYONE_PRINCIPAL, level: 'view' })
    if ('error' in result) {
      setToggleError('Failed to update general access. Please try again.')
    }
  }

  return (
    <div className="mb-4">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">General access</p>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <GlobeIcon className={`h-4 w-4 shrink-0 ${isPublic ? 'text-accent-600' : 'text-muted'}`} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{isPublic ? 'Public' : 'Private'}</p>
            <p className="truncate text-xs text-muted">
              {isPublic
                ? 'Anyone on the internet can view this folder.'
                : 'Only people with access can view this folder.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={handleToggle}
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {busy ? 'Saving…' : isPublic ? 'Make private' : 'Make public'}
        </button>
      </div>
      {toggleError && <p className="mt-1 text-xs text-danger">{toggleError}</p>}
    </div>
  )
}
```

> If `useAddGrantMutation`'s input type requires `principalEmail`, widen it to optional in `handoffApi.ts:504` — the backend already treats it as nullable.

In `ShareDialog.tsx` — query grants once for the public flag, render `GeneralAccess` first, and pass `isPublic` down:

```tsx
import { PeopleAccess, GeneralAccess } from './ManageAccessPanel'
import { useGetGrantsQuery } from '../store/handoffApi'
import { hasAnyoneGrant } from '../lib/acl'
// inside the component (RTK Query dedupes with GeneralAccess/PeopleAccess):
const { data: grantsData } = useGetGrantsQuery({ folderId })
const isPublic = hasAnyoneGrant(grantsData?.grants ?? [])
// in the body:
<div className="max-h-[70vh] overflow-y-auto px-5 py-4">
  <GeneralAccess folderId={folderId} />
  <PeopleAccess folderId={folderId} />
  <ShareLinksSection folderId={folderId} nodeId={nodeId} fileName={isFile ? title : undefined} isPublic={isPublic} />
</div>
```

In `ShareLinksSection.tsx` — add the prop and the note (immediately inside the section's top-level container, before the create-link controls):

```tsx
export interface ShareLinksSectionProps {
  folderId: string
  topDivider?: boolean
  nodeId?: string
  fileName?: string
  /** When true, renders a note that links are redundant while the folder is public. */
  isPublic?: boolean
}
// in the JSX, first child of the section container:
{isPublic && (
  <p className="mb-3 rounded-lg bg-accent-bg px-3 py-2 text-xs text-accent-700">
    This folder is public — anyone can view it without a link. Share links keep working and matter
    again if you make it private.
  </p>
)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter handoff test -- generalAccess` → PASS. Then `pnpm --filter handoff test` (full) and `pnpm --filter handoff lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/src/components/ManageAccessPanel.tsx apps/handoff/src/components/ShareDialog.tsx apps/handoff/src/components/ShareLinksSection.tsx apps/handoff/src/components/generalAccess.test.tsx
git commit -m "feat(handoff): General access (Public/Private) section in the Share dialog"
```

---

## Task 5: UI — signed-out root empty state (extract `EmptyState`)

**Files:**
- Create: `apps/handoff/src/components/EmptyState.tsx` (moved from `FolderView.tsx:1381-1415`)
- Modify: `apps/handoff/src/pages/FolderView.tsx` (remove the inline component; import + pass new props)
- Test: `apps/handoff/src/components/emptyState.test.tsx` *(new)*

**Interfaces:**
- Consumes: `UploadIcon` from `./icons` (already used by the inline version); `adminLoginUrl` from `../lib/session` (already imported in FolderView).
- Produces: `EmptyState({ canWrite, isRoot, signedOut, onNew, onSignIn })` — a signed-out guest at root with nothing visible sees "Nothing public here" + a Sign in button; all existing copy unchanged otherwise.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/handoff/src/components/emptyState.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('signed-out guest at root: public-empty copy + Sign in', async () => {
    const onSignIn = vi.fn()
    render(
      <EmptyState canWrite={false} isRoot signedOut onNew={() => {}} onSignIn={onSignIn} />,
    )
    expect(screen.getByText('Nothing public here')).toBeInTheDocument()
    expect(screen.getByText('Sign in to view your team’s content.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(onSignIn).toHaveBeenCalledOnce()
  })

  it('signed-in writer at root keeps the upload copy', () => {
    render(<EmptyState canWrite isRoot signedOut={false} onNew={() => {}} onSignIn={() => {}} />)
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upload files/ })).toBeInTheDocument()
  })

  it('signed-out guest in a public but empty sub-folder keeps the plain copy', () => {
    render(
      <EmptyState canWrite={false} isRoot={false} signedOut onNew={() => {}} onSignIn={() => {}} />,
    )
    expect(screen.getByText('This folder is empty')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter handoff test -- emptyState`
Expected: FAIL — `./EmptyState` module not found.

- [ ] **Step 3: Implement**

Create `apps/handoff/src/components/EmptyState.tsx` — move the JSX from `FolderView.tsx:1381-1415` verbatim and add the signed-out branch:

```tsx
/**
 * EmptyState — the "nothing in this folder" panel. Extracted from FolderView.
 * The signed-out root variant is the public-browse landing for guests when
 * nothing (or nothing public) is visible (ADR-0005).
 */
import { UploadIcon } from './icons'

export function EmptyState({
  canWrite,
  isRoot,
  signedOut,
  onNew,
  onSignIn,
}: {
  canWrite: boolean
  isRoot: boolean
  signedOut: boolean
  onNew: () => void
  onSignIn: () => void
}) {
  const guestAtRoot = signedOut && isRoot && !canWrite
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-bg text-accent-600">
        <UploadIcon className="h-7 w-7" />
      </div>
      <h2 className="text-base font-semibold text-ink">
        {guestAtRoot ? 'Nothing public here' : isRoot ? 'Nothing here yet' : 'This folder is empty'}
      </h2>
      <p className="mt-1 max-w-sm text-sm text-muted">
        {guestAtRoot
          ? 'Sign in to view your team’s content.'
          : canWrite
            ? 'Drag files or a folder anywhere on this page, or use New to upload content and create sub-folders.'
            : 'There’s nothing to see in this folder yet.'}
      </p>
      {guestAtRoot && (
        <button
          type="button"
          onClick={onSignIn}
          className="mt-5 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-700"
        >
          Sign in
        </button>
      )}
      {!guestAtRoot && canWrite && (
        <button
          type="button"
          onClick={onNew}
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-700"
        >
          <UploadIcon className="h-4 w-4" />
          Upload files
        </button>
      )}
    </div>
  )
}
```

In `FolderView.tsx`: delete the inline `EmptyState` (lines 1381-1415), add `import { EmptyState } from '../components/EmptyState'`, and update the call site (`FolderView.tsx:1300-1306`):

```tsx
{!isLoading && !isError && totalCount === 0 && (
  <EmptyState
    canWrite={canWrite}
    isRoot={folderId === 'root'}
    signedOut={!session?.authenticated}
    onNew={() => filesInputRef.current?.click()}
    onSignIn={() => {
      window.location.href = adminLoginUrl(window.location.href)
    }}
  />
)}
```

> `UploadIcon`'s import path inside FolderView tells you the icons module path — mirror it in `EmptyState.tsx` (expected `../components/icons` → `./icons`). If FolderView no longer references `UploadIcon` elsewhere after the move, drop it from FolderView's imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter handoff test -- emptyState` → PASS. Full suite + `pnpm --filter handoff lint` green (the FolderView edit must not break `pathRoutes`/store tests).

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/src/components/EmptyState.tsx apps/handoff/src/components/emptyState.test.tsx apps/handoff/src/pages/FolderView.tsx
git commit -m "feat(handoff): signed-out public-browse empty state at root"
```

---

## Task 6: MSW end-to-end — anonymous public browsing

**Files:**
- Modify: `apps/handoff/src/mocks/handlers.ts`
- Test: `apps/handoff/src/mocks/anyoneGrant.test.ts` *(new)*

**Interfaces:**
- Consumes: everything above. The mock gates in `handlers.ts` delegate ACL decisions to the canonical `evaluateAccess` (already imported at `handlers.ts:19`), so Task 1 does most of the work; this task removes the mock-only blanket guest 401s so guests reach evaluation, mirroring the real gates.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/handoff/src/mocks/anyoneGrant.test.ts
// @vitest-environment node
/**
 * End-to-end (fetch → MSW) coverage for public browsing via the Anyone grant
 * (ADR-0005): guests reach ACL evaluation, public subtrees are readable and
 * listed, Restricted cuts publicness, revoking Anyone re-privatizes.
 * Same style as shareRoot.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { setupServer } from 'msw/node'
import {
  handlers,
  resetMockState,
  setMockUser,
  setMockGrants,
  seedFolder,
  seedFile,
} from './handlers'
import { ANYONE_PRINCIPAL } from '../lib/acl'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => {
  resetMockState()
  server.resetHandlers()
})

const OWNER = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }
const anyoneGrant = { principalId: ANYONE_PRINCIPAL, level: 'view' as const }

describe('anonymous public browsing', () => {
  it('guest lists a public folder (200) and a private one is 401', async () => {
    setMockUser(OWNER)
    const pub = seedFolder('Public Docs', 'root')
    const priv = seedFolder('Private Docs', 'root')
    seedFile('readme.md', pub.id)
    setMockGrants(pub.id, [anyoneGrant])

    setMockUser(null) // anonymous
    const ok = await fetch(`/api/nodes?parentId=${pub.id}`)
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { nodes: Array<{ name: string }> }
    expect(body.nodes.map((n) => n.name)).toContain('readme.md')

    const denied = await fetch(`/api/nodes?parentId=${priv.id}`)
    expect(denied.status).toBe(401)
  })

  it('guest root listing shows only public subtrees', async () => {
    setMockUser(OWNER)
    const pub = seedFolder('Public Docs', 'root')
    seedFolder('Private Docs', 'root')
    setMockGrants(pub.id, [anyoneGrant])

    setMockUser(null)
    const res = await fetch('/api/nodes?parentId=root')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { nodes: Array<{ name: string }> }
    expect(body.nodes.map((n) => n.name)).toEqual(['Public Docs'])
  })

  it('a Restricted child under a public folder stays hidden from guests', async () => {
    setMockUser(OWNER)
    const pub = seedFolder('Public Docs', 'root')
    const locked = seedFolder('Salaries', pub.id)
    setMockGrants(pub.id, [anyoneGrant])
    // flip the child to restricted in mock ACL state
    const { nodeAcl } = await import('./handlers')
    const acl = nodeAcl.get(locked.id)!
    nodeAcl.set(locked.id, { ...acl, mode: 'restricted' })

    setMockUser(null)
    const res = await fetch(`/api/nodes?parentId=${locked.id}`)
    expect(res.status).toBe(401)
  })

  it('owner grants Anyone with level edit → stored capped at view; revoke re-privatizes', async () => {
    setMockUser(OWNER)
    const pub = seedFolder('Public Docs', 'root')

    const add = await fetch('/api/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: pub.id, principalId: ANYONE_PRINCIPAL, level: 'edit' }),
    })
    expect(add.status).toBe(200)
    const grants = (await (await fetch(`/api/grants?folderId=${pub.id}`)).json()) as {
      grants: Array<{ principalId: string; level: string }>
    }
    expect(grants.grants).toEqual([{ principalId: ANYONE_PRINCIPAL, principalEmail: null, level: 'view' }])

    setMockUser(null)
    expect((await fetch(`/api/nodes?parentId=${pub.id}`)).status).toBe(200)

    setMockUser(OWNER)
    const revoke = await fetch('/api/grants/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: pub.id, principalId: ANYONE_PRINCIPAL }),
    })
    expect(revoke.status).toBe(200)

    setMockUser(null)
    expect((await fetch(`/api/nodes?parentId=${pub.id}`)).status).toBe(401)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter handoff test -- anyoneGrant`
Expected: FAIL — the mock `/api/nodes` 401s all guests before evaluation; the grants mock stores `edit`.

- [ ] **Step 3: Align the mock gates with the real ones** (`handlers.ts`)

Three edits, mirroring the real pipelines:

1. **`GET /api/nodes` (`handlers.ts:637`)** — guests reach evaluation; root is per-child filtered for guests (the real `shape` filters for everyone; the mock's signed-in over-permissiveness at root is pre-existing and out of scope):

```ts
  http.get('/api/nodes', ({ request }) => {
    const parentId = new URL(request.url).searchParams.get('parentId') ?? 'root'

    if (parentId !== 'root') {
      const access = checkAccess(parentId)
      if (access === '401') return new HttpResponse(null, { status: 401 })
      if (access === '403') return new HttpResponse(null, { status: 403 })
    } else if (mockShareLinkFolderId !== null && !mockCurrentUser) {
      // Share-link viewers are folder-scoped; root stays out of scope.
      return new HttpResponse(null, { status: 403 })
    }

    const filtered = [...nodes.values()].filter((n) => n.parentId === parentId)
    // Guests see only children they can access (mirrors the real shape filter).
    const visible =
      !mockCurrentUser && parentId === 'root'
        ? filtered.filter((n) => checkAccess(n.id) === 'ok')
        : filtered
    const withAcl = visible.map((n) => {
      /* …existing mapping unchanged… */
    })
    return HttpResponse.json({ nodes: withAcl })
  })
```

> `checkAccess` is the existing helper around `handlers.ts:199-309`. If its non-error return value is something other than the literal `'ok'` (e.g. it returns the access level), adapt the filter predicate to its actual contract (`checkAccess(n.id) !== '401' && checkAccess(n.id) !== '403'`) rather than changing the helper. The blanket `if (!mockCurrentUser && mockShareLinkFolderId === null) 401` line at root is deleted — that is the point of this task.

2. **`GET /api/node` (`handlers.ts:672`)** — delete the blanket guest 401 first line (`if (!mockCurrentUser && mockShareLinkFolderId === null) return 401`); `checkAccess(id)` now decides (evaluateAccess handles guests since Task 1).

3. **`POST /api/grants` (`handlers.ts:430`)** — mirror the Task 3 cap where the grant object is built from the request body:

```ts
    const level = body.principalId === ANYONE_PRINCIPAL ? 'view' : body.level
    const principalEmail = body.principalId === ANYONE_PRINCIPAL ? null : (body.principalEmail ?? null)
```

Import `ANYONE_PRINCIPAL` from `../lib/acl` at the top of `handlers.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter handoff test -- anyoneGrant` → PASS.
Then the FULL suite: `pnpm --filter handoff test`. The mock 401 changes touch shared fixtures — `shareRoot.test.ts`, `pathRoutes.test.tsx`, `deleteNode`/`shareLinks` tests must stay green. If a pre-existing test asserted a blanket guest 401 on a folder that has no grants, it still passes (evaluation yields `none` → 401); investigate any other failure rather than re-adding the blanket check.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/src/mocks/handlers.ts apps/handoff/src/mocks/anyoneGrant.test.ts
git commit -m "test(handoff): end-to-end anonymous public-browse scenarios"
```

---

## Task 7: Apply to the live rule set + verify (post-merge, operational)

**Files:** `apps/handoff/bffless/README.md` (docs). Requires the PR merged first.

- [ ] **Step 1:** Update the live rules via `mcp__j5s-dev__update_proxy_rule` on set `5d59f6d8-f492-4e18-9edc-6a9d96677b44` so each changed rule's `pipelineConfig` equals the repo JSON: the 7 gate rules carrying `evalAccess` (`GET /api/uploads/content/*`, `GET /api/nodes`, `GET /api/node`, `DELETE /api/node`, `POST /api/sign`, `GET /api/resolve/*`) and `POST /api/grants` (merge cap).
- [ ] **Step 2:** Diff-verify: fetch the live set (`mcp__j5s-dev__get_proxy_rule_set` / per-rule `get_proxy_rule`) and assert each updated rule's `pipelineConfig` matches the repo JSON byte-for-byte (same compare approach as the share-root rollout, plan 2026-07-06 Task 8).
- [ ] **Step 3:** Smoke test on `handoff.j5s.dev`:
  - (a) Share dialog on a test folder → "Make public" → open the folder URL in a logged-out browser → listing renders and a file inside opens (uploads/content + sign paths).
  - (b) Create a `Restricted` child inside it → verify the logged-out browser cannot open the child (401).
  - (c) Logged-out visit to the app root → the public folder is listed; nothing else. "Make private" → logged-out root shows the "Nothing public here" empty state.
  - (d) Verify a POST `/api/grants` with `principalId:'anyone', level:'edit'` (via the API) stores `view` (`query_pipeline_data` on `handoff_nodes`, check `grantsJson`).
- [ ] **Step 4:** Update `apps/handoff/bffless/README.md`: document the Anyone principal (reserved id `anyone`, always `view`, ADR-0005 link) alongside the existing gate/cookie documentation. Commit.

---

## Self-review notes

- **Spec coverage:** ADR-0005 semantics → Tasks 1-3 (read-side match + cap, write-side cap); Share-dialog surface → Task 4; guest root browse + sign-in empty state → Tasks 5-6; share-links note → Task 4; rollout → Task 7. `/api/directory`, `/r/*`, share-link rules, and write gating intentionally untouched (Global Constraints).
- **The 615-char `OLD` body in Task 2 was verified byte-identical across all 7 copies on `main` at c7e96bb.** If `main` moves before execution, re-verify with the Task 2 extraction helper before running the patch script — the script's count check makes drift a loud failure, not a silent one.
- **Frontend `evaluateAccess` callers:** FolderView's `effectiveLevel` for guests changes from `none` to `view` on public folders — it only feeds `canWrite`/`canManage` (both still false) and share-mode display, so no further FolderView changes are needed. `inShareMode` is untouched.
- **hf_f/hf_s cookies:** unchanged. The content gate re-evaluates the full ACL per request (site assets match `allSites` by storage path), so anonymous public Site rendering needs no cookie work; `hf_f`/`hf_s` remain 401-vs-403 credential markers and share-link credentials respectively.
- **Known judgment call:** the mock root listing filters per-child for guests only (Task 6), not for signed-in users — matching the mock's pre-existing behavior for signed-in users to avoid churning unrelated tests; the real backend filters for everyone.
