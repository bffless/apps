/**
 * The island step's pane (03 `island` step, 08: "the pane is the island").
 *
 * The counterpart of `FormStepPane`, and the same rule applies: it is only ever
 * rendered for the run **this tab is driving** (`StepPane`'s `live` gate),
 * because everything an island can do — submit, annotate — lands on whatever
 * run the global `runSlice` currently holds.
 *
 * This component owns exactly one thing the middleware could not: the element.
 * The host, its arguments and the step's own lifecycle events all belong to the
 * handle the middleware parked (`store/islandLaunch`), so mounting is a single
 * pre-bound call — the pane cannot open an island with the wrong input, and
 * `step.waiting` is dispatched by the runner rather than by a React effect.
 *
 * Unmounting (navigating away, picking another step) tears the bridge down with
 * `'unmounted'` and leaves the step exactly as it was: the record is unchanged,
 * and coming back re-mounts from the same handle.
 *
 * The pane has no accept-for-me control of its own (apps#435): an island's
 * **Done** is always on screen now that islands open inline, and the way to
 * not hand-edit a step at all is decided at kickoff — "Don't wait for me" for
 * the run, or the step's own `auto-accept:` (07) — before the island mounts.
 *
 * The pane always opens **inline** (04, apps#432). An island that declared
 * `display: fullscreen` gets an **Expand** control here — the overlay is the
 * page's (`RunPage` fixes the canvas over the viewport and swaps the graph for
 * a strip), and the `<iframe>` is the same element either way: nothing here
 * remounts on the mode change, so the island's edit state survives it.
 */
import { useMemo } from 'react'
import { IslandFrame } from '../../islands/IslandFrame'
import type { IslandHost } from '../../islands/IslandHost'
import { useIslandHandle, useIslandLog } from '../../islands/useIslandHandle'
import type { RunState, StepKey } from '../../lib/runner/types'
import { useAppDispatch, useAppSelector } from '../../store/hooks'
import { islandDisplayChanged } from '../../store/uiSlice'
import { StatusPill } from '../StatusPill'
import { MarkdownView } from '../values/MarkdownView'
import { PaneCrumbs } from './PaneCrumbs'
import type { Crumb } from './PaneCrumbs'

export interface IslandStepPaneProps {
  state: RunState
  stepKey: StepKey
  /** The levels above (08: Run › job) — the island unmounts and re-mounts from its handle on return. */
  trail?: Crumb[]
}

export function IslandStepPane({ state, stepKey: key, trail = [] }: IslandStepPaneProps) {
  const display = useAppSelector((s) => s.ui.islandDisplay)
  const dispatch = useAppDispatch()
  const handle = useIslandHandle(state.runId, key)
  const log = useIslandLog(state.runId, key)
  const step = state.steps[key]

  /**
   * `IslandFrame` re-mounts whenever its `host` identity changes, so this
   * adapter is memoised on the handle — never built inline in render. It
   * delegates `mount` to the handle's pre-bound call and ignores the frame's
   * own mount arguments: the middleware already decided every one of them, and
   * its `AbortController` (not the frame's) is what `cancelRun` reaches. The
   * frame's cleanup still stops an in-flight mount, through `teardown`.
   * `sendToolInput` is delegated for the interface's sake only — the frame
   * never calls it for a step's island.
   */
  const frameHost = useMemo<IslandHost | null>(
    () =>
      handle
        ? {
            mount: (iframe) => handle.mount(iframe),
            setDisplayMode: (mode) => handle.host.setDisplayMode(mode),
            sendToolInput: (args) => handle.host.sendToolInput(args),
            teardown: (reason) => handle.host.teardown(reason),
          }
        : null,
    [handle],
  )

  if (!step) {
    return (
      <aside className="step-pane" data-testid="step-pane" aria-label="Step">
        <h3 className="graph-panel-title">{key}</h3>
        <p className="note">This run has no record of that step.</p>
      </aside>
    )
  }

  return (
    <aside className="step-pane island-step-pane" data-testid="step-pane" aria-label="Step">
      <section className="island-step" data-testid="island-step">
        <header className="pane-head">
          <span className="pane-title">
            <PaneCrumbs trail={trail} current={step.stepId} />
            <h3 className="graph-panel-title">{handle?.title ?? key}</h3>
            <span className="pane-key">{key}</span>
          </span>
          {/* `display: fullscreen` offers the overlay; `inline` never enlarges (04). */}
          {handle?.display === 'fullscreen' && display === 'inline' && (
            <button
              type="button"
              className="button island-expand"
              data-testid="island-expand"
              onClick={() => dispatch(islandDisplayChanged('fullscreen'))}
            >
              Expand
            </button>
          )}
          <StatusPill status={step.status} />
          <span className="pane-kind">island</span>
        </header>

        <div className="island-display" data-testid="island-display" data-mode={display}>
          {handle && frameHost ? (
            <IslandFrame
              impl={handle.impl}
              src={handle.src}
              arguments={handle.arguments}
              headless={handle.headless}
              display={display}
              title={handle.title}
              host={frameHost}
              // The handle records a failed mount as the step's own
              // `ISLAND_LOAD` failure and resolves, so this never fires: it is
              // the frame's contract, not a second reporting path.
              onLoadError={() => {}}
            />
          ) : (
            <p className="note">This step has no island to open — try resuming the run.</p>
          )}
        </div>

        {log.length > 0 && (
          <ul className="island-log" data-testid="island-log">
            {log.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}

        {step.summary && (
          <div className="pane-summary">
            <MarkdownView value={step.summary} />
          </div>
        )}

        {step.annotations.length > 0 && (
          <ul className="annotations">
            {step.annotations.map((annotation, i) => (
              // Every annotation on a *non-terminal* step arrived through
              // `workflow.annotate` → `step.annotated` (Decision 12): a step's
              // declared annotations only ever ride its terminal event, which
              // this pane never renders.
              <li
                className="annotation"
                key={i}
                data-level={annotation.level}
                data-testid="step-annotated"
              >
                <span className="badge" data-severity={annotation.level}>
                  {annotation.level}
                </span>
                {annotation.title && <span className="annotation-title">{annotation.title}</span>}
                <span className="annotation-message">{annotation.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
