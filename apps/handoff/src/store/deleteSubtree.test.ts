/**
 * Behavioral test for the `deleteSubtree` orchestration — recursion lives in the
 * client (the server owns only single-node delete), so this drives the REAL
 * mutation through a minimal RTK store against the same MSW `/api/*` boundary the
 * browser uses, and asserts observable behavior:
 *
 *   1. A nested folder → the whole subtree is gone and the parent listing empties.
 *      (Correct bottom-up ordering is load-bearing: the server's 409 non-empty
 *      guard would reject a parent deleted before its children, so a clean run
 *      proves children-before-parents.)
 *   2. Deletes are issued deepest-first (explicit order assertion).
 *   3. A per-node failure is collected, not fatal — the rest still delete.
 *   4. `affectedFolderIds` covers the parent + every folder in the subtree, so
 *      every touched listing is invalidated.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { handlers, resetMockState, setMockUser } from '../mocks/handlers'
import { handoffApi } from './handoffApi'
import { toNodeList } from '../lib/nodes'
import type { HandoffNode } from '../lib/nodes'

const server = setupServer(...handlers)

// Same jsdom+undici origin shim as importFolder.test — fetchBaseQuery builds
// `new Request('/api/…')`, which undici won't parse without an origin.
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

async function createFolder(parentId: string, name: string): Promise<string> {
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId, name }),
  })
  const { node } = (await res.json()) as { node: { id: string } }
  return node.id
}

async function uploadFile(parentId: string, name: string): Promise<string> {
  const prep = await fetch('/api/uploads/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: name, contentType: 'text/plain' }),
  })
  const prepared = (await prep.json()) as { uploadUrl: string; storageKey: string }
  await fetch(prepared.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x' })
  const reg = await fetch('/api/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageKey: prepared.storageKey, originalName: name, displayName: name, parentId }),
  })
  const { node } = (await reg.json()) as { node: { id: string } }
  return node.id
}

async function listFolder(parentId: string): Promise<HandoffNode[]> {
  const res = await fetch(`/api/nodes?parentId=${encodeURIComponent(parentId)}`)
  return toNodeList(await res.json())
}

describe('deleteSubtree — recursive bottom-up delete', () => {
  it('removes a whole nested subtree and empties the parent listing', async () => {
    setMockUser({ id: 'owner', email: 'owner@example.com' })
    // root ▸ top ▸ { fileA, sub ▸ fileB }
    const top = await createFolder('root', 'top')
    await uploadFile(top, 'a.txt')
    const sub = await createFolder(top, 'sub')
    await uploadFile(sub, 'b.txt')

    const store = makeStore()
    const result = await store.dispatch(
      handoffApi.endpoints.deleteSubtree.initiate({ rootId: top, parentId: 'root' }),
    )

    expect('data' in result).toBe(true)
    expect(result.data!.deleted).toBe(4) // top, a.txt, sub, b.txt
    expect(result.data!.failures).toEqual([])

    // Whole subtree gone — and a parent that was deleted before its children
    // would have 409'd, so a clean count proves children-before-parents.
    expect(await listFolder('root')).toHaveLength(0)
  })

  it('issues deletes deepest-first', async () => {
    setMockUser({ id: 'owner', email: 'owner@example.com' })
    // Linear chain: top ▸ sub ▸ file
    const top = await createFolder('root', 'top')
    const sub = await createFolder(top, 'sub')
    const file = await uploadFile(sub, 'leaf.txt')

    // Record the order DELETEs hit the wire.
    const deleteOrder: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = (typeof input === 'string' ? init?.method : (input as Request).method) ?? 'GET'
      if (method === 'DELETE') {
        const id = new URL(url, ORIGIN).searchParams.get('id') ?? ''
        deleteOrder.push(id)
      }
      return realFetch(input, init)
    }) as typeof fetch

    try {
      const store = makeStore()
      await store.dispatch(handoffApi.endpoints.deleteSubtree.initiate({ rootId: top, parentId: 'root' }))
    } finally {
      globalThis.fetch = realFetch
    }

    expect(deleteOrder).toEqual([file, sub, top]) // leaf → sub → root
  })

  it('collects per-node failures without aborting the rest', async () => {
    setMockUser({ id: 'owner', email: 'owner@example.com' })
    const top = await createFolder('root', 'top')
    const keep = await uploadFile(top, 'keep.txt')
    const boom = await uploadFile(top, 'boom.txt')

    // Force one leaf's delete to fail; the rest must still delete.
    server.use(
      http.delete('/api/node', ({ request }) => {
        const id = new URL(request.url).searchParams.get('id')
        if (id === boom) return HttpResponse.json({ error: 'boom' }, { status: 500 })
        return undefined // fall through to the default handler
      }),
    )

    const store = makeStore()
    const result = await store.dispatch(
      handoffApi.endpoints.deleteSubtree.initiate({ rootId: top, parentId: 'root' }),
    )

    const data = result.data!
    const failedIds = data.failures.map((f) => f.id)
    // The forced leaf fails; its surviving presence then makes the parent folder
    // a non-empty 409 — both are reported, neither aborts the sibling.
    expect(failedIds).toContain(boom)
    expect(failedIds).toContain(top)
    expect(data.failures.find((f) => f.id === boom)!.name).toBe('boom.txt')
    expect(data.deleted).toBe(1) // only keep.txt
    const listing = await listFolder(top)
    expect(listing.some((n) => n.id === keep)).toBe(false)
    expect(listing.some((n) => n.id === boom)).toBe(true)
  })

  it('reports every touched folder listing for invalidation', async () => {
    setMockUser({ id: 'owner', email: 'owner@example.com' })
    const top = await createFolder('root', 'top')
    const sub = await createFolder(top, 'sub')
    await uploadFile(sub, 'b.txt')

    const store = makeStore()
    const result = await store.dispatch(
      handoffApi.endpoints.deleteSubtree.initiate({ rootId: top, parentId: 'root' }),
    )

    const affected = result.data!.affectedFolderIds
    expect(affected).toContain('root') // parent listing
    expect(affected).toContain(top)
    expect(affected).toContain(sub)
  })
})
