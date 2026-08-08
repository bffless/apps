/**
 * The Studio's durable business state. Everything here is persisted to
 * localStorage (redux-persist, see `./index.ts`) so a hard reload doesn't lose
 * where you are: the stepper/board progress, the scenes you've built, the
 * transcript, the bucket serve references, and the contact sheets all survive.
 *
 * What is deliberately NOT here (kept as transient React state in the hook/page,
 * fine to lose on reload): the in-memory source `File`/object URL, the scrub
 * `currentTime`, and the `running`/`voicingId` spinners.
 *
 * The raw video blob is never stored — only the relative `/api/uploads/...`
 * serve path (which proxies to the bucket) once the clip has been uploaded.
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { RootState } from './index'
import { STAGE_DEFS, PER_VIDEO_STAGES, type StageId, type StageStatus } from '../lib/pipeline'
import { nextUntitledName, type ProjectMeta } from '../lib/projects'
import { reconcileIndex } from '../lib/projectSync'
import type { Scene } from '../lib/scenes'
import type { AutoBuildRun, AutoHalt, ActiveStep } from '../lib/autoBuild'
import type { VideoDescription } from '../lib/describe'
import type { ContactSheet } from '../lib/frames'
import type { DeadSpan } from '../lib/deadSpace'
import { replaceBlogImageUrl, type BlogImageRef } from '../lib/blog'

/**
 * The Export step's generated blog post (story for issue #68). The Markdown
 * document plus the inputs it was written from: the creator's `direction` and
 * the final `script` it was generated from — the staleness key, so a later
 * story can mark the post stale when the script changes. `status` drives the
 * card's visible state; `jobId` is the in-flight `/api/blog` job so a hard
 * reload resumes polling (mirrors `scenesJobId`). Null until first generated.
 */
export type BlogPost = {
  markdown: string
  direction: string
  script: string
  status: 'idle' | 'running' | 'done' | 'error'
  jobId?: string | null
  /** The post's inline frame images keyed back to the global-timeline second each
   *  was captured at (issue #91) — the memory that lets the producer nudge a bad
   *  frame to a nearby moment. Absent on posts generated before this shipped. */
  frames?: BlogImageRef[]
}

/** A word with its time markers, as transcription returns them. `speaker` is the
 *  diarization label (story 10a), e.g. `SPEAKER_00`; absent on old transcripts. */
export type TranscriptWord = { text: string; start: number; end: number; speaker?: string }

/**
 * Per-step progress — the ONLY dynamic part of the prep board, and all we keep
 * in state (and persist). The step *content* (title, note, where, action label)
 * is static `STAGE_DEFS` and is recombined with this in the hook, so editing the
 * board's shape in `STAGE_DEFS` takes effect immediately without a migration and
 * without bloating localStorage. Keyed by `StageId`; a missing id reads pending.
 */
export type StageProgress = { status: StageStatus; detail?: string }
export type StageProgressMap = Partial<Record<StageId, StageProgress>>

/** Fresh prep board progress: every stage pending. */
export const freshProgress = (): StageProgressMap => {
  const out: StageProgressMap = {}
  for (const s of STAGE_DEFS) out[s.id] = { status: 'pending' }
  return out
}

/**
 * One source video in a multi-video project (story 09a). Everything that used to
 * be a single top-level field (the bucket serve paths, the waveform, the
 * transcript words, the clip duration, the per-video prep progress) now lives
 * here, one per uploaded clip. Whole-project state (global contact sheets,
 * synopsis, direction, scenes, voice, final cut) stays top-level.
 */
export type VideoSource = {
  id: string
  /** Sequence in the final cut + the global-timeline offset. Drag reorders it. */
  order: number
  fileName: string
  duration: number
  sourceUrl: string | null
  audioUrl: string | null
  audioPeaks: number[]
  /** Measured dead space of this source's extracted WAV (story 13c), in
   *  source-local seconds. Null = never measured (audio extracted pre-13c). */
  deadSpace?: DeadSpan[] | null
  words: TranscriptWord[]
  /** In-flight async transcribe job id (story 10e). Transcription runs as a
   *  fire-and-poll job (diarization can exceed the 30s edge timeout), so a hard
   *  reload resumes polling from this; cleared (null) on terminal status. */
  transcribeJobId?: string | null
  /** Per-video prep progress: only the per-video stages (upload/extract/transcribe). */
  stageProgress: StageProgressMap
}

