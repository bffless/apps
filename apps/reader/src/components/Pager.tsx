/**
 * Numbered pagination for the item list. The page lives in the URL (`?page=n`,
 * see `lib/route`), so this is a pure control: it renders `[‹] [1] … [n] [›]`
 * for the current `page` / `totalPages` and reports a target page via `onPage`
 * — the parent turns that into a `navigate(withPage(...))`, which drives the
 * one refetch. It renders nothing for a single page, so the caller can drop it
 * unconditionally below the list and let it hide itself.
 *
 * For large sets the number strip is windowed: first and last page are always
 * shown, plus the current page and its immediate neighbors, with `…` gaps
 * elided between them (e.g. `1 … 4 5 6 … 10`).
 */

/** The visible page strip: page numbers with `'ellipsis'` gaps between runs. */
function pageWindow(page: number, totalPages: number): (number | 'ellipsis')[] {
  const shown = new Set<number>([1, totalPages])
  for (let p = page - 1; p <= page + 1; p++) {
    if (p >= 1 && p <= totalPages) shown.add(p)
  }
  const sorted = [...shown].sort((a, b) => a - b)
  const out: (number | 'ellipsis')[] = []
  let prev = 0
  for (const p of sorted) {
    if (p - prev > 1) out.push('ellipsis')
    out.push(p)
    prev = p
  }
  return out
}

const arrowClass =
  'rounded px-2 py-1 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'

export function Pager({
  page,
  totalPages,
  onPage,
}: {
  page: number
  totalPages: number
  onPage: (p: number) => void
}) {
  // Nothing to page through — hide entirely (page 1 == clean URL).
  if (totalPages <= 1) return null

  const atFirst = page <= 1
  const atLast = page >= totalPages

  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-center gap-1 border-t border-slate-100 px-2 py-2 dark:border-slate-800"
    >
      <button
        type="button"
        onClick={() => onPage(page - 1)}
        disabled={atFirst}
        aria-label="Previous page"
        className={arrowClass}
      >
        <span aria-hidden="true">‹</span>
      </button>

      {pageWindow(page, totalPages).map((entry, i) =>
        entry === 'ellipsis' ? (
          <span
            key={`ellipsis-${i}`}
            aria-hidden="true"
            className="px-1 text-sm text-slate-400 dark:text-slate-600"
          >
            …
          </span>
        ) : entry === page ? (
          <button
            key={entry}
            type="button"
            aria-current="page"
            aria-label={`Page ${entry}`}
            className="rounded bg-blue-50 px-2.5 py-1 text-sm font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
          >
            {entry}
          </button>
        ) : (
          <button
            key={entry}
            type="button"
            onClick={() => onPage(entry)}
            aria-label={`Page ${entry}`}
            className="rounded px-2.5 py-1 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            {entry}
          </button>
        ),
      )}

      <button
        type="button"
        onClick={() => onPage(page + 1)}
        disabled={atLast}
        aria-label="Next page"
        className={arrowClass}
      >
        <span aria-hidden="true">›</span>
      </button>
    </nav>
  )
}
