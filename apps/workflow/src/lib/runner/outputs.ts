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

/** Exported for reuse by `payload.ts`'s `isFilePayload` — the same File-ref shape check. */
export function isFileRef(v: unknown): v is FileRef {
  if (v === null || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.path === 'string' &&
    typeof r.name === 'string' &&
    typeof r.contentType === 'string' &&
    typeof r.size === 'number' &&
    typeof r.url === 'string'
  )
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
    return Promise.all(raw.map((v) => materializeFile(v, registerFile)))
  }
  return materializeFile(raw, registerFile)
}

async function coerceOne(
  name: string,
  decl: OutputDecl,
  contexts: Record<string, unknown>,
  registerFile: RegisterFile,
): Promise<unknown> {
  if (typeof decl === 'string') return evalValue(decl, contexts)

  // Omitted `value` → null (03: a step outputs map with no value for a name).
  const raw = decl.value === undefined ? null : evalDeep(decl.value, contexts)
  const shaped = decl.type === 'table' ? assembleTable(decl, raw) : raw
  const value = await materialize(decl.type, decl.list, shaped, registerFile)

  if (decl.type && !validateValue(decl.type, decl.list, value)) {
    throw new OutputTypeError(name, decl.list ? `${decl.type}[]` : decl.type, value)
  }
  return value
}

/**
 * Evaluate a pipeline step's declared `outputs` against `response` (and the
 * rest of `contexts`); validate against the closed vocabulary (02). Omitted
 * `decls` exposes exactly `{ response }` (03) — a pipeline step with no
 * `outputs` map.
 */
export async function coerceOutputs(
  decls: Record<string, OutputDecl> | undefined,
  contexts: Record<string, unknown>,
  registerFile: RegisterFile,
): Promise<Record<string, unknown>> {
  if (!decls) return { response: (contexts.response as unknown) ?? null }

  const out: Record<string, unknown> = {}
  for (const [name, decl] of Object.entries(decls)) {
    out[name] = await coerceOne(name, decl, contexts, registerFile)
  }
  return out
}
