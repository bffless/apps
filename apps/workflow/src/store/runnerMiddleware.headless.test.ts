/**
 * `headless: skip | auto` at run time (Task 12, Decision 11) — what an
 * unattended run does with the two step kinds that otherwise wait on a person.
 *
 * `form` and `island` are the only kinds with nobody to drive them in CI, so a
 * headless run reads each one's `headless:` declaration before it starts the
 * step: `skip` stands in the declared outputs without ever creating the pane,
 * `auto` runs the step exactly as an interactive run would (bounded by the wait
 * clock of Task 9), and a step that declared neither is a definition that cannot
 * run unattended at all — `HEADLESS_REQUIRED`, with a run annotation so the
 * failure is legible from the run list.
 *
 * Driven through the real middleware against the MSW-backed run store
 * (`trackedHelloStore`) and a virtual clock, like `runnerMiddleware.form.test.ts`
 * — nothing here mocks the branch under test. A headless run is started by
 * dispatching `run.started` with `headless: true` directly, because `startRun`
 * still hardcodes `headless: false` (Task 13 owns that half).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { db, stepRowKey } from '../mocks/db'
import { newRunId } from '../lib/runner/ids'
import type { Definition, FileRef, RunState, StepKey, StepState } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import type { AppStore } from './index'
import { flush, pumpUntil, resetHelloHarness, trackedHelloStore } from '../test/helloHarness'
import { runEvent, runOpened } from './runSlice'

afterEach(() => {
  resetHelloHarness()
})

const YAML = '# a headless workflow\n'
const REVIEW: StepKey = stepKey('confirm', 0, 'review')
const ECHO: StepKey = stepKey('confirm', 0, 'echo')

/** One job, whose steps are given whole — every case here differs only in the step declarations. */
function withSteps(steps: Record<string, unknown>[], outputs: Record<string, string> = {}): Definition {
  return toDefinition({
    name: 'Headless',
    jobs: { confirm: { steps, outputs } },
  }) as Definition
}

/** A `form` step called `review`, with whatever `headless:`/fields the case needs. */
function form(fields: Record<string, unknown>, extra: Record<string, unknown> = {}, id = 'review') {
  return {
    id,
    uses: 'form',
    with: { title: 'Review', fields, submit: 'Approve' },
    ...extra,
  }
}

/** An `island` step called `review` — never actually launched by any case here. */
function island(outputs: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: 'review',
    uses: 'island',
    with: { src: 'islands/pick.html', title: 'Pick' },
    outputs,
    ...extra,
  }
}

interface Started {
  store: AppStore
  advance: (ms: number) => Promise<void>
}

/**
 * Start `def` and pump until the run settles (or, interactively, until the
 * form is waiting on its person). `headless` is put on `run.started` itself:
 * it is the run's own fact, and every branch under test reads it off
 * `runState.headless`.
 */
async function start(
  def: Definition,
  a: { headless?: boolean; inputs?: Record<string, unknown> } = {},
): Promise<Started> {
  const { store, advance } = trackedHelloStore()
  store.dispatch(runOpened({ meta: { def, yaml: YAML, workflowName: 'Headless' } }))
  store.dispatch(
    runEvent({
      type: 'run.started',
      runId: newRunId(),
      impl: 'hello',
      workflow: 'headless',
      inputs: a.inputs ?? {},
      headless: a.headless ?? true,
      at: 1_000,
    }),
  )
  await flush()
  return { store, advance }
}

const runState = (store: AppStore): RunState => store.getState().run.state!
const stepOf = (store: AppStore, key: StepKey = REVIEW): StepState | undefined =>
  runState(store).steps[key]

/** The step row as the mock backend holds it — the record the live state must not run ahead of. */
const stepRow = (store: AppStore, key: StepKey = REVIEW) =>
  db.steps.get(stepRowKey(runState(store).runId, key))

/** Pump until the step reaches a terminal status. */
async function settle(s: Started, key: StepKey = REVIEW): Promise<void> {
  await pumpUntil(s.advance, () =>
    ['succeeded', 'failed', 'skipped', 'cancelled'].includes(
      s.store.getState().run.state?.steps[key]?.status ?? '',
    ),
  )
}

