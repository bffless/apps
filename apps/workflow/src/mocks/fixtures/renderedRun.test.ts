/**
 * The fixture is only useful if it is a *replayable* record (see
 * `finishedRun.test.ts` for why) and if its run-level outputs actually
 * resolve, through `resolveOutputDecl`, to the renderer the one pipeline step
 * declared — that's the whole point of a fixture built to exercise all five
 * named renderers through `RunOutputs` (Task 17).
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it } from 'vitest'
import { RUN_SCOPE, resolveOutputDecl } from '../../lib/outputDecls'
import { replayRun } from '../../lib/runner/replay'
import { RENDERED_RUN } from './renderedRun'

describe('RENDERED_RUN', () => {
  const def = toDefinition(RENDERED_RUN.run.definition)
  const state = replayRun(RENDERED_RUN.run, RENDERED_RUN.steps, def)

  it('replays into a finished run of one succeeded step', () => {
    expect(state.status).toBe('succeeded')
    expect(Object.keys(state.steps)).toEqual(['show/0/render'])
    expect(state.steps['show/0/render'].status).toBe('succeeded')
    expect(state.startedBy).toBe('user_mock')
  })

  it('carries the run outputs the step recorded', () => {
    expect(state.outputs).toEqual(RENDERED_RUN.run.outputs)
  })

  it('resolves each run-level output to the render its step declared', () => {
    expect(resolveOutputDecl(def, RUN_SCOPE, 'words')).toMatchObject({ render: 'transcript' })
    expect(resolveOutputDecl(def, RUN_SCOPE, 'counts')).toMatchObject({
      render: 'chart',
      mapping: { x: 'line', y: 'chars', kind: 'bar' },
    })
    expect(resolveOutputDecl(def, RUN_SCOPE, 'snippet')).toMatchObject({
      render: 'code',
      mapping: { language: 'javascript' },
    })
    expect(resolveOutputDecl(def, RUN_SCOPE, 'pics')).toMatchObject({ render: 'images', list: true })
    expect(resolveOutputDecl(def, RUN_SCOPE, 'view')).toMatchObject({
      render: 'island',
      src: 'islands/line-viewer.html',
    })
  })

  it('is monotonic in time', () => {
    const stamps = RENDERED_RUN.steps.flatMap((s) => [s.startedAt, s.finishedAt])
    for (const at of stamps) {
      if (at == null) continue
      expect(at).toBeGreaterThanOrEqual(RENDERED_RUN.run.startedAt)
      expect(at).toBeLessThanOrEqual(RENDERED_RUN.run.finishedAt as number)
    }
  })
})
