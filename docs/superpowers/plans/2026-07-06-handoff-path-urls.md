# Handoff Path URLs (/tree, /blob) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace UUID app URLs (`/folder/<id>`, `/view/<id>`) with GitHub-style path URLs (`/tree/<path>`, `/blob/<path>`) resolved server-side, per `docs/superpowers/specs/2026-07-06-handoff-path-urls-design.md`.

**Architecture:** A new `GET /api/resolve/*` proxy-rule pipeline resolves a decoded content path to a node using the exact ACL gate the serve rule uses (works for owners, admins, nested grantees, share visitors). The `GET /api/nodes` / `GET /api/node` pipelines additionally emit a server-computed `path` for every node (folders included) so all link generation is `node.path`-driven. The SPA adds `/tree/*` + `/blob/*` routes that resolve then render the existing `FolderView` / viewer internals; legacy id routes redirect.

**Tech Stack:** React 19 + react-router-dom v6 (`apps/handoff`), RTK Query, MSW v2 mocks, Vitest (+ @testing-library/react, jsdom), BFFless proxy-rule pipelines (embedded ES5-ish JS, sandboxed — `var` only, no `.map()` on query results).

## Global Constraints

- Work on branch `feat/handoff-path-urls` in `/home/rico/bffless/repos/apps` (NOT a worktree — owner's instruction). All paths below are relative to `apps/handoff/` unless prefixed with `docs/` or absolute.
- Run tests from `apps/handoff/`: `pnpm test:run <file>` (or `pnpm test:run` for all). Run lint with `pnpm lint` from `apps/handoff/`.
- Commit after each task (owner pre-authorized commits on this branch). Commit messages: conventional style, scope `handoff`, and end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- URLs contain **no root segment**: `/tree/Test`, not `/tree/Home/Test`. Root is `/`. Root label in UI is `~/` (exact two characters).
- Embedded pipeline JS runs in a sandboxed VM: use `var`, `for` loops (never `.map`/`.filter` on `data_query` results), no `crypto`/`fetch`/`Buffer`. Percent-decoding is **per-segment** with `try/catch` keeping the raw segment on malformed escapes (same contract as PR #177).
- `bffless/handoff.proxy-rules.json` is the rule-set source of truth. Edit it with **surgical string replacement** (python `str.replace` with `assert count==1`, or careful editing) — NEVER re-serialize the whole file (`json.dump` reformats 3,500 lines).
- The live rule set (`5d59f6d8-f492-4e18-9edc-6a9d96677b44`) is deployed by the OWNER via MCP after merge (Task 9). Never attempt live MCP writes from a subagent.
- Handoff node schema id (`handoff_nodes`): `1c5d4802-596e-4f50-a08f-c41fb8f9fab0`. Deployment owner/repo: `bffless/apps`. Content keys: `bffless/apps/uploads/content/<path>`.

---

### Task 1: `pathUrl` pure helpers

**Files:**
- Create: `src/lib/pathUrl.ts`
- Test: `src/lib/pathUrl.test.ts`

**Interfaces:**
- Produces (later tasks import these exact names from `../lib/pathUrl` or `./pathUrl`):
  - `encodePath(path: string): string` — per-segment `encodeURIComponent`, joined with `/`
  - `pathFromPathname(pathname: string, prefix: '/tree/' | '/blob/' | '/api/resolve/'): string` — slice prefix, split on `/`, per-segment decode (malformed escape keeps raw segment), drop empty segments, re-join
  - `treeUrl(path: string): string` — `'/'` when path is `''`, else `/tree/<encoded>`
  - `blobUrl(path: string): string` — `/blob/<encoded>`
  - `parentPath(path: string): string` — everything before the last `/`, `''` if none
  - `nodeUrl(node: { type: string; path: string | null; id: string }): string` — folders → `treeUrl(node.path)` or legacy `/folder/<id>` when `path` is null; files/sites → `blobUrl(node.path)` or legacy `/view/<id>` when `path` is null/empty
  - `crumbPathAt(crumbs: { name: string }[], index: number): string` — join of `crumbs[1..index].name` with `/` (crumb 0 is the synthetic root)

- [ ] **Step 1: Write the failing test**

Create `src/lib/pathUrl.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  encodePath,
  pathFromPathname,
  treeUrl,
  blobUrl,
  parentPath,
  nodeUrl,
  crumbPathAt,
} from './pathUrl'

describe('encodePath / pathFromPathname round-trip', () => {
  it('encodes each segment, preserving slashes between them', () => {
    expect(encodePath('Test/My File.png')).toBe('Test/My%20File.png')
    expect(encodePath('Rapport Été/résumé.md')).toBe(
      'Rapport%20%C3%89t%C3%A9/r%C3%A9sum%C3%A9.md',
    )
  })

  it('round-trips spaces, U+202F, unicode and literal %', () => {
    const names = [
      'Test/Screenshot 2026-07-05 at 2.07.28 PM.png',
      'Rapport Été/résumé.md',
      'a&b/c#d.txt',
      '100%.png',
    ]
    for (const p of names) {
      expect(pathFromPathname(`/blob/${encodePath(p)}`, '/blob/')).toBe(p)
    }
  })

  it('keeps a raw segment on a malformed escape instead of throwing', () => {
    expect(pathFromPathname('/tree/Test/100%zz', '/tree/')).toBe('Test/100%zz')
  })

  it('drops empty segments and returns "" for the bare prefix', () => {
    expect(pathFromPathname('/tree/', '/tree/')).toBe('')
    expect(pathFromPathname('/tree//Test//', '/tree/')).toBe('Test')
    expect(pathFromPathname('/other/x', '/tree/')).toBe('')
  })
})

describe('URL builders', () => {
  it('treeUrl maps "" to "/" and encodes otherwise', () => {
    expect(treeUrl('')).toBe('/')
    expect(treeUrl('Test/Sub Folder')).toBe('/tree/Test/Sub%20Folder')
  })

  it('blobUrl always encodes under /blob/', () => {
    expect(blobUrl('Test/My File.png')).toBe('/blob/Test/My%20File.png')
  })

  it('parentPath strips the final segment', () => {
    expect(parentPath('Test/Sub/file.png')).toBe('Test/Sub')
    expect(parentPath('file.png')).toBe('')
    expect(parentPath('')).toBe('')
  })

  it('nodeUrl prefers path URLs and falls back to legacy id URLs', () => {
    expect(nodeUrl({ type: 'folder', path: 'Test', id: 'f1' })).toBe('/tree/Test')
    expect(nodeUrl({ type: 'folder', path: null, id: 'f1' })).toBe('/folder/f1')
    expect(nodeUrl({ type: 'file', path: 'Test/a.png', id: 'n1' })).toBe('/blob/Test/a.png')
    expect(nodeUrl({ type: 'site', path: null, id: 's1' })).toBe('/view/s1')
    expect(nodeUrl({ type: 'file', path: '', id: 'n2' })).toBe('/view/n2')
  })

  it('crumbPathAt joins names after the synthetic root crumb', () => {
    const crumbs = [{ name: '~/' }, { name: 'Test' }, { name: 'Sub Folder' }]
    expect(crumbPathAt(crumbs, 0)).toBe('')
    expect(crumbPathAt(crumbs, 1)).toBe('Test')
    expect(crumbPathAt(crumbs, 2)).toBe('Test/Sub Folder')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/lib/pathUrl.test.ts`
Expected: FAIL — `Cannot find module './pathUrl'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `src/lib/pathUrl.ts`:

```ts
/**
 * Path-URL helpers (GitHub-style /tree//blob routes — spec
 * docs/superpowers/specs/2026-07-06-handoff-path-urls-design.md).
 *
 * URLs mirror structural-storage content paths exactly: no root segment, one
 * URL segment per node name, percent-encoded per segment. Decoding is
 * per-segment with malformed escapes kept raw — the same contract the serve
 * rules follow (PR #177) — so app URLs and content URLs never disagree.
 */

/** Per-segment encodeURIComponent, preserving the `/` separators. */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg // malformed escape — keep raw
  }
}

