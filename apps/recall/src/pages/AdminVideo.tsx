/**
 * Admin video detail/edit form (Task 5) + ingest dropzone (Task 6) +
 * source-video player/transcript panel (PR-feedback-1). Title/description/
 * YouTube-URL editing with live `extractYouTubeId` feedback, save-via-
 * `saveVideo`, delete-with-confirm, a drag/drop or click-to-pick source-video
 * uploader that drives `useIngest` through upload -> extract -> upload-audio
 * -> transcribe, and — once there's something to show — a signed-URL
 * `<video>` player plus a click-to-seek transcript panel so uploading and
 * transcribing actually FEEL like they did something (live-testing feedback:
 * the dropzone gave no confirmation, the video was unwatchable, and the
 * transcript was invisible).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { StatusPill } from '../components/StatusPill'
import { TranscriptView, type TranscriptWord } from '../components/TranscriptView'
import { useIndexJob, type IndexStage } from '../hooks/useIndexJob'
import { useIngest, type IngestStage } from '../hooks/useIngest'
import { captureFrameSheets, uploadFrameSheets } from '../lib/frames'
import { normalizeSheets, spriteStyle, type SheetMeta } from '../lib/sprite'
import { extractYouTubeId } from '../lib/youtube'
import {
  useDeleteVideoMutation,
  useGetAdminVideoQuery,
  useLazySignDownloadQuery,
  useSaveVideoMutation,
  useUnpublishMutation,
  type Video,
} from '../store/videosApi'

/**
 * Parse the admin `GET /api/videos/get` raw `transcript` string into
 * `{words}` for `TranscriptView`, tolerating a null/malformed value (a draft
 * video has no transcript yet; a hand-edited record could be garbage) by
 * returning `null` rather than throwing.
 */
function parseTranscript(raw: string | null): { words: TranscriptWord[] } | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { words?: unknown }
    if (!Array.isArray(parsed.words)) return null
    return { words: parsed.words as TranscriptWord[] }
  } catch {
    return null
  }
}

export function AdminVideo() {
  const { videoId } = useParams<{ videoId: string }>()

  const { data, isLoading, isError } = useGetAdminVideoQuery(videoId ?? '', { skip: !videoId })

  if (!videoId) return null

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10 text-slate-500 dark:text-slate-400">
        Loading…
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10 text-red-600 dark:text-red-400">
        Couldn't load this video.
      </div>
    )
  }

  // Keying the form on the loaded video's id gives each fresh load a fresh
  // React instance, so its editable state can simply initialize FROM the
  // fetched record (no effect needed to sync a query result into local state —
  // see https://react.dev/learn/you-might-not-need-an-effect).
  return <VideoForm key={data.video.id} videoId={videoId} video={data.video} />
}

const STAGE_LABELS: Record<IngestStage, string> = {
  idle: 'Idle',
  uploading: 'Uploading video…',
  frames: 'Capturing frames…',
  extracting: 'Extracting audio…',
  'uploading-audio': 'Uploading audio…',
  transcribing: 'Transcribing…',
  done: 'Transcribed',
  error: 'Error',
}

const STAGE_STYLES: Record<IngestStage, string> = {
  idle: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  uploading: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  frames: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  extracting: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'uploading-audio': 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  transcribing: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  done: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

/**
 * Parse the persisted `sheet_meta` JSON string, tolerating a null/malformed
 * value (no sheet yet, or a hand-edited record) the same way
 * `parseTranscript` does above. Accepts BOTH shapes (see `lib/sprite.ts`):
 * v1 (`{ tiles }`, PR-feedback-2) and v2 (`{ v: 2, sheets }`,
 * PR-feedback-6) — validates whichever array the tagged shape implies.
 */
function parseSheetMeta(raw: string | null): SheetMeta | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { v?: number; tiles?: unknown; sheets?: unknown }
    if (parsed.v === 2) {
      return Array.isArray(parsed.sheets) ? (parsed as SheetMeta) : null
    }
    return Array.isArray(parsed.tiles) ? (parsed as SheetMeta) : null
  } catch {
    return null
  }
}

