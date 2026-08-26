/**
 * Which renderer an output gets (02).
 *
 * A step declares its outputs with a `type`, so a step output needs no
 * detective work. Job and top-level outputs are usually a **bare expression**
 * (`report: ${{ jobs.confirm.outputs.report }}`) which carries no type at all —
 * and "json" would be the wrong answer for a value the workflow already
 * described as markdown two hops upstream. So a bare declaration is followed to
 * the declaration it names: top level → job → step, where the type lives.
 *
 * Two conventions from 01/03 are baked in on the way:
 * - a `form` step's outputs *are* its `with.fields`, and their types with them;
 * - a matrix job **collects** its steps' outputs, so a job output that reads
 *   `steps.<id>.outputs.<o>` inside a matrix job is a list of that type.
 *
 * `refsIn` (lib/runner/graph) is deliberately not used here: it recognises the
 * `steps`/`needs`/`inputs` roots an *expression context* has, and a top-level
 * output reads `jobs.<job>.outputs.<o>` — a root that exists nowhere else.
 * Parsing still goes through the one parser (`workflow-lint/expressions`).
 */
import { scanTemplates } from '@bffless/workflow-lint/expressions'
import type { Expr } from '@bffless/workflow-lint/expressions'
import type { Definition, OutputDecl, Step } from '@bffless/workflow-lint/definition'
import type { ValueDecl } from './valueDecl'

/** Where an output was declared: the workflow's own `outputs`, or one job's. */
export type OutputScope = { kind: 'run' } | { kind: 'job'; job: string }

export const RUN_SCOPE: OutputScope = { kind: 'run' }

/** What an undeclared, unresolvable or untyped value falls back to (02). */
const JSON_DECL: ValueDecl = { type: 'json' }

/** One `<root>.<name>.outputs.<output>` reference. */
interface OutputRef {
  root: string
  name: string
  output: string
}

/** The dotted identifier chain of an expression, or nothing when it is computed. */
function chain(expr: Expr): string[] | null {
  if (expr.kind === 'ident') return [expr.name]
  if (expr.kind === 'member') {
    const head = chain(expr.object)
    return head && [...head, expr.property]
  }
  return null
}

/** The first plain output reference a declaration reads, in source order. */
function firstRef(source: unknown): OutputRef | null {
  if (typeof source !== 'string') return null
  for (const span of scanTemplates(source)) {
    if (!span.expr) continue
    const parts = chain(span.expr)
    if (!parts) continue
    const [root, name, kind, output] = parts
    if (root && name && kind === 'outputs' && output) return { root, name, output }
  }
  return null
}

/** The renderer half of a declaration object, or nothing when it declares no type. */
function typed(decl: unknown): ValueDecl | null {
  if (decl === null || typeof decl !== 'object') return null
  const d = decl as Record<string, unknown>
  if (typeof d.type !== 'string') return null
  return {
    type: d.type,
    ...(d.list === true ? { list: true } : {}),
    ...(typeof d.render === 'string' ? { render: d.render } : {}),
    ...(d.columns === undefined ? {} : { columns: d.columns }),
    // `render: island` needs the island file to travel with the declaration —
    // the renderer is chosen from `render`, but only `src` says *which* island.
    ...(typeof d.src === 'string' ? { src: d.src } : {}),
    // `render: chart`/`render: code` need their own axis/language mapping —
    // same reasoning as `src` above.
    ...(d.mapping !== null && typeof d.mapping === 'object' ? { mapping: d.mapping } : {}),
  }
}

/**
 * One declared output of a step (03): the `outputs` map, a `form` step's
 * fields, otherwise untyped json — which is also what the bare `response` of a
 * pipeline step with no map gets.
 */
export function stepOutputDecl(step: Step, name: string): ValueDecl {
  const declared = typed(step.raw?.outputs?.[name])
  if (declared) return declared
  if (step.uses === 'form') {
    const field = typed(step.raw?.with?.fields?.[name])
    if (field) return field
  }
  return JSON_DECL
}

/** Follow one bare expression to the declaration it names. */
function follow(
  def: Definition,
  scope: OutputScope,
  source: unknown,
  seen: Set<string>,
): ValueDecl {
  const ref = firstRef(source)
  if (!ref) return JSON_DECL

  // `jobs.<job>` (top level) and `needs.<job>` (inside a job) both land on a job.
  if (ref.root === 'jobs' || ref.root === 'needs') {
    return resolve(def, { kind: 'job', job: ref.name }, ref.output, seen)
  }

  if (ref.root === 'steps' && scope.kind === 'job') {
    const job = def.jobs[scope.job]
    const step = job?.steps.find((candidate) => candidate.id === ref.name)
    if (!job || !step) return JSON_DECL
    const decl = stepOutputDecl(step, ref.output)
    // A matrix job collects one value per item (01): `lines` is a string list.
    return job.matrix ? { ...decl, list: true } : decl
  }

  return JSON_DECL
}

function declaredAt(def: Definition, scope: OutputScope, name: string): OutputDecl | undefined {
  return scope.kind === 'run' ? def.outputs?.[name] : def.jobs[scope.job]?.outputs?.[name]
}

function resolve(
  def: Definition,
  scope: OutputScope,
  name: string,
  seen: Set<string>,
): ValueDecl {
  // A workflow that references itself in a circle still has to render something.
  const id = `${scope.kind === 'run' ? '' : scope.job}.${name}`
  if (seen.has(id)) return JSON_DECL
  seen.add(id)

  const decl = declaredAt(def, scope, name)
  if (decl === undefined) return JSON_DECL
  if (typeof decl === 'string') return follow(def, scope, decl, seen)
  return typed(decl) ?? follow(def, scope, decl.value, seen)
}

/**
 * The renderer declaration of a run-level or job-level output, resolved through
 * however many bare expressions stand between it and the step that typed it.
 * Never throws, and answers `json` for anything it cannot follow.
 */
export function resolveOutputDecl(
  def: Definition,
  scope: OutputScope,
  name: string,
): ValueDecl {
  return resolve(def, scope, name, new Set())
}
