import { feedLabel, sortFeeds, type Feed } from '../lib/feeds'
import { selectionEquals, type Selection } from '../lib/river'
import { AddFeed } from './AddFeed'

/**
 * Left rail: add-feed, a "Refresh now" action, and the subscription list, led by
 * the two cross-feed views — **River** (unread everywhere) and **All items**.
 * Feeds are sorted by label (pure `sortFeeds`) and carry a per-feed unread badge
 * from `unreadCounts` (keyed by `feedId` = url). Selection is the pure
 * `Selection` union; the sidebar only decides which row is active.
 */
export function FeedSidebar({
  feeds,
  selection,
  unreadCounts,
  riverUnread,
  onSelect,
  onAdd,
  onRemove,
  onRefresh,
  adding,
  refreshing,
}: {
  feeds: Feed[]
  selection: Selection
  unreadCounts: Record<string, number>
  riverUnread: number
  onSelect: (sel: Selection) => void
  onAdd: (url: string) => Promise<void>
  onRemove: (url: string) => void
  onRefresh: () => void
  adding: boolean
  refreshing: boolean
}) {
  const sorted = sortFeeds(feeds)

  return (
    <aside className="flex w-full flex-col gap-4 border-slate-200 sm:w-72 sm:border-r sm:pr-4">
      <AddFeed onAdd={onAdd} busy={adding} />

      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing || feeds.length === 0}
        className="self-start rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {refreshing ? 'Refreshing…' : 'Refresh now'}
      </button>

      <nav className="flex flex-col gap-0.5">
        <FeedRow
          label="River"
          active={selectionEquals(selection, { kind: 'river' })}
          count={riverUnread}
          onClick={() => onSelect({ kind: 'river' })}
        />
        <FeedRow
          label="All items"
          active={selectionEquals(selection, { kind: 'all' })}
          onClick={() => onSelect({ kind: 'all' })}
        />
        <div className="my-1 border-t border-slate-100" />
        {sorted.map((feed) => (
          <FeedRow
            key={feed.url}
            label={feedLabel(feed)}
            active={selectionEquals(selection, { kind: 'feed', url: feed.url })}
            count={unreadCounts[feed.url] ?? 0}
            error={feed.lastError}
            onClick={() => onSelect({ kind: 'feed', url: feed.url })}
            onRemove={() => onRemove(feed.url)}
          />
        ))}
        {feeds.length === 0 && (
          <p className="px-2 py-3 text-sm text-slate-400">No feeds yet. Add one above.</p>
        )}
      </nav>
    </aside>
  )
}

function FeedRow({
  label,
  active,
  count,
  error,
  onClick,
  onRemove,
}: {
  label: string
  active: boolean
  count?: number
  error?: string | null
  onClick: () => void
  onRemove?: () => void
}) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
        active ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-100'
      }`}
    >
      <button type="button" onClick={onClick} className="min-w-0 flex-1 truncate text-left" title={label}>
        {label}
        {error && <span className="ml-1 text-red-500" title={error}>⚠</span>}
      </button>
      {count != null && count > 0 && (
        <span
          className={`shrink-0 rounded-full px-1.5 text-xs tabular-nums ${
            active ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'
          } group-hover:opacity-100`}
          aria-label={`${count} unread`}
        >
          {count}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Unsubscribe from ${label}`}
          title="Unsubscribe"
          className="shrink-0 rounded px-1 text-slate-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  )
}
