import type { FolderLink } from './acl'
import type { HandoffNode } from './nodes'

export const ROOT_SENTINEL = 'root'

export function pickRootNode(nodes: HandoffNode[]): HandoffNode | null {
  for (const n of nodes) if (n && n.type === 'root') return n
  return null
}

export function rootFolderLink(root: HandoffNode | null, shareLinkFolderId?: string): FolderLink {
  if (root) {
    return { id: root.id, ownerId: root.ownerId, grants: root.grants ?? [], mode: root.mode }
  }
  return { id: shareLinkFolderId ?? ROOT_SENTINEL, ownerId: null, grants: [], mode: 'inheriting' }
}
