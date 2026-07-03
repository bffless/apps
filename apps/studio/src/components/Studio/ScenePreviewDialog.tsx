import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Scene } from '../../lib/scenes'
import type { ContactSheet } from '../../lib/frames'
import { effectiveCuts } from '../../lib/refiner'
import { planScene } from '../../lib/export/assemble'
import { sourceTimeAt, outputTimeAt, nextKeptSource } from '../../lib/export/preview'
import { buildFilmstrip, frameAt, spriteStyle } from '../../lib/filmstrip'
import { claimPlayback } from './clipPlayer'

type Props = {
  open: boolean
  onClose: () => void
  scene: Scene
  /** The whole-clip prep contact sheets; the scene's own denser sheets win inside it. */
  sheets: ContactSheet[]
  /** Serve path of the whole-talk extracted WAV — the preview's soundtrack.
   *  Omit (restored session without audio) and the flipbook previews silent. */
  audioUrl?: string
}

const FRAME_WIDTH = 640

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

/**
 * The lightweight preview (story 03i): the assemble plan, simulated — the
 * ORIGINAL audio plays and jumps every cut (exactly what the render stitches),
 * contact-sheet frames flipped in sync. No ffmpeg, nothing rendered, nothing
 * persisted; edit → preview → edit for free.
 */
export function ScenePreviewDialog({ open, onClose, scene, sheets, audioUrl }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    const dlg = dialogRef.current
    if (!dlg) return
    if (open && !dlg.open) dlg.showModal()
    else if (!open && dlg.open) dlg.close()
  }, [open])

  useEffect(() => {
    const dlg = dialogRef.current
    if (!dlg) return
    const cancel = (e: Event) => {
      e.preventDefault()
      onClose()
    }
    dlg.addEventListener('cancel', cancel)
    return () => dlg.removeEventListener('cancel', cancel)
  }, [onClose])

  const plan = useMemo(
    () => planScene({ cuts: effectiveCuts(scene), start: scene.start, end: scene.end }),
    [scene],
  )
  const frames = useMemo(
    () => buildFilmstrip([...(scene.sheets ?? []), ...sheets]),
    [scene.sheets, sheets],
  )

  // The playhead in OUTPUT time, derived from the audio element's source-time
  // clock. `playing` mirrors the element's state for the button label.
  const [now, setNow] = useState(0)
  const [playing, setPlaying] = useState(false)

  // Track the audio clock → output clock, jumping cuts as they're reached: when
  // the playhead enters dropped footage, seek to the next kept span — that's
  // the stitch, audible live. Past the last kept span (or the scene end), stop.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onTime = () => {
      const jump = nextKeptSource(plan, el.currentTime, scene.start)
      if (jump === Infinity) {
        el.pause()
        return
      }
      if (jump != null) el.currentTime = jump
      setNow(outputTimeAt(plan, el.currentTime, scene.start))
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onPause)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onPause)
    }
  }, [plan, scene.start])

  // Pause the audio whenever the dialog closes (✕ / Esc / backdrop).
  useEffect(() => {
    if (!open) audioRef.current?.pause()
  }, [open])

  const seekOutput = useCallback(
    (t: number) => {
      const el = audioRef.current
      if (!el) return
      el.currentTime = sourceTimeAt(plan, t, scene.start)
      setNow(Math.min(Math.max(t, 0), plan.duration))
    },
    [plan, scene.start],
  )

  const toggle = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (!el.paused) {
      el.pause()
      return
    }
    claimPlayback(el)
    // (Re)start from the current playhead — or the top if the run finished.
    const from = now >= plan.duration - 0.05 ? 0 : now
    el.currentTime = sourceTimeAt(plan, from, scene.start)
    setNow(from)
    void el.play().catch(() => {})
  }, [now, plan, scene.start])

  const frame = frameAt(frames, sourceTimeAt(plan, now, scene.start))

  // Scrub: pointer-drag anywhere on the track seeks (capture keeps the drag).
  const trackRef = useRef<HTMLDivElement>(null)
  const seekTo = (clientX: number) => {
    const track = trackRef.current
    if (!track || plan.duration <= 0) return
    const rect = track.getBoundingClientRect()
    const frac = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
    seekOutput(frac * plan.duration)
  }

  const playable = plan.duration > 0 && !!audioUrl

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-[min(92vw,720px)] rounded-lg border border-paper-line bg-paper p-0 shadow-xl backdrop:bg-ink/70"
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
    >
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="metadata" className="hidden" />}
      <div className="flex items-center justify-between border-b border-paper-line px-5 py-3">
        <h2 className="meta-label">
          Preview · {scene.title} <span className="text-ink-mute">· instant, no render</span>
        </h2>
        <button type="button" className="pill-ghost" onClick={onClose} aria-label="Close preview">
          ✕
        </button>
      </div>

      <div className="flex aspect-video w-full items-center justify-center overflow-hidden bg-ink">
        {frame ? (
          <div className="shrink-0" style={spriteStyle(frame, FRAME_WIDTH)} />
        ) : (
          <p className="px-6 text-center text-[13px] text-paper">
            No frames captured for this scene yet — the audio still previews.
          </p>
        )}
      </div>

      <div className="px-5 py-4">
        <div
          ref={trackRef}
          className="relative h-6 cursor-pointer touch-none overflow-hidden rounded bg-paper-deep"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
            seekTo(e.clientX)
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) seekTo(e.clientX)
          }}
        >
          {plan.duration > 0 && (
            <div
              className="absolute inset-y-0 w-0.5 bg-terracotta"
              style={{ left: `${(now / plan.duration) * 100}%` }}
            />
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="pill-cta" disabled={!playable} onClick={toggle}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <span className="font-mono text-[12px] text-ink-mute">
            {fmtTime(now)} / {fmtTime(plan.duration)}
          </span>
          {plan.duration <= 0 && (
            <span className="text-[12.5px] text-terracotta-ink">
              Everything in this scene is cut — nothing to preview.
            </span>
          )}
          {plan.duration > 0 && !audioUrl && (
            <span className="text-[12.5px] text-terracotta-ink">
              No extracted audio on this session — frames only.
            </span>
          )}
        </div>
      </div>
    </dialog>
  )
}
