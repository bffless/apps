/**
 * Margin-comments behavioral tests against the MSW mock backend.
 *
 * Drives fetch against the same handlers the app uses in dev, mirroring the
 * live pipeline gates 1:1 (comments/{get,post,patch,delete}/{gate,pre,shape}.fn.ts):
 *   - GET is view+-gated (share-cookie visitors included).
 *   - POST/PATCH/DELETE require a session user — a share-cookie visitor alone
 *     is never enough (spec §7) — plus view+ access on the node.
 *   - PATCH `edit` is author-only; `resolve`/`reopen` are root-only; `react`
 *     toggles the caller's id in the emoji bucket.
 *   - DELETE is author-only; a root with a reply is soft-deleted (husk),
 *     everything else is hard-deleted.
 *
 * Uses msw/node — same idiom as shareLinks.test.ts / acl.test.ts. No RTK store
 * needed; responses are run through `toCommentList`/`toComment` so mock == real
 * is enforced at the coercion seam.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { setupServer } from 'msw/node'
import {
  handlers,
  resetMockState,
  setMockUser,
  setMockShareLinkFolderId,
  setMockGrants,
  seedFolder,
  seedFile,
} from './handlers'
import { toCommentList } from '../lib/comments'

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => {
  resetMockState()
  server.resetHandlers()
})

const OWNER = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }
const VIEWER = { id: 'user-b', email: 'b@example.com' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postComment(body: Record<string, unknown>): Promise<Response> {
  return fetch('/api/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function listComments(nodeId: string): Promise<Response> {
  return fetch(`/api/comments?nodeId=${encodeURIComponent(nodeId)}`)
}

async function patchComment(body: Record<string, unknown>): Promise<Response> {
  return fetch('/api/comments', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function deleteComment(id: string): Promise<Response> {
  return fetch(`/api/comments?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Seed a folder + file inside it, owned by OWNER. Returns the file's id. */
function seedTarget(): { folderId: string; fileId: string } {
  setMockUser(OWNER)
  const folder = seedFolder('Design', 'root')
  const file = seedFile('mock.png', folder.id)
  return { folderId: folder.id, fileId: file.id }
}

// ---------------------------------------------------------------------------
// Create -> list roundtrip
// ---------------------------------------------------------------------------

describe('comments: create -> list roundtrip', () => {
  it('POST creates a comment; GET returns it through toCommentList', async () => {
    const { fileId } = seedTarget()

    const res = await postComment({
      nodeId: fileId,
      body: 'Nice work!',
      anchor: { type: 'pin', x: 0.5, y: 0.5 },
    })
    expect(res.status).toBe(200)
    const { comment } = (await res.json()) as { comment: { authorId: string } }
    expect(comment.authorId).toBe(OWNER.id)

    const listRes = await listComments(fileId)
    expect(listRes.status).toBe(200)
    const listed = toCommentList(await listRes.json())
    expect(listed).toHaveLength(1)
    expect(listed[0].body).toBe('Nice work!')
    expect(listed[0].anchor).toEqual({ type: 'pin', x: 0.5, y: 0.5 })
    expect(listed[0].authorName).toBe(OWNER.email)
    expect(listed[0].parentId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// POST auth
// ---------------------------------------------------------------------------

describe('comments: POST auth', () => {
  it('anonymous POST -> 401', async () => {
    const { fileId } = seedTarget()
    setMockUser(null)

    const res = await postComment({ nodeId: fileId, body: 'hi' })
    expect(res.status).toBe(401)
  })

  it('share-cookie visitor (no session) POST -> 401', async () => {
    const { folderId, fileId } = seedTarget()
    setMockUser(null)
    setMockShareLinkFolderId(folderId)

    const res = await postComment({ nodeId: fileId, body: 'hi' })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

describe('comments: PATCH', () => {
  it('edit by non-author -> 403', async () => {
    const { folderId, fileId } = seedTarget()
    setMockGrants(folderId, [{ principalId: VIEWER.id, level: 'view' }])

    const created = await postComment({ nodeId: fileId, body: 'original' })
    const { comment } = (await created.json()) as { comment: { id: string } }

    setMockUser(VIEWER)
    const res = await patchComment({ id: comment.id, op: 'edit', body: 'hijacked' })
    expect(res.status).toBe(403)
  })

  it('react toggles on then off', async () => {
    const { folderId, fileId } = seedTarget()
    setMockGrants(folderId, [{ principalId: VIEWER.id, level: 'view' }])

    const created = await postComment({ nodeId: fileId, body: 'original' })
    const { comment } = (await created.json()) as { comment: { id: string } }

    setMockUser(VIEWER)
    const onRes = await patchComment({ id: comment.id, op: 'react', emoji: '👍' })
    expect(onRes.status).toBe(200)
    const { comment: afterOn } = (await onRes.json()) as { comment: { reactionsJson: string } }
    expect(JSON.parse(afterOn.reactionsJson)).toEqual({ '👍': [VIEWER.id] })

    const offRes = await patchComment({ id: comment.id, op: 'react', emoji: '👍' })
    expect(offRes.status).toBe(200)
    const { comment: afterOff } = (await offRes.json()) as { comment: { reactionsJson: string } }
    expect(JSON.parse(afterOff.reactionsJson)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe('comments: DELETE', () => {
  it('deleting a root with a reply leaves a husk visible via GET', async () => {
    const { fileId } = seedTarget()

    const rootRes = await postComment({ nodeId: fileId, body: 'root comment' })
    const { comment: root } = (await rootRes.json()) as { comment: { id: string } }
    const replyRes = await postComment({ nodeId: fileId, body: 'a reply', parentId: root.id })
    expect(replyRes.status).toBe(200)

    const delRes = await deleteComment(root.id)
    expect(delRes.status).toBe(200)
    const delBody = (await delRes.json()) as { id: string; soft: boolean }
    expect(delBody.soft).toBe(true)

    const listRes = await listComments(fileId)
    const listed = toCommentList(await listRes.json())
    const husk = listed.find((c) => c.id === root.id)
    expect(husk).toBeDefined()
    expect(husk?.deleted).toBe(true)
    expect(husk?.body).toBe('')
    // The reply survives, still anchored to the husked root.
    expect(listed.some((c) => c.parentId === root.id)).toBe(true)
  })

  it('deleting a reply hard-deletes it (gone from GET)', async () => {
    const { fileId } = seedTarget()

    const rootRes = await postComment({ nodeId: fileId, body: 'root comment' })
    const { comment: root } = (await rootRes.json()) as { comment: { id: string } }
    const replyRes = await postComment({ nodeId: fileId, body: 'a reply', parentId: root.id })
    const { comment: reply } = (await replyRes.json()) as { comment: { id: string } }

    const delRes = await deleteComment(reply.id)
    expect(delRes.status).toBe(200)
    const delBody = (await delRes.json()) as { id: string; soft: boolean }
    expect(delBody.soft).toBe(false)

    const listRes = await listComments(fileId)
    const listed = toCommentList(await listRes.json())
    expect(listed.find((c) => c.id === reply.id)).toBeUndefined()
    expect(listed.find((c) => c.id === root.id)).toBeDefined()
  })
})
