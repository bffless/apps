import { type ReactNode } from 'react'
import { formatTime } from '../../lib/edl'
import { sceneVideoSeconds, type Scene } from '../../lib/scenes'
import { effectiveCuts, normalizeCuts } from '../../lib/refiner'

type Props = {
  scene: Scene
  className?: string
}

/**
 * At-a-glance facts about the selected scene, shown beside the (capped) video so
 * the space to its right isn't wasted. Everything here is derived from the Scene
 * — footage span, the cuts, and the final clip length they produce (ADR-0003:
 * the scene's output is its footage minus cuts, nothing else).
 */
export function SceneMeta({ scene, className = '' }: Props) {
  const span = sceneVideoSeconds(scene)
  // Read the EFFECTIVE layer (refined edits over the director's first pass) so these
  // numbers match the assembled final clip exactly — not the stale baseline. Cuts
  // are normalized first so overlaps aren't double-counted.
  const cuts = normalizeCuts(effectiveCuts(scene))
  const dropped = cuts.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
  const finalLen = Math.max(0, span - dropped)
  const keptPct = span > 0 ? Math.round((finalLen / span) * 100) : 0
  const done = scene.status === 'built'

  return (
    <div className={['border rule bg-surface-dim/30 p-5', className].join(' ')}>
      <div className="flex items-center justify-between gap-3">
        <p className="meta-label">Scene {scene.index + 1}</p>
        {/* Read-only status badge — a scene becomes "built" automatically when you
            assemble & save it (see `saveSceneCut`), not via a manual toggle. Drives
            the tab ✓ and export readiness. */}
        <span
          title={
            done
              ? 'Built — this scene is assembled & saved'
              : 'Becomes “built” automatically once you assemble & save it'
          }
          className={[
            'rounded-full px-2.5 py-0.5 font-mono text-[11px]',
            done ? 'bg-accent text-surface' : 'border border-line text-ink-mute',
          ].join(' ')}
        >
          {done ? '✓ built' : 'not built'}
        </span>
      </div>
      <h3 className="mt-1 font-semibold tracking-[-0.01em] text-[20px] leading-tight text-ink">{scene.title}</h3>

      <dl className="mt-4 flex flex-col divide-y divide-line/60 text-[13px]">
        <Stat label="Footage span">
          <span className="font-mono">
            {formatTime(scene.start)}–{formatTime(scene.end)}
          </span>
        </Stat>
        <Stat label="Duration">
          <span className="font-mono">{formatTime(span)}</span>
        </Stat>
        <Stat label="Cuts">
          {cuts.length === 0 ? (
            <span className="text-ink-mute">none</span>
          ) : (
            <span className="font-mono">
              {cuts.length} · <span className="text-accent-ink">−{formatTime(dropped)}</span>
            </span>
          )}
        </Stat>
        {/* The assembled final clip's length for this scene: footage minus the
            effective cuts (kept dead space stays). Matches the export. */}
        <Stat label="Final clip">
          <span className="font-mono">
            {formatTime(span)} → {formatTime(finalLen)}
            {cuts.length > 0 && <span className="text-ink-mute"> · {keptPct}% kept</span>}
          </span>
        </Stat>
      </dl>
    </div>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  )
}
