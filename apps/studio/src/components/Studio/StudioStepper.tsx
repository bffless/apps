import { PHASES, type StudioPhase } from '../../lib/pipeline'

type Props = {
  phase: StudioPhase
  /** Phases the user can click to jump to (e.g. back to Prep from Build). */
  navigable?: StudioPhase[]
  /** Fired when a navigable phase is clicked. */
  onNavigate?: (phase: StudioPhase) => void
}

/**
 * The top-level "where am I" stepper for the whole producer journey:
 * Import → Prep → Build → Export. Orientation first — the deliberate per-step
 * actions live in the prep board below it. Mirrors `StageCard`'s glyph language:
 * terracotta fill = done, ringed = current, faint = upcoming. Phases listed in
 * `navigable` become clickable so you can hop back (Prep ⇄ Build) without losing
 * any work.
 */
export function StudioStepper({ phase, navigable = [], onNavigate }: Props) {
  const activeIndex = PHASES.findIndex((p) => p.id === phase)

  return (
    <ol className="flex items-center gap-2">
      {PHASES.map((p, i) => {
        const done = i < activeIndex
        const current = i === activeIndex
        const canNavigate = !!onNavigate && navigable.includes(p.id) && !current

        const glyph = (
          <span
            className={[
              'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-semibold transition-colors',
              done
                ? 'bg-terracotta text-paper'
                : current
                  ? 'border-2 border-terracotta text-terracotta-ink'
                  : 'border border-paper-line text-ink-faint',
            ].join(' ')}
          >
            {done ? '✓' : i + 1}
          </span>
        )
        const label = (
          <span
            className={[
              'font-serif text-[15px] leading-none whitespace-nowrap',
              current ? 'text-ink' : done ? 'text-ink-soft' : 'text-ink-faint',
            ].join(' ')}
          >
            {p.label}
          </span>
        )

        return (
          <li key={p.id} className="flex flex-1 items-center gap-2 last:flex-none">
            {canNavigate ? (
              <button
                type="button"
                onClick={() => onNavigate(p.id)}
                className="flex items-center gap-2.5 rounded-full transition-opacity hover:opacity-70"
                title={`Go to ${p.label}`}
              >
                {glyph}
                {label}
              </button>
            ) : (
              <div className="flex items-center gap-2.5">
                {glyph}
                {label}
              </div>
            )}
            {i < PHASES.length - 1 && (
              <span
                className={[
                  'h-px flex-1 transition-colors',
                  done ? 'bg-terracotta/50' : 'bg-paper-line',
                ].join(' ')}
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}
