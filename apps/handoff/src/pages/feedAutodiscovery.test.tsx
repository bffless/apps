/**
 * Render tests for RSS feed autodiscovery (#192, ADR-0008): a FolderView for an
 * effectively-public folder advertises its tokenless feed in the document head
 * via `<link rel="alternate" type="application/rss+xml">`, and a private folder
 * advertises NOTHING (a discoverable link must never carry a token). Same
 * provider/MSW/BasedRequest harness as `folderBadge.test.tsx`.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
  mockCurrentUser,
  ROOT_RECORD_ID,
} from '../mocks/handlers'
import { ANYONE_PRINCIPAL } from '../lib/acl'
import { feedUrl } from '../lib/pathUrl'
import { handoffApi } from '../store/handoffApi'
import handoffReducer from '../store/handoffSlice'
import { FolderView } from './FolderView'

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

function renderFolder(folderId: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={['/']}>
        <FolderView folderId={folderId} />
      </MemoryRouter>
    </Provider>,
  )
}

/** The autodiscovery link, or null when none is advertised. */
function feedLink(): HTMLLinkElement | null {
  return document.head.querySelector<HTMLLinkElement>(
    'link[rel="alternate"][type="application/rss+xml"]',
  )
}

describe('RSS feed autodiscovery', () => {
  it('advertises the tokenless feed for a public root folder', async () => {
    seedRoot()
    setMockGrants(ROOT_RECORD_ID, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])

    renderFolder('root')

    // Badge confirms the folder resolved as effectively public…
    expect(await screen.findByText('Public')).toBeInTheDocument()
    // …and the head carries the tokenless root feed link.
    const link = feedLink()
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe(feedUrl(''))
    expect(link?.getAttribute('href')).not.toContain('token')
  })

  it('advertises NO feed for a private folder (no token leak)', async () => {
    seedRoot()

    renderFolder('root')

    // Once the badge says Private, the head must not carry an autodiscovery link.
    expect(await screen.findByText('Private')).toBeInTheDocument()
    expect(feedLink()).toBeNull()
  })

  it('advertised href matches feedUrl() for a public sub-folder', async () => {
    seedRoot()
    setMockGrants(ROOT_RECORD_ID, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    const child = seedFolder('Docs', 'root')

    renderFolder(child.id)

    await waitFor(() => expect(feedLink()).not.toBeNull())
    expect(feedLink()?.getAttribute('href')).toBe(feedUrl('Docs'))
  })

  it('removes the autodiscovery link when the folder view unmounts', async () => {
    seedRoot()
    setMockGrants(ROOT_RECORD_ID, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])

    const { unmount } = renderFolder('root')
    await waitFor(() => expect(feedLink()).not.toBeNull())

    unmount()
    expect(feedLink()).toBeNull()
  })
})
