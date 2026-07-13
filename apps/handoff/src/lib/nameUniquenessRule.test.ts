// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard for the in-Folder name-uniqueness rules (structural storage,
 * Slice 4 / issue #159). The embedded pipeline logic runs only in CE's runner
 * (validated live via MCP); this asserts the exported rule set is wired the way
 * the design requires, so a refactor can't silently drop the collision gate:
 *
 *  - Each creation pipeline (POST /api/uploads/prepare, POST /api/nodes,
 *    POST /api/sites) queries existing siblings under the target parentId, then
 *    a `guard` function-handler decides `collision` / `ok`.
 *  - The side-effecting step (presigned / register_upload / data_create) and the
 *    200 response are gated on `steps.guard.ok`, so nothing is written or minted
 *    on a collision — the existing item is never overwritten.
 *  - A `conflict` response-handler returns 409 on `steps.guard.collision`.
 *
 * The pure decision itself is covered by nameCollision.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules } from '../test/proxyRules'

const NODES_SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'

const proxy = await loadProxyRules()

function rule(path: string, method: string) {
  return proxy.rules.find((r) => r.pathPattern === path && r.method === method)
}

/** The side-effecting step id whose execution must be gated per pipeline. */
const CASES = [
  { path: '/api/uploads/prepare', effectStep: 'presigned' },
  { path: '/api/nodes', effectStep: 'register' },
  { path: '/api/sites', effectStep: 'create' },
]

describe.each(CASES)('in-Folder uniqueness gate — POST $path', ({ path, effectStep }) => {
  const steps = () => rule(path, 'POST')!.pipelineConfig.steps as any[]

  it('queries existing siblings under the target parentId', () => {
    const sibling = steps().find((s) => s.id === 'sibling')
    expect(sibling.handlerType).toBe('data_query')
    expect(sibling.config.schemaId).toBe(NODES_SCHEMA)
    expect(sibling.config.filters.parentId.value).toBe('request.body.parentId')
    // Only checked when a parentId is present (importFolder's fresh folders skip).
    expect(sibling.config.condition).toBe('steps.pre.check')
  })

  it('decides the collision in a guard function-handler', () => {
    const guard = steps().find((s) => s.id === 'guard')
    expect(guard.handlerType).toBe('function_handler')
    expect(guard.config.code).toContain('collision')
  })

  it('gates the side-effecting step and the 200 response on steps.guard.ok', () => {
    const effect = steps().find((s) => s.id === effectStep)
    expect(effect.config.condition).toBe('steps.guard.ok')
    const ok = steps().find((s) => s.id === 'response')
    expect(ok.config.status).toBe(200)
    expect(ok.config.condition).toBe('steps.guard.ok')
  })

  it('returns 409 on steps.guard.collision — never overwrites', () => {
    const conflict = steps().find((s) => s.id === 'conflict')
    expect(conflict.handlerType).toBe('response_handler')
    expect(conflict.config.status).toBe(409)
    expect(conflict.config.condition).toBe('steps.guard.collision')
  })

  it('orders the guard steps before the side-effecting step', () => {
    const ids = steps().map((s) => s.id)
    expect(ids.indexOf('guard')).toBeLessThan(ids.indexOf(effectStep))
  })
})
