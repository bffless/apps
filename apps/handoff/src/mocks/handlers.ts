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

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Stored HandoffNode records, keyed by id. */
export const nodes = new Map<string, HandoffNode>()

/** Raw bytes uploaded via the mock bucket PUT. */
export const objects = new Map<string, { body: ArrayBuffer; type: string }>()

/** Monotonically-incrementing node id counter for determinism. */
let nodeCounter = 0

/** Reset all mock state — exported for use in tests. */
export function resetMockState(): void {
  nodes.clear()
  objects.clear()
  nodeCounter = 0
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
    const raw = {
      id,
      type: 'file',
      name: body.displayName ?? body.originalName ?? 'Untitled',
      mime: null,
      size: body.storageKey ? (objects.get(body.storageKey)?.body.byteLength ?? null) : null,
      url: body.storageKey ? mockServePath(body.storageKey) : null,
      storageKey: body.storageKey ?? null,
      parentId: body.parentId ?? 'root',
      createdAt: typeof body.createdMs === 'number' ? body.createdMs : Date.now(),
    }
    const node = toNode(raw)
    nodes.set(id, node)
    return HttpResponse.json({ node })
  }),

  /**
   * GET /api/nodes?parentId=…
   * Response: { nodes: HandoffNode[] }
   */
  http.get('/api/nodes', ({ request }) => {
    const parentId = new URL(request.url).searchParams.get('parentId') ?? 'root'
    const filtered = [...nodes.values()].filter((n) => n.parentId === parentId)
    return HttpResponse.json({ nodes: filtered })
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
] as const
