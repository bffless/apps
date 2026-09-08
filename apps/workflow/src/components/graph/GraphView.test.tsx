/**
 * The graph, in both of its modes (08) — **one node per job** (spec
 * 2026-09-08, Task 8).
 *
 * Definition mode is the workflow screen: jobs laid out by `topoLayers`
 * left→right, one `needs` edge per dependency, and each node carrying what the
 * job *declares* — how many steps it has and the outputs it promises, with
 * their types. Run mode is the run's Summary: the same nodes, each carrying the
 * job's folded status, its duration, and for a matrix job how far its fan-out
 * has got.
 *
 * Steps are not on the graph at all any more — the job page's step list owns
 * them (Phase 3) — so `[data-testid="step"]` must never appear on it. What a
 * step chip used to prove about a declaration is proved by `StepRow.test.tsx`,
 * which owns the row head that replaced it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
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

/** The fixture run, folded — the very state the run page hands the graph. */
const state = replayRun(
  FINISHED_RUN.run,
  FINISHED_RUN.steps,
  toDefinition(FINISHED_RUN.run.definition),
)

/** `GraphView` reads `ui.hoveredValue` off the store — every render needs one. */
function renderGraph(props: GraphViewProps, store: AppStore = makeStore()) {
  return { store, ...render(<Provider store={store}><GraphView {...props} /></Provider>) }
}

function renderRun(props: Partial<GraphViewProps> = {}, store: AppStore = makeStore()) {
  return renderGraph({ def: hello, mode: 'run', state, ...props }, store)
}

function renderDefinition(props: Partial<GraphViewProps> = {}, store: AppStore = makeStore()) {
  return renderGraph({ def: hello, mode: 'definition', ...props }, store)
}

/** One job's node — the graph's only clickable unit now. */
const node = (job: string) =>
  document.querySelector(`[data-testid="job"][data-job="${job}"]`) as HTMLElement

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

