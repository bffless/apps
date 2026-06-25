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
import type { Grant, FolderLink } from '../lib/acl'

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

/** Monotonically-incrementing node id counter for determinism. */
let nodeCounter = 0

/** Reset all mock state — exported for use in tests. */
export function resetMockState(): void {
  nodes.clear()
  objects.clear()
  sites.clear()
  nodeAcl.clear()
  grants.clear()
  nodeCounter = 0
  mockCurrentUser = { id: 'user-owner', email: 'owner@example.com', role: 'admin' }
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
 * Check whether `mockCurrentUser` can access the given node.
 *
 * Delegates to the canonical `evaluateAccess` from `src/lib/acl.ts` so the
 * mock enforces exactly the same rules as production (incl. inheritance and
 * restricted-mode semantics).
 *
 * Builds the ancestor FolderLink chain by walking `parentId` through the
 * in-memory `nodes` / `nodeAcl` maps (root → target). Capped at 64 hops to
 * avoid hanging on a cycle.
 *
 * Returns: 'ok' | '401' | '403'
 */
function checkAccess(nodeId: string): 'ok' | '401' | '403' {
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
  return level === 'none' ? '403' : 'ok'
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
   * Enforces ACL: checks mockCurrentUser against the parentId's ACL.
   */
  http.get('/api/nodes', ({ request }) => {
    const parentId = new URL(request.url).searchParams.get('parentId') ?? 'root'

    // ACL check on the parentId folder (skip for root)
    if (parentId !== 'root') {
      const access = checkAccess(parentId)
      if (access === '401') return new HttpResponse(null, { status: 401 })
      if (access === '403') return new HttpResponse(null, { status: 403 })
    } else {
      // root requires auth
      if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
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
   * Enforces ACL.
   */
  http.get('/api/node', ({ request }) => {
    if (!mockCurrentUser) return new HttpResponse(null, { status: 401 })
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
] as const
