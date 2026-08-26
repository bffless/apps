/**
 * `render: chart` (02): a small uPlot chart over `mapping: { x, y, kind? }`.
 * `x`/`y` name columns to read out of either shape a `chart`ed value can
 * arrive in — a `table`'s `{ columns, rows }` (02) or a bare json array of
 * row objects — onto an index x-axis (categorical labels, not a time axis)
 * and a numeric y-axis. `kind: 'bar'` swaps uPlot's default line paths for
 * `uPlot.paths.bars()`; anything else (including an absent `kind`) stays a
 * line.
 *
 * jsdom has no canvas, so uPlot itself is only ever exercised in the real
 * browser (`pnpm --filter workflow build` + a manual smoke, not a unit test);
 * `ChartView.test.tsx` mocks the `uplot` module and asserts the constructor
 * call plus the computed series instead. A mapping/value combination that
 * doesn't resolve to a series falls back to `JsonTree`, the same "still show
 * something, honestly" rule every renderer in this directory follows.
 */
import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import { JsonTree } from '../JsonTree'

type ChartKind = 'bar' | 'line'

interface ChartMapping {
  x: string
  y: string
  kind: ChartKind
}

function readMapping(mapping: unknown): ChartMapping | null {
  if (mapping === null || typeof mapping !== 'object') return null
  const m = mapping as Record<string, unknown>
  if (typeof m.x !== 'string' || typeof m.y !== 'string') return null
  return { x: m.x, y: m.y, kind: m.kind === 'bar' ? 'bar' : 'line' }
}

/** `value.rows` for a table-shaped value, `value` itself for a bare array. */
function extractRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object') {
    const rows = (value as Record<string, unknown>).rows
    if (Array.isArray(rows)) return rows
  }
  return null
}

/**
 * The `[labels, ys]` uPlot needs, or `null` when `mapping` doesn't name both
 * axes, `value` isn't row-shaped, or any row is missing a numeric `y`. Pure
 * and exported so the malformed-input cases can be asserted without a canvas.
 */
// `chartSeries` belongs beside `ChartView`, not split into a same-purpose
// second file just to satisfy fast refresh (same call as `useMediaSeek`,
// `MediaSeekContext.tsx`) — it's the pure half of this one renderer, tested
// directly because jsdom has no canvas to exercise it through the DOM.
// eslint-disable-next-line react-refresh/only-export-components
export function chartSeries(value: unknown, mapping: unknown): [string[], number[]] | null {
  const m = readMapping(mapping)
  if (!m) return null
  const rows = extractRows(value)
  if (!rows) return null

  const labels: string[] = []
  const ys: number[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') return null
    const r = row as Record<string, unknown>
    const y = r[m.y]
    if (typeof y !== 'number') return null
    labels.push(String(r[m.x]))
    ys.push(y)
  }
  return [labels, ys]
}

export function ChartView({ value, mapping }: { value: unknown; mapping: unknown }) {
  const m = readMapping(mapping)
  const series = chartSeries(value, mapping)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!series || !m || !el) return

    const [labels, ys] = series
    const xs = labels.map((_, i) => i)
    const data: uPlot.AlignedData = [xs, ys]

    const opts: uPlot.Options = {
      width: el.clientWidth || 480,
      height: 200,
      series: [
        {},
        {
          paths: m.kind === 'bar' ? uPlot.paths.bars!() : undefined,
          points: { show: m.kind !== 'bar' },
        },
      ],
      axes: [
        {
          values: (_self, splits) => splits.map((s) => labels[s] ?? ''),
        },
        {},
      ],
      scales: { x: { time: false } },
    }

    const plot = new uPlot(opts, data, el)
    return () => plot.destroy()
  }, [series, m])

  if (!series) {
    return (
      <div className="renderer-chart" data-testid="renderer" data-render="chart">
        <p className="note">chart needs mapping.x/mapping.y naming row keys with numeric y values</p>
        <JsonTree value={value} />
      </div>
    )
  }

  return (
    <div className="renderer-chart" data-testid="renderer" data-render="chart" ref={containerRef} />
  )
}
