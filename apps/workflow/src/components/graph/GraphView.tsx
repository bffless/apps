/**
 * The workflow graph — one view, two modes (08).
 *
 * Layout is derived, never measured: `topoLayers` gives the columns, a job's
 * slot in its layer gives the row, every card's height comes from the
 * definition (`cardHeight`), and both the CSS grid and the SVG overlay are
 * drawn from those numbers and the fixed cell geometry below. So there is no
 * ResizeObserver, no `getBoundingClientRect`, nothing that needs a layout pass
 * to be correct — which is also why the same component renders identically in
 * jsdom, where nothing has a size at all.
 *
 * Each card sits centred on its row's midline; a `needs` edge leaves the source
 * card's right edge at that midline and enters the target's left edge at its
 * own — a straight line when the two rows agree, one soft bend when they don't
 * (the prototype's connectors). The two dots on a card's edges are the
 * prototype's "jump straight to one side": the left one opens the **job** on
 * Input (what it waited on), the right one the job on Output (what it hands
 * on) — the job is the middle level of run › job › step, and its outputs are
 * what the edges carry.
 *
 * Definition mode owns its side panel (clicking a chip shows the declaration);
 * run mode reports the click instead, because there the pane belongs to the run
 * page, which has the evaluated inputs and outputs to put in it.
 */
import { useMemo, useState } from 'react'
import { dataFlowEdges, needsEdges, topoLayers } from '../../lib/runner/graph'
import type { Definition, Job, RunState, Step, StepKey } from '../../lib/runner/types'
import { stepKey } from '../../lib/runner/types'
import { useAppSelector } from '../../store/hooks'
import { flowFor } from './flow'
import { cardHeight, jobLabel } from './geometry'
import { JobCard } from './JobCard'

/** Cell geometry, in px. Mirrored by `.job-card` sizing in `index.css`. */
const COL_W = 260
const COL_GAP = 56
const ROW_GAP = 24
/** The edge dots' diameter; they straddle the card border. */
const DOT = 15
/** Canvas padding around the grid, so the outermost dots are not clipped. */
const PAD = 12

export type PaneSide = 'Input' | 'Output'

export interface GraphViewProps {
  def: Definition
  mode: 'definition' | 'run'
  /** Required in run mode: the folded state every chip reads its status from. */
  state?: RunState
  selectedKey?: StepKey | null
  /**
   * `key` is a step key (`job/index/step`) from a chip, or a bare job id from
   * the header strip / an edge dot / an OUT row; `side` is set when the click
   * came from an edge dot or an OUT row (08: "jump straight to one side").
   */
  onSelect?: (key: StepKey | string, side?: PaneSide) => void
}

