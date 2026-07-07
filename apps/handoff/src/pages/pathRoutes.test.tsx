/**
 * Route-behavior tests for the path-URL pages (spec 2026-07-06): /tree/<path>
 * and /blob/<path> resolve server-side, and the legacy /folder/:id and
 * /view/:id routes redirect to their canonical path URLs. Exercises the real
 * route table + real page components against the MSW mock backend, same
 * `BasedRequest` origin workaround and store-construction pattern as
 * `src/store/resolvePath.test.ts`.
 */
import { useEffect } from 'react'
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import {
  handlers,
  resetMockState,
  seedFolder,
  seedFile,
  mockCurrentUser,
  ROOT_RECORD_ID,
} from '../mocks/handlers'
import { handoffApi } from '../store/handoffApi'
import handoffReducer from '../store/handoffSlice'
import { TreePage, BlobPage, LegacyFolderRedirect, LegacyViewRedirect } from './PathPages'

// `useSession` (FolderView, BlobPage, ViewerBody, LegacyViewRedirect) reads the
// reverse-proxied SuperTokens session (`/api/auth/session`) BEFORE it ever
// falls back to the built-in relay mock already in `handlers.ts`
// (`/_bffless/auth/session`). None of these route components need a guest vs.
// authenticated distinction for the behaviors under test here, so this mirrors
// the relay mock's shape off the same `mockCurrentUser` mock state, added to
// the base handler list (not a per-test `server.use()`) so it survives
// `server.resetHandlers()` between tests.
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

let lastPath = ''
function LocationSpy() {
  const loc = useLocation()
  useEffect(() => {
    lastPath = loc.pathname
  }, [loc.pathname])
  return null
}

function renderAt(entry: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[entry]}>
        <LocationSpy />
        <Routes>
          <Route index element={<div>HOME</div>} />
          <Route path="tree/*" element={<TreePage />} />
          <Route path="blob/*" element={<BlobPage />} />
          <Route path="view/:id" element={<LegacyViewRedirect />} />
          <Route path="folder/:id" element={<LegacyFolderRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  )
}

describe('path routes', () => {
  it('renders the folder listing at a nested /tree path', async () => {
    const a = seedFolder('Test', 'root')
    const b = seedFolder('Sub Folder', a.id)
    seedFile('My File.png', b.id)

    renderAt('/tree/Test/Sub%20Folder')

    expect(await screen.findByText('My File.png')).toBeInTheDocument()
  })

  it('self-heals /tree/<file path> to the canonical /blob URL', async () => {
    const a = seedFolder('Test', 'root')
    seedFile('My File.png', a.id)

    renderAt('/tree/Test/My%20File.png')

    // MemoryRouter (unlike a real browser `window.location`) keeps
    // `location.pathname` percent-encoded exactly as the `Navigate` target was
    // built, so the canonical URL here is `encodePath`'s output, not the
    // decoded path.
    await waitFor(() => expect(lastPath).toBe('/blob/Test/My%20File.png'))
  })

  it('redirects the legacy /folder/:id URL to the canonical /tree URL', async () => {
    const a = seedFolder('Test', 'root')
    const b = seedFolder('Sub Folder', a.id)

    renderAt('/folder/' + b.id)

    await waitFor(() => expect(lastPath).toBe('/tree/Test/Sub%20Folder'))
  })

  it('redirects the legacy /folder/:id URL to / when the id is the root record', async () => {
    // ShareLinkEntry sends a root-share guest to /folder/<R-uuid>. R has no
    // `path` (it isn't a structural-storage node), so before this fix it fell
    // through to <FolderView folderId={R-uuid} /> — an empty listing, since
    // top-level nodes are parented to the string 'root', not R's id.
    renderAt('/folder/' + ROOT_RECORD_ID)

    await waitFor(() => expect(lastPath).toBe('/'))
    expect(await screen.findByText('HOME')).toBeInTheDocument()
  })

  it('redirects the legacy /view/:id URL to the canonical /blob URL', async () => {
    const a = seedFolder('Test', 'root')
    const f = seedFile('My File.png', a.id)

    renderAt('/view/' + f.id)

    await waitFor(() => expect(lastPath).toBe('/blob/Test/My%20File.png'))
  })

  it('shows the not-found state for an unresolvable /tree path', async () => {
    renderAt('/tree/Nope')

    expect(await screen.findByText('Nothing found at this path.')).toBeInTheDocument()
  })
})
