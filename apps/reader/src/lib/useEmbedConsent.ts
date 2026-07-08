import { useCallback, useState } from 'react'
import {
  allowOnce as sessionAllowOnce,
  isAllowedOnce,
  isHostAllowed,
  loadAllowedHosts,
  persistAllowedHost,
} from './embedConsent'

/**
 * React binding for the embedded-content consent gate (see `embedConsent.ts`).
 * Mirrors {@link import('./useTheme').useTheme} — a tiny hook over `localStorage`,
 * no settings system.
 *
 * - `isAllowed(host)` — host is on the persisted always-allow list.
 * - `allowAlways(host)` — persist + re-render so the embed loads now and stays.
 * - `allowOnce(id)` / `isAllowedOnce(id)` — ephemeral per-item show-once (session
 *   state lives in the module so it survives remounts; the hook bumps a counter
 *   to re-render when it changes).
 */
export function useEmbedConsent(): {
  isAllowed: (host: string | null | undefined) => boolean
  allowAlways: (host: string | null | undefined) => void
  allowOnce: (id: string) => void
  isAllowedOnce: (id: string | null | undefined) => boolean
} {
  const [allowed, setAllowed] = useState<string[]>(() => loadAllowedHosts())
  const [, bump] = useState(0)

  const isAllowed = useCallback(
    (host: string | null | undefined) => isHostAllowed(host, allowed),
    [allowed],
  )

  const allowAlways = useCallback((host: string | null | undefined) => {
    if (!host) return
    setAllowed(persistAllowedHost(host))
  }, [])

  const allowOnce = useCallback((id: string) => {
    sessionAllowOnce(id)
    bump((n) => n + 1)
  }, [])

  return { isAllowed, allowAlways, allowOnce, isAllowedOnce }
}
