/**
 * Minimal toast store for transient confirmations (link copied, uploaded,
 * imported). Detail-bearing or located feedback stays inline near its action —
 * toasts are only for "it worked" / "it failed" moments (ADR-0004 hybrid).
 *
 * Module-level store + useSyncExternalStore so any component can `toast(...)`
 * without prop-drilling or context.
 */

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  message: string
  type: ToastType
}

let toasts: Toast[] = []
let counter = 0
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function toast(message: string, type: ToastType = 'success'): number {
  const id = ++counter
  toasts = [...toasts, { id, message, type }]
  emit()
  setTimeout(() => dismissToast(id), 3500)
  return id
}

export function subscribeToasts(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export function getToasts(): Toast[] {
  return toasts
}
