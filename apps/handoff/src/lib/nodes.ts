/**
 * Node coercion helpers for the Handoff app.
 *
 * Both the live BFFless pipeline responses and the MSW mocks pass through
 * `toNode()` — a single coercion seam so mock == real is enforced at the type
 * level and the swap-don't-rewrite contract is maintained.
 */

import type { Grant } from './acl'

export type { Grant }

export type NodeType = 'file' | 'folder' | 'site'

export interface HandoffNode {
  id: string
  type: NodeType
  name: string
  mime: string | null
  size: number | null
  url: string | null          // BFFless serve path, e.g. /api/uploads/content/<key>
  storageKey: string | null
  parentId: string            // 'root' for top-level files
  createdAt: number           // ms epoch
  /** Null for files/sites; the owner user id for folders. */
  ownerId: string | null
  /** Active grants for this node. Empty array for files/sites. */
  grants: Grant[]
  /** Whether this folder inherits grants from ancestors or starts a new ACL boundary. */
  mode: 'inheriting' | 'restricted'
}

/** Body sent to POST /api/nodes to register a freshly-uploaded file. */
export interface RegisterBody {
  storageKey: string
  originalName: string
  parentId: string
  displayName: string
  createdMs: number
}

/** The shape the prepare endpoint returns (used in buildRegisterBody + uploadFile). */
export interface PreparedUpload {
  uploadUrl: string
  storageKey: string
  publicPath: string
  storedFilename: string
  originalName: string
  expiresIn: number
  expiresAt: number
  maxFileSize: number
  allowedMimeTypes: string[]
}

const KNOWN_TYPES: NodeType[] = ['file', 'folder', 'site']

/**
 * Coerce an unknown API response object into a `HandoffNode`. Never throws.
 * Missing, null, or wrong-typed fields are replaced with safe defaults.
 */
export function toNode(raw: unknown): HandoffNode {
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  // id: coerce to string
  const rawId = obj['id']
  const id = rawId == null ? '' : String(rawId)

  // type: must be one of the known NodeType values
  const rawType = obj['type']
  const type: NodeType = KNOWN_TYPES.includes(rawType as NodeType)
    ? (rawType as NodeType)
    : 'file'

  // name: string, trimmed; fallback 'Untitled'
  const rawName = obj['name']
  const trimmed = typeof rawName === 'string' ? rawName.trim() : ''
  const name = trimmed || 'Untitled'

  // mime: string or null
  const rawMime = obj['mime']
  const mime = typeof rawMime === 'string' ? rawMime : null

  // size: finite number or null
  const rawSize = obj['size']
  const sizeNum = rawSize == null ? NaN : Number(rawSize)
  const size = Number.isFinite(sizeNum) ? sizeNum : null

  // url: string or null
  const rawUrl = obj['url']
  const url = typeof rawUrl === 'string' ? rawUrl : null

  // storageKey: string or null
  const rawKey = obj['storageKey']
  const storageKey = typeof rawKey === 'string' ? rawKey : null

  // parentId: string, fallback 'root'
  const rawParent = obj['parentId']
  const parentId = typeof rawParent === 'string' ? rawParent : 'root'

  // createdAt: finite number or 0
  const rawCreated = obj['createdAt']
  const createdAtNum = rawCreated == null ? NaN : Number(rawCreated)
  const createdAt = Number.isFinite(createdAtNum) ? createdAtNum : 0

  // ownerId: string or null
  const rawOwnerId = obj['ownerId']
  const ownerId = typeof rawOwnerId === 'string' ? rawOwnerId : null

  // grants: array of Grant, or empty array
  const rawGrants = obj['grants']
  const grants: Grant[] = Array.isArray(rawGrants)
    ? rawGrants
        .filter((g): g is Record<string, unknown> => g !== null && typeof g === 'object')
        .map((g) => ({
          principalId: typeof g['principalId'] === 'string' ? g['principalId'] : '',
          principalEmail: typeof g['principalEmail'] === 'string' ? g['principalEmail'] : undefined,
          level: g['level'] === 'edit' ? 'edit' : 'view',
        }))
    : []

  // mode: 'inheriting' | 'restricted'; default 'inheriting' for files/sites
  const rawMode = obj['mode']
  const mode: 'inheriting' | 'restricted' = rawMode === 'restricted' ? 'restricted' : 'inheriting'

  return { id, type, name, mime, size, url, storageKey, parentId, createdAt, ownerId, grants, mode }
}

/**
 * Coerce a raw API response into `HandoffNode[]`. Accepts either:
 *   - `{ nodes: [...] }` (the standard listing envelope)
 *   - a bare `Array`
 *
 * Non-object entries inside the array are silently dropped.
 */
export function toNodeList(raw: unknown): HandoffNode[] {
  let arr: unknown[]
  if (Array.isArray(raw)) {
    arr = raw
  } else if (raw !== null && typeof raw === 'object') {
    const wrapped = (raw as Record<string, unknown>)['nodes']
    arr = Array.isArray(wrapped) ? wrapped : []
  } else {
    return []
  }
  return arr
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map(toNode)
}

/**
 * Build the request body for `POST /api/nodes` (register a freshly-uploaded
 * file). Pure function — gives a clean unit-test seam and keeps the network
 * layer thin.
 */
export function buildRegisterBody(
  prepared: PreparedUpload,
  file: File,
  parentId: string,
  nowMs: number,
): RegisterBody {
  return {
    storageKey: prepared.storageKey,
    originalName: file.name,
    parentId,
    displayName: file.name,
    createdMs: nowMs,
  }
}
