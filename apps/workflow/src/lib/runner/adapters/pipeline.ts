/**
 * The `pipeline` step adapter (03): one HTTP call to a proxy-rule endpoint on
 * the harness host, an optional `poll` loop, `retry`, timeouts and cancel —
 * expressed as a sequence of `RunEvent`s.
 *
 * The adapter owns no state: it reads the run snapshot it was handed, builds
 * step-local contexts for every evaluation site, and reports progress by
 * emitting events (which the reducer folds). It **never throws** — every path
 * ends in an emitted terminal event (`step.succeeded` / `step.failed` /
 * `step.cancelled`) or in a `step.retrying` followed by another attempt.
 *
 * Effects arrive through `StepRuntime` (fetch, clock, cancellation, file
 * registration), so the whole lifecycle is unit-testable against fakes and the
 * module stays inside the purity fence: no React/Redux/MSW/app imports
 * (spec 09, enforced by eslint).
 */
import { EvalError, truthy } from '@bffless/workflow-lint/expressions'
import type { OutputDecl } from '@bffless/workflow-lint/definition'
import { buildContexts, evalDeep, evalValue } from '../contexts'
import { parseDuration } from '../durations'
import { coerceOutputs, OutputTypeError } from '../outputs'
import { evalAnnotations, evalSummary, trimResponse } from '../results'
import type {
  Annotation,
  Definition,
  FileRef,
  RunEvent,
  RunState,
  Step,
  StepError,
  StepKey,
} from '../types'

// ---------------------------------------------------------------------------
// The runtime the middleware injects (Task 17); tests pass fakes.
// ---------------------------------------------------------------------------

export interface HttpJson {
  (
    path: string,
    init: {
      method: string
      query?: Record<string, unknown>
      body?: unknown
      headers?: Record<string, string>
      signal?: AbortSignal
    },
  ): Promise<{ status: number; ok: boolean; body: unknown }>
}

export interface Clock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export interface StepRuntime {
  emit(e: RunEvent): void
  http: HttpJson
  clock: Clock
  signal: AbortSignal
  registerFile: (path: string) => Promise<FileRef>
}

