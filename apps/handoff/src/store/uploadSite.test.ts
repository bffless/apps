/**
 * Behavioral test for the `uploadSite` orchestration (structural storage,
 * Slice 3 / issue #158).
 *
 * Drives the REAL mutation through a minimal RTK store against the same MSW
 * `/api/*` boundary the browser worker uses. Asserts the observable structural
 * contract: a Site's files land under the Site's own path prefix on the unified
 * content endpoint (no manifest), the Site node's `url` is the Entry's content
 * URL, and each asset serves back through `GET /api/uploads/content/*` — so a
 * rendered Entry's relative refs + runtime `fetch()` resolve same-origin.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, setMockUser } from '../mocks/handlers'
import { handoffApi } from './handoffApi'
import { toNode } from '../lib/nodes'

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

function item(relPath: string, content = relPath): { relPath: string; file: File } {
  return { relPath, file: new File([content], relPath.split('/').pop() ?? relPath, { type: 'text/html' }) }
}

async function createFolder(parentId: string, name: string): Promise<string> {
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId, name }),
  })
  const { node } = (await res.json()) as { node: { id: string } }
  return node.id
}

describe('uploadSite — Site on the unified content model', () => {
  it('stores each file under the Site prefix and points url at the Entry content URL', async () => {
    setMockUser({ id: 'user-a', email: 'a@example.com' })
    const store = makeStore()
    const parentId = await createFolder('root', 'proto')

    // An index.html referencing a relative asset + a runtime fetch target.
    const items = [
      item('index.html', '<img src="assets/logo.png"><script>fetch("data/config.json")</script>'),
      item('assets/logo.png', 'PNG'),
      item('data/config.json', '{"ok":true}'),
    ]

    const result = await store.dispatch(
      handoffApi.endpoints.uploadSite.initiate({
        items,
        entry: 'index.html',
        name: 'site',
        parentId,
        basePath: 'proto',
      }),
    )

    expect('data' in result).toBe(true)
    const node = toNode(result.data)
    expect(node.type).toBe('site')
    // The Site node serves through the unified endpoint at its Entry's path —
    // no `/api/sites/<id>/` route.
    expect(node.url).toBe('/api/uploads/content/proto/site/index.html')

    // Every asset is fetchable at its verbatim key under the Site prefix, so a
    // relative `assets/logo.png` and a `fetch('data/config.json')` from the
    // rendered Entry resolve same-origin.
    for (const rel of ['index.html', 'assets/logo.png', 'data/config.json']) {
      const res = await fetch(`/api/uploads/content/proto/site/${rel}`)
      expect(res.status).toBe(200)
    }
  })

  it('rejects a structurally-unsafe Site name instead of sanitising it', async () => {
    setMockUser({ id: 'user-a', email: 'a@example.com' })
    const store = makeStore()

    const result = await store.dispatch(
      handoffApi.endpoints.uploadSite.initiate({
        items: [item('index.html')],
        entry: 'index.html',
        name: '../escape',
        parentId: 'root',
        basePath: '',
      }),
    )

    expect('error' in result && result.error !== undefined).toBe(true)
  })
})
