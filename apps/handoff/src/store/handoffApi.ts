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
import { toNode, toNodeList, buildRegisterBody } from '../lib/nodes'
import type { HandoffNode, PreparedUpload, RegisterBody } from '../lib/nodes'
import { toSignedUrl } from '../lib/sign'
import { planSiteUpload } from '../lib/site'
import { planFolderImport } from '../lib/folderImport'
import type { Grant } from '../lib/acl'

export type { HandoffNode, PreparedUpload, RegisterBody, Grant }

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

export const handoffApi = createApi({
  reducerPath: 'handoffApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/', credentials: 'include' }),
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
     * POST /api/uploads/prepare → PreparedUpload
     * Mints a presigned PUT URL; the caller PUTs bytes directly to the bucket.
     */
    prepareUpload: builder.mutation<PreparedUpload, { filename: string; contentType?: string }>({
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
     * Multi-file presigned-upload flow for a site bundle:
     *   1. For each item: POST /api/uploads/prepare, PUT bytes, collect publicPath
     *   2. POST /api/sites with { parentId, name, entry, manifest, createdMs }
     *   3. Return the registered site node; invalidate the parent's node list.
     *
     * `manifest` maps relPath → publicPath (served URL for each file).
     */
    uploadSite: builder.mutation<
      HandoffNode,
      { items: { relPath: string; file: File }[]; entry: string; name: string; parentId: string }
    >({
      async queryFn({ items, entry, name, parentId }, _queryApi, _extraOptions, baseQuery) {
        try {
          const manifest: Record<string, string> = {}

          for (const { relPath, file } of items) {
            // 1a. Prepare presigned PUT URL
            const prepRes = await baseQuery({
              url: 'api/uploads/prepare',
              method: 'POST',
              body: {
                filename: relPath.split('/').pop() ?? file.name,
                contentType: file.type || 'application/octet-stream',
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

            manifest[relPath] = prepared.publicPath
          }

          // 2. Register site node
          const siteRes = await baseQuery({
            url: 'api/sites',
            method: 'POST',
            body: { parentId, name, entry, manifest, createdMs: Date.now() },
          })
          if (siteRes.error) return { error: siteRes.error }
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
     *      into its owning folder, with a bounded concurrency pool.
     *
     * A folder-creation failure aborts (children would be orphaned). File
     * failures are collected into `failures` so a partial import still reports
     * what landed and what didn't — never a silent no-op.
     */
    importFolder: builder.mutation<
      ImportFolderResult,
      { items: { relPath: string; file: File }[]; parentId: string }
    >({
      async queryFn({ items, parentId }, _queryApi, _extraOptions, baseQuery) {
        try {
          // Normalise once (carries the File through) so file lookup uses the
          // same paths planFolderImport derives its dirs/files from.
          const fileByPath = new Map(planSiteUpload(items).files.map((it) => [it.relPath, it.file]))
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
            const file = fileByPath.get(f.relPath)
            if (!file) {
              failures.push({ relPath: f.relPath, error: 'File data missing for path.' })
              return
            }
            const targetId = dirToId[f.dir] ?? parentId
            try {
              const prepRes = await baseQuery({
                url: 'api/uploads/prepare',
                method: 'POST',
                body: { filename: f.name, contentType: file.type || 'application/octet-stream' },
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
    uploadFile: builder.mutation<HandoffNode, { file: File; parentId: string }>({
      async queryFn({ file, parentId }, _queryApi, _extraOptions, baseQuery) {
        try {
          // 1. Prepare — mint a presigned bucket PUT URL
          const prepRes = await baseQuery({
            url: 'api/uploads/prepare',
            method: 'POST',
            body: { filename: file.name, contentType: file.type || 'application/octet-stream' },
          })
          if (prepRes.error) return { error: prepRes.error }
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
          if (regRes.error) return { error: regRes.error }
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
  }),
})

export const {
  useListNodesQuery,
  useGetNodeQuery,
  useGetSignedUrlQuery,
  usePrepareUploadMutation,
  useRegisterNodeMutation,
  useUploadFileMutation,
  useUploadSiteMutation,
  useImportFolderMutation,
  useCreateFolderMutation,
  useGetGrantsQuery,
  useAddGrantMutation,
  useRevokeGrantMutation,
  useSearchDirectoryQuery,
  useMintShareLinkMutation,
  useListShareLinksQuery,
  useRevokeShareLinkMutation,
  useValidateShareLinkQuery,
  useClaimShareLinkMutation,
} = handoffApi
