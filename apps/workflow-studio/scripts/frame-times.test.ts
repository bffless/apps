/**
 * `frame-times` — the `times` step of the `blog` job: `with: { markdown, sources, durations }`
 * in, `{ captures }` out. The blog writer places `![caption](frame:<t>)` tokens on the
 * GLOBAL (concatenated) clock the director read (R135); `video/frames` seeks ONE
 * recording, so every token has to come back as `{ source, time }` LOCAL to its own
 * source.
 */
import { describe, expect, it } from 'vitest'
import frameTimes from './frame-times'
import { fakeCtx } from './lib/fakeCtx'
import type { FileRef } from '@bffless/workflow-script'

type Capture = { source: string; time: number; name: string; key: string }
type Out = { captures: Capture[] }

const ref = (path: string): FileRef => ({
  path, name: path.split('/').pop() ?? 'file', contentType: 'video/mp4', size: 1, url: `/api/uploads/${path}`,
})

const A = ref('workflows/run/a.mp4')
const B = ref('workflows/run/b.mp4')

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
    const { ctx } = fakeCtx({ markdown, sources: [A, B], durations: [60, 40] })
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
    const { ctx } = fakeCtx({ markdown, sources: [A, B], durations: [60, 40] })
    const out = (await frameTimes(ctx)) as Out
    expect(out.captures).toEqual([
      { source: B.path, time: 23.5, name: 'frame-01.jpg', key: '83.5' },
      { source: A.path, time: 5, name: 'frame-02.jpg', key: '5' },
    ])
  })

  it('names the source by its uploads-relative path, never its serve URL', async () => {
    const { ctx } = fakeCtx({ markdown: '![a](frame:1)', sources: [A], durations: [60] })
    const out = (await frameTimes(ctx)) as Out
    expect(out.captures[0].source).toBe('workflows/run/a.mp4')
  })

  it('drops a malformed token rather than asking for a still at a nonsense time', async () => {
    const markdown = '![a](frame:)\n\n![b](frame:abc)\n\n![c](frame:-4)\n\n![d](frame:2)'
    const { ctx } = fakeCtx({ markdown, sources: [A], durations: [60] })
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
})
