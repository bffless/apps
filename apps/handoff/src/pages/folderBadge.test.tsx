/**
 * Render tests for the effective Public/Private badge + tinted folder icons
 * (task 5, spec 2026-07-06): FolderView's header badge is truthful for every
 * viewer once the ancestor chain resolves ("Public" or "Private", never just
 * silently absent), and a folder row's icon carries the accent tint whenever
 * `childIsPublic` says that child is effectively public. Same
 * provider/MSW/BasedRequest harness as `pathRoutes.test.tsx`.
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
  nodeAcl,
  mockCurrentUser,
  ROOT_RECORD_ID,
} from '../mocks/handlers'
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

describe('effective Public/Private badge + folder tints', () => {
  it('shows a Public badge and tints a child folder row when root carries an Anyone grant', async () => {
    seedRoot()
    setMockGrants(ROOT_RECORD_ID, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    const child = seedFolder('Docs', 'root')

    renderRoot()

    expect(await screen.findByText('Public')).toBeInTheDocument()
    const icon = await screen.findByTestId(`row-icon-${child.id}`)
    expect(icon.className).toContain('text-accent-600')
  })

  it('shows a Private badge and leaves the child folder row untinted without the root grant', async () => {
    seedRoot()
    const child = seedFolder('Docs', 'root')

    renderRoot()

    expect(await screen.findByText('Private')).toBeInTheDocument()
    const icon = await screen.findByTestId(`row-icon-${child.id}`)
    expect(icon.className).not.toContain('text-accent-600')
    expect(icon.className).toContain('text-folder')
  })

  it('leaves a restricted child folder under a public root untinted', async () => {
    seedRoot()
    setMockGrants(ROOT_RECORD_ID, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    const child = seedFolder('Restricted', 'root')
    const acl = nodeAcl.get(child.id)
    if (acl) acl.mode = 'restricted'

    renderRoot()

    // The root itself is still public — the badge reflects the folder we're IN.
    expect(await screen.findByText('Public')).toBeInTheDocument()
    const icon = await screen.findByTestId(`row-icon-${child.id}`)
    expect(icon.className).not.toContain('text-accent-600')
    expect(icon.className).toContain('text-folder')
  })
})
