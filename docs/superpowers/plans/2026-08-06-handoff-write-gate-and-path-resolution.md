# Handoff write gate + path resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate Handoff's four create endpoints on the access model the delete endpoint already uses, and correct the `handoff-api` skill so agents use the existing `GET /api/resolve/<path>` resolver instead of reading the app's node table through the admin API.

**Architecture:** A new `_shared/writeAccess.ts` module wraps `_shared/acl.ts`'s `folderChain` + `evalAccess` into a single `decideWrite()` verdict. Each of the four creation rules gains an `allFolders` `data_query` step, calls `decideWrite()` from its existing `guard.fn.ts` **before** the name-collision check, and gains `401`/`403` response steps. No new access model is introduced — this adds a consumer of the existing one.

**Tech Stack:** BFFless proxy rules authored as YAML + `.fn.ts` handlers (esbuild-bundled into the pipeline sandbox), TypeScript, Vitest.

## Global Constraints

- **Rule handlers may only import within their own rule set directory.** A `.fn.ts` importing a path that escapes `.bffless/proxy-rules/handoff/` is rejected by the bundler.
- **The sandbox has no DOM, no Node built-ins, and no module loader.** Write ES2020 that esbuild can inline. No `async`, no optional chaining in handler bodies (match the surrounding style).
- **A BFFless step `condition` can only reference a simple path.** It cannot express `allow && !collision`. Every branch must arrive from the guard as its own plain boolean.
- **Never mutate a `data_query` row** — the runtime freezes them.
- **`$schema:handoff_nodes`** is the schema reference in rule YAML; the nodes schema UUID in tests is `1c5d4802-596e-4f50-a08f-c41fb8f9fab0`.
- **Two access bars** (from the spec, verbatim): `parentId` absent or `'root'` → any authenticated user; `parentId` a folder UUID → `rank(level) >= 2`.
- **Access is checked before collision.** A denied caller must never learn whether a name exists.
- Run from `apps/handoff/`: `pnpm test:run`, `pnpm typecheck:rules`, `pnpm lint`.
- Spec: `apps/handoff/docs/superpowers/specs/2026-08-06-handoff-path-resolution-and-write-gate-design.md`.

---

### Task 1: The shared write-access module

**Files:**
- Create: `apps/handoff/.bffless/proxy-rules/handoff/_shared/writeAccess.ts`
- Test: `apps/handoff/src/lib/writeAccess.test.ts`

**Interfaces:**
- Consumes: `evalAccess`, `folderChain`, `rank`, and the types `AccessLevel`, `NodeRow`, `Viewer` from `./acl` (existing, unchanged).
- Produces:
  - `viewerFrom(ctx: Pick<HandlerContext, 'user' | 'request' | 'utils'>): Viewer`
  - `decideWrite(opts: { folders: NodeRow[]; parentId: string; viewer: Viewer }): WriteDecision`
  - `interface WriteDecision { allow: boolean; deny401: boolean; deny403: boolean; level: AccessLevel }`

  Tasks 2–5 import both functions and read all four `WriteDecision` fields.

- [ ] **Step 1: Write the failing test**

Create `apps/handoff/src/lib/writeAccess.test.ts`:

