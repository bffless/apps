/**
 * Pure ACL evaluation for the Handoff app.
 *
 * evaluateAccess is the single decision point for access control — it takes a
 * folder chain (root → target) and a viewer, and returns the effective access
 * level. It never throws. Supports the Anyone principal for public access.
 */

export type AccessLevel = 'none' | 'view' | 'edit' | 'owner'

export interface Grant {
  principalId: string
  principalEmail?: string | null
  /** UX metadata only — evaluation matches principalId. Absent ⇒ 'user' (legacy rows). */
  principalType?: 'user' | 'group'
  /** Display snapshot for group grants, taken at grant time. */
  principalName?: string | null
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
  /** Group ids the viewer is a member of (from CE user.groups / /api/me/groups). */
  groupIds?: string[]
  /** When set: this viewer arrived via a share link scoped to this folder id. */
  shareLinkFolderId?: string
}

/** Reserved Principal id representing the anonymous public (ADR-0005). */
export const ANYONE_PRINCIPAL = 'anyone'

/** Whether a grants list makes its folder public (contains the Anyone principal). */
export function hasAnyoneGrant(grants: Grant[]): boolean {
  return grants.some((g) => g.principalId === ANYONE_PRINCIPAL)
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

  // Find the deepest restricted folder — grants from above that point are dropped.
  let startIdx = 0
  for (let i = folderChain.length - 1; i >= 0; i--) {
    if (folderChain[i].mode === 'restricted') {
      startIdx = i
      break
    }
  }

  const levelOrder: AccessLevel[] = ['none', 'view', 'edit', 'owner']
  let best: AccessLevel = 'none'

  function levelRank(l: AccessLevel): number {
    return levelOrder.indexOf(l)
  }

  function promote(candidate: AccessLevel): void {
    if (levelRank(candidate) > levelRank(best)) {
      best = candidate
    }
  }

  // Grant scan — runs for every viewer, anonymous included. An Anyone grant
  // yields at most 'view' regardless of its stored level (defense in depth;
  // the write path also caps it).
  for (let i = startIdx; i < folderChain.length; i++) {
    for (const grant of folderChain[i].grants) {
      if (grant.principalId === ANYONE_PRINCIPAL) {
        promote('view')
      } else if (viewer.userId && grant.principalId === viewer.userId) {
        promote(grant.level)
      } else if (viewer.groupIds && viewer.groupIds.includes(grant.principalId)) {
        promote(grant.level)
      }
    }
  }

  // Share-link viewers (guests only): scoped folder id in the FULL chain
  // yields view — one more promotion source, not an early return.
  if (!viewer.userId && viewer.shareLinkFolderId) {
    if (folderChain.some((f) => f.id === viewer.shareLinkFolderId)) {
      promote('view')
    }
  }

  return best
}

/**
 * Whether the UI should treat the viewer as a **share-link visitor**.
 *
 * Share-mode is for GUESTS only. `shareLinkFolderId` is persisted to
 * localStorage when a visitor opens a `/s/:token` link, and it is never on the
 * URL of normal listing routes — so a stale value can outlive the visit. An
 * authenticated user must always be evaluated by their real identity
 * (role / ownership / grants); a leftover `shareLinkFolderId` must never
 * downgrade them into a scoped 'view' visitor. This mirrors `evaluateAccess`,
 * which only honours `shareLinkFolderId` when there is no `userId`.
 */
export function inShareMode(input: {
  authenticated: boolean
  shareLinkFolderId: string | null
}): boolean {
  return !!input.shareLinkFolderId && !input.authenticated
}

/**
 * Determine whether a folder chain grants any public access.
 *
 * A folder chain is considered effectively public if an anonymous viewer
 * (with no userId or shareLinkFolderId) has access level > 'none'.
 *
 * @param folderChain - Ordered root → target array of FolderLinks.
 * @returns True if public access exists, false otherwise.
 */
export function isEffectivelyPublic(folderChain: FolderLink[]): boolean {
  return evaluateAccess({ folderChain, viewer: {} }) !== 'none'
}

/**
 * Determine whether a child folder is effectively public given its parent chain.
 *
 * Appends the child as a FolderLink (coercing optional grants and mode fields)
 * to the parent chain and evaluates public access on the combined chain.
 *
 * @param folderChain - Parent chain (root → parent).
 * @param child - Child folder with id, ownerId, and optional grants/mode.
 * @returns True if the child is effectively public, false otherwise.
 */
export function childIsPublic(
  folderChain: FolderLink[],
  child: Pick<FolderLink, 'id' | 'ownerId'> & { grants?: Grant[]; mode?: FolderLink['mode'] },
): boolean {
  const childLink: FolderLink = {
    id: child.id,
    ownerId: child.ownerId,
    grants: child.grants ?? [],
    mode: child.mode ?? 'inheriting',
  }
  return isEffectivelyPublic([...folderChain, childLink])
}
