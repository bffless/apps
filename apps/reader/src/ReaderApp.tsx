import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { FeedRail } from './components/FeedRail'
import { FeedSidebar } from './components/FeedSidebar'
import { ItemList } from './components/ItemList'
import { Pager } from './components/Pager'
import { ReadingPane } from './components/ReadingPane'
import * as api from './lib/api'
import type { Counts, ItemsPage } from './lib/api'
import { feedTitleFor, type Feed } from './lib/feeds'
import { type Item } from './lib/items'
import type { SortOrder } from './lib/itemsQuery'
import { keyToAction, nextSelection } from './lib/keyboard'
import {
  CONTENT_MIN_SIZE,
  CONTENT_PANEL_ID,
  PANES_STORAGE_ID,
  SIDEBAR_DEFAULT_SIZE,
  SIDEBAR_MAX_SIZE,
  SIDEBAR_MIN_SIZE,
  SIDEBAR_PANEL_ID,
  SIDEBAR_RAIL_PX,
  isCollapsedWidth,
  pageScrollDelta,
} from './lib/panes'
import { DESKTOP_MEDIA_QUERY, useMediaQuery } from './lib/useMediaQuery'
import type { OpmlFeed } from './lib/opml'
import {
  pageFromSearch,
  pathForItem,
  pathForSelection,
  selectionFromParams,
  viewFromPathname,
  withPage,
} from './lib/route'
import {
  markGuidsRead,
  selectionKey,
  setRead,
  setStarred,
  unreadGuids,
  type Selection,
} from './lib/river'

