import { useEffect, useRef } from 'react'
import { itemPreview, type Item } from '../lib/items'

/**
 * Middle column: the item list for the current view. Items arrive already
 * ordered + scoped from `lib/river` (the caller's snapshot), so this only
 * renders — no sorting/filtering decisions live here.
 *
 * Unread rows are auto-marked read once they **scroll past** the top of the
 * viewport (via `IntersectionObserver`): a row that was on screen and then
 * leaves upward fires `onScrolledPast`. Rows never seen (still below the fold)
 * are left unread, so opening the app doesn't nuke the whole river. Where IO is
 * unavailable the list still works — read state then comes from opening items.
 */
export function ItemList({
  items,
  loading,
  selectedGuid,
  onSelect,
  onToggleStar,
  onScrolledPast,
}: {
  items: Item[]
  loading: boolean
  selectedGuid: string | null
  onSelect: (item: Item) => void
  onToggleStar?: (item: Item) => void
  onScrolledPast?: (item: Item) => void
}) {
  const seen = useRef<Set<string>>(new Set())
  const rows = useRef<Map<string, HTMLLIElement>>(new Map())

  // Re-subscribed whenever `items` changes, so the callback closes over the
  // current set (fresh read flags) without a mutable ref.
  useEffect(() => {
    if (!onScrolledPast || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const guid = (entry.target as HTMLElement).dataset.guid
          if (!guid) continue
          if (entry.isIntersecting) {
            seen.current.add(guid) // it's been on screen
          } else if (seen.current.has(guid) && entry.boundingClientRect.top < 0) {
            // Was visible, now gone above the top → scrolled past.
            const item = items.find((i) => i.guid === guid)
            if (item && !item.read) onScrolledPast(item)
          }
        }
      },
      { threshold: 0 },
    )
    for (const el of rows.current.values()) observer.observe(el)
    return () => observer.disconnect()
  }, [items, onScrolledPast])

  if (loading) {
    return <p className="px-2 py-6 text-sm text-slate-400 dark:text-slate-500">Loading…</p>
  }
  if (items.length === 0) {
    return (
      <p className="px-2 py-6 text-sm text-slate-400 dark:text-slate-500">
        Nothing here. Add a feed, hit “Refresh now”, or you’re all caught up.
      </p>
    )
  }

  return (
    <ul className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
      {items.map((item) => (
        <li
          key={item.guid}
          data-guid={item.guid}
          className="group relative"
          ref={(el) => {
            if (el) rows.current.set(item.guid, el)
            else rows.current.delete(item.guid)
          }}
        >
          {onToggleStar && (
            <button
              type="button"
              onClick={() => onToggleStar(item)}
              aria-pressed={item.starred}
              aria-label={item.starred ? 'Unstar' : 'Star'}
              title={item.starred ? 'Unstar' : 'Star'}
              className={`absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded px-1 text-base leading-none transition-opacity ${
                item.starred
                  ? 'text-amber-500 opacity-100'
                  : 'text-slate-300 opacity-0 hover:text-amber-500 focus:opacity-100 group-hover:opacity-100 dark:text-slate-600'
              }`}
            >
              {item.starred ? '★' : '☆'}
            </button>
          )}
          <button
            type="button"
            onClick={() => onSelect(item)}
            className={`flex w-full items-start gap-2 py-3 pl-3 pr-8 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 ${
              item.guid === selectedGuid ? 'bg-blue-50 dark:bg-blue-950/40' : ''
            }`}
          >
            <span
              aria-hidden="true"
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.read ? 'bg-transparent' : 'bg-blue-500'}`}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3">
                <span
                  className={`truncate text-sm ${
                    item.read ? 'font-normal text-slate-500 dark:text-slate-400' : 'font-semibold text-slate-900 dark:text-slate-100'
                  }`}
                >
                  {item.title || '(untitled)'}
                </span>
                {item.publishedAt && (
                  <time className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                    {new Date(item.publishedAt).toLocaleDateString()}
                  </time>
                )}
              </span>
              {itemPreview(item) && (
                <span className="mt-1 line-clamp-2 block text-xs text-slate-500 dark:text-slate-400">{itemPreview(item)}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
