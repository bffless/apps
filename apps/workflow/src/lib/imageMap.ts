/**
 * A `markdown` output's image map (02 `images`, apps#446), evaluated.
 *
 * The declaration carries the map *as written* — usually one expression,
 * `images: ${{ steps.<id>.outputs.<name> }}` — keyed by each image `src`
 * exactly as it appears in the markdown, with an uploads-relative path (or a
 * File ref, whose `path` is used) as the value. The keys are opaque to the
 * harness: whatever convention a workflow's own steps use to write and map
 * them is theirs. This module turns the map into the src → **serve url** map
 * `lib/markdown` rewrites images through, and picks the contexts it is
 * evaluated in:
 *
 * - a step output reads its map at the step's own *summary* site — its own
 *   outputs visible (a step may map the paths it just produced), the earlier
 *   steps of the same item, and no `response` (the map is read after the
 *   step, off the persisted row, not from a live response);
 * - a job- or run-level typed declaration reads job / run contexts, exactly as
 *   its `value` did;
 * - a bare job/run output that *followed* to a step's declaration
 *   (`lib/outputDecls`) reads that step's site.
 *
 * Because every context comes from the persisted step rows, a replayed or
 * read-only run page resolves the same map the live one did.
 *
 * Pure (no React/Redux), like the rest of `lib/`.
 */
import { fileUrl } from './coerce'
import type { DeclSite } from './outputDecls'
import { buildContexts, buildJobContexts, buildRunContexts, evalDeep } from './runner/contexts'
import { isFileRefLike } from './runner/fileRef'
import type { Definition, RunState, StepState } from './runner/types'
import { stepKey } from './runner/types'
import { isServeUrl } from './url'
import type { ValueDecl } from './valueDecl'

/** `src` as written in the markdown → the same-origin serve url to draw it from. */
export type ImageMap = Record<string, string>

/**
 * Evaluate a declared map in `contexts` and keep only the entries that name a
 * file the harness may draw: a non-empty path string or a File ref, whose
 * serve url passes the strict file-route gate (`isServeUrl` — a value that
 * climbs out of `/api/uploads/` with `..` is dropped, not rewritten). An
 * expression that fails to evaluate, or a value that is not an object, is an
 * empty map: the markdown then renders exactly as it would without `images`.
 */
export function resolveImageMap(declared: unknown, contexts: Record<string, unknown>): ImageMap {
  let evaluated: unknown
  try {
    evaluated = evalDeep(declared, contexts)
  } catch {
    return {}
  }
  const out: ImageMap = {}
  if (evaluated === null || typeof evaluated !== 'object' || Array.isArray(evaluated)) return out
  for (const [src, target] of Object.entries(evaluated as Record<string, unknown>)) {
    const path = typeof target === 'string' ? target : isFileRefLike(target) ? target.path : undefined
    if (typeof path !== 'string' || path.trim() === '') continue
    const url = fileUrl(path.trim())
    if (isServeUrl(url)) out[src] = url
  }
  return out
}

/** One step output's map, at the step's own summary site (own outputs visible). */
export function stepImageMap(
  def: Definition,
  state: RunState,
  step: StepState,
  decl: ValueDecl,
): ImageMap | undefined {
  if (decl.images === undefined) return undefined
  const contexts = buildContexts(def, state, {
    job: step.job,
    index: step.index,
    stepId: step.stepId,
    selfOutputs: step.outputs ?? {},
  })
  return resolveImageMap(decl.images, contexts)
}

/**
 * A job- or run-level output's map, at the site its typed declaration was
 * found (`resolveOutput`). A matrix job's collected output is a list with one
 * map per item, which no viewer draws yet — it stays unmapped rather than
 * showing item 0's frames on every item.
 */
export function outputImageMap(
  def: Definition,
  state: RunState,
  decl: ValueDecl,
  site: DeclSite | null,
): ImageMap | undefined {
  if (decl.images === undefined || site === null) return undefined
  switch (site.kind) {
    case 'run':
      return resolveImageMap(decl.images, buildRunContexts(def, state))
    case 'job':
      if (def.jobs[site.job]?.matrix) return undefined
      return resolveImageMap(decl.images, buildJobContexts(def, state, site.job))
    case 'step': {
      if (site.matrix) return undefined
      const own = state.steps[stepKey(site.job, 0, site.step)]
      return own ? stepImageMap(def, state, own, decl) : undefined
    }
  }
}