/**
 * The authenticated reading surface: feed/river sidebar · item list · reading
 * pane. Landing view is the **river** (unread across all feeds) — the "already
 * there when you arrive" loop.
 *
 * Each view fetches exactly one filtered, paginated page from the server
 * (`api.listItems(selection, { page, order })`) plus the sidebar counts
 * (`api.getCounts()`) — the client no longer loads the whole set or derives
 * views from it. `pageData.items` arrives already server-ordered (and reversed
 * for oldest-first). Read/star writes are optimistic: the loaded page flips
 * immediately via the pure `lib/river` transitions, then `api.setItemRead` /
 * `api.setItemStar` persist it (`data_update`) and the counts are refetched; a
 * failed write reverts. This component only orchestrates fetch + optimistic UI.
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
  const [pageData, setPageData] = useState<ItemsPage | null>(null)
  const [counts, setCounts] = useState<Counts>({ unreadByFeed: {}, starred: 0 })
  const [reloadSeq, setReloadSeq] = useState(0)
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest')
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The URL is the single source of truth for the selected view and the open
  // item (#144): the view comes from the pathname, the folder / feed ids from
  // the dynamic segments (already %-decoded by the router), and the open item
  // from `:itemId`. Deriving here — rather than holding React state — is what
  // makes hard reload, Back / Forward, and bookmarking work. `selection` is
  // memoized on its primitive keys so its identity only changes when the view
  // does, keeping the `visible`-snapshot effect from re-firing every render.
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const { folder, feedId, itemId } = useParams()
  const view = viewFromPathname(pathname)
  const selection = useMemo<Selection>(
    () => selectionFromParams({ view, folder, feedId }),
    [view, folder, feedId],
  )
  const selectedGuid = itemId ?? null

  // The current page is a URL query param (`?page=n`, #144) — derived, not
  // React state — so it survives reload / Back-Forward and coexists with the
  // open-item path. A selection navigation goes to a param-free `pathForSelection`
  // path, so `page` resets to 1 for free on any view change (no manual reset).
  const page = useMemo(() => pageFromSearch(search), [search])

  // Navigate to a view (river/all/starred/folder/feed) and, on mobile, dismiss
  // the nav drawer. Replaces the old local `selectView`.
  const goToSelection = useCallback(
    (next: Selection) => {
      navigate(pathForSelection(next))
      onDrawerOpenChange?.(false)
    },
    [navigate, onDrawerOpenChange],
  )

  // Page through the current view: write the target page into the URL (`?page=n`,
  // dropped for page 1). The fetch effect is keyed on the derived `page`, so this
  // one navigation triggers exactly one refetch — the URL is the only driver.
  const onPage = useCallback(
    (p: number) => {
      navigate(withPage(pathForSelection(selection), p))
    },
    [navigate, selection],
  )

  // Desktop pane layout (#140): the sidebar is a resizable, collapsible panel;
  // the list and reading pane each scroll in their own container. The panel ref
  // drives collapse/expand, `sidebarCollapsed` mirrors it for the toggle's
  // label, and the scroll refs re-target keyboard paging + mark-read (which used
  // to act on the window) to the panes now that the window no longer scrolls.
  const sidebarPanelRef = usePanelRef()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const readingScrollRef = useRef<HTMLDivElement>(null)
  // Persist sidebar width + collapsed state to localStorage, keyed by group id.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: PANES_STORAGE_ID,
    storage: typeof localStorage === 'undefined' ? undefined : localStorage,
  })
  const toggleSidebar = useCallback(() => {
    const panel = sidebarPanelRef.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }, [sidebarPanelRef])

  const loadFeeds = useCallback(async () => {
    try {
      const rows = await api.listFeeds()
      setFeeds(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load feeds')
    }
  }, [])

  // Sidebar badge counts come straight from the server (`/api/counts`) rather
  // than being derived from a loaded set — refetched on mount, after refresh,
  // and after any read/star/mark-all write. Counts are non-critical chrome, so a
  // failed refresh is swallowed (the last-known counts stay) rather than
  // surfacing an error over the reading surface.
  const refreshCounts = useCallback(async () => {
    try {
      const next = await api.getCounts()
      setCounts(next)
    } catch {
      // keep the last-known counts
    }
  }, [])

  // Initial load. The fetchers setState in their async continuations (the
  // analyzer can't see past the await), which trips set-state-in-effect; this is
  // the monorepo's accepted fetch-in-effect pattern (see apps/handoff/src/App.tsx).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFeeds()
    void refreshCounts()
  }, [loadFeeds, refreshCounts])

  // The last-known `total` for the CURRENT selection, kept in a ref so it can
  // seed the next fetch without being a render dependency. Reset to null when the
  // selection changes so an oldest-first first load falls back to the newest
  // page-`page` (see `buildItemsQuery`) and re-issues once total is known.
  const selKey = selectionKey(selection)
  const totalRef = useRef<number | null>(null)

  // A view change starts over with an unknown total (page itself resets to 1 via
  // the URL — a selection nav lands on a param-free path). Declared before the
  // fetch effect so, on a selection change, the `totalRef` clear lands before the
  // page fetch reads it.
  useEffect(() => {
    totalRef.current = null
  }, [selKey])

  // Fetch exactly one filtered, paginated page for the current selection/page/
  // order (plus a `reloadSeq` bump after feed mutations). The returned items are
  // already server-ordered and reversed for oldest-first — rendered as-is. A
  // stale response that resolves after a newer request is dropped via the
  // `cancelled` cleanup flag (out-of-order guard). For oldest-first, the first
  // fetch of a fresh selection can't know `total`, so it falls back to the
  // newest page-`page`; once the response carries `total`, we re-issue for the
  // correctly mirrored server page.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        let result = await api.listItems(selection, {
          page,
          order: sortOrder,
          total: totalRef.current,
        })
        if (!cancelled && sortOrder === 'oldest' && totalRef.current === null && result.total > 0) {
          const corrected = await api.listItems(selection, {
            page,
            order: sortOrder,
            total: result.total,
          })
          if (!cancelled) result = corrected
        }
        if (cancelled) return
        totalRef.current = result.total
        setPageData(result)
        setError(null)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Could not load items')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    void run()
    return () => {
      cancelled = true
    }
  }, [selection, page, sortOrder, reloadSeq])

  // Reload the current page after a feed mutation (add/import/refresh/remove):
  // bump the fetch effect's key and refetch the badge counts. Mirrors the
  // retired `loadSeq` idiom, but re-runs one paginated request instead of
  // reloading the whole set.
  const reload = useCallback(() => {
    // A feed mutation can change `total`, which drives the oldest-first server-
    // page mapping. Clear the cached total so the refetch re-derives it (same
    // path as a fresh selection); newest-first ignores `total`, so it's a no-op
    // there. Keeps the post-mutation page at least as correct as before.
    totalRef.current = null
    setReloadSeq((n) => n + 1)
    void refreshCounts()
  }, [refreshCounts])

  // Feed-name attribution: a row/article shows which feed it came from, but
  // only in mixed views (river/all/folder/starred) where feeds are
  // interleaved — in a single-feed view the source just repeats the sidebar
  // selection, so `feedNameFor` is `undefined` there and the eyebrow is dropped.
  const feedsByUrl = useMemo(() => new Map(feeds.map((f) => [f.url, f])), [feeds])
  const feedNameFor = useMemo(
    () =>
      selection.kind === 'feed'
        ? undefined
        : (item: Item) => feedTitleFor(item.feedId, feedsByUrl),
    [selection.kind, feedsByUrl],
  )

  // The loaded page's items — already server-ordered (and reversed for
  // oldest-first by `api.listItems`), so they're rendered straight through with
  // no client-side sort. Optimistic read/star writes patch this array in place.
  const visible = useMemo(() => pageData?.items ?? [], [pageData])

  // The river's total-unread badge is the sum of the per-feed unread counts.
  const riverTotal = useMemo(
    () => Object.values(counts.unreadByFeed).reduce((n, c) => n + c, 0),
    [counts],
  )

  // The open item resolves from the loaded page. A deep link to an item off the
  // current page is Task 7 (a `getItem` fallback); for now it stays unresolved.
  // While a page fetch is in flight and the id isn't found yet, `itemLoading`
  // holds the reading pane in its loading state.
  const selectedItem = useMemo(
    () => (selectedGuid === null ? null : (pageData?.items.find((i) => i.guid === selectedGuid) ?? null)),
    [pageData, selectedGuid],
  )
  const itemLoading = selectedGuid !== null && selectedItem === null && loading

  /** Reflect a read-flag change in the loaded page. */
  const applyRead = useCallback((guid: string, read: boolean) => {
    setPageData((prev) => (prev ? { ...prev, items: setRead(prev.items, guid, read) } : prev))
  }, [])

  const persistRead = useCallback(
    async (guid: string, read: boolean) => {
      applyRead(guid, read)
      try {
        await api.setItemRead(guid, read)
        void refreshCounts()
      } catch (e) {
        applyRead(guid, !read) // revert the optimistic flip
        setError(e instanceof Error ? e.message : 'Could not save read state')
      }
    },
    [applyRead, refreshCounts],
  )

  // Opening an item navigates to its URL (in the context of the current view)
  // and auto-marks it read — the "seen it" signal that keeps the unread count
  // honest; it stays visible in the current snapshot until you leave the view.
  const openItem = useCallback(
    (item: Item) => {
      // Carry `?page` onto the item URL so the still-visible desktop list stays
      // on the user's page (a bare item path would re-derive page 1 and jump).
      navigate(withPage(pathForItem(selection, item.guid), page))
      if (!item.read) void persistRead(item.guid, true)
    },
    [navigate, selection, page, persistRead],
  )

  const toggleRead = useCallback(
    (item: Item) => {
      void persistRead(item.guid, !item.read)
    },
    [persistRead],
  )

  /** Reflect a star-flag change in the loaded page. */
  const applyStar = useCallback((guid: string, starred: boolean) => {
    setPageData((prev) => (prev ? { ...prev, items: setStarred(prev.items, guid, starred) } : prev))
  }, [])

  // Star writes mirror read: optimistic flip, persist, refetch counts, revert on
  // failure. The item stays in the loaded page when unstarred from the starred
  // view (it leaves on the next fetch), so the row doesn't vanish under the cursor.
  const toggleStar = useCallback(
    (item: Item) => {
      const next = !item.starred
      applyStar(item.guid, next)
      void api
        .setItemStar(item.guid, next)
        .then(() => refreshCounts())
        .catch((e) => {
          applyStar(item.guid, !next)
          setError(e instanceof Error ? e.message : 'Could not save starred state')
        })
    },
    [applyStar, refreshCounts],
  )

  // Mark the entire view read server-side via `api.markAllRead` — not just the
  // loaded page. Optimistically patch the loaded page's unread rows for snappy
  // UX (that's all we have client-side); `reload()` then refetches the current
  // page and counts from the server, reconciling both on success or failure.
  const markAllRead = useCallback(() => {
    const guids = unreadGuids(pageData?.items ?? [])
    if (guids.length > 0) {
      setPageData((prev) => (prev ? { ...prev, items: markGuidsRead(prev.items, guids) } : prev))
    }
    void api
      .markAllRead(selection)
      .then(() => reload())
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Could not mark all read')
        reload()
      })
  }, [selection, pageData, reload])

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
        await loadFeeds()
        reload()
        goToSelection({ kind: 'feed', url: feed.url })
      } finally {
        setAdding(false)
      }
    },
    [loadFeeds, reload, goToSelection],
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
        await loadFeeds()
        reload()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Import failed')
      } finally {
        setImporting(false)
      }
    },
    [loadFeeds, reload],
  )

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      await api.refresh()
      await loadFeeds()
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }, [loadFeeds, reload])

  const handleRemove = useCallback(
    async (url: string) => {
      setError(null)
      try {
        await api.removeFeed(url)
        if (selection.kind === 'feed' && selection.url === url) goToSelection({ kind: 'river' })
        await loadFeeds()
        reload()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not unsubscribe')
      }
    },
    [loadFeeds, reload, selection, goToSelection],
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
        const next = nextSelection(visible.map((i) => i.guid), selectedGuid, action.dir)
        // Cursor moves replace history (not push) so Back steps between the
        // views / items you explicitly opened, not every j/k keystroke. The move
        // previews in the reading pane without marking read — 'o'/click do that.
        if (next && next !== selectedGuid)
          navigate(withPage(pathForItem(selection, next), page), { replace: true })
        return
      }
      if (action.kind === 'page') {
        // On desktop the window no longer scrolls (#140) — page the reading
        // pane's own container; fall back to the window on mobile / before the
        // pane mounts.
        const pane = readingScrollRef.current
        if (pane) pane.scrollBy({ top: pageScrollDelta(pane.clientHeight), behavior: 'smooth' })
        else window.scrollBy({ top: pageScrollDelta(window.innerHeight), behavior: 'smooth' })
        return
      }
      const item = visible.find((i) => i.guid === selectedGuid)
      if (!item) return
      if (action.kind === 'star') toggleStar(item)
      else if (action.kind === 'toggleRead') toggleRead(item)
      else if (action.kind === 'open') openItem(item)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible, selectedGuid, toggleStar, toggleRead, openItem, navigate, selection, page])

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
    // Navigate back to the current view's list (drops the /item/:id segment) but
    // KEEP `?page` so returning to the list lands on the page you opened from;
    // the router keeps Back / Forward honest on mobile.
    navigate(withPage(pathForSelection(selection), page))
    // Restore after the list has re-rendered and reclaimed its height.
    requestAnimationFrame(() => window.scrollTo(0, listScrollY.current))
  }, [navigate, selection, page])

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
      unreadCounts={counts.unreadByFeed}
      riverUnread={riverTotal}
      starredCount={counts.starred}
      onSelect={goToSelection}
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

  // Collapsed-sidebar view: the icon rail (#140). Same selection model as the
  // full sidebar, sized to the rail's fixed width.
  const feedRail = (
    <FeedRail
      feeds={feeds}
      selection={selection}
      unreadCounts={counts.unreadByFeed}
      riverUnread={riverTotal}
      starredCount={counts.starred}
      onSelect={goToSelection}
    />
  )

  const errorBanner = error && (
    <p className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">{error}</p>
  )

  const sortButton = (
    <button
      type="button"
      onClick={() => setSortOrder((o) => (o === 'newest' ? 'oldest' : 'newest'))}
      aria-pressed={sortOrder === 'oldest'}
      title="Toggle reading order"
      className="rounded px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
    </button>
  )

  const markAllButton = unreadInView && (
    <button
      type="button"
      onClick={markAllRead}
      className="ml-auto rounded px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      Mark all read
    </button>
  )

  // Desktop-only control that collapses/expands the feed sidebar panel (#140).
  const sidebarToggleButton = (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-pressed={sidebarCollapsed}
      aria-label={sidebarCollapsed ? 'Show feed sidebar' : 'Hide feed sidebar'}
      title={sidebarCollapsed ? 'Show feed sidebar' : 'Hide feed sidebar'}
      className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <line x1="9" y1="4" x2="9" y2="20" />
        <path d={sidebarCollapsed ? 'M13 9l3 3-3 3' : 'M16 9l-3 3 3 3'} />
      </svg>
    </button>
  )

  // Mobile toolbar: sort + mark-all, only once there's a list to act on.
  const listToolbar = visible.length > 0 && (
    <div className="flex items-center border-b border-slate-100 px-3 py-1.5 dark:border-slate-800">
      {sortButton}
      {markAllButton}
    </div>
  )

  if (isDesktop) {
    // Three independently-scrolling regions under the fixed header (#140): the
    // feed sidebar (a resizable/collapsible panel), the item list, and the
    // reading pane. The window itself doesn't scroll — the surface fills the
    // remaining viewport height (see `AppShell`) and each pane owns its overflow.
    return (
      <div className={`mx-auto min-h-0 w-full flex-1 px-4 py-6 sm:px-6 ${containerClass}`}>
        <Group
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <Panel
            id={SIDEBAR_PANEL_ID}
            panelRef={sidebarPanelRef}
            defaultSize={`${SIDEBAR_DEFAULT_SIZE}%`}
            minSize={`${SIDEBAR_MIN_SIZE}%`}
            maxSize={`${SIDEBAR_MAX_SIZE}%`}
            collapsible
            collapsedSize={`${SIDEBAR_RAIL_PX}px`}
            onResize={(size) => setSidebarCollapsed(isCollapsedWidth(size.inPixels))}
            className={sidebarCollapsed ? undefined : 'pr-1'}
          >
            {sidebarCollapsed ? feedRail : sidebar}
          </Panel>

          <Separator className="group relative flex w-3 shrink-0 items-center justify-center">
            <span className="h-10 w-px rounded-full bg-slate-200 transition-colors group-hover:w-0.5 group-hover:bg-blue-400 dark:bg-slate-700 dark:group-hover:bg-blue-500" />
          </Separator>

          <Panel id={CONTENT_PANEL_ID} minSize={`${CONTENT_MIN_SIZE}%`} style={{ overflow: 'hidden' }}>
            <div className="flex h-full min-h-0 gap-4">
              <section className="flex min-h-0 min-w-0 max-w-sm flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                {errorBanner}
                <div className="flex items-center gap-1 border-b border-slate-100 px-2 py-1.5 dark:border-slate-800">
                  {sidebarToggleButton}
                  {visible.length > 0 && sortButton}
                  {markAllButton}
                </div>
                <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto">
                  <ItemList
                    items={visible}
                    loading={loading}
                    selectedGuid={selectedGuid}
                    onSelect={openItem}
                    onToggleStar={toggleStar}
                    onScrolledPast={markScrolledPast}
                    scrollRootRef={listScrollRef}
                    feedNameFor={feedNameFor}
                  />
                </div>
                <Pager page={page} totalPages={pageData?.totalPages ?? 1} onPage={onPage} />
              </section>

              <section
                ref={readingScrollRef}
                className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
              >
                <ReadingPane
                  item={selectedItem}
                  loading={itemLoading}
                  measureClass={measureClass}
                  onToggleRead={toggleRead}
                  onToggleStar={toggleStar}
                  feedNameFor={feedNameFor}
                />
              </section>
            </div>
          </Panel>
        </Group>
      </div>
    )
  }

  // Mobile single-pane flow: the article replaces the list when an item is open
  // (or a deep-linked one is still resolving); otherwise the list is full-width.
  // An unknown id that never resolves falls back to the list. The sidebar is a
  // slide-in drawer.
  const showArticle = selectedItem !== null || itemLoading
  return (
    <>
      {showArticle ? (
        <div className="flex w-full flex-1 flex-col">
          <div className="sticky top-14 z-10 flex items-center gap-2 border-b border-slate-200 bg-white/90 px-3 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
            <button
              type="button"
              onClick={backToList}
              className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            >
              <span aria-hidden="true">←</span> Back
            </button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-500 dark:text-slate-400">
              {selectedItem ? selectedItem.title || '(untitled)' : 'Loading…'}
            </span>
          </div>
          <section className="min-w-0 flex-1 bg-white dark:bg-slate-900">
            <ReadingPane
              item={selectedItem}
              loading={itemLoading}
              measureClass={measureClass}
              onToggleRead={toggleRead}
              onToggleStar={toggleStar}
              feedNameFor={feedNameFor}
            />
          </section>
        </div>
      ) : (
        <div className="flex w-full flex-1 flex-col px-4 py-6">
          <section className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            {errorBanner}
            {listToolbar}
            <ItemList
              items={visible}
              loading={loading}
              selectedGuid={selectedGuid}
              onSelect={openItemMobile}
              onToggleStar={toggleStar}
              onScrolledPast={markScrolledPast}
              feedNameFor={feedNameFor}
            />
            <Pager page={page} totalPages={pageData?.totalPages ?? 1} onPage={onPage} />
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
          className={`absolute inset-y-0 left-0 flex w-80 max-w-[85%] flex-col overflow-y-auto bg-white p-4 shadow-xl transition-transform duration-200 dark:bg-slate-900 ${
            drawerOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {sidebar}
        </div>
      </div>
    </>
  )
}
