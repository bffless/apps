import { describe, it, expect } from 'vitest'
import type { Scene } from './scenes'
import type { ContactSheet } from './frames'
import {
  AUTO_STEPS,
  STALE_RENDER_PATCH,
  nextStep,
  nextActions,
  STEP_LANE,
  isSceneComplete,
  sceneStepStatuses,
  sceneRunStatus,
  isHaltStale,
  assembleInputsKey,
  ffmpegLaneCapacity,
  laneCapsFor,
  DEFAULT_LANE_CAPS,
  REMOTE_FFMPEG_MAX,
  type AutoBuildRun,
  type AutoHalt,
  type ActiveStep,
} from './autoBuild'

const idle: AutoBuildRun = { status: 'idle', active: [], halt: null }

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
    expect(nextActions([edited], [])).toEqual([{ kind: 'step', scene: edited, step: 'assemble' }])
  })

  it('leaves the editable cut layer intact so revert / re-refine still work', () => {
    const edited: Scene = { ...built(), ...STALE_RENDER_PATCH }
    // Only the rendered bytes + status are touched; the refined cuts (and the
    // director baseline they fall back to) survive untouched.
    expect(edited.refined).toEqual(built().refined)
  })
})

describe('sceneStepStatuses', () => {
  it('marks the pointed step running while the run is running', () => {
    const s = scene({ clipUrl: 'u', clipAudioUrl: 'a' }) // cut done, sheets next
    const run: AutoBuildRun = {
      status: 'running',
      active: [{ sceneId: 's1', stepId: 'sheets' }],
      halt: null,
    }
    const st = sceneStepStatuses(s, run)
    expect(st.cut).toBe('done')
    expect(st.sheets).toBe('running')
    expect(st.refine).toBe('pending')
  })

  it('marks the pointed step error while halted', () => {
    const s = scene({ clipUrl: 'u', clipAudioUrl: 'a' })
    const run: AutoBuildRun = {
      status: 'halted',
      active: [],
      halt: { sceneId: 's1', stepId: 'sheets', message: 'boom' },
    }
    expect(sceneStepStatuses(s, run).sheets).toBe('error')
  })
})

describe('sceneRunStatus', () => {
  it('reports built / running / error / pending', () => {
    expect(sceneRunStatus(scene({ status: 'built' }), idle)).toBe('built')
    expect(
      sceneRunStatus(scene({ id: 'x' }), {
        status: 'running',
        active: [{ sceneId: 'x', stepId: 'cut' }],
        halt: null,
      }),
    ).toBe('running')
    expect(
      sceneRunStatus(scene({ id: 'x' }), {
        status: 'halted',
        active: [],
        halt: { sceneId: 'x', stepId: 'cut', message: 'e' },
      }),
    ).toBe('error')
    expect(sceneRunStatus(scene({ id: 'x' }), idle)).toBe('pending')
  })

  it('marks both scenes running when both have active steps', () => {
    const run: AutoBuildRun = {
      status: 'running',
      active: [{ sceneId: 's1', stepId: 'assemble' }, { sceneId: 's2', stepId: 'refine' }],
      halt: null,
    }
    expect(sceneRunStatus(scene({ id: 's1' }), run)).toBe('running')
    expect(sceneRunStatus(scene({ id: 's2' }), run)).toBe('running')
    expect(sceneRunStatus(scene({ id: 's3' }), run)).toBe('pending')
  })
})

