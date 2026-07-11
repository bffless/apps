/**
 * RTK Query data layer for the Handoff `/api/*` endpoints. Network calls go
 * through here for consistent caching, in-flight state, and error handling.
 *
 * Upload flow (presigned direct-to-bucket):
 *   1. POST /api/uploads/prepare  → { uploadUrl, storageKey, ... }
 *   2. PUT  <uploadUrl>           → raw bytes straight to bucket (no proxy)
 *   3. POST /api/nodes            → register metadata → { node: Node }
 *
 * Both the live BFFless pipeline responses and the MSW mocks pass through
 * `toNode`/`toNodeList` — one coercion seam shared by mock and real.
 */

import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query/react'
import { attemptRefresh } from '../lib/session'
import { toNode, toNodeList, buildRegisterBody } from '../lib/nodes'
import { encodePath } from '../lib/pathUrl'
import type { HandoffNode, PreparedUpload, RegisterBody } from '../lib/nodes'
import { toSignedUrl } from '../lib/sign'
import { planFolderImport } from '../lib/folderImport'
import { contentSubPath } from '../lib/contentPath'
import type { Grant } from '../lib/acl'
import type { RootMeta } from '../lib/rootNode'

export type { HandoffNode, PreparedUpload, RegisterBody, Grant, RootMeta }

// ---------------------------------------------------------------------------
// Share-link types
// ---------------------------------------------------------------------------

export interface ShareLink {
  token: string
  folderId: string
  expiresAt: number | null
  revoked: boolean
  url: string
  createdAt?: number
}

function toShareLink(raw: unknown): ShareLink {
  const r = raw as Record<string, unknown>
  return {
    token: String(r.token ?? ''),
    folderId: String(r.folderId ?? ''),
    expiresAt: r.expiresAt != null ? Number(r.expiresAt) : null,
    revoked: Boolean(r.revoked),
    url: String(r.url ?? ''),
    createdAt: r.createdAt != null ? Number(r.createdAt) : undefined,
  }
}

function toShareLinkList(raw: unknown): ShareLink[] {
  const r = raw as { links?: unknown[] }
  if (!Array.isArray(r?.links)) return []
  return r.links.map(toShareLink)
}

// ---------------------------------------------------------------------------
// Folder-import result
// ---------------------------------------------------------------------------

export interface ImportFolderResult {
  /** Number of sub-folders created. */
  foldersCreated: number
  /** Number of files successfully uploaded + registered. */
  filesUploaded: number
  /** Per-file failures (folder creation failures abort and surface as an error). */
  failures: { relPath: string; error: string }[]
  /** Ids of every created sub-folder, used to invalidate their listings. */
  createdFolderIds: string[]
}

/**
 * Run `tasks` with a bounded number in flight at once, preserving result order.
 * Keeps the per-file fan-out from hammering the backend for large folders while
 * staying simple enough to collect a partial-failure summary.
 */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx]!)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Subtree-delete result
// ---------------------------------------------------------------------------

export interface DeleteSubtreeResult {
  /** Number of nodes successfully deleted (root + descendants). */
  deleted: number
  /** Per-node failures so a partial delete still reports what survived. */
  failures: { id: string; name: string; error: string }[]
  /** Folder listings to refetch (parent + root + every descendant folder). */
  affectedFolderIds: string[]
}

/** A node discovered while walking a subtree, tagged with its depth from the root. */
interface SubtreeNode {
  id: string
  name: string
  type: HandoffNode['type']
  depth: number
}

/**
 * Turn a base-query error into a clear message when the pipeline rejected a
 * duplicate name (409). The in-Folder uniqueness pipelines respond
 * `{ error: "<message>" }`, so a raw `Upload failed (409)` would bury the real,
 * actionable reason. Falls back to `null` for any other error so callers keep
 * their existing handling.
 */
function conflictMessage(err: unknown): string | null {
  const e = err as { status?: number; data?: unknown }
  if (e?.status !== 409) return null
  const data = e.data as { error?: unknown } | undefined
  return typeof data?.error === 'string' ? data.error : 'A sibling with that name already exists.'
}

const rawBaseQuery = fetchBaseQuery({ baseUrl: '/', credentials: 'include' })

