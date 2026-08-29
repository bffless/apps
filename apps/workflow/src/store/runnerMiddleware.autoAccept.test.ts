/**
 * A step's own `auto-accept:` (07, apps#435): "Auto-accept the cut edits" on
 * Studio's kickoff form — the narrower sibling of "Don't wait for me". When it
 * evaluates truthy on an **interactive** run, that one step reads its
 * `headless:` declaration as an unattended run would, and every other step is
 * left to the person.
 *
 * Studio-shaped on purpose: a matrix job of `trim` islands (`headless: auto`,
 * `auto-accept: ${{ inputs.accept_cuts }}`), a blog `edit` island that skips
 * unattended, and a cover `pick` form that auto-submits unattended. The fake
 * island host stands in for the cut editor; its `onSubmit` is the island's own
 * self-submit path (`hostContext.bffless.headless` is the only thing the real
 * island reads, App.test.tsx on the Studio side).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { replayRun } from '../lib/runner/replay'
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { Definition, RunState, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import { getIslandHandle } from './islandLaunch'
import { startRun } from './runnerActions'
import { runOpened, runReplaced } from './runSlice'
import { flush, islandStore, pumpUntil, resetIslandHarness } from '../test/islandHarness'
import type { AppStore } from './index'

afterEach(() => {
  resetIslandHarness()
})

const YAML = '# studio-shaped\n'
const SCENES = [{ title: 'Intro' }, { title: 'Demo' }, { title: 'Outro' }]

function studioShaped(trim: Record<string, unknown> = {}): Definition {
  return toDefinition({
    name: 'Studio-shaped',
    on: { manual: { inputs: { accept_cuts: { type: 'boolean', default: true } } } },
    jobs: {
      // Job ids sorted as the scheduler sorts them (topo, then id): `blog`,
      // `cover`, `scenes` — so the fake host's launch order is edit, then the
      // three trims, and `allDeps` can be read positionally.
      blog: {
        steps: [
          {
            id: 'edit',
            uses: 'island',
            with: { src: 'islands/blog-editor.html', title: 'Edit the post' },
            outputs: { post: { type: 'string' } },
            headless: { mode: 'skip', outputs: { post: 'the draft' } },
          },
        ],
      },
      cover: {
        steps: [
          {
            id: 'pick',
            uses: 'form',
            with: { title: 'Pick a cover', fields: { choice: { type: 'string', default: 'a' } }, submit: 'Pick' },
            headless: 'auto',
          },
        ],
      },
      scenes: {
        strategy: { matrix: { scene: SCENES } },
        steps: [
          {
            id: 'trim',
            uses: 'island',
            with: { src: 'islands/cut-editor.html', title: 'Trim: ${{ matrix.scene.title }}', scene: '${{ matrix.scene }}' },
            outputs: { keep: { type: 'json' } },
            headless: 'auto',
            'auto-accept': '${{ inputs.accept_cuts }}',
            ...trim,
          },
        ],
      },
    },
  }) as Definition
}

const EDIT: StepKey = stepKey('blog', 0, 'edit')
const PICK: StepKey = stepKey('cover', 0, 'pick')
const TRIM = (i: number): StepKey => stepKey('scenes', i, 'trim')
const TRIMS = SCENES.map((_, i) => TRIM(i))

const runState = (store: AppStore): RunState => store.getState().run.state!
const status = (store: AppStore, key: StepKey) => runState(store).steps[key]?.status

/** A detached iframe is all the fake host ever does with the element. */
const frame = () => document.createElement('iframe')

async function start(def: Definition, a: { accept_cuts: boolean; unattended?: boolean }) {
  const { store, advance, host, writes } = islandStore()
  store.dispatch(
    startRun({
      impl: 'studio',
      workflow: 'studio',
      def,
      yaml: YAML,
      workflowName: 'Studio-shaped',
      values: { accept_cuts: a.accept_cuts },
      unattended: a.unattended ?? false,
    }),
  )
  // Every interactive step has been reached: the islands have handles, the form waits.
  await pumpUntil(advance, () => TRIMS.every((k) => status(store, k) === 'running'))
  await pumpUntil(advance, () => ['running', 'skipped'].includes(status(store, EDIT) ?? ''))
  await pumpUntil(advance, () => ['waiting', 'succeeded'].includes(status(store, PICK) ?? ''))
  const runId = runState(store).runId
  return { store, advance, host, writes, runId }
}

