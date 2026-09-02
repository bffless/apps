/**
 * `loadWorkflowDefinition` against the MSW mock backend: the happy path and
 * every refusal, each spelled exactly as the kickoff page spells it.
 */
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { START_REFUSALS } from '../lib/autoStart'
import { server } from '../mocks/server'
import { makeStore } from './index'
import { loadWorkflowDefinition } from './workflowLoad'

describe('loadWorkflowDefinition', () => {
  it("resolves hello's interactive workflow: impl, listing, id, definition, yaml", async () => {
    const result = await makeStore().dispatch(loadWorkflowDefinition({ impl: 'hello', workflow: 'interactive' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.impl.alias).toBe('hello')
    expect(result.listing.file).toBe('interactive.workflow.yaml')
    expect(result.workflow).toBe('interactive')
    expect(result.def.name).toBe('Interactive hello')
    expect(result.yaml).toContain('name: Interactive hello')
  })

  it('refuses an alias nobody publishes, keyed `workflow`', async () => {
    const result = await makeStore().dispatch(loadWorkflowDefinition({ impl: 'nope', workflow: 'interactive' }))
    expect(result).toEqual({ ok: false, errors: { workflow: START_REFUSALS.noWorkflow } })
  })

  it('refuses a workflow the implementation does not list, keyed `workflow`', async () => {
    const result = await makeStore().dispatch(loadWorkflowDefinition({ impl: 'hello', workflow: 'missing' }))
    expect(result).toEqual({ ok: false, errors: { workflow: START_REFUSALS.noWorkflow } })
  })

  it('refuses when the alias list itself fails, keyed `discovery`', async () => {
    server.use(http.get('/api/workflow/aliases', () => new HttpResponse(null, { status: 500 })))
    const result = await makeStore().dispatch(loadWorkflowDefinition({ impl: 'hello', workflow: 'interactive' }))
    expect(result).toEqual({ ok: false, errors: { discovery: START_REFUSALS.discovery } })
  })

  it('refuses a listed file that cannot be fetched', async () => {
    server.use(
      http.get('/w/:alias/.bffless/workflows/interactive.workflow.yaml', () => new HttpResponse(null, { status: 500 })),
    )
    const result = await makeStore().dispatch(loadWorkflowDefinition({ impl: 'hello', workflow: 'interactive' }))
    expect(result).toEqual({ ok: false, errors: { workflow: START_REFUSALS.fileUnreadable } })
  })

  it('refuses a file that does not lint', async () => {
    server.use(
      http.get('/w/:alias/.bffless/workflows/interactive.workflow.yaml', () =>
        HttpResponse.text('spec: 1\nname: Broken\njobs: {}\n'),
      ),
    )
    const result = await makeStore().dispatch(loadWorkflowDefinition({ impl: 'hello', workflow: 'interactive' }))
    expect(result).toEqual({ ok: false, errors: { workflow: START_REFUSALS.doesNotLint } })
  })
})
