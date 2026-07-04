import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FeedSidebar } from './components/FeedSidebar'
import { ItemList } from './components/ItemList'
import { ReadingPane } from './components/ReadingPane'
import * as api from './lib/api'
import type { Feed } from './lib/feeds'
import { sortItemsNewestFirst, sortItemsOldestFirst, type Item } from './lib/items'
import { keyToAction, nextSelection } from './lib/keyboard'
import { DESKTOP_MEDIA_QUERY, useMediaQuery } from './lib/useMediaQuery'
import type { OpmlFeed } from './lib/opml'
import {
  itemsForSelection,
  markGuidsRead,
  setRead,
  setStarred,
  totalStarred,
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
export function ReaderApp({
  containerClass = 'max-w-6xl',
  measureClass = 'max-w-2xl',
  drawerOpen = false,
  onDrawerOpenChange,
}: {
  /** Outer-container max-width class from the reading-width preference (#136). */
  containerClass?: string
  /** Reading-measure max-width class threaded to the reading pane (#136). */
  measureClass?: string
  /** Mobile nav-drawer open state, lifted so the header hamburger drives it (#135). */
  drawerOpen?: boolean
  /** Report drawer open/close (opened by the header menu, closed on select/backdrop). */
  onDrawerOpenChange?: (open: boolean) => void
} = {}) {
  const [feeds, setFeeds] = useState<Feed[]>([])
  const [selection, setSelection] = useState<Selection>({ kind: 'river' })
  const [items, setItems] = useState<Item[]>([])
  const [loadSeq, setLoadSeq] = useState(0)
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null)
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest')
  const [itemsLoading, setItemsLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
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

  // Choosing a view (or a feed/folder) returns to the list and, on mobile,
  // dismisses the nav drawer (#135). On desktop the drawer is never open, so
  // the close is a no-op.
  const selectView = useCallback(
    (next: Selection) => {
      setSelection(next)
      setSelectedGuid(null)
      onDrawerOpenChange?.(false)
    },
    [onDrawerOpenChange],
  )

  const counts = useMemo(() => unreadCountsByFeed(items), [items])
  const riverTotal = useMemo(() => totalUnread(items), [items])
  const starredTotal = useMemo(() => totalStarred(items), [items])

  // The visible list is a snapshot captured when the view changes or a fresh
  // load lands (`loadSeq`) — deliberately NOT on every read toggle, so an item
  // marked read while open doesn't vanish from the river mid-read. Read items
  // leave the river on the next view change / refresh, staying queryable in the
  // "all"/per-feed views.
  const [visible, setVisible] = useState<Item[]>([])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(itemsForSelection(items, selection, feeds))
    // `items` is intentionally omitted: re-snapshotting on it would undo the
    // read-toggle patches below. `loadSeq` covers genuine set replacement, and
    // `feeds` re-scopes a folder view when a feed is moved in or out of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, loadSeq, feeds])

  // The order shown is applied over the snapshot (not re-derived from `items`),
  // so toggling newest/oldest reorders in place without dropping items that were
  // marked read while the view is open. #118 — chronological-reading toggle.
  const orderedVisible = useMemo(
    () => (sortOrder === 'oldest' ? sortItemsOldestFirst(visible) : sortItemsNewestFirst(visible)),
    [visible, sortOrder],
  )

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

  /** Reflect a star-flag change in both the source set and the visible snapshot. */
  const applyStar = useCallback((guid: string, starred: boolean) => {
    setItems((prev) => setStarred(prev, guid, starred))
    setVisible((prev) => setStarred(prev, guid, starred))
  }, [])

  // Star writes mirror read: optimistic flip, persist, revert on failure. The
  // item stays in the current snapshot when unstarred from the starred view (it
  // leaves on the next view change), so the row doesn't vanish under the cursor.
  const toggleStar = useCallback(
    (item: Item) => {
      const next = !item.starred
      applyStar(item.guid, next)
      void api.setItemStar(item.guid, next).catch((e) => {
        applyStar(item.guid, !next)
        setError(e instanceof Error ? e.message : 'Could not save starred state')
      })
    },
    [applyStar],
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

  // Add a feed from a pasted URL — resolve it first (#113): a site homepage is
  // discovered to its feed via the page's alternate link or a common-path probe;
  // a URL that is already a feed is returned unchanged and added directly.
  const handleAdd = useCallback(
    async (url: string) => {
      setAdding(true)
      setError(null)
      try {
        const discovered = await api.discoverFeed(url)
        const feed = await api.addFeed({ url: discovered.url, title: discovered.title })
        await api.refresh()
        await Promise.all([loadFeeds(), loadItems()])
        selectView({ kind: 'feed', url: feed.url })
      } finally {
        setAdding(false)
      }
    },
    [loadFeeds, loadItems, selectView],
  )

  // OPML import: upsert every parsed feed (each add is dedup-by-url, so re-import
  // is a no-op), carrying its folder, then refresh once so items land. Feeds are
  // added in parallel and settled independently — one bad url doesn't abort the
  // batch — mirroring the mark-all-read fan-out; there's no bulk add primitive.
  const handleImportOpml = useCallback(
    async (parsed: OpmlFeed[]) => {
      setImporting(true)
      setError(null)
      try {
        await Promise.allSettled(
          parsed.map((f) => api.addFeed({ url: f.url, title: f.title, folder: f.folder })),
        )
        await api.refresh()
        await Promise.all([loadFeeds(), loadItems()])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Import failed')
      } finally {
        setImporting(false)
      }
    },
    [loadFeeds, loadItems],
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

  // Move a feed to a folder (or out of one). Optimistic: patch the feed's folder
  // locally so the sidebar regroups immediately, then persist via re-upsert;
  // revert on failure. #116 — folder is a nullable field on the feed itself.
  const handleMoveFolder = useCallback(
    (feed: Feed, folder: string | null) => {
      if ((feed.folder ?? null) === (folder ?? null)) return
      const patch = (value: string | null) =>
        setFeeds((prev) => prev.map((f) => (f.url === feed.url ? { ...f, folder: value } : f)))
      patch(folder)
      void api.setFeedFolder(feed, folder).catch((e) => {
        patch(feed.folder) // revert to the pre-move folder
        setError(e instanceof Error ? e.message : 'Could not move feed')
      })
    },
    [],
  )

  // Keyboard navigation (#118): j/k move the cursor, space pages down, s/m/o act
  // on the cursor item. The mapping + cursor math live in the pure `lib/keyboard`
  // seam; this only wires DOM keydown to the existing star/read/open handlers.
  // Typing in a field (Add-feed input, etc.) is left alone, as are modified
  // chords (⌘/Ctrl/Alt) so browser shortcuts still work.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const action = keyToAction(e.key)
      if (!action) return
      e.preventDefault()
      if (action.kind === 'move') {
        setSelectedGuid((cur) => nextSelection(orderedVisible.map((i) => i.guid), cur, action.dir))
        return
      }
      if (action.kind === 'page') {
        window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: 'smooth' })
        return
      }
      const item = orderedVisible.find((i) => i.guid === selectedGuid)
      if (!item) return
      if (action.kind === 'star') toggleStar(item)
      else if (action.kind === 'toggleRead') toggleRead(item)
      else if (action.kind === 'open') openItem(item)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [orderedVisible, selectedGuid, toggleStar, toggleRead, openItem])

  const unreadInView = visible.some((i) => !i.read)

  // Desktop shows the three-column layout; below `lg` the mobile single-pane
  // flow governs (#135). The JS branch flips at the same width as the `lg:`
  // utilities, so the two never disagree.
  const isDesktop = useMediaQuery(DESKTOP_MEDIA_QUERY)

  // Mobile only: opening an item swaps the list for a full-screen article. Stash
  // the list's scroll offset first so Back can restore it, and start the article
  // from the top.
  const listScrollY = useRef(0)
  const openItemMobile = useCallback(
    (item: Item) => {
      listScrollY.current = window.scrollY
      openItem(item)
      window.scrollTo(0, 0)
    },
    [openItem],
  )
  const backToList = useCallback(() => {
    setSelectedGuid(null)
    // Restore after the list has re-rendered and reclaimed its height.
    requestAnimationFrame(() => window.scrollTo(0, listScrollY.current))
  }, [])

  const markScrolledPast = useCallback(
    (item: Item) => {
      if (!item.read) void persistRead(item.guid, true)
    },
    [persistRead],
  )

  const sidebar = (
    <FeedSidebar
      feeds={feeds}
      selection={selection}
      unreadCounts={counts}
      riverUnread={riverTotal}
      starredCount={starredTotal}
      onSelect={selectView}
      onAdd={handleAdd}
      onRemove={handleRemove}
      onMoveFolder={handleMoveFolder}
      onRefresh={handleRefresh}
      onImportOpml={handleImportOpml}
      adding={adding}
      importing={importing}
      refreshing={refreshing}
    />
  )

  const errorBanner = error && (
    <p className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
  )

  const listToolbar = visible.length > 0 && (
    <div className="flex items-center justify-between border-b border-slate-100 px-3 py-1.5">
      <button
        type="button"
        onClick={() => setSortOrder((o) => (o === 'newest' ? 'oldest' : 'newest'))}
        aria-pressed={sortOrder === 'oldest'}
        title="Toggle reading order"
        className="rounded px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
      >
        {sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
      </button>
      {unreadInView && (
        <button
          type="button"
          onClick={markAllRead}
          className="rounded px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
        >
          Mark all read
        </button>
      )}
    </div>
  )

  if (isDesktop) {
    return (
      <div
        className={`mx-auto flex w-full flex-1 flex-col gap-4 px-4 py-6 sm:flex-row sm:px-6 ${containerClass}`}
      >
        {sidebar}

        <div className="flex min-w-0 flex-1 flex-col gap-4 lg:flex-row">
          <section className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white lg:max-w-sm">
            {errorBanner}
            {listToolbar}
            <ItemList
              items={orderedVisible}
              loading={itemsLoading}
              selectedGuid={selectedGuid}
              onSelect={openItem}
              onToggleStar={toggleStar}
              onScrolledPast={markScrolledPast}
            />
          </section>

          <section className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white">
            <ReadingPane
              item={selectedItem}
              measureClass={measureClass}
              onToggleRead={toggleRead}
              onToggleStar={toggleStar}
            />
          </section>
        </div>
      </div>
    )
  }

  // Mobile single-pane flow: the article replaces the list when an item is open;
  // otherwise the list is full-width. The sidebar is a slide-in drawer.
  return (
    <>
      {selectedItem ? (
        <div className="flex w-full flex-1 flex-col">
          <div className="sticky top-14 z-10 flex items-center gap-2 border-b border-slate-200 bg-white/90 px-3 py-2 backdrop-blur">
            <button
              type="button"
              onClick={backToList}
              className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
            >
              <span aria-hidden="true">←</span> Back
            </button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-500">
              {selectedItem.title || '(untitled)'}
            </span>
          </div>
          <section className="min-w-0 flex-1 bg-white">
            <ReadingPane
              item={selectedItem}
              measureClass={measureClass}
              onToggleRead={toggleRead}
              onToggleStar={toggleStar}
            />
          </section>
        </div>
      ) : (
        <div className="flex w-full flex-1 flex-col px-4 py-6">
          <section className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white">
            {errorBanner}
            {listToolbar}
            <ItemList
              items={orderedVisible}
              loading={itemsLoading}
              selectedGuid={selectedGuid}
              onSelect={openItemMobile}
              onToggleStar={toggleStar}
              onScrolledPast={markScrolledPast}
            />
          </section>
        </div>
      )}

      {/* Slide-in navigation drawer, opened from the header hamburger. */}
      <div
        className={`fixed inset-0 z-30 lg:hidden ${drawerOpen ? '' : 'pointer-events-none'}`}
        aria-hidden={!drawerOpen}
      >
        <button
          type="button"
          tabIndex={drawerOpen ? 0 : -1}
          aria-label="Close menu"
          onClick={() => onDrawerOpenChange?.(false)}
          className={`absolute inset-0 h-full w-full cursor-default bg-slate-900/40 transition-opacity ${
            drawerOpen ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <div
          className={`absolute inset-y-0 left-0 flex w-80 max-w-[85%] flex-col overflow-y-auto bg-white p-4 shadow-xl transition-transform duration-200 ${
            drawerOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {sidebar}
        </div>
      </div>
    </>
  )
}
