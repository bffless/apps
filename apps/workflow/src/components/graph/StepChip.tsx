/**
 * One declared step, as the clickable unit of the graph (08) and the anchor of
 * the headless contract (07): `data-testid="step"`, the persisted step key, and
 * `data-state` — the step's status in run mode, `declared` before a run exists.
 *
 * Definition mode is about the *declaration* (kind, id, the outputs it promises
 * and their types); run mode is about the *attempt* (status glyph, how long it
 * took, which try this is). Both are the same chip so a driver written against
 * one screen keeps working on the other.
 *
 * Visually a chip is one row of its job card (the prototype's "Upload · 1m 02s"
 * line): a 15px status glyph, the step's label, and a mono duration on the
 * right. Its height is fixed by `CHIP` so `GraphView` can draw the connectors
 * without measuring anything.
 */
import { formatDuration } from '../../lib/duration'
import { StatusGlyph } from '../StatusPill'
import type { Step, StepKey, StepKind, StepState } from '../../lib/runner/types'
import { stepKey } from '../../lib/runner/types'
import { declaredOutputs, stepLabel } from './geometry'

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

/** What the right-hand mono slot says about a run-mode step. */
function meta(state: StepState | undefined): string {
  if (!state) return ''
  const elapsed =
    state.startedAt !== undefined && state.finishedAt !== undefined
      ? state.finishedAt - state.startedAt
      : undefined
  const attempt = (state.attempt ?? 1) > 1 ? ` · attempt ${state.attempt}` : ''
  if (elapsed !== undefined) return `${formatDuration(elapsed)}${attempt}`
  if (state.status === 'running' || state.status === 'polling') return `running${attempt}`
  if (state.status === 'waiting') return 'waiting'
  return ''
}

export interface StepChipProps {
  job: string
  /** The job's own name, shown on a single-step card in place of a strip (08). */
  jobLabel?: string
  index: number
  step: Step
  mode: 'definition' | 'run'
  /** The step's row in run mode; absent until the scheduler reaches it. */
  state?: StepState
  selected?: boolean
  /** This chip is its job's whole card: one 60px row rather than a list row. */
  single?: boolean
  onPick: (key: StepKey, step: Step) => void
  /** The value under the pointer, if this chip is its source or a target (08); absent otherwise. */
  flow?: 'source' | 'target'
}

export function StepChip({
  job,
  jobLabel,
  index,
  step,
  mode,
  state,
  selected,
  single = false,
  onPick,
  flow,
}: StepChipProps) {
  const key = stepKey(job, index, step.id)
  const run = mode === 'run'
  const outputs = run ? [] : declaredOutputs(step)
  // Definition-mode only: in run mode this would read as a status, not a declaration (M1 minor).
  const headless = mode === 'definition' ? headlessMode(step) : undefined
  const label = stepLabel(step)
  const status = run ? (state?.status ?? 'queued') : 'declared'

  return (
    <button
      type="button"
      className="step-chip"
      data-testid="step"
      data-key={key}
      // A step the run has not reached yet has no row, and is queued by definition.
      data-state={status}
      data-flow={flow}
      data-single={single || undefined}
      aria-pressed={selected ?? false}
      onClick={() => onPick(key, step)}
    >
      <span className="step-row">
        {run ? (
          <StatusGlyph status={status} />
        ) : (
          <span className="step-kind" title={step.uses} aria-hidden="true">
            {KIND_ICON[step.uses]}
          </span>
        )}
        <span className="step-label">
          {single && jobLabel && jobLabel !== label ? (
            <>
              <span className="step-title">{jobLabel}</span>
              <span className="step-id">{label}</span>
            </>
          ) : label !== step.id ? (
            <>
              <span className="step-title">{label}</span>
              <span className="step-id">{step.id}</span>
            </>
          ) : (
            <span className="step-id">{step.id}</span>
          )}
          {headless && <span className="badge">{`headless: ${headless}`}</span>}
        </span>
        <span className="step-meta">{run ? meta(state) : step.uses}</span>
      </span>

      {outputs.length > 0 && (
        <span className="step-outputs">
          {outputs.map(([name, type]) => (
            <span className="step-output" key={name}>
              <span className="out-tag" aria-hidden="true">
                out
              </span>
              <span className="out-name">{name}</span>
              <span className="out-type">{type}</span>
            </span>
          ))}
        </span>
      )}
    </button>
  )
}
