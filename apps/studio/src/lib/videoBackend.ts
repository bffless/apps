/**
 * Which backend runs video ops this session (spec: docs/superpowers/specs/
 * 2026-08-18-studio-video-backend-picker-design.md, P1–P4):
 *
 *   wasm    — in the browser (ffmpeg.wasm / WebAudio); labelled "Browser"
 *   server  — CE's ffmpeg_handler, CE picks its default executor ("Server (auto)")
 *   local   — CE, forcing the Local executor (ffmpeg inside the backend)
 *   remote  — CE, forcing the Remote executor (Cloud Run Worker)
 *
 * Mirrors resolveCoreChoice (export/ffmpeg.ts): a ?videoBackend= URL override
 * wins and is persisted to localStorage; otherwise a stored choice; otherwise
 * the probe (GET /api/video/capabilities) decides. The probe now ALWAYS runs
 * once per session for any server-side choice — it validates `remote`/`local`
 * against the instance's `executors` and supplies `defaultExecutor`, which is
 * what Auto Build's ffmpeg-lane capacity is decided from. The probe can never
 * break the app — any failure resolves like an older CE (wasm unless a stored
 * server choice says otherwise).
 */
import { fetchWithReauth } from './auth'

export type VideoBackend = 'wasm' | 'server' | 'local' | 'remote'
export type VideoExecutor = 'local' | 'remote'

export type VideoCapabilities = {
  server: boolean
  executors: VideoExecutor[]
  defaultExecutor: VideoExecutor | null
  remote: { ready: boolean; version?: string; reason?: string } | null
}

export type ResolvedVideoBackend = {
  /** The honoured choice (after fallback). */
  backend: VideoBackend
  /** The executor the instance will actually use for `backend` (null for wasm). */
  executor: VideoExecutor | null
  source: 'override' | 'stored' | 'probe'
  /** Human-readable reason when the requested choice could not be honoured. */
  note: string | null
  probe: VideoCapabilities | null
}

export const VIDEO_BACKEND_LABEL: Record<VideoBackend, string> = {
  wasm: 'Browser',
  server: 'Server (auto)',
  local: 'Local server',
  remote: 'Remote',
}

const STORAGE_KEY = 'videoBackend'

export function asBackend(v: unknown): VideoBackend | null {
  if (v === 'browser') return 'wasm'
  return v === 'wasm' || v === 'server' || v === 'local' || v === 'remote' ? v : null
}

function asExecutor(v: unknown): VideoExecutor | null {
  return v === 'local' || v === 'remote' ? v : null
}

/** Coerce the probe payload. Pre-remote CE (no `executors`) with server:true means Local only. */
export function parseCapabilities(raw: unknown): VideoCapabilities {
  const r = (raw ?? {}) as Record<string, unknown>
  const server = r.server === true
  let executors: VideoExecutor[]
  if (Array.isArray(r.executors)) {
    executors = r.executors.map(asExecutor).filter((e): e is VideoExecutor => e !== null)
  } else {
    executors = server ? ['local'] : []
  }
  const configured = asExecutor(r.defaultExecutor)
  const defaultExecutor = configured && executors.includes(configured) ? configured : (executors[0] ?? null)
  const rem = r.remote as Record<string, unknown> | undefined
  const remote =
    rem && typeof rem === 'object'
      ? {
          ready: rem.ready === true,
          ...(typeof rem.version === 'string' ? { version: rem.version } : {}),
          ...(typeof rem.reason === 'string' ? { reason: rem.reason } : {}),
        }
      : null
  return { server, executors, defaultExecutor, remote }
}

/** The `executor` a step body should carry: only explicit choices name one. */
export function stepExecutor(backend: VideoBackend): VideoExecutor | undefined {
  return backend === 'remote' || backend === 'local' ? backend : undefined
}

