/**
 * `scene-sheet-plan` — the `per-scene` job's `plan` step (`.bffless/workflows/studio.workflow.yaml`):
 * `with: { start, end }` in, `{ times, labels }` out. Studio's refiner never saw the
 * director's sheets — it got a second, dense pass over just its own scene (story 03c) —
 * and this step is that planner as data for `video/contact-sheet` (apps#524).
 *
 * What the suite pins down: the plan is Studio's `planSceneContactSheet` verbatim
 * (dense at the 1 s floor, capped by the 120-frame / 10-sheet budget), the times are
 * offset back into SOURCE seconds — the timeline the refine prompt declares for the
 * window, the word timings and the cuts — and the labels are the source-local clock,
 * not the global one the director's sheets burn.
 */
import { describe, expect, it } from 'vitest'
import sceneSheetPlan from './scene-sheet-plan'
import { fakeCtx } from './lib/fakeCtx'
import { clockLabel, MAX_FRAMES, planSceneContactSheet } from 'studio/lib/contactSheet'

async function plan(start: number, end: number) {
  const { ctx, annotations, logs } = fakeCtx({ start, end })
  const out = (await sceneSheetPlan(ctx)) as { times: number[]; labels: string[] }
  return { times: out.times, labels: out.labels, annotations, logs }
}

describe('scene-sheet-plan', () => {
  it('samples a 40s scene densely, inside its own window, on the source-local clock', async () => {
    // A 40 s scene at [100, 140]: the 1 s floor packs 40 frames — the whole budget on
    // THIS scene, where the global plan gave it only its share of the project spacing.
    const { times, labels } = await plan(100, 140)

    expect(times).toHaveLength(40)
    // Offset back into source seconds (`+ start`): every time lives in [100, 140].
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(100)
      expect(t).toBeLessThanOrEqual(140)
    }
    // ~1 s spacing, ascending — a frame every second of the scene.
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeCloseTo(1, 3)
    }

    // The burned-in clock is the SOURCE's — the timeline the refine prompt cuts on —
    // parallel to `times`. The first frame of a scene starting at 1:40 reads 1:40.
    expect(labels).toHaveLength(times.length)
    expect(labels).toEqual(times.map(clockLabel))
    expect(labels[0]).toBe('1:40')
  })

  it('is exactly Studio’s own per-scene planner', async () => {
    const { times } = await plan(120, 180)
    expect(times).toEqual(planSceneContactSheet(120, 180).times)
  })

  it('caps a 30-minute scene at the 120-frame budget with widened spacing', async () => {
    const { times, labels } = await plan(0, 30 * 60)

    expect(times).toHaveLength(MAX_FRAMES)
    expect(labels).toHaveLength(MAX_FRAMES)
    // The budget forces the spacing wider than the 1 s floor (30 min / 120 = 15 s).
    expect(times[1] - times[0]).toBeGreaterThan(1)
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThanOrEqual(30 * 60)
    }
  })

  it('plans nothing for an empty window, and says the capture step is skipped', async () => {
    // The workflow `if:`-skips `video/contact-sheet` on an empty plan and `refine`
    // gets `[]` (tolerated by its prep) — the annotation has to say exactly that.
    const { times, labels, annotations } = await plan(50, 50)

    expect(times).toEqual([])
    expect(labels).toEqual([])
    expect(annotations).toEqual([
      {
        level: 'warning',
        message: expect.stringContaining('skipped') as unknown as string,
      },
    ])
    const [note] = annotations as { message: string }[]
    expect(note.message).toContain('audio and word timings alone')
  })

  it('throws a clear error when `start` or `end` is not a number', async () => {
    const bad = fakeCtx({ start: '100', end: 140 })
    await expect(sceneSheetPlan(bad.ctx)).rejects.toThrow(/scene-sheet-plan.*start.*number/i)

    const missing = fakeCtx({ start: 100 })
    await expect(sceneSheetPlan(missing.ctx)).rejects.toThrow(/scene-sheet-plan.*end.*number/i)
  })
})