// ---------------------------------------------------------------------------
// skip — the step never runs; its declared outputs stand in for it
// ---------------------------------------------------------------------------

describe('headless: skip', () => {
  it('skips the step with its declared outputs, and a later step reads them', async () => {
    const def = withSteps([
      form(
        { approved: { type: 'boolean' } },
        { headless: { mode: 'skip', outputs: { approved: true } } },
      ),
      form(
        { copy: { type: 'boolean' } },
        { headless: { mode: 'skip', outputs: { copy: '${{ steps.review.outputs.approved }}' } } },
        'echo',
      ),
    ])
    const s = await start(def)
    await settle(s)
    await settle(s, ECHO)

    expect(stepOf(s.store)!).toMatchObject({ status: 'skipped', outputs: { approved: true } })
    // The downstream expression resolved against the skipped step's outputs.
    expect(stepOf(s.store, ECHO)!).toMatchObject({ status: 'skipped', outputs: { copy: true } })
  })

  it('writes the outputs onto the skipped step row', async () => {
    const def = withSteps([
      form(
        { approved: { type: 'boolean' } },
        { headless: { mode: 'skip', outputs: { approved: true } } },
      ),
    ])
    const s = await start(def)
    await settle(s)
    await flush()

    expect(stepRow(s.store)).toMatchObject({ status: 'skipped', outputs: { approved: true } })
  })

  it('never queues the step: the skip is its creation event', async () => {
    const def = withSteps([
      form({ approved: { type: 'boolean' } }, { headless: 'skip' }),
    ])
    const s = await start(def)
    await settle(s)

    // A bare `headless: skip` declares no outputs at all — every field is
    // unanswered, which is not an error unless the field is `required`.
    expect(stepOf(s.store)!).toMatchObject({ status: 'skipped', outputs: { approved: null } })
    expect(stepOf(s.store)!.startedAt).toBeUndefined()
  })

  it('a choice over File refs skips to the ref its path named', async () => {
    const poster: FileRef = {
      path: 'runs/r1/poster.svg',
      name: 'poster.svg',
      contentType: 'image/svg+xml',
      size: 42,
      url: '/api/uploads/runs/r1/poster.svg',
    }
    // hello's own `review` step in miniature (`interactive.workflow.yaml`): a
    // `choice` whose options are File refs, skipped to one of those refs. The
    // declared value is a ref *object*, and `choice` only validates strings —
    // so the skip must normalise it to the option's `path` to check membership
    // and record the ref again afterwards, exactly as a submit does.
    const def = withSteps([
      form(
        { cover: { type: 'choice', options: '${{ inputs.posters }}', required: true } },
        { headless: { mode: 'skip', outputs: { cover: '${{ inputs.posters[0] }}' } } },
      ),
    ])
    const s = await start(def, { inputs: { posters: [poster] } })
    await settle(s)

    expect(stepOf(s.store)!.status).toBe('skipped')
    expect(stepOf(s.store)!.outputs).toEqual({ cover: poster })
  })

  it("fails HEADLESS_SKIP when a declared value fails the step's own map", async () => {
    const def = withSteps([
      form(
        { approved: { type: 'boolean' } },
        { headless: { mode: 'skip', outputs: { approved: 'yes' } } },
      ),
    ])
    const s = await start(def)
    await settle(s)

    expect(stepOf(s.store)!).toMatchObject({
      status: 'failed',
      error: { code: 'HEADLESS_SKIP', message: 'approved: Expected a boolean value' },
    })
    expect(runState(s.store).status).toBe('failed')
  })

  it('validates an island skip against its `outputs` map, untyped meaning json', async () => {
    const def = withSteps([
      island(
        { line: { type: 'string' }, extra: {} },
        { headless: { mode: 'skip', outputs: { line: 'picked', extra: { any: ['shape'] } } } },
      ),
    ])
    const s = await start(def)
    await settle(s)

    expect(stepOf(s.store)!).toMatchObject({
      status: 'skipped',
      kind: 'island',
      outputs: { line: 'picked', extra: { any: ['shape'] } },
    })
  })

  it('fails HEADLESS_SKIP on an island value that fails its declared type', async () => {
    const def = withSteps([
      island({ line: { type: 'string' } }, { headless: { mode: 'skip', outputs: { line: 42 } } }),
    ])
    const s = await start(def)
    await settle(s)

    expect(stepOf(s.store)!).toMatchObject({
      status: 'failed',
      error: { code: 'HEADLESS_SKIP', message: 'line: Expected a string value' },
    })
  })
})

