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

/**
 * A published video's public metadata (Task 11), as `GET /api/videos`
 * shapes it — never the transcript or either storage path. `videoId` (not
 * `id`) and `youtubeId` (not `youtube_url`) intentionally diverge from
 * `VideoMeta`'s field names: this is a different, public-facing wire shape,
 * not a subset of the admin one.
 */
export type PublicVideoMeta = {
  videoId: string
  title: string
  description: string | null
  youtubeId: string
  duration: number
  publishedAtMs: number
}

/**
 * A published video's full public record (Task 11), as `GET /api/video`
 * shapes it — the transcript is already parsed JSON, ready for
 * `TranscriptView`. `youtubeId` can be `null` here (an admin could in
 * theory publish a video whose `youtube_url` stopped parsing after the
 * fact) even though `PublicVideoMeta` never carries a null one — the list
 * shape drops any row it can't extract an id from, but the single-video
 * lookup doesn't 404 over it.
 */
export type PublicVideo = {
  videoId: string
  title: string
  description: string | null
  youtubeId: string | null
  duration: number
  transcript: { words: { text: string; start: number; end: number }[] }
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

/** `POST /api/uploads/sign` response — a time-limited direct bucket URL. */
export type SignDownloadResponse = { url: string; expiresIn: number }

export type IndexStartArgs = { videoId: string }
export type IndexStartResponse = { jobId: string; status: string }

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

    // POST /api/uploads/sign { url } → { url, expiresIn } (PR-feedback-1): swap
    // a persisted `source_path`/`audio_path` serve path for a direct, time-
    // limited bucket URL so `<video>` reads the file straight from storage
    // instead of streaming it through `file_serve` (slow/OOM-prone on large
    // videos — same reasoning as Studio's `useSignedBytes`). The record stores
    // paths WITH a leading slash (e.g. `/api/uploads/videos/<id>/source/...`);
    // strip it before sending since the sign rule's `resolvePath.fn.js`
    // envelope check is on the bare `api/uploads/...` key. `keepUnusedDataFor`
    // mirrors Studio's 45min (signature lives 1h server-side).
    signDownload: builder.query<SignDownloadResponse, string>({
      query: (path) => ({
        url: 'api/uploads/sign',
        method: 'POST',
        body: { url: path.replace(/^\/+/, '') },
      }),
      keepUnusedDataFor: 45 * 60,
    }),

    // POST /api/index { videoId } → { jobId, status } (Task 8). ENQUEUE-ONLY,
    // same shape as transcribeStart: chunking/embedding runs in the pipeline's
    // postSteps so it can't hit the 30s edge timeout. The rule flips the video
    // to 'indexing' synchronously (or 400s with { error: reason } if the video
    // isn't eligible yet), then writes transcript embeddings + 'published'/
    // 'transcribed'(on failure) out-of-band — no invalidatesTags here, same
    // reasoning as transcribeStart; `useIndexJob` refetches `getAdminVideo`
    // once its poll reaches a terminal stage.
    indexStart: builder.mutation<IndexStartResponse, IndexStartArgs>({
      query: (body) => ({ url: 'api/index', method: 'POST', body }),
    }),

    // POST /api/unpublish { videoId } → { ok }. All-sync (Task 8): deletes the
    // video's transcript embeddings and flips status back to 'transcribed' in
    // the SAME request, so — unlike indexStart — it's safe to invalidate the
    // video tag immediately.
    unpublish: builder.mutation<{ ok: boolean }, { videoId: string }>({
      query: (body) => ({ url: 'api/unpublish', method: 'POST', body }),
      invalidatesTags: (_result, _error, arg) => [
        { type: 'Videos', id: arg.videoId },
        { type: 'Videos', id: 'LIST' },
      ],
    }),

    // GET /api/videos → { videos: PublicVideoMeta[] } — PUBLIC (Task 11):
    // every published video, newest-first, for the home page library grid.
    // No reauth surprises expected (public route), but this still goes
    // through `recallApi`'s shared base query like every other endpoint.
    listPublicVideos: builder.query<{ videos: PublicVideoMeta[] }, void>({
      query: () => 'api/videos',
      providesTags: (result) =>
        result
          ? [
              ...result.videos.map((v) => ({ type: 'Videos' as const, id: v.videoId })),
              { type: 'Videos' as const, id: 'PUBLIC_LIST' },
            ]
          : [{ type: 'Videos' as const, id: 'PUBLIC_LIST' }],
    }),

    // GET /api/video?videoId=<id> → { video: PublicVideo } — PUBLIC
    // (Task 11): the video/transcript page's data source. 404s (surfaced as
    // RTK's usual `isError`/`error.status === 404`) for an unknown id or a
    // non-published video.
    getPublicVideo: builder.query<{ video: PublicVideo }, string>({
      query: (videoId) => `api/video?videoId=${encodeURIComponent(videoId)}`,
      providesTags: (_result, _error, videoId) => [{ type: 'Videos', id: videoId }],
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
  useLazySignDownloadQuery,
  useIndexStartMutation,
  useUnpublishMutation,
  useListPublicVideosQuery,
  useGetPublicVideoQuery,
} = videosApi
