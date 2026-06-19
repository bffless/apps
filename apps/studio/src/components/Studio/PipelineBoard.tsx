import type { ReactNode } from 'react'
import type { Stage, StageId } from '../../lib/pipeline'
import { StageCard } from './StageCard'

type Props = {
  stages: Stage[]
  /** The next step to run — its card shows the action button. */
  currentStageId?: StageId | null
  /** A step is in flight. */
  busy?: boolean
  /** Run the current step. */
  onAction?: () => void
  /** A step whose action is owned by a richer panel elsewhere — hide its inline button. */
  panelStageId?: StageId | null
  /**
   * The artifact each step produces (contact sheet, director result, voice
   * studio), rendered as a row directly beneath its own step card so the board
   * reads top-to-bottom in one column: do the step, see what it made, do the next.
   */
  artifacts?: Partial<Record<StageId, ReactNode>>
}

/**
 * The board of "notes" — every prep step, visible up front and checking off as
 * it goes. Prep is step by step now: the current step shows its action button;
 * earlier steps are checked off, later ones wait their turn. Each step's artifact
 * (if any) sits tucked beneath its card in the same connected list.
 */
export function PipelineBoard({ stages, currentStageId, busy, onAction, panelStageId, artifacts }: Props) {
  const done = stages.filter((s) => s.status === 'done').length

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <p className="meta-label">The plan · {stages.length} steps</p>
        <p className="font-mono text-[12px] text-ink-mute">
          {done}/{stages.length} done
        </p>
      </div>
      <ol className="overflow-hidden border rule">
        {stages.map((stage, i) => {
          const artifact = artifacts?.[stage.id]
          return (
            <li key={stage.id} className="border-b rule last:border-b-0">
              <StageCard
                stage={stage}
                index={i}
                current={stage.id === currentStageId}
                busy={busy}
                onAction={onAction}
                hideAction={stage.id === panelStageId}
              />
              {artifact && <div className="border-t rule bg-paper-deep/30 px-5 py-4">{artifact}</div>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
