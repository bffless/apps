/**
 * The DOM ids a step row and its body carry — `greet/1/say` is not a valid id
 * on its own, and two screens need the same answer: `StepRow` stamps them
 * (`aria-controls`), and the job page looks the row up by id to scroll a
 * newly-followed step into view.
 *
 * A plain `.ts` module so neither component file has to export a
 * non-component (react-refresh/only-export-components).
 */
import type { StepKey } from '../../lib/runner/types'

export function stepRowId(key: StepKey): string {
  return `step-row-${key.replace(/[^a-z0-9]/gi, '-')}`
}

export function stepBodyId(key: StepKey): string {
  return `${stepRowId(key)}-body`
}
