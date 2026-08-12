/**
 * Which backend runs video ops this session: CE's server-side ffmpeg_handler
 * ('server') or the in-browser wasm/WebAudio path ('wasm').
 *
 * Mirrors resolveCoreChoice (export/ffmpeg.ts): a ?videoBackend=server|wasm URL
 * override wins and is persisted to localStorage; otherwise a stored choice;
 * otherwise probe GET /api/video/capabilities once per session. The probe can
 * never break the app — any failure (older CE, no rule, network) resolves
 * 'wasm', which is exactly today's behavior.
 */
import { fetchWithReauth } from './auth'

export type VideoBackend = 'server' | 'wasm'

const STORAGE_KEY = 'videoBackend'

function asBackend(v: unknown): VideoBackend | null {
  return v === 'server' || v === 'wasm' ? v : null
}

/**
 * Pure resolution: an explicit override (URL) beats a stored choice, which
 * beats the probe result. `probe` is only consulted when neither has an
 * opinion — pass `null` when the probe hasn't run (or shouldn't).
 */
export function resolveVideoBackend(
  search: string,
  stored: string | null,
  probe: { server: boolean } | null,
): VideoBackend {
  const override = asBackend(new URLSearchParams(search).get('videoBackend'))
  if (override) return override
  const persisted = asBackend(stored)
  if (persisted) return persisted
  return probe?.server ? 'server' : 'wasm'
}

// Cache the PROMISE, not the result (getFFmpeg pattern) — StrictMode double-mounts
// and concurrent op starts must share one probe.
let memo: Promise<VideoBackend> | null = null

export function getVideoBackend(): Promise<VideoBackend> {
  if (memo) return memo
  memo = (async () => {
    let search = ''
    let stored: string | null = null
    try {
      search = window.location.search
    } catch {
      /* non-browser context (SSR/tests without window) */
    }
    const override = asBackend(new URLSearchParams(search).get('videoBackend'))
    try {
      if (override) window.localStorage.setItem(STORAGE_KEY, override)
      stored = window.localStorage.getItem(STORAGE_KEY)
    } catch {
      /* no localStorage (SSR/tests) */
    }
    const persisted = asBackend(stored)
    // An override or a stored choice has already decided — skip the network.
    if (override || persisted) return resolveVideoBackend(search, stored, null)

    try {
      const res = await fetchWithReauth('/api/video/capabilities')
      if (!res.ok) return 'wasm'
      const caps = (await res.json()) as { server?: boolean }
      return resolveVideoBackend(search, stored, { server: caps.server === true })
    } catch {
      return 'wasm'
    }
  })()
  return memo
}

export function resetVideoBackendForTests(): void {
  memo = null
}
