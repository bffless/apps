/**
 * The `script` step adapter (03): the pure half of a script step — the
 * evaluated `with` a script module is invoked with, and the validation a
 * module's returned outputs must pass before they become the step's outputs.
 *
 * Everything that touches the Worker (loading the module, running it,
 * cancellation/`timeout-minutes`) lives above this module, mirroring
 * `island.ts`: the host hands plain data down and, on the return path, gets
 * validated outputs or an `OutputTypeError` back — never a raw throw from a
 * definition it didn't cause. Uploading/registering a returned `Blob`/`File`/
 * path is injected (`ScriptOutputDeps`), the same seam `coerceOutputs`
 * (pipeline) uses for `registerFile` — this module never touches storage
 * itself.
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import { buildContexts, evalDeep } from '../contexts'
import { resolveSrc } from './island'
import { OutputTypeError } from '../outputs'
import type { FileRef } from '../types'
import { expectedToken, isPlainObject, obj, outputDecls, validateDeclared, type StepScope } from './declared'

/** Same shape as `IslandStepArgs`/`StepScope` (declared.ts) — a script step needs nothing more. */
export type ScriptStepArgs = StepScope

/**
 * The evaluated `with` of a script step, split into the host-consumed `src`
 * and the module's `inputs` (03) — the same split `islandInputs` makes, minus
 * `title`/`display` (a script has no frame to configure).
 */
export function scriptInputs(a: ScriptStepArgs): { src: string; inputs: Record<string, unknown> } {
  const contexts = buildContexts(a.def, a.state, {
    job: a.job,
    index: a.index,
    stepId: a.step.id,
  })

  const evaluated = obj(evalDeep(obj(obj(a.step.raw).with), contexts))

  // The linter guarantees `src` (`script-src-ext`, mirroring `island-src-ext`):
  // reaching here without one is a definition bug, not a runtime state (09).
  const src = evaluated.src
  if (typeof src !== 'string' || src === '') {
    throw new Error(`script step ${a.step.id}: \`with.src\` must be a string`)
  }

  const inputs: Record<string, unknown> = { ...evaluated }
  delete inputs.src

  return { src, inputs }
}

/**
 * The script module's URL — `scripts/bundle.js` → `/w/<impl>/scripts/bundle.js`,
 * the *same* own-implementation rule an island's `src` passes through, so a
 * script cannot reach another implementation's bundle or an off-site module
 * however the path is spelled. Delegates to `resolveSrc` rather than repeating
 * the traversal checks; only the error label differs (an author whose script
 * `src` is wrong should not be told about islands). Throws on an escaping
 * `src`: a definition bug, not a runtime state (09).
 */
export function resolveScriptSrc(impl: string, src: string): string {
  return resolveSrc(impl, src, 'script')
}

/**
 * `ctx.annotate`'s argument, on the shape `annotateEvent` validates.
 *
 * A script's `ctx.annotate` takes **one** annotation — 03 and
 * `@bffless/workflow-script`: `{ level, message, title? } | { summary }` —
 * where an island's `workflow.annotate` *tool* takes the row's own shape
 * (`{ annotations: [...], summary }`). `annotateEvent` (island.ts) validates
 * the latter and is deliberately the only validator either path has, so the
 * single annotation is lifted into it here rather than a second set of rules
 * being written for scripts. Anything already in the row shape, or nothing
 * recognizable at all, is passed straight through for `annotateEvent` to
 * accept or refuse — a script that sends nonsense must get the same message an
 * island would.
 */
export function scriptAnnotateArgs(args: unknown): unknown {
  if (!isPlainObject(args)) return args
  if ('annotations' in args) return args
  if ('level' in args || 'message' in args || 'title' in args) return { annotations: [args] }
  return args
}

// ---------------------------------------------------------------------------
// Output coercion (03/06) — Blob/File → upload, string → registerFile
// ---------------------------------------------------------------------------

export interface ScriptOutputDeps {
  uploadBlob: (blob: Blob, name: string) => Promise<FileRef>
  registerFile: (path: string) => Promise<FileRef>
}