/**
 * Extract the decoded content path from a location pathname under a route
 * prefix. Returns '' when the pathname is not under the prefix or has no
 * remainder. Empty segments (doubled or trailing slashes) are dropped.
 */
export function pathFromPathname(
  pathname: string,
  prefix: '/tree/' | '/blob/' | '/api/resolve/',
): string {
  if (!pathname.startsWith(prefix)) return ''
  return pathname
    .slice(prefix.length)
    .split('/')
    .filter((s) => s.length > 0)
    .map(decodeSegment)
    .join('/')
}

/** Folder listing URL. The root folder is the app root, not /tree/. */
export function treeUrl(path: string): string {
  return path ? `/tree/${encodePath(path)}` : '/'
}

/** File/Site viewer URL. */
export function blobUrl(path: string): string {
  return `/blob/${encodePath(path)}`
}

/** The owning folder's path ('' for a root-level node). */
export function parentPath(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i) : ''
}

/**
 * Canonical app URL for a node. Falls back to the legacy id routes when the
 * node has no path yet (e.g. a response from a not-yet-updated backend), so
 * links never break during rollout.
 */
export function nodeUrl(node: { type: string; path: string | null; id: string }): string {
  if (node.type === 'folder') {
    return node.path != null ? treeUrl(node.path) : `/folder/${node.id}`
  }
  return node.path ? blobUrl(node.path) : `/view/${node.id}`
}

/**
 * Path prefix for breadcrumb crumb `index` (crumb 0 is the synthetic root, so
 * its path is '').
 */
export function crumbPathAt(crumbs: { name: string }[], index: number): string {
  return crumbs
    .slice(1, index + 1)
    .map((c) => c.name)
    .join('/')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run src/lib/pathUrl.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/src/lib/pathUrl.ts apps/handoff/src/lib/pathUrl.test.ts
git commit -m "feat(handoff): pathUrl helpers for /tree //blob URLs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: server-computed `path` on `GET /api/nodes` and `GET /api/node`

**Files:**
- Modify: `bffless/handoff.proxy-rules.json` (the `shape` steps of the `GET /api/nodes` rule and the `GET /api/node` rule)
- Test: `src/lib/nodePathRule.test.ts` (create)

**Interfaces:**
- Produces: every node object emitted by both rules gains `path: string | null` —
  folders: ancestor `displayName`s + own name joined with `/` (e.g. `Test/Sub`);
  files/sites: `url` minus the `/api/uploads/content/` prefix; `null` only when underivable.
  The client's `toNode()` (`src/lib/nodes.ts:101-108`) already prefers an explicit `path` field — no client change needed.

**Background — current shape-step code.** Both rules already load `allFolders`
(500-row `data_query` of `nodeType == 'folder'`). The `/api/nodes` `shape`
handler builds `var byId={...}` from `steps.allFolders` and pushes node objects
via `out.push({ id:id, type:t, name:..., ..., createdAt:... })`. The
`/api/node` `shape` handler builds a single `var node = id ? {...} : null`
object and does NOT currently build `byId`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/nodePathRule.test.ts`:

```ts
// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Behavioral guard: the GET /api/nodes and GET /api/node shape steps emit a
 * server-computed `path` for every node (folders included) so the app can
 * build /tree//blob URLs without walking ancestors client-side (path-URLs
 * spec, 2026-07-06). Runs the real embedded handlers.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

const listRule = proxy.rules.find((r) => r.pathPattern === '/api/nodes' && r.method === 'GET')
const nodeRule = proxy.rules.find((r) => r.pathPattern === '/api/node' && r.method === 'GET')

function handlerOf(rule: Record<string, any>, stepId: string): (ctx: any) => any {
  const step = rule.pipelineConfig.steps.find((s: any) => s.id === stepId)
  return new Function(`return (${step.config.code})`)() as (ctx: any) => any
}

// Two nested folders + one file, as flattened data_query rows.
const FOLDER_A = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  nodeType: 'folder',
  displayName: 'Test',
  parentId: 'root',
  ownerId: 'u1',
  mode: 'inheriting',
}
const FOLDER_B = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  nodeType: 'folder',
  displayName: 'Sub Folder',
  parentId: FOLDER_A.id,
  ownerId: 'u1',
  mode: 'inheriting',
}
const FILE_C = {
  id: 'cccccccc-0000-4000-8000-000000000003',
  nodeType: 'file',
  displayName: 'My File.png',
  parentId: FOLDER_B.id,
  ownerId: 'u1',
  url: '/api/uploads/content/Test/Sub Folder/My File.png',
  storage_path: 'bffless/apps/uploads/content/Test/Sub Folder/My File.png',
  createdMs: 1,
  size: 10,
}

describe('GET /api/nodes shape step — node.path', () => {
  it('emits folder paths from ancestor names and file paths from the content url', () => {
    const shape = handlerOf(listRule!, 'shape')
    const out = shape({
      steps: {
        allFolders: [FOLDER_A, FOLDER_B],
        gate: { viewer: { userId: 'u1', isAdmin: false } },
        query: [FOLDER_B, FILE_C],
      },
    })
    const byName = Object.fromEntries(out.nodes.map((n: any) => [n.name, n]))
    expect(byName['Sub Folder'].path).toBe('Test/Sub Folder')
    expect(byName['My File.png'].path).toBe('Test/Sub Folder/My File.png')
  })
})

