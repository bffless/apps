import { describe, it, expect } from 'vitest'
import { pickRootNode, rootFolderLink, ROOT_SENTINEL } from './rootNode'
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