```ts
// @vitest-environment node
/**
 * Unit tests for the create-endpoint write gate.
 *
 * The four creation endpoints shipped with no access check at all, so an unauthenticated
 * caller could create nodes (with `ownerId: null`) and any authenticated user could create
 * inside a folder they held no access to. `decideWrite` is the missing check; this pins its
 * decision table, including the 401-vs-403 split that tells a caller whether the problem is
 * a missing credential or an insufficient one.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { decideWrite, viewerFrom } from '../../.bffless/proxy-rules/handoff/_shared/writeAccess'
import type { NodeRow } from '../../.bffless/proxy-rules/handoff/_shared/acl'

const ROOT: NodeRow = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  nodeType: 'root',
  parentId: '',
  ownerId: 'owner-1',
  mode: 'inheriting',
  grantsJson: '[]',
}

const FOLDER_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

function folder(over: Partial<NodeRow> = {}): NodeRow {
  return {
    id: FOLDER_ID,
    nodeType: 'folder',
    displayName: 'Docs',
    parentId: 'root',
    ownerId: 'owner-1',
    mode: 'inheriting',
    grantsJson: '[]',
    ...over,
  }
}

const tree = (over: Partial<NodeRow> = {}) => [ROOT, folder(over)]

describe('decideWrite — root', () => {
  it('allows any authenticated user', () => {
    const d = decideWrite({ folders: tree(), parentId: 'root', viewer: { userId: 'nobody' } })
    expect(d.allow).toBe(true)
    expect(d.deny401).toBe(false)
    expect(d.deny403).toBe(false)
  })

  it('treats an absent parentId as root', () => {
    expect(decideWrite({ folders: tree(), parentId: '', viewer: { userId: 'nobody' } }).allow).toBe(true)
  })

  it('denies an anonymous caller with 401', () => {
    const d = decideWrite({ folders: tree(), parentId: 'root', viewer: {} })
    expect(d.allow).toBe(false)
    expect(d.deny401).toBe(true)
    expect(d.deny403).toBe(false)
  })

  it('denies a share-link visitor with 403 — a credential was presented, it just cannot write', () => {
    const d = decideWrite({ folders: tree(), parentId: 'root', viewer: { shareLinkFolderId: FOLDER_ID } })
    expect(d.allow).toBe(false)
    expect(d.deny401).toBe(false)
    expect(d.deny403).toBe(true)
  })
})

describe('decideWrite — folder', () => {
  it('allows the owner', () => {
    expect(decideWrite({ folders: tree(), parentId: FOLDER_ID, viewer: { userId: 'owner-1' } }).allow).toBe(true)
  })

  it('allows an admin', () => {
    expect(
      decideWrite({ folders: tree(), parentId: FOLDER_ID, viewer: { userId: 'x', isAdmin: true } }).allow,
    ).toBe(true)
  })

  it('allows an edit grantee', () => {
    const folders = tree({ grantsJson: JSON.stringify([{ principalId: 'bob', level: 'edit' }]) })
    expect(decideWrite({ folders, parentId: FOLDER_ID, viewer: { userId: 'bob' } }).allow).toBe(true)
  })

  it('denies a view-only grantee with 403', () => {
    const folders = tree({ grantsJson: JSON.stringify([{ principalId: 'carol', level: 'view' }]) })
    const d = decideWrite({ folders, parentId: FOLDER_ID, viewer: { userId: 'carol' } })
    expect(d.allow).toBe(false)
    expect(d.deny403).toBe(true)
  })

  it('denies a signed-in non-grantee with 403', () => {
    const d = decideWrite({ folders: tree(), parentId: FOLDER_ID, viewer: { userId: 'stranger' } })
    expect(d.allow).toBe(false)
    expect(d.deny403).toBe(true)
  })

  it('denies an anonymous caller with 401', () => {
    const d = decideWrite({ folders: tree(), parentId: FOLDER_ID, viewer: {} })
    expect(d.allow).toBe(false)
    expect(d.deny401).toBe(true)
  })

  it('never lets an anyone-grant reach edit — publicness cannot escalate to write', () => {
    const folders = tree({ grantsJson: JSON.stringify([{ principalId: 'anyone', level: 'edit' }]) })
    expect(decideWrite({ folders, parentId: FOLDER_ID, viewer: {} }).allow).toBe(false)
    expect(decideWrite({ folders, parentId: FOLDER_ID, viewer: { userId: 'stranger' } }).allow).toBe(false)
  })

  it('denies an unknown parentId rather than falling through', () => {
    const d = decideWrite({
      folders: tree(),
      parentId: 'ffffffff-0000-4000-8000-00000000000f',
      viewer: { userId: 'stranger' },
    })
    expect(d.allow).toBe(false)
    expect(d.deny403).toBe(true)
  })
})

describe('viewerFrom', () => {
  const utils = { verify: () => false, base64urlDecode: () => '' }

  it('builds a user viewer from the pipeline user, carrying groups and admin', () => {
    const v = viewerFrom({
      user: { id: 'u1', role: 'admin', groups: ['g1'] },
      request: { headers: {} },
      utils,
    } as any)
    expect(v).toEqual({ userId: 'u1', isAdmin: true, groupIds: ['g1'] })
  })

  it('is anonymous with no user and no valid share cookie', () => {
    expect(viewerFrom({ user: null, request: { headers: {} }, utils } as any)).toEqual({})
  })

  it('ignores a share cookie whose signature does not verify', () => {
    const req = { headers: { cookie: 'hf_s=body.badsig' } }
    expect(viewerFrom({ user: null, request: req, utils } as any)).toEqual({})
  })

  it('reads a valid, unexpired share cookie as a share viewer', () => {
    const payload = { s: FOLDER_ID, exp: Date.now() + 60_000 }
    const shareUtils = {
      verify: () => true,
      base64urlDecode: () => JSON.stringify(payload),
    }
    const req = { headers: { cookie: 'hf_s=body.sig' } }
    expect(viewerFrom({ user: null, request: req, utils: shareUtils } as any)).toEqual({
      shareLinkFolderId: FOLDER_ID,
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/handoff && pnpm test:run src/lib/writeAccess.test.ts
```

Expected: FAIL — `Failed to resolve import ".../_shared/writeAccess"`.

- [ ] **Step 3: Write the module**

Create `apps/handoff/.bffless/proxy-rules/handoff/_shared/writeAccess.ts`:

