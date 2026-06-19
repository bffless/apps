import { useEffect, useMemo, useRef, useState } from 'react'
import type { Scene } from '../../lib/scenes'
import type { ContactSheet } from '../../lib/frames'
import { effectiveCuts, effectiveSegments } from '../../lib/refiner'
import { planScene } from '../../lib/export/assemble'
import { audioEvents, sourceTimeAt } from '../../lib/export/preview'
import { buildFilmstrip, frameAt, spriteStyle } from '../../lib/filmstrip'
import { usePreviewTransport } from './usePreviewTransport'

type Props = {
  open: boolean
  onClose: () => void
  scene: Scene
  /** The whole-clip prep contact sheets; the scene's own denser sheets win inside it. */
  sheets: ContactSheet[]
}

const FRAME_WIDTH = 640

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

/**
 * The lightweight preview (story 03i): the assemble plan, simulated — narration
 * stitched on the Web Audio clock, contact-sheet frames flipped in sync. No
 * ffmpeg, nothing rendered, nothing persisted; edit → preview → edit for free.
 */
export function ScenePreviewDialog({ open, onClose, scene, sheets }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)

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

  const segments = useMemo(() => effectiveSegments(scene), [scene])
  const plan = useMemo(
    () => planScene({ segments, cuts: effectiveCuts(scene), start: scene.start, end: scene.end }),
    [segments, scene],
  )
  const events = useMemo(() => audioEvents(plan, segments), [plan, segments])
  const frames = useMemo(
    () => buildFilmstrip([...(scene.sheets ?? []), ...sheets]),
    [scene.sheets, sheets],
  )
  const unvoiced = segments.filter((s) => !s.audioUrl).length

  const transport = usePreviewTransport(events, plan.duration)
  const { stop, clock } = transport

  // Pause the audio whenever the dialog closes (✕ / Esc / backdrop).
  useEffect(() => {
    if (!open) stop()
  }, [open, stop])

  // The playhead, advanced by an rAF loop while the dialog is open. clock() is
  // just arithmetic on the AudioContext clock, so polling it every frame is free.
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!open) return
    let raf = 0
    const tick = () => {
      setNow(clock())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, clock])

  const frame = frameAt(frames, sourceTimeAt(plan, now, scene.start))

  // Scrub: pointer-drag anywhere on the track seeks (capture keeps the drag).
  const trackRef = useRef<HTMLDivElement>(null)
  const seekTo = (clientX: number) => {
    const track = trackRef.current
    if (!track || plan.duration <= 0) return
    const rect = track.getBoundingClientRect()
    const frac = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
    transport.seek(frac * plan.duration)
  }

  const playable = plan.duration > 0

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-[min(92vw,720px)] rounded-lg border border-paper-line bg-paper p-0 shadow-xl backdrop:bg-ink/70"
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
    >
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
          {playable &&
            events.map((ev) => (
              <div
                key={`${ev.segmentIndex}-${ev.offset}`}
                className="absolute inset-y-0 bg-voice/50"
                style={{
                  left: `${(ev.offset / plan.duration) * 100}%`,
                  width: `${(ev.duration / plan.duration) * 100}%`,
                }}
              />
            ))}
          {playable && (
            <div
              className="absolute inset-y-0 w-0.5 bg-terracotta"
              style={{ left: `${(now / plan.duration) * 100}%` }}
            />
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="pill-cta"
            disabled={!playable || transport.loading}
            onClick={transport.toggle}
          >
            {transport.loading ? 'Loading audio…' : transport.playing ? 'Pause' : 'Play'}
          </button>
          <span className="font-mono text-[12px] text-ink-mute">
            {fmtTime(now)} / {fmtTime(plan.duration)}
          </span>
          {!playable && (
            <span className="text-[12.5px] text-terracotta-ink">
              Everything in this scene is cut — nothing to preview.
            </span>
          )}
          {unvoiced > 0 && (
            <span className="text-[12.5px] text-terracotta-ink">
              {unvoiced} run{unvoiced === 1 ? '' : 's'} unvoiced → silent here
            </span>
          )}
          {transport.failed > 0 && (
            <span className="text-[12.5px] text-amber-700">
              {transport.failed} clip{transport.failed === 1 ? '' : 's'} failed to load → silent
            </span>
          )}
        </div>
      </div>
    </dialog>
  )
}
