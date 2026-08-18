import type { ReactNode } from 'react'
import type { Scene } from '../../lib/scenes'
import {
  AUTO_STEPS,
  sceneStepStatuses,
  sceneRunStatus,
  type AutoBuildRun,
  type AutoStepStatus,
} from '../../lib/autoBuild'

type Props = {
  scenes: Scene[]
  run: AutoBuildRun
  selectedId: string | null
  onSelect: (id: string) => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  /** Extra controls rendered in the header's right-hand cluster, before Start (e.g. the video backend picker). */
  toolbar?: ReactNode
}

const STEP_ICON: Record<AutoStepStatus, string> = {
  done: '✓',
  running: '⟳',
  error: '✗',
  pending: '·',
}

/** Animated activity indicator — inherits the surrounding text colour. Lets a slow
 *  async step (refine, voicing) read as ALIVE rather than frozen on the board. */
function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent align-middle ${className}`}
    />
  )
}

/**
 * Auto Build dashboard (story 03s) — a pure render of the run: the scene tree with
 * per-step status, plus the Start/Pause/Resume/Stop controls. It owns no logic;
 * everything comes from `autoBuild` selectors over the durable scene state. Clicking
 * a scene row drills into the existing manual editor below (the page's detail view).
 */
export function AutoBuildBoard({ scenes, run, selectedId, onSelect, onStart, onPause, onResume, onStop, toolbar }: Props) {
  const builtCount = scenes.filter((s) => s.status === 'built').length
  const activeSceneIds = new Set(run.active.map((a) => a.sceneId))
  // The final stitch has no scene — give it its own headline + spinner.
  const stitching = run.status === 'running' && run.active.some((a) => a.stepId === 'stitch')
  const runningCount = run.active.filter((a) => a.stepId !== 'stitch').length
  const headline = stitching
    ? 'Stitching the final cut…'
    : run.status === 'running'
      ? `Running · ${runningCount || 1} step${runningCount === 1 ? '' : 's'} · ${builtCount} / ${scenes.length} built`
      : run.status === 'paused'
        ? '⏸ Paused'
        : run.status === 'halted'
          ? '✗ Halted'
          : run.status === 'done'
            ? '✓ Done'
            : `${builtCount} / ${scenes.length} scenes built`

  return (
    <div className="border rule bg-surface p-5" data-testid="auto-build-board" data-state={run.status}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="meta-label">Auto build</p>
          <p className="mt-1 flex items-center gap-2 text-[13px] text-ink-soft">
            {run.status === 'running' && <Spinner className="h-3 w-3 text-accent" />}
            {headline}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {toolbar}
          {run.status === 'idle' || run.status === 'done' ? (
            <button type="button" className="pill-cta" data-testid="auto-build-start" onClick={onStart}>
              Start auto build
            </button>
          ) : null}
          {run.status === 'running' && (
            <button type="button" className="pill-ghost" onClick={onPause}>
              Pause
            </button>
          )}
          {(run.status === 'paused' || run.status === 'halted') && (
            <button type="button" className="pill-cta" onClick={onResume}>
              Resume
            </button>
          )}
          {run.status !== 'idle' && run.status !== 'done' && (
            <button type="button" className="pill-ghost" onClick={onStop}>
              Stop
            </button>
          )}
        </div>
      </div>

      {run.status === 'halted' && run.halt && (
        <p className="mt-3 whitespace-pre-wrap text-[13px] text-accent-ink" data-testid="auto-build-halt">
          {run.halt.message}
        </p>
      )}

      <ul className="mt-4 flex flex-col gap-2">
        {scenes.map((scene, i) => {
          const rolled = sceneRunStatus(scene, run)
          const steps = sceneStepStatuses(scene, run)
          const expanded = activeSceneIds.has(scene.id) || scene.id === selectedId
          return (
            <li key={scene.id} className="rounded-md border border-line">
              <button
                type="button"
                data-testid="auto-scene"
                data-state={rolled}
                onClick={() => onSelect(scene.id)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] ${
                  scene.id === selectedId ? 'bg-surface-dim' : ''
                }`}
              >
                <span className="truncate">
                  <span className="font-mono text-ink-mute">{i + 1}</span> {scene.title}
                </span>
                <span
                  className={
                    rolled === 'error'
                      ? 'text-accent-ink'
                      : rolled === 'built'
                        ? 'text-ink'
                        : rolled === 'running'
                          ? 'inline-flex items-center gap-1.5 text-accent'
                          : 'text-ink-mute'
                  }
                >
                  {rolled === 'built' ? (
                    '✓ built'
                  ) : rolled === 'running' ? (
                    <>
                      <Spinner className="h-2.5 w-2.5" /> running
                    </>
                  ) : rolled === 'error' ? (
                    '✗ error'
                  ) : (
                    'pending'
                  )}
                </span>
              </button>
              {expanded && (
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-line px-3 py-2 font-mono text-[12px] text-ink-mute sm:grid-cols-3">
                  {AUTO_STEPS.map((step) => (
                    <span
                      key={step.id}
                      data-testid={`auto-step-${step.id}`}
                      data-state={steps[step.id]}
                      className={
                        steps[step.id] === 'error'
                          ? 'text-accent-ink'
                          : steps[step.id] === 'done'
                            ? 'text-ink'
                            : steps[step.id] === 'running'
                              ? 'text-accent'
                              : ''
                      }
                    >
                      {steps[step.id] === 'running' ? (
                        <Spinner className="mr-0.5 h-2.5 w-2.5" />
                      ) : (
                        STEP_ICON[steps[step.id]]
                      )}{' '}
                      {step.label}
                    </span>
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
