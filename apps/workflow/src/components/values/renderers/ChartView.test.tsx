/**
 * `chartSeries` (pure, no canvas needed) and `ChartView` (Task 16, 02):
 * jsdom has no canvas, so `uplot` is mocked here — the test asserts the
 * wrapper, the computed series, and that the mocked constructor was called
 * with the data `chartSeries` computed, never the actual rendered pixels.
 */
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The one suite that *asserts* on uPlot rather than merely tolerating it, so
// it keeps its own spying stub instead of `src/test/uplotMock.ts`'s inert one.
const { uPlotCtor, barsFactory, destroySpy } = vi.hoisted(() => ({
  uPlotCtor: vi.fn(),
  barsFactory: vi.fn(() => 'bars-paths-builder'),
  destroySpy: vi.fn(),
}))

vi.mock('uplot', () => {
  class MockUPlot {
    static paths = { bars: barsFactory }
    constructor(...args: unknown[]) {
      uPlotCtor(...args)
    }
    destroy() {
      destroySpy()
    }
  }
  return { default: MockUPlot }
})

import { ChartView, chartSeries } from './ChartView'

const TABLE_VALUE = {
  columns: [{ key: 'line' }, { key: 'chars', type: 'number' }],
  rows: [
    { line: 'a', chars: 13 },
    { line: 'b', chars: 14 },
  ],
}

const JSON_ARRAY_VALUE = [
  { line: 'a', chars: 13 },
  { line: 'b', chars: 14 },
]

describe('chartSeries', () => {
  it('reads a table value (value.rows) with mapping { x: line, y: chars }', () => {
    expect(chartSeries(TABLE_VALUE, { x: 'line', y: 'chars' })).toEqual([
      ['a', 'b'],
      [13, 14],
    ])
  })

  it('reads a bare json array the same way', () => {
    expect(chartSeries(JSON_ARRAY_VALUE, { x: 'line', y: 'chars' })).toEqual([
      ['a', 'b'],
      [13, 14],
    ])
  })

  it('returns null when mapping.y is missing', () => {
    expect(chartSeries(JSON_ARRAY_VALUE, { x: 'line' })).toBeNull()
  })

  it('returns null when mapping is missing entirely', () => {
    expect(chartSeries(JSON_ARRAY_VALUE, undefined)).toBeNull()
  })

  it('returns null when the value is not row-shaped', () => {
    expect(chartSeries({ nope: true }, { x: 'line', y: 'chars' })).toBeNull()
  })

  it('returns null when a row is missing a numeric y', () => {
    expect(
      chartSeries([{ line: 'a', chars: 'not-a-number' }], { x: 'line', y: 'chars' }),
    ).toBeNull()
  })
})

describe('ChartView', () => {
  beforeEach(() => {
    uPlotCtor.mockClear()
    barsFactory.mockClear()
    destroySpy.mockClear()
  })

  it('renders the wrapper and constructs uPlot with the computed series (line)', () => {
    render(<ChartView value={JSON_ARRAY_VALUE} mapping={{ x: 'line', y: 'chars' }} />)
    const wrapper = screen.getByTestId('renderer')
    expect(wrapper).toHaveAttribute('data-render', 'chart')

    expect(uPlotCtor).toHaveBeenCalledTimes(1)
    const [, data] = uPlotCtor.mock.calls[0]
    expect(data).toEqual([[0, 1], [13, 14]])
    expect(barsFactory).not.toHaveBeenCalled()
  })

  it('uses uPlot.paths.bars() for kind: bar', () => {
    render(
      <ChartView value={JSON_ARRAY_VALUE} mapping={{ x: 'line', y: 'chars', kind: 'bar' }} />,
    )
    expect(barsFactory).toHaveBeenCalledTimes(1)
  })

  it('falls back to JsonTree with a note for a malformed mapping', () => {
    const { container } = render(<ChartView value={JSON_ARRAY_VALUE} mapping={{ x: 'line' }} />)
    expect(screen.getByTestId('renderer')).toHaveAttribute('data-render', 'chart')
    expect(container.querySelector('.note')).toBeTruthy()
    expect(container.querySelector('details')).toBeTruthy() // JsonTree
    expect(uPlotCtor).not.toHaveBeenCalled()
  })

  it('does not tear down and rebuild uPlot on a re-render with structurally-equal (new object) value/mapping', () => {
    // Simulates `RunPage` polling every 5s while a run is running: each poll
    // re-renders with a freshly-decoded outputs object that is a *new*
    // reference but the same data.
    const { rerender } = render(
      <ChartView value={JSON_ARRAY_VALUE} mapping={{ x: 'line', y: 'chars' }} />,
    )
    expect(uPlotCtor).toHaveBeenCalledTimes(1)

    rerender(
      <ChartView
        value={[
          { line: 'a', chars: 13 },
          { line: 'b', chars: 14 },
        ]}
        mapping={{ x: 'line', y: 'chars' }}
      />,
    )
    expect(uPlotCtor).toHaveBeenCalledTimes(1)
    expect(destroySpy).not.toHaveBeenCalled()
  })

  it('does tear down and rebuild uPlot when the data actually changes', () => {
    const { rerender } = render(
      <ChartView value={JSON_ARRAY_VALUE} mapping={{ x: 'line', y: 'chars' }} />,
    )
    expect(uPlotCtor).toHaveBeenCalledTimes(1)

    rerender(
      <ChartView
        value={[
          { line: 'a', chars: 13 },
          { line: 'b', chars: 99 },
        ]}
        mapping={{ x: 'line', y: 'chars' }}
      />,
    )
    expect(destroySpy).toHaveBeenCalledTimes(1)
    expect(uPlotCtor).toHaveBeenCalledTimes(2)
  })
})

/**
 * apps#380: uPlot dereferences `getContext('2d')` without checking it, so a
 * browser with canvas disabled would throw out of the render rather than
 * degrade. `src/test/setup.ts` installs a stub context for the whole suite —
 * these two tests take it away again for one render each, which is the only
 * way to reach the guard from jsdom.
 */
describe('ChartView with no 2d canvas', () => {
  const real = HTMLCanvasElement.prototype.getContext

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = real
  })

  it('falls back to JsonTree, with its own note, instead of constructing uPlot', () => {
    uPlotCtor.mockClear()
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as HTMLCanvasElement['getContext']

    const { container } = render(
      <ChartView value={JSON_ARRAY_VALUE} mapping={{ x: 'line', y: 'chars' }} />,
    )

    expect(screen.getByTestId('renderer')).toHaveAttribute('data-render', 'chart')
    expect(container.querySelector('.note')?.textContent).toContain('canvas')
    expect(container.querySelector('details')).toBeTruthy() // JsonTree
    expect(uPlotCtor).not.toHaveBeenCalled()
  })

  it('falls back rather than throwing when getContext itself throws', () => {
    uPlotCtor.mockClear()
    HTMLCanvasElement.prototype.getContext = (() => {
      throw new Error('canvas is disabled')
    }) as unknown as HTMLCanvasElement['getContext']

    expect(() =>
      render(<ChartView value={JSON_ARRAY_VALUE} mapping={{ x: 'line', y: 'chars' }} />),
    ).not.toThrow()
    expect(uPlotCtor).not.toHaveBeenCalled()
  })
})
