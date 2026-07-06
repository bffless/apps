/**
 * Behavioral test for the resolvePath endpoint against the MSW /api boundary
 * (path-URLs spec, 2026-07-06): a path resolves to its node (with path) for
 * an authorized viewer, 404s for garbage, and folder listings now carry
 * server-computed paths.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, seedFolder, seedFile } from '../mocks/handlers'
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

describe('resolvePath', () => {
  it('resolves a nested folder path to its node with path populated', async () => {
    const a = seedFolder('Test', 'root')
    const b = seedFolder('Sub Folder', a.id)
    const store = makeStore()
    const node = await store
      .dispatch(handoffApi.endpoints.resolvePath.initiate('Test/Sub Folder'))
      .unwrap()
    expect(node?.id).toBe(b.id)
    expect(node?.type).toBe('folder')
    expect(node?.path).toBe('Test/Sub Folder')
  })

  it('resolves a file path with spaces', async () => {
    const a = seedFolder('Test', 'root')
    const f = seedFile('My File.png', a.id)
    const store = makeStore()
    const node = await store
      .dispatch(handoffApi.endpoints.resolvePath.initiate('Test/My File.png'))
      .unwrap()
    expect(node?.id).toBe(f.id)
    expect(node?.path).toBe('Test/My File.png')
  })

  it('rejects with 404 for a path that resolves to nothing', async () => {
    seedFolder('Test', 'root')
    const store = makeStore()
    const res = await store.dispatch(handoffApi.endpoints.resolvePath.initiate('Nope/missing'))
    expect(res.isError).toBe(true)
    expect((res.error as { status?: number }).status).toBe(404)
  })

  it('listNodes responses carry folder paths', async () => {
    const a = seedFolder('Test', 'root')
    seedFolder('Sub Folder', a.id)
    const store = makeStore()
    const children = await store
      .dispatch(handoffApi.endpoints.listNodes.initiate({ parentId: a.id }))
      .unwrap()
    const sub = children.find((n) => n.name === 'Sub Folder')
    expect(sub?.path).toBe('Test/Sub Folder')
  })
})
