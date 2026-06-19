import { useEffect, useRef } from 'react'

type Props = {
  /** Normalized 0–1 peak amplitudes, one per bar (from `computePeaks`). */
  peaks: number[]
  /** Playback progress 0–1; bars before it are drawn "played" (terracotta). */
  progress?: number
  height?: number
}

/**
 * Paints a precomputed min/max-style waveform to a canvas — a cheap "we got the
 * audio" stenograph. The peaks are computed once during extraction (a few
 * hundred small numbers, persisted), so drawing never re-decodes the clip.
 * Bars left of `progress` render in terracotta to track playback.
 */
export function Waveform({ peaks, progress = 0, height = 56 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Redraw whenever the peaks, the playhead, or the element's width change.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    function draw() {
      const w = wrap!.clientWidth
      const dpr = window.devicePixelRatio || 1
      canvas!.width = w * dpr
      canvas!.height = height * dpr
      const ctx = canvas!.getContext('2d')
      if (!ctx || peaks.length === 0) return
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, height)
      const mid = height / 2
      const playedX = progress * w
      for (let x = 0; x < w; x++) {
        const p = peaks[Math.floor((x / w) * peaks.length)] ?? 0
        // mirror the peak around the midline so it reads like a classic waveform
        const half = Math.max(0.5, p * (mid - 1))
        // terracotta (#d85a3d) for played, ink-soft (#3a352e) for the rest
        ctx.fillStyle = x <= playedX ? 'rgba(216, 90, 61, 0.85)' : 'rgba(58, 53, 46, 0.5)'
        ctx.fillRect(x, mid - half, 1, half * 2)
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [peaks, progress, height])

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      {peaks.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-ink-mute">
          No waveform
        </div>
      )}
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  )
}
