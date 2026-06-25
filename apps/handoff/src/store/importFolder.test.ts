/**
 * Behavioral test for the `importFolder` orchestration.
 *
 * Drives the REAL mutation through a minimal RTK store against the same MSW
 * `/api/*` boundary the browser worker uses (`msw/node` + `setupServer`).
 * Asserts observable behavior at the API boundary (folders created + files
 * registered under the right parents), not internal wiring.
 *
 *   1. No-HTML folder → nested Folders + Files recreated; each file lands in
 *      the folder matching its source sub-dir.
 *   2. A folder containing `index.html`, imported as a tree, registers the
 *      HTML as a plain File (the tree branch is independent of the Site offer).
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { handlers, resetMockState } from '../mocks/handlers'
import { handoffApi } from './handoffApi'
import { toNodeList } from '../lib/nodes'
import type { HandoffNode } from '../lib/nodes'

const server = setupServer(...handlers)

// jsdom+undici artifact: `fetchBaseQuery` (baseUrl '/') builds `new Request('/api/…')`,
// which undici refuses to parse without an origin — a real browser resolves it
// against document.baseURI. Prepend the jsdom origin so the same orchestration
// the browser runs works under the node test runner. msw matches by path either way.
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
  return { relPath, file: new File([content], relPath.split('/').pop() ?? relPath, { type: 'text/plain' }) }
}

async function listFolder(parentId: string): Promise<HandoffNode[]> {
  const res = await fetch(`/api/nodes?parentId=${encodeURIComponent(parentId)}`)
  return toNodeList(await res.json())
}

describe('importFolder — no-HTML nested tree', () => {
  it('recreates sub-folders and registers each file under the right parent', async () => {
    const store = makeStore()
    const items = [
      item('readme.md'),
      item('docs/a.md'),
      item('docs/sub/b.md'),
    ]

    const result = await store.dispatch(
      handoffApi.endpoints.importFolder.initiate({ items, parentId: 'root' }),
    )

    expect('data' in result).toBe(true)
    const data = result.data!
    expect(data.foldersCreated).toBe(2) // docs, docs/sub
    expect(data.filesUploaded).toBe(3)
    expect(data.failures).toEqual([])

    // Root: folder 'docs' + file 'readme.md'
    const root = await listFolder('root')
    const docs = root.find((n) => n.type === 'folder' && n.name === 'docs')
    expect(docs).toBeDefined()
    expect(root.find((n) => n.type === 'file' && n.name === 'readme.md')).toBeDefined()
    expect(root).toHaveLength(2)

    // docs: folder 'sub' + file 'a.md'
    const inDocs = await listFolder(docs!.id)
    const sub = inDocs.find((n) => n.type === 'folder' && n.name === 'sub')
    expect(sub).toBeDefined()
    expect(inDocs.find((n) => n.type === 'file' && n.name === 'a.md')).toBeDefined()
    expect(inDocs).toHaveLength(2)

    // docs/sub: file 'b.md'
    const inSub = await listFolder(sub!.id)
    expect(inSub).toHaveLength(1)
    expect(inSub[0]!.type).toBe('file')
    expect(inSub[0]!.name).toBe('b.md')
  })
})

describe('importFolder — tree branch ignores HTML', () => {
  it('registers index.html as a plain File when imported as a folder of files', async () => {
    const store = makeStore()
    const items = [
      item('index.html', '<html><body>hi</body></html>'),
      item('style.css', 'body{}'),
    ]

    const result = await store.dispatch(
      handoffApi.endpoints.importFolder.initiate({ items, parentId: 'root' }),
    )
    expect('data' in result).toBe(true)
    expect(result.data!.foldersCreated).toBe(0)
    expect(result.data!.filesUploaded).toBe(2)

    const root = await listFolder('root')
    // No Site node — both land as plain Files.
    expect(root.every((n) => n.type === 'file')).toBe(true)
    expect(root.map((n) => n.name).sort()).toEqual(['index.html', 'style.css'])
  })
})
