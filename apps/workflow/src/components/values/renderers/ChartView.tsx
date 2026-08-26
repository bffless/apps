/**
 * `render: chart` (02): a small uPlot chart over `mapping: { x, y, kind? }`.
 * `x`/`y` name columns to read out of either shape a `chart`ed value can
 * arrive in — a `table`'s `{ columns, rows }` (02) or a bare json array of
 * row objects — onto an index x-axis (categorical labels, not a time axis)
 * and a numeric y-axis. `kind: 'bar'` swaps uPlot's default line paths for
 * `uPlot.paths.bars()`; anything else (including an absent `kind`) stays a
 * line.
 *
 * The series is painted in the system's own ink (`DESIGN.md`): uPlot draws
 * nothing for a series with no `stroke`/`fill` — which is exactly what the
 * first cut shipped, a grid with no bars (2026-08-26 review). A bar chart's
 * y scale starts at zero, since a bar's length *is* its value.
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

/** The chart's paint — the system's ink and hairlines, never a second palette (DESIGN.md). */
const INK = 'oklch(0.17 0.015 265)'
const AXIS = 'oklch(0.5 0.012 265)'
const GRID = 'oklch(0.94 0.006 265)'
const AXIS_FONT = "11px 'Roboto Mono', ui-monospace, monospace"

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

  // `chartSeries`/`readMapping` build a fresh array/object literal on
  // *every* render, even when `value`/`mapping` are structurally unchanged —
  // `RunPage` polls every 5s while a run is running, re-rendering with a
  // new-but-equal outputs object each poll. Depending the effect on `series`/
  // `m` directly would tear down and rebuild uPlot on every one of those
  // polls; depending on their JSON content instead (a primitive, compared by
  // value) only rebuilds when the chart's data has actually changed. `series`/
  // `m` are still read from the enclosing closure, which is exactly the pair
  // `seriesKey`/`kind` describe — this isn't a case exhaustive-deps can see
  // through, since it can't tell two array literals are content-equal.
  const seriesKey = series ? JSON.stringify(series) : null
  const kind = m?.kind ?? null

  useEffect(() => {
    const el = containerRef.current
    if (!series || !m || !el) return

    const [labels, ys] = series
    const xs = labels.map((_, i) => i)
    const data: uPlot.AlignedData = [xs, ys]

    const bar = m.kind === 'bar'
    const opts: uPlot.Options = {
      width: el.clientWidth || 480,
      height: 220,
      legend: { show: false },
      cursor: { show: false },
      series: [
        { label: m.x },
        {
          label: m.y,
          stroke: INK,
          fill: bar ? INK : undefined,
          width: 1.5,
          paths: bar ? uPlot.paths.bars!({ size: [0.6, 64] }) : undefined,
          points: { show: !bar, size: 6, fill: INK, stroke: INK },
        },
      ],
      axes: [
        {
          stroke: AXIS,
          grid: { show: false },
          ticks: { stroke: GRID, width: 1 },
          font: AXIS_FONT,
          gap: 8,
          // One label per data point, never a fractional split.
          splits: () => xs,
          values: (_self, splits) => splits.map((s) => labels[s] ?? ''),
        },
        {
          stroke: AXIS,
          grid: { stroke: GRID, width: 1 },
          ticks: { show: false },
          font: AXIS_FONT,
          gap: 8,
          size: 48,
        },
      ],
      scales: {
        // Bars sit on the index axis with room for their own width either side.
        x: { time: false, range: bar ? [-0.5, xs.length - 0.5] : undefined },
        // A bar's length is its value, so the scale starts at zero; a line can
        // keep uPlot's data-fitted range.
        y: bar ? { range: (_u, _min, max) => [0, max <= 0 ? 1 : max * 1.1] } : {},
      },
    }

    const plot = new uPlot(opts, data, el)
    return () => plot.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `seriesKey`/`kind` are the content-equality stand-ins for `series`/`m` explained above; listing `series`/`m` themselves would defeat the whole point (they're new references every render).
  }, [seriesKey, kind])

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
