/**
 * Pure ACL evaluation for the Handoff app.
 *
 * evaluateAccess is the single decision point for access control — it takes a
 * folder chain (root → target) and a viewer, and returns the effective access
 * level. It never throws.
 */

export type AccessLevel = 'none' | 'view' | 'edit' | 'owner'

export interface Grant {
  principalId: string
  principalEmail?: string
  level: 'view' | 'edit'
}

export interface FolderLink {
  /** Optional node id — used for share-link scope checking. */
  id?: string
  ownerId: string | null
  grants: Grant[]
  mode: 'inheriting' | 'restricted'
}

export interface Viewer {
  userId?: string
  isAdmin?: boolean
  /** When set: this viewer arrived via a share link scoped to this folder id. */
  shareLinkFolderId?: string
}

/**
 * Determine a viewer's effective access level for the target folder.
 *
 * @param input.folderChain - Ordered root → target array of FolderLinks.
 * @param input.viewer      - The viewer making the request.
 * @returns The highest applicable AccessLevel.
 */
export function evaluateAccess(input: {
  folderChain: FolderLink[]
  viewer: Viewer
}): AccessLevel {
  const { folderChain, viewer } = input

  // Admins always have full access.
  if (viewer.isAdmin) return 'owner'

  // If userId matches the ownerId of ANY folder in the chain → owner.
  if (viewer.userId) {
    for (const folder of folderChain) {
      if (folder.ownerId === viewer.userId) return 'owner'
    }
  }

  // Share-link viewers (no userId): yield at most 'view', only when scoped
  // folder id appears in the chain.
  if (!viewer.userId && viewer.shareLinkFolderId) {
    const inChain = folderChain.some((f) => f.id === viewer.shareLinkFolderId)
    return inChain ? 'view' : 'none'
  }

  // No userId and no share link → none.
  if (!viewer.userId) return 'none'

  // Find the deepest restricted folder — grants from above that point are dropped.
  let startIdx = 0
  for (let i = folderChain.length - 1; i >= 0; i--) {
    if (folderChain[i].mode === 'restricted') {
      startIdx = i
      break
    }
  }

  // Evaluate grants from startIdx onward, taking the highest level.
  const levelOrder: AccessLevel[] = ['none', 'view', 'edit', 'owner']
  let best: AccessLevel = 'none'

  const userId = viewer.userId

  function levelRank(l: AccessLevel): number {
    return levelOrder.indexOf(l)
  }

  function promote(candidate: AccessLevel): void {
    if (levelRank(candidate) > levelRank(best)) {
      best = candidate
    }
  }

  for (let i = startIdx; i < folderChain.length; i++) {
    const folder = folderChain[i]
    for (const grant of folder.grants) {
      if (grant.principalId === userId) {
        promote(grant.level)
      }
    }
  }

  return best
}
