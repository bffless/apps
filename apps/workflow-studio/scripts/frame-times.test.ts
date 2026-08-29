/**
 * `frame-times` — the `times` step of the `blog` job: `with: { markdown, sources, durations,
 * siblings? }` in, `{ captures }` out. The blog writer places `![caption](frame:<t>)` tokens
 * on the GLOBAL (concatenated) clock the director read (R135); `video/frames` seeks ONE
 * recording, so every token has to come back as `{ source, time }` LOCAL to its own
 * source. After the tokens' own frames come the Change-frame picker's candidates
 * (apps#429): Studio's ±30 s window around each token, on the finest grid that fits
 * the job's frame budget — or none, on a headless run (`siblings: false`).
 */
import { describe, expect, it } from 'vitest'
import frameTimes, { FRAME_BUDGET, planSiblingCaptures, SIBLING_STEPS, type Capture } from './frame-times'
import { fakeCtx } from './lib/fakeCtx'
import { planBlogCaptures } from 'studio/lib/blog'
import type { FileRef } from '@bffless/workflow-script'

type Out = { captures: Capture[] }

const ref = (path: string): FileRef => ({
  path, name: path.split('/').pop() ?? 'file', contentType: 'video/mp4', size: 1, url: `/api/uploads/${path}`,
})

const A = ref('workflows/run/a.mp4')
const B = ref('workflows/run/b.mp4')

/** The tokens' own captures — `frame-NN.jpg`, always first in the list. */
const own = (captures: Capture[]) => captures.filter((c) => /^frame-\d\d\.jpg$/.test(c.name))
/** The picker's candidates — Studio's `frame-t<ms>.jpg` names. */
const nearby = (captures: Capture[]) => captures.filter((c) => /^frame-t\d+\.jpg$/.test(c.name))

