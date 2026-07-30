/**
 * Pure gate for the viewer's comment composer.
 *
 * A node may be commented on by anyone with at least VIEW access to its
 * owning folder, as long as they're logged in — comment authorship only
 * requires being able to see the node, not edit it. This mirrors the
 * server's read gate using the folder context the viewer can cheaply see —
 * the node's immediate parent folder plus the node itself (so a root-level
 * file's own owner is still recognised). Ancestors above the parent aren't
 * loaded here, so this can only ever UNDER-grant; the backend enforces the
 * full folder chain regardless. Never throws.
 */

import { evaluateAccess } from './acl'
import type { FolderLink } from './acl'
import type { Session } from './session'
import type { HandoffNode } from './nodes'

export function canComment(input: {
  session: Session | null
  node: HandoffNode
  /** The node.parentId folder, or undefined while loading / for root items. */
  parentNode: HandoffNode | undefined
  /**
   * Group ids the viewer belongs to (from `useMyGroupsQuery`). `undefined`
   * while loading / on 404 / old CE ⇒ no group promotion — exactly today's
   * behavior, upgrading once the query lands.
   */
  groupIds?: string[]
}): boolean {
  const { session, node, parentNode, groupIds } = input
  if (!session || !session.authenticated) return false

  const folderChain: FolderLink[] = []
  if (parentNode) {
    folderChain.push({
      id: parentNode.id,
      ownerId: parentNode.ownerId,
      grants: parentNode.grants ?? [],
      mode: parentNode.mode,
    })
  }
  // The node itself contributes its owner — a root-level file has no parent
  // folder but its uploader still owns it.
  folderChain.push({
    id: node.id,
    ownerId: node.ownerId,
    grants: node.grants ?? [],
    mode: node.mode,
  })

  const level = evaluateAccess({
    folderChain,
    viewer: { userId: session.user.id, isAdmin: session.user.role === 'admin', groupIds },
  })
  return level !== 'none'
}
