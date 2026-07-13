import { describe, it, expect } from 'vitest'
import type { Scene } from './scenes'
import type { ContactSheet } from './frames'
import {
  AUTO_STEPS,
  STALE_RENDER_PATCH,
  nextStep,
  nextAction,
  isSceneComplete,
  sceneStepStatuses,
  sceneRunStatus,
  isHaltStale,
  assembleInputsKey,
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
    ...over,
  }
}

describe('AUTO_STEPS', () => {
  it('runs cut → sheets → refine → assemble', () => {
    expect(AUTO_STEPS.map((s) => s.id)).toEqual(['cut', 'sheets', 'refine', 'assemble'])
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

  it('moves to assemble once refined', () => {
    const s = scene({
      clipUrl: 'u',
      clipAudioUrl: 'a',
      sheets: [{} as ContactSheet],
      refined: { cuts: [{ start: 2, end: 4 }], source: 'ai' },
    })
    expect(nextStep(s)).toBe('assemble')
  })

  it('returns null once assembled', () => {
    const s = scene({
      clipUrl: 'u',
      clipAudioUrl: 'a',
      sheets: [{} as ContactSheet],
      refined: { cuts: [], source: 'ai' },
      assembledUrl: 'done',
    })
    expect(nextStep(s)).toBeNull()
    expect(isSceneComplete(s)).toBe(true)
  })
})

describe('STALE_RENDER_PATCH', () => {
  // A scene that's been fully built and saved — `nextStep` is null, the export
  // stitch would concat its `assembledUrl`.
  const built = () =>
    scene({
      status: 'built',
      clipUrl: 'u',
      clipAudioUrl: 'a',
      sheets: [{} as ContactSheet],
      refined: { cuts: [], source: 'ai' },
      assembledUrl: 'scene-0.mp4',
    })

  it('drops the stale render and returns the scene to pending', () => {
    const edited: Scene = {
      ...built(),
      // mimic editSceneCut: a hand-edit writes a new cut onto `refined`…
      refined: { cuts: [{ start: 2, end: 6 }], source: 'manual' },
      // …and is patched through patchSceneEdit, which stamps this on top.
      ...STALE_RENDER_PATCH,
    }
    expect(edited.assembledUrl).toBeUndefined()
    expect(edited.status).toBe('pending')
  })

  it('makes the orchestrator re-assemble the edited scene', () => {
    const edited: Scene = { ...built(), ...STALE_RENDER_PATCH }
    // The earlier steps (cut/sheets/refine) are still done, so the only step
    // the edit reopens is the render itself — not a full rebuild.
    expect(nextStep(edited)).toBe('assemble')
    expect(isSceneComplete(edited)).toBe(false)
    expect(nextAction([edited])).toEqual({ scene: edited, step: 'assemble' })
  })

  it('leaves the editable cut layer intact so revert / re-refine still work', () => {
    const edited: Scene = { ...built(), ...STALE_RENDER_PATCH }
    // Only the rendered bytes + status are touched; the refined cuts (and the
    // director baseline they fall back to) survive untouched.
    expect(edited.refined).toEqual(built().refined)
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
      refined: { cuts: [], source: 'ai' },
      assembledUrl: 'done',
      status: 'pending',
    })
    expect(nextAction([done])).toEqual({ scene: done, step: null })
  })

  it('returns null when every scene is built', () => {
    expect(nextAction([scene({ status: 'built' })])).toBeNull()
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

describe('isHaltStale', () => {
  const halted = (over: Partial<AutoBuildRun> = {}): AutoBuildRun => ({
    status: 'halted',
    currentSceneId: 's1',
    currentStepId: 'assemble',
    error: 'Failed to fetch',
    ...over,
  })

  it('is false while the halted step is still not done', () => {
    expect(isHaltStale([scene()], halted(), null)).toBe(false)
  })

  it('is true once the halted step’s durable output exists (issue #220)', () => {
    // The producer assembled + saved the scene by hand after the run halted on
    // its `assemble` step: the halt now points at work that IS done.
    const saved = scene({ assembledUrl: 'saved.mp4', status: 'built' })
    expect(isHaltStale([saved], halted(), null)).toBe(true)
  })

  it('is true when the scene was marked built by hand', () => {
    expect(isHaltStale([scene({ status: 'built' })], halted({ currentStepId: 'cut' }), null)).toBe(true)
  })

  it('is true once a halted final stitch has a saved final cut', () => {
    const run = halted({ currentSceneId: null, currentStepId: 'stitch' })
    expect(isHaltStale([scene()], run, null)).toBe(false)
    expect(isHaltStale([scene()], run, 'final.mp4')).toBe(true)
  })

  it('is false for any run that is not halted', () => {
    const saved = scene({ assembledUrl: 'saved.mp4', status: 'built' })
    expect(isHaltStale([saved], halted({ status: 'paused' }), null)).toBe(false)
    expect(isHaltStale([saved], halted({ status: 'running' }), null)).toBe(false)
  })

  it('is false when the pointed scene is gone', () => {
    expect(isHaltStale([], halted(), null)).toBe(false)
  })
})

describe('assembleInputsKey', () => {
  it('is stable for the same clip + cuts', () => {
    const s = scene({ clipUrl: 'clip.mp4', cuts: [{ start: 1, end: 2 }] })
    expect(assembleInputsKey(s)).toBe(assembleInputsKey({ ...s }))
  })

  it('changes when the cut clip is re-sliced', () => {
    const a = scene({ clipUrl: 'clip.mp4', cuts: [{ start: 1, end: 2 }] })
    const b = scene({ clipUrl: 'clip-2.mp4', cuts: [{ start: 1, end: 2 }] })
    expect(assembleInputsKey(a)).not.toBe(assembleInputsKey(b))
  })

  it('changes when the effective cuts are edited — so a cached render is dropped', () => {
    const base = scene({ clipUrl: 'clip.mp4', cuts: [{ start: 1, end: 2 }] })
    const refined = scene({
      clipUrl: 'clip.mp4',
      cuts: [{ start: 1, end: 2 }],
      refined: { cuts: [{ start: 3, end: 4 }], source: 'manual' },
    })
    expect(assembleInputsKey(base)).not.toBe(assembleInputsKey(refined))
  })
})
