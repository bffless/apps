/**
 * The graph, in both of its modes (08). Definition mode is the workflow screen:
 * jobs laid out by `topoLayers` left→right, one `needs` edge per dependency, and
 * a chip per declared step carrying the headless contract attributes (07).
 * Run mode is Task 15's screen; the fixture run is folded here so the props the
 * run page passes are pinned by a test rather than by a promise.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it, vi } from 'vitest'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from '../../lib/runner/definition'
import { replayRun } from '../../lib/runner/replay'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import type { Definition } from '../../lib/runner/types'
import { makeStore } from '../../store'
import type { AppStore } from '../../store'
import { valueHovered } from '../../store/uiSlice'
import { GraphView } from './GraphView'
import type { GraphViewProps } from './GraphView'

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition

/** `GraphView` reads `ui.hoveredValue` off the store — every render needs one. */
function renderGraph(props: GraphViewProps, store: AppStore = makeStore()) {
  return { store, ...render(<Provider store={store}><GraphView {...props} /></Provider>) }
}

/** `data-col` / `data-row` read back as the columns the layout claims to draw. */
function columns(): string[][] {
  const grid: string[][] = []
  for (const card of screen.getAllByTestId('job')) {
    const col = Number(card.getAttribute('data-col'))
    const row = Number(card.getAttribute('data-row'))
    ;(grid[col] ??= [])[row] = card.getAttribute('data-job') ?? ''
  }
  return grid
}

const chip = (container: HTMLElement, key: string) =>
  container.querySelector(`[data-key="${key}"]`) as HTMLElement

describe('GraphView (definition mode)', () => {
  it('lays every job out in its topological column', () => {
    renderGraph({ def: hello, mode: 'definition' })

    expect(screen.getAllByTestId('job')).toHaveLength(4)
    expect(columns()).toEqual([['greet'], ['flaky', 'slow'], ['confirm']])
  })

  it('draws one line per needs edge', () => {
    const { container } = renderGraph({ def: hello, mode: 'definition' })

    const edges = [...container.querySelectorAll('[data-edge]')].map((e) =>
      e.getAttribute('data-edge'),
    )
    expect(edges).toHaveLength(4)
    expect(new Set(edges)).toEqual(
      new Set(['greet→slow', 'greet→flaky', 'slow→confirm', 'flaky→confirm']),
    )
  })

  it('shows each step as a declared chip with its outputs and types', () => {
    const { container } = renderGraph({ def: hello, mode: 'definition' })

    const say = chip(container, 'greet/0/say')
    expect(say).toHaveAttribute('data-testid', 'step')
    expect(say).toHaveAttribute('data-state', 'declared')
    expect(within(say).getByText('say')).toBeInTheDocument()
    expect(within(say).getByText('line')).toBeInTheDocument()
    expect(within(say).getByText('string')).toBeInTheDocument()
  })

  it('shows the outputs each kind exposes, not only a declared `outputs` map (03)', () => {
    const { container } = renderGraph({ def: hello, mode: 'definition' })

    // A form's outputs *are* its fields, and it declares no `outputs` map.
    const review = chip(container, 'confirm/0/review')
    expect(within(review).getByText('approved')).toBeInTheDocument()
    expect(within(review).getByText('boolean')).toBeInTheDocument()
    expect(within(review).getByText('report')).toBeInTheDocument()
    expect(within(review).getByText('markdown')).toBeInTheDocument()

    // A pipeline step with no outputs map still exposes `response` (json).
    const boom = chip(container, 'flaky/0/boom')
    expect(within(boom).getByText('response')).toBeInTheDocument()
    expect(within(boom).getByText('json')).toBeInTheDocument()
  })

  it('notes a matrix job and a step that can run headless', () => {
    const { container } = renderGraph({ def: hello, mode: 'definition' })

    expect(screen.getByText('For each who · max 2 at once')).toBeInTheDocument()
    expect(
      within(chip(container, 'confirm/0/review')).getByText('headless: skip'),
    ).toBeInTheDocument()
  })

  it('opens the step declaration when a chip is clicked', () => {
    const { container } = renderGraph({ def: hello, mode: 'definition' })

    fireEvent.click(chip(container, 'greet/0/say'))

    const panel = screen.getByTestId('step-declaration')
    expect(panel.textContent).toContain('"uses": "pipeline"')
    expect(panel.textContent).toContain('"id": "say"')
  })
})