describe('GET /api/node shape step — node.path', () => {
  it('emits a nested folder path', () => {
    const shape = handlerOf(nodeRule!, 'shape')
    const out = shape({ steps: { query: FOLDER_B, allFolders: [FOLDER_A, FOLDER_B] } })
    expect(out.node.path).toBe('Test/Sub Folder')
  })

  it('emits a file path from the content url', () => {
    const shape = handlerOf(nodeRule!, 'shape')
    const out = shape({ steps: { query: FILE_C, allFolders: [FOLDER_A, FOLDER_B] } })
    expect(out.node.path).toBe('Test/Sub Folder/My File.png')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/lib/nodePathRule.test.ts`
Expected: FAIL — `path` is `undefined` on the emitted nodes.

- [ ] **Step 3: Patch the two shape steps in `bffless/handoff.proxy-rules.json`**

Use a python script with `assert t.count(old) == 1` string replacement (never
re-serialize the file). Three edits:

**(a) `/api/nodes` `shape` — add a `folderPath` helper.** Insert immediately
after the `folderChain(startId)` function definition (anchor: the text
`return ch; }` that closes `folderChain`, followed by ` var vw=`). Inserted
code:

```js
 function folderPath(startId){ var names=[]; var cur=String(startId||''); var g=0; while(cur&&UUID.test(cur)&&byId[cur]&&g<64){ names.push(String(byId[cur].displayName||'Untitled')); cur=byId[cur].parentId||''; g++; } var out=[]; for(var b=names.length-1;b>=0;b--)out.push(names[b]); return out.join('/'); } var CONTENT='/api/uploads/content/';
```

**(b) `/api/nodes` `shape` — emit `path`.** In the `out.push({ ... })` object,
after `storageKey:r.storage_path||null,` insert:

```js
 path:(t==='folder')?folderPath(id):((url&&url.indexOf(CONTENT)===0)?url.slice(CONTENT.length):null),
```

**(c) `/api/node` `shape` — add the map + helper and emit `path`.** This
handler is multi-line JSON-escaped (`\n`). After the line
`var r = (steps && steps.query) || {};` insert (as escaped `\n` lines):

```js
var UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
var folders = (steps && steps.allFolders) || [];
var byId = {};
for (var a = 0; a < folders.length; a++) { var f = folders[a] || {}; var fid = f.id || f.recordId || f.record_id; if (fid) byId[fid] = f; }
function folderPath(startId) { var names = []; var cur = String(startId || ''); var g = 0; while (cur && UUID.test(cur) && byId[cur] && g < 64) { names.push(String(byId[cur].displayName || 'Untitled')); cur = byId[cur].parentId || ''; g++; } var out = []; for (var b = names.length - 1; b >= 0; b--) out.push(names[b]); return out.join('/'); }
var CONTENT = '/api/uploads/content/';
```

and in its `var node = id ? { ... } : null;` object, after
`url: url, storageKey: r.storage_path || null,` insert:

```js
path: (t === 'folder') ? folderPath(id) : ((url && url.indexOf(CONTENT) === 0) ? url.slice(CONTENT.length) : null),
```

After editing, validate: `python3 -c "import json; json.load(open('bffless/handoff.proxy-rules.json'))"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run src/lib/nodePathRule.test.ts`
Expected: PASS.

Run: `pnpm test:run src/lib/directoryRule.test.ts src/lib/verbatimUploadRule.test.ts src/lib/publicRules.test.ts`
Expected: PASS (no regressions in sibling structural guards).

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/bffless/handoff.proxy-rules.json apps/handoff/src/lib/nodePathRule.test.ts
git commit -m "feat(handoff): emit server-computed node.path from /api/nodes and /api/node

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: new `GET /api/resolve/*` proxy rule

**Files:**
- Modify: `bffless/handoff.proxy-rules.json` (append one rule to the `rules` array)
- Test: `src/lib/resolveRule.test.ts` (create)

**Interfaces:**
- Produces: `GET /api/resolve/<encoded path>` → `200 {"node": {...}}` (node shaped exactly like `GET /api/node`'s response, including `path`), or `401/403/404` JSON errors with the same bodies as the serve rule (`{"error":"unauthorized"|"forbidden"|"not found"}`). Task 4's client endpoint consumes this.

- [ ] **Step 1: Write the failing test**

Create `src/lib/resolveRule.test.ts`:

```ts
// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural + behavioral guard for GET /api/resolve/* (path-URLs spec,
 * 2026-07-06): resolves a decoded content path to a node under the SAME ACL
 * gate as the serve rule, so /tree//blob deep links work for owners, nested
 * grantees, and share visitors. Runs the real embedded handlers.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const NODES_SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

const rule = proxy.rules.find((r) => r.pathPattern === '/api/resolve/*')

function handlerOf(stepId: string): (ctx: any) => any {
  const step = rule!.pipelineConfig.steps.find((s: any) => s.id === stepId)
  return new Function(`return (${step.config.code})`)() as (ctx: any) => any
}

const FOLDER_A = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  nodeType: 'folder',
  displayName: 'Test',
  parentId: 'root',
  ownerId: 'owner-1',
  mode: 'inheriting',
  grantsJson: '[]',
}
const FOLDER_B = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  nodeType: 'folder',
  displayName: 'Sub Folder',
  parentId: FOLDER_A.id,
  ownerId: 'owner-1',
  mode: 'inheriting',
  grantsJson: JSON.stringify([{ principalId: 'grantee-1', level: 'view' }]),
}
const FILE_C = {
  id: 'cccccccc-0000-4000-8000-000000000003',
  nodeType: 'file',
  displayName: 'My File.png',
  parentId: FOLDER_B.id,
  ownerId: 'owner-1',
  url: '/api/uploads/content/Test/Sub Folder/My File.png',
  storage_path: 'bffless/apps/uploads/content/Test/Sub Folder/My File.png',
  createdMs: 1,
  size: 10,
}

describe('GET /api/resolve/* — structure', () => {
  it('exists as an enabled GET pipeline rule against the nodes schema', () => {
    expect(rule).toBeTruthy()
    expect(rule!.proxyType).toBe('pipeline')
    expect(rule!.isEnabled).toBe(true)
    expect(rule!.method).toBe('GET')
    const nodeByKey = rule!.pipelineConfig.steps.find((s: any) => s.id === 'nodeByKey')
    expect(nodeByKey.handlerType).toBe('data_query')
    expect(nodeByKey.config.schemaId).toBe(NODES_SCHEMA)
    expect(nodeByKey.config.filters.storage_path.value).toBe('steps.parse.fullKey')
    const respond = rule!.pipelineConfig.steps.find((s: any) => s.id === 'respond')
    expect(respond.handlerType).toBe('response_handler')
    expect(respond.config.condition).toBe('steps.gate.allow')
  })
})

describe('parse step — per-segment decode', () => {
  it('decodes spaces/U+202F and builds the full storage key', () => {
    const parse = handlerOf('parse')
    const out = parse({
      request: { path: '/api/resolve/Test/Sub%20Folder/My%20File.png' },
      deployment: { owner: 'bffless', repo: 'apps' },
    })
    expect(out.path).toBe('Test/Sub Folder/My File.png')
    expect(out.segments).toEqual(['Test', 'Sub Folder', 'My File.png'])
    expect(out.fullKey).toBe('bffless/apps/uploads/content/Test/Sub Folder/My File.png')
    expect(out.hasPath).toBe(true)
  })

  it('keeps a malformed escape raw and rejects dot segments', () => {
    const parse = handlerOf('parse')
    const raw = parse({
      request: { path: '/api/resolve/Test/100%zz.png' },
      deployment: { owner: 'o', repo: 'r' },
    })
    expect(raw.path).toBe('Test/100%zz.png')
    expect(raw.hasPath).toBe(true)
    const dots = parse({
      request: { path: '/api/resolve/Test/../secret' },
      deployment: { owner: 'o', repo: 'r' },
    })
    expect(dots.hasPath).toBe(false)
  })
})

describe('gate step — resolution + ACL', () => {
  function runGate(opts: {
    user?: { id: string; role?: string } | null
    parse: any
    nodeByKey?: any[]
  }) {
    const gate = handlerOf('gate')
    return gate({
      user: opts.user ?? null,
      request: { headers: {} },
      utils: { verify: () => false, base64urlDecode: () => '' },
      steps: {
        parse: opts.parse,
        nodeByKey: opts.nodeByKey ?? [],
        allFolders: [FOLDER_A, FOLDER_B],
      },
    })
  }
  const fileParse = {
    path: 'Test/Sub Folder/My File.png',
    segments: ['Test', 'Sub Folder', 'My File.png'],
    fullKey: 'bffless/apps/uploads/content/Test/Sub Folder/My File.png',
    hasPath: true,
  }
  const folderParse = {
    path: 'Test/Sub Folder',
    segments: ['Test', 'Sub Folder'],
    fullKey: 'bffless/apps/uploads/content/Test/Sub Folder',
    hasPath: true,
  }

  it('resolves a file for its owner with a full node shape', () => {
    const out = runGate({ user: { id: 'owner-1' }, parse: fileParse, nodeByKey: [FILE_C] })
    expect(out.allow).toBe(true)
    expect(out.node.id).toBe(FILE_C.id)
    expect(out.node.type).toBe('file')
    expect(out.node.path).toBe('Test/Sub Folder/My File.png')
    expect(out.node.url).toBe(FILE_C.url)
  })

  it('resolves a nested folder by name-walk for a grantee who cannot see the ancestor', () => {
    const out = runGate({ user: { id: 'grantee-1' }, parse: folderParse })
    expect(out.allow).toBe(true)
    expect(out.node.id).toBe(FOLDER_B.id)
    expect(out.node.type).toBe('folder')
    expect(out.node.path).toBe('Test/Sub Folder')
  })

  it('denies the same nested folder to a stranger with 403 and to anon with 401', () => {
    const stranger = runGate({ user: { id: 'someone-else' }, parse: folderParse })
    expect(stranger.allow).toBe(false)
    expect(stranger.deny403).toBe(true)
    const anon = runGate({ user: null, parse: folderParse })
    expect(anon.allow).toBe(false)
    expect(anon.deny401).toBe(true)
  })

  it('404s an unresolvable path', () => {
    const out = runGate({
      user: { id: 'owner-1' },
      parse: { path: 'Nope/missing', segments: ['Nope', 'missing'], fullKey: 'bffless/apps/uploads/content/Nope/missing', hasPath: true },
    })
    expect(out.allow).toBe(false)
    expect(out.deny404).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/lib/resolveRule.test.ts`
Expected: FAIL — `rule` is undefined (`expect(rule).toBeTruthy()`).

- [ ] **Step 3: Append the rule to `bffless/handoff.proxy-rules.json`**

Append this object to the END of the top-level `rules` array (python: load
positions by string-matching the final `]` of the array is fragile — instead
insert textually before the file's closing `\n ]\n}` with a preceding comma, then
`json.load` to validate). The rule (2-space-per-level indentation matching
neighbors; the `code` values are single-line strings):

```json
{
  "pathPattern": "/api/resolve/*",
  "method": "GET",
  "targetUrl": "http://internal/pipeline",
  "stripPrefix": true,
  "order": 30,
  "timeout": 30000,
  "preserveHost": false,
  "forwardCookies": false,
  "proxyType": "pipeline",
  "isEnabled": true,
  "description": "Resolve a content path (/tree //blob deep link) to its node under the standard ACL gate (path-URLs spec 2026-07-06). Same chain evaluation as the content serve rule; works for owners, nested grantees, and share visitors.",
  "pipelineConfig": {
    "name": "Resolve content path",
    "description": "Decode /api/resolve/<path>, match a file/site by exact storage_path else a folder by name-walk, gate via the folder chain, return the node (with path) or 401/403/404.",
    "steps": [
      { "id": "parse", "name": "parse", "handlerType": "function_handler", "config": { "code": "<PARSE CODE — below>" } },
      { "id": "nodeByKey", "name": "nodeByKey", "handlerType": "data_query", "config": { "filters": { "storage_path": { "op": "eq", "value": "steps.parse.fullKey" } }, "pageSize": 1, "schemaId": "1c5d4802-596e-4f50-a08f-c41fb8f9fab0", "condition": "steps.parse.hasPath" } },
      { "id": "allFolders", "name": "allFolders", "handlerType": "data_query", "config": { "filters": { "nodeType": { "op": "eq", "value": "folder" } }, "pageSize": 500, "schemaId": "1c5d4802-596e-4f50-a08f-c41fb8f9fab0" } },
      { "id": "gate", "name": "gate", "handlerType": "function_handler", "config": { "code": "<GATE CODE — below>" } },
      { "id": "respond", "name": "respond", "handlerType": "response_handler", "config": { "body": "{\"node\": {{{steps.gate.node}}}}", "status": 200, "condition": "steps.gate.allow", "contentType": "application/json" } },
      { "id": "deny404", "name": "deny404", "handlerType": "response_handler", "config": { "body": "{\"error\":\"not found\"}", "status": 404, "condition": "steps.gate.deny404", "contentType": "application/json" } },
      { "id": "deny401", "name": "deny401", "handlerType": "response_handler", "config": { "body": "{\"error\":\"unauthorized\"}", "status": 401, "condition": "steps.gate.deny401", "contentType": "application/json" } },
      { "id": "deny403", "name": "deny403", "handlerType": "response_handler", "config": { "body": "{\"error\":\"forbidden\"}", "status": 403, "condition": "steps.gate.deny403", "contentType": "application/json" } }
    ]
  }
}
```

**PARSE CODE** (single line in the JSON; shown wrapped here):

```js
function handler({ request, deployment }) { var p = (request && request.path) || ''; var marker = '/api/resolve/'; var i = p.indexOf(marker); var rest = (i >= 0) ? p.slice(i + marker.length) : ''; var q = rest.indexOf('?'); if (q >= 0) rest = rest.slice(0, q); var rawSegs = rest.split('/'); var segs = []; var bad = false; for (var s = 0; s < rawSegs.length; s++) { var sg = rawSegs[s]; if (!sg) continue; try { sg = decodeURIComponent(sg); } catch (e) { /* malformed escape - keep raw */ } if (sg === '.' || sg === '..') { bad = true; break; } segs.push(sg); } var path = segs.join('/'); var owner = (deployment && deployment.owner) || ''; var repo = (deployment && deployment.repo) || ''; var hasPath = !bad && segs.length > 0 && !!owner && !!repo; var fullKey = hasPath ? (owner + '/' + repo + '/uploads/content/' + path) : ''; return { path: path, segments: segs, fullKey: fullKey, hasPath: hasPath }; }
```

**GATE CODE** (single line in the JSON; shown wrapped here). The
`readCookie`/`vtok`/`rank`/`evalAccess`/`folderChain` helpers are copied
**byte-for-byte** from the serve rule's gate (`GET /api/uploads/content/*`) —
copy them from the JSON, do not retype:

```js
function handler({ user, request, steps, utils }) { var UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/; function readCookie(name){ /* copy from serve gate */ } function vtok(tok){ /* copy from serve gate */ } function rank(l){ /* copy */ } function evalAccess(ch,vw){ /* copy */ } function folderChain(folders,startId){ /* copy */ } var uid=(user&&user.id)||null; var isAdmin=!!user&&user.role==='admin'; var stok=vtok(readCookie('hf_s')); var shareFolderId=(stok&&stok.s)?String(stok.s):''; var viewer; if(uid)viewer={userId:uid,isAdmin:isAdmin}; else if(shareFolderId)viewer={shareLinkFolderId:shareFolderId}; else viewer={}; var folders=(steps&&steps.allFolders)||[]; var byId={}; for(var a=0;a<folders.length;a++){var f=folders[a]||{};var id0=f.id||f.recordId||f.record_id;if(id0)byId[id0]=f;} function folderPath(startId){ var names=[]; var cur=String(startId||''); var g=0; while(cur&&UUID.test(cur)&&byId[cur]&&g<64){ names.push(String(byId[cur].displayName||'Untitled')); cur=byId[cur].parentId||''; g++; } var out=[]; for(var b=names.length-1;b>=0;b--)out.push(names[b]); return out.join('/'); } var CONTENT='/api/uploads/content/'; function shapeRow(r,path){ var id=r.id||r.recordId||r.record_id||null; var t=r.nodeType||'file'; var size=(typeof r.size==='number')?r.size:(r.size!=null?Number(r.size):null); var created=(typeof r.createdMs==='number')?r.createdMs:(r.createdMs!=null?Number(r.createdMs):0); var grants=r.grantsJson; if(typeof grants==='string'){try{grants=JSON.parse(grants);}catch(e){grants=[];}} if(!grants||Object.prototype.toString.call(grants)!=='[object Array]')grants=[]; return { id:id, type:t, name:r.displayName||r.original_name||r.filename||'Untitled', mime:r.content_type||r.mime_type||null, size:(size!=null&&!isNaN(size))?size:null, url:r.url||null, storageKey:r.storage_path||null, path:path, parentId:r.parentId||'root', ownerId:r.ownerId||null, mode:r.mode||'inheriting', grants:grants, createdAt:(created!=null&&!isNaN(created))?created:0 }; } var segs=(steps&&steps.parse&&steps.parse.segments)||[]; var reqPath=(steps&&steps.parse&&steps.parse.path)||''; var rows=(steps&&steps.nodeByKey)||[]; var hit=(rows&&rows.length)?rows[0]:null; var node=null; var ch=null; if(hit){ var hid=hit.id||hit.recordId||hit.record_id; ch=folderChain(folders,hit.parentId); ch.push({id:hid,ownerId:hit.ownerId||null,grants:[],mode:'inheriting'}); node=shapeRow(hit,reqPath); } else if(segs.length){ var curParent='root'; var cur=null; var curId=null; var ok=true; for(var i=0;i<segs.length;i++){ var found=null; var foundId=null; for(var fid in byId){ var ff=byId[fid]; if(String(ff.parentId||'root')===curParent&&String(ff.displayName||'')===segs[i]){found=ff;foundId=fid;break;} } if(!found){ok=false;break;} cur=found; curId=foundId; curParent=foundId; } if(ok&&cur){ ch=folderChain(folders,curId); node=shapeRow(cur,reqPath); } } var resolved=!!node; var level='none'; var allow=false; if(resolved){ level=evalAccess(ch,viewer); allow=level!=='none'; } var hasCred=!!uid||!!shareFolderId; var deny401=!allow&&resolved&&!hasCred; var deny403=!allow&&resolved&&hasCred; var deny404=!resolved; return { allow:allow, deny401:deny401, deny403:deny403, deny404:deny404, level:level, node:node }; }
```

After editing, validate JSON parses and run the guard suite.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run src/lib/resolveRule.test.ts`
Expected: PASS (all structure, parse, and gate tests).

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/bffless/handoff.proxy-rules.json apps/handoff/src/lib/resolveRule.test.ts
git commit -m "feat(handoff): GET /api/resolve/* rule — path → node under the serve-rule ACL gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: client endpoint + MSW mocks for resolve and node paths

