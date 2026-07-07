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
 * guard so mock == real: a name identifies content within a Folder, so a File
 * or Site whose name equals an existing sibling in the same Folder is rejected
 * (409), never overwritten. Any sibling type counts, and only within the same
 * `parentId` — the same name in a different Folder is fine.
 */
function siblingNameExists(parentId: string, name: string, ownerId: string | null): boolean {
  // 'root' is a shared virtual bucket (each user's Home), so it is scoped by
  // owner; a real Folder (UUID parentId) collides across any owner (a shared-
  // folder editor must not overwrite the owner's file). Mirrors the pipeline guard.
  const isRoot = parentId === 'root'
  for (const n of nodes.values()) {
    if (n.parentId !== parentId || n.name !== name) continue
    if (isRoot && n.ownerId !== ownerId) continue
    return true
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
export let mockCurrentUser: { id: string; email: string; role?: string } | null = {
  id: 'user-owner',
  email: 'owner@example.com',
  role: 'admin',
}

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
  nodeCounter = 0
  tokenCounter = 0
  mockCurrentUser = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }
  mockShareLinkFolderId = null
  seedRoot()
}

/** Set the current mock user (or null for unauthenticated). */
export function setMockUser(user: { id: string; email: string; role?: string } | null): void {
  mockCurrentUser = user
}

/** Set grants for a specific folder. */
export function setMockGrants(folderId: string, g: Grant[]): void {
  grants.set(folderId, g)
  const acl = nodeAcl.get(folderId)
  if (acl) acl.grants = g
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
    ? { userId: mockCurrentUser.id, isAdmin: mockCurrentUser.role === 'admin' }
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
   * Body: { folderId, principalId, principalEmail?, level }
   * Response: { grants: Grant[] }
   */
  http.post('/api/grants', async ({ request }) => {
    if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
    const body = (await request.json().catch(() => ({}))) as {
      folderId?: string
      principalId?: string
      principalEmail?: string
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
    const newGrant: Grant = {
      principalId: body.principalId ?? '',
      principalEmail: isAnyone ? null : (body.principalEmail ?? null),
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
    if (body.parentId && siblingNameExists(body.parentId, filename, mockCurrentUser?.id ?? null)) {
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
    if (siblingNameExists(parentId, displayName, mockCurrentUser?.id ?? null)) {
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
   * Body: { id, mode: 'inheriting' | 'restricted' }
   * Response: { id, mode }
   * Mirrors the live `node-set-mode` pipeline (Task 3): 400 on a bad/missing
   * id or mode, or a non-folder target (root and files rejected); 403 for
   * anyone who isn't the folder's owner or an admin (anonymous included —
   * there is no 401 branch, matching the real rule's `denied` step).
   */
  http.patch('/api/node', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { id?: string; mode?: string }
    const id = String(body.id ?? '')
    const mode: 'inheriting' | 'restricted' | '' =
      body.mode === 'restricted' ? 'restricted' : body.mode === 'inheriting' ? 'inheriting' : ''
    const node = id ? nodes.get(id) : undefined
    const isFolder = !!node && node.type === 'folder'
    const badRequest = !id || !mode || !isFolder

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

    if (acl) acl.mode = mode
    nodes.set(id, { ...node!, mode })
    return HttpResponse.json({ id, mode })
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
    if (siblingNameExists(siteParentId, siteName, mockCurrentUser?.id ?? null)) {
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
   * hf_s view cookie the ACL gate accepts. The mock returns the same shape so the
   * share-link entry flow works offline; cookie-setting is a no-op under MSW.
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
    return HttpResponse.json({ valid: true, folderId: link.folderId })
  }),
] as const
