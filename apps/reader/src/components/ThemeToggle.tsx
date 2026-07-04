import { THEME_OPTIONS, type ThemeChoice } from '../lib/theme'

/**
 * Theme segmented control (#137): Light · Dark · System, mirroring the
 * reading-width control's shape. The ordered options come straight from
 * {@link THEME_OPTIONS}, so the set stays defined in one place. Available on
 * every viewport (unlike the desktop-only width control) since dark mode applies
 * on mobile too.
 */
export function ThemeToggle({
  choice,
  onChange,
}: {
  choice: ThemeChoice
  onChange: (choice: ThemeChoice) => void
}) {
  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-lg border border-slate-200 p-0.5 dark:border-slate-700"
    >
      {THEME_OPTIONS.map((option) => {
        const active = option.id === choice
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={active}
            title={`${option.label} theme`}
            className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              active
                ? 'bg-slate-100 text-slate-900 dark:bg-slate-700 dark:text-slate-100'
                : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