/** Total tile count across every sheet (v1 has exactly one implicit sheet). */
function totalTiles(meta: SheetMeta): number {
  return normalizeSheets(meta).reduce((sum, sheet) => sum + sheet.tiles.length, 0)
}

type FramesBackfillStage = 'idle' | 'signing' | 'capturing' | 'uploading' | 'done' | 'error'

const FRAMES_BACKFILL_LABELS: Record<FramesBackfillStage, string> = {
  idle: 'Generate frames',
  signing: 'Signing…',
  capturing: 'Capturing frames…',
  uploading: 'Uploading…',
  done: 'Generate frames',
  error: 'Generate frames',
}

/**
 * Shared "(re)generate the contact sheet(s) from a signed source URL" flow
 * (PR-feedback-2, extended PR-feedback-5, made multi-sheet-aware in
 * PR-feedback-6): fetches a signed download URL for the already-uploaded
 * `source_path` (the same presigned-GET flow `SourceVideoPlayer` uses),
 * captures densely-spaced frames from it packed into one or more sheets (the
 * bucket CORS that already allows our origin for `SourceVideoPlayer`'s
 * playback also makes the canvas capture untainted), uploads EACH sheet
 * (looped — `uploadFrameSheets` mints one presigned PUT per sheet file), and
 * saves `sheet_path`/`sheet_meta` onto the record — same flow
 * `useIngest`'s automatic `frames` stage runs for a fresh upload, just
 * sourced from a signed URL instead of the local File. Shared by
 * `FramesBackfill` (the "no sheet yet" button) and `FramesGrid`'s
 * "Regenerate" affordance (the "sheet exists, make a new one" case) — same
 * flow, same code, different trigger label.
 */
function useFramesGenerate(videoId: string, video: Video) {
  const [stage, setStage] = useState<FramesBackfillStage>('idle')
  const [error, setError] = useState<string | null>(null)
  const [saveVideo] = useSaveVideoMutation()
  const [triggerSign] = useLazySignDownloadQuery()
  const { refetch } = useGetAdminVideoQuery(videoId, { skip: !videoId })

  const busy = stage === 'signing' || stage === 'capturing' || stage === 'uploading'

  async function generate() {
    if (!video.source_path) return
    setError(null)
    try {
      setStage('signing')
      const { url } = await triggerSign(video.source_path).unwrap()

      setStage('capturing')
      const captured = await captureFrameSheets(url)
      if (captured.sheets.length === 0) {
        throw new Error("Couldn't capture any frames from this video.")
      }

      setStage('uploading')
      const uploaded = await uploadFrameSheets(captured, videoId)
      if (!uploaded) {
        throw new Error("Couldn't upload the captured frames.")
      }
      await saveVideo({ videoId, sheet_path: uploaded.sheet_path, sheet_meta: uploaded.sheet_meta }).unwrap()

      setStage('done')
      void refetch()
    } catch (e) {
      setStage('error')
      setError(e instanceof Error && e.message ? e.message : "Couldn't generate frames.")
    }
  }

  return { stage, error, busy, generate }
}

/**
 * Backfill button + status pill for videos uploaded before contact sheets
 * existed (PR-feedback-2). Hidden once a sheet already exists (the richer
 * `FramesGrid` section takes over — this just shows the "Frames ✓" pill
 * instead) or before any source video has been uploaded (nothing to capture
 * from yet).
 */
function FramesBackfill({ videoId, video }: { videoId: string; video: Video }) {
  const { stage, error, busy, generate } = useFramesGenerate(videoId, video)
  const sheetMeta = parseSheetMeta(video.sheet_meta)

  if (video.sheet_path && sheetMeta) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
        Frames ✓ · {totalTiles(sheetMeta)} tiles
      </span>
    )
  }

  if (!video.source_path) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => {
          void generate()
        }}
        disabled={busy}
        className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
      >
        {FRAMES_BACKFILL_LABELS[stage]}
      </button>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}

