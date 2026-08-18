import { useEffect, useState, type ReactNode } from 'react'
import {
  getResolvedVideoBackend,
  setVideoBackend,
  subscribeVideoBackend,
  VIDEO_BACKEND_LABEL,
  type ResolvedVideoBackend,
  type VideoBackend,
} from '../../lib/videoBackend'
import { ffmpegLaneCapacity } from '../../lib/autoBuild'

const ORDER: VideoBackend[] = ['wasm', 'server', 'local', 'remote']

/**
 * Where video ops run this session (spec P8): a compact select over Browser /
 * Server (auto) / Local server / Remote plus a one-line status — the honoured
 * backend, its effective executor, the Auto Build parallelism it buys, and the
 * fallback note when a choice couldn't be honoured. Choices persist per browser
 * (`localStorage.videoBackend`, same key as the `?videoBackend=` override); a
 * change re-resolves in-session, and Auto Build reads the new lane width on its
 * next Start/Resume. Rendered on the Auto Build board and the prep card.
 */
export function VideoBackendPicker({ sceneCount, compact = false }: { sceneCount: number; compact?: boolean }) {
  const [resolved, setResolved] = useState<ResolvedVideoBackend | null>(null)

  useEffect(() => {
    let live = true
    const load = () => {
      setResolved(null)
      void getResolvedVideoBackend().then((r) => {
        if (live) setResolved(r)
      })
    }
    load()
    const unsub = subscribeVideoBackend(load)
    return () => {
      live = false
      unsub()
    }
  }, [])

  const probe = resolved?.probe ?? null
  const overridden = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('videoBackend')
  const enabled = (b: VideoBackend): boolean => {
    if (b === 'wasm') return true
    if (probe === null) return b === 'server' // unverifiable: only the auto choice is offered
    if (!probe.server) return false
    if (b === 'server') return true
    return probe.executors.includes(b)
  }

  let status: ReactNode = 'Checking video backend…'
  if (resolved) {
    const parts = [VIDEO_BACKEND_LABEL[resolved.backend]]
    if (resolved.executor) parts.push(resolved.executor)
    if (resolved.executor === 'remote') parts.push(`up to ${ffmpegLaneCapacity('remote', sceneCount)} parallel`)
    status = parts.join(' · ')
  }

  return (
    <div className={compact ? 'flex flex-wrap items-center gap-2 text-[12px]' : 'flex flex-col gap-1 text-[12px]'} data-testid="video-backend-picker">
      <label className="flex items-center gap-2 text-ink-soft">
        <span className="meta-label">Video backend</span>
        <select
          aria-label="Video backend"
          className="rounded border rule bg-surface px-2 py-1 text-[12px] text-ink"
          value={resolved?.backend ?? 'wasm'}
          disabled={!resolved || overridden}
          onChange={(e) => setVideoBackend(e.target.value as VideoBackend)}
        >
          {ORDER.map((b) => (
            <option key={b} value={b} disabled={!enabled(b)}>
              {VIDEO_BACKEND_LABEL[b]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-ink-soft" data-testid="video-backend-status">
        {status}
        {overridden ? ' · set by ?videoBackend= in the URL' : ''}
      </p>
      {resolved?.note ? (
        <p className="text-amber-600" role="status">
          {resolved.note}
        </p>
      ) : null}
    </div>
  )
}
