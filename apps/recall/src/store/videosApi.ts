/**
 * RTK Query endpoints for the admin video CRUD surface (Task 5). Injected onto
 * the shared `recallApi` base query so the reauth wrapper and store wiring stay
 * centralized in `recallApi.ts`.
 *
 * Field names mirror the `recall_videos` pipeline schema as-is (snake_case) —
 * unlike Studio's project records, a video has no separate client-generated id:
 * `id` (aka `videoId` elsewhere in the app, e.g. the `videos/<id>/` upload
 * prefix) is the row's own system id, only known after `createVideo` returns
 * it. See `.bffless/proxy-rules/recall/rules/api/videos/` for the backing rules.
 */

import { recallApi } from './recallApi'

/** A video row without `transcript` — what the admin list table needs. */
export type VideoMeta = {
  id: string
  title: string
  description: string | null
  youtube_url: string | null
  status: string
  duration: number
  source_path: string | null
  audio_path: string | null
  created_ms: number
  updated_ms: number
}

/** The full video row, including `transcript` — what the detail page needs. */
export type Video = VideoMeta & {
  transcript: string | null
}

export type SaveVideoArgs = {
  videoId: string
  title: string
  description: string
  youtube_url: string
}

export const videosApi = recallApi.injectEndpoints({
  endpoints: (builder) => ({
    // GET /api/admin/videos → { videos: VideoMeta[] } — every status, transcript
    // dropped (Task 5).
    listAdminVideos: builder.query<{ videos: VideoMeta[] }, void>({
      query: () => 'api/admin/videos',
      providesTags: (result) =>
        result
          ? [
              ...result.videos.map((v) => ({ type: 'Videos' as const, id: v.id })),
              { type: 'Videos' as const, id: 'LIST' },
            ]
          : [{ type: 'Videos' as const, id: 'LIST' }],
    }),

    // GET /api/videos/get?videoId=<id> → { video: Video } — full record incl.
    // transcript (Task 5, custom pathPattern rule).
    getAdminVideo: builder.query<{ video: Video }, string>({
      query: (videoId) => `api/videos/get?videoId=${encodeURIComponent(videoId)}`,
      providesTags: (_result, _error, videoId) => [{ type: 'Videos', id: videoId }],
    }),

    // POST /api/videos { title, createdMs } → { video: VideoMeta } — creates a
    // 'draft' row and returns its (server-assigned) id.
    createVideo: builder.mutation<{ video: VideoMeta }, { title: string }>({
      query: ({ title }) => ({
        url: 'api/videos',
        method: 'POST',
        body: { title, createdMs: Date.now() },
      }),
      invalidatesTags: [{ type: 'Videos', id: 'LIST' }],
    }),

    // POST /api/videos/save { videoId, title, description, youtube_url } →
    // { video: Video }. Updates an existing row; 404s if the row is gone.
    saveVideo: builder.mutation<{ video: Video }, SaveVideoArgs>({
      query: (body) => ({ url: 'api/videos/save', method: 'POST', body }),
      invalidatesTags: (_result, _error, arg) => [
        { type: 'Videos', id: arg.videoId },
        { type: 'Videos', id: 'LIST' },
      ],
    }),

    // POST /api/videos/delete { videoId } → { ok, deleted, prefix, recordsDeleted }.
    // Wipes the videos/<id>/ bucket prefix and the record.
    deleteVideo: builder.mutation<{ ok: boolean }, { videoId: string }>({
      query: (body) => ({ url: 'api/videos/delete', method: 'POST', body }),
      invalidatesTags: (_result, _error, arg) => [
        { type: 'Videos', id: arg.videoId },
        { type: 'Videos', id: 'LIST' },
      ],
    }),
  }),
})

export const {
  useListAdminVideosQuery,
  useGetAdminVideoQuery,
  useCreateVideoMutation,
  useSaveVideoMutation,
  useDeleteVideoMutation,
} = videosApi
