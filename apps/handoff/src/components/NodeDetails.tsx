/**
 * Details affordance for the file/site viewer: a compact control-bar trigger
 * opening a popover with the node's display Title (falling back to its
 * filename) + Description, and — for writers — an "Edit details" dialog that
 * PATCHes /api/node/meta. Lives in the control bar (not its own chrome row) so
 * the viewer keeps a single, slim header above the content. Additive metadata:
 * the filename stays the node's identity; title/description only enrich the
 * viewer and the RSS feed.
 */
import { useEffect, useRef, useState } from 'react'
import type { HandoffNode } from '../lib/nodes'
import { useUpdateNodeMetaMutation } from '../store/handoffApi'
import { toast } from '../lib/toast'
import { InfoIcon } from './icons'

const TITLE_MAX = 200
const DESC_MAX = 2000

export function NodeDetails({ node, canEdit }: { node: HandoffNode; canEdit: boolean }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const hasMeta = !!node.title || !!node.description

  // Outside click / Escape close the popover (the edit dialog manages itself).
  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!hasMeta && !canEdit) return null

  return (
    <span ref={wrapRef} className="relative flex shrink-0">
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Details"
        className={[
          'inline-flex items-center gap-1 rounded px-2 py-1 text-sm transition-colors hover:bg-surface-2 hover:text-ink',
          open ? 'bg-surface-2 text-ink' : 'text-muted',
        ].join(' ')}
      >
        <InfoIcon className="h-4 w-4" />
        <span className="hidden sm:inline">Details</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Details"
          className="menu-pop absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-4 shadow-md"
          style={{ zIndex: 'var(--z-dropdown)' }}
        >
          {hasMeta ? (
            <>
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 flex-1 break-words text-sm font-semibold text-ink">
                  {node.title || node.name}
                </h2>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false)
                      setEditing(true)
                    }}
                    className="-mr-1 -mt-0.5 shrink-0 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    Edit details
                  </button>
                )}
              </div>
              {node.title && <p className="mt-0.5 break-words text-xs text-muted">{node.name}</p>}
              {node.description && (
                <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-ink">
                  {node.description}
                </p>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setEditing(true)
              }}
              className="text-sm text-muted transition-colors hover:text-ink"
            >
              + Add title &amp; description
            </button>
          )}
        </div>
      )}

      {editing && <EditDetailsDialog node={node} onClose={() => setEditing(false)} />}
    </span>
  )
}

/**
 * Native <dialog> + showModal(), mirroring ShareDialog.tsx: focus-trapped and
 * Escape-closable for free. Escape (and any other native close) fires the
 * dialog's 'close' event, wired straight to `onClose`; the Cancel button and
 * backdrop click both go through `handleClose` -> `ref.current.close()` so
 * every path converges on that same 'close' event instead of duplicating the
 * close logic.
 */
function EditDetailsDialog({ node, onClose }: { node: HandoffNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState(node.title ?? '')
  const [description, setDescription] = useState(node.description ?? '')
  const [updateMeta, { isLoading }] = useUpdateNodeMetaMutation()

  useEffect(() => {
    const dlg = ref.current
    if (dlg && !dlg.open) dlg.showModal()
  }, [])

  function handleClose() {
    ref.current?.close()
  }

  async function handleSave() {
    try {
      await updateMeta({ id: node.id, title, description, parentId: node.parentId }).unwrap()
      toast('Details saved.')
      handleClose()
    } catch {
      toast('Couldn’t save details. Please try again.', 'error')
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        // Backdrop click (the dialog element itself is the click target).
        if (e.target === ref.current) handleClose()
      }}
      aria-label="Edit details"
      className="m-auto w-full max-w-md rounded-xl border border-border bg-surface p-0 text-ink shadow-lg backdrop:bg-black/40"
    >
      <div className="p-6">
        <h2 className="mb-3 text-sm font-semibold text-ink">Edit details</h2>
        <label htmlFor="node-details-title" className="block text-xs font-medium text-muted">
          Title
        </label>
        <input
          id="node-details-title"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={node.name}
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
        />
        <label htmlFor="node-details-description" className="mt-3 block text-xs font-medium text-muted">
          Description
        </label>
        <textarea
          id="node-details-description"
          value={description}
          maxLength={DESC_MAX}
          rows={4}
          onChange={(e) => setDescription(e.target.value)}
          className="mt-1 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={isLoading}
            onClick={handleClose}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isLoading}
            onClick={handleSave}
            className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isLoading ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </dialog>
  )
}
