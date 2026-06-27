/**
 * Unit tests for `canDeleteNode` — the viewer's write-gate for the Delete
 * control. Proves it shows only for edit/owner/admin and hides for view-only,
 * unauthenticated, and non-granted viewers.
 */

import { describe, it, expect } from 'vitest'
import { canDeleteNode } from './deleteGate'
import type { Session } from './session'
import type { HandoffNode } from './nodes'

function file(over: Partial<HandoffNode> = {}): HandoffNode {
  return {
    id: 'file-1', type: 'file', name: 'doc.txt', mime: null, size: null, url: null,
    storageKey: 'content/abc', parentId: 'folder-1', createdAt: 0,
    ownerId: null, grants: [], mode: 'inheriting', ...over,
  }
}

function folder(over: Partial<HandoffNode> = {}): HandoffNode {
  return {
    id: 'folder-1', type: 'folder', name: 'Folder', mime: null, size: null, url: null,
    storageKey: null, parentId: 'root', createdAt: 0,
    ownerId: null, grants: [], mode: 'inheriting', ...over,
  }
}

const authed = (id: string, role?: string): Session => ({ authenticated: true, user: { id, role } })

describe('canDeleteNode', () => {
  it('denies an unauthenticated viewer', () => {
    expect(canDeleteNode({ session: { authenticated: false }, node: file(), parentNode: folder() })).toBe(false)
    expect(canDeleteNode({ session: null, node: file(), parentNode: folder() })).toBe(false)
  })

  it('allows the owner of the parent folder', () => {
    const parent = folder({ ownerId: 'alice' })
    expect(canDeleteNode({ session: authed('alice'), node: file(), parentNode: parent })).toBe(true)
  })

  it('allows an edit-granted viewer but denies a view-only viewer', () => {
    const parent = folder({ grants: [{ principalId: 'bob', level: 'edit' }] })
    expect(canDeleteNode({ session: authed('bob'), node: file(), parentNode: parent })).toBe(true)

    const viewParent = folder({ grants: [{ principalId: 'carol', level: 'view' }] })
    expect(canDeleteNode({ session: authed('carol'), node: file(), parentNode: viewParent })).toBe(false)
  })

  it('allows an admin regardless of grants', () => {
    expect(canDeleteNode({ session: authed('admin', 'admin'), node: file(), parentNode: folder() })).toBe(true)
  })

  it('recognises the owner of a root-level file (no parent folder)', () => {
    const rootFile = file({ parentId: 'root', ownerId: 'dave' })
    expect(canDeleteNode({ session: authed('dave'), node: rootFile, parentNode: undefined })).toBe(true)
    expect(canDeleteNode({ session: authed('eve'), node: rootFile, parentNode: undefined })).toBe(false)
  })
})