describe('auto-accept — "Auto-accept the cut edits" on an interactive run', () => {
  it('self-submits every trim scene while edit and pick still wait for the person', async () => {
    const { store, advance, host, runId, writes } = await start(studioShaped(), { accept_cuts: true })

    // Only the run's own kickoff input decided this: the run is neither
    // headless nor unattended, and its row says so.
    expect(runState(store)).toMatchObject({ headless: false, unattended: false, inputs: { accept_cuts: true } })
    const create = writes.find((w) => w.op === 'create')
    expect(create && create.op === 'create' ? create.row : null).toMatchObject({
      headless: false,
      unattended: false,
      inputs: { accept_cuts: true },
    })

    // Every `trim` scene mounts self-driving; `edit` mounts for its person.
    for (const key of TRIMS) expect(getIslandHandle(runId, key)!.headless).toBe(true)
    expect(getIslandHandle(runId, EDIT)!.headless).toBe(false)
    expect(status(store, EDIT)).toBe('running')
    expect(status(store, PICK)).toBe('waiting')

    // The pane mounts each trim island; the island reads the flag and submits
    // the cuts as they stand — no click anywhere. Launch order is edit, then
    // the trims in matrix order (see the definition).
    expect(host.allDeps).toHaveLength(4)
    for (const [i, key] of TRIMS.entries()) {
      void getIslandHandle(runId, key)!.mount(frame())
      await flush()
      host.settle()
      await flush()
      expect(status(store, key)).toBe('waiting')
      expect(host.mounts.at(-1)!.headless).toBe(true)
      expect(host.deps).not.toBeNull()
      const submitted = host.allDeps[i + 1]!.onSubmit({ keep: [{ start: 0, end: i + 1 }] })
      expect(submitted).toEqual({ ok: true })
      await flush()
    }
    await pumpUntil(advance, () => TRIMS.every((k) => status(store, k) === 'succeeded'))
    expect(runState(store).steps[TRIM(1)]!.outputs).toEqual({ keep: [{ start: 0, end: 2 }] })

    // Nobody touched the person's steps: still theirs, however long they take.
    await advance(10 * 60_000)
    expect(status(store, EDIT)).toBe('running')
    expect(status(store, PICK)).toBe('waiting')
    expect(runState(store).status).toBe('running')
  })

  it('leaves every trim scene to the person when the box is unticked', async () => {
    const { store, runId } = await start(studioShaped(), { accept_cuts: false })

    for (const key of TRIMS) expect(getIslandHandle(runId, key)!.headless).toBe(false)
    expect(getIslandHandle(runId, EDIT)!.headless).toBe(false)
    expect(status(store, PICK)).toBe('waiting')
  })

  it('is irrelevant under "Don\'t wait for me": every declaration is honoured as before (apps#434)', async () => {
    const { store, advance, runId } = await start(studioShaped(), { accept_cuts: false, unattended: true })

    for (const key of TRIMS) expect(getIslandHandle(runId, key)!.headless).toBe(true)
    expect(runState(store).steps[EDIT]).toMatchObject({ status: 'skipped', outputs: { post: 'the draft' } })
    await pumpUntil(advance, () => status(store, PICK) === 'succeeded')
    expect(runState(store).steps[PICK]!.outputs).toEqual({ choice: 'a' })
  })

  it('applies a `skip` declaration too, and a bare boolean', async () => {
    const def = studioShaped({
      headless: { mode: 'skip', outputs: { keep: [] } },
      'auto-accept': true,
    })
    const { store, advance, host, writes } = islandStore()
    store.dispatch(
      startRun({ impl: 'studio', workflow: 'studio', def, yaml: YAML, workflowName: 'Studio-shaped', values: { accept_cuts: false } }),
    )
    await pumpUntil(advance, () => TRIMS.every((k) => status(store, k) === 'skipped'))

    for (const key of TRIMS) expect(runState(store).steps[key]!.outputs).toEqual({ keep: [] })
    // No island was ever built for a skipped step — only `edit`'s host exists.
    expect(host.allDeps).toHaveLength(1)
    expect(writes.find((w) => w.op === 'create')).toMatchObject({ row: { unattended: false } })
  })

  it('fails the step, not the run, on an expression that cannot be evaluated', async () => {
    const def = studioShaped({ 'auto-accept': '${{ inputs.accept_cuts && }}' })
    const { store, advance } = islandStore()
    store.dispatch(
      startRun({ impl: 'studio', workflow: 'studio', def, yaml: YAML, workflowName: 'Studio-shaped', values: { accept_cuts: true } }),
    )
    // The first leg fails on the declaration; a sibling fails the same way or
    // is fail-fast skipped before its own turn — either is a leg that did not
    // self-drive by mistake, and none of it is an illegal transition.
    await pumpUntil(advance, () =>
      TRIMS.every((k) => ['failed', 'skipped', 'cancelled'].includes(status(store, k) ?? '')),
    )

    expect(runState(store).steps[TRIM(0)]!.error).toMatchObject({
      code: 'AUTO_ACCEPT',
      message: expect.stringMatching(/expression/),
    })
    // The person's steps are untouched by a neighbour's bad declaration.
    await pumpUntil(advance, () => status(store, PICK) === 'waiting')
    expect(status(store, PICK)).toBe('waiting')
  })
})

