// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard for the resolve-root splice into the mint & grants pipelines.
 *
 * Sharing/granting the synthetic "root" folder used to 500: pipelines ran a
 * data_query with recordId='root' against a UUID column. The fix puts the
 * resolve-root step group into each share/grant rule so 'root' resolves to the
 * singleton root record's UUID, and gates root creation/sharing to admins only
 * (root = the entire instance top-level). See resolveRootFragment.test.ts, which
 * pins that group's shape and that its copies stay identical across the rules.
 *
 * These assertions pin the wired shape: resolveRootShape.effectiveFolderId feeds
 * every id-keyed step, those steps are conditioned so a null id (non-admin root)
 * skips the query instead of 500ing, and the admin gate is present on rootCreate.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'
import { evalAccess, folderChain } from '../../.bffless/proxy-rules/handoff/_shared/acl'
import type { NodeRow } from '../../.bffless/proxy-rules/handoff/_shared/acl'

const proxy = await loadProxyRules()

const EFFECTIVE = 'steps.resolveRootShape.effectiveFolderId'

function rule(method: string, pathPattern: string): Record<string, any> {
  const r = proxy.rules.find((x) => x.method === method && x.pathPattern === pathPattern)
  expect(r, `${method} ${pathPattern} rule exists`).toBeTruthy()
  return r!
}
function steps(r: Record<string, any>): Array<Record<string, any>> {
  return r.pipelineConfig.steps
}
function ids(r: Record<string, any>): string[] {
  return steps(r).map((s) => s.id)
}
function step(r: Record<string, any>, id: string): Record<string, any> {
  const s = steps(r).find((x) => x.id === id)
  expect(s, `step ${id} exists`).toBeTruthy()
  return s!
}

describe('resolve-root wired into mint (POST /api/share-links)', () => {
  const r = rule('POST', '/api/share-links')

  it('splices the full write group in resolve order', () => {
    const list = ids(r)
    for (const id of ['resolveRootPre', 'rootRecord', 'rootGate', 'rootCreate', 'resolveRootShape']) {
      expect(list).toContain(id)
    }
    expect(list.indexOf('rootRecord')).toBeLessThan(list.indexOf('rootGate'))
    expect(list.indexOf('rootGate')).toBeLessThan(list.indexOf('rootCreate'))
    expect(list.indexOf('resolveRootShape')).toBeLessThan(list.indexOf('folder'))
  })

  it('feeds the resolved folder id into the folder query and the created share link', () => {
    expect(step(r, 'folder').config.recordId).toBe(EFFECTIVE)
    expect(step(r, 'folder').config.condition).toBe(EFFECTIVE)
    expect(step(r, 'create').config.fields.folderId).toBe(EFFECTIVE)
  })

  it('gates root creation to admins only, via a simple-path condition on rootGate', () => {
    // BFFless conditions only evaluate simple paths — the admin/exists logic lives in
    // the rootGate function, referenced here by a plain path (never a compound expression).
    expect(step(r, 'rootCreate').config.condition).toBe('steps.rootGate.shouldCreate')
    expect(step(r, 'rootGate').config.code).toContain('isAdmin')
    expect(step(r, 'rootGate').config.code).toContain('shouldCreate')
  })
})

describe('resolve-root wired into grants (POST /api/grants)', () => {
  const r = rule('POST', '/api/grants')

  it('splices resolveRootShape before the folder query', () => {
    const list = ids(r)
    expect(list).toContain('resolveRootShape')
    expect(list.indexOf('resolveRootShape')).toBeLessThan(list.indexOf('folder'))
  })

  it('feeds the resolved folder id into the folder query and the grants save', () => {
    expect(step(r, 'folder').config.recordId).toBe(EFFECTIVE)
    expect(step(r, 'folder').config.condition).toBe(EFFECTIVE)
    expect(step(r, 'save').config.recordId).toBe(EFFECTIVE)
    // save must run only when merge allowed AND a folder id resolved (admin's merge
    // short-circuits allowed=true even for an empty/never-created root; without the
    // resolved-id guard save would run with recordId=null -> UUID-cast 500). That
    // compound predicate lives in merge as `canSave`; the condition is a simple path.
    expect(step(r, 'save').config.condition).toBe('steps.merge.canSave')
    expect(step(r, 'merge').config.code).toContain('canSave')
    expect(step(r, 'merge').config.code).toContain('effectiveFolderId')
  })

  it('gates root creation to admins only, via a simple-path condition on rootGate', () => {
    expect(step(r, 'rootCreate').config.condition).toBe('steps.rootGate.shouldCreate')
    expect(step(r, 'rootGate').config.code).toContain('isAdmin')
    expect(step(r, 'rootGate').config.code).toContain('shouldCreate')
  })
})

