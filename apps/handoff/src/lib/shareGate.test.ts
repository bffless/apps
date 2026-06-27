/**
 * TDD tests for canShareParentFolder — written BEFORE the implementation.
 * Run to confirm RED, then implement shareGate.ts to go GREEN.
 */

import { describe, it, expect } from 'vitest'
import { canShareParentFolder } from './shareGate'
import type { Session } from './session'
import type { HandoffNode } from './nodes'

const ownerSession: Session = { authenticated: true, user: { id: 'u1' } }
const adminSession: Session = { authenticated: true, user: { id: 'u2', role: 'admin' } }
const guestSession: Session = { authenticated: false }

function folder(ownerId: string | null): HandoffNode {
  return {
    id: 'f1', type: 'folder', name: 'F', mime: null, size: null, url: null,
    storageKey: null, parentId: 'root', createdAt: 0, ownerId, grants: [], mode: 'inheriting',
  }
}

describe('canShareParentFolder', () => {
  it('returns true for admin regardless of ownership', () => {
    expect(canShareParentFolder({ session: adminSession, parentNode: folder('someone-else') })).toBe(true)
  })
  it('returns true when the user owns the parent folder', () => {
    expect(canShareParentFolder({ session: ownerSession, parentNode: folder('u1') })).toBe(true)
  })
  it('returns false when the user does not own the parent folder', () => {
    expect(canShareParentFolder({ session: ownerSession, parentNode: folder('other') })).toBe(false)
  })
  it('returns false while the parent node is still loading (undefined)', () => {
    expect(canShareParentFolder({ session: ownerSession, parentNode: undefined })).toBe(false)
  })
  it('returns false for guests (share-link visitors)', () => {
    expect(canShareParentFolder({ session: guestSession, parentNode: folder('u1') })).toBe(false)
  })
  it('returns false when session is null', () => {
    expect(canShareParentFolder({ session: null, parentNode: folder('u1') })).toBe(false)
  })
})
