import { describe, it, expect } from 'vitest'
import { pickRootNode, rootFolderLink, ROOT_SENTINEL, rootMetaNode } from './rootNode'
import { ANYONE_PRINCIPAL } from './acl'
import type { HandoffNode } from './nodes'

const R = (over: Partial<HandoffNode> = {}): HandoffNode =>
  ({ id: 'R-uuid', name: 'My Files', type: 'root', parentId: '', ownerId: 'owner-1',
     grants: [{ principalId: 'u2', level: 'view' }], mode: 'inheriting',
     size: null, mime: null, createdAt: 0, url: null, storageKey: null, path: null, ...over }) as HandoffNode

describe('pickRootNode', () => {
  it('returns the root-type node', () => {
    expect(pickRootNode([R(), { id: 'x', type: 'folder' } as HandoffNode])?.id).toBe('R-uuid')
  })
  it('returns null when absent', () => {
    expect(pickRootNode([{ id: 'x', type: 'folder' } as HandoffNode])).toBeNull()
  })
})

describe('rootFolderLink', () => {
  it('uses the real root record when present (id + grants carried)', () => {
    const link = rootFolderLink(R())
    expect(link).toEqual({ id: 'R-uuid', ownerId: 'owner-1',
      grants: [{ principalId: 'u2', level: 'view' }], mode: 'inheriting' })
  })
  it('falls back to the share-link scope id when root record is absent', () => {
    expect(rootFolderLink(null, 'R-uuid')).toEqual({ id: 'R-uuid', ownerId: null, grants: [], mode: 'inheriting' })
  })
  it('falls back to the sentinel when nothing is known', () => {
    expect(rootFolderLink(null)).toEqual({ id: ROOT_SENTINEL, ownerId: null, grants: [], mode: 'inheriting' })
  })
})

describe('rootMetaNode', () => {
  it('returns null when meta is undefined', () => {
    expect(rootMetaNode(undefined)).toBeNull()
  })

  it('returns null when meta.id is null', () => {
    expect(rootMetaNode({ id: null, public: false })).toBeNull()
  })

  it('returns a synthetic root node with anyone grant when public is true', () => {
    const result = rootMetaNode({ id: 'R', public: true })
    expect(result).not.toBeNull()
    if (result) {
      expect(result.id).toBe('R')
      expect(result.type).toBe('root')
      expect(result.name).toBe('My Files')
      expect(result.parentId).toBe('')
      expect(result.ownerId).toBeNull()
      expect(result.mode).toBe('inheriting')
      expect(result.grants).toEqual([{ principalId: ANYONE_PRINCIPAL, level: 'view' }])
    }
  })

  it('returns a synthetic root node with empty grants when public is false', () => {
    const result = rootMetaNode({ id: 'R', public: false })
    expect(result).not.toBeNull()
    if (result) {
      expect(result.id).toBe('R')
      expect(result.grants).toEqual([])
    }
  })
})
