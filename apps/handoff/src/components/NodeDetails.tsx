/**
 * Details block for the file/site viewer: shows the node's display Title
 * (falling back to its filename) + Description, and — for writers — an
 * "Edit details" dialog that PATCHes /api/node/meta. Additive metadata: the
 * filename stays the node's identity; title/description only enrich the viewer
 * and the RSS feed.
 */
import { useState } from 'react'
import type { HandoffNode } from '../lib/nodes'
import { useUpdateNodeMetaMutation } from '../store/handoffApi'
import { toast } from '../lib/toast'

const TITLE_MAX = 200
const DESC_MAX = 2000

export function NodeDetails({ node, canEdit }: { node: HandoffNode; canEdit: boolean }) {
  const [open, setOpen] = useState(false)
  const hasMeta = !!node.title || !!node.description
  if (!hasMeta && !canEdit) return null

  return (
    <div className="border-b border-border bg-surface px-4 py-3">
      {hasMeta ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">
              {node.title || node.name}
            </h1>
            {canEdit && (
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="shrink-0 rounded px-2 py-1 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                Edit details
              </button>
            )}
          </div>
          {node.title && <p className="mt-0.5 text-xs text-muted">{node.name}</p>}
          {node.description && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{node.description}</p>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm text-muted transition-colors hover:text-ink"
        >
          + Add title &amp; description
        </button>
      )}
      {open && <EditDetailsDialog node={node} onClose={() => setOpen(false)} />}
    </div>
  )
}

function EditDetailsDialog({ node, onClose }: { node: HandoffNode; onClose: () => void }) {
  const [title, setTitle] = useState(node.title ?? '')
  const [description, setDescription] = useState(node.description ?? '')
  const [updateMeta, { isLoading }] = useUpdateNodeMetaMutation()

  async function handleSave() {
    try {
      await updateMeta({ id: node.id, title, description, parentId: node.parentId }).unwrap()
      toast('Details saved.')
      onClose()
    } catch {
      toast('Couldn’t save details. Please try again.', 'error')
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit details"
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 'var(--z-modal)' }}
      onClick={() => { if (!isLoading) onClose() }}
    >
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <div
        className="relative w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-ink">Edit details</h2>
        <label className="block text-xs font-medium text-muted">Title</label>
        <input
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={node.name}
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
        />
        <label className="mt-3 block text-xs font-medium text-muted">Description</label>
        <textarea
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
            onClick={onClose}
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
    </div>
  )
}
