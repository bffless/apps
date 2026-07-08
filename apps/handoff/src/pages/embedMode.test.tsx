/**
 * Embed-mode (`?embed=1`) tests for the Handoff viewer (Task 1 of the
 * reader-inline-markdown feature): an RSS reader iframes a markdown post's body
 * with NONE of the app chrome — only the rendered content.
 *
 * These render the REAL route table (via `<App>`, so both chrome layers —
 * `Shell` in App.tsx and `ViewerBody` in HandoffViewer.tsx — are exercised)
 * against the MSW mock backend, using the same `BasedRequest` origin workaround,
 * `sessionHandler`, and store-construction pattern as `pathRoutes.test.tsx`.
 *
 * A markdown File is seeded (name ending `.md` + a content URL) so the viewer
 * picks `MarkdownPreview`, whose same-origin content iframe surfaces titled by
 * the node name.
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
  seedFolder,
  seedFile,
  mockNodePath,
  mockCurrentUser,
  nodes,
  objects,
} from '../mocks/handlers'
import { handoffApi } from '../store/handoffApi'
import handoffReducer from '../store/handoffSlice'
import App from '../App'
import { __resetSessionCache } from '../lib/session'

// Mirrors the proxied SuperTokens session off the mock user (same rationale as
// pathRoutes.test.tsx). Added to the base handler list so it survives resets.
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

/**
 * Seed a markdown File with real content so the viewer renders `MarkdownPreview`
 * (whose iframe fetches `node.url` and sets `srcDoc`). `seedFile` leaves `url`
 * null; we set the verbatim content URL + store the bytes the mock content
 * endpoint serves. Returns the node's canonical path for the `/blob/<path>` URL.
 */
function seedMarkdown(name: string, parentId: string, body = '# Hello world'): string {
  const f = seedFile(name, parentId)
  const path = mockNodePath(f.id)! // e.g. "Posts/Post.md"
  nodes.set(f.id, { ...nodes.get(f.id)!, url: `/api/uploads/content/${path}`, mime: 'text/markdown' })
  objects.set(path, { body: new TextEncoder().encode(body).buffer, type: 'text/markdown' })
  return path
}

function renderApp(entry: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[entry]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

describe('viewer embed mode (?embed=1)', () => {
  it('renders only the content iframe — no Shell header, no ControlBar, no NodeDetails', async () => {
    const folder = seedFolder('Posts', 'root')
    seedMarkdown('Post.md', folder.id)

    renderApp('/blob/Posts/Post.md?embed=1')

    // The markdown content iframe surfaces, titled by the node name.
    expect(await screen.findByTitle('Post.md')).toBeInTheDocument()

    // Chrome is fully suppressed: no Shell wordmark, no ControlBar Back button,
    // no NodeDetails "Add title & description" affordance.
    expect(screen.queryByText('Handoff')).toBeNull()
    expect(screen.queryByRole('button', { name: /Back/i })).toBeNull()
    expect(screen.queryByText(/Add title/i)).toBeNull()
  })

  it('renders the full chrome without the param (no regression)', async () => {
    const folder = seedFolder('Posts', 'root')
    seedMarkdown('Post.md', folder.id)

    renderApp('/blob/Posts/Post.md')

    // Same content iframe still renders.
    expect(await screen.findByTitle('Post.md')).toBeInTheDocument()

    // ...alongside the Shell wordmark and the ControlBar Back button.
    expect(screen.getByText('Handoff')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Back/i })).toBeInTheDocument()
  })
})
