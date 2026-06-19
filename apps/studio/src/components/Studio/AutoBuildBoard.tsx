import type { Scene } from '../../lib/scenes'
import {
  AUTO_STEPS,
  sceneStepStatuses,
  sceneRunStatus,
  voiceProgress,
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
export function AutoBuildBoard({ scenes, run, selectedId, onSelect, onStart, onPause, onResume, onStop }: Props) {
  const builtCount = scenes.filter((s) => s.status === 'built').length
  const activeIndex = scenes.findIndex((s) => s.id === run.currentSceneId)
  // The final stitch has no active scene (currentSceneId is null) — give it its own
  // headline + spinner so the run doesn't look frozen / off-by-one while it renders.
  const stitching = run.status === 'running' && run.currentStepId === 'stitch'
  const headline = stitching
    ? 'Stitching the final cut…'
    : run.status === 'running'
      ? `Running · Scene ${activeIndex >= 0 ? activeIndex + 1 : Math.min(builtCount + 1, scenes.length)} / ${scenes.length}`
      : run.status === 'paused'
        ? '⏸ Paused'
        : run.status === 'halted'
          ? '✗ Halted'
          : run.status === 'done'
            ? '✓ Done'
            : `${builtCount} / ${scenes.length} scenes built`

  return (
    <div className="border rule bg-paper p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="meta-label">Auto build</p>
          <p className="mt-1 flex items-center gap-2 text-[13px] text-ink-soft">
            {run.status === 'running' && <Spinner className="h-3 w-3 text-terracotta" />}
            {headline}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {run.status === 'idle' || run.status === 'done' ? (
            <button type="button" className="pill-cta" onClick={onStart}>
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

      {run.status === 'halted' && run.error && (
        <p className="mt-3 whitespace-pre-wrap text-[13px] text-terracotta-ink">{run.error}</p>
      )}

      <ul className="mt-4 flex flex-col gap-2">
        {scenes.map((scene, i) => {
          const rolled = sceneRunStatus(scene, run)
          const steps = sceneStepStatuses(scene, run)
          const expanded = scene.id === run.currentSceneId || scene.id === selectedId
          const vp = voiceProgress(scene)
          return (
            <li key={scene.id} className="rounded-md border border-paper-line">
              <button
                type="button"
                onClick={() => onSelect(scene.id)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] ${
                  scene.id === selectedId ? 'bg-paper-deep' : ''
                }`}
              >
                <span className="truncate">
                  <span className="font-mono text-ink-mute">{i + 1}</span> {scene.title}
                </span>
                <span
                  className={
                    rolled === 'error'
                      ? 'text-terracotta-ink'
                      : rolled === 'built'
                        ? 'text-ink'
                        : rolled === 'running'
                          ? 'inline-flex items-center gap-1.5 text-terracotta'
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
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-paper-line px-3 py-2 font-mono text-[12px] text-ink-mute sm:grid-cols-3">
                  {AUTO_STEPS.map((step) => (
                    <span
                      key={step.id}
                      className={
                        steps[step.id] === 'error'
                          ? 'text-terracotta-ink'
                          : steps[step.id] === 'done'
                            ? 'text-ink'
                            : steps[step.id] === 'running'
                              ? 'text-terracotta'
                              : ''
                      }
                    >
                      {steps[step.id] === 'running' ? (
                        <Spinner className="mr-0.5 h-2.5 w-2.5" />
                      ) : (
                        STEP_ICON[steps[step.id]]
                      )}{' '}
                      {step.label}
                      {step.id === 'voice' && steps.voice !== 'pending' ? ` (${vp.done}/${vp.total})` : ''}
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
