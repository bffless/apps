import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { STAGE_DEFS, PER_VIDEO_STAGES, GLOBAL_STAGES, type Stage, type StageId } from '../../lib/pipeline'
import { type Cut, type Scene } from '../../lib/scenes'
import { combinedTimedTranscript, toScenes, type DirectorScene } from '../../lib/director'
import { buildDescribeRequest, sceneWordsLookup, toDescription, videoScript } from '../../lib/describe'
import {
  buildBlogRequest,
  toBlog,
  isBlogStale,
  planBlogCaptures,
  rewriteFrameTokens,
  blogImageRefs,
  planBlogSiblings,
  blogReframeFileName,
  type BlogImageRef,
} from '../../lib/blog'
import { buildThumbnailDraftRequest, toThumbnailPrompt, toThumbnailImage } from '../../lib/thumbnail'
import {
  toRefinement,
  refineDirections,
  sceneWordTimings,
  sceneDeadSpace,
  deadSpaceLines,
  sceneTail,
  addCut,
  addCuts,
  removeCut,
  effectiveCuts,
  type RefineSceneRaw,
} from '../../lib/refiner'
import { planScene } from '../../lib/export/assemble'
import { totalDuration, sourceForScene, globalToLocal } from '../../lib/sources'
import { deadSpaceFromUrl, extractAudio, sliceAudioWav } from '../../lib/audio'
import { createBlobCache } from '../../lib/blobCache'
import { fetchWithReauth } from '../../lib/auth'
import { presignedUpload } from '../../lib/upload'
import { STALE_RENDER_PATCH } from '../../lib/autoBuild'
import { createSemaphore } from '../../lib/semaphore'
import { buildSliceCommand } from '../../lib/export/slice'
import { slice as ffmpegSlice, sliceSourcePath } from '../../lib/export/ffmpeg'
import {
  captureFramesAt,
  captureSceneContactSheet,
  composeContactSheet,
  CONTACT_SHEET_CELL,
  CONTACT_SHEET_SUPERSAMPLE,
  type ContactSheet,
} from '../../lib/frames'
import { chunk, cellsPerSheet } from '../../lib/contactSheet'
import { planGlobalSheetCaptures } from '../../lib/globalSheet'
import { useAppDispatch, useAppSelector } from '../../store/hooks'
import {
  studioApi,
  useTranscribeStartMutation,
  useScenesMutation,
  useRefineSceneMutation,
  useDescribeMutation,
  useBlogStartMutation,
  useThumbnailDraftMutation,
  useThumbnailRenderMutation,
  useUploadMutation,
  useLazySignDownloadQuery,
  useVideoSliceStartMutation,
  useVideoConcatStartMutation,
  toVideoResult,
  type UploadKind,
  type VideoJobKind,
} from '../../store/studioApi'
import { getVideoBackend } from '../../lib/videoBackend'
import {
  patchStage,
  failActiveStage,
  setScenes,
  patchScene as patchSceneAction,
  setSourceUrl,
  setAudioUrl,
  setAudioPeaks,
  setDeadSpace,
  setContactSheets,
  setWords,
  setSynopsis,
  setScenesJobId,
  setDirectorPromptJobId,
  setSelected,
  setFinalCutUrl,
  setDescription,
  setDescriptionTitle,
  setBlogRunning,
  setBlogResult,
  reframeBlogImage as reframeBlogImageAction,
  setBlogError,
  setYoutubeThumbnail,
  setDuration,
  setFileName,
  addSource,
  patchSource,
  patchSourceStage,
  resetProject,
  selectActive,
  selectActiveProjectId,
  type TranscriptWord,
} from '../../store/studioSlice'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`

// Async fire-and-poll tuning (story 03f Part 0). The director/refiner jobs run
// off the response path now, so we poll a status endpoint until the row is done.
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 5 * 60 * 1000 // give up on a wedged job rather than poll forever
// Server-side ffmpeg jobs (slice/concat/extract) can legitimately run long on a
// big source. CE's ffmpeg_handler has its own FFMPEG_MAX_SECONDS (1800s) watchdog,
// so this just needs to outlast that — the server, not the client, decides wedged.
const VIDEO_POLL_TIMEOUT_MS = 35 * 60 * 1000

/**
 * Job ids currently being polled, shared across hook instances (same rationale as
 * `stepInFlight`). Both the live action AND the resume-on-mount effect can race to
 * poll the same job — and React StrictMode double-invokes effects in dev — so this
 * module-level guard ensures exactly one poll loop per job id.
 */
const pollsInFlight = new Set<string>()

/**
 * Audio URLs currently being measured for dead space (story 13c backfill).
 * Module-level for the same StrictMode reason as `pollsInFlight`: two hook
 * instances briefly coexist in dev, and the backfill fetches the whole WAV —
 * this keeps it to one fetch per URL.
 */
const deadSpaceBackfillsInFlight = new Set<string>()

/** Measure a video clip's real length by loading just its metadata off an object
 *  URL — mirrors `measureAudioDuration` but for <video>. Resolves 0 on error. */
function measureVideoDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    const done = (v: number) => resolve(Number.isFinite(v) && v > 0 ? v : 0)
    video.addEventListener('loadedmetadata', () => done(video.duration))
    video.addEventListener('error', () => done(0))
    video.src = url
  })
}

/**
 * Module-level in-flight guard for the prep step runner. Deliberately NOT a
 * per-instance `useRef`: in React StrictMode (dev) the tree mounts twice, so two
 * hook instances briefly coexist, each with its own ref — letting a step fire on
 * both and double-hit a paid `/api/*` call (e.g. two `/api/transcribe`). A shared
 * module flag flips synchronously before any work, so the second caller bails
 * regardless of which instance it came from. Same singleton pattern as
 * `useSession.ts`'s `inFlight` dedupe.
 */
let stepInFlight = false

/**
 * One upload at a time across every concurrent build step — parallel uploads
 * trip the dev proxy's keep-alive sockets (the 502 lesson `sliceScene` and
 * `processAll` already encode). Module-level so all hook instances share it.
 */
const uploadSlot = createSemaphore(1)

/**
 * Turn whatever a failed step threw into a readable message. RTK Query's
 * `unwrap()` rejects with a *serialized* error object (`{ status, error }` or
 * `{ status, data }`), not an `Error` — so `String(e)` would give the useless
 * "[object Object]". Pull the real message out of those shapes.
 */
function stageError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>
    if (typeof o.error === 'string') return o.error // FETCH_ERROR / our queryFn CUSTOM_ERROR
    if (typeof o.message === 'string') return o.message
    if (typeof o.data === 'string') return o.data
    const data = o.data as { message?: unknown } | undefined
    if (data && typeof data.message === 'string') return data.message
    if ('status' in o) return `Request failed (${String(o.status)})`
  }
  return 'Unknown error'
}

/** Re-exported so the auto-build orchestrator surfaces the same readable error. */
export const autoBuildError = stageError

export type { TranscriptWord }

/** What each step needs: the source file, its object URL, and its duration.
 *  (The director's free-text direction now comes from the persisted slice —
 *  story 03l — not the step context.) */
export type StepContext = { file: File; src: string; duration: number }

/**
 * Owns the one-time prep pipeline and the scene queue you build afterwards.
 *
 * Business state (stages, scenes, transcript, bucket serve URLs, contact sheets,
 * selection) lives in the persisted Redux `studio` slice, so a hard reload
 * resumes where you left off. Only transient UI flags (`running`)
 * are local React state — losing those on reload is fine. Network calls go
 * through RTK Query (`/store/studioApi`).
 *
 * Prep runs **step by step** — the user triggers each step deliberately via
 * `next(ctx)`, which advances `currentStageId`. Swap a mocked step for its real
 * `/api/*` call here without touching the UI.
 */
