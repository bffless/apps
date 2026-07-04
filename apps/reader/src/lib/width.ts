/**
 * Reading-width preference (#136).
 *
 * A single ordered set of named width *levels*, each mapping to a pair of
 * Tailwind max-width classes: one for the overall app container and one for the
 * article's reading measure. Both widen together as you step up, so the item
 * being read gets meaningfully more room — not just the list. The lowest level,
 * **Cozy**, reproduces the original layout pixel-for-pixel (`max-w-6xl` /
 * `max-w-2xl`).
 *
 * The chosen level is persisted to `localStorage` (see {@link useReadingWidth}).
 * The presets live here, in one place, so the set is trivial to tune or extend.
 * Class strings are written as literals so Tailwind's source scanner emits them.
 *
 * Desktop-only: on small screens the control is hidden and the presets are inert
 * — the viewport is narrower than every cap, so the max-width never binds.
 */

export type WidthLevel = 'cozy' | 'comfortable' | 'wide' | 'full'

export type WidthPreset = {
  id: WidthLevel
  label: string
  /** Max-width class for the outer app container (Cozy = the original `max-w-6xl`). */
  container: string
  /** Max-width class for the article reading measure (Cozy = the original `max-w-2xl`). */
  measure: string
}

// Ordered lowest → highest. Cozy MUST equal today's layout.
export const WIDTH_PRESETS: readonly WidthPreset[] = [
  { id: 'cozy', label: 'Cozy', container: 'max-w-6xl', measure: 'max-w-2xl' },
  { id: 'comfortable', label: 'Comfortable', container: 'max-w-7xl', measure: 'max-w-3xl' },
  { id: 'wide', label: 'Wide', container: 'max-w-[90rem]', measure: 'max-w-4xl' },
  { id: 'full', label: 'Full', container: 'max-w-none', measure: 'max-w-5xl' },
] as const

export const DEFAULT_WIDTH_LEVEL: WidthLevel = 'cozy'

export const WIDTH_STORAGE_KEY = 'rivulet:reading-width'

export function isWidthLevel(value: unknown): value is WidthLevel {
  return typeof value === 'string' && WIDTH_PRESETS.some((p) => p.id === value)
}

/** Resolve a raw (possibly stored) value to a valid level, defaulting on miss. */
export function resolveWidthLevel(raw: unknown): WidthLevel {
  return isWidthLevel(raw) ? raw : DEFAULT_WIDTH_LEVEL
}

/** The preset for a level — the default preset for anything unrecognized. */
export function presetForLevel(level: unknown): WidthPreset {
  const id = resolveWidthLevel(level)
  return WIDTH_PRESETS.find((p) => p.id === id) ?? WIDTH_PRESETS[0]
}