describe('GraphView (run mode)', () => {
  const state = replayRun(
    FINISHED_RUN.run,
    FINISHED_RUN.steps,
    toDefinition(FINISHED_RUN.run.definition),
  )

  it('carries each step status and the matrix progress fraction', () => {
    const { container } = renderGraph({ def: hello, mode: 'run', state })

    expect(chip(container, 'greet/0/say')).toHaveAttribute('data-state', 'succeeded')
    expect(chip(container, 'flaky/0/boom')).toHaveAttribute('data-state', 'failed')
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
  })

  it('does not show the definition-mode headless badge (it would read as a status)', () => {
    renderGraph({ def: hello, mode: 'run', state })
    expect(screen.queryByText(/^headless:/)).not.toBeInTheDocument()
  })

  it('switches a matrix job to another item', () => {
    const { container } = renderGraph({ def: hello, mode: 'run', state })

    expect(chip(container, 'greet/0/say')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Matrix item of greet'), { target: { value: '1' } })
    expect(chip(container, 'greet/0/say')).toBeNull()
    expect(chip(container, 'greet/1/say')).toBeTruthy()
  })

  it('shows the matrix item its owner has selected, and reports a change on the same channel', () => {
    const onSelect = vi.fn()
    const { container } = renderGraph({
      def: hello,
      mode: 'run',
      state,
      selectedKey: 'greet/1/say',
      onSelect,
    })

    // The card follows the selection rather than private state: item 1 is shown.
    expect(chip(container, 'greet/1/say')).toHaveAttribute('aria-pressed', 'true')
    expect(chip(container, 'greet/0/say')).toBeNull()

    fireEvent.change(screen.getByLabelText('Matrix item of greet'), { target: { value: '0' } })

    expect(onSelect).toHaveBeenCalledWith('greet/0/say')
  })

  it('reports the clicked step to its owner instead of opening the declaration', () => {
    const onSelect = vi.fn()
    const { container } = renderGraph({
      def: hello,
      mode: 'run',
      state,
      selectedKey: null,
      onSelect,
    })

    fireEvent.click(chip(container, 'slow/0/start'))

    expect(onSelect).toHaveBeenCalledWith('slow/0/start')
    expect(screen.queryByTestId('step-declaration')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Data-flow hover-highlight (08, Task 22)
// ---------------------------------------------------------------------------

describe('GraphView — data-flow hover-highlight', () => {
  const state = replayRun(
    FINISHED_RUN.run,
    FINISHED_RUN.steps,
    toDefinition(FINISHED_RUN.run.definition),
  )

  it('marks the target step and the source job when a job-level output is hovered', () => {
    const store = makeStore()
    const { container } = renderGraph({ def: hello, mode: 'run', state }, store)

    act(() => {
      store.dispatch(valueHovered({ job: 'greet', output: 'lines' }))
    })

    expect(chip(container, 'slow/0/start')).toHaveAttribute('data-flow', 'target')
    expect(chip(container, 'greet/0/say')).toHaveAttribute('data-flow', 'source')
    expect(container.querySelector('[data-testid="job"][data-job="greet"]')).toHaveAttribute(
      'data-flow',
      'source',
    )
  })

  it('clears every data-flow attribute once the hover ends', () => {
    const store = makeStore()
    const { container } = renderGraph({ def: hello, mode: 'run', state }, store)

    act(() => {
      store.dispatch(valueHovered({ job: 'greet', output: 'lines' }))
    })
    expect(chip(container, 'slow/0/start')).toHaveAttribute('data-flow', 'target')

    act(() => {
      store.dispatch(valueHovered(null))
    })

    expect(chip(container, 'slow/0/start')).not.toHaveAttribute('data-flow')
    expect(chip(container, 'greet/0/say')).not.toHaveAttribute('data-flow')
    expect(container.querySelector('[data-testid="job"][data-job="greet"]')).not.toHaveAttribute(
      'data-flow',
    )
  })
})