/**
 * On a 401 (expired SuperTokens access token) run the shared single-flight
 * refresh and retry the request once. The refresh is shared with the session
 * hook and `fetchWithReauth` so the whole app issues exactly one
 * `/api/auth/session/refresh` per expiry (the refresh token rotates, so
 * concurrent refreshes would race — see `attemptRefresh`).
 *
 * Without this, queries that 401 during the brief expired-token window on load
 * (e.g. `getNode` + `listNodes` firing before the session check refreshes)
 * never recover: the session hook re-authes but the data stays errored, so the
 * folder renders empty until a manual reload.
 */
const baseQueryWithReauth: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args,
  api,
  extraOptions,
) => {
  let result = await rawBaseQuery(args, api, extraOptions)
  if (result.error?.status === 401 && (await attemptRefresh())) {
    result = await rawBaseQuery(args, api, extraOptions)
  }
  return result
}

export const handoffApi = createApi({
  reducerPath: 'handoffApi',
  baseQuery: baseQueryWithReauth,
  tagTypes: ['Node', 'Grant', 'ShareLink'],
  endpoints: (builder) => ({
    /**
     * GET /api/nodes?parentId=… → { nodes: HandoffNode[] }
     * Provides 'Node' tags so `uploadFile` can invalidate and trigger a refetch.
     */
    listNodes: builder.query<HandoffNode[], { parentId: string }>({
      query: ({ parentId }) => `api/nodes?parentId=${encodeURIComponent(parentId)}`,
      transformResponse: toNodeList,
      providesTags: (result, _err, { parentId }) =>
        result
          ? [...result.map(({ id }) => ({ type: 'Node' as const, id })), { type: 'Node', id: `LIST:${parentId}` }]
          : [{ type: 'Node', id: `LIST:${parentId}` }],
    }),

    /**
     * GET /api/nodes?parentId=root → { nodes: [...], root: { id, public } }
     * Root-only meta: whether the singleton root record ("My Files") carries
     * an Anyone grant. Tagged 'Grant' (not 'Node') so the existing
     * addGrant/revokeGrant/setNodeMode `invalidatesTags: ['Grant', ...]`
     * refreshes the public toggle without a dedicated tag.
     */
    getRootMeta: builder.query<RootMeta, void>({
      query: () => 'api/nodes?parentId=root',
      transformResponse: (raw) => (raw as { root?: RootMeta }).root ?? { id: null, public: false },
      providesTags: ['Grant'],
    }),

    /**
     * GET /api/node?id=<id> → { node: HandoffNode | null }
     * Resolves a single node by id.
     */
    getNode: builder.query<HandoffNode | null, string>({
      query: (id) => `api/node?id=${encodeURIComponent(id)}`,
      transformResponse: (r) => {
        const n = (r as { node?: unknown }).node
        return n ? toNode(n) : null
      },
      providesTags: (_result, _err, id) => [{ type: 'Node' as const, id }],
    }),

    /**
     * GET /api/resolve/<encoded path> → { node: HandoffNode | null }
     * Resolves a /tree//blob content path to its node server-side, under the
     * same ACL gate as content serving — the client cannot walk ancestors it
     * isn't allowed to list (nested grants, share visitors).
     */
    resolvePath: builder.query<HandoffNode | null, string>({
      query: (path) => `api/resolve/${encodePath(path)}`,
      transformResponse: (r) => {
        const n = (r as { node?: unknown }).node
        return n ? toNode(n) : null
      },
      providesTags: (result) => (result ? [{ type: 'Node' as const, id: result.id }] : []),
    }),

    /**
     * POST /api/uploads/prepare → PreparedUpload
     * Mints a presigned PUT URL; the caller PUTs bytes directly to the bucket.
     */
    prepareUpload: builder.mutation<
      PreparedUpload,
      { filename: string; contentType?: string; path?: string; parentId?: string }
    >({
      query: (body) => ({
        url: 'api/uploads/prepare',
        method: 'POST',
        body,
      }),
    }),

    /**
     * POST /api/nodes → { node: HandoffNode }
     * Records the metadata for a file that has already been PUT to the bucket.
     */
    registerNode: builder.mutation<HandoffNode, RegisterBody>({
      query: (body) => ({
        url: 'api/nodes',
        method: 'POST',
        body,
      }),
      transformResponse: (r) => toNode((r as { node?: unknown }).node),
    }),

    /**
     * POST /api/sign → { signed: { url, ... } }
     * Mints a short-lived presigned GET URL for a bucket object so the browser
     * can stream video/audio directly without proxying through BFFless.
     * keepUnusedDataFor is short (60 s) — signed URLs are minted per view and
     * must NOT be persisted to redux-persist (the handoffApi cache is already
     * excluded from the persist config).
     */
    getSignedUrl: builder.query<string | null, string /* storageKey */>({
      query: (storageKey) => ({
        url: 'api/sign',
        method: 'POST',
        body: { path: storageKey },
      }),
      transformResponse: toSignedUrl,
      keepUnusedDataFor: 60,
    }),

    /**
     * POST /api/folders → { node: HandoffNode }
     * Creates a new folder node under parentId.
     */
    createFolder: builder.mutation<HandoffNode, { parentId: string; name: string }>({
      query: ({ parentId, name }) => ({
        url: 'api/folders',
        method: 'POST',
        body: { parentId, name, createdMs: Date.now() },
      }),
      transformResponse: (r) => toNode((r as { node?: unknown }).node),
      invalidatesTags: (_result, _err, { parentId }) => [{ type: 'Node', id: `LIST:${parentId}` }],
    }),

    /**
     * Multi-file presigned-upload flow for a site bundle (structural storage,
     * Slice 3). A Site now stores under its own path prefix on the unified
     * content endpoint — no `manifest` side-map:
     *   1. Compute the Site's content path prefix (`contentSubPath(basePath,
     *      name)` = owning-Folder path + the Site's name). Each asset's verbatim
     *      key is that prefix + its normalised relative path, so the whole bundle
     *      mirrors the dropped tree and relative refs + runtime `fetch()` resolve
     *      same-origin on `/api/uploads/content/*` (ADR-0001).
     *   2. For each item: POST /api/uploads/prepare (with the verbatim `path`),
     *      PUT bytes straight to bucket.
     *   3. POST /api/sites with { parentId, name, entry, path, createdMs }; the
     *      registered node's `url` is the Entry's content URL. Invalidate the
     *      parent's node list.
     *
     * `basePath` is the owning Folder's content path (`''` for a root upload).
     */
    uploadSite: builder.mutation<
      HandoffNode,
      {
        items: { relPath: string; file: File }[]
        entry: string
        name: string
        parentId: string
        basePath?: string
      }
    >({
      async queryFn({ items, entry, name, parentId, basePath = '' }, _queryApi, _extraOptions, baseQuery) {
        try {
          // The Site's content path prefix (owning-Folder path + name). An unsafe
          // name is rejected here — never sanitised — so the bundle's keys stay
          // byte-for-byte what the browser will request.
          let sitePath: string
          try {
            sitePath = contentSubPath(basePath, name)
          } catch {
            return {
              error: { status: 'CUSTOM_ERROR' as const, error: `Unsupported site name: ${name}` },
            }
          }

          for (const { relPath, file } of items) {
            // The asset's verbatim key = the Site prefix + its relative path.
            let path: string
            try {
              path = contentSubPath(sitePath, relPath)
            } catch {
              return {
                error: { status: 'CUSTOM_ERROR' as const, error: `Unsupported path: ${relPath}` },
              }
            }

            // 1a. Prepare presigned PUT URL at the verbatim key.
            const prepRes = await baseQuery({
              url: 'api/uploads/prepare',
              method: 'POST',
              body: {
                filename: relPath.split('/').pop() ?? file.name,
                contentType: file.type || 'application/octet-stream',
                path,
              },
            })
            if (prepRes.error) return { error: prepRes.error }
            const prepared = prepRes.data as PreparedUpload

            // 1b. PUT bytes directly to bucket
            const putRes = await fetch(prepared.uploadUrl, {
              method: 'PUT',
              headers: { 'Content-Type': file.type || 'application/octet-stream' },
              body: file,
            })
            if (!putRes.ok) {
              return {
                error: {
                  status: 'CUSTOM_ERROR' as const,
                  error: `Bucket upload failed for ${relPath} (${putRes.status})`,
                },
              }
            }
          }

          // 2. Register site node at its path prefix (no manifest).
          const siteRes = await baseQuery({
            url: 'api/sites',
            method: 'POST',
            body: { parentId, name, entry, path: sitePath, createdMs: Date.now() },
          })
          if (siteRes.error) {
            // In-Folder name collision (Slice 4): reject a Site whose name
            // duplicates an existing sibling in the target Folder.
            const msg = conflictMessage(siteRes.error)
            return msg
              ? { error: { status: 'CUSTOM_ERROR' as const, error: msg } }
              : { error: siteRes.error }
          }
          const node = toNode((siteRes.data as { node?: unknown }).node)
          return { data: node }
        } catch (e) {
          return {
            error: {
              status: 'CUSTOM_ERROR' as const,
              error: e instanceof Error ? e.message : String(e),
            },
          }
        }
      },
      invalidatesTags: (_result, _err, { parentId }) => [{ type: 'Node', id: `LIST:${parentId}` }],
    }),

    /**
     * Folder-tree import: recreate a dropped folder as browsable Folders + Files.
     * Pure client orchestration over endpoints that already exist:
     *   1. planFolderImport(items) → dirs (parent-before-child) + files.
     *   2. Create each sub-folder via POST /api/folders, building a
     *      `relDir -> folderId` map (root dir '' = the starting parentId).
     *   3. Upload each file (prepare → bucket PUT → POST /api/nodes register)
     *      into its owning folder at its VERBATIM structural key
     *      (`contentSubPath(basePath, relPath)` = owning-Folder path + the file's
     *      normalised relative path), with a bounded concurrency pool. Storing at
     *      the structural key mirrors the dropped tree, so relative references —
     *      same-folder `assets/x` and cross-sibling `../y/z` — resolve on the
     *      unified content endpoint (structural storage, Slice 2).
     *
     * A folder-creation failure aborts (children would be orphaned). File
     * failures — including a structurally-unsafe name `contentSubPath` refuses —
     * are collected into `failures` so a partial import still reports what
     * landed and what didn't — never a silent no-op.
     *
     * `basePath` is the owning Folder's content path (`''` for a root import).
     */
    importFolder: builder.mutation<
      ImportFolderResult,
      { items: { relPath: string; file: File }[]; parentId: string; basePath?: string }
    >({
      async queryFn({ items, parentId, basePath = '' }, _queryApi, _extraOptions, baseQuery) {
        try {
          // planFolderImport carries each item's File through onto its planned
          // file, so the upload always uses the path the plan created folders for.
          const plan = planFolderImport(items)

          // relDir -> folderId; '' is the starting folder we import into.
          const dirToId: Record<string, string> = { '': parentId }
          const createdFolderIds: string[] = []

          // 1. Create folders, parents first.
          for (const dir of plan.dirs) {
            const slash = dir.lastIndexOf('/')
            const parentDir = slash === -1 ? '' : dir.slice(0, slash)
            const name = slash === -1 ? dir : dir.slice(slash + 1)
            const parentFolderId = dirToId[parentDir] ?? parentId

            const res = await baseQuery({
              url: 'api/folders',
              method: 'POST',
              body: { parentId: parentFolderId, name, createdMs: Date.now() },
            })
            if (res.error) return { error: res.error }
            const node = toNode((res.data as { node?: unknown }).node)
            dirToId[dir] = node.id
            createdFolderIds.push(node.id)
          }

          // 2. Upload files into their owning folder (bounded concurrency).
          const failures: { relPath: string; error: string }[] = []
          let filesUploaded = 0

          await runPool(plan.files, 4, async (f) => {
            const { file } = f
            const targetId = dirToId[f.dir] ?? parentId
            try {
              // Verbatim structural key = owning-Folder path + the file's
              // normalised relative path, so the stored key mirrors the tree.
              // A structurally-unsafe name is rejected here (never sanitised)
              // and surfaces as a per-file failure below.
              let path: string
              try {
                path = contentSubPath(basePath, f.relPath)
              } catch {
                throw new Error('unsupported name')
              }
              const prepRes = await baseQuery({
                url: 'api/uploads/prepare',
                method: 'POST',
                body: { filename: f.name, contentType: file.type || 'application/octet-stream', path },
              })
              if (prepRes.error) throw new Error(`prepare failed (${JSON.stringify(prepRes.error)})`)
              const prepared = prepRes.data as PreparedUpload

              const putRes = await fetch(prepared.uploadUrl, {
                method: 'PUT',
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
                body: file,
              })
              if (!putRes.ok) throw new Error(`bucket upload failed (${putRes.status})`)

              const regBody = buildRegisterBody(prepared, file, targetId, Date.now())
              const regRes = await baseQuery({ url: 'api/nodes', method: 'POST', body: regBody })
              if (regRes.error) throw new Error(`register failed (${JSON.stringify(regRes.error)})`)

              filesUploaded++
            } catch (e) {
              failures.push({ relPath: f.relPath, error: e instanceof Error ? e.message : String(e) })
            }
          })

          return {
            data: {
              foldersCreated: createdFolderIds.length,
              filesUploaded,
              failures,
              createdFolderIds,
            },
          }
        } catch (e) {
          return {
            error: {
              status: 'CUSTOM_ERROR' as const,
              error: e instanceof Error ? e.message : String(e),
            },
          }
        }
      },
      invalidatesTags: (result, _err, { parentId }) => [
        { type: 'Node', id: `LIST:${parentId}` },
        ...(result?.createdFolderIds ?? []).map((id) => ({ type: 'Node' as const, id: `LIST:${id}` })),
      ],
    }),

    /**
     * GET /api/grants?folderId=<id> → { grants: Grant[] }
     */
    getGrants: builder.query<{ grants: Grant[] }, { folderId: string }>({
      query: ({ folderId }) => `api/grants?folderId=${encodeURIComponent(folderId)}`,
      providesTags: ['Grant'],
    }),

    /**
     * POST /api/grants { folderId, principalId, principalEmail?, level } → { grants: Grant[] }
     */
    addGrant: builder.mutation<
      { grants: Grant[] },
      { folderId: string; principalId: string; principalEmail?: string; level: 'view' | 'edit' }
    >({
      query: (body) => ({
        url: 'api/grants',
        method: 'POST',
        body,
      }),
      invalidatesTags: (_result, _err, { folderId }) => [
        'Grant',
        { type: 'Node' as const, id: folderId },
      ],
    }),

    /**
     * POST /api/grants/revoke { folderId, principalId } → { grants: Grant[] }
     */
    revokeGrant: builder.mutation<
      { grants: Grant[] },
      { folderId: string; principalId: string }
    >({
      query: (body) => ({
        url: 'api/grants/revoke',
        method: 'POST',
        body,
      }),
      invalidatesTags: (_result, _err, { folderId }) => [
        'Grant',
        { type: 'Node' as const, id: folderId },
      ],
    }),

    /**
     * PATCH /api/node { id, mode } → { id, mode }
     * Sets a folder's inheritance mode ('inheriting' | 'restricted');
     * owner/admin only (400 invalid/non-folder incl. root, 403 otherwise).
     * Invalidates 'Grant' (the public toggle reads via getRootMeta/evaluated
     * chains) plus the node itself and, when known, its parent's listing.
     */
    setNodeMode: builder.mutation<
      { id: string; mode: string },
      { id: string; mode: 'inheriting' | 'restricted'; parentId?: string }
    >({
      query: ({ id, mode }) => ({
        url: 'api/node',
        method: 'PATCH',
        body: { id, mode },
      }),
      invalidatesTags: (_result, _err, { id, parentId }) => [
        'Grant',
        { type: 'Node' as const, id },
        ...(parentId ? [{ type: 'Node' as const, id: parentId }] : []),
      ],
    }),

    /**
     * PATCH /api/node { id, feedExcluded } → { id, feedExcluded }
     * Toggles a folder's feed-exclusion flag (#191 / ADR-0007) — a surfacing
     * flag, not a grant, so it does NOT invalidate 'Grant'. Owner/admin only;
     * 400 for a non-folder (root/file) target. Rides the same PATCH /api/node
     * endpoint as setNodeMode (folders only). Never `Promise.all` this with a
     * same-node mode/grant write — CE's data_update read-modify-writes the whole
     * record, so concurrent same-node writes clobber each other (see #194).
     */
    setNodeFeedExcluded: builder.mutation<
      { id: string; feedExcluded: boolean },
      { id: string; feedExcluded: boolean; parentId?: string }
    >({
      query: ({ id, feedExcluded }) => ({
        url: 'api/node',
        method: 'PATCH',
        body: { id, feedExcluded },
      }),
      invalidatesTags: (_result, _err, { id, parentId }) => [
        { type: 'Node' as const, id },
        ...(parentId ? [{ type: 'Node' as const, id: parentId }] : []),
      ],
    }),

    /**
     * PATCH /api/node/meta { id, title?, description? } → { id, title, description }
     * Sets a File/Site's display title + description (feed-surfaced metadata).
     * Requires `edit` on the parent-folder chain (mirrors the DELETE gate);
     * 400 for a non-leaf/no-field body, 401 no credential, 403 insufficient.
     * An empty string clears a field to null. Single isolated write — never
     * Promise.all with another same-node write (CE data_update clobbers, #194).
     */
    updateNodeMeta: builder.mutation<
      { id: string; title: string | null; description: string | null },
      { id: string; title?: string; description?: string; parentId?: string }
    >({
      query: ({ id, title, description }) => ({
        url: 'api/node/meta',
        method: 'PATCH',
        body: {
          id,
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
        },
      }),
      invalidatesTags: (_result, _err, { id, parentId }) => [
        { type: 'Node' as const, id },
        ...(parentId ? [{ type: 'Node' as const, id: `LIST:${parentId}` }] : []),
      ],
    }),

    /**
     * GET /api/directory?search=<q> → { users: { id: string; email: string }[] }
     */
    searchDirectory: builder.query<{ users: { id: string; email: string }[] }, { search: string }>({
      query: ({ search }) => `api/directory?search=${encodeURIComponent(search)}`,
    }),

    // -----------------------------------------------------------------------
    // Share-link endpoints
    // -----------------------------------------------------------------------

    /**
     * POST /api/share-links { folderId, expiresMs? }
     * → ShareLink  (auth; owner/admin of the folder)
     */
    mintShareLink: builder.mutation<ShareLink, { folderId: string; expiresMs?: number }>({
      query: (body) => ({
        url: 'api/share-links',
        method: 'POST',
        body,
      }),
      transformResponse: toShareLink,
      invalidatesTags: (_result, _err, { folderId }) => [{ type: 'ShareLink' as const, id: `LIST:${folderId}` }],
    }),

    /**
     * GET /api/share-links?folderId=<id>
     * → { links: ShareLink[] }  (auth)
     */
    listShareLinks: builder.query<ShareLink[], { folderId: string }>({
      query: ({ folderId }) => `api/share-links?folderId=${encodeURIComponent(folderId)}`,
      transformResponse: toShareLinkList,
      providesTags: (_result, _err, { folderId }) => [{ type: 'ShareLink' as const, id: `LIST:${folderId}` }],
    }),

    /**
     * POST /api/share-links/revoke { token }
     * → { token, revoked: true }  (auth; creator/admin)
     */
    revokeShareLink: builder.mutation<{ token: string; revoked: true }, { token: string; folderId: string }>({
      query: ({ token }) => ({
        url: 'api/share-links/revoke',
        method: 'POST',
        body: { token },
      }),
      invalidatesTags: (_result, _err, { folderId }) => [{ type: 'ShareLink' as const, id: `LIST:${folderId}` }],
    }),

    /**
     * GET /api/share-links/validate?token=<t>
     * → { valid: boolean, folderId: string | null }  (public — no auth)
     */
    validateShareLink: builder.query<{ valid: boolean; folderId: string | null }, string /* token */>({
      query: (token) => `api/share-links/validate?token=${encodeURIComponent(token)}`,
    }),

    /**
     * POST /api/share-links/claim { token }
     * → { valid: boolean, folderId: string | null }  (public — no auth)
     *
     * Validates the token AND, on success, sets a signed folder-scoped `hf_s`
     * view cookie the server-side ACL gate accepts (ADR-0002). A logged-out
     * visitor must claim before the gated content/list endpoints will serve.
     * `credentials: 'include'` (baseQuery default) lets the Set-Cookie stick.
     */
    claimShareLink: builder.mutation<{ valid: boolean; folderId: string | null }, string /* token */>({
      query: (token) => ({
        url: 'api/share-links/claim',
        method: 'POST',
        body: { token },
      }),
    }),

    /**
     * Full presigned-upload flow: prepare → PUT bytes → register metadata.
     * Modelled on Studio's `upload` mutation — a custom `queryFn` that runs
     * arbitrary async and still exposes itself as a normal RTK mutation hook.
     * On success, invalidates the node list so the listing refetches.
     */
    uploadFile: builder.mutation<HandoffNode, { file: File; parentId: string; path: string }>({
      async queryFn({ file, parentId, path }, _queryApi, _extraOptions, baseQuery) {
        try {
          // 1. Prepare — mint a presigned bucket PUT URL at the verbatim content
          //    sub-path (folder path + name), so the stored key mirrors the tree.
          const prepRes = await baseQuery({
            url: 'api/uploads/prepare',
            method: 'POST',
            body: {
              filename: file.name,
              contentType: file.type || 'application/octet-stream',
              path,
              parentId,
            },
          })
          if (prepRes.error) {
            // In-Folder name collision (Slice 4): prepare rejects before any
            // bytes are minted/PUT, so the existing file is never overwritten.
            const msg = conflictMessage(prepRes.error)
            return msg
              ? { error: { status: 'CUSTOM_ERROR' as const, error: msg } }
              : { error: prepRes.error }
          }
          const prepared = prepRes.data as PreparedUpload

          // 2. PUT bytes directly to the bucket (no proxy, no credentials)
          const putRes = await fetch(prepared.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          })
          if (!putRes.ok) {
            return {
              error: {
                status: 'CUSTOM_ERROR' as const,
                error: `Bucket upload failed (${putRes.status})`,
              },
            }
          }

          // 3. Register metadata server-side
          const nowMs = Date.now()
          const regBody = buildRegisterBody(prepared, file, parentId, nowMs)
          const regRes = await baseQuery({
            url: 'api/nodes',
            method: 'POST',
            body: regBody,
          })
          if (regRes.error) {
            const msg = conflictMessage(regRes.error)
            return msg
              ? { error: { status: 'CUSTOM_ERROR' as const, error: msg } }
              : { error: regRes.error }
          }
          const node = toNode((regRes.data as { node?: unknown }).node)
          return { data: node }
        } catch (e) {
          return {
            error: {
              status: 'CUSTOM_ERROR' as const,
              error: e instanceof Error ? e.message : String(e),
            },
          }
        }
      },
      invalidatesTags: (_result, _err, { parentId }) => [{ type: 'Node', id: `LIST:${parentId}` }],
    }),

    /**
     * DELETE /api/node?id=<id> → { deleted: true, id }
     * Single-node hard delete (the backend purges a file's stored object too).
     * Recursion lives in `deleteSubtree`; this is the leaf primitive it calls.
     */
    deleteNode: builder.mutation<{ id: string }, { id: string; parentId: string }>({
      query: ({ id }) => ({
        url: `api/node?id=${encodeURIComponent(id)}`,
        method: 'DELETE',
      }),
      transformResponse: (r) => ({ id: String((r as { id?: unknown }).id ?? '') }),
      invalidatesTags: (_result, _err, { parentId }) => [{ type: 'Node', id: `LIST:${parentId}` }],
    }),

    /**
     * Recursive subtree delete — pure client orchestration, mirroring
     * `importFolder` in reverse. The server owns a single-node delete (it can't
     * fan out: `data_delete` has no bulk `in`, `file_delete` key-mode is one
     * object), so the client discovers the tree and deletes it bottom-up:
     *   1. BFS the subtree by listing `api/nodes?parentId=` per level (files
     *      simply return no children), tagging each node with its depth.
     *   2. Delete deepest-first, one depth-level at a time (bounded concurrency
     *      within a level) so a folder is only removed after its children — the
     *      server's non-empty-folder `409` guard then never trips in the happy path.
     *   3. Collect `{ id, name, error }` failures so a partial delete still
     *      reports what survived, and invalidate every touched folder listing.
     */
    deleteSubtree: builder.mutation<DeleteSubtreeResult, { rootId: string; parentId: string }>({
      async queryFn({ rootId, parentId }, queryApi, _extraOptions, baseQuery) {
        try {
          // Seed with the root. Pull its name/type from the parent's cached
          // listing when available (for nicer failure messages); fall back to id.
          const parentSel = handoffApi.endpoints.listNodes.select({ parentId })(
            queryApi.getState() as never,
          )
          const rootMeta = parentSel?.data?.find((n) => n.id === rootId)
          const subtree: SubtreeNode[] = [
            {
              id: rootId,
              name: rootMeta?.name ?? rootId,
              type: rootMeta?.type ?? 'folder',
              depth: 0,
            },
          ]

          // 1. Discover descendants level by level. Listing the children of a
          //    file/site returns [], so we can probe every node uniformly.
          let frontier: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }]
          let guard = 0
          while (frontier.length && guard++ < 64) {
            const next: { id: string; depth: number }[] = []
            await runPool(frontier, 4, async ({ id, depth }) => {
              const res = await baseQuery(`api/nodes?parentId=${encodeURIComponent(id)}`)
              if (res.error) return
              const children = toNodeList(res.data)
              for (const c of children) {
                subtree.push({ id: c.id, name: c.name, type: c.type, depth: depth + 1 })
                next.push({ id: c.id, depth: depth + 1 })
              }
            })
            frontier = next
          }

          // 2. Delete deepest-first, a whole depth-level at a time.
          const failures: DeleteSubtreeResult['failures'] = []
          let deleted = 0
          const depths = [...new Set(subtree.map((n) => n.depth))].sort((a, b) => b - a)
          for (const d of depths) {
            const level = subtree.filter((n) => n.depth === d)
            await runPool(level, 4, async (n) => {
              const res = await baseQuery({ url: `api/node?id=${encodeURIComponent(n.id)}`, method: 'DELETE' })
              if (res.error) {
                failures.push({ id: n.id, name: n.name, error: JSON.stringify(res.error) })
                return
              }
              deleted++
            })
          }

          // 3. Folder listings that changed: the parent (root removed) plus every
          //    folder in the subtree. Over-listing non-folders is a harmless no-op.
          const affectedFolderIds = [
            parentId,
            ...subtree.filter((n) => n.type === 'folder').map((n) => n.id),
          ]

          return { data: { deleted, failures, affectedFolderIds } }
        } catch (e) {
          return {
            error: {
              status: 'CUSTOM_ERROR' as const,
              error: e instanceof Error ? e.message : String(e),
            },
          }
        }
      },
      invalidatesTags: (result, _err, { parentId }) => [
        { type: 'Node', id: `LIST:${parentId}` },
        ...(result?.affectedFolderIds ?? []).map((id) => ({ type: 'Node' as const, id: `LIST:${id}` })),
      ],
    }),
  }),
})

export const {
  useListNodesQuery,
  useGetRootMetaQuery,
  useGetNodeQuery,
  useResolvePathQuery,
  useGetSignedUrlQuery,
  usePrepareUploadMutation,
  useRegisterNodeMutation,
  useUploadFileMutation,
  useUploadSiteMutation,
  useImportFolderMutation,
  useCreateFolderMutation,
  useDeleteNodeMutation,
  useDeleteSubtreeMutation,
  useGetGrantsQuery,
  useAddGrantMutation,
  useRevokeGrantMutation,
  useSetNodeModeMutation,
  useSetNodeFeedExcludedMutation,
  useUpdateNodeMetaMutation,
  useSearchDirectoryQuery,
  useMintShareLinkMutation,
  useListShareLinksQuery,
  useRevokeShareLinkMutation,
  useValidateShareLinkQuery,
  useClaimShareLinkMutation,
} = handoffApi
