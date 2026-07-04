import { useCallback, useState } from 'react'
import {
  DEFAULT_WIDTH_LEVEL,
  WIDTH_STORAGE_KEY,
  presetForLevel,
  resolveWidthLevel,
  type WidthLevel,
  type WidthPreset,
} from './width'

/**
 * Reading-width preference hook (#136): the current level, a setter that
 * persists to `localStorage`, and the resolved {@link WidthPreset} of classes.
 *
 * Greenfield preferences primitive — a tiny hook + `localStorage`, no settings
 * system. The stored value is validated through {@link resolveWidthLevel} on
 * read, so a corrupt or stale entry falls back to the default rather than
 * breaking the layout.
 */
function readStoredLevel(): WidthLevel {
  try {
    return resolveWidthLevel(localStorage.getItem(WIDTH_STORAGE_KEY))
  } catch {
    return DEFAULT_WIDTH_LEVEL
  }
}

export function useReadingWidth(): {
  level: WidthLevel
  setLevel: (level: WidthLevel) => void
  preset: WidthPreset
} {
  const [level, setLevelState] = useState<WidthLevel>(readStoredLevel)

  const setLevel = useCallback((next: WidthLevel) => {
    setLevelState(next)
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, next)
    } catch {
      // Non-fatal: the preference just won't survive this reload.
    }
  }, [])

  return { level, setLevel, preset: presetForLevel(level) }
}
