/**
 * The run header's Delete slot (Task 20).
 *
 * Delete is the one header action that destroys something, so it is gated
 * twice over: the page only passes `onDelete` when the *server* would allow it
 * (a terminal run, owned by this user or an admin — `RunPage.tsx`), and the
 * header itself never calls it without a confirm. This suite owns the second
 * gate; `RunPage.test.tsx` owns the first.
 *
 * The run-sub line's **forked from** entry (05 "Re-run from this job";
 * apps#491) is the same shape as Delete: the page passes `forkedFrom` off a
 * row that has one (replayed, or adopted live into `RunMeta` — apps#513), and
 * the header renders the link — or nothing.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toRunRow } from '../../lib/coerce'
import { attachDiagnostics, buildDiagnostics, copyDiagnostics } from '../../lib/diagnostics'
import { httpJsonWithReauth } from '../../lib/http'
import { createRunStore } from '../../lib/runStore'
import { db } from '../../mocks/db'
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

    // The confirm always names forks (apps#491, decision 4): a fork keeps
    // pointing at its parent's files, and the page does not list forks.
    expect(confirm).toHaveBeenCalledWith(
      'Delete this run and its files? A run forked from it keeps pointing at those files. This cannot be undone.',
    )
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

describe('RunHeader — forked from (apps#491)', () => {
  it('links a fork to its parent run and names the job it re-ran from', () => {
    renderHeader({ forkedFrom: { runId: 'run_parent', job: 'slow' } })

    const line = screen.getByTestId('run-forked-from')
    expect(line).toHaveTextContent('forked from run_parent at slow')
    expect(within(line).getByRole('link', { name: 'run_parent' })).toHaveAttribute(
      'href',
      '/hello/hello/runs/run_parent',
    )
  })

  it('renders no such line on a run that was not forked', () => {
    renderHeader()

    expect(screen.queryByTestId('run-forked-from')).not.toBeInTheDocument()
    expect(screen.queryByText(/forked from/)).not.toBeInTheDocument()
  })
})

describe('RunHeader — badges', () => {
  it('badges an unattended run apart from a headless one (07)', () => {
    renderHeader({ unattended: true })
    expect(screen.getByTestId('run-unattended')).toHaveTextContent('unattended')
    expect(screen.queryByText('headless')).not.toBeInTheDocument()
  })

  it('shows no unattended badge by default', () => {
    renderHeader()
    expect(screen.queryByTestId('run-unattended')).not.toBeInTheDocument()
  })
})

describe('RunHeader — diagnostics (apps#526)', () => {
  /** The header's whole contract: buttons and echoed state; the page owns the writes. */
  const ACTIONS = {
    onCopy: () => {},
    copied: false,
    onAttach: () => {},
    attaching: false,
    attached: false,
  }

  it('offers no diagnostics buttons when the page passes none', () => {
    renderHeader()
    expect(screen.queryByTestId('run-copy-diagnostics')).not.toBeInTheDocument()
    expect(screen.queryByTestId('run-attach-diagnostics')).not.toBeInTheDocument()
  })

  it('copies the decided payload to the clipboard', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const onCopy = () => {
        void copyDiagnostics(
          buildDiagnostics({ runId: 'run_1', steps: [{ key: 'main/0/hello', status: 'failed' }] }),
        )
      }
      renderHeader({ diagnostics: { ...ACTIONS, onCopy } })

      fireEvent.click(screen.getByTestId('run-copy-diagnostics'))

      expect(writeText).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(writeText.mock.calls[0]?.[0] as string) as Record<string, unknown>
      expect(payload).toMatchObject({
        buildSha: 'dev',
        runId: 'run_1',
        steps: [{ key: 'main/0/hello', status: 'failed' }],
      })
      expect(typeof payload.url).toBe('string')
      expect(typeof payload.userAgent).toBe('string')
      expect(Array.isArray(payload.errors)).toBe(true)
      expect(typeof payload.at).toBe('number')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    }
  })

  it('echoes copied / attaching / attached on the buttons', () => {
    const { unmount } = renderHeader({ diagnostics: { ...ACTIONS, copied: true, attaching: true } })
    expect(screen.getByTestId('run-copy-diagnostics')).toHaveTextContent('Copied')
    expect(screen.getByTestId('run-attach-diagnostics')).toBeDisabled()
    unmount()

    renderHeader({ diagnostics: { ...ACTIONS, attached: true } })
    expect(screen.getByTestId('run-attach-diagnostics')).toBeEnabled()
    expect(screen.getByTestId('run-attach-diagnostics')).toHaveTextContent('Attached')
  })

  // The record path end to end (against the MSW `run/update` handler): two
  // clicks leave the row holding exactly ONE diagnostics annotation — the
  // second replaces the first (decided on the issue) — and the rollup rides
  // along on the same write.
  it('attaches exactly one diagnostics annotation after two clicks, counts and all', async () => {
    db.runs.set(
      'run_diag',
      toRunRow({
        runId: 'run_diag',
        impl: 'hello',
        workflow: 'hello',
        workflowName: 'Hello workflow',
        yaml: '# hello\n',
        status: 'failed',
        startedAt: 1_000,
        finishedAt: 2_000,
        annotations: [{ level: 'warning', message: 'already there' }],
      }),
    )
    const runStore = createRunStore(httpJsonWithReauth)
    const writes: Promise<void>[] = []
    const onAttach = () => {
      // Fresh row each click, the way the page's refetch keeps it fresh — the
      // second attach must see (and replace) the first's annotation.
      const row = db.runs.get('run_diag')!
      writes.push(
        attachDiagnostics(runStore, row, [], buildDiagnostics({ runId: 'run_diag', steps: [] })),
      )
    }
    renderHeader({ diagnostics: { ...ACTIONS, onAttach } })

    fireEvent.click(screen.getByTestId('run-attach-diagnostics'))
    await writes[0]
    fireEvent.click(screen.getByTestId('run-attach-diagnostics'))
    await writes[1]

    const row = db.runs.get('run_diag')!
    const attached = (row.annotations ?? []).filter((a) => a.kind === 'diagnostics')
    expect(attached).toHaveLength(1)
    expect(row.annotations).toHaveLength(2) // the warning stayed; the first attach was replaced
    expect(attached[0]).toMatchObject({
      level: 'notice',
      title: 'Diagnostics',
      message: `Client diagnostics attached from ${window.location.href}`,
    })
    expect((attached[0]?.data as { runId?: string }).runId).toBe('run_diag')
    expect(row.annotationCounts).toEqual({ error: 0, warning: 1, notice: 1 })
  })
})

describe('RunHeader — Follow run (apps#452)', () => {
  it('offers no toggle at all when the page passes no handler', () => {
    renderHeader({ follow: false })
    expect(screen.queryByTestId('run-follow')).not.toBeInTheDocument()
  })

  it('reads on while following, and asks the page to pin on click', () => {
    const onFollowChange = vi.fn()
    renderHeader({ status: 'running', finishedAt: null, follow: true, onFollowChange })

    const toggle = screen.getByTestId('run-follow')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('data-state', 'on')
    expect(toggle).toHaveTextContent('Follow run')

    fireEvent.click(toggle)
    expect(onFollowChange).toHaveBeenCalledWith(false)
  })

  it('reads off while pinned, and asks the page to follow on click', () => {
    const onFollowChange = vi.fn()
    renderHeader({ status: 'running', finishedAt: null, follow: false, onFollowChange })

    const toggle = screen.getByTestId('run-follow')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAttribute('data-state', 'off')

    fireEvent.click(toggle)
    expect(onFollowChange).toHaveBeenCalledWith(true)
  })
})
