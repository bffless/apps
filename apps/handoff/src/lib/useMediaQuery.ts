/**
 * useMediaQuery — reactive match for a CSS media query, via useSyncExternalStore
 * so it stays correct across resizes without effect churn.
 */

import { useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  function subscribe(onChange: () => void): () => void {
    const mq = window.matchMedia(query)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}
