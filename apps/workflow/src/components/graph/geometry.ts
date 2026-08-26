/**
 * The graph's derived geometry (08): every card's and row's height as a
 * function of the definition (and, in run mode, the fan-out), so `GraphView`
 * can place cards, draw connectors and pin the edge dots without a layout
 * pass — which is also why the graph renders identically in jsdom. The pixel
 * constants are mirrored by `.job-card` / `.step-chip` sizing in `index.css`;
 * change both.
 *
 * Kept apart from the components so each component file exports only
 * components (react-refresh/only-export-components).
 */
import { stepOutputNames } from '@bffless/workflow-lint/definition'
import type { Job, RunState, Step } from '../../lib/runner/types'

/** Row geometry in px — mirrored by `.step-chip` sizing in `index.css`; change both. */
export const CHIP = {
  /** A step row inside a multi-step (or matrix) card. */
  row: 42,
  /** The one row of a single-step card, which is the whole card. */
  single: 60,
  /** One declared output line under a row (definition mode only). */
  out: 20,
  /** Breathing room under the last output line. */
  outPad: 8,
}

/**
 * What a step promises, per kind (03) — and the linter owns that answer, so the
 * chip asks `stepOutputNames` rather than reading `outputs` and calling a form
 * or a bare pipeline step outputless: a form's outputs *are* its `with.fields`,
 * and a pipeline step with no `outputs` map still exposes `response`.
 *
 * Types follow the same three conventions: the declaration's `type`, a form
 * field's `type`, otherwise untyped json (02).
 */
export function declaredOutputs(step: Step): Array<[string, string]> {
  const names = stepOutputNames(step)
  if (!names) return []

  const declared = (step.raw?.outputs ?? null) as Record<string, { type?: unknown }> | null
  const fields =
    step.uses === 'form'
      ? ((step.raw?.with?.fields ?? null) as Record<string, { type?: unknown }> | null)
      : null

  return names.map((name) => {
    const declaredType = declared?.[name]?.type
    if (typeof declaredType === 'string') return [name, declaredType]
    const fieldType = fields?.[name]?.type
    return [name, typeof fieldType === 'string' ? fieldType : 'json']
  })
}

/** The step's `name` when it declares one (01), else its id. */
export function stepLabel(step: Step): string {
  const name = step.raw?.name
  return typeof name === 'string' && name !== '' ? name : step.id
}

/** The chip's height in px, from the definition alone. */
export function chipHeight(step: Step, mode: 'definition' | 'run', single: boolean): number {
  const base = single ? CHIP.single : CHIP.row
  if (mode !== 'definition') return base
  const outputs = declaredOutputs(step).length
  return outputs === 0 ? base : base + outputs * CHIP.out + CHIP.outPad
}

/** Card geometry in px — mirrored by `.job-card` sizing in `index.css`; change both. */
export const CARD = {
  /** The header strip: job name (+ fraction). */
  strip: 40,
  /** The matrix line under the name. */
  note: 20,
  /** The matrix item selector row. */
  select: 34,
  /** One declared job-output line under the steps (run mode). */
  out: 20,
  /** Breathing room under the last output line. */
  outPad: 8,
  /** Top + bottom border. */
  border: 2,
}

/** The job's declared `outputs:` names — the rows a run-mode card lists under its steps. */
export function jobOutputNames(job: Job): string[] {
  return Object.keys(job.outputs ?? {})
}

/** "For each who · max 2 at once" — the strategy, as the prototype phrases it. */
export function matrixNote(job: Job): string | null {
  const strategy = job.raw?.strategy as { matrix?: object; 'max-parallel'?: number } | undefined
  const vars = strategy?.matrix ? Object.keys(strategy.matrix) : []
  if (vars.length === 0) return null
  const parallel = strategy?.['max-parallel']
  return `For each ${vars.join(', ')}${parallel ? ` · max ${parallel} at once` : ''}`
}

/** The job's `name` when it declares one, else its id. */
export function jobLabel(job: Job): string {
  return job.raw?.name ?? job.id
}

/** A one-step, un-fanned job renders as a single card (08). */
export function isSingle(job: Job): boolean {
  return job.steps.length === 1 && job.matrix === undefined
}

/** Whether the item selector row shows: a run-mode matrix job that fanned out to more than one item. */
function hasSelector(job: Job, mode: 'definition' | 'run', state?: RunState): boolean {
  if (job.matrix === undefined || mode !== 'run') return false
  const expansion = state?.expansions[job.id]
  return (expansion?.total ?? expansion?.items?.length ?? 1) > 1
}

/** The card's height in px, from the definition (and, in run mode, the fan-out) alone. */
export function cardHeight(job: Job, mode: 'definition' | 'run', state?: RunState): number {
  const single = isSingle(job)
  const chips = job.steps.reduce((sum, step) => sum + chipHeight(step, mode, single), 0)
  const outs = mode === 'run' ? jobOutputNames(job).length : 0
  const outRows = outs === 0 ? 0 : outs * CARD.out + CARD.outPad
  if (single) return chips + outRows + CARD.border
  return (
    CARD.strip +
    (matrixNote(job) ? CARD.note : 0) +
    (hasSelector(job, mode, state) ? CARD.select : 0) +
    chips +
    outRows +
    CARD.border
  )
}
