/**
 * The one "show all N …" / "show fewer" control every folded viewer shares
 * (02 "Inferred shapes"): a compact list past `LIST_PREVIEW`, a table past
 * `TABLE_PREVIEW_ROWS`, a `list: true` value past `LIST_ITEMS_PREVIEW`. The
 * count is always the real total, so folding hides rows, never the fact of them.
 */
export function ShowAll({
  total,
  unit,
  open,
  onToggle,
}: {
  total: number
  unit: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="value-more"
      data-testid="value-more"
      aria-pressed={open}
      onClick={onToggle}
    >
      {open ? 'show fewer' : `show all ${total} ${unit}`}
    </button>
  )
}
