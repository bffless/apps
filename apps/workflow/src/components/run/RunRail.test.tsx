import { render, screen, within, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { replayRun } from '../../lib/runner/replay'
import { definitionOf } from '../../lib/runDefinition'
import { toRunRow, toStepRow } from '../../lib/coerce'
import { FINISHED_RUN, FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { RunRail } from './RunRail'

const run = toRunRow(FINISHED_RUN.run)
const def = definitionOf(run)!
const state = replayRun(run, FINISHED_RUN.steps.map(toStepRow), def)

function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RunRail base="/hello/hello" runId={FIXTURE_RUN_ID} def={def} state={state} yaml={run.yaml} />
    </MemoryRouter>,
  )
}

describe('RunRail', () => {
  it('lists Summary, every job in scheduling order, and the run details', () => {
    at(`/hello/hello/runs/${FIXTURE_RUN_ID}`)
    const rail = screen.getByRole('navigation', { name: 'Run' })
    expect(within(rail).getByTestId('rail-summary')).toHaveAttribute('aria-current', 'page')
    // Job rows only (no item rows: the matrix group starts collapsed) — topo order, ids sorted within a layer.
    const jobs = within(rail).getAllByTestId('rail-job').filter((el) => !el.hasAttribute('data-index')).map((el) => el.getAttribute('data-job'))
    expect(jobs).toEqual(['greet', 'flaky', 'slow', 'confirm'])
    expect(within(rail).getByRole('link', { name: 'Past runs' })).toHaveAttribute('href', '/hello/hello/runs')
    expect(within(rail).getByRole('link', { name: 'Workflow file' })).toHaveAttribute('href', '/hello/hello/file')
    expect(within(rail).getByTestId('rail-back')).toHaveAttribute('href', '/hello/hello')
  })

  // Task 17b: a job's status is the engine's result, not the worst of its steps.
  it('reads the flaky job as succeeded — its only failure was absorbed by continue-on-error', () => {
    at(`/hello/hello/runs/${FIXTURE_RUN_ID}`)
    const rail = screen.getByRole('navigation', { name: 'Run' })
    const flaky = within(rail).getAllByTestId('rail-job').find((el) => el.getAttribute('data-job') === 'flaky')!
    expect(flaky.querySelector('.glyph')).toHaveAttribute('data-state', 'succeeded')
  })

  it('shows a matrix job as a group with its fraction, collapsed until opened or current', () => {
    at(`/hello/hello/runs/${FIXTURE_RUN_ID}`)
    const rail = screen.getByRole('navigation', { name: 'Run' })
    const group = within(rail).getByTestId('rail-matrix')
    expect(group).toHaveTextContent('2 of 2')
    expect(within(rail).getAllByTestId('rail-job').every((el) => !el.hasAttribute('data-index'))).toBe(true)
    fireEvent.click(within(group).getByRole('button', { name: /show items/i }))
    const items = within(rail).getAllByTestId('rail-job').filter((el) => el.hasAttribute('data-index'))
    expect(items.map((el) => el.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('who: world'), expect.stringContaining('who: studio')]))
    expect(items[1]).toHaveAttribute('href', `/hello/hello/runs/${FIXTURE_RUN_ID}/job/greet/1`)
  })

  it('opens the group and marks the item current on an item route', () => {
    at(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/greet/1`)
    const rail = screen.getByRole('navigation', { name: 'Run' })
    const current = within(rail).getAllByTestId('rail-job').find((el) => el.getAttribute('aria-current') === 'page')
    expect(current).toHaveAttribute('data-job', 'greet')
    expect(current).toHaveAttribute('data-index', '1')
  })

  it('collapses the matrix group you are on (fix round 5, finding 4)', () => {
    // `currentJob === job` defaults the group open on the job's own item route
    // — the very case `toggle` used to be a no-op against, since `opened`
    // never held it either way.
    at(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/greet/1`)
    const rail = screen.getByRole('navigation', { name: 'Run' })
    const chevron = within(rail).getByRole('button', { name: /hide items/i })
    fireEvent.click(chevron)
    expect(chevron).toHaveAttribute('aria-expanded', 'false')
    expect(within(rail).queryAllByTestId('rail-job').some((el) => el.hasAttribute('data-index'))).toBe(false)

    fireEvent.click(within(rail).getByRole('button', { name: /show items/i }))
    expect(within(rail).getByRole('button', { name: /hide items/i })).toHaveAttribute('aria-expanded', 'true')
    const items = within(rail).getAllByTestId('rail-job').filter((el) => el.hasAttribute('data-index'))
    expect(items).toHaveLength(2)
  })
})
