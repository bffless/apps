/**
 * Pure gate for the viewer's Share control.
 *
 * Decides whether the current viewer may create share links for a node's parent
 * folder. Mirrors the server's mint authorization exactly: a user may share a
 * folder if they are an admin or own that folder. Never throws.
 */

import type { Session } from './session'
import type { HandoffNode } from './nodes'

export function canShareParentFolder(input: {
  session: Session | null
  /** The node.parentId folder, or undefined while loading / for root items. */
  parentNode: HandoffNode | undefined
}): boolean {
  const { session, parentNode } = input
  if (!session || !session.authenticated) return false
  if (session.user.role === 'admin') return true
  return parentNode != null && parentNode.ownerId === session.user.id
}
