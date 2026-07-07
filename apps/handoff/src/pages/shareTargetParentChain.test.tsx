/**
 * Render test for the Critical reviewed finding on the "effective Public/
 * Private UI" feature: FolderView's single ShareDialog call site computed
 * `parentChain`/`folderMode` once for the PAGE folder, even though the row
 * kebab also opens Share for FOLDER rows. A subfolder row's Share dialog was
 * shown the page folder's own chain/mode instead of its own — a fresh
 * subfolder's Share dialog incorrectly read "Private" (the exact bug the
 * effective-public feature exists to fix).
 *
 * The repro needs the PAGE folder itself to carry a direct Anyone grant, one
 * level below the account root — NOT literal root. At literal root,
 * `buildAncestorFolderChain` returns the synthetic root FolderLink's REAL
 * record id (`ROOT_RECORD_ID`), which never equals the page's `folderId`
 * prop (the `'root'` sentinel string) — so FolderView's own
 * `chainTail?.id === folderId` strip guard never fires there, and the
 * page-level `parentChain` happens to equal the full chain (bug or no bug).
 * One level in, the page folder's own resolved node DOES land in the chain
 * with `id === folderId`, so the strip guard fires for real — exercising the
 * exact code path this fix targets. See FolderView.tsx's `parentChain` /
 * `folderChainIncludingCurrent` comments.
 *
 * Same provider/MSW/BasedRequest harness as `folderBadge.test.tsx`.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, seedRoot, seedFolder, setMockGrants, mockCurrentUser, ROOT_RECORD_ID } from '../mocks/handlers'
import { ANYONE_PRINCIPAL } from '../lib/acl'
import { handoffApi } from '../store/handoffApi'
import handoffReducer from '../store/handoffSlice'
import { FolderView } from './FolderView'

// See pathRoutes.test.tsx — FolderView reads the reverse-proxied SuperTokens
// session (`/api/auth/session`) before it ever falls back to the built-in
// relay mock already in `handlers.ts`.
const sessionHandler = http.get('/api/auth/session', () => {
  if (!mockCurrentUser) {
    return HttpResponse.json({ authenticated: false, user: null })
  }
  return HttpResponse.json({
    authenticated: true,
    user: {
      id: mockCurrentUser.id,
      email: mockCurrentUser.email,
      role: mockCurrentUser.role,
    },
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
  // jsdom does not implement <dialog>'s showModal()/close() — ShareDialog
  // (src/components/ShareDialog.tsx) is a native <dialog> that calls
  // showModal() on mount, which would otherwise throw
  // "dlg.showModal is not a function" the moment any test opens it. No
  // existing test in this app renders the native ShareDialog yet
  // (generalAccess.test.tsx only renders its GeneralAccess/PeopleAccess
  // sub-pieces, and the other role="dialog" surfaces in this app are plain
  // divs) — this is a minimal, scoped polyfill for this file only.
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

describe('ShareDialog parentChain/folderMode — per share target (Critical finding)', () => {
  it('regression guard: the current-folder (toolbar) Share still shows Public at a public root', async () => {
    seedRoot()
    setMockGrants(ROOT_RECORD_ID, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])

    renderRoot()

    // Sanity: the page header itself is Public.
    expect(await screen.findByText('Public')).toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: 'Share' }))

    const dialog = getShareDialog()
    expect(await within(dialog).findByText('Public')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Make private' })).toBeInTheDocument()
  })

  it('Make private at a public root revokes directly — no confirm dialog, no mode PATCH (Important finding)', async () => {
    // At literal root, `folderChain`'s tail carries the resolved root RECORD
    // id (a UUID), never the `folderId` sentinel string 'root' — so the
    // page-target `parentChain` strip guard in FolderView can't fire there,
    // and the toolbar Share dialog was handed the UNSTRIPPED `[rootLink]`
    // chain (root's own Anyone grant, double-counted as "inherited"). That
    // made GeneralAccess treat root's own publicness as inherited-from-parent
    // and route "Make private" through MakePrivateConfirmDialog (whose
    // parent-folder copy is nonsensical at root — root has no parent) and
    // then PATCH `setNodeMode({id:'root', mode:'restricted'})`, which the
    // mock (mirroring the live rule) 400s since 'root' isn't a folder node id.
    seedRoot()
    setMockGrants(ROOT_RECORD_ID, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])

    renderRoot()

    expect(await screen.findByText('Public')).toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: 'Share' }))

    const dialog = getShareDialog()
    // Wait for GeneralAccess's own grants query to resolve before querying
    // for its toggle button — otherwise it's still `null` (isLoading).
    expect(await within(dialog).findByText('Public')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make private' }))

    // No confirm dialog — root's publicness is judged from its OWN grant
    // only, so revoking it directly is enough (no parent to cut off from).
    expect(screen.queryByText('Make this folder private?')).not.toBeInTheDocument()

    // The Anyone grant is revoked directly and the section flips to Private.
    expect(await within(dialog).findByText('Private')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Make public' })).toBeInTheDocument()
  })

  it('a fresh subfolder row Share dialog shows Public (inherited from its parent), not Private, when the page folder itself is public', async () => {
    seedRoot()
    const docs = seedFolder('Docs', 'root')
    setMockGrants(docs.id, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    const reports = seedFolder('Reports', docs.id)

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <FolderView folderId={docs.id} />
        </MemoryRouter>
      </Provider>,
    )

    // Sanity: the page (Docs) itself reads Public via its own Anyone grant.
    expect(await screen.findByText('Public')).toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${reports.name}` }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share…' }))

    const dialog = getShareDialog()
    // Before the fix: Reports's ShareDialog was handed the PAGE folder's
    // (Docs's) own `parentChain` — root→Docs with Docs's OWN link stripped
    // off (correct for sharing Docs itself, since Docs isn't its own
    // parent). But Reports's parent IS Docs, so Reports needs Docs's own
    // link — and its Anyone grant — INCLUDED. The stripped chain drops the
    // only source of publicness here, showing "Private" / "Make public" for
    // a folder that is, in fact, effectively public through its parent.
    expect(await within(dialog).findByText('Public')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Make private' })).toBeInTheDocument()
  })
})

describe('Live chain tail / live row mode after mutations (final-review Important findings)', () => {
  it('the HEADER badge on a non-root page folder flips to Private after a direct revoke, with no remount (Finding 1)', async () => {
    // `AncestorNodesInner.handleResolved` is first-write-wins, so once Docs's
    // own node has landed in the ancestor map its cached entry never gets
    // replaced by a later refetch — before the fix, `folderChain`'s tail
    // (Docs itself, once the walk is complete) stayed stale after the toolbar
    // Share dialog's "Make private" revoked Docs's own Anyone grant, so the
    // HEADER kept reading "Public" even though the dialog (which reads grants
    // live) correctly flipped.
    seedRoot()
    const docs = seedFolder('Docs', 'root')
    setMockGrants(docs.id, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <FolderView folderId={docs.id} />
        </MemoryRouter>
      </Provider>,
    )

    const heading = await screen.findByRole('heading', { level: 1, name: 'Docs' })
    const header = heading.parentElement!
    await waitFor(() => expect(header.textContent).toContain('Public'))

    fireEvent.click(screen.getByRole('button', { name: 'Share' }))

    const dialog = getShareDialog()
    // Docs is public purely via its own grant (no public ancestor) — wait for
    // GeneralAccess's own grants query to resolve before reading its state.
    expect(await within(dialog).findByText('Public')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make private' }))

    // Own-grant-only publicness → direct revoke, no parent-cutoff confirm.
    expect(screen.queryByText('Make this folder private?')).not.toBeInTheDocument()
    expect(await within(dialog).findByText('Private')).toBeInTheDocument()

    // The bug: this assertion failed before the fix — the header stayed
    // "Public" until a remount (e.g. navigating away and back).
    await waitFor(() => expect(header.textContent).toContain('Private'))
  })

  it('a row Share dialog reflects its OWN cut-off live — no confirm loop (Finding 2)', async () => {
    // Docs (the page folder) is public via its own grant; Reports is a fresh
    // subfolder row that inherits that publicness (mode defaults to
    // 'inheriting'). Before the fix, the row's `mode` was captured on the
    // ShareTarget at click time and never re-read — after the PATCH succeeds
    // and the listing refetches with mode:'restricted', the STILL-OPEN
    // dialog kept computing `inheritedPublic` from the stale 'inheriting'
    // mode, so it kept showing Public/"Make private" (a confirm loop).
    seedRoot()
    const docs = seedFolder('Docs', 'root')
    setMockGrants(docs.id, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    const reports = seedFolder('Reports', docs.id)

    render(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/']}>
          <FolderView folderId={docs.id} />
        </MemoryRouter>
      </Provider>,
    )

    // Sanity: the page (Docs) itself reads Public via its own Anyone grant.
    expect(await screen.findByText('Public')).toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${reports.name}` }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share…' }))

    const dialog = getShareDialog()
    // Reports inherits Docs's publicness (mode defaults to 'inheriting').
    expect(await within(dialog).findByText('Public')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make private' }))

    // Inherited publicness routes through the parent-cutoff confirm dialog.
    const confirmDialog = await screen.findByRole('dialog', { name: 'Make this folder private?' })
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Make private' }))

    // The bug: before the fix, these assertions failed — the dialog kept
    // showing Public/"Make private" forever (confirm loop) because
    // `shareFolderMode` never re-read the row's live mode.
    expect(await within(dialog).findByText('Private')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Make public' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Make this folder private?' })).not.toBeInTheDocument()
  })
})
