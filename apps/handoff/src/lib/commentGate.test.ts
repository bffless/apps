/**
 * Unit tests for `canComment` — the viewer's client-side gate for the margin
 * comment composer. Proves it shows for any authenticated viewer with at
 * least VIEW access (view/edit/owner/admin) and hides for view-only-denied,
 * unauthenticated, and non-granted viewers.
 */

import { describe, it, expect } from 'vitest'
import { canComment } from './commentGate'
import type { Session } from './session'
import type { HandoffNode } from './nodes'

function file(over: Partial<HandoffNode> = {}): HandoffNode {
  return {
    id: 'file-1', type: 'file', name: 'doc.txt', mime: null, size: null, url: null,
    storageKey: 'content/abc', path: 'abc', parentId: 'folder-1', createdAt: 0,
    ownerId: null, grants: [], mode: 'inheriting', title: null, description: null, ...over,
  }
}

function folder(over: Partial<HandoffNode> = {}): HandoffNode {
  return {
    id: 'folder-1', type: 'folder', name: 'Folder', mime: null, size: null, url: null,
    storageKey: null, path: null, parentId: 'root', createdAt: 0,
    ownerId: null, grants: [], mode: 'inheriting', title: null, description: null, ...over,
  }
}

const authed = (id: string, role?: string): Session => ({ authenticated: true, user: { id, role } })

describe('canComment', () => {
  it('denies an unauthenticated viewer', () => {
    expect(canComment({ session: { authenticated: false }, node: file(), parentNode: folder() })).toBe(false)
    expect(canComment({ session: null, node: file(), parentNode: folder() })).toBe(false)
  })

  it('allows the owner of the parent folder', () => {
    const parent = folder({ ownerId: 'alice' })
    expect(canComment({ session: authed('alice'), node: file(), parentNode: parent })).toBe(true)
  })

  it('allows a view-only-granted viewer (the key difference from canDeleteNode)', () => {
    const viewParent = folder({ grants: [{ principalId: 'carol', level: 'view' }] })
    expect(canComment({ session: authed('carol'), node: file(), parentNode: viewParent })).toBe(true)
  })

  it('denies an authenticated stranger with no grant', () => {
    const parent = folder({ ownerId: 'alice' })
    expect(canComment({ session: authed('mallory'), node: file(), parentNode: parent })).toBe(false)
  })

  it('allows an admin regardless of grants', () => {
    expect(canComment({ session: authed('admin', 'admin'), node: file(), parentNode: folder() })).toBe(true)
  })

  it('allows a view-granted group member but denies a non-member', () => {
    const parent = folder({ grants: [{ principalId: 'group-eng', principalType: 'group', level: 'view' }] })
    expect(
      canComment({ session: authed('carol'), node: file(), parentNode: parent, groupIds: ['group-eng'] }),
    ).toBe(true)
    expect(
      canComment({ session: authed('carol'), node: file(), parentNode: parent, groupIds: ['group-design'] }),
    ).toBe(false)
  })

  it('undefined groupIds is exactly today\'s behavior — no group promotion', () => {
    const parent = folder({ grants: [{ principalId: 'group-eng', principalType: 'group', level: 'view' }] })
    expect(canComment({ session: authed('carol'), node: file(), parentNode: parent })).toBe(false)
  })
})
