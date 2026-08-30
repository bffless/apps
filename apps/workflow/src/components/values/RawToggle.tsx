/**
 * The pane head's **Show raw** switch (08, apps#450) — the run, job and step
 * panes all carry one, and they are one switch: `rawPreference` is a single
 * store, so flipping it in any pane flips every value on the page.
 */
import { setShowRaw, useShowRaw } from './rawPreference'

export function RawToggle() {
  const on = useShowRaw()
  return (
    <button
      type="button"
      className="pane-raw"
      data-testid="pane-raw"
      aria-pressed={on}
      title={on ? 'Show values as declared and inferred' : 'Show every value as the raw JSON the row holds'}
      onClick={() => setShowRaw(!on)}
    >
      Show raw
    </button>
  )
}
