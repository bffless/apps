/**
 * The pane head's YAML drawer (08, apps#449): opens over the run page with
 * the selected block marked, says it is the run's snapshot, and closes —
 * Esc, scrim, button — without touching the pane it came from.
 *
 * Rendered on the finished hello run's replayed state, with the hello file
 * as the snapshot, so the marked lines can be asserted by number against
 * `docs/spec/examples/hello.workflow.yaml` (the locator's own test does the
 * same; this one checks the DOM those numbers become).
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { replayRun } from '../../lib/runner/replay'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import { makeStore } from '../../store'
import { HELLO_YAML, hello } from '../../test/helloHarness'
import { JobPane } from './JobPane'
import { StepPane } from './StepPane'
import type { YamlSource } from './YamlDrawer'

const SOURCE: YamlSource = { yaml: HELLO_YAML, workflowVersion: '0.0.0', fileHref: '/hello/hello/file' }
const state = replayRun(FINISHED_RUN.run, FINISHED_RUN.steps, hello)

/** `null` = a bare pane with no run source at all. */
function renderStep(key: string, source: YamlSource | null = SOURCE) {
  const onBack = vi.fn()
  render(
    <Provider store={makeStore()}>
      <MemoryRouter>
        <StepPane def={hello} state={state} stepKey={key} live={false} onBack={onBack} source={source ?? undefined} />
      </MemoryRouter>
    </Provider>,
  )
  return { onBack }
}

function renderJob(job: string) {
  render(
    <Provider store={makeStore()}>
      <MemoryRouter>
        <JobPane def={hello} state={state} job={job} onSelect={vi.fn()} onBack={vi.fn()} source={SOURCE} />
      </MemoryRouter>
    </Provider>,
  )
}

const drawer = () => screen.getByTestId('yaml-drawer')

/** The 1-based source line numbers the drawer marked. */
function markedLines(): number[] {
  const lines = Array.from(drawer().querySelectorAll('.code-line'))
  return lines.flatMap((line, i) => (line.getAttribute('data-marked') === 'true' ? [i + 1] : []))
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe('YamlDrawer', () => {
  it("opens from the step pane head with the step's block marked, as yaml", () => {
    renderStep('flaky/0/after')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'YAML' }))

    const dialog = screen.getByRole('dialog', { name: 'Workflow YAML' })
    expect(within(dialog).getByTestId('renderer')).toHaveAttribute('data-language', 'yaml')
    expect(within(dialog).getByRole('heading', { name: 'flaky/0/after' })).toBeInTheDocument()
    expect(markedLines()).toEqual(range(68, 75))
    expect(drawer().querySelector('.code-line[data-marked="true"]')?.textContent).toContain('- id: after')
    // The pane behind it is untouched.
    expect(screen.getByTestId('step-pane')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'YAML' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('labels the source as the run’s snapshot, with a way to the current file', () => {
    renderStep('flaky/0/after')
    fireEvent.click(screen.getByRole('button', { name: 'YAML' }))

    expect(screen.getByTestId('yaml-drawer-snapshot')).toHaveTextContent('as run · 0.0.0 · lines 68–75')
    expect(within(drawer()).getByRole('link', { name: 'Current workflow file' })).toHaveAttribute(
      'href',
      '/hello/hello/file',
    )
  })

  it("marks a matrix leg's step together with the job's strategy", () => {
    renderStep('greet/1/say')
    fireEvent.click(screen.getByRole('button', { name: 'YAML' }))

    expect(markedLines()).toEqual([...range(21, 23), ...range(25, 32)])
    expect(screen.getByTestId('yaml-drawer-snapshot')).toHaveTextContent('lines 21–23, 25–32')
  })

  it('marks the whole job from the job pane', () => {
    renderJob('slow')
    fireEvent.click(screen.getByRole('button', { name: 'YAML' }))

    expect(within(drawer()).getByRole('heading', { name: 'slow' })).toBeInTheDocument()
    expect(markedLines()).toEqual(range(36, 58))
  })

  it('Esc closes the drawer without climbing a level, and hands focus back to the control', () => {
    const { onBack } = renderStep('flaky/0/after')
    fireEvent.click(screen.getByRole('tab', { name: 'Output' }))
    const trigger = screen.getByRole('button', { name: 'YAML' })
    fireEvent.click(trigger)
    expect(drawer()).toHaveFocus()

    fireEvent.keyDown(drawer(), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onBack).not.toHaveBeenCalled()
    expect(screen.getByTestId('step-pane')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true')
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('a click outside, or the Close button, closes it the same way', () => {
    const { onBack } = renderStep('flaky/0/after')
    const trigger = screen.getByRole('button', { name: 'YAML' })

    fireEvent.click(trigger)
    fireEvent.click(screen.getByTestId('yaml-drawer-scrim'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByTestId('yaml-drawer-close'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(onBack).not.toHaveBeenCalled()
  })

  it('shows a snapshot that has no such block unmarked, and says so', () => {
    renderStep('flaky/0/after', { yaml: 'name: Not this one\n', fileHref: '/hello/hello/file' })
    fireEvent.click(screen.getByRole('button', { name: 'YAML' }))

    expect(screen.getByTestId('yaml-drawer-unmarked')).toBeInTheDocument()
    expect(markedLines()).toEqual([])
    expect(screen.getByTestId('yaml-drawer-snapshot')).toHaveTextContent(/^as run$/)
  })

  it('offers no control when the pane has no run source', () => {
    renderStep('flaky/0/after', null)
    expect(screen.queryByRole('button', { name: 'YAML' })).not.toBeInTheDocument()
  })
})
