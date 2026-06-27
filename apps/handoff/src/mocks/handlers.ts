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
import { evaluateAccess } from '../lib/acl'
import type { AccessLevel, Grant, FolderLink } from '../lib/acl'

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Stored HandoffNode records, keyed by id. */
export const nodes = new Map<string, HandoffNode>()

/** Raw bytes uploaded via the mock bucket PUT. */
export const objects = new Map<string, { body: ArrayBuffer; type: string }>()

/**
 * Site metadata for mock site nodes.
 * Key: site node id; Value: { entry, manifest }
 */
export const sites = new Map<string, { entry: string; manifest: Record<string, string> }>()

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

function checkAccess(nodeId: string, minLevel: AccessLevel = 'view'): 'ok' | '401' | '403' {
  // Share-link viewer path: no user, just a scoped folderId.
  if (mockShareLinkFolderId !== null) {
    // Share-link viewers are capped at 'view' — they can never satisfy a write.
    if (levelRank(minLevel) > levelRank('view')) return '403'
    const acl = nodeAcl.get(nodeId)
    if (!acl) return 'ok' // no ACL = open

    const MAX_HOPS = 64
    const ancestorIds: string[] = []
    let cursor: string | undefined = nodeId
    let hops = 0
    while (cursor && cursor !== 'root' && hops < MAX_HOPS) {
      ancestorIds.unshift(cursor)
      const n = nodes.get(cursor)
      cursor = n?.parentId ?? undefined
      hops++
    }

    const folderChain: FolderLink[] = ancestorIds.map((id) => {
      const a = nodeAcl.get(id)
      return {
        id,
        ownerId: a?.ownerId ?? null,
        grants: a?.grants ?? [],
        mode: a?.mode ?? 'inheriting',
      }
    })

    if (folderChain.length === 0) {
      folderChain.push({ id: nodeId, ownerId: acl.ownerId, grants: acl.grants, mode: acl.mode })
    }

    const level = evaluateAccess({ folderChain, viewer: { shareLinkFolderId: mockShareLinkFolderId } })
    return levelRank(level) >= levelRank(minLevel) ? 'ok' : '403'
  }

  // Normal user path.
  if (!mockCurrentUser) return '401'

  const acl = nodeAcl.get(nodeId)
  if (!acl) return 'ok' // no ACL record = open (root or file)

  // Build ancestor chain: walk parentId links from root down to nodeId.
  const MAX_HOPS = 64
  const ancestorIds: string[] = []
  let cursor: string | undefined = nodeId
  let hops = 0
  while (cursor && cursor !== 'root' && hops < MAX_HOPS) {
    ancestorIds.unshift(cursor)
    const n = nodes.get(cursor)
    cursor = n?.parentId ?? undefined
    hops++
  }

  // Build the FolderLink chain (root → target).
  const folderChain: FolderLink[] = ancestorIds.map((id) => {
    const a = nodeAcl.get(id)
    return {
      id,
      ownerId: a?.ownerId ?? null,
      grants: a?.grants ?? [],
      mode: a?.mode ?? 'inheriting',
    }
  })

  // If the chain is somehow empty (e.g. nodeId not in nodes map), fall back to
  // the direct ACL entry so we still enforce something.
  if (folderChain.length === 0) {
    folderChain.push({
      id: nodeId,
      ownerId: acl.ownerId,
      grants: acl.grants,
      mode: acl.mode,
    })
  }

  const viewer = {
    userId: mockCurrentUser.id,
    isAdmin: mockCurrentUser.role === 'admin',
  }

  const level = evaluateAccess({ folderChain, viewer })
  return levelRank(level) >= levelRank(minLevel) ? 'ok' : '403'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    const folderId = new URL(request.url).searchParams.get('folderId') ?? ''
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
    const folderId = body.folderId ?? ''
    const acl = nodeAcl.get(folderId)
    if (acl) {
      const isAdmin = mockCurrentUser.role === 'admin'
      const isOwner = acl.ownerId === mockCurrentUser.id
      if (!isAdmin && !isOwner) return new HttpResponse(null, { status: 403 })
    }
    const existing = grants.get(folderId) ?? []
    const newGrant: Grant = {
      principalId: body.principalId ?? '',
      principalEmail: body.principalEmail,
      level: body.level ?? 'view',
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
    const folderId = body.folderId ?? ''
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
    }
    const filename = body.filename ?? 'upload'
    const storageKey = `handoff/uploads/mock/${Date.now()}-${filename}`
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
    const id = String(++nodeCounter)
    const ownerId = mockCurrentUser?.id ?? null
    const raw = {
      id,
      type: 'file',
      name: body.displayName ?? body.originalName ?? 'Untitled',
      mime: body.storageKey ? (objects.get(body.storageKey)?.type ?? null) : null,
      size: body.storageKey ? (objects.get(body.storageKey)?.body.byteLength ?? null) : null,
      url: body.storageKey ? mockServePath(body.storageKey) : null,
      storageKey: body.storageKey ?? null,
      parentId: body.parentId ?? 'root',
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
   * Response: { nodes: HandoffNode[] }
   * Enforces ACL: checks mockCurrentUser (or share-link viewer) against the parentId's ACL.
   */
  http.get('/api/nodes', ({ request }) => {
    const parentId = new URL(request.url).searchParams.get('parentId') ?? 'root'

    // ACL check on the parentId folder (skip for root)
    if (parentId !== 'root') {
      const access = checkAccess(parentId)
      if (access === '401') return new HttpResponse(null, { status: 401 })
      if (access === '403') return new HttpResponse(null, { status: 403 })
    } else {
      // root requires auth (share-link viewers are never at root)
      if (!mockCurrentUser && mockShareLinkFolderId === null) return new HttpResponse(null, { status: 401 })
      // Share-link viewers trying to list root → 403 (out of scope)
      if (mockShareLinkFolderId !== null) return new HttpResponse(null, { status: 403 })
    }

    const filtered = [...nodes.values()].filter((n) => n.parentId === parentId)
    // Attach ACL fields to each node in response
    const withAcl = filtered.map((n) => {
      const acl = nodeAcl.get(n.id)
      return {
        ...n,
        ownerId: acl?.ownerId ?? n.ownerId,
        grants: acl?.grants ?? n.grants,
        mode: acl?.mode ?? n.mode,
      }
    })
    return HttpResponse.json({ nodes: withAcl })
  }),

  /**
   * GET /api/node?id=…
   * Response: { node: HandoffNode | null }
   * Enforces ACL (supports share-link viewer context).
   */
  http.get('/api/node', ({ request }) => {
    // Allow share-link viewers (no user required)
    if (!mockCurrentUser && mockShareLinkFolderId === null) return new HttpResponse(null, { status: 401 })
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const access = checkAccess(id)
    if (access === '401') return new HttpResponse(null, { status: 401 })
    if (access === '403') return new HttpResponse(null, { status: 403 })

    const node = nodes.get(id) ?? null
    if (!node) return HttpResponse.json({ node: null })

    const acl = nodeAcl.get(id)
    const nodeWithAcl = acl ? { ...node, ...acl } : node
    return HttpResponse.json({ node: nodeWithAcl })
  }),

  /**
   * DELETE /api/node?id=…
   * Hard-delete a single node — write-gated (edit/owner). Mirrors the live
   * `Handoff delete node` pipeline at the `toNode` seam:
   *   - no credential → 401; insufficient (view-only / share-link) → 403.
   *   - a folder that still has children → 409 (the client deletes bottom-up, so
   *     this only guards direct/out-of-order calls from orphaning a subtree).
   *   - a file → its stored object is purged too.
   *   - a site → every object its manifest references is purged (the live
   *     pipeline does this via `file_delete` keys-as-expression — ce#364 / #35).
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

    // Hard delete: purge the stored object(s), then drop the record + ACL.
    if (node.type === 'file' && node.storageKey) {
      objects.delete(node.storageKey)
    } else if (node.type === 'site') {
      // Purge every object the site's manifest references (mirrors the live
      // siteKeys → file_delete keys[] step). Manifest values are serve paths
      // (/api/uploads/content/<storageKey>); strip back to the objects key.
      const manifest = sites.get(id)?.manifest ?? {}
      for (const target of Object.values(manifest)) {
        const key = target.replace(/^\/api\/uploads\/content\//, '')
        if (key) objects.delete(key)
      }
    }
    nodes.delete(id)
    nodeAcl.delete(id)
    grants.delete(id)
    sites.delete(id)
    return HttpResponse.json({ deleted: true, id })
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
   * Body: { parentId, name, entry, manifest, createdMs }
   * Response: { node: HandoffNode } — type:'site', url = /api/sites/<id>/<entry>
   */
  http.post('/api/sites', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      parentId?: string
      name?: string
      entry?: string
      manifest?: Record<string, string>
      createdMs?: number
    }
    const id = String(++nodeCounter)
    const entry = body.entry ?? 'index.html'
    const manifest = body.manifest ?? {}
    const siteUrl = `/api/sites/${id}/${entry}`
    const ownerId = mockCurrentUser?.id ?? null

    const raw = {
      id,
      type: 'site',
      name: body.name ?? 'Untitled Site',
      mime: null,
      size: null,
      url: siteUrl,
      storageKey: null,
      parentId: body.parentId ?? 'root',
      createdAt: typeof body.createdMs === 'number' ? body.createdMs : Date.now(),
      ownerId,
      grants: [],
      mode: 'inheriting' as const,
    }
    const node = toNode(raw)
    nodes.set(id, node)
    sites.set(id, { entry, manifest })
    nodeAcl.set(id, { ownerId, grants: [], mode: 'inheriting' })
    return HttpResponse.json({ node })
  }),

  /**
   * GET /api/sites/<siteId>/<relPath...>
   * Resolves the relPath via the site's manifest to a storageKey / publicPath,
   * then serves the bytes from the objects store.
   */
  http.get('/api/sites/:siteId/*', ({ request, params }) => {
    const siteId = String(params.siteId)
    // The wildcard part after /api/sites/<siteId>/
    const url = new URL(request.url)
    const relPath = url.pathname.replace(`/api/sites/${siteId}/`, '')

    const site = sites.get(siteId)
    if (!site) return new HttpResponse(null, { status: 404 })

    // Look up the publicPath for this relPath in the manifest
    const publicPath = site.manifest[relPath]
    if (!publicPath) return new HttpResponse(null, { status: 404 })

    // Derive the storageKey from the publicPath (reverse of mockServePath)
    const storageKey = publicPath.replace('/api/uploads/content/', '')
    const obj = objects.get(storageKey)
    if (!obj) return new HttpResponse(null, { status: 404 })

    return new HttpResponse(obj.body, {
      status: 200,
      headers: { 'Content-Type': obj.type },
    })
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
    const folderId = body.folderId ?? ''
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
    const folderId = new URL(request.url).searchParams.get('folderId') ?? ''
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
