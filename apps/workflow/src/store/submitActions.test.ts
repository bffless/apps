/**
 * `submitStep`: forms and islands through their own validators, every refusal
 * keyed, only the driving tab may submit. Driven through the real middleware
 * (the hello harness for the form, the island harness for the island).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { getIslandHandle } from './islandLaunch'
import { makeStore } from './index'
import { submitStep } from './submitActions'
import { REVIEW_KEY, resetHelloHarness, startHelloAtConfirmWaiting } from '../test/helloHarness'
import { ISLAND_KEY, flush, resetIslandHarness, startIslandRun } from '../test/islandHarness'

afterEach(() => {
  resetHelloHarness()
  resetIslandHarness()
})

/** What an agent does with a waiting form's evaluated fields: each field's default. */
function defaultsOf(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, (field as { default?: unknown }).default ?? null]),
  )
}

describe('submitStep — forms', () => {
  it('completes a waiting form with values its fields accept', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const fields = (store.getState().run.state!.steps[REVIEW_KEY]!.inputs as { fields: Record<string, unknown> }).fields
    const result = store.dispatch(submitStep({ key: REVIEW_KEY, values: defaultsOf(fields) }))
    expect(result).toEqual({ ok: true })
    const step = store.getState().run.state!.steps[REVIEW_KEY]!
    expect(step.status).toBe('succeeded')
    expect(step.outputs).toMatchObject({ approved: true })
  })

  it('refuses values the fields reject, keyed by field, and dispatches nothing', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const result = store.dispatch(submitStep({ key: REVIEW_KEY, values: { approved: 'nope', report: '' } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors)).toEqual(['approved'])
    expect(store.getState().run.state!.steps[REVIEW_KEY]!.status).toBe('waiting')
  })

  it('refuses a step that is not waiting, an unknown step, and a kind that never waits', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    expect(store.dispatch(submitStep({ key: 'nope/0/x', values: {} }))).toEqual({
      ok: false,
      errors: { step: 'No such step in this run' },
    })
    expect(store.dispatch(submitStep({ key: 'greet/0/say', values: {} }))).toEqual({
      ok: false,
      errors: { step: 'A pipeline step cannot be submitted' },
    })
    store.dispatch(submitStep({ key: REVIEW_KEY, values: { approved: true, report: 'x' } }))
    expect(store.dispatch(submitStep({ key: REVIEW_KEY, values: { approved: true, report: 'x' } }))).toEqual({
      ok: false,
      errors: { step: 'That step is not waiting (status: succeeded)' },
    })
  })

  it('refuses when the page has no run at all', () => {
    const store = makeStore()
    expect(store.dispatch(submitStep({ key: REVIEW_KEY, values: { approved: true } }))).toEqual({
      ok: false,
      errors: { runId: 'This page has no run' },
    })
  })
})

describe('submitStep — islands', () => {
  it('completes a waiting island with its declared outputs and tears its bridge down', async () => {
    const { store, runId, host } = await startIslandRun()
    void getIslandHandle(runId, ISLAND_KEY)!.mount(document.createElement('iframe'))
    await flush()
    host.settle()
    await flush()
    expect(store.getState().run.state!.steps[ISLAND_KEY]!.status).toBe('waiting')

    expect(store.dispatch(submitStep({ key: ISLAND_KEY, values: { choice: 'a', extra: 'dropped' } }))).toEqual({ ok: true })
    const step = store.getState().run.state!.steps[ISLAND_KEY]!
    expect(step.status).toBe('succeeded')
    expect(step.outputs).toEqual({ choice: 'a' })
    await flush()
    expect(host.teardowns).toContain('completed')
    expect(getIslandHandle(runId, ISLAND_KEY)).toBeUndefined()
  })

  it('refuses outputs the declared map rejects, and an island still loading', async () => {
    const { store, runId, host } = await startIslandRun()
    // Still `running`: the pane has not mounted it yet.
    expect(store.dispatch(submitStep({ key: ISLAND_KEY, values: { choice: 'a' } }))).toEqual({
      ok: false,
      errors: { step: 'That step is not waiting (status: running)' },
    })
    void getIslandHandle(runId, ISLAND_KEY)!.mount(document.createElement('iframe'))
    await flush()
    host.settle()
    await flush()
    const result = store.dispatch(submitStep({ key: ISLAND_KEY, values: { choice: 5 } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors)).toEqual(['choice'])
    expect(store.getState().run.state!.steps[ISLAND_KEY]!.status).toBe('waiting')
  })
})
