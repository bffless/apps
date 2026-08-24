/**
 * The `island` step adapter (03/04): the pure half of an interactive step —
 * the tool input an island is opened with, the paths its `src` and its tool
 * calls resolve to, and the validation a `workflow.submit` / `workflow.annotate`
 * must pass before it becomes an engine event.
 *
 * Everything that touches the DOM (the sandboxed iframe, the ext-apps host
 * bridge, the 30 s `ISLAND_LOAD` timer) lives above this module: the host hands
 * plain data down and gets events or errors back. Like the `form` adapter this
 * module has no effects and, on the submit path, **never throws** — rejected
 * input comes back as per-output messages. The two *definition-bug* paths do
 * throw (`with.src` missing, a `src`/tool name that escapes the implementation),
 * because those are bugs, not runtime states (09).
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import type { InputDef, OutputDecl } from '@bffless/workflow-lint/definition'
import { buildContexts, evalDeep } from '../contexts'
import { validateInputConstraints } from '../inputConstraints'
import { validateValue } from '../outputs'
import { evalAnnotations, evalSummary } from '../results'
import type { Annotation, Definition, RunEvent, RunState, Step, StepKey } from '../types'

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** A JSON object — an array is not a bag of named values. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** "Unanswered" for the purposes of `required` — `false` and `0` are answers. */
function blank(value: unknown, list: boolean): boolean {
  if (value === null || value === undefined || value === '') return true
  return list && Array.isArray(value) && value.length === 0
}

function article(type: string, list: boolean): string {
  return list ? `a list of ${type} values` : `a ${type} value`
}

/**
 * `with` keys the host consumes itself: they configure the frame, so they are
 * **not** delivered as tool input (04). Exported because the linter's
 * `island-reserved-with` rule and the host must agree on one list.
 */
export const ISLAND_RESERVED = ['src', 'title', 'display'] as const

export interface IslandStepArgs {
  step: Step
  key: StepKey
  job: string
  index: number
  def: Definition
  state: RunState
}

export interface IslandInputs {
  src: string
  title: string
  display: 'inline' | 'fullscreen'
  /** The tool-input `arguments` — and, verbatim, the step's persisted `inputs` (Decision 11). */
  arguments: Record<string, unknown>
}

/**
 * The evaluated `with` of an island step, split into the three host-owned keys
 * and the tool `arguments`. The arguments are also exactly what `step.started`
 * records as `inputs`, so a resumed island re-mounts from the record rather
 * than re-evaluating (D16, Decision 11).
 */
export function islandInputs(a: IslandStepArgs): IslandInputs {
  const contexts = buildContexts(a.def, a.state, {
    job: a.job,
    index: a.index,
    stepId: a.step.id,
  })

  const evaluated = obj(evalDeep(obj(obj(a.step.raw).with), contexts))

  // The linter guarantees `src` (`island-src-ext`, Decision 17): reaching here
  // without one is a definition bug, not a runtime state — so it throws (09).
  const src = evaluated.src
  if (typeof src !== 'string' || src === '') {
    throw new Error(`island step ${a.step.id}: \`with.src\` must be a string`)
  }

  const rawTitle = evaluated.title
  const title = typeof rawTitle === 'string' && rawTitle !== '' ? rawTitle : a.step.id
  const display = evaluated.display === 'fullscreen' ? 'fullscreen' : 'inline'

  const args: Record<string, unknown> = { ...evaluated }
  for (const key of ISLAND_RESERVED) delete args[key]

  return { src, title, display, arguments: args }
}

// ---------------------------------------------------------------------------
// Paths (01) — where an island's HTML and its tool calls actually go
// ---------------------------------------------------------------------------

/** `http:`, `data:`, `javascript:` … — anything with a URL scheme is off-bundle. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * The island HTML's URL. A relative `src` is implementation-scoped —
 * `islands/x.html` → `/w/<impl>/islands/x.html` — and an already-absolute
 * bundle path (`/w/…`) is used verbatim, the same own-implementation rule the
 * pipeline adapter applies to `/api/<impl>/<path>`. Anything else (another
 * alias, an absolute `/api/…`, a protocol-relative `//host`, an off-site URL)
 * is a definition bug and throws.
 */
