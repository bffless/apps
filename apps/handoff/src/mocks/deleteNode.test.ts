/**
 * Behavioral test for the DELETE /api/node mock — the write-gated, hard-delete
 * boundary the `Handoff delete node` pipeline mirrors.
 *
 * Drives fetch against the MSW handlers (mock == real at the `toNode` seam) to
 * prove:
 *   - owner deletes a file → 200, record gone, stored object purged
 *   - an `edit`-granted user can delete; a `view`-granted user → 403
 *   - a share-link viewer → 403; unauthenticated → 401
 *   - a non-empty folder → 409 (nothing deleted); an empty folder → 200
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { setupServer } from 'msw/node'
import {
  handlers,
  resetMockState,
  setMockUser,
  setMockGrants,
  setMockShareLinkFolderId,
  nodes,
  objects,
} from './handlers'

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => {
  resetMockState()
  server.resetHandlers()
})

const USER_A = { id: 'user-a', email: 'a@example.com' }
const USER_B = { id: 'user-b', email: 'b@example.com' }

async function createFolder(parentId: string, name: string): Promise<string> {
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId, name }),
  })
  expect(res.status).toBe(200)
  const { node } = (await res.json()) as { node: { id: string } }
  return node.id
}

/** Full presigned flow (prepare → PUT → register) → the new file node's id. */
async function uploadFile(parentId: string, name: string): Promise<{ id: string; storageKey: string }> {
  const prep = await fetch('/api/uploads/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: name, contentType: 'text/plain' }),
  })
  const prepared = (await prep.json()) as { uploadUrl: string; storageKey: string; originalName: string }
  await fetch(prepared.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'hello' })
  const reg = await fetch('/api/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storageKey: prepared.storageKey,
      originalName: name,
      displayName: name,
      parentId,
    }),
  })
  expect(reg.status).toBe(200)
  const { node } = (await reg.json()) as { node: { id: string } }
  return { id: node.id, storageKey: prepared.storageKey }
}

/** Upload a Site bundle (prepare+PUT each asset → POST /api/sites). */
async function uploadSite(
  parentId: string,
  name: string,
  assets: string[],
): Promise<{ id: string; storageKeys: string[] }> {
  const manifest: Record<string, string> = {}
  const storageKeys: string[] = []
  for (const relPath of assets) {
    const prep = await fetch('/api/uploads/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: relPath, contentType: 'text/html' }),
    })
    const prepared = (await prep.json()) as { uploadUrl: string; storageKey: string; publicPath: string }
    await fetch(prepared.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: relPath })
    manifest[relPath] = prepared.publicPath
    storageKeys.push(prepared.storageKey)
  }
  const res = await fetch('/api/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId, name, entry: assets[0], manifest }),
  })
  expect(res.status).toBe(200)
  const { node } = (await res.json()) as { node: { id: string } }
  return { id: node.id, storageKeys }
}

function del(id: string): Promise<Response> {
  return fetch(`/api/node?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

describe('DELETE /api/node — write-gated hard delete', () => {
  it('owner deletes a file: record gone and stored object purged', async () => {
    setMockUser(USER_A)
    const folderId = await createFolder('root', 'Folder')
    const { id, storageKey } = await uploadFile(folderId, 'doc.txt')
    expect(nodes.has(id)).toBe(true)
    expect(objects.has(storageKey)).toBe(true)

    const res = await del(id)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true, id })
    expect(nodes.has(id)).toBe(false)
    expect(objects.has(storageKey)).toBe(false)
  })

  it('an edit-granted user can delete; a view-granted user cannot (403)', async () => {
    setMockUser(USER_A)
    const folderId = await createFolder('root', 'Shared')
    const editFile = await uploadFile(folderId, 'edit.txt')
    const viewFile = await uploadFile(folderId, 'view.txt')

    // View grant → cannot delete.
    setMockGrants(folderId, [{ principalId: USER_B.id, level: 'view' }])
    setMockUser(USER_B)
    expect((await del(viewFile.id)).status).toBe(403)
    expect(nodes.has(viewFile.id)).toBe(true)

    // Edit grant → can delete.
    setMockUser(USER_A)
    setMockGrants(folderId, [{ principalId: USER_B.id, level: 'edit' }])
    setMockUser(USER_B)
    expect((await del(editFile.id)).status).toBe(200)
    expect(nodes.has(editFile.id)).toBe(false)
  })

  it('a share-link viewer cannot delete (403)', async () => {
    setMockUser(USER_A)
    const folderId = await createFolder('root', 'Linked')
    const { id } = await uploadFile(folderId, 'doc.txt')

    setMockUser(null)
    setMockShareLinkFolderId(folderId)
    expect((await del(id)).status).toBe(403)
    expect(nodes.has(id)).toBe(true)
  })

  it('an unauthenticated request is rejected (401)', async () => {
    setMockUser(USER_A)
    const folderId = await createFolder('root', 'Folder')
    const { id } = await uploadFile(folderId, 'doc.txt')

    setMockUser(null)
    expect((await del(id)).status).toBe(401)
    expect(nodes.has(id)).toBe(true)
  })

  it('deleting a site removes the node and purges every manifest asset object', async () => {
    setMockUser(USER_A)
    const folderId = await createFolder('root', 'Sites')
    const { id, storageKeys } = await uploadSite(folderId, 'My Site', ['index.html', 'style.css', 'app.js'])
    expect(storageKeys).toHaveLength(3)
    expect(storageKeys.every((k) => objects.has(k))).toBe(true)

    const res = await del(id)
    expect(res.status).toBe(200)
    expect(nodes.has(id)).toBe(false)
    // No orphaned objects: every asset the manifest referenced is gone.
    expect(storageKeys.some((k) => objects.has(k))).toBe(false)
  })

  it('refuses a non-empty folder with 409, then deletes it once emptied', async () => {
    setMockUser(USER_A)
    const folderId = await createFolder('root', 'Parent')
    const { id: childId } = await uploadFile(folderId, 'child.txt')

    // Direct delete of the non-empty folder → 409, nothing removed.
    expect((await del(folderId)).status).toBe(409)
    expect(nodes.has(folderId)).toBe(true)

    // Empty it, then the folder deletes cleanly.
    expect((await del(childId)).status).toBe(200)
    expect((await del(folderId)).status).toBe(200)
    expect(nodes.has(folderId)).toBe(false)
  })
})
