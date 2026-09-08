/**
 * The graph's derived geometry (08): every card's and row's height as a
 * function of the definition (and, in run mode, the fan-out), so `GraphView`
 * can place cards, draw connectors and pin the edge dots without a layout
 * pass — which is also why the graph renders identically in jsdom. The pixel
 * constants are mirrored by `.job-card` / `.step-row-head` sizing in `index.css`;
 * change both.
 *
 * Kept apart from the components so each component file exports only
 * components (react-refresh/only-export-components).
 */
import { stepOutputNames } from '@bffless/workflow-lint/definition'
import type { Definition, Job, Step } from '../../lib/runner/types'
import { resolveOutput } from '../../lib/outputDecls'
import { isFileRef } from '../values/fileRef'

/** Row geometry in px — mirrored by `.step-row-head` sizing in `index.css`; change both. */
export const CHIP = {
  /** A step row inside a multi-step (or matrix) card. */
  row: 42,
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

/** Card geometry in px — mirrored by `.job-card` sizing in `index.css`; change both. */
export const CARD = {
  /** The header strip: job name (+ fraction). */
  strip: 40,
  /** The matrix line under the name. */
  note: 20,
  /** The run-mode status line. */
  status: 42,
  /** A definition-mode OUT line. */
  out: 20,
  /** Top + bottom border. */
  border: 2,
}



/** "For each who · max 2 at once" — the strategy, as the prototype phrases it. */
export function matrixNote(job: Job): string | null {
  const strategy = job.raw?.strategy as { matrix?: object; 'max-parallel'?: number } | undefined
  const vars = strategy?.matrix ? Object.keys(strategy.matrix) : []
  if (vars.length === 0) return null
  const parallel = strategy?.['max-parallel']
  return `For each ${vars.join(', ')}${parallel ? ` · max ${parallel} at once` : ''}`
}

/** The job's declared outputs, as `[name, type]` pairs. */
export function declaredJobOutputs(def: Definition, job: string): Array<[string, string]> {
  const decl = def.jobs[job]
  if (!decl) return []
  return Object.keys(decl.outputs ?? {}).map((name) => {
    const type = resolveOutput(def, { kind: 'job', job }, name).decl.type
    return [name, typeof type === 'string' ? type : 'json']
  })
}

/** The job's `name` when it declares one, else its id. */
export function jobLabel(job: Job): string {
  return job.raw?.name ?? job.id
}

/**
 * One matrix variable's bound value, as shown by `JobCard`'s item selector: a
 * string or number stands for itself, a File ref (a take, a contact sheet,
 * ...) shows its own `name`, and any other object shows the first of
 * `title`/`name`/`label`/`id` that is a non-empty string. hello's matrix
 * items are strings; the Studio port's (`per-scene`) are objects
 * (`{ number, title, source, ... }`) — `String(value)` on one of those reads
 * as `[object Object]`, which is the bug this fixes. Anything left with
 * nothing readable on it falls back to its position, so the selector never
 * goes blank.
 */
export function matrixItemLabel(value: unknown, index: number): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (isFileRef(value)) return value.name
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of ['title', 'name', 'label', 'id']) {
      const candidate = obj[key]
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
  }
  return `#${index + 1}`
}

/** `who: world` — one matrix item's full name, the rail and the job card's item selector share. */
export function itemLabel(item: Record<string, unknown>, index: number): string {
  const bindings = Object.entries(item).map(([name, value]) => `${name}: ${matrixItemLabel(value, index)}`)
  return bindings.length > 0 ? bindings.join(', ') : `Item ${index + 1}`
}

/** The card's height in px, from the definition alone. */
export function cardHeight(def: Definition, job: string, mode: 'definition' | 'run'): number {
  const jobDecl = def.jobs[job]
  if (!jobDecl) return 0
  const outputs = declaredJobOutputs(def, job).length
  return (
    CARD.strip +
    (matrixNote(jobDecl) ? CARD.note : 0) +
    (mode === 'run' ? CARD.status : CARD.status + outputs * CARD.out + (outputs ? CHIP.outPad : 0)) +
    CARD.border
  )
}
