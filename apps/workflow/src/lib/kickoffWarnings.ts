/**
 * `on.manual.warnings` (01), evaluated live on the kickoff form (08).
 *
 * A warning is `{ if, message }` read against the form's *current* values —
 * the same `inputs` a run would start with, plus one thing only the form
 * knows: a media file's `duration` in seconds, measured by its preview
 * (`FileControl` → `MediaPreview.onDuration`) and never stored on the File
 * ref (the stored ref stays `{ path, name, contentType, size, url }`, 02).
 * `impl` is the only other context. There is no run yet, so `run`, `steps`
 * and the status functions are not there — the linter rejects them
 * statically (`kickoff-warning-*` slots), and here they degrade to a notice
 * naming the reason rather than breaking the form.
 *
 * Evaluated through the shared engine (`runner/contexts` → workflow-lint), so
 * a warning cannot disagree with a lint. A warning is a caution, never
 * validation: nothing here disables Start. Pure: no React.
 */
import { EvalError, type EvalOptions } from '@bffless/workflow-lint/expressions'
import type { InputDef, KickoffWarning } from '@bffless/workflow-lint/definition'
import { evalIf, evalValue, implCtx } from './runner/contexts'
import { isFileRefLike } from './runner/fileRef'

export interface ShownWarning {
  /** `warning` when the `if` held; `notice` when the entry could not be evaluated. */
  severity: 'warning' | 'notice'
  message: string
}

/** Seconds per File-ref `path`, as the form's previews measured them. */
export type Durations = Record<string, number>

/**
 * `inputs` as a warning sees it: a `file` input's ref(s) carry `duration`
 * (`null` until the preview has measured it — a document has none, and a
 * `null` divides to 0, so an unmeasured recording never fires a warning by
 * accident); every other input is the form value as is. Built for evaluation
 * only — what `onStart` submits is untouched.
 */
export function warningInputs(
  inputs: Record<string, InputDef>,
  values: Record<string, unknown>,
  durations: Durations,
): Record<string, unknown> {
  const withDuration = (ref: unknown): unknown =>
    isFileRefLike(ref) ? { ...ref, duration: durations[ref.path] ?? null } : ref
  const out: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(inputs)) {
    const v = values[name] ?? null
    if (def.type !== 'file') {
      out[name] = v
    } else {
      out[name] = Array.isArray(v) ? v.map(withDuration) : withDuration(v)
    }
  }
  return out
}

/** No run has started: every status function is a mistake, reported as such. */
const NO_RUN_YET: NonNullable<EvalOptions['status']> = {
  success: () => {
    throw new EvalError('success() has nothing to report before a run starts')
  },
  failure: () => {
    throw new EvalError('failure() has nothing to report before a run starts')
  },
  always: () => {
    throw new EvalError('always() has nothing to report before a run starts')
  },
  cancelled: () => {
    throw new EvalError('cancelled() has nothing to report before a run starts')
  },
}

function text(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * The warnings to show right now, in declaration order: each entry whose `if`
 * holds, with its `message` rendered; an entry that throws (a status function,
 * an unknown function) becomes a `notice` so the author sees why.
 */
export function evalKickoffWarnings(
  warnings: readonly KickoffWarning[],
  inputs: Record<string, unknown>,
  alias: string | undefined,
): ShownWarning[] {
  const contexts = { inputs, impl: alias === undefined ? null : implCtx(alias) }
  const shown: ShownWarning[] = []
  warnings.forEach((w, i) => {
    try {
      if (!evalIf(w.if, contexts, NO_RUN_YET)) return
      shown.push({ severity: 'warning', message: text(evalValue(w.message, contexts)) })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      shown.push({ severity: 'notice', message: `Warning ${i + 1} could not be evaluated — ${reason}` })
    }
  })
  return shown
}
