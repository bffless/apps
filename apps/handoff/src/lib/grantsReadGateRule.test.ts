// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Owner-gate for GET /api/grants (issue #266).
 *
 * The read path used to be auth-gated only (`auth_required`) — any authenticated user who knew
 * (or guessed) a folderId could list its grants, leaking principal emails and group names. The
 * write path (POST /api/grants) has always been owner/admin-gated in `merge.fn.ts`; this pins
 * that the read path's `shape.fn.ts` enforces the SAME gate: direct owner or admin, no chain
 * walking, mirroring merge.fn.ts's `isAdmin`/`isOwner` mechanics exactly.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'

const proxy = await loadProxyRules()

function shapeHandler() {
  const rule = proxy.rules.find((r) => r.pathPattern === '/api/grants' && r.method === 'GET')
  if (!rule) throw new Error('no rule for GET /api/grants')
  const step = rule.pipelineConfig.steps.find((s: any) => s.id === 'shape')
  if (!step) throw new Error('GET /api/grants has no "shape" step')
  return compileHandler(step.config.code)
}

const FOLDER = 'f1'
const OWNER = 'owner-1'
const storedGrants = [{ principalId: 'u9', principalEmail: 'u9@example.com', level: 'view' }]

describe('GET /api/grants :: shape (owner gate, issue #266)', () => {
  const shape = shapeHandler()
  const run = (user: any, folder: any = { id: FOLDER, ownerId: OWNER, grantsJson: JSON.stringify(storedGrants) }) =>
    shape({ user, steps: { folder } }) as Record<string, any>

  it('the owner sees the grants', () => {
    const out = run({ id: OWNER, role: 'user' })
    expect(out).toMatchObject({ allowed: true, denied: false })
    expect(out.grants).toEqual([
      { principalId: 'u9', principalEmail: 'u9@example.com', principalName: null, level: 'view' },
    ])
  })

  it('an admin sees the grants even when not the owner', () => {
    const out = run({ id: 'someone-else', role: 'admin' })
    expect(out).toMatchObject({ allowed: true, denied: false })
    expect(out.grants).toHaveLength(1)
  })

  it('a non-owner, non-admin authenticated user is denied — empty grants, denied: true', () => {
    const out = run({ id: 'mallory', role: 'user' })
    expect(out).toMatchObject({ allowed: false, denied: true })
    expect(out.grants).toEqual([])
  })

  it('a user who is neither owner nor admin gets denied even when the folder has no grants', () => {
    const out = run({ id: 'mallory', role: 'user' }, { id: FOLDER, ownerId: OWNER, grantsJson: '[]' })
    expect(out).toMatchObject({ allowed: false, denied: true })
  })

  it('the root-sentinel path still works for the resolved root owner', () => {
    // resolveRootShape resolves 'root' to the singleton root record's real id/ownerId before the
    // `folder` query runs, so by the time `shape` sees `steps.folder` it's an ordinary record —
    // the owner check is identical to any other folder.
    const out = run({ id: OWNER, role: 'user' }, { id: 'root-uuid', ownerId: OWNER, grantsJson: '[]' })
    expect(out).toMatchObject({ allowed: true, denied: false })
  })
})

describe('GET /api/grants rule wiring: 403 on denied, 200 on allowed', () => {
  const rule = proxy.rules.find((r) => r.pathPattern === '/api/grants' && r.method === 'GET')!

  it('has an ok response step conditioned on steps.shape.allowed', () => {
    const step = rule.pipelineConfig.steps.find((s: any) => s.id === 'ok')
    expect(step, 'GET /api/grants has no "ok" response step').toBeTruthy()
    expect(step.config.condition).toBe('steps.shape.allowed')
    expect(step.config.status).toBe(200)
  })

  it('has a denied response step conditioned on steps.shape.denied, returning 403', () => {
    const step = rule.pipelineConfig.steps.find((s: any) => s.id === 'denied')
    expect(step, 'GET /api/grants has no "denied" response step').toBeTruthy()
    expect(step.config.condition).toBe('steps.shape.denied')
    expect(step.config.status).toBe(403)
  })
})