export function GraphView({ def, mode, state, selectedKey, onSelect }: GraphViewProps) {
  const [declared, setDeclared] = useState<{ key: StepKey; step: Step } | null>(null)
  const hoveredValue = useAppSelector((s) => s.ui.hoveredValue)
  // The edge list depends on the definition alone, so it is memoized on the
  // definition alone: folded into the `flow` memo it was rebuilt on every
  // hover tick, walking the whole workflow to answer a pointer move (apps#380).
  const dataEdges = useMemo(() => dataFlowEdges(def), [def])
  const flow = useMemo(() => flowFor(def, hoveredValue, dataEdges), [def, hoveredValue, dataEdges])

  const layers = topoLayers(def)
  const at = new Map<string, { col: number; row: number }>()
  layers.forEach((layer, col) => layer.forEach((job, row) => at.set(job, { col, row })))

  const rows = Math.max(...layers.map((layer) => layer.length), 1)

  // Row heights: the tallest card in each row, so a 60px single beside a
  // four-step group still shares its midline.
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(
      ...layers.map((layer) => {
        const job = layer[row]
        return job ? cardHeight(def.jobs[job]!, mode, state) : 0
      }),
      1,
    ),
  )
  const rowTops = rowHeights.reduce<number[]>((tops, _h, i) => {
    tops.push(i === 0 ? 0 : tops[i - 1]! + rowHeights[i - 1]! + ROW_GAP)
    return tops
  }, [])

  const columnLeft = (col: number) => PAD + col * (COL_W + COL_GAP)
  const rowMiddle = (row: number) => PAD + rowTops[row]! + rowHeights[row]! / 2

  const width = PAD * 2 + layers.length * COL_W + Math.max(layers.length - 1, 0) * COL_GAP
  const height =
    PAD * 2 + rowHeights.reduce((sum, h) => sum + h, 0) + Math.max(rows - 1, 0) * ROW_GAP

  const pick = (key: StepKey, step: Step) => {
    if (mode !== 'run') setDeclared({ key, step })
    // A chip's click carries no side — the owner's pane opens as it likes.
    else onSelect?.(key)
  }

  /** The job as the selection (strip, dots, OUT rows) — run mode only; definition mode has no job pane. */
  const pickJob = (job: Job, side?: PaneSide) => {
    if (mode !== 'run') {
      const step = job.steps[0]
      if (step) setDeclared({ key: stepKey(job.id, 0, step.id), step })
      return
    }
    if (side === undefined) onSelect?.(job.id)
    else onSelect?.(job.id, side)
  }

  return (
    <div className="graph" data-mode={mode}>
      <div className="graph-scroll">
        <div className="graph-canvas" style={{ width, height }}>
          <svg
            className="graph-edges"
            viewBox={`0 0 ${width} ${height}`}
            width={width}
            height={height}
            aria-hidden="true"
          >
            {needsEdges(def).map((edge) => {
              const from = at.get(edge.fromJob)
              const to = at.get(edge.toJob)
              if (!from || !to) return null
              const x1 = columnLeft(from.col) + COL_W
              const y1 = rowMiddle(from.row)
              const x2 = columnLeft(to.col)
              const y2 = rowMiddle(to.row)
              const bend = COL_GAP / 2
              const d =
                y1 === y2
                  ? `M ${x1} ${y1} H ${x2}`
                  : `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
              return (
                <path
                  key={`${edge.fromJob}->${edge.toJob}`}
                  className="graph-edge"
                  data-edge={`${edge.fromJob}→${edge.toJob}`}
                  d={d}
                  vectorEffect="non-scaling-stroke"
                />
              )
            })}
          </svg>

          <div
            className="graph-grid"
            style={{
              left: PAD,
              top: PAD,
              gridTemplateColumns: `repeat(${layers.length}, ${COL_W}px)`,
              gridTemplateRows: rowHeights.map((h) => `${h}px`).join(' '),
              columnGap: COL_GAP,
              rowGap: ROW_GAP,
            }}
          >
            {layers.flatMap((layer, col) =>
              layer.map((job, row) => (
                <JobCard
                  key={job}
                  job={def.jobs[job]!}
                  col={col}
                  row={row}
                  mode={mode}
                  state={state}
                  selectedKey={selectedKey}
                  onPick={pick}
                  onPickJob={(id, side) => pickJob(def.jobs[id]!, side)}
                  flow={flow}
                  style={{
                    gridColumn: col + 1,
                    gridRow: row + 1,
                    height: cardHeight(def.jobs[job]!, mode, state),
                    alignSelf: 'center',
                  }}
                />
              )),
            )}
          </div>

          {layers.flatMap((layer, col) =>
            layer.flatMap((jobId, row) => {
              const job = def.jobs[jobId]!
              const y = rowMiddle(row) - DOT / 2
              const name = jobLabel(job)
              return (['Input', 'Output'] as const).map((side) => (
                <button
                  key={`${jobId}:${side}`}
                  type="button"
                  className="graph-dot"
                  data-side={side === 'Input' ? 'in' : 'out'}
                  data-job={jobId}
                  title={side}
                  aria-label={`${side} of ${name}`}
                  style={{
                    left: side === 'Input' ? columnLeft(col) - DOT / 2 : columnLeft(col) + COL_W - DOT / 2,
                    top: y,
                  }}
                  onClick={() => pickJob(job, side)}
                />
              ))
            }),
          )}
        </div>
      </div>

      {mode === 'run' && (
        <p className="graph-legend" aria-hidden="true">
          <span className="legend-item">
            <span className="legend-dot" data-side="in" />
            left dot · input
          </span>
          <span className="legend-item">
            <span className="legend-dot" data-side="out" />
            right dot · output
          </span>
        </p>
      )}

      {declared && (
        <aside className="graph-panel" aria-label="Step declaration">
          <header className="graph-panel-head">
            <h3 className="graph-panel-title">{declared.key}</h3>
            <button type="button" className="link-button" onClick={() => setDeclared(null)}>
              Close
            </button>
          </header>
          <pre className="declaration" data-testid="step-declaration">
            {JSON.stringify(declared.step.raw, null, 2)}
          </pre>
        </aside>
      )}
    </div>
  )
}