describe('resolve-root wired into grants read (GET /api/grants)', () => {
  const r = rule('GET', '/api/grants')

  it('splices the read-only group (no rootCreate) before the folder query', () => {
    const list = ids(r)
    expect(list).toContain('resolveRootShape')
    expect(list).not.toContain('rootCreate')
    expect(list.indexOf('resolveRootShape')).toBeLessThan(list.indexOf('folder'))
  })

  it('feeds the resolved folder id into the folder query', () => {
    expect(step(r, 'folder').config.recordId).toBe(EFFECTIVE)
    expect(step(r, 'folder').config.condition).toBe(EFFECTIVE)
  })
})

describe('resolve-root wired into share-links read (GET /api/share-links)', () => {
  const r = rule('GET', '/api/share-links')

  it('splices the read-only group (no rootCreate) before the rows query', () => {
    const list = ids(r)
    expect(list).toContain('resolveRootShape')
    expect(list).not.toContain('rootCreate')
    expect(list.indexOf('resolveRootShape')).toBeLessThan(list.indexOf('rows'))
  })

  it('feeds the resolved folder id into the rows filter', () => {
    expect(step(r, 'rows').config.filters.folderId.value).toBe(EFFECTIVE)
    expect(step(r, 'rows').config.condition).toBe(EFFECTIVE)
  })
})

describe('resolve-root wired into grants revoke (POST /api/grants/revoke)', () => {
  const r = rule('POST', '/api/grants/revoke')

  it('splices the read-only group (no rootCreate) before the folder query', () => {
    const list = ids(r)
    for (const id of ['resolveRootPre', 'rootRecord', 'resolveRootShape']) {
      expect(list).toContain(id)
    }
    expect(list).not.toContain('rootCreate')
    expect(list.indexOf('resolveRootShape')).toBeLessThan(list.indexOf('folder'))
  })

  it('feeds the resolved folder id into the folder query and the grants save', () => {
    expect(step(r, 'folder').config.recordId).toBe(EFFECTIVE)
    expect(step(r, 'folder').config.condition).toBe(EFFECTIVE)
    expect(step(r, 'save').config.recordId).toBe(EFFECTIVE)
    // CRITICAL: merge short-circuits allowed=true for an ADMIN even when steps.folder
    // is empty (never-created root). save must ALSO be guarded on the resolved id or
    // an admin revoking on a non-existent root runs save with recordId=null -> 500.
    // That predicate lives in merge as `canSave`; the condition is a simple path.
    expect(step(r, 'save').config.condition).toBe('steps.merge.canSave')
    expect(step(r, 'merge').config.code).toContain('canSave')
    expect(step(r, 'merge').config.code).toContain('effectiveFolderId')
  })
})