export interface PipelineStepArgs {
  step: Step
  key: StepKey
  job: string
  index: number
  /** Snapshot at start; step-local contexts are built inside. */
  def: Definition
  state: RunState
  /**
   * Resume of a `polling` row (05 Resume item 3, Decision 3). Applies only to
   * the first attempt — a retry re-runs the whole step (request + poll, 01),
   * same as any other attempt. A `queued`/`running` row has no resume hint:
   * it is relaunched by calling this adapter with `resume` absent, which
   * re-issues the initial request *and* emits `step.started` (legal from
   * both).
   *
   * - `poll-only` — skip the initial request and re-enter the poll loop with
   *   the recorded initial response.
   * - `restart` — re-issue the initial request, because the recorded initial
   *   is unusable: `results.ts`'s `trimResponse` stubbed it out of the record
   *   when it blew the 256 KB budget, and the poll's request context reads
   *   `response.<field>` off it. Still no `step.started`, for the same reason
   *   `poll-only` has none: the row is already `polling`, and `polling ->
   *   running` is not a legal transition (transitions.ts). The row therefore
   *   keeps the `with` its original `step.started` announced, and re-enters
   *   the poll loop through the legal `polling -> polling` self-transition.
   */
  resume?: { mode: 'poll-only'; initial: unknown } | { mode: 'restart' }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Poll defaults from the workflow schema. */
const DEFAULT_EVERY = '3s'
const DEFAULT_POLL_TIMEOUT = '10m'
const DEFAULT_POLL_METHOD = 'GET'
const DEFAULT_RETRY_DELAY = '5s'

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Relative paths are implementation-scoped; an absolute path is used verbatim (03). */
function resolvePath(path: string, impl: string): string {
  return path.startsWith('/') ? path : `/api/${impl}/${path}`
}

/** Non-2xx: `code` from the body's `code`/`error`, else `HTTP_<status>` (03). */
function httpError(status: number, body: unknown, url: string): StepError {
  const b = obj(body)
  return {
    code: str(b.code) ?? str(b.error) ?? `HTTP_${status}`,
    message:
      str(b.message) ??
      str(b.error) ??
      str(typeof body === 'string' ? body : undefined) ??
      `${url} failed with status ${status}`,
    status,
  }
}

/** A tick whose `fail` expression held: the error the tick's own body describes. */
function pollFailError(response: unknown): StepError {
  const r = obj(response)
  return {
    code: str(r.code) ?? str(r.error) ?? 'POLL_FAILED',
    message: str(r.message) ?? str(r.error) ?? 'the poll `fail` condition held',
  }
}

/**
 * A thrown value from anywhere in the attempt, mapped onto the step's error
 * vocabulary. Exported because it is the *step* error vocabulary, not the
 * pipeline's: the script runtime maps the identical throws (a malformed
 * `summary:` template, a wrong-typed output) the identical way, and two copies
 * of this table would drift.
 */
export function toStepError(err: unknown): StepError {
  if (err instanceof OutputTypeError) return { code: 'OUTPUT_TYPE', message: err.message }
  if (err instanceof EvalError) return { code: 'EXPRESSION', message: err.message }
  if (err instanceof RangeError) return { code: 'DURATION', message: err.message }
  return { code: 'STEP', message: messageOf(err) }
}

// ---------------------------------------------------------------------------
// One attempt (request + optional poll + outputs)
// ---------------------------------------------------------------------------

type Fetched =
  | { kind: 'ok'; body: unknown }
  /** `response`: the last response this attempt did see — `retry.if` reads it (01). */
  | { kind: 'error'; error: StepError; response?: unknown }
  | { kind: 'cancelled' }

type AttemptResult =
  | { kind: 'success'; event: Extract<RunEvent, { type: 'step.succeeded' }> }
  | { kind: 'error'; error: StepError; response?: unknown }
  | { kind: 'cancelled' }

interface RequestSpec {
  path: string
  method: string
  query?: Record<string, unknown>
  body?: unknown
  headers?: Record<string, string>
}

async function request(rt: StepRuntime, impl: string, spec: RequestSpec): Promise<Fetched> {
  const url = resolvePath(spec.path, impl)
  let res: { status: number; ok: boolean; body: unknown }
  try {
    res = await rt.http(url, {
      method: spec.method,
      query: spec.query,
      // GET sends `query` only (03).
      body: spec.method === 'GET' ? undefined : spec.body,
      headers: spec.headers,
      signal: rt.signal,
    })
  } catch (err) {
    if (rt.signal.aborted) return { kind: 'cancelled' }
    return { kind: 'error', error: { code: 'NETWORK', message: messageOf(err) } }
  }
  if (rt.signal.aborted) return { kind: 'cancelled' }
  if (!res.ok || res.status < 200 || res.status >= 300) {
    return { kind: 'error', error: httpError(res.status, res.body, url) }
  }
  return { kind: 'ok', body: res.body }
}

/**
 * The step's overall budget: `timeout-minutes` measured from the first attempt,
 * so it also bounds the retries (a spent budget stops further attempts).
 */
function stepDeadline(raw: Record<string, unknown>, startedAt: number): number | undefined {
  const minutes = raw['timeout-minutes']
  return typeof minutes === 'number' ? startedAt + minutes * 60_000 : undefined
}

function timedOut(deadline: number | undefined, now: number): boolean {
  return deadline !== undefined && now >= deadline
}

async function runAttempt(
  a: PipelineStepArgs,
  rt: StepRuntime,
  attempt: number,
  deadline: number | undefined,
  /** The resume mode this attempt is running under, if it is the resumed one. */
  resuming: 'poll-only' | 'restart' | undefined,
): Promise<AttemptResult> {
  const raw = obj(a.step.raw)
  const scope = (over: { response?: unknown; selfOutputs?: Record<string, unknown> } = {}) =>
    buildContexts(a.def, a.state, {
      job: a.job,
      index: a.index,
      stepId: a.step.id,
      attempt,
      ...over,
    })

  // `step.started` must be emitted before anything else can go wrong: `queued`
  // has no edge to `failed` (transitions.ts), only to `running`/`cancelled`.
  let inputs: Record<string, unknown> = {}
  if (resuming) {
    // A resumed `polling` row already carries the `with` its original
    // `step.started` evaluated (replayed onto the step); re-emitting
    // `step.started` here would be `polling -> running`, which is not a
    // legal transition (only `polling -> polling`, the self-transition
    // no-op below, is) — nothing new to evaluate or announce. True of
    // `restart` too, which re-requests but from the *recorded* inputs.
    inputs = a.state.steps[a.key]?.inputs ?? {}
  } else {
    let inputsError: StepError | undefined
    try {
      inputs = obj(evalDeep(raw.with, scope()))
    } catch (err) {
      inputsError = toStepError(err)
    }
    rt.emit({ type: 'step.started', key: a.key, inputs, at: rt.clock.now() })
    if (inputsError) return { kind: 'error', error: inputsError }
  }

  // The last response this attempt saw, carried on every failure so `retry.if`
  // can read `response` alongside `error` (01).
  let seen: unknown

  try {
    const initialPath = str(inputs.path)
    if (!initialPath) {
      return { kind: 'error', error: { code: 'STEP', message: 'pipeline step has no `with.path`' } }
    }

    const pollDecl = raw.poll === undefined || raw.poll === null ? undefined : obj(raw.poll)

    // A row only ever persists `polling` when the step declares `poll:`
    // (rows.ts) — resuming one (either mode) for a step whose definition no
    // longer does is a data inconsistency the adapter should fail closed on,
    // not paper over with a fabricated success nobody validated. Checked
    // *before* the request: `poll-only` never had a side effect to get wrong
    // (it issues nothing), and `restart` must not either — a re-POST that
    // then reports "no `poll:`" would have already enqueued a server-side job
    // for a step the harness is about to fail.
    if (resuming && !pollDecl) {
      return {
        kind: 'error',
        error: { code: 'STEP', message: 'resumed a polling row but the step has no `poll:`' },
      }
    }

    let initial: unknown
    if (resuming === 'poll-only') {
      initial = (a.resume as { initial: unknown }).initial
    } else {
      const first = await request(rt, a.state.impl, {
        path: initialPath,
        method: (str(inputs.method) ?? 'POST').toUpperCase(),
        query: inputs.query === undefined ? undefined : obj(inputs.query),
        body: inputs.body,
        headers: inputs.headers === undefined ? undefined : (obj(inputs.headers) as Record<string, string>),
      })
      if (first.kind !== 'ok') return first
      initial = first.body
    }
    seen = initial
    if (timedOut(deadline, rt.clock.now())) {
      return { kind: 'error', error: timeoutError(), response: initial }
    }

    let last: unknown = initial

    if (pollDecl) {
      // `step.polling` re-affirms the status the resumed row already has
      // (the self-transition no-op, transitions.ts) when resuming, or moves
      // it there for the first time on a fresh attempt — either way this is
      // the same single emit.
      rt.emit({ type: 'step.polling', key: a.key, initial, at: rt.clock.now() })
      const polled = await runPoll(a, rt, pollDecl, initialPath, initial, scope, deadline)
      if (polled.kind !== 'ok') return polled
      last = polled.body
      seen = last
    }

    // Terminal success: outputs against the *final* response, then summary and
    // annotations with the step's own outputs in scope (01).
    const outputs = await coerceOutputs(
      raw.outputs as Record<string, OutputDecl> | undefined,
      scope({ response: last }),
      rt.registerFile,
    )
    const resultCtx = scope({ response: last, selfOutputs: outputs })

    return {
      kind: 'success',
      event: {
        type: 'step.succeeded',
        key: a.key,
        outputs,
        // The persist layer caps the polling row; the terminal event is where
        // the 256 KB budget applies to the pair (05).
        response: pollDecl ? trimResponse({ initial, last }) : trimResponse({ initial }),
        summary: evalSummary(a.step, resultCtx),
        annotations: evalAnnotations(a.step, resultCtx),
        at: rt.clock.now(),
      },
    }
  } catch (err) {
    return { kind: 'error', error: toStepError(err), response: seen }
  }
}

/** One budget, one sentence — shared with the script runtime, which owns its own timer. */
export function timeoutError(): StepError {
  return { code: 'TIMEOUT', message: 'the step exceeded its `timeout-minutes` budget' }
}

// ---------------------------------------------------------------------------
// The poll loop
// ---------------------------------------------------------------------------

async function runPoll(
  a: PipelineStepArgs,
  rt: StepRuntime,
  poll: Record<string, unknown>,
  initialPath: string,
  initial: unknown,
  scope: (over?: { response?: unknown }) => Record<string, unknown>,
  deadline: number | undefined,
): Promise<Fetched> {
  const every = parseDuration(str(poll.every) ?? DEFAULT_EVERY)
  const timeout = str(poll.timeout) ?? DEFAULT_POLL_TIMEOUT
  const pollDeadline = rt.clock.now() + parseDuration(timeout)
  const method = (str(poll.method) ?? DEFAULT_POLL_METHOD).toUpperCase()
  const path = str(poll.path) ?? initialPath

  // Two different `response` bindings live in a poll (01 contexts table, 03):
  // the tick **request** (`query`/`body`) always reads the *initial* response —
  // that is what makes `query: { id: ${{ response.jobId }} }` keep working once
  // ticks stop echoing the job id — while `fail`/`until` (and, later, `outputs`)
  // read the *latest tick's* response.
  const requestCtx = scope({ response: initial })
  let last: unknown = initial

  for (;;) {
    if (rt.signal.aborted) return { kind: 'cancelled' }
    const now = rt.clock.now()
    if (timedOut(deadline, now)) return { kind: 'error', error: timeoutError(), response: last }
    if (now >= pollDeadline) {
      return {
        kind: 'error',
        error: { code: 'POLL_TIMEOUT', message: `poll timed out after ${timeout}` },
        response: last,
      }
    }

    const tick = await request(rt, a.state.impl, {
      path,
      method,
      query: poll.query === undefined ? undefined : obj(evalDeep(poll.query, requestCtx)),
      body: poll.body === undefined ? undefined : evalDeep(poll.body, requestCtx),
    })
    if (tick.kind !== 'ok') return tick.kind === 'error' ? { ...tick, response: last } : tick
    last = tick.body

    // `fail` is evaluated before `until` (03).
    const answered = scope({ response: last })
    const fail = str(poll.fail)
    if (fail && truthy(evalValue(fail, answered))) {
      return { kind: 'error', error: pollFailError(last), response: last }
    }
    const until = str(poll.until)
    if (until && truthy(evalValue(until, answered))) return { kind: 'ok', body: last }

    try {
      await rt.clock.sleep(every, rt.signal)
    } catch {
      return { kind: 'cancelled' }
    }
    if (rt.signal.aborted) return { kind: 'cancelled' }
  }
}

// ---------------------------------------------------------------------------
// The step: attempts, retry, terminal event
// ---------------------------------------------------------------------------

/**
 * Full lifecycle of one pipeline step incl. poll/retry; emits
 * started/polling/retrying/succeeded/failed/cancelled. Never throws.
 */
export async function runPipelineStep(a: PipelineStepArgs, rt: StepRuntime): Promise<void> {
  const raw = obj(a.step.raw)
  const retry = raw.retry === undefined || raw.retry === null ? undefined : obj(raw.retry)
  const maxExtra = typeof retry?.max === 'number' ? retry.max : 0
  const deadline = stepDeadline(raw, rt.clock.now())

  const cancel = () => rt.emit({ type: 'step.cancelled', key: a.key, at: rt.clock.now() })

  // The attempt counter rides the events: the scheduler queued attempt 1, each
  // `step.retrying` bumps it in the reducer, and the adapter tracks the same
  // number so `step.attempt` reads the same value inside expressions.
  const first = a.state.steps[a.key]?.attempt ?? 1
  let attempt = first
  // Resume (05 item 3, Decision 3): only the very first loop iteration of a
  // resumed run runs under a resume mode — a retry re-runs the whole step
  // (request + poll) and announces itself with `step.started`, same as any
  // other attempt (by then the row is `running`, so that edge is legal again).
  let resuming: 'poll-only' | 'restart' | undefined = a.resume?.mode

  for (;;) {
    if (rt.signal.aborted) return cancel()

    const result = await runAttempt(a, rt, attempt, deadline, resuming)
    resuming = undefined
    if (result.kind === 'cancelled') return cancel()
    if (result.kind === 'success') return rt.emit(result.event)

    const error = result.error
    if (!shouldRetry(a, rt, retry, maxExtra, attempt - first, error, result.response, deadline)) {
      return rt.emit({
        type: 'step.failed',
        key: a.key,
        error,
        annotations: failureAnnotations(a, attempt, error),
        at: rt.clock.now(),
      })
    }

    rt.emit({ type: 'step.retrying', key: a.key, error, at: rt.clock.now() })
    attempt += 1
    try {
      await rt.clock.sleep(parseDuration(str(retry?.delay) ?? DEFAULT_RETRY_DELAY), rt.signal)
    } catch {
      return cancel()
    }
  }
}

/**
 * The step's `annotations:`, evaluated once the step reaches its terminal
 * *failure* (01): `error` is in scope — the only site where it is populated —
 * and the step has no outputs to read. Each entry is evaluated on its own so a
 * template that cannot be evaluated drops that entry instead of masking the
 * failure that is being reported.
 */
function failureAnnotations(a: PipelineStepArgs, attempt: number, error: StepError): Annotation[] {
  const list = obj(a.step.raw).annotations
  if (!Array.isArray(list)) return []

  const contexts = buildContexts(a.def, a.state, {
    job: a.job,
    index: a.index,
    stepId: a.step.id,
    attempt,
    error,
  })

  const out: Annotation[] = []
  for (const entry of list) {
    try {
      out.push(...evalAnnotations({ ...a.step, raw: { annotations: [entry] } }, contexts))
    } catch {
      // A broken annotation template is a lint problem; it must not replace the
      // step's own error on the way out.
    }
  }
  return out
}

/**
 * `retry` re-runs the whole step (request + poll) at most `max` **extra** times
 * while `if` holds — evaluated over `error` and the last `response` this attempt
 * saw, and defaulting to any failure (01/03). A spent `timeout-minutes` budget
 * ends the retries whatever `if` says: another attempt could only time out again.
 */
function shouldRetry(
  a: PipelineStepArgs,
  rt: StepRuntime,
  retry: Record<string, unknown> | undefined,
  maxExtra: number,
  used: number,
  error: StepError,
  response: unknown,
  deadline: number | undefined,
): boolean {
  if (!retry || used >= maxExtra) return false
  if (timedOut(deadline, rt.clock.now())) return false

  const condition = str(retry.if)
  if (!condition) return true
  try {
    return truthy(
      evalValue(
        condition,
        buildContexts(a.def, a.state, {
          job: a.job,
          index: a.index,
          stepId: a.step.id,
          attempt: used + 1,
          error,
          response,
        }),
      ),
    )
  } catch {
    // A `retry.if` that cannot be evaluated is not a licence to hammer the
    // server — the step keeps its original failure.
    return false
  }
}
