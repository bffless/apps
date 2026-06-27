/**
 * Pure gate for the viewer's Delete control.
 *
 * A node may be deleted by anyone with WRITE access (edit or owner) to its
 * owning folder. This mirrors the server's write gate using the folder context
 * the viewer can cheaply see — the node's immediate parent folder plus the node
 * itself (so a root-level file's own owner is still recognised). Ancestors above
 * the parent aren't loaded here, so this can only ever UNDER-grant; the backend
 * enforces the full folder chain regardless. Never throws.
 */

import { evaluateAccess } from './acl'
import type { FolderLink } from './acl'
import type { Session } from './session'
import type { HandoffNode } from './nodes'

export function canDeleteNode(input: {
  session: Session | null
  node: HandoffNode
  /** The node.parentId folder, or undefined while loading / for root items. */
  parentNode: HandoffNode | undefined
}): boolean {
  const { session, node, parentNode } = input
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
    viewer: { userId: session.user.id, isAdmin: session.user.role === 'admin' },
  })
  return level === 'owner' || level === 'edit'
}
