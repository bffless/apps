/**
 * Tests for buildBreadcrumb — pure function that walks parentId chains.
 *
 * RED phase: written before the implementation exists.
 */

import { describe, it, expect } from 'vitest'
import { buildBreadcrumb } from './tree'
import type { Crumb } from './tree'
import type { HandoffNode } from './nodes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFolder(id: string, name: string, parentId: string): HandoffNode {
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
