/**
 * What a step declares about waiting: its `headless:` mode (07) and its
 * `timeout-minutes` budget (01/D13).
 *
 * Both are read straight off `step.raw` — the parsed YAML, not a typed model —
 * so this is the one place that knows their spellings and their defaults. It
 * exists because three modules that must agree were each reading them
 * separately: the graph chip (which shows the mode), the script launcher (which
 * times its Worker), and now the wait clock the middleware puts on `island` /
 * `form` steps (Decision 10). A disagreement between those readings would show
 * up as a step that displays one budget and enforces another.
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import type { Step } from './types'

export type HeadlessMode = 'skip' | 'auto'

/**
 * `headless: skip|auto` (bare form) or `headless: { mode: skip|auto, ... }`
 * (07) — `undefined` for a step that declares no `headless` at all. Defensive
 * on a headless block with no `mode`: the schema requires one, but `auto` is
 * the harness's own default if that ever slips through.
 */
export function headlessMode(step: Step): HeadlessMode | undefined {
  const h = step.raw?.headless as unknown
  if (h === 'skip' || h === 'auto') return h
  if (h !== null && typeof h === 'object') {
    const mode = (h as { mode?: unknown }).mode
    if (mode === 'skip' || mode === 'auto') return mode
    if (mode === undefined) return 'auto'
  }
  return undefined
}

/** The step's declared `timeout-minutes` budget in ms, if it declared one (01). */
export function budgetMs(step: Step): number | undefined {
  const minutes = ((step.raw ?? {}) as Record<string, unknown>)['timeout-minutes']
  return typeof minutes === 'number' ? minutes * 60_000 : undefined
}

/**
 * What a headless run gives an `island`/`form` step that declared no budget of
 * its own (04/07: "default 5 in headless"). There is no equivalent for an
 * interactive run on purpose — a person is allowed to take as long as they
 * like, and a harness that timed them out would lose their work.
 */
export const HEADLESS_AUTO_DEFAULT_MS = 5 * 60_000

/**
 * How long a step may sit `waiting` before it fails (Decision 10). The declared
 * budget always wins — a workflow that says one minute means one minute whether
 * a person or CI is driving — and `undefined` means "no clock at all".
 */
export function waitBudgetMs(step: Step, headless: boolean): number | undefined {
  return budgetMs(step) ?? (headless ? HEADLESS_AUTO_DEFAULT_MS : undefined)
}
