/**
 * A single search hit within a video card (Task 9): "mm:ss — "snippet"".
 * Clicking it hands the moment's { start, snippet } up to the caller, which
 * points the shared `SeekingPlayer` panel at this video/timestamp.
 */

function formatMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

export type Moment = {
  start: number
  end?: number
  snippet: string
  similarity: number
}

export function MomentChip({ moment, onSelect }: { moment: Moment; onSelect: (moment: Moment) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(moment)}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      <span className="shrink-0 font-mono text-xs text-blue-600 dark:text-blue-400">
        {formatMMSS(moment.start)}
      </span>
      <span className="truncate text-slate-500 dark:text-slate-400">&ldquo;{moment.snippet}&rdquo;</span>
    </button>
  )
}