/** A MIME type → the extension `blobFileName` falls back to for a bare `Blob` — a pure table, no dependency. */
const BLOB_EXT: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/json': 'json',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
}

/**
 * The name a materialized `Blob` uploads under: a `File`'s own name, else the
 * declared output's name plus an extension guessed from its MIME type
 * (`.bin` when unknown or empty) — a bare `Blob` carries no filename of its
 * own (03).
 */
export function blobFileName(output: string, blob: Blob): string {
  if (blob instanceof File && blob.name !== '') return blob.name
  return `${output}.${BLOB_EXT[blob.type] ?? 'bin'}`
}

/** One output value against one `file`-declared slot: Blob/File → upload, string → registerFile. */
async function materializeFileValue(
  name: string,
  value: unknown,
  deps: ScriptOutputDeps,
): Promise<unknown> {
  if (value instanceof Blob) return deps.uploadBlob(value, blobFileName(name, value))
  if (typeof value === 'string') return deps.registerFile(value)
  return value // already File-ref shaped, or malformed — validateDeclared catches it below
}

/** As above, `list: true`-aware: uploads/registers every item, in order. */
async function materializeFile(
  name: string,
  value: unknown,
  list: boolean,
  deps: ScriptOutputDeps,
): Promise<unknown> {
  if (value === null || value === undefined) return value
  if (list) {
    if (!Array.isArray(value)) return value
    return Promise.all(value.map((v) => materializeFileValue(name, v, deps)))
  }
  return materializeFileValue(name, value, deps)
}

/**
 * Validate/coerce a script module's returned value against the step's
 * declared outputs (02/03). Every declared output is treated as *required*
 * here (unlike a form/island field): a script's return value is its entire
 * contract (03), so a name the module didn't return is as much a fault as a
 * wrong-typed one.
 *
 * Two passes, in this order (apps#375): first the whole declared set is
 * checked with every `file` slot read as "present?" only — so a missing or
 * wrong-typed non-file output refuses the return value *before a single byte
 * has moved*; then each `file` output is materialized — a `Blob`/`File` is
 * uploaded, a `string` is registered, both in list order for `list: true` —
 * and the set runs through the same `validateDeclared` walk a form/island
 * submit uses, this time for real. Uploading first and validating after left
 * bytes under the step prefix whenever a later output failed. A validation
 * error, a missing declared output, or a wrong-typed file value all throw
 * `OutputTypeError` (the pipeline adapter's `toStepError` already maps it to
 * `OUTPUT_TYPE`; a script-step runtime does the same), whose `expected` is
 * the declared type token (`number`, `file[]`), never a sentence.
 */
export async function coerceScriptOutputs(
  a: ScriptStepArgs,
  returned: unknown,
  deps: ScriptOutputDeps,
): Promise<Record<string, unknown>> {
  const decls = outputDecls(a.step)
  const values: Record<string, unknown> = isPlainObject(returned) ? { ...returned } : {}
  const required: Record<string, Record<string, unknown>> = {}
  const presence: Record<string, Record<string, unknown>> = {}

  for (const [name, declared] of Object.entries(decls)) {
    const decl = typeof declared === 'string' ? {} : obj(declared)
    // Every declared output is required here — see the doc comment above.
    required[name] = { ...decl, required: true }
    // A `file` slot before materialization holds a Blob, a path or nothing:
    // `json` accepts the first two, and `required` still refuses the last.
    presence[name] = decl.type === 'file' ? { ...required[name], type: 'json', list: false } : required[name]
  }

  const refuse = (errors: Record<string, string>): void => {
    const [firstError] = Object.entries(errors)
    if (!firstError) return
    const [name] = firstError
    throw new OutputTypeError(name, expectedToken(required[name] ?? {}, 'json'), values[name] ?? null)
  }

  refuse(validateDeclared(presence, values, { defaultType: 'json' }).errors)

  for (const [name, decl] of Object.entries(required)) {
    if (decl.type !== 'file') continue
    values[name] = await materializeFile(name, values[name], decl.list === true, deps)
  }

  const { outputs, errors } = validateDeclared(required, values, { defaultType: 'json' })
  refuse(errors)
  return outputs
}