/** Fresh per-video progress: every per-video stage pending. */
export const freshSourceProgress = (): StageProgressMap => {
  const out: StageProgressMap = {}
  for (const id of PER_VIDEO_STAGES) out[id] = { status: 'pending' }
  return out
}

const makeSource = (p: { id: string; fileName: string; duration: number; order: number }): VideoSource => ({
  id: p.id,
  order: p.order,
  fileName: p.fileName,
  duration: p.duration,
  sourceUrl: null,
  audioUrl: null,
  audioPeaks: [],
  deadSpace: null,
  words: [],
  transcribeJobId: null,
  stageProgress: freshSourceProgress(),
})

/**
 * One project's worth of durable working state — what used to be the entire
 * top-level studio slice when there was a single implicit project. Story 11a
 * turns the slice into a keyed collection of these (see `StudioState`), one per
 * project, with reducers re-pointed onto the active project via `active(state)`.
 */
export type ProjectWorkingState = {
  stageProgress: StageProgressMap
  /**
   * Whether the producer has clicked "Continue" to reveal the global plan
   * (thumbnails → voice → director) after their source videos finished
   * processing. Until then the prep view shows only the source queue — the plan
   * stays hidden so it doesn't get ahead of the first job (find & process your
   * clips). Persisted so the reveal survives a reload; cleared when the project's
   * working state is reset. (A plan that's already underway shows regardless —
   * see `planStarted` in the page — so this only gates the not-yet-started case.)
   */
  planRevealed: boolean
  /** Whether transcription should run speaker **diarization** (story 10e). Off by
   *  default (single-narrator = the fast path); the producer flips it on before
   *  processing when a recording has more than one speaker. Persisted. */
  diarize: boolean
  scenes: Scene[]
  /** Relative `/api/uploads/source/...` serve path once uploaded (proxies to bucket). */
  sourceUrl: string | null
  /** Relative `/api/uploads/audio/...` serve path once uploaded. */
  audioUrl: string | null
  /** Compact waveform summary (normalized 0–1 peaks) of the extracted audio. */
  audioPeaks: number[]
  /**
   * Measured dead space of the extracted WAV (story 13c): spans of true silence
   * (per-slice RMS below a threshold), NEVER inferred from gaps between word
   * timestamps. Derived once at extract time (or backfilled from the WAV URL
   * for older projects) and fed to the cut grid — and, later, the refiner
   * (story 13f). A few hundred small numbers at most, so persisting it keeps
   * the url-only rule intact. Null = not measured yet (pre-13c project);
   * distinct from `[]` = measured, no silences found.
   */
  deadSpace: DeadSpan[] | null
  contactSheets: ContactSheet[]
  words: TranscriptWord[]
  /** One-line logline of the whole talk, from the master director (story 03). */
  synopsis: string | null
  /**
   * The creator's free-text direction to the master director (story 03l).
   * Persisted — it's sent with `/api/scenes` at prep time AND forwarded to every
   * per-scene refine in Build (each scene has an include-checkbox), so it must
   * outlive the prep step and survive reloads. Old persisted sessions rehydrate
   * without the key and fall back to '' (top-level persist merge) — no migration.
   */
  direction: string
  /**
   * In-flight master-director job id (story 03f Part 0). The director call is now
   * async fire-and-poll: `/api/scenes` enqueues a job and returns an id we poll on.
   * Persisted so a hard reload resumes polling instead of stranding a running job;
   * cleared (null) once the job reaches a terminal status. (Per-scene refine jobs
   * track their own id on `Scene.refineJobId`.)
   */
  scenesJobId: string | null
  /**
   * Job id of the last SUCCESSFUL master-director run (story 03m) — the prompt
   * disclosure lazy-fetches the job row to show what was sent to Gemini.
   * Separate from `scenesJobId` (in-flight resume pointer, cleared on terminal
   * status so the resume poller never re-runs a finished job).
   */
  directorPromptJobId: string | null
  selectedId: string | null
  /** Source clip duration in seconds (from the <video> metadata). */
  duration: number
  /** Original filename, so a restored session can prompt to re-attach the clip. */
  fileName: string | null
  /**
   * The assembled final cut's `/api/uploads/export/...` serve path once the
   * producer has SAVED it to the bucket (story 05). URL-only, like every other
   * resource — the heavy MP4 blob is never persisted — so a hard reload brings
   * the saved cut back to play/download. Null until saved; re-saving overwrites it.
   */
  finalCutUrl: string | null
  /**
   * The Export page's generated title + summary (from `/api/describe`), plus the
   * final script it was written from — so we can show it cached and only
   * regenerate when the script actually changes. Null until generated; the title
   * is producer-editable. Cleared when the project's working state is reset.
   */
  description: (VideoDescription & { script: string }) | null
  /**
   * The Export page's generated YouTube thumbnail (story 06): the creator's notes,
   * the (edited) image prompt it was rendered from, and the persisted
   * `/api/uploads/youtube-thumbnail/...` serve path. URL-only — the PNG bytes are
   * never persisted; the path is re-signed on load for display/download. Null
   * until rendered; re-rendering overwrites it. Cleared when working state resets.
   */
  youtubeThumbnail: {
    notes: string
    prompt: string
    url: string
    /**
     * Optional reference image the creator uploaded (a face or product shot),
     * persisted url-only like everything else so a reload keeps it attached and
     * re-renders can reuse it without picking the file again.
     */
    referenceUrl?: string
  } | null
  /**
   * The Export page's generated blog post (issue #68): the Markdown document,
   * the creator's direction, the final script it was written from (staleness
   * key), the card status, and the in-flight `/api/blog` job id (so a reload
   * resumes polling). Persisted + synced as part of the working state, so it
   * restores for the same user on another device. Null until first generated.
   */
  blog: BlogPost | null
  /**
   * All source videos in the project (story 09a). Each holds its own per-video
   * prep state (sourceUrl, audioUrl, words, stageProgress, etc.). The single
   * top-level fields (sourceUrl, audioUrl, etc.) remain for backward compat
   * and are retired in a later task.
   */
  sources: VideoSource[]
  /** Auto-build run state (story 03s, reshaped for parallel runs by 03u). Durable
   *  so a reload knows a run was in progress; the orchestrator coerces a persisted
   *  `running` back to `paused` on reload (in-flight browser steps aren't
   *  resumable). The resumable truth is the scenes themselves — this is just
   *  status + the in-flight `active` set + the structured `halt`. */
  autoBuild: AutoBuildRun
}

