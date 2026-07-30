/**
 * MSW request handlers for the Handoff app. When the master switch in
 * `config.ts` is on, this worker intercepts `/api/*` requests in dev. When the
 * switch is off the worker never starts, so all requests go directly to the
 * network via the Vite proxy. Only active in dev — MSW isn't started in prod
 * (see `main.tsx`).
 *
 * In-memory mock backend — returns the SAME shapes as the frozen API contract.
 * Both mock and real responses pass through `toNode`/`toNodeList` so mock == real
 * is enforced at the coercion seam.
 *
 * Mock bucket URL: /__mock_bucket/<storageKey>
 * Serve path:      /api/uploads/content/<storageKey>
 */

import { http, HttpResponse } from 'msw'
import { toNode } from '../lib/nodes'
import type { HandoffNode } from '../lib/nodes'
import { evaluateAccess, hasAnyoneGrant, ANYONE_PRINCIPAL } from '../lib/acl'
import type { AccessLevel, Grant, FolderLink } from '../lib/acl'
import { pathFromPathname } from '../lib/pathUrl'

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Stored HandoffNode records, keyed by id. */
export const nodes = new Map<string, HandoffNode>()

/**
 * In-Folder name uniqueness (structural storage, Slice 4). Mirrors the pipeline
 * guard so mock == real: a name identifies content within a Folder, so a node
 * whose name equals an existing sibling in the same Folder is rejected (409),
 * never overwritten. Any sibling type counts, across ALL owners — root
 * included: verbatim keys give every level a single shared path namespace, so
 * a name collision is a storage-key collision regardless of who owns the
 * sibling (issue #225). The same name in a different Folder is fine.
 */
function siblingNameExists(parentId: string, name: string): boolean {
  for (const n of nodes.values()) {
    if (n.parentId === parentId && n.name === name) return true
  }
  return false
}

/** Raw bytes uploaded via the mock bucket PUT. */
export const objects = new Map<string, { body: ArrayBuffer; type: string }>()

/**
 * Site metadata for mock site nodes (structural storage, Slice 3). A Site's
 * assets are stored as normal objects under its own path prefix on the unified
 * content endpoint — no manifest side-map.
 * Key: site node id; Value: { entry, path } (path = the Site's content prefix).
 */
export const sites = new Map<string, { entry: string; path: string }>()

/** ACL data keyed by node id. */
export const nodeAcl = new Map<string, { ownerId: string | null; grants: Grant[]; mode: 'inheriting' | 'restricted' }>()

/** Grants keyed by folderId. */
export const grants = new Map<string, Grant[]>()

/** The currently logged-in mock user (null = unauthenticated). */
export let mockCurrentUser: { id: string; email: string; role?: string; groups?: string[] } | null = {
  id: 'user-owner',
  email: 'owner@example.com',
  role: 'admin',
}

/**
 * Fixture group directory (group-sharing plan, Task 7). Backs both
 * `GET /api/groups` (the share-dialog picker — all groups, search-filterable)
 * and `GET /api/me/groups` (the session user's own memberships, filtered by
 * `mockCurrentUser.groups`), so component tests can mirror the server's
 * group-aware ACL without hitting the network.
 */
export const FAKE_GROUPS: { id: string; name: string; memberCount: number }[] = [
  { id: 'group-eng', name: 'Engineering', memberCount: 3 },
  { id: 'group-design', name: 'Design', memberCount: 2 },
]

// ---------------------------------------------------------------------------
// Share-link in-memory store
// ---------------------------------------------------------------------------

export interface MockShareLink {
  token: string
  folderId: string
  expiresAt: number | null
  revoked: boolean
  url: string
  createdAt: number
  creatorId: string
}

/** All minted share links, keyed by token. */
export const shareLinks = new Map<string, MockShareLink>()

/**
 * The active share-link viewer for the current request context in tests.
 * When set to a folderId string, GET /api/nodes and /api/node will allow
 * access for a share-link viewer (no user) scoped to that folder.
 * Set to null to use the normal mockCurrentUser path.
 */
export let mockShareLinkFolderId: string | null = null

/** Set the share-link viewer context (null = use normal user auth). */
export function setMockShareLinkFolderId(folderId: string | null): void {
  mockShareLinkFolderId = folderId
}

/** Monotonically-incrementing node id counter for determinism. */
let nodeCounter = 0
let tokenCounter = 0

/**
 * Stable id for the mock's singleton root record `R` — mirrors the live,
 * admin-owned root record resolved by the `'root'` sentinel in mint/grants
 * (Task 4) and injected into ACL chains (Task 5). Kept distinct from the
 * counter-based ids `seedFolder`/`seedFile` hand out so tests can reference it
 * directly.
 */
export const ROOT_RECORD_ID = 'root-record-0000-0000-0000-000000000000'

/**
 * Test seam: seed the singleton root record `R` (`type:'root'`, `ownerId` an
 * admin, `grants:[]`) into the mock node/ACL state — mirrors the live
 * admin-owned root record. Called by `resetMockState()` so `R` exists from
 * the start of every test, matching the fact that sharing/granting on root
 * requires it to already be resolvable. Idempotent — re-seeding just resets
 * `R` to a fresh state (e.g. to change its owner).
 */
export function seedRoot(ownerId: string = mockCurrentUser?.id ?? 'user-owner'): HandoffNode {
  const raw = {
    id: ROOT_RECORD_ID,
    type: 'root',
    name: 'My Files',
    mime: null,
    size: null,
    url: null,
    storageKey: null,
    parentId: '',
    createdAt: Date.now(),
    ownerId,
    grants: [],
    mode: 'inheriting' as const,
  }
  const node = toNode(raw)
  nodes.set(ROOT_RECORD_ID, node)
  nodeAcl.set(ROOT_RECORD_ID, { ownerId, grants: [], mode: 'inheriting' })
  grants.set(ROOT_RECORD_ID, [])
  return node
}

/**
 * Resolve the `'root'` sentinel to `R`'s id — mirrors the live
 * `resolveRootShape.effectiveFolderId` used by mint, grants, and grants/revoke
 * (Tasks 4 & 6). Any other folderId passes through unchanged.
 */
function resolveFolderId(folderId: string): string {
  return folderId === 'root' ? ROOT_RECORD_ID : folderId
}

/** Reset all mock state — exported for use in tests. */
export function resetMockState(): void {
  nodes.clear()
  objects.clear()
  sites.clear()
  nodeAcl.clear()
  grants.clear()
  shareLinks.clear()
  comments.clear()
  nodeCounter = 0
  tokenCounter = 0
  mockCurrentUser = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }
  mockShareLinkFolderId = null
  seedRoot()
}

/** Set the current mock user (or null for unauthenticated). */
export function setMockUser(
  user: { id: string; email: string; role?: string; groups?: string[] } | null,
): void {
  mockCurrentUser = user
}