/**
 * Visual contact-sheet section (PR-feedback-5, made multi-sheet-aware +
 * lazy-loaded in PR-feedback-6): once the record has a sheet, shows every
 * tile across every sheet as a 5-per-row grid, each cropped out of ITS OWN
 * sheet image via `sprite.ts`'s `spriteStyle` (same math `MomentChip` uses
 * on the public search side, just at a larger 160×90 display size) with its
 * `mm:ss` timestamp captioned beneath. Clicking a tile seeks the admin
 * `<video>` player via `onSeek` — the same seek path `TranscriptPanel` uses
 * (`VideoForm`'s `handleSeek`), so a click here jumps the player exactly
 * like clicking a transcript span does. The header's "Regenerate" button
 * reuses `useFramesGenerate`'s flow. Renders nothing until there's a sheet
 * to show — `FramesBackfill` (above, in `IngestPanel`) covers the "no sheet
 * yet" state.
 *
 * Each tile is its own `<img loading="lazy">` (PR-feedback-7, replacing an
 * earlier hidden-warmer-plus-CSS-`background-image` design — see below),
 * absolutely positioned inside a small `overflow-hidden` frame and scaled up
 * to the full sheet's size so only its own tile shows through, the same
 * offset math `spriteStyle` already computed for `background-position` but
 * as raw numbers (`sheetWidth`/`sheetHeight`/`offsetX`/`offsetY`) instead of
 * a CSS shorthand string. Every tile from the same sheet shares that sheet's
 * `src`, so the browser fetches the image once and serves the rest from
 * cache — same "fetch once, crop many" behavior as the old approach, but the
 * lazy/eager decision is now native browser viewport-proximity on a REAL,
 * rendered element instead of on a same-URL warmer `<img>` kept permanently
 * `display: none`.
 *
 * That earlier design was the actual first-load bug (see PR-feedback-7's
 * report): `loading="lazy"` on an `<img>` with no layout box (`display:
 * none`) has no box for the browser to test against the viewport, so
 * whether/when it ever fires `load` is undefined browser behavior — CSS
 * `background-image` can't be natively lazy-loaded at all, which is why that
 * design needed a warmer in the first place. Rendering the real, visible
 * `<img>` sidesteps both problems: it has genuine geometry to test, and it
 * IS the pixels shown, so nothing else has to react to its `load` event.
 */
const FRAMES_GRID_TILE_DISPLAY_W = 160

/**
 * `mm:ss` for a tile's own timestamp — NOT `formatDuration` above, which
 * treats `0` as "unknown" (`'—'`, for a video's not-yet-extracted duration)
 * and would wrongly blank out the very first tile's genuine `0:00`.
 */
function formatTileTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

