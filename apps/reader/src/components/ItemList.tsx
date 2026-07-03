import { itemPreview, sortItemsNewestFirst, type Item } from '../lib/items'

/** Middle column: the (newest-first) list of items for the current selection. */
export function ItemList({
  items,
  loading,
  selectedGuid,
  onSelect,
}: {
  items: Item[]
  loading: boolean
  selectedGuid: string | null
  onSelect: (item: Item) => void
}) {
  if (loading) {
    return <p className="px-2 py-6 text-sm text-slate-400">Loading…</p>
  }
  if (items.length === 0) {
    return (
      <p className="px-2 py-6 text-sm text-slate-400">
        No items yet. Add a feed and hit “Refresh now”.
      </p>
    )
  }

  const ordered = sortItemsNewestFirst(items)

  return (
    <ul className="flex flex-col divide-y divide-slate-100">
      {ordered.map((item) => (
        <li key={item.guid}>
          <button
            type="button"
            onClick={() => onSelect(item)}
            className={`w-full px-3 py-3 text-left transition-colors hover:bg-slate-50 ${
              item.guid === selectedGuid ? 'bg-blue-50' : ''
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span
                className={`truncate text-sm ${
                  item.read ? 'font-normal text-slate-500' : 'font-semibold text-slate-900'
                }`}
              >
                {item.title || '(untitled)'}
              </span>
              {item.publishedAt && (
                <time className="shrink-0 text-xs text-slate-400">
                  {new Date(item.publishedAt).toLocaleDateString()}
                </time>
              )}
            </div>
            {itemPreview(item) && (
              <p className="mt-1 line-clamp-2 text-xs text-slate-500">{itemPreview(item)}</p>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}
