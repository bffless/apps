import { useCallback, useEffect, useMemo, useState } from 'react'
import { FeedSidebar } from './components/FeedSidebar'
import { ItemList } from './components/ItemList'
import { ReadingPane } from './components/ReadingPane'
import * as api from './lib/api'
import type { Feed } from './lib/feeds'
import type { Item } from './lib/items'
import {
  itemsForSelection,
  markGuidsRead,
  setRead,
  totalUnread,
  unreadCountsByFeed,
  unreadGuids,
  type Selection,
} from './lib/river'

/**
 * The authenticated reading surface: feed/river sidebar · item list · reading
 * pane. Landing view is the **river** (unread across all feeds) — the "already
 * there when you arrive" loop.
 *
 * The full item set is loaded once (`api.listItems()`), and every view — river,
 * all, per-feed — plus the unread counts is derived from it client-side by the
 * pure `lib/river` helpers. Read-state writes are optimistic: local state flips
 * immediately via the same pure transitions, then `api.setItemRead` persists it
 * (`data_update`); a failed write reverts. This keeps all decision logic in the
 * tested `lib/*` seam; this component only orchestrates.
 */
export function ReaderApp() {
  const [feeds, setFeeds] = useState<Feed[]>([])
  const [selection, setSelection] = useState<Selection>({ kind: 'river' })
  const [items, setItems] = useState<Item[]>([])
  const [loadSeq, setLoadSeq] = useState(0)
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null)
  const [itemsLoading, setItemsLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadFeeds = useCallback(async () => {
    try {
      const rows = await api.listFeeds()
      setFeeds(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load feeds')
    }
  }, [])

  const loadItems = useCallback(async () => {
    setItemsLoading(true)
    try {
      const rows = await api.listItems()
      setItems(rows)
      setLoadSeq((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load items')
    } finally {
      setItemsLoading(false)
    }
  }, [])

  // Initial load. The fetchers setState in their async continuations (the
  // analyzer can't see past the await), which trips set-state-in-effect; this is
  // the monorepo's accepted fetch-in-effect pattern (see apps/handoff/src/App.tsx).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFeeds()
    void loadItems()
  }, [loadFeeds, loadItems])

  const selectView = useCallback((next: Selection) => {
    setSelection(next)
    setSelectedGuid(null)
  }, [])

  const counts = useMemo(() => unreadCountsByFeed(items), [items])
  const riverTotal = useMemo(() => totalUnread(items), [items])

  // The visible list is a snapshot captured when the view changes or a fresh
  // load lands (`loadSeq`) — deliberately NOT on every read toggle, so an item
  // marked read while open doesn't vanish from the river mid-read. Read items
  // leave the river on the next view change / refresh, staying queryable in the
  // "all"/per-feed views.
  const [visible, setVisible] = useState<Item[]>([])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(itemsForSelection(items, selection))
    // `items` is intentionally omitted: re-snapshotting on it would undo the
    // read-toggle patches below. `loadSeq` covers genuine set replacement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, loadSeq])

  const selectedItem = visible.find((i) => i.guid === selectedGuid) ?? null

  /** Reflect a read-flag change in both the source set and the visible snapshot. */
  const applyRead = useCallback((guid: string, read: boolean) => {
    setItems((prev) => setRead(prev, guid, read))
    setVisible((prev) => setRead(prev, guid, read))
  }, [])

  const persistRead = useCallback(
    async (guid: string, read: boolean) => {
      applyRead(guid, read)
      try {
        await api.setItemRead(guid, read)
      } catch (e) {
        applyRead(guid, !read) // revert the optimistic flip
        setError(e instanceof Error ? e.message : 'Could not save read state')
      }
    },
    [applyRead],
  )

  // Opening an item auto-marks it read — the "seen it" signal that keeps the
  // unread count honest; it stays visible in the current snapshot until you
  // leave the view.
  const openItem = useCallback(
    (item: Item) => {
      setSelectedGuid(item.guid)
      if (!item.read) void persistRead(item.guid, true)
    },
    [persistRead],
  )

  const toggleRead = useCallback(
    (item: Item) => {
      void persistRead(item.guid, !item.read)
    },
    [persistRead],
  )

  const markAllRead = useCallback(() => {
    const guids = unreadGuids(visible)
    if (guids.length === 0) return
    setItems((prev) => markGuidsRead(prev, guids))
    setVisible((prev) => markGuidsRead(prev, guids))
    void Promise.all(guids.map((g) => api.setItemRead(g, true))).catch((e) => {
      setError(e instanceof Error ? e.message : 'Could not mark all read')
      void loadItems()
    })
  }, [visible, loadItems])

  const handleAdd = useCallback(
    async (url: string) => {
      setAdding(true)
      setError(null)
      try {
        const feed = await api.addFeed({ url })
        await api.refresh()
        await Promise.all([loadFeeds(), loadItems()])
        selectView({ kind: 'feed', url: feed.url })
      } finally {
        setAdding(false)
      }
    },
    [loadFeeds, loadItems, selectView],
  )

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      await api.refresh()
      await Promise.all([loadFeeds(), loadItems()])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }, [loadFeeds, loadItems])

  const handleRemove = useCallback(
    async (url: string) => {
      setError(null)
      try {
        await api.removeFeed(url)
        if (selection.kind === 'feed' && selection.url === url) selectView({ kind: 'river' })
        await Promise.all([loadFeeds(), loadItems()])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not unsubscribe')
      }
    },
    [loadFeeds, loadItems, selection, selectView],
  )

  const unreadInView = visible.some((i) => !i.read)

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-6 sm:flex-row sm:px-6">
      <FeedSidebar
        feeds={feeds}
        selection={selection}
        unreadCounts={counts}
        riverUnread={riverTotal}
        onSelect={selectView}
        onAdd={handleAdd}
        onRemove={handleRemove}
        onRefresh={handleRefresh}
        adding={adding}
        refreshing={refreshing}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-4 lg:flex-row">
        <section className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white lg:max-w-sm">
          {error && (
            <p className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          )}
          {unreadInView && (
            <div className="flex justify-end border-b border-slate-100 px-3 py-1.5">
              <button
                type="button"
                onClick={markAllRead}
                className="rounded px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
              >
                Mark all read
              </button>
            </div>
          )}
          <ItemList
            items={visible}
            loading={itemsLoading}
            selectedGuid={selectedGuid}
            onSelect={openItem}
            onScrolledPast={(item) => {
              if (!item.read) void persistRead(item.guid, true)
            }}
          />
        </section>

        <section className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white">
          <ReadingPane item={selectedItem} onToggleRead={toggleRead} />
        </section>
      </div>
    </div>
  )
}
