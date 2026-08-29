/**
 * `sheet-plan` — `per-video` → step `plan` (`.bffless/workflows/studio.workflow.yaml`).
 *
 *   with:    { duration }                    seconds, the transcript's last word end (R126)
 *   outputs: { times, labels, interval }     fed straight to `video/contact-sheet`
 *
 * Studio computed this plan in the browser right before it captured the frames
 * itself; the workflow has to hand the timestamps to a pipeline as data, so the
 * plan becomes its own step (R116). The arithmetic is not re-derived here —
 * `planContactSheet` IS the rule (density floor, coverage ceiling, the 120-frame
 * budget) and `clockLabel` IS the burned-in clock the director reads a moment off.
 *
 * `duration` is the transcript's last word end rather than the container duration,
 * so it can never overrun the file; `sampleTimes` additionally keeps every time at
 * `duration - 0.05` or below, so a still is never asked for past the last frame.
 */
import type { ScriptContext } from '@bffless/workflow-script'
import { clockLabel, planContactSheet } from 'studio/lib/contactSheet'
import { requireNumber } from './lib/inputs'

const EMPTY = { times: [], labels: [], interval: 0 }

export default async function sheetPlan(ctx: ScriptContext): Promise<Record<string, unknown>> {
  const duration = requireNumber('sheet-plan', ctx.inputs, 'duration')

  // `video/contact-sheet` refuses an empty plan, so a silent `[]` would fail the
  // NEXT step with a confusing message. Say what actually happened here instead:
  // a recording whose transcript has no words has nothing to plan against.
  if (!Number.isFinite(duration) || duration <= 0) {
    ctx.annotate({
      level: 'warning',
      message:
        'No contact sheets planned — this recording has no spoken audio to plan from, so the director will work from the transcript alone.',
    })
    return { ...EMPTY }
  }

  const plan = planContactSheet(duration)
  ctx.log(`${plan.times.length} frames every ${plan.interval.toFixed(1)}s across ${clockLabel(duration)}`)
  return { times: plan.times, labels: plan.times.map(clockLabel), interval: plan.interval }
}
