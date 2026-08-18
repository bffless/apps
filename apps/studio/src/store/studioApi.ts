/**
 * RTK Query data layer for the Studio `/api/*` endpoints. Every network call the
 * producer makes goes through here so caching, in-flight state, and error
 * handling are consistent.
 *
 * - `transcribe` is a plain JSON mutation.
 * - `upload` wraps the three-step presigned flow (prepare → direct bucket PUT →
 *   register) in a custom `queryFn` by delegating to the existing, unit-tested
 *   `presignedUpload` helper — RTK Query can't model a direct-to-bucket PUT with
 *   `fetchBaseQuery`, but `queryFn` lets us run arbitrary async and still expose
 *   it as a normal mutation hook.
 */

import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query/react'
import { attemptRefresh } from '../lib/auth'
import { presignedUpload, toSignedUrl } from '../lib/upload'
import type { TranscriptWord } from './studioSlice'
import type { DirectorRequest, DirectorScene } from '../lib/director'
import type { RefineSceneRequest, RefineSceneRaw } from '../lib/refiner'
import type { SearchRequest } from '../lib/search'
import type { DescribeRequest } from '../lib/describe'
import type { BlogRequest, BlogResult } from '../lib/blog'
import type { ThumbnailDraftRequest } from '../lib/thumbnail'
import type { ProjectMeta } from '../lib/projects'
import type { ProjectRecord, ProjectRecordIn } from '../lib/projectSync'

export type UploadKind = 'source' | 'audio' | 'thumbnails' | 'export' | 'scene-clip' | 'youtube-thumbnail' | 'blog'
type TranscribeResponse = { words?: TranscriptWord[]; text?: string }
/** The master director's result blob: a logline + the raw scene breakdown. */
type ScenesResult = { synopsis?: string; scenes?: DirectorScene[] }
/** The per-scene refiner's result blob (story 03c): the refined cuts. */
type RefineSceneResult = RefineSceneRaw

export type VideoJobKind = 'video-extract' | 'video-slice' | 'video-concat'
export type VideoResult = { url: string; audioUrl?: string | null; duration?: number | null }

/**
 * Async fire-and-poll (story 03f Part 0). The director and refiner Replicate calls
 * are slow and used to time out on the synchronous response path. Now the start
 * endpoints (`/api/scenes`, `/api/refine-scene`) just ENQUEUE a job and return its
 * id immediately; the heavy Replicate call runs in the pipeline's `postSteps`, and
 * the front end polls `getStudioJob` until the row reaches a terminal status.
 */
export type StartJobResponse = { jobId: string; status: string }

/**
 * The poll endpoint's view of a job row. `result` is the model's already-COERCED
 * output blob — the very same shape the synchronous endpoints used to return — so
 * the client still runs it through `toScenes` / `toRefinement` (mock and real
 * share the shape; swap-don't-rewrite holds).
 */
export type StudioJob = {
  status: 'pending' | 'running' | 'done' | 'error'
  kind: 'scenes' | 'refine' | 'transcribe' | 'blog' | VideoJobKind
  result?: ScenesResult | RefineSceneResult | TranscribeResponse | BlogResult | VideoResult | null
  error?: string | null
  /** The stitched per-run Gemini prompt, stored on the job row at enqueue
   *  (story 03m). Null/absent on jobs older than 03m. */
  prompt?: string | null
  /** The system instruction sent with it (story 03m). */
  system?: string | null
}

/** One pure coercer for both MSW and real /api/video job results (mock-parity rule). */
export function toVideoResult(raw: unknown): VideoResult {
  const obj = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  const r = (obj ?? {}) as { url?: unknown; audioUrl?: unknown; duration?: unknown }
  if (typeof r.url !== 'string' || !r.url) throw new Error('Video job finished without an output URL.')
  return {
    url: r.url,
    audioUrl: typeof r.audioUrl === 'string' && r.audioUrl ? r.audioUrl : null,
    duration: typeof r.duration === 'number' && Number.isFinite(r.duration) ? r.duration : null,
  }
}

const rawBaseQuery = fetchBaseQuery({ baseUrl: '/', credentials: 'include' })

