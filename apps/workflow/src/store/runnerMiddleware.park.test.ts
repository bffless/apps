/**
 * `?wait=park` at run time (07 additions; ADR-0006 DR2/DR3) — what a *driven*
 * headless run does with a step that would otherwise wait on a person.
 *
 * Without the flag a headless run fails such a step fast (`HEADLESS_REQUIRED`,
 * `runnerMiddleware.headless.test.ts`); with it the driver has said it would
 * rather wait for a person than fail, so the step runs exactly as it would for
 * one, and the run **parks** the moment that step is the only thing left: the
 * lease is cleared, this tab stops driving, and the slice's mode reads
 * `parked`. The run record stays `running` — nothing failed.
 *
 * Driven through the real middleware against the MSW-backed run store
 * (`trackedHelloStore`) and a virtual clock, so the row assertions below are
 * against what the backend actually holds.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { db } from '../mocks/db'
import { newRunId } from '../lib/runner/ids'
import type { Definition, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import { flush, pumpUntil, resetHelloHarness, trackedHelloStore } from '../test/helloHarness'
import { runEvent, runOpened } from './runSlice'

afterEach(() => resetHelloHarness())

const REVIEW: StepKey = stepKey('confirm', 0, 'review')
const ECHO: StepKey = stepKey('confirm', 0, 'echo')

/** One job, given whole — every case here differs only in the first step's `headless:`. */
function withSteps(steps: Record<string, unknown>[]): Definition {
  return toDefinition({ name: 'Park', jobs: { confirm: { steps } } }) as Definition
}
/** Two jobs with no `needs` between them, so they are scheduled together. */
function withJobs(jobs: Record<string, unknown>): Definition {
  return toDefinition({ name: 'Park', jobs }) as Definition
}
const undeclaredForm = { id: 'review', uses: 'form', with: { title: 'Review', fields: { note: { type: 'string' } }, submit: 'Approve' } }
const autoForm = { ...undeclaredForm, headless: 'auto' }
const timedForm = { ...undeclaredForm, 'timeout-minutes': 1 }
const echo = { id: 'echo', uses: 'pipeline', with: { path: 'echo', text: 'hi' }, outputs: { text: { type: 'string' } } }
/**
 * `hello`'s `slow` job in miniature, stretched: the mock answers one BUSY per
 * distinct body (hence the `retry`) and its first poll tick is always
 * `pending`, so a half-hour `every` leaves the step sitting in `polling` for
 * as long as any case here needs it to. It is the *other* thing the run has to
 * do while the form waits — which is what keeps the run from parking.
 */
const longPoll = {
  id: 'wait',
  uses: 'pipeline',
  with: { path: 'slow', body: { lines: ['park'] } },
  poll: {
    path: 'job',
    query: { id: '${{ response.jobId }}' },
    until: "${{ response.status == 'done' }}",
    every: '30m',
    timeout: '90m',
  },
  retry: { max: 2, delay: '3s', if: "${{ error.code == 'BUSY' }}" },
}

/**
 * Start a headless run of `def`, with `park` on the meta the way the kickoff
 * page sets it from `?wait=park` — page state, so it never rides on
 * `run.started`.
 */
async function start(def: Definition, park: boolean) {
  const { store, advance } = trackedHelloStore()
  const runId = newRunId()
  store.dispatch(runOpened({ meta: { def, yaml: '# park\n', workflowName: 'Park', park } }))
  store.dispatch(runEvent({ type: 'run.started', runId, impl: 'hello', workflow: 'park', inputs: {}, headless: true, unattended: false, at: Date.now() }))
  await flush()
  return { store, advance, runId }
}

