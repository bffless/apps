import type { ProjectWorkingState } from '../store/studioSlice'
import { phaseOf } from './projects'

/** The phases that appear in the URL. `import` (story 11a's phaseOf result for a
 *  source-less project) collapses to `prep` — there is no `import` URL. */
export const URL_PHASES = ['prep', 'build', 'export'] as const
export type UrlPhase = (typeof URL_PHASES)[number]

const isUrlPhase = (v: string | undefined): v is UrlPhase =>
  v !== undefined && (URL_PHASES as readonly string[]).includes(v)

/** Furthest phase the project may currently show, on the prep<build<export ladder. */
export function maxPhaseFor(w: ProjectWorkingState): UrlPhase {
  const p = phaseOf(w) // 'import' | 'prep' | 'build' | 'export'
  return p === 'import' ? 'prep' : p
}

/** Resolve a requested URL phase against the project's state: either render it
 *  (`{ phase }`) or redirect (`{ redirectTo }`) to the furthest allowed phase. */
export function resolvePhase(
  w: ProjectWorkingState,
  requested: string | undefined,
): { phase: UrlPhase } | { redirectTo: UrlPhase } {
  const max = maxPhaseFor(w)
  if (!isUrlPhase(requested)) return { redirectTo: max }
  if (URL_PHASES.indexOf(requested) > URL_PHASES.indexOf(max)) return { redirectTo: max }
  return { phase: requested }
}