/**
 * On a 401 (expired SuperTokens access token) run the shared single-flight
 * refresh and retry the request once. The refresh is shared with
 * `fetchWithReauth` so the whole app issues exactly one refresh per expiry — the
 * refresh token rotates, so concurrent refreshes would race (see `attemptRefresh`).
 *
 * This is what keeps a long auto-build alive: the run outlives the access token,
 * every `/api/*` call starts answering `401 {"message":"try refresh token"}`, and
 * without this the poll loop and uploads die mid-run with that message surfaced
 * verbatim in the UI.
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

export const studioApi = createApi({
  reducerPath: 'studioApi',
  baseQuery: baseQueryWithReauth,
  endpoints: (builder) => ({
    // Transcription (story 02; async since story 10e). ENQUEUE-ONLY: returns a
    // { jobId } to poll on — WhisperX (and, when `diarize`, the slow pyannote
    // speaker pass) runs in the pipeline's postSteps so it can't hit the 30s edge
    // timeout. The flattened { words, text } lands in the job row's `result` blob.
    transcribeStart: builder.mutation<StartJobResponse, { audioUrl: string | null; diarize: boolean }>({
      query: (body) => ({
        url: 'api/transcribe',
        method: 'POST',
        body,
      }),
    }),

    // Video extraction (extract audio from a source video).
    videoExtractStart: builder.mutation<StartJobResponse, { sourceUrl: string; projectId: string; executor?: 'local' | 'remote' }>({
      query: (body) => ({ url: 'api/video/extract-audio', method: 'POST', body }),
    }),

    // Video slicing (extract spans from a source video, optionally with audio).
    videoSliceStart: builder.mutation<
      StartJobResponse,
      { sourceUrl: string; spans: { start: number; end: number }[]; wantAudio: boolean; audioFades: boolean; projectId: string; executor?: 'local' | 'remote' }
    >({
      query: (body) => ({ url: 'api/video/slice', method: 'POST', body }),
    }),

    // Video concatenation (join multiple video parts).
    videoConcatStart: builder.mutation<StartJobResponse, { parts: string[]; projectId: string; executor?: 'local' | 'remote' }>({
      query: (body) => ({ url: 'api/video/concat', method: 'POST', body }),
    }),

    // The master director (story 03, 13f contract): timestamped transcript +
    // contact-sheet images + the user's direction → synopsis + scenes (title,
    // tiled span, cutting brief, baseline cuts).
    // Now ENQUEUE-ONLY (story 03f Part 0): returns a { jobId } to poll on; the
    // Gemini call runs in the pipeline's postSteps. The director's result lands in
    // the job row's `result` blob, read via `getStudioJob`.
    scenes: builder.mutation<StartJobResponse, DirectorRequest>({
      query: (body) => ({
        url: 'api/scenes',
        method: 'POST',
        body,
      }),
    }),

    // The per-scene refiner (story 03c, 13f contract): the scene's word timings
    // + its cutting brief + dense contact sheets + measured dead space →
    // precise cuts, nothing else. Also enqueue-only (story 03f Part 0) —
    // returns a { jobId } to poll on.
    refineScene: builder.mutation<StartJobResponse, RefineSceneRequest>({
      query: (body) => ({
        url: 'api/refine-scene',
        method: 'POST',
        body,
      }),
    }),

    // Poll a job's status (story 03f Part 0). Shared by the director and refiner
    // start endpoints (discriminated by `kind`). `keepUnusedDataFor: 0` so the
    // poll never reads a stale cached `pending` — each poll hits the network and
    // the result isn't retained after the loop unsubscribes.
    getStudioJob: builder.query<StudioJob, string>({
      query: (id) => `api/studio/job?id=${encodeURIComponent(id)}`,
      keepUnusedDataFor: 0,
    }),

    // Transcript search (story 08): one text-only LLM read of the timestamped
    // transcript → spans matching the producer's query. SYNC — no images, so
    // it returns in seconds (no 03f jobs flow). The raw blob goes through
    // `toSearchHits` at the call site; results are transient UI, never
    // persisted to the slice.
    searchTranscript: builder.mutation<unknown, SearchRequest>({
      query: (body) => ({
        url: 'api/search-transcript',
        method: 'POST',
        body,
      }),
    }),

    // Export description (finished-product page): one sync text call that writes a
    // recommended title + summary from the FINAL kept script (+ the director's
    // synopsis as context). Like search, no images → returns in seconds (no jobs
    // flow). The raw blob goes through `toDescription` at the call site.
    describe: builder.mutation<unknown, DescribeRequest>({
      query: (body) => ({
        url: 'api/describe',
        method: 'POST',
        body,
      }),
    }),

    // Blog post (issue #68): a sibling of the master director — async
    // fire-and-poll. The start endpoint ENQUEUEs a `kind: 'blog'` job and returns
    // its id; the (eventual) multimodal Gemini call runs in the pipeline's
    // postSteps, and the FE polls `getStudioJob` until the row carries the
    // `{ markdown }` result (coerced through `toBlog` at the call site).
    blogStart: builder.mutation<StartJobResponse, BlogRequest>({
      query: (body) => ({
        url: 'api/blog',
        method: 'POST',
        body,
      }),
    }),

    // Thumbnail draft (story 06): one sync call to the prompt-drafting handler
    // (which loads the `image-prompts` skill) → a ready-to-paste nano-banana
    // prompt. Raw blob goes through `toThumbnailPrompt` at the call site.
    thumbnailDraft: builder.mutation<unknown, ThumbnailDraftRequest>({
      query: (body) => ({
        url: 'api/thumbnail/draft',
        method: 'POST',
        body,
      }),
    }),

    // Thumbnail render (story 06): call google/nano-banana with the (edited)
    // prompt; the pipeline stores the image to the bucket and returns a serve
    // path. Raw blob goes through `toThumbnailImage` at the call site.
    // `referenceImageUrl` is an optional `/api/uploads/...` serve path; the rule
    // turns it into nano-banana's `image_input` array (empty when absent).
    thumbnailRender: builder.mutation<
      unknown,
      { prompt: string; projectId: string; referenceImageUrl?: string }
    >({
      query: (body) => ({
        url: 'api/thumbnail/render',
        method: 'POST',
        body,
      }),
    }),

    // Sign a persisted `/api/uploads/...` serve path into a time-limited direct
    // bucket URL. The serve pipeline streams the object through the BFFless
    // backend, which 504s/OOMs on big files (the ~280 MB source video) — so every
    // read of the raw source goes through here and hits the bucket directly,
    // mirroring how uploads bypass the 1 MB body cap. Signed URLs live 1 h;
    // keep cache entries most of that so repeated reads (scene sheets, slicing,
    // the restored-session preview) reuse one URL.
    signDownload: builder.query<{ url: string }, string>({
      query: (url) => ({
        url: 'api/uploads/sign',
        method: 'POST',
        body: { url },
      }),
      transformResponse: (raw: unknown) => ({ url: toSignedUrl(raw) }),
      keepUnusedDataFor: 45 * 60,
    }),

    // Sign a persisted serve path into a direct bucket URL that FORCES a download
    // under `filename`. Separate from `signDownload` because that URL feeds
    // <video> playback and ffmpeg reads, which must not be `attachment`.
    // Needed because `<a download>` is ignored on cross-origin URLs, so the name
    // can only arrive as a Content-Disposition header signed into the URL.
    signAttachment: builder.query<{ url: string }, { url: string; filename: string }>({
      query: (body) => ({
        url: 'api/uploads/sign',
        method: 'POST',
        body,
      }),
      transformResponse: (raw: unknown) => ({ url: toSignedUrl(raw) }),
      keepUnusedDataFor: 45 * 60,
    }),

    // Delete all bucket objects for a project (story 11c): wipes
    // uploads/projects/<id>/ and returns { deleted, prefix }. Best-effort —
    // the caller removes the project from local state regardless of outcome.
    deleteProjectAssets: builder.mutation<{ deleted: number }, { projectId: string }>({
      query: (body) => ({ url: 'api/projects/delete', method: 'POST', body }),
    }),

    // List all projects (story 11d): GET /api/projects → array of metas (no data).
    // Tolerates both a bare array response and a wrapped { data: [...] } shape.
    listProjects: builder.query<ProjectMeta[], void>({
      query: () => ({ url: 'api/projects' }),
      transformResponse: (raw: unknown): ProjectMeta[] => {
        const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown })?.data) ? (raw as { data: unknown[] }).data : []
        return (arr as unknown[]).filter((r): r is ProjectMeta => !!r && typeof (r as { id?: unknown }).id === 'string')
      },
    }),

    // Get one full project record (story 11d): GET /api/projects/get?id=<id> →
    // full record with data as a parsed object (server coerces the stored JSON string).
    getProject: builder.query<ProjectRecordIn, string>({
      query: (id) => ({ url: `api/projects/get?id=${encodeURIComponent(id)}` }),
      transformResponse: (raw: unknown): ProjectRecordIn => raw as ProjectRecordIn,
    }),

    // Create a new project record (story 11d): POST /api/projects body = ProjectRecord
    // (data is a JSON string). Returns the created record.
    createProjectRecord: builder.mutation<unknown, ProjectRecord>({
      query: (record) => ({ url: 'api/projects', method: 'POST', body: record }),
    }),

    // Save (upsert) a project record (story 11d): POST /api/projects/save body =
    // ProjectRecord (data JSON string) → returns the updated record.
    saveProject: builder.mutation<unknown, ProjectRecord>({
      query: (record) => ({ url: 'api/projects/save', method: 'POST', body: record }),
    }),

    upload: builder.mutation<{ url: string }, { file: File; kind: UploadKind; projectId: string }>({
      async queryFn({ file, kind, projectId }) {
        try {
          const url = await presignedUpload(file, `/api/uploads/${kind}`, projectId)
          return { data: { url } }
        } catch (e) {
          return {
            error: {
              status: 'CUSTOM_ERROR' as const,
              error: e instanceof Error ? e.message : String(e),
            },
          }
        }
      },
    }),
  }),
})

export const {
  useTranscribeStartMutation,
  useScenesMutation,
  useRefineSceneMutation,
  useVideoExtractStartMutation,
  useVideoSliceStartMutation,
  useVideoConcatStartMutation,
  useLazyGetStudioJobQuery,
  useSignDownloadQuery,
  useLazySignDownloadQuery,
  useSignAttachmentQuery,
  useSearchTranscriptMutation,
  useDescribeMutation,
  useBlogStartMutation,
  useDeleteProjectAssetsMutation,
  useUploadMutation,
  useListProjectsQuery,
  useGetProjectQuery,
  useLazyGetProjectQuery,
  useCreateProjectRecordMutation,
  useSaveProjectMutation,
  useThumbnailDraftMutation,
  useThumbnailRenderMutation,
} = studioApi