```ts
/**
 * Handoff's write gate: may this caller create something under `parentId`?
 *
 * The four creation endpoints (POST /api/folders, /api/nodes, /api/sites,
 * /api/uploads/prepare) shipped without any access check — their `guard.fn.ts` decided
 * sibling-name collisions and nothing else. So an unauthenticated caller could create nodes
 * (which recorded `ownerId: null`, since the field is written from `user.id`), and any
 * authenticated user could create inside a folder they hold no access to. This module is the
 * check they were missing, built on the same primitives `DELETE /api/node` already uses.
 *
 * Two bars, matching how `GET /api/nodes` already treats root:
 *  - root (`parentId` absent or the literal `'root'`) is a shared landing area, so any
 *    authenticated user may create there — the listing rule likewise allows the request and
 *    filters per row;
 *  - a folder needs `edit` or better on its chain (`rank >= 2`), the same bar as delete.
 *
 * A share-link visitor's viewer caps at `view`, and an `anyone` grant is capped at `view` by
 * `evalAccess` itself, so neither can ever satisfy the folder bar. There is deliberately no
 * anonymous write path: `Edit` is not grantable to an anonymous principal.
 */
import type { HandlerContext } from 'bffless/handlers';
import {
  evalAccess,
  folderChain,
  rank,
  type AccessLevel,
  type NodeRow,
  type Viewer,
} from './acl';

/** Payload of a Handoff signed cookie: base64url(JSON) + '.' + hmac, with an ms-epoch `exp`. */
interface SignedToken {
  exp?: number;
  /** `hf_s` only: the share link's folder id. */
  s?: string;
  [key: string]: unknown;
}

/** The verdict, precomputed as plain booleans because a step `condition` cannot express logic. */
export interface WriteDecision {
  allow: boolean;
  deny401: boolean;
  deny403: boolean;
  /** Informational — the level the decision was made at. */
  level: AccessLevel;
}

/** Read one cookie off the raw header. The header can arrive as a string or a 1-element array. */
function readCookie(request: HandlerContext['request'], name: string): string {
  let raw: unknown = (request && request.headers && request.headers.cookie) || '';
  if (Array.isArray(raw)) raw = raw[0] || '';
  const cookie = String(raw);
  const parts = cookie.split(';');
  for (const kv of parts) {
    const p = kv.indexOf('=');
    if (p < 0) continue;
    const k = kv.slice(0, p).replace(/^\s+|\s+$/g, '');
    if (k === name) return decodeURIComponent(kv.slice(p + 1));
  }
  return '';
}

/** Verify a `<body>.<sig>` cookie token and return its payload, or null if invalid/expired. */
function verifyToken(utils: HandlerContext['utils'], tok: string): SignedToken | null {
  if (!tok) return null;
  const d = tok.lastIndexOf('.');
  if (d < 1) return null;
  const body = tok.slice(0, d);
  const sig = tok.slice(d + 1);
  if (!body || !sig) return null;
  if (!utils.verify(body, sig)) return null;
  let o: unknown;
  try {
    o = JSON.parse(utils.base64urlDecode(body));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const payload = o as SignedToken;
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

/**
 * Who is asking — a signed-in user, a share-link visitor, or nobody.
 *
 * Every gate in the rule set had its own copy of this; the create gates import it instead of
 * adding four more.
 */
export function viewerFrom(ctx: Pick<HandlerContext, 'user' | 'request' | 'utils'>): Viewer {
  const user = ctx.user;
  const uid = ((user && user.id) || null) as string | null;
  const isAdmin = !!user && user.role === 'admin';
  const groupIds = (user && (user as { groups?: string[] }).groups) || undefined;

  if (uid) return { userId: uid, isAdmin: isAdmin, groupIds: groupIds };

  const stok = verifyToken(ctx.utils, readCookie(ctx.request, 'hf_s'));
  const shareFolderId = stok && stok.s ? String(stok.s) : '';
  if (shareFolderId) return { shareLinkFolderId: shareFolderId };

  return {};
}

/** Decide whether `viewer` may create a node under `parentId`. */
export function decideWrite(opts: {
  folders: NodeRow[];
  parentId: string;
  viewer: Viewer;
}): WriteDecision {
  const viewer: Viewer = opts.viewer || {};
  const parentId = String(opts.parentId || '');
  const isRoot = parentId === '' || parentId === 'root';
  const hasCred = !!viewer.userId || !!viewer.shareLinkFolderId;

  let level: AccessLevel = 'none';
  let allow = false;

  if (isRoot) {
    // Root is everyone's landing area: creating there needs an account, nothing more.
    allow = !!viewer.userId;
    level = allow ? (viewer.isAdmin ? 'owner' : 'edit') : 'none';
  } else {
    level = evalAccess(folderChain(opts.folders || [], parentId), viewer);
    allow = rank(level) >= 2;
  }

  return {
    allow: allow,
    deny401: !allow && !hasCred,
    deny403: !allow && hasCred,
    level: level,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/handoff && pnpm test:run src/lib/writeAccess.test.ts && pnpm typecheck:rules
```

Expected: PASS, and `typecheck:rules` exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/.bffless/proxy-rules/handoff/_shared/writeAccess.ts apps/handoff/src/lib/writeAccess.test.ts
git commit -m "feat(handoff): shared write-access decision for the create endpoints"
```

---

### Task 2: Gate `POST /api/folders`

**Files:**
- Modify: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/folders/post/guard.fn.ts` (full rewrite)
- Modify: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/folders/post/rule.yaml`
- Test: `apps/handoff/src/lib/createWriteGateRule.test.ts` (created here, extended in Tasks 3–5)

**Interfaces:**
- Consumes: `decideWrite`, `viewerFrom` from Task 1.
- Produces: the guard's return shape `{ ok, collision, deny401, deny403 }`, which Tasks 3–5 reproduce exactly and the rule YAML conditions reference.

- [ ] **Step 1: Write the failing test**

Create `apps/handoff/src/lib/createWriteGateRule.test.ts`:

```ts
// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Behavioral + structural guard for the create endpoints' access check.
 *
 * These four pipelines shipped with a `guard` that only decided sibling-name collisions, so
 * an unauthenticated caller could create nodes and any signed-in user could create inside a
 * folder they had no access to. This runs the REAL embedded guard handlers out of the
 * compiled rule set and asserts both the decision and the wiring that carries it into a
 * response, so a refactor cannot silently drop the gate.
 *
 * The pure decision is covered by writeAccess.test.ts; the collision half by
 * nameCollision.test.ts and nameUniquenessRule.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, findRule, handlerOf } from '../test/proxyRules'

