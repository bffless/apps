import { describe, it, expect } from 'vitest'
import reducer, {
  startAutoBuild,
  pauseAutoBuild,
  resumeAutoBuild,
  stopAutoBuild,
  haltAutoBuild,
  completeAutoBuild,
  setAutoPointer,
  freshWorkingState,
  type StudioState,
} from './studioSlice'

// The autoBuild reducers act on the ACTIVE project's working state (story 11a),
// so every case runs against a root with one project active and asserts on
// `working.p1.autoBuild` instead of the old top-level `autoBuild`.
const withOneProject = (): StudioState => ({
  index: { p1: { id: 'p1', name: 'A', createdAt: 1, updatedAt: 1, phase: 'import', thumbnailUrl: null } },
  working: { p1: freshWorkingState() },
  activeProjectId: 'p1',
  savedVoices: [],
})

const initial = withOneProject()

describe('autoBuild reducers', () => {
  it('defaults to idle', () => {
    expect(initial.working.p1.autoBuild).toEqual({ status: 'idle', currentSceneId: null, currentStepId: null, error: null })
  })

  it('start → running and clears any prior error', () => {
    const halted = reducer(initial, haltAutoBuild('boom'))
    const s = reducer(halted, startAutoBuild())
    expect(s.working.p1.autoBuild.status).toBe('running')
    expect(s.working.p1.autoBuild.error).toBeNull()
  })

  it('pause only from running', () => {
    const running = reducer(initial, startAutoBuild())
    expect(reducer(running, pauseAutoBuild()).working.p1.autoBuild.status).toBe('paused')
    expect(reducer(initial, pauseAutoBuild()).working.p1.autoBuild.status).toBe('idle')
  })

  it('resume from paused or halted → running, error cleared', () => {
    const halted = reducer(initial, haltAutoBuild('boom'))
    const r = reducer(halted, resumeAutoBuild())
    expect(r.working.p1.autoBuild.status).toBe('running')
    expect(r.working.p1.autoBuild.error).toBeNull()
  })

  it('halt records the message', () => {
    const s = reducer(reducer(initial, startAutoBuild()), haltAutoBuild('REPLICATE_NOT_CONFIGURED'))
    expect(s.working.p1.autoBuild).toMatchObject({ status: 'halted', error: 'REPLICATE_NOT_CONFIGURED' })
  })

  it('stop resets the pointer', () => {
    const moved = reducer(initial, setAutoPointer({ sceneId: 's1', stepId: 'refine' }))
    const s = reducer(moved, stopAutoBuild())
    expect(s.working.p1.autoBuild).toEqual({ status: 'idle', currentSceneId: null, currentStepId: null, error: null })
  })

  it('setAutoPointer moves the pointer', () => {
    const s = reducer(initial, setAutoPointer({ sceneId: 's2', stepId: 'voice' }))
    expect(s.working.p1.autoBuild).toMatchObject({ currentSceneId: 's2', currentStepId: 'voice' })
  })

  it('complete → done', () => {
    const s = reducer(reducer(initial, startAutoBuild()), completeAutoBuild())
    expect(s.working.p1.autoBuild.status).toBe('done')
  })
})
