import { useCallback, useEffect, useRef, useState } from 'react'
import { scheduleFrom, type AudioEvent } from '../../lib/export/preview'

/**
 * Decoded narration clips, cached for the whole session by serve URL. Voicing a
 * segment again mints a NEW url, so stale entries are simply never asked for
 * again — no invalidation logic. Cut/move edits change only offsets (pure math),
 * so re-opening the preview after an edit re-fetches nothing.
 */
const bufferCache = new Map<string, Promise<AudioBuffer | null>>()

/** One lazily-created context for every preview (browsers cap the count). */
let sharedCtx: AudioContext | null = null
function audioCtx(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext()
  return sharedCtx
}

/** Fetch + decode one clip; a failure resolves to null → that clip is silence
 *  in the preview (the assembler's "never reference a missing input" rule).
 *  Failures are NOT cached — a transient network error can retry on the next play. */
function loadBuffer(url: string): Promise<AudioBuffer | null> {
  let p = bufferCache.get(url)
  if (!p) {
    p = fetch(url, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`)
        return res.arrayBuffer()
      })
      .then((bytes) => audioCtx().decodeAudioData(bytes))
      .catch(() => {
        bufferCache.delete(url)
        return null
      })
    bufferCache.set(url, p)
  }
  return p
}

export type PreviewTransport = {
  playing: boolean
  /** Buffers are being fetched/decoded (first play of new clips only). */
  loading: boolean
  /** Clips that failed to fetch/decode — they play as silence. */
  failed: number
  /** Current output-timeline position, in seconds. Safe to call every rAF. */
  clock: () => number
  /** Play from the current position (or restart from 0 when at the end) / pause. */
  toggle: () => void
  /** Jump to output-second `t`; keeps playing if playing, else just re-positions. */
  seek: (t: number) => void
  /** Hard stop — close/unmount. Keeps the position. */
  stop: () => void
}

/**
 * Schedules `events` (from `audioEvents`) on the shared AudioContext and owns
 * the transport clock. The context clock runs even with zero nodes scheduled,
 * so an all-silent scene previews fine. All state is transient.
 *
 * `events` must be referentially stable across renders (memoize in the caller):
 * an identity change is treated as a timeline edit and stops playback.
 */
export function usePreviewTransport(events: AudioEvent[], duration: number): PreviewTransport {
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(0)

  const playingRef = useRef(false)
  const loadingRef = useRef(false)
  const offsetRef = useRef(0)
  const startedAtRef = useRef(0)
  const nodesRef = useRef<AudioBufferSourceNode[]>([])
  const endTimerRef = useRef<number | null>(null)
  /** Bumped to cancel an in-flight async play (pause/seek/unmount raced it). */
  const tokenRef = useRef(0)

  const setIsPlaying = (v: boolean) => {
    playingRef.current = v
    setPlaying(v)
  }

  const stopNodes = () => {
    for (const node of nodesRef.current) {
      try {
        node.stop()
      } catch {
        /* already stopped/never started — fine */
      }
    }
    nodesRef.current = []
    if (endTimerRef.current !== null) {
      clearTimeout(endTimerRef.current)
      endTimerRef.current = null
    }
  }

  const clock = useCallback(() => {
    if (!playingRef.current || !sharedCtx) return offsetRef.current
    return Math.min(Math.max(sharedCtx.currentTime - startedAtRef.current, 0), duration)
  }, [duration])

  const stop = useCallback(() => {
    tokenRef.current++
    offsetRef.current = clock()
    stopNodes()
    loadingRef.current = false
    setIsPlaying(false)
    setLoading(false)
  }, [clock])

  const play = useCallback(
    async (offset: number) => {
      loadingRef.current = true
      offsetRef.current = offset
      const token = ++tokenRef.current
      setLoading(true)
      const pairs = await Promise.all(
        events.map(async (e) => [e.audioUrl, await loadBuffer(e.audioUrl)] as const),
      )
      if (token !== tokenRef.current) return
      const ctx = audioCtx()
      try {
        await ctx.resume()
      } catch {
        if (token === tokenRef.current) {
          loadingRef.current = false
          setLoading(false)
        }
        return
      }
      if (token !== tokenRef.current) return
      loadingRef.current = false
      setLoading(false)
      setFailed(pairs.filter(([, buf]) => !buf).length)
      const buffers = new Map(pairs)

      // A small lead so every node's start time is still in the future when set.
      const base = ctx.currentTime + 0.05
      for (const s of scheduleFrom(events, offset)) {
        const buffer = buffers.get(s.event.audioUrl)
        if (!buffer) continue
        const node = ctx.createBufferSource()
        node.buffer = buffer
        node.connect(ctx.destination)
        node.start(base + s.when, s.bufferOffset, s.duration)
        nodesRef.current.push(node)
      }
      startedAtRef.current = base - offset
      setIsPlaying(true)

      const remaining = Math.max(0, duration - offset)
      endTimerRef.current = window.setTimeout(function onEnd() {
        const left = duration - (sharedCtx ? sharedCtx.currentTime - startedAtRef.current : duration)
        if (left > 0.05) {
          endTimerRef.current = window.setTimeout(onEnd, left * 1000 + 100)
          return
        }
        stopNodes()
        offsetRef.current = duration
        setIsPlaying(false)
      }, remaining * 1000 + 100)
    },
    [events, duration],
  )

  const toggle = useCallback(() => {
    if (playingRef.current || loadingRef.current) {
      stop()
      return
    }
    const from = offsetRef.current >= duration ? 0 : offsetRef.current
    void audioCtx().resume()
    void play(from)
  }, [duration, stop, play])

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.min(Math.max(t, 0), duration)
      if (playingRef.current || loadingRef.current) {
        tokenRef.current++
        stopNodes()
        setIsPlaying(false)
        void play(clamped)
      } else {
        offsetRef.current = clamped
      }
    },
    [duration, play],
  )

  // Mount-only unmount: always calls the latest stop without re-registering the
  // effect when stop's identity changes (which would fire the cleanup mid-session).
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => () => stopRef.current(), [])

  // An edit changed the timeline while it was playing/loading — the scheduled
  // nodes are stale. Stop; the producer presses play again on the new plan.
  useEffect(() => {
    if (playingRef.current || loadingRef.current) stopRef.current()
  }, [events, duration])

  return { playing, loading, failed, clock, toggle, seek, stop }
}