export function useScenePipeline() {
  const dispatch = useAppDispatch()
  // The board is the static step content (STAGE_DEFS) recombined with the only
  // persisted, dynamic part — per-step progress. Keeping just the progress in
  // state means editing STAGE_DEFS reshapes the board on the next load, no
  // migration needed (see studioSlice `StageProgress`).
  const stageProgress = useAppSelector((s) => selectActive(s).stageProgress)
  const stages = useMemo<Stage[]>(
    () =>
      STAGE_DEFS.map((def) => ({
        ...def,
        status: stageProgress[def.id]?.status ?? 'pending',
        detail: stageProgress[def.id]?.detail,
      })),
    [stageProgress],
  )
  const scenes = useAppSelector((s) => selectActive(s).scenes)
  const sourceUrl = useAppSelector((s) => selectActive(s).sourceUrl)
  const audioUrl = useAppSelector((s) => selectActive(s).audioUrl)
  const audioPeaks = useAppSelector((s) => selectActive(s).audioPeaks)
  // `?? null` folds pre-13c persisted states (rehydrated without the key) into
  // the explicit "not measured" value.
  const deadSpace = useAppSelector((s) => selectActive(s).deadSpace ?? null)
  const persistedSheets = useAppSelector((s) => selectActive(s).contactSheets)
  const words = useAppSelector((s) => selectActive(s).words)
  const synopsis = useAppSelector((s) => selectActive(s).synopsis)
  const description = useAppSelector((s) => selectActive(s).description)
  const youtubeThumbnail = useAppSelector((s) => selectActive(s).youtubeThumbnail)
  const blog = useAppSelector((s) => selectActive(s).blog)
  const direction = useAppSelector((s) => selectActive(s).direction)
  const directorPromptJobId = useAppSelector((s) => selectActive(s).directorPromptJobId)
  const scenesJobId = useAppSelector((s) => selectActive(s).scenesJobId)
  const diarize = useAppSelector((s) => selectActive(s).diarize)
  const selectedId = useAppSelector((s) => selectActive(s).selectedId)
  const finalCutUrl = useAppSelector((s) => selectActive(s).finalCutUrl)
  const sources = useAppSelector((s) => selectActive(s).sources)
  // 09a bridge: until a later story makes every read per-source, the "current"
  // source is the first (single-video projects have exactly one). The prep steps
  // dual-write here so sources[0] tracks the legacy fields.
  const currentSource = sources[0] ?? null

  const activeProjectId = useAppSelector(selectActiveProjectId)

  const [transcribeStartReq] = useTranscribeStartMutation()
  const [videoSliceStartReq] = useVideoSliceStartMutation()
  const [videoConcatStartReq] = useVideoConcatStartMutation()
  const [scenesReq] = useScenesMutation()
  const [refineSceneReq] = useRefineSceneMutation()
  const [describeReq] = useDescribeMutation()
  const [blogStartReq] = useBlogStartMutation()
  const [thumbnailDraftReq] = useThumbnailDraftMutation()
  const [thumbnailRenderReq] = useThumbnailRenderMutation()
  const [uploadReqRaw] = useUploadMutation()
  const [signReq] = useLazySignDownloadQuery()

  const uploadReq = useCallback(
    (a: { file: File; kind: UploadKind }) => uploadReqRaw({ ...a, projectId: activeProjectId ?? '' }),
    [uploadReqRaw, activeProjectId],
  )

  // Sign any bucket serve path into a time-limited direct GCS URL (big media must
  // never stream through file_serve). Per-scene callers pass THAT scene's source URL.
  const signFor = useCallback(
    async (url: string) => {
      const { url: signed } = await signReq(url, true).unwrap()
      return signed
    },
    [signReq],
  )

  // Session-scoped media caches, keyed by the PERSISTED serve path (stable across
  // signings — `signFor` only mints the time-limited URL). Before these, every
  // per-scene Build step pulled the whole recording back from the bucket — the
  // cut, then the dense sheets, ~2 full downloads of an hour-long source per
  // scene — and each scene's soundtrack re-fetched the whole-clip WAV. Now each
  // source and each WAV downloads once per session, shared by every scene (and
  // the blog frame captures). Blobs are disk-backed by the browser, so a multi-GB
  // source costs blob storage, not JS heap — the same property the slice mount
  // relies on. A replaced source gets a new serve path, so it can never hit a
  // stale entry.
  const sourceBlobs = useMemo(
    () =>
      createBlobCache(async (url) => {
        // Direct bucket read — no `credentials`, it's a presigned URL, and
        // sending cookies cross-origin would fail the CORS check. `.blob()`, NOT
        // `.arrayBuffer()`: a Blob can be disk-backed, while an ArrayBuffer must
        // be one contiguous allocation (a 1.37 GB source died that way in
        // Firefox while a 739 MB one was fine).
        const res = await fetch(await signFor(url))
        if (!res.ok) throw new Error(`Couldn't load source video (${res.status})`)
        return res.blob()
      }),
    [signFor],
  )
  const audioBlobs = useMemo(
    () =>
      createBlobCache(async (url) => {
        // The whole-clip WAV serves same-origin, so it needs the session cookie
        // (and the mid-build token refresh) — unlike the signed source reads.
        const res = await fetchWithReauth(url)
        if (!res.ok) throw new Error(`Couldn't load audio (${res.status})`)
        return res.blob()
      }),
    [],
  )

  // Transient UI state — not persisted.
  const [running, setRunning] = useState(false)
  // The export step (story 05): true while the assembled MP4 is uploading to the
  // bucket. The finished blob lives transiently in the AssembleBar (which also
  // owns the save error); only the saved serve URL (finalCutUrl) is persisted.
  const [savingFinalCut, setSavingFinalCut] = useState(false)
  const [describing, setDescribing] = useState(false)
  const [draftingThumbnail, setDraftingThumbnail] = useState(false)
  const [renderingThumbnail, setRenderingThumbnail] = useState(false)
  // The scene whose assembled cut is currently uploading to the bucket (story 03g
  // phase 2 — per-scene assemble & save). Transient.
  const [savingSceneCutId, setSavingSceneCutId] = useState<string | null>(null)
  // Per-scene busy sets (story 03u): auto build runs steps on DIFFERENT scenes
  // concurrently, so "busy" is per scene now. Guards stay belt-and-braces — the
  // scheduler already never double-fires a scene/lane.
  const [sheetingIds, setSheetingIds] = useState<ReadonlySet<string>>(new Set())
  const [refiningIds, setRefiningIds] = useState<ReadonlySet<string>>(new Set())
  const [slicingIds, setSlicingIds] = useState<ReadonlySet<string>>(new Set())
  // Last error per scene, plus the legacy "most recent" scalar the manual
  // editor still shows. The orchestrator reads the per-scene map, so one
  // scene's stale error can never halt another scene's attempt.
  const [sceneErrors, setSceneErrors] = useState<Record<string, string>>({})
  const [sceneError, setSceneError] = useState<string | null>(null)

  const toggleId = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }
  const setSceneErrorFor = useCallback((id: string, msg: string | null) => {
    setSceneErrors((prev) => {
      const next = { ...prev }
      if (msg) next[id] = msg
      else delete next[id]
      return next
    })
    setSceneError(msg)
  }, [])
  // Per-source processing (story 09b): which source id is currently running its
  // upload → extract → transcribe pipeline. Transient — fine to lose on reload.
  const [processingId, setProcessingId] = useState<string | null>(null)
  // The just-captured contact sheets, shown immediately while they upload. They
  // carry the heavy base64 `dataUrl`, so they live here (transient) and NEVER in
  // Redux/localStorage — only the uploaded sheets (bucket URL, empty dataUrl) are
  // committed to the persisted slice.
  const [pendingSheets, setPendingSheets] = useState<ContactSheet[]>([])

  // Once uploaded, the persisted bucket-URL sheets win; until then show the
  // local previews. Never both — the upload swap clears the pending set.
  const contactSheets = persistedSheets.length ? persistedSheets : pendingSheets

  const patch = useCallback(
    (id: StageId, p: Parameters<typeof patchStage>[0]['patch']) =>
      dispatch(patchStage({ id, patch: p })),
    [dispatch],
  )

  const patchScene = useCallback(
    (id: string, p: Partial<Scene>) => dispatch(patchSceneAction({ id, patch: p })),
    [dispatch],
  )

  // Patch a scene through here for any edit that changes its **assemble inputs** —
  // the cuts, the narration segments' audio, or the cut clip itself. Stamping
  // `STALE_RENDER_PATCH` drops the now-stale saved render so the export gate and
  // auto-build re-render it before the final stitch (which is a blind concat of
  // saved clips); see that constant for the full rationale. Clears ONLY the
  // rendered bytes — the director baseline and `refined` script are untouched.
  const patchSceneEdit = useCallback(
    (id: string, p: Partial<Scene>) => patchScene(id, { ...p, ...STALE_RENDER_PATCH }),
    [patchScene],
  )

  const reset = useCallback(() => {
    setPendingSheets([])
    dispatch(resetProject())
  }, [dispatch])

  // Prep is "done" when EVERY source has finished its per-video stages AND the
  // global stages (thumbnails/director/clone) are done (story 09c). The per-video
  // stages are tracked per source now, not in the top-level stageProgress.
  const sourcesReady = useMemo(
    () =>
      sources.length > 0 &&
      sources.every((s) => PER_VIDEO_STAGES.every((id) => s.stageProgress[id]?.status === 'done')),
    [sources],
  )

  // The next GLOBAL step to run (thumbnails → clone → director), shown on the prep
  // board. Null while sources are still being prepped (the per-video stages live in
  // the queue, not the board) or once every global stage is done.
  const currentStageId = useMemo<StageId | null>(() => {
    if (!sourcesReady) return null
    return GLOBAL_STAGES.find((id) => (stageProgress[id]?.status ?? 'pending') !== 'done') ?? null
  }, [sourcesReady, stageProgress])

  // ---- Async fire-and-poll (story 03f Part 0) -------------------------------

  /**
   * Poll a studio job until it reaches a terminal status. The director/refiner
   * Replicate calls run off the response path now (in the pipeline's postSteps),
   * so the start endpoint just hands back a job id and we poll `getStudioJob`
   * here: `done` → return the `result` blob; `error` → throw the job's message;
   * otherwise sleep and re-poll, giving up after `POLL_TIMEOUT_MS` so a wedged
   * job surfaces as an error instead of polling forever. Each poll uses
   * `initiate(..., { forceRefetch: true, subscribe: false })` so it always hits
   * the network (never a stale cached `pending`) and leaves no cache subscription.
   */
  const pollJob = useCallback(
    async (
      jobId: string,
      opts?: { timeoutMs?: number },
    ): Promise<{ kind: 'scenes' | 'refine' | 'transcribe' | 'blog' | VideoJobKind; result: unknown }> => {
      const deadline = Date.now() + (opts?.timeoutMs ?? POLL_TIMEOUT_MS)
      for (;;) {
        const job = await dispatch(
          studioApi.endpoints.getStudioJob.initiate(jobId, { forceRefetch: true, subscribe: false }),
        ).unwrap()
        if (job.status === 'done') return { kind: job.kind, result: job.result ?? null }
        if (job.status === 'error') throw new Error(job.error || 'The job failed.')
        if (Date.now() > deadline) throw new Error('Timed out waiting for the job to finish.')
        await delay(POLL_INTERVAL_MS)
      }
    },
    [dispatch],
  )

  /**
   * Drive a master-director job to completion, then commit it — shared by the
   * live action (`runDirector`) and resume-on-reload. `videoSrc` is the in-memory
   * object URL when we have it (live) or the persisted source serve URL (resume);
   * the per-scene card thumbs are captured off it best-effort, so a cold reload
   * with no seekable source still commits the scenes (just without card art).
   * The `pollsInFlight` guard makes the live path and the resume effect idempotent.
   */
  const completeDirectorJob = useCallback(
    async (jobId: string, videoSrc: string | null) => {
      if (pollsInFlight.has(jobId)) return
      pollsInFlight.add(jobId)
      setRunning(true)
      patch('director', { status: 'active' })
      try {
        const { result } = await pollJob(jobId)
        const data = (result ?? {}) as { synopsis?: string; scenes?: DirectorScene[] }
        // Pass each source's words so the scene transcripts derive locally — the
        // 13f director contract no longer echoes the spoken words back.
        const built = toScenes(data.scenes ?? [], sources.map((s) => ({ id: s.id, duration: s.duration, words: s.words })))
        dispatch(setSynopsis(data.synopsis ?? null))

        // Commit the scene queue FIRST — card art is cosmetic and must never
        // gate the commit. (A stalled thumb capture once hung right here after
        // the job row was already done, freezing prep until a reload.)
        dispatch(setScenes(built))
        dispatch(setSelected(built[0]?.id ?? null))

        const cutCount = built.reduce((n, s) => n + (s.cuts?.length ?? 0), 0)
        patch('director', {
          status: 'done',
          detail: `${built.length} scene${built.length === 1 ? '' : 's'} · ${cutCount} cut${cutCount === 1 ? '' : 's'} · briefs ready`,
        })
        // Remember the job row so the prompt disclosure can fetch what was sent
        // to Gemini (story 03m). Separate from the in-flight id cleared below.
        dispatch(setDirectorPromptJobId(jobId))
        dispatch(setScenesJobId(null))

        // Scene-card art, best-effort and AFTER the commit: one midpoint frame
        // per scene if we can seek the source, patched onto each scene once
        // captured. captureFramesAt never hangs (stall watchdog) and never
        // rejects, but stay defensive — a failed capture just means no art.
        if (videoSrc && built.length) {
          try {
            const thumbs = await captureFramesAt(videoSrc, built.map((s) => (s.start + s.end) / 2), 64)
            built.forEach((s, i) => {
              if (thumbs[i]) patchScene(s.id, { thumb: thumbs[i] })
            })
          } catch {
            // card art is optional
          }
        }
      } catch (e) {
        // Terminal: drop the persisted job id (so we don't resume a dead job) and
        // surface the failure on the director stage's existing error UI.
        dispatch(setScenesJobId(null))
        patch('director', { status: 'error', detail: stageError(e) })
      } finally {
        pollsInFlight.delete(jobId)
        setRunning(false)
      }
    },
    [pollJob, dispatch, patch, patchScene, sources],
  )

  /**
   * Drive a per-scene refiner job to completion and write its cuts into
   * `scene.refined` (non-destructive). Shared by the live `refineScene` and
   * resume-on-reload; `pollsInFlight` keeps the two from double-polling one job.
   * Clears the scene's `refineJobId` on any terminal status.
   */
  const completeRefineJob = useCallback(
    async (sceneId: string, jobId: string) => {
      if (pollsInFlight.has(jobId)) return
      pollsInFlight.add(jobId)
      setRefiningIds((s) => toggleId(s, sceneId, true))
      setSceneErrorFor(sceneId, null)
      try {
        const { result } = await pollJob(jobId)
        const scene = scenes.find((s) => s.id === sceneId)
        if (!scene) {
          patchScene(sceneId, { refineJobId: null })
          return
        }
        patchSceneEdit(sceneId, {
          refined: toRefinement(result as RefineSceneRaw, scene),
          refineJobId: null,
          promptJobId: jobId,
        })
      } catch (e) {
        setSceneErrorFor(sceneId, stageError(e))
        patchScene(sceneId, { refineJobId: null })
      } finally {
        pollsInFlight.delete(jobId)
        setRefiningIds((s) => toggleId(s, sceneId, false))
      }
    },
    [pollJob, scenes, patchScene, patchSceneEdit, setSceneErrorFor],
  )

  /**
   * Drive a per-source transcribe job to completion and write its words onto the
   * source (story 10e). Shared by the live `processSource`/`transcribe` path and
   * resume-on-reload; `pollsInFlight` keeps the two from double-polling. Dual-writes
   * the legacy top-level `words`/board stage when this is the primary source (the
   * 09a bridge). Clears the source's `transcribeJobId` on any terminal status.
   */
  const completeTranscribeJob = useCallback(
    async (sourceId: string, jobId: string) => {
      if (pollsInFlight.has(jobId)) return
      pollsInFlight.add(jobId)
      const ordered = [...sources].sort((a, b) => a.order - b.order)
      const isPrimary = ordered.length === 0 || ordered[0].id === sourceId
      dispatch(patchSourceStage({ id: sourceId, stage: 'transcribe', patch: { status: 'active' } }))
      if (isPrimary) patch('transcribe', { status: 'active' })
      try {
        const { result } = await pollJob(jobId)
        const got = ((result ?? {}) as { words?: TranscriptWord[] }).words ?? []
        const detail = `${got.length.toLocaleString()} words`
        dispatch(patchSource({ id: sourceId, patch: { words: got, transcribeJobId: null } }))
        dispatch(patchSourceStage({ id: sourceId, stage: 'transcribe', patch: { status: 'done', detail } }))
        if (isPrimary) {
          dispatch(setWords(got))
          patch('transcribe', { status: 'done', detail })
        }
      } catch (e) {
        const detail = stageError(e)
        dispatch(patchSource({ id: sourceId, patch: { transcribeJobId: null } }))
        dispatch(patchSourceStage({ id: sourceId, stage: 'transcribe', patch: { status: 'error', detail } }))
        if (isPrimary) patch('transcribe', { status: 'error', detail })
      } finally {
        pollsInFlight.delete(jobId)
      }
    },
    [pollJob, dispatch, patch, sources],
  )

  /**
   * Turn the post's inline `frame:<t>` tokens into real, uploaded images (issue
   * #70). The model emits timestamps it read off the Contact sheets; per ADR-0002
   * we re-capture a clean, full-resolution, label-free frame from the SOURCE video
   * (never crop the contact sheet) and upload it as a `blog` asset. Pure planning
   * (`planBlogCaptures`) dedups the timestamps and routes each global time to its
   * owning `(sourceId, localTime)` — multi-source projects capture from the right
   * video. Captures are grouped per source so each clip is signed + fetched once
   * (a `<video crossOrigin>` read of the signed GCS URL fails CORS, so we go via a
   * same-origin blob URL — the same path the director/refiner use). Returns the
   * Markdown with every resolvable token rewritten to its bucket serve URL; a
   * frame that fails to capture or upload is left out, never a broken image.
   */
  const materializeBlogImages = useCallback(
    async (markdown: string): Promise<{ markdown: string; frames: BlogImageRef[] }> => {
      const captures = planBlogCaptures(
        markdown,
        sources.map((s) => ({ id: s.id, duration: s.duration })),
      )
      if (captures.length === 0) return { markdown, frames: [] }

      const bySource = new Map<string, typeof captures>()
      for (const c of captures) {
        const arr = bySource.get(c.sourceId) ?? []
        arr.push(c)
        bySource.set(c.sourceId, arr)
      }

      const urlByTime = new Map<number, string>()
      for (const [sourceId, caps] of bySource) {
        const src = sources.find((s) => s.id === sourceId)
        if (!src?.sourceUrl) continue
        const objectUrl = URL.createObjectURL(await sourceBlobs.get(src.sourceUrl))
        try {
          // A high cap height: `captureFramesAt` never upscales past the source, so
          // this yields a clean full-resolution frame. JPEG q0.9 — a hero image, not
          // a thumbnail.
          const frames = await captureFramesAt(
            objectUrl,
            caps.map((c) => c.localTime),
            4320,
            { type: 'image/jpeg', quality: 0.9 },
          )
          for (let i = 0; i < caps.length; i++) {
            const dataUrl = frames[i]
            if (!dataUrl) continue // capture failed for this frame — skip it
            try {
              const blob = await (await fetch(dataUrl)).blob()
              const file = new File([blob], caps[i].fileName, { type: blob.type })
              const { url } = await uploadReq({ file, kind: 'blog' }).unwrap()
              urlByTime.set(caps[i].time, url)
            } catch {
              // upload failed — leave this token unresolved (it gets dropped below)
            }
          }
        } finally {
          URL.revokeObjectURL(objectUrl)
        }
      }
      // The sidecar mirrors exactly what survives into the Markdown (a token that
      // failed to upload is dropped by both), so each stored image knows the second
      // it came from and can be re-framed later (issue #91).
      return { markdown: rewriteFrameTokens(markdown, urlByTime), frames: blogImageRefs(captures, urlByTime) }
    },
    [sources, sourceBlobs, uploadReq],
  )

  // ---- Re-framing a blog image to a nearby moment (issue #91) --------------
  //
  // The producer can nudge a bad AI-picked frame (mid-blink, a weird face) to a
  // sibling timestamp: a filmstrip of nearby frames, then a one-click swap. The
  // source clip is decoded to a same-origin blob (a `<video crossOrigin>` read of
  // the signed GCS URL fails CORS). The bytes come from the session blob cache;
  // this ref only holds the one live object URL (which needs explicit revoking).
  const blogClipRef = useRef<{ sourceId: string; objectUrl: string } | null>(null)
  const blogClipUrl = useCallback(
    async (sourceId: string): Promise<string | null> => {
      const cached = blogClipRef.current
      if (cached?.sourceId === sourceId) return cached.objectUrl
      const src = sources.find((s) => s.id === sourceId)
      if (!src?.sourceUrl) return null
      const objectUrl = URL.createObjectURL(await sourceBlobs.get(src.sourceUrl))
      if (cached) URL.revokeObjectURL(cached.objectUrl)
      blogClipRef.current = { sourceId, objectUrl }
      return objectUrl
    },
    [sources, sourceBlobs],
  )
  // Free the cached clip blob when the pipeline unmounts (project close / reload).
  useEffect(
    () => () => {
      if (blogClipRef.current) URL.revokeObjectURL(blogClipRef.current.objectUrl)
      blogClipRef.current = null
    },
    [],
  )

  /**
   * Capture the filmstrip of nearby frames offered when re-framing a blog image:
   * plan a ±window/step window around the image's global timestamp, route each
   * sibling to its owning source + local time (multi-source aware), and capture a
   * small in-browser JPEG thumbnail for each. Nothing uploads — thumbnails are
   * throwaway previews until the producer picks one. Ordered ascending by time;
   * a sibling whose frame fails to capture is dropped.
   */
  const captureBlogSiblings = useCallback(
    async (time: number): Promise<{ time: number; thumb: string }[]> => {
      const lite = sources.map((s) => ({ id: s.id, duration: s.duration }))
      const times = planBlogSiblings(time, totalDuration(lite))
      const bySource = new Map<string, number[]>()
      const localByGlobal = new Map<number, number>()
      for (const t of times) {
        const loc = globalToLocal(lite, t)
        if (!loc) continue
        localByGlobal.set(t, loc.localTime)
        const arr = bySource.get(loc.sourceId) ?? []
        arr.push(t)
        bySource.set(loc.sourceId, arr)
      }
      const thumbByTime = new Map<number, string>()
      for (const [sourceId, ts] of bySource) {
        const objectUrl = await blogClipUrl(sourceId)
        if (!objectUrl) continue
        const frames = await captureFramesAt(
          objectUrl,
          ts.map((t) => localByGlobal.get(t) ?? 0),
          108, // a small filmstrip thumb, not the hero frame
          { type: 'image/jpeg', quality: 0.7 },
        )
        ts.forEach((t, i) => {
          if (frames[i]) thumbByTime.set(t, frames[i])
        })
      }
      return times
        .map((t) => ({ time: t, thumb: thumbByTime.get(t) ?? '' }))
        .filter((s) => s.thumb)
    },
    [sources, blogClipUrl],
  )

  /**
   * Capture a single medium-resolution preview frame at a global timestamp — the
   * large in-place preview the producer scrubs through before committing (issue
   * #91). Same cached-clip path as the filmstrip, one seek, NO upload: it's a
   * throwaway "what would this look like" frame, big enough to read a face at
   * figure size but not the full 4K hero the pick eventually recaptures. Empty
   * string if the moment can't be routed or the frame fails to capture.
   */
  const captureBlogPreview = useCallback(
    async (time: number): Promise<string> => {
      const lite = sources.map((s) => ({ id: s.id, duration: s.duration }))
      const loc = globalToLocal(lite, time)
      if (!loc) return ''
      const objectUrl = await blogClipUrl(loc.sourceId)
      if (!objectUrl) return ''
      const [dataUrl] = await captureFramesAt(objectUrl, [loc.localTime], 720, {
        type: 'image/jpeg',
        quality: 0.82,
      })
      return dataUrl ?? ''
    },
    [sources, blogClipUrl],
  )

  /**
   * Re-capture a blog image at a producer-picked nearby timestamp and swap it into
   * the post: route the global time to its source, capture ONE clean full-res
   * frame (same path + encoding as the initial materialise — ADR-0002 re-captures
   * from the source, never crops the sheet), upload it as a `blog` asset, and
   * commit the new URL + timestamp to the stored post. Resolves true on success;
   * a capture/upload failure leaves the post untouched and resolves false.
   */
  const reframeBlogImage = useCallback(
    async (oldUrl: string, time: number): Promise<boolean> => {
      const lite = sources.map((s) => ({ id: s.id, duration: s.duration }))
      const loc = globalToLocal(lite, time)
      if (!loc) return false
      const objectUrl = await blogClipUrl(loc.sourceId)
      if (!objectUrl) return false
      const [dataUrl] = await captureFramesAt(objectUrl, [loc.localTime], 4320, {
        type: 'image/jpeg',
        quality: 0.9,
      })
      if (!dataUrl) return false
      try {
        const blob = await (await fetch(dataUrl)).blob()
        const file = new File([blob], blogReframeFileName(time), { type: blob.type })
        const { url } = await uploadReq({ file, kind: 'blog' }).unwrap()
        dispatch(reframeBlogImageAction({ oldUrl, newUrl: url, time }))
        return true
      } catch {
        return false
      }
    },
    [sources, blogClipUrl, uploadReq, dispatch],
  )

  /**
   * Drive a blog-post job to completion and commit the Markdown (issue #68).
   * Shared by the live `generateBlog` action and resume-on-reload; `pollsInFlight`
   * keeps the two from double-polling one job. Once the prose is in, materialise
   * its inline frame images (issue #70) before committing, so the stored Markdown
   * already points at uploaded frames. Clears the post's in-flight job id on any
   * terminal status (success commits the markdown, failure flags `error`).
   */
  const completeBlogJob = useCallback(
    async (jobId: string) => {
      if (pollsInFlight.has(jobId)) return
      pollsInFlight.add(jobId)
      try {
        const { result } = await pollJob(jobId)
        const { markdown } = toBlog(result)
        const { markdown: resolved, frames } = await materializeBlogImages(markdown)
        dispatch(setBlogResult({ markdown: resolved, frames }))
      } catch {
        dispatch(setBlogError())
      } finally {
        pollsInFlight.delete(jobId)
      }
    },
    [pollJob, dispatch, materializeBlogImages],
  )

  // Resume any in-flight job after a hard reload (redux-persist brings back the
  // persisted job ids). The `pollsInFlight` guard inside the `complete*` helpers
  // makes this safe to re-run and safe to race with a live action — only one poll
  // loop runs per job id. Cold reloads have no in-memory clip, so the director
  // resume captures thumbs off the persisted source serve URL.
  useEffect(() => {
    // Kick the resume off in a microtask: the `complete*` helpers flip transient
    // spinner state synchronously (fine in the live event-handler path), so we
    // defer them out of the effect body to avoid a synchronous setState-in-effect.
    queueMicrotask(() => {
      if (scenesJobId) void completeDirectorJob(scenesJobId, sourceUrl)
      for (const scene of scenes) {
        if (scene.refineJobId) void completeRefineJob(scene.id, scene.refineJobId)
      }
      for (const s of sources) {
        if (s.transcribeJobId) void completeTranscribeJob(s.id, s.transcribeJobId)
      }
      if (blog?.status === 'running' && blog.jobId) void completeBlogJob(blog.jobId)
    })
  }, [scenesJobId, sourceUrl, scenes, sources, blog, completeDirectorJob, completeRefineJob, completeTranscribeJob, completeBlogJob])

  // Backfill measured dead space for projects whose audio was extracted before
  // 13c (extract never re-runs, so `deadSpace` would stay null forever): pull
  // the persisted WAV back once, measure, persist the small spans. `null` is
  // the trigger — a measured-but-silence-free project stores `[]` and is left
  // alone. A failed fetch clears the guard so the next mount can retry.
  useEffect(() => {
    if (!audioUrl || deadSpace || deadSpaceBackfillsInFlight.has(audioUrl)) return
    deadSpaceBackfillsInFlight.add(audioUrl)
    deadSpaceFromUrl(audioUrl)
      .then((spans) => {
        dispatch(setDeadSpace(spans))
        const primary = [...sources].sort((a, b) => a.order - b.order)[0]
        if (primary) dispatch(patchSource({ id: primary.id, patch: { deadSpace: spans } }))
      })
      .catch(() => {})
      .finally(() => deadSpaceBackfillsInFlight.delete(audioUrl))
  }, [audioUrl, deadSpace, sources, dispatch])

  // ---- Individual steps -----------------------------------------------------

  // Stage ① — upload the source clip directly to the storage bucket via the
  // presigned flow (the video is far over the 1 MB proxy body cap).
  const uploadClip = useCallback(
    async ({ file, duration }: StepContext) => {
      patch('upload', { status: 'active' })
      const sourceId = currentSource?.id ?? 'source-1'
      if (!currentSource) dispatch(addSource({ id: sourceId, fileName: file.name, duration }))
      const { url } = await uploadReq({ file, kind: 'source' }).unwrap()
      dispatch(setSourceUrl(url))                                   // legacy (unchanged)
      dispatch(patchSource({ id: sourceId, patch: { sourceUrl: url, fileName: file.name, duration } }))
      patch('upload', { status: 'done', detail: `${mb(file.size)} → storage bucket` })
    },
    [patch, dispatch, uploadReq, currentSource],
  )

  // Stage ② — extract the audio in-browser, then upload that WAV to the bucket
  // on its own so the transcription step can hand Replicate an audio URL.
  const extractAndUploadAudio = useCallback(
    async ({ file }: StepContext) => {
      patch('extract', { status: 'active' })
      // One decode yields the uploadable WAV, a compact waveform summary (the
      // resource card's stenograph), and the measured dead-space spans (story
      // 13c) — no re-decoding the whole clip for any of them.
      const { wav, peaks, deadSpace: dead } = await extractAudio(file) // real, browser-side
      const wavFile = new File([wav], `${file.name.replace(/\.[^.]+$/, '')}.wav`, {
        type: 'audio/wav',
      })
      const { url } = await uploadReq({ file: wavFile, kind: 'audio' }).unwrap()
      dispatch(setAudioUrl(url))                                       // legacy
      dispatch(setAudioPeaks(peaks))                                   // legacy
      dispatch(setDeadSpace(dead))                                     // legacy
      dispatch(patchSource({ id: currentSource?.id ?? 'source-1', patch: { audioUrl: url, audioPeaks: peaks, deadSpace: dead } }))
      patch('extract', {
        status: 'done',
        detail: `16 kHz mono WAV · ${mb(wav.size)} → bucket`,
      })
    },
    [patch, dispatch, uploadReq, currentSource],
  )

  // Stage ③ — transcribe the uploaded audio. POSTs the bucketed `audioUrl` to
  // the real `/api/transcribe` pipeline (presigned audio URL → Replicate
  // WhisperX with word-level alignment, story 02). Keeps the word-level
  // timestamps for shorten + segment (story 03).
  const transcribe = useCallback(
    async () => {
      const id = currentSource?.id ?? 'source-1'
      patch('transcribe', { status: 'active' })
      // Enqueue the async job, persist its id so a reload resumes polling, then
      // drive it to completion (story 10e). Diarization is the producer's
      // project-level choice; it's what can push this past the 30s edge timeout.
      const { jobId } = await transcribeStartReq({ audioUrl, diarize }).unwrap()
      dispatch(patchSource({ id, patch: { transcribeJobId: jobId } }))
      await completeTranscribeJob(id, jobId)
    },
    [patch, dispatch, transcribeStartReq, audioUrl, diarize, currentSource, completeTranscribeJob],
  )

  // Stage ④ — sample interval thumbnails across ALL source videos, compose them
  // into timestamped contact sheets (real, browser-side), then upload each to its
  // bucket so the master director (story 03) can be handed real image URLs — not
  // just in-browser blobs. The global timeline spacing is based on the COMBINED
  // duration of all sources so the ≤10-sheet budget holds. Each frame is stamped
  // with its GLOBAL time so the director reads one continuous timeline (story 09c).
  const generateThumbnails = useCallback(
    async () => {
      patch('thumbnails', { status: 'active' })
      const ordered = [...sources].sort((a, b) => a.order - b.order)
      const captures = planGlobalSheetCaptures(ordered.map((s) => ({ id: s.id, duration: s.duration })))

      // Capture each planned frame from the RIGHT source video at its LOCAL time,
      // off a same-origin blob URL (a <video crossOrigin> read of the signed GCS
      // URL fails CORS — same lesson as the per-scene refiner sheets). Group by
      // source so we sign+fetch each video once; keep frames in global order.
      const captureHeight = Math.round(CONTACT_SHEET_CELL * CONTACT_SHEET_SUPERSAMPLE)
      const frameByIndex: (string | null)[] = new Array(captures.length).fill(null)
      const idxBySource = new Map<string, number[]>()
      captures.forEach((c, i) => {
        const arr = idxBySource.get(c.sourceId) ?? []
        arr.push(i)
        idxBySource.set(c.sourceId, arr)
      })
      for (const [sourceId, idxs] of idxBySource) {
        const src = ordered.find((s) => s.id === sourceId)
        if (!src?.sourceUrl) continue
        const { url: signed } = await signReq(src.sourceUrl, true).unwrap()
        const blob = await (await fetch(signed)).blob()
        const objectUrl = URL.createObjectURL(blob)
        try {
          const localTimes = idxs.map((i) => captures[i].localTime)
          const frames = await captureFramesAt(objectUrl, localTimes, captureHeight, { type: 'image/png' })
          idxs.forEach((i, k) => {
            frameByIndex[i] = frames[k] ?? null
          })
        } finally {
          URL.revokeObjectURL(objectUrl)
        }
      }

      // Keep only captures that produced a frame, in global order, and compose into
      // ≤10 tiles stamped with GLOBAL time (so the director reads one timeline).
      const kept = captures.map((c, i) => ({ c, frame: frameByIndex[i] })).filter((x) => x.frame)
      const frames = kept.map((x) => x.frame as string)
      const times = kept.map((x) => x.c.globalTime)
      const perSheet = cellsPerSheet(frames.length)
      const frameTiles = chunk(frames, perSheet)
      const timeTiles = chunk(times, perSheet)
      // Global sampling spacing (seconds between frames) — evenly spaced across the
      // combined timeline, so consecutive captures differ by a constant interval.
      // composeContactSheet can't infer it, so stamp it (the preview reads it).
      const interval = times.length > 1 ? times[1] - times[0] : 0
      const sheets: ContactSheet[] = []
      for (let t = 0; t < frameTiles.length; t++) {
        const sheet = await composeContactSheet(frameTiles[t], timeTiles[t], CONTACT_SHEET_CELL)
        if (sheet.dataUrl) sheets.push({ ...sheet, interval, index: sheets.length, total: frameTiles.length })
      }

      // ===== keep the EXISTING upload + dispatch logic below, verbatim =====
      setPendingSheets(sheets)
      const uploaded: ContactSheet[] = []
      for (const sheet of sheets) {
        const blob = await (await fetch(sheet.dataUrl)).blob()
        const ext = blob.type === 'image/png' ? 'png' : 'jpg'
        const name = `contact-${String(sheet.index + 1).padStart(2, '0')}.${ext}`
        const file = new File([blob], name, { type: blob.type })
        const { url } = await uploadReq({ file, kind: 'thumbnails' }).unwrap()
        uploaded.push({ ...sheet, url, dataUrl: '' })
      }
      dispatch(setContactSheets(uploaded))
      setPendingSheets([])
      const frameCount = uploaded.reduce((n, s) => n + s.count, 0)
      patch('thumbnails', {
        status: 'done',
        detail: frameCount
          ? `${frameCount} frames · ${uploaded.length} sheet${uploaded.length === 1 ? '' : 's'} → bucket`
          : 'no frames sampled',
      })
    },
    [patch, dispatch, sources, signReq, uploadReq],
  )

  // Stages ⑤⑥ — the master director (story 03, 13f contract). One multimodal
  // Gemini call gets the timestamped transcript, the director contact sheets,
  // and the user's optional direction, and returns the synopsis + scenes (title,
  // tiled original-video span, cutting brief, and baseline cut spans). Marks BOTH
  // the shorten and segment notes done (one call does both), then captures a
  // midpoint thumb per scene for the scene-card art.
  const runDirector = useCallback(
    async ({ src }: StepContext) => {
      patch('director', { status: 'active' })
      const ordered = [...sources].sort((a, b) => a.order - b.order)
      const transcript = combinedTimedTranscript(
        ordered.map((s) => ({ id: s.id, fileName: s.fileName, duration: s.duration, words: s.words })),
      )
      const sheetUrls = persistedSheets.map((s) => s.url).filter((u): u is string => !!u)
      const duration = totalDuration(ordered.map((s) => ({ id: s.id, duration: s.duration })))
      // Enqueue-only: the start endpoint records a job and returns its id; the
      // Gemini call runs in the pipeline's postSteps (story 03f Part 0). Persist
      // the id so a hard reload resumes polling, then drive it to completion.
      const { jobId } = await scenesReq({ transcript, sheetUrls, direction, duration }).unwrap()
      dispatch(setScenesJobId(jobId))
      await completeDirectorJob(jobId, src)
    },
    [patch, sources, persistedSheets, direction, scenesReq, dispatch, completeDirectorJob],
  )

  // Re-run the master director after it's already done (story 03m). `next()`
  // runs the CURRENT stage — wrong here, it would run clone — so this drives the
  // director step directly. The UI confirm has already happened by now; the
  // scene queue is replaced wholesale by `completeDirectorJob` (which also
  // resets the selection). Same enqueue+poll as a first run, so `scenesJobId`
  // persists and a mid-redo reload resumes polling.
  const rerunDirector = useCallback(
    async (ctx: StepContext) => {
      try {
        await runDirector(ctx)
      } catch (e) {
        patch('director', { status: 'error', detail: stageError(e) })
      }
    },
    [runDirector, patch],
  )

  // ---- Per-source processing (story 09b) --------------------------------------

  // Process ONE source video through its three per-video prep stages (story 09b):
  // upload → extract+upload audio → transcribe, writing results into that source
  // in `sources[]` (NOT the legacy top-level fields). `stepInFlight` (module-level)
  // guards re-entrancy across StrictMode/instances, same as `next()`. The audioUrl
  // is threaded straight into transcribe — the selector value is stale within this run.
  const processSource = useCallback(
    async (id: string, file: File) => {
      if (processingId || stepInFlight) return
      stepInFlight = true
      setProcessingId(id)
      const objectUrl = URL.createObjectURL(file)
      let stage: StageId = 'upload'
      // Determine whether this is the primary (first-by-order) source so we can
      // mirror its results into the legacy top-level slice fields that the existing
      // board/director/preview all still read (09b bridge; retired in 09d).
      const ordered = [...sources].sort((a, b) => a.order - b.order)
      const isPrimary = ordered.length === 0 || ordered[0].id === id
      try {
        const duration = await measureVideoDuration(objectUrl)
        dispatch(patchSource({ id, patch: { fileName: file.name, duration } }))

        stage = 'upload'
        dispatch(patchSourceStage({ id, stage, patch: { status: 'active' } }))
        const { url: srcUrl } = await uploadReq({ file, kind: 'source' }).unwrap()
        dispatch(patchSource({ id, patch: { sourceUrl: srcUrl } }))
        dispatch(patchSourceStage({ id, stage, patch: { status: 'done', detail: `${mb(file.size)} → bucket` } }))
        if (isPrimary) {
          dispatch(setSourceUrl(srcUrl))
          dispatch(setDuration(duration))
          dispatch(setFileName(file.name))
          patch('upload', { status: 'done', detail: `${mb(file.size)} → bucket` })
        }

        stage = 'extract'
        dispatch(patchSourceStage({ id, stage, patch: { status: 'active' } }))
        const { wav, peaks, deadSpace: dead } = await extractAudio(file)
        const wavFile = new File([wav], `${file.name.replace(/\.[^.]+$/, '')}.wav`, { type: 'audio/wav' })
        const { url: aUrl } = await uploadReq({ file: wavFile, kind: 'audio' }).unwrap()
        dispatch(patchSource({ id, patch: { audioUrl: aUrl, audioPeaks: peaks, deadSpace: dead } }))
        dispatch(patchSourceStage({ id, stage, patch: { status: 'done', detail: `16 kHz mono WAV · ${mb(wav.size)}` } }))
        if (isPrimary) {
          dispatch(setAudioUrl(aUrl))
          dispatch(setAudioPeaks(peaks))
          dispatch(setDeadSpace(dead))
          patch('extract', { status: 'done', detail: `16 kHz mono WAV · ${mb(wav.size)}` })
        }

        // Transcribe is async (story 10e): enqueue, persist the job id (so a
        // reload resumes), then poll to completion. `completeTranscribeJob` owns
        // the stage transitions + the per-source/primary word dual-write.
        stage = 'transcribe'
        const { jobId } = await transcribeStartReq({ audioUrl: aUrl, diarize }).unwrap()
        dispatch(patchSource({ id, patch: { transcribeJobId: jobId } }))
        await completeTranscribeJob(id, jobId)
      } catch (e) {
        dispatch(patchSourceStage({ id, stage, patch: { status: 'error', detail: stageError(e) } }))
      } finally {
        URL.revokeObjectURL(objectUrl)
        stepInFlight = false
        setProcessingId(null)
      }
    },
    [processingId, sources, dispatch, uploadReq, transcribeStartReq, diarize, completeTranscribeJob, patch],
  )

  // Walk the source queue in order and process each that isn't already fully
  // prepped, one at a time (sequential — parallel uploads trip the dev proxy's
  // keep-alive sockets). `files` maps each source id to its in-memory File (held
  // transiently by the page; a source with no File in the map is skipped).
  const processAll = useCallback(
    async (files: Map<string, File>) => {
      const ordered = [...sources].sort((a, b) => a.order - b.order)
      for (const s of ordered) {
        if (PER_VIDEO_STAGES.every((st) => s.stageProgress[st]?.status === 'done')) continue
        const f = files.get(s.id)
        if (f) await processSource(s.id, f)
      }
    },
    [sources, processSource],
  )

  /** Run the current prep step. Marks the active stage `error` if it throws. */
  const next = useCallback(
    async (ctx: StepContext) => {
      const id = currentStageId
      if (!id || stepInFlight) return
      stepInFlight = true
      setRunning(true)
      try {
        if (id === 'upload') await uploadClip(ctx)
        else if (id === 'extract') await extractAndUploadAudio(ctx)
        else if (id === 'transcribe') await transcribe()
        else if (id === 'thumbnails') await generateThumbnails()
        else if (id === 'director') await runDirector(ctx) // scene split + briefs, one Gemini call
      } catch (e) {
        dispatch(failActiveStage(stageError(e)))
      } finally {
        stepInFlight = false
        setRunning(false)
      }
    },
    [
      currentStageId,
      dispatch,
      uploadClip,
      extractAndUploadAudio,
      transcribe,
      generateThumbnails,
      runDirector,
    ],
  )

  // ---- Per-scene refiner (story 03c) ----------------------------------------

  // Button 1: capture DENSE contact sheets for just this scene's window and
  // upload them (url-only persisted, like the prep sheets). Captures off the
  // persisted source serve URL so it works after a reload without the in-memory
  // clip. Separate from the whole-clip prep sheets.
  const generateSceneSheets = useCallback(
    async (id: string) => {
      if (sheetingIds.has(id) || refiningIds.has(id)) return
      const scene = scenes.find((s) => s.id === id)
      const src = scene && sourceForScene(sources, scene)
      if (!scene || !src?.sourceUrl) return
      setSheetingIds((s) => toggleId(s, id, true))
      setSceneErrorFor(id, null)
      // Capture frames off a SAME-ORIGIN blob: URL, never the cross-origin signed
      // bucket URL directly. A `<video crossOrigin>` media read against the GCS
      // object fails CORS (the element's range/preflight isn't satisfied even
      // though GET from this origin is allowed), whereas a plain `fetch` of the
      // bytes is fine. The source bytes come from the session blob cache — shared
      // with the cut step, so this never re-downloads the recording.
      let objectUrl: string | null = null
      try {
        const source = await sourceBlobs.get(src.sourceUrl)
        objectUrl = URL.createObjectURL(source)
        const sheets = await captureSceneContactSheet(objectUrl, scene.start, scene.end)
        const uploaded: ContactSheet[] = []
        for (const sheet of sheets) {
          const blob = await (await fetch(sheet.dataUrl)).blob()
          const ext = blob.type === 'image/png' ? 'png' : 'jpg'
          const name = `scene-${scene.index + 1}-sheet-${String(sheet.index + 1).padStart(2, '0')}.${ext}`
          const sheetFile = new File([blob], name, { type: blob.type })
          const { url } = await uploadSlot.run(() => uploadReq({ file: sheetFile, kind: 'thumbnails' }).unwrap())
          // Persist URL-only — drop the base64 blob so localStorage stays small.
          uploaded.push({ ...sheet, url, dataUrl: '' })
        }
        patchScene(id, { sheets: uploaded })
      } catch (e) {
        setSceneErrorFor(id, stageError(e))
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        setSheetingIds((s) => toggleId(s, id, false))
      }
    },
    [sheetingIds, refiningIds, scenes, sources, sourceBlobs, uploadReq, patchScene, setSceneErrorFor],
  )

  // Button 2: hand the scene's word timings + the director's cutting brief +
  // the dense sheets + the measured dead space to /api/refine-scene, store the
  // returned cuts in `scene.refined` (NON-destructive — the director's baseline
  // cuts are untouched).
  const refineScene = useCallback(
    async (id: string) => {
      if (sheetingIds.has(id) || refiningIds.has(id)) return
      const scene = scenes.find((s) => s.id === id)
      if (!scene) return
      setRefiningIds((s) => toggleId(s, id, true))
      setSceneErrorFor(id, null)
      try {
        // Belt-and-braces with the SceneRefinePanel gate (story 03k): the refiner
        // is required to listen, so refining an un-cut scene is an error, not a
        // silent fall-back to the old deaf behavior.
        if (!scene.clipAudioUrl) throw new Error('Cut this scene first — the refiner needs its audio.')
        const src = sourceForScene(sources, scene)
        const scoped = (src?.words ?? []).filter((w) => w.start >= scene.start && w.start < scene.end)
        const sheetUrls = (scene.sheets ?? []).map((s) => s.url).filter((u): u is string => !!u)
        // Seam-aware context (story 03r): hand the refiner the tail of the
        // PREVIOUS scene's effective narration so this scene opens in flow with
        // it, instead of being written blind. Snapshot at refine time — re-refine
        // a neighbor and this goes stale until you re-refine here.
        const sceneIndex = scenes.findIndex((s) => s.id === id)
        const prevScene = sceneIndex > 0 ? scenes[sceneIndex - 1] : null
        const prevWords = prevScene
          ? (sourceForScene(sources, prevScene)?.words ?? []).filter(
              (w) => w.start < prevScene.end && w.end > prevScene.start,
            )
          : []
        // Enqueue-only (story 03f Part 0): returns a job id; the Gemini refine runs
        // in the pipeline's postSteps. Persist the id on the scene so a reload
        // resumes polling, then drive it to completion (writes `scene.refined`).
        const { jobId } = await refineSceneReq({
          start: scene.start,
          end: scene.end,
          wordTimings: sceneWordTimings(scoped),
          sheetUrls,
          audioUrl: scene.clipAudioUrl,
          // The director's cutting brief (story 13f) — rides every refine
          // untouched; distinct from the creator's own direction below.
          brief: (scene.brief ?? '').trim(),
          // Measured dead space for this scene (story 13c → 13f): true silence
          // from the source's WAV, clamped to the scene window, so the model
          // snaps cut edges into silence rather than clipping words.
          deadSpace: deadSpaceLines(sceneDeadSpace(src?.deadSpace ?? deadSpace ?? [], scene)),
          // Creator steering (story 03l): the scene's own prompt + the global
          // director prompt (subject to the scene's include-checkbox).
          ...refineDirections(scene, direction),
          // Where this scene sits in the arc + the prior scene's lead-in (03r).
          sceneNumber: sceneIndex + 1,
          sceneCount: scenes.length,
          previousContext: prevScene ? sceneTail(prevScene, prevWords) : '',
        }).unwrap()
        patchScene(id, { refineJobId: jobId })
        await completeRefineJob(id, jobId)
      } catch (e) {
        setSceneErrorFor(id, stageError(e))
        setRefiningIds((s) => toggleId(s, id, false))
      }
    },
    [
      sheetingIds,
      refiningIds,
      scenes,
      sources,
      deadSpace,
      direction,
      refineSceneReq,
      patchScene,
      completeRefineJob,
      setSceneErrorFor,
    ],
  )

  // Creator steering for the refine call (story 03l). Both are INPUT-layer scene
  // fields — they survive revert (`clearRefinement` never touches them) and seed
  // the next re-refine.
  const setRefinePrompt = useCallback(
    (sceneId: string, text: string) => patchScene(sceneId, { refinePrompt: text }),
    [patchScene],
  )
  const setIncludeDirection = useCallback(
    (sceneId: string, on: boolean) => patchScene(sceneId, { includeDirection: on }),
    [patchScene],
  )

  // Hand-edit a scene's cuts directly on the cut grid (story 03d). `add` paints
  // a new/extended cut over the span; `remove` contracts/splits an existing one.
  // Materializes `refined` from the director baseline on the first edit, tags it
  // `manual`, and NEVER touches `scene.cuts` — so `clearRefinement` still
  // reverts to the AI's first pass cleanly.
  const editSceneCut = useCallback(
    (sceneId: string, span: Cut, op: 'add' | 'remove') => {
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const base = scene.refined ?? { cuts: scene.cuts ?? [], source: 'ai' as const }
      const cuts = op === 'add' ? addCut(base.cuts, span, scene) : removeCut(base.cuts, span)
      patchSceneEdit(sceneId, { refined: { ...base, cuts, source: 'manual' } })
    },
    [scenes, patchSceneEdit],
  )

  // Auto-trim dead space (story 13e): apply the tool's whole batch of
  // deterministic silence cuts as ONE edit — the same non-destructive layer as
  // a drag (`refined`, `source: 'manual'`, baseline untouched), so revert still
  // clears back to the AI's first pass. One patch, not N `editSceneCut` calls:
  // those would each rebuild `refined` from this render's stale scene and keep
  // only the last span.
  const addSceneCuts = useCallback(
    (sceneId: string, spans: Cut[]) => {
      if (!spans.length) return
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const base = scene.refined ?? { cuts: scene.cuts ?? [], source: 'ai' as const }
      patchSceneEdit(sceneId, {
        refined: { ...base, cuts: addCuts(base.cuts, spans, scene), source: 'manual' },
      })
    },
    [scenes, patchSceneEdit],
  )

  // Cut this scene into its own video clip + soundtrack (story 03g + 03k, build
  // step 0). The raw source is the immutable source of truth — every scene reads
  // the same bytes through the session blob cache, so the recording downloads
  // once per session, not once per cut. We trim `[start, end]` frame-accurately
  // in ffmpeg.wasm and slice the same span from the talk WAV (also cached),
  // upload both (kind `scene-clip` / `audio`, SEQUENTIALLY — the keep-alive 502
  // lesson), and persist both serve paths in ONE patch, so the scene gets both
  // resources or neither and a reload resumes with the cut done. Re-cutting
  // overwrites both.
  const sliceScene = useCallback(
    async (sceneId: string) => {
      if (slicingIds.has(sceneId)) return
      const scene = scenes.find((s) => s.id === sceneId)
      const src = scene && sourceForScene(sources, scene)
      if (!scene || !src) return
      setSlicingIds((s) => toggleId(s, sceneId, true))
      setSceneErrorFor(sceneId, null)
      try {
        if (!src.audioUrl) throw new Error('No extracted audio to cut the scene soundtrack from.')
        if (!src.sourceUrl) throw new Error('No source clip available to cut from.')

        if ((await getVideoBackend()) === 'server') {
          // Server path: the source never leaves the bucket. One job cuts the
          // clip AND emits its 16k WAV (audioOutput) — replacing the wasm slice
          // + WebAudio sliceAudioWav + two uploads.
          const { jobId } = await videoSliceStartReq({
            sourceUrl: src.sourceUrl,
            spans: [{ start: scene.start, end: scene.end }],
            wantAudio: true,
            audioFades: false, // cut parity: slice.ts has no fades
            projectId: activeProjectId ?? '',
          }).unwrap()
          const job = await pollJob(jobId, { timeoutMs: VIDEO_POLL_TIMEOUT_MS })
          const out = toVideoResult(job.result)
          if (!out.audioUrl) throw new Error('Server cut finished without a soundtrack WAV.')
          patchSceneEdit(sceneId, { clipUrl: out.url, clipAudioUrl: out.audioUrl })
          return
        }

        // `slice()` mounts this Blob instead of copying it into the wasm heap.
        const source = await sourceBlobs.get(src.sourceUrl)

        const command = buildSliceCommand({
          start: scene.start,
          end: scene.end,
          source: sliceSourcePath(),
          output: `scene-${scene.index}.mp4`,
        })
        const blob = await ffmpegSlice({ source, command })
        const clip = new File([blob], `scene-${scene.index}.mp4`, { type: 'video/mp4' })
        const { url } = await uploadSlot.run(() => uploadReq({ file: clip, kind: 'scene-clip' }).unwrap())
        const wav = await sliceAudioWav(await audioBlobs.get(src.audioUrl), scene.start, scene.end)
        const audioFile = new File([wav], `scene-${scene.index}-audio.wav`, { type: 'audio/wav' })
        const { url: clipAudioUrl } = await uploadSlot.run(() => uploadReq({ file: audioFile, kind: 'audio' }).unwrap())
        patchSceneEdit(sceneId, { clipUrl: url, clipAudioUrl })
      } catch (e) {
        setSceneErrorFor(sceneId, stageError(e))
      } finally {
        setSlicingIds((s) => toggleId(s, sceneId, false))
      }
    },
    [
      slicingIds,
      scenes,
      sources,
      sourceBlobs,
      audioBlobs,
      uploadReq,
      videoSliceStartReq,
      pollJob,
      activeProjectId,
      patchSceneEdit,
      setSceneErrorFor,
    ],
  )

  // Throw out the refinement and revert to the director's first pass.
  const clearRefinement = useCallback(
    (id: string) => {
      setSceneErrorFor(id, null)
      patchSceneEdit(id, { refined: null, promptJobId: undefined })
    },
    [patchSceneEdit, setSceneErrorFor],
  )

  // ---- Scene build loop -----------------------------------------------------

  const markBuilt = useCallback(
    (id: string) => {
      // Targeted patch, NOT a wholesale setScenes — a concurrent step's write
      // to another scene must survive this (story 03u).
      patchScene(id, { status: 'built' })
      const stillPending = scenes.find((s) => s.id !== id && s.status === 'pending')
      if (stillPending) dispatch(setSelected(stillPending.id))
    },
    [scenes, patchScene, dispatch],
  )

  // Flip a scene's built flag both ways — the producer's own "this one's good to
  // go" tracker. Marking built auto-advances to the next pending scene (so you
  // walk the queue); un-marking just sets it back to pending, no jump. Independent
  // of voicing or assembling — purely a status the export readiness reads.
  const toggleBuilt = useCallback(
    (id: string) => {
      const scene = scenes.find((s) => s.id === id)
      if (!scene) return
      if (scene.status === 'built') {
        patchScene(id, { status: 'pending' })
      } else {
        markBuilt(id)
      }
    },
    [scenes, patchScene, markBuilt],
  )

  const select = useCallback((id: string | null) => dispatch(setSelected(id)), [dispatch])

  // ---- Export: describe the finished video ----------------------------------

  // Write the Export page's recommended title + summary from the FINAL kept script
  // (with the director's synopsis as context) via /api/describe, and persist it
  // alongside the script it was built from so the Export view can show it cached
  // and only regenerate when the script changes. One sync text call (mirrors
  // search). Errors surface through the shared `sceneError`.
  // Resolves a scene to its timed words — the kept-script derivations (describe/
  // blog/thumbnail) subtract the effective cuts from these (ADR-0003).
  const wordsFor = useMemo(() => sceneWordsLookup(sources), [sources])

  const generateDescription = useCallback(async () => {
    const req = buildDescribeRequest(scenes, synopsis, wordsFor)
    if (!req.script) {
      setSceneError('Build at least one scene before generating a description.')
      return
    }
    setDescribing(true)
    setSceneError(null)
    try {
      const raw = await describeReq(req).unwrap()
      const { title, summary } = toDescription(raw)
      dispatch(setDescription({ title, summary, script: req.script }))
    } catch (e) {
      setSceneError(stageError(e))
    } finally {
      setDescribing(false)
    }
  }, [scenes, synopsis, wordsFor, describeReq, dispatch])

  // ---- Export: generate the blog post (issue #68) ---------------------------

  // The post is stale when the final kept script has drifted from the one it was
  // generated against (issue #72) — e.g. a scene was re-cut. Surfaced in the card
  // so the producer can regenerate; never auto-regenerated.
  const blogStale = useMemo(() => isBlogStale(blog, videoScript(scenes, wordsFor)), [blog, scenes, wordsFor])

  // Generate a Markdown blog post from the FINAL kept script (+ the creator's
  // direction) via the async `/api/blog` job, mirroring the master director:
  // enqueue, persist the job id + inputs (so a reload resumes polling), then
  // drive it to completion (which commits the markdown). On-demand only — the
  // Export step never auto-runs this. Errors surface on the post's `error` status.
  const generateBlog = useCallback(
    async (directionInput: string) => {
      const ordered = [...sources].sort((a, b) => a.order - b.order)
      const sheetUrls = persistedSheets.map((s) => s.url).filter((u): u is string => !!u)
      const duration = totalDuration(ordered.map((s) => ({ id: s.id, duration: s.duration })))
      // Same `[m:ss]` timestamped transcript the director gets, so the writer can
      // align what's said to WHEN and pick accurate `frame:<t>` image timestamps.
      const timedTranscript = combinedTimedTranscript(
        ordered.map((s) => ({ id: s.id, fileName: s.fileName, duration: s.duration, words: s.words })),
      )
      const req = buildBlogRequest(scenes, directionInput, wordsFor, {
        synopsis,
        description,
        sheetUrls,
        duration,
        timedTranscript,
      })
      if (!req.script) {
        setSceneError('Build at least one scene before generating a blog post.')
        return
      }
      try {
        const { jobId } = await blogStartReq(req).unwrap()
        dispatch(setBlogRunning({ direction: req.direction, script: req.script, jobId }))
        await completeBlogJob(jobId)
      } catch (e) {
        setSceneError(stageError(e))
        dispatch(setBlogError())
      }
    },
    [scenes, sources, persistedSheets, synopsis, description, blogStartReq, dispatch, completeBlogJob, wordsFor],
  )

  // Producer edit of the recommended title (persisted on the description layer).
  const editDescriptionTitle = useCallback(
    (title: string) => dispatch(setDescriptionTitle(title)),
    [dispatch],
  )

  // ---- Export: YouTube thumbnail (story 06) ---------------------------------

  // Draft a nano-banana prompt from the finished video's title + YouTube
  // description + final script + the creator's notes. One sync call; the handler
  // loads the `image-prompts` skill to do the prompt-craft. Returns the drafted
  // prompt for the editable textarea (we don't persist until it's rendered).
  const draftThumbnailPrompt = useCallback(
    async (title: string, description: string, notes: string): Promise<string | null> => {
      const req = buildThumbnailDraftRequest(scenes, title, description, notes, wordsFor)
      if (!req.script) {
        setSceneError('Build at least one scene before generating a thumbnail.')
        return null
      }
      setDraftingThumbnail(true)
      setSceneError(null)
      try {
        const raw = await thumbnailDraftReq(req).unwrap()
        return toThumbnailPrompt(raw).prompt
      } catch (e) {
        setSceneError(stageError(e))
        return null
      } finally {
        setDraftingThumbnail(false)
      }
    },
    [scenes, wordsFor, thumbnailDraftReq],
  )

  // Render the thumbnail with the (edited) prompt: nano-banana → bucket → serve
  // path, persisted on the project (url-only) so it survives reload + rides
  // server-sync. Stores notes + prompt alongside so the UI can repopulate.
  const renderThumbnail = useCallback(
    async (notes: string, prompt: string, referenceUrl: string | null = null) => {
      if (!prompt.trim()) {
        setSceneError('Draft a prompt before generating the image.')
        return
      }
      setRenderingThumbnail(true)
      setSceneError(null)
      try {
        const raw = await thumbnailRenderReq({
          prompt,
          projectId: activeProjectId ?? '',
          ...(referenceUrl ? { referenceImageUrl: referenceUrl } : {}),
        }).unwrap()
        const { imageUrl } = toThumbnailImage(raw)
        dispatch(
          setYoutubeThumbnail({
            notes,
            prompt,
            url: imageUrl,
            ...(referenceUrl ? { referenceUrl } : {}),
          }),
        )
      } catch (e) {
        setSceneError(stageError(e))
      } finally {
        setRenderingThumbnail(false)
      }
    },
    [thumbnailRenderReq, activeProjectId, dispatch],
  )

  // Upload the optional thumbnail reference image (the creator's face, a product
  // shot) through the same presigned direct-to-bucket flow every other asset
  // uses — the bytes never go through a pipeline body.
  const uploadThumbnailReference = useCallback(
    async (file: File): Promise<string> => {
      if (!activeProjectId) throw new Error('Open a project before uploading a reference image.')
      return presignedUpload(file, '/api/uploads/thumbnails', activeProjectId)
    },
    [activeProjectId],
  )

  // ---- Export: save the assembled cut (story 05) ----------------------------

  // Persist the assembled MP4 the same way every other resource is saved: upload
  // the blob to the bucket via the presigned `export` flow, then keep only the
  // returned serve URL in Redux (persisted to localStorage) so a hard reload
  // brings the cut back. Re-saving a freshly re-assembled blob OVERWRITES the URL
  // — the producer can refine, re-assemble, and save again. The heavy blob never
  // touches Redux; "Download" stays separate (a local file, not a saved artifact).
  const saveFinalCut = useCallback(
    async (blob: Blob): Promise<string> => {
      setSavingFinalCut(true)
      try {
        const file = new File([blob], 'studio-final-cut.mp4', { type: blob.type || 'video/mp4' })
        const { url } = await uploadSlot.run(() => uploadReq({ file, kind: 'export' }).unwrap())
        dispatch(setFinalCutUrl(url))
        return url
      } finally {
        setSavingFinalCut(false)
      }
    },
    [uploadReq, dispatch],
  )

  // Server-side final stitch (story video-ops task 7) — the `videoConcatStart`
  // equivalent of `assembleFinalCutBlob` + `saveFinalCut`. Observable-behavior
  // parity note: `assembleFinalCutBlob`'s one-scene shortcut
  // (`assembleScene.ts:64`) only skips the ffmpeg concat pass — the resulting
  // Blob is STILL handed to `saveFinalCut`, which re-uploads it through the
  // `export` presigned flow and mints a fresh serve URL distinct from
  // `assembledUrl`. So there is no dedicated single-scene shortcut here either:
  // `videoConcatStart` runs with however many parts there are (the server's
  // concat rule accepts `parts.length === 1` — see
  // `.bffless/proxy-rules/studio/rules/api/video/concat/post/prep.fn.js`), and
  // its poll result becomes the new `finalCutUrl` the same way a save would.
  // Aliasing `finalCutUrl` straight to a scene's `assembledUrl` was rejected —
  // it would make the final cut's URL life-cycle depend on that scene's, which
  // the wasm path never does. THROWS on failure (stitch regime — halts
  // auto-build, mirrored at its call site).
  const stitchFinalCutRemote = useCallback(async (): Promise<void> => {
    const missing = scenes.findIndex((s) => !s.assembledUrl)
    if (missing !== -1) throw new Error(`Scene ${missing + 1} isn't assembled yet.`)
    const { jobId } = await videoConcatStartReq({
      parts: scenes.map((s) => s.assembledUrl as string),
      projectId: activeProjectId ?? '',
    }).unwrap()
    const job = await pollJob(jobId, { timeoutMs: VIDEO_POLL_TIMEOUT_MS })
    const out = toVideoResult(job.result)
    dispatch(setFinalCutUrl(out.url))
  }, [scenes, videoConcatStartReq, pollJob, activeProjectId, dispatch])

  // Save one scene's assembled cut (story 03g phase 2). Uploads the rendered scene
  // MP4 (reusing the `export` presigned flow) and persists its serve path on the
  // scene as `assembledUrl`, so a reload keeps it and the final master concat can
  // stitch every scene's saved cut. Re-assembling + saving overwrites it.
  // Saving an assembled scene IS what makes it "built" — set `status` here rather
  // than leave it to a manual toggle, so the badge / tab ✓ / export readiness follow
  // the actual work (a scene with an assembled cut is, by definition, built).
  const saveSceneCut = useCallback(
    async (sceneId: string, blob: Blob): Promise<string> => {
      setSavingSceneCutId(sceneId)
      try {
        const file = new File([blob], `scene-${sceneId}.mp4`, { type: blob.type || 'video/mp4' })
        const { url } = await uploadSlot.run(() => uploadReq({ file, kind: 'export' }).unwrap())
        patchScene(sceneId, { assembledUrl: url, status: 'built' })
        return url
      } finally {
        setSavingSceneCutId(null)
      }
    },
    [uploadReq, patchScene],
  )

  // Server-side scene assemble (story video-ops task 7) — the `videoSliceStart`
  // equivalent of `assembleSceneBlob` + `saveSceneCut` combined into one job: the
  // clip-local plan is the SAME pure `planScene` walk `SceneAssembleBar` uses, but
  // the render runs on the server's ffmpeg_handler against `scene.clipUrl` and the
  // job's own output URL becomes `assembledUrl` directly — no separate blob/upload
  // round trip. `wantAudio: false, audioFades: true`: assemble keeps the CLIP's own
  // audio track through the video slice (never a re-extracted WAV), and Task 5's
  // slice rule hardcodes fades ON for that branch — sent as specified, not
  // inverted. THROWS on failure (assemble regime — halts auto-build, mirrored at
  // its call sites, unlike `sliceScene`'s swallow into `sceneErrors`).
  const assembleSceneRemote = useCallback(
    async (sceneId: string): Promise<void> => {
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene?.clipUrl) throw new Error("Cut this scene first — assemble works on the scene's own clip.")
      const plan = planScene({ cuts: effectiveCuts(scene), start: scene.start, end: scene.end })
      if (plan.video.length === 0) throw new Error('Nothing to assemble — the whole scene is cut.')
      const { jobId } = await videoSliceStartReq({
        sourceUrl: scene.clipUrl,
        spans: plan.video,
        wantAudio: false,
        audioFades: true, // assemble parity: buildFfmpegCommand's ~10ms edge fades
        projectId: activeProjectId ?? '',
      }).unwrap()
      const job = await pollJob(jobId, { timeoutMs: VIDEO_POLL_TIMEOUT_MS })
      const out = toVideoResult(job.result)
      patchScene(sceneId, { assembledUrl: out.url, status: 'built' })
    },
    [scenes, videoSliceStartReq, pollJob, activeProjectId, patchScene],
  )

  const allBuilt = useMemo(
    () => scenes.length > 0 && scenes.every((s) => s.status === 'built'),
    [scenes],
  )
  const globalReady = useMemo(
    () => GLOBAL_STAGES.every((id) => stageProgress[id]?.status === 'done'),
    [stageProgress],
  )
  const ready = useMemo(() => sourcesReady && globalReady, [sourcesReady, globalReady])

  return {
    stages,
    scenes,
    sourceUrl,
    audioUrl,
    audioPeaks,
    deadSpace,
    contactSheets,
    words,
    synopsis,
    selectedId,
    finalCutUrl,
    savingFinalCut,
    savingSceneCutId,
    running,
    sheetingIds,
    refiningIds,
    slicingIds,
    sceneErrors,
    sceneError,
    ready,
    sourcesReady,
    allBuilt,
    currentStageId,
    next,
    reset,
    select,
    saveFinalCut,
    stitchFinalCutRemote,
    description,
    describing,
    generateDescription,
    blog,
    blogStale,
    generateBlog,
    captureBlogSiblings,
    captureBlogPreview,
    reframeBlogImage,
    editDescriptionTitle,
    signFor,
    youtubeThumbnail,
    draftingThumbnail,
    renderingThumbnail,
    draftThumbnailPrompt,
    renderThumbnail,
    uploadThumbnailReference,
    saveSceneCut,
    assembleSceneRemote,
    generateSceneSheets,
    refineScene,
    direction,
    setRefinePrompt,
    setIncludeDirection,
    directorPromptJobId,
    rerunDirector,
    editSceneCut,
    addSceneCuts,
    sliceScene,
    clearRefinement,
    markBuilt,
    toggleBuilt,
    sources,
    processingId,
    processSource,
    processAll,
    diarize,
    wordsFor,
  }
}