**Files:**
- Modify: `src/store/handoffApi.ts` (add `resolvePath` query after `getNode`, ~line 183)
- Modify: `src/mocks/handlers.ts` (folder `path` in `/api/nodes`, `/api/node` responses; new `GET /api/resolve/*` handler)
- Test: `src/store/resolvePath.test.ts` (create)

**Interfaces:**
- Consumes: `pathFromPathname`, `encodePath` from Task 1; `toNode` (existing).
- Produces:
  - `useResolvePathQuery(path: string)` / hook exported from `src/store/handoffApi.ts` → `HandoffNode | null` (RTK Query; 401-refresh behavior inherited from `baseQueryWithReauth`).
  - Mock nodes now carry `path` (folders too) — computed by a new exported helper `mockNodePath(id: string): string | null` in `src/mocks/handlers.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/store/resolvePath.test.ts` (same jsdom+undici origin scaffold as `src/store/nameUniqueness.test.ts` — copy its `BasedRequest` + store setup verbatim):

```ts
/**
 * Behavioral test for the resolvePath endpoint against the MSW /api boundary
 * (path-URLs spec, 2026-07-06): a path resolves to its node (with path) for
 * an authorized viewer, 404s for garbage, and folder listings now carry
 * server-computed paths.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { handlers, resetMockState, seedFolder, seedFile } from '../mocks/handlers'
import { handoffApi } from './handoffApi'

const server = setupServer(...handlers)

const ORIGIN = 'http://localhost:3000'
const RealRequest = globalThis.Request
class BasedRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/')) input = ORIGIN + input
    super(input, init)
  }
}

function makeStore() {
  return configureStore({
    reducer: { [handoffApi.reducerPath]: handoffApi.reducer },
    middleware: (gDM) => gDM().concat(handoffApi.middleware),
  })
}

beforeAll(() => {
  globalThis.Request = BasedRequest as unknown as typeof Request
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  resetMockState()
  server.resetHandlers()
})
afterAll(() => {
  globalThis.Request = RealRequest
  server.close()
})

describe('resolvePath', () => {
  it('resolves a nested folder path to its node with path populated', async () => {
    const a = seedFolder('Test', 'root')
    const b = seedFolder('Sub Folder', a.id)
    const store = makeStore()
    const node = await store
      .dispatch(handoffApi.endpoints.resolvePath.initiate('Test/Sub Folder'))
      .unwrap()
    expect(node?.id).toBe(b.id)
    expect(node?.type).toBe('folder')
    expect(node?.path).toBe('Test/Sub Folder')
  })

  it('resolves a file path with spaces', async () => {
    const a = seedFolder('Test', 'root')
    const f = seedFile('My File.png', a.id)
    const store = makeStore()
    const node = await store
      .dispatch(handoffApi.endpoints.resolvePath.initiate('Test/My File.png'))
      .unwrap()
    expect(node?.id).toBe(f.id)
    expect(node?.path).toBe('Test/My File.png')
  })

  it('rejects with 404 for a path that resolves to nothing', async () => {
    seedFolder('Test', 'root')
    const store = makeStore()
    const res = await store.dispatch(handoffApi.endpoints.resolvePath.initiate('Nope/missing'))
    expect(res.isError).toBe(true)
    expect((res.error as { status?: number }).status).toBe(404)
  })

  it('listNodes responses carry folder paths', async () => {
    const a = seedFolder('Test', 'root')
    seedFolder('Sub Folder', a.id)
    const store = makeStore()
    const children = await store
      .dispatch(handoffApi.endpoints.listNodes.initiate({ parentId: a.id }))
      .unwrap()
    const sub = children.find((n) => n.name === 'Sub Folder')
    expect(sub?.path).toBe('Test/Sub Folder')
  })
})
```

