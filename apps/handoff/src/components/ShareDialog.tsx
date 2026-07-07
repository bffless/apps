/**
 * ShareDialog — the single Share surface used everywhere (folder toolbar, row
 * kebab, viewer). Composes People/grants + the share-link section in a native
 * <dialog> (focus-trapped, Escape-closable). For a file it shares the file's
 * containing folder and offers a file-direct link (ADR-0004).
 */

import { useEffect, useRef, useState } from 'react'
import { PeopleAccess, GeneralAccess, FeedExclusion } from './ManageAccessPanel'
import { ShareLinksSection } from './ShareLinksSection'
import { XIcon, ShareIcon, RssIcon } from './icons'
import { useGetGrantsQuery } from '../store/handoffApi'
import { hasAnyoneGrant, isEffectivelyPublic, type FolderLink } from '../lib/acl'
import { feedUrl } from '../lib/pathUrl'

export interface ShareDialogProps {
  folderId: string
  /** Display name of what's being shared (folder name, or the file's name). */
  title: string
  /** When set, the link section produces a file-direct link to this node. */
  nodeId?: string
  /** True when sharing a file (shows the "shares the containing folder" note). */
  isFile?: boolean
  /**
   * Root → parent chain (this folder's own link excluded). Optional — absent
   * means "behave as today" (own-grant state only), forwarded to
   * `GeneralAccess` and used for the share-links `isPublic` note.
   */
  parentChain?: FolderLink[]
  /** This folder's own inheritance mode. Absent is treated as 'inheriting'. */
  folderMode?: 'inheriting' | 'restricted'
  /**
   * This folder's feed-exclusion flag (#191). Owner/admin see a toggle for it;
   * absent is treated as false. Ignored for file targets.
   */
  folderFeedExcluded?: boolean
  /** Parent folder id of the shared folder — forwarded for cache invalidation. */
  parentId?: string
  /**
   * Content path of the folder being shared ('' for the root folder). When set
   * and the folder is effectively public, the dialog offers a tokenless
   * "Copy RSS feed URL" (#188). Absent for file targets.
   */
  feedPath?: string
  onClose: () => void
}

export function ShareDialog({ folderId, title, nodeId, isFile, parentChain, folderMode, folderFeedExcluded, parentId, feedPath, onClose }: ShareDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  // RTK Query dedupes this with GeneralAccess/PeopleAccess's identical query.
  const { data: grantsData } = useGetGrantsQuery({ folderId })
  const ownAnyone = hasAnyoneGrant(grantsData?.grants ?? [])
  const inheritedPublic = folderMode !== 'restricted' && isEffectivelyPublic(parentChain ?? [])
  const isPublic = ownAnyone || inheritedPublic

  useEffect(() => {
    const dlg = ref.current
    if (dlg && !dlg.open) dlg.showModal()
  }, [])

  function handleClose() {
    ref.current?.close()
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        // Backdrop click (the dialog element itself is the click target).
        if (e.target === ref.current) handleClose()
      }}
      className="share-dialog m-auto w-full max-w-lg rounded-xl border border-border bg-surface p-0 text-ink shadow-lg backdrop:bg-black/40"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-bg text-accent-600">
            <ShareIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-ink">Share “{title}”</h2>
            {isFile && (
              <p className="truncate text-xs text-muted">
                Sharing the containing folder — people you add can see everything in it.
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close"
          className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
        <GeneralAccess folderId={folderId} parentChain={parentChain} folderMode={folderMode} />
        {isPublic && !isFile && feedPath != null && <PublicFeedRow feedPath={feedPath} />}
        {!isFile && (
          <FeedExclusion folderId={folderId} feedExcluded={folderFeedExcluded} parentId={parentId} />
        )}
        <PeopleAccess folderId={folderId} />
        <ShareLinksSection
          folderId={folderId}
          nodeId={nodeId}
          fileName={isFile ? title : undefined}
          isPublic={isPublic}
          feedPath={isFile ? undefined : feedPath}
        />
      </div>
    </dialog>
  )
}

/**
 * PublicFeedRow — the tokenless "Copy RSS feed URL" affordance for an
 * effectively-public folder (#188). The URL is path-based (`/feed/<path>.xml`,
 * or `/feed.xml` for the root) and carries no token — safe to share publicly.
 */
function PublicFeedRow({ feedPath }: { feedPath: string }) {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}${feedUrl(feedPath)}`

  function handleCopy() {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <RssIcon className="h-4 w-4 shrink-0 text-accent-600" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">RSS feed</p>
            <p className="truncate font-mono text-xs text-muted">{url}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface-2"
        >
          {copied ? 'Copied!' : 'Copy RSS feed URL'}
        </button>
      </div>
    </div>
  )
}