export function resolveSrc(impl: string, src: string): string {
  if (src.startsWith('/w/')) return src
  if (src.startsWith('/') || HAS_SCHEME.test(src)) {
    throw new Error(`island src ${src}: must be relative to the implementation bundle or under /w/`)
  }
  if (src.split('/').includes('..')) {
    throw new Error(`island src ${src}: must not escape the implementation bundle`)
  }
  return `/w/${impl}/${src}`
}

export type ToolTarget =
  | { kind: 'host'; tool: 'submit' | 'annotate' }
  | { kind: 'pipeline'; path: string; method: 'GET' | 'POST'; url: string }
  | { kind: 'rejected'; reason: string }

/** The two host tools, dot-canonical and slash-tolerant (Decision 1). */
const HOST_TOOLS = new Map<string, 'submit' | 'annotate'>([
  ['workflow.submit', 'submit'],
  ['workflow/submit', 'submit'],
  ['workflow.annotate', 'annotate'],
  ['workflow/annotate', 'annotate'],
])

/** `_meta: { bffless: { method: 'GET' } }` — only the island knows a rule's verb (Decision 10). */
function methodOf(meta: unknown): 'GET' | 'POST' {
  return obj(obj(meta).bffless).method === 'GET' ? 'GET' : 'POST'
}

function rejected(reason: string): ToolTarget {
  return { kind: 'rejected', reason }
}

/**
 * An MCP tool name → what the host should do with it (Decision 1 + 10).
 *
 * Names are dot-canonical (`video.slice`) because MCP tool names are
 * `[A-Za-z0-9_.-]`, and slash-tolerant (`video/slice`) because the spec writes
 * pipelines by path: a name containing `/` **is** the path, otherwise every `.`
 * becomes `/`. A pipeline whose path itself contains a `.` (`feed.xml` →
 * `feed/xml`) is therefore only reachable by its slash form — the documented
 * lossy case, which the linter notices rather than the host special-cases.
 *
 * An island may only reach its own implementation's rules plus the two
 * `workflow.*` host tools (04), so anything absolute, empty, whitespace-bearing
 * or traversing out of `/api/<impl>/` comes back rejected — a tool error the
 * bridge reports to the island, never a throw.
 */
export function resolveToolName(impl: string, name: string, meta?: unknown): ToolTarget {
  if (typeof name !== 'string' || name === '') return rejected('a tool name is required')
  if (/\s/.test(name)) return rejected(`tool "${name}": a tool name may not contain whitespace`)

  const host = HOST_TOOLS.get(name)
  if (host) return { kind: 'host', tool: host }

  if (name.startsWith('/')) {
    return rejected(`tool "${name}": absolute paths are not callable from an island`)
  }

  const path = name.includes('/') ? name : name.split('.').join('/')
  const segments = path.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return rejected(`tool "${name}": resolves outside /api/${impl}/`)
  }

  return { kind: 'pipeline', path, method: methodOf(meta), url: `/api/${impl}/${path}` }
}

// ---------------------------------------------------------------------------
// workflow.submit / workflow.annotate
// ---------------------------------------------------------------------------

export type IslandSubmitResult =
  | { ok: true; event: Extract<RunEvent, { type: 'step.succeeded' }> }
  | { ok: false; errors: Record<string, string> }

/** The step's declared `outputs` map — an island's outputs are named and typed (02/03). */
function outputDecls(step: Step): Record<string, OutputDecl> {
  return obj(obj(step.raw).outputs) as Record<string, OutputDecl>
}

/**
 * Validate an island's `workflow.submit { outputs }` against the step's declared
 * `outputs` map, exactly as `completeFormStep` validates a submit against the
 * form's fields: required, then the closed type vocabulary (02), then the
 * declaration's own constraint keys; undeclared keys are dropped, because the
 * declaration is the contract the rest of the workflow reads.
 *
 * On success `summary`/`annotations` are evaluated with the step's own outputs
 * in scope and ride on the returned `step.succeeded`. Never throws.
 */
