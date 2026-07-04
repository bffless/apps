import { WIDTH_PRESETS, type WidthLevel } from '../lib/width'

/**
 * Reading-width segmented control (#136). Desktop-only — hidden below `lg`, where
 * the mobile single-pane layout governs and the width presets are inert. The
 * ordered presets come straight from {@link WIDTH_PRESETS}, so the set stays
 * defined in one place.
 */
export function WidthControl({
  level,
  onChange,
}: {
  level: WidthLevel
  onChange: (level: WidthLevel) => void
}) {
  return (
    <div
      role="group"
      aria-label="Reading width"
      className="hidden items-center gap-0.5 rounded-lg border border-slate-200 p-0.5 lg:flex"
    >
      {WIDTH_PRESETS.map((preset) => {
        const active = preset.id === level
        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => onChange(preset.id)}
            aria-pressed={active}
            title={`${preset.label} reading width`}
            className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              active
                ? 'bg-slate-100 text-slate-900'
                : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
            }`}
          >
            {preset.label}
          </button>
        )
      })}
    </div>
  )
}