/**
 * Pure resolution. An override beats a stored choice, which beats the probe.
 * `remote`/`local` are honoured only when server ops are enabled AND the probe
 * lists them (`{server:false, executors:['local']}` is a common real payload —
 * CE reports `executors` from operator config while `server` also requires the
 * feature flag on and readiness); otherwise they
 * fall back to `server` (auto) when the instance has server ops, else `wasm`,
 * with a note. `server`/`wasm` are always honoured as-is (an override "for
 * testing" must win even against a probe that disagrees — today's behaviour).
 */
export function resolveVideoBackend(
  search: string,
  stored: string | null,
  probe: VideoCapabilities | null,
): ResolvedVideoBackend {
  const override = asBackend(new URLSearchParams(search).get('videoBackend'))
  const persisted = asBackend(stored)
  const source: ResolvedVideoBackend['source'] = override ? 'override' : persisted ? 'stored' : 'probe'
  const requested: VideoBackend = override ?? persisted ?? (probe?.server ? 'server' : 'wasm')

  const finish = (backend: VideoBackend, note: string | null): ResolvedVideoBackend => ({
    backend,
    executor: effectiveExecutor(backend, probe),
    source,
    note,
    probe,
  })

  if (requested === 'wasm' || requested === 'server') return finish(requested, null)

  // Explicit executor: needs the probe's word.
  const label = VIDEO_BACKEND_LABEL[requested]
  if (probe === null) {
    return finish('server', `${label} couldn't be verified (capability probe unavailable) — using Server (auto).`)
  }
  if (probe.server && probe.executors.includes(requested)) return finish(requested, null)
  const fallback: VideoBackend = probe.server ? 'server' : 'wasm'
  return finish(
    fallback,
    `${label} isn't enabled on this instance — using ${VIDEO_BACKEND_LABEL[fallback]}.`,
  )
}

function effectiveExecutor(backend: VideoBackend, probe: VideoCapabilities | null): VideoExecutor | null {
  if (backend === 'wasm') return null
  if (backend === 'remote' || backend === 'local') return backend
  // server (auto): whatever CE will pick; unknown ⇒ assume local (cap 1 — conservative).
  return probe?.defaultExecutor ?? 'local'
}

// Cache the PROMISE, not the result (getFFmpeg pattern) — StrictMode double-mounts
// and concurrent op starts must share one probe.
let memo: Promise<ResolvedVideoBackend> | null = null
const listeners = new Set<() => void>()

function readSearch(): string {
  try {
    return window.location.search
  } catch {
    return '' // non-browser context (SSR/tests without window)
  }
}

export function getResolvedVideoBackend(): Promise<ResolvedVideoBackend> {
  if (memo) return memo
  memo = (async () => {
    const search = readSearch()
    let stored: string | null = null
    const override = asBackend(new URLSearchParams(search).get('videoBackend'))
    try {
      if (override) window.localStorage.setItem(STORAGE_KEY, override)
      stored = window.localStorage.getItem(STORAGE_KEY)
    } catch {
      /* no localStorage (SSR/tests) */
    }
    // A wasm decision needs nothing from the server — skip the network.
    if ((override ?? asBackend(stored)) === 'wasm') return resolveVideoBackend(search, stored, null)

    let probe: VideoCapabilities | null = null
    try {
      const res = await fetchWithReauth('/api/video/capabilities')
      if (res.ok) probe = parseCapabilities(await res.json())
    } catch {
      /* older CE / no rule / network: probe stays null */
    }
    return resolveVideoBackend(search, stored, probe)
  })()
  return memo
}

export function getVideoBackend(): Promise<VideoBackend> {
  return getResolvedVideoBackend().then((r) => r.backend)
}

/** Persist a new choice for this browser and re-resolve (the probe re-runs once). */
export function setVideoBackend(choice: VideoBackend): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    /* no localStorage */
  }
  memo = null
  for (const l of listeners) l()
}

export function subscribeVideoBackend(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetVideoBackendForTests(): void {
  memo = null
  listeners.clear()
}
