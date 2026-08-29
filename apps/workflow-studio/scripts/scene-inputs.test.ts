/**
 * `scene-inputs` — the `inputs` step of the `per-scene` job: `with: { scene, words, scenes }`
 * in, `{ word_timings, previous_context, scene_words }` out (R130 names). It is the
 * bridge between the director's scene rows and the `refine-scene` pipeline: Studio
 * derived all three in the browser off its store, the workflow has to derive them
 * from the matrix row plus the source's word list.
 */
import { describe, expect, it } from 'vitest'
import sceneInputs from './scene-inputs'
import { fakeCtx } from './lib/fakeCtx'
import { sceneWordTimings } from 'studio/lib/refiner'
import type { TWord } from 'studio/lib/transcriptGrid'

type Out = { word_timings: string; previous_context: string; scene_words: TWord[] }

const word = (text: string, start: number, end: number): TWord => ({ text, start, end })

/** Source A: one word per second for 30s, "a0".."a29". */
const wordsA: TWord[] = Array.from({ length: 30 }, (_, i) => word(`a${i}`, i, i + 0.5))
/** Source B: one word per second for 20s, "b0".."b19". */
const wordsB: TWord[] = Array.from({ length: 20 }, (_, i) => word(`b${i}`, i, i + 0.5))

const rowA1 = {
  number: 1, title: 'Opening', brief: '', source: 'workflows/x/a.mp4', sourceIndex: 0,
  start: 0, end: 10, spans: [{ start: 0, end: 10 }], cuts: [],
}
const rowA2 = {
  number: 2, title: 'Middle', brief: '', source: 'workflows/x/a.mp4', sourceIndex: 0,
  start: 10, end: 30, spans: [{ start: 10, end: 30 }], cuts: [],
}
const rowB3 = {
  number: 3, title: 'Second take', brief: '', source: 'workflows/x/b.mp4', sourceIndex: 1,
  start: 0, end: 20, spans: [{ start: 0, end: 20 }], cuts: [],
}

describe('scene-inputs', () => {
  it('slices the scene window by word midpoint and formats it as Studio does', async () => {
    const { ctx } = fakeCtx({ scene: rowA2, words: wordsA, scenes: [rowA1, rowA2, rowB3] })
    const out = (await sceneInputs(ctx)) as Out

    expect(out.scene_words.map((w) => w.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `a${i + 10}`),
    )
    expect(out.word_timings).toBe(sceneWordTimings(out.scene_words))
    expect(out.word_timings.split('\n')[0]).toBe('10.00 10.50 a10')
  })

  it('carries the previous scene tail forward when both scenes share a source', async () => {
    const { ctx } = fakeCtx({ scene: rowA2, words: wordsA, scenes: [rowA1, rowA2, rowB3] })
    const out = (await sceneInputs(ctx)) as Out
    // Scene 1 is `a0`..`a9`, uncut — its tail is the whole thing (under the 30-word cap).
    expect(out.previous_context).toBe('a0 a1 a2 a3 a4 a5 a6 a7 a8 a9')
  })

  it('honours the previous scene cuts — a cut word is never in the lead-in', async () => {
    const cut = { ...rowA1, cuts: [{ start: 0, end: 8 }] }
    const { ctx } = fakeCtx({ scene: rowA2, words: wordsA, scenes: [cut, rowA2] })
    const out = (await sceneInputs(ctx)) as Out
    expect(out.previous_context).toBe('a8 a9')
  })

  it('falls back to the previous row transcript across a source boundary', async () => {
    // Scene 3 opens a DIFFERENT recording, so this job has no word list for scene 2 —
    // `sceneTail` degrades to the row's own transcript.
    const prev = { ...rowA2, transcript: 'and that wraps the first take' }
    const { ctx } = fakeCtx({ scene: rowB3, words: wordsB, scenes: [rowA1, prev, rowB3] })
    const out = (await sceneInputs(ctx)) as Out
    expect(out.previous_context).toBe('and that wraps the first take')
    expect(out.scene_words.map((w) => w.text)).toEqual(wordsB.map((w) => w.text))
  })

  it('gives an empty lead-in across a source boundary with no transcript on the row', async () => {
    const { ctx } = fakeCtx({ scene: rowB3, words: wordsB, scenes: [rowA1, rowA2, rowB3] })
    expect(((await sceneInputs(ctx)) as Out).previous_context).toBe('')
  })

  it('gives an empty lead-in for the first scene', async () => {
    const { ctx } = fakeCtx({ scene: rowA1, words: wordsA, scenes: [rowA1, rowA2] })
    const out = (await sceneInputs(ctx)) as Out
    expect(out.previous_context).toBe('')
    expect(out.scene_words).toHaveLength(10)
  })

  it('throws a clear error when `scene` is not a scene row', async () => {
    const { ctx } = fakeCtx({ scene: null, words: wordsA, scenes: [rowA1] })
    await expect(sceneInputs(ctx)).rejects.toThrow(/scene-inputs.*scene/i)
  })

  it('throws a clear error when `words` is not a list', async () => {
    const { ctx } = fakeCtx({ scene: rowA1, words: 'nope', scenes: [rowA1] })
    await expect(sceneInputs(ctx)).rejects.toThrow(/scene-inputs.*words/i)
  })
})
