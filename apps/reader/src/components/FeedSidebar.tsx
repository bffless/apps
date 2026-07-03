import { feedLabel, type Feed } from '../lib/feeds'
import { folderNames, folderUnread, groupFeedsByFolder } from '../lib/folders'
import { selectionEquals, type Selection } from '../lib/river'
import { AddFeed } from './AddFeed'

/**
 * Left rail: add-feed, a "Refresh now" action, and the subscription list, led by
 * the cross-feed views — **River** (unread everywhere), **All items**, and
 * **★ Starred**. Below them the feeds are grouped by folder (#116): each named
 * folder is a clickable per-folder view with its own unread badge, and
 * uncategorized feeds trail after. Grouping/counting is the pure `lib/folders`
 * seam; the sidebar only renders it and lets a feed be moved between folders.
 */
export function FeedSidebar({
  feeds,
  selection,
  unreadCounts,
  riverUnread,
  starredCount,
  onSelect,
  onAdd,
  onRemove,
  onMoveFolder,
  onRefresh,
  adding,
  refreshing,
}: {
  feeds: Feed[]
  selection: Selection
  unreadCounts: Record<string, number>
  riverUnread: number
  starredCount: number
  onSelect: (sel: Selection) => void
  onAdd: (url: string) => Promise<void>
  onRemove: (url: string) => void
  onMoveFolder: (feed: Feed, folder: string | null) => void
  onRefresh: () => void
  adding: boolean
  refreshing: boolean
}) {
  const groups = groupFeedsByFolder(feeds)
  const existingFolders = folderNames(feeds)

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
        <FeedRow
          label="★ Starred"
          active={selectionEquals(selection, { kind: 'starred' })}
          count={starredCount}
          onClick={() => onSelect({ kind: 'starred' })}
        />
        <div className="my-1 border-t border-slate-100" />

        {groups.map((group) => (
          <div key={group.folder ?? ' uncategorized'} className="flex flex-col gap-0.5">
            {group.folder != null && (
              <FeedRow
                label={group.folder}
                folder
                active={selectionEquals(selection, { kind: 'folder', name: group.folder })}
                count={folderUnread(unreadCounts, group.feeds)}
                onClick={() => onSelect({ kind: 'folder', name: group.folder as string })}
              />
            )}
            {group.feeds.map((feed) => (
              <FeedRow
                key={feed.url}
                label={feedLabel(feed)}
                indent={group.folder != null}
                active={selectionEquals(selection, { kind: 'feed', url: feed.url })}
                count={unreadCounts[feed.url] ?? 0}
                error={feed.lastError}
                folders={existingFolders}
                currentFolder={feed.folder}
                onClick={() => onSelect({ kind: 'feed', url: feed.url })}
                onRemove={() => onRemove(feed.url)}
                onMoveFolder={(folder) => onMoveFolder(feed, folder)}
              />
            ))}
          </div>
        ))}

        {feeds.length === 0 && (
          <p className="px-2 py-3 text-sm text-slate-400">No feeds yet. Add one above.</p>
        )}
      </nav>
    </aside>
  )
}

/** A special option value that can't collide with a real folder name. */
const NEW_FOLDER = ' new'
const NO_FOLDER = ' none'

function FeedRow({
  label,
  active,
  count,
  error,
  folder,
  indent,
  folders,
  currentFolder,
  onClick,
  onRemove,
  onMoveFolder,
}: {
  label: string
  active: boolean
  count?: number
  error?: string | null
  /** This row is a folder header (bold, not indented). */
  folder?: boolean
  /** This row is a feed inside a folder (indented). */
  indent?: boolean
  folders?: string[]
  currentFolder?: string | null
  onClick: () => void
  onRemove?: () => void
  onMoveFolder?: (folder: string | null) => void
}) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
        indent ? 'ml-3' : ''
      } ${active ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-100'}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`min-w-0 flex-1 truncate text-left ${folder ? 'font-medium' : ''}`}
        title={label}
      >
        {folder && <span className="mr-1 text-slate-400" aria-hidden>📁</span>}
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
      {onMoveFolder && (
        <select
          aria-label={`Move ${label} to a folder`}
          title="Move to folder"
          value={currentFolder ?? NO_FOLDER}
          onChange={(e) => {
            const v = e.target.value
            if (v === NEW_FOLDER) {
              const name = window.prompt('New folder name')?.trim()
              if (name) onMoveFolder(name)
              return
            }
            onMoveFolder(v === NO_FOLDER ? null : v)
          }}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 rounded border border-transparent bg-transparent text-xs text-slate-400 opacity-0 transition-opacity focus:border-slate-300 focus:opacity-100 group-hover:opacity-100"
        >
          <option value={NO_FOLDER}>Uncategorized</option>
          {(folders ?? []).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          {/* Keep the current folder selectable even if it's the only feed in it. */}
          {currentFolder && !(folders ?? []).includes(currentFolder) && (
            <option value={currentFolder}>{currentFolder}</option>
          )}
          <option value={NEW_FOLDER}>＋ New folder…</option>
        </select>
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
