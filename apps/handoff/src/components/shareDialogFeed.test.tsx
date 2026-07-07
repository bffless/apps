/**
 * ShareDialog: the tokenless "Copy RSS feed URL" affordance (#188) — shown for
 * an effectively-public folder target, hidden for private and file targets.
 * Same store + MSW pattern as generalAccess.test.tsx.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, setMockUser, seedFolder, setMockGrants } from '../mocks/handlers'
import { handoffApi } from '../store/handoffApi'
import handoffReducer from '../store/handoffSlice'
import { ANYONE_PRINCIPAL } from '../lib/acl'
import { ShareDialog } from './ShareDialog'

const server = setupServer(...handlers)

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
  // jsdom doesn't implement <dialog> modal methods.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
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

function renderDialog(props: Partial<React.ComponentProps<typeof ShareDialog>>) {
  const store = makeStore()
  return render(
    <Provider store={store}>
      <ShareDialog folderId="f-1" title="Docs" onClose={() => {}} {...props} />
    </Provider>,
  )
}

describe('ShareDialog — public RSS feed URL', () => {
  it('offers a tokenless Copy RSS feed URL for a public folder', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])

    renderDialog({ folderId: folder.id, feedPath: 'Docs' })

    const btn = await screen.findByRole('button', { name: 'Copy RSS feed URL' })
    expect(btn).toBeTruthy()
    expect(screen.getByText(`${ORIGIN}/feed/Docs.xml`)).toBeTruthy()

    // Copy writes the tokenless URL to the clipboard.
    let written = ''
    Object.assign(navigator, {
      clipboard: { writeText: (t: string) => ((written = t), Promise.resolve()) },
    })
    fireEvent.click(btn)
    expect(written).toBe(`${ORIGIN}/feed/Docs.xml`)
  })

  it('hides the RSS URL for a private folder', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Secret', 'root')
    setMockGrants(folder.id, [])

    renderDialog({ folderId: folder.id, feedPath: 'Secret' })

    // Wait for the grants query to resolve (People section renders).
    await screen.findByText(/Only you can see this folder/i)
    expect(screen.queryByRole('button', { name: 'Copy RSS feed URL' })).toBeNull()
  })

  it('hides the RSS URL for a file target even when public', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])

    renderDialog({ folderId: folder.id, feedPath: 'Docs', isFile: true, nodeId: 'file-1', title: 'a.png' })

    await screen.findByText(/opens this file directly/i)
    expect(screen.queryByRole('button', { name: 'Copy RSS feed URL' })).toBeNull()
  })
})

describe('ShareDialog — per-share-link private RSS (#189)', () => {
  it('offers a tokened Copy RSS on each share link of a private folder', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Secret', 'root')
    setMockGrants(folder.id, [])

    renderDialog({ folderId: folder.id, feedPath: 'Secret' })

    // No public feed row for a private folder.
    await screen.findByText(/Only you can see this folder/i)
    expect(screen.queryByRole('button', { name: 'Copy RSS feed URL' })).toBeNull()

    // Mint a link → it appears in the active list with a Copy RSS action.
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    const rssBtn = await screen.findByRole('button', { name: 'Copy RSS' })

    let written = ''
    Object.assign(navigator, {
      clipboard: { writeText: (t: string) => ((written = t), Promise.resolve()) },
    })
    fireEvent.click(rssBtn)
    // The private feed URL is the folder's tokenless feed + the link's token.
    expect(written).toMatch(new RegExp(`^${ORIGIN}/feed/Secret\\.xml\\?token=mock-token-\\d+$`))
  })

  it('does not offer Copy RSS on a file-direct share link', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    setMockGrants(folder.id, [])

    renderDialog({ folderId: folder.id, isFile: true, nodeId: 'file-1', title: 'a.png' })

    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    // Wait for the link to land in the active list (its Revoke action), then
    // assert no RSS action exists for a file target.
    await screen.findByRole('button', { name: 'Revoke' })
    expect(screen.queryByRole('button', { name: 'Copy RSS' })).toBeNull()
  })
})
