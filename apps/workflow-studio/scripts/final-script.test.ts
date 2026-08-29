/**
 * `final-script` — the `script` step of the `stitch` job: `with: { scenes, keep, words }`
 * in, `{ script, chapters }` out. `keep` is what the cut editor (or the headless
 * auto-keep) settled on per scene, in CLIP-relative seconds; `words` is each
 * scene's `scene_words` from `scene-inputs`. Both arrive in `scenes` order.
 */
import { describe, expect, it } from 'vitest'
import finalScript from './final-script'
import { fakeCtx } from './lib/fakeCtx'
import type { TWord } from 'studio/lib/transcriptGrid'

type Out = { script: string; chapters: string }

const word = (text: string, start: number, end: number): TWord => ({ text, start, end })

const row = (n: number, title: string, start: number, end: number) => ({
  number: n, title, brief: '', source: `workflows/x/s${n}.mp4`, sourceIndex: n - 1,
  start, end, spans: [{ start, end }], cuts: [],
})

describe('final-script', () => {
  it('keeps only the words inside the kept spans, a blank line between scenes', async () => {
    const scenes = [row(1, 'One', 0, 30), row(2, 'Two', 0, 30)]
    const keep = [[{ start: 0, end: 10 }], [{ start: 0, end: 20 }]]
    const words = [
      [word('hello', 1, 2), word('dropped', 20, 21)],
      [word('world', 5, 6), word('gone', 25, 26)],
    ]
    const { ctx } = fakeCtx({ scenes, keep, words })
    const out = (await finalScript(ctx)) as Out
    expect(out.script).toBe('hello\n\nworld')
  })

  it('maps clip-relative keep spans back to source time before cutting the words', async () => {
    // Scene 2 starts at 40s of ITS source: keeping clip seconds [0,10) keeps source
    // [40,50). A word at 45s survives; one at 55s does not.
    const scenes = [row(1, 'One', 40, 70)]
    const keep = [[{ start: 0, end: 10 }]]
    const words = [[word('kept', 45, 45.5), word('cut', 55, 55.5)]]
    const { ctx } = fakeCtx({ scenes, keep, words })
    expect(((await finalScript(ctx)) as Out).script).toBe('kept')
  })

  it('numbers chapters off the cumulative kept duration, not the source times', async () => {
    const scenes = [row(1, 'One', 0, 30), row(2, 'Two', 0, 30), row(3, 'Three', 0, 30)]
    const keep = [
      [{ start: 0, end: 10 }],
      [{ start: 0, end: 20 }],
      [{ start: 0, end: 5 }, { start: 10, end: 15 }],
    ]
    const words = [[], [], []]
    const { ctx } = fakeCtx({ scenes, keep, words })
    const out = (await finalScript(ctx)) as Out
    expect(out.chapters).toBe('0:00 One\n0:10 Two\n0:30 Three')
  })

  it('falls back to a scene transcript when the scene has no timed words', async () => {
    const scenes = [{ ...row(1, 'One', 0, 30), transcript: 'the words the AI heard' }]
    const { ctx } = fakeCtx({ scenes, keep: [[{ start: 0, end: 30 }]], words: [[]] })
    expect(((await finalScript(ctx)) as Out).script).toBe('the words the AI heard')
  })

  it('keeps everything when a scene was kept whole', async () => {
    const scenes = [row(1, 'One', 0, 30)]
    const words = [[word('a', 1, 2), word('b', 29, 29.5)]]
    const { ctx } = fakeCtx({ scenes, keep: [[{ start: 0, end: 30 }]], words })
    const out = (await finalScript(ctx)) as Out
    expect(out.script).toBe('a b')
    expect(out.chapters).toBe('0:00 One')
  })

  it('treats a scene with no kept spans as fully cut', async () => {
    const scenes = [row(1, 'One', 0, 30), row(2, 'Two', 0, 30)]
    const words = [[word('gone', 5, 6)], [word('here', 5, 6)]]
    const { ctx } = fakeCtx({ scenes, keep: [[], [{ start: 0, end: 30 }]], words })
    const out = (await finalScript(ctx)) as Out
    expect(out.script).toBe('here')
    expect(out.chapters).toBe('0:00 One\n0:00 Two')
  })

  it('throws a clear error when `keep` is not a list', async () => {
    const { ctx } = fakeCtx({ scenes: [row(1, 'One', 0, 30)], keep: {}, words: [[]] })
    await expect(finalScript(ctx)).rejects.toThrow(/final-script.*keep/i)
  })
})
