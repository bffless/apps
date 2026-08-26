/**
 * One declared step, as the clickable unit of the graph (08) and the anchor of
 * the headless contract (07): `data-testid="step"`, the persisted step key, and
 * `data-state` — the step's status in run mode, `declared` before a run exists.
 *
 * Definition mode is about the *declaration* (kind, id, the outputs it promises
 * and their types); run mode is about the *attempt* (status, how long it took,
 * which try this is). Both are the same chip so a driver written against one
 * screen keeps working on the other.
 */
import { stepOutputNames } from '@bffless/workflow-lint/definition'
import { formatDuration } from '../../lib/duration'
import { StatusPill } from '../StatusPill'
import type { Step, StepKey, StepKind, StepState } from '../../lib/runner/types'
import { stepKey } from '../../lib/runner/types'

/** A glyph per step kind (03) — decoration; the kind is also the chip's title. */
const KIND_ICON: Record<StepKind, string> = {
  pipeline: '⇢',
  island: '◧',
  form: '☑',
  script: '⌘',
}

/**
 * `headless: skip|auto` (bare form) or `headless: { mode: skip|auto, ... }`
 * (07) — `undefined` for a step that declares no `headless` at all. Defensive
 * on a headless block with no `mode`: the schema requires one, but `auto` is
 * the harness's own default if that ever slips through.
 */
function headlessMode(step: Step): 'skip' | 'auto' | undefined {
  const h = step.raw?.headless as unknown
  if (h === 'skip' || h === 'auto') return h
  if (h !== null && typeof h === 'object') {
    const mode = (h as { mode?: unknown }).mode
    if (mode === 'skip' || mode === 'auto') return mode
    if (mode === undefined) return 'auto'
  }
  return undefined
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
function declaredOutputs(step: Step): Array<[string, string]> {
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

export interface StepChipProps {
  job: string
  index: number
  step: Step
  mode: 'definition' | 'run'
  /** The step's row in run mode; absent until the scheduler reaches it. */
  state?: StepState
  selected?: boolean
  onPick: (key: StepKey, step: Step) => void
  /** The value under the pointer, if this chip is its source or a target (08); absent otherwise. */
  flow?: 'source' | 'target'
}

export function StepChip({ job, index, step, mode, state, selected, onPick, flow }: StepChipProps) {
  const key = stepKey(job, index, step.id)
  const run = mode === 'run'
  const outputs = declaredOutputs(step)
  const elapsed =
    state?.startedAt !== undefined && state.finishedAt !== undefined
      ? state.finishedAt - state.startedAt
      : undefined
  // Definition-mode only: in run mode this would read as a status, not a declaration (M1 minor).
  const headless = mode === 'definition' ? headlessMode(step) : undefined

  return (
    <button
      type="button"
      className="step-chip"
      data-testid="step"
      data-key={key}
      // A step the run has not reached yet has no row, and is queued by definition.
      data-state={run ? (state?.status ?? 'queued') : 'declared'}
      data-flow={flow}
      aria-pressed={selected ?? false}
      onClick={() => onPick(key, step)}
    >
      <span className="step-head">
        <span className="step-kind" title={step.uses} aria-hidden="true">
          {KIND_ICON[step.uses]}
        </span>
        <span className="step-id">{step.id}</span>
        {run && state && <StatusPill status={state.status} />}
        {headless && <span className="badge">{`headless: ${headless}`}</span>}
      </span>

      {run ? (
        <span className="step-meta">
          {elapsed !== undefined && <span>{formatDuration(elapsed)}</span>}
          {(state?.attempt ?? 1) > 1 && <span>attempt {state!.attempt}</span>}
        </span>
      ) : (
        outputs.length > 0 && (
          <span className="step-outputs">
            {outputs.map(([name, type]) => (
              <span className="step-output" key={name}>
                <span className="out-name">{name}</span>
                <span className="out-type">{type}</span>
              </span>
            ))}
          </span>
        )
      )}
    </button>
  )
}
