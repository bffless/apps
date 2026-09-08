import { describe, expect, it } from 'vitest'
import { parseStepKey } from './runner/types'
import {
  jobPath, pathForSelection, redirectFor, runPath, selectionFromRoute, selectionKey, stepPath,
} from './runRoutes'

const BASE = '/hello/hello'
const RUN = 'run_1'

describe('parseStepKey', () => {
  it('splits a step key into its parts', () => {
    expect(parseStepKey('greet/1/say')).toEqual({ job: 'greet', index: 1, stepId: 'say' })
  })
  it('rejects a bare job id and a non-integer index', () => {
    expect(parseStepKey('greet')).toBeNull()
    expect(parseStepKey('greet/x/say')).toBeNull()
  })
})

describe('paths', () => {
  it('builds the three levels', () => {
    expect(runPath(BASE, RUN)).toBe('/hello/hello/runs/run_1')
    expect(jobPath(BASE, RUN, 'greet')).toBe('/hello/hello/runs/run_1/job/greet')
    expect(jobPath(BASE, RUN, 'greet', 1)).toBe('/hello/hello/runs/run_1/job/greet/1')
    expect(stepPath(BASE, RUN, 'greet/1/say')).toBe('/hello/hello/runs/run_1/job/greet/1?step=greet%2F1%2Fsay')
  })
  it('keeps unrelated query parameters and drops `step` on the way up', () => {
    const search = new URLSearchParams('mocks=on&step=greet%2F0%2Fsay')
    expect(pathForSelection(BASE, RUN, { kind: 'run' }, search)).toBe('/hello/hello/runs/run_1?mocks=on')
    expect(pathForSelection(BASE, RUN, { kind: 'job', job: 'slow' }, search)).toBe('/hello/hello/runs/run_1/job/slow?mocks=on')
    expect(pathForSelection(BASE, RUN, { kind: 'step', key: 'slow/0/start' }, search)).toBe(
      '/hello/hello/runs/run_1/job/slow/0?mocks=on&step=slow%2F0%2Fstart',
    )
  })
  it('carries the side an edge dot asked for', () => {
    expect(pathForSelection(BASE, RUN, { kind: 'job', job: 'slow' }, new URLSearchParams(), 'Output')).toBe(
      '/hello/hello/runs/run_1/job/slow?tab=Output',
    )
  })
})

describe('selectionFromRoute', () => {
  it('reads the three levels off the params and the query', () => {
    expect(selectionFromRoute({}, new URLSearchParams())).toEqual({ kind: 'run' })
    // An old Summary link is read as the level it names, so the shell knows
    // what it is redirecting before the redirect lands.
    expect(selectionFromRoute({}, new URLSearchParams('step=greet%2F1%2Fsay'))).toEqual({
      kind: 'step', key: 'greet/1/say',
    })
    expect(selectionFromRoute({}, new URLSearchParams('step=greet'))).toEqual({ kind: 'job', job: 'greet' })
    expect(selectionFromRoute({ job: 'greet' }, new URLSearchParams())).toEqual({ kind: 'job', job: 'greet' })
    expect(selectionFromRoute({ job: 'greet', index: '1' }, new URLSearchParams())).toEqual({ kind: 'job', job: 'greet', index: 1 })
    expect(selectionFromRoute({ job: 'greet', index: '1' }, new URLSearchParams('step=greet%2F1%2Fsay'))).toEqual({
      kind: 'step', key: 'greet/1/say',
    })
  })
  it('ignores a `step` that is not a step key, and a bad index', () => {
    expect(selectionFromRoute({ job: 'greet' }, new URLSearchParams('step=greet'))).toEqual({ kind: 'job', job: 'greet' })
    expect(selectionFromRoute({ job: 'greet', index: 'x' }, new URLSearchParams())).toEqual({ kind: 'job', job: 'greet' })
    expect(selectionFromRoute({}, new URLSearchParams('step='))).toEqual({ kind: 'run' })
  })
  it('maps a selection back to the key the follow logic reads', () => {
    expect(selectionKey({ kind: 'run' })).toBeNull()
    expect(selectionKey({ kind: 'job', job: 'greet', index: 1 })).toBe('greet')
    expect(selectionKey({ kind: 'step', key: 'greet/1/say' })).toBe('greet/1/say')
  })
})

describe('redirectFor', () => {
  it('sends an old `?step=<job>` on the Summary to the job page', () => {
    expect(redirectFor(BASE, RUN, new URLSearchParams('step=slow'))).toBe('/hello/hello/runs/run_1/job/slow')
  })
  it('sends an old `?step=<key>` to the job page with the step kept, other params riding along', () => {
    expect(redirectFor(BASE, RUN, new URLSearchParams('mocks=on&step=greet%2F1%2Fsay'))).toBe(
      '/hello/hello/runs/run_1/job/greet/1?mocks=on&step=greet%2F1%2Fsay',
    )
  })
  it('does nothing without a `step`', () => {
    expect(redirectFor(BASE, RUN, new URLSearchParams('resume=1'))).toBeNull()
  })
})