describe('frame-times', () => {
  it('routes each token to its own recording and its local second', async () => {
    const markdown = [
      '# Post',
      '',
      '![the diff](frame:10)',
      '',
      'Prose.',
      '',
      '![the terminal](frame:70)',
    ].join('\n')
    const { ctx } = fakeCtx({ markdown, sources: [A, B], durations: [60, 40], siblings: false })
    const out = (await frameTimes(ctx)) as Out
    // Both land on their own recording's 10th second; only `key` — the GLOBAL token
    // second (R140) — tells them apart downstream, which is what `byTime` is keyed by.
    expect(out.captures).toEqual([
      { source: A.path, time: 10, name: 'frame-01.jpg', key: '10' },
      { source: B.path, time: 10, name: 'frame-02.jpg', key: '70' },
    ])
  })

  it('captures a reused moment once, numbered in first-appearance order', async () => {
    const markdown = '![a](frame:83.5)\n\n![b](frame:5)\n\n![c](frame:83.5)'
    const { ctx } = fakeCtx({ markdown, sources: [A, B], durations: [60, 40], siblings: false })
    const out = (await frameTimes(ctx)) as Out
    expect(out.captures).toEqual([
      { source: B.path, time: 23.5, name: 'frame-01.jpg', key: '83.5' },
      { source: A.path, time: 5, name: 'frame-02.jpg', key: '5' },
    ])
  })

  it('names the source by its uploads-relative path, never its serve URL', async () => {
    const { ctx } = fakeCtx({ markdown: '![a](frame:1)', sources: [A], durations: [60], siblings: false })
    const out = (await frameTimes(ctx)) as Out
    expect(out.captures[0].source).toBe('workflows/run/a.mp4')
  })

  it('drops a malformed token rather than asking for a still at a nonsense time', async () => {
    const markdown = '![a](frame:)\n\n![b](frame:abc)\n\n![c](frame:-4)\n\n![d](frame:2)'
    const { ctx } = fakeCtx({ markdown, sources: [A], durations: [60], siblings: false })
    const out = (await frameTimes(ctx)) as Out
    expect(out.captures).toEqual([{ source: A.path, time: 2, name: 'frame-01.jpg', key: '2' }])
  })

  it('returns no captures for a post with no frame tokens', async () => {
    const { ctx } = fakeCtx({ markdown: '# Just prose', sources: [A], durations: [60] })
    expect((await frameTimes(ctx)) as Out).toEqual({ captures: [] })
  })

  it('throws a clear error when a source is not a File ref', async () => {
    const { ctx } = fakeCtx({ markdown: '![a](frame:1)', sources: ['a.mp4'], durations: [60] })
    await expect(frameTimes(ctx)).rejects.toThrow(/frame-times.*sources/i)
  })

  it('throws a clear error when `durations` does not cover the sources', async () => {
    const { ctx } = fakeCtx({ markdown: '![a](frame:1)', sources: [A, B], durations: [60] })
    await expect(frameTimes(ctx)).rejects.toThrow(/frame-times.*durations/i)
  })

  describe('nearby candidates for the Change-frame picker (apps#429)', () => {
    it('follows the tokens’ own frames, on a 5 s grid across ±30 s, keyed by global second', async () => {
      const { ctx, logs } = fakeCtx({ markdown: '![a](frame:40)', sources: [A, B], durations: [60, 40] })
      const out = (await frameTimes(ctx)) as Out

      expect(own(out.captures)).toEqual([{ source: A.path, time: 40, name: 'frame-01.jpg', key: '40' }])
      // 10 … 70 every 5 s, minus the token's own 40 — twelve candidates, ascending.
      const candidates = nearby(out.captures)
      expect(candidates.map((c) => c.key)).toEqual(
        ['10', '15', '20', '25', '30', '35', '45', '50', '55', '60', '65', '70'],
      )
      expect(out.captures.slice(0, 1)).toEqual(own(out.captures))
      // Each is routed like a token: 60 s and later belong to B, on B's own clock.
      expect(candidates.find((c) => c.key === '55')).toEqual({ source: A.path, time: 55, name: 'frame-t55000.jpg', key: '55' })
      expect(candidates.find((c) => c.key === '65')).toEqual({ source: B.path, time: 5, name: 'frame-t65000.jpg', key: '65' })
      expect(logs).toContainEqual(expect.stringMatching(/12 nearby candidate\(s\) on a 5 s grid/))
    })

    it('clamps the window to the timeline and never duplicates a token’s own second', async () => {
      const markdown = '![a](frame:5)\n\n![b](frame:15)'
      const { ctx } = fakeCtx({ markdown, sources: [A], durations: [60] })
      const out = (await frameTimes(ctx)) as Out
      const keys = out.captures.map((c) => c.key)
      expect(new Set(keys).size).toBe(keys.length)
      expect(keys.slice(0, 2)).toEqual(['5', '15'])
      // Nothing before 0 or past the recording's end; the two windows overlap and merge.
      const candidates = nearby(out.captures).map((c) => Number(c.key))
      expect(Math.min(...candidates)).toBe(0)
      expect(Math.max(...candidates)).toBeLessThan(60)
      expect(candidates).not.toContain(5)
      expect(candidates).not.toContain(15)
    })

    it('is off when the workflow says nobody will open the picker (`siblings: false`)', async () => {
      const { ctx } = fakeCtx({ markdown: '![a](frame:40)', sources: [A], durations: [120], siblings: false })
      const out = (await frameTimes(ctx)) as Out
      expect(out.captures).toHaveLength(1)
    })

    it('coarsens the grid as the token count grows, and stays under the frame budget', () => {
      const timeline = [{ id: A.path, duration: 10000 }]
      const post = (n: number) =>
        Array.from({ length: n }, (_, i) => `![f${i}](frame:${100 + i * 100})`).join('\n\n')

      const few = planSiblingCaptures(planBlogCaptures(post(9), timeline), timeline)
      expect(few.step).toBe(5)
      expect(few.captures).toHaveLength(9 * 12)

      const more = planSiblingCaptures(planBlogCaptures(post(20), timeline), timeline)
      expect(more.step).toBe(10)
      expect(20 + more.captures.length).toBeLessThanOrEqual(FRAME_BUDGET)

      const many = planSiblingCaptures(planBlogCaptures(post(60), timeline), timeline)
      expect(many.step).toBe(30)
      expect(60 + many.captures.length).toBeLessThanOrEqual(FRAME_BUDGET)

      // Past what even the coarsest grid can afford, the post gets its frames and no picker.
      const tooMany = planSiblingCaptures(planBlogCaptures(post(70), timeline), timeline)
      expect(tooMany).toEqual({ step: null, captures: [] })
      expect(SIBLING_STEPS[SIBLING_STEPS.length - 1]).toBe(30)
    })

    it('plans nothing for a post with no tokens', () => {
      expect(planSiblingCaptures([], [{ id: A.path, duration: 60 }])).toEqual({ step: null, captures: [] })
    })
  })
})
