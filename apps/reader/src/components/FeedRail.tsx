import { feedInitial, feedLabel, sortFeeds, type Feed } from '../lib/feeds'
import { selectionEquals, type Selection } from '../lib/river'

/**
 * The **collapsed** feed sidebar (#140): a fixed-width vertical rail of square
 * icon buttons — the cross-feed views (River / All / ★ Starred) above a divider,
 * then one lettered square per feed, each carrying its unread badge. It mirrors
 * {@link FeedSidebar}'s selection model so a feed stays switchable without
 * expanding the sidebar; the header toggle expands back to the full list.
 *
 * Rendered only on desktop, only while the sidebar panel is at rail width, so it
 * never has to reflow — every icon is sized to fit `SIDEBAR_RAIL_PX`.
 */
export function FeedRail({
  feeds,
  selection,
  unreadCounts,
  riverUnread,
  starredCount,
  onSelect,
}: {
  feeds: Feed[]
  selection: Selection
  unreadCounts: Record<string, number>
  riverUnread: number
  starredCount: number
  onSelect: (sel: Selection) => void
}) {
  return (
    <nav aria-label="Feeds" className="flex w-full flex-col items-center gap-1 py-1">
      <RailButton
        label="River"
        active={selectionEquals(selection, { kind: 'river' })}
        count={riverUnread}
        onClick={() => onSelect({ kind: 'river' })}
      >
        <WavesGlyph />
      </RailButton>
      <RailButton
        label="All items"
        active={selectionEquals(selection, { kind: 'all' })}
        onClick={() => onSelect({ kind: 'all' })}
      >
        <ListGlyph />
      </RailButton>
      <RailButton
        label="Starred"
        active={selectionEquals(selection, { kind: 'starred' })}
        count={starredCount}
        onClick={() => onSelect({ kind: 'starred' })}
      >
        <span aria-hidden className="text-base leading-none">★</span>
      </RailButton>

      {feeds.length > 0 && <div className="my-1 h-px w-8 bg-slate-200 dark:bg-slate-800" />}

      {sortFeeds(feeds).map((feed) => {
        const label = feedLabel(feed)
        return (
          <RailButton
            key={feed.url}
            label={label}
            active={selectionEquals(selection, { kind: 'feed', url: feed.url })}
            count={unreadCounts[feed.url] ?? 0}
            error={feed.lastError}
            onClick={() => onSelect({ kind: 'feed', url: feed.url })}
          >
            <span aria-hidden className="text-sm font-semibold leading-none">
              {feedInitial(feed)}
            </span>
          </RailButton>
        )
      })}
    </nav>
  )
}

/** One square rail icon: active/hover states, an unread badge, and an error dot. */
function RailButton({
  label,
  active,
  count,
  error,
  onClick,
  children,
}: {
  label: string
  active: boolean
  count?: number
  error?: string | null
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={error ? `${label} — ${error}` : label}
      aria-label={count && count > 0 ? `${label}, ${count} unread` : label}
      aria-current={active ? 'true' : undefined}
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-colors ${
        active
          ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-300'
          : 'border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100'
      }`}
    >
      {children}
      {count != null && count > 0 && (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-medium tabular-nums text-white"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
      {error && (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-white bg-red-500 dark:border-slate-900"
        />
      )}
    </button>
  )
}

/** The Rivulet three-stream motif, reused as the River view's rail glyph. */
function WavesGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M3 8c3 0 3 2 6 2s3-2 6-2 3 2 3 2" opacity="0.9" />
      <path d="M3 12c3 0 3 2 6 2s3-2 6-2 3 2 3 2" opacity="0.7" />
      <path d="M3 16c3 0 3 2 6 2s3-2 6-2 3 2 3 2" opacity="0.5" />
    </svg>
  )
}

/** A stacked-lines glyph for the "All items" view. */
function ListGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="7" x2="19" y2="7" />
      <line x1="5" y1="12" x2="19" y2="12" />
      <line x1="5" y1="17" x2="19" y2="17" />
    </svg>
  )
}
