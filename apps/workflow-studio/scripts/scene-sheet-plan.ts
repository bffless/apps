/**
 * `scene-sheet-plan` — the `per-scene` job's `plan` step (`.bffless/workflows/studio.workflow.yaml`).
 *
 *   with:    { start, end }    the scene row's window, LOCAL to its source
 *   outputs: { times, labels } capture seconds + the burned-in clock, parallel
 *
 * Studio's refiner never worked from the director's sheets: it got a second, dense pass —
 * the whole 120-frame / 10-sheet budget spent on ONE scene at a 1 s floor
 * (`planSceneContactSheet`, story 03c). The port fed `refine-scene` the recording's share
 * of the ONE global plan instead (apps#524): ≤120 frames spread across EVERY recording at
 * the project-wide spacing — coarser, and burned with the GLOBAL clock while everything
 * downstream of `director` is source-LOCAL. This step is Studio's per-scene planner as its
 * own `script` step (the same move R116 made for the global plan): the arithmetic is not
 * re-derived — `planSceneContactSheet` IS the plan and `clockLabel` IS the burned-in clock.
 *
 * Both halves come out right at once:
 *
 * - **Density** — the budget belongs to this scene alone, so a ≤120 s scene gets a frame
 *   every second; longer scenes cap at 120 frames and the spacing widens.
 * - **The clock is the scene's own timeline.** `planSceneContactSheet` offsets its times
 *   back into source seconds (`+ start`), which is exactly the timeline the refine prompt
 *   declares for every value — the scene window `[start, end]`, the word timings, the cuts.
 *   The global sheets' clocks disagreed with that timeline for every recording after the
 *   first.
 *
 * A zero-length (or empty) window plans no times; the workflow `if:`-skips the capture
 * step (`video/contact-sheet` refuses an empty plan) and `refine` gets `[]`, which its
 * prep tolerates — the refiner works from the scene's audio and word timings alone.
 *
 * `planSceneContactSheet` can never exceed the 10 sheets `refine-scene` signs
 * (`cellsPerSheet` guarantees ≤ MAX_SHEETS) nor CE's 200-times-per-job cap (MAX_FRAMES
 * is 120), so unlike `sheet-plan` there is no per-source ceiling to enforce here.
 */
import type { ScriptContext } from '@bffless/workflow-script'
import { clockLabel, planSceneContactSheet } from 'studio/lib/contactSheet'
import { requireNumber } from './lib/inputs'

const NAME = 'scene-sheet-plan'

export default async function sceneSheetPlan(ctx: ScriptContext): Promise<Record<string, unknown>> {
  const start = requireNumber(NAME, ctx.inputs, 'start')
  const end = requireNumber(NAME, ctx.inputs, 'end')

  const plan = planSceneContactSheet(start, end)
  const times = plan.times
  const labels = times.map(clockLabel)

  if (times.length === 0) {
    // Has to be TRUE: the workflow `if:`-skips the capture step on an empty plan.
    ctx.annotate({
      level: 'warning',
      message: `No dense contact sheet for this scene — its window [${start}, ${end}] has no room to sample, so the capture step is skipped and the refiner works from the scene's audio and word timings alone.`,
    })
  } else {
    ctx.log(
      `${times.length} frames across the ${Math.round(end - start)}s scene window [${clockLabel(start)}–${clockLabel(end)}]`,
    )
  }

  return { times, labels }
}
