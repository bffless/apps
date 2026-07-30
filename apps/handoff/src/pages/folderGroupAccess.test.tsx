/**
 * FolderView-level coverage for group-aware `canWrite`/`canManage`
 * (group-sharing plan, Task 7): a group `edit` grant unlocks the write
 * affordances (the "New" add menu) for a member of that group, but never
 * `canManage` (the "Share" button) — group membership can promote to `edit`,
 * never `owner`. A group `view` grant unlocks neither. A non-member of the
 * granted group gets nothing. And while `/api/me/groups` is unresolved (404 —
 * simulating old CE), the viewer sees exactly today's ungrouped affordances.
 *
 * Same provider/MSW/BasedRequest harness as `folderBadge.test.tsx`, plus the
 * `__resetSessionCache()` teardown from `viewerVisibility.test.tsx` since this
 * file renders as more than one distinct user.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
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
  setMockGrants,
  setMockUser,
  mockCurrentUser,
} from '../mocks/handlers'
import { __resetSessionCache } from '../lib/session'
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

const OWNER = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }

function renderFolder(folderId: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={['/']}>
        <FolderView folderId={folderId} />
      </MemoryRouter>
    </Provider>,
  )
}

describe('FolderView — group-aware canWrite/canManage', () => {
  it('an edit-granted group member gets the New menu but never Share (edit, not owner)', async () => {
    seedRoot()
    setMockUser(OWNER)
    const folder = seedFolder('Team Docs', 'root')
    setMockGrants(folder.id, [{ principalId: 'group-eng', principalType: 'group', level: 'edit' }])

    setMockUser({ id: 'user-member', email: 'member@example.com', role: 'user', groups: ['group-eng'] })
    renderFolder(folder.id)

    expect(await screen.findByRole('button', { name: /New/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
  })

  it('a non-member of the granted group has no access at all (the folder has no other grant)', async () => {
    seedRoot()
    setMockUser(OWNER)
    const folder = seedFolder('Team Docs', 'root')
    setMockGrants(folder.id, [{ principalId: 'group-eng', principalType: 'group', level: 'edit' }])

    setMockUser({ id: 'user-outsider', email: 'outsider@example.com', role: 'user', groups: ['group-design'] })
    renderFolder(folder.id)

    // The grant is the outsider's only possible path in — evaluateAccess
    // correctly yields 'none', not just write-denied, so the listing itself
    // 401s instead of rendering the folder's contents.
    expect(await screen.findByText("You don't have access to this folder.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
  })

  it('a view-only group grant unlocks neither New nor Share', async () => {
    seedRoot()
    setMockUser(OWNER)
    const folder = seedFolder('Team Docs', 'root')
    setMockGrants(folder.id, [{ principalId: 'group-eng', principalType: 'group', level: 'view' }])

    setMockUser({ id: 'user-member', email: 'member@example.com', role: 'user', groups: ['group-eng'] })
    renderFolder(folder.id)

    expect(await screen.findByText('Team Docs')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
  })

  it("a 404 from /api/me/groups (old CE) renders exactly today's affordances — no group promotion, no crash", async () => {
    seedRoot()
    setMockUser(OWNER)
    const folder = seedFolder('Team Docs', 'root')
    setMockGrants(folder.id, [{ principalId: 'group-eng', principalType: 'group', level: 'edit' }])

    server.use(http.get('/api/me/groups', () => new HttpResponse(null, { status: 404 })))

    setMockUser({ id: 'user-member', email: 'member@example.com', role: 'user', groups: ['group-eng'] })
    renderFolder(folder.id)

    expect(await screen.findByText('Team Docs')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
  })
})