const NODES_SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'
const FOLDER_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

const proxy = await loadProxyRules()

const ROOT = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  nodeType: 'root',
  parentId: '',
  ownerId: 'owner-1',
  mode: 'inheriting',
  grantsJson: '[]',
}

const folder = (over: Record<string, unknown> = {}) => ({
  id: FOLDER_ID,
  nodeType: 'folder',
  displayName: 'Docs',
  parentId: 'root',
  ownerId: 'owner-1',
  mode: 'inheriting',
  grantsJson: '[]',
  ...over,
})

/** Every creation pipeline, with the step whose execution must stay gated on `steps.guard.ok`. */
const CASES = [
  { path: '/api/folders', effectStep: 'create' },
  { path: '/api/nodes', effectStep: 'register' },
  { path: '/api/sites', effectStep: 'create' },
  { path: '/api/uploads/prepare', effectStep: 'presigned' },
]

/** Only the endpoints implemented so far — extended as Tasks 3-5 land. */
const IMPLEMENTED = CASES.filter((c) => c.path === '/api/folders')

function callGuard(
  path: string,
  opts: {
    user?: any
    parentId?: string
    name?: string
    sibling?: any[]
    folders?: any[]
  },
) {
  const guard = handlerOf(findRule(proxy.rules, path, 'POST'), 'guard')
  const name = opts.name ?? 'New Thing'
  const parentId = opts.parentId ?? 'root'
  return guard({
    user: opts.user ?? null,
    request: { headers: {}, body: {} },
    utils: { verify: () => false, base64urlDecode: () => '' },
    steps: {
      pre: { parentId, name, check: parentId !== '' && name !== '' },
      sibling: opts.sibling ?? [],
      allFolders: opts.folders ?? [ROOT, folder()],
    },
  })
}

