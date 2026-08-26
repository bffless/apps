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
import { buildContexts, evalDeep } from '../contexts'
import type { Annotation, Definition, RunEvent, RunState, Step, StepKey } from '../types'
import { isPlainObject, obj, outputDecls, succeededEvent, validateDeclared } from './declared'

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
 * The two things a raw segment scan cannot see, because the *browser* resolves
 * the URL, not this module: a percent-escape (`%2e%2e/` is `../` by the time it
 * is fetched) and a backslash (WHATWG treats `\` as `/` for http(s) URLs). No
 * legitimate bundle path or tool name needs either, so both are refused outright
 * rather than decoded and re-checked.
 */
const ENCODED_OR_BACKSLASH = /[\\%]/

/**
 * Does the built path really land inside `prefix`? The check the fetch itself
 * will apply: resolve it the way the browser would (which normalises `.`/`..`,
 * their percent-escaped spellings and backslashes) and look at the result. The
 * segment scans above are the readable first line; this is the one that holds.
 */
function inside(url: string, prefix: string): boolean {
  try {
    return new URL(url, 'https://harness.invalid').pathname.startsWith(prefix)
  } catch {
    return false
  }
}

/**
 * The island HTML's URL. A relative `src` is implementation-scoped —
 * `islands/x.html` → `/w/<impl>/islands/x.html` — and an already-absolute
 * bundle path under `/w/<impl>/` is used verbatim, the same own-implementation
 * rule the pipeline adapter applies to `/api/<impl>/<path>`. Anything else
 * (another implementation's bundle, an absolute `/api/…`, a protocol-relative
 * `//host`, an off-site URL, a path that traverses out however it is spelled)
 * is a definition bug and throws.
 *
 * `kind` only labels the error: a `script` step's `src` resolves by exactly the
 * same rules (`resolveScriptSrc` in the script adapter passes `'script'`), and
 * a message that said "island" there would send the author looking in the
 * wrong place.
 */
export function resolveSrc(impl: string, src: string, kind = 'island'): string {
  const bad = (why: string): never => {
    throw new Error(`${kind} src ${src}: ${why}`)
  }

  if (src === '') bad('must not be empty')
  if (ENCODED_OR_BACKSLASH.test(src)) bad('must not contain a backslash or a percent-escape')
  if (!src.startsWith('/w/') && (src.startsWith('/') || HAS_SCHEME.test(src))) {
    bad('must be relative to the implementation bundle or under /w/')
  }

  // A bare `.`, a trailing `/` or `/.` all normalise to a *directory* — the
  // bundle root, at worst — which is never an island (apps#370).
  const last = src.split('/').at(-1)
  if (last === '' || last === '.') bad('must name a file')

  const url = src.startsWith('/w/') ? src : `/w/${impl}/${src}`
  if (src.split('/').includes('..') || !inside(url, `/w/${impl}/`)) {
    bad(`must resolve inside /w/${impl}/`)
  }
  return url
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

  if (ENCODED_OR_BACKSLASH.test(name)) {
    return rejected(`tool "${name}": a tool name may not contain a backslash or a percent-escape`)
  }

  const path = name.includes('/') ? name : name.split('.').join('/')
  const segments = path.split('/')
  const url = `/api/${impl}/${path}`
  if (segments.some((s) => s === '' || s === '.' || s === '..') || !inside(url, `/api/${impl}/`)) {
    return rejected(`tool "${name}": resolves outside /api/${impl}/`)
  }

  return { kind: 'pipeline', path, method: methodOf(meta), url }
}

// ---------------------------------------------------------------------------
// workflow.submit / workflow.annotate
// ---------------------------------------------------------------------------

export type IslandSubmitResult =
  | { ok: true; event: Extract<RunEvent, { type: 'step.succeeded' }> }
  | { ok: false; errors: Record<string, string> }

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
export function completeIslandStep(
  a: IslandStepArgs & { outputs: unknown; at: number },
): IslandSubmitResult {
  if (!isPlainObject(a.outputs)) {
    return { ok: false, errors: { outputs: 'Expected an object of outputs' } }
  }

  // An island's outputs are named and typed by the step; an untyped one is
  // `json`, the vocabulary's "anything" (02). The walk itself — required, type,
  // constraints, drop-the-undeclared — is the one the form step uses.
  const { outputs, errors } = validateDeclared(outputDecls(a.step), a.outputs, {
    defaultType: 'json',
  })

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return { ok: true, event: succeededEvent(a, outputs, a.at) }
}

const LEVELS = new Set<Annotation['level']>(['notice', 'warning', 'error'])

function isLevel(value: unknown): value is Annotation['level'] {
  return typeof value === 'string' && LEVELS.has(value as Annotation['level'])
}

/**
 * What one step may accumulate through `workflow.annotate` (apps#370): the
 * `annotations` and `summary` columns are persisted with every upsert and are
 * *not* offloaded the way Phase 2 offloads `outputs` at 256 KB, so a looping
 * island must hit a wall well before that budget. Exported as the one place
 * these numbers live, for Phase 2's persistence work to budget against.
 */
export const ANNOTATION_BUDGET = {
  /** Annotations per step, the recorded ones included. */
  count: 100,
  /** JSON bytes of a step's annotations, the recorded ones included. */
  bytes: 64 * 1024,
  /** JSON bytes of one summary. */
  summaryBytes: 16 * 1024,
} as const

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

/**
 * Validate a `workflow.annotate` call into a `step.annotated` event
 * (Decision 12): `annotations` (a list of `{ level, message, title? }`) and/or
 * `summary`, at least one of the two. Bad input comes back as `{ error }` — the
 * bridge turns it into an MCP tool error, so a sloppy island cannot poison the
 * run record.
 *
 * `existing` is what the step already holds, so the budget is enforced over
 * the step's total, not per call (apps#370).
 */
export function annotateEvent(
  key: StepKey,
  args: unknown,
  at: number,
  existing: readonly Annotation[] = [],
): Extract<RunEvent, { type: 'step.annotated' }> | { error: string } {
  if (!isPlainObject(args)) {
    return { error: 'Expected an object with `annotations` and/or `summary`' }
  }

  const event: Extract<RunEvent, { type: 'step.annotated' }> = { type: 'step.annotated', key, at }

  if (args.annotations !== undefined) {
    if (!Array.isArray(args.annotations)) return { error: '`annotations` must be a list' }
    if (existing.length + args.annotations.length > ANNOTATION_BUDGET.count) {
      return {
        error: `\`annotations\`: a step holds at most ${ANNOTATION_BUDGET.count} (${existing.length} already recorded)`,
      }
    }

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
    if (annotations.length > 0) {
      if (byteSize([...existing, ...annotations]) > ANNOTATION_BUDGET.bytes) {
        return {
          error: `\`annotations\`: a step's annotations may not exceed ${ANNOTATION_BUDGET.bytes / 1024} KB`,
        }
      }
      event.annotations = annotations
    }
  }

  if (args.summary !== undefined) {
    if (typeof args.summary !== 'string') return { error: '`summary` must be a string' }
    if (new TextEncoder().encode(args.summary).length > ANNOTATION_BUDGET.summaryBytes) {
      return {
        error: `\`summary\`: may not exceed ${ANNOTATION_BUDGET.summaryBytes / 1024} KB`,
      }
    }
    event.summary = args.summary
  }

  if (event.annotations === undefined && event.summary === undefined) {
    return { error: 'Expected at least one of `annotations` or `summary`' }
  }

  return event
}