/** A brand-new, empty project's working state (every prep stage pending). */
export function freshWorkingState(): ProjectWorkingState {
  return {
    stageProgress: freshProgress(),
    planRevealed: false,
    diarize: false,
    scenes: [],
    sourceUrl: null,
    audioUrl: null,
    audioPeaks: [],
    deadSpace: null,
    contactSheets: [],
    words: [],
    synopsis: null,
    direction: '',
    scenesJobId: null,
    directorPromptJobId: null,
    selectedId: null,
    duration: 0,
    fileName: null,
    finalCutUrl: null,
    description: null,
    youtubeThumbnail: null,
    blog: null,
    sources: [],
    autoBuild: { status: 'idle', active: [], halt: null },
  }
}

/**
 * The studio slice is now a keyed collection of projects (story 11a). `index`
 * holds the lightweight per-project metadata (name, phase, thumbnail) for the
 * dashboard; `working` holds the heavy working state keyed by the same id;
 * `activeProjectId` selects which one the project-scoped reducers mutate.
 */
export type StudioState = {
  index: Record<string, ProjectMeta>
  working: Record<string, ProjectWorkingState>
  activeProjectId: string | null
}

const initialState: StudioState = {
  index: {},
  working: {},
  activeProjectId: null,
}

/** The active project's working state, or undefined when none is selected. */
function active(state: StudioState): ProjectWorkingState | undefined {
  return state.activeProjectId ? state.working[state.activeProjectId] : undefined
}

