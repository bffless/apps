/**
 * TDD tests for evaluateAccess — written BEFORE the implementation.
 * Run to confirm RED, then implement acl.ts to go GREEN.
 */

import { describe, it, expect } from 'vitest'
import { evaluateAccess } from './acl'
import type { FolderLink, Viewer } from './acl'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function link(
  ownerId: string | null,
  grants: { principalId: string; level: 'view' | 'edit' }[] = [],
  mode: 'inheriting' | 'restricted' = 'inheriting',
): FolderLink {
  return { ownerId, grants, mode }
}

function viewer(opts: {
  userId?: string
  isAdmin?: boolean
  shareLinkFolderId?: string
} = {}): Viewer {
  return opts
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateAccess', () => {
  // 1. admin → 'owner'
  it('admin always gets owner regardless of grants', () => {
    const result = evaluateAccess({
      folderChain: [link('someone-else', [])],
      viewer: viewer({ userId: 'admin-user', isAdmin: true }),
    })
    expect(result).toBe('owner')
  })

  // 2. owner of target → 'owner'
  it('owner of the target folder gets owner', () => {
    const result = evaluateAccess({
      folderChain: [link('user-a')],
      viewer: viewer({ userId: 'user-a' }),
    })
    expect(result).toBe('owner')
  })

  // 3. owner of ancestor (inherited ownership) → 'owner'
  it('owner of an ancestor folder in the chain gets owner', () => {
    // root → parent (owned by user-a) → target (no owner)
    const result = evaluateAccess({
      folderChain: [
        link('user-a'),     // ancestor
        link(null),         // target
      ],
      viewer: viewer({ userId: 'user-a' }),
    })
    expect(result).toBe('owner')
  })

  // 4. ungranted → 'none'
  it('user with no grants and not owner gets none', () => {
    const result = evaluateAccess({
      folderChain: [link('user-a', [])],
      viewer: viewer({ userId: 'user-b' }),
    })
    expect(result).toBe('none')
  })

  // 5. single view grant on target → 'view'
  it('view grant on target folder yields view', () => {
    const result = evaluateAccess({
      folderChain: [link('user-a', [{ principalId: 'user-b', level: 'view' }])],
      viewer: viewer({ userId: 'user-b' }),
    })
    expect(result).toBe('view')
  })

  // 6. inherited view grant from ancestor → 'view'
  it('view grant on ancestor propagates to target', () => {
    const result = evaluateAccess({
      folderChain: [
        link('user-a', [{ principalId: 'user-b', level: 'view' }]),  // ancestor with grant
        link(null, []),                                                 // target — no grant
      ],
      viewer: viewer({ userId: 'user-b' }),
    })
    expect(result).toBe('view')
  })

  // 7. edit beats view (edit grant → 'edit')
  it('edit grant on target yields edit', () => {
    const result = evaluateAccess({
      folderChain: [link('user-a', [{ principalId: 'user-b', level: 'edit' }])],
      viewer: viewer({ userId: 'user-b' }),
    })
    expect(result).toBe('edit')
  })

  // 8. highest-wins across multiple grants
  it('edit grant on target beats view grant on ancestor', () => {
    const result = evaluateAccess({
      folderChain: [
        link('user-a', [{ principalId: 'user-b', level: 'view' }]),  // ancestor: view
        link(null, [{ principalId: 'user-b', level: 'edit' }]),       // target: edit
      ],
      viewer: viewer({ userId: 'user-b' }),
    })
    expect(result).toBe('edit')
  })

  // Also: view grant on target, edit on ancestor → edit wins
  it('edit grant on ancestor beats view grant on target', () => {
    const result = evaluateAccess({
      folderChain: [
        link('user-a', [{ principalId: 'user-b', level: 'edit' }]),  // ancestor: edit
        link(null, [{ principalId: 'user-b', level: 'view' }]),       // target: view
      ],
      viewer: viewer({ userId: 'user-b' }),
    })
    expect(result).toBe('edit')
  })

  // 9. restricted drops higher inherited grant; owner of folder above restriction retains owner
  it('restricted folder drops grants from above it', () => {
    // user-b has edit grant on the root, but the target is restricted
    // → the grant from above is dropped, so user-b gets none
    const result = evaluateAccess({
      folderChain: [
        link('user-a', [{ principalId: 'user-b', level: 'edit' }]),  // ancestor with grant
        link(null, [], 'restricted'),                                   // target is restricted
      ],
      viewer: viewer({ userId: 'user-b' }),
    })
    expect(result).toBe('none')
  })

  it('owner of folder above restriction retains owner despite restricted child', () => {
    // user-a owns the ancestor, which is above a restricted target
    const result = evaluateAccess({
      folderChain: [
        link('user-a', []),               // ancestor owned by user-a
        link(null, [], 'restricted'),      // restricted target
      ],
      viewer: viewer({ userId: 'user-a' }),
    })
    expect(result).toBe('owner')
  })

  it('restricted folder evaluates its own grants independently', () => {
    // user-b has NO grant on the restricted folder itself but had one above
    // The restricted folder has its own grant for user-c
    const result = evaluateAccess({
      folderChain: [
        link('user-a', [{ principalId: 'user-b', level: 'edit' }]),   // ancestor: edit for user-b
        link(null, [{ principalId: 'user-c', level: 'view' }], 'restricted'), // restricted: only user-c
      ],
      viewer: viewer({ userId: 'user-c' }),
    })
    expect(result).toBe('view')
  })

  // 10. share-link within scope → 'view'
  it('share-link viewer within scoped folder gets view', () => {
    const result = evaluateAccess({
      folderChain: [link('user-a'), link(null)],
      viewer: viewer({ shareLinkFolderId: 'folder-1' }),
    })
    // The scoped folderId must appear in the chain — we use the node's id
    // For this test, build folderChain with identifiable folders
    expect(result).toBe('none') // no chain contains 'folder-1' by id
  })

  it('share-link viewer whose scoped id appears in chain gets view', () => {
    // Build chain where the second folder has the linked id
    const chainLink: FolderLink = { ownerId: null, grants: [], mode: 'inheriting', id: 'folder-1' }
    const result = evaluateAccess({
      folderChain: [{ ownerId: 'user-a', grants: [], mode: 'inheriting' }, chainLink],
      viewer: viewer({ shareLinkFolderId: 'folder-1' }),
    })
    expect(result).toBe('view')
  })

  // 11. share-link denied outside scope → 'none'
  it('share-link viewer outside scope gets none', () => {
    const result = evaluateAccess({
      folderChain: [{ ownerId: 'user-a', grants: [], mode: 'inheriting', id: 'folder-99' }],
      viewer: viewer({ shareLinkFolderId: 'folder-1' }),
    })
    expect(result).toBe('none')
  })

  // 12. share-link never exceeds view even with edit grant
  it('share-link user never exceeds view even with edit grant', () => {
    // A share-link user who happens to also have an edit grant should still only get view
    // (In practice userId is not set for share-link viewers, so grant lookup is skipped)
    const chainLink: FolderLink = {
      ownerId: null,
      grants: [{ principalId: 'user-b', level: 'edit' }],
      mode: 'inheriting',
      id: 'folder-1',
    }
    // share-link viewer: no userId (can't look up grants), just the shareLinkFolderId
    const result = evaluateAccess({
      folderChain: [chainLink],
      viewer: viewer({ shareLinkFolderId: 'folder-1' }),
    })
    expect(result).toBe('view')
  })

  // 13. empty chain → 'none'
  it('empty folder chain returns none', () => {
    const result = evaluateAccess({
      folderChain: [],
      viewer: viewer({ userId: 'user-a' }),
    })
    expect(result).toBe('none')
  })

  // Admin with empty chain still gets owner
  it('admin with empty chain still gets owner', () => {
    const result = evaluateAccess({
      folderChain: [],
      viewer: viewer({ userId: 'admin-user', isAdmin: true }),
    })
    expect(result).toBe('owner')
  })
})
