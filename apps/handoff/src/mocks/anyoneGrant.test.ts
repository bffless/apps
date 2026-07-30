/**
 * End-to-end (fetch → MSW) coverage for public browsing via the Anyone grant
 * (ADR-0005): guests reach ACL evaluation, public subtrees are readable and
 * listed, Restricted cuts publicness, revoking Anyone re-privatizes.
 * Same style as shareRoot.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { setupServer } from 'msw/node'
import {
  handlers,
  resetMockState,
  setMockUser,
  setMockGrants,
  seedFolder,
  seedFile,
} from './handlers'
import { ANYONE_PRINCIPAL } from '../lib/acl'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => {
  resetMockState()
  server.resetHandlers()
})

const OWNER = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }
const anyoneGrant = { principalId: ANYONE_PRINCIPAL, level: 'view' as const }

describe('anonymous public browsing', () => {
  it('guest lists a public folder (200) and a private one is 401', async () => {
    setMockUser(OWNER)
    const pub = seedFolder('Public Docs', 'root')
    const priv = seedFolder('Private Docs', 'root')
    seedFile('readme.md', pub.id)
    setMockGrants(pub.id, [anyoneGrant])

    setMockUser(null) // anonymous
    const ok = await fetch(`/api/nodes?parentId=${pub.id}`)
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { nodes: Array<{ name: string }> }
    expect(body.nodes.map((n) => n.name)).toContain('readme.md')

    const denied = await fetch(`/api/nodes?parentId=${priv.id}`)
    expect(denied.status).toBe(401)
  })

  it('guest root listing shows only public subtrees', async () => {
    setMockUser(OWNER)
    const pub = seedFolder('Public Docs', 'root')
    seedFolder('Private Docs', 'root')
    setMockGrants(pub.id, [anyoneGrant])

    setMockUser(null)
    const res = await fetch('/api/nodes?parentId=root')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { nodes: Array<{ name: string }> }
    expect(body.nodes.map((n) => n.name)).toEqual(['Public Docs'])
  })

  it('a Restricted child under a public folder stays hidden from guests', async () => {
    setMockUser(OWNER)
    const pub = seedFolder('Public Docs', 'root')
    const locked = seedFolder('Salaries', pub.id)
    setMockGrants(pub.id, [anyoneGrant])
    // flip the child to restricted in mock ACL state
    const { nodeAcl } = await import('./handlers')
    const acl = nodeAcl.get(locked.id)!
    nodeAcl.set(locked.id, { ...acl, mode: 'restricted' })

    setMockUser(null)
    const res = await fetch(`/api/nodes?parentId=${locked.id}`)
    expect(res.status).toBe(401)
  })

  it('owner grants Anyone with level edit → stored capped at view; revoke re-privatizes', async () => {
    setMockUser(OWNER)
    const pub = seedFolder('Public Docs', 'root')

    const add = await fetch('/api/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: pub.id, principalId: ANYONE_PRINCIPAL, level: 'edit' }),
    })
    expect(add.status).toBe(200)
    const grants = (await (await fetch(`/api/grants?folderId=${pub.id}`)).json()) as {
      grants: Array<{ principalId: string; level: string }>
    }
    // The Anyone principal is always capped — no type, no name (mirrors the
    // real merge.fn.ts, group grants spec 2026-07-29).
    expect(grants.grants).toEqual([
      { principalId: ANYONE_PRINCIPAL, principalEmail: null, principalName: null, level: 'view' },
    ])

    setMockUser(null)
    expect((await fetch(`/api/nodes?parentId=${pub.id}`)).status).toBe(200)

    setMockUser(OWNER)
    const revoke = await fetch('/api/grants/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: pub.id, principalId: ANYONE_PRINCIPAL }),
    })
    expect(revoke.status).toBe(200)

    setMockUser(null)
    expect((await fetch(`/api/nodes?parentId=${pub.id}`)).status).toBe(401)
  })
})