describe('isHaltStale', () => {
  const halted = (over: Partial<AutoHalt> = {}): AutoBuildRun => ({
    status: 'halted',
    active: [],
    halt: { sceneId: 's1', stepId: 'assemble', message: 'Failed to fetch', ...over },
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
    expect(isHaltStale([scene({ status: 'built' })], halted({ stepId: 'cut' }), null)).toBe(true)
  })

  it('is true once a halted final stitch has a saved final cut', () => {
    const run = halted({ sceneId: null, stepId: 'stitch' })
    expect(isHaltStale([scene()], run, null)).toBe(false)
    expect(isHaltStale([scene()], run, 'final.mp4')).toBe(true)
  })

  it('is false for any run that is not halted', () => {
    const saved = scene({ assembledUrl: 'saved.mp4', status: 'built' })
    const runPaused: AutoBuildRun = { ...halted(), status: 'paused' }
    const runRunning: AutoBuildRun = { ...halted(), status: 'running' }
    expect(isHaltStale([saved], runPaused, null)).toBe(false)
    expect(isHaltStale([saved], runRunning, null)).toBe(false)
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

describe('nextActions (lane scheduler)', () => {
  // Scenes staged at a given step, built with the same fields nextStep derives from.
  const atCut = (id: string, index: number) => scene({ id, index })
  const atSheets = (id: string, index: number) =>
    scene({ id, index, clipUrl: 'c', clipAudioUrl: 'a' })
  const atRefine = (id: string, index: number) =>
    scene({ id, index, clipUrl: 'c', clipAudioUrl: 'a', sheets: [{} as ContactSheet] })
  const atAssemble = (id: string, index: number) =>
    scene({
      id, index, clipUrl: 'c', clipAudioUrl: 'a', sheets: [{} as ContactSheet],
      refined: { cuts: [{ start: 1, end: 2 }], source: 'ai' },
    })
  const complete = (id: string, index: number) =>
    scene({
      id, index, clipUrl: 'c', clipAudioUrl: 'a', sheets: [{} as ContactSheet],
      refined: { cuts: [], source: 'ai' }, assembledUrl: 'done',
    })
  const built = (id: string, index: number) => ({ ...complete(id, index), status: 'built' as const })

  const stepsOf = (actions: ReturnType<typeof nextActions>) =>
    actions.filter((a) => a.kind === 'step').map((a) => `${a.scene.id}:${a.step}`)

  it('maps cut+assemble to the ffmpeg lane, refine and sheets to their own', () => {
    expect(STEP_LANE).toEqual({ cut: 'ffmpeg', assemble: 'ffmpeg', refine: 'refine', sheets: 'sheets' })
  })

  it('offers only one ffmpeg step: assemble of the earlier scene wins over cut of a later one', () => {
    const actions = nextActions([atAssemble('s1', 0), atCut('s2', 1)], [])
    expect(stepsOf(actions)).toEqual(['s1:assemble'])
  })

  it('overlaps the three lanes across scenes', () => {
    const actions = nextActions([atAssemble('s1', 0), atRefine('s2', 1), atSheets('s3', 2)], [])
    // s2 refine is allowed: the only earlier scene (s1) already has `refined`.
    expect(stepsOf(actions)).toEqual(['s1:assemble', 's2:refine', 's3:sheets'])
  })

  it('blocks a lane already in flight', () => {
    const inFlight: ActiveStep[] = [{ sceneId: 's1', stepId: 'assemble' }]
    const actions = nextActions([atAssemble('s1', 0), atCut('s2', 1), atSheets('s3', 2)], inFlight)
    // s2's cut needs the busy ffmpeg lane; s3's sheets lane is free.
    expect(stepsOf(actions)).toEqual(['s3:sheets'])
  })

  it('never offers a second step on a scene that already has one in flight', () => {
    const inFlight: ActiveStep[] = [{ sceneId: 's1', stepId: 'sheets' }]
    const actions = nextActions([atSheets('s1', 0)], inFlight)
    expect(actions).toEqual([])
  })

  it('holds scene N refine until every earlier scene is refined or built (seam order, 03r)', () => {
    // s1 is only at cut — its refine hasn't happened, so s2 must wait even
    // though the refine lane is free.
    const actions = nextActions([atCut('s1', 0), atRefine('s2', 1)], [])
    expect(stepsOf(actions)).toEqual(['s1:cut'])
    // Once s1 is built, s2's refine unblocks.
    const after = nextActions([built('s1', 0), atRefine('s2', 1)], [])
    expect(stepsOf(after)).toEqual(['s2:refine'])
  })

  it('emits markBuilt for a complete-but-pending scene', () => {
    const actions = nextActions([complete('s1', 0)], [])
    expect(actions).toEqual([{ kind: 'markBuilt', scene: expect.objectContaining({ id: 's1' }) }])
  })

  it('emits stitch only when all scenes are built AND nothing is in flight', () => {
    expect(nextActions([built('s1', 0)], [])).toEqual([{ kind: 'stitch' }])
    expect(nextActions([built('s1', 0)], [{ sceneId: null, stepId: 'stitch' }])).toEqual([])
    expect(nextActions([built('s1', 0), atAssemble('s2', 1)], [{ sceneId: 's2', stepId: 'assemble' }])).toEqual([])
  })

  it('skips built scenes entirely', () => {
    const actions = nextActions([built('s1', 0), atCut('s2', 1)], [])
    expect(stepsOf(actions)).toEqual(['s2:cut'])
  })
})

describe('ffmpegLaneCapacity / laneCapsFor', () => {
  it('is 1 for wasm (null executor) and local', () => {
    expect(ffmpegLaneCapacity(null, 12)).toBe(1)
    expect(ffmpegLaneCapacity('local', 12)).toBe(1)
  })
  it('is min(8, scenes) for remote', () => {
    expect(ffmpegLaneCapacity('remote', 3)).toBe(3)
    expect(ffmpegLaneCapacity('remote', 12)).toBe(REMOTE_FFMPEG_MAX)
    expect(ffmpegLaneCapacity('remote', 0)).toBe(1) // never zero — a lone stitch/assemble must still run
  })
  it('leaves refine and sheets at 1', () => {
    expect(laneCapsFor('remote', 5)).toEqual({ ffmpeg: 5, refine: 1, sheets: 1 })
    expect(laneCapsFor(null, 5)).toEqual(DEFAULT_LANE_CAPS)
  })
})

describe('nextActions with a wider ffmpeg lane', () => {
  // Bare scenes: every one is on `cut` (ffmpeg lane).
  const bare = (id: string, index: number): Scene => ({
    id, index, sourceId: 'src', title: id, start: index * 10, end: index * 10 + 10, transcript: '', status: 'pending',
  })
  const scenes = [bare('a', 0), bare('b', 1), bare('c', 2), bare('d', 3)]

  it('cap 1 (default) still admits exactly one ffmpeg step', () => {
    const steps = nextActions(scenes, []).filter((a) => a.kind === 'step')
    expect(steps.map((a) => a.kind === 'step' && a.scene.id)).toEqual(['a'])
  })
  it('cap 3 admits three cuts across scenes and holds the fourth', () => {
    const caps = { ffmpeg: 3, refine: 1, sheets: 1 }
    const steps = nextActions(scenes, [], caps).filter((a) => a.kind === 'step')
    expect(steps.map((a) => a.kind === 'step' && a.scene.id)).toEqual(['a', 'b', 'c'])
  })
  it('counts in-flight ffmpeg steps against the cap', () => {
    const caps = { ffmpeg: 3, refine: 1, sheets: 1 }
    const inFlight = [{ sceneId: 'a', stepId: 'cut' as const }, { sceneId: 'b', stepId: 'cut' as const }]
    const steps = nextActions(scenes, inFlight, caps).filter((a) => a.kind === 'step')
    expect(steps.map((a) => a.kind === 'step' && a.scene.id)).toEqual(['c'])
  })
  it('cap min(8, scenes) admits every scene when there are fewer than 8', () => {
    const steps = nextActions(scenes, [], laneCapsFor('remote', scenes.length)).filter((a) => a.kind === 'step')
    expect(steps).toHaveLength(4)
  })
  it('a wider ffmpeg lane never widens refine or sheets', () => {
    // two scenes both on `sheets` (cut done): only one sheets step is admitted
    const cut = (s: Scene): Scene => ({ ...s, clipUrl: 'c.mp4', clipAudioUrl: 'c.wav' })
    const twoOnSheets = [cut(bare('a', 0)), cut(bare('b', 1))]
    const steps = nextActions(twoOnSheets, [], laneCapsFor('remote', 2)).filter((a) => a.kind === 'step')
    expect(steps.map((a) => a.kind === 'step' && a.step)).toEqual(['sheets'])
  })
})