describe('GraphView (definition mode)', () => {
  it('lays every job out in its topological column', () => {
    renderDefinition()

    expect(screen.getAllByTestId('job')).toHaveLength(4)
    expect(columns()).toEqual([['greet'], ['flaky', 'slow'], ['confirm']])
  })

  it('draws one line per needs edge', () => {
    const { container } = renderDefinition()

    const edges = [...container.querySelectorAll('[data-edge]')].map((e) =>
      e.getAttribute('data-edge'),
    )
    expect(edges).toHaveLength(4)
    expect(new Set(edges)).toEqual(
      new Set(['greet→slow', 'greet→flaky', 'slow→confirm', 'flaky→confirm']),
    )
  })

  it('lists a job’s declared outputs with their types in definition mode, and reports the clicked job', () => {
    const onSelect = vi.fn()
    renderDefinition({ onSelect, selectedJob: null })

    const slow = node('slow')
    expect(slow).toHaveTextContent('report')
    expect(slow).toHaveTextContent('markdown')
    expect(slow).toHaveAttribute('data-state', 'declared')
    // The OUT rows are part of the node's accessible name too (no `aria-label`).
    expect(slow).toHaveAccessibleName(/report/)

    fireEvent.click(slow)

    // The declaration is the job page's now (`WorkflowPage.test.tsx`): the
    // graph names the job and shows nothing of it beside the canvas.
    expect(onSelect).toHaveBeenCalledWith('slow', undefined)
    expect(screen.queryByTestId('step-declaration')).not.toBeInTheDocument()
    expect(document.querySelector('.graph-panel')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Input of A slow server job' }))
    expect(onSelect).toHaveBeenCalledWith('slow', 'Input')
  })

  it('presses the node its owner has selected, and presses none where nothing tracks a selection', () => {
    const { unmount } = renderDefinition({ selectedJob: 'slow' })

    expect(node('slow')).toHaveAttribute('aria-pressed', 'true')
    expect(node('greet')).toHaveAttribute('aria-pressed', 'false')

    unmount()
    // A graph with no owner to select for is not a toggle at all.
    renderDefinition()
    expect(node('slow')).not.toHaveAttribute('aria-pressed')
  })

  it('counts a job’s steps and notes what a matrix job fans out over', () => {
    renderDefinition()

    expect(screen.getByText('For each who · max 2 at once')).toBeInTheDocument()
    // `flaky` declares `boom` and `after`; `greet` declares one step.
    expect(node('flaky')).toHaveTextContent('2 steps')
    expect(node('greet')).toHaveTextContent('1 step')
  })

  it('draws no step chips: the graph is jobs only', () => {
    renderDefinition()

    expect(document.querySelectorAll('[data-testid="step"]')).toHaveLength(0)
    // …so the definition-mode `headless:` badge cannot appear on it either.
    expect(screen.queryByText(/^headless:/)).not.toBeInTheDocument()
  })
})

describe('GraphView (run mode)', () => {
  it('draws one node per job with its status and duration in run mode', () => {
    renderRun()

    const slow = node('slow')
    expect(slow).toHaveTextContent('Succeeded')
    expect(slow).toHaveAttribute('data-state', 'succeeded')
    // No `aria-label` override: the node's content *is* its accessible name, so
    // everything it exists to say is said to a screen reader too.
    expect(slow).toHaveAccessibleName(/A slow server job/)
    expect(slow).toHaveAccessibleName(/Succeeded/)
    expect(slow).toHaveAccessibleName(/7\.0 s/)
    // `slow/0/start` ran from +2 s to +9 s — the job's own span.
    expect(slow).toHaveTextContent('7.0 s')
    // `flaky/0/boom` failed under `continue-on-error`: the job still reads failed.
    expect(node('flaky')).toHaveAttribute('data-state', 'failed')
    expect(document.querySelectorAll('[data-testid="step"]')).toHaveLength(0)
  })

  it('shows a matrix job as one node with its fraction and note', () => {
    renderRun()

    const greet = node('greet')
    expect(greet).toHaveTextContent('For each who · max 2 at once')
    expect(greet).toHaveTextContent('2 of 2 done')
    expect(greet).toHaveAccessibleName(/For each who · max 2 at once/)
    expect(greet).toHaveAccessibleName(/2 of 2 done/)
  })

  it('reports the clicked job to its owner, with the side an edge dot asked for', () => {
    const onSelect = vi.fn()
    renderRun({ onSelect, selectedJob: null })

    fireEvent.click(node('slow'))
    expect(onSelect).toHaveBeenCalledWith('slow', undefined)
    expect(screen.queryByTestId('step-declaration')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Output of A slow server job' }))
    expect(onSelect).toHaveBeenCalledWith('slow', 'Output')
  })

  it('presses the node its owner has selected, and only that one', () => {
    renderRun({ selectedJob: 'slow' })

    expect(node('slow')).toHaveAttribute('aria-pressed', 'true')
    expect(node('greet')).toHaveAttribute('aria-pressed', 'false')
  })
})

// ---------------------------------------------------------------------------
// Data-flow hover-highlight (08, Task 22) — at job granularity (Task 8)
// ---------------------------------------------------------------------------

describe('GraphView — data-flow hover-highlight', () => {
  it('marks the target jobs and the source job when a value is hovered', () => {
    const store = makeStore()
    renderRun({}, store)

    act(() => {
      store.dispatch(valueHovered({ job: 'greet', output: 'lines' }))
    })

    expect(node('greet')).toHaveAttribute('data-flow', 'source')
    expect(node('slow')).toHaveAttribute('data-flow', 'target')
  })

  it('clears every data-flow attribute once the hover ends', () => {
    const store = makeStore()
    renderRun({}, store)

    act(() => {
      store.dispatch(valueHovered({ job: 'greet', output: 'lines' }))
    })
    expect(node('slow')).toHaveAttribute('data-flow', 'target')

    act(() => {
      store.dispatch(valueHovered(null))
    })

    expect(node('slow')).not.toHaveAttribute('data-flow')
    expect(node('greet')).not.toHaveAttribute('data-flow')
  })
})
