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

/** `line: { type: string }` → `line · string`; a bare expression is untyped json (02). */
function declaredOutputs(step: Step): Array<[string, string]> {
  const raw: unknown = step.raw?.outputs
  if (raw === null || typeof raw !== 'object') return []
  return Object.entries(raw as Record<string, unknown>).map(([name, decl]) => {
    const type = (decl as { type?: unknown } | null)?.type
    return [name, typeof type === 'string' ? type : 'json']
  })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
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
}

export function StepChip({ job, index, step, mode, state, selected, onPick }: StepChipProps) {
  const key = stepKey(job, index, step.id)
  const run = mode === 'run'
  const outputs = declaredOutputs(step)
  const elapsed =
    state?.startedAt !== undefined && state.finishedAt !== undefined
      ? state.finishedAt - state.startedAt
      : undefined

  return (
    <button
      type="button"
      className="step-chip"
      data-testid="step"
      data-key={key}
      // A step the run has not reached yet has no row, and is queued by definition.
      data-state={run ? (state?.status ?? 'queued') : 'declared'}
      aria-pressed={selected ?? false}
      onClick={() => onPick(key, step)}
    >
      <span className="step-head">
        <span className="step-kind" title={step.uses} aria-hidden="true">
          {KIND_ICON[step.uses]}
        </span>
        <span className="step-id">{step.id}</span>
        {run && state && <StatusPill status={state.status} />}
        {step.raw?.headless !== undefined && <span className="badge">headless</span>}
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
