/**
 * Behavioral ACL test: granted-sees / ungranted-denied.
 *
 * Drives fetch against the MSW handlers to prove:
 *   - User B (non-owner, no grant) cannot see User A's folder (403)
 *   - After A grants View to B, B can list the folder (200)
 *   - After A revokes B's grant, B is denied again (403)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, setMockUser, setMockGrants } from './handlers'

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => {
  resetMockState()
  server.resetHandlers()
})

const USER_A = { id: 'user-a', email: 'a@example.com' }
const USER_B = { id: 'user-b', email: 'b@example.com' }

describe('ACL behavioral test: granted-sees / ungranted-denied', () => {
  it('user B cannot see a folder until granted, and loses access after revoke', async () => {
    // ------------------------------------------------------------------
    // Step 1: User A creates a folder (A is set as ownerId by the handler)
    // ------------------------------------------------------------------
    setMockUser(USER_A)

    const createRes = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: 'root', name: 'Secret Folder' }),
    })
    expect(createRes.status).toBe(200)
    const { node: folder } = (await createRes.json()) as { node: { id: string } }
    const folderId = folder.id
    expect(folderId).toBeTruthy()

    // ------------------------------------------------------------------
    // Step 2: User B (non-owner, no grant) cannot list/see the folder → 403
    // ------------------------------------------------------------------
    setMockUser(USER_B)

    const listRes1 = await fetch(`/api/nodes?parentId=${folderId}`)
    expect(listRes1.status).toBe(403)

    // ------------------------------------------------------------------
    // Step 3: User A grants View to User B
    // ------------------------------------------------------------------
    setMockUser(USER_A)
    setMockGrants(folderId, [{ principalId: USER_B.id, principalEmail: USER_B.email, level: 'view' }])

    // Verify from A's perspective
    const grantsRes = await fetch(`/api/grants?folderId=${folderId}`)
    expect(grantsRes.status).toBe(200)
    const { grants } = (await grantsRes.json()) as { grants: { principalId: string }[] }
    expect(grants.some((g) => g.principalId === USER_B.id)).toBe(true)

    // ------------------------------------------------------------------
    // Step 4: User B can now list the folder → 200
    // ------------------------------------------------------------------
    setMockUser(USER_B)

    const listRes2 = await fetch(`/api/nodes?parentId=${folderId}`)
    expect(listRes2.status).toBe(200)
    const body2 = (await listRes2.json()) as { nodes: unknown[] }
    expect(Array.isArray(body2.nodes)).toBe(true)

    // ------------------------------------------------------------------
    // Step 5: User A revokes B's grant
    // ------------------------------------------------------------------
    setMockUser(USER_A)

    const revokeRes = await fetch('/api/grants/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId, principalId: USER_B.id }),
    })
    expect(revokeRes.status).toBe(200)
    const { grants: afterRevoke } = (await revokeRes.json()) as { grants: { principalId: string }[] }
    expect(afterRevoke.some((g) => g.principalId === USER_B.id)).toBe(false)

    // ------------------------------------------------------------------
    // Step 6: User B is denied again → 403
    // ------------------------------------------------------------------
    setMockUser(USER_B)

    const listRes3 = await fetch(`/api/nodes?parentId=${folderId}`)
    expect(listRes3.status).toBe(403)
  })

  it('unauthenticated user gets 401', async () => {
    // Set up a folder as user A
    setMockUser(USER_A)
    const createRes = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: 'root', name: 'Any Folder' }),
    })
    expect(createRes.status).toBe(200)
    const { node: folder } = (await createRes.json()) as { node: { id: string } }

    // Unauthenticated
    setMockUser(null)
    const res = await fetch(`/api/nodes?parentId=${folder.id}`)
    expect(res.status).toBe(401)
  })

  it('admin always has access regardless of grants', async () => {
    // Create folder as user A (no admin role)
    setMockUser(USER_A)
    const createRes = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: 'root', name: 'Admin Test Folder' }),
    })
    const { node: folder } = (await createRes.json()) as { node: { id: string } }

    // Admin user (no grants)
    setMockUser({ id: 'admin-user', email: 'admin@example.com', role: 'admin' })
    const res = await fetch(`/api/nodes?parentId=${folder.id}`)
    expect(res.status).toBe(200)
  })
})
