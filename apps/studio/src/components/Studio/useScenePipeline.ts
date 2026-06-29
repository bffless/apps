import { useCallback, useEffect, useMemo, useState } from 'react'
import { STAGE_DEFS, PER_VIDEO_STAGES, GLOBAL_STAGES, type Stage, type StageId } from '../../lib/pipeline'
import { narrationSeconds, type Cut, type NarrationSegment, type Scene } from '../../lib/scenes'
import { combinedTimedTranscript, toScenes, type DirectorScene } from '../../lib/director'
import { buildDescribeRequest, toDescription } from '../../lib/describe'
import { buildBlogRequest, toBlog } from '../../lib/blog'
import { buildThumbnailDraftRequest, toThumbnailPrompt, toThumbnailImage } from '../../lib/thumbnail'
import {
  toRefinement,
  refineDirections,
  sceneWordTimings,
  sceneTail,
  effectiveSegments,
  addCut,
  removeCut,
  clampDropStart,
  moveRun as moveRunSegments,
  insertSegment,
  removeSegment,
  suggestedOriginalIndices,
  applyOriginalClips,
  type RefineSceneRaw,
} from '../../lib/refiner'
import { totalDuration, sourceForScene } from '../../lib/sources'
import { resolvePerson, dominantSpeaker, resolveSpeakerVoice } from '../../lib/speakers'
import { extractAudio, extractAudioWav, sliceAudioWav, sliceManyAudioWav } from '../../lib/audio'
import { STALE_RENDER_PATCH } from '../../lib/autoBuild'
import { buildSliceCommand } from '../../lib/export/slice'
import { slice as ffmpegSlice } from '../../lib/export/ffmpeg'
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
  useNarrateMutation,
  useDescribeMutation,
  useBlogStartMutation,
  useThumbnailDraftMutation,
  useThumbnailRenderMutation,
  useUploadMutation,
  useLazySignDownloadQuery,
  useVoiceCloneMutation,
  useVoiceSayMutation,
  type UploadKind,
} from '../../store/studioApi'
import { presetLabel } from '../../lib/voices'
import {
  patchStage,
  failActiveStage,
  setScenes,
  patchScene as patchSceneAction,
  setSourceUrl,
  setAudioUrl,
  setAudioPeaks,
  setContactSheets,
  setWords,
  setSynopsis,
  setScenesJobId,
  setDirectorPromptJobId,
  addSavedVoice,
  removeSavedVoice,
  setSelected,
  setFinalCutUrl,
  setDescription,
  setDescriptionTitle,
  setBlogRunning,
  setBlogResult,
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
  setPeopleCount,
  renamePerson,
  setPersonVoice,
  removePerson,
  assignSpeaker,
  type TranscriptWord,
} from '../../store/studioSlice'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`

// Async fire-and-poll tuning (story 03f Part 0). The director/refiner jobs run
// off the response path now, so we poll a status endpoint until the row is done.
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 5 * 60 * 1000 // give up on a wedged job rather than poll forever

/**
 * Job ids currently being polled, shared across hook instances (same rationale as
 * `stepInFlight`). Both the live action AND the resume-on-mount effect can race to
 * poll the same job — and React StrictMode double-invokes effects in dev — so this
 * module-level guard ensures exactly one poll loop per job id.
 */
const pollsInFlight = new Set<string>()

/**
 * Measure an audio clip's real length by loading just its metadata — the TTS
 * pipeline doesn't report a duration, so we read it off the served file (works
 * for both bucket serve paths and the mock's data-URL tone). Resolves 0 on error.
 */
function measureAudioDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio()
    audio.preload = 'metadata'
    const done = (v: number) => resolve(Number.isFinite(v) && v > 0 ? v : 0)
    audio.addEventListener('loadedmetadata', () => done(audio.duration))
    audio.addEventListener('error', () => done(0))
    audio.src = url
  })
}

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
  const persistedSheets = useAppSelector((s) => selectActive(s).contactSheets)
  const words = useAppSelector((s) => selectActive(s).words)
  const synopsis = useAppSelector((s) => selectActive(s).synopsis)
  const description = useAppSelector((s) => selectActive(s).description)
  const youtubeThumbnail = useAppSelector((s) => selectActive(s).youtubeThumbnail)
  const blog = useAppSelector((s) => selectActive(s).blog)
  const direction = useAppSelector((s) => selectActive(s).direction)
  const directorPromptJobId = useAppSelector((s) => selectActive(s).directorPromptJobId)
  const scenesJobId = useAppSelector((s) => selectActive(s).scenesJobId)
  const voice = useAppSelector((s) => selectActive(s).voice)
  const savedVoices = useAppSelector((s) => s.studio.savedVoices)
  const cast = useAppSelector((s) => selectActive(s).cast)
  const speakerAssignments = useAppSelector((s) => selectActive(s).speakerAssignments)
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
  const [scenesReq] = useScenesMutation()
  const [refineSceneReq] = useRefineSceneMutation()
  const [narrateReqRaw] = useNarrateMutation()
  const [describeReq] = useDescribeMutation()
  const [blogStartReq] = useBlogStartMutation()
  const [thumbnailDraftReq] = useThumbnailDraftMutation()
  const [thumbnailRenderReq] = useThumbnailRenderMutation()
  const [uploadReqRaw] = useUploadMutation()
  const [voiceCloneReq] = useVoiceCloneMutation()
  const [voiceSayReq] = useVoiceSayMutation()
  const [signReq] = useLazySignDownloadQuery()

  const uploadReq = useCallback(
    (a: { file: File; kind: UploadKind }) => uploadReqRaw({ ...a, projectId: activeProjectId ?? '' }),
    [uploadReqRaw, activeProjectId],
  )
  const narrateReq = useCallback(
    (a: { text: string; voiceId: string }) => narrateReqRaw({ ...a, projectId: activeProjectId ?? '' }),
    [narrateReqRaw, activeProjectId],
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
  // Per-scene refiner (story 03c) busy flags + last error. Transient: the scene
  // being captured-for, the scene being refined, and any error from either.
  const [sheetingId, setSheetingId] = useState<string | null>(null)
  const [refiningId, setRefiningId] = useState<string | null>(null)
  // The scene currently slicing+uploading an original-audio clip (story 03d).
  const [adoptingId, setAdoptingId] = useState<string | null>(null)
  // The scene currently being cut into its own video clip (story 03g). Transient.
  const [slicingId, setSlicingId] = useState<string | null>(null)
  // Which segment is currently being voiced (AI or record-upload), as
  // `${sceneId}:${segmentIndex}` — so only that one row shows a spinner.
  const [voicingSegKey, setVoicingSegKey] = useState<string | null>(null)
  // Which scene is currently having ALL its segments voiced by auto mode (story 03s).
  const [voicingSceneId, setVoicingSceneId] = useState<string | null>(null)
  const [sceneError, setSceneError] = useState<string | null>(null)
  // The clone prep step's two busy flags: cloning a recording, and synthesizing
  // the post-selection preview sample. Transient — fine to lose on reload.
  const [cloning, setCloning] = useState(false)
  const [samplingVoice, setSamplingVoice] = useState(false)
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
    async (jobId: string): Promise<{ kind: 'scenes' | 'refine' | 'transcribe' | 'blog'; result: unknown }> => {
      const deadline = Date.now() + POLL_TIMEOUT_MS
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
   * Voice a list of spans with the clip's OWN audio (story 03j): decode the
   * whole-clip WAV once, slice every span from the same PCM, then upload the
   * slices SEQUENTIALLY (parallel registers reset the dev proxy's keep-alive
   * sockets — same lesson as the contact-sheet uploads). One entry per span:
   * the uploaded clip + its measured length, or null if that span failed (the
   * caller leaves that segment unvoiced).
   */
  const sliceAndUploadSpans = useCallback(
    async (
      sourceAudioUrl: string,
      spans: { start: number; end: number }[],
    ): Promise<({ url: string; seconds: number } | null)[]> => {
      if (!sourceAudioUrl) throw new Error('No extracted audio to slice from.')
      const blobs = await sliceManyAudioWav(sourceAudioUrl, spans)
      const out: ({ url: string; seconds: number } | null)[] = []
      for (let i = 0; i < blobs.length; i++) {
        try {
          const { start, end } = spans[i]
          const file = new File(
            [blobs[i]],
            `original-${Math.round(start)}-${Math.round(end)}.wav`,
            { type: 'audio/wav' },
          )
          const { url } = await uploadReq({ file, kind: 'voice' }).unwrap()
          const measured = await measureAudioDuration(url)
          out.push({ url, seconds: measured > 0 ? measured : end - start })
        } catch {
          out.push(null)
        }
      }
      return out
    },
    [uploadReq],
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
        const built = toScenes(data.scenes ?? [], sources.map((s) => ({ id: s.id, duration: s.duration })))
        dispatch(setSynopsis(data.synopsis ?? null))

        // Scene-card art: capture one midpoint frame per scene if we can seek the
        // source; never let a failed/absent source fail the whole job.
        let thumbs: string[] = []
        if (videoSrc) {
          try {
            thumbs = await captureFramesAt(videoSrc, built.map((s) => (s.start + s.end) / 2), 64)
          } catch {
            thumbs = []
          }
        }
        const withThumbs = built.map((s, i) => ({ ...s, thumb: thumbs[i] }))
        dispatch(setScenes(withThumbs))
        dispatch(setSelected(withThumbs[0]?.id ?? null))

        const cutCount = withThumbs.reduce((n, s) => n + (s.cuts?.length ?? 0), 0)
        patch('director', {
          status: 'done',
          detail: `${withThumbs.length} scene${withThumbs.length === 1 ? '' : 's'} · ${cutCount} cut${cutCount === 1 ? '' : 's'} · script tightened`,
        })
        // Remember the job row so the prompt disclosure can fetch what was sent
        // to Gemini (story 03m). Separate from the in-flight id cleared below.
        dispatch(setDirectorPromptJobId(jobId))
        dispatch(setScenesJobId(null))
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
    [pollJob, dispatch, patch, sources],
  )

  /**
   * Drive a per-scene refiner job to completion and write it into `scene.refined`
   * (non-destructive). Shared by the live `refineScene` and resume-on-reload;
   * `pollsInFlight` keeps the two from double-polling one job. Clears the scene's
   * `refineJobId` on any terminal status.
   *
   * Auto-adopt (story 03j): segments the refiner tagged `original` (and the
   * verbatim guard upheld) are voiced from the clip's own audio BEFORE the
   * refinement is committed — one decode, sequential uploads, per-segment
   * failures non-fatal (each keeps its one-click "Use original" chip).
   * Committing ONCE, after the audio work, means no second patch racing the
   * producer's hand-edits.
   */
  const completeRefineJob = useCallback(
    async (sceneId: string, jobId: string) => {
      if (pollsInFlight.has(jobId)) return
      pollsInFlight.add(jobId)
      setRefiningId(sceneId)
      setSceneError(null)
      try {
        const { result } = await pollJob(jobId)
        const scene = scenes.find((s) => s.id === sceneId)
        if (!scene) {
          patchScene(sceneId, { refineJobId: null })
          return
        }
        const src = sourceForScene(sources, scene)
        const refinement = toRefinement(result as RefineSceneRaw, scene)

        const idx = suggestedOriginalIndices(refinement.segments)
        let segments = refinement.segments
        let failed = 0
        if (idx.length) {
          let clips: ({ url: string; seconds: number } | null)[] = idx.map(() => null)
          try {
            clips = await sliceAndUploadSpans(
              src?.audioUrl ?? '',
              idx.map((i) => ({ start: segments[i].start, end: segments[i].end })),
            )
          } catch {
            // No extracted audio / decode failed — every tagged segment falls
            // back to its chip.
          }
          ;({ segments, failed } = applyOriginalClips(segments, idx, clips))
        }
        const total = segments.reduce((n, s) => n + (s.audioSeconds ?? 0), 0)
        patchSceneEdit(sceneId, {
          refined: { ...refinement, segments },
          refineJobId: null,
          promptJobId: jobId,
          // null (not stale) when the new refinement has no voiced audio yet.
          narrationSeconds: total > 0 ? total : null,
        })
        if (failed > 0) {
          setSceneError(
            `Couldn't reuse the original audio for ${failed} segment${failed === 1 ? '' : 's'} — use the run's "Use original" button to retry.`,
          )
        }
      } catch (e) {
        setSceneError(stageError(e))
        patchScene(sceneId, { refineJobId: null })
      } finally {
        pollsInFlight.delete(jobId)
        setRefiningId(null)
      }
    },
    [pollJob, scenes, patchScene, patchSceneEdit, sliceAndUploadSpans, sources],
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
   * Drive a blog-post job to completion and commit the Markdown (issue #68).
   * Shared by the live `generateBlog` action and resume-on-reload; `pollsInFlight`
   * keeps the two from double-polling one job. Clears the post's in-flight job id
   * on any terminal status (success commits the markdown, failure flags `error`).
   */
  const completeBlogJob = useCallback(
    async (jobId: string) => {
      if (pollsInFlight.has(jobId)) return
      pollsInFlight.add(jobId)
      try {
        const { result } = await pollJob(jobId)
        const { markdown } = toBlog(result)
        dispatch(setBlogResult({ markdown }))
      } catch {
        dispatch(setBlogError())
      } finally {
        pollsInFlight.delete(jobId)
      }
    },
    [pollJob, dispatch],
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

  // Cast seeding (story 10b): ensure at least one person exists when the voice
  // step is reached, so the single-narrator common case is one decision with no
  // extra UI. Guard so we don't add if cast already has people.
  useEffect(() => {
    if (cast.length === 0) dispatch(setPeopleCount(1))
  }, [cast.length, dispatch])

  // Back-compat: a pre-cast session had a single legacy `voice` on the slice but
  // no cast entry. Adopt it onto person 1 so old sessions resume without re-picking.
  useEffect(() => {
    if (cast.length === 1 && !cast[0].voice && voice) {
      dispatch(setPersonVoice({ id: cast[0].id, voice }))
    }
  }, [cast, voice, dispatch])

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
      // One decode yields both the uploadable WAV and a compact waveform summary
      // — so the resource card can show a stenograph of the extracted audio
      // without re-decoding the whole clip just to draw it.
      const { wav, peaks } = await extractAudio(file) // real, browser-side
      const wavFile = new File([wav], `${file.name.replace(/\.[^.]+$/, '')}.wav`, {
        type: 'audio/wav',
      })
      const { url } = await uploadReq({ file: wavFile, kind: 'audio' }).unwrap()
      dispatch(setAudioUrl(url))                                       // legacy
      dispatch(setAudioPeaks(peaks))                                   // legacy
      dispatch(patchSource({ id: currentSource?.id ?? 'source-1', patch: { audioUrl: url, audioPeaks: peaks } }))
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

  // Stages ⑤⑥ — the master director (story 03). One multimodal Gemini call gets
  // the timestamped transcript, the director contact sheets, and the user's
  // optional direction, and returns the synopsis + scenes (per-scene refine
  // prompt, original-video span, and cut spans). Marks BOTH the shorten and segment
  // notes done (one call does both), then captures a midpoint thumb per scene
  // for the scene-card art. Replaces the old mocked `buildScenes`.
  const runDirector = useCallback(
    async ({ src }: StepContext) => {
      patch('director', { status: 'active' })
      const ordered = [...sources].sort((a, b) => a.order - b.order)
      const namer = (videoId: string, label: string) =>
        resolvePerson(videoId, label, cast, speakerAssignments)?.name ?? label
      const transcript = combinedTimedTranscript(
        ordered.map((s) => ({ id: s.id, fileName: s.fileName, duration: s.duration, words: s.words })),
        namer,
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
    [patch, sources, persistedSheets, direction, scenesReq, dispatch, completeDirectorJob, cast, speakerAssignments],
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

  // Stage ⑥ — the voice step (story 04). Not run through `next()`: it's owned by
  // the VoiceStudio resource at the bottom of prep, which calls the *ForPerson
  // variants below (story 10b). The legacy single-voice handlers were removed in
  // 10d — use cloneForPerson / pickPresetForPerson / reuseForPerson / clearForPerson
  // / sampleForPerson instead.

  const forgetVoice = useCallback(
    (voiceId: string) => dispatch(removeSavedVoice(voiceId)),
    [dispatch],
  )

  // ---- Cast dispatchers (story 10b) -------------------------------------------
  // Stable `useCallback`-wrapped wrappers around the imported action creators so
  // the references never change between renders. `assignSpeaker` MUST be stable —
  // it's a dep of the seeding effect in Studio.tsx; the others get the same
  // treatment for consistency. Deps: [dispatch] only, since dispatch is itself
  // stable for the lifetime of the store.
  const assignSpeakerCb = useCallback(
    (videoId: string, label: string, personId: string) =>
      dispatch(assignSpeaker({ videoId, label, personId })),
    [dispatch],
  )
  const setPeopleCountCb = useCallback(
    (n: number) => dispatch(setPeopleCount(n)),
    [dispatch],
  )
  const renamePersonCb = useCallback(
    (id: string, name: string) => dispatch(renamePerson({ id, name })),
    [dispatch],
  )
  const removePersonCb = useCallback(
    (id: string) => dispatch(removePerson(id)),
    [dispatch],
  )

  // ---- Person-scoped voice handlers (story 10b) --------------------------------
  // Mirror the single-voice handlers above but target a specific cast person via
  // `setPersonVoice({ id, voice })`. Each person can be cloned/preset/reused
  // independently; the first person's voice mirrors to the legacy `voice` field
  // via the slice reducer. Busy flags (`cloning`, `samplingVoice`) are shared
  // across all persons — only one operation can run at a time, same as before.

  const cloneForPerson = useCallback(
    async (personId: string, blob: Blob) => {
      if (cloning) return
      setCloning(true)
      patch('clone', { status: 'active' })
      try {
        const recorded = new File([blob], 'voice-sample', { type: blob.type || 'audio/webm' })
        const wav = await extractAudioWav(recorded, 24000)
        const file = new File([wav], 'voice-sample.wav', { type: 'audio/wav' })
        const { url: sampleUrl } = await uploadReq({ file, kind: 'voice' }).unwrap()
        const { voiceId } = await voiceCloneReq({ sampleUrl }).unwrap()
        const label = 'Your cloned voice'
        dispatch(setPersonVoice({ id: personId, voice: { voiceId, source: 'clone', label, sampleUrl } }))
        dispatch(addSavedVoice({ voiceId, label }))
        patch('clone', { status: 'done', detail: `cloned voice ready · ${voiceId}` })
      } catch (e) {
        patch('clone', { status: 'error', detail: stageError(e) })
      } finally {
        setCloning(false)
      }
    },
    [cloning, patch, dispatch, uploadReq, voiceCloneReq],
  )

  const pickPresetForPerson = useCallback(
    (personId: string, voiceId: string) => {
      const label = presetLabel(voiceId)
      dispatch(setPersonVoice({ id: personId, voice: { voiceId, source: 'preset', label } }))
      patch('clone', { status: 'done', detail: `preset · ${label}` })
    },
    [dispatch, patch],
  )

  const reuseForPerson = useCallback(
    (personId: string, rawId: string) => {
      const voiceId = rawId.trim()
      if (!voiceId) return
      const label = voiceId
      dispatch(setPersonVoice({ id: personId, voice: { voiceId, source: 'saved', label } }))
      dispatch(addSavedVoice({ voiceId, label }))
      patch('clone', { status: 'done', detail: `saved voice · ${voiceId}` })
    },
    [dispatch, patch],
  )

  const clearForPerson = useCallback(
    (personId: string) => {
      dispatch(setPersonVoice({ id: personId, voice: null }))
      // Only reset the stage if ALL people now have no voice.
      // (If another person still has a voice, the stage stays done.)
      const anyVoiced = cast.some((p) => p.id !== personId && p.voice !== null)
      if (!anyVoiced) patch('clone', { status: 'pending', detail: undefined })
    },
    [dispatch, patch, cast],
  )

  const forgetForPerson = useCallback(
    (voiceId: string) => dispatch(removeSavedVoice(voiceId)),
    [dispatch],
  )

  const sampleForPerson = useCallback(
    async (personId: string): Promise<string | null> => {
      if (samplingVoice) return null
      const person = cast.find((p) => p.id === personId)
      if (!person?.voice) return null
      setSamplingVoice(true)
      try {
        const text = 'Here is a quick sample of how your narration will sound across the scenes.'
        const { audioUrl } = await voiceSayReq({ text, voiceId: person.voice.voiceId }).unwrap()
        return audioUrl
      } finally {
        setSamplingVoice(false)
      }
    },
    [cast, samplingVoice, voiceSayReq],
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
        const { wav, peaks } = await extractAudio(file)
        const wavFile = new File([wav], `${file.name.replace(/\.[^.]+$/, '')}.wav`, { type: 'audio/wav' })
        const { url: aUrl } = await uploadReq({ file: wavFile, kind: 'audio' }).unwrap()
        dispatch(patchSource({ id, patch: { audioUrl: aUrl, audioPeaks: peaks } }))
        dispatch(patchSourceStage({ id, stage, patch: { status: 'done', detail: `16 kHz mono WAV · ${mb(wav.size)}` } }))
        if (isPrimary) {
          dispatch(setAudioUrl(aUrl))
          dispatch(setAudioPeaks(peaks))
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
        else if (id === 'director') await runDirector(ctx) // shorten + segment, one Gemini call
        // 'clone' isn't run here — the VoiceStudio resource owns it (record/clone
        // or pick a preset), so reaching it via the board is a no-op.
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
      if (sheetingId || refiningId) return
      const scene = scenes.find((s) => s.id === id)
      const src = scene && sourceForScene(sources, scene)
      if (!scene || !src?.sourceUrl) return
      setSheetingId(id)
      setSceneError(null)
      // Capture frames off a SAME-ORIGIN blob: URL, never the cross-origin signed
      // bucket URL directly. A `<video crossOrigin>` media read against the GCS
      // object fails CORS (the element's range/preflight isn't satisfied even
      // though GET from this origin is allowed), whereas a plain `fetch` of the
      // bytes is fine. Pull the scene's own source bytes back through the signed
      // URL and wrap them in a blob URL so capture stays same-origin.
      let objectUrl: string | null = null
      try {
        const source = await (await fetch(await signFor(src.sourceUrl))).blob()
        objectUrl = URL.createObjectURL(source)
        const sheets = await captureSceneContactSheet(objectUrl, scene.start, scene.end)
        const uploaded: ContactSheet[] = []
        for (const sheet of sheets) {
          const blob = await (await fetch(sheet.dataUrl)).blob()
          const ext = blob.type === 'image/png' ? 'png' : 'jpg'
          const name = `scene-${scene.index + 1}-sheet-${String(sheet.index + 1).padStart(2, '0')}.${ext}`
          const sheetFile = new File([blob], name, { type: blob.type })
          const { url } = await uploadReq({ file: sheetFile, kind: 'thumbnails' }).unwrap()
          // Persist URL-only — drop the base64 blob so localStorage stays small.
          uploaded.push({ ...sheet, url, dataUrl: '' })
        }
        patchScene(id, { sheets: uploaded })
      } catch (e) {
        setSceneError(stageError(e))
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        setSheetingId(null)
      }
    },
    [sheetingId, refiningId, scenes, sources, signFor, uploadReq, patchScene],
  )

  // Button 2: hand the scene's word timings + the director's refinePrompt +
  // the dense sheets to /api/refine-scene, store the result in
  // `scene.refined` (NON-destructive — the director's baseline cuts are untouched).
  const refineScene = useCallback(
    async (id: string) => {
      if (sheetingId || refiningId) return
      const scene = scenes.find((s) => s.id === id)
      if (!scene) return
      setRefiningId(id)
      setSceneError(null)
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
        // Enqueue-only (story 03f Part 0): returns a job id; the Gemini refine runs
        // in the pipeline's postSteps. Persist the id on the scene so a reload
        // resumes polling, then drive it to completion (writes `scene.refined`).
        const { jobId } = await refineSceneReq({
          start: scene.start,
          end: scene.end,
          wordTimings: sceneWordTimings(scoped),
          sheetUrls,
          audioUrl: scene.clipAudioUrl,
          // Creator steering (story 03l): the scene's own prompt + the global
          // director prompt (subject to the scene's include-checkbox).
          ...refineDirections(scene, direction),
          // Where this scene sits in the arc + the prior scene's lead-in (03r).
          sceneNumber: sceneIndex + 1,
          sceneCount: scenes.length,
          previousContext: prevScene ? sceneTail(prevScene) : '',
        }).unwrap()
        patchScene(id, { refineJobId: jobId })
        await completeRefineJob(id, jobId)
      } catch (e) {
        setSceneError(stageError(e))
        setRefiningId(null)
      }
    },
    [sheetingId, refiningId, scenes, sources, direction, refineSceneReq, patchScene, completeRefineJob],
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

  // Hand-edit a scene's cuts directly on the diff grid (story 03d). `add` paints
  // a new/extended cut over the span; `remove` contracts/splits an existing one.
  // Materializes `refined` from the director baseline on the first edit (same
  // merge as `setSegmentAudio`), tags it `manual`, and NEVER touches `scene.cuts`
  // — so `clearRefinement` still reverts to the AI's first pass cleanly.
  const editSceneCut = useCallback(
    (sceneId: string, span: Cut, op: 'add' | 'remove') => {
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const base =
        scene.refined ?? { segments: effectiveSegments(scene), cuts: scene.cuts ?? [], source: 'ai' as const }
      const cuts = op === 'add' ? addCut(base.cuts, span, scene) : removeCut(base.cuts, span)
      patchSceneEdit(sceneId, { refined: { ...base, cuts, source: 'manual' } })
    },
    [scenes, patchSceneEdit],
  )

  // Adopt a span of the source clip's ORIGINAL audio as a New-pane run (story
  // 03d): slice `[origStart, origEnd]` out of the whole-clip audio, upload it as
  // a real clip, and drop it into the scene at `dropStart`. Since story 03h the
  // drop lands ANYWHERE in the scene (clamped so it never passes `scene.end`) —
  // overlap with existing runs is a legal, flagged state the producer resolves
  // by moving a run. Writes `scene.refined` (`source: 'manual'`), never the
  // director baseline.
  const adoptOriginalAudio = useCallback(
    async (sceneId: string, origStart: number, origEnd: number, dropStart: number) => {
      if (adoptingId) return
      const scene = scenes.find((s) => s.id === sceneId)
      const src = sourceForScene(sources, scene ?? { sourceId: '' })
      if (!scene || !src?.audioUrl) return
      const duration = origEnd - origStart
      const segs = effectiveSegments(scene)
      setAdoptingId(sceneId)
      setSceneError(null)
      try {
        const wav = await sliceAudioWav(src.audioUrl, origStart, origEnd)
        const file = new File([wav], `original-${Math.round(origStart)}-${Math.round(origEnd)}.wav`, {
          type: 'audio/wav',
        })
        const { url } = await uploadReq({ file, kind: 'voice' }).unwrap()
        const measured = await measureAudioDuration(url)
        const len = measured > 0 ? measured : duration
        const start = clampDropStart(scene, dropStart, len)
        const text = src.words
          .filter((w) => w.start >= origStart && w.start < origEnd)
          .map((w) => w.text)
          .join(' ')
        const seg: NarrationSegment = {
          text,
          start,
          end: start + len,
          audioUrl: url,
          audioSeconds: len,
          audioSource: 'original',
        }
        const base =
          scene.refined ?? { segments: segs, cuts: scene.cuts ?? [], source: 'ai' as const }
        const segments = insertSegment(base.segments, seg)
        // Keeping original audio here contradicts a cut over the same span — so
        // un-cut it, otherwise the run would render red (cut wins over voiced).
        const cuts = removeCut(base.cuts, { start: seg.start, end: seg.end })
        const total = segments.reduce((n, s) => n + (s.audioSeconds ?? 0), 0)
        patchSceneEdit(sceneId, {
          refined: { ...base, segments, cuts, source: 'manual' },
          narrationSeconds: total,
        })
      } catch (e) {
        setSceneError(stageError(e))
      } finally {
        setAdoptingId(null)
      }
    },
    [adoptingId, scenes, sources, uploadReq, patchSceneEdit],
  )

  // Cut this scene into its own video clip + soundtrack (story 03g + 03k, build
  // step 0). The raw source is the immutable source of truth — every scene
  // re-reads it: prefer the in-memory `file` (no refetch), else pull the persisted
  // source serve URL back. We trim `[start, end]` frame-accurately in ffmpeg.wasm
  // and slice the same span from the talk WAV, upload both (kind `scene-clip` /
  // `audio`, SEQUENTIALLY — the keep-alive 502 lesson), and persist both serve
  // paths in ONE patch, so the scene gets both resources or neither and a reload
  // resumes with the cut done. Re-cutting overwrites both.
  const sliceScene = useCallback(
    async (sceneId: string) => {
      if (slicingId) return
      const scene = scenes.find((s) => s.id === sceneId)
      const src = scene && sourceForScene(sources, scene)
      if (!scene || !src) return
      setSlicingId(sceneId)
      setSceneError(null)
      try {
        if (!src.audioUrl) throw new Error('No extracted audio to cut the scene soundtrack from.')
        if (!src.sourceUrl) throw new Error('No source clip available to cut from.')
        // Direct bucket read — no `credentials`, it's a presigned URL, and
        // sending cookies cross-origin would fail the CORS check.
        const source = new Uint8Array(await (await fetch(await signFor(src.sourceUrl))).arrayBuffer())

        const command = buildSliceCommand({
          start: scene.start,
          end: scene.end,
          output: `scene-${scene.index}.mp4`,
        })
        const blob = await ffmpegSlice({ source, command })
        const clip = new File([blob], `scene-${scene.index}.mp4`, { type: 'video/mp4' })
        const { url } = await uploadReq({ file: clip, kind: 'scene-clip' }).unwrap()
        const wav = await sliceAudioWav(src.audioUrl, scene.start, scene.end)
        const audioFile = new File([wav], `scene-${scene.index}-audio.wav`, { type: 'audio/wav' })
        const { url: clipAudioUrl } = await uploadReq({ file: audioFile, kind: 'audio' }).unwrap()
        patchSceneEdit(sceneId, { clipUrl: url, clipAudioUrl })
      } catch (e) {
        setSceneError(stageError(e))
      } finally {
        setSlicingId(null)
      }
    },
    [slicingId, scenes, sources, signFor, uploadReq, patchSceneEdit],
  )

  // Delete one New-pane run, reopening its gap (story 03d) — e.g. to clear room
  // for an original-audio clip. Materializes `refined` from the baseline so it's
  // revertible, recomputes the scene's narration length, tags it `manual`.
  const deleteSegment = useCallback(
    (sceneId: string, segIndex: number) => {
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const base =
        scene.refined ?? { segments: effectiveSegments(scene), cuts: scene.cuts ?? [], source: 'ai' as const }
      const segments = removeSegment(base.segments, segIndex)
      const total = segments.reduce((n, s) => n + (s.audioSeconds ?? 0), 0)
      patchSceneEdit(sceneId, { refined: { ...base, segments, source: 'manual' }, narrationSeconds: total })
    },
    [scenes, patchSceneEdit],
  )

  // Re-time one New-pane run (story 03h): drag its voice-control row to a new
  // start, keeping its duration — clamped so its end never passes the scene.
  // Materializes `refined` from the baseline like the other hand-edits, tags it
  // `manual`. The expected way to resolve a flagged overlap.
  const moveRun = useCallback(
    (sceneId: string, segIndex: number, newStart: number) => {
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const base =
        scene.refined ?? { segments: effectiveSegments(scene), cuts: scene.cuts ?? [], source: 'ai' as const }
      const run = base.segments[segIndex]
      if (!run) return
      const segments = moveRunSegments(base.segments, segIndex, newStart, scene)
      // Landing a run on cut footage means you want that footage kept — un-cut
      // beneath its new span (same contradiction rule as adopt), otherwise the
      // moved run renders red and you'd have to hand-un-cut it. Dropping a run
      // you don't want is what delete (✕) is for. The clamp here mirrors the one
      // inside moveRunSegments so the un-cut span is exactly where it landed.
      const duration = run.end - run.start
      const start = clampDropStart(scene, newStart, duration)
      const cuts = removeCut(base.cuts, { start, end: start + duration })
      const total = segments.reduce((n, s) => n + (s.audioSeconds ?? 0), 0)
      patchSceneEdit(sceneId, { refined: { ...base, segments, cuts, source: 'manual' }, narrationSeconds: total })
    },
    [scenes, patchSceneEdit],
  )

  // Throw out the refinement and revert to the director's first pass.
  const clearRefinement = useCallback(
    (id: string) => {
      setSceneError(null)
      patchSceneEdit(id, { refined: null, narrationSeconds: null, promptJobId: undefined })
    },
    [patchSceneEdit],
  )

  // Write one segment's audio back into `scene.refined` (creating a refinement
  // from the baseline if the scene wasn't refined yet), and recompute the scene's
  // total narration length from the voiced segments. Shared by AI + record.
  // The run's `end` snaps to the measured clip length so the footprint shows
  // what will actually play (not the refiner anchor / word-count estimate).
  const setSegmentAudio = useCallback(
    (sceneId: string, segIndex: number, audio: Partial<NarrationSegment>) => {
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const base =
        scene.refined ?? { segments: effectiveSegments(scene), cuts: scene.cuts ?? [], source: 'ai' as const }
      const segments = base.segments.map((seg, i) =>
        i === segIndex
          ? {
              ...seg,
              ...audio,
              ...(audio.audioSeconds != null && audio.audioSeconds > 0
                ? { end: seg.start + audio.audioSeconds }
                : {}),
            }
          : seg,
      )
      const total = segments.reduce((n, s) => n + (s.audioSeconds ?? 0), 0)
      patchSceneEdit(sceneId, { refined: { ...base, segments }, narrationSeconds: total })
    },
    [scenes, patchSceneEdit],
  )

  // Set a per-segment voice override (story 10d): persisted on the non-destructive
  // `refined` layer like every Build edit. The picker UI (10d.2) calls this.
  const setSegmentVoice = useCallback(
    (sceneId: string, segIndex: number, voiceId: string) => {
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const base =
        scene.refined ?? { segments: effectiveSegments(scene), cuts: scene.cuts ?? [], source: 'ai' as const }
      const segments = base.segments.map((seg, i) =>
        i === segIndex ? { ...seg, voiceId } : seg,
      )
      patchScene(sceneId, { refined: { ...base, segments } })
    },
    [scenes, patchScene],
  )

  // Add a hand-typed narration run (the "typed snippet" spec): an unvoiced
  // segment sized by the word-count estimate, dropped anywhere in the scene and
  // voiced later via its Record / AI controls. Same non-destructive layering as
  // adopt-original; cuts are untouched (no audio contradicts a cut).
  const addSnippet = useCallback(
    (sceneId: string, text: string, dropStart: number) => {
      const scene = scenes.find((s) => s.id === sceneId)
      const trimmed = text.trim()
      if (!scene || !trimmed) return
      const len = narrationSeconds(trimmed)
      const start = clampDropStart(scene, dropStart, len)
      const base =
        scene.refined ?? { segments: effectiveSegments(scene), cuts: scene.cuts ?? [], source: 'ai' as const }
      const segments = insertSegment(base.segments, { text: trimmed, start, end: start + len })
      patchScene(sceneId, { refined: { ...base, segments, source: 'manual' } })
    },
    [scenes, patchScene],
  )

  // Voice ONE segment with the saved voice via the persisted-TTS pipeline. The
  // robot/AI option, now per-segment (not the whole scene at once).
  // Voice resolution order: per-segment override → speaker-derived voice → global voice.
  const generateSegmentNarration = useCallback(
    async (sceneId: string, segIndex: number) => {
      if (voicingSegKey) return
      const scene = scenes.find((s) => s.id === sceneId)
      const seg = scene && effectiveSegments(scene)[segIndex]
      if (!seg) return
      const src = scene && sourceForScene(sources, scene)
      const label = src ? dominantSpeaker(src.words, seg.start, seg.end) : null
      const speakerVoice = label && scene
        ? resolveSpeakerVoice(scene.sourceId, label, cast, speakerAssignments)
        : null
      const voiceId = seg.voiceId ?? speakerVoice?.voiceId ?? voice?.voiceId
      if (!voiceId) { setSceneError('Pick a voice for this speaker first.'); return }
      setVoicingSegKey(`${sceneId}:${segIndex}`)
      setSceneError(null)
      try {
        const { audioUrl } = await narrateReq({ text: seg.text, voiceId }).unwrap()
        const audioSeconds = await measureAudioDuration(audioUrl)
        setSegmentAudio(sceneId, segIndex, { audioUrl, audioSeconds, audioSource: 'ai' })
      } catch (e) {
        setSceneError(stageError(e))
      } finally {
        setVoicingSegKey(null)
      }
    },
    [voicingSegKey, scenes, sources, cast, speakerAssignments, voice, narrateReq, setSegmentAudio],
  )

  // Voice ONE segment with the user's OWN recording: re-encode the take to WAV,
  // upload it (reusing the voice/ bucket), measure it, store it on the segment.
  // This is the "record it myself, it's actually me" path.
  const recordSegmentNarration = useCallback(
    async (sceneId: string, segIndex: number, blob: Blob) => {
      if (voicingSegKey) return
      setVoicingSegKey(`${sceneId}:${segIndex}`)
      setSceneError(null)
      try {
        const recorded = new File([blob], 'segment', { type: blob.type || 'audio/webm' })
        const wav = await extractAudioWav(recorded, 24000)
        const file = new File([wav], `segment-${segIndex + 1}.wav`, { type: 'audio/wav' })
        const { url } = await uploadReq({ file, kind: 'voice' }).unwrap()
        const audioSeconds = await measureAudioDuration(url)
        setSegmentAudio(sceneId, segIndex, { audioUrl: url, audioSeconds, audioSource: 'recorded' })
      } catch (e) {
        setSceneError(stageError(e))
      } finally {
        setVoicingSegKey(null)
      }
    },
    [voicingSegKey, uploadReq, setSegmentAudio],
  )

  // One-click "Use original" (story 03j): voice THIS run with the slice of the
  // clip's own audio under its span — the manual completion of an AI 'original'
  // suggestion auto-adopt couldn't finish (or whose audio was later cleared).
  // Same per-segment busy key as the other voicing actions.
  const adoptSegmentOriginal = useCallback(
    async (sceneId: string, segIndex: number) => {
      if (voicingSegKey) return
      const scene = scenes.find((s) => s.id === sceneId)
      const seg = scene && effectiveSegments(scene)[segIndex]
      if (!seg) return
      const src = scene && sourceForScene(sources, scene)
      setVoicingSegKey(`${sceneId}:${segIndex}`)
      setSceneError(null)
      try {
        const [clip] = await sliceAndUploadSpans(src?.audioUrl ?? '', [{ start: seg.start, end: seg.end }])
        if (!clip) throw new Error("Couldn't slice the original audio for this run.")
        setSegmentAudio(sceneId, segIndex, {
          audioUrl: clip.url,
          audioSeconds: clip.seconds,
          audioSource: 'original',
        })
      } catch (e) {
        setSceneError(stageError(e))
      } finally {
        setVoicingSegKey(null)
      }
    },
    [voicingSegKey, scenes, sources, sliceAndUploadSpans, setSegmentAudio],
  )

  // Voice EVERY unvoiced segment in a scene for auto mode (story 03s). Segments the
  // refiner already voiced from the source audio (auto-adopted `original`) keep
  // their audio and are skipped; a still-unvoiced segment the refiner TAGGED
  // `original` is reused from the source audio; every other unvoiced segment gets
  // AI TTS in its resolved voice (per-segment override → speaker voice → global).
  // Sequential — one network call at a time. Builds the new segments array locally
  // and commits in ONE patch (a tight loop of `setSegmentAudio` would merge from a
  // stale `refined` and lose earlier segments). On failure sets `sceneError` and
  // bails WITHOUT a partial commit — auto mode reads `sceneError` to halt; resuming
  // re-voices the scene from its already-voiced segments (the skip keeps it cheap).
  const voiceAllSegments = useCallback(
    async (sceneId: string) => {
      if (voicingSceneId) return
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene) return
      setVoicingSceneId(sceneId)
      setSceneError(null)
      try {
        const src = sourceForScene(sources, scene)
        if (!src?.audioUrl) throw new Error('No source audio for this scene — cut the scene first.')
        const base =
          scene.refined ?? { segments: effectiveSegments(scene), cuts: scene.cuts ?? [], source: 'ai' as const }
        const segments = [...base.segments]
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i]
          if (seg.audioUrl) continue // already voiced (incl. auto-adopted original)
          if (seg.suggestedSource === 'original') {
            const [clip] = await sliceAndUploadSpans(src.audioUrl, [{ start: seg.start, end: seg.end }])
            if (!clip) throw new Error(`Couldn't reuse the original audio for segment ${i + 1}.`)
            segments[i] = {
              ...seg,
              audioUrl: clip.url,
              audioSeconds: clip.seconds,
              audioSource: 'original',
              end: seg.start + clip.seconds,
            }
          } else {
            const label = src ? dominantSpeaker(src.words, seg.start, seg.end) : null
            const speakerVoice =
              label != null ? resolveSpeakerVoice(scene.sourceId, label, cast, speakerAssignments) : null
            const voiceId = seg.voiceId ?? speakerVoice?.voiceId ?? voice?.voiceId
            if (!voiceId)
              throw new Error('Pick a voice before auto-building — segments need a voice to narrate.')
            const { audioUrl } = await narrateReq({ text: seg.text, voiceId }).unwrap()
            const audioSeconds = await measureAudioDuration(audioUrl)
            segments[i] = {
              ...seg,
              audioUrl,
              audioSeconds,
              audioSource: 'ai',
              end: seg.start + (audioSeconds > 0 ? audioSeconds : seg.end - seg.start),
            }
          }
        }
        const total = segments.reduce((n, s) => n + (s.audioSeconds ?? 0), 0)
        patchSceneEdit(sceneId, { refined: { ...base, segments }, narrationSeconds: total > 0 ? total : null })
      } catch (e) {
        setSceneError(stageError(e))
      } finally {
        setVoicingSceneId(null)
      }
    },
    [voicingSceneId, scenes, sources, cast, speakerAssignments, voice, narrateReq, sliceAndUploadSpans, patchSceneEdit],
  )

  // ---- Scene build loop -----------------------------------------------------

  const markBuilt = useCallback(
    (id: string) => {
      const next = scenes.map((s) =>
        s.id === id ? { ...s, status: 'built' as const } : s,
      )
      dispatch(setScenes(next))
      const stillPending = next.find((s) => s.status === 'pending')
      if (stillPending) dispatch(setSelected(stillPending.id))
    },
    [scenes, dispatch],
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
  const generateDescription = useCallback(async () => {
    const req = buildDescribeRequest(scenes, synopsis)
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
  }, [scenes, synopsis, describeReq, dispatch])

  // ---- Export: generate the blog post (issue #68) ---------------------------

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
      const req = buildBlogRequest(scenes, directionInput, { synopsis, description, sheetUrls, duration })
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
    [scenes, sources, persistedSheets, synopsis, description, blogStartReq, dispatch, completeBlogJob],
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
      const req = buildThumbnailDraftRequest(scenes, title, description, notes)
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
    [scenes, thumbnailDraftReq],
  )

  // Render the thumbnail with the (edited) prompt: nano-banana → bucket → serve
  // path, persisted on the project (url-only) so it survives reload + rides
  // server-sync. Stores notes + prompt alongside so the UI can repopulate.
  const renderThumbnail = useCallback(
    async (notes: string, prompt: string) => {
      if (!prompt.trim()) {
        setSceneError('Draft a prompt before generating the image.')
        return
      }
      setRenderingThumbnail(true)
      setSceneError(null)
      try {
        const raw = await thumbnailRenderReq({ prompt, projectId: activeProjectId ?? '' }).unwrap()
        const { imageUrl } = toThumbnailImage(raw)
        dispatch(setYoutubeThumbnail({ notes, prompt, url: imageUrl }))
      } catch (e) {
        setSceneError(stageError(e))
      } finally {
        setRenderingThumbnail(false)
      }
    },
    [thumbnailRenderReq, activeProjectId, dispatch],
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
        const { url } = await uploadReq({ file, kind: 'export' }).unwrap()
        dispatch(setFinalCutUrl(url))
        return url
      } finally {
        setSavingFinalCut(false)
      }
    },
    [uploadReq, dispatch],
  )

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
        const { url } = await uploadReq({ file, kind: 'export' }).unwrap()
        patchScene(sceneId, { assembledUrl: url, status: 'built' })
        return url
      } finally {
        setSavingSceneCutId(null)
      }
    },
    [uploadReq, patchScene],
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
    contactSheets,
    words,
    synopsis,
    voice,
    savedVoices,
    selectedId,
    finalCutUrl,
    savingFinalCut,
    savingSceneCutId,
    running,
    cloning,
    samplingVoice,
    sheetingId,
    refiningId,
    adoptingId,
    slicingId,
    voicingSegKey,
    sceneError,
    ready,
    sourcesReady,
    allBuilt,
    currentStageId,
    next,
    reset,
    select,
    saveFinalCut,
    description,
    describing,
    generateDescription,
    blog,
    generateBlog,
    editDescriptionTitle,
    signFor,
    youtubeThumbnail,
    draftingThumbnail,
    renderingThumbnail,
    draftThumbnailPrompt,
    renderThumbnail,
    saveSceneCut,
    generateSceneSheets,
    refineScene,
    direction,
    setRefinePrompt,
    setIncludeDirection,
    directorPromptJobId,
    rerunDirector,
    editSceneCut,
    adoptOriginalAudio,
    adoptSegmentOriginal,
    addSnippet,
    sliceScene,
    deleteSegment,
    moveRun,
    clearRefinement,
    generateSegmentNarration,
    recordSegmentNarration,
    setSegmentVoice,
    forgetVoice,
    markBuilt,
    voiceAllSegments,
    voicingSceneId,
    toggleBuilt,
    sources,
    processingId,
    processSource,
    processAll,
    // Cast & speaker assignment (story 10b)
    cast,
    speakerAssignments,
    diarize,
    setPeopleCount: setPeopleCountCb,
    renamePerson: renamePersonCb,
    removePerson: removePersonCb,
    assignSpeaker: assignSpeakerCb,
    cloneForPerson,
    pickPresetForPerson,
    reuseForPerson,
    clearForPerson,
    forgetForPerson,
    sampleForPerson,
  }
}
