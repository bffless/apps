/**
 * The run header's Delete slot (Task 20).
 *
 * Delete is the one header action that destroys something, so it is gated
 * twice over: the page only passes `onDelete` when the *server* would allow it
 * (a terminal run, owned by this user or an admin — `RunPage.tsx`), and the
 * header itself never calls it without a confirm. This suite owns the second
 * gate; `RunPage.test.tsx` owns the first.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunHeader } from './RunHeader'
import type { RunHeaderProps } from './RunHeader'

const BASE_PROPS: RunHeaderProps = {
  workflowName: 'Hello workflow',
  runId: 'run_1',
  startedAt: 1_000,
  finishedAt: 2_000,
  headless: false,
  yaml: '# hello\n',
  status: 'succeeded',
  annotations: [],
  base: '/hello/hello',
}

function renderHeader(props: Partial<RunHeaderProps> = {}) {
  return render(
    <MemoryRouter>
      <RunHeader {...BASE_PROPS} {...props} />
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RunHeader — Delete', () => {
  it('offers no Delete at all when the page passes no handler', () => {
    renderHeader()

    expect(screen.queryByTestId('run-delete')).not.toBeInTheDocument()
  })

  it('renders Delete when the page passes a handler', () => {
    renderHeader({ onDelete: () => {} })

    expect(screen.getByTestId('run-delete')).toBeEnabled()
  })

  it('does not delete when the confirm is dismissed', () => {
    const onDelete = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderHeader({ onDelete })

    fireEvent.click(screen.getByTestId('run-delete'))

    expect(confirm).toHaveBeenCalledWith('Delete this run and its files? This cannot be undone.')
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('deletes once the confirm is accepted', () => {
    const onDelete = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderHeader({ onDelete })

    fireEvent.click(screen.getByTestId('run-delete'))

    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('disables Delete while one is in flight', () => {
    const onDelete = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderHeader({ onDelete, deleting: true })

    expect(screen.getByTestId('run-delete')).toBeDisabled()
  })

  it('keeps Cancel and Delete as separate actions on a live run', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderHeader({ live: true, onCancel: () => {}, onDelete: () => {} })

    expect(screen.getByTestId('run-cancel')).toBeInTheDocument()
    expect(screen.getByTestId('run-delete')).toBeInTheDocument()
  })
})