const studioSlice = createSlice({
  name: 'studio',
  initialState,
  reducers: {
    patchStage(state, action: PayloadAction<{ id: StageId; patch: Partial<StageProgress> }>) {
      const w = active(state); if (!w) return
      const prev = w.stageProgress[action.payload.id] ?? { status: 'pending' }
      w.stageProgress[action.payload.id] = { ...prev, ...action.payload.patch }
    },
    /** Mark whichever stage is currently `active` as errored (used on a thrown step). */
    failActiveStage(state, action: PayloadAction<string>) {
      const w = active(state); if (!w) return
      for (const def of STAGE_DEFS) {
        if (w.stageProgress[def.id]?.status === 'active') {
          w.stageProgress[def.id] = { status: 'error', detail: action.payload }
          break
        }
      }
    },
    /** Reveal the global plan once sources are processed (see `planRevealed`). */
    setPlanRevealed(state, action: PayloadAction<boolean>) {
      const w = active(state); if (!w) return
      w.planRevealed = action.payload
    },
    /** Toggle speaker diarization for transcription (story 10e). */
    setDiarize(state, action: PayloadAction<boolean>) {
      const w = active(state); if (!w) return
      w.diarize = action.payload
    },
    setScenes(state, action: PayloadAction<Scene[]>) {
      const w = active(state); if (!w) return
      w.scenes = action.payload
    },
    patchScene(state, action: PayloadAction<{ id: string; patch: Partial<Scene> }>) {
      const w = active(state); if (!w) return
      const scene = w.scenes.find((s) => s.id === action.payload.id)
      if (scene) Object.assign(scene, action.payload.patch)
    },
    setSourceUrl(state, action: PayloadAction<string | null>) {
      const w = active(state); if (!w) return
      w.sourceUrl = action.payload
    },
    setAudioUrl(state, action: PayloadAction<string | null>) {
      const w = active(state); if (!w) return
      w.audioUrl = action.payload
    },
    setAudioPeaks(state, action: PayloadAction<number[]>) {
      const w = active(state); if (!w) return
      w.audioPeaks = action.payload
    },
    /** Measured dead-space spans of the extracted WAV (story 13c). Null resets
     *  to "not measured"; `[]` means measured with no silences found. */
    setDeadSpace(state, action: PayloadAction<DeadSpan[] | null>) {
      const w = active(state); if (!w) return
      w.deadSpace = action.payload
    },
    setContactSheets(state, action: PayloadAction<ContactSheet[]>) {
      const w = active(state); if (!w) return
      w.contactSheets = action.payload
    },
    setWords(state, action: PayloadAction<TranscriptWord[]>) {
      const w = active(state); if (!w) return
      w.words = action.payload
    },
    setSynopsis(state, action: PayloadAction<string | null>) {
      const w = active(state); if (!w) return
      w.synopsis = action.payload
    },
    /** The creator's master-director prompt (story 03l) — see `direction` above. */
    setDirection(state, action: PayloadAction<string>) {
      const w = active(state); if (!w) return
      w.direction = action.payload
    },
    /** The in-flight director job id (story 03f). Null clears it on terminal status. */
    setScenesJobId(state, action: PayloadAction<string | null>) {
      const w = active(state); if (!w) return
      w.scenesJobId = action.payload
    },
    /** Pointer to the last successful director job's row (story 03m). */
    setDirectorPromptJobId(state, action: PayloadAction<string | null>) {
      const w = active(state); if (!w) return
      w.directorPromptJobId = action.payload
    },
    /** Mint a new project (id + timestamp minted by the caller, kept out of the
     *  reducer so it stays pure), name it the next free "Untitled project", seed
     *  its working state, and make it active. */
    createProject(state, action: PayloadAction<{ id: string; now: number }>) {
      const { id, now } = action.payload
      const name = nextUntitledName(Object.values(state.index).map((m) => m.name))
      state.index[id] = { id, name, createdAt: now, updatedAt: now, phase: 'import', thumbnailUrl: null }
      state.working[id] = freshWorkingState()
      state.activeProjectId = id
    },
    /** Select an existing project (no-op if it has no working state). */
    openProject(state, action: PayloadAction<string>) {
      if (state.working[action.payload]) state.activeProjectId = action.payload
    },
    /** Return to the dashboard (no project active). */
    closeProject(state) {
      state.activeProjectId = null
    },
    renameProject(state, action: PayloadAction<{ id: string; name: string; now: number }>) {
      const meta = state.index[action.payload.id]
      if (!meta) return
      meta.name = action.payload.name
      meta.updatedAt = action.payload.now
    },
    deleteProject(state, action: PayloadAction<string>) {
      delete state.index[action.payload]
      delete state.working[action.payload]
      if (state.activeProjectId === action.payload) state.activeProjectId = null
    },
    /** Reset the active project's working state back to fresh (keeps it in the list). */
    resetProject(state) {
      const id = state.activeProjectId
      if (!id) return
      state.working[id] = freshWorkingState()
    },
    /** Internal: applied by the projectMetaSync middleware. Not for direct UI use. */
    _syncMeta(state, action: PayloadAction<{ id: string; phase: ProjectMeta['phase']; thumbnailUrl: string | null; now: number }>) {
      const meta = state.index[action.payload.id]
      if (!meta) return
      meta.phase = action.payload.phase
      meta.thumbnailUrl = action.payload.thumbnailUrl
      meta.updatedAt = action.payload.now
    },
    setSelected(state, action: PayloadAction<string | null>) {
      const w = active(state); if (!w) return
      w.selectedId = action.payload
    },
    setDuration(state, action: PayloadAction<number>) {
      const w = active(state); if (!w) return
      w.duration = action.payload
    },
    setFileName(state, action: PayloadAction<string | null>) {
      const w = active(state); if (!w) return
      w.fileName = action.payload
    },
    /** The saved final cut's serve path (story 05). Re-saving overwrites it;
     *  clearing (null) drops the saved reference without touching anything else. */
    setFinalCutUrl(state, action: PayloadAction<string | null>) {
      const w = active(state); if (!w) return
      w.finalCutUrl = action.payload
    },
    /** Store the Export page's generated title + summary and the script it came
     *  from (so we know when it's stale). */
    setDescription(state, action: PayloadAction<VideoDescription & { script: string }>) {
      const w = active(state); if (!w) return
      w.description = action.payload
    },
    /** The rendered YouTube thumbnail (story 06): notes + prompt + serve path. */
    setYoutubeThumbnail(
      state,
      action: PayloadAction<{ notes: string; prompt: string; url: string } | null>,
    ) {
      const w = active(state); if (!w) return
      w.youtubeThumbnail = action.payload
    },
    /** Producer edit of the recommended title (no-op if nothing's generated yet). */
    setDescriptionTitle(state, action: PayloadAction<string>) {
      const w = active(state); if (!w) return
      if (w.description) w.description.title = action.payload
    },
    /** Mark the blog post running for a fresh `/api/blog` job (issue #68): records
     *  the direction + final script it's being generated from and the job id to
     *  poll, while keeping any prior markdown on screen until the new one lands. */
    setBlogRunning(state, action: PayloadAction<{ direction: string; script: string; jobId: string }>) {
      const w = active(state); if (!w) return
      w.blog = {
        markdown: w.blog?.markdown ?? '',
        direction: action.payload.direction,
        script: action.payload.script,
        status: 'running',
        jobId: action.payload.jobId,
      }
    },
    /** Commit the generated Markdown + its resolved frame sidecar — replaces the
     *  post and clears the in-flight job id (no-op if the blog state was reset out
     *  from under the job). `frames` maps each baked image URL back to the second
     *  it came from, so the producer can re-frame it later (issue #91). */
    setBlogResult(state, action: PayloadAction<{ markdown: string; frames?: BlogImageRef[] }>) {
      const w = active(state); if (!w?.blog) return
      w.blog.markdown = action.payload.markdown
      w.blog.frames = action.payload.frames ?? []
      w.blog.status = 'done'
      w.blog.jobId = null
    },
    /** Re-frame one blog image (issue #91): the producer picked a nearby timestamp
     *  and a fresh frame was captured + uploaded. Point the post at the new URL and
     *  update (or add) its sidecar entry's `time`/`url`, leaving captions + prose
     *  untouched. No-op if there's no post. */
    reframeBlogImage(
      state,
      action: PayloadAction<{ oldUrl: string; newUrl: string; time: number }>,
    ) {
      const w = active(state); if (!w?.blog) return
      const { oldUrl, newUrl, time } = action.payload
      w.blog.markdown = replaceBlogImageUrl(w.blog.markdown, oldUrl, newUrl)
      const refs = w.blog.frames ?? []
      const entry = refs.find((f) => f.url === oldUrl)
      if (entry) {
        entry.url = newUrl
        entry.time = time
      } else {
        refs.push({ url: newUrl, time })
      }
      w.blog.frames = refs
    },
    /** Terminal failure for the blog job: surface the error state, drop the job id. */
    setBlogError(state) {
      const w = active(state); if (!w?.blog) return
      w.blog.status = 'error'
      w.blog.jobId = null
    },
    /** Append a new source video with fresh per-video prep progress (story 09a). */
    addSource(state, action: PayloadAction<{ id: string; fileName: string; duration: number }>) {
      const w = active(state); if (!w) return
      w.sources.push(makeSource({ ...action.payload, order: w.sources.length }))
    },
    /** Shallow-merge `patch` into the source identified by `id`. */
    patchSource(state, action: PayloadAction<{ id: string; patch: Partial<VideoSource> }>) {
      const w = active(state); if (!w) return
      const src = w.sources.find((s) => s.id === action.payload.id)
      if (src) Object.assign(src, action.payload.patch)
    },
    /** Merge `patch` into one prep stage on a specific source. */
    patchSourceStage(state, action: PayloadAction<{ id: string; stage: StageId; patch: Partial<StageProgress> }>) {
      const w = active(state); if (!w) return
      const src = w.sources.find((s) => s.id === action.payload.id)
      if (!src) return
      const prev = src.stageProgress[action.payload.stage] ?? { status: 'pending' }
      src.stageProgress[action.payload.stage] = { ...prev, ...action.payload.patch }
    },
    /** Remove a source by id and renumber `order` on the remaining entries. */
    removeSource(state, action: PayloadAction<string>) {
      const w = active(state); if (!w) return
      w.sources = w.sources.filter((s) => s.id !== action.payload).map((s, i) => ({ ...s, order: i }))
    },
    /** Move a source from index `from` to index `to` and renumber `order`. */
    reorderSources(state, action: PayloadAction<{ from: number; to: number }>) {
      const w = active(state); if (!w) return
      const { from, to } = action.payload
      if (from < 0 || to < 0 || from >= w.sources.length || to >= w.sources.length) return
      const [moved] = w.sources.splice(from, 1)
      w.sources.splice(to, 0, moved)
      w.sources = w.sources.map((s, i) => ({ ...s, order: i }))
    },
    /** Begin / restart an auto-build run; clears any prior halt. */
    startAutoBuild(state) {
      const w = active(state); if (!w) return
      w.autoBuild.status = 'running'
      w.autoBuild.halt = null
    },
    /** Pause: no NEW steps start; in-flight steps run to completion. */
    pauseAutoBuild(state) {
      const w = active(state); if (!w) return
      if (w.autoBuild.status === 'running') w.autoBuild.status = 'paused'
    },
    /** Resume a paused or halted run; clears the halt. */
    resumeAutoBuild(state) {
      const w = active(state); if (!w) return
      if (w.autoBuild.status === 'paused' || w.autoBuild.status === 'halted') {
        w.autoBuild.status = 'running'
        w.autoBuild.halt = null
      }
    },
    /** End the run, leaving completed scene work intact. */
    stopAutoBuild(state) {
      const w = active(state); if (!w) return
      w.autoBuild = { status: 'idle', active: [], halt: null }
    },
    /** Stop on an error, recording WHICH step failed. In-flight siblings still
     *  finish (their autoStepFinished lands after this). */
    haltAutoBuild(state, action: PayloadAction<AutoHalt>) {
      const w = active(state); if (!w) return
      w.autoBuild.status = 'halted'
      w.autoBuild.halt = action.payload
    },
    /** Drop a halt whose step has since been done by hand (`isHaltStale`),
     *  leaving the run paused and resumable. */
    clearAutoHalt(state) {
      const w = active(state); if (!w) return
      if (w.autoBuild.status !== 'halted') return
      w.autoBuild.status = 'paused'
      w.autoBuild.halt = null
    },
    /** The run finished every scene (and the final stitch). */
    completeAutoBuild(state) {
      const w = active(state); if (!w) return
      w.autoBuild.status = 'done'
    },
    /** A step began executing (idempotent per step). */
    autoStepStarted(state, action: PayloadAction<ActiveStep>) {
      const w = active(state); if (!w) return
      const a = action.payload
      if (!w.autoBuild.active.some((x) => x.sceneId === a.sceneId && x.stepId === a.stepId))
        w.autoBuild.active.push(a)
    },
    /** A step finished (successfully or not) — drop it from the active set. */
    autoStepFinished(state, action: PayloadAction<ActiveStep>) {
      const w = active(state); if (!w) return
      const a = action.payload
      w.autoBuild.active = w.autoBuild.active.filter(
        (x) => !(x.sceneId === a.sceneId && x.stepId === a.stepId),
      )
    },
    /** Server sync: replace the working state for a project with the server copy. */
    hydrateProject(state, action: PayloadAction<{ id: string; working: ProjectWorkingState }>) {
      state.working[action.payload.id] = action.payload.working
    },
    /** Server sync: keep only the given project's working state, dropping every
     *  other project's working (index/meta untouched). Idempotent — used on
     *  ENTERING a project so eviction is StrictMode-safe (mount→unmount→mount). */
    evictOthers(state, action: PayloadAction<string>) {
      for (const id of Object.keys(state.working)) {
        if (id !== action.payload) delete state.working[id]
      }
    },
    /** Server sync: merge server project metas into the local index. */
    reconcileServerIndex(state, action: PayloadAction<ProjectMeta[]>) {
      state.index = reconcileIndex(state.index, action.payload)
    },
  },
})

