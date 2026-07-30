/**
 * PeopleAccess — Groups section in the share dialog (group-sharing plan,
 * Task 8). The people-picker becomes a two-section picker (People / Groups);
 * group rows in the access list render the snapshot name + a live member
 * count; everything degrades to today's people-only UI when `/api/groups`
 * 404s (old CE). Same store-construction + MSW pattern as generalAccess.test.tsx.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { handlers, resetMockState, setMockUser, seedFolder, setMockGrants } from '../mocks/handlers'
import { handoffApi } from '../store/handoffApi'
import handoffReducer from '../store/handoffSlice'
import { PeopleAccess } from './ManageAccessPanel'

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

function renderPanel(folderId: string) {
  return render(
    <Provider store={makeStore()}>
      <PeopleAccess folderId={folderId} />
    </Provider>,
  )
}

/** The picker's results dropdown — scoped so its "People"/"Groups" section
 * headers can be asserted independent of the panel's own static "People" title. */
async function findResults() {
  return screen.findByTestId('principal-results')
}

describe('PeopleAccess — two-section picker (People / Groups)', () => {
  it('shows a People section and a Groups section when both sources have matches', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    server.use(
      http.get('/api/directory', () =>
        HttpResponse.json({ users: [{ id: 'user-alice', email: 'alice@example.com' }] }),
      ),
      http.get('/api/groups', () =>
        HttpResponse.json({ groups: [{ id: 'group-eng', name: 'Engineering', memberCount: 3 }] }),
      ),
    )
    renderPanel(folder.id)

    fireEvent.change(screen.getByPlaceholderText('Search people by email…'), { target: { value: 'en' } })

    const results = await findResults()
    expect(within(results).getByText('alice@example.com')).toBeInTheDocument()
    expect(within(results).getByText('Engineering')).toBeInTheDocument()
    expect(within(results).getByText('People')).toBeInTheDocument()
    expect(within(results).getByText('Groups')).toBeInTheDocument()
    expect(within(results).getByText(/3 members/)).toBeInTheDocument()
  })

  it("renders a flat list with no section headers for people-only results (today's UI)", async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    server.use(
      http.get('/api/directory', () =>
        HttpResponse.json({ users: [{ id: 'user-alice', email: 'alice@example.com' }] }),
      ),
      http.get('/api/groups', () => HttpResponse.json({ groups: [] })),
    )
    renderPanel(folder.id)

    fireEvent.change(screen.getByPlaceholderText('Search people by email…'), { target: { value: 'al' } })

    const results = await findResults()
    expect(within(results).getByText('alice@example.com')).toBeInTheDocument()
    expect(within(results).queryByText('People')).not.toBeInTheDocument()
    expect(within(results).queryByText('Groups')).not.toBeInTheDocument()
  })

  it('selecting a group row calls addGrant with principalType/principalName and adds it to the access list', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    server.use(
      http.get('/api/directory', () => HttpResponse.json({ users: [] })),
      http.get('/api/groups', () =>
        HttpResponse.json({ groups: [{ id: 'group-eng', name: 'Engineering', memberCount: 3 }] }),
      ),
    )
    renderPanel(folder.id)

    fireEvent.change(screen.getByPlaceholderText('Search people by email…'), { target: { value: 'eng' } })
    const option = await screen.findByRole('button', { name: /Engineering/ })
    fireEvent.mouseDown(option)

    // The real /api/grants handler (unmocked here) only stores principalType:
    // 'group' + principalName when the request body actually carries them
    // (see mocks/handlers.ts and store/groups.test.ts) — a group icon +
    // principalName in the resulting grant row is proof the POST body was
    // { principalId: 'group-eng', principalType: 'group', principalName:
    // 'Engineering', level: 'view' }.
    const grantsList = await screen.findByTestId('grants-list')
    expect(within(grantsList).getByTestId('grant-icon-group-eng')).toBeInTheDocument()
    expect(within(grantsList).getByText('Engineering')).toBeInTheDocument()
  })

  it('renders a group grant with the group icon, principalName, level badge, and revoke button', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [
      { principalId: 'group-eng', principalType: 'group', principalName: 'Engineering', level: 'view' },
    ])
    renderPanel(folder.id)

    expect(await screen.findByText('Engineering')).toBeInTheDocument()
    expect(screen.getByTestId('grant-icon-group-eng')).toBeInTheDocument()
    expect(screen.getByText('Can view')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument()
  })

  it('falls back to principalId when principalName is missing on a group grant', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [{ principalId: 'group-eng', principalType: 'group', level: 'view' }])
    renderPanel(folder.id)

    expect(await screen.findByText('group-eng')).toBeInTheDocument()
  })

  it('appends the member count only when the granted group is present in the current searchGroups data', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [
      { principalId: 'group-eng', principalType: 'group', principalName: 'Engineering', level: 'view' },
    ])
    server.use(
      http.get('/api/directory', () => HttpResponse.json({ users: [] })),
      http.get('/api/groups', () =>
        HttpResponse.json({ groups: [{ id: 'group-eng', name: 'Engineering', memberCount: 3 }] }),
      ),
    )
    renderPanel(folder.id)

    // Before any search, no groups data is loaded — name-only.
    const grantsList = await screen.findByTestId('grants-list')
    expect(within(grantsList).getByText('Engineering')).toBeInTheDocument()
    expect(within(grantsList).queryByText(/members/)).not.toBeInTheDocument()

    // Search brings group-eng into the current searchGroups data — count appears
    // on the grant row (scoped to grants-list — the picker dropdown shows its
    // own "3 members" text for the same group at the same time).
    fireEvent.change(screen.getByPlaceholderText('Search people by email…'), { target: { value: 'eng' } })
    expect(await within(grantsList).findByText(/3 members/)).toBeInTheDocument()
  })

  it('renders a group grant name-only when the group no longer exists in the directory (deleted group)', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [
      { principalId: 'group-ghost', principalType: 'group', principalName: 'Old Team', level: 'view' },
    ])
    server.use(
      http.get('/api/directory', () => HttpResponse.json({ users: [] })),
      http.get('/api/groups', () => HttpResponse.json({ groups: [] })),
    )
    renderPanel(folder.id)

    fireEvent.change(screen.getByPlaceholderText('Search people by email…'), { target: { value: 'gh' } })

    expect(await screen.findByText('Old Team')).toBeInTheDocument()
    expect(screen.queryByText(/members/)).not.toBeInTheDocument()
  })

  it('404 from /api/groups suppresses the Groups section entirely; people search is unaffected', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    server.use(
      http.get('/api/directory', () =>
        HttpResponse.json({ users: [{ id: 'user-alice', email: 'alice@example.com' }] }),
      ),
      http.get('/api/groups', () => new HttpResponse(null, { status: 404 })),
    )
    renderPanel(folder.id)

    fireEvent.change(screen.getByPlaceholderText('Search people by email…'), { target: { value: 'al' } })

    const results = await findResults()
    expect(within(results).getByText('alice@example.com')).toBeInTheDocument()
    expect(within(results).queryByText('Groups')).not.toBeInTheDocument()
    expect(within(results).queryByText('People')).not.toBeInTheDocument()
  })

  it('404 from /api/groups still lets a pre-existing group grant render name-only, no crash', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [
      { principalId: 'group-eng', principalType: 'group', principalName: 'Engineering', level: 'view' },
    ])
    server.use(http.get('/api/groups', () => new HttpResponse(null, { status: 404 })))
    renderPanel(folder.id)

    expect(await screen.findByText('Engineering')).toBeInTheDocument()
    expect(screen.queryByText(/members/)).not.toBeInTheDocument()
  })
})
