/**
 * `sheet-plan` — the `plan` job's only step (`.bffless/workflows/studio.workflow.yaml`).
 *
 *   with:    { sources, durations }   the recordings, in `per-video` order
 *   outputs: { plans }                one entry per source, fed to the `sheets` matrix
 *
 * Studio computed this plan in the browser right before it captured the frames itself;
 * the workflow has to hand the timestamps to a pipeline as data, so the plan becomes its
 * own step (R116). The arithmetic is not re-derived here — `planGlobalSheetCaptures` IS
 * the rule and `clockLabel` IS the burned-in clock the director reads a moment off.
 *
 * ## One plan for the whole project, not one per recording (R147)
 *
 * Studio lays every source end to end on ONE global timeline and plans the director's
 * sheet across that (`apps/studio/src/lib/globalSheet.ts`): the ≤120-frame / ≤10-image
 * budget is spent once, at a 1 s density floor, and each global timestamp is routed to
 * the source it should be captured from. This step is that planner, nothing more.
 *
 * Two things follow, and both are why planning per recording was wrong:
 *
 * - **The label is the GLOBAL clock.** `scenes` and `blog` shift every transcript line
 *   onto the combined timeline (R132/R135), so a frame burned with its LOCAL time would
 *   disagree with the words beside it for every recording after the first. `times` stay
 *   LOCAL — that is what ffmpeg seeks in the file.
 * - **The budget is shared.** Per-recording planning gave two ≥600 s recordings ten
 *   sheets each, and the consumers sign only the first ten: the second recording
 *   contributed nothing at all.
 *
 * A source is identified to the planner by its INDEX, not its path: the same file
 * uploaded twice would otherwise collapse into one source and swallow the other's frames.
 *
 * `durations` are the transcripts' last word ends rather than container durations (R126),
 * so a time can never overrun the file; `sampleTimes` additionally keeps every time at
 * `duration - 0.05` or below, so a still is never asked for past the last frame.
 */
import type { ScriptContext } from '@bffless/workflow-script'
import { clockLabel } from 'studio/lib/contactSheet'
import { planGlobalSheetCaptures } from 'studio/lib/globalSheet'
import { requireFileRefs, requireNumbers } from './lib/inputs'

const NAME = 'sheet-plan'

/** CE's `MAX_STILLS_PER_JOB`, which `video/contact-sheet` also enforces on `times`. */
const MAX_TIMES_PER_SOURCE = 200

/** One recording's share of the global plan — the `sheets` matrix's item shape. */
export interface SourcePlan {
  /** The recording's uploads-relative path, straight to `video/contact-sheet`. */
  source: string
  /** Its position in `per-video`, so a consumer can index back by `sourceIndex`. */
  sourceIndex: number
  /** LOCAL capture seconds, ascending — what ffmpeg seeks. */
  times: number[]
  /** The GLOBAL clock burned onto each of them, parallel to `times`. */
  labels: string[]
}

export default async function sheetPlan(ctx: ScriptContext): Promise<Record<string, unknown>> {
  const sources = requireFileRefs(NAME, ctx.inputs, 'sources')
  const durations = requireNumbers(NAME, ctx.inputs, 'durations')

  const plans: SourcePlan[] = sources.map((source, index) => ({
    source: source.path,
    sourceIndex: index,
    times: [],
    labels: [],
  }))

  const captures = planGlobalSheetCaptures(
    sources.map((_source, index) => {
      const duration = durations[index]
      return { id: String(index), duration: typeof duration === 'number' ? duration : 0 }
    }),
  )

  // Ascending in global time, so each source's `times` come out ascending too.
  for (const capture of captures) {
    const plan = plans[Number(capture.sourceId)]
    if (!plan) continue
    plan.times.push(capture.localTime)
    plan.labels.push(clockLabel(capture.globalTime))
  }

  const total = plans.reduce((sum, plan) => sum + plan.times.length, 0)

  // Nothing planned anywhere means no recording has a word of spoken audio. Every `sheets`
  // leg would be `if:`-skipped, but `director` has no guard of its own and would run on
  // empty inputs, and the run would finish `succeeded` with nothing in it (apps#469). Fail
  // here instead — a failed `plan` skips every job downstream — and say why on the step
  // BEFORE throwing: the harness only accepts an annotation while the step is running.
  if (total === 0) {
    const message =
      'No recording has any spoken audio — there is nothing to plan contact sheets from and the director would run on empty inputs, so the run stops here.'
    ctx.annotate({ level: 'error', message })
    throw new Error(`${NAME}: ${message}`)
  }

  for (const plan of plans) {
    // Unreachable while the global budget is 120 frames across every source, but this is
    // the one invariant `video/contact-sheet` would reject rather than truncate.
    if (plan.times.length > MAX_TIMES_PER_SOURCE) {
      throw new Error(
        `${NAME}: planned ${plan.times.length} captures for ${plan.source} — at most ${MAX_TIMES_PER_SOURCE} per source`,
      )
    }
    // `video/contact-sheet` refuses an empty plan, so the workflow SKIPS the step for
    // this recording (`if: length(matrix.plan.times) > 0`). Say what that means rather
    // than leaving a silent hole in the run.
    if (plan.times.length === 0) {
      ctx.annotate({
        level: 'warning',
        message: `No contact sheets for ${plan.source || `recording ${plan.sourceIndex + 1}`} — it has no spoken audio to plan from, so its contact-sheet step is skipped and the director works from its transcript alone.`,
      })
    }
  }

  const combined = durations.reduce((sum, d) => sum + (Number.isFinite(d) && d > 0 ? d : 0), 0)
  ctx.log(
    `${total} frames across ${plans.length} recording(s), one timeline of ${clockLabel(combined)}`,
  )

  return { plans }
}
