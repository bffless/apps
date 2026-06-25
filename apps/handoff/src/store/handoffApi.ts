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

export type { HandoffNode, PreparedUpload, RegisterBody }

export const handoffApi = createApi({
  reducerPath: 'handoffApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/', credentials: 'include' }),
  tagTypes: ['Node'],
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
  usePrepareUploadMutation,
  useRegisterNodeMutation,
  useUploadFileMutation,
} = handoffApi