/** Set grants for a specific folder. */
export function setMockGrants(folderId: string, g: Grant[]): void {
  grants.set(folderId, g)
  const acl = nodeAcl.get(folderId)
  if (acl) acl.grants = g
}

// ---------------------------------------------------------------------------
// Comments in-memory store
// ---------------------------------------------------------------------------

/** A stored margin-comment record. Mirrors the `handoff_comments` schema. */
export interface MockComment {
  id: string
  nodeId: string
  /** '' for a thread root; the root comment's id for a reply. */
  parentId: string
  authorId: string
  authorName: string
  body: string
  anchorJson: string | null
  resolved: boolean
  resolvedBy: string | null
  resolvedMs: number | null
  reactionsJson: string
  deleted: boolean
  createdMs: number
  updatedMs: number | null
}

/** Stored comment records, keyed by id. Mirrors handoff_comments. */
export const comments = new Map<string, MockComment>()

const MAX_COMMENT_BODY = 5000
const MAX_EMOJI = 16

/**
 * Validate + normalise a raw `anchor` payload into its stored JSON string, or
 * `null` when absent/malformed. Mirrors `anchorString()` in
 * `comments/post/pre.fn.ts`.
 */
function anchorStringForCreate(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.type === 'text') {
    const start = Number(o.start)
    const end = Number(o.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null
    return JSON.stringify({
      type: 'text',
      quote: String(o.quote ?? '').slice(0, 1000),
      prefix: String(o.prefix ?? '').slice(0, 64),
      suffix: String(o.suffix ?? '').slice(0, 64),
      start,
      end,
    })
  }
  if (o.type === 'pin') {
    const x = Number(o.x)
    const y = Number(o.y)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null
    return JSON.stringify({ type: 'pin', x, y })
  }
  return null
}

/** Shape a stored comment for the wire — husk for a soft-deleted root, full row otherwise. Mirrors `comments/get/shape.fn.ts`. */
function shapeComment(c: MockComment): Record<string, unknown> {
  if (c.deleted) {
    return {
      id: c.id,
      nodeId: c.nodeId,
      parentId: c.parentId,
      deleted: true,
      createdMs: c.createdMs,
      anchorJson: c.anchorJson,
    }
  }
  return {
    id: c.id,
    nodeId: c.nodeId,
    parentId: c.parentId,
    authorId: c.authorId,
    authorName: c.authorName,
    body: c.body,
    anchorJson: c.anchorJson,
    resolved: c.resolved,
    resolvedBy: c.resolvedBy,
    resolvedMs: c.resolvedMs,
    reactionsJson: c.reactionsJson,
    deleted: false,
    createdMs: c.createdMs,
    updatedMs: c.updatedMs,
  }
}

// ---------------------------------------------------------------------------
// ACL helpers
// ---------------------------------------------------------------------------

/** A small fake directory of users for autocomplete. */
const FAKE_DIRECTORY = [
  { id: 'user-alice', email: 'alice@example.com' },
  { id: 'user-bob', email: 'bob@example.com' },
  { id: 'user-carol', email: 'carol@example.com' },
  { id: 'user-dave', email: 'dave@example.com' },
]

/**
 * Check whether `mockCurrentUser` (or the active share-link viewer) can access
 * the given node.
 *
 * Delegates to the canonical `evaluateAccess` from `src/lib/acl.ts` so the
 * mock enforces exactly the same rules as production (incl. inheritance and
 * restricted-mode semantics, and share-link scope matching).
 *
 * Builds the ancestor FolderLink chain by walking `parentId` through the
 * in-memory `nodes` / `nodeAcl` maps (root → target). Capped at 64 hops to
 * avoid hanging on a cycle.
 *
 * `minLevel` is the access level the action requires — `'view'` for reads
 * (default) and `'edit'` for writes such as delete. The 401/403 split is
 * unchanged: no credential at all → 401; a credential that's simply
 * insufficient (e.g. a view-only grant or a share-link viewer trying to write)
 * → 403. This mirrors the live ACL gate exactly (`rank(level) >= rank(minLevel)`).
 *
 * Returns: 'ok' | '401' | '403'
 */
function levelRank(l: AccessLevel): number {
  return l === 'owner' ? 3 : l === 'edit' ? 2 : l === 'view' ? 1 : 0
}

/**
 * Build the root→target ancestor id chain by walking `parentId` upward from
 * `nodeId`. Resolves the `'root'` sentinel to `R`'s id so the root record is
 * included as `chain[0]` instead of the walk stopping short of it — mirrors
 * the Task-5 live gate's `folderChain` root injection. Capped at 64 hops to
 * avoid hanging on a cycle.
 *
 * Equivalence with the live gate (Fix #1/#2): for a TOP-LEVEL node whose
 * `parentId === 'root'`, this walk resolves that sentinel to `R` and yields
 * `[R, node]`. The live gate builds the same chain as
 * `folderChain(folders, node.parentId).concat(node)`; before Fix #1
 * `folderChain(...,'root')` returned `[]` (UUID.test('root') fails), so the
 * live gate diverged (`[node]`) and this mock masked the bug. After Fix #1
 * seeds that walk at `R`, the live gate also yields `[R, node]` — the two
 * converge, which the `mocks/shareRoot.test.ts` top-level-file e2e guards.
 */
function buildAncestorIds(nodeId: string): string[] {
  const MAX_HOPS = 64
  const ancestorIds: string[] = []
  let cursor: string | undefined = nodeId
  let hops = 0
  while (cursor && cursor !== 'root' && hops < MAX_HOPS) {
    ancestorIds.unshift(cursor)
    const n = nodes.get(cursor)
    const parentId = n?.parentId
    cursor = parentId === 'root' ? ROOT_RECORD_ID : (parentId ?? undefined)
    hops++
  }
  return ancestorIds
}

/** Build the ordered root→target FolderLink[] chain (via `buildAncestorIds`) from the in-memory ACL maps. */
function buildFolderChain(nodeId: string): FolderLink[] {
  return buildAncestorIds(nodeId).map((id) => {
    const a = nodeAcl.get(id)
    return {
      id,
      ownerId: a?.ownerId ?? null,
      grants: a?.grants ?? [],
      mode: a?.mode ?? 'inheriting',
    }
  })
}

