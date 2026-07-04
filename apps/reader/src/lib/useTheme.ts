import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_THEME_CHOICE,
  THEME_STORAGE_KEY,
  resolveTheme,
  resolveThemeChoice,
  type ResolvedTheme,
  type ThemeChoice,
} from './theme'

/**
 * Theme preference hook (#137): the current choice, a setter that persists to
 * `localStorage`, and the {@link ResolvedTheme} actually painted.
 *
 * Mirrors {@link import('./useReadingWidth').useReadingWidth} — a tiny hook over
 * `localStorage`, no settings system. The stored value is validated on read, so a
 * stale/corrupt entry falls back to the default. While the choice is **System**
 * the hook tracks live OS `prefers-color-scheme` changes; the resolved theme is
 * reflected onto the root `.dark` class (CSS drives `color-scheme` off it), the
 * same class the pre-paint script in `index.html` sets to avoid a load flash.
 */
function readStoredChoice(): ThemeChoice {
  try {
    return resolveThemeChoice(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return DEFAULT_THEME_CHOICE
  }
}

function prefersDarkQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia('(prefers-color-scheme: dark)')
}

export function useTheme(): {
  choice: ThemeChoice
  setChoice: (choice: ThemeChoice) => void
  resolved: ResolvedTheme
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice)
  const [systemDark, setSystemDark] = useState<boolean>(() => prefersDarkQuery()?.matches ?? false)

  // Track the OS preference so a **System** choice re-resolves live.
  useEffect(() => {
    const mq = prefersDarkQuery()
    if (!mq) return
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved = resolveTheme(choice, systemDark)

  // Reflect the resolved theme onto the root element (mirrors the pre-paint
  // script so the class stays correct after the user toggles or the OS flips).
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
  }, [resolved])

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Non-fatal: the preference just won't survive this reload.
    }
  }, [])

  return { choice, setChoice, resolved }
}
