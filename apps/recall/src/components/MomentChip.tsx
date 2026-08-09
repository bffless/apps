/**
 * A single search hit within a video card (Task 9): "mm:ss — "snippet"".
 * Clicking it hands the moment's { start, snippet } up to the caller, which
 * points the shared `SeekingPlayer` panel at this video/timestamp.
 *
 * PR-feedback-2: when the video has a contact-sheet sprite, render a small
 * (~112×63) thumbnail cropped from the nearest tile, left of the timestamp —
 * a quick visual cue for which moment this is before reading the snippet.
 * Cards without a sheet render exactly as before (no reserved space, no
 * layout jump) — the thumbnail slot only exists when there's a sheet to show.
 *
 * PR-feedback-6: `sheetMeta` can be v1 (single implicit sheet) or v2
 * (multiple sheets, each with its own url) — `nearestTile` handles both,
 * returning WHICH sheet's url to crop from (falling back to `sheetUrl` for a
 * v1 meta, which carries no url of its own).
 */

import { nearestTile, spriteStyle, type SheetMeta } from '../lib/sprite'

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

/** ~112px display width for the sprite thumbnail (16:9 -> ~63px tall). */
const THUMB_DISPLAY_W = 112

function SpriteThumb({ sheetUrl, sheetMeta, t }: { sheetUrl: string; sheetMeta: SheetMeta; t: number }) {
  const hit = nearestTile(sheetMeta, t, sheetUrl)
  if (!hit || !hit.url) return null
  const style = spriteStyle(sheetMeta, hit.tileIndex, THUMB_DISPLAY_W)
  if (!style) return null

  return (
    <span
      aria-hidden="true"
      className="shrink-0 overflow-hidden rounded bg-slate-200 dark:bg-slate-800"
      style={{
        width: style.width,
        height: style.height,
        backgroundImage: `url(${hit.url})`,
        backgroundSize: style.backgroundSize,
        backgroundPosition: style.backgroundPosition,
        backgroundRepeat: 'no-repeat',
      }}
    />
  )
}

export function MomentChip({
  moment,
  sheetUrl,
  sheetMeta,
  onSelect,
}: {
  moment: Moment
  sheetUrl?: string | null
  sheetMeta?: SheetMeta | null
  onSelect: (moment: Moment) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(moment)}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      {sheetUrl && sheetMeta && (
        <SpriteThumb sheetUrl={sheetUrl} sheetMeta={sheetMeta} t={moment.start} />
      )}
      <span className="shrink-0 font-mono text-xs text-blue-600 dark:text-blue-400">
        {formatMMSS(moment.start)}
      </span>
      <span className="truncate text-slate-500 dark:text-slate-400">&ldquo;{moment.snippet}&rdquo;</span>
    </button>
  )
}