describe.each(IMPLEMENTED)('create write gate — POST $path', ({ path, effectStep }) => {
  const steps = () => findRule(proxy.rules, path, 'POST').pipelineConfig.steps as any[]

  it('queries the folder tree so the guard can walk the chain', () => {
    const all = steps().find((s) => s.id === 'allFolders')
    expect(all.handlerType).toBe('data_query')
    expect(all.config.schemaId).toBe(NODES_SCHEMA)
    expect(all.config.filters.nodeType.op).toBe('in')
    expect(all.config.filters.nodeType.value).toEqual(['folder', 'root'])
  })

  it('runs allFolders before the guard', () => {
    const ids = steps().map((s) => s.id)
    expect(ids.indexOf('allFolders')).toBeLessThan(ids.indexOf('guard'))
  })

  it('answers 401 on steps.guard.deny401 and 403 on steps.guard.deny403', () => {
    const d401 = steps().find((s) => s.id === 'deny401')
    expect(d401.handlerType).toBe('response_handler')
    expect(d401.config.status).toBe(401)
    expect(d401.config.condition).toBe('steps.guard.deny401')

    const d403 = steps().find((s) => s.id === 'deny403')
    expect(d403.handlerType).toBe('response_handler')
    expect(d403.config.status).toBe(403)
    expect(d403.config.condition).toBe('steps.guard.deny403')
  })

  it('still gates the side-effecting step and the 200 on steps.guard.ok', () => {
    expect(steps().find((s) => s.id === effectStep).config.condition).toBe('steps.guard.ok')
    expect(steps().find((s) => s.id === 'response').config.condition).toBe('steps.guard.ok')
  })

  it('denies an anonymous caller with 401, at root and in a folder', () => {
    for (const parentId of ['root', FOLDER_ID]) {
      const r = callGuard(path, { user: null, parentId })
      expect(r.ok).toBe(false)
      expect(r.deny401).toBe(true)
      expect(r.deny403).toBe(false)
    }
  })

  it('allows any authenticated user at root', () => {
    const r = callGuard(path, { user: { id: 'nobody' }, parentId: 'root' })
    expect(r.ok).toBe(true)
    expect(r.deny401).toBe(false)
    expect(r.deny403).toBe(false)
  })

  it('denies a signed-in non-grantee in a folder with 403', () => {
    const r = callGuard(path, { user: { id: 'stranger' }, parentId: FOLDER_ID })
    expect(r.ok).toBe(false)
    expect(r.deny403).toBe(true)
  })

  it('allows an edit grantee in a folder', () => {
    const folders = [ROOT, folder({ grantsJson: JSON.stringify([{ principalId: 'bob', level: 'edit' }]) })]
    const r = callGuard(path, { user: { id: 'bob' }, parentId: FOLDER_ID, folders })
    expect(r.ok).toBe(true)
  })

  it('still reports a collision to an allowed caller', () => {
    const r = callGuard(path, {
      user: { id: 'owner-1' },
      parentId: FOLDER_ID,
      name: 'Taken',
      sibling: [{ displayName: 'Taken' }],
    })
    expect(r.ok).toBe(false)
    expect(r.collision).toBe(true)
  })

  it('never discloses a collision to a denied caller', () => {
    const r = callGuard(path, {
      user: { id: 'stranger' },
      parentId: FOLDER_ID,
      name: 'Taken',
      sibling: [{ displayName: 'Taken' }],
    })
    expect(r.collision).toBe(false)
    expect(r.deny403).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/handoff && pnpm test:run src/lib/createWriteGateRule.test.ts
```

Expected: FAIL — no `allFolders` step (`Cannot read properties of undefined`), and the anonymous case returns `ok: true`.

- [ ] **Step 3: Rewrite the guard**

Replace the entire contents of `apps/handoff/.bffless/proxy-rules/handoff/rules/api/folders/post/guard.fn.ts`:

```ts
import type { HandlerContext } from 'bffless/handlers';
import type { NodeRow } from '../../../../_shared/acl';
import { decideWrite, viewerFrom } from '../../../../_shared/writeAccess';

/** What the `pre` step handed us: the normalized parentId/name and whether a check is warranted. */
interface PreStep {
  parentId?: string;
  name?: string;
  check?: boolean;
}

/** A sibling row from the `data_query` step — name lives under whichever column the row carries. */
interface SiblingRow {
  displayName?: string | null;
  original_name?: string | null;
  filename?: string | null;
}

interface Steps {
  pre?: PreStep;
  sibling?: SiblingRow[];
  allFolders?: NodeRow[];
}

export default function handler({ user, request, steps, utils }: HandlerContext) {
  const s = (steps || {}) as Steps;
  const pre: PreStep = s.pre || {};

  // Access first: a caller who cannot write here never learns whether the name is taken.
  const decision = decideWrite({
    folders: s.allFolders || [],
    parentId: pre.parentId || '',
    viewer: viewerFrom({ user: user, request: request, utils: utils }),
  });
  if (!decision.allow) {
    return { ok: false, collision: false, deny401: decision.deny401, deny403: decision.deny403 };
  }

  if (!pre.check) return { ok: true, collision: false, deny401: false, deny403: false };

  // A name is a path segment under verbatim keys, so it collides with ANY
  // same-named sibling regardless of owner — root included (issue #225).
  const rows: SiblingRow[] = s.sibling || [];
  let hit = false;
  for (let i = 0; i < rows.length; i++) {
    const r: SiblingRow = rows[i] || {};
    const nm = r.displayName != null ? r.displayName : r.original_name != null ? r.original_name : r.filename;
    if (nm === pre.name) {
      hit = true;
      break;
    }
  }
  return { ok: !hit, collision: hit, deny401: false, deny403: false };
}
```

- [ ] **Step 4: Add the pipeline steps**

In `apps/handoff/.bffless/proxy-rules/handoff/rules/api/folders/post/rule.yaml`, insert this block **between** the `sibling` step and the `guard` step:

```yaml
    - id: allFolders
      name: allFolders
      handler: data_query
      config:
        filters:
          nodeType:
            op: in
            value:
              - folder
              - root
        pageSize: 500
        schemaId: $schema:handoff_nodes
```

Then append these two steps **after** the existing `conflict` step, as the last entries under `steps:`:

```yaml
    - id: deny401
      name: deny401
      handler: response_handler
      config:
        body: '{"error":"unauthorized"}'
        status: 401
        condition: steps.guard.deny401
        contentType: application/json
    - id: deny403
      name: deny403
      handler: response_handler
      config:
        body: '{"error":"forbidden"}'
        status: 403
        condition: steps.guard.deny403
        contentType: application/json
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/handoff && pnpm test:run src/lib/createWriteGateRule.test.ts src/lib/nameUniquenessRule.test.ts && pnpm typecheck:rules
```

Expected: PASS. `nameUniquenessRule.test.ts` must still pass unchanged — the collision contract is untouched for allowed callers.

- [ ] **Step 6: Commit**

```bash
git add apps/handoff/.bffless/proxy-rules/handoff/rules/api/folders/post apps/handoff/src/lib/createWriteGateRule.test.ts
git commit -m "fix(handoff): require write access to create a folder"
```

---

### Task 3: Gate `POST /api/nodes`

**Files:**
- Modify: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/nodes/post/guard.fn.ts` (full rewrite)
- Modify: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/nodes/post/rule.yaml`
- Modify: `apps/handoff/src/lib/createWriteGateRule.test.ts` (the `IMPLEMENTED` filter only)

**Interfaces:**
- Consumes: `decideWrite`, `viewerFrom` from Task 1; the guard shape established in Task 2.
- Produces: nothing new.

- [ ] **Step 1: Extend the test to cover this endpoint**

In `apps/handoff/src/lib/createWriteGateRule.test.ts`, change the `IMPLEMENTED` filter to:

```ts
/** Only the endpoints implemented so far — extended as Tasks 3-5 land. */
const IMPLEMENTED = CASES.filter((c) => c.path === '/api/folders' || c.path === '/api/nodes')
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/handoff && pnpm test:run src/lib/createWriteGateRule.test.ts
```

Expected: FAIL on the `/api/nodes` cases only; `/api/folders` still passes.

- [ ] **Step 3: Rewrite the guard**

Replace the entire contents of `apps/handoff/.bffless/proxy-rules/handoff/rules/api/nodes/post/guard.fn.ts` with the **exact same content as Task 2 Step 3** (same directory depth, so the `../../../../_shared/…` import paths are unchanged).

- [ ] **Step 4: Add the pipeline steps**

In `apps/handoff/.bffless/proxy-rules/handoff/rules/api/nodes/post/rule.yaml`, insert the `allFolders` block between `sibling` and `guard`, and append `deny401` + `deny403` after `conflict` — **the same YAML as Task 2 Step 4, verbatim.**

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/handoff && pnpm test:run src/lib/createWriteGateRule.test.ts src/lib/nameUniquenessRule.test.ts src/lib/verbatimUploadRule.test.ts && pnpm typecheck:rules
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/handoff/.bffless/proxy-rules/handoff/rules/api/nodes/post apps/handoff/src/lib/createWriteGateRule.test.ts
git commit -m "fix(handoff): require write access to register a node"
```

---

### Task 4: Gate `POST /api/sites`

**Files:**
- Modify: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/sites/post/guard.fn.ts` (full rewrite)
- Modify: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/sites/post/rule.yaml`
- Modify: `apps/handoff/src/lib/createWriteGateRule.test.ts` (the `IMPLEMENTED` filter only)

**Interfaces:**
- Consumes: `decideWrite`, `viewerFrom` from Task 1; the guard shape from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Extend the test to cover this endpoint**

```ts
/** Only the endpoints implemented so far — extended as Task 5 lands. */
const IMPLEMENTED = CASES.filter((c) => c.path !== '/api/uploads/prepare')
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/handoff && pnpm test:run src/lib/createWriteGateRule.test.ts
```

Expected: FAIL on the `/api/sites` cases only.

- [ ] **Step 3: Rewrite the guard**

Replace the entire contents of `apps/handoff/.bffless/proxy-rules/handoff/rules/api/sites/post/guard.fn.ts` with the **exact same content as Task 2 Step 3** (same directory depth).

- [ ] **Step 4: Add the pipeline steps**

In `apps/handoff/.bffless/proxy-rules/handoff/rules/api/sites/post/rule.yaml`, insert the `allFolders` block between `sibling` and `guard`, and append `deny401` + `deny403` after `conflict` — **the same YAML as Task 2 Step 4, verbatim.**

Note this pipeline has a `build` step between `guard` and `create`. Leave it where it is; it is already effectively gated because `create`, `shape`, and `response` all condition on `steps.guard.ok`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/handoff && pnpm test:run src/lib/createWriteGateRule.test.ts src/lib/sitesUnifiedRule.test.ts src/lib/nameUniquenessRule.test.ts && pnpm typecheck:rules
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/handoff/.bffless/proxy-rules/handoff/rules/api/sites/post apps/handoff/src/lib/createWriteGateRule.test.ts
git commit -m "fix(handoff): require write access to register a site"
```

---

### Task 5: Gate `POST /api/uploads/prepare`

This one matters most: it mints presigned PUT URLs, so leaving it ungated would let an unauthenticated caller write bytes into the bucket even with the three register endpoints closed.

**Files:**
- Modify: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/uploads/prepare/post/guard.fn.ts` (full rewrite)
- Modify: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/uploads/prepare/post/rule.yaml`
- Modify: `apps/handoff/src/lib/createWriteGateRule.test.ts` (the `IMPLEMENTED` filter only)

**Interfaces:**
- Consumes: `decideWrite`, `viewerFrom` from Task 1; the guard shape from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Extend the test to cover all four endpoints**

Delete the `IMPLEMENTED` constant entirely and change the `describe.each` to iterate `CASES`:

```ts
describe.each(CASES)('create write gate — POST $path', ({ path, effectStep }) => {
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/handoff && pnpm test:run src/lib/createWriteGateRule.test.ts
```

Expected: FAIL on the `/api/uploads/prepare` cases only.

- [ ] **Step 3: Rewrite the guard**

Replace the entire contents of `apps/handoff/.bffless/proxy-rules/handoff/rules/api/uploads/prepare/post/guard.fn.ts`. This is the Task 2 guard with **one extra `../` on both imports** — this rule sits one directory deeper than the other three:

```ts
import type { HandlerContext } from 'bffless/handlers';
import type { NodeRow } from '../../../../../_shared/acl';
import { decideWrite, viewerFrom } from '../../../../../_shared/writeAccess';

/** What the `pre` step handed us: the normalized parentId/name and whether a check is warranted. */
interface PreStep {
  parentId?: string;
  name?: string;
  check?: boolean;
}

/** A sibling row from the `data_query` step — name lives under whichever column the row carries. */
interface SiblingRow {
  displayName?: string | null;
  original_name?: string | null;
  filename?: string | null;
}

interface Steps {
  pre?: PreStep;
  sibling?: SiblingRow[];
  allFolders?: NodeRow[];
}

export default function handler({ user, request, steps, utils }: HandlerContext) {
  const s = (steps || {}) as Steps;
  const pre: PreStep = s.pre || {};

  // Access first: a caller who cannot write here never learns whether the name is taken.
  const decision = decideWrite({
    folders: s.allFolders || [],
    parentId: pre.parentId || '',
    viewer: viewerFrom({ user: user, request: request, utils: utils }),
  });
  if (!decision.allow) {
    return { ok: false, collision: false, deny401: decision.deny401, deny403: decision.deny403 };
  }

  if (!pre.check) return { ok: true, collision: false, deny401: false, deny403: false };

  // A name is a path segment under verbatim keys, so it collides with ANY
  // same-named sibling regardless of owner — root included (issue #225).
  const rows: SiblingRow[] = s.sibling || [];
  let hit = false;
  for (let i = 0; i < rows.length; i++) {
    const r: SiblingRow = rows[i] || {};
    const nm = r.displayName != null ? r.displayName : r.original_name != null ? r.original_name : r.filename;
    if (nm === pre.name) {
      hit = true;
      break;
    }
  }
  return { ok: !hit, collision: hit, deny401: false, deny403: false };
}
```

- [ ] **Step 4: Add the pipeline steps**

In `apps/handoff/.bffless/proxy-rules/handoff/rules/api/uploads/prepare/post/rule.yaml`, insert the `allFolders` block between `sibling` and `guard`, and append `deny401` + `deny403` after `conflict` — **the same YAML as Task 2 Step 4, verbatim.**

> A Site's assets are uploaded with **no `parentId`**, which lands on the root bar: any authenticated user may mint those presigned URLs. That is intended — the assets are bucket objects with no node to attach a grant to, and the Site node they belong to is gated separately by Task 4.

- [ ] **Step 5: Run the full suite**

```bash
cd apps/handoff && pnpm test:run && pnpm typecheck:rules && pnpm lint
```

Expected: all PASS. If `verbatimUploadRule.test.ts` or `folderImport.test.ts` fail, they are calling the guard without an `allFolders` step or an authenticated `user` — add both to their fixture contexts rather than weakening the gate.

- [ ] **Step 6: Commit**

```bash
git add apps/handoff/.bffless/proxy-rules/handoff/rules/api/uploads/prepare/post apps/handoff/src/lib/createWriteGateRule.test.ts
git commit -m "fix(handoff): require write access to mint a presigned upload"
```

---

### Task 6: Correct the `handoff-api` skill

PR #294 (`bffless/apps`, branch `docs/handoff-api-path-resolution-and-key-limits`, single commit `2996c7d81db2`) documents this failure but encodes two wrong conclusions. Cherry-pick it so its correct content and authorship survive, then fix the two sections.

**Files:**
- Modify: `plugins/bffless-apps/skills/handoff-api/SKILL.md`
- Modify: `.claude/skills/handoff-api/SKILL.md` (byte-identical mirror)
- Modify: `.agents/skills/handoff-api/SKILL.md` (byte-identical mirror)
- Modify: `.claude-plugin/marketplace.json`, `plugins/bffless-apps/.claude-plugin/plugin.json` (both to `0.1.4`)

**Interfaces:**
- Consumes: the `401`/`403` responses added in Tasks 2–5.
- Produces: nothing code-facing.

- [ ] **Step 1: Cherry-pick PR #294**

```bash
git fetch origin docs/handoff-api-path-resolution-and-key-limits
git cherry-pick 2996c7d81db2
```

If it conflicts, resolve by taking #294's side wholesale — the corrections come next.

- [ ] **Step 2: Replace the wrong key-diagnosis block**

In all three SKILL.md copies, delete the paragraph beginning **"Check what your key actually resolves to before trusting that. Some project keys carry *no user identity*"** through **"…rather than leaving strays the user has to clean up by hand."** and put this in its place:

```markdown
**Check that the instance actually recognises your key.** An unrecognised key is
not rejected — it falls through to *anonymous*, and the read endpoints answer
anonymously rather than erroring. The usual cause is a key for a **different
instance**: `bffless login` stores one credential per admin URL, and `auth token`
will hand you whichever one it resolves. Confirm with one call:

    curl -s "$HANDOFF_BASE_URL/api/nodes" | head -c 200                       # anonymous
    curl -s -H "X-API-Key: $BFFLESS_API_KEY" "$HANDOFF_BASE_URL/api/nodes"    # keyed

**If the two match, your key is not being recognised — stop and fix it, do not
work around it.** Check that the admin URL you logged into belongs to the same
instance as `$HANDOFF_BASE_URL` (`handoff.example.com` → `admin.example.com`),
then `npx bffless login --api-url https://admin.example.com`. A recognised key
authenticates as its owner: nodes it creates carry that user's `ownerId`, and it
can list, delete, and patch them.

Every write is now rejected with `401` when the key is unrecognised. Older
deployments accepted those writes and recorded `"ownerId": null` — orphans that
no API key can delete, because no key can reach `edit` on them. If you find some,
tell the user; they need an admin in the browser.
```

- [ ] **Step 3: Replace the wrong path-resolution section**

Delete the entire section **"## Finding a folder's id from its path"** (from its heading through "…don't infer one from the other.") and put this in its place:

```markdown
## Resolve a path to a node

Every write is keyed by `parentId`, but users hand you *paths* — a URL like
`https://handoff.example.com/tree/claude`, or just "put it in claude".
`GET /api/resolve/<path>` turns one into the other:

    curl -s -H "X-API-Key: $BFFLESS_API_KEY" "$HANDOFF_BASE_URL/api/resolve/claude"
    → {"node":{"id":"a46c2c42-…","type":"folder","path":"claude",
               "parentId":"root","mode":"restricted","ownerId":"…"}}

The path is everything after `/tree/` or `/blob/` in the browser URL, encoded per
segment (`Design%20Docs/Q3`). Folders resolve by walking names down the tree,
files and Sites by their storage key. It runs the same ACL gate as the serve
endpoint, so the answer reflects what you may actually see:

| Status | Meaning |
| --- | --- |
| `200` | Resolved and readable — use `node.id` as `parentId`. |
| `401` | No credential presented, or the key is unrecognised (above). |
| `403` | The path exists, you have no access to it. |
| `404` | No such path. |

Use it before any write into a named folder. **Do not** tree-walk
`GET /api/nodes?parentId=…` hunting for an id, and **do not** read the app's node
table through the BFFless admin API — `resolve` is the supported route and it
sees restricted folders that a listing will never show you.

`GET /api/nodes?path=…` is *not* a resolver: the parameter is silently ignored
and you get the whole root listing back, which looks like an answer and is not
one.
```

- [ ] **Step 4: Document the write gate in Gotchas**

In the `## Gotchas` list, add these two bullets immediately after the "An empty root listing is normal" bullet:

```markdown
- **Creating requires access to the destination.** `POST /api/folders`,
  `/api/nodes`, `/api/sites`, and `/api/uploads/prepare` answer `401` with no
  credential and `403` without `edit` on the target folder. The check runs
  *before* the name-collision check, so a `403` tells you nothing about whether
  the name is free. At root, any authenticated user may create.
- **A `409` at root can name something you cannot see.** Root is a shared
  namespace and in-folder uniqueness is owner-blind, so a name taken by another
  user's private folder collides for you too. Pick a different name — do not
  switch to the root node's UUID to get around it (next bullet).
```

- [ ] **Step 5: Mirror the copies and verify they are identical**

```bash
cp plugins/bffless-apps/skills/handoff-api/SKILL.md .claude/skills/handoff-api/SKILL.md
cp plugins/bffless-apps/skills/handoff-api/SKILL.md .agents/skills/handoff-api/SKILL.md
diff plugins/bffless-apps/skills/handoff-api/SKILL.md .claude/skills/handoff-api/SKILL.md
diff plugins/bffless-apps/skills/handoff-api/SKILL.md .agents/skills/handoff-api/SKILL.md
```

Expected: both diffs silent.

- [ ] **Step 6: Verify conventions and commit**

```bash
node scripts/check-app-conventions.mjs
```

Expected: exits 0 (this checks that `marketplace.json` and `plugin.json` versions match — the cherry-pick set both to `0.1.4`).

```bash
git add plugins/bffless-apps .claude/skills/handoff-api .agents/skills/handoff-api .claude-plugin/marketplace.json
git commit -m "docs(handoff-api): resolve paths with GET /api/resolve, correct the key diagnosis"
```

---

### Task 7: Verify against a live preview

The unit tests run the real handlers but not the real pipeline runner. Before merging, confirm the deployed behavior.

**Files:** none — verification only.

- [ ] **Step 1: Open the PR so `preview-handoff.yml` deploys a preview rule set**

```bash
git push -u origin feat/handoff-write-gate
gh pr create --title "fix(handoff): gate the create endpoints on write access" --body-file - <<'EOF'
Gates `POST /api/folders`, `/api/nodes`, `/api/sites`, and `/api/uploads/prepare`
on the same access model `DELETE /api/node` already uses, and corrects the
`handoff-api` skill to use the existing `GET /api/resolve/<path>` resolver.

Supersedes #294 (cherry-picked here, with its two wrong conclusions corrected).

Spec: `apps/handoff/docs/superpowers/specs/2026-08-06-handoff-path-resolution-and-write-gate-design.md`
EOF
```

Note `--body-file -` for a heredoc body; `--body -` writes a literal `-`.

- [ ] **Step 2: Smoke the preview**

Against the preview URL the workflow comments on the PR (`$PREVIEW`), with a key for that instance in `$K`:

```bash
curl -s -o /dev/null -w "anon folders:   %{http_code}\n" -X POST "$PREVIEW/api/folders" -H "Content-Type: application/json" -d '{"parentId":"root","name":"zz-gate-probe"}'
curl -s -o /dev/null -w "anon prepare:   %{http_code}\n" -X POST "$PREVIEW/api/uploads/prepare" -H "Content-Type: application/json" -d '{"filename":"a.txt","contentType":"text/plain","path":"a.txt","parentId":"root"}'
curl -s -o /dev/null -w "keyed folders:  %{http_code}\n" -X POST "$PREVIEW/api/folders" -H "X-API-Key: $K" -H "Content-Type: application/json" -d '{"parentId":"root","name":"zz-gate-probe","createdMs":0}'
curl -s -w "\nresolve: %{http_code}\n" -H "X-API-Key: $K" "$PREVIEW/api/resolve/zz-gate-probe"
```

Expected: `401`, `401`, `200`, `200` — and the resolve returns the id of the folder the keyed call just made.

- [ ] **Step 3: Confirm the browser UI is unaffected**

Sign in to the preview and, as a normal user: create a folder, upload a file into it, and import an HTML file as a Site. All three must succeed. This is the regression that matters — the UI sends session cookies, so it should be untouched, but the create path is exactly what changed.

- [ ] **Step 4: Clean up the probe and report**

Delete `zz-gate-probe` (`DELETE /api/node?id=<id>` with `$K`, which now works because the keyed create recorded a real `ownerId`), then report the four status codes and the UI result on the PR.

---

## Follow-ups (explicitly out of scope)

Tracked in the spec, not built here:

- Accept `path` in place of `parentId` on the four write endpoints, removing the resolve round trip.
- Make `GET /api/nodes?path=` filter or error instead of being silently ignored.
- Alias the root node's UUID to `"root"`, or reject it.
- Carry `prepare`'s `contentType` through to the registered node's mime.
- Refresh `node.size` after an overwrite.
- The two pre-existing `ownerId: null` strays on `handoff.sahp.app` (`claude-test`, `zz-probe-2350045`) need an admin in the browser.
