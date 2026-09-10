/**
 * The bar above a list of collapsible values: how many there are, and the one
 * control that opens or closes all of them (2026-09-09 UX review).
 *
 * Every value in the list is closed by default, so "how many is this?" is a
 * question the closed list has to answer, and "show me everything" has to stay
 * one click away — that was the shape of the old always-open pane, and losing
 * it entirely would trade one complaint for another.
 */
import { pluralize } from '../../lib/plural'

export function ExpandAll({
  count,
  unit,
  open,
  onToggle,
}: {
  count: number
  /** Singular; pluralised with the count ("output" → "3 outputs"). */
  unit: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="values-bar">
      <span className="values-count">{pluralize(count, unit)}</span>
      <button
        type="button"
        className="values-expand"
        data-testid="values-expand-all"
        aria-pressed={open}
        onClick={onToggle}
      >
        {open ? 'Collapse all' : 'Expand all'}
      </button>
    </div>
  )
}
