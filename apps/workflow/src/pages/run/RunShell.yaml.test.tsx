/**
 * The YAML drawer on a real run page (08, apps#449): a past run's step opens
 * its block from the run's stored snapshot, labelled as such, without leaving
 * `/runs/<id>` — and closing leaves the selection exactly where it was.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from '../../App'
import { seedFinishedRun } from '../../mocks/db'
import { FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { makeStore } from '../../store'

const RUN_PATH = `/hello/hello/runs/${FIXTURE_RUN_ID}`

/** One job's node on the Summary graph — the graph's only clickable unit (Task 8). */
const node = (job: string) =>
  document.querySelector(`[data-testid="job"][data-job="${job}"]`) as HTMLElement | null

/** From the Summary: the step's job, then the step's own row on the job's trail. */
function openStep(page: HTMLElement, key: string) {
  fireEvent.click(node(key.split('/')[0]!)!)
  fireEvent.click(
    within(within(page).getByTestId('job-pane')).getByRole('button', { name: new RegExp(key) }),
  )
}

async function openRun() {
  seedFinishedRun()
  render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[RUN_PATH]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
  const page = screen.getByRole('main')
  await within(page).findByTestId('run-status')
  return page
}

function markedLines(): number[] {
  const lines = Array.from(screen.getByTestId('yaml-drawer').querySelectorAll('.code-line'))
  return lines.flatMap((line, i) => (line.getAttribute('data-marked') === 'true' ? [i + 1] : []))
}

describe('RunPage — YAML drawer', () => {
  it("shows a past run's step from the snapshot that ran, and closing restores the pane", async () => {
    const page = await openRun()
    openStep(page, 'flaky/0/after')
    const pane = within(page).getByTestId('step-pane')
    fireEvent.click(within(pane).getByRole('tab', { name: 'Output' }))
    expect(within(pane).getByText('Attempt 1')).toBeInTheDocument()

    fireEvent.click(within(pane).getByRole('button', { name: 'YAML' }))

    const dialog = screen.getByRole('dialog', { name: 'Workflow YAML' })
    expect(within(dialog).getByTestId('yaml-drawer-snapshot')).toHaveTextContent('as run · 0.0.0 · lines 68–75')
    expect(markedLines()).toEqual([68, 69, 70, 71, 72, 73, 74, 75])
    // Still the run page: the header's own link is untouched and the pane is still there.
    expect(within(page).getByRole('link', { name: 'View workflow file' })).toBeInTheDocument()
    expect(within(page).getByTestId('step-pane')).toBeInTheDocument()

    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const same = within(page).getByTestId('step-pane')
    expect(within(same).getByText('flaky/0/after', { selector: '.pane-key' })).toBeInTheDocument()
    expect(within(same).getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true')
    expect(within(same).getByText('Attempt 1')).toBeInTheDocument()
    expect(within(same).getByRole('button', { name: 'YAML' })).toHaveFocus()
  })

  it('marks the job block for a job selection', async () => {
    const page = await openRun()
    // The job node *is* the job selection now (Task 8) — one click, no step in
    // between and no crumb to climb.
    fireEvent.click(node('slow')!)
    const pane = within(page).getByTestId('job-pane')

    fireEvent.click(within(pane).getByRole('button', { name: 'YAML' }))

    expect(markedLines()).toEqual(Array.from({ length: 23 }, (_, i) => 36 + i))
    fireEvent.click(screen.getByTestId('yaml-drawer-close'))
    expect(within(page).getByTestId('job-pane')).toBeInTheDocument()
  })
})
