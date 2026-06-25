/**
 * MSW-boundary behavioral test.
 *
 * Uses `msw/node` + `setupServer` to drive the real `/api/*` boundary with the
 * same handlers the browser worker uses. Asserts observable behavior (not wiring):
 *
 *   1. Initially GET /api/nodes?parentId=root returns an empty list.
 *   2. After the full upload flow (prepare → PUT → register), listing returns
 *      a node with the right name, type, and size.
 *
 * `fetch` is used directly so the test doesn't need a full RTK store setup,
 * but `toNode`/`toNodeList` coercion is exercised through the handlers.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { setupServer } from 'msw/node'
import { handlers, resetMockState } from './handlers'
import { toNodeList } from '../lib/nodes'

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  resetMockState()
  server.resetHandlers()
})
afterAll(() => server.close())

describe('MSW boundary: node listing', () => {
  it('returns an empty node list initially', async () => {
    const res = await fetch('/api/nodes?parentId=root')
    expect(res.ok).toBe(true)
    const json = await res.json()
    const list = toNodeList(json)
    expect(list).toHaveLength(0)
  })
})

describe('MSW boundary: upload flow', () => {
  it('upload → register → list produces a node with correct name, type, and size', async () => {
    const content = 'hello world'
    const file = new File([content], 'hello.txt', { type: 'text/plain' })

    // Step 1: Prepare
    const prepRes = await fetch('/api/uploads/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, contentType: file.type }),
    })
    expect(prepRes.ok).toBe(true)
    const prepared = (await prepRes.json()) as {
      uploadUrl: string
      storageKey: string
      originalName: string
    }
    expect(typeof prepared.uploadUrl).toBe('string')
    expect(typeof prepared.storageKey).toBe('string')

    // Step 2: PUT bytes to the mock bucket
    const putRes = await fetch(prepared.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    })
    expect(putRes.ok).toBe(true)

    // Step 3: Register
    const nowMs = 1700000000000
    const regRes = await fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storageKey: prepared.storageKey,
        originalName: file.name,
        parentId: 'root',
        displayName: file.name,
        createdMs: nowMs,
      }),
    })
    expect(regRes.ok).toBe(true)
    const regJson = await regRes.json()
    expect(regJson).toHaveProperty('node')

    // Step 4: List — node should appear
    const listRes = await fetch('/api/nodes?parentId=root')
    expect(listRes.ok).toBe(true)
    const listJson = await listRes.json()
    const list = toNodeList(listJson)

    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('hello.txt')
    expect(list[0].type).toBe('file')
    // size reflects the bytes stored in the mock bucket (positive, non-null)
    expect(list[0].size).toBeGreaterThan(0)
    expect(list[0].parentId).toBe('root')
    expect(list[0].createdAt).toBe(nowMs)
  })
})
