/**
 * Admin video detail/edit form (Task 5). Title/description/YouTube-URL editing
 * with live `extractYouTubeId` feedback, save-via-`saveVideo`, and
 * delete-with-confirm.
 */

import { useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
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
    </div>
  )
}
