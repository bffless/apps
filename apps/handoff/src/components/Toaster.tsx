/**
 * Toaster — renders the transient-toast stack (top-right), portaled to <body>
 * so it floats above all chrome. Subscribes to the module-level toast store.
 */

import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { subscribeToasts, getToasts, dismissToast } from '../lib/toast'
import type { Toast } from '../lib/toast'
import { CheckIcon, XIcon } from './icons'

function ToastRow({ t }: { t: Toast }) {
  const accent =
    t.type === 'error' ? 'text-danger' : t.type === 'info' ? 'text-accent-600' : 'text-success'
  return (
    <div
      role="status"
      className="toast-in pointer-events-auto flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-2.5 shadow-lg"
    >
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${accent}`}>
        {t.type === 'error' ? <XIcon className="h-4 w-4" /> : <CheckIcon className="h-5 w-5" />}
      </span>
      <span className="text-sm text-ink">{t.message}</span>
      <button
        type="button"
        onClick={() => dismissToast(t.id)}
        aria-label="Dismiss"
        className="ml-1 flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts)
  if (toasts.length === 0) return null
  return createPortal(
    <div
      className="pointer-events-none fixed right-4 top-4 flex flex-col gap-2"
      style={{ zIndex: 'var(--z-toast)' }}
    >
      {toasts.map((t) => (
        <ToastRow key={t.id} t={t} />
      ))}
    </div>,
    document.body,
  )
}