Note: if `src/mocks/handlers.ts` does not already export seeding helpers named
`seedFolder(name, parentId)` / `seedFile(name, parentId)`, check what the
existing store tests (`nameUniqueness.test.ts`, `importFolder.test.ts`) use to
create mock nodes and either reuse that mechanism or add these two small
exported helpers to `handlers.ts` in Step 3 (they must register the node in
`nodes` and `nodeAcl` exactly like the existing creation handlers do, and
return the created node object with its `id`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/store/resolvePath.test.ts`
Expected: FAIL — `resolvePath` endpoint does not exist (type/compile error) or unhandled `/api/resolve/...` request.

- [ ] **Step 3: Implement endpoint + mocks**

**(a) `src/store/handoffApi.ts`** — import `encodePath` from `../lib/pathUrl`
and add after the `getNode` endpoint:

```ts
    /**
     * GET /api/resolve/<encoded path> → { node: HandoffNode | null }
     * Resolves a /tree//blob content path to its node server-side, under the
     * same ACL gate as content serving — the client cannot walk ancestors it
     * isn't allowed to list (nested grants, share visitors).
     */
    resolvePath: builder.query<HandoffNode | null, string>({
      query: (path) => `api/resolve/${encodePath(path)}`,
      transformResponse: (r) => {
        const n = (r as { node?: unknown }).node
        return n ? toNode(n) : null
      },
      providesTags: (result) => (result ? [{ type: 'Node' as const, id: result.id }] : []),
    }),
```

and add `useResolvePathQuery` to the exported hooks list at the bottom of the
file (match the existing export style).

**(b) `src/mocks/handlers.ts`** — three additions:

1. A path helper near the other ACL helpers:

```ts
/** Compute a node's content path by walking parentId names (mock mirror of the
 *  server-side folderPath). Returns null when the chain is broken. */
export function mockNodePath(id: string): string | null {
  const names: string[] = []
  let cur = id
  let hops = 0
  while (cur && cur !== 'root' && hops < 64) {
    const n = nodes.get(cur)
    if (!n) return null
    names.unshift(n.name ?? 'Untitled')
    cur = n.parentId
    hops++
  }
  return names.join('/')
}
```

(If mock node records store their display name under a different property than
`name` — check the `nodes` map's record shape first — use that property.)

2. Attach `path: mockNodePath(n.id)` to every node object returned by the
`GET /api/nodes` handler (inside its `withAcl` mapping) and the `GET /api/node`
handler (on `nodeWithAcl`).

3. New handler, registered alongside the other `http.get` handlers:

```ts
  /**
   * GET /api/resolve/<encoded path>
   * Response: { node } | 401 | 403 | 404 — mirrors the live resolve rule.
   */
  http.get('/api/resolve/*', ({ request }) => {
    const pathname = new URL(request.url).pathname
    const path = pathname
      .slice('/api/resolve/'.length)
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => {
        try {
          return decodeURIComponent(s)
        } catch {
          return s
        }
      })
      .join('/')
    if (!path) return new HttpResponse(null, { status: 404 })

    // File/site: exact path match. Folder: name-walk from root.
    let target: string | null = null
    for (const [id] of nodes) {
      if (mockNodePath(id) === path) {
        target = id
        break
      }
    }
    if (!target) return HttpResponse.json({ error: 'not found' }, { status: 404 })

    const access = checkAccess(target)
    if (access === '401') return new HttpResponse(null, { status: 401 })
    if (access === '403') return new HttpResponse(null, { status: 403 })

    const node = nodes.get(target)!
    const acl = nodeAcl.get(target)
    return HttpResponse.json({ node: { ...node, ...(acl ?? {}), path } })
  }),
