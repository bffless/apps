/**
 * Module-level store for in-flight uploads — the single channel between the
 * upload mutations (which run inside RTK Query `queryFn`s, far from any
 * component) and the `UploadTray` that renders them.
 *
 * Same shape as `toast.ts`: a plain store + `useSyncExternalStore`, so any
 * layer can report progress without prop-drilling or context. Toasts stay the
 * "it worked" moment; an upload entry is *located, detail-bearing* feedback —
 * a 300 MB file needs a bar, a byte count and a cancel button, not a 3.5s
 * confirmation (ADR-0004 hybrid).
 *
 * An entry is created by the caller *before* the first network call, so a drop
 * is acknowledged instantly even while `POST /api/uploads/prepare` is still in
 * flight.
 */

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'canceled'

export interface UploadItem {
  id: string
  /** File name, or the site/folder name for a multi-file group. */
  name: string
  /** Byte size of the file currently transferring (0 when not yet known). */
  size: number
  /** Bytes handed to the socket so far for the current file. */
  loaded: number
  status: UploadStatus
  error?: string
  /** Total files in a folder/site import; undefined for a single file. */
  fileCount?: number
  /** 1-based index of the file currently transferring within a group. */
  fileIndex?: number
}

/** How long a finished (done/canceled) entry lingers before it disappears. */
export const DONE_DISMISS_MS = 4000

let uploads: UploadItem[] = []
let counter = 0
const listeners = new Set<() => void>()
/** Abort handles for live transfers, keyed by upload id. */
const aborts = new Map<string, () => void>()
/**
 * Ids the user canceled. Outlives the entry itself: the mutation rejects a
 * moment after the abort, and its caller needs to know that the failure was a
 * deliberate cancel (stay quiet) rather than a real error (say so).
 */
const canceled = new Set<string>()

function emit() {
  for (const l of listeners) l()
}

/** Replace one entry by id, no-op if it is gone. Terminal states are final. */
function patch(id: string, changes: Partial<UploadItem>, force = false) {
  const idx = uploads.findIndex((u) => u.id === id)
  if (idx === -1) return
  const current = uploads[idx]
  if (!force && isTerminal(current.status)) return
  const next = uploads.slice()
  next[idx] = { ...current, ...changes }
  uploads = next
  emit()
}

function isTerminal(status: UploadStatus): boolean {
  return status === 'done' || status === 'error' || status === 'canceled'
}

/** Register an entry and return its id. Visible to the tray immediately. */
export function beginUpload({
  name,
  size,
  fileCount,
}: {
  name: string
  size: number
  fileCount?: number
}): string {
  const id = `u${++counter}`
  uploads = [...uploads, { id, name, size, loaded: 0, status: 'queued', fileCount }]
  emit()
  return id
}

/**
 * Report transferred bytes. `opts.size` / `opts.fileIndex` let a folder import
 * re-point the same entry at the next file in its group.
 */
export function setUploadProgress(
  id: string,
  loaded: number,
  opts?: { size?: number; fileIndex?: number },
): void {
  const current = uploads.find((u) => u.id === id)
  if (!current || isTerminal(current.status)) return
  const size = opts?.size ?? current.size
  patch(id, {
    status: 'uploading',
    size,
    loaded: size > 0 ? Math.min(loaded, size) : loaded,
    ...(opts?.fileIndex === undefined ? {} : { fileIndex: opts.fileIndex }),
  })
}

function scheduleDismiss(id: string) {
  setTimeout(() => dismissUpload(id), DONE_DISMISS_MS)
}

export function completeUpload(id: string): void {
  const current = uploads.find((u) => u.id === id)
  if (!current || isTerminal(current.status)) return
  aborts.delete(id)
  patch(id, { status: 'done', loaded: current.size })
  scheduleDismiss(id)
}

/** Failures stay put — the message is the only record of what went wrong. */
export function failUpload(id: string, error: string): void {
  aborts.delete(id)
  patch(id, { status: 'error', error })
}

/** Abort the live transfer (if any) and mark the entry canceled. */
export function cancelUpload(id: string): void {
  const current = uploads.find((u) => u.id === id)
  if (!current || isTerminal(current.status)) return
  const abort = aborts.get(id)
  aborts.delete(id)
  canceled.add(id)
  abort?.()
  patch(id, { status: 'canceled' })
  scheduleDismiss(id)
}

/** Did the user cancel this upload? True even after the entry auto-dismissed. */
export function isUploadCanceled(id: string): boolean {
  return canceled.has(id)
}

/** Hand the store the abort function for a transfer, so the tray's × works. */
export function registerAbort(id: string, abort: () => void): void {
  aborts.set(id, abort)
}

export function dismissUpload(id: string): void {
  aborts.delete(id)
  const next = uploads.filter((u) => u.id !== id)
  if (next.length === uploads.length) return
  uploads = next
  emit()
}

/** Clear every terminal entry, leaving live transfers alone (tray "close"). */
export function clearFinishedUploads(): void {
  const next = uploads.filter((u) => !isTerminal(u.status))
  if (next.length === uploads.length) return
  for (const u of uploads) if (isTerminal(u.status)) aborts.delete(u.id)
  uploads = next
  emit()
}

export function subscribeUploads(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export function getUploads(): UploadItem[] {
  return uploads
}

/** Test-only: drop all state so suites don't leak entries into each other. */
export function resetUploadsForTest(): void {
  uploads = []
  aborts.clear()
  canceled.clear()
  counter = 0
  emit()
}
