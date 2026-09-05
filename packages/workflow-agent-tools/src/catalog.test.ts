import { describe, expect, it } from 'vitest'
import { CATALOG, toolByName } from './index.js'

describe('the catalog says what start and resume do on each surface (ADR-0006)', () => {
  it('tells a model that over the MCP endpoint a start dispatches a driver and answers pending', () => {
    const description = toolByName('workflow.start')?.description ?? ''
    expect(description).toBe(
      'Start a run of a workflow with the given inputs. Validated exactly as the kickoff form validates a person’s values; a refusal names each bad input. On the harness page it returns the run id and its first snapshot and moves the page to the run. Over the MCP endpoint it dispatches the implementation’s headless driver and answers `pending` with the run id; poll workflow.status until the row exists (about a minute), then complete its interactive steps here.',
    )
  })

  it('tells a model that a resume is how a run answered here continues without a person on the page', () => {
    const description = toolByName('workflow.resume')?.description ?? ''
    expect(description).toBe(
      'Take over a `running` run whose driver went away (an expired lease). On the harness page this surface drives it from here. Over the MCP endpoint it dispatches the implementation’s headless driver to resume the run — how a run answered here continues without a person on the page.',
    )
  })
})

describe('the catalog names both interactive step kinds for the agent-host panel', () => {
  it('submitStep tells a host-rendering agent to open an island or a form with values: {}', () => {
    const description = toolByName('workflow.submitStep')?.description ?? ''
    expect(description).toContain('call it with `values: {}` for an island or form step')
    expect(description).toContain('do not invent values for them')
    expect(CATALOG.find((t) => t.name === 'workflow.submitStep')?.description).toBe(description)
  })
})