describe('no pipeline step uses a compound condition (BFFless evaluates simple paths only)', () => {
  // Regression guard for apps#181: a step `condition` is evaluated as a single truthy
  // path lookup — `&&`, `||`, `!`, `[0]` indexing, and `===` silently resolve falsy and
  // skip the step. Any compound predicate MUST be computed in a function_handler and
  // referenced by a simple path. This scans EVERY rule, not just the share-root ones.
  it('every step condition across the rule set is a bare path (no &&, ||, !, [, ===)', () => {
    const offenders: string[] = []
    for (const rl of proxy.rules) {
      for (const s of rl.pipelineConfig?.steps ?? []) {
        const cond: string | undefined = s.config?.condition
        if (cond && /&&|\|\||!|\[|===/.test(cond)) {
          offenders.push(`${rl.pathPattern} :: ${s.id} :: ${cond}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('authored rule sets', () => {
  // Replaces the old "the patched proxy-rules JSON still parses" guard: the rules are
  // no longer a hand-patched JSON blob but files compiled by `buildRuleSet` — the same
  // compiler `bffless rules push` runs — so a malformed manifest or handler now fails
  // the compile in loadProxyRules() and takes every test in this file with it.
  // What still needs asserting is that BOTH sets are in the merged view: the feeds live
  // in `handoff-rss-feed`, a second set attached to the same alias, and a lookup that
  // silently missed it would make the feed guards below vacuous.
  it('merges the handoff and handoff-rss-feed sets', () => {
    expect(proxy.rules.some((r) => r.pathPattern === '/api/nodes')).toBe(true)
    expect(proxy.rules.some((r) => r.pathPattern === '/feed.xml')).toBe(true)
  })
})

/**
 * Task 5: the ACL gates must resolve the 'root' sentinel into the folder chain.
 *
 * `folderChain` walks parentId upward; it used to stop at the 'root' sentinel, so the
 * singleton root record R was never in the chain and a root-scoped share visitor / root
 * grantee was never matched. It now (a) captures R's id while indexing the rows and
 * (b) resolves BOTH a `parentId === 'root'` and a `startId === 'root'` to that id, so R
 * becomes chain[0] — the latter matters because a node sitting directly in "My Files"
 * (the DEFAULT upload target) has the sentinel as its parent. The chain-feeding queries
 * (allFolders / folders) are widened from nodeType eq 'folder' to in ['folder','root'] so
 * R is actually fetched.
 *
 * The walk lives in ONE module now (`.bffless/proxy-rules/handoff/_shared/acl.ts`, inlined
 * into each handler bundle by esbuild), so these run the real function rather than pattern-
 * matching eleven minified copies of it. `aclSharedModule.test.ts` pins the per-set copies
 * together; `has exactly 14 embedded folderChain functions` below pins that every gate still
 * carries it. The margin-comments gates (GET/POST/PATCH /api/comments, spec 2026-07-28) joined
 * the set, bumping the copy count and the widened-query count below.
 *
 * folderPath (the human breadcrumb walk) must NOT gain root — prepending R ("My Files")
 * would corrupt every displayed path — so it is asserted, through the real shape handlers,
 * to still stop at the sentinel.
 */
describe('Task 5 — root sentinel resolved into the ACL folder chain', () => {
  // Every step's embedded handler code across all rules.
  const allCode: string[] = []
  for (const r of proxy.rules) {
    const stepList = (r.pipelineConfig && r.pipelineConfig.steps) || []
    for (const s of stepList) {
      const code = s.config && s.config.code
      if (typeof code === 'string') allCode.push(code)
    }
  }

  const chainCodes = allCode.filter((c) => c.includes('function folderChain'))

  const ROOT = '00000000-0000-4000-8000-0000000000a1'
  const DOCS = '00000000-0000-4000-8000-0000000000b2'
  const SUB = '00000000-0000-4000-8000-0000000000c3'
  const FILE = '00000000-0000-4000-8000-0000000000f4'

  // The singleton root record R — the only row with no parent at all.
  const rootRow = (grants: unknown[] = []): NodeRow => ({
    id: ROOT,
    nodeType: 'root',
    ownerId: 'alice',
    grantsJson: JSON.stringify(grants),
    mode: 'inheriting',
    displayName: 'My Files',
  })
  // A top-level folder: its parent is the SENTINEL, not R's uuid — that is the whole point.
  const docsRow: NodeRow = {
    id: DOCS,
    nodeType: 'folder',
    parentId: 'root',
    ownerId: 'alice',
    grantsJson: '[]',
    mode: 'inheriting',
    displayName: 'Docs',
  }
  const subRow: NodeRow = {
    id: SUB,
    nodeType: 'folder',
    parentId: DOCS,
    ownerId: 'alice',
    grantsJson: '[]',
    mode: 'inheriting',
    displayName: 'Reports',
    createdMs: 1000,
  }

  it('has exactly 18 embedded folderChain functions', () => {
    // 8 original + the two feed select handlers (#188) + the PATCH
    // /api/node/meta gate (Task 5) + the GET/POST/PATCH /api/comments gates
    // (margin comments) + the four create-endpoint guards (POST /api/folders,
    // /api/nodes, /api/sites, /api/uploads/prepare), which reach it through
    // _shared/writeAccess — each a verbatim copy.
    expect(chainCodes.length).toBe(18)
  })

  it('resolves the root sentinel to R, so a root-scoped grant matches a nested node', () => {
    const folders = [rootRow([{ principalId: 'bob', level: 'view' }]), docsRow, subRow]

    // The walk crosses the sentinel: R is chain[0], not a chain that stops at Docs.
    expect(folderChain(folders, SUB).map((n) => n.id)).toEqual([ROOT, DOCS, SUB])

    // Which is what makes a grant scoped to root actually reach a node inside it. Were the
    // sentinel left unresolved the chain would start at Docs and bob would get 'none'.
    expect(evalAccess(folderChain(folders, SUB), { userId: 'bob' })).toBe('view')
    expect(evalAccess(folderChain(folders, DOCS), { userId: 'bob' })).toBe('view')
    // Control: no root grant -> no access (so the assertion above is about the grant, not admin/owner).
    expect(evalAccess(folderChain([rootRow(), docsRow, subRow], SUB), { userId: 'bob' })).toBe('none')
  })

  // Fix #1: a node sitting directly in "My Files" has parentId==='root' (the sentinel), so the
  // gate calls folderChain(..., 'root'). The walk used to UUID-test 'root', fail, and return [] —
  // R never entered the chain, so top-level FILES and SITES (the DEFAULT upload target) were missed
  // by a root share/grant. The walk now seeds at R when startId is the sentinel.
  it('seeds the walk at R when startId is the root sentinel (Fix #1)', () => {
    const folders = [rootRow([{ principalId: 'bob', level: 'view' }]), docsRow]

    expect(folderChain(folders, 'root').map((n) => n.id)).toEqual([ROOT])
    // A root share link matches a top-level node: the linked folder id (R) is in the chain.
    expect(evalAccess(folderChain(folders, 'root'), { shareLinkFolderId: ROOT })).toBe('view')
    expect(evalAccess(folderChain(folders, 'root'), { userId: 'bob' })).toBe('view')
  })

  it('a root grant reaches a top-level FILE through the real content gate (Fix #1, end to end)', () => {
    // The shared walk is inlined into each handler bundle — prove a live gate gets the benefit,
    // not just the module in isolation. bob holds view on root only; the file hangs off the
    // sentinel. Without the seed the chain is just [file] and bob is refused (403).
    const gate = compileHandler(step(rule('GET', '/api/uploads/content/*'), 'gate').config.code)
    const fullKey = 'bffless/apps/uploads/content/a.txt'
    const out = gate({
      user: { id: 'bob' },
      request: { headers: {} },
      utils: { verify: () => false, base64urlDecode: (v: string) => v },
      steps: {
        allFolders: [rootRow([{ principalId: 'bob', level: 'view' }])],
        allSites: [],
        parsePath: { fullKey },
        nodeByKey: [{ id: FILE, nodeType: 'file', parentId: 'root', ownerId: 'alice', storage_path: fullKey }],
      },
    })
    expect(out).toMatchObject({ allow: true, level: 'view', deny403: false, deny404: false })
  })

  it('leaves the folderPath breadcrumb walk untouched (no root prepended to paths)', () => {
    // The two shape handlers carry folderPath alongside folderChain. Only folderChain gains
    // root: a folder's displayed path must stay 'Docs/Reports', never 'My Files/Docs/Reports'.
    const listShape = compileHandler(step(rule('GET', '/api/nodes'), 'shape').config.code)
    const getShape = compileHandler(step(rule('GET', '/api/node'), 'shape').config.code)
    const allFolders = [rootRow(), docsRow, subRow]

    const listed = listShape({
      steps: { allFolders, query: [subRow], gate: { viewer: { isAdmin: true } } },
    })
    expect(listed.nodes).toHaveLength(1)
    expect(listed.nodes[0].path).toBe('Docs/Reports')

    const got = getShape({ steps: { allFolders, query: subRow } })
    expect(got.node.path).toBe('Docs/Reports')
  })

  it('widens every chain-feeding query (allFolders / folders) to nodeType in [folder, root]', () => {
    const widened: Array<Record<string, any>> = []
    for (const r of proxy.rules) {
      const stepList = (r.pipelineConfig && r.pipelineConfig.steps) || []
      for (const s of stepList) {
        if (s.id === 'allFolders' || s.id === 'folders') {
          const nt = s.config && s.config.filters && s.config.filters.nodeType
          expect(nt, `${r.method} ${r.pathPattern} ${s.id} nodeType widened`).toEqual({
            op: 'in',
            value: ['folder', 'root'],
          })
          widened.push(s)
        }
      }
    }
    // 8 original + the GET/POST/PATCH /api/comments gates' allFolders queries
    // + the four create-endpoint guards' allFolders queries.
    expect(widened.length).toBe(15)
  })

  it('leaves allSites (nodeType site) queries unchanged', () => {
    let seen = 0
    for (const r of proxy.rules) {
      const stepList = (r.pipelineConfig && r.pipelineConfig.steps) || []
      for (const s of stepList) {
        if (s.id === 'allSites') {
          const nt = s.config && s.config.filters && s.config.filters.nodeType
          expect(nt).toEqual({ op: 'eq', value: 'site' })
          seen++
        }
      }
    }
    expect(seen).toBeGreaterThan(0)
  })

})

/**
 * Fix #4: the singleton root marker R (nodeType 'root') must be non-deletable.
 * The DELETE /api/node gate blocks deletion of a folder with children
 * (`guardBlocked = isFolder && hasChildren`), but R is nodeType 'root', not
 * 'folder', so an admin knowing R's UUID could delete it — orphaning every
 * grant/link scoped to it. The guard must also block nodeType==='root'.
 */
describe('Fix #4 — the root marker is non-deletable', () => {
  const gate = compileHandler(step(rule('DELETE', '/api/node'), 'gate').config.code)
  const ROOT = '00000000-0000-4000-8000-0000000000a1'
  const utils = { verify: () => false, base64urlDecode: (v: string) => v }

  // An ADMIN — the only caller who could plausibly hold write on the root marker, and so the
  // only one the guard has to stop. `guardBlocked` is what drives the 409 response_handler;
  // `doDelete` is what drives the data_delete.
  const runDelete = (node: Record<string, any>) =>
    gate({
      user: { id: 'admin-1', role: 'admin' },
      request: { headers: {} },
      utils,
      steps: { allFolders: [node], query: node, children: [] },
    })

  it("the DELETE /api/node gate blocks deletion when nodeType==='root'", () => {
    const out = runDelete({ id: ROOT, nodeType: 'root', parentId: null, ownerId: 'alice', grantsJson: '[]' })
    expect(out.allow).toBe(true) // an admin does hold write — the block is the guard, not the ACL
    expect(out.guardBlocked).toBe(true)
    expect(out.doDelete).toBe(false)
  })

  it('still deletes an empty folder (the guard is scoped to root + non-empty folders)', () => {
    const empty = {
      id: '00000000-0000-4000-8000-0000000000b2',
      nodeType: 'folder',
      parentId: 'root',
      ownerId: 'alice',
      grantsJson: '[]',
    }
    const out = runDelete(empty)
    expect(out.guardBlocked).toBe(false)
    expect(out.doDelete).toBe(true)
  })
})
