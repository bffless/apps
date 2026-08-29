/**
 * `sheet-plan` — the `plan` step of the `per-video` job (`.bffless/workflows/studio.workflow.yaml`):
 * `with: { duration }` in, `{ times, labels, interval }` out. It is the one script
 * that exists only because the workflow needs it (R116): Studio computed the
 * contact-sheet plan inline in the browser, the workflow has to hand `times` +
 * `labels` to the `video/contact-sheet` pipeline as data.
 */
import { describe, expect, it } from 'vitest'
import sheetPlan from './sheet-plan'
import { fakeCtx } from './lib/fakeCtx'
import { MAX_FRAMES, planContactSheet, clockLabel } from 'studio/lib/contactSheet'

describe('sheet-plan', () => {
  it('plans a 60s clip exactly as Studio does, with a burn-in label per time', async () => {
    const { ctx } = fakeCtx({ duration: 60 })
    const out = (await sheetPlan(ctx)) as { times: number[]; labels: string[]; interval: number }

    const plan = planContactSheet(60)
    expect(out.times).toEqual(plan.times)
    expect(out.interval).toBe(plan.interval)
    expect(out.interval).toBe(5)
    expect(out.labels).toEqual(plan.times.map(clockLabel))
    expect(out.labels[0]).toBe('0:02')
    expect(out.labels).toHaveLength(out.times.length)
  })

  it('keeps every time inside the recording, so no still is asked for past the end (R126)', async () => {
    const { ctx } = fakeCtx({ duration: 60 })
    const out = (await sheetPlan(ctx)) as { times: number[] }
    for (const t of out.times) {
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThanOrEqual(60 - 0.05)
    }
  })

  it('never exceeds the frame budget, however long the recording', async () => {
    const { ctx } = fakeCtx({ duration: 6 * 60 * 60 })
    const out = (await sheetPlan(ctx)) as { times: number[]; labels: string[] }
    expect(out.times.length).toBe(MAX_FRAMES)
    // Past an hour the burned-in clock promotes to `h:mm:ss`, so the director can
    // still read a moment off a late frame.
    expect(out.labels[0]).toBe('1:30')
    expect(out.labels[out.labels.length - 1]).toMatch(/^\d+:\d\d:\d\d$/)
  })

  it('warns and plans nothing when the transcript found no spoken audio', async () => {
    const { ctx, annotations } = fakeCtx({ duration: 0 })
    const out = await sheetPlan(ctx)
    expect(out).toEqual({ times: [], labels: [], interval: 0 })
    expect(annotations).toEqual([
      { level: 'warning', message: expect.stringContaining('no spoken audio') },
    ])
  })

  it('warns and plans nothing for a non-finite duration', async () => {
    const { ctx, annotations } = fakeCtx({ duration: Number.NaN })
    expect(await sheetPlan(ctx)).toEqual({ times: [], labels: [], interval: 0 })
    expect(annotations).toHaveLength(1)
  })

  it('throws a clear error when `duration` is not a number at all', async () => {
    const { ctx } = fakeCtx({ duration: '60' })
    await expect(sheetPlan(ctx)).rejects.toThrow(/sheet-plan.*duration.*number/i)
  })
})