export function FramesGrid({
  videoId,
  video,
  onSeek,
}: {
  videoId: string
  video: Video
  onSeek: (sec: number) => void
}) {
  const { stage, error, busy, generate } = useFramesGenerate(videoId, video)
  const sheetMeta = parseSheetMeta(video.sheet_meta)

  if (!video.sheet_path || !sheetMeta) return null
  const sheets = normalizeSheets(sheetMeta, video.sheet_path)
  if (sheets.every((s) => s.tiles.length === 0)) return null

  return (
    <section className="mt-8 border-t border-slate-200 pt-6 dark:border-slate-800">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Frames
        </h2>
        <button
          type="button"
          onClick={() => {
            void generate()
          }}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
        >
          {busy ? FRAMES_BACKFILL_LABELS[stage] : 'Regenerate'}
        </button>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {sheets.map((sheet, sheetIndex) =>
          sheet.tiles.map((tile, tileIndex) => {
            const style = spriteStyle(sheetMeta, tileIndex, FRAMES_GRID_TILE_DISPLAY_W)
            if (!style || !sheet.url) return null
            return (
              <button
                key={`${sheetIndex}-${tileIndex}`}
                type="button"
                onClick={() => onSeek(tile.t)}
                className="group flex flex-col items-center gap-1"
              >
                <span
                  className="relative block overflow-hidden rounded bg-slate-200 ring-1 ring-transparent transition-all group-hover:ring-blue-500 dark:bg-slate-800"
                  style={{ width: style.width, height: style.height }}
                >
                  <img
                    src={sheet.url}
                    loading="lazy"
                    decoding="async"
                    alt=""
                    draggable={false}
                    className="absolute max-w-none"
                    style={{
                      width: style.sheetWidth,
                      height: style.sheetHeight,
                      left: style.offsetX,
                      top: style.offsetY,
                    }}
                  />
                </span>
                <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                  {formatTileTime(tile.t)}
                </span>
              </button>
            )
          }),
        )}
      </div>

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  )
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Signed-URL `<video>` player for an admin-uploaded source (PR-feedback-1).
 * Fetches a fresh presigned bucket URL on mount and re-fetches on `<video>`
 * error (the signature expires after 1h — see `signDownload` in
 * `store/videosApi.ts`); a simple mount/error refetch is enough here, no
 * Studio-style cache-hold needed for a single detail-page player.
 * `videoRef` is a callback ref so the parent (`VideoForm`) learns the live
 * `<video>` element the moment it mounts/unmounts, for transcript seeking.
 */
function SourceVideoPlayer({
  sourcePath,
  videoRef,
}: {
  sourcePath: string
  videoRef: (el: HTMLVideoElement | null) => void
}) {
  const [triggerSign, { data, isFetching, isError }] = useLazySignDownloadQuery()

  useEffect(() => {
    void triggerSign(sourcePath)
  }, [sourcePath, triggerSign])

  return (
    <div className="aspect-video max-h-96 w-full overflow-hidden rounded-lg bg-black">
      {data?.url ? (
        <video
          ref={videoRef}
          data-testid="source-video-player"
          controls
          preload="metadata"
          className="h-full w-full"
          src={data.url}
          onError={() => {
            void triggerSign(sourcePath)
          }}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-slate-400">
          {isError ? "Couldn't load the video preview. Retrying…" : isFetching ? 'Loading preview…' : null}
        </div>
      )}
    </div>
  )
}

/**
 * Pick the "Source video" section's status pill (Task 3, clear stage
 * feedback). While an ingest run is actually in flight this session
 * (`stage !== 'idle'`), the live `useIngest` stage wins — same labels/styles
 * as before. Once it's back to `idle` (a fresh page load, or between runs),
 * fall back to the PERSISTED record: still-transcribing/error notes from an
 * earlier session, a transcribed-with-word-count summary, or a plain
 * "Uploaded ✓" once there's a source file and nothing else to report yet —
 * replacing what used to be a bare, context-free "Idle" pill next to an
 * empty-looking dropzone.
 */
function describeStagePill(
  stage: IngestStage,
  video: Video,
  transcriptWordCount: number | null,
): { label: string; style: string } {
  if (stage !== 'idle') {
    return { label: STAGE_LABELS[stage], style: STAGE_STYLES[stage] }
  }
  if (video.status === 'transcribing') {
    return { label: STAGE_LABELS.transcribing, style: STAGE_STYLES.transcribing }
  }
  if (video.status === 'error') {
    return { label: STAGE_LABELS.error, style: STAGE_STYLES.error }
  }
  if (transcriptWordCount != null) {
    return {
      label: `Transcribed ✓ · ${transcriptWordCount} words · ${formatDuration(video.duration)}`,
      style: STAGE_STYLES.done,
    }
  }
  if (video.source_path) {
    return { label: 'Uploaded ✓', style: STAGE_STYLES.done }
  }
  return { label: STAGE_LABELS.idle, style: STAGE_STYLES.idle }
}

/**
 * Drag/drop or click-to-pick source-video uploader (Task 6), now fronted by
 * the uploaded video's own player once there's a `source_path` (PR-feedback-1)
 * — the dropzone only reappears once "Replace video" is clicked (or there's
 * nothing uploaded yet), instead of always showing "Drop a video file here"
 * even right after a successful upload. Still drives `useIngest` through its
 * staged pipeline and surfaces stage pills, the extracted duration, and any
 * error with a retry action.
 */
function IngestPanel({
  videoId,
  video,
  transcriptWordCount,
  onVideoRef,
}: {
  videoId: string
  video: Video
  transcriptWordCount: number | null
  onVideoRef: (el: HTMLVideoElement | null) => void
}) {
  const { stage, progress, error, start, retryTranscribe, canRetry } = useIngest(videoId)
  const [dragOver, setDragOver] = useState(false)
  const sourcePath = video.source_path
  const [showUploader, setShowUploader] = useState(!sourcePath)

  // "Adjusting state when a prop changes" (see
  // https://react.dev/learn/you-might-not-need-an-effect) rather than an
  // effect: as soon as a fresh `source_path` lands (the upload step of
  // `useIngest`'s pipeline saves it well before transcription finishes), the
  // dropzone collapses back to the player view automatically — no reason to
  // keep showing "Drop a video file here" once there's a fresh source to
  // watch, and no `useEffect`+`setState` cascade needed to do it.
  const [trackedSourcePath, setTrackedSourcePath] = useState(sourcePath)
  if (sourcePath !== trackedSourcePath) {
    setTrackedSourcePath(sourcePath)
    if (sourcePath) setShowUploader(false)
  }

  // The transcribe rule writes transcript/status/duration onto the video
  // record OUT OF BAND (postSteps, after this component's own `getAdminVideo`
  // fetched it) — RTK Query has no tag to invalidate for that, so refetch by
  // hand once the poll loop reaches a terminal stage. `useGetAdminVideoQuery`
  // with the same arg as `AdminVideo`'s dedupes onto the same cache entry, so
  // this doesn't add an extra request — just a handle to `refetch`.
  const { refetch } = useGetAdminVideoQuery(videoId, { skip: !videoId })
  useEffect(() => {
    if (stage === 'done' || stage === 'error') {
      void refetch()
    }
  }, [stage, refetch])

  const busy = stage !== 'idle' && stage !== 'error' && stage !== 'done'

  function pickFile(file: File | undefined | null) {
    if (!file || busy) return
    void start(file)
  }

  function handleDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    setDragOver(false)
    pickFile(e.dataTransfer.files[0])
  }

  const pill = describeStagePill(stage, video, transcriptWordCount)

  return (
    <section className="mt-8 border-t border-slate-200 pt-6 dark:border-slate-800">
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Source video
      </h2>

      {sourcePath && !showUploader ? (
        <div className="flex flex-col gap-3">
          <SourceVideoPlayer sourcePath={sourcePath} videoRef={onVideoRef} />
          <div>
            <button
              type="button"
              onClick={() => setShowUploader(true)}
              className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
            >
              Replace video
            </button>
          </div>
        </div>
      ) : (
        <label
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm transition-colors ${
            busy ? 'pointer-events-none cursor-not-allowed opacity-60' : 'cursor-pointer'
          } ${
            dragOver
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
              : 'border-slate-300 text-slate-500 hover:border-slate-400 dark:border-slate-700 dark:text-slate-400'
          }`}
        >
          <input
            type="file"
            accept="video/*"
            className="sr-only"
            disabled={busy}
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
          <span>Drop a video file here, or click to choose one</span>
          <span className="text-xs text-slate-400 dark:text-slate-500">MP4, MOV, … up to 2 GB</span>
        </label>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span
          data-testid="ingest-stage-pill"
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${pill.style}`}
        >
          {pill.label}
        </span>
        {progress.durationSec != null && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Duration: {formatDuration(progress.durationSec)}
          </span>
        )}
        {stage === 'idle' && video.status === 'transcribing' && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Transcription is already in progress from an earlier session — this tab doesn't
            resume the poll on its own, reload once it finishes.
          </span>
        )}
        {stage === 'idle' && <FramesBackfill videoId={videoId} video={video} />}
      </div>

      {error && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          {canRetry && (
            <button
              type="button"
              onClick={() => {
                void retryTranscribe()
              }}
              className="rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              Retry transcription
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * Transcript panel (PR-feedback-1): the admin equivalent of `Video.tsx`'s
 * public click-to-seek `TranscriptView`, but seeking a REAL `<video>` element
 * instead of a YouTube iframe, so `activeSec` can track genuine playback
 * (via `timeupdate`) instead of only the last manually-seeked second.
 */
function TranscriptPanel({
  words,
  duration,
  onSeek,
  activeSec,
}: {
  words: TranscriptWord[]
  duration: number
  onSeek: (sec: number) => void
  activeSec?: number
}) {
  return (
    <section className="mt-8 border-t border-slate-200 pt-6 dark:border-slate-800">
      <h2 className="mb-1 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Transcript
      </h2>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        {words.length} words · {formatDuration(duration)}
      </p>
      <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <TranscriptView words={words} onSeek={onSeek} activeSec={activeSec} />
      </div>
    </section>
  )
}

const INDEX_STAGE_LABELS: Record<IndexStage, string> = {
  idle: 'Publish',
  indexing: 'Indexing…',
  done: 'Publish',
  error: 'Publish',
}

/**
 * Publish/unpublish controls (Task 8). "Publish" (or "Re-index" once already
 * published) is disabled until the video has a valid YouTube URL and is at
 * least `transcribed`; it drives `useIndexJob`'s enqueue+poll loop the same
 * way `IngestPanel` drives `useIngest`'s. "Unpublish" only shows once
 * published and is a single synchronous mutation (no job to poll — see
 * `rules/api/unpublish/post/rule.yaml`).
 */
function PublishPanel({ videoId, video }: { videoId: string; video: Video }) {
  const { stage, error, start } = useIndexJob(videoId)
  const [unpublish, { isLoading: unpublishing, error: unpublishError }] = useUnpublishMutation()

  // Same out-of-band-write problem as IngestPanel: the index rule writes the
  // video record's status/transcript embeddings from its postSteps, outside
  // this component's own `getAdminVideo` fetch, so refetch by hand once the
  // job reaches a terminal stage.
  const { refetch } = useGetAdminVideoQuery(videoId, { skip: !videoId })
  useEffect(() => {
    if (stage === 'done' || stage === 'error') {
      void refetch()
    }
  }, [stage, refetch])

  const youtubeId = video.youtube_url ? extractYouTubeId(video.youtube_url) : null
  const eligible =
    !!youtubeId && (video.status === 'transcribed' || video.status === 'published')
  const busy = stage === 'indexing'
  const publishLabel =
    stage === 'idle' && video.status === 'published' ? 'Re-index' : INDEX_STAGE_LABELS[stage]

  return (
    <section className="mt-8 border-t border-slate-200 pt-6 dark:border-slate-800">
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Publish
      </h2>

      <div className="flex flex-wrap items-center gap-3">
        <StatusPill status={video.status} />

        <button
          type="button"
          onClick={() => {
            void start()
          }}
          disabled={!eligible || busy}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {publishLabel}
        </button>

        {video.status === 'published' && (
          <button
            type="button"
            onClick={() => {
              void unpublish({ videoId })
            }}
            disabled={unpublishing}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
          >
            {unpublishing ? 'Unpublishing…' : 'Unpublish'}
          </button>
        )}
      </div>

      {!eligible && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Add a valid YouTube URL and finish transcribing before publishing.
        </p>
      )}
      {video.status === 'transcribed' && !video.sheet_path && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          No frames yet — generate frames for search thumbnails.
        </p>
      )}
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {unpublishError && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">Couldn't unpublish. Try again.</p>
      )}
    </section>
  )
}

function VideoForm({ videoId, video }: { videoId: string; video: Video }) {
  const navigate = useNavigate()
  const [saveVideo, { isLoading: saving }] = useSaveVideoMutation()
  const [deleteVideo, { isLoading: deleting }] = useDeleteVideoMutation()

  const [title, setTitle] = useState(video.title ?? '')
  const [description, setDescription] = useState(video.description ?? '')
  const [youtubeUrl, setYoutubeUrl] = useState(video.youtube_url ?? '')
  const [saveError, setSaveError] = useState<string | null>(null)

  const trimmedUrl = youtubeUrl.trim()
  const youtubeId = trimmedUrl ? extractYouTubeId(trimmedUrl) : null
  const youtubeUrlValid = trimmedUrl === '' || youtubeId !== null

  // Shared with `IngestPanel`'s `<video>` element (PR-feedback-1). The
  // element itself lives in a plain `useRef` (mutable by design — setting
  // `.currentTime` on it is a DOM operation, not a React state mutation);
  // `videoMounted` is a separate boolean piece of STATE that only exists to
  // make this component re-render — and re-run the `timeupdate` effect below
  // — the moment the player actually mounts/unmounts (it may not exist yet
  // on first render with no `source_path`, or may unmount when "Replace
  // video" reopens the dropzone).
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const [videoMounted, setVideoMounted] = useState(false)
  const setVideoEl = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el
    setVideoMounted(el !== null)
  }, [])

  const [activeSec, setActiveSec] = useState<number | undefined>(undefined)
  const lastActiveSecUpdateRef = useRef(0)

  // Track the real playhead (throttled ~500ms) so `TranscriptPanel` can
  // highlight whichever span is playing RIGHT NOW, not just the last span the
  // admin manually clicked — unlike the public `Video.tsx` page, this is a
  // real `<video>` element, so genuine `timeupdate` tracking works.
  useEffect(() => {
    const el = videoElRef.current
    if (!el) return
    function handleTimeUpdate() {
      const now = Date.now()
      if (now - lastActiveSecUpdateRef.current < 500) return
      lastActiveSecUpdateRef.current = now
      setActiveSec(el?.currentTime)
    }
    el.addEventListener('timeupdate', handleTimeUpdate)
    return () => el.removeEventListener('timeupdate', handleTimeUpdate)
  }, [videoMounted])

  function handleSeek(sec: number) {
    setActiveSec(sec)
    const el = videoElRef.current
    if (el) {
      el.currentTime = sec
      void el.play()
    }
  }

  // Parsed once per `video.transcript` change (Task 2) — `TranscriptPanel`
  // only needs `{words}`, and `IngestPanel`'s status pill needs just the
  // word count (Task 3's "Transcribed ✓ · N words · mm:ss").
  const transcript = useMemo(() => parseTranscript(video.transcript), [video.transcript])

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    setSaveError(null)
    try {
      await saveVideo({ videoId, title, description, youtube_url: youtubeUrl }).unwrap()
    } catch {
      setSaveError("Couldn't save. Try again.")
    }
  }

  async function handleDelete() {
    if (!window.confirm('Delete this video? This cannot be undone.')) return
    await deleteVideo({ videoId }).unwrap()
    navigate('/admin')
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Edit video
      </h1>

      <form onSubmit={handleSave} className="flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Description
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
            YouTube URL
          </span>
          <input
            type="text"
            value={youtubeUrl}
            onChange={(e) => setYoutubeUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            aria-invalid={!youtubeUrlValid}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          {!youtubeUrlValid && (
            <span className="text-xs text-red-600 dark:text-red-400">
              Doesn't look like a valid YouTube URL.
            </span>
          )}
          {youtubeUrlValid && youtubeId && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">
              Video id: {youtubeId}
            </span>
          )}
        </label>

        {saveError && <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}

        <div className="mt-2 flex items-center justify-between">
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleDelete()
            }}
            disabled={deleting}
            className="rounded-lg px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </form>

      <IngestPanel
        videoId={videoId}
        video={video}
        transcriptWordCount={transcript?.words.length ?? null}
        onVideoRef={setVideoEl}
      />

      <FramesGrid videoId={videoId} video={video} onSeek={handleSeek} />

      {transcript && transcript.words.length > 0 && (
        <TranscriptPanel
          words={transcript.words}
          duration={video.duration}
          onSeek={handleSeek}
          activeSec={activeSec}
        />
      )}

      <PublishPanel videoId={videoId} video={video} />
    </div>
  )
}
