/**
 * GeneralAccess: Public/Private state + toggle, driven by the Anyone grant.
 * Same store-construction + MSW pattern as src/pages/pathRoutes.test.tsx.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, setMockUser, seedFolder, setMockGrants } from '../mocks/handlers'
import { handoffApi, useGetNodeQuery } from '../store/handoffApi'
import handoffReducer from '../store/handoffSlice'
import { ANYONE_PRINCIPAL, type FolderLink } from '../lib/acl'
import { GeneralAccess, PeopleAccess } from './ManageAccessPanel'

const server = setupServer(...handlers)

// MSW/node needs absolute URLs; RTK Query issues relative ones (same
// workaround as pathRoutes.test.tsx).
const ORIGIN = 'http://localhost:3000'
const RealRequest = globalThis.Request
class BasedRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/')) input = ORIGIN + input
    super(input, init)
  }
}

beforeAll(() => {
  globalThis.Request = BasedRequest as typeof Request
  server.listen({ onUnhandledRequest: 'error' })
})
afterAll(() => {
  globalThis.Request = RealRequest
  server.close()
})
beforeEach(() => resetMockState())
afterEach(() => server.resetHandlers())

function makeStore() {
  return configureStore({
    reducer: { [handoffApi.reducerPath]: handoffApi.reducer, handoff: handoffReducer },
    middleware: (gdm) => gdm().concat(handoffApi.middleware),
  })
}

const OWNER = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }

/**
 * Mirrors how FolderView threads `folderMode` — from a live `getNode` query
 * that gets invalidated (and refetched) when `setNodeMode` succeeds — so the
 * "panel re-renders Private after confirming" behavior is exercised for
 * real, not asserted against a static prop.
 */
function EffectiveAccessHarness({ folderId, parentChain }: { folderId: string; parentChain: FolderLink[] }) {
  const { data } = useGetNodeQuery(folderId)
  return <GeneralAccess folderId={folderId} parentChain={parentChain} folderMode={data?.mode ?? 'inheriting'} />
}

describe('GeneralAccess', () => {
  it('shows Private and toggles to Public (adds the Anyone grant)', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    render(
      <Provider store={makeStore()}>
        <GeneralAccess folderId={folder.id} />
      </Provider>,
    )
    expect(await screen.findByText('Private')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Make public' }))
    expect(await screen.findByText('Public')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make private' })).toBeInTheDocument()
  })

  it('shows Public for a folder that already has the Anyone grant, and reverts', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    render(
      <Provider store={makeStore()}>
        <GeneralAccess folderId={folder.id} />
      </Provider>,
    )
    expect(await screen.findByText('Public')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Make private' }))
    expect(await screen.findByText('Private')).toBeInTheDocument()
  })

  it('shows effective Public from an inherited parentChain, confirms the cut-off, and reverts to Private', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    const parentChain: FolderLink[] = [
      { id: 'root', ownerId: 'someone-else', grants: [{ principalId: ANYONE_PRINCIPAL, level: 'view' }], mode: 'inheriting' },
    ]
    render(
      <Provider store={makeStore()}>
        <EffectiveAccessHarness folderId={folder.id} parentChain={parentChain} />
      </Provider>,
    )

    expect(await screen.findByText('Public')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Make private' }))

    const dialog = await screen.findByRole('dialog', { name: 'Make this folder private?' })
    expect(within(dialog).getByText('Make this folder private?')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'People who can only see it through a parent folder — including everyone on the internet while a parent is public — will lose access. People added directly to this folder keep access.',
      ),
    ).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Make private' }))

    expect(await screen.findByText('Private')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Make this folder private?' })).not.toBeInTheDocument()
  })

  it('folderMode:"restricted" overrides a public parentChain and shows Private', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    const parentChain: FolderLink[] = [
      { id: 'root', ownerId: 'someone-else', grants: [{ principalId: ANYONE_PRINCIPAL, level: 'view' }], mode: 'inheriting' },
    ]
    render(
      <Provider store={makeStore()}>
        <GeneralAccess folderId={folder.id} parentChain={parentChain} folderMode="restricted" />
      </Provider>,
    )
    expect(await screen.findByText('Private')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make public' })).toBeInTheDocument()
  })
})

describe('PeopleAccess hides the Anyone row', () => {
  it('does not list the anyone principal among people', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [
      { principalId: ANYONE_PRINCIPAL, level: 'view' },
      { principalId: 'u2', principalEmail: 'u2@example.com', level: 'view' },
    ])
    render(
      <Provider store={makeStore()}>
        <PeopleAccess folderId={folder.id} />
      </Provider>,
    )
    expect(await screen.findByText('u2@example.com')).toBeInTheDocument()
    expect(screen.queryByText(ANYONE_PRINCIPAL)).not.toBeInTheDocument()
  })
})
