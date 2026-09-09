/**
 * The Summary's per-job summaries (spec 2026-09-08 Task 9): every step's
 * `summary` grouped under the job (and matrix item) it belongs to, each
 * heading a way into that job's own page — the GitHub-shape replacement for
 * the old flat `RunSummary` list.
 */
import { render, screen, within } from '@testing-library/react'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { JobSummaries } from './JobSummaries'
import { FINISHED_RUN, FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { replayRun } from '../../lib/runner/replay'
import type { Definition, RunState } from '../../lib/runner/types'

const def = toDefinition(FINISHED_RUN.run.definition) as Definition
const state = replayRun(FINISHED_RUN.run, FINISHED_RUN.steps, def)

const BASE = '/hello/hello'

function renderSummaries(overrides: { def?: Definition; state?: RunState } = {}) {
  return render(
    <MemoryRouter>
      <JobSummaries def={overrides.def ?? def} state={overrides.state ?? state} base={BASE} runId={FIXTURE_RUN_ID} />
    </MemoryRouter>,
  )
}

describe('JobSummaries', () => {
  it('groups step summaries by job in scheduling order, each heading linking to the job', () => {
    renderSummaries()

    // Only `greet`'s two items write a summary in the fixture — `slow`,
    // `flaky` and `confirm` all leave `summary: null`.
    const entries = screen.getAllByRole('article')
    expect(entries.map((e) => e.getAttribute('data-job'))).toEqual(['greet', 'greet'])
    expect(within(entries[1]!).getByRole('link')).toHaveAttribute(
      'href',
      `/hello/hello/runs/${FIXTURE_RUN_ID}/job/greet/1`,
    )
    expect(within(entries[1]!).getByRole('heading')).toHaveTextContent(
      'Greet each name (who: studio) summary',
    )
    expect(entries[1]).toHaveTextContent('Hello, studio!')
  })

  it('links a non-matrix job heading to the job with no item index, and no item label', () => {
    // `greet` (the only job with a summary in the unmodified fixture) is a
    // matrix job, so that case alone never exercises the non-matrix branch of
    // `JobSummaries`' `href`/label logic. `slow` is a plain job — give its one
    // step a summary to reach it.
    const stateWithSlowSummary: RunState = {
      ...state,
      steps: {
        ...state.steps,
        'slow/0/start': { ...state.steps['slow/0/start']!, summary: 'Slow **done**' },
      },
    }
    renderSummaries({ state: stateWithSlowSummary })

    const entries = screen.getAllByRole('article')
    const slowEntry = entries.find((e) => e.getAttribute('data-job') === 'slow')!
    expect(slowEntry).toBeInTheDocument()
    // `itemTotal` for a non-matrix job is always 1, so its one entry's own
    // `data-index` is `0` — never absent, and never anything a matrix item's
    // index could be confused with.
    expect(slowEntry).toHaveAttribute('data-index', '0')
    expect(within(slowEntry).getByRole('link')).toHaveAttribute(
      'href',
      `/hello/hello/runs/${FIXTURE_RUN_ID}/job/slow`,
    )
    // No matrix item label — a plain job's heading names only the job.
    expect(within(slowEntry).getByRole('heading')).toHaveTextContent('A slow server job summary')
    expect(slowEntry).toHaveTextContent('done')
  })

  it('shows the note when no step anywhere wrote a summary', () => {
    const bareState: RunState = {
      ...state,
      steps: Object.fromEntries(
        Object.entries(state.steps).map(([key, step]) => [key, { ...step, summary: undefined }]),
      ),
    }
    renderSummaries({ state: bareState })

    expect(screen.queryAllByRole('article')).toHaveLength(0)
    expect(screen.getByText('No step wrote a summary.')).toBeInTheDocument()
  })
})
