/**
 * "Open in new tab" tests for the Handoff viewer.
 *
 * Markdown must NOT open its raw bytes: the content endpoint serves it as
 * text/markdown, which browsers download rather than render (the button became
 * a second Download). It opens the chromeless viewer instead. Every other kind
 * still opens its content URL directly.
 *
 * Same route-level harness as `embedMode.test.tsx` — the real route table over
 * the MSW mock backend, with the `BasedRequest` origin workaround.
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

/** Seed a markdown File with real bytes so the viewer renders MarkdownPreview. */
function seedMarkdown(name: string, parentId: string, body = '# Hello world'): string {
  const f = seedFile(name, parentId)
  const path = mockNodePath(f.id)!
  nodes.set(f.id, { ...nodes.get(f.id)!, url: `/api/uploads/content/${path}`, mime: 'text/markdown' })
  objects.set(path, { body: new TextEncoder().encode(body).buffer, type: 'text/markdown' })
  return path
}

/** Seed a PDF File — a kind whose raw content URL the browser renders fine. */
function seedPdf(name: string, parentId: string): string {
  const f = seedFile(name, parentId)
  const path = mockNodePath(f.id)!
  nodes.set(f.id, { ...nodes.get(f.id)!, url: `/api/uploads/content/${path}`, mime: 'application/pdf' })
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

describe('viewer "Open in new tab"', () => {
  it('opens the rendered doc — not the raw bytes — for Markdown', async () => {
    const folder = seedFolder('Posts', 'root')
    seedMarkdown('Post.md', folder.id)

    renderApp('/blob/Posts/Post.md')

    const open = await screen.findByTitle('Open in new tab')
    expect(open).toHaveAttribute('href', '/blob/Posts/Post.md?embed=1')
    expect(open).toHaveAttribute('target', '_blank')
  })

  it('opens the content URL directly for a PDF', async () => {
    const folder = seedFolder('Posts', 'root')
    seedPdf('Report.pdf', folder.id)

    renderApp('/blob/Posts/Report.pdf')

    const open = await screen.findByTitle('Open in new tab')
    expect(open).toHaveAttribute('href', '/api/uploads/content/Posts/Report.pdf')
  })
})
