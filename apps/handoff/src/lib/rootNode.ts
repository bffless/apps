import type { FolderLink } from './acl'
import { ANYONE_PRINCIPAL } from './acl'
import type { HandoffNode } from './nodes'

export const ROOT_SENTINEL = 'root'

export interface RootMeta {
  id: string | null
  public: boolean
}

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

/**
 * Construct a synthetic root node from metadata.
 *
 * Returns null when meta is undefined or meta.id is falsy. Otherwise creates
 * a synthetic HandoffNode with type 'root', name 'My Files', and grants set to
 * an Anyone/view grant if public is true, or empty otherwise.
 *
 * @param meta - RootMeta with id and public flag, or undefined.
 * @returns A synthetic HandoffNode or null.
 */
export function rootMetaNode(meta: RootMeta | undefined): HandoffNode | null {
  if (!meta?.id) {
    return null
  }

  return {
    id: meta.id,
    type: 'root',
    name: 'My Files',
    parentId: '',
    ownerId: null,
    grants: meta.public ? [{ principalId: ANYONE_PRINCIPAL, level: 'view' }] : [],
    mode: 'inheriting',
    size: null,
    mime: null,
    url: null,
    storageKey: null,
    path: null,
    createdAt: 0,
  } as HandoffNode
}
