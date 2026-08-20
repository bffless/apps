/**
 * Discovery itself failed (08 treats error states as first-class): the alias
 * list could not be read, so the harness knows nothing about this project —
 * which is *not* the same as the project having published nothing, and must
 * never be reported as such.
 */
import { EmptyState } from './EmptyState'

/** RTK Query's error union (`FetchBaseQueryError | SerializedError`), as one line. */
function detail(error: unknown): string {
  const e = (error ?? {}) as { status?: unknown; error?: unknown; message?: unknown }
  if (typeof e.status === 'number') return `The alias list answered ${e.status}.`
  if (typeof e.error === 'string') return e.error
  if (typeof e.message === 'string') return e.message
  if (typeof e.status === 'string') return `The alias list request ${e.status}.`
  return 'The alias list request did not complete.'
}

export function DiscoveryError({ error }: { error?: unknown }) {
  return (
    <EmptyState title="Couldn't reach the server">
      <p className="empty-detail">{detail(error)}</p>
      <p>
        Discovery could not list this project's deployments, so no implementation can be shown.
        Nothing is wrong with what you published — try again once the server answers.
      </p>
    </EmptyState>
  )
}
