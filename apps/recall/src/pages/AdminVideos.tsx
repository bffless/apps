/**
 * Admin video list (Task 5). Table of every video (any status) with a "New
 * video" action that creates a draft row and navigates straight to its detail
 * page for editing.
 */

import { Link, useNavigate } from 'react-router-dom'
import { useCreateVideoMutation, useListAdminVideosQuery } from '../store/videosApi'

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString()
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  processing: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  ready: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

function StatusPill({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? STATUS_STYLES.draft
  return (
    <span
      data-testid="status-pill"
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}
    >
      {status}
    </span>
  )
}

export function AdminVideos() {
  const { data, isLoading, isError } = useListAdminVideosQuery()
  const [createVideo, { isLoading: creating }] = useCreateVideoMutation()
  const navigate = useNavigate()

  async function handleNew() {
    const { video } = await createVideo({ title: 'Untitled video' }).unwrap()
    navigate(`/admin/video/${video.id}`)
  }

  const videos = data?.videos ?? []

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Videos
        </h1>
        <button
          type="button"
          onClick={() => {
            void handleNew()
          }}
          disabled={creating}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'New video'}
        </button>
      </div>

      {isLoading && <p className="text-slate-500 dark:text-slate-400">Loading…</p>}
      {isError && (
        <p className="text-red-600 dark:text-red-400">Couldn't load videos. Try refreshing.</p>
      )}
      {!isLoading && !isError && videos.length === 0 && (
        <p className="text-slate-500 dark:text-slate-400">No videos yet.</p>
      )}

      {videos.length > 0 && (
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <th className="py-2 pr-4 font-medium">Title</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Duration</th>
              <th className="py-2 pr-4 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {videos.map((v) => (
              <tr
                key={v.id}
                className="border-b border-slate-100 last:border-0 dark:border-slate-900"
              >
                <td className="py-3 pr-4">
                  <Link
                    to={`/admin/video/${v.id}`}
                    className="font-medium text-slate-900 hover:underline dark:text-slate-100"
                  >
                    {v.title || 'Untitled video'}
                  </Link>
                </td>
                <td className="py-3 pr-4">
                  <StatusPill status={v.status} />
                </td>
                <td className="py-3 pr-4 text-slate-600 dark:text-slate-400">
                  {formatDuration(v.duration)}
                </td>
                <td className="py-3 pr-4 text-slate-600 dark:text-slate-400">
                  {formatDate(v.created_ms)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
