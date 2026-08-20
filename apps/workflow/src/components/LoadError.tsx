/**
 * A fetch that *failed* — as distinct from one that succeeded and found nothing
 * (08 treats both as first-class, and conflating them is the worse bug: "No
 * such run" for a run that exists is a lie the user cannot tell from the truth).
 *
 * Always offers the retry, because the common cause is a token that expired
 * mid-read or a server that blinked, and both are fixed by asking again.
 */
import { EmptyState } from './EmptyState'

/** RTK Query's error union (`FetchBaseQueryError | SerializedError`), as one line. */
function detail(error: unknown): string {
  const e = (error ?? {}) as { status?: unknown; error?: unknown; message?: unknown }
  if (typeof e.status === 'number') return `The server answered ${e.status}.`
  if (typeof e.error === 'string') return e.error
  if (typeof e.message === 'string') return e.message
  if (typeof e.status === 'string') return `The request ${e.status}.`
  return 'The request did not complete.'
}

export function LoadError({
  title,
  error,
  onRetry,
}: {
  title: string
  error?: unknown
  onRetry: () => void
}) {
  return (
    <EmptyState title={title}>
      <p className="empty-detail">{detail(error)}</p>
      <button type="button" className="link-button" onClick={onRetry}>
        Retry
      </button>
    </EmptyState>
  )
}
