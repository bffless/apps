/**
 * Theme (light/dark) state for Handoff.
 *
 * Dark mode is class-driven: `.dark` on <html>. The default follows the OS
 * (`prefers-color-scheme`); the header toggle writes an explicit override to
 * localStorage. A tiny boot script in index.html applies the resolved theme
 * before first paint to avoid a flash — this module is the React-facing seam
 * that stays in sync with it.
 */

import { useSyncExternalStore, useCallback } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'handoff-theme'

function systemTheme(): Theme {
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

/** The theme that should currently be applied (explicit override, else system). */
export function resolveTheme(): Theme {
  return storedTheme() ?? systemTheme()
}

/** Reflect a theme onto <html>. Safe to call repeatedly. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

// --- reactive store ---------------------------------------------------------

const listeners = new Set<() => void>()
function emit() {
  for (const l of listeners) l()
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    /* storage unavailable — still apply for this session */
  }
  applyTheme(theme)
  emit()
}

export function toggleTheme(): void {
  setTheme(resolveTheme() === 'dark' ? 'light' : 'dark')
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  // Track OS changes while the user hasn't set an explicit override.
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  const onSystem = () => {
    if (storedTheme() === null) {
      applyTheme(systemTheme())
      onChange()
    }
  }
  mq?.addEventListener?.('change', onSystem)
  return () => {
    listeners.delete(onChange)
    mq?.removeEventListener?.('change', onSystem)
  }
}

/** Reactive current theme + a toggle. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, resolveTheme, () => 'light' as Theme)
  const toggle = useCallback(() => toggleTheme(), [])
  return { theme, toggle }
}
