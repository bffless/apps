/**
 * The feedback contract for a slow upload (issue: a dropped 300 MB file left
 * the UI silent for 30+ seconds). Drives the REAL drop → `uploadFile` path
 * against the MSW `/api/*` boundary, with `prepare` deliberately delayed, and
 * asserts the tray acknowledges the file *before* any byte work resolves —
 * then reports it done, and lets the user cancel one mid-flight.
 *
 * Same provider/MSW/BasedRequest harness as `folderBadge.test.tsx`.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { http, HttpResponse, delay } from 'msw'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, seedRoot, setMockUser, mockCurrentUser } from '../mocks/handlers'
import { handoffApi } from '../store/handoffApi'
import handoffReducer from '../store/handoffSlice'
import { FolderView } from './FolderView'
import { UploadTray } from '../components/UploadTray'
import { resetUploadsForTest, getUploads } from '../lib/uploads'

const sessionHandler = http.get('/api/auth/session', () => {
  if (!mockCurrentUser) return HttpResponse.json({ authenticated: false, user: null })
  return HttpResponse.json({
    authenticated: true,
    user: { id: mockCurrentUser.id, email: mockCurrentUser.email, role: mockCurrentUser.role },
  })
})

const server = setupServer(...handlers, sessionHandler)

const ORIGIN = 'http://localhost:3000'
const RealRequest = globalThis.Request
class BasedRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/')) input = ORIGIN + input
    super(input, init)
  }
}

const OWNER = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }

function makeStore() {
  return configureStore({
    reducer: { handoff: handoffReducer, [handoffApi.reducerPath]: handoffApi.reducer },
    middleware: (gDM) => gDM().concat(handoffApi.middleware),
  })
}

beforeAll(() => {
  globalThis.Request = BasedRequest as unknown as typeof Request
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  resetMockState()
  resetUploadsForTest()
  server.resetHandlers()
})
afterAll(() => {
  globalThis.Request = RealRequest
  server.close()
})

function renderRoot() {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={['/']}>
        <FolderView folderId="root" />
        <UploadTray />
      </MemoryRouter>
    </Provider>,
  )
}

/** Queries scoped to the tray — a finished file also appears in the listing. */
function tray() {
  return within(screen.getByRole('region', { name: 'Uploads' }))
}

/** A plain-files drop (no directory entries — that path is the folder import). */
function fileDrop(files: File[]) {
  return {
    dataTransfer: {
      files,
      items: files.map((f) => ({ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => f })),
      types: ['Files'],
    },
  }
}

describe('upload feedback', () => {
  it('acknowledges a dropped file before the upload has done any work', async () => {
    seedRoot()
    setMockUser(OWNER)
    // Hold `prepare` open: nothing about the upload can have progressed while
    // this is pending, so anything on screen is the immediate acknowledgement.
    let releasePrepare = () => {}
    const prepareReached = new Promise<void>((resolve) => {
      server.use(
        http.post('/api/uploads/prepare', async () => {
          resolve()
          await new Promise<void>((r) => {
            releasePrepare = r
          })
          return HttpResponse.error()
        }),
      )
    })

    const { container } = renderRoot()
    await screen.findByText('My Files')

    const file = new File(['x'.repeat(64)], 'demo-recording.mp4', { type: 'video/mp4' })
    fireEvent.drop(container.firstChild as Element, fileDrop([file]))

    // Visible immediately — no waiting on the network.
    expect(await screen.findByText('demo-recording.mp4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel upload of demo-recording.mp4' })).toBeVisible()

    await prepareReached
    releasePrepare()
  })

  it('queues every file of a multi-file drop up front', async () => {
    seedRoot()
    setMockUser(OWNER)
    // Slow the bytes down so the queue is observable — with the instant mock,
    // all three would be finished before the first assertion runs.
    server.use(
      http.put('/__mock_bucket/*', async () => {
        await delay(30)
        return undefined
      }),
    )
    const { container } = renderRoot()
    await screen.findByText('My Files')

    fireEvent.drop(
      container.firstChild as Element,
      fileDrop([
        new File(['a'], 'a.png', { type: 'image/png' }),
        new File(['b'], 'b.png', { type: 'image/png' }),
        new File(['c'], 'c.png', { type: 'image/png' }),
      ]),
    )

    expect(await screen.findByRole('region', { name: 'Uploads' })).toBeInTheDocument()
    expect(tray().getByText('a.png')).toBeInTheDocument()
    expect(tray().getByText('b.png')).toBeInTheDocument()
    expect(tray().getByText('c.png')).toBeInTheDocument()
    // The later two wait their turn rather than all racing the bucket at once.
    expect(tray().getAllByText('Queued').length).toBeGreaterThanOrEqual(2)

    await waitFor(() => expect(tray().getAllByText('Done')).toHaveLength(3), { timeout: 5000 })
  })

  it('reports a real upload through to Done', async () => {
    seedRoot()
    setMockUser(OWNER)
    const { container } = renderRoot()
    await screen.findByText('My Files')

    fireEvent.drop(
      container.firstChild as Element,
      fileDrop([new File(['hello'], 'notes.txt', { type: 'text/plain' })]),
    )

    expect(await screen.findByRole('region', { name: 'Uploads' })).toBeInTheDocument()
    expect(tray().getByText('notes.txt')).toBeInTheDocument()
    await waitFor(() => expect(tray().getByText('Done')).toBeInTheDocument())
  })

  it('surfaces a failed upload in the tray with its reason', async () => {
    seedRoot()
    setMockUser(OWNER)
    server.use(
      http.post('/api/uploads/prepare', async () => {
        await delay(5)
        return HttpResponse.json({ error: 'Storage unavailable' }, { status: 500 })
      }),
    )

    const { container } = renderRoot()
    await screen.findByText('My Files')

    fireEvent.drop(
      container.firstChild as Element,
      fileDrop([new File(['x'], 'broken.txt', { type: 'text/plain' })]),
    )

    expect(await screen.findByText('broken.txt')).toBeInTheDocument()
    await waitFor(() => expect(tray().getByText('1 upload failed')).toBeInTheDocument())
    expect(tray().getByText('Storage unavailable')).toBeInTheDocument()
  })

  it('cancelling a queued file stops it from ever uploading', async () => {
    seedRoot()
    setMockUser(OWNER)
    // Hold the first file's bytes on the wire so the second stays queued long
    // enough to cancel; `prepare` counts how many files actually started.
    const prepare = vi.fn()
    server.use(
      http.post('/api/uploads/prepare', async () => {
        prepare()
        return undefined // fall through to the base handler
      }),
      http.put('/__mock_bucket/*', async () => {
        await delay(50)
        return undefined
      }),
    )

    const { container } = renderRoot()
    await screen.findByText('My Files')

    fireEvent.drop(
      container.firstChild as Element,
      fileDrop([
        new File(['a'], 'first.png', { type: 'image/png' }),
        new File(['b'], 'second.png', { type: 'image/png' }),
      ]),
    )

    await screen.findByText('second.png')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload of second.png' }))

    await waitFor(() => {
      const second = getUploads().find((u) => u.name === 'second.png')
      expect(second?.status).toBe('canceled')
    })
    // Only the first file ever reached the server.
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
    expect(tray().getByText('Canceled')).toBeInTheDocument()
  })
})
