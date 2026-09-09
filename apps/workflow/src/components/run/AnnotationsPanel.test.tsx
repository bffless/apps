/**
 * The Summary's Annotations panel (spec 2026-09-08 Task 9): a collapsible
 * `<details>`, closed by default unless the run carries an error, with a
 * summary line counting each level and each step annotation linking to the
 * step it came from — GitHub's shape, replacing the old always-open
 * `AnnotationList`.
 */
import { render, screen } from '@testing-library/react'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AnnotationsPanel } from './AnnotationsPanel'
import { FINISHED_RUN, FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { collectAnnotations } from '../../lib/runner/annotations'
import { replayRun } from '../../lib/runner/replay'
import type { Annotation, Definition } from '../../lib/runner/types'

const def = toDefinition(FINISHED_RUN.run.definition) as Definition
const state = replayRun(FINISHED_RUN.run, FINISHED_RUN.steps, def)
const annotations = collectAnnotations(state)

const BASE = '/hello/hello'

function renderPanel(list: Annotation[]) {
  return render(
    <MemoryRouter>
      <AnnotationsPanel annotations={list} base={BASE} runId={FIXTURE_RUN_ID} />
    </MemoryRouter>,
  )
}

describe('AnnotationsPanel', () => {
  it('sums the counts in its summary line and links each step annotation to its step', () => {
    renderPanel(annotations)

    // notices + warnings only (the fixture has no error-level annotation) —
    // closed by default.
    expect(screen.getByRole('group')).not.toHaveAttribute('open')
    expect(screen.getByText(/Annotations · 1 warning, 1 notice/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'flaky/0/after' })).toHaveAttribute(
      'href',
      `/hello/hello/runs/${FIXTURE_RUN_ID}/job/flaky/0?step=flaky%2F0%2Fafter`,
    )
  })

  it('opens by itself when any annotation is an error', () => {
    renderPanel([{ level: 'error', message: 'boom' }])

    expect(screen.getByRole('group')).toHaveAttribute('open')
  })

  it('says "No annotations" and shows no list when the run produced none', () => {
    renderPanel([])

    expect(screen.getByText('No annotations')).toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByRole('group')).not.toHaveAttribute('open')
  })

  it('renders a run-level annotation with no jump link', () => {
    renderPanel([{ level: 'notice', message: 'a run-level note' }])

    expect(screen.getByText('a run-level note')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
