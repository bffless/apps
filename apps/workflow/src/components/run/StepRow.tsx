/**
 * One step of a job, as a row that expands in place (spec 2026-09-08, phase 3
 * — GitHub's job page). The row *head* is the clickable unit and the anchor of
 * the headless contract (07): `data-testid="step"`, the persisted step key on
 * `data-key`, and `data-state` — the step's status in run mode, `declared`
 * before a run exists. That contract used to live on the graph's step chip;
 * the graph draws jobs only now (Task 8), so the row inherits it verbatim,
 * names and all, and a driver written against the old screen keeps working.
 *
 * Run mode is about the *attempt* (status glyph, how long it took, which try
 * this is); declared mode is about the *declaration* (kind glyph, id, the
 * `headless` contract it names). Both are the same row, so one reading of a
 * workflow serves both screens.
 *
 * Expanding is the page's business, not the row's: `open` comes down as a
 * prop and every click goes back up through `onToggle`, because the URL's
 * `?step=` is the real state (Decision 1) and a row that owned its own
 * `open` would fight it. A step the run has not reached has no row of its own
 * to show, so its chevron is `disabled` and it never opens.
 */
import { formatDuration } from '../../lib/duration'
import { headlessMode } from '../../lib/runner/headless'
import { isTerminal } from '../../lib/runner/jobs'
import type { JobStepRow } from '../../lib/runner/jobs'
import type { Definition, RunState, Step, StepKey, StepKind, StepStatus } from '../../lib/runner/types'
import { parseStepKey } from '../../lib/runner/types'
import { StatusGlyph } from '../StatusPill'
import type { GraphFlow } from '../graph/flow'
import { stepLabel } from '../graph/geometry'
import { StepBody } from './StepBody'
import type { Tab } from './StepBody'
import { stepBodyId, stepRowId } from './stepRowId'
import type { YamlSource } from './YamlDrawer'

/** A glyph per step kind (03) — decoration; the kind's word sits beside it. */
const KIND_ICON: Record<StepKind, string> = {
  pipeline: '⇢',
  island: '◧',
  form: '☑',
  script: '⌘',
}

/**
 * PR 5's declared-mode body (the step's own declaration, read off the
 * workflow file rather than off a run). Until then the raw block is an honest
 * placeholder — every fact it will show is already in there. `def`/`job`
 * dropped (fix round 3, nit): PR 5's real body will re-add whichever of them
 * it actually reads.
 */
export function DeclaredStepBody({ step }: { step: Step }) {
  return <pre className="declaration">{JSON.stringify(step.raw, null, 2)}</pre>
}

export interface StepRowProps {
  def: Definition
  state: RunState
  row: JobStepRow
  open: boolean
  onToggle: (key: StepKey) => void
  /** This run is the one this tab is driving — handed straight to `StepBody`'s form/island gate. */
  live: boolean
  /** Overrides `ImplContext` — only `render: island` outputs read it (`ValueView`). */
  impl?: string
  /** The run's YAML snapshot, for the body's **YAML** drawer (apps#449). */
  source?: YamlSource
  /** Which side the body opens on — an edge dot's click says (08). */
  initialTab?: Tab
  /** `run` reads the attempt; `declared` reads the declaration (PR 5). */
  mode?: 'run' | 'declared'
  /** The value under the pointer (08): the head lights up if this step declares it or reads it. */
  flow?: GraphFlow
  /**
   * This row is the one the fullscreen overlay is (or would be) fixed over —
   * `RunShell`'s `openIslandKey`, compared against this row's own key by
   * `JobPage` (fix round 3, finding 2). Marks the `<li>` with
   * `data-fullscreen`, which `index.css` scopes the overlay's "everything but
   * this row" rule to — without it, a second open row shared the viewport
   * with the one the overlay actually names.
   */
  openIsland?: boolean
}

export function StepRow({
  def,
  state,
  row,
  open,
  onToggle,
  live,
  impl,
  source,
  initialTab,
  mode = 'run',
  flow,
  openIsland,
}: StepRowProps) {
  const { key, step, state: s } = row
  const run = mode === 'run'
  const runStatus: StepStatus = s?.status ?? 'queued'
  const status = run ? runStatus : 'declared'
  // Declared mode is about the file, which is always there; a run-mode row the
  // scheduler never reached has nothing to open.
  const reachable = !run || s !== undefined
  const label = stepLabel(step)
  const elapsed =
    s?.startedAt !== undefined && s?.finishedAt !== undefined ? s.finishedAt - s.startedAt : undefined
  // The right-hand mono slot: how long the attempt took once it is over, and
  // what it is doing while it is not (a step still moving says so with an
  // ellipsis; one that ended without stamps just names its outcome).
  const meta = !run
    ? ''
    : elapsed !== undefined
      ? formatDuration(elapsed)
      : isTerminal(runStatus)
        ? runStatus
        : `${runStatus}…`
  const headless = run ? undefined : headlessMode(step)
  const parts = parseStepKey(key)
  const flowKey = parts ? `${parts.job}::${step.id}` : undefined
  const dataFlow =
    flowKey === undefined || flow === undefined
      ? undefined
      : flow.sourceSteps.has(flowKey)
        ? 'source'
        : flow.targetSteps.has(flowKey)
          ? 'target'
          : undefined
  const bodyId = stepBodyId(key)

  return (
    <li
      className="step-row"
      data-open={open || undefined}
      data-fullscreen={openIsland || undefined}
      id={stepRowId(key)}
    >
      <button
        type="button"
        className="step-row-head"
        data-testid="step"
        data-key={key}
        // A step the run has not reached yet has no row, and is queued by definition.
        data-state={status}
        data-flow={dataFlow}
        aria-expanded={open}
        aria-controls={bodyId}
        disabled={!reachable}
        onClick={() => onToggle(key)}
      >
        {run ? (
          <StatusGlyph status={status} />
        ) : (
          <span className="step-kind" title={step.uses} aria-hidden="true">
            {KIND_ICON[step.uses]}
          </span>
        )}
        <span className="step-label">
          <span className="step-title">{label}</span>
          {label !== step.id && <span className="step-id">{step.id}</span>}
          {headless && <span className="badge">{`headless: ${headless}`}</span>}
        </span>
        <span className="step-kind-word">{step.uses}</span>
        {s !== undefined && s.attempt > 1 && <span className="badge">attempt {s.attempt}</span>}
        <span className="step-meta">{meta}</span>
        <span className="step-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div id={bodyId} className="step-row-body">
          {run ? (
            <StepBody
              def={def}
              state={state}
              stepKey={key}
              live={live}
              impl={impl}
              source={source}
              initialTab={initialTab}
              onClose={() => onToggle(key)}
            />
          ) : (
            <DeclaredStepBody step={step} />
          )}
        </div>
      )}
    </li>
  )
}