// ---------------------------------------------------------------------------
// auto — the step runs; a form submits its own defaults with no pane
// ---------------------------------------------------------------------------

describe('headless: auto', () => {
  it("submits a form's defaults without a pane", async () => {
    const def = withSteps([
      form(
        { approved: { type: 'boolean', default: true }, note: { type: 'string', default: 'ok' } },
        { headless: 'auto' },
      ),
    ])
    const s = await start(def)
    await settle(s)

    expect(stepOf(s.store)!).toMatchObject({
      status: 'succeeded',
      outputs: { approved: true, note: 'ok' },
    })
    // It really went through `waiting` — the status the reducer stamps
    // `startedAt` at — rather than skipping the wait altogether.
    expect(stepOf(s.store)!.startedAt).toBeDefined()
  })

  it('fails HEADLESS_FORM when the defaults do not satisfy the fields', async () => {
    const def = withSteps([
      form({ approved: { type: 'boolean', required: true } }, { headless: 'auto' }),
    ])
    const s = await start(def)
    await settle(s)

    expect(stepOf(s.store)!).toMatchObject({
      status: 'failed',
      error: { code: 'HEADLESS_FORM', message: 'approved: This field is required' },
    })
  })

})

// ---------------------------------------------------------------------------
// no declaration at all — the definition cannot run unattended
// ---------------------------------------------------------------------------

describe('headless: undeclared', () => {
  const MESSAGE = 'step confirm/0/review needs a person; declare headless:'

  it('fails HEADLESS_REQUIRED and annotates the run', async () => {
    const def = withSteps([form({ approved: { type: 'boolean' } })])
    const s = await start(def)
    await settle(s)

    expect(stepOf(s.store)!).toMatchObject({
      status: 'failed',
      error: { code: 'HEADLESS_REQUIRED', message: MESSAGE },
    })
    expect(runState(s.store).annotations).toContainEqual({
      level: 'error',
      message: MESSAGE,
      stepKey: REVIEW,
    })
    expect(runState(s.store).status).toBe('failed')
  })

  it('fails an undeclared island the same way', async () => {
    const def = withSteps([island({ line: { type: 'string' } })])
    const s = await start(def)
    await settle(s)

    expect(stepOf(s.store)!).toMatchObject({
      status: 'failed',
      error: { code: 'HEADLESS_REQUIRED', message: MESSAGE },
    })
  })
})

// ---------------------------------------------------------------------------
// interactive — `headless:` is not read at all
// ---------------------------------------------------------------------------

describe('interactive runs', () => {
  it('ignore `headless: skip` and wait for a person', async () => {
    const def = withSteps([
      form(
        { approved: { type: 'boolean' } },
        { headless: { mode: 'skip', outputs: { approved: true } } },
      ),
    ])
    const s = await start(def, { headless: false })
    await pumpUntil(s.advance, () => stepOf(s.store)?.status === 'waiting')

    await s.advance(30 * 60_000)
    expect(stepOf(s.store)!.status).toBe('waiting')
    expect(stepOf(s.store)!.outputs).toBeUndefined()
  })

  it('ignore an undeclared `headless:` and wait for a person', async () => {
    const def = withSteps([form({ approved: { type: 'boolean' } })])
    const s = await start(def, { headless: false })
    await pumpUntil(s.advance, () => stepOf(s.store)?.status === 'waiting')

    expect(runState(s.store).annotations).toEqual([])
  })
})