describe('wait=park (spec 07 additions; DR2/DR3)', () => {
  it('parks a headless run at an undeclared form: row waiting, lease cleared, mode parked', async () => {
    const { store, advance, runId } = await start(withSteps([undeclaredForm, echo]), true)
    await pumpUntil(advance, () => store.getState().run.mode === 'parked', { maxSteps: 200 })
    const state = store.getState().run
    expect(state.state?.status).toBe('running')
    expect(state.state?.steps[REVIEW]?.status).toBe('waiting')
    expect(state.state?.steps[ECHO]).toBeUndefined()
    const row = db.runs.get(runId)!
    expect(row.status).toBe('running')
    expect(row.leaseOwner).toBeNull()
    expect(row.leaseUntil).toBeNull()
  })

  it('still fails fast without the flag', async () => {
    const { store, advance } = await start(withSteps([undeclaredForm, echo]), false)
    await pumpUntil(advance, () => store.getState().run.state?.status === 'failed', { maxSteps: 200 })
    expect(store.getState().run.state?.steps[REVIEW]?.error?.code).toBe('HEADLESS_REQUIRED')
    expect(store.getState().run.mode).toBe('live')
  })

  it('does not park on a headless:auto form — it auto-submits as today', async () => {
    const { store, advance } = await start(withSteps([autoForm, echo]), true)
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running', { maxSteps: 400 })
    expect(store.getState().run.mode).not.toBe('parked')
    expect(store.getState().run.state?.steps[REVIEW]?.status).toBe('succeeded')
  })

  it('nobody submits the parked form on the person’s behalf, however long they take', async () => {
    const { store, advance } = await start(withSteps([undeclaredForm, echo]), true)
    await pumpUntil(advance, () => store.getState().run.mode === 'parked', { maxSteps: 200 })
    await advance(6 * 60_000)
    expect(store.getState().run.state?.steps[REVIEW]?.status).toBe('waiting')
  })

  /**
   * The budget half, which the case above cannot prove: parking disarms every
   * clock (`loseLease`), so a step that has already parked would sit at
   * `waiting` even with the old 5-minute default still being armed. Here the
   * run has *not* parked — a sibling job is mid-poll, which is work this tab
   * still owes the run — so the form's clock is the only thing that could
   * fire, and six minutes is past the `HEADLESS_AUTO_DEFAULT_MS` an undeclared
   * step used to be given.
   */
  it('gives an undeclared form no headless default budget while the run is still driving itself', async () => {
    const { store, advance } = await start(
      withJobs({ confirm: { steps: [undeclaredForm] }, work: { steps: [longPoll] } }),
      true,
    )
    await pumpUntil(advance, () => store.getState().run.state?.steps[REVIEW]?.status === 'waiting', {
      maxSteps: 200,
    })
    // The premise: the poll is unfinished work, so nothing parked.
    expect(store.getState().run.mode).toBe('live')

    await advance(6 * 60_000)

    const state = store.getState().run.state
    expect(state?.steps[REVIEW]?.status).toBe('waiting')
    expect(state?.steps[REVIEW]?.error).toBeUndefined()
    expect(state?.status).toBe('running')
    expect(store.getState().run.mode).toBe('live')
  })

  /**
   * A *declared* `timeout-minutes` is not spent while parked either (the
   * ruling on DR3): a parked tab holds no lease and may not write a terminal
   * row, so `loseLease` takes its clock with it. The budget is not forgiven —
   * `armWaitingStep` re-arms it from the step's recorded `startedAt` when the
   * run is resumed, and a run adopted past its budget fails immediately (07
   * Resume) — it simply does not run down with nobody watching.
   */
  it('does not spend a declared timeout-minutes while parked', async () => {
    const { store, advance } = await start(withSteps([timedForm, echo]), true)
    await pumpUntil(advance, () => store.getState().run.mode === 'parked', { maxSteps: 200 })

    await advance(2 * 60_000)

    const state = store.getState().run.state
    expect(state?.steps[REVIEW]?.status).toBe('waiting')
    expect(state?.steps[REVIEW]?.error).toBeUndefined()
    expect(state?.status).toBe('running')
  })
})
