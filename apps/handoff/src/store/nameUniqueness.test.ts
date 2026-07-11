/**
 * Behavioral test for in-Folder name uniqueness (structural storage, Slice 4 /
 * issue #159).
 *
 * Drives the REAL `uploadFile` / `uploadSite` mutations through a minimal RTK
 * store against the same MSW `/api/*` boundary the browser worker uses. The
 * mocks mirror the pipeline guard, so this asserts the observable contract:
 *   - a File/Site whose name duplicates an existing sibling is rejected (no new
 *     node, a clear error) — never overwritten;
 *   - the same name is accepted in a different Folder;
 *   - a folder-import's own internal structure is not falsely flagged;
 *   - a Folder whose name duplicates ANY existing sibling is rejected, across
 *     owners too — verbatim keys make a path collision a storage-key collision
 *     (issue #225).
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, setMockUser } from '../mocks/handlers'
import { handoffApi } from './handoffApi'
import { toNodeList } from '../lib/nodes'
import type { HandoffNode } from '../lib/nodes'

const server = setupServer(...handlers)

// Same jsdom+undici origin workaround as importFolder.test.ts.
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

function file(name: string): File {
  return new File([name], name, { type: 'text/plain' })
}

async function listFolder(parentId: string): Promise<HandoffNode[]> {
  const res = await fetch(`/api/nodes?parentId=${encodeURIComponent(parentId)}`)
  return toNodeList(await res.json())
}

type Dispatch = ReturnType<typeof makeStore>['dispatch']

function upload(dispatch: Dispatch, name: string, parentId: string) {
  return dispatch(
    handoffApi.endpoints.uploadFile.initiate({ file: file(name), parentId, path: `${parentId}/${name}` }),
  )
}

describe('in-Folder name uniqueness — File uploads', () => {
  it('rejects a File whose name duplicates an existing sibling (no overwrite)', async () => {
    const store = makeStore()
    const first = await upload(store.dispatch, 'logo.png', 'root')
    expect('data' in first).toBe(true)

    const dup = await upload(store.dispatch, 'logo.png', 'root')
    expect('error' in dup).toBe(true)
    const err = (dup as { error: { error?: string } }).error
    expect(err.error?.toLowerCase()).toContain('already exists')

    // Exactly one node — the original survived, nothing was overwritten.
    const siblings = (await listFolder('root')).filter((n) => n.name === 'logo.png')
    expect(siblings).toHaveLength(1)
  })

  it('accepts the same name in a different Folder', async () => {
    const store = makeStore()
    // Two distinct folders via the folders endpoint.
    const mkFolder = (name: string) =>
      store.dispatch(handoffApi.endpoints.createFolder.initiate({ parentId: 'root', name }))
    const a = await mkFolder('A')
    const b = await mkFolder('B')
    const aId = (a as { data: HandoffNode }).data.id
    const bId = (b as { data: HandoffNode }).data.id

    const inA = await upload(store.dispatch, 'notes.md', aId)
    const inB = await upload(store.dispatch, 'notes.md', bId)
    expect('data' in inA).toBe(true)
    expect('data' in inB).toBe(true)
  })
})

describe('in-Folder name uniqueness — Site uploads', () => {
  it('rejects a Site whose name duplicates an existing sibling', async () => {
    const store = makeStore()
    const items = [{ relPath: 'index.html', file: file('index.html') }]
    const mkSite = () =>
      store.dispatch(
        handoffApi.endpoints.uploadSite.initiate({ items, entry: 'index.html', name: 'Docs', parentId: 'root' }),
      )
    expect('data' in (await mkSite())).toBe(true)
    const dup = await mkSite()
    expect('error' in dup).toBe(true)
    const err = (dup as { error: { error?: string } }).error
    expect(err.error?.toLowerCase()).toContain('already exists')
  })
})

describe('in-Folder name uniqueness — folder creation (issue #225)', () => {
  function mkFolder(dispatch: Dispatch, name: string, parentId = 'root') {
    return dispatch(handoffApi.endpoints.createFolder.initiate({ parentId, name }))
  }

  it('rejects a folder whose name duplicates an existing sibling folder', async () => {
    const store = makeStore()
    expect('data' in (await mkFolder(store.dispatch, 'plans'))).toBe(true)

    const dup = await mkFolder(store.dispatch, 'plans')
    expect('error' in dup).toBe(true)
    const err = (dup as { error: { status?: number; data?: { error?: string } } }).error
    expect(err.status).toBe(409)
    expect(err.data?.error?.toLowerCase()).toContain('already exists')

    const siblings = (await listFolder('root')).filter((n) => n.name === 'plans')
    expect(siblings).toHaveLength(1)
  })

  it('rejects a folder whose name duplicates a sibling File', async () => {
    const store = makeStore()
    expect('data' in (await upload(store.dispatch, 'notes', 'root'))).toBe(true)

    const dup = await mkFolder(store.dispatch, 'notes')
    expect('error' in dup).toBe(true)
    expect((dup as { error: { status?: number } }).error.status).toBe(409)
  })

  it('accepts the same folder name under a different parent', async () => {
    const store = makeStore()
    const a = await mkFolder(store.dispatch, 'A')
    const aId = (a as { data: HandoffNode }).data.id
    expect('data' in (await mkFolder(store.dispatch, 'plans'))).toBe(true)
    expect('data' in (await mkFolder(store.dispatch, 'plans', aId))).toBe(true)
  })

  it('rejects a duplicate sibling name across owners at root (verbatim keys collide)', async () => {
    const store = makeStore()
    setMockUser({ id: 'user-a', email: 'a@example.com' })
    expect('data' in (await mkFolder(store.dispatch, 'plans'))).toBe(true)

    setMockUser({ id: 'user-b', email: 'b@example.com' })
    const dup = await mkFolder(makeStore().dispatch, 'plans')
    expect('error' in dup).toBe(true)
    expect((dup as { error: { status?: number } }).error.status).toBe(409)
  })
})

describe('cross-owner File collision at root (issue #225)', () => {
  it('rejects a File upload whose name duplicates another owner\'s root sibling', async () => {
    setMockUser({ id: 'user-a', email: 'a@example.com' })
    expect('data' in (await upload(makeStore().dispatch, 'logo.png', 'root'))).toBe(true)

    setMockUser({ id: 'user-b', email: 'b@example.com' })
    const dup = await upload(makeStore().dispatch, 'logo.png', 'root')
    expect('error' in dup).toBe(true)
    const err = (dup as { error: { error?: string } }).error
    expect(err.error?.toLowerCase()).toContain('already exists')
  })
})

describe('root listing without parentId (issue #225)', () => {
  it('GET /api/nodes with no parentId param lists root nodes', async () => {
    const store = makeStore()
    const created = await store.dispatch(
      handoffApi.endpoints.createFolder.initiate({ parentId: 'root', name: 'plans' }),
    )
    expect('data' in created).toBe(true)

    const res = await fetch('/api/nodes')
    expect(res.status).toBe(200)
    const names = toNodeList(await res.json()).map((n) => n.name)
    expect(names).toContain('plans')
  })
})

describe('in-Folder name uniqueness — folder import', () => {
  it('does not falsely flag a folder import with its own internal structure', async () => {
    const store = makeStore()
    // A tree that reuses the same leaf name (a.md) in different sub-folders —
    // distinct siblings, so the import must land cleanly.
    const items = [
      { relPath: 'proj/a.md', file: file('a.md') },
      { relPath: 'proj/docs/a.md', file: file('a.md') },
      { relPath: 'proj/docs/b.md', file: file('b.md') },
    ]
    const res = await store.dispatch(
      handoffApi.endpoints.importFolder.initiate({ items, parentId: 'root' }),
    )
    const data = (res as { data: { filesUploaded: number; failures: unknown[] } }).data
    expect(data.failures).toHaveLength(0)
    expect(data.filesUploaded).toBe(3)
  })
})
