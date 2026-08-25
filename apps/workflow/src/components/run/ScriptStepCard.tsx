/**
 * A script step's live log (03: `ctx.log` "shows in the step card").
 *
 * The counterpart of the island pane's `island-log`, and deliberately *not* a
 * pane of its own: a script has nothing to interact with, so its step keeps
 * the ordinary Input / Output / Details tabs and this card rides along on
 * Details, under the timeline that says when the step ran.
 *
 * The lines are never run state (Decision 12) — they are not persisted, not
 * replayed, and mean nothing outside the tab driving the run — so they come
 * from the module-level `scripts/logStore` through `useSyncExternalStore`
 * rather than from Redux. The store keeps the tail; the card renders whatever
 * it holds, and says so when that is nothing yet (a script that has only just
 * started, and a script that never logs, look the same from here — which is
 * the truth).
 */
import { useSyncExternalStore } from 'react'
import type { StepKey } from '../../lib/runner/types'
import { getScriptLog, subscribeScriptLogs } from '../../scripts/logStore'

export interface ScriptStepCardProps {
  runId: string
  stepKey: StepKey
}

/** The store's own snapshot, returned as-is: a fresh array per read would loop. */
function useScriptLog(runId: string, key: StepKey): readonly string[] {
  const read = () => getScriptLog(runId, key)
  return useSyncExternalStore(subscribeScriptLogs, read, read)
}

export function ScriptStepCard({ runId, stepKey: key }: ScriptStepCardProps) {
  const log = useScriptLog(runId, key)

  return (
    <section className="script-log-card" data-testid="script-log">
      <h4 className="section-title">Log</h4>
      {log.length === 0 ? (
        <p className="note">No log lines yet</p>
      ) : (
        <ul className="script-log">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
