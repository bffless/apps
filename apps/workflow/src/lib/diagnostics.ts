/**
 * Client diagnostics (apps#526): the failures that never reach the run record.
 *
 * An island that never completes its handshake, a script Worker that dies, a
 * `workflow.sign` that fails — when this tab is not driving the run, those
 * land on the console and nowhere else, so a bug report is a screenshot or
 * nothing. This module keeps a rolling buffer of the page's last errors
 * (`installDiagnostics`, called once at startup from `main.tsx`) and turns it
 * into one portable payload (`buildDiagnostics`) the run page can copy to the
 * clipboard or attach to the run record as its single `kind: 'diagnostics'`
 * annotation.
 *
 * Deliberately no bespoke taps into `ScriptHost`/`IslandHost`: everything they
 * fail on already reaches `console.error`, window `error` or
 * `unhandledrejection`, and a second reporting channel would be one more thing
 * to keep in step. Equally deliberate (decided on the issue): the entries are
 * captured **verbatim**, no redaction — Attach persists them to a row any
 * authenticated viewer of the run can read, and the message on the annotation
 * says where they came from.
 */
import type { AnnotationCounts, RunRow } from './runner/rows'
import type { Annotation, StepKey, StepStatus } from './runner/types'
import type { RunStore } from './runStore'

/** The last ~50 entries are plenty to see what broke without an unbounded row. */
const CAP = 50

export interface DiagnosticsEntry {
  at: number
  source: 'console' | 'error' | 'rejection'
  message: string
}

/** What Copy puts on the clipboard and Attach writes into the annotation's `data`. */
export interface DiagnosticsPayload {
  buildSha: string
  url: string
  userAgent: string
  runId: string
  /** The recorded half's pointers: which steps exist and where each one got to. */
  steps: { key: StepKey; status: StepStatus }[]
  errors: DiagnosticsEntry[]
  at: number
}

const buffer: DiagnosticsEntry[] = []
let installed = false

function push(source: DiagnosticsEntry['source'], message: string) {
  buffer.push({ at: Date.now(), source, message })
  if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP)
}

/** One console argument as a line of text; an Error keeps its stack, the rest stays short. */
function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Start capturing: `console.error` (wrapped, always called through), window
 * `error` and `unhandledrejection`. Idempotent — a second call is a no-op —
 * and returns an uninstall for tests; the app itself never uninstalls.
 */
export function installDiagnostics(): () => void {
  if (installed) return () => {}
  installed = true

  const realError = console.error
  console.error = (...args: unknown[]) => {
    push('console', args.map(describe).join(' '))
    realError.apply(console, args)
  }

  const onError = (event: ErrorEvent) => {
    push('error', event.message || describe(event.error))
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    push('rejection', describe(event.reason))
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  return () => {
    console.error = realError
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    installed = false
  }
}

/** The buffer as it stands — a copy, so a caller cannot edit history. */
export function recentErrors(): DiagnosticsEntry[] {
  return [...buffer]
}

/** Tests only: the buffer is module-level, and one test's noise must not be the next test's evidence. */
export function resetDiagnostics(): void {
  buffer.length = 0
}

/** The deployed commit, baked in by `deploy-workflow.yml`; `dev` everywhere else (dev, mocks, CI). */
function buildSha(): string {
  const raw = import.meta.env.VITE_BUILD_SHA
  return typeof raw === 'string' && raw !== '' ? raw : 'dev'
}

export function buildDiagnostics(facts: {
  runId: string
  steps: { key: StepKey; status: StepStatus }[]
}): DiagnosticsPayload {
  return {
    buildSha: buildSha(),
    url: window.location.href,
    userAgent: navigator.userAgent,
    runId: facts.runId,
    steps: facts.steps,
    errors: recentErrors(),
    at: Date.now(),
  }
}

/**
 * Copy, best-effort — the `ShapeView` posture: no permission, no secure
 * context, no clipboard at all — resolves `false` and the page moves on; the
 * payload is still one Attach away.
 */
export async function copyDiagnostics(payload: DiagnosticsPayload): Promise<boolean> {
  const clipboard = navigator.clipboard
  if (!clipboard) return false
  try {
    await clipboard.writeText(JSON.stringify(payload, null, 2))
    return true
  } catch {
    return false
  }
}

/** The run annotation Attach writes: human half on the surface, machine half in `data`. */
export function diagnosticsAnnotation(payload: DiagnosticsPayload): Annotation {
  return {
    kind: 'diagnostics',
    level: 'notice',
    title: 'Diagnostics',
    message: `Client diagnostics attached from ${payload.url}`,
    data: payload,
  }
}

/**
 * The run's annotations with `annotation` attached — replacing, never
 * stacking, any previous annotation of the same `kind` (apps#526, decided).
 * The live path gets the same rule from the reducer's `run.annotation` case;
 * this is the record view's copy of it, applied to the fetched row.
 */
export function withDiagnostics(annotations: readonly Annotation[], annotation: Annotation): Annotation[] {
  return [...annotations.filter((a) => a.kind !== annotation.kind), annotation]
}

/**
 * Attach on a **record view**: append-replace on the fetched row's annotations
 * and patch the row directly through the existing `run/update` path — the same
 * single write the live path's `run.annotation` event produces (rows.ts), so
 * the `annotationCounts` rollup rides along and Past runs stays honest.
 */
export async function attachDiagnostics(
  store: Pick<RunStore, 'patchRun'>,
  run: Pick<RunRow, 'runId' | 'annotations'>,
  stepAnnotations: readonly Annotation[],
  payload: DiagnosticsPayload,
): Promise<void> {
  const annotations = withDiagnostics(run.annotations ?? [], diagnosticsAnnotation(payload))
  const counts: AnnotationCounts = { error: 0, warning: 0, notice: 0 }
  for (const annotation of [...annotations, ...stepAnnotations]) counts[annotation.level] += 1
  await store.patchRun(run.runId, { annotations, annotationCounts: counts })
}
