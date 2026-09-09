/**
 * The two bits of chrome every value list in the harness puts beside a value:
 * the mono **tag** that names its declared type, and the **origin** line that
 * names where the value came from (08).
 *
 * Its own plain `.ts` module for the reason `inferDecl` is one: the same value
 * shown on two screens must be labelled the same way on both, and a component
 * file cannot export a non-component (react-refresh/only-export-components).
 * `StepBody` (the evaluated `with` of an attempt) and `DeclaredStepBody` (the
 * declared `with` of a step nothing has run) share both — the run page and the
 * workflow page are showing the same declaration, one with values in it.
 */
import { refsIn } from '../../lib/runner/graph'
import type { ValueRef } from '../../lib/runner/graph'
import type { ValueDecl } from '../../lib/valueDecl'

/** The mono tag beside a value's name: its declared type, and its renderer when named. */
export function kindTag(decl: ValueDecl): string {
  const base = `${decl.type}${decl.list ? ' · list' : ''}`
  return typeof decl.render === 'string' ? `${base} · ${decl.render}` : base
}

/** "`<job>/<step>`" / "`<job>` job output" / "`inputs.<name>`" (08). */
export function originLabel(job: string, ref: ValueRef): string {
  if (ref.context === 'inputs') return `inputs.${ref.name}`
  if (ref.context === 'needs') return `${ref.name} job output`
  return `${job}/${ref.name}`
}

/**
 * Where one entry's value comes from: every upstream value its expressions
 * read, joined — a single entry can read several (`body.lines` *and*
 * `body.photo`). Nothing upstream (a literal) claims no origin at all.
 */
export function originOf(job: string, declared: unknown): string | undefined {
  const labels = refsIn(declared).map((ref) => originLabel(job, ref))
  return labels.length > 0 ? labels.join(', ') : undefined
}