```

(`checkAccess` is the existing exported/module-level ACL helper the
`/api/node` handler already uses — reuse it as-is. If `checkAccess` gates by a
folder id, pass the node's own id exactly like the `/api/node` handler does.)

4. If Step 1 required them, the seeding helpers:

```ts
/** Test seam: create a folder node directly in mock state. */
export function seedFolder(name: string, parentId: string) { /* mirror the POST /api/folders handler's node-creation logic */ }
/** Test seam: create a file node directly in mock state. */
export function seedFile(name: string, parentId: string) { /* mirror the POST /api/nodes register handler's node-creation logic */ }
```

Implement these by extracting/reusing the node-construction code the existing
POST handlers use (same id scheme `nodeCounter`, same `nodeAcl` entries) — do
NOT invent a divergent record shape.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run src/store/resolvePath.test.ts`
Expected: PASS.

Run: `pnpm test:run src/store/ src/lib/`
Expected: PASS — no regressions (existing store tests exercise the modified handlers).

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/src/store/handoffApi.ts apps/handoff/src/mocks/handlers.ts apps/handoff/src/store/resolvePath.test.ts
git commit -m "feat(handoff): resolvePath endpoint + MSW resolve/path mocks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: routes and pages — /tree, /blob, legacy redirects

**Files:**
- Create: `src/pages/PathPages.tsx` (TreePage, BlobPage, LegacyFolderRedirect, LegacyViewRedirect, shared ResolveError)
- Modify: `src/pages/HandoffViewer.tsx` (split into `HandoffViewer` route wrapper + exported `ViewerBody({ id })`; path-based Back target)
- Modify: `src/App.tsx` (routes + `showTree` check)
- Delete: `src/pages/HandoffFolder.tsx` (superseded by LegacyFolderRedirect)

**Interfaces:**
- Consumes: `useResolvePathQuery`, `useGetNodeQuery` (Task 4 / existing), `pathFromPathname`, `treeUrl`, `blobUrl`, `parentPath`, `nodeUrl` (Task 1), `FolderView` (existing, unchanged props `{ folderId: string }`), `InvalidLink` (existing component), `useClaimShareToken` + `shouldClaimToken` (existing).
- Produces: route components used only by `App.tsx`; `ViewerBody({ id }: { id: string })` exported from `HandoffViewer.tsx`.

- [ ] **Step 1: Refactor `HandoffViewer.tsx`**

In `src/pages/HandoffViewer.tsx`:

1. Rename the current exported `HandoffViewer` function to
   `ViewerBody` with signature `export function ViewerBody({ id }: { id: string })`,
   deleting its `useParams` line (`const { id } = useParams<{ id: string }>()`)
   and replacing the `useGetNodeQuery(id ?? '', { skip: !id || ... })` call's
   `!id ||` guard accordingly (id is now always a string). Everything else
   (claim flow, source toggle, previews) stays byte-identical.
2. The Back target becomes path-based with a legacy fallback. Where the file
   currently computes `parentFolderPath(node.parentId)` (two call sites) and
   renders `to={`/folder/${node.parentId}`}` (one call site), define once near
   the top of the component that owns `node`:

```ts
  const backTo = node.path != null && node.path !== ''
    ? treeUrl(parentPath(node.path))
    : parentFolderPath(node.parentId)
```

   and use `backTo` at all three sites (`navigate(backTo)` twice, `to={backTo}`
   once). Import `treeUrl, parentPath` from `../lib/pathUrl`. Note the sites
   live in a child component (`ControlBar` area, lines ~64-122) — thread
   `backTo` (or compute it there from its `node` prop) rather than lifting
   state.
3. Keep `export function HandoffViewer()` OUT of this file — the legacy route
   is replaced by `LegacyViewRedirect` in `PathPages.tsx` (Step 2). Update the
   file's header comment accordingly.

- [ ] **Step 2: Create `src/pages/PathPages.tsx`**

