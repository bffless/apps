/**
 * End-to-end coverage for sharing the root folder ("My Files").
 *
 * The backend pipeline (Tasks 4–6) resolves the `'root'` sentinel to the
 * singleton root record `R` in mint/grants/revoke, and injects `R` into the
 * ACL gates' folder chain so a guest scoped to `R` (or a root grantee) is
 * authorized. This mock mirrors that resolution (`resolveFolderId` +
 * `buildAncestorIds` in `handlers.ts`, seeded via `seedRoot`/`ROOT_RECORD_ID`)
 * so these tests genuinely exercise the guest/grantee/revoke paths, not a
 * mock that just happens to always allow.
 *
 * Drives fetch against the MSW handlers (mock == real at the `toNode` seam),
 * same style as `acl.test.ts` / `shareLinks.test.ts` / `deleteNode.test.ts`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { setupServer } from 'msw/node'
import {
  handlers,
  resetMockState,
  setMockUser,
  setMockShareLinkFolderId,
  seedFolder,
  seedFile,
  shareLinks,
  ROOT_RECORD_ID,
} from './handlers'

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => {
  resetMockState()
  server.resetHandlers()
})

const ADMIN = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }
const GRANTEE = { id: 'user-grantee', email: 'grantee@example.com' }
const OTHER = { id: 'user-other', email: 'other@example.com' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mintLink(folderId: string): Promise<{ token: string; folderId: string }> {
  const res = await fetch('/api/share-links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId }),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ token: string; folderId: string }>
}

async function grant(folderId: string, principalId: string, level: 'view' | 'edit' = 'view') {
  const res = await fetch('/api/grants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId, principalId, level }),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ grants: { principalId: string }[] }>
}

async function revoke(folderId: string, principalId: string) {
  return fetch('/api/grants/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId, principalId }),
  })
}

// ---------------------------------------------------------------------------
// 1. Mint stores R's UUID, not the literal 'root'
// ---------------------------------------------------------------------------

describe('mint on root resolves the sentinel to R', () => {
  it("stores R's real id as the link's folderId, not the string 'root'", async () => {
    setMockUser(ADMIN)

    const minted = await mintLink('root')

    expect(minted.folderId).toBe(ROOT_RECORD_ID)
    expect(minted.folderId).not.toBe('root')

    const stored = shareLinks.get(minted.token)
    expect(stored?.folderId).toBe(ROOT_RECORD_ID)
  })
})

// ---------------------------------------------------------------------------
// 2. A guest scoped to R sees content nested under a top-level folder
// ---------------------------------------------------------------------------

describe('a root-scoped guest browses nested content', () => {
  it('a guest scoped to R (via mint) can getNode/listNodes a file nested under a top-level folder', async () => {
    setMockUser(ADMIN)
    const top = seedFolder('Shared', 'root')
    const nested = seedFile('Nested.txt', top.id)

    const minted = await mintLink('root')
    expect(minted.folderId).toBe(ROOT_RECORD_ID)

    setMockUser(null)
    setMockShareLinkFolderId(minted.folderId)

    const listRes = await fetch(`/api/nodes?parentId=${top.id}`)
    expect(listRes.status).toBe(200)
    const { nodes: children } = (await listRes.json()) as { nodes: { id: string; name: string }[] }
    expect(children.some((n) => n.id === nested.id && n.name === 'Nested.txt')).toBe(true)

    const nodeRes = await fetch(`/api/node?id=${nested.id}`)
    expect(nodeRes.status).toBe(200)
    const { node } = (await nodeRes.json()) as { node: { id: string } | null }
    expect(node?.id).toBe(nested.id)
  })
})

// ---------------------------------------------------------------------------
// 3. A grant on root inherits down to nested content for a non-admin grantee
// ---------------------------------------------------------------------------

describe('a grant on root inherits to nested content', () => {
  it('a non-admin user granted view on root can access a nested file', async () => {
    setMockUser(ADMIN)
    const top = seedFolder('Shared2', 'root')
    const nested = seedFile('Deep.txt', top.id)

    const { grants: updated } = await grant('root', GRANTEE.id, 'view')
    expect(updated.some((g) => g.principalId === GRANTEE.id)).toBe(true)

    setMockUser(GRANTEE)

    const listRes = await fetch(`/api/nodes?parentId=${top.id}`)
    expect(listRes.status).toBe(200)

    const nodeRes = await fetch(`/api/node?id=${nested.id}`)
    expect(nodeRes.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 4. Negative: no share scope, no grant → nested access denied
// ---------------------------------------------------------------------------

describe('no share scope and no grant denies nested access', () => {
  it('a plain authenticated user with no grant is denied nested content', async () => {
    setMockUser(ADMIN)
    const top = seedFolder('Private', 'root')
    seedFile('Secret.txt', top.id)

    setMockUser(OTHER)

    const res = await fetch(`/api/nodes?parentId=${top.id}`)
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// 5. Revoke on root removes previously-inherited access
// ---------------------------------------------------------------------------

describe('revoking a root grant removes inherited access', () => {
  it('grant then revoke on root removes the grantee\'s access to nested content', async () => {
    setMockUser(ADMIN)
    const top = seedFolder('Shared3', 'root')

    await grant('root', GRANTEE.id, 'view')

    setMockUser(GRANTEE)
    const before = await fetch(`/api/nodes?parentId=${top.id}`)
    expect(before.status).toBe(200)

    setMockUser(ADMIN)
    const revokeRes = await revoke('root', GRANTEE.id)
    expect(revokeRes.status).toBe(200)
    const { grants: afterRevoke } = (await revokeRes.json()) as { grants: { principalId: string }[] }
    expect(afterRevoke.some((g) => g.principalId === GRANTEE.id)).toBe(false)

    setMockUser(GRANTEE)
    const after = await fetch(`/api/nodes?parentId=${top.id}`)
    expect(after.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Part A wiring check: FolderView threads the share scope into the chain
// ---------------------------------------------------------------------------

describe('FolderView wiring: threads the share scope into buildAncestorFolderChain', () => {
  // Why a structural check instead of a full RTL render: a share-link viewer's
  // effective access level is capped at 'view' either way the chain head
  // resolves, and 'view' vs 'none' gates no visible affordance in FolderView —
  // only canWrite/canManage do (both false for a capped viewer regardless).
  // The actual HTTP status a render would observe is enforced server-side
  // (Part B, the mock's checkAccess), independent of the client's local
  // evaluateAccess call — so a render test would pass even if this call site
  // were never wired, giving false confidence. A structural check on the call
  // site — the same style as the pipeline JSON guards in
  // `lib/shareRootRules.test.ts` — is the precise, lightweight way to lock in
  // the one-liner itself (buildAncestorFolderChain's chain-head resolution is
  // already unit-tested in `lib/tree.test.ts`).
  // Resolved from process.cwd() (the package root under pnpm) rather than
  // import.meta.url — under the jsdom test environment import.meta.url is not
  // reliably a file:// URL, unlike the plain-node shareRootRules.test.ts.
  const source = readFileSync(resolve(process.cwd(), 'src/pages/FolderView.tsx'), 'utf8')

  it('passes isShareMode ? (shareLinkFolderId ?? undefined) : undefined as the 4th argument', () => {
    const call = source.match(/buildAncestorFolderChain\(\s*([\s\S]*?)\s*\)\s*\n/)
    expect(call, 'buildAncestorFolderChain call site found in FolderView.tsx').toBeTruthy()

    const args = call![1]
    expect(args).toContain('ancestorNodesById')
    expect(args).toContain('folderId')
    // 3rd positional arg (rootNode) must stay null — fetching R for
    // authenticated grantees' chain grants is an explicit deferred follow-up.
    expect(args).toMatch(/null\s*,/)
    expect(args).toMatch(/isShareMode\s*\?\s*\(shareLinkFolderId\s*\?\?\s*undefined\)\s*:\s*undefined/)
  })
})
