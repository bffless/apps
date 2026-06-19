import { describe, it, expect } from 'vitest'
import type { Scene } from './scenes'
import type { ContactSheet } from './frames'
import {
  AUTO_STEPS,
  nextStep,
  nextAction,
  isSceneComplete,
  voiceProgress,
  sceneStepStatuses,
  sceneRunStatus,
  type AutoBuildRun,
} from './autoBuild'

const idle: AutoBuildRun = { status: 'idle', currentSceneId: null, currentStepId: null, error: null }

function scene(over: Partial<Scene> = {}): Scene {
  return {
    id: 's1',
    index: 0,
    sourceId: 'source-1',
    title: 'Scene 1',
    start: 0,
    end: 10,
    transcript: 'hello world',
    status: 'pending',
    narrationSeconds: null,
    ...over,
  }
}

describe('AUTO_STEPS', () => {
  it('runs cut → sheets → refine → voice → assemble', () => {
    expect(AUTO_STEPS.map((s) => s.id)).toEqual(['cut', 'sheets', 'refine', 'voice', 'assemble'])
  })
})

describe('nextStep', () => {
  it('starts at cut on a bare scene', () => {
    expect(nextStep(scene())).toBe('cut')
  })

  it('moves to sheets once the scene is cut', () => {
    expect(nextStep(scene({ clipUrl: 'u', clipAudioUrl: 'a' }))).toBe('sheets')
  })

  it('moves to refine once cut + sheeted', () => {
    expect(nextStep(scene({ clipUrl: 'u', clipAudioUrl: 'a', sheets: [{} as ContactSheet] }))).toBe(
      'refine',
    )
  })

  it('moves to voice once refined, while a segment is unvoiced', () => {
    const s = scene({
      clipUrl: 'u',
      clipAudioUrl: 'a',
      sheets: [{} as ContactSheet],
      refined: { segments: [{ text: 'hi', start: 0, end: 1 }], cuts: [], source: 'ai' },
    })
    expect(nextStep(s)).toBe('voice')
  })

  it('moves to assemble once every segment is voiced', () => {
    const s = scene({
      clipUrl: 'u',
      clipAudioUrl: 'a',
      sheets: [{} as ContactSheet],
      refined: { segments: [{ text: 'hi', start: 0, end: 1, audioUrl: 'v' }], cuts: [], source: 'ai' },
    })
    expect(nextStep(s)).toBe('assemble')
  })

  it('returns null once assembled', () => {
    const s = scene({
      clipUrl: 'u',
      clipAudioUrl: 'a',
      sheets: [{} as ContactSheet],
      refined: { segments: [{ text: 'hi', start: 0, end: 1, audioUrl: 'v' }], cuts: [], source: 'ai' },
      assembledUrl: 'done',
    })
    expect(nextStep(s)).toBeNull()
    expect(isSceneComplete(s)).toBe(true)
  })

  it('treats a refined scene with zero segments as voiced', () => {
    const s = scene({
      clipUrl: 'u',
      clipAudioUrl: 'a',
      sheets: [{} as ContactSheet],
      refined: { segments: [], cuts: [], source: 'ai' },
    })
    expect(nextStep(s)).toBe('assemble')
  })
})

describe('nextAction', () => {
  it('returns null when there are no scenes', () => {
    expect(nextAction([])).toBeNull()
  })

  it('skips built scenes and points at the first pending one', () => {
    const built = scene({ id: 'a', status: 'built' })
    const pending = scene({ id: 'b' })
    const r = nextAction([built, pending])
    expect(r?.scene.id).toBe('b')
    expect(r?.step).toBe('cut')
  })

  it('returns step=null for a fully-stepped but not-yet-built scene', () => {
    const done = scene({
      id: 'c',
      clipUrl: 'u',
      clipAudioUrl: 'a',
      sheets: [{} as ContactSheet],
      refined: { segments: [{ text: 'hi', start: 0, end: 1, audioUrl: 'v' }], cuts: [], source: 'ai' },
      assembledUrl: 'done',
      status: 'pending',
    })
    expect(nextAction([done])).toEqual({ scene: done, step: null })
  })

  it('returns null when every scene is built', () => {
    expect(nextAction([scene({ status: 'built' })])).toBeNull()
  })
})

describe('voiceProgress', () => {
  it('counts voiced vs total segments', () => {
    const s = scene({
      refined: {
        segments: [
          { text: 'a', start: 0, end: 1, audioUrl: 'v' },
          { text: 'b', start: 1, end: 2 },
        ],
        cuts: [],
        source: 'ai',
      },
    })
    expect(voiceProgress(s)).toEqual({ done: 1, total: 2 })
  })

  it('returns { done: 0, total: 0 } for an unrefined scene', () => {
    expect(voiceProgress(scene())).toEqual({ done: 0, total: 0 })
  })
})

describe('sceneStepStatuses', () => {
  it('marks the pointed step running while the run is running', () => {
    const s = scene({ clipUrl: 'u', clipAudioUrl: 'a' }) // cut done, sheets next
    const run: AutoBuildRun = { status: 'running', currentSceneId: 's1', currentStepId: 'sheets', error: null }
    const st = sceneStepStatuses(s, run)
    expect(st.cut).toBe('done')
    expect(st.sheets).toBe('running')
    expect(st.refine).toBe('pending')
  })

  it('marks the pointed step error while halted', () => {
    const s = scene({ clipUrl: 'u', clipAudioUrl: 'a' })
    const run: AutoBuildRun = { status: 'halted', currentSceneId: 's1', currentStepId: 'sheets', error: 'boom' }
    expect(sceneStepStatuses(s, run).sheets).toBe('error')
  })
})

describe('sceneRunStatus', () => {
  it('reports built / running / error / pending', () => {
    expect(sceneRunStatus(scene({ status: 'built' }), idle)).toBe('built')
    expect(
      sceneRunStatus(scene({ id: 'x' }), { status: 'running', currentSceneId: 'x', currentStepId: 'cut', error: null }),
    ).toBe('running')
    expect(
      sceneRunStatus(scene({ id: 'x' }), { status: 'halted', currentSceneId: 'x', currentStepId: 'cut', error: 'e' }),
    ).toBe('error')
    expect(sceneRunStatus(scene({ id: 'x' }), idle)).toBe('pending')
  })
})
