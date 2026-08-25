/**
 * A script step's `ctx.log` lines (03, Decision 12) — **live only**.
 *
 * A log line is not run state: it is never persisted, never replayed, and has
 * no meaning outside the tab that is actually driving the run, so it has no
 * business in the record *or* in Redux. It lives here instead, in the same
 * module-level shape `store/islandLaunch`'s handle log takes and for the same
 * reason — only one run is ever driven per tab, and the card needs a lookup
 * that survives its own re-renders.
 *
 * Keyed `<runId>:<stepKey>`, never by the bare key: a step key
 * (`<job>/<index>/<step>`) repeats identically across every run of the same
 * workflow, so a bare key would let one run's lines show up under another's.
 *
 * Each key holds the **last** `MAX_LINES` lines, replaced as a fresh array per
 * line rather than pushed to: the card reads it as a `useSyncExternalStore`
 * snapshot (apps#370), which must never be mutated in place. No React import
 * here — the hook belongs to the component.
 */
import type { StepKey } from '../lib/runner/types'

/** A chatty script must not grow the tab without bound; the tail is what a reader wants. */
const MAX_LINES = 50

/** The one shared empty snapshot: a fresh `[]` per read would loop `useSyncExternalStore`. */
const NO_LINES: readonly string[] = []

const logs = new Map<string, readonly string[]>()
const listeners = new Set<() => void>()

function logKey(runId: string, key: StepKey): string {
  return `${runId}:${key}`
}

function bump(): void {
  for (const listener of [...listeners]) listener()
}

/** `useSyncExternalStore` subscribe: a new line, or a reset, notifies. */
export function subscribeScriptLogs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** This step's lines, oldest first — a stable `[]` when the script has logged nothing. */
export function getScriptLog(runId: string, key: StepKey): readonly string[] {
  return logs.get(logKey(runId, key)) ?? NO_LINES
}

export function appendScriptLog(runId: string, key: StepKey, line: string): void {
  const id = logKey(runId, key)
  const next = [...(logs.get(id) ?? NO_LINES), line]
  logs.set(id, next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next)
  bump()
}

/**
 * Every line this tab holds, dropped. Called from the runner's own
 * `resetRunnerState()` — the moment a *different* run becomes the one this tab
 * drives, nothing from the old one may stay on the page.
 */
export function clearAllScriptLogs(): void {
  if (logs.size === 0) return
  logs.clear()
  bump()
}
