/**
 * Comment coercion + threading helpers. Both live pipeline responses and MSW
 * mocks pass through `toComment()` — the same single-seam contract as `toNode`.
 */

export interface CommentAnchorText {
  type: 'text'
  quote: string
  prefix: string
  suffix: string
  start: number
  end: number
}
export interface CommentAnchorPin {
  type: 'pin'
  /** Fractions of the image's natural width/height, 0..1. */
  x: number
  y: number
}
export type CommentAnchor = CommentAnchorText | CommentAnchorPin

export interface HandoffComment {
  id: string
  nodeId: string
  /** Null for thread roots; the root comment's id for replies. */
  parentId: string | null
  authorId: string
  authorName: string
  body: string
  /** Roots only; replies carry null. */
  anchor: CommentAnchor | null
  resolved: boolean
  resolvedBy: string | null
  resolvedMs: number | null
  /** emoji → user ids who reacted. */
  reactions: Record<string, string[]>
  /** Soft-deleted root husk (kept so its replies survive). */
  deleted: boolean
  createdMs: number
  updatedMs: number | null
}

export interface CommentThread {
  root: HandoffComment
  replies: HandoffComment[]
}

function parseAnchor(raw: unknown): CommentAnchor | null {
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.type === 'text') {
    const start = Number(o.start)
    const end = Number(o.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null
    return {
      type: 'text',
      quote: typeof o.quote === 'string' ? o.quote : '',
      prefix: typeof o.prefix === 'string' ? o.prefix : '',
      suffix: typeof o.suffix === 'string' ? o.suffix : '',
      start,
      end,
    }
  }
  if (o.type === 'pin') {
    const x = Number(o.x)
    const y = Number(o.y)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null
    return { type: 'pin', x, y }
  }
  return null
}

function parseReactions(raw: unknown): Record<string, string[]> {
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return {}
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string[]> = {}
  for (const [k, ids] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(ids)) {
      const clean = ids.filter((i): i is string => typeof i === 'string')
      if (clean.length) out[k] = clean
    }
  }
  return out
}

/**
 * Coerce an unknown API response object into a `HandoffComment`. Never
 * throws. Missing, null, or wrong-typed fields are replaced with safe
 * defaults.
 */
export function toComment(raw: unknown): HandoffComment {
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  // id: coerce to string
  const rawId = obj['id']
  const id = rawId == null ? '' : String(rawId)

  // nodeId: coerce to string
  const rawNodeId = obj['nodeId']
  const nodeId = rawNodeId == null ? '' : String(rawNodeId)

  // parentId: non-empty string, else null
  const rawParentId = obj['parentId']
  const parentId = typeof rawParentId === 'string' && rawParentId !== '' ? rawParentId : null

  // authorId / authorName: string, else ''
  const rawAuthorId = obj['authorId']
  const authorId = typeof rawAuthorId === 'string' ? rawAuthorId : ''
  const rawAuthorName = obj['authorName']
  const authorName = typeof rawAuthorName === 'string' ? rawAuthorName : ''

  // body: string, else ''
  const rawBody = obj['body']
  const body = typeof rawBody === 'string' ? rawBody : ''

  // anchor: parsed from anchorJson (string or already-parsed object)
  const anchor = parseAnchor(obj['anchorJson'])

  // resolved: boolean, may arrive as the string 'true' from the data table
  const rawResolved = obj['resolved']
  const resolved = rawResolved === true || rawResolved === 'true'

  // resolvedBy: string or null
  const rawResolvedBy = obj['resolvedBy']
  const resolvedBy = typeof rawResolvedBy === 'string' ? rawResolvedBy : null

  // resolvedMs: finite number or null
  const rawResolvedMs = obj['resolvedMs']
  const resolvedMsNum = rawResolvedMs == null ? NaN : Number(rawResolvedMs)
  const resolvedMs = Number.isFinite(resolvedMsNum) ? resolvedMsNum : null

  // reactions: parsed from reactionsJson (string or already-parsed object)
  const reactions = parseReactions(obj['reactionsJson'])

  // deleted: boolean, may arrive as the string 'true'
  const rawDeleted = obj['deleted']
  const deleted = rawDeleted === true || rawDeleted === 'true'

  // createdMs: finite number or 0
  const rawCreatedMs = obj['createdMs']
  const createdMsNum = rawCreatedMs == null ? NaN : Number(rawCreatedMs)
  const createdMs = Number.isFinite(createdMsNum) ? createdMsNum : 0

  // updatedMs: finite number or null
  const rawUpdatedMs = obj['updatedMs']
  const updatedMsNum = rawUpdatedMs == null ? NaN : Number(rawUpdatedMs)
  const updatedMs = Number.isFinite(updatedMsNum) ? updatedMsNum : null

  return {
    id,
    nodeId,
    parentId,
    authorId,
    authorName,
    body,
    anchor,
    resolved,
    resolvedBy,
    resolvedMs,
    reactions,
    deleted,
    createdMs,
    updatedMs,
  }
}

/**
 * Coerce a raw API response into `HandoffComment[]`. Accepts either:
 *   - `{ comments: [...] }` (the standard listing envelope)
 *   - a bare `Array`
 *
 * Non-object entries inside the array are silently dropped.
 */
export function toCommentList(raw: unknown): HandoffComment[] {
  let arr: unknown[]
  if (Array.isArray(raw)) {
    arr = raw
  } else if (raw !== null && typeof raw === 'object') {
    const wrapped = (raw as Record<string, unknown>)['comments']
    arr = Array.isArray(wrapped) ? wrapped : []
  } else {
    return []
  }
  return arr
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map(toComment)
}

/** Sort key for a thread root: text anchors by `start`, pins after text by `y`, unanchored last. */
function rootSortKey(c: HandoffComment): number {
  if (c.anchor?.type === 'text') return c.anchor.start
  if (c.anchor?.type === 'pin') return 100000 + c.anchor.y * 1000
  return Infinity
}

/**
 * Group a flat comment list into threads: each non-reply comment (`parentId
 * === null`) becomes a root, with its replies (`parentId === root.id`)
 * attached and sorted by `createdMs`. A reply whose root is missing from the
 * list is dropped. Roots are sorted by anchor position (`rootSortKey`) then
 * `createdMs`.
 */
export function threadsFor(comments: HandoffComment[]): CommentThread[] {
  const roots = comments.filter((c) => c.parentId === null)
  const rootIds = new Set(roots.map((r) => r.id))
  const repliesByParent = new Map<string, HandoffComment[]>()

  for (const c of comments) {
    if (c.parentId !== null && rootIds.has(c.parentId)) {
      const list = repliesByParent.get(c.parentId) ?? []
      list.push(c)
      repliesByParent.set(c.parentId, list)
    }
  }

  const threads: CommentThread[] = roots.map((root) => ({
    root,
    replies: (repliesByParent.get(root.id) ?? []).slice().sort((a, b) => a.createdMs - b.createdMs),
  }))

  threads.sort((a, b) => {
    const keyDiff = rootSortKey(a.root) - rootSortKey(b.root)
    if (keyDiff !== 0) return keyDiff
    return a.root.createdMs - b.root.createdMs
  })

  return threads
}
