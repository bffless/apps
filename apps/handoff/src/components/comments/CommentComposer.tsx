/**
 * The one text-entry control the comment gutter uses — for a new thread (draft
 * card), a reply, and an in-place edit. Auto-growing textarea + a Post button,
 * with Cmd/Ctrl+Enter as the keyboard commit so a comment never costs a mouse
 * trip. Submitting is the caller's business: this owns only the draft text and
 * clears it once `onSubmit` has been handed the trimmed body.
 */
import { useState } from 'react'

export interface CommentComposerProps {
  onSubmit: (body: string) => void
  busy: boolean
  placeholder: string
  autoFocus?: boolean
  /** Label for the submit button. Defaults to "Post". */
  submitLabel?: string
  /** Optional secondary action rendered beside the submit button. */
  onCancel?: () => void
  /** Initial text — used by the edit-in-place flow. */
  initialValue?: string
}

export function CommentComposer({
  onSubmit,
  busy,
  placeholder,
  autoFocus,
  submitLabel = 'Post',
  onCancel,
  initialValue = '',
}: CommentComposerProps) {
  const [value, setValue] = useState(initialValue)
  const trimmed = value.trim()

  function submit() {
    if (!trimmed || busy) return
    onSubmit(trimmed)
    setValue('')
  }

  return (
    <div className="mt-2">
      <textarea
        value={value}
        rows={2}
        placeholder={placeholder}
        aria-label={placeholder}
        /* A draft card only ever opens in direct response to the user selecting
           text or dropping a pin, so stealing focus is the expected behaviour. */
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
        className="w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-muted"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          disabled={busy || !trimmed}
          onClick={submit}
          className="rounded-md bg-accent-600 px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Posting…' : submitLabel}
        </button>
      </div>
    </div>
  )
}
