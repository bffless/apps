import { useCallback, useEffect, useState } from 'react'
import { FeedSidebar, ALL_FEEDS } from './components/FeedSidebar'
import { ItemList } from './components/ItemList'
import { ReadingPane } from './components/ReadingPane'
import * as api from './lib/api'
import type { Feed } from './lib/feeds'
import type { Item } from './lib/items'

/**
 * The authenticated reading surface: feed sidebar · item list · reading pane.
 *
 * This is the #112 tracer — add a feed → refresh → read its items — so state is
 * kept as plain React state (no store slice yet; the river/read/star stores land
 * in #114/#115). All decision logic (URL normalize, item shaping/ordering,
 * sanitize) lives in the tested `lib/*`; this component only orchestrates.
 */
export function ReaderApp() {
  const [feeds, setFeeds] = useState<Feed[]>([])
  const [selectedFeed, setSelectedFeed] = useState<string | null>(ALL_FEEDS)
  const [items, setItems] = useState<Item[]>([])
  const [selectedItem, setSelectedItem] = useState<Item | null>(null)
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

  const loadItems = useCallback(async (feedUrl: string | null) => {
    setItemsLoading(true)
    try {
      const rows = await api.listItems(feedUrl ?? undefined)
      setItems(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load items')
    } finally {
      setItemsLoading(false)
    }
  }, [])

  const selectFeed = useCallback((url: string | null) => {
    setSelectedFeed(url)
    setSelectedItem(null)
  }, [])

  // Initial + dependency-driven data loads. The fetchers setState in their async
  // continuations (the analyzer can't see past the await), which trips
  // set-state-in-effect; this is the monorepo's accepted fetch-in-effect pattern
  // (see apps/handoff/src/App.tsx). The loaders own their own race-safety.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFeeds()
  }, [loadFeeds])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadItems(selectedFeed)
  }, [selectedFeed, loadItems])

  const handleAdd = useCallback(
    async (url: string) => {
      setAdding(true)
      setError(null)
      try {
        const feed = await api.addFeed({ url })
        await api.refresh()
        await loadFeeds()
        setSelectedFeed(feed.url)
        await loadItems(feed.url)
      } finally {
        setAdding(false)
      }
    },
    [loadFeeds, loadItems],
  )

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      await api.refresh()
      await Promise.all([loadFeeds(), loadItems(selectedFeed)])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }, [loadFeeds, loadItems, selectedFeed])

  const handleRemove = useCallback(
    async (url: string) => {
      setError(null)
      try {
        await api.removeFeed(url)
        if (selectedFeed === url) setSelectedFeed(ALL_FEEDS)
        await loadFeeds()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not unsubscribe')
      }
    },
    [loadFeeds, selectedFeed],
  )

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-6 sm:flex-row sm:px-6">
      <FeedSidebar
        feeds={feeds}
        selected={selectedFeed}
        onSelect={selectFeed}
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
          <ItemList
            items={items}
            loading={itemsLoading}
            selectedGuid={selectedItem?.guid ?? null}
            onSelect={setSelectedItem}
          />
        </section>

        <section className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white">
          <ReadingPane item={selectedItem} />
        </section>
      </div>
    </div>
  )
}
