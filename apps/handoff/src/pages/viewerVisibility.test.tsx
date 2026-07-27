/**
 * Effective-visibility tests for the file viewer (`/blob/<path>`).
 *
 * Issue #253 (bug): the viewer's ControlBar opened ShareDialog with only
 * `folderId={node.parentId}` — no `parentChain`/`folderMode` — so the dialog
 * fell back to "own-grant state only" and reported an inherited-public file as
 * Private (while the same content opened fine anonymously). FolderView got the
 * per-target chain fix (shareTargetParentChain.test.tsx); the viewer was left
 * behind.
 *
 * Issue #254 (feature): the viewer showed no visibility indicator at all — the
 * effective Public/Private badge existed only on folder pages. These tests pin
 * the same badge (truthful once the chain + rootMeta resolve, no "Private"
 * flash while loading) next to the file name in the viewer.
 *
 * Same route-level harness as `viewerOpen.test.tsx` (real route table over the
 * MSW mock backend, BasedRequest origin workaround), plus the <dialog>
 * polyfill from `shareTargetParentChain.test.tsx` for the native ShareDialog.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import {
  handlers,
  resetMockState,
  seedRoot,
  seedFolder,
  seedFile,
  setMockGrants,
  mockCurrentUser,
  ROOT_RECORD_ID,
} from '../mocks/handlers'
import { ANYONE_PRINCIPAL } from '../lib/acl'
import { handoffApi } from '../store/handoffApi'
import handoffReducer from '../store/handoffSlice'
import App from '../App'
import { __resetSessionCache } from '../lib/session'

const sessionHandler = http.get('/api/auth/session', () => {
  if (!mockCurrentUser) {
    return HttpResponse.json({ authenticated: false, user: null })
  }
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

function makeStore() {
  return configureStore({
    reducer: {
      handoff: handoffReducer,
      [handoffApi.reducerPath]: handoffApi.reducer,
    },
    middleware: (gDM) => gDM().concat(handoffApi.middleware),
  })
}

beforeAll(() => {
  globalThis.Request = BasedRequest as unknown as typeof Request
  // jsdom has no matchMedia; Shell's useMediaQuery calls it non-optionally.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  // jsdom does not implement <dialog>'s showModal()/close() — see
  // shareTargetParentChain.test.tsx for the rationale of this scoped polyfill.
  if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true
    }
  }
  if (typeof HTMLDialogElement.prototype.close !== 'function') {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false
      this.dispatchEvent(new Event('close'))
    }
  }
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  resetMockState()
  server.resetHandlers()
  __resetSessionCache()
})
afterAll(() => {
  globalThis.Request = RealRequest
  server.close()
})

function renderApp(entry: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[entry]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

/** The single open ShareDialog's native <dialog> element. */
function getShareDialog(): HTMLElement {
  const dlg = document.querySelector('dialog.share-dialog')
  if (!dlg) throw new Error('ShareDialog <dialog> not found')
  return dlg as HTMLElement
}

describe('viewer Share dialog — inherited publicness (#253)', () => {
  it('shows Public for a file whose folder inherits publicness from a public root', async () => {
    seedRoot()
    setMockGrants(ROOT_RECORD_ID, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    const reports = seedFolder('Reports', 'root')
    seedFile('review.txt', reports.id)

    renderApp('/blob/Reports/review.txt')

    fireEvent.click(await screen.findByRole('button', { name: 'Share' }))

    const dialog = getShareDialog()
    // Before the fix: the dialog was handed no parentChain, so the root's
    // Anyone grant was invisible and this read "Private" / "Make public" for
    // a file anyone on the internet could open.
    expect(await within(dialog).findByText('Public')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Make private' })).toBeInTheDocument()
  })

  it('routes Make private through the inheritance cut-off confirm for an inherited-public file', async () => {
    seedRoot()
    setMockGrants(ROOT_RECORD_ID, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    const reports = seedFolder('Reports', 'root')
    seedFile('review.txt', reports.id)

    renderApp('/blob/Reports/review.txt')

    fireEvent.click(await screen.findByRole('button', { name: 'Share' }))

    const dialog = getShareDialog()
    expect(await within(dialog).findByText('Public')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make private' }))

    // Inherited publicness must route through the parent-cutoff confirm —
    // a bare revoke of the folder's own (nonexistent) Anyone grant would
    // leave the file publicly reachable.
    expect(
      await screen.findByRole('dialog', { name: 'Make this folder private?' }),
    ).toBeInTheDocument()
  })

  it('still shows Private for a file in a genuinely private folder', async () => {
    seedRoot()
    const reports = seedFolder('Reports', 'root')
    seedFile('review.txt', reports.id)

    renderApp('/blob/Reports/review.txt')

    fireEvent.click(await screen.findByRole('button', { name: 'Share' }))

    const dialog = getShareDialog()
    expect(await within(dialog).findByText('Private')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Make public' })).toBeInTheDocument()
  })
})

describe('viewer effective-visibility badge (#254)', () => {
  it('shows a Public badge on the viewer for a file that inherits publicness', async () => {
    seedRoot()
    setMockGrants(ROOT_RECORD_ID, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    const reports = seedFolder('Reports', 'root')
    seedFile('review.txt', reports.id)

    renderApp('/blob/Reports/review.txt')

    // The badge renders in the viewer chrome itself — no dialog open.
    expect(await screen.findByText('Public')).toBeInTheDocument()
  })

  it('shows a Private badge on the viewer for a file in a private folder', async () => {
    seedRoot()
    const reports = seedFolder('Reports', 'root')
    seedFile('review.txt', reports.id)

    renderApp('/blob/Reports/review.txt')

    expect(await screen.findByText('Private')).toBeInTheDocument()
  })

  it('shows a Public badge for a file directly in a public folder (own Anyone grant)', async () => {
    seedRoot()
    const reports = seedFolder('Reports', 'root')
    setMockGrants(reports.id, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    seedFile('review.txt', reports.id)

    renderApp('/blob/Reports/review.txt')

    expect(await screen.findByText('Public')).toBeInTheDocument()
  })
})
