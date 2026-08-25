/**
 * One coercer per server shape (09): every response — real or mocked — enters
 * the app through this module, so a CE envelope change or a JSON column handed
 * back as a string is fixed in exactly one place and the engine only ever sees
 * the types of `lib/runner`.
 *
 * Deliberately forgiving on the way in and strict on the way out: a missing
 * column yields the documented default rather than an exception, because a
 * half-written row must still render as a run record (08 degraded states).
 */
import type { RunRow, StepRow } from './runner/rows'
import type { Annotation, FileRef, RunStatus, StepError, StepKind, StepStatus } from './runner/types'

// ---------------------------------------------------------------------------
// Discovery (06)
// ---------------------------------------------------------------------------

export interface WorkflowListing {
  file: string
  name: string
  description?: string
  inputs: number
  jobs: number
  headlessSafe: boolean
}

export interface Implementation {
  alias: string
  name: string
  description?: string
  version?: string
  commit?: string
  preview: boolean
  workflows: WorkflowListing[]
  /** Reachable, but its `index.json` could not be used (08 empty states). */
  error?: string
}

/** The record id CE gives a Data Table row; the engine's types never carry it (R4). */
export interface ServerRunRow extends RunRow {
  _id?: string
}

export interface ServerStepRow extends StepRow {
  _id?: string
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return fallback
}

function optionalNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = num(value, Number.NaN)
  return Number.isFinite(n) ? n : null
}

function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  return fallback
}

/**
 * A `json` column can arrive parsed or as its text (CE has answered with both
 * across versions and the mock speaks the parsed form).
 */
function maybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function record(value: unknown): Record<string, unknown> {
  return obj(maybeJson(value))
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  const parsed = maybeJson(value)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

function list(value: unknown): unknown[] {
  const parsed = maybeJson(value)
  return Array.isArray(parsed) ? parsed : []
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(str(value)) ? (value as T) : fallback
}

const RUN_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const satisfies readonly RunStatus[]
const STEP_STATUSES = [
  'queued', 'running', 'polling', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled',
] as const satisfies readonly StepStatus[]
const STEP_KINDS = ['pipeline', 'island', 'form', 'script'] as const satisfies readonly StepKind[]

/**
 * A list response is the raw `data_query` result, and which envelope that is has
 * changed across CE versions (the rule set's own `shape.fn.js` hedges the same
 * three keys); a bare array is what the mock and a `postSteps`-shaped rule send.
 */
export function unwrapRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  const r = obj(raw)
  for (const key of ['records', 'data', 'rows']) {
    if (Array.isArray(r[key])) return r[key] as unknown[]
  }
  return []
}

/**
 * The row's own columns, whether CE flattened them onto the record or kept them
 * under `fields`. The record id is never a column, so it is read separately.
 */
function fieldsOf(raw: unknown): Record<string, unknown> {
  const r = obj(raw)
  const nested = obj(r.fields)
  return Object.keys(nested).length > 0 ? nested : r
}

function recordId(raw: unknown): string | undefined {
  const r = obj(raw)
  return optionalStr(r.id) ?? optionalStr(r._id) ?? optionalStr(r.recordId)
}

function annotations(value: unknown): Annotation[] {
  return list(value).flatMap((entry) => {
    const a = obj(entry)
    const message = optionalStr(a.message)
    if (!message) return []
    return [
      {
        level: oneOf(a.level, ['notice', 'warning', 'error'] as const, 'notice'),
        message,
        ...(optionalStr(a.title) ? { title: str(a.title) } : {}),
        ...(optionalStr(a.stepKey) ? { stepKey: str(a.stepKey) } : {}),
      },
    ]
  })
}

function stepError(value: unknown): StepError | null {
  const e = optionalRecord(value)
  if (!e) return null
  const code = optionalStr(e.code)
  const message = optionalStr(e.message)
  if (!code && !message) return null
  const status = optionalNum(e.status)
  return {
    code: code ?? 'STEP',
    message: message ?? '',
    ...(status === null ? {} : { status }),
  }
}

// ---------------------------------------------------------------------------
// Coercers
// ---------------------------------------------------------------------------

/** The workflow id of a listing file: the basename minus its workflow suffix (R1). */
export function workflowId(file: string): string {
  const base = file.split('/').pop() ?? file
  return base.replace(/\.workflow\.ya?ml$/i, '').replace(/\.ya?ml$/i, '')
}

/**
 * The one route a File ref's `url` may point at — mirrors the rule's `shape.fn.js`
 * (06): CE's `file_serve_handler` serves `/api/uploads/<subDir>/…`.
 *
 * Exported because it is also the *gate*: `lib/url.ts`'s `isServeUrl` refuses
 * any ref url that does not resolve inside this prefix, and a second copy of
 * the string would let the builder and the gate drift apart.
 */
export const SERVE_PREFIX = '/api/uploads/'

