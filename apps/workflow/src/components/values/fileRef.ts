/**
 * The single UI-side File-ref guard: every component that has to decide
 * whether an `unknown` value is a File ref (ValueView's `file` dispatch,
 * StepPane, RunOutputs, RunsPage) imports this one, so they cannot drift
 * apart. The runner has its own copy in `lib/runner/outputs.ts` because
 * `lib/runner/**` is pure and may not import from `components/` (spec 09) —
 * that one stays behind the fence, and this one is the only guard above it.
 *
 * A `file`-declared value only needs to actually look like a File ref before
 * FileCard trusts it: the dispatch site (`ValueView`) can't verify an
 * `unknown` value with a type cast alone. `contentType`/`size` are checked
 * separately, defensively, inside FileCard, since a value can satisfy this
 * guard while still missing them (a bare `path` string is also valid per 02
 * and is handled by the caller, not this guard) — and the `url` this guard
 * accepts is a *string*, not a safe one: FileCard runs it through
 * `lib/url`'s `isSafeUrl` before it reaches an attribute.
 */
import type { FileRef } from '../../lib/runner/types'
import type { ValueDecl } from '../../lib/valueDecl'

export function isFileRef(value: unknown): value is FileRef {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.path === 'string' && typeof v.name === 'string' && typeof v.url === 'string'
}

/**
 * A bare `${{ … }}` output carries no type, so `outputDecls` resolves it to
 * `json` and only the *value* can say it is a file (02) — that inference is
 * what turns a job's `poster: ${{ steps.draw.outputs.poster }}` into a file
 * card. It stops at a declaration that **names a renderer**: `render: island`
 * over a File ref is a viewer for that file (M3 Task 10's `poster_view`), and
 * coercing it to `file` would silently overrule what the author asked for.
 *
 * Shared by the three panes that show a declared value beside a recorded one
 * (run, job, step) — the rule is one rule, and three copies of it drifted
 * apart is exactly how `poster_view` came out as a file card.
 */
export function withFileRefValue(decl: ValueDecl, value: unknown): ValueDecl {
  return decl.type === 'json' && !decl.list && decl.render === undefined && isFileRef(value)
    ? { type: 'file' }
    : decl
}
