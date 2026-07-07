/**
 * Behavioral test for the `getRootMeta` query and `setNodeMode` mutation
 * against the MSW /api boundary (effective Public/Private UI, task 4):
 * root meta reflects the Anyone grant on the singleton root record, and
 * setNodeMode flips a folder's inheritance mode for its owner/admin while
 * rejecting a non-owner.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import {
  handlers,
  resetMockState,
  seedRoot,
  seedFolder,
  setMockGrants,
  setMockUser,
  nodeAcl,
  nodes,
  ROOT_RECORD_ID,
} from '../mocks/handlers'
import { ANYONE_PRINCIPAL } from '../lib/acl'
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

const OWNER = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }
const OTHER = { id: 'user-other', email: 'other@example.com', role: 'member' }

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

describe('getRootMeta', () => {
  it('reports public:true after seedRoot() + an Anyone grant', async () => {
    const root = seedRoot()
    setMockGrants(ROOT_RECORD_ID, [{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    const store = makeStore()
    const meta = await store.dispatch(handoffApi.endpoints.getRootMeta.initiate()).unwrap()
    expect(meta).toEqual({ id: root.id, public: true })
  })

  it('reports public:false without the Anyone grant', async () => {
    seedRoot()
    const store = makeStore()
    const meta = await store.dispatch(handoffApi.endpoints.getRootMeta.initiate()).unwrap()
    expect(meta).toEqual({ id: ROOT_RECORD_ID, public: false })
  })
})

describe('setNodeMode', () => {
  it('flips a seeded folder to restricted for its owner', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    const store = makeStore()
    const res = await store
      .dispatch(handoffApi.endpoints.setNodeMode.initiate({ id: folder.id, mode: 'restricted' }))
      .unwrap()
    expect(res).toEqual({ id: folder.id, mode: 'restricted' })
    expect(nodeAcl.get(folder.id)?.mode).toBe('restricted')
  })

  it('rejects with 403 for a non-owner', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')

    setMockUser(OTHER)
    const store = makeStore()
    const res = await store.dispatch(
      handoffApi.endpoints.setNodeMode.initiate({ id: folder.id, mode: 'restricted' }),
    )
    expect('error' in res).toBe(true)
    const err = (res as { error: { status?: number } }).error
    expect(err.status).toBe(403)
    expect(nodeAcl.get(folder.id)?.mode).toBe('inheriting')
  })
})

describe('setNodeFeedExcluded (#191)', () => {
  it('writes the feedExcluded flag on a folder for its owner', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    const store = makeStore()
    const res = await store
      .dispatch(handoffApi.endpoints.setNodeFeedExcluded.initiate({ id: folder.id, feedExcluded: true }))
      .unwrap()
    expect(res).toEqual({ id: folder.id, feedExcluded: true })
    expect(nodes.get(folder.id)?.feedExcluded).toBe(true)
  })

  it('sequential mode + feedExcluded writes on the same node do not clobber (#194)', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')
    const store = makeStore()
    // Sequenced on purpose — never Promise.all a same-node pair (CE data_update
    // is a whole-record read-modify-write). Both disjoint fields must survive.
    await store.dispatch(handoffApi.endpoints.setNodeMode.initiate({ id: folder.id, mode: 'restricted' })).unwrap()
    await store
      .dispatch(handoffApi.endpoints.setNodeFeedExcluded.initiate({ id: folder.id, feedExcluded: true }))
      .unwrap()
    expect(nodeAcl.get(folder.id)?.mode).toBe('restricted')
    expect(nodes.get(folder.id)?.feedExcluded).toBe(true)
  })

  it('rejects with 403 for a non-owner', async () => {
    setMockUser(OWNER)
    const folder = seedFolder('Docs', 'root')

    setMockUser(OTHER)
    const store = makeStore()
    const res = await store.dispatch(
      handoffApi.endpoints.setNodeFeedExcluded.initiate({ id: folder.id, feedExcluded: true }),
    )
    expect('error' in res).toBe(true)
    expect((res as { error: { status?: number } }).error.status).toBe(403)
    expect(nodes.get(folder.id)?.feedExcluded).toBeFalsy()
  })
})
