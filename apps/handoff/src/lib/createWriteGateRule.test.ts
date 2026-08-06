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

/** Only the endpoints implemented so far — extended as Task 5 lands. */
const IMPLEMENTED = CASES.filter((c) => c.path !== '/api/uploads/prepare')

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
