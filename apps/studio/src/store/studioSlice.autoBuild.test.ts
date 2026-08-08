import { describe, it, expect } from 'vitest'
import reducer, {
  startAutoBuild,
  pauseAutoBuild,
  resumeAutoBuild,
  stopAutoBuild,
  haltAutoBuild,
  completeAutoBuild,
  autoStepStarted,
  autoStepFinished,
  freshWorkingState,
  type StudioState,
} from './studioSlice'

const withOneProject = (): StudioState => ({
  index: { p1: { id: 'p1', name: 'A', createdAt: 1, updatedAt: 1, phase: 'import', thumbnailUrl: null } },
  working: { p1: freshWorkingState() },
  activeProjectId: 'p1',
})

const initial = withOneProject()
const boom = { sceneId: 's1', stepId: 'assemble' as const, message: 'boom' }

describe('autoBuild reducers', () => {
  it('defaults to idle with an empty active set', () => {
    expect(initial.working.p1.autoBuild).toEqual({ status: 'idle', active: [], halt: null })
  })

  it('start → running and clears any prior halt', () => {
    const halted = reducer(initial, haltAutoBuild(boom))
    const s = reducer(halted, startAutoBuild())
    expect(s.working.p1.autoBuild.status).toBe('running')
    expect(s.working.p1.autoBuild.halt).toBeNull()
  })

  it('pause only from running', () => {
    const running = reducer(initial, startAutoBuild())
    expect(reducer(running, pauseAutoBuild()).working.p1.autoBuild.status).toBe('paused')
    expect(reducer(initial, pauseAutoBuild()).working.p1.autoBuild.status).toBe('idle')
  })

  it('resume from paused or halted → running, halt cleared', () => {
    const halted = reducer(initial, haltAutoBuild(boom))
    const r = reducer(halted, resumeAutoBuild())
    expect(r.working.p1.autoBuild.status).toBe('running')
    expect(r.working.p1.autoBuild.halt).toBeNull()
  })

  it('halt records the failing step', () => {
    const s = reducer(reducer(initial, startAutoBuild()), haltAutoBuild(boom))
    expect(s.working.p1.autoBuild).toMatchObject({ status: 'halted', halt: boom })
  })

  it('stop resets the run and empties the active set', () => {
    const started = reducer(initial, autoStepStarted({ sceneId: 's1', stepId: 'refine' }))
    const s = reducer(started, stopAutoBuild())
    expect(s.working.p1.autoBuild).toEqual({ status: 'idle', active: [], halt: null })
  })

  it('started/finished add and remove exactly that step', () => {
    let s = reducer(initial, autoStepStarted({ sceneId: 's1', stepId: 'assemble' }))
    s = reducer(s, autoStepStarted({ sceneId: 's2', stepId: 'refine' }))
    expect(s.working.p1.autoBuild.active).toEqual([
      { sceneId: 's1', stepId: 'assemble' },
      { sceneId: 's2', stepId: 'refine' },
    ])
    s = reducer(s, autoStepFinished({ sceneId: 's1', stepId: 'assemble' }))
    expect(s.working.p1.autoBuild.active).toEqual([{ sceneId: 's2', stepId: 'refine' }])
  })

  it('started is idempotent for the same step', () => {
    let s = reducer(initial, autoStepStarted({ sceneId: 's1', stepId: 'cut' }))
    s = reducer(s, autoStepStarted({ sceneId: 's1', stepId: 'cut' }))
    expect(s.working.p1.autoBuild.active).toHaveLength(1)
  })

  it('complete → done', () => {
    const s = reducer(reducer(initial, startAutoBuild()), completeAutoBuild())
    expect(s.working.p1.autoBuild.status).toBe('done')
  })
})
