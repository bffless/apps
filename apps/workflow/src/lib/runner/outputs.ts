/**
 * Typed output coercion (02): evaluates a pipeline step's declared `outputs`
 * against the step's `response` (and the rest of the site's contexts), then
 * validates each value against the closed type vocabulary. A bare string
 * where `file` is declared is registered into a File ref (02, "Pipelines may
 * return a bare path string where a `file` is declared").
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint). File
 * registration is injected as `registerFile` — this module never touches
 * storage itself.
 */
import type { OutputDecl } from '@bffless/workflow-lint/definition'
import type { FileRef } from './types'
import { evalDeep, evalValue } from './contexts'
import { isFileRefLike } from './fileRef'

export class OutputTypeError extends Error {
  output: string
  expected: string
  got: unknown

  // Parameter properties (`public output: string`) are TS syntax that emits a
  // field assignment, which `erasableSyntaxOnly` (tsconfig) forbids — so the
  // three fields are declared above and assigned by hand here instead.
  constructor(output: string, expected: string, got: unknown) {
    super(`output ${output}: expected ${expected}`)
    this.output = output
    this.expected = expected
    this.got = got
  }
}

export type RegisterFile = (path: string) => Promise<FileRef>

/**
 * How many registrations a `list: true` file output keeps in flight at once.
 * Each is one `files/register` call; a pipeline can answer with a long list
 * (Studio's blog `frames` returns ~170 stills), and firing them all together
 * is what turned two transient 500s into a failed step (apps#490). Four is
 * enough to keep a long list quick without shaping a burst.
 */
export const REGISTER_CONCURRENCY = 4

/**
 * `items.map(fn)` with at most `limit` calls pending at once. Results keep
 * `items`' order; the first rejection rejects the whole thing once the calls
 * already in flight have settled (no new call is started after a failure).
 */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  // A holder rather than a nullable `let`: the workers assign it inside their
  // own async closures, which TS's control-flow narrowing cannot see through.
  const failure: { hit: boolean; err: unknown } = { hit: false, err: undefined }
  const worker = async () => {
    while (next < items.length && !failure.hit) {
      const i = next++
      try {
        results[i] = await fn(items[i] as T)
      } catch (err) {
        if (!failure.hit) {
          failure.hit = true
          failure.err = err
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure.hit) throw failure.err
  return results
}

/**
 * The **strict** File-ref check — a `type: file` value promises `contentType`
 * and `size` as well as the three keys that name the file, because everything
 * downstream (the cards, a job output, an offloaded payload) reads them. Built
 * on the shared shape guard (`./fileRef`) so "names a file" is one rule, not a
 * fourth copy of it.
 *
 * Exported for reuse by `payload.ts`'s `isFilePayload` — the same shape check.
 */
export function isFileRef(v: unknown): v is FileRef {
  if (!isFileRefLike(v)) return false
  // The guard above only promises the three naming keys, so these two are a
  // real runtime check even though it has already narrowed `v` to `FileRef`.
  const { contentType, size } = v
  return typeof contentType === 'string' && typeof size === 'number'
}

/** One value against one scalar type of the 02 vocabulary. */
function validateScalar(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
    case 'choice':
    case 'markdown':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    case 'file':
      return isFileRef(value)
    case 'table': {
      if (value === null || typeof value !== 'object') return false
      const t = value as Record<string, unknown>
      return Array.isArray(t.columns) && Array.isArray(t.rows)
    }
    case 'json':
      return true
    default:
      // The vocabulary is closed by the linter (02); an unrecognised type name
      // here is a lint problem, not something this runtime check should reject.
      return true
  }
}

/**
 * Validate an already-produced value (e.g. a `form` submit) against a
 * declared field type. `null` always passes — a skipped/failed upstream
 * step, or an unanswered optional field, is not a type error (01/02).
 */
export function validateValue(type: string, list: boolean | undefined, value: unknown): boolean {
  if (value === null) return true
  if (list) return Array.isArray(value) && value.every((v) => v === null || validateScalar(type, v))
  return validateScalar(type, value)
}

async function materializeFile(v: unknown, registerFile: RegisterFile): Promise<unknown> {
  if (v === null) return null
  if (typeof v === 'string') return registerFile(v)
  return v // already File-ref shaped (or malformed — validateValue below catches it)
}

/**
 * `table`-typed values only: the documented pattern (02, and studio.workflow.yaml's
 * `scenes` output) declares `columns` on the decl and lets `value` evaluate to a
 * bare rows array — assemble the canonical `{ columns, rows }` shape from the two
 * before validation. A value that already arrives `{ columns, rows }` shaped (or
 * isn't a bare array at all) passes through untouched.
 */
function assembleTable(decl: Record<string, unknown>, raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw
  const columns = decl.columns
  if (!Array.isArray(columns)) return raw
  return { columns, rows: raw }
}

/** `file`-typed values only: register a bare path string into a File ref. */
async function materialize(
  type: string | undefined,
  list: boolean | undefined,
  raw: unknown,
  registerFile: RegisterFile,
): Promise<unknown> {
  if (type !== 'file' || raw === null) return raw
  if (list) {
    if (!Array.isArray(raw)) return raw
    return mapConcurrent(raw, REGISTER_CONCURRENCY, (v) => materializeFile(v, registerFile))
  }
  return materializeFile(raw, registerFile)
}

/** The evaluated (and, for `table`, assembled) value of one declaration — nothing registered yet. */
function evaluateOne(decl: OutputDecl, contexts: Record<string, unknown>): unknown {
  if (typeof decl === 'string') return evalValue(decl, contexts)
  // Omitted `value` → null (03: a step outputs map with no value for a name).
  const raw = decl.value === undefined ? null : evalDeep(decl.value, contexts)
  return decl.type === 'table' ? assembleTable(decl, raw) : raw
}

function check(name: string, decl: OutputDecl, value: unknown): void {
  if (typeof decl === 'string' || !decl.type) return
  if (!validateValue(decl.type, decl.list, value)) {
    throw new OutputTypeError(name, decl.list ? `${decl.type}[]` : decl.type, value)
  }
}

/**
 * Evaluate a pipeline step's declared `outputs` against `response` (and the
 * rest of `contexts`); validate against the closed vocabulary (02). Omitted
 * `decls` exposes exactly `{ response }` (03) — a pipeline step with no
 * `outputs` map.
 *
 * Order matters (apps#375): every declaration is evaluated and every
 * non-`file` one validated *before* the first `file` is registered, so a
 * later declaration's type failure never leaves a registered file behind for
 * a step that then fails `OUTPUT_TYPE`. The returned map keeps declaration
 * order either way.
 */
export async function coerceOutputs(
  decls: Record<string, OutputDecl> | undefined,
  contexts: Record<string, unknown>,
  registerFile: RegisterFile,
): Promise<Record<string, unknown>> {
  if (!decls) return { response: (contexts.response as unknown) ?? null }

  const out: Record<string, unknown> = {}
  const files: [string, OutputDecl][] = []
  for (const [name, decl] of Object.entries(decls)) {
    out[name] = evaluateOne(decl, contexts)
    if (typeof decl !== 'string' && decl.type === 'file') files.push([name, decl])
    else check(name, decl, out[name])
  }

  for (const [name, decl] of files) {
    const typed = decl as Exclude<OutputDecl, string>
    out[name] = await materialize(typed.type, typed.list, out[name], registerFile)
    check(name, decl, out[name])
  }
  return out
}
