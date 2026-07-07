// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const proxy = JSON.parse(readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8')) as { rules: any[] }

function shapeSource(method: string, path: string): string {
  const rule = proxy.rules.find((r) => r.pathPattern === path && r.method === method)
  const step = rule.pipelineConfig.steps.find((s: any) => s.id === 'shape')
  return step.config.code
}

describe('node shape projections expose title/description', () => {
  it('GET /api/node projects title and description', () => {
    expect(shapeSource('GET', '/api/node')).toContain('title:')
    expect(shapeSource('GET', '/api/node')).toContain('description:')
  })
  it('GET /api/nodes projects title and description', () => {
    expect(shapeSource('GET', '/api/nodes')).toContain('title:')
    expect(shapeSource('GET', '/api/nodes')).toContain('description:')
  })
  it('POST /api/nodes (register) projects title and description', () => {
    expect(shapeSource('POST', '/api/nodes')).toContain('title:')
    expect(shapeSource('POST', '/api/nodes')).toContain('description:')
  })
})
