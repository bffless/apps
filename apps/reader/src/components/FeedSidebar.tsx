import { feedLabel, sortFeeds, type Feed } from '../lib/feeds'
import { AddFeed } from './AddFeed'

/** The special "all feeds" selection — `null` selected feed shows every item. */
export const ALL_FEEDS = null

/**
 * Left rail: add-feed, a "Refresh now" action, and the subscription list. Feeds
 * are sorted by label here (pure `sortFeeds`) so the order is deterministic.
 */
export function FeedSidebar({
  feeds,
  selected,
  onSelect,
  onAdd,
  onRemove,
  onRefresh,
  adding,
  refreshing,
}: {
  feeds: Feed[]
  selected: string | null
  onSelect: (url: string | null) => void
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
          label="All feeds"
          active={selected === ALL_FEEDS}
          onClick={() => onSelect(ALL_FEEDS)}
        />
        {sorted.map((feed) => (
          <FeedRow
            key={feed.url}
            label={feedLabel(feed)}
            active={selected === feed.url}
            error={feed.lastError}
            onClick={() => onSelect(feed.url)}
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
  error,
  onClick,
  onRemove,
}: {
  label: string
  active: boolean
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
