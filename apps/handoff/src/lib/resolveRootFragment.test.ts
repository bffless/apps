// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard for the resolve-root step group.
 *
 * The group decides whether a folderId refers to the literal "root" sentinel, resolves it
 * to the singleton root record's UUID (creating that record if missing), and exposes the
 * resolved id + owner as `effectiveFolderId` / `rootOwnerId`.
 *
 * It used to live in `bffless/_fragments/resolve-root.json`, a fixture a patch script
 * spliced into each pipeline — so the copies were identical by construction, and this test
 * only had to check the fixture was well-formed. Under the authored layout (#231) each rule
 * carries its own `resolveRootPre.fn.js` / `resolveRootShape.fn.js`, so the copies CAN now
 * drift apart. That makes cross-rule identity the property worth pinning, and this test
 * asserts it against the compiled rules that actually ship.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, findRule } from '../test/proxyRules'

const NODES_SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'

const proxy = await loadProxyRules()

// The two write paths can mint the root record on demand (rootGate → rootCreate);
// the read paths only resolve an existing one.
const CREATE_CAPABLE: Array<[string, string]> = [
  ['/api/grants', 'POST'],
  ['/api/share-links', 'POST'],
]
const RESOLVE_ONLY: Array<[string, string]> = [
  ['/api/grants/revoke', 'POST'],
  ['/api/grants', 'GET'],
  ['/api/share-links', 'GET'],
]
const ALL_ROOT_AWARE = [...CREATE_CAPABLE, ...RESOLVE_ONLY]

const stepsOf = (path: string, method: string) =>
  findRule(proxy.rules, path, method).pipelineConfig.steps as Array<Record<string, any>>

const stepOf = (path: string, method: string, id: string) => {
  const step = stepsOf(path, method).find((s) => s.id === id)
  expect(step, `${method} ${path} is missing step "${id}"`).toBeTruthy()
  return step!
}

describe('resolve-root step group', () => {
  it('every root-aware rule leads with the group, in order', () => {
    for (const [path, method] of CREATE_CAPABLE) {
      const ids = stepsOf(path, method).map((s) => s.id)
      expect(ids.slice(0, 5), `${method} ${path}`).toEqual([
        'resolveRootPre',
        'rootRecord',
        'rootGate',
        'rootCreate',
        'resolveRootShape',
      ])
    }
    for (const [path, method] of RESOLVE_ONLY) {
      const ids = stepsOf(path, method).map((s) => s.id)
      expect(ids.slice(0, 3), `${method} ${path}`).toEqual([
        'resolveRootPre',
        'rootRecord',
        'resolveRootShape',
      ])
    }
  })

  // The whole point of the old shared fixture. Now that each rule owns its handler files,
  // a fix applied to one copy and not the others would silently diverge the root semantics.
  it('shares byte-identical resolveRootPre / resolveRootShape code across every rule', () => {
    for (const id of ['resolveRootPre', 'resolveRootShape']) {
      const bodies = ALL_ROOT_AWARE.map(([path, method]) => stepOf(path, method, id).config.code)
      const unique = new Set(bodies)
      expect(unique.size, `${id} has ${unique.size} distinct copies across the root-aware rules`).toBe(1)
    }
  })

  it('resolveRootPre detects the root sentinel', () => {
    const pre = stepOf('/api/grants', 'POST', 'resolveRootPre')
    expect(pre.handlerType).toBe('function_handler')
    expect(pre.config.code).toContain('isRoot')
  })

  it('rootRecord queries the nodes table only when the target is root', () => {
    const rec = stepOf('/api/grants', 'POST', 'rootRecord')
    expect(rec.handlerType).toBe('data_query')
    expect(rec.config.schemaId).toBe(NODES_SCHEMA)
    expect(rec.config.condition).toBe('steps.resolveRootPre.isRoot')
  })

  // BFFless step conditions take a simple path only — no `&&`/`!`/`===` — so the
  // admin + missing-record decision has to be precomputed into one boolean.
  it('rootGate precomputes shouldCreate from an admin check', () => {
    const gate = stepOf('/api/grants', 'POST', 'rootGate')
    expect(gate.handlerType).toBe('function_handler')
    expect(gate.config.code).toContain('shouldCreate')
    expect(gate.config.code).toContain('isAdmin')
  })

  it('rootCreate mints the singleton root node, gated on a simple path', () => {
    const create = stepOf('/api/share-links', 'POST', 'rootCreate')
    expect(create.handlerType).toBe('data_create')
    expect(create.config.schemaId).toBe(NODES_SCHEMA)
    expect(create.config.condition).toBe('steps.rootGate.shouldCreate')
    expect(create.config.fields).toMatchObject({
      nodeType: 'root',
      displayName: 'My Files',
      parentId: '',
      mode: 'inheriting',
      grantsJson: '[]',
    })
  })

  it('resolveRootShape outputs effectiveFolderId and rootOwnerId', () => {
    const shape = stepOf('/api/grants', 'POST', 'resolveRootShape')
    expect(shape.handlerType).toBe('function_handler')
    expect(shape.config.code).toContain('effectiveFolderId')
    expect(shape.config.code).toContain('rootOwnerId')
  })
})
