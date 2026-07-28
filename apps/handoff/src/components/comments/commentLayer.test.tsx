/**
 * The assembled margin-comments feature as the reader meets it (Task 12): the
 * viewer's Comments toggle, the gutter it opens, and the read-only posture an
 * anonymous visitor gets.
 *
 * These render the REAL route table (via `<App>`) against the MSW mock backend
 * — same `BasedRequest` origin workaround, `sessionHandler`, and store
 * construction as `../../pages/embedMode.test.tsx`, which is also where the
 * markdown-seeding helper comes from. jsdom measures nothing, so a seeded
 * thread lands in the panel's "Unanchored" rail; that is the point of the
 * fallback and exactly what a reader sees before geometry arrives.
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
  seedFolder,
  seedFile,
  setMockUser,
  setMockGrants,
  mockNodePath,
  mockCurrentUser,
  nodes,
  objects,
  comments,
  type MockComment,
} from '../../mocks/handlers'
import { ANYONE_PRINCIPAL } from '../../lib/acl'
import { handoffApi } from '../../store/handoffApi'
import handoffReducer from '../../store/handoffSlice'
import App from '../../App'
import { __resetSessionCache } from '../../lib/session'

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

const OWNER = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }

/** Seed a markdown File with real bytes; returns its id + canonical path. */
function seedMarkdown(name: string, parentId: string, body = '# Hello world') {
  const f = seedFile(name, parentId)
  const path = mockNodePath(f.id)!
  nodes.set(f.id, { ...nodes.get(f.id)!, url: `/api/uploads/content/${path}`, mime: 'text/markdown' })
  objects.set(path, { body: new TextEncoder().encode(body).buffer, type: 'text/markdown' })
  return { id: f.id, path }
}

/** Seed a root comment with a text anchor on `nodeId`. */
function seedComment(nodeId: string, over: Partial<MockComment> = {}): MockComment {
  const id = over.id ?? `c-${comments.size + 1}`
  const record: MockComment = {
    id,
    nodeId,
    parentId: '',
    authorId: OWNER.id,
    authorName: 'Owner',
    body: 'Tighten this heading',
    anchorJson: JSON.stringify({
      type: 'text', quote: 'Hello', prefix: '', suffix: '', start: 2, end: 7,
    }),
    resolved: false,
    resolvedBy: null,
    resolvedMs: null,
    reactionsJson: '{}',
    deleted: false,
    createdMs: Date.now(),
    updatedMs: null,
    ...over,
  }
  comments.set(record.id, record)
  return record
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

const commentsButton = () => screen.queryByRole('button', { name: /^comments/i })
const gutter = () => screen.queryByRole('complementary', { name: 'Comments' })

describe('viewer comment layer', () => {
  it('keeps the gutter closed until the Comments button is clicked', async () => {
    const folder = seedFolder('Posts', 'root')
    seedMarkdown('Post.md', folder.id)

    renderApp('/blob/Posts/Post.md')
    expect(await screen.findByTitle('Post.md')).toBeInTheDocument()

    expect(gutter()).toBeNull()

    const button = commentsButton()
    expect(button).toBeInTheDocument()
    fireEvent.click(button!)

    expect(gutter()).toBeInTheDocument()
  })

  it('badges the button with the open thread count', async () => {
    const folder = seedFolder('Posts', 'root')
    const { id: nodeId } = seedMarkdown('Post.md', folder.id)
    seedComment(nodeId, { id: 'c-open' })
    seedComment(nodeId, { id: 'c-done', resolved: true })

    renderApp('/blob/Posts/Post.md')
    expect(await screen.findByTitle('Post.md')).toBeInTheDocument()

    // One unresolved root → badge "1" (the resolved one doesn't nag).
    expect(await screen.findByTestId('comment-count-badge')).toHaveTextContent('1')
  })

  it('shows an existing thread read-only to an anonymous visitor', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Public', 'root')
    const { id: nodeId } = seedMarkdown('Post.md', folder.id)
    seedComment(nodeId, { id: 'c-1', body: 'Tighten this heading' })
    setMockGrants(folder.id, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])

    setMockUser(null)
    renderApp('/blob/Public/Post.md')
    expect(await screen.findByTitle('Post.md')).toBeInTheDocument()

    fireEvent.click(commentsButton()!)
    const panel = gutter()!

    // The thread is readable...
    expect(await within(panel).findByText('Tighten this heading')).toBeInTheDocument()
    // ...but every write affordance is replaced by the sign-in note.
    expect(within(panel).getByText('Sign in to comment')).toBeInTheDocument()
    expect(within(panel).queryByRole('textbox')).toBeNull()
    expect(within(panel).queryByRole('button', { name: /resolve/i })).toBeNull()
  })

  it('offers no Comments button for a non-commentable kind', async () => {
    const folder = seedFolder('Files', 'root')
    const f = seedFile('archive.zip', folder.id)
    nodes.set(f.id, { ...nodes.get(f.id)!, url: `/api/uploads/content/Files/archive.zip` })

    renderApp('/blob/Files/archive.zip')
    expect(await screen.findByText('Preview unavailable')).toBeInTheDocument()

    expect(commentsButton()).toBeNull()
  })

  it('offers no Comments button in embed mode', async () => {
    const folder = seedFolder('Posts', 'root')
    seedMarkdown('Post.md', folder.id)

    renderApp('/blob/Posts/Post.md?embed=1')
    expect(await screen.findByTitle('Post.md')).toBeInTheDocument()

    expect(commentsButton()).toBeNull()
    expect(gutter()).toBeNull()
  })
})
