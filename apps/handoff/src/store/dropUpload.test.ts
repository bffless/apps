/**
 * Behavioral test for the drag-and-drop → folder-import path.
 *
 * Drives the REAL drop pipeline the dropzone uses: a mocked OS `DataTransfer`
 * (FileSystem entries with paged `readEntries`) → `filesFromDataTransfer` →
 * `importFolder` mutation, against the same MSW `/api/*` boundary the browser
 * worker uses. Asserts the dropped folder is recreated under the target parent.
 *
 * Native drag-and-drop can't be faithfully driven in jsdom, so the OS layer
 * (DataTransfer / FileSystemEntry) is mocked; everything downstream is real.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { handlers, resetMockState } from '../mocks/handlers'
import { handoffApi } from './handoffApi'
import { toNodeList } from '../lib/nodes'
import type { HandoffNode } from '../lib/nodes'
import { filesFromDataTransfer } from '../lib/ingest'

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

async function listFolder(parentId: string): Promise<HandoffNode[]> {
  const res = await fetch(`/api/nodes?parentId=${encodeURIComponent(parentId)}`)
  return toNodeList(await res.json())
}

// --- Mocked FileSystem entries / DataTransfer (no webkitGetAsEntry in jsdom) ---

function fileEntry(fullPath: string, name: string, content = name) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath,
    file: (cb: (f: File) => void) => cb(new File([content], name, { type: 'text/plain' })),
  }
}

function dirEntry(
  fullPath: string,
  name: string,
  children: unknown[],
): { isFile: false; isDirectory: true; name: string; fullPath: string; createReader: () => unknown } {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    createReader: () => {
      let i = 0
      return {
        // Page one child per call to exercise the batched-read loop.
        readEntries: (cb: (batch: unknown[]) => void) => {
          if (i >= children.length) {
            cb([])
            return
          }
          cb(children.slice(i, i + 1))
          i += 1
        },
      }
    },
  }
}

function dropOf(entries: unknown[]): DataTransfer {
  return {
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    files: [],
  } as unknown as DataTransfer
}

describe('drag-drop folder → importFolder', () => {
  it('recreates a dropped folder tree under the target parent', async () => {
    const store = makeStore()

    // Drop a "notes" folder: a top-level file plus a nested sub-folder.
    const dt = dropOf([
      dirEntry('/notes', 'notes', [
        fileEntry('/notes/readme.md', 'readme.md'),
        dirEntry('/notes/chapters', 'chapters', [fileEntry('/notes/chapters/one.md', 'one.md')]),
      ]),
    ])

    const items = await filesFromDataTransfer(dt)
    expect(items.map((i) => i.relPath).sort()).toEqual([
      'notes/chapters/one.md',
      'notes/readme.md',
    ])

    const result = await store.dispatch(
      handoffApi.endpoints.importFolder.initiate({ items, parentId: 'root' }),
    )

    expect('data' in result).toBe(true)
    expect(result.data!.failures).toEqual([])
    expect(result.data!.filesUploaded).toBe(2)

    // The common top dir ('notes') is stripped by planFolderImport, so the
    // tree lands directly under root: a 'chapters' folder + 'readme.md'.
    const root = await listFolder('root')
    const chapters = root.find((n) => n.type === 'folder' && n.name === 'chapters')
    expect(chapters).toBeDefined()
    expect(root.find((n) => n.type === 'file' && n.name === 'readme.md')).toBeDefined()

    const inChapters = await listFolder(chapters!.id)
    expect(inChapters.map((n) => n.name)).toEqual(['one.md'])
  })
})