```tsx
/**
 * Path-URL route components (spec 2026-07-06): GitHub-style /tree/<path> and
 * /blob/<path> pages that resolve the path server-side (GET /api/resolve/*),
 * plus redirects that keep the legacy /folder/:id and /view/:id URLs working.
 * Resolution must be server-side: ACL filtering hides ancestors from nested
 * grantees and share visitors, so a client-side walk cannot see the way down.
 */

import { useEffect } from 'react'
import { useLocation, useParams, useSearchParams, Navigate } from 'react-router-dom'
import { useResolvePathQuery, useGetNodeQuery } from '../store/handoffApi'
import { pathFromPathname, treeUrl, blobUrl, nodeUrl } from '../lib/pathUrl'
import { useSession, adminLoginUrl } from '../lib/session'
import { shouldClaimToken } from '../lib/shareGate'
import { useClaimShareToken } from '../store/useClaimShareToken'
import { FolderView } from './FolderView'
import { ViewerBody } from './HandoffViewer'
import { InvalidLink } from '../components/InvalidLink'

/** Shared error rendering for a failed path resolution. */
function ResolveError({ status }: { status?: number }) {
  if (status === 401) {
    return (
      <div className="container-page py-16 text-center">
        <p className="mb-3 text-sm text-ink">Sign in to view this item</p>
        <button
          type="button"
          onClick={() => {
            window.location.href = adminLoginUrl(window.location.href)
          }}
          className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700"
        >
          Sign in
        </button>
      </div>
    )
  }
  if (status === 403) {
    return (
      <div className="container-page py-16 text-center text-sm text-danger">
        You don&apos;t have access to this item.
      </div>
    )
  }
  return (
    <div className="container-page py-16 text-center">
      <p className="text-sm text-muted">Nothing found at this path.</p>
    </div>
  )
}

function Loading() {
  return <div className="py-16 text-center text-sm text-muted">Loading…</div>
}

/** /tree/<path> — folder listing at a path. */
export function TreePage() {
  const { pathname } = useLocation()
  const path = pathFromPathname(pathname, '/tree/')
  const { data: node, isLoading, isError, error } = useResolvePathQuery(path, { skip: !path })

  if (!path) return <Navigate to="/" replace />
  if (isLoading) return <Loading />
  if (isError || !node) {
    return <ResolveError status={(error as { status?: number } | undefined)?.status} />
  }
  // Self-heal a type/route mismatch (file URL pasted under /tree/).
  if (node.type !== 'folder') return <Navigate to={nodeUrl(node)} replace />
  return <FolderView folderId={node.id} />
}

/** /blob/<path> — file/site viewer at a path (share-token aware). */
export function BlobPage() {
  const { pathname } = useLocation()
  const path = pathFromPathname(pathname, '/blob/')
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const { session, loading: sessionLoading } = useSession()
  const authed = session?.authenticated === true

  // Claim the share token BEFORE resolving, so the hf_s cookie gates the
  // resolve call for guests (same ordering the viewer uses for its node fetch).
  const needClaim = !sessionLoading && shouldClaimToken({ token, authenticated: authed })
  const { run: claimToken, data: claimData, isError: claimError } = useClaimShareToken()
  const claimSettled = claimData !== undefined || claimError
  const claimPending = needClaim && !claimSettled

  useEffect(() => {
    if (needClaim && token) void claimToken(token)
  }, [needClaim, token, claimToken])

  const { data: node, isLoading, isError, error } = useResolvePathQuery(path, {
    skip: !path || sessionLoading || claimPending || (needClaim && claimData?.valid === false),
  })

  if (!path) return <Navigate to="/" replace />
  if (sessionLoading || claimPending) return <Loading />
  if (needClaim && (claimError || claimData?.valid === false)) return <InvalidLink />
  if (isLoading) return <Loading />
  if (isError || !node) {
    return <ResolveError status={(error as { status?: number } | undefined)?.status} />
  }
  if (node.type === 'folder') return <Navigate to={nodeUrl(node)} replace />
  return <ViewerBody id={node.id} />
}

/** /folder/:id — legacy URL; redirect to the canonical /tree URL. */
export function LegacyFolderRedirect() {
  const { id } = useParams<{ id: string }>()
  const { data: node, isLoading } = useGetNodeQuery(id ?? '', { skip: !id })
  if (!id) return <Navigate to="/" replace />
  if (node?.path != null) return <Navigate to={treeUrl(node.path)} replace />
  if (!isLoading && node === null) {
    return (
      <div className="container-page py-16 text-center">
        <p className="text-sm text-muted">Folder not found.</p>
      </div>
    )
  }
  // Query error (401/403) or path missing: keep the legacy render so ACL error
  // states behave exactly as before.
  if (!isLoading && node && node.path == null) return <FolderView folderId={id} />
  if (!isLoading && !node) return <FolderView folderId={id} />
  return <Loading />
}

/** /view/:id — legacy URL; redirect to the canonical /blob URL. */
export function LegacyViewRedirect() {
  const { id } = useParams<{ id: string }>()
  const { search } = useLocation()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const { session, loading: sessionLoading } = useSession()
  const authed = session?.authenticated === true

  const needClaim = !sessionLoading && shouldClaimToken({ token, authenticated: authed })
  const { run: claimToken, data: claimData, isError: claimError } = useClaimShareToken()
  const claimSettled = claimData !== undefined || claimError
  const claimPending = needClaim && !claimSettled

  useEffect(() => {
    if (needClaim && token) void claimToken(token)
  }, [needClaim, token, claimToken])

  const { data: node, isLoading } = useGetNodeQuery(id ?? '', {
    skip: !id || sessionLoading || claimPending || (needClaim && claimData?.valid === false),
  })

  if (!id) return <Navigate to="/" replace />
  if (sessionLoading || claimPending) return <Loading />
  if (needClaim && (claimError || claimData?.valid === false)) return <InvalidLink />
  // Canonical redirect, preserving the query string (?token=… survives).
  if (node?.path) return <Navigate to={blobUrl(node.path) + search} replace />
  // Fallback: render in place when the path is unavailable.
  if (!isLoading && node) return <ViewerBody id={id} />
  if (!isLoading && !node) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-muted">File not found.</p>
      </div>
    )
  }
  return <Loading />
}
```

Check the real exported names in `src/lib/shareGate.ts` and
`src/store/useClaimShareToken.ts` before writing imports (the viewer imports
them today — mirror its imports exactly).

- [ ] **Step 3: Update `src/App.tsx` and delete `HandoffFolder.tsx`**

In `src/App.tsx`:

1. Replace the imports of `HandoffViewer` / `HandoffFolder` with:

```tsx
import { TreePage, BlobPage, LegacyFolderRedirect, LegacyViewRedirect } from './pages/PathPages'
```

2. Replace the route block inside `<Route element={<Shell />}>`:

```tsx
          <Route index element={<HandoffHome />} />
          <Route path="tree/*" element={<TreePage />} />
          <Route path="blob/*" element={<BlobPage />} />
          <Route path="view/:id" element={<LegacyViewRedirect />} />
          <Route path="folder/:id" element={<LegacyFolderRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
```

3. Update the sidebar predicate in `Shell`:

```tsx
  // Folder tree only makes sense on listing routes (not the viewer).
  const showTree = pathname === '/' || pathname.startsWith('/tree/') || pathname.startsWith('/folder/')
```

4. `git rm apps/handoff/src/pages/HandoffFolder.tsx` and remove any other
   references to it (grep for `HandoffFolder`).

- [ ] **Step 4: Type-check and run the suite**

Run: `pnpm exec tsc -b && pnpm test:run`
Expected: compile clean; all tests PASS (no component tests exist for the old
routes; store/lib suites must stay green).

- [ ] **Step 5: Commit**

```bash
git add -A apps/handoff/src
git commit -m "feat(handoff): /tree //blob routes with server-side resolution; legacy id routes redirect

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: link emission + `~/` root label

**Files:**
- Modify: `src/pages/FolderView.tsx` (row links, breadcrumb links)
- Modify: `src/components/FolderTree.tsx` (path links, current-folder highlight, root label)
- Modify: `src/lib/tree.ts` (ROOT_CRUMB name → `~/`)
- Modify: `src/lib/tree.test.ts` (root-crumb expectations)

**Interfaces:**
- Consumes: `nodeUrl`, `treeUrl`, `crumbPathAt`, `pathFromPathname` from Task 1; `node.path` from Tasks 2/4.

- [ ] **Step 1: Update `src/lib/tree.ts` + its test**

Change `const ROOT_CRUMB: Crumb = { id: 'root', name: 'Home' }` to
`{ id: 'root', name: '~/' }`. Run
`pnpm test:run src/lib/tree.test.ts` — update every assertion that expects the
root crumb to be named `'Home'` to expect `'~/'` (search the test file for
`'Home'`). Expected after edits: PASS.

- [ ] **Step 2: `src/pages/FolderView.tsx` — rows + breadcrumb**

1. Import: `import { nodeUrl, treeUrl, crumbPathAt } from '../lib/pathUrl'`.
2. In `RowKebab` (line ~687) and `ListingRow` (line ~747), replace

```tsx
  const to = node.type === 'folder' ? `/folder/${node.id}` : `/view/${node.id}`
```

with

```tsx
  const to = nodeUrl(node)
```

3. In `BreadcrumbInner` (line ~176), replace the crumb link target

```tsx
                <Link
                  to={crumb.id === 'root' ? '/' : `/folder/${crumb.id}`}
```

with

```tsx
                <Link
                  to={crumb.id === 'root' ? '/' : treeUrl(crumbPathAt(crumbs, i))}
```

(The crumb names come from the ancestor-resolution machinery, which stays —
it also drives ACL evaluation.)

- [ ] **Step 3: `src/components/FolderTree.tsx` — path links + highlight + label**

1. Import `nodeUrl, treeUrl, pathFromPathname` from `../lib/pathUrl`.
2. Replace `currentFolderId` with a path-based matcher:

```tsx
/** The content path of the folder the current route shows ('' = root; null = no listing route). */
function currentFolderPath(pathname: string): string | null {
  if (pathname === '/' || pathname === '') return ''
  if (pathname.startsWith('/tree/')) return pathFromPathname(pathname, '/tree/')
  return null // viewer / legacy routes → nothing highlighted
}
```

3. Thread paths through `TreeFolder`: add `path: string | null` to
   `TreeFolderProps`; compute `isCurrent = path != null && path === currentPath`
   (rename the `currentId` prop to `currentPath: string | null`); child render
   passes `path={f.path}`; the link becomes

```tsx
  const to = id === rootId && rootId === 'root' ? '/' : nodeUrl({ type: 'folder', path, id })
