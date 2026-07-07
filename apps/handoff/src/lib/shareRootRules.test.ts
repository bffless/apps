// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard for the resolve-root splice into the mint & grants pipelines.
 *
 * Sharing/granting the synthetic "root" folder used to 500: pipelines ran a
 * data_query with recordId='root' against a UUID column. The fix splices the
 * resolve-root group (_fragments/resolve-root.json) into the four share/grant
 * rules so 'root' resolves to the singleton root record's UUID, and gates root
 * creation/sharing to admins only (root = the entire instance top-level).
 *
 * These assertions pin the wired shape: resolveRootShape.effectiveFolderId feeds
 * every id-keyed step, those steps are conditioned so a null id (non-admin root)
 * skips the query instead of 500ing, and the admin gate is present on rootCreate.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

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

describe('patched proxy-rules JSON', () => {
  it('still parses', () => {
    const raw = readFileSync(
      new URL('../../bffless/handoff.proxy-rules.json', import.meta.url),
      'utf8',
    )
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})

/**
 * Structural guard for Task 5: the ACL gates must resolve the 'root' sentinel
 * into the folder chain. Every embedded `folderChain` walks parentId upward; it
 * used to stop at the 'root' sentinel, so the singleton root record R was never
 * in the chain and a root-scoped share visitor / root grantee was never matched.
 *
 * The patch makes each folderChain (a) capture R's id while building `byId`
 * (`f.nodeType==='root'`) and (b) resolve `parentId==='root'` → that id so R
 * becomes chain[0]; and widens each chain-feeding query (allFolders / folders)
 * from nodeType eq 'folder' to in ['folder','root'] so R is actually fetched.
 *
 * folderPath (the human breadcrumb walk) must NOT gain root — prepending R
 * ("My Files") would corrupt every displayed path — so its distinct
 * `cur=byId[cur].parentId||''` line must stay untouched.
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
  // Tolerant of optional spaces around === and && (sandbox code is minified, but
  // the assertion should not be brittle to whitespace).
  const CAPTURE = /nodeType\s*===\s*'root'/
  const SENTINEL = /===\s*'root'\s*&&\s*rootId/

  it('has exactly 8 embedded folderChain functions', () => {
    expect(chainCodes.length).toBe(8)
  })

  it('every folderChain captures the root record id and resolves the root sentinel', () => {
    for (const c of chainCodes) {
      expect(c, 'folderChain captures nodeType root -> rootId').toMatch(CAPTURE)
      expect(c, "folderChain resolves parentId==='root' -> rootId").toMatch(SENTINEL)
    }
  })

  // Fix #1: a node sitting directly in "My Files" has parentId==='root' (the
  // sentinel), so the gate calls folderChain(...,'root'). The walk's UUID.test
  // fails on 'root' and returns [] — R is never injected, so top-level FILES and
  // SITES (the DEFAULT upload target) are missed by a root share/grant. The fix
  // seeds the walk at R when startId is the sentinel.
  const SEED = /var rev=\[\];var cur=\(String\(startId\|\|''\)\s*===\s*'root'\s*&&\s*rootId\)\?rootId:String\(startId\|\|''\)/

  it('every folderChain seeds the walk at R when startId is the root sentinel (Fix #1)', () => {
    for (const c of chainCodes) {
      expect(c, 'folderChain seeds startId===root -> rootId').toMatch(SEED)
    }
    // Belt-and-braces: exactly 8 seeded bodies across the whole document.
    const seeded = allCode.filter((c) => SEED.test(c))
    expect(seeded.length).toBe(8)
  })

  it('leaves the two folderPath breadcrumb seeds plain (no root, Fix #1)', () => {
    // folderPath must NOT gain root — its seed uses a distinct `var names=[]`
    // form and must remain the plain `String(startId||'')`.
    const pathSeeds = allCode.filter((c) => c.includes("var names=[]; var cur=String(startId||'')"))
    expect(pathSeeds.length).toBe(2)
    for (const c of pathSeeds) {
      expect(c, 'folderPath seed stays plain (no rootId)').not.toMatch(
        /var names=\[\]; var cur=\(String\(startId\|\|''\)\s*===\s*'root'/,
      )
    }
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
    expect(widened.length).toBe(7)
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

  it('leaves the folderPath breadcrumb walk untouched (no root prepended to paths)', () => {
    // The GET /api/nodes shape step carries both folderChain (ACL) and folderPath
    // (breadcrumb). Only folderChain gains root; folderPath still walks parentId
    // via its distinct `cur=byId[cur].parentId||''` line.
    const shape = step(rule('GET', '/api/nodes'), 'shape')
    expect(shape.config.code).toContain("cur=byId[cur].parentId||''")
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
  it("the DELETE /api/node gate blocks deletion when nodeType==='root'", () => {
    const gate = step(rule('DELETE', '/api/node'), 'gate')
    expect(gate.config.code).toMatch(
      /var guardBlocked=\(isFolder&&hasChildren\)\|\|nodeType===['"]root['"];/,
    )
  })
})
