/**
 * The step chip's own declaration reading (07/03).
 *
 * The `headless` badge (M1 minor — Task 22) is definition mode only, and
 * spelled `headless: skip|auto` rather than the bare `headless` label, which
 * used to read like a status rather than a declaration. Run mode never shows
 * it at all — there it would be read as an attempt's status, not the step's
 * own contract.
 *
 * The declared-output rows are the second half: what a step promises is what
 * `stepOutputNames` says it does, per kind (03), not merely a written-out
 * `outputs` map. Both facts used to be read off the graph; since the graph
 * draws jobs only (spec 2026-09-08, Task 8) the chip is where they are pinned.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import interactiveYaml from '../../../docs/spec/examples/interactive.workflow.yaml?raw'
import { loadWorkflow } from '../../lib/runner/definition'
import type { Definition, Step } from '../../lib/runner/types'
import { StepChip } from './StepChip'

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition
const interactive = loadWorkflow(interactiveYaml, 'interactive.workflow.yaml').def as Definition
const review = hello.jobs.confirm!.steps[0]! // `headless: { mode: skip, outputs: {...} }`
const say = hello.jobs.greet!.steps[0]! // no `headless` declared at all
const choose = interactive.jobs.pick!.steps[0]! // the bare `headless: auto` form
/** The bare `headless: skip` scalar (07) — no example workflow declares one. */
const bareSkip: Step = {
  id: 'ack',
  index: 0,
  uses: 'form',
  raw: { id: 'ack', uses: 'form', with: { title: 'OK?', fields: {} }, headless: 'skip' },
}

describe('StepChip — headless badge', () => {
  it('reads `headless: skip` in definition mode for a step declaring it', () => {
    render(
      <StepChip job="confirm" index={0} step={review} mode="definition" onPick={vi.fn()} />,
    )
    expect(screen.getByText('headless: skip')).toBeInTheDocument()
  })

  // Both spellings are legal (07) and `headlessMode` reads them the same way;
  // every example workflow but one uses the object form, so the bare scalar
  // reached the chip untested (apps#382).
  it('reads the bare `headless: skip` scalar the same as the object form', () => {
    render(<StepChip job="confirm" index={0} step={bareSkip} mode="definition" onPick={vi.fn()} />)
    expect(screen.getByText('headless: skip')).toBeInTheDocument()
  })

  it('reads the bare `headless: auto` scalar (interactive: pick/choose)', () => {
    render(<StepChip job="pick" index={0} step={choose} mode="definition" onPick={vi.fn()} />)
    expect(screen.getByText('headless: auto')).toBeInTheDocument()
  })

  it('never shows the badge in run mode for the bare form either', () => {
    render(<StepChip job="confirm" index={0} step={bareSkip} mode="run" onPick={vi.fn()} />)
    expect(screen.queryByText(/^headless/)).not.toBeInTheDocument()
  })

  it('shows no badge in definition mode for a step with no `headless` at all', () => {
    render(<StepChip job="greet" index={0} step={say} mode="definition" onPick={vi.fn()} />)
    expect(screen.queryByText(/^headless/)).not.toBeInTheDocument()
  })

  it('never shows the badge in run mode, even for a step that declares headless: skip', () => {
    render(<StepChip job="confirm" index={0} step={review} mode="run" onPick={vi.fn()} />)
    expect(screen.queryByText(/^headless/)).not.toBeInTheDocument()
  })
})

describe('StepChip — data-flow', () => {
  it('stamps data-flow only when the prop names it', () => {
    const { rerender, container } = render(
      <StepChip job="greet" index={0} step={say} mode="definition" onPick={vi.fn()} />,
    )
    expect(within(container).getByTestId('step')).not.toHaveAttribute('data-flow')

    rerender(
      <StepChip
        job="greet"
        index={0}
        step={say}
        mode="definition"
        onPick={vi.fn()}
        flow="source"
      />,
    )
    expect(within(container).getByTestId('step')).toHaveAttribute('data-flow', 'source')

    rerender(
      <StepChip
        job="greet"
        index={0}
        step={say}
        mode="definition"
        onPick={vi.fn()}
        flow="target"
      />,
    )
    expect(within(container).getByTestId('step')).toHaveAttribute('data-flow', 'target')
  })
})

describe('StepChip — declared outputs (03)', () => {
  it("shows a declared output's own name and type", () => {
    render(<StepChip job="greet" index={0} step={say} mode="definition" onPick={vi.fn()} />)

    expect(screen.getByText('line')).toBeInTheDocument()
    expect(screen.getByText('string')).toBeInTheDocument()
  })

  it("shows a form's fields as its outputs, though it declares no `outputs` map", () => {
    render(<StepChip job="confirm" index={0} step={review} mode="definition" onPick={vi.fn()} />)

    expect(screen.getByText('approved')).toBeInTheDocument()
    expect(screen.getByText('boolean')).toBeInTheDocument()
    expect(screen.getByText('report')).toBeInTheDocument()
    expect(screen.getByText('markdown')).toBeInTheDocument()
  })

  it('shows the `response` a pipeline step exposes with no outputs map at all', () => {
    const boom = hello.jobs.flaky!.steps[0]!

    render(<StepChip job="flaky" index={0} step={boom} mode="definition" onPick={vi.fn()} />)

    expect(screen.getByText('response')).toBeInTheDocument()
    expect(screen.getByText('json')).toBeInTheDocument()
  })

  it('shows no declared outputs in run mode: there the chip is about the attempt', () => {
    render(<StepChip job="greet" index={0} step={say} mode="run" onPick={vi.fn()} />)

    expect(screen.queryByText('line')).not.toBeInTheDocument()
  })
})
