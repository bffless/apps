/**
 * The job card's **Re-run from this job** slot (05; apps#491).
 *
 * Same contract as the run header's Delete: the page decides whether the job
 * can be forked from (`forkTarget`, the current definition, not the live tab —
 * `RunPage.tsx`) and passes `onFork` only then; the card renders the button
 * when it is handed one and nothing otherwise, and never decides for itself.
 * `RunPage.test.tsx` owns the first gate; this suite owns the rendering.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it, vi } from 'vitest'
import { JobPane } from './JobPane'
import type { JobPaneProps } from './JobPane'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import { replayRun } from '../../lib/runner/replay'

const def = toDefinition(FINISHED_RUN.run.definition)
const state = replayRun(FINISHED_RUN.run, FINISHED_RUN.steps, def)

function renderPane(props: Partial<JobPaneProps> = {}) {
  return render(
    <JobPane def={def} state={state} job="slow" impl="hello" onSelect={() => {}} onBack={() => {}} {...props} />,
  )
}

describe('JobPane — Re-run from this job', () => {
  it('offers no fork at all when the page passes no handler', () => {
    renderPane()

    expect(screen.getByTestId('job-pane')).toBeInTheDocument()
    expect(screen.queryByTestId('job-fork')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Re-run from this job' })).not.toBeInTheDocument()
  })

  it('renders the button when the page passes a handler, and calls it on click', () => {
    const onFork = vi.fn()
    renderPane({ onFork })

    const button = screen.getByTestId('job-fork')
    expect(button).toHaveTextContent('Re-run from this job')
    expect(button).toBeEnabled()

    fireEvent.click(button)

    expect(onFork).toHaveBeenCalledTimes(1)
  })

  it('keeps the button on both sides of the card — it is an action of the job, not of a tab', () => {
    renderPane({ onFork: () => {}, initialTab: 'Input' })

    expect(screen.getByTestId('job-fork')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Output' }))
    expect(screen.getByTestId('job-fork')).toBeInTheDocument()
  })
})