function checkAccess(nodeId: string, minLevel: AccessLevel = 'view'): 'ok' | '401' | '403' {
  // Share-link viewer path: no user, just a scoped folderId.
  if (mockShareLinkFolderId !== null) {
    // Share-link viewers are capped at 'view' — they can never satisfy a write.
    if (levelRank(minLevel) > levelRank('view')) return '403'
    const acl = nodeAcl.get(nodeId)
    if (!acl) return 'ok' // no ACL = open

    let folderChain = buildFolderChain(nodeId)
    if (folderChain.length === 0) {
      folderChain = [{ id: nodeId, ownerId: acl.ownerId, grants: acl.grants, mode: acl.mode }]
    }

    const level = evaluateAccess({ folderChain, viewer: { shareLinkFolderId: mockShareLinkFolderId } })
    return levelRank(level) >= levelRank(minLevel) ? 'ok' : '403'
  }

  // Normal user path — guests included (Task 6). Guests reach evaluation
  // instead of being blanket-401'd here, mirroring the real gates: a guest
  // is denied with no credential (401), while a signed-in user with an
  // insufficient level is denied with a credential (403).
  const acl = nodeAcl.get(nodeId)
  if (!acl) return 'ok' // no ACL record = open (root or file)

  // Build the FolderLink chain (root → target). If it's somehow empty (e.g.
  // nodeId not in the nodes map), fall back to the direct ACL entry so we
  // still enforce something.
  let folderChain = buildFolderChain(nodeId)
  if (folderChain.length === 0) {
    folderChain = [{ id: nodeId, ownerId: acl.ownerId, grants: acl.grants, mode: acl.mode }]
  }

  const viewer = mockCurrentUser
    ? {
        userId: mockCurrentUser.id,
        isAdmin: mockCurrentUser.role === 'admin',
        groupIds: mockCurrentUser.groups,
      }
    : {}

  const level = evaluateAccess({ folderChain, viewer })
  if (levelRank(level) >= levelRank(minLevel)) return 'ok'
  return mockCurrentUser ? '403' : '401'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a node's content path by walking parentId names (mock mirror of the
 * server-side folderPath). Returns null when the chain is broken.
 */
export function mockNodePath(id: string): string | null {
  const names: string[] = []
  let cur = id
  let hops = 0
  while (cur && cur !== 'root' && hops < 64) {
    const n = nodes.get(cur)
    if (!n) return null
    names.unshift(n.name ?? 'Untitled')
    cur = n.parentId
    hops++
  }
  return names.join('/')
}

/** Test seam: create a folder node directly in mock state (mirrors POST /api/folders). */
export function seedFolder(name: string, parentId: string): HandoffNode {
  const id = String(++nodeCounter)
  const ownerId = mockCurrentUser?.id ?? null
  const folderGrants: Grant[] = []
  const raw = {
    id,
    type: 'folder',
    name,
    mime: null,
    size: null,
    url: null,
    storageKey: null,
    parentId,
    createdAt: Date.now(),
    ownerId,
    grants: folderGrants,
    mode: 'inheriting' as const,
  }
  const node = toNode(raw)
  nodes.set(id, node)
  nodeAcl.set(id, { ownerId, grants: folderGrants, mode: 'inheriting' })
  grants.set(id, folderGrants)
  return node
}

/** Test seam: create a file node directly in mock state (mirrors POST /api/nodes). */
export function seedFile(name: string, parentId: string): HandoffNode {
  const id = String(++nodeCounter)
  const ownerId = mockCurrentUser?.id ?? null
  const raw = {
    id,
    type: 'file',
    name,
    title: null,
    description: null,
    mime: null,
    size: null,
    url: null,
    storageKey: null,
    parentId,
    createdAt: Date.now(),
    ownerId,
    grants: [],
    mode: 'inheriting' as const,
  }
  const node = toNode(raw)
  nodes.set(id, node)
  nodeAcl.set(id, { ownerId, grants: [], mode: 'inheriting' })
  return node
}

/**
 * Test seam: create a site node directly in mock state (mirrors a served Site
 * upload). Unlike `seedFile`, a site carries a `url` (its served entry) so the
 * viewer renders the site iframe rather than the "preview unavailable" card.
 */
export function seedSite(name: string, parentId: string): HandoffNode {
  const id = String(++nodeCounter)
  const ownerId = mockCurrentUser?.id ?? null
  const raw = {
    id,
    type: 'site',
    name,
    title: null,
    description: null,
    mime: null,
    size: null,
    url: `/api/uploads/content/site-${id}/index.html`,
    storageKey: `site-${id}`,
    parentId,
    createdAt: Date.now(),
    ownerId,
    grants: [],
    mode: 'inheriting' as const,
  }
  const node = toNode(raw)
  nodes.set(id, node)
  nodeAcl.set(id, { ownerId, grants: [], mode: 'inheriting' })
  return node
}

/**
 * Test seam: mint a share link for `folderId` directly in mock state (mirrors
 * POST /api/share-links, without the owner-auth round-trip). Returns the link
 * so a test can hand its `token` to a `/blob/<path>?token=` render.
 */
export function seedShareLink(
  folderId: string,
  opts: { revoked?: boolean; expiresAt?: number | null } = {},
): MockShareLink {
  const token = `mock-token-${++tokenCounter}`
  const link: MockShareLink = {
    token,
    folderId,
    expiresAt: opts.expiresAt ?? null,
    revoked: opts.revoked ?? false,
    url: `/s/${token}`,
    createdAt: Date.now(),
    creatorId: mockCurrentUser?.id ?? 'user-owner',
  }
  shareLinks.set(token, link)
  return link
}

const MOCK_BUCKET_PREFIX = '/__mock_bucket'

function mockUploadUrl(storageKey: string): string {
  return `${MOCK_BUCKET_PREFIX}/${storageKey}`
}

