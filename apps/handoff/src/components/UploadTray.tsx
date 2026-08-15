/**
 * UploadTray — the bottom-right panel that shows what is currently uploading.
 *
 * A 300 MB file used to look identical to a hung one: nothing moved until the
 * listing refetched, sometimes half a minute later. The tray is the *located,
 * detail-bearing* half of the ADR-0004 feedback split — a row appears the
 * instant a file is dropped (before `prepare` has even answered), tracks bytes
 * on the wire, and offers a cancel; toasts stay for the short "it worked" note.
 *
 * Reads the module-level uploads store (`lib/uploads`) via `useSyncExternalStore`
 * and portals to <body>, mirroring `Toaster`, so no page has to host it.
 */

import { useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  subscribeUploads,
  getUploads,
  cancelUpload,
  clearFinishedUploads,
  dismissUpload,
} from '../lib/uploads'
import type { UploadItem } from '../lib/uploads'
import { formatBytes } from '../lib/format'
import { ChevronDownIcon, ChevronUpIcon, FolderIcon, NodeIcon, XIcon } from './icons'

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function percentOf(u: UploadItem): number {
  if (u.status === 'done') return 100
  if (u.size <= 0) return 0
  return Math.min(100, Math.round((u.loaded / u.size) * 100))
}

/**
 * The one line under a row's name. Bytes are what a slow upload needs; the
 * "Finishing…" state covers the gap between the last byte leaving the socket
 * and the node being registered, so the bar never sits at a lying 100%.
 */
function statusLine(u: UploadItem): string {
  switch (u.status) {
    case 'queued':
      return 'Queued'
    case 'done':
      return 'Done'
    case 'canceled':
      return 'Canceled'
    case 'error':
      return u.error ?? 'Upload failed'
    case 'uploading': {
      if (u.size > 0 && u.loaded >= u.size) return 'Finishing…'
      const bytes = `${formatBytes(u.loaded)} of ${formatBytes(u.size)}`
      return u.fileCount === undefined
        ? bytes
        : `${u.fileIndex ?? 0} of ${plural(u.fileCount, 'file')} · ${bytes}`
    }
  }
}

function headerLabel(uploads: UploadItem[]): string {
  const live = uploads.filter((u) => u.status === 'queued' || u.status === 'uploading').length
  if (live > 0) return `Uploading ${plural(live, 'file')}`
  const failed = uploads.filter((u) => u.status === 'error').length
  if (failed > 0) return `${plural(failed, 'upload')} failed`
  const canceled = uploads.filter((u) => u.status === 'canceled').length
  if (canceled === uploads.length) return `${plural(canceled, 'upload')} canceled`
  return `${plural(uploads.filter((u) => u.status === 'done').length, 'upload')} complete`
}

function UploadRow({ u }: { u: UploadItem }) {
  const live = u.status === 'queued' || u.status === 'uploading'
  const pct = percentOf(u)
  const tone =
    u.status === 'error' ? 'text-danger' : u.status === 'done' ? 'text-success' : 'text-muted'

  return (
    <li className="flex items-start gap-2.5 px-3.5 py-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-muted">
        {u.fileCount === undefined ? (
          <NodeIcon type="file" name={u.name} mime={null} className="h-4 w-4" />
        ) : (
          <FolderIcon className="h-4 w-4" />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink" title={u.name}>
          {u.name}
        </span>

        {live && (
          <span
            role="progressbar"
            aria-label={`Uploading ${u.name}`}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
          >
            <span
              className="block h-full rounded-full bg-accent-500 transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </span>
        )}

        <span className={`mt-1 block text-xs ${tone}`}>{statusLine(u)}</span>
      </span>

      {live ? (
        <button
          type="button"
          onClick={() => cancelUpload(u.id)}
          aria-label={`Cancel upload of ${u.name}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => dismissUpload(u.id)}
          aria-label={`Dismiss ${u.name}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      )}

      {live && (
        <span className="mt-0.5 w-9 shrink-0 text-right text-xs tabular-nums text-muted">
          {pct}%
        </span>
      )}
    </li>
  )
}

export function UploadTray() {
  const uploads = useSyncExternalStore(subscribeUploads, getUploads, getUploads)
  const [collapsed, setCollapsed] = useState(false)

  if (uploads.length === 0) return null

  const hasFinished = uploads.some(
    (u) => u.status === 'done' || u.status === 'error' || u.status === 'canceled',
  )

  return createPortal(
    <div
      className="toast-in fixed bottom-4 left-4 right-4 overflow-hidden rounded-xl border border-border bg-surface shadow-lg sm:left-auto sm:w-96"
      style={{ zIndex: 'var(--z-sticky)' }}
      role="region"
      aria-label="Uploads"
    >
      <div className="flex items-center gap-1 border-b border-border bg-surface-2 px-3.5 py-2">
        <span className="flex-1 truncate text-sm font-medium text-ink">
          {headerLabel(uploads)}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'}
          className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface hover:text-ink"
        >
          {collapsed ? (
            <ChevronUpIcon className="h-4 w-4" />
          ) : (
            <ChevronDownIcon className="h-4 w-4" />
          )}
        </button>
        {hasFinished && (
          <button
            type="button"
            onClick={clearFinishedUploads}
            aria-label="Clear finished uploads"
            className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* `m-0 list-none p-0`: this app's base CSS keeps the UA's list padding and
          disc marker, which would otherwise indent every row by 40px. */}
      {!collapsed && (
        <ul className="m-0 max-h-72 list-none divide-y divide-border overflow-y-auto p-0">
          {uploads.map((u) => (
            <UploadRow key={u.id} u={u} />
          ))}
        </ul>
      )}
    </div>,
    document.body,
  )
}
