/**
 * One job of the graph: its name, what it fans out over, and its steps stacked
 * in declaration order (08).
 *
 * Two shapes, as in the prototype: a job with one step and no matrix is a
 * single 60px card — the step *is* the card, its row carries the job's name —
 * and anything else is a group card with a header strip (the job name, and for
 * a matrix job the `FOR EACH … · N AT ONCE` line) over one row per step.
 *
 * A matrix job is one card, not N: in run mode it carries the progress fraction
 * ("2 of 2") and an item selector that swaps which expansion index the chips
 * below show. That keeps the layout a function of the *definition* — the graph
 * never grows or reflows as a run fans out. Every card's height is derived the
 * same way (`cardHeight`), so `GraphView` can draw connectors and edge dots
 * without a layout pass.
 *
 * Which item is showing is *derived from `selectedKey`* whenever the selection
 * belongs to this job, and changing the selector reports the new key through
 * `onPick`. So there is exactly one place the card and the run page's pane can
 * disagree about — the key — and a run page that restores a selection or
 * deep-links to `greet/1/say` gets a card showing item 1, with that very chip
 * on it. The local index is only the fallback for a job nothing has selected.
 */
import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { Job, RunState, Step, StepKey, StepStatus } from '../../lib/runner/types'
import { stepKey } from '../../lib/runner/types'
import type { GraphFlow } from './flow'
import { isSingle, jobLabel, jobOutputNames, matrixNote } from './geometry'
import { StepChip } from './StepChip'

const TERMINAL: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
])

/** `greet/1/say` → its parts; step ids cannot contain `/`, so the split is exact. */
function parseKey(key: StepKey): { job: string; index: number; stepId: string } | null {
  const [job, index, ...rest] = key.split('/')
  if (job === undefined || index === undefined || rest.length === 0) return null
  const parsed = Number(index)
  return Number.isInteger(parsed) ? { job, index: parsed, stepId: rest.join('/') } : null
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
  /** The job itself as the selection (08: run › job › step): the header strip and the OUT rows. */
  onPickJob?: (job: string, side?: 'Input' | 'Output') => void
  /** Which chips light up for the hovered value (08); absent outside `GraphView`'s own render. */
  flow?: GraphFlow
  style?: CSSProperties
}

export function JobCard({ job, col, row, mode, state, selectedKey, onPick, onPickJob, flow, style }: JobCardProps) {
  const [picked, setPicked] = useState(0)

  const expansion = state?.expansions[job.id]
  const items = expansion?.items ?? [{}]
  const total = expansion?.total ?? items.length

  const selection = selectedKey ? parseKey(selectedKey) : null
  const selectedHere = selection?.job === job.id ? selection : null
  // The selection wins; the local index is the fallback for an unselected job.
  // Either can outrun the expansion (a resume with fewer items), hence the clamp.
  const preferred = selectedHere ? selectedHere.index : picked
  const index = preferred < total ? preferred : 0

  /** Switching item is a *selection* change, reported on the one channel. */
  const pickItem = (next: number) => {
    setPicked(next)
    const step = job.steps.find((candidate) => candidate.id === selectedHere?.stepId) ?? job.steps[0]
    if (step) onPick(stepKey(job.id, next, step.id), step)
  }

  const done = Array.from({ length: total }).filter((_, i) =>
    job.steps.every((step) => TERMINAL.has(state?.steps[stepKey(job.id, i, step.id)]?.status ?? 'queued')),
  ).length

  const note = matrixNote(job)
  const isMatrix = job.matrix !== undefined && mode === 'run'
  const single = isSingle(job)
  const jobFlow = flow?.sourceJobs.has(job.id) ? 'source' : undefined
  const selectedInside = selectedHere !== null
  const selectedJob = selectedKey === job.id
  const outs = mode === 'run' ? jobOutputNames(job) : []

  return (
    <article
      className="job-card"
      data-testid="job"
      data-job={job.id}
      data-col={col}
      data-row={row}
      data-flow={jobFlow}
      data-single={single || undefined}
      data-selected={selectedInside || selectedJob || undefined}
      data-selected-job={selectedJob || undefined}
      style={style}
    >
      {!single && (
        <header className="job-head">
          {/* The strip is the job's own handle (08: run › job › step). */}
          <button
            type="button"
            className="job-head-row"
            data-testid="job-head"
            aria-pressed={selectedJob}
            aria-label={`Job ${jobLabel(job)}`}
            onClick={() => onPickJob?.(job.id)}
          >
            <h3 className="job-name">{jobLabel(job)}</h3>
            {isMatrix && (
              <span className="job-fraction">
                {done} of {total}
              </span>
            )}
          </button>
          {note && <p className="job-note">{note}</p>}
        </header>
      )}

      {isMatrix && total > 1 && (
        <select
          className="job-items"
          aria-label={`Matrix item of ${job.id}`}
          value={index}
          onChange={(event) => pickItem(Number(event.target.value))}
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
          const flowKey = `${job.id}::${step.id}`
          const stepFlow = flow?.sourceSteps.has(flowKey)
            ? 'source'
            : flow?.targetSteps.has(flowKey)
              ? 'target'
              : undefined
          return (
            <StepChip
              key={step.id}
              job={job.id}
              jobLabel={single ? jobLabel(job) : undefined}
              index={mode === 'run' ? index : 0}
              step={step}
              mode={mode}
              state={state?.steps[key]}
              selected={selectedKey === key}
              single={single}
              onPick={onPick}
              flow={stepFlow}
            />
          )
        })}
      </div>

      {outs.length > 0 && (
        <div className="job-outputs">
          {outs.map((name) => (
            <button
              type="button"
              className="job-output"
              key={name}
              data-testid="job-output"
              data-output={name}
              onClick={() => onPickJob?.(job.id, 'Output')}
            >
              <span className="out-tag" aria-hidden="true">
                out
              </span>
              <span className="out-name">{name}</span>
            </button>
          ))}
        </div>
      )}
    </article>
  )
}
