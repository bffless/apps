/**
 * End-to-end (fetch → MSW) coverage for the "effective Public/Private UI"
 * feature: root-level publicness display via inheritance, and the
 * inherit → cut-off (restricted) round trip, plus PATCH /api/node guards
 * (non-owner 403, bad target 400). Same style as `anyoneGrant.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { setupServer } from 'msw/node'
import {
  handlers,
  resetMockState,
  setMockUser,
  setMockGrants,
  seedFolder,
  ROOT_RECORD_ID,
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
const OTHER_USER = { id: 'user-alice', email: 'alice@example.com', role: 'member' }
const anyoneGrant = { principalId: ANYONE_PRINCIPAL, level: 'view' as const }

describe('effective public/private — inherit + cut-off round trip', () => {
  it('public root + fresh subfolder: anon subfolder listing 200, root listing shows root.public true', async () => {
    setMockUser(OWNER)
    setMockGrants(ROOT_RECORD_ID, [anyoneGrant])
    const sub = seedFolder('Photos', 'root')

    setMockUser(null)
    const subListing = await fetch(`/api/nodes?parentId=${sub.id}`)
    expect(subListing.status).toBe(200)

    const rootListing = await fetch('/api/nodes?parentId=root')
    expect(rootListing.status).toBe(200)
    const rootBody = (await rootListing.json()) as { root: { id: string | null; public: boolean } }
    expect(rootBody.root.public).toBe(true)
  })

  it('owner cuts off the subfolder to restricted: anon subfolder listing 401, subfolder drops from anon root listing', async () => {
    setMockUser(OWNER)
    setMockGrants(ROOT_RECORD_ID, [anyoneGrant])
    const sub = seedFolder('Photos', 'root')

    const patch = await fetch('/api/node', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sub.id, mode: 'restricted' }),
    })
    expect(patch.status).toBe(200)
    expect((await patch.json()) as { mode: string }).toEqual({ id: sub.id, mode: 'restricted' })

    setMockUser(null)
    const subListing = await fetch(`/api/nodes?parentId=${sub.id}`)
    expect(subListing.status).toBe(401)

    const rootListing = await fetch('/api/nodes?parentId=root')
    expect(rootListing.status).toBe(200)
    const rootBody = (await rootListing.json()) as { nodes: Array<{ id: string; name: string }> }
    expect(rootBody.nodes.map((n) => n.id)).not.toContain(sub.id)
    expect(rootBody.nodes.map((n) => n.name)).not.toContain('Photos')
  })

  it('PATCH by a non-owner, non-admin user is 403 and leaves mode unchanged', async () => {
    setMockUser(OWNER)
    const sub = seedFolder('Photos', 'root') // ownerId === OWNER.id

    setMockUser(OTHER_USER) // mismatched, non-admin
    const patch = await fetch('/api/node', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sub.id, mode: 'restricted' }),
    })
    expect(patch.status).toBe(403)

    setMockUser(OWNER)
    const check = await fetch(`/api/node?id=${sub.id}`)
    const body = (await check.json()) as { node: { mode: string } }
    expect(body.node.mode).toBe('inheriting')
  })

  it('PATCH targeting the root record id is 400', async () => {
    setMockUser(OWNER)
    const patch = await fetch('/api/node', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ROOT_RECORD_ID, mode: 'restricted' }),
    })
    expect(patch.status).toBe(400)
  })
})
