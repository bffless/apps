import type { Stage } from '../../lib/pipeline'

type Props = {
  stage: Stage
  index: number
  /** True when this is the next step to run — shows its action button. */
  current?: boolean
  /** A step is in flight; disable the button and show progress. */
  busy?: boolean
  onAction?: () => void
  /** Suppress the inline action button — a richer panel elsewhere owns it. */
  hideAction?: boolean
}

/** One "note" in the pipeline board: what we're going to do, and its status. */
export function StageCard({ stage, index, current, busy, onAction, hideAction }: Props) {
  const done = stage.status === 'done'
  const active = stage.status === 'active'
  const error = stage.status === 'error'
  const showAction = current && stage.actionLabel && onAction && !hideAction

  return (
    <div
      className={[
        'flex items-start gap-4 border-l-2 bg-paper px-5 py-4 transition-colors',
        active
          ? 'border-terracotta bg-terracotta/5'
          : done
            ? 'border-paper-line opacity-60'
            : error
              ? 'border-terracotta-ink'
              : 'border-paper-line',
      ].join(' ')}
    >
      <StatusGlyph status={stage.status} index={index} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4
            className={[
              'font-serif text-[17px] leading-tight text-ink',
              done ? 'line-through decoration-ink-faint' : '',
            ].join(' ')}
          >
            {stage.title}
          </h4>
          <WhereBadge where={stage.where} />
        </div>
        <p className="mt-1 text-[13.5px] leading-relaxed text-ink-soft">{stage.note}</p>
        {(done || error) && stage.detail && (
          <p
            className={[
              'mt-1.5 font-mono text-[12px]',
              error ? 'text-terracotta-ink' : 'text-ink-mute',
            ].join(' ')}
          >
            {error ? '✕ ' : '→ '}
            {stage.detail}
          </p>
        )}
        {showAction && (
          <button
            type="button"
            className="pill-cta mt-3"
            disabled={busy}
            onClick={onAction}
          >
            {busy ? 'Working…' : stage.actionLabel}
          </button>
        )}
      </div>
    </div>
  )
}

/** browser / pipeline / browser+pipeline tag. Hybrid steps show both tones. */
function WhereBadge({ where }: { where: Stage['where'] }) {
  const pill = 'rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider'
  if (where === 'browser+pipeline') {
    return (
      <span className="flex items-center gap-1">
        <span className={`${pill} bg-ink/10 text-ink-mute`}>browser</span>
        <span className="font-mono text-[10px] text-ink-faint">→</span>
        <span className={`${pill} bg-terracotta/15 text-terracotta-ink`}>pipeline</span>
      </span>
    )
  }
  return (
    <span
      className={[
        pill,
        where === 'browser' ? 'bg-ink/10 text-ink-mute' : 'bg-terracotta/15 text-terracotta-ink',
      ].join(' ')}
    >
      {where}
    </span>
  )
}

function StatusGlyph({ status, index }: { status: Stage['status']; index: number }) {
  const base =
    'mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-semibold'
  if (status === 'done')
    return <span className={`${base} bg-terracotta text-paper`}>✓</span>
  if (status === 'error')
    return <span className={`${base} bg-terracotta-ink text-paper`}>✕</span>
  if (status === 'active')
    return (
      <span className={`${base} border-2 border-terracotta text-terracotta`}>
        <span className="h-2 w-2 animate-ping rounded-full bg-terracotta" />
      </span>
    )
  return (
    <span className={`${base} border border-paper-line text-ink-faint`}>{index + 1}</span>
  )
}
