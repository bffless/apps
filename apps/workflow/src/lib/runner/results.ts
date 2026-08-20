/**
 * `summary` / `annotations` evaluation (01) and the `response` size cap (05).
 *
 * `summary` and `annotations` are markdown/message templates evaluated by the
 * harness once a step reaches a terminal state; they never live inside
 * pipeline responses. Both go through the same expression contexts as
 * everything else — via `evalValue` (contexts.ts), which wraps the shared
 * `@bffless/workflow-lint/expressions` engine.
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import { truthy } from '@bffless/workflow-lint/expressions'
import type { Annotation, Step } from './types'
import { evalValue } from './contexts'

function rawOf(step: Step): Record<string, unknown> {
  return (step.raw ?? {}) as Record<string, unknown>
}

/** A template value coerced to a string for display (summary/annotation text is always shown as text). */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** The step's `summary:` template, evaluated after the step reaches a terminal state. */
export function evalSummary(step: Step, contexts: Record<string, unknown>): string | undefined {
  const summary = rawOf(step).summary
  if (typeof summary !== 'string') return undefined
  return asString(evalValue(summary, contexts))
}

/**
 * The step's `annotations:` list, each entry's `if` applied (dropped when
 * false; entries with no `if` are unconditional — unlike a step/job `if`,
 * there is no default `success()`).
 */
export function evalAnnotations(step: Step, contexts: Record<string, unknown>): Annotation[] {
  const list = rawOf(step).annotations
  if (!Array.isArray(list)) return []

  const out: Annotation[] = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>

    if (typeof e.if === 'string' && !truthy(evalValue(e.if, contexts))) continue

    const level = e.level as Annotation['level']
    const message = asString(evalValue(typeof e.message === 'string' ? e.message : '', contexts))
    const annotation: Annotation = { level, message }
    if (typeof e.title === 'string') annotation.title = asString(evalValue(e.title, contexts))
    out.push(annotation)
  }
  return out
}

/** Response halves are JSON-serialized and capped at this size (05). */
const RESPONSE_BUDGET_BYTES = 256 * 1024

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

function stub(value: unknown): { note: 'truncated'; size: number } {
  return { note: 'truncated', size: byteSize(value) }
}

/**
 * Trim a step's `response` (`{ initial, last }`) to a 256 KB JSON-serialized
 * budget, trimming `last` first and only reaching for `initial` if that
 * alone was not enough (05) — `last` is the bulkier, less useful half once a
 * poll has run to completion.
 */
export function trimResponse(response: {
  initial?: unknown
  last?: unknown
}): { initial?: unknown; last?: unknown; truncated?: boolean } {
  let initial = response.initial
  let last = response.last
  let truncated = false

  const over = () => byteSize({ initial, last }) > RESPONSE_BUDGET_BYTES

  if (over() && last !== undefined) {
    last = stub(last)
    truncated = true
  }
  if (over() && initial !== undefined) {
    initial = stub(initial)
    truncated = true
  }

  const out: { initial?: unknown; last?: unknown; truncated?: boolean } = {}
  if (initial !== undefined) out.initial = initial
  if (last !== undefined) out.last = last
  if (truncated) out.truncated = true
  return out
}
