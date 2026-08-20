/**
 * The graph, in both of its modes (08). Definition mode is the workflow screen:
 * jobs laid out by `topoLayers` left→right, one `needs` edge per dependency, and
 * a chip per declared step carrying the headless contract attributes (07).
 * Run mode is Task 15's screen; the fixture run is folded here so the props the
 * run page passes are pinned by a test rather than by a promise.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it, vi } from 'vitest'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from '../../lib/runner/definition'
import { replayRun } from '../../lib/runner/replay'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import type { Definition } from '../../lib/runner/types'
import { GraphView } from './GraphView'

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition

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
    render(<GraphView def={hello} mode="definition" />)

    expect(screen.getAllByTestId('job')).toHaveLength(4)
    expect(columns()).toEqual([['greet'], ['flaky', 'slow'], ['confirm']])
  })

  it('draws one line per needs edge', () => {
    const { container } = render(<GraphView def={hello} mode="definition" />)

    const edges = [...container.querySelectorAll('[data-edge]')].map((e) =>
      e.getAttribute('data-edge'),
    )
    expect(edges).toHaveLength(4)
    expect(new Set(edges)).toEqual(
      new Set(['greet→slow', 'greet→flaky', 'slow→confirm', 'flaky→confirm']),
    )
  })

  it('shows each step as a declared chip with its outputs and types', () => {
    const { container } = render(<GraphView def={hello} mode="definition" />)

    const say = chip(container, 'greet/0/say')
    expect(say).toHaveAttribute('data-testid', 'step')
    expect(say).toHaveAttribute('data-state', 'declared')
    expect(within(say).getByText('say')).toBeInTheDocument()
    expect(within(say).getByText('line')).toBeInTheDocument()
    expect(within(say).getByText('string')).toBeInTheDocument()
  })

  it('notes a matrix job and a step that can run headless', () => {
    const { container } = render(<GraphView def={hello} mode="definition" />)

    expect(screen.getByText('For each who · max 2 at once')).toBeInTheDocument()
    expect(within(chip(container, 'confirm/0/review')).getByText('headless')).toBeInTheDocument()
  })

  it('opens the step declaration when a chip is clicked', () => {
    const { container } = render(<GraphView def={hello} mode="definition" />)

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
    const { container } = render(<GraphView def={hello} mode="run" state={state} />)

    expect(chip(container, 'greet/0/say')).toHaveAttribute('data-state', 'succeeded')
    expect(chip(container, 'flaky/0/boom')).toHaveAttribute('data-state', 'failed')
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
  })

  it('switches a matrix job to another item', () => {
    const { container } = render(<GraphView def={hello} mode="run" state={state} />)

    expect(chip(container, 'greet/0/say')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Matrix item of greet'), { target: { value: '1' } })
    expect(chip(container, 'greet/0/say')).toBeNull()
    expect(chip(container, 'greet/1/say')).toBeTruthy()
  })

  it('reports the clicked step to its owner instead of opening the declaration', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <GraphView def={hello} mode="run" state={state} selectedKey={null} onSelect={onSelect} />,
    )

    fireEvent.click(chip(container, 'slow/0/start'))

    expect(onSelect).toHaveBeenCalledWith('slow/0/start')
    expect(screen.queryByTestId('step-declaration')).not.toBeInTheDocument()
  })
})