function mockServePath(storageKey: string): string {
  return `/api/uploads/content/${storageKey}`
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const handlers = [
  /**
   * GET /_bffless/auth/session
   * Returns current mock user as authenticated or unauthenticated.
   */
  http.get('/_bffless/auth/session', () => {
    if (!mockCurrentUser) {
      return HttpResponse.json({ authenticated: false, user: null })
    }
    return HttpResponse.json({
      authenticated: true,
      user: {
        id: mockCurrentUser.id,
        email: mockCurrentUser.email,
        role: mockCurrentUser.role,
      },
    })
  }),

  /**
   * GET /api/grants?folderId=<id>
   * Response: { grants: Grant[] }
   */
  http.get('/api/grants', ({ request }) => {
    if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
    const folderId = resolveFolderId(new URL(request.url).searchParams.get('folderId') ?? '')
    const acl = nodeAcl.get(folderId)
    // Only owner or admin can manage grants
    if (acl) {
      const isAdmin = mockCurrentUser.role === 'admin'
      const isOwner = acl.ownerId === mockCurrentUser.id
      if (!isAdmin && !isOwner) return new HttpResponse(null, { status: 403 })
    }
    return HttpResponse.json({ grants: grants.get(folderId) ?? [] })
  }),

  /**
   * POST /api/grants
   * Body: { folderId, principalId, principalEmail?, principalType?, principalName?, level }
   * Response: { grants: Grant[] }
   *
   * `principalType`/`principalName` mirror the real `merge.fn.ts` (group
   * grants, spec 2026-07-29): only `'group'` is ever stored as a type —
   * anything else sanitizes to absent — updating an existing grant preserves
   * its stored type/name when the request omits them, and the `anyone`
   * principal is always capped (no type, no name, view-only).
   */
  http.post('/api/grants', async ({ request }) => {
    if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
    const body = (await request.json().catch(() => ({}))) as {
      folderId?: string
      principalId?: string
      principalEmail?: string
      principalType?: string
      principalName?: string
      level?: 'view' | 'edit'
    }
    const folderId = resolveFolderId(body.folderId ?? '')
    const acl = nodeAcl.get(folderId)
    if (acl) {
      const isAdmin = mockCurrentUser.role === 'admin'
      const isOwner = acl.ownerId === mockCurrentUser.id
      if (!isAdmin && !isOwner) return new HttpResponse(null, { status: 403 })
    }
    const existing = grants.get(folderId) ?? []
    const isAnyone = body.principalId === ANYONE_PRINCIPAL
    const existingGrant = existing.find((g) => g.principalId === body.principalId)
    // Mirror merge.fn.ts: the body-declared type/name are only ever 'group'/named when the
    // body itself says 'group' — a name never rides in on a type that isn't 'group'. On update,
    // fall back to the stored (sanitized) type/name only when the body didn't provide them.
    const bodyType: Grant['principalType'] = body.principalType === 'group' ? 'group' : undefined
    const bodyName = bodyType === 'group' && body.principalName ? body.principalName : null
    const principalType: Grant['principalType'] = isAnyone
      ? undefined
      : bodyType || (existingGrant?.principalType === 'group' ? 'group' : undefined)
    const principalName = isAnyone
      ? null
      : (bodyName ?? existingGrant?.principalName ?? null)
    const newGrant: Grant = {
      principalId: body.principalId ?? '',
      principalEmail: isAnyone ? null : (body.principalEmail ?? existingGrant?.principalEmail ?? null),
      principalType,
      principalName,
      level: isAnyone ? 'view' : (body.level ?? 'view'),
    }
    // Replace if already exists, otherwise append
    const updated = [
      ...existing.filter((g) => g.principalId !== newGrant.principalId),
      newGrant,
    ]
    grants.set(folderId, updated)
    if (acl) acl.grants = updated
    return HttpResponse.json({ grants: updated })
  }),

  /**
   * POST /api/grants/revoke
   * Body: { folderId, principalId }
   * Response: { grants: Grant[] }
   */
  http.post('/api/grants/revoke', async ({ request }) => {
    if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
    const body = (await request.json().catch(() => ({}))) as {
      folderId?: string
      principalId?: string
    }
    const folderId = resolveFolderId(body.folderId ?? '')
    const acl = nodeAcl.get(folderId)
    if (acl) {
      const isAdmin = mockCurrentUser.role === 'admin'
      const isOwner = acl.ownerId === mockCurrentUser.id
      if (!isAdmin && !isOwner) return new HttpResponse(null, { status: 403 })
    }
    const existing = grants.get(folderId) ?? []
    const updated = existing.filter((g) => g.principalId !== (body.principalId ?? ''))
    grants.set(folderId, updated)
    if (acl) acl.grants = updated
    return HttpResponse.json({ grants: updated })
  }),

  /**
   * GET /api/directory?search=<q>
   * Response: { users: { id, email }[] }
   */
  http.get('/api/directory', ({ request }) => {
    if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
    const q = (new URL(request.url).searchParams.get('search') ?? '').toLowerCase()
    const users = FAKE_DIRECTORY.filter((u) => u.email.includes(q))
    return HttpResponse.json({ users })
  }),

  /**
   * GET /api/groups?search=<q>
   * Group picker for the share dialog. Response: { groups: { id, name, memberCount }[] }.
   * Blank search lists all fixture groups.
   */
  http.get('/api/groups', ({ request }) => {
    if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
    const q = (new URL(request.url).searchParams.get('search') ?? '').toLowerCase()
    const groups = FAKE_GROUPS.filter((g) => g.name.toLowerCase().includes(q))
    return HttpResponse.json({ groups })
  }),

  /**
   * GET /api/me/groups
   * The session user's own group memberships, driven by `mockCurrentUser.groups`.
   * Response: { groups: { id, name }[] }.
   */
  http.get('/api/me/groups', () => {
    if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
    const memberIds = mockCurrentUser.groups ?? []
    const groups = FAKE_GROUPS.filter((g) => memberIds.includes(g.id)).map((g) => ({
      id: g.id,
      name: g.name,
    }))
    return HttpResponse.json({ groups })
  }),

  /**
   * POST /api/uploads/prepare
   * Body: { filename, contentType? }
   * Response: PreparedUpload shape (same as the real pipeline).
   */
  http.post('/api/uploads/prepare', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      filename?: string
      contentType?: string
      path?: string
      parentId?: string
    }
    const filename = body.filename ?? 'upload'
    // Reject before minting a URL when the target Folder already has a sibling
    // by this name — so the existing file's bytes are never overwritten.
    if (body.parentId && siblingNameExists(body.parentId, filename)) {
      return HttpResponse.json(
        { error: 'An item with that name already exists in this folder. Rename it and try again.' },
        { status: 409 },
      )
    }
    // Verbatim structural key when the client sends a `path` (structural
    // storage, Slice 1); otherwise the legacy uuid-ish mock key. The serve
    // path mirrors the key, so relative refs resolve on the content endpoint.
    // The mock's storageKey is the content-relative path (everything after the
    // `/api/uploads/content/` serve prefix), so a verbatim `path` maps to it 1:1.
    const storageKey = body.path
      ? body.path
      : `handoff/uploads/mock/${Date.now()}-${filename}`
    return HttpResponse.json({
      uploadUrl: mockUploadUrl(storageKey),
      storageKey,
      publicPath: mockServePath(storageKey),
      storedFilename: filename,
      originalName: filename,
      expiresIn: 3600,
      expiresAt: Date.now() + 3600 * 1000,
      maxFileSize: 10 * 1024 * 1024,
      allowedMimeTypes: ['*/*'],
    })
  }),

  /**
   * PUT /__mock_bucket/*
   * Receives raw bytes for a presigned upload and stores them in `objects`.
   */
  http.put(`${MOCK_BUCKET_PREFIX}/*`, async ({ request }) => {
    const storageKey = new URL(request.url).pathname.replace(`${MOCK_BUCKET_PREFIX}/`, '')
    const body = await request.arrayBuffer()
    objects.set(storageKey, {
      body,
      type: request.headers.get('content-type') ?? 'application/octet-stream',
    })
    return new HttpResponse(null, { status: 200 })
  }),

  /**
   * POST /api/nodes
   * Body: RegisterBody
   * Response: { node: HandoffNode }
   */
  http.post('/api/nodes', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      storageKey?: string
      originalName?: string
      parentId?: string
      displayName?: string
      createdMs?: number
    }
    const displayName = body.displayName ?? body.originalName ?? 'Untitled'
    const parentId = body.parentId ?? 'root'
    // In-Folder name uniqueness — backstop the prepare-time guard (Slice 4).
    if (siblingNameExists(parentId, displayName)) {
      return HttpResponse.json(
        { error: 'An item with that name already exists in this folder. Rename it and try again.' },
        { status: 409 },
      )
    }
    const id = String(++nodeCounter)
    const ownerId = mockCurrentUser?.id ?? null
    const raw = {
      id,
      type: 'file',
      name: displayName,
      title: null,
      description: null,
      mime: body.storageKey ? (objects.get(body.storageKey)?.type ?? null) : null,
      size: body.storageKey ? (objects.get(body.storageKey)?.body.byteLength ?? null) : null,
      url: body.storageKey ? mockServePath(body.storageKey) : null,
      storageKey: body.storageKey ?? null,
      parentId,
      createdAt: typeof body.createdMs === 'number' ? body.createdMs : Date.now(),
      ownerId,
      grants: [],
      mode: 'inheriting' as const,
    }
    const node = toNode(raw)
    nodes.set(id, node)
    nodeAcl.set(id, { ownerId, grants: [], mode: 'inheriting' })
    return HttpResponse.json({ node })
  }),

  /**
   * POST /api/folders
   * Body: { parentId, name, createdMs? }
   * Response: { node: HandoffNode } — type:'folder', file fields null
   */
  http.post('/api/folders', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      parentId?: string
      name?: string
      createdMs?: number
    }
    // In-Folder name uniqueness — a folder is a path segment under verbatim
    // keys, so it collides with ANY same-named sibling (issue #225).
    if (body.parentId && body.name && siblingNameExists(body.parentId, body.name)) {
      return HttpResponse.json(
        { error: 'An item with that name already exists in this folder. Rename it and try again.' },
        { status: 409 },
      )
    }
    const id = String(++nodeCounter)
    const ownerId = mockCurrentUser?.id ?? null
    const folderGrants: Grant[] = []
    const raw = {
      id,
      type: 'folder',
      name: body.name ?? 'Untitled Folder',
      mime: null,
      size: null,
      url: null,
      storageKey: null,
      parentId: body.parentId ?? 'root',
      createdAt: typeof body.createdMs === 'number' ? body.createdMs : Date.now(),
      ownerId,
      grants: folderGrants,
      mode: 'inheriting' as const,
    }
    const node = toNode(raw)
    nodes.set(id, node)
    nodeAcl.set(id, { ownerId, grants: folderGrants, mode: 'inheriting' })
    grants.set(id, folderGrants)
    return HttpResponse.json({ node })
  }),

  /**
   * GET /api/nodes?parentId=…
   * Response: { nodes: HandoffNode[], root: { id, public } }
   * Enforces ACL: checks mockCurrentUser (or share-link viewer) against the parentId's ACL.
   * `root` mirrors the live listing's rootMeta (Task 2): the singleton root
   * record's id (or null if never seeded) and whether it carries an Anyone
   * grant — appended to every 200 response, not just root listings.
   */
  http.get('/api/nodes', ({ request }) => {
    const parentId = new URL(request.url).searchParams.get('parentId') ?? 'root'

    // ACL check on the parentId folder (skip for root). Guests reach
    // evaluation now (Task 6) — mirrors the real gates.
    if (parentId !== 'root') {
      const access = checkAccess(parentId)
      if (access === '401') return new HttpResponse(null, { status: 401 })
      if (access === '403') return new HttpResponse(null, { status: 403 })
    } else if (mockShareLinkFolderId !== null && !mockCurrentUser) {
      // Share-link viewers are folder-scoped; root stays out of scope.
      return new HttpResponse(null, { status: 403 })
    }

    const filtered = [...nodes.values()].filter((n) => n.parentId === parentId)
    // Guests see only children they can access (mirrors the real shape filter).
    const visible =
      !mockCurrentUser && parentId === 'root'
        ? filtered.filter((n) => checkAccess(n.id) === 'ok')
        : filtered
    // Attach ACL fields + server-computed path to each node in response
    const withAcl = visible.map((n) => {
      const acl = nodeAcl.get(n.id)
      return {
        ...n,
        ownerId: acl?.ownerId ?? n.ownerId,
        grants: acl?.grants ?? n.grants,
        mode: acl?.mode ?? n.mode,
        path: mockNodePath(n.id),
      }
    })
    const rootAcl = nodeAcl.get(ROOT_RECORD_ID)
    const root = rootAcl
      ? { id: ROOT_RECORD_ID, public: hasAnyoneGrant(rootAcl.grants) }
      : { id: null, public: false }
    return HttpResponse.json({ nodes: withAcl, root })
  }),

  /**
   * GET /api/node?id=…
   * Response: { node: HandoffNode | null }
   * Enforces ACL (supports share-link viewer context).
   */
  http.get('/api/node', ({ request }) => {
    // Guests reach evaluation now (Task 6) — evaluateAccess handles them.
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const access = checkAccess(id)
    if (access === '401') return new HttpResponse(null, { status: 401 })
    if (access === '403') return new HttpResponse(null, { status: 403 })

    const node = nodes.get(id) ?? null
    if (!node) return HttpResponse.json({ node: null })

    const acl = nodeAcl.get(id)
    const nodeWithAcl = { ...node, ...(acl ?? {}), path: mockNodePath(id) }
    return HttpResponse.json({ node: nodeWithAcl })
  }),

  /**
   * GET /api/resolve/<encoded path>
   * Response: { node } | 401 | 403 | 404 — mirrors the live resolve rule.
   */
  http.get('/api/resolve/*', ({ request }) => {
    const path = pathFromPathname(new URL(request.url).pathname, '/api/resolve/')
    if (!path) return new HttpResponse(null, { status: 404 })

    // File/site: exact path match. Folder: name-walk from root.
    let target: string | null = null
    for (const [id] of nodes) {
      if (mockNodePath(id) === path) {
        target = id
        break
      }
    }
    if (!target) return HttpResponse.json({ error: 'not found' }, { status: 404 })

    const access = checkAccess(target)
    if (access === '401') return new HttpResponse(null, { status: 401 })
    if (access === '403') return new HttpResponse(null, { status: 403 })

    const node = nodes.get(target)!
    const acl = nodeAcl.get(target)
    return HttpResponse.json({ node: { ...node, ...(acl ?? {}), path } })
  }),

  /**
   * DELETE /api/node?id=…
   * Hard-delete a single node — write-gated (edit/owner). Mirrors the live
   * `Handoff delete node` pipeline at the `toNode` seam:
   *   - no credential → 401; insufficient (view-only / share-link) → 403.
   *   - a folder that still has children → 409 (the client deletes bottom-up, so
   *     this only guards direct/out-of-order calls from orphaning a subtree).
   *   - a file → its stored object is purged too.
   *   - a site → the record is dropped; its assets under the Site's path prefix
   *     are left for the greenfield wipe (structural storage, Slice 3 defers
   *     subtree purge, matching the live pipeline — no manifest to enumerate).
   * Response: { deleted: true, id }.
   */
  http.delete('/api/node', ({ request }) => {
    const hasCredential = !!mockCurrentUser || mockShareLinkFolderId !== null
    if (!hasCredential) return new HttpResponse(null, { status: 401 })

    const id = new URL(request.url).searchParams.get('id') ?? ''
    const node = nodes.get(id)
    // A node the gate can't load can't be authorised — matches the live gate,
    // which leaves `allow` false (→ 403) when the record query returns nothing.
    if (!node) {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const access = checkAccess(id, 'edit')
    if (access === '401') return new HttpResponse(null, { status: 401 })
    if (access === '403') return new HttpResponse(null, { status: 403 })

    // Refuse to orphan a non-empty subtree on a direct delete.
    if (node.type === 'folder') {
      const hasChildren = [...nodes.values()].some((n) => n.parentId === id)
      if (hasChildren) {
        return HttpResponse.json({ error: 'folder_not_empty' }, { status: 409 })
      }
    }

    // Hard delete: purge the stored object for a file, then drop the record +
    // ACL. A Site's assets under its path prefix are deferred to the wipe.
    if (node.type === 'file' && node.storageKey) {
      objects.delete(node.storageKey)
    }
    nodes.delete(id)
    nodeAcl.delete(id)
    grants.delete(id)
    sites.delete(id)
    return HttpResponse.json({ deleted: true, id })
  }),

  /**
   * PATCH /api/node
   * Body: { id, mode?: 'inheriting' | 'restricted', feedExcluded?: boolean }
   * Response: { id, mode?, feedExcluded? } — echoes only the fields updated.
   * Mirrors the live `node-set-mode` pipeline (extended for #191): 400 on a
   * bad/missing id, a non-folder target (root and files rejected), or a body
   * carrying neither a valid mode nor a feedExcluded boolean; 403 for anyone
   * who isn't the folder's owner or an admin (anonymous included — there is no
   * 401 branch, matching the real rule's `denied` step). Each field is written
   * independently (a mode-only PATCH never touches feedExcluded and vice versa)
   * so field-disjoint writes don't clobber each other.
   */
  http.patch('/api/node', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      id?: string
      mode?: string
      feedExcluded?: unknown
    }
    const id = String(body.id ?? '')
    const mode: 'inheriting' | 'restricted' | '' =
      body.mode === 'restricted' ? 'restricted' : body.mode === 'inheriting' ? 'inheriting' : ''
    const hasFeedExcluded = typeof body.feedExcluded === 'boolean'
    const feedExcluded = body.feedExcluded === true
    const node = id ? nodes.get(id) : undefined
    const isFolder = !!node && node.type === 'folder'
    const badRequest = !id || (!mode && !hasFeedExcluded) || !isFolder

    if (badRequest) {
      return HttpResponse.json({ error: 'invalid request' }, { status: 400 })
    }

    const acl = nodeAcl.get(id)
    const isAdmin = mockCurrentUser?.role === 'admin'
    const isOwner = !!mockCurrentUser && acl?.ownerId === mockCurrentUser.id
    const allowed = isAdmin || isOwner
    if (!allowed) {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    let updated = { ...node! }
    const resp: { id: string; mode?: string; feedExcluded?: boolean } = { id }
    if (mode) {
      if (acl) acl.mode = mode
      updated = { ...updated, mode }
      resp.mode = mode
    }
    if (hasFeedExcluded) {
      updated = { ...updated, feedExcluded }
      resp.feedExcluded = feedExcluded
    }
    nodes.set(id, updated)
    return HttpResponse.json(resp)
  }),

  /**
   * PATCH /api/node/meta
   * Body: { id, title?, description? } → { id, title, description }.
   * Mirrors the live meta pipeline at the toNode seam: edit-gated over the
   * parent-folder chain (checkAccess min 'edit'); 400 bad/missing id, non-leaf,
   * or no editable field; 401 no credential; 403 insufficient. Writes only the
   * provided fields; '' clears to null.
   */
  http.patch('/api/node/meta', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { id?: string; title?: unknown; description?: unknown }
    const id = String(body.id ?? '')
    const hasTitle = typeof body.title === 'string'
    const hasDescription = typeof body.description === 'string'
    const node = id ? nodes.get(id) : undefined
    const isLeaf = !!node && (node.type === 'file' || node.type === 'site')
    if (!id || (!hasTitle && !hasDescription) || !isLeaf) {
      return HttpResponse.json({ error: 'invalid request' }, { status: 400 })
    }
    const access = checkAccess(id, 'edit')
    if (access === '401') return HttpResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (access === '403') return HttpResponse.json({ error: 'forbidden' }, { status: 403 })

    let updated = { ...node! }
    if (hasTitle) {
      const t = String(body.title).trim()
      updated = { ...updated, title: t ? t.slice(0, 200) : null }
    }
    if (hasDescription) {
      const d = String(body.description)
      updated = { ...updated, description: d ? d.slice(0, 2000) : null }
    }
    nodes.set(id, updated)
    return HttpResponse.json({ id, title: updated.title ?? null, description: updated.description ?? null })
  }),

  /**
   * GET /api/uploads/content/*
   * Serves bytes stored during the mock PUT — sets up preview for slice #8.
   */
  http.get('/api/uploads/content/*', ({ request }) => {
    const storageKey = new URL(request.url).pathname.replace('/api/uploads/content/', '')
    const obj = objects.get(storageKey)
    if (!obj) return new HttpResponse(null, { status: 404 })
    return new HttpResponse(obj.body, {
      status: 200,
      headers: { 'Content-Type': obj.type },
    })
  }),

  /**
   * POST /api/sign
   * Body: { path: storageKey }
   * Response: { signed: { url } }
   *
   * In dev mocks, we return the serve path (/api/uploads/content/<storageKey>)
   * as the "signed" URL so the <video>/<audio> element can actually load the
   * bytes stored by the mock bucket PUT — same response shape as the real
   * contract (`{ signed: { url } }`).
   */
  http.post('/api/sign', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { path?: string }
    const storageKey = body.path ?? ''
    const url = mockServePath(storageKey)
    return HttpResponse.json({ signed: { url } })
  }),

  /**
   * POST /api/sites
   * Body: { parentId, name, entry, path, createdMs }
   * Response: { node: HandoffNode } — type:'site', url = the Entry's content URL
   * on the unified endpoint (`/api/uploads/content/<path>/<entry>`). The Site's
   * assets were already PUT to the mock bucket at their verbatim keys under
   * `<path>/`, so they serve straight through GET /api/uploads/content/* — no
   * manifest, no dedicated site route (structural storage, Slice 3).
   */
  http.post('/api/sites', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      parentId?: string
      name?: string
      entry?: string
      path?: string
      createdMs?: number
    }
    const siteName = body.name ?? 'Untitled Site'
    const siteParentId = body.parentId ?? 'root'
    // In-Folder name uniqueness — a Site collides just like a File (Slice 4).
    if (siblingNameExists(siteParentId, siteName)) {
      return HttpResponse.json(
        { error: 'An item with that name already exists in this folder. Rename it and try again.' },
        { status: 409 },
      )
    }
    const id = String(++nodeCounter)
    const entry = body.entry ?? 'index.html'
    const path = body.path ?? ''
    const siteUrl = mockServePath(`${path}/${entry}`)
    const ownerId = mockCurrentUser?.id ?? null

    const raw = {
      id,
      type: 'site',
      name: siteName,
      mime: null,
      size: null,
      url: siteUrl,
      storageKey: null,
      path,
      parentId: siteParentId,
      createdAt: typeof body.createdMs === 'number' ? body.createdMs : Date.now(),
      ownerId,
      grants: [],
      mode: 'inheriting' as const,
    }
    const node = toNode(raw)
    nodes.set(id, node)
    sites.set(id, { entry, path })
    nodeAcl.set(id, { ownerId, grants: [], mode: 'inheriting' })
    return HttpResponse.json({ node })
  }),

  // ---------------------------------------------------------------------------
  // Share-link handlers
  // ---------------------------------------------------------------------------

  /**
   * POST /api/share-links
   * Body: { folderId, expiresMs? }
   * Response: { token, folderId, expiresAt, revoked, url, createdAt }
   * Auth required; must be owner/admin of the folder.
   */
  http.post('/api/share-links', async ({ request }) => {
    if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
    const body = (await request.json().catch(() => ({}))) as {
      folderId?: string
      expiresMs?: number
    }
    const folderId = resolveFolderId(body.folderId ?? '')
    const acl = nodeAcl.get(folderId)
    if (acl) {
      const isAdmin = mockCurrentUser.role === 'admin'
      const isOwner = acl.ownerId === mockCurrentUser.id
      if (!isAdmin && !isOwner) return new HttpResponse(null, { status: 403 })
    }
    const token = `mock-token-${++tokenCounter}`
    const now = Date.now()
    const expiresAt = body.expiresMs != null ? now + body.expiresMs : null
    const link: MockShareLink = {
      token,
      folderId,
      expiresAt,
      revoked: false,
      url: `/s/${token}`,
      createdAt: now,
      creatorId: mockCurrentUser.id,
    }
    shareLinks.set(token, link)
    return HttpResponse.json({ token, folderId, expiresAt, revoked: false, url: link.url, createdAt: now })
  }),

  /**
   * GET /api/share-links?folderId=<id>
   * Response: { links: ShareLink[] }  (auth)
   */
  http.get('/api/share-links', ({ request }) => {
    if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
    const folderId = resolveFolderId(new URL(request.url).searchParams.get('folderId') ?? '')
    const acl = nodeAcl.get(folderId)
    if (acl) {
      const isAdmin = mockCurrentUser.role === 'admin'
      const isOwner = acl.ownerId === mockCurrentUser.id
      if (!isAdmin && !isOwner) return new HttpResponse(null, { status: 403 })
    }
    const links = [...shareLinks.values()]
      .filter((l) => l.folderId === folderId)
      .map(({ token, folderId: fid, expiresAt, revoked, url, createdAt }) => ({
        token, folderId: fid, expiresAt, revoked, url, createdAt,
      }))
    return HttpResponse.json({ links })
  }),

  /**
   * POST /api/share-links/revoke
   * Body: { token }
   * Response: { token, revoked: true }  (auth; creator/admin)
   */
  http.post('/api/share-links/revoke', async ({ request }) => {
    if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
    const body = (await request.json().catch(() => ({}))) as { token?: string }
    const token = body.token ?? ''
    const link = shareLinks.get(token)
    if (!link) return new HttpResponse(null, { status: 404 })
    const isAdmin = mockCurrentUser.role === 'admin'
    const isCreator = link.creatorId === mockCurrentUser.id
    if (!isAdmin && !isCreator) return new HttpResponse(null, { status: 403 })
    link.revoked = true
    return HttpResponse.json({ token, revoked: true })
  }),

  /**
   * GET /api/share-links/validate?token=<t>
   * Response: { valid: boolean, folderId: string | null }
   * PUBLIC — no auth. Handles revoked/expired/bogus tokens → valid:false.
   */
  http.get('/api/share-links/validate', ({ request }) => {
    const token = new URL(request.url).searchParams.get('token') ?? ''
    const link = shareLinks.get(token)
    if (!link || link.revoked) {
      return HttpResponse.json({ valid: false, folderId: null })
    }
    if (link.expiresAt !== null && link.expiresAt < Date.now()) {
      return HttpResponse.json({ valid: false, folderId: null })
    }
    return HttpResponse.json({ valid: true, folderId: link.folderId })
  }),

  /**
   * POST /api/share-links/claim
   * Body: { token }
   * Response: { valid: boolean, folderId: string | null }
   * PUBLIC — validates the token and (in production) sets a signed, folder-scoped
   * hf_s view cookie the ACL gate accepts. There is no cookie jar under MSW, so
   * the mock mirrors that Set-Cookie by setting the in-memory share-link viewer
   * context (`mockShareLinkFolderId`) on a valid claim — subsequent gated calls
   * (resolve, node) in the same test then see the granted scope, exactly as a
   * real guest's follow-up requests would carry the cookie. Reset between tests
   * by `resetMockState`. An invalid claim leaves the context untouched.
   */
  http.post('/api/share-links/claim', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { token?: string }
    const token = body.token ?? ''
    const link = shareLinks.get(token)
    if (!link || link.revoked) {
      return HttpResponse.json({ valid: false, folderId: null })
    }
    if (link.expiresAt !== null && link.expiresAt < Date.now()) {
      return HttpResponse.json({ valid: false, folderId: null })
    }
    mockShareLinkFolderId = link.folderId
    return HttpResponse.json({ valid: true, folderId: link.folderId })
  }),

  // ---------------------------------------------------------------------------
  // Comments handlers
  // ---------------------------------------------------------------------------

  /**
   * GET /api/comments?nodeId=…
   * Response: { comments: (Row | husk)[] }
   * Read-gated (view+) per-folder ACL, share-cookie visitors included — mirrors
   * comments/get/{gate,shape}.fn.ts via `checkAccess` (the same helper every
   * other read route uses). Soft-deleted roots go out as husks.
   */
  http.get('/api/comments', ({ request }) => {
    const nodeId = new URL(request.url).searchParams.get('nodeId') ?? ''
    if (!nodeId || !nodes.has(nodeId)) {
      return HttpResponse.json({ error: 'invalid request' }, { status: 400 })
    }

    const access = checkAccess(nodeId, 'view')
    if (access === '401') return HttpResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (access === '403') return HttpResponse.json({ error: 'forbidden' }, { status: 403 })

    const rows = [...comments.values()].filter((c) => c.nodeId === nodeId).map(shapeComment)
    return HttpResponse.json({ comments: rows })
  }),

  /**
   * POST /api/comments
   * Body: { nodeId, body, parentId?, anchor? }
   * Response: { comment: Row }
   * Mirrors comments/post/{pre,gate,shape}.fn.ts: a share-cookie visitor alone
   * is never enough to write (spec §7) — a session `mockCurrentUser` is
   * mandatory in addition to view+ access on the node, checked in that order
   * (matching the gate's uid-first deny401/deny403 split).
   */
  http.post('/api/comments', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      nodeId?: unknown
      body?: unknown
      parentId?: unknown
      anchor?: unknown
    }
    const nodeId = String(body.nodeId ?? '')
    const parentId = body.parentId == null ? '' : String(body.parentId)
    const bodyText = typeof body.body === 'string' ? body.body : ''
    const trimmed = bodyText.trim()
    const isReply = parentId !== ''

    const nodeOk = !!nodeId && nodes.has(nodeId)
    const bodyOk = trimmed.length > 0 && trimmed.length <= MAX_COMMENT_BODY

    let replyOk = true
    if (isReply) {
      const parent = comments.get(parentId)
      replyOk = !!parent && !parent.deleted && parent.parentId === '' && parent.nodeId === nodeId
    }

    if (!nodeOk || !bodyOk || !replyOk) {
      return HttpResponse.json({ error: 'invalid request' }, { status: 400 })
    }

    // WRITE rule (spec §7): a session user id is mandatory — hf_s alone never writes.
    if (!mockCurrentUser) return HttpResponse.json({ error: 'unauthorized' }, { status: 401 })

    const access = checkAccess(nodeId, 'view')
    if (access !== 'ok') {
      // uid is present here, so an insufficient level is always 403 (deny403).
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const record: MockComment = {
      id: crypto.randomUUID(),
      nodeId,
      parentId,
      authorId: mockCurrentUser.id,
      authorName: mockCurrentUser.email,
      body: trimmed,
      anchorJson: isReply ? null : anchorStringForCreate(body.anchor),
      resolved: false,
      resolvedBy: null,
      resolvedMs: null,
      reactionsJson: '{}',
      deleted: false,
      createdMs: Date.now(),
      updatedMs: null,
    }
    comments.set(record.id, record)
    return HttpResponse.json({ comment: shapeComment(record) })
  }),

  /**
   * PATCH /api/comments
   * Body: { id, op: 'edit'|'resolve'|'reopen'|'react', body?, emoji? }
   * Response: { comment: Row }
   * Same op table + auth posture as comments/patch/{pre,gate,shape}.fn.ts:
   * session + view+ required for every op; `edit` additionally author-only;
   * `resolve`/`reopen` root-only (targeting a reply is a 400, not a 403);
   * `react` toggles the caller's id into/out of `reactionsJson[emoji]`.
   */
  http.patch('/api/comments', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      id?: unknown
      op?: unknown
      body?: unknown
      emoji?: unknown
    }
    const id = String(body.id ?? '')
    const op = String(body.op ?? '')
    const OPS = ['edit', 'resolve', 'reopen', 'react'] as const
    const opOk = (OPS as readonly string[]).includes(op)

    const bodyRaw = typeof body.body === 'string' ? body.body : ''
    const newBody = bodyRaw.trim()
    const bodyOk = newBody.length > 0 && newBody.length <= MAX_COMMENT_BODY

    const emoji = typeof body.emoji === 'string' ? body.emoji : ''
    const emojiOk = emoji.length > 0 && emoji.length <= MAX_EMOJI

    const comment = id ? comments.get(id) : undefined
    const isRoot = !!comment && comment.parentId === ''
    const opFieldOk =
      opOk &&
      (op !== 'edit' || bodyOk) &&
      (op !== 'react' || emojiOk) &&
      ((op !== 'resolve' && op !== 'reopen') || isRoot)

    const badRequest = !id || !comment || comment.deleted || !opFieldOk
    if (badRequest) {
      return HttpResponse.json({ error: 'invalid request' }, { status: 400 })
    }

    if (!mockCurrentUser) return HttpResponse.json({ error: 'unauthorized' }, { status: 401 })

    const c = comment as MockComment
    const access = checkAccess(c.nodeId, 'view')
    const isAuthor = c.authorId === mockCurrentUser.id
    const permitted = access === 'ok' && (op !== 'edit' || isAuthor)
    if (!permitted) {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const now = Date.now()
    if (op === 'edit') {
      c.body = newBody
      c.updatedMs = now
    } else if (op === 'resolve' || op === 'reopen') {
      c.resolved = op === 'resolve'
      c.resolvedBy = mockCurrentUser.id
      c.resolvedMs = now
    } else if (op === 'react') {
      let reactions: Record<string, string[]>
      try {
        reactions = (JSON.parse(c.reactionsJson) as Record<string, string[]>) || {}
      } catch {
        reactions = {}
      }
      const uid = mockCurrentUser.id
      const cur = Array.isArray(reactions[emoji]) ? reactions[emoji] : []
      const next = cur.includes(uid) ? cur.filter((u) => u !== uid) : [...cur, uid]
      if (next.length) reactions[emoji] = next
      else delete reactions[emoji]
      c.reactionsJson = JSON.stringify(reactions)
    }

    return HttpResponse.json({ comment: shapeComment(c) })
  }),

  /**
   * DELETE /api/comments?id=…
   * Response: { id, soft }
   * Author-only (v1: not even an admin may moderate-delete) — mirrors
   * comments/delete/{pre,gate}.fn.ts. A root comment with >=1 reply is
   * soft-deleted (husk keeps id/nodeId/parentId/deleted/createdMs/anchorJson
   * — only body/authorName are cleared — so it still anchors at its original
   * spot instead of listing under "Unanchored"); a reply, or a childless
   * root, is hard-deleted. An orphan husk (no surviving replies) is filtered
   * out client-side entirely by `threadsFor`.
   */
  http.delete('/api/comments', ({ request }) => {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const comment = id ? comments.get(id) : undefined
    const badRequest = !id || !comment || comment.deleted
    if (badRequest) {
      return HttpResponse.json({ error: 'invalid request' }, { status: 400 })
    }

    if (!mockCurrentUser) return HttpResponse.json({ error: 'unauthorized' }, { status: 401 })

    const c = comment as MockComment
    const isAuthor = c.authorId === mockCurrentUser.id
    if (!isAuthor) return HttpResponse.json({ error: 'forbidden' }, { status: 403 })

    const isRoot = c.parentId === ''
    const hasReplies = [...comments.values()].some((r) => r.parentId === id)
    const doSoft = isRoot && hasReplies

    if (doSoft) {
      c.deleted = true
      c.body = ''
      c.authorName = ''
    } else {
      comments.delete(id)
    }

    return HttpResponse.json({ id, soft: doSoft })
  }),
] as const
