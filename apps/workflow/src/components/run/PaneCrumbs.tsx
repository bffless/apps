/**
 * Where the card under the graph sits in the taxonomy (08: run › job › step),
 * as a breadcrumb in its head — the same shape as the shell's own, so a person
 * reads their position the same way at both levels of the page. Every segment
 * above the current one is a way up: the nearest is the "Back" the tests and
 * Esc use (`step-pane-back`), the first is the run.
 *
 * Selection is the URL's `?step=` (RunPage), so each click is a history entry.
 */
export interface Crumb {
  label: string
  /** Absent for a segment that is not a level of its own (the run card's "Run"). */
  onClick?: () => void
}

export function PaneCrumbs({
  trail,
  current,
  note,
}: {
  /** The levels above, outermost first. */
  trail: Crumb[]
  /** This card's own name. */
  current: string
  /** A trailing qualifier — `item 2 of 2`, `for each who · max 2 at once`. */
  note?: string
}) {
  return (
    <nav className="pane-crumbs" aria-label="Where this sits">
      {trail.map((crumb, i) => (
        <span className="pane-crumb-slot" key={`${i}-${crumb.label}`}>
          {crumb.onClick ? (
            <button
              type="button"
              className="pane-crumb"
              data-testid={i === trail.length - 1 ? 'step-pane-back' : undefined}
              onClick={crumb.onClick}
            >
              {crumb.label}
            </button>
          ) : (
            <span className="pane-crumb is-static">{crumb.label}</span>
          )}
          <span className="pane-crumb-sep" aria-hidden="true">
            ›
          </span>
        </span>
      ))}
      <span className="pane-crumb is-current" aria-current="location">
        {current}
      </span>
      {note && <span className="pane-crumb-note">· {note}</span>}
    </nav>
  )
}
