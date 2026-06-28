/**
 * Tree / breadcrumb utilities for Handoff.
 *
 * `buildBreadcrumb` walks the parentId chain from a given folder node up to
 * 'root', collecting {id,name} crumbs along the way, then reverses to produce
 * a root→current ordered breadcrumb array.
 *
 * `buildAncestorFolderChain` walks the same chain but returns FolderLink[]
 * (root→target order) for use with evaluateAccess. The root virtual folder is
 * represented with a synthetic FolderLink (no ownerId, no grants, inheriting).
 *
 * Guarantees:
 *   - Always starts with the synthetic root crumb { id:'root', name:'Home' }.
 *   - If folderId === 'root', returns just the root crumb.
 *   - If an ancestor is missing from the map, stops gracefully (partial chain).
 *   - Cycles (self-parent or A→B→A loops) are capped at MAX_HOPS.
 */

import type { HandoffNode } from './nodes'
import type { FolderLink } from './acl'

export interface Crumb { id: string; name: string }

const ROOT_CRUMB: Crumb = { id: 'root', name: 'Home' }
const MAX_HOPS = 64

/**
 * Route a node's location resolves to: the parent Folder when the node lives in
 * one, else Home ('/'). Used by the viewer's Back button and breadcrumb so they
 * return to the parent Folder rather than the root (PRD stories 26–27).
 */
export function parentFolderPath(parentId: string): string {
  return parentId && parentId !== 'root' ? `/folder/${parentId}` : '/'
}

export function buildBreadcrumb(nodesById: Record<string, HandoffNode>, folderId: string): Crumb[] {
  if (folderId === 'root') return [ROOT_CRUMB]

  const crumbs: Crumb[] = []
  let current = folderId
  let hops = 0

  while (current !== 'root' && hops < MAX_HOPS) {
    const node = nodesById[current]
    if (!node) break  // missing ancestor — stop gracefully
    crumbs.push({ id: node.id, name: node.name })
    current = node.parentId
    hops++
  }

  crumbs.reverse()
  return [ROOT_CRUMB, ...crumbs]
}

/**
 * Build an ordered root→target FolderLink[] from the resolved ancestor map.
 *
 * Used by FolderView to pass the full ancestor chain to `evaluateAccess`, so
 * that share-link scope-matching and inherited grants work correctly for
 * sub-folders.
 *
 * - The root virtual folder is represented as a synthetic FolderLink with no
 *   ownerId, no grants, and mode:'inheriting'.
 * - If an ancestor node is missing from the map (chain not fully resolved yet),
 *   the chain is partial (root→… up to the last known ancestor). Callers should
 *   treat a partial chain as "still loading" and fall back gracefully.
 * - Returns `null` when folderId is 'root' and the map is unused (root is
 *   handled by the synthetic root link alone).
 */
export function buildAncestorFolderChain(
  nodesById: Record<string, HandoffNode>,
  folderId: string,
): { chain: FolderLink[]; complete: boolean } {
  // Synthetic root FolderLink — no ownerId, no grants, inheriting.
  const rootLink: FolderLink = { id: 'root', ownerId: null, grants: [], mode: 'inheriting' }

  if (folderId === 'root') {
    return { chain: [rootLink], complete: true }
  }

  // Walk up from folderId to 'root', collecting nodes in reverse order.
  const nodes: HandoffNode[] = []
  let current = folderId
  let hops = 0
  let complete = false

  while (current !== 'root' && hops < MAX_HOPS) {
    const node = nodesById[current]
    if (!node) break  // ancestor not yet resolved — partial chain
    nodes.push(node)
    current = node.parentId
    hops++
  }

  if (current === 'root') complete = true

  // nodes is target→root; reverse to get root→target ancestor order.
  nodes.reverse()

  const chain: FolderLink[] = [
    rootLink,
    ...nodes.map((n) => ({
      id: n.id,
      ownerId: n.ownerId,
      grants: n.grants,
      mode: n.mode,
    })),
  ]

  return { chain, complete }
}
