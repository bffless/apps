/**
 * Copy diagnostics / Attach to run, as the run page offers them (apps#526).
 *
 * Same shape as `useRunDelete`: the page owns the facts (which run, which
 * steps, live or record), the header gets callbacks and flags and renders
 * buttons — it never reaches for the store itself. What the two actions share
 * is the payload (`buildDiagnostics`); where they differ is the write:
 *
 * - **Copy** is best-effort clipboard, the `ShapeView` posture — a refusal
 *   flips no label and raises no banner, the payload is still one Attach away.
 * - **Attach** on the tab driving the run dispatches the existing
 *   `run.annotation` event, and the runner middleware persists it like any
 *   other (rows.ts) — the reducer's replace-by-kind keeps it single. On a
 *   record view there is no live state to dispatch into, so it patches the
 *   fetched row directly through the same `run/update` path and lets the
 *   caller refetch (`onAttached`).
 *
 * The rule behind the write requires auth only, no lease — so a viewer of a
 * finished run can attach, which is the whole point: the record view is where
 * diagnostics get asked for.
 */
import { useEffect, useState } from 'react'
import { attachDiagnostics, buildDiagnostics, copyDiagnostics, diagnosticsAnnotation } from '../lib/diagnostics'
import { httpJsonWithReauth } from '../lib/http'
import type { Annotation, StepKey, StepStatus } from '../lib/runner/types'
import { createRunStore } from '../lib/runStore'
import { runEvent } from './runSlice'
import { useAppDispatch } from './hooks'

/** The app's real `RunStore` — fresh per module, matching `lifecycleActions.ts`. */
const runStore = createRunStore(httpJsonWithReauth)

const COPIED_MS = 1_500

export interface RunDiagnosticsFacts {
  /** The run on screen; `undefined` until the page knows which one it is. */
  runId?: string
  /** This tab is driving the run — Attach goes through the event, not the row. */
  live: boolean
  /** Which steps exist and where each got to — the payload's pointers at the recorded half. */
  steps: { key: StepKey; status: StepStatus }[]
  /** The fetched row on a record view (`null`/absent while live): what Attach patches. */
  run?: { runId: string; annotations?: Annotation[] | null } | null
  /** Every step annotation the record holds, for the `annotationCounts` rollup. */
  stepAnnotations?: readonly Annotation[]
  /** A record-view attach landed — the caller refetches so the row on screen catches up. */
  onAttached?: () => void
}

/** What the header renders — present as a group or not at all (`RunHeader`'s `diagnostics` prop). */
export interface RunDiagnosticsActions {
  onCopy: () => void
  /** The last copy landed on the clipboard; echoed on the button for a moment. */
  copied: boolean
  onAttach: () => void
  /** A record-view write is in flight; the button stays but refuses a second press. */
  attaching: boolean
  /** The last attach landed; cleared the moment another begins. */
  attached: boolean
}

export interface RunDiagnostics {
  /** `undefined` until there is a run to describe — the header then offers nothing. */
  actions?: RunDiagnosticsActions
  /** The refusal to show, in the words of the person who asked; `null` while there is none. */
  failed: string | null
}

export function useRunDiagnostics(facts: RunDiagnosticsFacts): RunDiagnostics {
  const dispatch = useAppDispatch()
  const [copied, setCopied] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [attached, setAttached] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const { runId, live, steps, run, stepAnnotations, onAttached } = facts
  if (runId === undefined) return { actions: undefined, failed }

  const onCopy = () => {
    void copyDiagnostics(buildDiagnostics({ runId, steps })).then((ok) => setCopied(ok))
  }

  const onAttach = () => {
    setAttached(false)
    setFailed(null)
    const payload = buildDiagnostics({ runId, steps })
    if (live) {
      // The middleware persists this dispatch like any other run event, and
      // the reducer replaces any previous diagnostics annotation (apps#526).
      dispatch(runEvent({ type: 'run.annotation', annotation: diagnosticsAnnotation(payload), at: payload.at }))
      setAttached(true)
      return
    }
    if (!run || attaching) return
    setAttaching(true)
    attachDiagnostics(runStore, run, stepAnnotations ?? [], payload)
      .then(() => {
        setAttached(true)
        onAttached?.()
      })
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : 'The diagnostics could not be attached.')
      })
      .finally(() => setAttaching(false))
  }

  return { actions: { onCopy, copied, onAttach, attaching, attached }, failed }
}
