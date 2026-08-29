/**
 * `sheet-plan` — the `plan` job's step (`.bffless/workflows/studio.workflow.yaml`):
 * `with: { sources, durations }` in, `{ plans }` out, one entry per recording. It is the
 * one script that exists only because the workflow needs it (R116): Studio computed the
 * contact-sheet plan inline in the browser, the workflow has to hand `times` + `labels`
 * to the `video/contact-sheet` pipeline as data.
 *
 * What the suite is really pinning down is R147 — the plan is GLOBAL. One budget across
 * every recording, LOCAL seconds to seek with, and the GLOBAL clock burned onto the
 * frame so the director's images agree with the globally-shifted transcript it reads
 * beside them.
 */
import { describe, expect, it } from 'vitest'
import sheetPlan, { type SourcePlan } from './sheet-plan'
import { fakeCtx } from './lib/fakeCtx'
import { clockLabel, planContactSheet } from 'studio/lib/contactSheet'
import { planGlobalSheetCaptures } from 'studio/lib/globalSheet'

const ref = (path: string) => ({ path, name: path.split('/').pop() })

async function plan(sources: string[], durations: number[]) {
  const { ctx, annotations, logs } = fakeCtx({ sources: sources.map(ref), durations })
  const out = (await sheetPlan(ctx)) as { plans: SourcePlan[] }
  return { plans: out.plans, annotations, logs }
}

describe('sheet-plan', () => {
  it('plans one budget across both recordings and labels them on the GLOBAL clock', async () => {
    // 13 s + 8 s = one 21 s timeline; at the 1 s floor that is 21 frames, well inside the
    // 120-frame budget, so every second of BOTH recordings is sampled.
    const { plans } = await plan(['workflows/r/a.mp4', 'workflows/r/b.mp4'], [13, 8])

    expect(plans).toHaveLength(2)
    expect(plans.map((p) => [p.source, p.sourceIndex])).toEqual([
      ['workflows/r/a.mp4', 0],
      ['workflows/r/b.mp4', 1],
    ])

    // `times` are LOCAL — what ffmpeg seeks in each file — and ascending.
    expect(plans[0].times).toEqual([...Array(13)].map((_, i) => i + 0.5))
    expect(plans[1].times).toEqual([...Array(8)].map((_, i) => i + 0.5))
    for (const p of plans) {
      expect([...p.times].sort((a, b) => a - b)).toEqual(p.times)
      expect(p.labels).toHaveLength(p.times.length)
    }

    // …but the burned-in clock is GLOBAL: the second recording starts at 0:13 on the
    // combined timeline, which is the clock `scenes`/`blog` shift its transcript onto.
    expect(plans[0].labels[0]).toBe('0:00')
    expect(plans[1].labels[0]).toBe('0:13')
    expect(plans[1].labels).toEqual(['0:13', '0:14', '0:15', '0:16', '0:17', '0:18', '0:19', '0:20'])
  })

  it('spends the ≤120-frame budget once, not once per recording', async () => {
    const { plans } = await plan(
      ['workflows/r/a.mp4', 'workflows/r/b.mp4'],
      [40 * 60, 40 * 60],
    )
    const total = plans.reduce((sum, p) => sum + p.times.length, 0)
    expect(total).toBe(120)
    // Both halves are represented — the whole point of R147. Planning per recording gave
    // each 120 frames / 10 sheets, and the consumers sign only the first 10.
    expect(plans[0].times.length).toBe(60)
    expect(plans[1].times.length).toBe(60)
    // Global again: the second recording's first frame is 40 minutes into the project,
    // and past an hour the clock promotes to `h:mm:ss` so a late frame is still readable.
    expect(plans[1].labels[0]).toBe('40:20')
    expect(plans[1].labels[plans[1].labels.length - 1]).toMatch(/^1:\d\d:\d\d$/)
  })

  it('is exactly Studio’s own planner for a single recording (1 s floor)', async () => {
    const { plans } = await plan(['workflows/r/a.mp4'], [60])
    const expected = planContactSheet(60, 1)

    expect(plans).toHaveLength(1)
    expect(plans[0].times).toEqual(expected.times)
    expect(plans[0].labels).toEqual(expected.times.map(clockLabel))
    // …and identical to routing the same global plan by hand.
    expect(plans[0].times).toEqual(
      planGlobalSheetCaptures([{ id: '0', duration: 60 }]).map((c) => c.localTime),
    )
  })

  it('keeps every time inside its own recording (R126)', async () => {
    const { plans } = await plan(['workflows/r/a.mp4', 'workflows/r/b.mp4'], [13, 8])
    for (const [i, duration] of [13, 8].entries()) {
      for (const t of plans[i].times) {
        expect(t).toBeGreaterThanOrEqual(0)
        expect(t).toBeLessThanOrEqual(duration - 0.05)
      }
    }
  })

  it('still emits an entry for a recording with no spoken audio, and says so', async () => {
    const { plans, annotations } = await plan(
      ['workflows/r/a.mp4', 'workflows/r/silent.mp4'],
      [10, 0],
    )

    // One entry PER SOURCE, always — the `sheets` matrix is indexed by `sourceIndex`.
    expect(plans).toHaveLength(2)
    expect(plans[1]).toEqual({
      source: 'workflows/r/silent.mp4',
      sourceIndex: 1,
      times: [],
      labels: [],
    })
    expect(plans[0].times.length).toBeGreaterThan(0)

    // The annotation has to be TRUE: the workflow `if:`-skips the step for this leg.
    expect(annotations).toEqual([
      {
        level: 'warning',
        message: expect.stringContaining('no spoken audio') as unknown as string,
      },
    ])
    const [note] = annotations as { message: string }[]
    expect(note.message).toContain('skipped')
    expect(note.message).toContain('workflows/r/silent.mp4')
  })

  it('plans nothing at all when no recording has any audio', async () => {
    const { plans, annotations } = await plan(['workflows/r/a.mp4'], [0])
    expect(plans).toEqual([{ source: 'workflows/r/a.mp4', sourceIndex: 0, times: [], labels: [] }])
    expect(annotations).toHaveLength(1)
  })

  it('treats a missing duration as no audio rather than guessing one', async () => {
    const { plans } = await plan(['workflows/r/a.mp4', 'workflows/r/b.mp4'], [10])
    expect(plans[1].times).toEqual([])
  })

  it('throws a clear error when `sources` is not a list of File refs', async () => {
    const { ctx } = fakeCtx({ sources: ['workflows/r/a.mp4'], durations: [10] })
    await expect(sheetPlan(ctx)).rejects.toThrow(/sheet-plan.*sources.*File refs/i)
  })

  it('throws a clear error when `durations` is not a list of numbers', async () => {
    const { ctx } = fakeCtx({ sources: [ref('workflows/r/a.mp4')], durations: ['10'] })
    await expect(sheetPlan(ctx)).rejects.toThrow(/sheet-plan.*durations.*finite numbers/i)
  })
})
