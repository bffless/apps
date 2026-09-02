import { describe, expect, it } from 'vitest'
import { SCOPES, TOOL_SCOPES, scopeOf } from '../src/scopes.js'
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
})
