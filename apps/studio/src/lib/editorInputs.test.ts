import { describe, it, expect } from 'vitest'
import type { Scene } from './scenes'
import type { TWord } from './transcriptGrid'
import { cutEditorInputs, type EditorSourceLike } from './editorInputs'

function scene(over: Partial<Scene> = {}): Scene {
  return {
    id: 's1',
    index: 0,
    sourceId: 'src-1',
    title: 'Scene 1',
    start: 0,
    end: 60,
    transcript: 'original transcript words',
    status: 'built',
    ...over,
  }
}

/** Timed words spaced 1s apart from `start`, one per token. */
const timed = (text: string, start = 0): TWord[] =>
  text.split(/\s+/).map((t, i) => ({ text: t, start: start + i, end: start + i + 0.5 }))

const src = (over: Partial<EditorSourceLike> & { id: string }): EditorSourceLike => ({
  order: 0,
  duration: 100,
  words: [],
  ...over,
})

/**
 * The regression fixture (apps: Build page, chapters 7–8 blank): a multi-source
 * project where scene times are LOCAL to each source, so a later source's scene
 * window lies numerically beyond the primary source's last word — and collides
 * numerically with other sources' scenes.
 */
const sources: EditorSourceLike[] = [
  src({
    id: 'src-1',
    order: 0,
    duration: 340,
    words: timed('one-a one-b one-c', 10), // primary's words end at 12.5s
    audioUrl: '/audio/one.wav',
    deadSpace: [{ start: 0, end: 5 }],
  }),
  src({
    id: 'src-2',
    order: 1,
    duration: 360,
    words: timed('two-a two-b', 20),
    audioUrl: '/audio/two.wav',
    deadSpace: [{ start: 100, end: 110 }],
  }),
  src({
    id: 'src-3',
    order: 2,
    duration: 800,
    words: timed('three-a three-b three-c', 420), // spoken well past src-1's coverage
    audioUrl: '/audio/three.wav',
    deadSpace: [{ start: 400, end: 410 }],
  }),
]

const lateScene = scene({ id: 'late', sourceId: 'src-3', start: 415, end: 610 })

describe('cutEditorInputs · words', () => {
  it('slices the SELECTED scene’s OWN source — a window beyond the primary source’s last word still has words', () => {
    const got = cutEditorInputs(sources, [lateScene], lateScene)
    expect(got.words.map((w) => w.text)).toEqual(['three-a', 'three-b', 'three-c'])
  })

  it('never reads another source’s words when windows collide numerically', () => {
    // src-1 (10–12.5s) AND src-2 (20–21.5s) both have words inside [0, 60) —
    // only the scene's own source's may show.
    const early = scene({ id: 'early', sourceId: 'src-2', start: 0, end: 60 })
    expect(cutEditorInputs(sources, [early], early).words.map((w) => w.text)).toEqual([
      'two-a',
      'two-b',
    ])
  })

  it('is empty with no selection', () => {
    expect(cutEditorInputs(sources, [lateScene], null).words).toEqual([])
  })
})

describe('cutEditorInputs · transcribed gate', () => {
  it('opens once the scene’s source has words — even when the window itself is silent', () => {
    const silentWindow = scene({ id: 'q', sourceId: 'src-2', start: 100, end: 160 })
    expect(cutEditorInputs(sources, [silentWindow], silentWindow).transcribed).toBe(true)
  })

  it('stays closed when the scene’s source has no words, whatever the others have', () => {
    const mute = [...sources, src({ id: 'src-4', order: 3, duration: 50, words: [] })]
    const s = scene({ id: 'm', sourceId: 'src-4', start: 0, end: 50 })
    expect(cutEditorInputs(mute, [s], s).transcribed).toBe(false)
  })

  it('stays closed with no selection or an unknown source', () => {
    expect(cutEditorInputs(sources, [], null).transcribed).toBe(false)
    const orphan = scene({ id: 'o', sourceId: 'gone' })
    expect(cutEditorInputs(sources, [orphan], orphan).transcribed).toBe(false)
  })
})

describe('cutEditorInputs · audio + dead space', () => {
  it('hands over the selected scene’s source audio and silence map', () => {
    const got = cutEditorInputs(sources, [lateScene], lateScene)
    expect(got.originalAudioUrl).toBe('/audio/three.wav')
    expect(got.deadSpace).toEqual([{ start: 400, end: 410 }])
  })

  it('is undefined with no selection / a source that never measured', () => {
    expect(cutEditorInputs(sources, [], null).originalAudioUrl).toBeUndefined()
    const bare = [src({ id: 'src-5', duration: 10, words: timed('hi') })]
    const s = scene({ id: 'b', sourceId: 'src-5', start: 0, end: 10 })
    const got = cutEditorInputs(bare, [s], s)
    expect(got.originalAudioUrl).toBeUndefined()
    expect(got.deadSpace).toBeUndefined()
  })
})

describe('cutEditorInputs · whole-project readout (duration + projectCuts)', () => {
  it('duration is ALL footage, not the primary source', () => {
    expect(cutEditorInputs(sources, [], null).duration).toBe(1500)
  })

  it('offsets each scene’s cuts onto the global timeline so same-numbered spans on different sources stay distinct', () => {
    const scenes = [
      scene({ id: 'a', sourceId: 'src-1', start: 0, end: 60, refined: { cuts: [{ start: 10, end: 20 }], source: 'ai' } }),
      scene({ id: 'b', sourceId: 'src-2', start: 0, end: 60, refined: { cuts: [{ start: 10, end: 20 }], source: 'ai' } }),
    ]
    // src-2 sits at [340, 700) on the global timeline.
    expect(cutEditorInputs(sources, scenes, null).projectCuts).toEqual([
      { start: 10, end: 20 },
      { start: 350, end: 360 },
    ])
  })

  it('offsets follow source `order`, not array position', () => {
    const shuffled = [sources[2], sources[0], sources[1]]
    const s = scene({ id: 'c', sourceId: 'src-3', start: 0, end: 60, refined: { cuts: [{ start: 0, end: 5 }], source: 'ai' } })
    // src-3 still starts at 340 + 360 = 700 globally.
    expect(cutEditorInputs(shuffled, [s], null).projectCuts).toEqual([{ start: 700, end: 705 }])
  })

  it('a scene with an unknown source keeps its cuts un-offset rather than dropping them', () => {
    const s = scene({ id: 'd', sourceId: 'gone', start: 0, end: 60, refined: { cuts: [{ start: 1, end: 2 }], source: 'ai' } })
    expect(cutEditorInputs(sources, [s], null).projectCuts).toEqual([{ start: 1, end: 2 }])
  })
})
