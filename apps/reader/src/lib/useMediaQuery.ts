import { useEffect, useState } from 'react'

/**
 * The viewport width at/above which Rivulet shows the desktop three-column
 * layout; below it, the mobile single-pane flow governs (#135). Matches
 * Tailwind's `lg` breakpoint, so the JS branch and the `lg:` utility classes
 * flip at exactly the same width.
 */
export const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)'

/**
 * Read a media query's current match. Guards environments without `matchMedia`
 * (SSR, older jsdom) by reporting `false` — a deterministic "not desktop", so
 * the mobile layout is the safe default when the capability is missing.
 */
export function matchesQuery(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(query).matches
}

/**
 * Subscribe to a media query, returning whether it currently matches and
 * re-rendering when that flips (e.g. a resize across the breakpoint). Falls
 * back to `false` where `matchMedia` is unavailable. The listener is torn down
 * on unmount / query change.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesQuery(query))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    // Resync once on attach: the query may have changed between the initial
    // render and this effect running.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
