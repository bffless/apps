/**
 * Shared status pill (Task 8, hoisted out of AdminVideos.tsx so exporting the
 * style map alongside the component doesn't trip
 * react-refresh/only-export-components). Keyed on the real
 * `recall_videos.status` vocabulary (draft -> transcribing -> transcribed ->
 * indexing -> published, with `error` reachable from either slow step) so the
 * admin list page and the video detail page's publish panel never disagree
 * on what a status looks like.
 */

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  transcribing: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  transcribed: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  indexing: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  published: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

export function StatusPill({ status }: { status: string }) {
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
