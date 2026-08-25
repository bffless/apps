/**
 * Like `finishedRun.test.ts`: a fixture is only useful if the engine can fold
 * it, since the run page rebuilds its state with the same `replayRun` a resumed
 * live run uses. The extra thing asserted here is the point of this fixture —
 * the `big` output is stored as a *pointer*, not a value, so the page can only
 * show it by fetching what it points at.
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it } from 'vitest'
import { isFilePayload } from '../../lib/runner/payload'
import { replayRun } from '../../lib/runner/replay'
import type { StepStatus } from '../../lib/runner/types'
import { SCRIPT_RUN, SCRIPT_RUN_BIG_MARKER, SCRIPT_RUN_FILES } from './scriptRun'

const TERMINAL: StepStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled']

describe('SCRIPT_RUN', () => {
  const state = replayRun(SCRIPT_RUN.run, SCRIPT_RUN.steps, toDefinition(SCRIPT_RUN.run.definition))

  it('replays into a finished run of five terminal steps', () => {
    expect(state.status).toBe('succeeded')
    expect(Object.keys(state.steps)).toHaveLength(5)
    for (const step of Object.values(state.steps)) {
      expect(TERMINAL, step.key).toContain(step.status)
    }
  })

  it('records the script step as a script, with its log-free annotations and summary', () => {
    const draw = state.steps['card/0/draw']
    expect(draw.kind).toBe('script')
    expect(draw.summary).toMatch(/^Card \*\*poster\.svg\*\*/)
    expect(draw.annotations).toEqual([{ level: 'notice', message: 'card drawn' }])
  })

  it('stores `big` as a {"$file"} pointer whose bytes are seeded alongside it', () => {
    const big = state.steps['card/0/draw'].outputs?.big
    expect(isFilePayload(big)).toBe(true)
    const path = (big as { $file: { path: string } }).$file.path
    const bytes = SCRIPT_RUN_FILES.find((file) => file.path === path)
    expect(bytes, 'the payload has no seeded object').toBeDefined()
    expect(JSON.parse(bytes!.text).marker).toBe(SCRIPT_RUN_BIG_MARKER)
  })

  it('keeps the poster as a File ref the serve route can answer', () => {
    const poster = state.steps['card/0/draw'].outputs?.poster as { path: string; url: string }
    expect(poster.url).toBe(`/api/uploads/${poster.path}`)
    expect(SCRIPT_RUN_FILES.some((file) => file.path === poster.path)).toBe(true)
    expect(state.outputs?.poster).toEqual(poster)
  })

  it('is monotonic in time', () => {
    const stamps = SCRIPT_RUN.steps.flatMap((s) => [s.startedAt, s.finishedAt])
    for (const at of stamps) {
      if (at == null) continue
      expect(at).toBeGreaterThanOrEqual(SCRIPT_RUN.run.startedAt)
      expect(at).toBeLessThanOrEqual(SCRIPT_RUN.run.finishedAt as number)
    }
  })
})
