/**
 * Tests for buildBreadcrumb and buildAncestorFolderChain — pure tree utilities.
 */

import { describe, it, expect } from 'vitest'
import { buildBreadcrumb, buildAncestorFolderChain, parentFolderPath } from './tree'
import { evaluateAccess } from './acl'
import type { Crumb } from './tree'
import type { FolderLink } from './acl'
import type { HandoffNode } from './nodes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFolder(
  id: string,
  name: string,
  parentId: string,
  overrides: Partial<Pick<HandoffNode, 'ownerId' | 'grants' | 'mode'>> = {},
): HandoffNode {
  return {
    id,
    type: 'folder',
    name,
    mime: null,
    size: null,
    url: null,
    storageKey: null,
    parentId,
    createdAt: 0,
    ownerId: null,
    grants: [],
    mode: 'inheriting',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('buildBreadcrumb', () => {
  it('returns [root] when folderId is "root"', () => {
    const result = buildBreadcrumb({}, 'root')
    expect(result).toEqual<Crumb[]>([{ id: 'root', name: 'Home' }])
  })

  it('one level deep: folder whose parentId is "root"', () => {
    const nodesById: Record<string, HandoffNode> = {
      abc: makeFolder('abc', 'Documents', 'root'),
    }
    const result = buildBreadcrumb(nodesById, 'abc')
    expect(result).toEqual<Crumb[]>([
      { id: 'root', name: 'Home' },
      { id: 'abc', name: 'Documents' },
    ])
  })

  it('three levels deep: root → A → B → C', () => {
    const nodesById: Record<string, HandoffNode> = {
      a: makeFolder('a', 'Level A', 'root'),
      b: makeFolder('b', 'Level B', 'a'),
      c: makeFolder('c', 'Level C', 'b'),
    }
    const result = buildBreadcrumb(nodesById, 'c')
    expect(result).toEqual<Crumb[]>([
      { id: 'root', name: 'Home' },
      { id: 'a', name: 'Level A' },
      { id: 'b', name: 'Level B' },
      { id: 'c', name: 'Level C' },
    ])
  })

  it('missing ancestor: stops gracefully and still root-prefixes the partial chain', () => {
    // 'c' → 'b' → 'missing' (not in map); should return [root, b, c]
    // Note: walk stops when it can't find the ancestor; b is known, missing is not.
    // Walk from c: node c.parentId=b → add c, then node b.parentId=missing → add b, then missing → stop.
    // Reversed: [b, c] → prepend root → [root, b, c]
    const nodesById: Record<string, HandoffNode> = {
      b: makeFolder('b', 'Level B', 'missing'),
      c: makeFolder('c', 'Level C', 'b'),
    }
    const result = buildBreadcrumb(nodesById, 'c')
    expect(result[0]).toEqual({ id: 'root', name: 'Home' })
    // Should include 'b' and 'c' (the known part of the chain)
    const ids = result.map((c: Crumb) => c.id)
    expect(ids).toContain('b')
    expect(ids).toContain('c')
    // 'missing' should NOT appear (it wasn't in the map)
    expect(ids).not.toContain('missing')
  })

  it('cycle/self-parent guard: caps at 64 hops and does not hang', () => {
    // Node 'x' points to itself as parent — should cap at MAX_HOPS and return
    const nodesById: Record<string, HandoffNode> = {
      x: makeFolder('x', 'Cycle Node', 'x'),
    }
    // Should not hang; result must be an array starting with root crumb
    const result = buildBreadcrumb(nodesById, 'x')
    expect(Array.isArray(result)).toBe(true)
    expect(result[0]).toEqual({ id: 'root', name: 'Home' })
    // Should have at most MAX_HOPS + 1 (root) entries
    expect(result.length).toBeLessThanOrEqual(65)
  })

  it('two-node cycle: A → B → A', () => {
    const nodesById: Record<string, HandoffNode> = {
      a: makeFolder('a', 'Node A', 'b'),
      b: makeFolder('b', 'Node B', 'a'),
    }
    const result = buildBreadcrumb(nodesById, 'a')
    expect(Array.isArray(result)).toBe(true)
    expect(result[0]).toEqual({ id: 'root', name: 'Home' })
    expect(result.length).toBeLessThanOrEqual(65)
  })

  it('unknown folderId (not in map) → still returns [{ id:"root", name:"Home" }]', () => {
    const result = buildBreadcrumb({}, 'unknown-id')
    expect(result).toEqual<Crumb[]>([{ id: 'root', name: 'Home' }])
  })
})

// ---------------------------------------------------------------------------
// parentFolderPath tests — drives the viewer's Back button (PRD story 27).
// ---------------------------------------------------------------------------

describe('parentFolderPath', () => {
  it('returns the parent folder route when the node lives in a folder', () => {
    expect(parentFolderPath('abc')).toBe('/folder/abc')
  })

  it('returns Home for a top-level item (parentId === "root")', () => {
    expect(parentFolderPath('root')).toBe('/')
  })

  it('returns Home when parentId is empty/missing', () => {
    expect(parentFolderPath('')).toBe('/')
  })
})

// ---------------------------------------------------------------------------
// buildAncestorFolderChain tests
// ---------------------------------------------------------------------------

describe('buildAncestorFolderChain', () => {
  it('root folder → single synthetic root link, complete=true', () => {
    const { chain, complete } = buildAncestorFolderChain({}, 'root')
    expect(complete).toBe(true)
    expect(chain).toHaveLength(1)
    expect(chain[0].id).toBe('root')
    expect(chain[0].ownerId).toBeNull()
    expect(chain[0].grants).toEqual([])
    expect(chain[0].mode).toBe('inheriting')
  })

  it('one-level deep (parentId=root) → [rootLink, folderLink], complete=true', () => {
    const nodesById = {
      a: makeFolder('a', 'Docs', 'root', { ownerId: 'user-1' }),
    }
    const { chain, complete } = buildAncestorFolderChain(nodesById, 'a')
    expect(complete).toBe(true)
    expect(chain).toHaveLength(2)
    expect(chain[0].id).toBe('root')
    expect(chain[1].id).toBe('a')
    expect(chain[1].ownerId).toBe('user-1')
  })

  it('root→A→B→C chain: ordered correctly, complete=true, ids mapped', () => {
    const nodesById = {
      a: makeFolder('a', 'A', 'root', { ownerId: 'user-1' }),
      b: makeFolder('b', 'B', 'a', { grants: [{ principalId: 'user-2', level: 'view' }] }),
      c: makeFolder('c', 'C', 'b', { mode: 'restricted' }),
    }
    const { chain, complete } = buildAncestorFolderChain(nodesById, 'c')
    expect(complete).toBe(true)
    expect(chain.map((l: FolderLink) => l.id)).toEqual(['root', 'a', 'b', 'c'])
    expect(chain[3].mode).toBe('restricted')
    expect(chain[2].grants).toHaveLength(1)
  })

  it('partial chain (ancestor missing) → complete=false, partial chain returned', () => {
    // b→missing (not in map); only b and c are known
    const nodesById = {
      b: makeFolder('b', 'B', 'missing-parent'),
      c: makeFolder('c', 'C', 'b'),
    }
    const { chain, complete } = buildAncestorFolderChain(nodesById, 'c')
    expect(complete).toBe(false)
    // root + b + c (walk stops when 'missing-parent' not found after resolving b)
    const ids = chain.map((l: FolderLink) => l.id)
    expect(ids).toContain('root')
    expect(ids).toContain('b')
    expect(ids).toContain('c')
    expect(ids).not.toContain('missing-parent')
  })

  it('share-link sub-folder: scoped folder A appears in chain → evaluateAccess returns view', () => {
    // A visitor with a share link scoped to 'folder-a' navigates into child 'folder-b'.
    // The full chain [root, folder-a, folder-b] contains folder-a so evaluateAccess
    // must return 'view', NOT 'none'.
    const nodesById = {
      'folder-a': makeFolder('folder-a', 'A', 'root'),
      'folder-b': makeFolder('folder-b', 'B', 'folder-a'),
    }
    const { chain } = buildAncestorFolderChain(nodesById, 'folder-b')
    const level = evaluateAccess({
      folderChain: chain,
      viewer: { shareLinkFolderId: 'folder-a' },
    })
    expect(level).toBe('view')
  })

  it('share-link sibling denial: scoped folder A not in chain for sibling → evaluateAccess returns none', () => {
    // A visitor scoped to 'folder-a' tries to access sibling 'folder-sibling' (parentId=root).
    // The chain [root, folder-sibling] does NOT contain folder-a → must return 'none'.
    const nodesById = {
      'folder-sibling': makeFolder('folder-sibling', 'Sibling', 'root'),
    }
    const { chain } = buildAncestorFolderChain(nodesById, 'folder-sibling')
    const level = evaluateAccess({
      folderChain: chain,
      viewer: { shareLinkFolderId: 'folder-a' },
    })
    expect(level).toBe('none')
  })

  it('inherited grant: user with edit grant on ancestor sees edit on sub-folder', () => {
    // user-b has an edit grant on 'folder-a'; navigating into child 'folder-b' (inheriting)
    // should still yield 'edit' when the full chain is passed.
    const nodesById = {
      'folder-a': makeFolder('folder-a', 'A', 'root', {
        ownerId: 'user-owner',
        grants: [{ principalId: 'user-b', level: 'edit' }],
      }),
      'folder-b': makeFolder('folder-b', 'B', 'folder-a'),
    }
    const { chain } = buildAncestorFolderChain(nodesById, 'folder-b')
    const level = evaluateAccess({
      folderChain: chain,
      viewer: { userId: 'user-b' },
    })
    expect(level).toBe('edit')
  })
})
