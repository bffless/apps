/**
 * EmptyState — the "nothing in this folder" panel. Extracted from FolderView.
 * The signed-out root variant is the public-browse landing for guests when
 * nothing (or nothing public) is visible (ADR-0005).
 */
import { UploadIcon } from './icons'

export function EmptyState({
  canWrite,
  isRoot,
  signedOut,
  onNew,
  onSignIn,
}: {
  canWrite: boolean
  isRoot: boolean
  signedOut: boolean
  onNew: () => void
  onSignIn: () => void
}) {
  const guestAtRoot = signedOut && isRoot && !canWrite
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-bg text-accent-600">
        <UploadIcon className="h-7 w-7" />
      </div>
      <h2 className="text-base font-semibold text-ink">
        {guestAtRoot ? 'Nothing public here' : isRoot ? 'Nothing here yet' : 'This folder is empty'}
      </h2>
      <p className="mt-1 max-w-sm text-sm text-muted">
        {guestAtRoot
          ? "Sign in to view your team's content."
          : canWrite
            ? 'Drag files or a folder anywhere on this page, or use New to upload content and create sub-folders.'
            : "There's nothing to see in this folder yet."}
      </p>
      {guestAtRoot && (
        <button
          type="button"
          onClick={onSignIn}
          className="mt-5 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-700"
        >
          Sign in
        </button>
      )}
      {!guestAtRoot && canWrite && (
        <button
          type="button"
          onClick={onNew}
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-700"
        >
          <UploadIcon className="h-4 w-4" />
          Upload files
        </button>
      )}
    </div>
  )
}