/**
 * The serve route a storage path is reachable at: `path` is the
 * uploads-relative key, so the url is simply `SERVE_PREFIX` + path.
 */
export function fileUrl(path: string): string {
  return `${SERVE_PREFIX}${path.replace(/^\/+/, '')}`
}

/** The alias list, whether CE answered with a bare array, `{ aliases }` or `{ data }`. */
export function toAliasList(raw: unknown): Array<{ name: string; isAutoPreview: boolean }> {
  const entries = Array.isArray(obj(raw).aliases) ? (obj(raw).aliases as unknown[]) : unwrapRows(raw)
  return entries.flatMap((entry) => {
    const a = obj(entry)
    const name = optionalStr(a.name) ?? optionalStr(a.alias)
    return name ? [{ name, isAutoPreview: bool(a.isAutoPreview) }] : []
  })
}

function toListing(raw: unknown): WorkflowListing[] {
  const w = obj(raw)
  const file = optionalStr(w.file)
  if (!file) return []
  return [
    {
      file,
      name: optionalStr(w.name) ?? workflowId(file),
      ...(optionalStr(w.description) ? { description: str(w.description) } : {}),
      inputs: num(w.inputs),
      jobs: num(w.jobs),
      headlessSafe: bool(w.headlessSafe),
    },
  ]
}

/**
 * `index.json` → an implementation. Everything comes from the document itself:
 * the alias and its preview flag are what the *caller* already knows (which URL
 * it probed), never re-derived here.
 */
export function toImplementation(alias: string, preview: boolean, raw: unknown): Implementation {
  const invalid = (error: string): Implementation => ({
    alias,
    name: alias,
    preview,
    workflows: [],
    error,
  })

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid('index.json is not an object')
  }
  const index = raw as Record<string, unknown>
  if (index.spec !== 1) return invalid(`unsupported index.json spec: ${JSON.stringify(index.spec)}`)
  if (!Array.isArray(index.workflows)) return invalid('index.json has no workflows array')

  return {
    alias,
    name: optionalStr(index.name) ?? alias,
    ...(optionalStr(index.description) ? { description: str(index.description) } : {}),
    ...(optionalStr(index.version) ? { version: str(index.version) } : {}),
    ...(optionalStr(index.commit) ? { commit: str(index.commit) } : {}),
    preview,
    workflows: index.workflows.flatMap(toListing),
  }
}

export function toRunRow(raw: unknown): ServerRunRow {
  const f = fieldsOf(raw)
  const id = recordId(raw)
  return {
    ...(id ? { _id: id } : {}),
    runId: str(f.runId),
    impl: str(f.impl),
    workflow: str(f.workflow),
    workflowName: str(f.workflowName),
    ...(optionalStr(f.workflowVersion) ? { workflowVersion: str(f.workflowVersion) } : {}),
    definition: maybeJson(f.definition) ?? null,
    yaml: str(f.yaml),
    inputs: record(f.inputs),
    status: oneOf(f.status, RUN_STATUSES, 'running'),
    headless: bool(f.headless),
    ...(optionalStr(f.startedBy) ? { startedBy: str(f.startedBy) } : {}),
    startedAt: num(f.startedAt),
    finishedAt: optionalNum(f.finishedAt),
    leaseOwner: optionalStr(f.leaseOwner) ?? null,
    leaseUntil: optionalNum(f.leaseUntil),
    outputs: optionalRecord(f.outputs),
    annotations: annotations(f.annotations),
  }
}

export function toStepRow(raw: unknown): ServerStepRow {
  const f = fieldsOf(raw)
  const id = recordId(raw)
  return {
    ...(id ? { _id: id } : {}),
    runId: str(f.runId),
    key: str(f.key),
    job: str(f.job),
    index: num(f.index),
    step: str(f.step),
    kind: oneOf(f.kind, STEP_KINDS, 'pipeline'),
    status: oneOf(f.status, STEP_STATUSES, 'queued'),
    attempt: num(f.attempt, 1),
    inputs: optionalRecord(f.inputs),
    response: optionalRecord(f.response),
    outputs: optionalRecord(f.outputs),
    error: stepError(f.error),
    summary: optionalStr(f.summary) ?? null,
    annotations: annotations(f.annotations),
    startedAt: optionalNum(f.startedAt),
    finishedAt: optionalNum(f.finishedAt),
    heartbeatAt: optionalNum(f.heartbeatAt),
  }
}

export function toFileRef(raw: unknown): FileRef {
  const r = record(raw)
  const path = str(r.path) || str(r.storagePath) || str(r.storageKey)
  const name = optionalStr(r.name) ?? optionalStr(r.fileName) ?? optionalStr(r.originalName)
  return {
    path,
    name: name ?? path.split('/').pop() ?? 'file',
    contentType: optionalStr(r.contentType) ?? 'application/octet-stream',
    size: num(r.size),
    url: optionalStr(r.url) ?? fileUrl(path),
  }
}
