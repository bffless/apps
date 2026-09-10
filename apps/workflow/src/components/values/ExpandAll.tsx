/**
 * The bar above a list of collapsible values: how many there are, and the one
 * control that opens or closes all of them (2026-09-09 UX review).
 *
 * Every value in the list is closed by default, so "how many is this?" is a
 * question the closed list has to answer, and "show me everything" has to stay
 * one click away — that was the shape of the old always-open pane, and losing
 * it entirely would trade one complaint for another.
 *
 * Two numbers, one rule each. `total` is how many values the pane holds, and
 * it is what the label says — the count answers "how big is this list?", so it
 * has to count the list. `foldable` is how many of them actually fold, and it
 * only decides whether the bar exists: a `form` step's inputs are typically
 * three short strings, none of which folds, and a bar reading "3 inputs ·
 * Expand all" over a pane where pressing it changes nothing is worse than no
 * bar. Conflating the two made the bar say "2 outputs" over a list of five
 * (round 4) — islands and one-line values are still outputs.
 */
import { pluralize } from '../../lib/plural'

export function ExpandAll({
  total,
  foldable,
  unit,
  open,
  onToggle,
}: {
  /** How many values the pane holds — the number the label prints. */
  total: number
  /** How many of them fold; zero renders nothing at all. */
  foldable: number
  /** Singular; pluralised with the total ("output" → "3 outputs"). */
  unit: string
  open: boolean
  onToggle: () => void
}) {
  if (foldable === 0) return null
  return (
    <div className="values-bar">
      <span className="values-count">{pluralize(total, unit)}</span>
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
