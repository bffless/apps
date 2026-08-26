/**
 * The workflow graph — one view, two modes (08).
 *
 * Layout is derived, never measured: `topoLayers` gives the columns, a job's
 * slot in its layer gives the row, and both the CSS grid and the SVG edge
 * overlay are drawn from those two integers and the fixed cell size below. So
 * there is no ResizeObserver, no `getBoundingClientRect`, nothing that needs a
 * layout pass to be correct — which is also why the same component renders
 * identically in jsdom, where nothing has a size at all.
 *
 * Definition mode owns its side panel (clicking a chip shows the declaration);
 * run mode reports the click instead, because there the pane belongs to the run
 * page, which has the evaluated inputs and outputs to put in it.
 */
import { useMemo, useState } from 'react'
import { needsEdges, topoLayers } from '../../lib/runner/graph'
import type { Definition, RunState, Step, StepKey } from '../../lib/runner/types'
import { useAppSelector } from '../../store/hooks'
import { flowFor } from './flow'
import { JobCard } from './JobCard'

/** Cell geometry, in px. Mirrored by `.job-card` sizing in `index.css`. */
const COL_W = 240
const COL_GAP = 72
const ROW_H = 190
const ROW_GAP = 20

const columnLeft = (col: number) => col * (COL_W + COL_GAP)
const rowMiddle = (row: number) => row * (ROW_H + ROW_GAP) + ROW_H / 2

export interface GraphViewProps {
  def: Definition
  mode: 'definition' | 'run'
  /** Required in run mode: the folded state every chip reads its status from. */
  state?: RunState
  selectedKey?: StepKey | null
  onSelect?: (key: StepKey) => void
}

export function GraphView({ def, mode, state, selectedKey, onSelect }: GraphViewProps) {
  const [declared, setDeclared] = useState<{ key: StepKey; step: Step } | null>(null)
  const hoveredValue = useAppSelector((s) => s.ui.hoveredValue)
  const flow = useMemo(() => flowFor(def, hoveredValue), [def, hoveredValue])

  const layers = topoLayers(def)
  const at = new Map<string, { col: number; row: number }>()
  layers.forEach((layer, col) => layer.forEach((job, row) => at.set(job, { col, row })))

  const rows = Math.max(...layers.map((layer) => layer.length), 1)
  const width = layers.length * COL_W + Math.max(layers.length - 1, 0) * COL_GAP
  const height = rows * ROW_H + Math.max(rows - 1, 0) * ROW_GAP

  const pick = (key: StepKey, step: Step) => {
    if (mode === 'run') onSelect?.(key)
    else setDeclared({ key, step })
  }

  return (
    <div className="graph">
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
            return (
              <path
                key={`${edge.fromJob}->${edge.toJob}`}
                className="graph-edge"
                data-edge={`${edge.fromJob}→${edge.toJob}`}
                d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        </svg>

        <div
          className="graph-grid"
          style={{
            gridTemplateColumns: `repeat(${layers.length}, ${COL_W}px)`,
            gridAutoRows: `${ROW_H}px`,
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
                flow={flow}
                style={{ gridColumn: col + 1, gridRow: row + 1 }}
              />
            )),
          )}
        </div>
      </div>

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
