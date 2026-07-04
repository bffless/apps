/**
 * Theme preference (#137): Light / Dark / System.
 *
 * The user picks one of three *choices*; the *resolved* theme actually painted
 * is either `light` or `dark`. An explicit Light/Dark choice wins outright;
 * **System** (the default) defers to the OS `prefers-color-scheme`. The choice is
 * persisted to `localStorage` and applied to the root `.dark` class before first
 * paint (see the inline script in `index.html`) so a dark-mode user never sees a
 * light flash on load; the {@link useTheme} hook keeps it in sync thereafter.
 *
 * This module is pure — no DOM, no storage — so the resolution logic (stored
 * value + system fallback → active theme) is unit-testable in isolation. It
 * mirrors the reading-width primitive (#136): a tiny set of presets + a couple of
 * resolve helpers, kept in one place.
 */

export type ThemeChoice = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export type ThemeOption = { id: ThemeChoice; label: string }

// Ordered for the header toggle: Light → Dark → System.
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
] as const

export const DEFAULT_THEME_CHOICE: ThemeChoice = 'system'

export const THEME_STORAGE_KEY = 'rivulet:theme'

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && THEME_OPTIONS.some((o) => o.id === value)
}

/** Resolve a raw (possibly stored) value to a valid choice, defaulting on miss. */
export function resolveThemeChoice(raw: unknown): ThemeChoice {
  return isThemeChoice(raw) ? raw : DEFAULT_THEME_CHOICE
}

/**
 * The active theme to paint: an explicit `light`/`dark` choice wins; `system`
 * (or any unrecognized value) follows the OS preference passed in.
 */
export function resolveTheme(choice: unknown, systemPrefersDark: boolean): ResolvedTheme {
  const resolved = resolveThemeChoice(choice)
  if (resolved === 'light') return 'light'
  if (resolved === 'dark') return 'dark'
  return systemPrefersDark ? 'dark' : 'light'
}
