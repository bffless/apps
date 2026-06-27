/**
 * ShareDialog — the single Share surface used everywhere (folder toolbar, row
 * kebab, viewer). Composes People/grants + the share-link section in a native
 * <dialog> (focus-trapped, Escape-closable). For a file it shares the file's
 * containing folder and offers a file-direct link (ADR-0004).
 */

import { useEffect, useRef } from 'react'
import { PeopleAccess } from './ManageAccessPanel'
import { ShareLinksSection } from './ShareLinksSection'
import { XIcon, ShareIcon } from './icons'

export interface ShareDialogProps {
  folderId: string
  /** Display name of what's being shared (folder name, or the file's name). */
  title: string
  /** When set, the link section produces a file-direct link to this node. */
  nodeId?: string
  /** True when sharing a file (shows the "shares the containing folder" note). */
  isFile?: boolean
  onClose: () => void
}

export function ShareDialog({ folderId, title, nodeId, isFile, onClose }: ShareDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

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
        <PeopleAccess folderId={folderId} />
        <ShareLinksSection folderId={folderId} nodeId={nodeId} />
      </div>
    </dialog>
  )
}
