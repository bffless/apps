/**
 * The `mapping` a declaration hands its renderer (02), read once and in one
 * place. `render: chart` wants `{ x, y, kind? }` and `render: code` wants
 * `{ language }`, but both start from the same question — "is this an object
 * at all?" — and both answered it with their own copy of the guard until
 * apps#380. One `record()` here, two typed readers over it.
 *
 * Every reader is total: an absent, null, or wrongly-shaped mapping answers
 * `null`/`undefined` rather than throwing, because the value it describes came
 * from a run row's JSON and a renderer's job is to still show something,
 * honestly.
 */

export type ChartKind = 'bar' | 'line'

export interface ChartMapping {
  x: string
  y: string
  kind: ChartKind
}

/** The one null-guard: `mapping` as a plain bag of unknowns, or `null`. */
function record(mapping: unknown): Record<string, unknown> | null {
  if (mapping === null || typeof mapping !== 'object') return null
  return mapping as Record<string, unknown>
}

/** `render: chart`'s axes. Both `x` and `y` must name a column; `kind` defaults to `line`. */
export function chartMapping(mapping: unknown): ChartMapping | null {
  const m = record(mapping)
  if (!m) return null
  if (typeof m.x !== 'string' || typeof m.y !== 'string') return null
  return { x: m.x, y: m.y, kind: m.kind === 'bar' ? 'bar' : 'line' }
}

/**
 * `render: code`'s requested language — the *requested* one, whether or not
 * `lib/highlight` has it registered; `CodeView` reports what was asked for
 * either way.
 */
export function codeLanguage(mapping: unknown): string | undefined {
  const m = record(mapping)
  if (!m) return undefined
  return typeof m.language === 'string' ? m.language : undefined
}
