// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const proxy = JSON.parse(readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8')) as { rules: any[] }

function shapeSource(method: string, path: string): string {
  const rule = proxy.rules.find((r) => r.pathPattern === path && r.method === method)
  const step = rule.pipelineConfig.steps.find((s: any) => s.id === 'shape')
  return step.config.code
}

describe('node shape projections expose title/description', () => {
  it('GET /api/node projects title and description from steps.query', () => {
    const src = shapeSource('GET', '/api/node')
    expect(src).toContain('var r = (steps && steps.query) || {};')
    expect(src).toContain('title:')
    expect(src).toContain('description:')
    expect(src).toContain("title: (r.title != null && String(r.title) !== '') ? String(r.title) : null,")
    expect(src).toContain("description: (r.description != null && String(r.description) !== '') ? String(r.description) : null,")
  })
  it('GET /api/nodes projects title and description from rows[i]', () => {
    const src = shapeSource('GET', '/api/nodes')
    expect(src).toContain('var r=rows[i]||{};')
    expect(src).toContain('title:')
    expect(src).toContain('description:')
    expect(src).toContain("title:(r.title!=null&&String(r.title)!=='')?String(r.title):null,")
    expect(src).toContain("description:(r.description!=null&&String(r.description)!=='')?String(r.description):null,")
  })
  it('POST /api/nodes (register) projects title and description from steps.register', () => {
    const src = shapeSource('POST', '/api/nodes')
    expect(src).toContain('var r = (steps && steps.register) || {};')
    expect(src).toContain('title:')
    expect(src).toContain('description:')
    expect(src).toContain("title: (r.title != null && String(r.title) !== '') ? String(r.title) : null,")
    expect(src).toContain("description: (r.description != null && String(r.description) !== '') ? String(r.description) : null,")
  })
})
