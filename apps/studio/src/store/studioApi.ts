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

export type UploadKind = 'source' | 'audio' | 'thumbnails' | 'voice' | 'export' | 'scene-clip' | 'youtube-thumbnail'
type TranscribeResponse = { words?: TranscriptWord[]; text?: string }
/** The master director's result blob: a logline + the raw scene breakdown. */
type ScenesResult = { synopsis?: string; scenes?: DirectorScene[] }
/** The per-scene refiner's result blob (story 03c): anchored segments + refined cuts. */
type RefineSceneResult = RefineSceneRaw

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
  kind: 'scenes' | 'refine' | 'transcribe' | 'blog'
  result?: ScenesResult | RefineSceneResult | TranscribeResponse | BlogResult | null
  error?: string | null
  /** The stitched per-run Gemini prompt, stored on the job row at enqueue
   *  (story 03m). Null/absent on jobs older than 03m. */
  prompt?: string | null
  /** The system instruction sent with it (story 03m). */
  system?: string | null
}
/** Voice clone (story 04): the recorded sample's URL → a reusable `voiceId`
 *  (+ a preview mp3 of the cloned voice from MiniMax). */
type VoiceCloneResponse = { voiceId: string; previewUrl?: string }
/** Voice say (TTS preview): a line spoken in the chosen voice → playable audio. */
type VoiceSayResponse = { audioUrl: string; durationSeconds?: number }
/** Scene narration (story 03c): a run of script → a PERSISTED mp3 serve path. */
type VoiceNarrateResponse = { audioUrl: string }

export const studioApi = createApi({
  reducerPath: 'studioApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/', credentials: 'include' }),
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

    // The master director (story 03): timestamped transcript + contact-sheet
    // images + the user's direction → synopsis + scenes (script, span, cuts).
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

    // The per-scene refiner (story 03c): the scene's transcript + the director's
    // first-pass script/cuts + the scene's dense contact sheets → anchored
    // segments (where the new text lands) + refined cuts. Also enqueue-only now
    // (story 03f Part 0) — returns a { jobId } to poll on.
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

    // Scene narration (story 03c): speak a run of the refined script in the saved
    // voice and PERSIST the mp3 to the bucket → a durable serve path. Distinct
    // from voiceSay (ephemeral preview); these clips are kept for the diff-viewer
    // players and the eventual ffmpeg assemble (story 05).
    narrate: builder.mutation<VoiceNarrateResponse, { text: string; voiceId: string; projectId: string }>({
      query: (body) => ({
        url: 'api/voice/narrate',
        method: 'POST',
        body,
      }),
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
    thumbnailRender: builder.mutation<unknown, { prompt: string; projectId: string }>({
      query: (body) => ({
        url: 'api/thumbnail/render',
        method: 'POST',
        body,
      }),
    }),

    // Voice clone (story 04): POST the uploaded recording's URL → a reusable
    // voiceId. The real $3 Replicate clone is DISABLED server-side for now — the
    // pipeline returns a real preset id as a stub, so the rest of the flow (and
    // the TTS preview below) works end to end without the spend.
    voiceClone: builder.mutation<VoiceCloneResponse, { sampleUrl: string }>({
      query: (body) => ({
        url: 'api/voice/clone',
        method: 'POST',
        body,
      }),
    }),

    // Voice say (TTS preview): speak a short canned line in the chosen voice
    // (minimax/speech-2.8-turbo, live + cheap) so the producer can hear it right
    // after selecting. Per-scene narration is a later (Build) story.
    voiceSay: builder.mutation<VoiceSayResponse, { text: string; voiceId: string }>({
      query: (body) => ({
        url: 'api/voice/say',
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
  useLazyGetStudioJobQuery,
  useSignDownloadQuery,
  useLazySignDownloadQuery,
  useNarrateMutation,
  useSearchTranscriptMutation,
  useDescribeMutation,
  useBlogStartMutation,
  useDeleteProjectAssetsMutation,
  useUploadMutation,
  useVoiceCloneMutation,
  useVoiceSayMutation,
  useListProjectsQuery,
  useGetProjectQuery,
  useLazyGetProjectQuery,
  useCreateProjectRecordMutation,
  useSaveProjectMutation,
  useThumbnailDraftMutation,
  useThumbnailRenderMutation,
} = studioApi
