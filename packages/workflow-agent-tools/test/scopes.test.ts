import { describe, expect, it } from 'vitest'
import { RULE_SCOPES, SCOPES, TOOL_SCOPES, ruleScopeOf, scopeOf } from '../src/scopes.js'
import { TOOL_NAMES } from '../src/catalog.js'

describe('the tool → scope map (D23)', () => {
  it('partitions the catalog exactly as spec 10 does', () => {
    const byScope = (scope: string) => TOOL_NAMES.filter((name) => TOOL_SCOPES[name] === scope)
    expect(byScope('workflow:read')).toEqual([
      'workflow.list',
      'workflow.describe',
      'workflow.status',
      'workflow.await',
      'workflow.runs',
      'workflow.outputs',
    ])
    expect(byScope('workflow:run')).toEqual(['workflow.start', 'workflow.submitStep', 'workflow.cancel', 'workflow.resume'])
    expect(byScope('workflow:files')).toEqual(['workflow.sign'])
  })

  it('keeps the v1 scope vocabulary stable', () => {
    expect([...SCOPES]).toEqual(['workflow:read', 'workflow:run', 'workflow:files'])
  })

  it('answers for slash-form names and refuses strangers', () => {
    expect(scopeOf('workflow/sign')).toBe('workflow:files')
    expect(scopeOf('workflow.start')).toBe('workflow:run')
    expect(scopeOf('video.slice')).toBeUndefined()
    expect(scopeOf('constructor')).toBeUndefined()
  })

  it('maps every harness rule to one of the three scopes (Phase 3 plan, Decision 27)', () => {
    const keys = Object.keys(RULE_SCOPES)
    expect(keys).toHaveLength(15)
    for (const key of keys) expect(SCOPES).toContain(RULE_SCOPES[key])
    expect(ruleScopeOf('workflow/runs/post')).toBe('workflow:run')
    expect(ruleScopeOf('workflow/run/delete/post')).toBe('workflow:run')
    expect(ruleScopeOf('uploads/workflows/[...path]/get')).toBe('workflow:files')
    expect(ruleScopeOf('workflow/mcp/post')).toBeUndefined()
    expect(ruleScopeOf('constructor')).toBeUndefined()
  })
})
