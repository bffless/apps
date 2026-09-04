import { describe, expect, it } from 'vitest'
import { CATALOG, toolByName } from './index.js'

describe('the catalog names both interactive step kinds for the agent-host panel', () => {
  it('submitStep tells a host-rendering agent to open an island or a form with values: {}', () => {
    const description = toolByName('workflow.submitStep')?.description ?? ''
    expect(description).toContain('call it with `values: {}` for an island or form step')
    expect(description).toContain('do not invent values for them')
    expect(CATALOG.find((t) => t.name === 'workflow.submitStep')?.description).toBe(description)
  })
})
