/**
 * One job of the graph: its name, what it fans out over, and its steps stacked
 * in declaration order (08).
 *
 * A matrix job is one card, not N: in run mode it carries the progress fraction
 * ("2 of 2") and an item selector that swaps which expansion index the chips
 * below show. That keeps the layout a function of the *definition* — the graph
 * never grows or reflows as a run fans out.
 */
import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { Job, RunState, Step, StepKey, StepStatus } from '../../lib/runner/types'
import { stepKey } from '../../lib/runner/types'
import { StepChip } from './StepChip'

const TERMINAL: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
])

/** "For each who · max 2 at once" — the strategy, as the prototype phrases it. */
function matrixNote(job: Job): string | null {
  const strategy = job.raw?.strategy as { matrix?: object; 'max-parallel'?: number } | undefined
  const vars = strategy?.matrix ? Object.keys(strategy.matrix) : []
  if (vars.length === 0) return null
  const parallel = strategy?.['max-parallel']
  return `For each ${vars.join(', ')}${parallel ? ` · max ${parallel} at once` : ''}`
}

/** `who: world` — how one matrix item names itself in the selector. */
function itemLabel(item: Record<string, unknown>, index: number): string {
  const bindings = Object.entries(item).map(([name, value]) => `${name}: ${String(value)}`)
  return bindings.length > 0 ? bindings.join(', ') : `Item ${index + 1}`
}

export interface JobCardProps {
  job: Job
  /** Layout position: topological layer, and the slot within it. */
  col: number
  row: number
  mode: 'definition' | 'run'
  state?: RunState
  selectedKey?: StepKey | null
  onPick: (key: StepKey, step: Step) => void
  style?: CSSProperties
}

export function JobCard({ job, col, row, mode, state, selectedKey, onPick, style }: JobCardProps) {
  const [picked, setPicked] = useState(0)

  const expansion = state?.expansions[job.id]
  const items = expansion?.items ?? [{}]
  const total = expansion?.total ?? items.length
  // A run can shrink the expansion under a selection (resume with fewer items).
  const index = picked < total ? picked : 0

  const done = Array.from({ length: total }).filter((_, i) =>
    job.steps.every((step) => TERMINAL.has(state?.steps[stepKey(job.id, i, step.id)]?.status ?? 'queued')),
  ).length

  const note = matrixNote(job)
  const isMatrix = job.matrix !== undefined && mode === 'run'

  return (
    <article
      className="job-card"
      data-testid="job"
      data-job={job.id}
      data-col={col}
      data-row={row}
      style={style}
    >
      <header className="job-head">
        <h3 className="job-name">{job.raw?.name ?? job.id}</h3>
        {isMatrix && (
          <span className="job-fraction">
            {done} of {total}
          </span>
        )}
      </header>

      {note && <p className="job-note">{note}</p>}

      {isMatrix && total > 1 && (
        <select
          className="job-items"
          aria-label={`Matrix item of ${job.id}`}
          value={index}
          onChange={(event) => setPicked(Number(event.target.value))}
        >
          {items.map((item, i) => (
            <option key={i} value={i}>
              {itemLabel(item, i)}
            </option>
          ))}
        </select>
      )}

      <div className="job-steps">
        {job.steps.map((step) => {
          const key = stepKey(job.id, mode === 'run' ? index : 0, step.id)
          return (
            <StepChip
              key={step.id}
              job={job.id}
              index={mode === 'run' ? index : 0}
              step={step}
              mode={mode}
              state={state?.steps[key]}
              selected={selectedKey === key}
              onPick={onPick}
            />
          )
        })}
      </div>
    </article>
  )
}
