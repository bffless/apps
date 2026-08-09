/**
 * Admin video detail/edit form (Task 5) + ingest dropzone (Task 6).
 * Title/description/YouTube-URL editing with live `extractYouTubeId`
 * feedback, save-via-`saveVideo`, delete-with-confirm, and a drag/drop or
 * click-to-pick source-video uploader that drives `useIngest` through
 * upload -> extract -> upload-audio -> transcribe.
 */

import { useEffect, useState, type DragEvent, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useIngest, type IngestStage } from '../hooks/useIngest'
import { extractYouTubeId } from '../lib/youtube'
import {
  useDeleteVideoMutation,
  useGetAdminVideoQuery,
  useSaveVideoMutation,
  type Video,
} from '../store/videosApi'

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
  extracting: 'Extracting audio…',
  'uploading-audio': 'Uploading audio…',
  transcribing: 'Transcribing…',
  done: 'Transcribed',
  error: 'Error',
}

const STAGE_STYLES: Record<IngestStage, string> = {
  idle: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  uploading: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  extracting: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'uploading-audio': 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  transcribing: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  done: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Drag/drop or click-to-pick source-video uploader (Task 6). Drives
 * `useIngest` through its staged pipeline and surfaces stage pills, the
 * extracted duration, and any error with a retry action.
 */
function IngestPanel({ videoId, video }: { videoId: string; video: Video }) {
  const { stage, progress, error, start, retryTranscribe, canRetry } = useIngest(videoId)
  const [dragOver, setDragOver] = useState(false)

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

  return (
    <section className="mt-8 border-t border-slate-200 pt-6 dark:border-slate-800">
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Source video
      </h2>

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

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span
          data-testid="ingest-stage-pill"
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STAGE_STYLES[stage]}`}
        >
          {STAGE_LABELS[stage]}
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

      <IngestPanel videoId={videoId} video={video} />
    </div>
  )
}