export function completeIslandStep(a: IslandStepArgs & { outputs: unknown }): IslandSubmitResult {
  if (!isPlainObject(a.outputs)) {
    return { ok: false, errors: { outputs: 'Expected an object of outputs' } }
  }
  const submitted = a.outputs

  const errors: Record<string, string> = {}
  const outputs: Record<string, unknown> = {}

  for (const [name, declared] of Object.entries(outputDecls(a.step))) {
    // The bare-string form of an OutputDecl is an *expression* (02) — it only
    // makes sense where the harness computes the value (pipeline/job/run
    // outputs). An island's values come from the island, so a string
    // declaration is read as "declared, untyped".
    const decl = typeof declared === 'string' ? {} : obj(declared)
    // No `type` declared → `json`, the vocabulary's "anything" (02).
    const type = typeof decl.type === 'string' ? decl.type : 'json'
    const list = decl.list === true
    // Anything not submitted is unanswered, not undefined: outputs are JSON.
    const value = Object.hasOwn(submitted, name) && submitted[name] !== undefined
      ? submitted[name]
      : null

    if (decl.required === true && blank(value, list)) {
      errors[name] = 'This field is required'
      continue
    }
    if (!validateValue(type, list, value)) {
      errors[name] = `Expected ${article(type, list)}`
      continue
    }
    // The same constraint keys the form step applies on top of the type
    // (min/max, pattern, minLength/maxLength, choice membership) — a
    // declaration that carries them means them wherever the value came from.
    const constraintError = validateInputConstraints({ ...decl, type } as InputDef, value)
    if (constraintError) {
      errors[name] = constraintError
      continue
    }
    // NOTE (M2, flagged deviation): a declaration's `schema` key is accepted
    // and IGNORED here. 02 specifies JSON-Schema validation as "one function
    // over that schema"; M2 validates the type/list shape only and defers the
    // schema pass to M3, so a `schema`-carrying output is type-checked but not
    // structure-checked.
    outputs[name] = value
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const contexts = buildContexts(a.def, a.state, {
    job: a.job,
    index: a.index,
    stepId: a.step.id,
    selfOutputs: outputs,
  })

  return {
    ok: true,
    event: {
      type: 'step.succeeded',
      key: a.key,
      outputs,
      summary: evalSummary(a.step, contexts),
      annotations: evalAnnotations(a.step, contexts),
      at: Date.now(),
    },
  }
}

const LEVELS = new Set<Annotation['level']>(['notice', 'warning', 'error'])

function isLevel(value: unknown): value is Annotation['level'] {
  return typeof value === 'string' && LEVELS.has(value as Annotation['level'])
}

/**
 * Validate a `workflow.annotate` call into a `step.annotated` event
 * (Decision 12): `annotations` (a list of `{ level, message, title? }`) and/or
 * `summary`, at least one of the two. Bad input comes back as `{ error }` — the
 * bridge turns it into an MCP tool error, so a sloppy island cannot poison the
 * run record.
 */
export function annotateEvent(
  key: StepKey,
  args: unknown,
  at: number,
): Extract<RunEvent, { type: 'step.annotated' }> | { error: string } {
  if (!isPlainObject(args)) {
    return { error: 'Expected an object with `annotations` and/or `summary`' }
  }

  const event: Extract<RunEvent, { type: 'step.annotated' }> = { type: 'step.annotated', key, at }

  if (args.annotations !== undefined) {
    if (!Array.isArray(args.annotations)) return { error: '`annotations` must be a list' }

    const annotations: Annotation[] = []
    for (let i = 0; i < args.annotations.length; i++) {
      const entry = args.annotations[i]
      if (!isPlainObject(entry)) return { error: `annotations[${i}]: expected an object` }
      if (!isLevel(entry.level)) {
        return { error: `annotations[${i}]: \`level\` must be notice, warning or error` }
      }
      if (typeof entry.message !== 'string') {
        return { error: `annotations[${i}]: \`message\` must be a string` }
      }
      const annotation: Annotation = { level: entry.level, message: entry.message }
      if (typeof entry.title === 'string') annotation.title = entry.title
      annotations.push(annotation)
    }
    if (annotations.length > 0) event.annotations = annotations
  }

  if (args.summary !== undefined) {
    if (typeof args.summary !== 'string') return { error: '`summary` must be a string' }
    event.summary = args.summary
  }

  if (event.annotations === undefined && event.summary === undefined) {
    return { error: 'Expected at least one of `annotations` or `summary`' }
  }

  return event
}
