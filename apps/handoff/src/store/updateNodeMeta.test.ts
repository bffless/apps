/**
 * Behavioral test for the `updateNodeMeta` mutation (Task 5) against the MSW
 * /api boundary: `PATCH /api/node/meta` sets a File/Site's display title +
 * description for a writer over the parent-folder chain (mirrors the DELETE
 * gate's edit check), rejects a view-only grantee with 403, and rejects a
 * folder target with 400 (the endpoint is leaf-only — see the design note in
 * the proxy-rules JSON for why this isn't folded into `PATCH /api/node`).
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, seedFolder, seedFile, setMockUser, nodeAcl } from '../mocks/handlers'
import { handoffApi } from './handoffApi'

const server = setupServer(...handlers)

// Same jsdom+undici origin shim as the other store tests — fetchBaseQuery
// builds `new Request('/api/…')`, which undici won't parse without an origin.
const ORIGIN = 'http://localhost:3000'
const RealRequest = globalThis.Request
class BasedRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/')) input = ORIGIN + input
    super(input, init)
  }
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

function makeStore() {
  return configureStore({
    reducer: { [handoffApi.reducerPath]: handoffApi.reducer },
    middleware: (getDefault) => getDefault().concat(handoffApi.middleware),
  })
}

describe('updateNodeMeta', () => {
  it('a writer sets title + description (200) and clears on empty string', async () => {
    setMockUser({ id: 'owner-1', email: 'owner-1@example.com', role: 'user' })
    const folder = seedFolder('Docs', 'root')
    const file = seedFile('a.png', folder.id)
    const store = makeStore()
    const res = await store
      .dispatch(handoffApi.endpoints.updateNodeMeta.initiate({ id: file.id, title: 'Deck', description: 'note', parentId: folder.id }))
      .unwrap()
    expect(res).toMatchObject({ id: file.id, title: 'Deck', description: 'note' })

    const cleared = await store
      .dispatch(handoffApi.endpoints.updateNodeMeta.initiate({ id: file.id, title: '', parentId: folder.id }))
      .unwrap()
    expect(cleared.title).toBeNull()
  })

  it('a view-only user is forbidden (403)', async () => {
    setMockUser({ id: 'owner-1', email: 'owner-1@example.com', role: 'user' })
    const folder = seedFolder('Docs', 'root')
    nodeAcl.set(folder.id, { ownerId: 'owner-1', grants: [{ principalId: 'viewer-2', level: 'view' }], mode: 'inheriting' })
    const file = seedFile('a.png', folder.id)
    setMockUser({ id: 'viewer-2', email: 'viewer-2@example.com', role: 'user' })
    const store = makeStore()
    const res = await store.dispatch(handoffApi.endpoints.updateNodeMeta.initiate({ id: file.id, title: 'X', parentId: folder.id }))
    expect('error' in res).toBe(true)
    expect((res as { error: { status?: number } }).error.status).toBe(403)
  })

  it('rejects a folder target (400)', async () => {
    setMockUser({ id: 'owner-1', email: 'owner-1@example.com', role: 'user' })
    const folder = seedFolder('Docs', 'root')
    const store = makeStore()
    const res = await store.dispatch(handoffApi.endpoints.updateNodeMeta.initiate({ id: folder.id, title: 'X', parentId: 'root' }))
    expect('error' in res).toBe(true)
    expect((res as { error: { status?: number } }).error.status).toBe(400)
  })
})
