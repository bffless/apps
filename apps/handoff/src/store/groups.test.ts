/**
 * Behavioral tests for the group-sharing client endpoints (group-sharing
 * plan, Task 6): `searchGroups` and `myGroups` against the MSW `/api/*`
 * boundary, plus `addGrant` posting the new `principalType`/`principalName`
 * fields through to the server for a group grant.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { handlers, resetMockState } from '../mocks/handlers'
import { handoffApi } from './handoffApi'

const server = setupServer(...handlers)

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
    reducer: { [handoffApi.reducerPath]: handoffApi.reducer },
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

describe('searchGroups', () => {
  it('hits /api/groups?search=<q> and returns the mocked group list', async () => {
    let capturedUrl: URL | undefined
    server.use(
      http.get('/api/groups', ({ request }) => {
        capturedUrl = new URL(request.url)
        return HttpResponse.json({
          groups: [{ id: 'group-design', name: 'Design', memberCount: 4 }],
        })
      }),
    )

    const store = makeStore()
    const result = await store.dispatch(handoffApi.endpoints.searchGroups.initiate({ search: 'de' })).unwrap()

    expect(capturedUrl?.pathname).toBe('/api/groups')
    expect(capturedUrl?.searchParams.get('search')).toBe('de')
    expect(result).toEqual({ groups: [{ id: 'group-design', name: 'Design', memberCount: 4 }] })
  })
})

describe('myGroups', () => {
  it('hits /api/me/groups and returns the mocked memberships', async () => {
    let hit = false
    server.use(
      http.get('/api/me/groups', () => {
        hit = true
        return HttpResponse.json({ groups: [{ id: 'group-design', name: 'Design' }] })
      }),
    )

    const store = makeStore()
    const result = await store.dispatch(handoffApi.endpoints.myGroups.initiate()).unwrap()

    expect(hit).toBe(true)
    expect(result).toEqual({ groups: [{ id: 'group-design', name: 'Design' }] })
  })
})

describe('addGrant — group principal fields', () => {
  it('posts principalType and principalName through in the body', async () => {
    let capturedBody: Record<string, unknown> | undefined
    server.use(
      http.post('/api/grants', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ grants: [] })
      }),
    )

    const store = makeStore()
    await store
      .dispatch(
        handoffApi.endpoints.addGrant.initiate({
          folderId: 'folder-1',
          principalId: 'group-design',
          principalType: 'group',
          principalName: 'Design',
          level: 'view',
        }),
      )
      .unwrap()

    expect(capturedBody).toEqual({
      folderId: 'folder-1',
      principalId: 'group-design',
      principalType: 'group',
      principalName: 'Design',
      level: 'view',
    })
  })
})