```

4. In `FolderTree()`: `const currentPath = currentFolderPath(pathname)`; root
   `TreeFolder` gets `path={rootId === 'root' ? '' : (sharedRoot?.path ?? null)}`;
   the root display name becomes

```tsx
  const rootName = rootId === 'root' ? '~/' : (sharedRoot?.name ?? 'Shared folder')
```

- [ ] **Step 4: Type-check, lint, full suite**

Run: `pnpm exec tsc -b && pnpm lint && pnpm test:run`
Expected: clean compile, no lint errors, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/src/pages/FolderView.tsx apps/handoff/src/components/FolderTree.tsx apps/handoff/src/lib/tree.ts apps/handoff/src/lib/tree.test.ts
git commit -m "feat(handoff): emit path URLs everywhere; root label is ~/

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: route behavior tests (RTL + MSW)

**Files:**
- Test: `src/pages/pathRoutes.test.tsx` (create)

**Interfaces:**
- Consumes: everything from Tasks 4-6; `@testing-library/react`; MSW `handlers` + seeding from Task 4.

- [ ] **Step 1: Write the tests**

Create `src/pages/pathRoutes.test.tsx`. Scaffold: MSW server (same
`BasedRequest` origin workaround as the store tests), a real redux store (use
the app's actual store factory from `src/store/index.ts` if it exports one;
otherwise `configureStore` with the `handoffApi` reducer + the `handoff` slice
reducer), `MemoryRouter` + the real route table. Use a small location spy:

```tsx
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { Provider } from 'react-redux'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, seedFolder, seedFile } from '../mocks/handlers'
import { TreePage, BlobPage, LegacyFolderRedirect, LegacyViewRedirect } from './PathPages'

// ... BasedRequest scaffold + store factory as in resolvePath.test.ts ...

let lastPath = ''
function LocationSpy() {
  const loc = useLocation()
  lastPath = loc.pathname
  return null
}

function renderAt(entry: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[entry]}>
        <LocationSpy />
        <Routes>
          <Route index element={<div>HOME</div>} />
          <Route path="tree/*" element={<TreePage />} />
          <Route path="blob/*" element={<BlobPage />} />
          <Route path="view/:id" element={<LegacyViewRedirect />} />
          <Route path="folder/:id" element={<LegacyFolderRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  )
}
```

Tests (each seeds, renders, asserts):

1. **`/tree/<nested folder path>` renders the folder listing** — seed
   `Test/Sub Folder` + a file inside; `renderAt('/tree/Test/Sub%20Folder')`;
   `await screen.findByText(<file name>)`.
2. **`/tree/<file path>` self-heals to /blob** — seed `Test` + file;
   `renderAt('/tree/Test/My%20File.png')`; `await waitFor(() => expect(lastPath).toBe('/blob/Test/My File.png'))`
   (MemoryRouter pathnames are decoded).
3. **legacy `/folder/:id` redirects to the canonical /tree URL** — seed nested
   folder, `renderAt('/folder/' + b.id)`; `await waitFor(() => expect(lastPath).toBe('/tree/Test/Sub Folder'))`.
4. **legacy `/view/:id` redirects to /blob preserving the node** — seed file;
   `renderAt('/view/' + f.id)`; expect `lastPath` to be `/blob/Test/My File.png`.
5. **unresolvable path shows the not-found state** —
   `renderAt('/tree/Nope')`; `await screen.findByText(/nothing found/i)`.

The exact seeded names/assertions may need adjusting to the FolderView DOM
(e.g. the file name appears in the listing row). Keep assertions on visible
text, not implementation details. `FolderView` will fire `/api/auth/session`
etc. — if MSW errors on unhandled requests, add passthrough handlers for
`/api/auth/*` returning `{ authenticated: false }`-shaped responses consistent
with what `src/lib/session.ts` expects (check `handlers.ts` — a session mock
may already exist).

- [ ] **Step 2: Run the tests, iterate to green**

Run: `pnpm test:run src/pages/pathRoutes.test.tsx`
Expected: PASS (iterate on selectors/mock gaps as needed — fix the page
components only if the test reveals a real behavior bug, not to make a flaky
selector pass).

- [ ] **Step 3: Full suite + lint + build**

Run: `pnpm test:run && pnpm lint && pnpm build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add apps/handoff/src/pages/pathRoutes.test.tsx apps/handoff/src/mocks/handlers.ts
git commit -m "test(handoff): route behavior tests for /tree //blob + legacy redirects

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: push branch + PR

- [ ] **Step 1: Final verification**

From `apps/handoff/`: `pnpm test:run && pnpm lint && pnpm build` — all green.
`git log --oneline main..HEAD` — one commit per task plus the spec/plan commits.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/handoff-path-urls
gh pr create --repo bffless/apps \
  --title "feat(handoff): GitHub-style path URLs — /tree/<path> and /blob/<path>" \
  --body "Implements docs/superpowers/specs/2026-07-06-handoff-path-urls-design.md (plan: docs/superpowers/plans/2026-07-06-handoff-path-urls.md).

- New \`GET /api/resolve/*\` pipeline rule: decoded path → node under the exact serve-rule ACL gate (owners, admins, nested grantees, share visitors).
- \`GET /api/nodes\` / \`GET /api/node\` now emit a server-computed \`path\` per node (folders included) — all link generation is \`node.path\`-driven.
- SPA: \`/tree/*\` + \`/blob/*\` routes resolve then render the existing FolderView/viewer; \`/folder/:id\` + \`/view/:id\` redirect to canonical URLs (query string preserved); root label is \`~/\`.
- Tests: pathUrl unit suite, behavioral evals of the new/changed embedded pipeline steps, store-level resolve tests, RTL route tests.

⚠️ Post-merge (owner-gated): apply the rule-set changes to the live \`handoff\` set via MCP — create \`/api/resolve/*\`, update the \`/api/nodes\` + \`/api/node\` shape steps — then run the live validation checklist in the plan's Task 9.

Depends on / includes #177 (branch is based on it).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Note: if PR #177 has merged by now, rebase onto `origin/main` first so the PR
diff is clean; if it hasn't, set `--base` to the #177 branch or note the
stacking in the PR body (keep whichever the owner prefers at execution time —
default: leave base `main` and note the overlap).

---

### Task 9: OWNER-GATED — live deploy + validation (do not automate)

Owner (or main-session Claude with owner approval) applies via MCP after merge:

- [ ] Create the `/api/resolve/*` rule on live set `5d59f6d8-f492-4e18-9edc-6a9d96677b44` (`create_proxy_rule`, `pipelineConfig` copied verbatim from the merged JSON).
- [ ] Update the live `GET /api/nodes` rule (`6585ccbe-e150-4e6d-91da-a894a8a70686`) and `GET /api/node` rule (`9d544d90-3cae-409e-9d92-77e66c06644e`) `pipelineConfig`s with the new shape-step code (build the payload from the LIVE rule + the merged diff, as done for the serve-rule fix on 2026-07-06).
- [ ] Live validation:
  - `curl` anon `https://handoff.j5s.dev/api/resolve/Test` → 401 (resolved, gated) and `/api/resolve/Garbage-zzz` → 404.
  - Claim a share token (POST `/api/share-links/claim`), then resolve a path inside the shared folder with the cookie → 200 with `node.path`.
  - Signed-in browser: open `https://handoff.j5s.dev/tree/Test`, click into files (spaces + U+202F names), verify breadcrumbs/`~/`, verify an old `/folder/<id>` URL redirects.
