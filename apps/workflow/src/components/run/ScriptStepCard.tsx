/**
 * A script step's `ctx.log` card (03: `ctx.log` "shows in the step card").
 *
 * The counterpart of the island pane's `island-log`, and deliberately *not* a
 * pane of its own: a script has nothing to interact with, so its step keeps
 * the ordinary Input / Output toggle and this card rides along on Output,
 * under the stats that say when the step ran.
 *
 * Two sources, one card (apps#527). While the tab drives the run the lines
 * stream through the module-level `scripts/logStore` via
 * `useSyncExternalStore` — they are not run state until the step ends, so
 * they never touch Redux. When the step's terminal event lands, the capped
 * tail is persisted on the row's `log` column, and a read-back run hands it
 * here as `recorded`. The live store wins whenever it holds anything (it is
 * this exact run's stream, at worst a superset of what was persisted);
 * otherwise the card renders the record. A run from before the column
 * existed has neither, and says so.
 */
import { useSyncExternalStore } from 'react'
import type { StepKey } from '../../lib/runner/types'
import { getScriptLog, subscribeScriptLogs } from '../../scripts/logStore'

export interface ScriptStepCardProps {
  runId: string
  stepKey: StepKey
  /** The row's persisted `log` tail (apps#527) — the fallback when this tab holds no live lines. */
  recorded?: readonly string[]
}

/** The store's own snapshot, returned as-is: a fresh array per read would loop. */
function useScriptLog(runId: string, key: StepKey): readonly string[] {
  const read = () => getScriptLog(runId, key)
  return useSyncExternalStore(subscribeScriptLogs, read, read)
}

export function ScriptStepCard({ runId, stepKey: key, recorded }: ScriptStepCardProps) {
  const live = useScriptLog(runId, key)
  const log = live.length > 0 ? live : (recorded ?? live)

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