describe('auto-accept — resume reads the persisted inputs', () => {
  const def = studioShaped()

  /** A run left with one scene trimmed and the rest still `waiting`, `edit` waiting too. */
  function rows(runId: string, accept_cuts: boolean): { run: RunRow; steps: StepRow[] } {
    const island = (key: StepKey, job: string, index: number, step: string, inputs: Record<string, unknown>): StepRow => ({
      runId,
      key,
      job,
      index,
      step,
      kind: 'island',
      status: 'waiting',
      attempt: 1,
      inputs,
      annotations: [],
      startedAt: 1_001,
    })
    return {
      run: {
        runId,
        impl: 'studio',
        workflow: 'studio',
        workflowName: 'Studio-shaped',
        definition: def.raw,
        yaml: YAML,
        inputs: { accept_cuts },
        status: 'running',
        headless: false,
        unattended: false,
        startedAt: 1_000,
        finishedAt: null,
        outputs: null,
        annotations: [],
      },
      steps: [
        island(EDIT, 'blog', 0, 'edit', {}),
        { ...island(TRIM(0), 'scenes', 0, 'trim', { scene: SCENES[0] }), status: 'succeeded', outputs: { keep: [] }, finishedAt: 1_002 },
        island(TRIM(1), 'scenes', 1, 'trim', { scene: SCENES[1] }),
        island(TRIM(2), 'scenes', 2, 'trim', { scene: SCENES[2] }),
      ],
    }
  }

  async function resume(accept_cuts: boolean) {
    const { store } = islandStore()
    const runId = `run_resumed_${accept_cuts}`
    const { run, steps } = rows(runId, accept_cuts)
    store.dispatch(runOpened({ meta: { def, yaml: YAML, workflowName: 'Studio-shaped' } }))
    store.dispatch(runReplaced({ state: replayRun(run, steps, def), mode: 'live' }))
    await flush()
    return { store, runId }
  }

  it('still auto-accepts the remaining scenes of a run started with the box ticked', async () => {
    const { store, runId } = await resume(true)

    expect(runState(store)).toMatchObject({ unattended: false, headless: false })
    expect(getIslandHandle(runId, TRIM(1))!.headless).toBe(true)
    expect(getIslandHandle(runId, TRIM(2))!.headless).toBe(true)
    expect(getIslandHandle(runId, EDIT)!.headless).toBe(false)
    // The finished scene is not re-launched.
    expect(getIslandHandle(runId, TRIM(0))).toBeUndefined()
  })

  it('and waits per scene for one started with it unticked', async () => {
    const { runId } = await resume(false)

    expect(getIslandHandle(runId, TRIM(1))!.headless).toBe(false)
    expect(getIslandHandle(runId, TRIM(2))!.headless).toBe(false)
  })
})
