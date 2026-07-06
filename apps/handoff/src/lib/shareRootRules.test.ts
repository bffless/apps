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
    for (const id of ['resolveRootPre', 'rootRecord', 'rootCreate', 'resolveRootShape']) {
      expect(list).toContain(id)
    }
    expect(list.indexOf('resolveRootShape')).toBeLessThan(list.indexOf('folder'))
  })

  it('feeds the resolved folder id into the folder query and the created share link', () => {
    expect(step(r, 'folder').config.recordId).toBe(EFFECTIVE)
    expect(step(r, 'folder').config.condition).toBe(EFFECTIVE)
    expect(step(r, 'create').config.fields.folderId).toBe(EFFECTIVE)
  })

  it('gates root creation to admins only (security guard)', () => {
    expect(step(r, 'rootCreate').config.condition).toContain('steps.resolveRootPre.isAdmin')
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
    expect(step(r, 'save').config.condition).toBe('steps.merge.allowed')
  })

  it('gates root creation to admins only (security guard)', () => {
    expect(step(r, 'rootCreate').config.condition).toContain('steps.resolveRootPre.isAdmin')
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

describe('patched proxy-rules JSON', () => {
  it('still parses', () => {
    const raw = readFileSync(
      new URL('../../bffless/handoff.proxy-rules.json', import.meta.url),
      'utf8',
    )
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})
