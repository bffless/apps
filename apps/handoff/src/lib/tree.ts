/**
 * Tree / breadcrumb utilities for Handoff.
 *
 * `buildBreadcrumb` walks the parentId chain from a given folder node up to
 * 'root', collecting {id,name} crumbs along the way, then reverses to produce
 * a root→current ordered breadcrumb array.
 *
 * Guarantees:
 *   - Always starts with the synthetic root crumb { id:'root', name:'Home' }.
 *   - If folderId === 'root', returns just the root crumb.
 *   - If an ancestor is missing from the map, stops gracefully (partial chain).
 *   - Cycles (self-parent or A→B→A loops) are capped at MAX_HOPS.
 */

import type { HandoffNode } from './nodes'

export interface Crumb { id: string; name: string }

const ROOT_CRUMB: Crumb = { id: 'root', name: 'Home' }
const MAX_HOPS = 64

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