export const {
  patchStage,
  failActiveStage,
  setPlanRevealed,
  setDiarize,
  setScenes,
  patchScene,
  setSourceUrl,
  setAudioUrl,
  setAudioPeaks,
  setDeadSpace,
  setContactSheets,
  setWords,
  setSynopsis,
  setDirection,
  setScenesJobId,
  setDirectorPromptJobId,
  createProject,
  openProject,
  closeProject,
  renameProject,
  deleteProject,
  resetProject,
  _syncMeta, // internal: dispatched by the projectMetaSync middleware, not for direct UI use
  setSelected,
  setDuration,
  setFileName,
  setFinalCutUrl,
  setDescription,
  setYoutubeThumbnail,
  setDescriptionTitle,
  setBlogRunning,
  setBlogResult,
  reframeBlogImage,
  setBlogError,
  addSource,
  patchSource,
  patchSourceStage,
  removeSource,
  reorderSources,
  startAutoBuild,
  pauseAutoBuild,
  resumeAutoBuild,
  stopAutoBuild,
  haltAutoBuild,
  clearAutoHalt,
  completeAutoBuild,
  autoStepStarted,
  autoStepFinished,
  hydrateProject,
  evictOthers,
  reconcileServerIndex,
} = studioSlice.actions

/** Frozen empty working state — a STABLE reference so useSelector reads don't
 *  thrash when no project is open. */
export const EMPTY_WORKING: ProjectWorkingState = Object.freeze(freshWorkingState()) as ProjectWorkingState

export const selectActive = (s: RootState): ProjectWorkingState =>
  s.studio.activeProjectId ? (s.studio.working[s.studio.activeProjectId] ?? EMPTY_WORKING) : EMPTY_WORKING

export const selectActiveProjectId = (s: RootState): string | null => s.studio.activeProjectId

export const selectProjectList = (s: RootState): ProjectMeta[] =>
  Object.values(s.studio.index).sort((a, b) => b.updatedAt - a.updatedAt)

export default studioSlice.reducer
