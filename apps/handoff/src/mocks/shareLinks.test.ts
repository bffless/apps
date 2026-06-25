/**
 * Share-link behavioral tests.
 *
 * Covers the full lifecycle: mint → validate → scoped view → revoke → invalidated.
 * Also tests optional expiry (expired link → invalid) and scope enforcement
 * (share viewer denied a sibling folder not in their chain).
 *
 * Uses msw/node + the same handlers as the browser worker so mock == live is
 * enforced at the coercion seam (toShareLink). No RTK store needed — drives
 * raw fetch just like the ACL behavioral tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { setupServer } from 'msw/node'
import {
  handlers,
  resetMockState,
  setMockUser,
  setMockShareLinkFolderId,
  shareLinks,
} from './handlers'

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => {
  resetMockState()
  server.resetHandlers()
})

const OWNER = { id: 'user-owner', email: 'owner@example.com' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function mintLink(folderId: string, expiresMs?: number): Promise<string> {
  const body: Record<string, unknown> = { folderId }
  if (expiresMs !== undefined) body.expiresMs = expiresMs
  const res = await fetch('/api/share-links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  const json = (await res.json()) as { token: string }
  return json.token
}

async function validate(token: string): Promise<{ valid: boolean; folderId: string | null }> {
  const res = await fetch(`/api/share-links/validate?token=${encodeURIComponent(token)}`)
  expect(res.status).toBe(200)
  return res.json() as Promise<{ valid: boolean; folderId: string | null }>
}

async function claim(token: string): Promise<{ valid: boolean; folderId: string | null }> {
  const res = await fetch('/api/share-links/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ valid: boolean; folderId: string | null }>
}

async function revokeLink(token: string): Promise<void> {
  const res = await fetch('/api/share-links/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  expect(res.status).toBe(200)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('share-link lifecycle: mint → validate → revoke', () => {
  it('mints a link, validate returns valid+folderId, revoke → invalid', async () => {
    setMockUser(OWNER)

    // Create a folder as the owner
    const folderId = await createFolder('root', 'Shared Folder')

    // Mint a share link for that folder
    const token = await mintLink(folderId)
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)

    // Validate — should be valid with correct folderId
    const v1 = await validate(token)
    expect(v1.valid).toBe(true)
    expect(v1.folderId).toBe(folderId)

    // The link URL should be /s/<token>
    const link = shareLinks.get(token)
    expect(link?.url).toBe(`/s/${token}`)

    // Revoke the link
    await revokeLink(token)

    // Validate again — should be invalid
    const v2 = await validate(token)
    expect(v2.valid).toBe(false)
    expect(v2.folderId).toBeNull()
  })
})

describe('share-link scoped access: can view linked folder, denied sibling', () => {
  it('share viewer can list linked folder contents but is denied a sibling folder', async () => {
    setMockUser(OWNER)

    // Create two sibling folders
    const folderA = await createFolder('root', 'Folder A')
    const folderB = await createFolder('root', 'Folder B')

    // Upload a file to folder A so listing isn't empty
    await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: folderA, name: 'Sub Folder' }),
    })

    // Mint a share link scoped to folder A
    const token = await mintLink(folderA)
    const v = await validate(token)
    expect(v.valid).toBe(true)
    expect(v.folderId).toBe(folderA)

    // Switch to share-link viewer context (no user)
    setMockUser(null)
    setMockShareLinkFolderId(folderA)

    // Can list folder A → 200
    const listA = await fetch(`/api/nodes?parentId=${folderA}`)
    expect(listA.status).toBe(200)
    const { nodes: nodesA } = (await listA.json()) as { nodes: unknown[] }
    expect(Array.isArray(nodesA)).toBe(true)

    // Cannot list folder B (sibling, out of scope) → 403
    const listB = await fetch(`/api/nodes?parentId=${folderB}`)
    expect(listB.status).toBe(403)
  })

  it('share viewer can list a sub-folder of the linked folder', async () => {
    setMockUser(OWNER)

    const folderA = await createFolder('root', 'Folder A')
    const subFolder = await createFolder(folderA, 'Sub Folder')

    const token = await mintLink(folderA)
    const v = await validate(token)
    expect(v.valid).toBe(true)
    expect(v.folderId).toBe(folderA)

    // Share-link viewer context
    setMockUser(null)
    setMockShareLinkFolderId(folderA)

    // Can list the sub-folder (folderA is in the ancestor chain → view granted)
    const listSub = await fetch(`/api/nodes?parentId=${subFolder}`)
    expect(listSub.status).toBe(200)
  })
})

describe('share-link expiry', () => {
  it('link with past expiresMs validates as invalid', async () => {
    setMockUser(OWNER)

    const folderId = await createFolder('root', 'Expiry Folder')

    // Mint with expiresMs in the past (1ms)
    const token = await mintLink(folderId, 1)

    // Manually back-date the expiresAt in the store to simulate expiry
    const link = shareLinks.get(token)
    if (link) link.expiresAt = Date.now() - 1000 // 1 second in the past

    // Validate → invalid because expired
    const v = await validate(token)
    expect(v.valid).toBe(false)
    expect(v.folderId).toBeNull()
  })

  it('link with future expiry validates as valid', async () => {
    setMockUser(OWNER)

    const folderId = await createFolder('root', 'Future Expiry')
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    const token = await mintLink(folderId, sevenDays)

    const v = await validate(token)
    expect(v.valid).toBe(true)
    expect(v.folderId).toBe(folderId)

    // expiresAt should be set approximately 7 days from now
    const link = shareLinks.get(token)
    expect(link?.expiresAt).not.toBeNull()
    const daysUntilExpiry = ((link?.expiresAt ?? 0) - Date.now()) / (24 * 60 * 60 * 1000)
    expect(daysUntilExpiry).toBeGreaterThan(6)
    expect(daysUntilExpiry).toBeLessThanOrEqual(7)
  })
})

describe('share-link listing', () => {
  it('owner can list share links for a folder', async () => {
    setMockUser(OWNER)
    const folderId = await createFolder('root', 'List Test Folder')

    const token1 = await mintLink(folderId)
    const token2 = await mintLink(folderId, 7 * 24 * 60 * 60 * 1000)

    const res = await fetch(`/api/share-links?folderId=${encodeURIComponent(folderId)}`)
    expect(res.status).toBe(200)
    const { links } = (await res.json()) as { links: { token: string; revoked: boolean }[] }
    expect(links).toHaveLength(2)
    const tokens = links.map((l) => l.token)
    expect(tokens).toContain(token1)
    expect(tokens).toContain(token2)
    expect(links.every((l) => !l.revoked)).toBe(true)
  })

  it('revoked links appear in listing with revoked:true', async () => {
    setMockUser(OWNER)
    const folderId = await createFolder('root', 'Revoke List Folder')

    const token = await mintLink(folderId)
    await revokeLink(token)

    const res = await fetch(`/api/share-links?folderId=${encodeURIComponent(folderId)}`)
    const { links } = (await res.json()) as { links: { token: string; revoked: boolean }[] }
    expect(links).toHaveLength(1)
    expect(links[0].revoked).toBe(true)
  })
})

describe('share-link validate edge cases', () => {
  it('bogus/unknown token → valid:false', async () => {
    const v = await validate('nonexistent-token-xyz')
    expect(v.valid).toBe(false)
    expect(v.folderId).toBeNull()
  })

  it('validate is public: works without any mock user', async () => {
    setMockUser(OWNER)
    const folderId = await createFolder('root', 'Public Validate Folder')
    const token = await mintLink(folderId)

    // Switch to unauthenticated
    setMockUser(null)

    // validate is still reachable without auth
    const v = await validate(token)
    expect(v.valid).toBe(true)
    expect(v.folderId).toBe(folderId)
  })
})

describe('share-link claim: validates and (in prod) sets the hf_s cookie', () => {
  it('valid token → claim returns valid+folderId (public, no auth)', async () => {
    setMockUser(OWNER)
    const folderId = await createFolder('root', 'Claim Folder')
    const token = await mintLink(folderId)

    setMockUser(null)
    const c = await claim(token)
    expect(c.valid).toBe(true)
    expect(c.folderId).toBe(folderId)
  })

  it('revoked token → claim returns valid:false', async () => {
    setMockUser(OWNER)
    const folderId = await createFolder('root', 'Claim Revoked Folder')
    const token = await mintLink(folderId)
    await revokeLink(token)

    const c = await claim(token)
    expect(c.valid).toBe(false)
    expect(c.folderId).toBeNull()
  })

  it('bogus token → claim returns valid:false', async () => {
    const c = await claim('nonexistent-token-xyz')
    expect(c.valid).toBe(false)
    expect(c.folderId).toBeNull()
  })
})

describe('share-link coercion: toShareLink shape', () => {
  it('minted link has all required fields in response shape', async () => {
    setMockUser(OWNER)
    const folderId = await createFolder('root', 'Shape Test')
    const token = await mintLink(folderId)
    const res = await fetch('/api/share-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId, expiresMs: 86400000 }),
    })
    const json = (await res.json()) as Record<string, unknown>
    expect(typeof json.token).toBe('string')
    expect(json.folderId).toBe(folderId)
    expect(typeof json.expiresAt).toBe('number')
    expect(json.revoked).toBe(false)
    expect(typeof json.url).toBe('string')
    expect(json.url).toMatch(/^\/s\//)
    expect(typeof token).toBe('string') // already validated above
  })

  it('minted link without expiry has null expiresAt', async () => {
    setMockUser(OWNER)
    const folderId = await createFolder('root', 'No Expiry Shape')
    const res = await fetch('/api/share-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId }),
    })
    const json = (await res.json()) as { expiresAt: unknown }
    expect(json.expiresAt).toBeNull()
  })
})
