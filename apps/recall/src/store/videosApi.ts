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

// A genuine partial PATCH (Task 6): every field but `videoId` is optional and
// an omitted one is left untouched server-side (see the save rule's `pick`
// step). The title-edit form still sends all three text fields on every save;
// `useIngest` sends only `source_path` or `audio_path` as each upload lands.
export type SaveVideoArgs = {
  videoId: string
  title?: string
  description?: string
  youtube_url?: string
  source_path?: string
  audio_path?: string
}

/** A `recall_jobs` row as the ingest poll loop sees it (Task 6). */
export type Job = {
  status: 'pending' | 'running' | 'done' | 'error' | string
  kind: string
  result: { words?: { text: string; start: number | null; end: number | null }[]; text?: string } | null
  error: string | null
}

export type TranscribeStartArgs = { videoId: string; audioPath: string; durationSec: number }
export type TranscribeStartResponse = { jobId: string; status: string }

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

    // POST /api/transcribe { videoId, audioPath, durationSec } → { jobId, status }.
    // ENQUEUE-ONLY (Task 6, mirrors Studio's transcribeStart): the WhisperX call
    // runs in the pipeline's postSteps so it can't hit the 30s edge timeout. The
    // rule itself flips the video record to 'transcribing' synchronously, then
    // writes the transcript + 'transcribed'/'error' status once the job settles —
    // outside this request/response cycle, so there's no result here to tag;
    // `AdminVideo`'s `IngestPanel` explicitly `refetch()`s `getAdminVideo` once
    // `useIngest`'s poll reaches a terminal stage, since RTK has no way to know
    // the pipeline wrote to a DIFFERENT record out-of-band.
    transcribeStart: builder.mutation<TranscribeStartResponse, TranscribeStartArgs>({
      query: (body) => ({ url: 'api/transcribe', method: 'POST', body }),
    }),

    // GET /api/recall/job?id=<jobId> → Job. Polled by `useIngest` every 2s.
    // `keepUnusedDataFor: 0` so a poll never reads a stale cached 'pending' —
    // each call hits the network and nothing lingers after the loop stops.
    getJob: builder.query<Job, string>({
      query: (jobId) => `api/recall/job?id=${encodeURIComponent(jobId)}`,
      keepUnusedDataFor: 0,
    }),
  }),
})

export const {
  useListAdminVideosQuery,
  useGetAdminVideoQuery,
  useCreateVideoMutation,
  useSaveVideoMutation,
  useDeleteVideoMutation,
  useTranscribeStartMutation,
  useLazyGetJobQuery,
} = videosApi
